import { isUtf8 } from "node:buffer";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import QRCode from "qrcode";

import { clearHrKnowledgeCache } from "./hr-knowledge.js";

import {
  HR_CHANNEL,
  HrStore,
  HrStoreError,
  type ArchiveHrMessageInput,
  type ArchiveHrMessageResult,
  type HrDraft,
  type HrDraftType,
  type HrMaterialsSummary,
  type HrOpportunity,
  type HrOpportunityDetail,
  type HrSettingsSummary,
  type UpdateHrMaterialsInput,
  type UpdateHrSettingsInput
} from "../state/hr.js";

export type WecomCustomerServiceAdapterStatus = {
  state: "disabled" | "incomplete" | "awaiting-adapter" | "ready" | "error";
  receiving: boolean;
  detail: string;
};

/**
 * A public WeCom callback implementation plugs in here. It is deliberately
 * separate from the localhost management server and the personal WeChat bridge.
 */
export interface WecomCustomerServiceAdapter {
  readonly channel: typeof HR_CHANNEL;
  getStatus(): WecomCustomerServiceAdapterStatus;
  matchesCallbackPath?(pathname: string): boolean;
  verifyCallbackUrl?(query: WecomPublicCallbackQuery, echoString: string): Promise<string>;
  acceptCallback?(query: WecomPublicCallbackQuery, encryptedXml: Buffer): Promise<void>;
  createContactWay?(scene: string): Promise<string>;
  waitForIdle?(): Promise<void>;
}

export type WecomPublicCallbackQuery = {
  msgSignature: string;
  timestamp: string;
  nonce: string;
};

export type WecomCustomerServiceInboundEvent = ArchiveHrMessageInput & {
  corpId: string;
  consentAction?: "accept" | "decline";
};

export type HrInboundDisposition = {
  disposition: "consent-required" | "consent-declined" | "archived-isolated";
  localCodexAllowed: false;
  duplicate: boolean;
  visitor: ArchiveHrMessageResult["visitor"];
  message?: ArchiveHrMessageResult["message"];
  opportunity?: ArchiveHrMessageResult["opportunity"];
  consentPlan?: {
    text: string;
    menu: Array<{ id: "consent:accept" | "consent:decline"; label: string }>;
  };
  postConsentPlan?: {
    deliveryId: string;
    text?: string;
    resume?: { id: string; name?: string };
  };
};

export type HrEntrySummary = {
  channel: typeof HR_CHANNEL;
  stableId: string;
  enabled: boolean;
  configured: boolean;
  publicLink?: string;
  contactUrl?: string;
  qrContent?: string;
  qrDataUrl?: string;
  callbackUrl?: string;
  localCallbackTarget?: string;
  providerManaged: true;
  validity: "until-revoked-or-changed";
  validityNote: string;
};

export type HrBootstrap = {
  settings: HrSettingsSummary;
  entry: HrEntrySummary;
  materials: HrMaterialsSummary;
  connection: WecomCustomerServiceAdapterStatus;
  opportunities: HrOpportunity[];
};

export type HrServiceOptions = {
  store: HrStore;
  adapter?: WecomCustomerServiceAdapter;
  qrDataUrlFactory?: (content: string) => Promise<string>;
  callbackListenerUrl?: string;
};

export type HrMaterialUploadKind = "resume" | "knowledge";

export type HrMaterialUploadInput = {
  kind: HrMaterialUploadKind;
  fileName: string;
  contentType: string;
  data: Buffer;
};

export type HrMaterialUploadResult = {
  materials: HrMaterialsSummary;
  uploaded: {
    kind: HrMaterialUploadKind;
    name: string;
    size: number;
  };
};

const MAX_RESUME_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_STRUCTURED_KNOWLEDGE_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_KNOWLEDGE_UPLOAD_BYTES = 512 * 1024;
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export class HrService {
  private readonly qrDataUrlFactory: (content: string) => Promise<string>;
  private callbackListenerUrl?: string;
  private inboundQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: HrServiceOptions) {
    this.callbackListenerUrl = options.callbackListenerUrl;
    this.qrDataUrlFactory = options.qrDataUrlFactory ?? ((content) => QRCode.toDataURL(content, {
      width: 320,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#111816", light: "#ffffff" }
    }));
  }

  setCallbackListenerUrl(url: string): void {
    this.callbackListenerUrl = url;
  }

  async getBootstrap(): Promise<HrBootstrap> {
    const [entry] = await Promise.all([this.getEntry()]);
    return {
      settings: this.options.store.getSettings(),
      entry,
      materials: this.options.store.getMaterials(),
      connection: this.getConnectionStatus(),
      opportunities: this.options.store.listOpportunities()
    };
  }

  getSettings(): HrSettingsSummary {
    return this.options.store.getSettings();
  }

  async updateSettings(input: UpdateHrSettingsInput): Promise<{ settings: HrSettingsSummary; entry: HrEntrySummary; connection: WecomCustomerServiceAdapterStatus }> {
    const current = this.options.store.getSettings();
    const suppliedLink = input.serviceLink !== undefined ? input.serviceLink : input.contactUrl;
    const effectiveLinkPresent = suppliedLink === undefined
      ? Boolean(current.serviceLink)
      : Boolean(suppliedLink?.trim());
    let settings: HrSettingsSummary;
    if (input.enabled === true && !effectiveLinkPresent && this.options.adapter?.createContactWay) {
      const staged = await this.options.store.updateSettings({ ...input, enabled: false });
      const serviceLink = await this.options.adapter.createContactWay(contactScene(staged.stableId));
      await this.options.store.updateSettings({ serviceLink });
      settings = await this.options.store.updateSettings({ enabled: true });
    } else {
      settings = await this.options.store.updateSettings(input);
    }
    return {
      settings,
      entry: await this.getEntry(),
      connection: this.getConnectionStatus()
    };
  }

  getMaterials(): HrMaterialsSummary {
    return this.options.store.getMaterials();
  }

  async updateMaterials(input: UpdateHrMaterialsInput): Promise<HrMaterialsSummary> {
    const materials = await this.options.store.updateMaterials(input);
    clearHrKnowledgeCache();
    return materials;
  }

  async uploadMaterial(input: HrMaterialUploadInput): Promise<HrMaterialUploadResult> {
    const validated = validateMaterialUpload(input);
    let stagingDirectory: string | undefined;
    try {
      stagingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-material-upload-"));
      const stagingPath = path.join(stagingDirectory, `${crypto.randomUUID()}${validated.extension}`);
      fs.writeFileSync(stagingPath, input.data, { flag: "wx", mode: 0o600 });
      const materials = input.kind === "resume"
        ? await this.options.store.importUploadedResume(stagingPath, validated.fileName)
        : await this.options.store.importUploadedKnowledgeFile(stagingPath, validated.fileName);
      clearHrKnowledgeCache();
      return {
        materials,
        uploaded: {
          kind: input.kind,
          name: validated.fileName,
          size: input.data.length
        }
      };
    } finally {
      if (stagingDirectory) {
        fs.rmSync(stagingDirectory, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
      }
    }
  }

  getResumeFile(id: string): { path: string; name: string } {
    return this.options.store.getResumeFile(id);
  }

  listOpportunities(): HrOpportunity[] {
    return this.options.store.listOpportunities();
  }

  getOpportunity(id: string): HrOpportunityDetail {
    return this.options.store.getOpportunity(id);
  }

  generateDraft(opportunityId: string, type: HrDraftType): Promise<HrDraft> {
    return this.options.store.generateDraft(opportunityId, type);
  }

  setDraftStatus(draftId: string, status: "reviewed" | "approved" | "rejected"): Promise<HrDraft> {
    return this.options.store.setDraftStatus(draftId, status);
  }

  async ensureContactWay(force = false): Promise<{ settings: HrSettingsSummary; entry: HrEntrySummary }> {
    const current = this.options.store.getSettings();
    if (!force && current.serviceLink) return { settings: current, entry: await this.getEntry() };
    if (!this.options.adapter?.createContactWay) {
      throw new HrStoreError("WeChat Customer Service contact-way adapter is unavailable", "NOT_CONFIGURED");
    }
    const serviceLink = await this.options.adapter.createContactWay(contactScene(current.stableId));
    const settings = await this.options.store.updateSettings({ serviceLink });
    return { settings, entry: await this.getEntry() };
  }

  matchesPublicCallback(pathname: string): boolean {
    return this.options.adapter?.matchesCallbackPath?.(pathname) ?? false;
  }

  verifyPublicCallback(query: WecomPublicCallbackQuery, echoString: string): Promise<string> {
    if (!this.options.adapter?.verifyCallbackUrl) {
      throw new HrStoreError("WeChat Customer Service callback adapter is unavailable", "NOT_CONFIGURED");
    }
    return this.options.adapter.verifyCallbackUrl(query, echoString);
  }

  acceptPublicCallback(query: WecomPublicCallbackQuery, encryptedXml: Buffer): Promise<void> {
    if (!this.options.adapter?.acceptCallback) {
      throw new HrStoreError("WeChat Customer Service callback adapter is unavailable", "NOT_CONFIGURED");
    }
    return this.options.adapter.acceptCallback(query, encryptedXml);
  }

  waitForAdapterIdle(): Promise<void> {
    return this.options.adapter?.waitForIdle?.() ?? Promise.resolve();
  }

  async getEntry(): Promise<HrEntrySummary> {
    const settings = this.options.store.getSettings();
    let qrDataUrl: string | undefined;
    if (settings.serviceLink) {
      try {
        qrDataUrl = await this.qrDataUrlFactory(settings.serviceLink);
      } catch {
        // The stable official link remains usable even if local QR rendering fails.
      }
    }
    return {
      channel: HR_CHANNEL,
      stableId: settings.stableId,
      enabled: settings.enabled,
      configured: settings.configured,
      ...(settings.serviceLink ? {
        publicLink: settings.serviceLink,
        contactUrl: settings.serviceLink,
        qrContent: settings.serviceLink
      } : {}),
      ...(qrDataUrl ? { qrDataUrl } : {}),
      ...(settings.callbackPublicUrl ? { callbackUrl: settings.callbackPublicUrl } : {}),
      ...(this.callbackListenerUrl ? { localCallbackTarget: this.callbackListenerUrl } : {}),
      providerManaged: true,
      validity: "until-revoked-or-changed",
      validityNote: "由企业微信托管；客服帐号、场景或权限未被撤销和变更时可长期使用"
    };
  }

  getConnectionStatus(): WecomCustomerServiceAdapterStatus {
    const settings = this.options.store.getSettings();
    if (!settings.enabled) {
      return { state: "disabled", receiving: false, detail: "微信客服接入尚未启用" };
    }
    if (!settings.configured || !settings.callbackPublicUrl) {
      return { state: "incomplete", receiving: false, detail: "微信客服配置或公网回调地址不完整" };
    }
    if (!this.options.adapter) {
      return {
        state: "awaiting-adapter",
        receiving: false,
        detail: "配置已保存；公网加密回调适配器尚未安装，本机管理 API 不接收企业微信回调"
      };
    }
    if (this.options.adapter.channel !== HR_CHANNEL) {
      return { state: "error", receiving: false, detail: "接入适配器通道不匹配" };
    }
    return this.options.adapter.getStatus();
  }

  /** Called only by a verified WeCom callback adapter, never by the local HTTP management API. */
  handleVerifiedInbound(event: WecomCustomerServiceInboundEvent): Promise<HrInboundDisposition> {
    return this.enqueueInbound(() => this.handleVerifiedInboundNow(event));
  }

  private async handleVerifiedInboundNow(event: WecomCustomerServiceInboundEvent): Promise<HrInboundDisposition> {
    const settings = this.options.store.getSettings();
    if (!settings.enabled || !settings.configured) {
      throw new HrStoreError("WeChat Customer Service is disabled or incomplete", "NOT_CONFIGURED");
    }
    if (event.corpId.trim() !== settings.corpId || event.openKfid.trim() !== settings.openKfid) {
      throw new HrStoreError("WeChat Customer Service event does not match the configured account", "VALIDATION");
    }
    const consentAction = event.consentAction ?? consentActionFromText(event.text);
    let visitor = this.options.store.findVisitor(event.openKfid, event.externalUserId);
    const consentRecord = (!visitor || visitor.consentStatus !== "accepted" || consentAction)
      ? await this.options.store.recordPreConsentEvent(event)
      : undefined;
    visitor ??= consentRecord!.visitor;
    if (consentAction === "decline") {
      if (consentRecord?.duplicate && visitor.consentStatus === "declined") {
        return {
          disposition: "consent-declined",
          localCodexAllowed: false,
          duplicate: true,
          visitor
        };
      }
      visitor = (await this.options.store.transitionVisitorConsent(visitor.id, "declined")).visitor;
      return {
        disposition: "consent-declined",
        localCodexAllowed: false,
        duplicate: consentRecord?.duplicate ?? false,
        visitor
      };
    }
    let newlyAccepted = false;
    if (consentAction === "accept") {
      if (consentRecord?.duplicate && visitor.consentStatus !== "accepted") {
        return consentDisposition(settings.aiDisclosure, visitor, true);
      }
      const transition = await this.options.store.transitionVisitorConsent(visitor.id, "accepted");
      visitor = transition.visitor;
      newlyAccepted = transition.changed && !consentRecord?.duplicate;
    }
    if (visitor.consentStatus !== "accepted") {
      const pending = consentRecord ?? await this.options.store.recordPreConsentEvent(event);
      return consentDisposition(settings.aiDisclosure, pending.visitor, pending.duplicate);
    }

    const archived = await this.options.store.archiveInbound(event);
    const materials = this.options.store.getMaterials();
    const postConsentText = [materials.bio, settings.welcomeMessage]
      .filter((part): part is string => Boolean(part?.trim()))
      .join("\n\n");
    const shouldDeliverMaterials = Boolean(visitor.materialsDeliveryId)
      && visitor.materialsStatus !== "sent"
      && (newlyAccepted || (consentAction === "accept" && visitor.materialsStatus === "failed"));
    return {
      ...archived,
      disposition: "archived-isolated",
      localCodexAllowed: false,
      ...(shouldDeliverMaterials && visitor.materialsDeliveryId ? {
        postConsentPlan: {
          deliveryId: visitor.materialsDeliveryId,
          ...(postConsentText ? { text: postConsentText } : {}),
          ...(materials.resume.id ? {
            resume: { id: materials.resume.id, ...(materials.resume.name ? { name: materials.resume.name } : {}) }
          } : {})
        }
      } : {})
    };
  }

  async archiveVerifiedOutbound(event: WecomCustomerServiceInboundEvent): Promise<ArchiveHrMessageResult> {
    const settings = this.options.store.getSettings();
    if (!settings.enabled || event.corpId.trim() !== settings.corpId || event.openKfid.trim() !== settings.openKfid) {
      throw new HrStoreError("WeChat Customer Service outbound event does not match the configured account", "VALIDATION");
    }
    return this.options.store.archiveOutbound(event);
  }

  setMaterialsDeliveryStatus(
    visitorId: string,
    deliveryId: string,
    status: "pending" | "sent" | "failed"
  ): ReturnType<HrStore["setMaterialsDeliveryStatus"]> {
    return this.options.store.setMaterialsDeliveryStatus(visitorId, deliveryId, status);
  }

  private enqueueInbound<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.inboundQueue.then(operation, operation);
    this.inboundQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function consentDisposition(
  disclosure: string,
  visitor: ArchiveHrMessageResult["visitor"],
  duplicate: boolean
): HrInboundDisposition {
  return {
    disposition: visitor.consentStatus === "declined" ? "consent-declined" : "consent-required",
    localCodexAllowed: false,
    duplicate,
    visitor,
    ...(visitor.consentStatus === "declined" ? {} : {
      consentPlan: {
        text: disclosure,
        menu: [
          { id: "consent:accept", label: "同意并获取简历" },
          { id: "consent:decline", label: "暂不同意" }
        ]
      }
    })
  };
}

function consentActionFromText(text: string | undefined): "accept" | "decline" | undefined {
  const normalized = text?.trim().replace(/\s+/g, "");
  if (normalized === "同意并获取简历" || normalized === "consent:accept") return "accept";
  if (normalized === "暂不同意" || normalized === "不同意" || normalized === "consent:decline") return "decline";
  return undefined;
}

function contactScene(stableId: string): string {
  return `hr_${crypto.createHash("sha256").update(stableId).digest("hex").slice(0, 29)}`;
}

function validateMaterialUpload(input: HrMaterialUploadInput): { fileName: string; extension: string } {
  const fileName = input.fileName.normalize("NFC").trim();
  if (!fileName
    || fileName.length > 255
    || Buffer.byteLength(fileName, "utf8") > 255
    || /[\u0000-\u001f\u007f/\\]/u.test(fileName)
    || fileName === "."
    || fileName === "..") {
    throw new HrStoreError("Uploaded file name is invalid", "VALIDATION");
  }

  const extension = path.extname(fileName).toLowerCase();
  const contentType = input.contentType.trim().toLowerCase();
  const allowed: Map<string, Set<string>> = input.kind === "resume"
    ? new Map([[".pdf", new Set(["application/pdf"])]] as const)
    : new Map([
        [".pdf", new Set(["application/pdf"])],
        [".docx", new Set([DOCX_MIME])],
        [".txt", new Set(["text/plain"])],
        [".md", new Set(["text/markdown", "text/plain"])]
      ] as const);
  const allowedTypes = allowed.get(extension);
  if (!allowedTypes || !allowedTypes.has(contentType)) {
    throw new HrStoreError(
      input.kind === "resume"
        ? "Resume upload must be a PDF with application/pdf content type"
        : "Knowledge upload must be PDF, DOCX, TXT or MD with a matching content type",
      "VALIDATION"
    );
  }
  if (input.data.length === 0) {
    throw new HrStoreError("Uploaded file is empty", "VALIDATION");
  }

  const maxBytes = input.kind === "resume"
    ? MAX_RESUME_UPLOAD_BYTES
    : extension === ".txt" || extension === ".md"
      ? MAX_TEXT_KNOWLEDGE_UPLOAD_BYTES
      : MAX_STRUCTURED_KNOWLEDGE_UPLOAD_BYTES;
  if (input.data.length > maxBytes) {
    throw new HrStoreError("Uploaded file exceeds the allowed size", "VALIDATION");
  }

  if (extension === ".pdf" && !input.data.subarray(0, 5).equals(Buffer.from("%PDF-", "ascii"))) {
    throw new HrStoreError("Uploaded PDF does not contain a valid PDF header", "VALIDATION");
  }
  if (extension === ".docx") {
    const zipHeader = input.data.subarray(0, 4);
    const isZip = zipHeader.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const hasContentTypes = input.data.includes(Buffer.from("[Content_Types].xml", "ascii"));
    const hasDocument = input.data.includes(Buffer.from("word/document.xml", "ascii"));
    if (!isZip || !hasContentTypes || !hasDocument) {
      throw new HrStoreError("Uploaded DOCX package is invalid", "VALIDATION");
    }
  }
  if ((extension === ".txt" || extension === ".md")
    && (!isUtf8(input.data) || input.data.includes(0))) {
    throw new HrStoreError("Uploaded text file must contain valid UTF-8 text", "VALIDATION");
  }
  return { fileName, extension };
}
