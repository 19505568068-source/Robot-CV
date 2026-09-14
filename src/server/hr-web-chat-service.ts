import crypto from "node:crypto";

import {
  HrStore,
  HrStoreError,
  type ArchiveHrMessageResult,
  type HrArchivedMessage,
  type HrMaterialsSummary,
  type HrVisitor
} from "../state/hr.js";
import { enforceNoCommitment, type HrAiService } from "./hr-ai-service.js";
import type { HrCodexEngine } from "./hr-codex-engine.js";
import { readConfiguredKnowledgeRoots, retrieveHrKnowledge } from "./hr-knowledge.js";
import type { HrInboundDisposition, WecomCustomerServiceInboundEvent } from "./hr-service.js";
import {
  HrWebChatPublicError,
  type HrWebChatBackend,
  type HrWebChatContext,
  type HrWebChatMessagePage,
  type HrWebChatProjectSelection,
  type HrWebChatResume,
  type HrWebChatSessionState,
  type HrWebChatSubmitResult
} from "./hr-web-chat-server.js";
import {
  formatHrWebProjectDetail,
  getHrWebProject,
  listHrWebProjectCards,
  type HrWebProjectCard
} from "./hr-project-catalog.js";

const WEB_ENTRY_ID = "wechat-h5-hr-clawbot";
const PROJECT_CATALOG_REVISION = "2026-09-14";
const DEFAULT_INTRODUCTION = "您好，我是候选人的 AI 招聘助理 ClawBot。您可以直接询问候选人的经历、项目与求职意向；涉及面试时间、薪资、Offer 或入职安排时，我会交由候选人本人确认。";
const COMPANY_PROMPT = "为了按岗位重点沟通，方便先告诉我您来自哪家公司吗？";
const PROJECT_MENU_PROMPT = "收到，下面是几段可以重点交流的项目与实习经历。选择标题后，我会说明自己的角色、具体工作和结果，欢迎您直接开始提问。";
const FALLBACK_REPLY = "您的消息已记录。当前自动回答暂不可用，候选人会在后台查看；涉及面试、薪资、Offer 或入职安排的内容均需候选人本人确认。";

export type HrWebChatSnapshot = {
  visitorId: string;
  consentStatus: HrVisitor["consentStatus"];
  disclosure: string;
  messages: HrArchivedMessage[];
  resume?: {
    id: string;
    name: string;
    size: number;
  };
};

export type HrWebChatServiceOptions = {
  store: HrStore;
  aiService?: HrAiService;
  codexEngine?: HrCodexEngine;
  hrStatePath?: string;
};

/**
 * Channel-neutral business adapter used by the public H5 transport. The public
 * server owns cookies and CSRF; this service only receives its opaque visitor key.
 */
export class HrWebChatService implements HrWebChatBackend {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly pendingReplies = new Set<string>();

  constructor(private readonly options: HrWebChatServiceOptions) {}

  async getSessionState(context: HrWebChatContext): Promise<HrWebChatSessionState> {
    const snapshot = await this.open(context.sessionId);
    this.verifyBinding(context, snapshot.visitorId);
    return this.publicSessionState(snapshot);
  }

  async setConsent(
    context: HrWebChatContext,
    input: { action: "accept" | "decline" | "withdraw"; disclosureVersion: string }
  ): Promise<HrWebChatSessionState> {
    if (input.disclosureVersion !== this.options.store.currentConsentVersion()) {
      throw new HrWebChatPublicError(409, "DISCLOSURE_CHANGED", "授权说明已更新，请重新确认");
    }
    const snapshot = await this.setVisitorConsent(
      context.sessionId,
      `${input.action}:${input.disclosureVersion}`,
      input.action === "accept" ? "accepted" : "declined"
    );
    this.verifyBinding(context, snapshot.visitorId);
    return this.publicSessionState(snapshot);
  }

  async listMessages(
    context: HrWebChatContext,
    input: { after?: string; limit: number }
  ): Promise<HrWebChatMessagePage> {
    const snapshot = await this.open(context.sessionId);
    this.verifyBinding(context, snapshot.visitorId);
    if (snapshot.consentStatus !== "accepted") return { messages: [] };
    const start = input.after
      ? Math.max(0, snapshot.messages.findIndex((message) => message.id === input.after) + 1)
      : 0;
    const selected = snapshot.messages.slice(start, start + input.limit);
    const projectOptions = this.projectOptions(snapshot);
    return {
      messages: selected.map((message) => ({
        id: message.id,
        role: message.role,
        text: message.text,
        createdAt: message.createdAt,
        ...(message.messageType === "project-menu" ? { kind: "project-menu" as const } : {})
      })),
      ...(selected.length ? { cursor: selected.at(-1)!.id } : {}),
      ...(projectOptions ? { projectOptions } : {})
    };
  }

  async submitMessage(
    context: HrWebChatContext,
    input: { clientMessageId: string; text: string }
  ): Promise<HrWebChatSubmitResult> {
    const archived = await this.archiveVisitorMessage(context.sessionId, input.clientMessageId, input.text);
    this.verifyBinding(context, archived.visitor.id);
    await this.deliverProjectMenu(archived.visitor);
    const replyArchived = this.hasArchivedReply(archived.visitor.id, archived.message.id);
    if (!replyArchived && !this.pendingReplies.has(archived.message.id)) {
      this.pendingReplies.add(archived.message.id);
      const background = this.enqueue(context.sessionId, () => this.generateAndArchiveReply(
        context.sessionId,
        input.text.trim(),
        archived
      ));
      void background.then(
        () => { this.pendingReplies.delete(archived.message.id); },
        () => { this.pendingReplies.delete(archived.message.id); }
      );
    }
    return {
      acceptedMessageId: archived.message.id,
      replyStatus: replyArchived
        ? "sent"
        : this.pendingReplies.has(archived.message.id) ? "pending" : "unavailable",
      visitorId: archived.visitor.id
    };
  }

  async selectProject(
    context: HrWebChatContext,
    input: { projectId: string }
  ): Promise<HrWebChatProjectSelection> {
    const project = getHrWebProject(input.projectId);
    if (!project) throw new HrWebChatPublicError(404, "PROJECT_NOT_FOUND", "项目经历不存在");
    return this.enqueue(context.sessionId, async () => {
      const snapshot = await this.open(context.sessionId);
      this.verifyBinding(context, snapshot.visitorId);
      if (snapshot.consentStatus !== "accepted") {
        throw new HrWebChatPublicError(428, "CONSENT_REQUIRED", "授权后才能查看项目经历");
      }
      if (!this.hasProjectMenu(snapshot)) {
        throw new HrWebChatPublicError(409, "PROJECTS_NOT_READY", "项目经历尚未准备好，请稍后再试");
      }
      const existing = snapshot.messages.find((message) =>
        message.direction === "outbound" && message.channelMessageId === projectEventId(snapshot.visitorId, project.id));
      if (existing) {
        return {
          project: card(project),
          message: toPublicMessage(existing),
          visitorId: snapshot.visitorId
        };
      }
      const visitor = this.options.store.getVisitor(snapshot.visitorId);
      if (!visitor) throw new HrStoreError("HR visitor not found", "NOT_FOUND");
      const archived = await this.options.store.archiveOutbound({
        channelMessageId: projectEventId(visitor.id, project.id),
        openKfid: WEB_ENTRY_ID,
        externalUserId: visitor.externalUserId,
        text: formatHrWebProjectDetail(project),
        messageType: "project-detail"
      });
      return {
        project: card(project),
        message: toPublicMessage(archived.message),
        visitorId: visitor.id
      };
    });
  }

  async getResume(context: HrWebChatContext): Promise<HrWebChatResume> {
    const snapshot = await this.open(context.sessionId);
    this.verifyBinding(context, snapshot.visitorId);
    if (snapshot.consentStatus !== "accepted" || !snapshot.resume) {
      throw new HrWebChatPublicError(404, "RESUME_UNAVAILABLE", "简历暂不可用");
    }
    return this.getResumeFile(context.sessionId, snapshot.resume.id);
  }

  open(visitorKey: string): Promise<HrWebChatSnapshot> {
    const existing = this.options.store.findVisitor(WEB_ENTRY_ID, visitorKey);
    if (existing) return Promise.resolve(this.snapshot(existing));
    return this.enqueue(visitorKey, async () => {
      const visitor = await this.ensureVisitor(visitorKey);
      return this.snapshot(visitor);
    });
  }

  private setVisitorConsent(
    visitorKey: string,
    actionId: string,
    status: "accepted" | "declined"
  ): Promise<HrWebChatSnapshot> {
    return this.enqueue(visitorKey, async () => {
      let visitor = (await this.options.store.recordPreConsentEvent({
        channelMessageId: eventId("consent", visitorKey, actionId),
        openKfid: WEB_ENTRY_ID,
        externalUserId: visitorKey,
        messageType: "consent"
      })).visitor;
      const transition = await this.options.store.transitionVisitorConsent(visitor.id, status);
      visitor = transition.visitor;
      if (status === "accepted") {
        await this.deliverIntroduction(visitor);
        visitor = this.options.store.getVisitor(visitor.id) ?? visitor;
      }
      return this.snapshot(visitor);
    });
  }

  private async archiveVisitorMessage(
    visitorKey: string,
    clientMessageId: string,
    text: string
  ): Promise<ArchiveHrMessageResult> {
    this.requireAcceptedVisitor(visitorKey);
    const normalizedText = text.trim();
    if (!normalizedText) throw new HrStoreError("Message text is required", "VALIDATION");
    if (normalizedText.length > 6_000) throw new HrStoreError("Message text is too long", "VALIDATION");
    const inboundEvent: WecomCustomerServiceInboundEvent = {
      corpId: "web",
      channelMessageId: eventId("message", visitorKey, clientMessageId),
      openKfid: WEB_ENTRY_ID,
      externalUserId: visitorKey,
      text: normalizedText,
      messageType: "text"
    };
    return this.options.store.archiveInbound(inboundEvent);
  }

  private async generateAndArchiveReply(
    visitorKey: string,
    normalizedText: string,
    archived: ArchiveHrMessageResult
  ): Promise<void> {
    const inboundEvent: WecomCustomerServiceInboundEvent = {
      corpId: "web",
      channelMessageId: archived.message.channelMessageId,
      openKfid: WEB_ENTRY_ID,
      externalUserId: visitorKey,
      text: normalizedText,
      messageType: "text"
    };
    const disposition: HrInboundDisposition = {
      ...archived,
      disposition: "archived-isolated",
      localCodexAllowed: false
    };
    let generated: string | undefined;
    const codexStartedAt = Date.now();
    if (this.options.codexEngine && this.options.hrStatePath) {
      try {
        generated = await this.generateCodexReply(normalizedText, archived.visitor.id, archived.opportunity.id);
      } catch {
        // The public response remains deterministic; an optional tool-free provider may still answer.
      }
    }
    const codexFailedQuickly = Date.now() - codexStartedAt < 5_000;
    if (!generated && (!this.options.codexEngine || codexFailedQuickly)) {
      try {
        generated = await this.options.aiService?.generateReply(inboundEvent, disposition);
      } catch {
        generated = undefined;
      }
    }
    const reply = generated?.trim() || FALLBACK_REPLY;
    await this.options.store.archiveOutbound({
      channelMessageId: replyEventId(archived.message.id),
      openKfid: WEB_ENTRY_ID,
      externalUserId: visitorKey,
      text: reply,
      messageType: generated ? "ai-text" : "service-status"
    });
  }

  private hasArchivedReply(visitorId: string, inboundMessageId: string): boolean {
    return this.options.store.listMessagesForVisitor(visitorId).some((message) =>
      message.direction === "outbound" && message.channelMessageId === replyEventId(inboundMessageId));
  }

  getResumeFile(visitorKey: string, resumeId: string): { path: string; name: string } {
    this.requireAcceptedVisitor(visitorKey);
    const materials = this.options.store.getMaterials();
    if (!materials.resume.configured || materials.resume.id !== resumeId) {
      throw new HrStoreError("Resume not found for this visitor", "NOT_FOUND");
    }
    return this.options.store.getResumeFile(resumeId);
  }

  private async ensureVisitor(visitorKey: string): Promise<HrVisitor> {
    const existing = this.options.store.findVisitor(WEB_ENTRY_ID, visitorKey);
    if (existing) return existing;
    return (await this.options.store.recordPreConsentEvent({
      channelMessageId: eventId("session", visitorKey, "created"),
      openKfid: WEB_ENTRY_ID,
      externalUserId: visitorKey,
      messageType: "session"
    })).visitor;
  }

  private requireAcceptedVisitor(visitorKey: string): HrVisitor {
    const visitor = this.options.store.findVisitor(WEB_ENTRY_ID, visitorKey);
    if (!visitor) throw new HrStoreError("HR visitor not found", "NOT_FOUND");
    if (visitor.consentStatus !== "accepted") {
      throw new HrStoreError("Visitor consent is required", "VALIDATION");
    }
    return visitor;
  }

  private async deliverIntroduction(visitor: HrVisitor): Promise<void> {
    const settings = this.options.store.getSettings();
    const materials = this.options.store.getMaterials();
    const introduction = [materials.bio, settings.welcomeMessage]
      .filter((part): part is string => Boolean(part?.trim()))
      .join("\n\n") || DEFAULT_INTRODUCTION;
    await this.options.store.archiveOutbound({
      channelMessageId: `web:intro:${visitor.id}:${this.options.store.currentConsentVersion()}`,
      openKfid: WEB_ENTRY_ID,
      externalUserId: visitor.externalUserId,
      text: introduction,
      messageType: "introduction"
    });
    if (materials.resume.configured && materials.resume.id) {
      await this.options.store.archiveOutbound({
        channelMessageId: `web:resume:${visitor.id}:${materials.resume.id}`,
        openKfid: WEB_ENTRY_ID,
        externalUserId: visitor.externalUserId,
        text: `候选人原始简历：${materials.resume.name ?? "简历.pdf"}`,
        messageType: "file",
        attachments: [{ type: "file", ...(materials.resume.name ? { name: materials.resume.name } : {}) }]
      });
    }
    await this.options.store.archiveOutbound({
      channelMessageId: `web:company-prompt:${visitor.id}:${this.options.store.currentConsentVersion()}`,
      openKfid: WEB_ENTRY_ID,
      externalUserId: visitor.externalUserId,
      text: COMPANY_PROMPT,
      messageType: "company-prompt"
    });
    const current = this.options.store.getVisitor(visitor.id);
    if (current?.materialsDeliveryId && current.materialsStatus !== "sent") {
      await this.options.store.setMaterialsDeliveryStatus(current.id, current.materialsDeliveryId, "sent");
    }
  }

  private async generateCodexReply(message: string, visitorId: string, opportunityId: string): Promise<string> {
    const visitor = this.options.store.getVisitor(visitorId);
    if (!visitor) throw new HrStoreError("HR visitor not found", "NOT_FOUND");
    const opportunity = this.options.store.getOpportunity(opportunityId);
    const materials = this.options.store.getMaterials();
    const settings = this.options.store.getSettings();
    const query = [message, opportunity.company, opportunity.role, ...opportunity.concerns, ...opportunity.conditions]
      .filter(Boolean)
      .join(" ")
      .slice(0, 8_000);
    const knowledge = await retrieveHrKnowledge(
      readConfiguredKnowledgeRoots(this.options.hrStatePath!),
      query
    );
    const result = await this.options.codexEngine!.reply({
      visitorId,
      ...(visitor.codexThreadId ? { threadId: visitor.codexThreadId } : {}),
      message,
      context: {
        candidateProfile: {
          bio: materials.bio ?? "待确认",
          targetRoles: settings.targetRoles,
          profileKeywords: settings.profileKeywords
        },
        opportunity: {
          company: opportunity.company ?? "待确认",
          role: opportunity.role ?? "待确认",
          stage: opportunity.stage,
          conditions: opportunity.conditions,
          concerns: opportunity.concerns,
          invitationScore: opportunity.invitationScore,
          fitScore: opportunity.fitScore ?? "待确认",
          needsConfirmation: opportunity.needsConfirmation,
          evidence: opportunity.evidence.map((item) => ({ kind: item.kind, quote: item.quote }))
        },
        knowledgeExcerpts: knowledge.chunks.map((chunk) => ({
          source: chunk.source,
          text: chunk.text
        })),
        recentConversation: opportunity.messages.slice(-20).map((item) => ({
          speaker: item.direction === "inbound" ? "hr" as const : "assistant" as const,
          text: item.text
        }))
      },
      onThreadStarted: async (threadId) => {
        await this.options.store.setVisitorCodexThreadId(visitorId, threadId);
      }
    });
    return enforceNoCommitment(result.text);
  }

  private snapshot(visitor: HrVisitor): HrWebChatSnapshot {
    const materials: HrMaterialsSummary = this.options.store.getMaterials();
    return {
      visitorId: visitor.id,
      consentStatus: visitor.consentStatus,
      disclosure: this.options.store.getSettings().aiDisclosure,
      messages: visitor.consentStatus === "accepted"
        ? this.options.store.listMessagesForVisitor(visitor.id)
        : [],
      ...(visitor.consentStatus === "accepted" && materials.resume.configured && materials.resume.id
        && materials.resume.name && materials.resume.size !== undefined ? {
          resume: {
            id: materials.resume.id,
            name: materials.resume.name,
            size: materials.resume.size
          }
        } : {})
    };
  }

  private publicSessionState(snapshot: HrWebChatSnapshot): HrWebChatSessionState {
    return {
      consentStatus: snapshot.consentStatus,
      disclosure: snapshot.disclosure,
      disclosureVersion: this.options.store.currentConsentVersion(),
      resumeAvailable: Boolean(snapshot.resume),
      visitorId: snapshot.visitorId
    };
  }

  private projectOptions(snapshot: HrWebChatSnapshot): HrWebProjectCard[] | undefined {
    return this.hasProjectMenu(snapshot) ? listHrWebProjectCards() : undefined;
  }

  private hasProjectMenu(snapshot: HrWebChatSnapshot): boolean {
    return snapshot.consentStatus === "accepted"
      && snapshot.messages.some((message) => message.direction === "inbound")
      && snapshot.messages.some((message) => message.direction === "outbound" && message.messageType === "project-menu");
  }

  private async deliverProjectMenu(visitor: HrVisitor): Promise<void> {
    const messages = this.options.store.listMessagesForVisitor(visitor.id);
    if (!messages.some((message) => message.direction === "inbound")) return;
    if (messages.some((message) => message.direction === "outbound" && message.messageType === "project-menu")) return;
    await this.options.store.archiveOutbound({
      channelMessageId: projectMenuEventId(visitor.id),
      openKfid: WEB_ENTRY_ID,
      externalUserId: visitor.externalUserId,
      text: PROJECT_MENU_PROMPT,
      messageType: "project-menu"
    });
  }

  private verifyBinding(context: HrWebChatContext, visitorId: string): void {
    if (context.visitorId && context.visitorId !== visitorId) {
      throw new HrWebChatPublicError(401, "SESSION_INVALID", "会话身份无效");
    }
  }

  private enqueue<T>(visitorKey: string, operation: () => Promise<T>): Promise<T> {
    const key = crypto.createHash("sha256").update(visitorKey).digest("hex");
    const previous = this.queues.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    this.queues.set(key, settled);
    void settled.finally(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key);
    });
    return result;
  }
}

function eventId(kind: string, visitorKey: string, clientId: string): string {
  const digest = crypto.createHash("sha256")
    .update(`${kind}\0${visitorKey}\0${clientId}`)
    .digest("base64url");
  return `web:${kind}:${digest}`;
}

function replyEventId(inboundMessageId: string): string {
  return `web:reply:${inboundMessageId}`;
}

function projectMenuEventId(visitorId: string): string {
  return `web:project-menu:${visitorId}`;
}

function projectEventId(visitorId: string, projectId: string): string {
  return `web:project:${visitorId}:${PROJECT_CATALOG_REVISION}:${projectId}`;
}

function card(project: ReturnType<typeof getHrWebProject>): HrWebProjectCard {
  if (!project) throw new HrStoreError("HR project not found", "NOT_FOUND");
  const { id, title, category, summary, dateLabel, statusLabel } = project;
  return {
    id,
    title,
    category,
    summary,
    ...(dateLabel ? { dateLabel } : {}),
    ...(statusLabel ? { statusLabel } : {})
  };
}

function toPublicMessage(message: HrArchivedMessage): {
  id: string;
  role: "visitor" | "assistant";
  text: string;
  createdAt: string;
} {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    createdAt: message.createdAt
  };
}
