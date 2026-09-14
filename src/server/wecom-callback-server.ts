import http, { type IncomingMessage, type ServerResponse } from "node:http";

import { HrStoreError } from "../state/hr.js";
import type { HrService } from "./hr-service.js";
import { callbackQueryFromUrl, WecomAdapterError } from "./wecom-customer-service-adapter.js";

const MAX_CALLBACK_BODY_BYTES = 256 * 1024;

export type WecomCallbackServerOptions = {
  hrService: HrService;
  port?: number;
  host?: string;
};

export type WecomCallbackServer = {
  url: string;
  close: () => Promise<void>;
};

/** A dedicated loopback listener intended to sit behind a public HTTPS reverse proxy. */
export async function startWecomCallbackServer(options: WecomCallbackServerOptions): Promise<WecomCallbackServer> {
  const host = options.host?.trim() || "127.0.0.1";
  const server = http.createServer((request, response) => {
    void handleCallbackRequest(request, response, options.hrService).catch((error: unknown) => {
      const { status, message } = publicError(error);
      sendText(response, status, message);
    });
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8788, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to determine WeCom callback server address");
  const printableHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return {
    url: `http://${printableHost}:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

async function handleCallbackRequest(
  request: IncomingMessage,
  response: ServerResponse,
  hrService: HrService
): Promise<void> {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  const url = new URL(request.url ?? "/", "http://wecom-callback.local");
  if (!hrService.matchesPublicCallback(url.pathname)) {
    sendText(response, 404, "not found");
    return;
  }
  const method = request.method ?? "GET";
  const query = callbackQueryFromUrl(url);
  if (method === "GET") {
    const echoString = url.searchParams.get("echostr") ?? "";
    const plaintext = await hrService.verifyPublicCallback(query, echoString);
    sendText(response, 200, plaintext);
    return;
  }
  if (method === "POST") {
    const encryptedXml = await readBody(request, MAX_CALLBACK_BODY_BYTES);
    // acceptPublicCallback authenticates/decrypts synchronously and only queues the API sync work.
    await hrService.acceptPublicCallback(query, encryptedXml);
    sendText(response, 200, "success");
    return;
  }
  response.setHeader("Allow", "GET, POST");
  sendText(response, 405, "method not allowed");
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const contentLength = Number(request.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new WecomAdapterError("Callback body is too large", "PROTOCOL");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new WecomAdapterError("Callback body is too large", "PROTOCOL");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function publicError(error: unknown): { status: number; message: string } {
  if (error instanceof WecomAdapterError) {
    if (error.code === "AUTH") return { status: 403, message: "invalid callback signature" };
    if (error.code === "PROTOCOL") return { status: 400, message: "invalid callback payload" };
    if (error.code === "NOT_CONFIGURED") return { status: 503, message: "callback unavailable" };
    return { status: 502, message: "provider request failed" };
  }
  if (error instanceof HrStoreError && error.code === "NOT_CONFIGURED") {
    return { status: 503, message: "callback unavailable" };
  }
  return { status: 500, message: "callback processing failed" };
}

function sendText(response: ServerResponse, status: number, value: string): void {
  if (response.headersSent) return;
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end(value);
}
