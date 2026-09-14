import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { SecretProtector } from "../security/dpapi.js";
import { writeJsonFile } from "./json-store.js";
import type { StatePaths } from "./paths.js";

const DOCUMENT_VERSION = 2;
const MAX_MESSAGE_TEXT = 20_000;
const MAX_DISCLOSURE_BYTES = 1_024;
const MAX_INTRO_MESSAGE_BYTES = 2_048;
const MAX_RESUME_SIZE_BYTES = 20 * 1024 * 1024;
const PDF_MAGIC = Buffer.from("%PDF-", "ascii");
const MAX_MATERIAL_DELIVERY_RECORDS = 500;
const MAX_PROVIDER_MESSAGE_IDS_PER_COMPONENT = 5;
const DEFAULT_DISCLOSURE = "你好，我是候选人的 AI 助手 ClawBot。聊天记录会用于回答招聘问题、整理岗位信息与面试邀约，并由候选人本人审核重要承诺。";

export const HR_CHANNEL = "wecom-wechat-customer-service" as const;
export const HR_WEB_CHANNEL = "wechat-h5-web-chat" as const;
export type HrChannel = typeof HR_CHANNEL | typeof HR_WEB_CHANNEL;

export type HrOpportunityStage =
  | "unknown"
  | "sourcing"
  | "screening"
  | "interview-proposed"
  | "interview-scheduled"
  | "offer";

export type HrEvidenceKind = "company" | "role" | "condition" | "concern" | "invitation" | "fit";
export type HrDraftType = "invitation-analysis" | "interview-advice" | "resume-improvements" | "follow-up";

type HrSettingsRecord = {
  channel: typeof HR_CHANNEL;
  enabled: boolean;
  stableId: string;
  corpId?: string;
  openKfid?: string;
  serviceLink?: string;
  callbackPublicUrl?: string;
  encryptedSecret?: string;
  encryptedToken?: string;
  encryptedEncodingAesKey?: string;
  welcomeMessage?: string;
  aiDisclosure: string;
  targetRoles: string[];
  profileKeywords: string[];
  createdAt: string;
  updatedAt: string;
};

export type HrSettingsSummary = {
  channel: typeof HR_CHANNEL;
  enabled: boolean;
  stableId: string;
  corpId?: string;
  openKfid?: string;
  openKfId?: string;
  serviceLink?: string;
  contactUrl?: string;
  callbackPublicUrl?: string;
  welcomeMessage?: string;
  aiDisclosure: string;
  targetRoles: string[];
  profileKeywords: string[];
  hasSecret: boolean;
  hasToken: boolean;
  hasEncodingAesKey: boolean;
  configured: boolean;
  createdAt: string;
  updatedAt: string;
};

export type UpdateHrSettingsInput = {
  enabled?: boolean;
  corpId?: string | null;
  openKfid?: string | null;
  openKfId?: string | null;
  serviceLink?: string | null;
  contactUrl?: string | null;
  callbackPublicUrl?: string | null;
  secret?: string | null;
  token?: string | null;
  encodingAesKey?: string | null;
  welcomeMessage?: string | null;
  aiDisclosure?: string | null;
  targetRoles?: string[];
  profileKeywords?: string[];
};

export type HrVisitor = {
  id: string;
  channel: HrChannel;
  openKfid: string;
  externalUserId: string;
  displayName?: string;
  consentStatus: "pending" | "accepted" | "declined";
  consentAt?: string;
  consentVersion?: string;
  materialsStatus: "not-sent" | "pending" | "sent" | "failed";
  materialsSentAt?: string;
  materialsDeliveryId?: string;
  codexThreadId?: string;
  lastPreConsentEventId?: string;
  processedConsentEventIds: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  messageCount: number;
};

export type HrArchivedAttachment = {
  type: "image" | "file" | "video" | "audio" | "unknown";
  name?: string;
};

export type HrArchivedMessage = {
  id: string;
  channelMessageId: string;
  visitorId: string;
  opportunityId: string;
  direction: "inbound" | "outbound";
  role: "visitor" | "assistant";
  text: string;
  content: string;
  messageType: string;
  attachments: HrArchivedAttachment[];
  createdAt: string;
};

export type HrEvidence = {
  id: string;
  messageId: string;
  kind: HrEvidenceKind;
  label: string;
  text: string;
  quote: string;
  createdAt: string;
};

export type HrOpportunity = {
  id: string;
  visitorId: string;
  openKfid: string;
  consentStatus?: "pending" | "accepted" | "declined" | "not_required";
  consentedAt?: string;
  company?: string;
  role?: string;
  conditions: string[];
  concerns: string[];
  stage: HrOpportunityStage;
  invitationScore: number;
  fitScore?: number;
  priorityScore: number;
  status: "active" | "archived";
  evidence: HrEvidence[];
  needsConfirmation: string[];
  missingFields: string[];
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
};

export type HrDraft = {
  id: string;
  opportunityId: string;
  type: HrDraftType;
  status: "draft" | "reviewed" | "approved" | "rejected";
  generator: "local-template";
  isAiGenerated: false;
  content: string;
  createdAt: string;
  updatedAt: string;
};

type HrResumeVersion = {
  id: string;
  name: string;
  path: string;
  sha256: string;
  size: number;
  version: number;
  createdAt: string;
};

type HrKnowledgeBaseDocument = {
  id: string;
  name: string;
  path: string;
  kind: "file" | "directory";
  sha256?: string;
  addedAt: string;
};

type HrMaterialsRecord = {
  bio?: string;
  currentResumeId?: string;
  resumeVersions: HrResumeVersion[];
  knowledgeBaseDocuments: HrKnowledgeBaseDocument[];
  updatedAt?: string;
};

type HrIntegrationRuntime = {
  syncCursors: Record<string, string>;
  materialDeliveries: HrMaterialDeliveryRecord[];
  callbackVerifiedAt?: string;
  updatedAt?: string;
};

export type HrMaterialDeliveryComponent = "intro" | "resume";
export type HrMaterialDeliveryComponentStatus = "pending" | "submitted" | "failed";

type HrMaterialDeliveryComponentRecord = {
  status: HrMaterialDeliveryComponentStatus;
  providerMessageId?: string;
  providerMessageIds: string[];
  updatedAt: string;
};

export type HrMaterialDeliveryRecord = {
  deliveryId: string;
  visitorId: string;
  openKfid: string;
  externalUserId: string;
  components: Partial<Record<HrMaterialDeliveryComponent, HrMaterialDeliveryComponentRecord>>;
  createdAt: string;
  updatedAt: string;
};

export type UpdateHrMaterialsInput = {
  disclosure?: string | null;
  bio?: string | null;
  resumePath?: string | null;
  knowledgeBasePaths?: string[];
};

export type HrMaterialsSummary = {
  supported: true;
  editable: true;
  saveEndpoint: "/api/hr/materials";
  disclosure: string;
  bio?: string;
  resume: {
    configured: boolean;
    id?: string;
    name?: string;
    hash?: string;
    version?: number;
    size?: number;
    url?: string;
  };
  resumeVersions: Array<{
    id: string;
    name: string;
    hash: string;
    version: number;
    size: number;
    createdAt: string;
    url: string;
  }>;
  knowledgeBase: {
    configured: boolean;
    documentCount: number;
    documents: Array<{ id: string; name: string; kind: "file" | "directory"; hash?: string; addedAt: string }>;
    updatedAt?: string;
  };
};

type HrDocument = {
  version: 2;
  settings: HrSettingsRecord;
  materials: HrMaterialsRecord;
  integration: HrIntegrationRuntime;
  visitors: HrVisitor[];
  messages: HrArchivedMessage[];
  opportunities: HrOpportunity[];
  drafts: HrDraft[];
};

export type ArchiveHrMessageInput = {
  channelMessageId: string;
  openKfid: string;
  externalUserId: string;
  displayName?: string;
  text?: string;
  messageType?: string;
  attachments?: HrArchivedAttachment[];
  createdAt?: string;
};

export type ArchiveHrMessageResult = {
  duplicate: boolean;
  visitor: HrVisitor;
  message: HrArchivedMessage;
  opportunity: HrOpportunity;
};

export type HrOpportunityDetail = HrOpportunity & {
  visitor: HrVisitor;
  messages: HrArchivedMessage[];
  drafts: HrDraft[];
};

export type HrStoreErrorCode = "NOT_FOUND" | "VALIDATION" | "STORAGE" | "NOT_CONFIGURED" | "CONFLICT";

export class HrStoreError extends Error {
  constructor(message: string, readonly code: HrStoreErrorCode) {
    super(message);
    this.name = "HrStoreError";
  }
}

export class HrStore {
  private document: HrDocument;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly paths: StatePaths,
    private readonly protector: SecretProtector,
    private readonly now: () => Date = () => new Date()
  ) {
    const exists = fs.existsSync(paths.hrPath);
    const loaded = exists ? readDocument(paths) : { document: emptyDocument(this.now()), migrated: false };
    this.document = loaded.document;
    if (!exists || loaded.migrated) this.persist();
  }

  getSettings(): HrSettingsSummary {
    return settingsSummary(this.document.settings, this.document.materials);
  }

  getCallbackCredentialsRevision(): string {
    const settings = this.document.settings;
    return sha256Text([
      settings.corpId ?? "",
      settings.encryptedToken ?? "",
      settings.encryptedEncodingAesKey ?? ""
    ].join("\0"));
  }

  updateSettings(input: UpdateHrSettingsInput): Promise<HrSettingsSummary> {
    return this.enqueueMutation(async () => {
      const current = this.document.settings;
      const suppliedOpenIds = [input.openKfid, input.openKfId].filter((value) => value !== undefined);
      const openKfidInput = input.openKfid ?? input.openKfId;
      if (new Set(suppliedOpenIds.map(cleanOptional)).size > 1) {
        throw new HrStoreError("openKfid and openKfId must refer to the same WeChat Customer Service account", "VALIDATION");
      }
      const serviceLinkInput = input.serviceLink !== undefined ? input.serviceLink : input.contactUrl;
      const [encryptedSecret, encryptedToken, encryptedEncodingAesKey] = await Promise.all([
        this.updateSecret(current.encryptedSecret, input.secret, "secret"),
        this.updateSecret(current.encryptedToken, input.token, "token"),
        this.updateSecret(current.encryptedEncodingAesKey, input.encodingAesKey, "encodingAesKey")
      ]);
      const next: HrSettingsRecord = {
        ...current,
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        corpId: updatedOptional(current.corpId, input.corpId, 128, "corpId"),
        openKfid: updatedOptional(current.openKfid, openKfidInput, 256, "openKfid"),
        serviceLink: serviceLinkInput === undefined
          ? current.serviceLink
          : normalizeServiceLink(serviceLinkInput),
        callbackPublicUrl: input.callbackPublicUrl === undefined
          ? current.callbackPublicUrl
          : normalizeCallbackPublicUrl(input.callbackPublicUrl),
        welcomeMessage: updatedOptional(current.welcomeMessage, input.welcomeMessage, 2_000, "welcomeMessage"),
        aiDisclosure: input.aiDisclosure === undefined
          ? current.aiDisclosure
          : normalizeDisclosure(input.aiDisclosure),
        targetRoles: input.targetRoles === undefined ? current.targetRoles : normalizeList(input.targetRoles, 50, 100),
        profileKeywords: input.profileKeywords === undefined ? current.profileKeywords : normalizeList(input.profileKeywords, 100, 100),
        encryptedSecret,
        encryptedToken,
        encryptedEncodingAesKey,
        updatedAt: this.now().toISOString()
      };
      const identityChanged = Boolean(current.corpId || current.openKfid)
        && (next.corpId !== current.corpId || next.openKfid !== current.openKfid);
      if (identityChanged) {
        next.enabled = false;
        delete next.serviceLink;
      }
      if (input.welcomeMessage !== undefined) {
        requireIntroductionWithinLimit(this.document.materials.bio, next.welcomeMessage);
      }
      if (next.enabled) {
        requireIntroductionWithinLimit(this.document.materials.bio, next.welcomeMessage);
      }
      if (next.enabled && !isConfigured(next, this.document.materials)) {
        if (!disclosureFitsMenu(next.aiDisclosure)) {
          throw new HrStoreError(
            `aiDisclosure must not exceed ${MAX_DISCLOSURE_BYTES} UTF-8 bytes before WeChat Customer Service can be enabled`,
            "VALIDATION"
          );
        }
        throw new HrStoreError(
          "WeChat Customer Service requires corpId, openKfid, serviceLink, callbackPublicUrl, secret, callback token and encodingAesKey before it can be enabled",
          "NOT_CONFIGURED"
        );
      }
      const disclosureChanged = next.aiDisclosure !== current.aiDisclosure;
      const callbackChanged = identityChanged
        || next.corpId !== current.corpId
        || next.callbackPublicUrl !== current.callbackPublicUrl
        || next.encryptedToken !== current.encryptedToken
        || next.encryptedEncodingAesKey !== current.encryptedEncodingAesKey;
      const previousDocument = this.document;
      this.document = structuredClone(this.document);
      this.document.settings = next;
      if (disclosureChanged) this.resetAcceptedConsent();
      if (callbackChanged) delete this.document.integration.callbackVerifiedAt;
      if (identityChanged) {
        if (current.openKfid) delete this.document.integration.syncCursors[current.openKfid];
        if (next.openKfid) delete this.document.integration.syncCursors[next.openKfid];
        this.document.integration.updatedAt = next.updatedAt;
      }
      try {
        this.persist();
      } catch (error) {
        this.document = previousDocument;
        throw error;
      }
      return settingsSummary(next, this.document.materials);
    });
  }

  async readCredentials(): Promise<{
    corpId: string;
    openKfid: string;
    secret: string;
    token: string;
    encodingAesKey: string;
  }> {
    const [api, callback] = await Promise.all([this.readApiCredentials(), this.readCallbackCredentials()]);
    return { ...api, ...callback };
  }

  async readApiCredentials(): Promise<{
    corpId: string;
    openKfid: string;
    secret: string;
  }> {
    const settings = this.document.settings;
    if (!settings.corpId || !settings.openKfid || !settings.encryptedSecret) {
      throw new HrStoreError("WeChat Customer Service API credentials are incomplete", "NOT_CONFIGURED");
    }
    try {
      const secret = await this.protector.unprotect(settings.encryptedSecret);
      return {
        corpId: settings.corpId,
        openKfid: settings.openKfid,
        secret
      };
    } catch (error) {
      if (error instanceof HrStoreError) throw error;
      throw new HrStoreError("Unable to decrypt WeChat Customer Service API credentials", "STORAGE");
    }
  }

  async readCallbackCredentials(): Promise<{
    corpId: string;
    token: string;
    encodingAesKey: string;
  }> {
    const settings = this.document.settings;
    if (!settings.corpId || !settings.encryptedToken || !settings.encryptedEncodingAesKey) {
      throw new HrStoreError("WeChat Customer Service callback credentials are incomplete", "NOT_CONFIGURED");
    }
    try {
      const [token, encodingAesKey] = await Promise.all([
        this.protector.unprotect(settings.encryptedToken),
        this.protector.unprotect(settings.encryptedEncodingAesKey)
      ]);
      return { corpId: settings.corpId, token, encodingAesKey };
    } catch (error) {
      if (error instanceof HrStoreError) throw error;
      throw new HrStoreError("Unable to decrypt WeChat Customer Service callback credentials", "STORAGE");
    }
  }

  getSyncCursor(openKfid: string): string | undefined {
    const cursor = this.document.integration.syncCursors[required(openKfid, "openKfid", 256)];
    return cursor || undefined;
  }

  setSyncCursor(openKfid: string, cursor: string): Promise<void> {
    const normalizedOpenKfid = required(openKfid, "openKfid", 256);
    const normalizedCursor = required(cursor, "cursor", 2_048);
    return this.enqueueMutation(() => {
      this.document.integration.syncCursors[normalizedOpenKfid] = normalizedCursor;
      this.document.integration.updatedAt = this.now().toISOString();
      this.persist();
    });
  }

  getCallbackVerifiedAt(): string | undefined {
    return this.document.integration.callbackVerifiedAt;
  }

  markCallbackVerified(): Promise<string> {
    return this.enqueueMutation(() => {
      const timestamp = this.now().toISOString();
      this.document.integration.callbackVerifiedAt = timestamp;
      this.document.integration.updatedAt = timestamp;
      this.persist();
      return timestamp;
    });
  }

  getMaterialDelivery(deliveryId: string): HrMaterialDeliveryRecord | undefined {
    const normalizedDeliveryId = required(deliveryId, "deliveryId", 256);
    const delivery = this.document.integration.materialDeliveries.find((candidate) =>
      candidate.deliveryId === normalizedDeliveryId);
    return delivery ? structuredClone(delivery) : undefined;
  }

  ensureMaterialDelivery(input: {
    deliveryId: string;
    visitorId: string;
    components: HrMaterialDeliveryComponent[];
  }): Promise<HrMaterialDeliveryRecord> {
    const deliveryId = required(input.deliveryId, "deliveryId", 256);
    const visitorId = required(input.visitorId, "visitorId", 256);
    const components = [...new Set(input.components)];
    if (components.some((component) => component !== "intro" && component !== "resume")) {
      throw new HrStoreError("Material delivery component is invalid", "VALIDATION");
    }
    return this.enqueueMutation(() => {
      const visitor = this.document.visitors.find((candidate) => candidate.id === visitorId);
      if (!visitor) throw new HrStoreError("HR visitor not found", "NOT_FOUND");
      if (visitor.consentStatus !== "accepted" || visitor.materialsDeliveryId !== deliveryId) {
        throw new HrStoreError("Material delivery attempt is stale or not consented", "CONFLICT");
      }
      const timestamp = this.now().toISOString();
      let delivery = this.document.integration.materialDeliveries.find((candidate) =>
        candidate.deliveryId === deliveryId);
      if (!delivery) {
        delivery = {
          deliveryId,
          visitorId,
          openKfid: visitor.openKfid,
          externalUserId: visitor.externalUserId,
          components: {},
          createdAt: timestamp,
          updatedAt: timestamp
        };
        this.document.integration.materialDeliveries.push(delivery);
      } else if (delivery.visitorId !== visitorId || delivery.openKfid !== visitor.openKfid
        || delivery.externalUserId !== visitor.externalUserId) {
        throw new HrStoreError("Material delivery identity does not match", "CONFLICT");
      }
      for (const existing of ["intro", "resume"] as const) {
        if (!components.includes(existing)) delete delivery.components[existing];
      }
      for (const component of components) {
        delivery.components[component] ??= {
          status: "pending",
          providerMessageIds: [],
          updatedAt: timestamp
        };
      }
      delivery.updatedAt = timestamp;
      this.syncVisitorMaterialDelivery(delivery);
      this.pruneMaterialDeliveries();
      this.document.integration.updatedAt = timestamp;
      this.persist();
      return structuredClone(delivery);
    });
  }

  markMaterialComponentSubmitted(
    deliveryId: string,
    component: HrMaterialDeliveryComponent,
    providerMessageId: string
  ): Promise<HrMaterialDeliveryRecord> {
    const normalizedMessageId = required(providerMessageId, "providerMessageId", 256);
    return this.enqueueMutation(() => {
      const delivery = this.requireMaterialDelivery(deliveryId);
      const componentRecord = delivery.components[component];
      if (!componentRecord) throw new HrStoreError("Material delivery component is not planned", "CONFLICT");
      const timestamp = this.now().toISOString();
      componentRecord.status = "submitted";
      componentRecord.providerMessageId = normalizedMessageId;
      componentRecord.providerMessageIds = uniqueStrings([
        ...componentRecord.providerMessageIds,
        normalizedMessageId
      ]).slice(-MAX_PROVIDER_MESSAGE_IDS_PER_COMPONENT);
      componentRecord.updatedAt = timestamp;
      delivery.updatedAt = timestamp;
      this.syncVisitorMaterialDelivery(delivery);
      this.document.integration.updatedAt = timestamp;
      this.persist();
      return structuredClone(delivery);
    });
  }

  markMaterialComponentFailed(
    deliveryId: string,
    component: HrMaterialDeliveryComponent
  ): Promise<HrMaterialDeliveryRecord> {
    return this.enqueueMutation(() => {
      const delivery = this.requireMaterialDelivery(deliveryId);
      const componentRecord = delivery.components[component];
      if (!componentRecord) throw new HrStoreError("Material delivery component is not planned", "CONFLICT");
      const timestamp = this.now().toISOString();
      componentRecord.status = "failed";
      componentRecord.updatedAt = timestamp;
      delivery.updatedAt = timestamp;
      this.syncVisitorMaterialDelivery(delivery);
      this.document.integration.updatedAt = timestamp;
      this.persist();
      return structuredClone(delivery);
    });
  }

  markMaterialComponentFailedByProviderMessageId(providerMessageId: string): Promise<{
    matched: boolean;
    currentAttempt: boolean;
    delivery?: HrMaterialDeliveryRecord;
    component?: HrMaterialDeliveryComponent;
  }> {
    const normalizedMessageId = required(providerMessageId, "providerMessageId", 256);
    return this.enqueueMutation(() => {
      const deliveries = [...this.document.integration.materialDeliveries]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      for (const delivery of deliveries) {
        for (const component of ["intro", "resume"] as const) {
          const record = delivery.components[component];
          if (!record?.providerMessageIds.includes(normalizedMessageId)) continue;
          const currentAttempt = record.providerMessageId === normalizedMessageId;
          if (currentAttempt && record.status !== "failed") {
            const timestamp = this.now().toISOString();
            record.status = "failed";
            record.updatedAt = timestamp;
            delivery.updatedAt = timestamp;
            this.syncVisitorMaterialDelivery(delivery);
            this.document.integration.updatedAt = timestamp;
            this.persist();
          }
          return { matched: true, currentAttempt, delivery: structuredClone(delivery), component };
        }
      }
      return { matched: false, currentAttempt: false };
    });
  }

  listVisitors(): HrVisitor[] {
    return structuredClone(this.document.visitors).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  getMaterials(): HrMaterialsSummary {
    const materials = this.document.materials;
    const current = materials.resumeVersions.find((resume) => resume.id === materials.currentResumeId);
    return {
      supported: true,
      editable: true,
      saveEndpoint: "/api/hr/materials",
      disclosure: this.document.settings.aiDisclosure,
      ...(materials.bio ? { bio: materials.bio } : {}),
      resume: current ? {
        configured: true,
        id: current.id,
        name: current.name,
        hash: current.sha256,
        version: current.version,
        size: current.size,
        url: `/api/hr/materials/resumes/${encodeURIComponent(current.id)}`
      } : { configured: false },
      resumeVersions: materials.resumeVersions.map((resume) => ({
        id: resume.id,
        name: resume.name,
        hash: resume.sha256,
        version: resume.version,
        size: resume.size,
        createdAt: resume.createdAt,
        url: `/api/hr/materials/resumes/${encodeURIComponent(resume.id)}`
      })),
      knowledgeBase: {
        configured: materials.knowledgeBaseDocuments.length > 0,
        documentCount: materials.knowledgeBaseDocuments.length,
        documents: materials.knowledgeBaseDocuments.map(({ path: _path, sha256, ...document }) => ({
          ...document,
          ...(sha256 ? { hash: sha256 } : {})
        })),
        ...(materials.updatedAt ? { updatedAt: materials.updatedAt } : {})
      }
    };
  }

  getVisitor(id: string): HrVisitor | undefined {
    const visitor = this.document.visitors.find((candidate) => candidate.id === id);
    return visitor ? structuredClone(visitor) : undefined;
  }

  setVisitorCodexThreadId(visitorId: string, threadId: string): Promise<HrVisitor> {
    return this.enqueueMutation(() => {
      const visitor = this.document.visitors.find((candidate) => candidate.id === required(visitorId, "visitorId", 256));
      if (!visitor) throw new HrStoreError("HR visitor not found", "NOT_FOUND");
      const normalizedThreadId = required(threadId, "threadId", 256);
      if (visitor.codexThreadId && visitor.codexThreadId !== normalizedThreadId) {
        throw new HrStoreError("HR visitor already has a different Codex thread", "CONFLICT");
      }
      if (!visitor.codexThreadId) {
        visitor.codexThreadId = normalizedThreadId;
        this.persist();
      }
      return structuredClone(visitor);
    });
  }

  listMessagesForVisitor(visitorId: string): HrArchivedMessage[] {
    const visitor = this.document.visitors.find((candidate) => candidate.id === visitorId);
    if (!visitor) throw new HrStoreError("HR visitor not found", "NOT_FOUND");
    return structuredClone(this.document.messages)
      .filter((message) => message.visitorId === visitor.id)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  findVisitor(openKfid: string, externalUserId: string): HrVisitor | undefined {
    const visitor = this.document.visitors.find((candidate) =>
      candidate.openKfid === openKfid && candidate.externalUserId === externalUserId);
    return visitor ? structuredClone(visitor) : undefined;
  }

  recordPreConsentEvent(input: ArchiveHrMessageInput): Promise<{ duplicate: boolean; visitor: HrVisitor }> {
    return this.enqueueMutation(() => this.recordPreConsentEventNow(input));
  }

  private recordPreConsentEventNow(input: ArchiveHrMessageInput): { duplicate: boolean; visitor: HrVisitor } {
    const openKfid = required(input.openKfid, "openKfid", 256);
    const externalUserId = required(input.externalUserId, "externalUserId", 256);
    const channelMessageId = required(input.channelMessageId, "channelMessageId", 256);
    const createdAt = validTimestamp(input.createdAt) ?? this.now().toISOString();
    const visitor = this.ensureVisitor(openKfid, externalUserId, input.displayName, createdAt);
    const duplicate = visitor.processedConsentEventIds.includes(channelMessageId);
    if (!duplicate) {
      visitor.lastPreConsentEventId = channelMessageId;
      visitor.processedConsentEventIds.push(channelMessageId);
      visitor.processedConsentEventIds = visitor.processedConsentEventIds.slice(-100);
      visitor.lastSeenAt = laterTimestamp(visitor.lastSeenAt, createdAt);
      this.persist();
    }
    return { duplicate, visitor: structuredClone(visitor) };
  }

  setVisitorConsent(
    visitorId: string,
    status: "accepted" | "declined",
    consentVersion = this.currentConsentVersion()
  ): Promise<HrVisitor> {
    return this.enqueueMutation(() => this.transitionVisitorConsentNow(visitorId, status, consentVersion).visitor);
  }

  transitionVisitorConsent(
    visitorId: string,
    status: "accepted" | "declined",
    consentVersion = this.currentConsentVersion()
  ): Promise<{ visitor: HrVisitor; changed: boolean }> {
    return this.enqueueMutation(() => this.transitionVisitorConsentNow(visitorId, status, consentVersion));
  }

  private transitionVisitorConsentNow(
    visitorId: string,
    status: "accepted" | "declined",
    consentVersion: string
  ): { visitor: HrVisitor; changed: boolean } {
    const visitor = this.document.visitors.find((candidate) => candidate.id === visitorId);
    if (!visitor) throw new HrStoreError("HR visitor not found", "NOT_FOUND");
    const changed = visitor.consentStatus !== status || (status === "accepted" && visitor.consentVersion !== consentVersion);
    if (!changed) return { visitor: structuredClone(visitor), changed: false };
    visitor.consentStatus = status;
    visitor.consentAt = this.now().toISOString();
    visitor.consentVersion = consentVersion;
    visitor.materialsStatus = status === "accepted" ? "pending" : "not-sent";
    if (status === "accepted") visitor.materialsDeliveryId = crypto.randomUUID();
    else delete visitor.materialsDeliveryId;
    delete visitor.materialsSentAt;
    this.syncOpportunityConsent(visitor);
    this.persist();
    return { visitor: structuredClone(visitor), changed: true };
  }

  currentConsentVersion(): string {
    return sha256Text(this.document.settings.aiDisclosure);
  }

  setMaterialsDeliveryStatus(
    visitorId: string,
    deliveryId: string,
    status: "pending" | "sent" | "failed"
  ): Promise<HrVisitor> {
    return this.enqueueMutation(() => this.setMaterialsDeliveryStatusNow(visitorId, deliveryId, status));
  }

  private setMaterialsDeliveryStatusNow(
    visitorId: string,
    deliveryId: string,
    status: "pending" | "sent" | "failed"
  ): HrVisitor {
    const visitor = this.document.visitors.find((candidate) => candidate.id === visitorId);
    if (!visitor) throw new HrStoreError("HR visitor not found", "NOT_FOUND");
    if (visitor.consentStatus !== "accepted") {
      throw new HrStoreError("Candidate materials cannot be sent before visitor consent", "VALIDATION");
    }
    if (!deliveryId.trim() || visitor.materialsDeliveryId !== deliveryId) {
      throw new HrStoreError("Material delivery attempt is stale or does not match the active delivery", "CONFLICT");
    }
    if (visitor.materialsStatus === status) return structuredClone(visitor);
    if (visitor.materialsStatus === "sent") {
      throw new HrStoreError("Material delivery has already completed", "CONFLICT");
    }
    visitor.materialsStatus = status;
    if (status === "sent") visitor.materialsSentAt = this.now().toISOString();
    else delete visitor.materialsSentAt;
    this.persist();
    return structuredClone(visitor);
  }

  updateMaterials(input: UpdateHrMaterialsInput): Promise<HrMaterialsSummary> {
    return this.enqueueMutation(() => this.updateMaterialsNow(input));
  }

  importUploadedResume(sourcePath: string, displayName: string): Promise<HrMaterialsSummary> {
    return this.enqueueMutation(() => this.updateMaterialsNow(
      { resumePath: sourcePath },
      normalizeMaterialDisplayName(displayName, ".pdf")
    ));
  }

  importUploadedKnowledgeFile(sourcePath: string, displayName: string): Promise<HrMaterialsSummary> {
    return this.enqueueMutation(() => {
      const timestamp = this.now().toISOString();
      const source = path.resolve(sourcePath);
      const stat = requireLocalFile(source, "uploaded knowledge file");
      const extension = path.extname(source).toLowerCase();
      const name = normalizeMaterialDisplayName(displayName, extension);
      if (![".pdf", ".docx", ".txt", ".md"].includes(extension)) {
        throw new HrStoreError("Uploaded knowledge file type is not supported", "VALIDATION");
      }
      const maxBytes = extension === ".txt" || extension === ".md"
        ? 512 * 1024
        : MAX_RESUME_SIZE_BYTES;
      if (stat.size <= 0 || stat.size > maxBytes) {
        throw new HrStoreError("Uploaded knowledge file size is outside the allowed range", "VALIDATION");
      }
      if (this.document.materials.knowledgeBaseDocuments.length >= 200) {
        throw new HrStoreError("Too many knowledge base documents", "VALIDATION");
      }

      const sha256 = sha256File(source);
      const existing = this.document.materials.knowledgeBaseDocuments.find((item) =>
        item.kind === "file" && item.sha256 === sha256);
      if (existing) return this.getMaterials();

      const id = crypto.randomUUID();
      const target = path.join(this.paths.hrMaterialsDir, "knowledge", `${id}${extension}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      try {
        fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
        if (sha256File(target) !== sha256) {
          throw new HrStoreError("Imported knowledge file hash verification failed", "STORAGE");
        }
      } catch (error) {
        fs.rmSync(target, { force: true });
        if (error instanceof HrStoreError) throw error;
        throw new HrStoreError("Unable to import the knowledge file", "STORAGE");
      }

      const previousDocument = this.document;
      const nextMaterials: HrMaterialsRecord = structuredClone(this.document.materials);
      nextMaterials.knowledgeBaseDocuments.push({
        id,
        name,
        path: target,
        kind: "file",
        sha256,
        addedAt: timestamp
      });
      nextMaterials.updatedAt = timestamp;
      this.document = structuredClone(this.document);
      this.document.materials = nextMaterials;
      try {
        this.persist();
      } catch (error) {
        this.document = previousDocument;
        fs.rmSync(target, { force: true });
        throw error;
      }
      return this.getMaterials();
    });
  }

  private updateMaterialsNow(input: UpdateHrMaterialsInput, resumeDisplayName?: string): HrMaterialsSummary {
    const timestamp = this.now().toISOString();
    const nextSettings: HrSettingsRecord = structuredClone(this.document.settings);
    const nextMaterials: HrMaterialsRecord = structuredClone(this.document.materials);
    let resumeImport: { source: string; target: string; version: HrResumeVersion } | undefined;

    if (input.disclosure !== undefined) {
      nextSettings.aiDisclosure = normalizeDisclosure(input.disclosure);
      nextSettings.updatedAt = timestamp;
    }
    if (input.bio !== undefined) {
      nextMaterials.bio = cleanOptional(input.bio)?.slice(0, 10_000);
      requireIntroductionWithinLimit(nextMaterials.bio, nextSettings.welcomeMessage);
    }
    if (input.resumePath !== undefined && input.resumePath !== null && input.resumePath.trim()) {
      const sourcePath = path.resolve(input.resumePath.trim());
      const stat = requireLocalFile(sourcePath, "resumePath");
      if (path.extname(sourcePath).toLowerCase() !== ".pdf") {
        throw new HrStoreError("resumePath must point to a PDF file", "VALIDATION");
      }
      validateResumePdf(sourcePath, stat);
      const sha256 = sha256File(sourcePath);
      let version = nextMaterials.resumeVersions.find((item) => item.sha256 === sha256);
      if (!version) {
        const id = crypto.randomUUID();
        version = {
          id,
          name: resumeDisplayName ?? path.basename(sourcePath),
          path: path.join(this.paths.hrMaterialsDir, "resumes", `${id}.pdf`),
          sha256,
          size: stat.size,
          version: Math.max(0, ...nextMaterials.resumeVersions.map((item) => item.version)) + 1,
          createdAt: timestamp
        };
        nextMaterials.resumeVersions.push(version);
        resumeImport = { source: sourcePath, target: version.path, version };
      }
      nextMaterials.currentResumeId = version.id;
    }
    if (input.resumePath === null) {
      delete nextMaterials.currentResumeId;
    }
    if (input.knowledgeBasePaths !== undefined) {
      const knowledgePaths = normalizeList(input.knowledgeBasePaths, 200, 2_048).map((item) => path.resolve(item));
      nextMaterials.knowledgeBaseDocuments = knowledgePaths.map((documentPath) => {
        let stat: fs.Stats;
        try {
          stat = fs.statSync(documentPath);
        } catch {
          throw new HrStoreError(`Knowledge base path not found: ${documentPath}`, "VALIDATION");
        }
        if (!stat.isFile() && !stat.isDirectory()) {
          throw new HrStoreError(`Knowledge base path is not a file or directory: ${documentPath}`, "VALIDATION");
        }
        const existing = nextMaterials.knowledgeBaseDocuments.find((item) => item.path === documentPath);
        return existing ?? {
          id: crypto.randomUUID(),
          name: path.basename(documentPath),
          path: documentPath,
          kind: stat.isDirectory() ? "directory" : "file",
          ...(stat.isFile() ? { sha256: sha256File(documentPath) } : {}),
          addedAt: timestamp
        };
      });
    }
    nextMaterials.updatedAt = timestamp;

    if (resumeImport) {
      fs.mkdirSync(path.dirname(resumeImport.target), { recursive: true });
      try {
        fs.copyFileSync(resumeImport.source, resumeImport.target, fs.constants.COPYFILE_EXCL);
      } catch {
        fs.rmSync(resumeImport.target, { force: true });
        throw new HrStoreError("Unable to import the immutable resume version", "STORAGE");
      }
      if (sha256File(resumeImport.target) !== resumeImport.version.sha256) {
        fs.rmSync(resumeImport.target, { force: true });
        throw new HrStoreError("Imported resume hash verification failed", "STORAGE");
      }
    }

    const previousDocument = this.document;
    this.document = structuredClone(this.document);
    this.document.settings = nextSettings;
    this.document.materials = nextMaterials;
    if (nextSettings.aiDisclosure !== previousDocument.settings.aiDisclosure) this.resetAcceptedConsent();
    try {
      this.persist();
    } catch (error) {
      this.document = previousDocument;
      if (resumeImport) fs.rmSync(resumeImport.target, { force: true });
      throw error;
    }
    return this.getMaterials();
  }

  getResumeFile(id: string): { path: string; name: string } {
    const resume = this.document.materials.resumeVersions.find((item) => item.id === id);
    if (!resume) throw new HrStoreError("Resume version not found", "NOT_FOUND");
    const stat = requireLocalFile(resume.path, "resume");
    if (stat.size !== resume.size || sha256File(resume.path) !== resume.sha256) {
      throw new HrStoreError("Archived resume failed integrity verification", "STORAGE");
    }
    return { path: resume.path, name: resume.name };
  }

  listOpportunities(): HrOpportunity[] {
    return structuredClone(this.document.opportunities)
      .sort((a, b) => b.priorityScore - a.priorityScore || b.lastMessageAt.localeCompare(a.lastMessageAt));
  }

  getOpportunity(id: string): HrOpportunityDetail {
    const opportunity = this.requireOpportunity(id);
    const visitor = this.document.visitors.find((candidate) => candidate.id === opportunity.visitorId);
    if (!visitor) throw new HrStoreError("HR visitor not found", "STORAGE");
    return {
      ...structuredClone(opportunity),
      visitor: structuredClone(visitor),
      messages: structuredClone(this.document.messages)
        .filter((message) => message.opportunityId === id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      drafts: structuredClone(this.document.drafts)
        .filter((draft) => draft.opportunityId === id)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    };
  }

  archiveInbound(input: ArchiveHrMessageInput): Promise<ArchiveHrMessageResult> {
    return this.enqueueMutation(() => this.archiveMessage(input, "inbound"));
  }

  archiveOutbound(input: ArchiveHrMessageInput): Promise<ArchiveHrMessageResult> {
    return this.enqueueMutation(() => this.archiveMessage(input, "outbound"));
  }

  generateDraft(opportunityId: string, type: HrDraftType): Promise<HrDraft> {
    return this.enqueueMutation(() => this.generateDraftNow(opportunityId, type));
  }

  private generateDraftNow(opportunityId: string, type: HrDraftType): HrDraft {
    const opportunity = this.requireOpportunity(opportunityId);
    const createdAt = this.now().toISOString();
    const draft: HrDraft = {
      id: crypto.randomUUID(),
      opportunityId,
      type,
      status: "draft",
      generator: "local-template",
      isAiGenerated: false,
      content: buildDraft(type, opportunity),
      createdAt,
      updatedAt: createdAt
    };
    this.document.drafts.push(draft);
    this.persist();
    return structuredClone(draft);
  }

  setDraftStatus(draftId: string, status: "reviewed" | "approved" | "rejected"): Promise<HrDraft> {
    return this.enqueueMutation(() => this.setDraftStatusNow(draftId, status));
  }

  private setDraftStatusNow(draftId: string, status: "reviewed" | "approved" | "rejected"): HrDraft {
    const draft = this.document.drafts.find((candidate) => candidate.id === draftId);
    if (!draft) throw new HrStoreError("HR draft not found", "NOT_FOUND");
    draft.status = status;
    draft.updatedAt = this.now().toISOString();
    this.persist();
    return structuredClone(draft);
  }

  private archiveMessage(input: ArchiveHrMessageInput, direction: "inbound" | "outbound"): ArchiveHrMessageResult {
    const channelMessageId = required(input.channelMessageId, "channelMessageId", 256);
    const openKfid = required(input.openKfid, "openKfid", 256);
    const externalUserId = required(input.externalUserId, "externalUserId", 256);
    const duplicate = this.document.messages.find((message) =>
      message.direction === direction
      && message.channelMessageId === channelMessageId
      && this.document.visitors.some((visitor) => visitor.id === message.visitorId
        && visitor.openKfid === openKfid
        && visitor.externalUserId === externalUserId));
    if (duplicate) {
      const visitor = this.document.visitors.find((candidate) => candidate.id === duplicate.visitorId)!;
      const opportunity = this.requireOpportunity(duplicate.opportunityId);
      return {
        duplicate: true,
        visitor: structuredClone(visitor),
        message: structuredClone(duplicate),
        opportunity: structuredClone(opportunity)
      };
    }

    const createdAt = validTimestamp(input.createdAt) ?? this.now().toISOString();
    const visitor = this.ensureVisitor(openKfid, externalUserId, input.displayName, createdAt);
    if (visitor.consentStatus !== "accepted") {
      throw new HrStoreError("Visitor consent is required before full message archiving", "VALIDATION");
    }
    const text = (input.text ?? "").trim().slice(0, MAX_MESSAGE_TEXT);
    const extraction = direction === "inbound" ? extractRecruitmentInfo(text) : emptyExtraction();
    const opportunity = this.resolveOpportunity(visitor, extraction, createdAt);
    const message: HrArchivedMessage = {
      id: crypto.randomUUID(),
      channelMessageId,
      visitorId: visitor.id,
      opportunityId: opportunity.id,
      direction,
      role: direction === "inbound" ? "visitor" : "assistant",
      text,
      content: text,
      messageType: cleanOptional(input.messageType)?.slice(0, 40) ?? (text ? "text" : "unknown"),
      attachments: normalizeAttachments(input.attachments),
      createdAt
    };
    this.document.messages.push(message);
    visitor.lastSeenAt = laterTimestamp(visitor.lastSeenAt, createdAt);
    visitor.messageCount += 1;
    if (direction === "inbound") {
      applyExtraction(opportunity, extraction, message, this.document.settings);
    }
    opportunity.messageCount += 1;
    opportunity.lastMessageAt = laterTimestamp(opportunity.lastMessageAt, createdAt);
    opportunity.updatedAt = laterTimestamp(opportunity.updatedAt, createdAt);
    this.persist();
    return {
      duplicate: false,
      visitor: structuredClone(visitor),
      message: structuredClone(message),
      opportunity: structuredClone(opportunity)
    };
  }

  private ensureVisitor(openKfid: string, externalUserId: string, displayName: string | undefined, createdAt: string): HrVisitor {
    const existing = this.document.visitors.find((visitor) =>
      visitor.openKfid === openKfid && visitor.externalUserId === externalUserId);
    const normalizedName = cleanOptional(displayName)?.slice(0, 100);
    if (existing) {
      if (normalizedName) existing.displayName = normalizedName;
      return existing;
    }
    const visitor: HrVisitor = {
      id: crypto.randomUUID(),
      channel: openKfid === "wechat-h5-hr-clawbot" ? HR_WEB_CHANNEL : HR_CHANNEL,
      openKfid,
      externalUserId,
      ...(normalizedName ? { displayName: normalizedName } : {}),
      consentStatus: "pending",
      materialsStatus: "not-sent",
      processedConsentEventIds: [],
      firstSeenAt: createdAt,
      lastSeenAt: createdAt,
      messageCount: 0
    };
    this.document.visitors.push(visitor);
    return visitor;
  }

  private resolveOpportunity(visitor: HrVisitor, extraction: RecruitmentExtraction, createdAt: string): HrOpportunity {
    const current = this.document.opportunities
      .filter((opportunity) => opportunity.visitorId === visitor.id && opportunity.status === "active")
      .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))[0];
    const companyChanged = Boolean(current?.company && extraction.company
      && normalizeComparable(current.company) !== normalizeComparable(extraction.company));
    const roleChanged = Boolean(current?.role && extraction.role
      && normalizeComparable(current.role) !== normalizeComparable(extraction.role));
    if (current && !companyChanged && !roleChanged) return current;
    const opportunity: HrOpportunity = {
      id: crypto.randomUUID(),
      visitorId: visitor.id,
      openKfid: visitor.openKfid,
      consentStatus: visitor.consentStatus,
      ...(visitor.consentAt ? { consentedAt: visitor.consentAt } : {}),
      ...(extraction.company ? { company: extraction.company } : {}),
      ...(extraction.role ? { role: extraction.role } : {}),
      conditions: [],
      concerns: [],
      stage: "unknown",
      invitationScore: 0,
      priorityScore: 0,
      status: "active",
      evidence: [],
      needsConfirmation: [],
      missingFields: [],
      messageCount: 0,
      createdAt,
      updatedAt: createdAt,
      lastMessageAt: createdAt
    };
    this.document.opportunities.push(opportunity);
    return opportunity;
  }

  private requireOpportunity(id: string): HrOpportunity {
    const opportunity = this.document.opportunities.find((candidate) => candidate.id === id);
    if (!opportunity) throw new HrStoreError("HR opportunity not found", "NOT_FOUND");
    return opportunity;
  }

  private requireMaterialDelivery(deliveryId: string): HrMaterialDeliveryRecord {
    const normalizedDeliveryId = required(deliveryId, "deliveryId", 256);
    const delivery = this.document.integration.materialDeliveries.find((candidate) =>
      candidate.deliveryId === normalizedDeliveryId);
    if (!delivery) throw new HrStoreError("Material delivery record not found", "NOT_FOUND");
    return delivery;
  }

  private syncVisitorMaterialDelivery(delivery: HrMaterialDeliveryRecord): void {
    const visitor = this.document.visitors.find((candidate) => candidate.id === delivery.visitorId);
    if (!visitor || visitor.materialsDeliveryId !== delivery.deliveryId || visitor.consentStatus !== "accepted") return;
    const components = Object.values(delivery.components);
    if (components.some((component) => component?.status === "failed")) {
      visitor.materialsStatus = "failed";
      delete visitor.materialsSentAt;
    } else if (components.length > 0 && components.every((component) => component?.status === "submitted")) {
      visitor.materialsStatus = "sent";
      visitor.materialsSentAt = this.now().toISOString();
    } else {
      visitor.materialsStatus = "pending";
      delete visitor.materialsSentAt;
    }
  }

  private pruneMaterialDeliveries(): void {
    const deliveries = this.document.integration.materialDeliveries;
    if (deliveries.length <= MAX_MATERIAL_DELIVERY_RECORDS) return;
    const activeDeliveryIds = new Set(this.document.visitors
      .map((visitor) => visitor.materialsDeliveryId)
      .filter((deliveryId): deliveryId is string => Boolean(deliveryId)));
    while (deliveries.length > MAX_MATERIAL_DELIVERY_RECORDS) {
      const candidates = deliveries
        .map((delivery, index) => ({ delivery, index }))
        .filter(({ delivery }) => !activeDeliveryIds.has(delivery.deliveryId))
        .sort((left, right) => left.delivery.updatedAt.localeCompare(right.delivery.updatedAt));
      const removeIndex = candidates[0]?.index;
      if (removeIndex === undefined) break;
      deliveries.splice(removeIndex, 1);
    }
  }

  private async updateSecret(current: string | undefined, input: string | null | undefined, field: string): Promise<string | undefined> {
    if (input === undefined || input === "") return current;
    if (input === null) return undefined;
    const value = input.trim();
    if (!value) return current;
    if (value.length > 8_192) throw new HrStoreError(`${field} is too long`, "VALIDATION");
    if (field === "token" && !/^[A-Za-z0-9]{1,32}$/u.test(value)) {
      throw new HrStoreError("token must contain 1 to 32 English letters or digits", "VALIDATION");
    }
    if (field === "encodingAesKey" && !/^[A-Za-z0-9]{43}$/u.test(value)) {
      throw new HrStoreError("encodingAesKey must contain exactly 43 English letters or digits", "VALIDATION");
    }
    try {
      return await this.protector.protect(value);
    } catch {
      throw new HrStoreError(`Unable to encrypt WeChat Customer Service ${field}`, "STORAGE");
    }
  }

  private enqueueMutation<T>(mutation: () => T | Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(mutation, mutation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private persist(): void {
    writeJsonFile(this.paths.hrPath, this.document);
  }

  private resetAcceptedConsent(): void {
    for (const visitor of this.document.visitors) {
      if (visitor.consentStatus !== "accepted") continue;
      visitor.consentStatus = "pending";
      visitor.materialsStatus = "not-sent";
      delete visitor.consentAt;
      delete visitor.consentVersion;
      delete visitor.materialsSentAt;
      delete visitor.materialsDeliveryId;
      this.syncOpportunityConsent(visitor);
    }
  }

  private syncOpportunityConsent(visitor: HrVisitor): void {
    for (const opportunity of this.document.opportunities) {
      if (opportunity.visitorId !== visitor.id) continue;
      opportunity.consentStatus = visitor.consentStatus;
      if (visitor.consentAt) opportunity.consentedAt = visitor.consentAt;
      else delete opportunity.consentedAt;
      opportunity.updatedAt = this.now().toISOString();
    }
  }
}

type RecruitmentExtraction = {
  company?: string;
  role?: string;
  stage: HrOpportunityStage;
  conditions: string[];
  concerns: string[];
  signals: Array<{ kind: HrEvidenceKind; label: string; quote: string }>;
};

export function extractRecruitmentInfo(text: string): RecruitmentExtraction {
  const normalized = text.trim();
  if (!normalized) return emptyExtraction();
  const sentences = splitSentences(normalized);
  const company = firstCaptured(normalized, [
    /(?:我们是|来自)\s*([\p{L}\p{N}·&（）()\- ]{2,40}?)(?:的?\s*(?:HR|招聘|人力)|[，,。；;])/iu,
    /(?:公司|企业|雇主|单位)\s*(?:是|为|名称)?\s*[：:]?\s*([^，,。；;\n]{2,40})/iu
  ]);
  const role = firstCaptured(normalized, [
    /(?:(?:招聘|招募)\s*)?(?:岗位|职位)\s*(?:是|为|方向)?\s*[：:]?\s*([^，,。；;\n]{2,50})/iu,
    /(?:招聘|招募)\s*(?:是|为|方向)?\s*[：:]?\s*([^，,。；;\n]{2,50})/iu,
    /(?:在招|诚聘)\s*([^，,。；;\n]{2,50})/iu
  ]);
  const conditionKeywords = /薪资|月薪|年薪|地点|城市|办公|远程|经验|年限|学历|本科|硕士|博士|到岗|入职|技术栈|职级|汇报|团队/iu;
  const concernKeywords = /关注|想了解|请介绍|方便说说|项目|经历|经验|技术|学历|年限|离职|薪资|到岗|空窗|管理|作品/iu;
  const invitationKeywords = /面试|邀约|邀请|约个时间|方便.*(?:聊|沟通)|电话沟通|视频沟通|现场沟通|面谈|终面|复试|初试|offer|录用|入职通知/iu;
  const conditions = uniqueStrings(sentences.filter((sentence) => conditionKeywords.test(sentence)).map(shortQuote));
  const concerns = uniqueStrings(sentences.filter((sentence) => concernKeywords.test(sentence)).map(shortQuote));
  const invitations = uniqueStrings(sentences.filter((sentence) => invitationKeywords.test(sentence)).map(shortQuote));
  const stage = inferStage(normalized);
  const signals: RecruitmentExtraction["signals"] = [];
  if (company) signals.push({ kind: "company", label: "公司", quote: evidenceSentence(sentences, company) });
  if (role) signals.push({ kind: "role", label: "岗位", quote: evidenceSentence(sentences, role) });
  for (const quote of conditions) signals.push({ kind: "condition", label: "招聘条件", quote });
  for (const quote of concerns) signals.push({ kind: "concern", label: "HR 关注点", quote });
  for (const quote of invitations) signals.push({ kind: "invitation", label: "邀约信号", quote });
  return { company, role, stage, conditions, concerns, signals };
}

function applyExtraction(
  opportunity: HrOpportunity,
  extraction: RecruitmentExtraction,
  message: HrArchivedMessage,
  settings: HrSettingsRecord
): void {
  if (extraction.company) opportunity.company = extraction.company;
  if (extraction.role) opportunity.role = extraction.role;
  opportunity.conditions = uniqueStrings([...opportunity.conditions, ...extraction.conditions]).slice(-30);
  opportunity.concerns = uniqueStrings([...opportunity.concerns, ...extraction.concerns]).slice(-30);
  if (stageWeight(extraction.stage) > stageWeight(opportunity.stage)) opportunity.stage = extraction.stage;
  for (const signal of extraction.signals) {
    if (opportunity.evidence.some((evidence) =>
      evidence.messageId === message.id && evidence.kind === signal.kind && evidence.quote === signal.quote)) continue;
    opportunity.evidence.push({
      id: crypto.randomUUID(),
      messageId: message.id,
      kind: signal.kind,
      label: signal.label,
      text: signal.quote,
      quote: signal.quote,
      createdAt: message.createdAt
    });
  }
  opportunity.evidence = opportunity.evidence.slice(-100);
  opportunity.invitationScore = invitationScore(opportunity);
  const fit = calculateFit(opportunity, settings);
  if (fit !== undefined) {
    opportunity.fitScore = fit;
    if (!opportunity.evidence.some((evidence) => evidence.messageId === message.id && evidence.kind === "fit")) {
      const matchedTerms = [...settings.targetRoles, ...settings.profileKeywords]
        .filter((term) => fuzzyIncludes(message.text, term));
      if (matchedTerms.length) {
        const quote = shortQuote(message.text);
        opportunity.evidence.push({
          id: crypto.randomUUID(),
          messageId: message.id,
          kind: "fit",
          label: `岗位匹配依据：${matchedTerms.slice(0, 5).join("、")}`,
          text: quote,
          quote,
          createdAt: message.createdAt
        });
      }
    }
  }
  else delete opportunity.fitScore;
  opportunity.priorityScore = Math.round(opportunity.fitScore === undefined
    ? opportunity.invitationScore
    : opportunity.invitationScore * 0.6 + opportunity.fitScore * 0.4);
  opportunity.needsConfirmation = confirmationItems(opportunity);
  opportunity.missingFields = [...opportunity.needsConfirmation];
}

function invitationScore(opportunity: HrOpportunity): number {
  const stageBase: Record<HrOpportunityStage, number> = {
    unknown: 0,
    sourcing: 20,
    screening: 40,
    "interview-proposed": 70,
    "interview-scheduled": 88,
    offer: 100
  };
  const invitationEvidence = opportunity.evidence.filter((evidence) => evidence.kind === "invitation").length;
  return Math.min(100, stageBase[opportunity.stage] + Math.min(12, invitationEvidence * 3));
}

function calculateFit(opportunity: HrOpportunity, settings: HrSettingsRecord): number | undefined {
  if (!settings.targetRoles.length && !settings.profileKeywords.length) return undefined;
  const haystack = [opportunity.role, ...opportunity.conditions, ...opportunity.concerns]
    .filter(Boolean).join(" ").toLowerCase();
  if (!haystack) return undefined;
  const roleMatches = settings.targetRoles.filter((target) => fuzzyIncludes(haystack, target)).length;
  const keywordMatches = settings.profileKeywords.filter((keyword) => fuzzyIncludes(haystack, keyword)).length;
  if (!roleMatches && !keywordMatches) return undefined;
  const rolePoints = settings.targetRoles.length ? (roleMatches ? 55 + Math.min(25, roleMatches * 10) : 30) : 45;
  const keywordPoints = settings.profileKeywords.length
    ? Math.round((keywordMatches / settings.profileKeywords.length) * 25)
    : 15;
  return Math.min(100, rolePoints + keywordPoints);
}

function confirmationItems(opportunity: HrOpportunity): string[] {
  const items: string[] = [];
  if (!opportunity.company) items.push("公司名称待确认");
  if (!opportunity.role) items.push("岗位名称待确认");
  if (opportunity.fitScore === undefined) items.push("岗位匹配依据待补充");
  if (opportunity.stage === "interview-proposed"
    && !opportunity.evidence.some((evidence) => /\d{1,2}[月\/-]\d{1,2}|周[一二三四五六日天]|上午|下午|晚上|:\d{2}/u.test(evidence.quote))) {
    items.push("面试时间待确认");
  }
  return items;
}

function inferStage(text: string): HrOpportunityStage {
  if (/offer|录用|入职通知/iu.test(text)) return "offer";
  const scheduleMarker = "(?:\\d{1,2}[月\\/-]\\d{1,2}|周[一二三四五六日天]|上午|下午|晚上|\\d{1,2}:\\d{2})";
  if (new RegExp(`(?:面试|复试|初试|终面).{0,30}${scheduleMarker}|${scheduleMarker}.{0,30}(?:面试|复试|初试|终面)|(?:已安排|定在).*(?:面试|沟通)`, "iu").test(text)) {
    return "interview-scheduled";
  }
  if (/面试|邀约|邀请|面谈|复试|初试|终面/iu.test(text)) return "interview-proposed";
  if (/电话沟通|视频沟通|方便.*(?:聊|沟通)|初聊|进一步沟通/iu.test(text)) return "screening";
  if (/岗位|职位|招聘|招募|在招|诚聘|公司|企业/iu.test(text)) return "sourcing";
  return "unknown";
}

function buildDraft(type: HrDraftType, opportunity: HrOpportunity): string {
  const company = opportunity.company ?? "待确认公司";
  const role = opportunity.role ?? "待确认岗位";
  const evidence = opportunity.evidence.filter((item) => item.kind === "invitation").slice(-3);
  const evidenceLines = evidence.length
    ? evidence.map((item) => `- “${item.quote}”`).join("\n")
    : "- 暂无明确邀约原文";
  const pending = opportunity.needsConfirmation.length
    ? opportunity.needsConfirmation.map((item) => `- ${item}`).join("\n")
    : "- 暂无";
  if (type === "invitation-analysis") {
    return [
      `当前招聘阶段：${stageLabel(opportunity.stage)}`,
      `HR 邀约意向：${opportunity.invitationScore}/100`,
      `岗位匹配度：${opportunity.fitScore === undefined ? "信息不足" : `${opportunity.fitScore}/100`}`,
      "",
      "明确证据：",
      evidenceLines,
      "",
      "待确认事项：",
      pending
    ].join("\n");
  }
  if (type === "interview-advice") {
    const focus = uniqueStrings([...opportunity.concerns, ...opportunity.conditions]).slice(0, 5);
    return [
      `${company} · ${role} 面试准备建议`,
      "",
      "准备重点：",
      ...(focus.length ? focus.map((item) => `- 围绕“${item}”准备可核验的真实案例`) : ["- 先补齐岗位职责、技术栈与面试形式"]),
      "- 从自己的真实项目中选择与岗位最相关的经历，按背景、行动、结果组织",
      "",
      "可能追问：",
      "- 你在相关项目中的具体职责和可量化结果是什么？",
      "- 遇到的最大困难、取舍和复盘是什么？",
      "",
      "提示：此草稿不替你作出时间、薪资或入职承诺。"
    ].join("\n");
  }
  if (type === "resume-improvements") {
    const concerns = opportunity.concerns.slice(0, 5);
    return [
      `${company} · ${role} 简历改进意见`,
      "",
      ...(concerns.length
        ? concerns.map((item) => `- 针对 HR 关注的“${item}”，在对应真实经历段落补充职责、行动和可验证结果。`)
        : ["- 当前 HR 关注点不足，先保持原始简历不变，待获得岗位描述后再定向修改。"]),
      "- 不新增未经证实的经历、数字或技能；原始简历始终保留。",
      "- 所有修改先由候选人审核，再生成新版本。"
    ].join("\n");
  }
  return [
    `您好，感谢您介绍${company}的${role}机会。`,
    opportunity.needsConfirmation.length
      ? `为便于进一步评估，想请您补充：${opportunity.needsConfirmation.join("、")}。`
      : "我会尽快确认安排并回复您。",
    "涉及面试时间、薪资或入职安排，我确认后再给您明确答复。"
  ].join("\n");
}

function emptyDocument(now: Date): HrDocument {
  const timestamp = now.toISOString();
  return {
    version: DOCUMENT_VERSION,
    settings: {
      channel: HR_CHANNEL,
      enabled: false,
      stableId: crypto.randomUUID(),
      aiDisclosure: DEFAULT_DISCLOSURE,
      targetRoles: [],
      profileKeywords: [],
      createdAt: timestamp,
      updatedAt: timestamp
    },
    materials: {
      resumeVersions: [],
      knowledgeBaseDocuments: []
    },
    integration: { syncCursors: {}, materialDeliveries: [] },
    visitors: [],
    messages: [],
    opportunities: [],
    drafts: []
  };
}

function readDocument(paths: StatePaths): { document: HrDocument; migrated: boolean } {
  try {
    const value = JSON.parse(fs.readFileSync(paths.hrPath, "utf8")) as Record<string, unknown>;
    if ((value.version !== 1 && value.version !== DOCUMENT_VERSION) || !value.settings
      || !Array.isArray(value.visitors) || !Array.isArray(value.messages)
      || !Array.isArray(value.opportunities) || !Array.isArray(value.drafts)) {
      throw new Error("invalid document");
    }
    const sourceVersion = value.version;
    const sourceSettings = value.settings as Partial<HrSettingsRecord>;
    if (sourceSettings.channel !== HR_CHANNEL || typeof sourceSettings.stableId !== "string"
      || typeof sourceSettings.createdAt !== "string" || typeof sourceSettings.updatedAt !== "string") {
      throw new Error("invalid settings");
    }
    const sourceMaterials = value.materials && typeof value.materials === "object"
      ? value.materials as Partial<HrMaterialsRecord>
      : {};
    if (sourceVersion === DOCUMENT_VERSION
      && (!Array.isArray(sourceMaterials.resumeVersions) || !Array.isArray(sourceMaterials.knowledgeBaseDocuments))) {
      throw new Error("invalid materials");
    }
    const resumeVersions = migrateResumeVersions(
      Array.isArray(sourceMaterials.resumeVersions) ? sourceMaterials.resumeVersions : [],
      paths,
      sourceVersion === 1
    );
    const storedDisclosure = cleanOptional(sourceSettings.aiDisclosure) ?? DEFAULT_DISCLOSURE;
    const disclosureNeedsReview = !disclosureFitsMenu(storedDisclosure);
    const introductionNeedsReview = !introductionFitsMessage(
      typeof sourceMaterials.bio === "string" ? sourceMaterials.bio : undefined,
      typeof sourceSettings.welcomeMessage === "string" ? sourceSettings.welcomeMessage : undefined
    );
    const materialDeliveryHistoryNeedsMigration = needsMaterialDeliveryHistoryMigration(value.integration);
    const visitors = (value.visitors as HrVisitor[]).map((visitor) => {
      const normalized = {
        ...visitor,
        consentStatus: visitor.consentStatus ?? "pending",
        materialsStatus: visitor.materialsStatus ?? "not-sent",
        processedConsentEventIds: Array.isArray(visitor.processedConsentEventIds)
          ? visitor.processedConsentEventIds.slice(-100)
          : (visitor.lastPreConsentEventId ? [visitor.lastPreConsentEventId] : [])
      };
      if (sourceVersion !== 1) return normalized;
      const {
        consentAt: _consentAt,
        consentVersion: _consentVersion,
        materialsSentAt: _materialsSentAt,
        materialsDeliveryId: _materialsDeliveryId,
        ...legacyVisitor
      } = normalized;
      return {
        ...legacyVisitor,
        consentStatus: "pending" as const,
        materialsStatus: "not-sent" as const
      };
    });
    const document: HrDocument = {
      version: DOCUMENT_VERSION,
      settings: {
        ...sourceSettings,
        channel: HR_CHANNEL,
        enabled: sourceSettings.enabled === true && !disclosureNeedsReview && !introductionNeedsReview,
        stableId: sourceSettings.stableId,
        aiDisclosure: storedDisclosure,
        targetRoles: Array.isArray(sourceSettings.targetRoles) ? sourceSettings.targetRoles : [],
        profileKeywords: Array.isArray(sourceSettings.profileKeywords) ? sourceSettings.profileKeywords : [],
        createdAt: sourceSettings.createdAt,
        updatedAt: sourceSettings.updatedAt
      },
      materials: {
        ...sourceMaterials,
        resumeVersions,
        knowledgeBaseDocuments: Array.isArray(sourceMaterials.knowledgeBaseDocuments)
          ? sourceMaterials.knowledgeBaseDocuments
          : []
      },
      integration: normalizeIntegrationRuntime(value.integration),
      visitors,
      messages: value.messages as HrArchivedMessage[],
      opportunities: (value.opportunities as HrOpportunity[]).map((opportunity) => {
        const normalized = {
          ...opportunity,
          missingFields: Array.isArray(opportunity.missingFields)
            ? opportunity.missingFields
            : [...(opportunity.needsConfirmation ?? [])]
        };
        if (sourceVersion !== 1) return normalized;
        const { consentedAt: _consentedAt, ...legacyOpportunity } = normalized;
        return { ...legacyOpportunity, consentStatus: "pending" as const };
      }),
      drafts: (value.drafts as HrDraft[]).map((draft) => ({
        ...draft,
        generator: "local-template",
        isAiGenerated: false
      }))
    };
    return {
      document,
      migrated: sourceVersion === 1
        || materialDeliveryHistoryNeedsMigration
        || (sourceSettings.enabled === true && (disclosureNeedsReview || introductionNeedsReview))
    };
  } catch {
    throw new HrStoreError("HR storage is invalid; restore or remove hr.json before retrying", "STORAGE");
  }
}

function normalizeIntegrationRuntime(value: unknown): HrIntegrationRuntime {
  if (!value || typeof value !== "object") return { syncCursors: {}, materialDeliveries: [] };
  const source = value as Partial<HrIntegrationRuntime>;
  const syncCursors: Record<string, string> = {};
  if (source.syncCursors && typeof source.syncCursors === "object") {
    for (const [openKfid, cursor] of Object.entries(source.syncCursors)) {
      if (openKfid && openKfid.length <= 256 && typeof cursor === "string" && cursor && cursor.length <= 2_048) {
        syncCursors[openKfid] = cursor;
      }
    }
  }
  return {
    syncCursors,
    materialDeliveries: normalizeMaterialDeliveries(source.materialDeliveries),
    ...(typeof source.callbackVerifiedAt === "string" ? { callbackVerifiedAt: source.callbackVerifiedAt } : {}),
    ...(typeof source.updatedAt === "string" ? { updatedAt: source.updatedAt } : {})
  };
}

function needsMaterialDeliveryHistoryMigration(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const deliveries = (value as { materialDeliveries?: unknown }).materialDeliveries;
  if (!Array.isArray(deliveries)) return false;
  return deliveries.some((delivery) => {
    if (!delivery || typeof delivery !== "object") return false;
    const components = (delivery as { components?: unknown }).components;
    if (!components || typeof components !== "object") return false;
    return Object.values(components).some((component) => Boolean(component)
      && typeof component === "object"
      && (component as { providerMessageId?: unknown }).providerMessageId !== undefined
      && (component as { providerMessageIds?: unknown }).providerMessageIds === undefined);
  });
}

function normalizeMaterialDeliveries(value: unknown): HrMaterialDeliveryRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("invalid material deliveries");
  const deliveries = value.map((candidate) => {
    if (!candidate || typeof candidate !== "object") throw new Error("invalid material delivery");
    const source = candidate as Partial<HrMaterialDeliveryRecord>;
    if ([source.deliveryId, source.visitorId, source.openKfid, source.externalUserId, source.createdAt, source.updatedAt]
      .some((item) => typeof item !== "string" || !item)
      || !source.components || typeof source.components !== "object") {
      throw new Error("invalid material delivery");
    }
    const components: HrMaterialDeliveryRecord["components"] = {};
    for (const component of ["intro", "resume"] as const) {
      const record = source.components[component];
      if (!record) continue;
      if (!["pending", "submitted", "failed"].includes(record.status)
        || typeof record.updatedAt !== "string"
        || (record.providerMessageIds !== undefined && !Array.isArray(record.providerMessageIds))) {
        throw new Error("invalid material delivery component");
      }
      const providerMessageIds = (record.providerMessageIds ?? [])
        .filter((messageId): messageId is string => typeof messageId === "string" && messageId.length > 0 && messageId.length <= 256)
        .slice(-MAX_PROVIDER_MESSAGE_IDS_PER_COMPONENT);
      const providerMessageId = typeof record.providerMessageId === "string"
        && record.providerMessageId.length > 0 && record.providerMessageId.length <= 256
        ? record.providerMessageId
        : undefined;
      components[component] = {
        status: record.status,
        providerMessageIds: providerMessageId
          ? uniqueStrings([...providerMessageIds, providerMessageId]).slice(-MAX_PROVIDER_MESSAGE_IDS_PER_COMPONENT)
          : providerMessageIds,
        ...(providerMessageId ? { providerMessageId } : {}),
        updatedAt: record.updatedAt
      };
    }
    return {
      deliveryId: source.deliveryId!,
      visitorId: source.visitorId!,
      openKfid: source.openKfid!,
      externalUserId: source.externalUserId!,
      components,
      createdAt: source.createdAt!,
      updatedAt: source.updatedAt!
    };
  });
  if (new Set(deliveries.map((delivery) => delivery.deliveryId)).size !== deliveries.length) {
    throw new Error("duplicate material delivery");
  }
  return deliveries
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
    .slice(-MAX_MATERIAL_DELIVERY_RECORDS);
}

function migrateResumeVersions(value: unknown[], paths: StatePaths, migrate: boolean): HrResumeVersion[] {
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== "object") throw new Error("invalid resume version");
    const resume = candidate as HrResumeVersion;
    if ([resume.id, resume.name, resume.path, resume.sha256, resume.createdAt]
      .some((item) => typeof item !== "string" || !item)
      || typeof resume.size !== "number" || typeof resume.version !== "number") {
      throw new Error("invalid resume version");
    }
    if (!migrate) return resume;
    const target = path.join(paths.hrMaterialsDir, "resumes", `${resume.id}.pdf`);
    if (path.resolve(resume.path).toLowerCase() !== path.resolve(target).toLowerCase()) {
      const stat = requireLocalFile(resume.path, "legacy resume");
      if (stat.size !== resume.size || sha256File(resume.path) !== resume.sha256) {
        throw new Error("legacy resume integrity check failed");
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (!fs.existsSync(target)) fs.copyFileSync(resume.path, target, fs.constants.COPYFILE_EXCL);
    }
    const targetStat = requireLocalFile(target, "migrated resume");
    if (targetStat.size !== resume.size || sha256File(target) !== resume.sha256) {
      throw new Error("migrated resume integrity check failed");
    }
    return { ...resume, path: target };
  });
}

function settingsSummary(settings: HrSettingsRecord, materials: HrMaterialsRecord): HrSettingsSummary {
  return {
    channel: settings.channel,
    enabled: settings.enabled,
    stableId: settings.stableId,
    ...(settings.corpId ? { corpId: settings.corpId } : {}),
    ...(settings.openKfid ? { openKfid: settings.openKfid, openKfId: settings.openKfid } : {}),
    ...(settings.serviceLink ? { serviceLink: settings.serviceLink, contactUrl: settings.serviceLink } : {}),
    ...(settings.callbackPublicUrl ? { callbackPublicUrl: settings.callbackPublicUrl } : {}),
    ...(settings.welcomeMessage ? { welcomeMessage: settings.welcomeMessage } : {}),
    aiDisclosure: settings.aiDisclosure,
    targetRoles: [...settings.targetRoles],
    profileKeywords: [...settings.profileKeywords],
    hasSecret: Boolean(settings.encryptedSecret),
    hasToken: Boolean(settings.encryptedToken),
    hasEncodingAesKey: Boolean(settings.encryptedEncodingAesKey),
    configured: isConfigured(settings, materials),
    createdAt: settings.createdAt,
    updatedAt: settings.updatedAt
  };
}

function isConfigured(settings: HrSettingsRecord, materials: HrMaterialsRecord): boolean {
  return Boolean(settings.corpId && settings.openKfid && settings.serviceLink && settings.callbackPublicUrl
    && settings.encryptedSecret && settings.encryptedToken && settings.encryptedEncodingAesKey
    && disclosureFitsMenu(settings.aiDisclosure)
    && introductionFitsMessage(materials.bio, settings.welcomeMessage));
}

function updatedOptional(current: string | undefined, input: string | null | undefined, max: number, field: string): string | undefined {
  if (input === undefined) return current;
  const clean = cleanOptional(input);
  if (!clean) return undefined;
  if (clean.length > max) throw new HrStoreError(`${field} is too long`, "VALIDATION");
  return clean;
}

function normalizeServiceLink(input: string | null): string | undefined {
  const value = cleanOptional(input);
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HrStoreError("serviceLink is invalid", "VALIDATION");
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "work.weixin.qq.com"
    || url.username || url.password || (url.port && url.port !== "443")
    || !/^\/kf\/[^/]+\/?$/u.test(url.pathname)) {
    throw new HrStoreError("serviceLink must be an official https://work.weixin.qq.com/kf/<token> link", "VALIDATION");
  }
  url.hash = "";
  return url.toString();
}

function normalizeCallbackPublicUrl(input: string | null): string | undefined {
  const value = cleanOptional(input);
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HrStoreError("callbackPublicUrl is invalid", "VALIDATION");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new HrStoreError("callbackPublicUrl must be a public HTTPS URL without credentials, query parameters or fragments", "VALIDATION");
  }
  if (url.pathname !== "/wecom/callback") {
    throw new HrStoreError("callbackPublicUrl must use the dedicated /wecom/callback path", "VALIDATION");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname === "::1" || hostname.endsWith(".local")
    || /^127\./.test(hostname) || /^10\./.test(hostname) || /^192\.168\./.test(hostname)
    || /^172\.(?:1[6-9]|2\d|3[01])\./.test(hostname)) {
    throw new HrStoreError("callbackPublicUrl must be reachable from the public internet", "VALIDATION");
  }
  return url.toString();
}

function requireLocalFile(filePath: string, field: string): fs.Stats {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new HrStoreError(`${field} file not found`, "VALIDATION");
  }
  if (!stat.isFile()) throw new HrStoreError(`${field} must point to a file`, "VALIDATION");
  return stat;
}

function validateResumePdf(filePath: string, stat: fs.Stats): void {
  if (stat.size > MAX_RESUME_SIZE_BYTES) {
    throw new HrStoreError("resumePath must not exceed 20 MiB", "VALIDATION");
  }
  const header = Buffer.alloc(PDF_MAGIC.length);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, "r");
    const bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
    if (bytesRead !== PDF_MAGIC.length || !header.equals(PDF_MAGIC)) {
      throw new HrStoreError("resumePath does not contain a valid PDF header", "VALIDATION");
    }
  } catch (error) {
    if (error instanceof HrStoreError) throw error;
    throw new HrStoreError("Unable to inspect resumePath", "VALIDATION");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeList(value: string[], maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) throw new HrStoreError("Expected a string array", "VALIDATION");
  if (value.length > maxItems) throw new HrStoreError("Too many list items", "VALIDATION");
  return uniqueStrings(value.map((item) => {
    if (typeof item !== "string") throw new HrStoreError("List item is invalid", "VALIDATION");
    const clean = item.trim().replace(/\s+/g, " ");
    if (clean.length > maxLength) throw new HrStoreError("List item is too long", "VALIDATION");
    return clean;
  }).filter(Boolean));
}

function normalizeDisclosure(value: string | null | undefined): string {
  const disclosure = cleanOptional(value) ?? DEFAULT_DISCLOSURE;
  if (!disclosureFitsMenu(disclosure)) {
    throw new HrStoreError(`aiDisclosure must not exceed ${MAX_DISCLOSURE_BYTES} UTF-8 bytes`, "VALIDATION");
  }
  return disclosure;
}

function disclosureFitsMenu(value: string): boolean {
  return Buffer.byteLength(value, "utf8") <= MAX_DISCLOSURE_BYTES;
}

function introductionFitsMessage(bio: string | undefined, welcomeMessage: string | undefined): boolean {
  const content = [bio, welcomeMessage]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
  return Buffer.byteLength(content, "utf8") <= MAX_INTRO_MESSAGE_BYTES;
}

function requireIntroductionWithinLimit(bio: string | undefined, welcomeMessage: string | undefined): void {
  if (!introductionFitsMessage(bio, welcomeMessage)) {
    throw new HrStoreError(
      `Candidate introduction and welcome message must not exceed ${MAX_INTRO_MESSAGE_BYTES} UTF-8 bytes combined`,
      "VALIDATION"
    );
  }
}

function normalizeAttachments(value: HrArchivedAttachment[] | undefined): HrArchivedAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map((attachment) => ({
    type: ["image", "file", "video", "audio"].includes(attachment?.type) ? attachment.type : "unknown",
    ...(cleanOptional(attachment?.name)?.slice(0, 255) ? { name: cleanOptional(attachment.name)!.slice(0, 255) } : {})
  }));
}

function validTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.valueOf())) throw new HrStoreError("createdAt is invalid", "VALIDATION");
  return timestamp.toISOString();
}

function required(value: string, field: string, max: number): string {
  const clean = value?.trim();
  if (!clean) throw new HrStoreError(`${field} is required`, "VALIDATION");
  if (clean.length > max) throw new HrStoreError(`${field} is too long`, "VALIDATION");
  return clean;
}

function normalizeMaterialDisplayName(value: string, expectedExtension: string): string {
  const name = required(value.normalize("NFC"), "uploaded file name", 255);
  if (Buffer.byteLength(name, "utf8") > 255
    || /[\u0000-\u001f\u007f/\\]/u.test(name)
    || name === "."
    || name === ".."
    || path.extname(name).toLowerCase() !== expectedExtension) {
    throw new HrStoreError("Uploaded file name is invalid", "VALIDATION");
  }
  return name;
}

function emptyExtraction(): RecruitmentExtraction {
  return { stage: "unknown", conditions: [], concerns: [], signals: [] };
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[。！？!?；;\n])/u).map((item) => item.trim()).filter(Boolean);
}

function firstCaptured(text: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const captured = pattern.exec(text)?.[1]?.trim()
      .replace(/^(?:一家|一个)/u, "")
      .replace(/(?:的)?\s*(?:岗位|职位)$/u, "")
      .replace(/\s+/g, " ")
      .slice(0, 80);
    if (captured && captured.length >= 2) return captured;
  }
  return undefined;
}

function evidenceSentence(sentences: string[], needle: string): string {
  return shortQuote(sentences.find((sentence) => sentence.includes(needle)) ?? needle);
}

function shortQuote(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 240);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cleanOptional(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeComparable(value: string): string {
  return value.toLowerCase().replace(/[\s（）()\-_/]/g, "");
}

function fuzzyIncludes(haystack: string, needle: string): boolean {
  const normalizedNeedle = normalizeComparable(needle);
  return Boolean(normalizedNeedle) && normalizeComparable(haystack).includes(normalizedNeedle);
}

function laterTimestamp(first: string, second: string): string {
  return first.localeCompare(second) >= 0 ? first : second;
}

function stageWeight(stage: HrOpportunityStage): number {
  return ["unknown", "sourcing", "screening", "interview-proposed", "interview-scheduled", "offer"].indexOf(stage);
}

function stageLabel(stage: HrOpportunityStage): string {
  return ({
    unknown: "信息不足",
    sourcing: "机会接洽",
    screening: "初步沟通",
    "interview-proposed": "提出面试",
    "interview-scheduled": "已约面试",
    offer: "录用阶段"
  } as Record<HrOpportunityStage, string>)[stage];
}
