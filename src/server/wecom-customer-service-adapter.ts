import crypto from "node:crypto";
import fs from "node:fs";

import { XMLParser } from "fast-xml-parser";

import {
  HR_CHANNEL,
  HrStore,
  HrStoreError,
  type HrArchivedAttachment
} from "../state/hr.js";
import type {
  HrInboundDisposition,
  WecomCustomerServiceAdapter,
  WecomCustomerServiceAdapterStatus,
  WecomCustomerServiceInboundEvent
} from "./hr-service.js";

const DEFAULT_API_BASE_URL = "https://qyapi.weixin.qq.com";
const ACCESS_TOKEN_SKEW_SECONDS = 120;
const MAX_SYNC_PAGES = 100;
const CALLBACK_BODY_LIMIT_BYTES = 256 * 1024;
const CALLBACK_REPLAY_WINDOW_MS = 10 * 60 * 1_000;
const CALLBACK_SIGNATURE_MAX_AGE_MS = 10 * 60 * 1_000;
const MAX_CALLBACK_REPLAY_ENTRIES = 2_048;
const RECONCILIATION_INTERVAL_MS = 5 * 60 * 1_000;
const RECONCILIATION_START_DELAY_MS = 5_000;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

type WecomApiResult = Record<string, unknown> & {
  errcode?: number;
  errmsg?: string;
};

type CallbackCredentials = {
  corpId: string;
  token: string;
  encodingAesKey: string;
};

export type WecomCallbackQuery = {
  msgSignature: string;
  timestamp: string;
  nonce: string;
};

export type OfficialWecomCustomerServiceAdapterOptions = {
  store: HrStore;
  handleInbound: (event: WecomCustomerServiceInboundEvent) => Promise<HrInboundDisposition> | HrInboundDisposition;
  archiveOutbound: (event: WecomCustomerServiceInboundEvent) => Promise<unknown> | unknown;
  setMaterialsDeliveryStatus: (
    visitorId: string,
    deliveryId: string,
    status: "pending" | "sent" | "failed"
  ) => Promise<unknown> | unknown;
  getResumeFile: (id: string) => { path: string; name: string };
  generateAiReply?: (
    event: WecomCustomerServiceInboundEvent,
    disposition: HrInboundDisposition
  ) => Promise<string | undefined> | string | undefined;
  fetchImpl?: FetchLike;
  apiBaseUrl?: string;
  now?: () => number;
  logger?: Pick<Console, "error" | "warn">;
};

export class WecomAdapterError extends Error {
  constructor(
    message: string,
    readonly code: "AUTH" | "PROTOCOL" | "API" | "NOT_CONFIGURED",
    readonly apiErrorCode?: number
  ) {
    super(message);
    this.name = "WecomAdapterError";
  }
}

/**
 * Official Enterprise WeChat "WeChat Customer Service" protocol adapter.
 * It has no dependency on the retained personal-WeChat bridge.
 */
export class OfficialWecomCustomerServiceAdapter implements WecomCustomerServiceAdapter {
  readonly channel = HR_CHANNEL;

  private readonly fetchImpl: FetchLike;
  private readonly apiBaseUrl: string;
  private readonly now: () => number;
  private readonly logger: Pick<Console, "error" | "warn">;
  private tokenCache?: { fingerprint: string; token: string; expiresAt: number };
  private callbackCredentialsCache?: {
    credentialsRevision: string;
    promise: Promise<CallbackCredentials>;
  };
  private readonly recentCallbacks = new Map<string, number>();
  private lastError?: string;
  private syncQueue: Promise<void> = Promise.resolve();
  private reconciliationTimer?: NodeJS.Timeout;
  private reconciliationStartTimer?: NodeJS.Timeout;

  constructor(private readonly options: OfficialWecomCustomerServiceAdapterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiBaseUrl = (options.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/u, "");
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? console;
  }

  getStatus(): WecomCustomerServiceAdapterStatus {
    const settings = this.options.store.getSettings();
    if (!settings.enabled) {
      return { state: "disabled", receiving: false, detail: "微信客服接入尚未启用" };
    }
    if (!settings.configured || !settings.callbackPublicUrl) {
      return { state: "incomplete", receiving: false, detail: "微信客服配置或公网回调地址不完整" };
    }
    if (this.lastError) {
      return { state: "error", receiving: false, detail: this.lastError };
    }
    const verifiedAt = this.options.store.getCallbackVerifiedAt();
    return verifiedAt ? {
      state: "ready",
      receiving: true,
      detail: `企业微信已完成回调验签（${verifiedAt}）`
    } : {
      state: "ready",
      receiving: false,
      detail: "加密回调适配器已安装，等待企业微信后台完成 URL 验证"
    };
  }

  matchesCallbackPath(pathname: string): boolean {
    const callbackPublicUrl = this.options.store.getSettings().callbackPublicUrl;
    if (!callbackPublicUrl) return false;
    try {
      return new URL(callbackPublicUrl).pathname === pathname;
    } catch {
      return false;
    }
  }

  async verifyCallbackUrl(query: WecomCallbackQuery, echoString: string): Promise<string> {
    this.assertLocallyEnabled();
    const credentials = await this.readCallbackCredentials();
    this.verifySignature(credentials.token, query, echoString);
    const decrypted = decryptWecomPayload(echoString, credentials.encodingAesKey);
    if (decrypted.receiveId !== credentials.corpId) {
      throw new WecomAdapterError("Callback receiver does not match the configured CorpID", "AUTH");
    }
    await this.options.store.markCallbackVerified();
    this.lastError = undefined;
    return decrypted.message;
  }

  async acceptCallback(query: WecomCallbackQuery, encryptedXml: Buffer): Promise<void> {
    this.assertLocallyEnabled();
    if (encryptedXml.length > CALLBACK_BODY_LIMIT_BYTES) {
      throw new WecomAdapterError("Callback body is too large", "PROTOCOL");
    }
    const wrapper = parseXmlRoot(encryptedXml.toString("utf8"));
    const encrypted = requiredXmlString(wrapper, "Encrypt");
    const credentials = await this.readCallbackCredentials();
    this.verifySignature(credentials.token, query, encrypted);
    const decrypted = decryptWecomPayload(encrypted, credentials.encodingAesKey);
    if (decrypted.receiveId !== credentials.corpId) {
      throw new WecomAdapterError("Callback receiver does not match the configured CorpID", "AUTH");
    }
    const event = parseXmlRoot(decrypted.message);
    if (requiredXmlString(event, "ToUserName") !== credentials.corpId
      || requiredXmlString(event, "MsgType") !== "event"
      || requiredXmlString(event, "Event") !== "kf_msg_or_event") {
      throw new WecomAdapterError("Unsupported or mismatched callback event", "PROTOCOL");
    }
    const syncToken = requiredXmlString(event, "Token");
    const openKfid = requiredXmlString(event, "OpenKfId");
    const configuredOpenKfid = this.options.store.getSettings().openKfid;
    if (openKfid !== configuredOpenKfid) {
      throw new WecomAdapterError("Callback event does not match the configured customer service account", "AUTH");
    }
    if (!this.rememberCallback(query, encrypted)) return;
    void this.enqueueSync(syncToken, openKfid);
  }

  async waitForIdle(): Promise<void> {
    await this.syncQueue;
  }

  startReconciliation(): void {
    if (this.reconciliationTimer || this.reconciliationStartTimer) return;
    const reconcile = () => {
      void this.reconcileMessages().catch(() => undefined);
    };
    this.reconciliationStartTimer = setTimeout(() => {
      this.reconciliationStartTimer = undefined;
      reconcile();
    }, RECONCILIATION_START_DELAY_MS);
    this.reconciliationStartTimer.unref();
    this.reconciliationTimer = setInterval(reconcile, RECONCILIATION_INTERVAL_MS);
    this.reconciliationTimer.unref();
  }

  stopReconciliation(): void {
    if (this.reconciliationStartTimer) clearTimeout(this.reconciliationStartTimer);
    if (this.reconciliationTimer) clearInterval(this.reconciliationTimer);
    this.reconciliationStartTimer = undefined;
    this.reconciliationTimer = undefined;
  }

  async reconcileMessages(): Promise<void> {
    const settings = this.options.store.getSettings();
    if (!settings.enabled || !settings.configured || !settings.openKfid) return;
    await this.enqueueSync(undefined, settings.openKfid);
  }

  async createContactWay(scene: string): Promise<string> {
    const normalizedScene = normalizeScene(scene);
    const credentials = await this.options.store.readApiCredentials();
    const result = await this.callApi("/cgi-bin/kf/add_contact_way", () => ({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ open_kfid: credentials.openKfid, scene: normalizedScene })
    }));
    const contactUrl = requiredApiString(result, "url");
    validateOfficialContactUrl(contactUrl);
    this.lastError = undefined;
    return contactUrl;
  }

  async syncMessages(syncToken: string | undefined, openKfid: string): Promise<void> {
    await this.enqueueSync(syncToken, openKfid);
  }

  private enqueueSync(syncToken: string | undefined, openKfid: string): Promise<void> {
    const task = this.syncQueue.then(() => this.performSyncMessages(syncToken, openKfid));
    this.syncQueue = task.catch((error: unknown) => {
      this.lastError = safeErrorDetail(error);
      this.logger.error(`[wecom-hr] message synchronization failed: ${this.lastError}`);
    });
    return task;
  }

  private async performSyncMessages(syncToken: string | undefined, openKfid: string): Promise<void> {
    this.assertLocallyEnabled();
    const settings = this.options.store.getSettings();
    if (openKfid !== settings.openKfid) {
      throw new WecomAdapterError("Sync request does not match the configured customer service account", "AUTH");
    }
    let cursor = this.options.store.getSyncCursor(openKfid);
    const seenCursors = new Set<string>();
    const promptedVisitors = new Set<string>();
    for (let page = 0; page < MAX_SYNC_PAGES; page += 1) {
      const result = await this.callApi("/cgi-bin/kf/sync_msg", () => ({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(cursor ? { cursor } : {}),
          ...(syncToken ? { token: syncToken } : {}),
          limit: 1000,
          voice_format: 0,
          open_kfid: openKfid
        })
      }));
      const messages = Array.isArray(result.msg_list) ? result.msg_list : [];
      const validatedMessages = messages.map((message) => {
        if (!message || typeof message !== "object") {
          throw new WecomAdapterError("WeChat Customer Service returned an invalid message", "PROTOCOL");
        }
        return message as Record<string, unknown>;
      });
      const orderedMessages = [
        ...validatedMessages.filter(isEnterSessionMessage),
        ...validatedMessages.filter((message) => !isEnterSessionMessage(message))
      ];
      for (const message of orderedMessages) {
        await this.processSyncedMessage(message, promptedVisitors);
      }
      const nextCursor = optionalApiString(result.next_cursor);
      if (nextCursor) {
        await this.options.store.setSyncCursor(openKfid, nextCursor);
        cursor = nextCursor;
      }
      if (Number(result.has_more) !== 1) {
        this.lastError = undefined;
        return;
      }
      if (!nextCursor || seenCursors.has(nextCursor)) {
        throw new WecomAdapterError("WeChat Customer Service returned a non-advancing cursor", "PROTOCOL");
      }
      seenCursors.add(nextCursor);
    }
    throw new WecomAdapterError("WeChat Customer Service sync exceeded the page limit", "PROTOCOL");
  }

  async sendText(externalUserId: string, openKfid: string, content: string): Promise<string> {
    const result = await this.sendMessage({
      touser: externalUserId,
      open_kfid: openKfid,
      msgtype: "text",
      text: { content: requireUtf8Within(content, 2_048, "Text message") }
    });
    return requiredApiString(result, "msgid");
  }

  async uploadMedia(filePath: string, type: "image" | "voice" | "video" | "file" = "file"): Promise<string> {
    const buildRequest = () => {
      const data = new Uint8Array(fs.readFileSync(filePath));
      const form = new FormData();
      form.append("media", new Blob([data], { type: type === "file" ? "application/octet-stream" : mediaMimeType(type) }), fileName(filePath));
      return { method: "POST", body: form } satisfies RequestInit;
    };
    const result = await this.callApi(`/cgi-bin/media/upload?type=${encodeURIComponent(type)}`, buildRequest);
    return requiredApiString(result, "media_id");
  }

  async sendFile(externalUserId: string, openKfid: string, mediaId: string): Promise<string> {
    const result = await this.sendMessage({
      touser: externalUserId,
      open_kfid: openKfid,
      msgtype: "file",
      file: { media_id: mediaId }
    });
    return requiredApiString(result, "msgid");
  }

  private assertLocallyEnabled(): void {
    const settings = this.options.store.getSettings();
    if (!settings.enabled || !settings.configured) {
      throw new WecomAdapterError("WeChat Customer Service is disabled or incomplete", "NOT_CONFIGURED");
    }
  }

  private verifySignature(token: string, query: WecomCallbackQuery, encrypted: string): void {
    if (!query.msgSignature || !query.timestamp || !query.nonce) {
      throw new WecomAdapterError("Callback signature parameters are incomplete", "AUTH");
    }
    const timestamp = Number(query.timestamp);
    if (!Number.isSafeInteger(timestamp)
      || Math.abs(this.now() - timestamp * 1_000) > CALLBACK_SIGNATURE_MAX_AGE_MS) {
      throw new WecomAdapterError("Callback signature timestamp is stale", "AUTH");
    }
    const expected = crypto.createHash("sha1")
      .update([token, query.timestamp, query.nonce, encrypted].sort().join(""))
      .digest("hex");
    if (!safeTextEqual(expected, query.msgSignature.toLowerCase())) {
      throw new WecomAdapterError("Callback signature is invalid", "AUTH");
    }
  }

  private readCallbackCredentials(): Promise<CallbackCredentials> {
    const credentialsRevision = this.options.store.getCallbackCredentialsRevision();
    if (this.callbackCredentialsCache?.credentialsRevision === credentialsRevision) {
      return this.callbackCredentialsCache.promise;
    }
    const promise = this.options.store.readCallbackCredentials();
    this.callbackCredentialsCache = { credentialsRevision, promise };
    void promise.catch(() => {
      if (this.callbackCredentialsCache?.promise === promise) this.callbackCredentialsCache = undefined;
    });
    return promise;
  }

  private rememberCallback(query: WecomCallbackQuery, encrypted: string): boolean {
    const receivedAt = this.now();
    const oldestAllowed = receivedAt - CALLBACK_REPLAY_WINDOW_MS;
    for (const [key, timestamp] of this.recentCallbacks) {
      if (timestamp >= oldestAllowed) break;
      this.recentCallbacks.delete(key);
    }
    const key = crypto.createHash("sha256")
      .update(query.timestamp)
      .update("\0")
      .update(query.nonce)
      .update("\0")
      .update(encrypted)
      .digest("hex");
    if (this.recentCallbacks.has(key)) return false;
    this.recentCallbacks.set(key, receivedAt);
    while (this.recentCallbacks.size > MAX_CALLBACK_REPLAY_ENTRIES) {
      const oldest = this.recentCallbacks.keys().next().value as string | undefined;
      if (!oldest) break;
      this.recentCallbacks.delete(oldest);
    }
    return true;
  }

  private async processSyncedMessage(
    message: Record<string, unknown>,
    promptedVisitors: Set<string>
  ): Promise<void> {
    const origin = Number(message.origin);
    if (origin === 4 || message.msgtype === "event") {
      await this.processSystemEvent(message, promptedVisitors);
      return;
    }
    if (origin !== 3 && origin !== 5) return;
    const settings = this.options.store.getSettings();
    const openKfid = requiredApiString(message, "open_kfid");
    const externalUserId = requiredApiString(message, "external_userid");
    if (openKfid !== settings.openKfid) {
      throw new WecomAdapterError("Synced message does not match the configured customer service account", "AUTH");
    }
    const msgType = optionalApiString(message.msgtype) ?? "unknown";
    const event: WecomCustomerServiceInboundEvent = {
      corpId: settings.corpId!,
      openKfid,
      externalUserId,
      channelMessageId: requiredApiString(message, "msgid"),
      text: syncedMessageText(message, msgType),
      messageType: msgType,
      attachments: syncedAttachments(message, msgType),
      createdAt: syncedTimestamp(message.send_time),
      ...(menuConsentAction(message) ? { consentAction: menuConsentAction(message) } : {})
    };
    if (origin === 5) {
      if (this.options.store.findVisitor(openKfid, externalUserId)?.consentStatus !== "accepted") return;
      await this.options.archiveOutbound(event);
      return;
    }
    const disposition = await this.options.handleInbound(event);
    await this.applyInboundDisposition(disposition, event, promptedVisitors);
  }

  private async processSystemEvent(message: Record<string, unknown>, promptedVisitors: Set<string>): Promise<void> {
    const eventPayload = asRecord(message.event);
    const eventType = optionalApiString(eventPayload.event_type);
    if (eventType === "msg_send_fail") {
      const failedMessageId = optionalApiString(eventPayload.fail_msgid);
      if (failedMessageId) {
        const failure = await this.options.store.markMaterialComponentFailedByProviderMessageId(failedMessageId);
        if (failure.matched && failure.currentAttempt) {
          this.logger.warn("[wecom-hr] Enterprise WeChat reported a material message delivery failure");
        }
      }
      return;
    }
    if (eventType !== "enter_session") return;
    const settings = this.options.store.getSettings();
    const openKfid = requiredApiString(eventPayload, "open_kfid");
    const externalUserId = requiredApiString(eventPayload, "external_userid");
    if (openKfid !== settings.openKfid) {
      throw new WecomAdapterError("Enter-session event does not match the configured customer service account", "AUTH");
    }
    const inboundEvent: WecomCustomerServiceInboundEvent = {
      corpId: settings.corpId!,
      openKfid,
      externalUserId,
      channelMessageId: requiredApiString(message, "msgid"),
      messageType: "event:enter_session",
      createdAt: syncedTimestamp(message.send_time)
    };
    const disposition = await this.options.handleInbound(inboundEvent);
    const welcomeCode = optionalApiString(eventPayload.welcome_code);
    if (disposition.disposition === "consent-required" && disposition.consentPlan) {
      const visitorKey = `${openKfid}\0${externalUserId}`;
      if (promptedVisitors.has(visitorKey)) return;
      if (welcomeCode) {
        try {
          await this.sendConsentMenuOnEvent(welcomeCode, disposition);
          promptedVisitors.add(visitorKey);
          return;
        } catch {
          this.logger.warn("[wecom-hr] Welcome code could not be used; falling back to a regular consent menu");
        }
      }
      await this.sendConsentMenu(externalUserId, openKfid, disposition);
      promptedVisitors.add(visitorKey);
    }
  }

  private async applyInboundDisposition(
    disposition: HrInboundDisposition,
    event: WecomCustomerServiceInboundEvent,
    promptedVisitors: Set<string>
  ): Promise<void> {
    if (disposition.disposition === "consent-required" && disposition.consentPlan) {
      const visitorKey = `${event.openKfid}\0${event.externalUserId}`;
      if (promptedVisitors.has(visitorKey)) return;
      await this.sendConsentMenu(event.externalUserId, event.openKfid, disposition);
      promptedVisitors.add(visitorKey);
      return;
    }
    if (disposition.postConsentPlan) {
      const plan = disposition.postConsentPlan;
      const components = [
        ...(plan.text ? ["intro" as const] : []),
        ...(plan.resume ? ["resume" as const] : [])
      ];
      if (!components.length) {
        await this.options.setMaterialsDeliveryStatus(disposition.visitor.id, plan.deliveryId, "sent");
      } else {
        let delivery = await this.options.store.ensureMaterialDelivery({
          deliveryId: plan.deliveryId,
          visitorId: disposition.visitor.id,
          components
        });
        if (plan.text && delivery.components.intro?.status !== "submitted") {
          try {
            const sentMessageId = await this.sendText(event.externalUserId, event.openKfid, plan.text);
            delivery = await this.options.store.markMaterialComponentSubmitted(plan.deliveryId, "intro", sentMessageId);
            try {
              await this.options.archiveOutbound({
                ...event,
                channelMessageId: sentMessageId,
                text: plan.text,
                messageType: "text"
              });
            } catch {
              this.logger.warn("[wecom-hr] Submitted introduction could not be added to the local archive");
            }
          } catch (error) {
            await this.options.store.markMaterialComponentFailed(plan.deliveryId, "intro");
            throw error;
          }
        }
        if (plan.resume && delivery.components.resume?.status !== "submitted") {
          try {
            const resume = this.options.getResumeFile(plan.resume.id);
            const mediaId = await this.uploadMedia(resume.path, "file");
            const sentMessageId = await this.sendFile(event.externalUserId, event.openKfid, mediaId);
            await this.options.store.markMaterialComponentSubmitted(plan.deliveryId, "resume", sentMessageId);
            try {
              await this.options.archiveOutbound({
                ...event,
                channelMessageId: sentMessageId,
                text: "",
                messageType: "file",
                attachments: [{ type: "file", name: resume.name }]
              });
            } catch {
              this.logger.warn("[wecom-hr] Submitted resume could not be added to the local archive");
            }
          } catch (error) {
            await this.options.store.markMaterialComponentFailed(plan.deliveryId, "resume");
            throw error;
          }
        }
      }
    }

    if (!this.options.generateAiReply
      || disposition.disposition !== "archived-isolated"
      || disposition.duplicate
      || disposition.postConsentPlan
      || event.messageType?.toLowerCase() !== "text"
      || !event.text?.trim()
      || event.consentAction
      || isConsentText(event.text)) {
      return;
    }
    try {
      const reply = await this.options.generateAiReply(event, disposition);
      if (!reply?.trim()) return;
      const sentMessageId = await this.sendText(event.externalUserId, event.openKfid, reply);
      await this.options.archiveOutbound({
        ...event,
        channelMessageId: sentMessageId,
        text: reply,
        messageType: "text"
      });
    } catch {
      this.logger.warn("[wecom-hr] AI reply was skipped; the inbound message remains archived");
    }
  }

  private async sendConsentMenu(
    externalUserId: string,
    openKfid: string,
    disposition: HrInboundDisposition
  ): Promise<void> {
    await this.sendMessage({
      touser: externalUserId,
      open_kfid: openKfid,
      ...consentMenuPayload(disposition)
    });
  }

  private async sendConsentMenuOnEvent(
    code: string,
    disposition: HrInboundDisposition
  ): Promise<void> {
    await this.callApi("/cgi-bin/kf/send_msg_on_event", () => ({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        ...consentMenuPayload(disposition)
      })
    }));
  }

  private sendMessage(payload: Record<string, unknown>): Promise<WecomApiResult> {
    return this.callApi("/cgi-bin/kf/send_msg", () => ({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }));
  }

  private async callApi(pathWithQuery: string, requestFactory: () => RequestInit): Promise<WecomApiResult> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const accessToken = await this.getAccessToken(attempt > 0);
      const url = new URL(pathWithQuery, `${this.apiBaseUrl}/`);
      url.searchParams.set("access_token", accessToken);
      const result = await this.fetchJson(url, requestFactory(), "WeChat Customer Service API request failed");
      const errorCode = Number(result.errcode ?? 0);
      if (attempt === 0 && isAccessTokenError(errorCode)) {
        this.tokenCache = undefined;
        continue;
      }
      assertApiSuccess(result);
      this.lastError = undefined;
      return result;
    }
    throw new WecomAdapterError("Unable to refresh the WeChat Customer Service access token", "API");
  }

  private async getAccessToken(forceRefresh = false): Promise<string> {
    const credentials = await this.options.store.readApiCredentials();
    const fingerprint = crypto.createHash("sha256")
      .update(credentials.corpId)
      .update("\0")
      .update(credentials.secret)
      .digest("hex");
    if (!forceRefresh && this.tokenCache?.fingerprint === fingerprint && this.tokenCache.expiresAt > this.now()) {
      return this.tokenCache.token;
    }
    const url = new URL("/cgi-bin/gettoken", `${this.apiBaseUrl}/`);
    url.searchParams.set("corpid", credentials.corpId);
    url.searchParams.set("corpsecret", credentials.secret);
    const result = await this.fetchJson(url, { method: "GET" }, "Unable to obtain the WeChat Customer Service access token");
    assertApiSuccess(result);
    const token = requiredApiString(result, "access_token");
    const expiresIn = Number(result.expires_in);
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new WecomAdapterError("WeChat Customer Service returned an invalid access token lifetime", "PROTOCOL");
    }
    this.tokenCache = {
      fingerprint,
      token,
      expiresAt: this.now() + Math.max(1, expiresIn - ACCESS_TOKEN_SKEW_SECONDS) * 1_000
    };
    return token;
  }

  private async fetchJson(url: URL, init: RequestInit, failureMessage: string): Promise<WecomApiResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, signal: init.signal ?? AbortSignal.timeout(10_000) });
    } catch {
      throw new WecomAdapterError(failureMessage, "API");
    }
    if (!response.ok) {
      throw new WecomAdapterError(`${failureMessage} (HTTP ${response.status})`, "API");
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new WecomAdapterError("WeChat Customer Service returned invalid JSON", "PROTOCOL");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new WecomAdapterError("WeChat Customer Service returned an invalid response", "PROTOCOL");
    }
    return parsed as WecomApiResult;
  }
}

export function stableContactScene(stableId: string): string {
  const digest = crypto.createHash("sha256").update(stableId).digest("hex");
  return `hr_${digest.slice(0, 29)}`;
}

export function callbackQueryFromUrl(url: URL): WecomCallbackQuery {
  return {
    msgSignature: url.searchParams.get("msg_signature") ?? "",
    timestamp: url.searchParams.get("timestamp") ?? "",
    nonce: url.searchParams.get("nonce") ?? ""
  };
}

function decryptWecomPayload(encrypted: string, encodingAesKey: string): { message: string; receiveId: string } {
  let key: Buffer;
  try {
    key = Buffer.from(`${encodingAesKey}=`, "base64");
  } catch {
    throw new WecomAdapterError("Callback EncodingAESKey is invalid", "NOT_CONFIGURED");
  }
  if (key.length !== 32) throw new WecomAdapterError("Callback EncodingAESKey is invalid", "NOT_CONFIGURED");
  let padded: Buffer;
  try {
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
    decipher.setAutoPadding(false);
    padded = Buffer.concat([decipher.update(encrypted, "base64"), decipher.final()]);
  } catch {
    throw new WecomAdapterError("Callback ciphertext is invalid", "AUTH");
  }
  const plain = removePkcs7Padding(padded);
  if (plain.length < 20) throw new WecomAdapterError("Callback plaintext is invalid", "AUTH");
  const messageLength = plain.readUInt32BE(16);
  const messageEnd = 20 + messageLength;
  if (messageEnd > plain.length) throw new WecomAdapterError("Callback plaintext length is invalid", "AUTH");
  return {
    message: plain.subarray(20, messageEnd).toString("utf8"),
    receiveId: plain.subarray(messageEnd).toString("utf8")
  };
}

function removePkcs7Padding(value: Buffer): Buffer {
  if (!value.length) throw new WecomAdapterError("Callback padding is invalid", "AUTH");
  const padding = value[value.length - 1];
  if (padding < 1 || padding > 32 || padding > value.length) {
    throw new WecomAdapterError("Callback padding is invalid", "AUTH");
  }
  for (let index = value.length - padding; index < value.length; index += 1) {
    if (value[index] !== padding) throw new WecomAdapterError("Callback padding is invalid", "AUTH");
  }
  return value.subarray(0, value.length - padding);
}

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  processEntities: false
});

function parseXmlRoot(xml: string): Record<string, unknown> {
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) {
    throw new WecomAdapterError("Callback XML declarations are not allowed", "PROTOCOL");
  }
  let parsed: unknown;
  try {
    parsed = xmlParser.parse(xml);
  } catch {
    throw new WecomAdapterError("Callback XML is invalid", "PROTOCOL");
  }
  const root = asRecord(asRecord(parsed).xml);
  if (!Object.keys(root).length) throw new WecomAdapterError("Callback XML root is invalid", "PROTOCOL");
  return root;
}

function requiredXmlString(value: Record<string, unknown>, key: string): string {
  const result = optionalApiString(value[key]);
  if (!result) throw new WecomAdapterError(`Callback field ${key} is required`, "PROTOCOL");
  return result;
}

function assertApiSuccess(result: WecomApiResult): void {
  const errorCode = Number(result.errcode ?? 0);
  if (errorCode === 0) return;
  const detail = typeof result.errmsg === "string" && result.errmsg.trim() ? `: ${result.errmsg.trim().slice(0, 300)}` : "";
  throw new WecomAdapterError(`WeChat Customer Service API error ${errorCode}${detail}`, "API", errorCode);
}

function isAccessTokenError(code: number): boolean {
  return code === 40001 || code === 40014 || code === 42001;
}

function requiredApiString(value: Record<string, unknown>, key: string): string {
  const result = optionalApiString(value[key]);
  if (!result) throw new WecomAdapterError(`WeChat Customer Service response field ${key} is required`, "PROTOCOL");
  return result;
}

function optionalApiString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim();
  return clean || undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeTextEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalizeScene(scene: string): string {
  const clean = scene.trim();
  if (!/^[0-9a-zA-Z_-]{1,32}$/u.test(clean)) {
    throw new WecomAdapterError("Contact scene must contain 1-32 letters, digits, underscores or hyphens", "PROTOCOL");
  }
  return clean;
}

function validateOfficialContactUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WecomAdapterError("WeChat Customer Service returned an invalid contact URL", "PROTOCOL");
  }
  if (url.protocol !== "https:" || url.hostname !== "work.weixin.qq.com" || !/^\/kf\/[^/]+\/?$/u.test(url.pathname)) {
    throw new WecomAdapterError("WeChat Customer Service returned a non-official contact URL", "PROTOCOL");
  }
}

function consentMenuPayload(disposition: HrInboundDisposition): Record<string, unknown> {
  const plan = disposition.consentPlan;
  if (!plan) throw new WecomAdapterError("Consent menu plan is missing", "PROTOCOL");
  return {
    msgtype: "msgmenu",
    msgmenu: {
      head_content: requireUtf8Within(plan.text, 1_024, "AI disclosure"),
      list: plan.menu.map((item) => ({
        type: "click",
        click: {
          id: requireUtf8Within(item.id, 128, "Consent menu ID"),
          content: requireUtf8Within(item.label, 128, "Consent menu label")
        }
      }))
    }
  };
}

function menuConsentAction(message: Record<string, unknown>): "accept" | "decline" | undefined {
  const menuId = optionalApiString(asRecord(message.text).menu_id);
  if (menuId === "consent:accept") return "accept";
  if (menuId === "consent:decline") return "decline";
  return undefined;
}

function isEnterSessionMessage(message: Record<string, unknown>): boolean {
  return optionalApiString(message.msgtype) === "event"
    && optionalApiString(asRecord(message.event).event_type) === "enter_session";
}

function isConsentText(value: string): boolean {
  const normalized = value.trim().replace(/\s+/gu, "");
  return normalized === "同意并获取简历"
    || normalized === "暂不同意"
    || normalized === "不同意"
    || normalized === "consent:accept"
    || normalized === "consent:decline";
}

function syncedMessageText(message: Record<string, unknown>, messageType: string): string {
  if (messageType === "text") return optionalApiString(asRecord(message.text).content) ?? "";
  if (messageType === "link") {
    const link = asRecord(message.link);
    return [link.title, link.desc, link.url].map(optionalApiString).filter(Boolean).join("\n");
  }
  if (messageType === "location") {
    const location = asRecord(message.location);
    return [location.name, location.address].map(optionalApiString).filter(Boolean).join(" · ");
  }
  if (messageType === "business_card") {
    return optionalApiString(asRecord(message.business_card).userid) ?? "";
  }
  if (messageType === "miniprogram") {
    return optionalApiString(asRecord(message.miniprogram).title) ?? "";
  }
  return "";
}

function syncedAttachments(message: Record<string, unknown>, messageType: string): HrArchivedAttachment[] {
  if (!["image", "voice", "video", "file"].includes(messageType)) return [];
  const payload = asRecord(message[messageType]);
  return [{
    type: messageType === "voice" ? "audio" : messageType as HrArchivedAttachment["type"],
    ...(optionalApiString(payload.filename) ? { name: optionalApiString(payload.filename) } : {})
  }];
}

function syncedTimestamp(value: unknown): string | undefined {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  const timestamp = new Date(seconds * 1_000);
  return Number.isNaN(timestamp.getTime()) ? undefined : timestamp.toISOString();
}

function requireUtf8Within(value: string, maxBytes: number, field: string): string {
  const clean = value.trim();
  if (!clean) throw new WecomAdapterError(`${field} is empty`, "PROTOCOL");
  if (Buffer.byteLength(clean, "utf8") > maxBytes) {
    throw new WecomAdapterError(`${field} exceeds ${maxBytes} UTF-8 bytes`, "PROTOCOL");
  }
  return clean;
}

function fileName(filePath: string): string {
  return filePath.replace(/^.*[\\/]/u, "") || "material";
}

function mediaMimeType(type: "image" | "voice" | "video"): string {
  if (type === "image") return "image/jpeg";
  if (type === "voice") return "audio/mpeg";
  return "video/mp4";
}

function safeErrorDetail(error: unknown): string {
  if (error instanceof WecomAdapterError) return error.message;
  if (error instanceof HrStoreError) return error.message;
  return "微信客服适配器发生未预期错误";
}
