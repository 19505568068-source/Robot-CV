import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { z } from "zod";

import { resolveCodexCommand } from "../codex/exec-runner.js";
import { HrAiStoreError } from "../state/hr-ai.js";
import { HrStoreError, type HrDraftType } from "../state/hr.js";
import type { StatePaths } from "../state/paths.js";
import type { HrAiService } from "./hr-ai-service.js";
import type { HrService } from "./hr-service.js";
import type { HrWebAdminService } from "./hr-web-admin-service.js";
import { WecomAdapterError } from "./wecom-customer-service-adapter.js";
import { createStartupService, type StartupService } from "./startup.js";
import type { UpdateService } from "./update-manager.js";

const startupSchema = z.object({
  enabled: z.boolean()
});
const hrSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  corpId: z.string().max(128).nullable().optional(),
  openKfid: z.string().max(256).nullable().optional(),
  openKfId: z.string().max(256).nullable().optional(),
  serviceLink: z.string().max(2_048).nullable().optional(),
  contactUrl: z.string().max(2_048).nullable().optional(),
  callbackPublicUrl: z.string().max(2_048).nullable().optional(),
  callbackUrl: z.string().max(2_048).nullable().optional(),
  secret: z.string().max(8_192).nullable().optional(),
  token: z.string().max(8_192).nullable().optional(),
  encodingAesKey: z.string().max(8_192).nullable().optional(),
  welcomeMessage: z.string().max(2_000).nullable().optional(),
  aiDisclosure: z.string().max(2_000).nullable().optional(),
  targetRoles: z.array(z.string().max(100)).max(50).optional(),
  profileKeywords: z.array(z.string().max(100)).max(100).optional()
}).refine((value) => Object.keys(value).length > 0, "HR settings update is empty");
const hrMaterialsSchema = z.object({
  disclosure: z.string().max(2_000).nullable().optional(),
  bio: z.string().max(10_000).nullable().optional(),
  resumePath: z.string().max(2_048).nullable().optional(),
  knowledgeBasePaths: z.array(z.string().max(2_048)).max(200).optional()
}).refine((value) => Object.keys(value).length > 0, "HR materials update is empty");
const hrDraftStatusSchema = z.object({
  status: z.enum(["reviewed", "approved", "rejected"])
});
const hrContactWaySchema = z.object({
  force: z.boolean().optional()
});
const hrAiSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  endpoint: z.string().max(2_048).nullable().optional(),
  model: z.string().max(200).nullable().optional(),
  apiKey: z.string().max(8_192).nullable().optional()
}).refine((value) => Object.keys(value).length > 0, "HR AI settings update is empty");
const hrWebSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  publicBaseUrl: z.string().max(2_048).nullable().optional(),
  candidateName: z.string().max(100).nullable().optional()
}).strict().refine((value) => Object.keys(value).length > 0, "HR web chat settings update is empty");
const webRoot = fileURLToPath(new URL("../web", import.meta.url));
const execFileAsync = promisify(execFile);

export type LocalHttpServerOptions = {
  paths: StatePaths;
  hrService?: HrService;
  hrAiService?: HrAiService;
  hrWebAdminService?: HrWebAdminService;
  productVersion?: string;
  port?: number;
  updateService?: UpdateService;
  startupService?: StartupService;
  onUpdateInstalled?: (version: string) => void;
};

export type LocalHttpServer = {
  url: string;
  requestToken: string;
  close: () => Promise<void>;
};

export async function startLocalHttpServer(options: LocalHttpServerOptions): Promise<LocalHttpServer> {
  const requestToken = crypto.randomBytes(24).toString("base64url");
  const productVersion = options.productVersion ?? readProductVersion();
  const startupService = options.startupService ?? createStartupService();
  let actualPort = options.port ?? 8787;
  const server = http.createServer((request, response) => {
    void handleRequest(request, response, {
      ...options,
      productVersion,
      requestToken,
      startupService,
      port: actualPort
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, errorStatus(error), {
        error: message
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8787, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine local server address");
  }
  actualPort = address.port;
  return {
    url: `http://127.0.0.1:${actualPort}`,
    requestToken,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

type HandlerContext = LocalHttpServerOptions & {
  productVersion: string;
  requestToken: string;
  startupService: StartupService;
  port: number;
};

async function handleRequest(request: IncomingMessage, response: ServerResponse, context: HandlerContext): Promise<void> {
  setSecurityHeaders(response);
  if (!isAllowedHost(request.headers.host, context.port)) {
    sendJson(response, 403, { error: "Local host required" });
    return;
  }
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  const method = request.method ?? "GET";
  if (isRetiredInHrOnlyMode(url.pathname)) {
    sendJson(response, 410, {
      error: "This API is unavailable in HR-only mode",
      code: "HR_ONLY"
    });
    return;
  }
  if (isMutation(method)) {
    if (!isAllowedOrigin(request.headers.origin, context.port)) {
      sendJson(response, 403, { error: "Local origin required" });
      return;
    }
    if (request.headers["x-codex-weixin-token"] !== context.requestToken) {
      sendJson(response, 403, { error: "Invalid request token" });
      return;
    }
  }

  if (method === "GET" && url.pathname === "/api/bootstrap") {
    const [startup, hrBase, hrWeb] = await Promise.all([
      context.startupService.getStartupStatus(),
      context.hrService?.getBootstrap(),
      context.hrWebAdminService?.getBootstrap()
    ]);
    const hr = hrBase ? {
      ...hrBase,
      ...(hrWeb ? { web: hrWeb, entry: hrWeb.entry } : {}),
      ...(context.hrAiService ? { ai: context.hrAiService.getBootstrap() } : {})
    } : undefined;
    sendJson(response, 200, {
      product: "微信扫码 HR ClawBot",
      version: context.productVersion,
      requestToken: context.requestToken,
      startup,
      accounts: [],
      sessions: [],
      ...(hr ? { hr } : {})
    });
    return;
  }
  if (method === "GET" && url.pathname === "/api/hr/bootstrap") {
    const [bootstrap, web] = await Promise.all([
      requireHrService(context).getBootstrap(),
      context.hrWebAdminService?.getBootstrap()
    ]);
    sendJson(response, 200, {
      ...bootstrap,
      ...(web ? { web, entry: web.entry } : {}),
      ...(context.hrAiService ? { ai: context.hrAiService.getBootstrap() } : {})
    });
    return;
  }
  if (method === "GET" && url.pathname === "/api/hr/web") {
    sendJson(response, 200, await requireHrWebAdminService(context).getBootstrap());
    return;
  }
  if (method === "PUT" && url.pathname === "/api/hr/web") {
    const body = hrWebSettingsSchema.parse(await readJsonBody(request));
    sendJson(response, 200, await requireHrWebAdminService(context).updateSettings(body));
    return;
  }
  if (method === "POST" && url.pathname === "/api/hr/web/rotate") {
    sendJson(response, 200, await requireHrWebAdminService(context).rotateEntry());
    return;
  }
  if (method === "GET" && url.pathname === "/api/hr/ai/settings") {
    sendJson(response, 200, requireHrAiService(context).getBootstrap());
    return;
  }
  if (method === "PUT" && url.pathname === "/api/hr/ai/settings") {
    const body = hrAiSettingsSchema.parse(await readJsonBody(request));
    sendJson(response, 200, await requireHrAiService(context).updateSettings(body));
    return;
  }
  if (method === "GET" && url.pathname === "/api/hr/settings") {
    const service = requireHrService(context);
    sendJson(response, 200, {
      settings: service.getSettings(),
      entry: await service.getEntry(),
      connection: service.getConnectionStatus()
    });
    return;
  }
  if (method === "PUT" && url.pathname === "/api/hr/settings") {
    const body = hrSettingsSchema.parse(await readJsonBody(request));
    const callbackPublicUrl = body.callbackPublicUrl !== undefined ? body.callbackPublicUrl : body.callbackUrl;
    const { callbackUrl: _callbackUrl, ...input } = body;
    sendJson(response, 200, await requireHrService(context).updateSettings({
      ...input,
      ...(callbackPublicUrl !== undefined ? { callbackPublicUrl } : {})
    }));
    return;
  }
  if (method === "POST" && url.pathname === "/api/hr/contact-way") {
    const body = hrContactWaySchema.parse(await readJsonBody(request));
    sendJson(response, 200, await requireHrService(context).ensureContactWay(body.force === true));
    return;
  }
  if (method === "GET" && url.pathname === "/api/hr/materials") {
    sendJson(response, 200, { materials: requireHrService(context).getMaterials() });
    return;
  }
  if (method === "PUT" && url.pathname === "/api/hr/materials") {
    const body = hrMaterialsSchema.parse(await readJsonBody(request));
    sendJson(response, 200, { materials: await requireHrService(context).updateMaterials(body) });
    return;
  }
  const hrMaterialUploadMatch = matchPath(url.pathname, "/api/hr/materials/uploads/:kind");
  if (method === "POST" && hrMaterialUploadMatch) {
    const kind = hrMaterialUploadMatch.kind;
    if (kind !== "resume" && kind !== "knowledge") {
      throw new HrStoreError("Invalid HR material upload kind", "VALIDATION");
    }
    const data = await readBodyBuffer(request, 20 * 1024 * 1024, "Uploaded file exceeds the allowed size");
    const result = await requireHrService(context).uploadMaterial({
      kind,
      fileName: readEncodedUploadFileName(request),
      contentType: singleHeader(request.headers["content-type"], "Content-Type"),
      data
    });
    sendJson(response, 201, result);
    return;
  }
  const hrResumeMatch = matchPath(url.pathname, "/api/hr/materials/resumes/:id");
  if ((method === "GET" || method === "HEAD") && hrResumeMatch) {
    const resume = requireHrService(context).getResumeFile(hrResumeMatch.id);
    serveHrResume(response, resume, method === "HEAD");
    return;
  }
  if (method === "GET" && url.pathname === "/api/hr/opportunities") {
    sendJson(response, 200, { opportunities: requireHrService(context).listOpportunities() });
    return;
  }
  const hrOpportunityAction = matchPath(url.pathname, "/api/hr/opportunities/:id/actions/:action");
  if (method === "POST" && hrOpportunityAction) {
    const type = parseHrDraftType(hrOpportunityAction.action);
    const generation = context.hrAiService
      ? await context.hrAiService.generateDraft(hrOpportunityAction.id, type)
      : {
          draft: await requireHrService(context).generateDraft(hrOpportunityAction.id, type),
          generation: { mode: "local-template" as const, ai: false }
        };
    sendJson(response, 201, generation);
    return;
  }
  const hrOpportunityMatch = matchPath(url.pathname, "/api/hr/opportunities/:id");
  if (method === "GET" && hrOpportunityMatch) {
    const opportunity = requireHrService(context).getOpportunity(hrOpportunityMatch.id);
    sendJson(response, 200, {
      opportunity: context.hrAiService ? context.hrAiService.decorateOpportunity(opportunity) : opportunity
    });
    return;
  }
  const hrDraftMatch = matchPath(url.pathname, "/api/hr/drafts/:id");
  if (method === "PATCH" && hrDraftMatch) {
    const body = hrDraftStatusSchema.parse(await readJsonBody(request));
    const draft = context.hrAiService
      ? await context.hrAiService.setDraftStatus(hrDraftMatch.id, body.status)
      : await requireHrService(context).setDraftStatus(hrDraftMatch.id, body.status);
    sendJson(response, 200, { draft });
    return;
  }
  if (method === "GET" && url.pathname === "/api/startup") {
    sendJson(response, 200, context.startupService.getStartupStatus());
    return;
  }
  if (method === "POST" && url.pathname === "/api/startup") {
    const body = startupSchema.parse(await readJsonBody(request));
    sendJson(response, 200, await context.startupService.setStartupEnabled(body.enabled));
    return;
  }
  if (method === "GET" && !url.pathname.startsWith("/api/")) {
    serveStatic(response, url.pathname);
    return;
  }
  sendJson(response, 404, { error: "Not found" });
}

function readProductVersion(): string {
  try {
    const packageJson = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof packageJson.version === "string" ? packageJson.version : "unknown";
  } catch {
    return "unknown";
  }
}

function serveStatic(response: ServerResponse, pathname: string): void {
  const files: Record<string, { name: string; type: string }> = {
    "/": { name: "index.html", type: "text/html; charset=utf-8" },
    "/index.html": { name: "index.html", type: "text/html; charset=utf-8" },
    "/favicon.ico": { name: "favicon.svg", type: "image/svg+xml" },
    "/favicon.svg": { name: "favicon.svg", type: "image/svg+xml" },
    "/styles.css": { name: "styles.css", type: "text/css; charset=utf-8" },
    "/app.js": { name: "app.js", type: "text/javascript; charset=utf-8" },
    "/vendor/lucide.min.js": { name: "vendor/lucide.min.js", type: "text/javascript; charset=utf-8" },
    "/vendor/marked.umd.js": { name: "vendor/marked.umd.js", type: "text/javascript; charset=utf-8" },
    "/vendor/purify.min.js": { name: "vendor/purify.min.js", type: "text/javascript; charset=utf-8" }
  };
  const asset = files[pathname];
  if (!asset) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }
  const filePath = path.join(webRoot, asset.name);
  if (!fs.existsSync(filePath)) {
    sendJson(response, 503, { error: "Web assets are not built" });
    return;
  }
  response.statusCode = 200;
  response.setHeader("Content-Type", asset.type);
  response.end(fs.readFileSync(filePath));
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
}

function isAllowedHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function isMutation(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function isRetiredInHrOnlyMode(pathname: string): boolean {
  return ["/api/accounts", "/api/logins", "/api/sessions", "/api/config", "/api/api-profiles", "/api/update"]
    .some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function matchPath(pathname: string, pattern: string): Record<string, string> | undefined {
  const actual = pathname.split("/").filter(Boolean);
  const expected = pattern.split("/").filter(Boolean);
  if (actual.length !== expected.length) return undefined;
  const values: Record<string, string> = {};
  for (let index = 0; index < expected.length; index += 1) {
    const segment = expected[index];
    if (segment.startsWith(":")) {
      values[segment.slice(1)] = decodeURIComponent(actual[index]);
    } else if (segment !== actual[index]) {
      return undefined;
    }
  }
  return values;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const body = await readBodyBuffer(request, 1024 * 1024);
  if (!body.length) return {};
  return JSON.parse(body.toString("utf8"));
}

async function readBodyBuffer(request: IncomingMessage, maxBytes: number, limitMessage = "Request body is too large"): Promise<Buffer> {
  const contentLength = Number(request.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(limitMessage);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error(limitMessage);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function readEncodedUploadFileName(request: IncomingMessage): string {
  const encoded = singleHeader(request.headers["x-codex-weixin-filename"], "X-Codex-Weixin-Filename");
  if (encoded.length > 2_048) throw new Error("Uploaded file name is too long");
  try {
    return decodeURIComponent(encoded);
  } catch {
    throw new Error("Uploaded file name encoding is invalid");
  }
}

function singleHeader(value: string | string[] | undefined, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} header is required`);
  return value.trim();
}

function errorStatus(error: unknown): number {
  if (error instanceof HrAiStoreError) {
    if (error.code === "NOT_FOUND") return 404;
    if (error.code === "VALIDATION") return 400;
    if (error.code === "NOT_CONFIGURED") return 409;
    return 500;
  }
  if (error instanceof HrStoreError) {
    if (error.code === "NOT_FOUND") return 404;
    if (error.code === "VALIDATION") return 400;
    if (error.code === "NOT_CONFIGURED" || error.code === "CONFLICT") return 409;
    return 500;
  }
  if (error instanceof WecomAdapterError) {
    if (error.code === "AUTH") return 403;
    if (error.code === "NOT_CONFIGURED") return 409;
    if (error.code === "PROTOCOL") return 400;
    return 502;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/not found/i.test(message)) return 404;
  if (/already in progress|no newer/i.test(message)) return 409;
  if (/unable to verify|timed out/i.test(message)) return 503;
  return /required|invalid|allowed|empty|too large|too many|exceed/i.test(message) ? 400 : 500;
}

function requireHrService(context: HandlerContext): HrService {
  if (!context.hrService) throw new Error("HR service is unavailable");
  return context.hrService;
}

function requireHrAiService(context: HandlerContext): HrAiService {
  if (!context.hrAiService) throw new Error("HR AI service is unavailable");
  return context.hrAiService;
}

function requireHrWebAdminService(context: HandlerContext): HrWebAdminService {
  if (!context.hrWebAdminService) throw new Error("HR web chat service is unavailable");
  return context.hrWebAdminService;
}

function parseHrDraftType(value: string): HrDraftType {
  const aliases: Record<string, HrDraftType> = {
    "invitation-analysis": "invitation-analysis",
    "analyze-invitation": "invitation-analysis",
    "interview-advice": "interview-advice",
    interview: "interview-advice",
    "resume-improvements": "resume-improvements",
    resume: "resume-improvements",
    "follow-up": "follow-up"
  };
  const type = aliases[value.toLowerCase()];
  if (!type) throw new HrStoreError("Invalid HR draft action", "VALIDATION");
  return type;
}

function serveHrResume(response: ServerResponse, resume: { path: string; name: string }, headOnly: boolean): void {
  const stat = fs.statSync(resume.path);
  response.statusCode = 200;
  response.setHeader("Content-Type", "application/pdf");
  response.setHeader("Content-Length", String(stat.size));
  response.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(resume.name)}`);
  if (headOnly) {
    response.end();
    return;
  }
  const stream = fs.createReadStream(resume.path);
  stream.on("error", (error) => {
    if (!response.headersSent) sendJson(response, 500, { error: error.message });
    else response.destroy(error);
  });
  stream.pipe(response);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(value)}\n`);
}

export async function checkCodex(codexBin: string): Promise<{ ready: boolean; version?: string; error?: string }> {
  try {
    const command = resolveCodexCommand(codexBin);
    const result = await execFileAsync(command.command, [...command.argsPrefix, "--version"], {
      timeout: 5_000,
      windowsHide: true
    });
    return { ready: true, version: result.stdout.trim() || result.stderr.trim() || codexBin };
  } catch (error) {
    return { ready: false, error: error instanceof Error ? error.message : String(error) };
  }
}
