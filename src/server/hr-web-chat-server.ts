import crypto from "node:crypto";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  HR_WEB_SESSION_DEFAULT_TTL_MS,
  HrWebStore,
  HrWebStoreError,
  type HrWebSession
} from "./hr-web-store.js";
import type { HrWebProjectCard } from "./hr-project-catalog.js";

const DEFAULT_PORT = 8789;
const MAX_BODY_BYTES = 16 * 1024;
const SESSION_COOKIE = "hr_web_session";
const CSRF_COOKIE = "hr_web_csrf";
const DEFAULT_POLL_LIMIT = 100;
const MAX_POLL_LIMIT = 100;
const DEFAULT_WEB_ROOT = fileURLToPath(new URL("../web-chat", import.meta.url));

const createSessionSchema = z.object({
  entryToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u)
}).strict();
const consentSchema = z.object({
  action: z.enum(["accept", "decline", "withdraw"]),
  disclosureVersion: z.string().min(1).max(128)
}).strict();
const messageSchema = z.object({
  clientMessageId: z.string().uuid(),
  text: z.string().trim().min(1).max(6_000)
}).strict();
const projectSelectionSchema = z.object({
  projectId: z.string().regex(/^[a-z0-9-]{1,64}$/u)
}).strict();

export type HrWebChatContext = {
  sessionId: string;
  visitorId?: string;
};

export type HrWebChatMessage = {
  id: string;
  role: "visitor" | "assistant";
  text: string;
  createdAt: string;
  kind?: "project-menu";
};

export type HrWebChatSessionState = {
  consentStatus: "pending" | "accepted" | "declined";
  disclosure: string;
  disclosureVersion: string;
  intro?: string;
  resumeAvailable: boolean;
  visitorId?: string;
};

export type HrWebChatMessagePage = {
  messages: HrWebChatMessage[];
  cursor?: string;
  projectOptions?: HrWebProjectCard[];
};

export type HrWebChatProjectSelection = {
  project: HrWebProjectCard;
  message: HrWebChatMessage;
  visitorId?: string;
};

export type HrWebChatSubmitResult = {
  acceptedMessageId: string;
  replyStatus: "pending" | "sent" | "unavailable";
  visitorId?: string;
};

export type HrWebChatResume = {
  path: string;
  name: string;
};

/**
 * This is the complete boundary between the public HTTP surface and HR data.
 * Implementations must scope every operation to the supplied session/visitor and
 * must never return management settings, opportunity IDs, secrets, or local paths
 * except for getResume(), whose path is consumed only by this server.
 */
export interface HrWebChatBackend {
  getSessionState(context: HrWebChatContext): Promise<HrWebChatSessionState>;
  setConsent(
    context: HrWebChatContext,
    input: { action: "accept" | "decline" | "withdraw"; disclosureVersion: string }
  ): Promise<HrWebChatSessionState>;
  listMessages(
    context: HrWebChatContext,
    input: { after?: string; limit: number }
  ): Promise<HrWebChatMessagePage>;
  submitMessage(
    context: HrWebChatContext,
    input: { clientMessageId: string; text: string }
  ): Promise<HrWebChatSubmitResult>;
  selectProject(
    context: HrWebChatContext,
    input: { projectId: string }
  ): Promise<HrWebChatProjectSelection>;
  getResume(context: HrWebChatContext): Promise<HrWebChatResume>;
}

export type HrWebChatServerOptions = {
  store: HrWebStore;
  backend: HrWebChatBackend;
  port?: number;
  host?: string;
  webRoot?: string;
  sessionTtlMs?: number;
  rateLimits?: Partial<{
    requestsPerMinute: number;
    sessionsPerTenMinutes: number;
    messagesPerMinute: number;
  }>;
  onError?: (error: unknown) => void;
};

export type HrWebChatServer = {
  listenerUrl: string;
  entryUrl: string;
  getEntryUrl: () => string;
  close: () => Promise<void>;
};

export class HrWebChatPublicError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 428 | 429 | 503,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "HrWebChatPublicError";
  }
}

export async function startHrWebChatServer(options: HrWebChatServerOptions): Promise<HrWebChatServer> {
  const host = options.host?.trim() || "0.0.0.0";
  const webRoot = path.resolve(options.webRoot ?? DEFAULT_WEB_ROOT);
  const limits = {
    requestsPerMinute: positiveLimit(options.rateLimits?.requestsPerMinute, 240),
    sessionsPerTenMinutes: positiveLimit(options.rateLimits?.sessionsPerTenMinutes, 10),
    messagesPerMinute: positiveLimit(options.rateLimits?.messagesPerMinute, 12)
  };
  const generalLimiter = new FixedWindowLimiter(60_000, limits.requestsPerMinute);
  const sessionCreationLimiter = new FixedWindowLimiter(10 * 60_000, limits.sessionsPerTenMinutes);
  const messageLimiter = new FixedWindowLimiter(60_000, limits.messagesPerMinute);
  let actualPort = options.port ?? DEFAULT_PORT;
  let fallbackOrigin = "";
  const server = http.createServer((request, response) => {
    void handleRequest(request, response, {
      ...options,
      host,
      webRoot,
      actualPort,
      fallbackOrigin,
      generalLimiter,
      sessionCreationLimiter,
      messageLimiter
    }).catch((error: unknown) => {
      options.onError?.(error);
      const mapped = publicError(error);
      sendJson(response, mapped.status, { error: mapped.message, code: mapped.code });
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? DEFAULT_PORT, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to determine HR web chat server address");
  actualPort = address.port;
  const listenerHost = wildcardHost(host) ? "127.0.0.1" : host;
  const listenerUrl = originFor(listenerHost, actualPort, "http:");
  fallbackOrigin = originFor(advertisedHost(host), actualPort, "http:");
  const getEntryUrl = () => {
    const settings = options.store.getSettings();
    return `${settings.publicBaseUrl ?? fallbackOrigin}/e/${encodeURIComponent(settings.entryToken)}`;
  };
  return {
    listenerUrl,
    get entryUrl() { return getEntryUrl(); },
    getEntryUrl,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

type RequestContext = HrWebChatServerOptions & {
  host: string;
  webRoot: string;
  actualPort: number;
  fallbackOrigin: string;
  generalLimiter: FixedWindowLimiter;
  sessionCreationLimiter: FixedWindowLimiter;
  messageLimiter: FixedWindowLimiter;
};

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext
): Promise<void> {
  const entryOrigin = context.store.getSettings().publicBaseUrl ?? context.fallbackOrigin;
  setSecurityHeaders(response, entryOrigin.startsWith("https://"));
  const clientKey = request.socket.remoteAddress ?? "unknown";
  requireRateLimit(context.generalLimiter, clientKey, response);
  if (!allowedHost(request.headers.host, entryOrigin, context.actualPort)) {
    throw new HrWebChatPublicError(403, "INVALID_HOST", "Request host is not allowed");
  }
  const url = new URL(request.url ?? "/", entryOrigin);
  const method = request.method ?? "GET";

  if (method === "GET" && url.pathname === "/healthz") {
    sendJson(response, 200, { ok: true });
    return;
  }
  const entryToken = matchEntryPath(url.pathname);
  if (method === "GET" && entryToken !== undefined) {
    const settings = context.store.getSettings();
    if (!settings.enabled || !safeTextEqual(entryToken, settings.entryToken)) {
      throw new HrWebChatPublicError(404, "NOT_FOUND", "Not found");
    }
    serveStatic(response, context.webRoot, "index.html", "text/html; charset=utf-8");
    return;
  }
  if (method === "GET" && url.pathname === "/chat") {
    serveStatic(response, context.webRoot, "index.html", "text/html; charset=utf-8");
    return;
  }
  if (method === "GET" && url.pathname === "/chat/app.js") {
    serveStatic(response, context.webRoot, "app.js", "text/javascript; charset=utf-8");
    return;
  }
  if (method === "GET" && url.pathname === "/chat/styles.css") {
    serveStatic(response, context.webRoot, "styles.css", "text/css; charset=utf-8");
    return;
  }

  if (method === "POST" && url.pathname === "/api/public/sessions") {
    requireOrigin(request, entryOrigin);
    requireRateLimit(context.sessionCreationLimiter, clientKey, response);
    const body = createSessionSchema.parse(await readJsonBody(request));
    const created = context.store.createSession(body.entryToken, context.sessionTtlMs ?? HR_WEB_SESSION_DEFAULT_TTL_MS);
    setSessionCookies(response, created.sessionToken, created.csrfToken, created.session.expiresAt, entryOrigin);
    const state = await context.backend.getSessionState(sessionContext(created.session));
    bindReturnedVisitor(context.store, created.session, state.visitorId);
    sendJson(response, 201, { session: publicState(context.store, state) });
    return;
  }

  if (!url.pathname.startsWith("/api/public/session")) {
    throw new HrWebChatPublicError(404, "NOT_FOUND", "Not found");
  }
  const session = authenticateRequest(request, context.store);

  if (method === "GET" && url.pathname === "/api/public/session") {
    ensureCsrfCookie(request, response, context.store, session, entryOrigin);
    const state = await context.backend.getSessionState(sessionContext(session));
    bindReturnedVisitor(context.store, session, state.visitorId);
    sendJson(response, 200, { session: publicState(context.store, state) });
    return;
  }
  if (method === "POST" && url.pathname === "/api/public/session/consent") {
    requireMutationProtection(request, context.store, session, entryOrigin);
    const body = consentSchema.parse(await readJsonBody(request));
    const state = await context.backend.setConsent(sessionContext(session), body);
    bindReturnedVisitor(context.store, session, state.visitorId);
    sendJson(response, 200, { session: publicState(context.store, state) });
    return;
  }
  if (method === "GET" && url.pathname === "/api/public/session/messages") {
    await requireAccepted(context.backend, session);
    const after = cleanCursor(url.searchParams.get("after"));
    const limit = parseLimit(url.searchParams.get("limit"));
    const page = await context.backend.listMessages(sessionContext(session), { after, limit });
    sendJson(response, 200, publicMessagePage(page));
    return;
  }
  if (method === "POST" && url.pathname === "/api/public/session/messages") {
    requireMutationProtection(request, context.store, session, entryOrigin);
    await requireAccepted(context.backend, session);
    requireRateLimit(context.messageLimiter, session.id, response);
    const body = messageSchema.parse(await readJsonBody(request));
    const result = await context.backend.submitMessage(sessionContext(session), body);
    bindReturnedVisitor(context.store, session, result.visitorId);
    sendJson(response, 201, {
      acceptedMessageId: requiredBackendText(result.acceptedMessageId, 256),
      replyStatus: result.replyStatus === "sent"
        ? "sent"
        : result.replyStatus === "pending" ? "pending" : "unavailable"
    });
    return;
  }
  if (method === "POST" && url.pathname === "/api/public/session/projects") {
    requireMutationProtection(request, context.store, session, entryOrigin);
    await requireAccepted(context.backend, session);
    requireRateLimit(context.messageLimiter, session.id, response);
    const body = projectSelectionSchema.parse(await readJsonBody(request));
    const result = await context.backend.selectProject(sessionContext(session), body);
    bindReturnedVisitor(context.store, session, result.visitorId);
    sendJson(response, 201, {
      project: publicProject(result.project),
      message: publicMessage(result.message)
    });
    return;
  }
  if ((method === "GET" || method === "HEAD") && url.pathname === "/api/public/session/resume") {
    const state = await context.backend.getSessionState(sessionContext(session));
    if (state.consentStatus !== "accepted") {
      throw new HrWebChatPublicError(428, "CONSENT_REQUIRED", "Consent is required before downloading the resume");
    }
    const resume = await context.backend.getResume(sessionContext(session));
    serveResume(response, resume, method === "HEAD");
    return;
  }
  throw new HrWebChatPublicError(404, "NOT_FOUND", "Not found");
}

function publicState(store: HrWebStore, state: HrWebChatSessionState): Omit<HrWebChatSessionState, "visitorId"> & {
  candidateName?: string;
} {
  if (!["pending", "accepted", "declined"].includes(state.consentStatus)) {
    throw new Error("Backend returned an invalid consent state");
  }
  const candidateName = store.getSettings().candidateName;
  return {
    consentStatus: state.consentStatus,
    disclosure: requiredBackendText(state.disclosure, 2_000),
    disclosureVersion: requiredBackendText(state.disclosureVersion, 128),
    ...(state.intro ? { intro: requiredBackendText(state.intro, 10_000) } : {}),
    resumeAvailable: state.resumeAvailable === true,
    ...(candidateName ? { candidateName } : {})
  };
}

async function requireAccepted(backend: HrWebChatBackend, session: HrWebSession): Promise<void> {
  const state = await backend.getSessionState(sessionContext(session));
  if (state.consentStatus !== "accepted") {
    throw new HrWebChatPublicError(428, "CONSENT_REQUIRED", "Consent is required before using chat");
  }
}

function publicMessagePage(page: HrWebChatMessagePage): HrWebChatMessagePage {
  if (!page || !Array.isArray(page.messages) || page.messages.length > MAX_POLL_LIMIT) {
    throw new Error("Backend returned an invalid message page");
  }
  if (page.projectOptions !== undefined
    && (!Array.isArray(page.projectOptions) || page.projectOptions.length > 12)) {
    throw new Error("Backend returned an invalid project list");
  }
  return {
    messages: page.messages.map((message) => {
      return publicMessage(message);
    }),
    ...(page.cursor ? { cursor: requiredBackendText(page.cursor, 256) } : {}),
    ...(page.projectOptions
      ? { projectOptions: page.projectOptions.map(publicProject) }
      : {})
  };
}

function publicMessage(message: HrWebChatMessage): HrWebChatMessage {
  if (!message || (message.role !== "visitor" && message.role !== "assistant")
    || !Number.isFinite(Date.parse(message.createdAt))
    || (message.kind !== undefined
      && (message.kind !== "project-menu" || message.role !== "assistant"))) {
    throw new Error("Backend returned an invalid message");
  }
  return {
    id: requiredBackendText(message.id, 256),
    role: message.role,
    text: requiredBackendText(message.text, 20_000, true),
    createdAt: message.createdAt,
    ...(message.kind ? { kind: message.kind } : {})
  };
}

function publicProject(project: HrWebProjectCard): HrWebProjectCard {
  if (!project || !/^[a-z0-9-]{1,64}$/u.test(project.id)) {
    throw new Error("Backend returned an invalid project");
  }
  return {
    id: project.id,
    title: requiredBackendText(project.title, 200),
    category: requiredBackendText(project.category, 80),
    summary: requiredBackendText(project.summary, 500),
    ...(project.dateLabel ? { dateLabel: requiredBackendText(project.dateLabel, 120) } : {}),
    ...(project.statusLabel ? { statusLabel: requiredBackendText(project.statusLabel, 120) } : {})
  };
}

function requiredBackendText(value: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value) || value.length > max || /[\0]/u.test(value)) {
    throw new Error("Backend returned invalid public data");
  }
  return value;
}

function bindReturnedVisitor(store: HrWebStore, session: HrWebSession, visitorId: string | undefined): void {
  if (visitorId) store.bindVisitor(session.id, visitorId);
}

function sessionContext(session: HrWebSession): HrWebChatContext {
  return { sessionId: session.id, ...(session.visitorId ? { visitorId: session.visitorId } : {}) };
}

function authenticateRequest(request: IncomingMessage, store: HrWebStore): HrWebSession {
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  if (!token) throw new HrWebChatPublicError(401, "SESSION_REQUIRED", "Web chat session is required");
  return store.authenticateSession(token);
}

function requireMutationProtection(
  request: IncomingMessage,
  store: HrWebStore,
  session: HrWebSession,
  entryOrigin: string
): void {
  requireOrigin(request, entryOrigin);
  if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    throw new HrWebChatPublicError(400, "JSON_REQUIRED", "JSON request body is required");
  }
  const cookies = parseCookies(request.headers.cookie);
  const cookieToken = cookies[CSRF_COOKIE];
  const header = request.headers["x-hr-web-csrf"];
  const headerToken = Array.isArray(header) ? "" : String(header ?? "");
  if (!cookieToken || !safeTextEqual(cookieToken, headerToken)) {
    throw new HrWebChatPublicError(403, "CSRF_INVALID", "CSRF validation failed");
  }
  store.verifyCsrf(session.id, headerToken);
}

function ensureCsrfCookie(
  request: IncomingMessage,
  response: ServerResponse,
  store: HrWebStore,
  session: HrWebSession,
  entryOrigin: string
): void {
  const csrfToken = parseCookies(request.headers.cookie)[CSRF_COOKIE];
  try {
    if (csrfToken) {
      store.verifyCsrf(session.id, csrfToken);
      return;
    }
  } catch {
    // A missing/stale readable CSRF cookie can be safely rotated after session authentication.
  }
  const replacement = store.rotateCsrfToken(session.id);
  appendCookie(response, cookieHeader(CSRF_COOKIE, replacement, session.expiresAt, false, entryOrigin));
}

function setSessionCookies(
  response: ServerResponse,
  sessionToken: string,
  csrfToken: string,
  expiresAt: string,
  entryOrigin: string
): void {
  response.setHeader("Set-Cookie", [
    cookieHeader(SESSION_COOKIE, sessionToken, expiresAt, true, entryOrigin),
    cookieHeader(CSRF_COOKIE, csrfToken, expiresAt, false, entryOrigin)
  ]);
}

function cookieHeader(name: string, value: string, expiresAt: string, httpOnly: boolean, entryOrigin: string): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "SameSite=Lax",
    `Expires=${new Date(expiresAt).toUTCString()}`,
    ...(entryOrigin.startsWith("https://") ? ["Secure"] : []),
    ...(httpOnly ? ["HttpOnly"] : [])
  ].join("; ");
}

function appendCookie(response: ServerResponse, value: string): void {
  const current = response.getHeader("Set-Cookie");
  const values = current === undefined ? [] : Array.isArray(current) ? current.map(String) : [String(current)];
  response.setHeader("Set-Cookie", [...values, value]);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const values: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    if (name !== SESSION_COOKIE && name !== CSRF_COOKIE) continue;
    try {
      values[name] = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      // Ignore malformed cookie values.
    }
  }
  return values;
}

function requireOrigin(request: IncomingMessage, expectedOrigin: string): void {
  const origin = request.headers.origin;
  if (typeof origin !== "string" || origin !== expectedOrigin) {
    throw new HrWebChatPublicError(403, "ORIGIN_INVALID", "Request origin is not allowed");
  }
}

function allowedHost(host: string | undefined, entryOrigin: string, port: number): boolean {
  if (!host) return false;
  const expected = new URL(entryOrigin).host.toLowerCase();
  const normalized = host.toLowerCase();
  return normalized === expected || normalized === `127.0.0.1:${port}` || normalized === `localhost:${port}`;
}

function matchEntryPath(pathname: string): string | undefined {
  const match = /^\/e\/([A-Za-z0-9_-]{43})$/u.exec(pathname);
  return match ? match[1] : undefined;
}

function cleanCursor(value: string | null): string | undefined {
  if (value === null || value === "") return undefined;
  if (value.length > 256 || /[\r\n\0]/u.test(value)) {
    throw new HrWebChatPublicError(400, "CURSOR_INVALID", "Message cursor is invalid");
  }
  return value;
}

function parseLimit(value: string | null): number {
  if (value === null || value === "") return DEFAULT_POLL_LIMIT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_POLL_LIMIT) {
    throw new HrWebChatPublicError(400, "LIMIT_INVALID", "Message limit is invalid");
  }
  return limit;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentLength = Number(request.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new HrWebChatPublicError(400, "BODY_TOO_LARGE", "Request body is too large");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new HrWebChatPublicError(400, "BODY_TOO_LARGE", "Request body is too large");
    chunks.push(buffer);
  }
  if (!total) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HrWebChatPublicError(400, "JSON_INVALID", "Request body is invalid JSON");
  }
}

function serveStatic(response: ServerResponse, root: string, name: string, type: string): void {
  const filePath = path.join(root, name);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new HrWebChatPublicError(503, "ASSET_UNAVAILABLE", "Web chat assets are unavailable");
  }
  response.statusCode = 200;
  response.setHeader("Content-Type", type);
  response.end(fs.readFileSync(filePath));
}

function serveResume(response: ServerResponse, resume: HrWebChatResume, headOnly: boolean): void {
  const stat = fs.statSync(resume.path);
  if (!stat.isFile() || stat.size > 20 * 1024 * 1024) {
    throw new HrWebChatPublicError(404, "RESUME_UNAVAILABLE", "Resume is unavailable");
  }
  const name = safeFilename(resume.name);
  response.statusCode = 200;
  response.setHeader("Content-Type", "application/pdf");
  response.setHeader("Content-Length", String(stat.size));
  response.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  response.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
  if (headOnly) {
    response.end();
    return;
  }
  const stream = fs.createReadStream(resume.path);
  stream.once("error", (error) => response.destroy(error));
  stream.pipe(response);
}

function safeFilename(value: string): string {
  const normalized = value.replace(/[\r\n\0\\/]/gu, "_").trim().slice(0, 180);
  return normalized.toLowerCase().endsWith(".pdf") ? normalized : `${normalized || "resume"}.pdf`;
}

function setSecurityHeaders(response: ServerResponse, secure: boolean): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  );
  if (secure) response.setHeader("Strict-Transport-Security", "max-age=31536000");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(value)}\n`);
}

function publicError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof HrWebChatPublicError) return error;
  if (error instanceof HrWebStoreError) {
    if (error.code === "AUTH") return { status: 401, code: "SESSION_INVALID", message: "Web chat session is invalid" };
    if (error.code === "DISABLED") return { status: 503, code: "CHAT_DISABLED", message: "Web chat is unavailable" };
    if (error.code === "CAPACITY") return { status: 503, code: "CHAT_BUSY", message: "Web chat is busy" };
    if (error.code === "VALIDATION") return { status: 400, code: "REQUEST_INVALID", message: error.message };
  }
  if (error instanceof z.ZodError) return { status: 400, code: "REQUEST_INVALID", message: "Request payload is invalid" };
  return { status: 500, code: "INTERNAL_ERROR", message: "Web chat request failed" };
}

class FixedWindowLimiter {
  private readonly entries = new Map<string, { resetAt: number; count: number }>();

  constructor(private readonly windowMs: number, private readonly maximum: number) {}

  consume(key: string, now = Date.now()): number | undefined {
    const current = this.entries.get(key);
    if (!current || current.resetAt <= now) {
      this.entries.set(key, { resetAt: now + this.windowMs, count: 1 });
      this.prune(now);
      return undefined;
    }
    current.count += 1;
    if (current.count <= this.maximum) return undefined;
    return Math.max(1, Math.ceil((current.resetAt - now) / 1_000));
  }

  private prune(now: number): void {
    if (this.entries.size < 2_000) return;
    for (const [key, entry] of this.entries) if (entry.resetAt <= now) this.entries.delete(key);
  }
}

function requireRateLimit(limiter: FixedWindowLimiter, key: string, response: ServerResponse): void {
  const retryAfter = limiter.consume(key);
  if (retryAfter === undefined) return;
  response.setHeader("Retry-After", String(retryAfter));
  throw new HrWebChatPublicError(429, "RATE_LIMITED", "Too many requests");
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function safeTextEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && cryptoSafeEqual(leftBuffer, rightBuffer);
}

function cryptoSafeEqual(left: Buffer, right: Buffer): boolean {
  return crypto.timingSafeEqual(left, right);
}

function wildcardHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || host === "[::]";
}

function advertisedHost(host: string): string {
  if (!wildcardHost(host)) return host;
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const address of interfaces ?? []) {
      if (address.family === "IPv4" && !address.internal && isPrivateIpv4(address.address)) return address.address;
    }
  }
  return "127.0.0.1";
}

function isPrivateIpv4(value: string): boolean {
  const parts = value.split(".").map(Number);
  return parts[0] === 10 || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
}

function originFor(host: string, port: number, protocol: "http:" | "https:"): string {
  const formatted = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const defaultPort = (protocol === "http:" && port === 80) || (protocol === "https:" && port === 443);
  return `${protocol}//${formatted}${defaultPort ? "" : `:${port}`}`;
}

export const HR_WEB_SESSION_COOKIE = SESSION_COOKIE;
export const HR_WEB_CSRF_COOKIE = CSRF_COOKIE;
