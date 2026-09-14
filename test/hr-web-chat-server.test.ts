import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  startHrWebChatServer,
  type HrWebChatBackend,
  type HrWebChatContext,
  type HrWebChatMessage,
  type HrWebChatSessionState
} from "../src/server/hr-web-chat-server.js";
import { HrWebStore } from "../src/server/hr-web-store.js";

test("exposes only the consent-gated cookie-authenticated public chat surface", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-hr-web-http-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const webRoot = path.join(root, "web");
  fs.mkdirSync(webRoot);
  fs.writeFileSync(path.join(webRoot, "index.html"), "<!doctype html><title>chat</title>");
  fs.writeFileSync(path.join(webRoot, "app.js"), "void 0;");
  fs.writeFileSync(path.join(webRoot, "styles.css"), "body{}");
  const resumePath = path.join(root, "resume.pdf");
  fs.writeFileSync(resumePath, "%PDF-1.4\ntest resume\n");

  const store = new HrWebStore(path.join(root, "hr-web.json"));
  store.updateSettings({ enabled: true, candidateName: "测试候选人" });
  const backend = new FakeBackend(resumePath);
  const server = await startHrWebChatServer({
    store,
    backend,
    host: "127.0.0.1",
    port: 0,
    webRoot,
    rateLimits: { messagesPerMinute: 2 }
  });
  t.after(() => server.close());
  const origin = new URL(server.entryUrl).origin;

  const entry = await fetch(server.entryUrl);
  assert.equal(entry.status, 200);
  assert.match(entry.headers.get("content-security-policy") ?? "", /default-src 'none'/u);
  assert.equal(entry.headers.get("referrer-policy"), "no-referrer");

  const createdResponse = await fetch(`${origin}/api/public/sessions`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ entryToken: store.getSettings().entryToken })
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json() as { session: HrWebChatSessionState & { candidateName?: string; visitorId?: string } };
  assert.equal(created.session.consentStatus, "pending");
  assert.equal(created.session.candidateName, "测试候选人");
  assert.equal(created.session.visitorId, undefined);
  const cookies = responseCookies(createdResponse);
  const sessionCookie = cookieValue(cookies, "hr_web_session");
  const csrfCookie = cookieValue(cookies, "hr_web_csrf");
  const cookieHeader = `hr_web_session=${sessionCookie}; hr_web_csrf=${csrfCookie}`;
  assert.ok(sessionCookie);
  assert.ok(csrfCookie);
  assert.match(cookies.find((cookie) => cookie.startsWith("hr_web_session=")) ?? "", /HttpOnly/u);

  const blockedResume = await fetch(`${origin}/api/public/session/resume`, {
    headers: { Cookie: cookieHeader }
  });
  assert.equal(blockedResume.status, 428);
  const blockedMessages = await fetch(`${origin}/api/public/session/messages`, {
    headers: { Cookie: cookieHeader }
  });
  assert.equal(blockedMessages.status, 428);

  const missingCsrf = await fetch(`${origin}/api/public/session/consent`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookieHeader },
    body: JSON.stringify({ action: "accept", disclosureVersion: "v1" })
  });
  assert.equal(missingCsrf.status, 403);

  const acceptedResponse = await fetch(`${origin}/api/public/session/consent`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      Cookie: cookieHeader,
      "X-HR-Web-CSRF": csrfCookie
    },
    body: JSON.stringify({ action: "accept", disclosureVersion: "v1" })
  });
  assert.equal(acceptedResponse.status, 200);
  assert.equal((await acceptedResponse.json() as { session: { consentStatus: string } }).session.consentStatus, "accepted");

  const sent = await fetch(`${origin}/api/public/session/messages`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      Cookie: cookieHeader,
      "X-HR-Web-CSRF": csrfCookie
    },
    body: JSON.stringify({ clientMessageId: crypto.randomUUID(), text: "请介绍一下项目经验" })
  });
  assert.equal(sent.status, 201);
  assert.equal((await sent.json() as { replyStatus: string }).replyStatus, "pending");
  const projectResponse = await fetch(`${origin}/api/public/session/projects`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      Cookie: cookieHeader,
      "X-HR-Web-CSRF": csrfCookie
    },
    body: JSON.stringify({ projectId: "red-infinity" })
  });
  assert.equal(projectResponse.status, 201);
  const projectPayload = await projectResponse.json() as {
    project: { id: string };
    message: HrWebChatMessage;
  };
  assert.equal(projectPayload.project.id, "red-infinity");
  assert.match(projectPayload.message.text, /欢迎直接提问/u);
  const rateLimited = await fetch(`${origin}/api/public/session/messages`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      Cookie: cookieHeader,
      "X-HR-Web-CSRF": csrfCookie
    },
    body: JSON.stringify({ clientMessageId: crypto.randomUUID(), text: "第二条消息" })
  });
  assert.equal(rateLimited.status, 429);
  assert.ok(Number(rateLimited.headers.get("retry-after")) >= 1);

  const messages = await fetch(`${origin}/api/public/session/messages?limit=100`, {
    headers: { Cookie: cookieHeader }
  });
  const messagePage = await messages.json() as { messages: HrWebChatMessage[] };
  assert.equal(messagePage.messages.some((message) => message.text.includes("项目经验")), true);
  assert.equal(messagePage.messages.some((message) => message.role === "assistant"), true);
  assert.equal(messagePage.messages.some((message) => message.kind === "project-menu"), true);

  const resume = await fetch(`${origin}/api/public/session/resume`, {
    headers: { Cookie: cookieHeader }
  });
  assert.equal(resume.status, 200);
  assert.equal(resume.headers.get("content-type"), "application/pdf");
  assert.match(resume.headers.get("content-disposition") ?? "", /^attachment;/u);
  assert.match(await resume.text(), /^%PDF-1\.4/u);

  const adminLeak = await fetch(`${origin}/api/hr/bootstrap`);
  assert.equal(adminLeak.status, 404);
});

test("rejects wrong origins and stops existing cookies as soon as the channel is disabled", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-hr-web-stop-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, value] of [["index.html", "chat"], ["app.js", ""], ["styles.css", ""]]) {
    fs.writeFileSync(path.join(root, name), value);
  }
  const resumePath = path.join(root, "resume.pdf");
  fs.writeFileSync(resumePath, "%PDF-1.4\n");
  const store = new HrWebStore(path.join(root, "hr-web.json"));
  store.updateSettings({ enabled: true });
  const server = await startHrWebChatServer({ store, backend: new FakeBackend(resumePath), host: "127.0.0.1", port: 0, webRoot: root });
  t.after(() => server.close());
  const origin = new URL(server.entryUrl).origin;

  const wrongOrigin = await fetch(`${origin}/api/public/sessions`, {
    method: "POST",
    headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
    body: JSON.stringify({ entryToken: store.getSettings().entryToken })
  });
  assert.equal(wrongOrigin.status, 403);

  const created = await fetch(`${origin}/api/public/sessions`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ entryToken: store.getSettings().entryToken })
  });
  const sessionCookie = cookieValue(responseCookies(created), "hr_web_session");
  store.updateSettings({ enabled: false });
  const stopped = await fetch(`${origin}/api/public/session`, {
    headers: { Cookie: `hr_web_session=${sessionCookie}` }
  });
  assert.equal(stopped.status, 503);
  assert.equal((await stopped.json() as { code: string }).code, "CHAT_DISABLED");
});

test("applies a public base URL update without restarting the listener", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-hr-web-hot-origin-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, value] of [["index.html", "chat"], ["app.js", ""], ["styles.css", ""]]) {
    fs.writeFileSync(path.join(root, name), value);
  }
  const resumePath = path.join(root, "resume.pdf");
  fs.writeFileSync(resumePath, "%PDF-1.4\n");
  const store = new HrWebStore(path.join(root, "hr-web.json"));
  store.updateSettings({ enabled: true });
  const server = await startHrWebChatServer({ store, backend: new FakeBackend(resumePath), host: "127.0.0.1", port: 0, webRoot: root });
  t.after(() => server.close());
  const listener = new URL(server.listenerUrl);
  const updatedOrigin = `http://localhost:${listener.port}`;
  store.updateSettings({ publicBaseUrl: updatedOrigin });
  assert.equal(new URL(server.getEntryUrl()).origin, updatedOrigin);

  const body = JSON.stringify({ entryToken: store.getSettings().entryToken });
  const response = await rawHttpRequest({
    hostname: listener.hostname,
    port: Number(listener.port),
    path: "/api/public/sessions",
    method: "POST",
    headers: {
      Host: `localhost:${listener.port}`,
      Origin: updatedOrigin,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body)
    }
  }, body);
  assert.equal(response.status, 201);
});

class FakeBackend implements HrWebChatBackend {
  private readonly states = new Map<string, HrWebChatSessionState>();
  private readonly messages = new Map<string, HrWebChatMessage[]>();

  constructor(private readonly resumePath: string) {}

  async getSessionState(context: HrWebChatContext): Promise<HrWebChatSessionState> {
    return this.state(context);
  }

  async setConsent(
    context: HrWebChatContext,
    input: { action: "accept" | "decline" | "withdraw"; disclosureVersion: string }
  ): Promise<HrWebChatSessionState> {
    assert.equal(input.disclosureVersion, "v1");
    const accepted = input.action === "accept";
    const state: HrWebChatSessionState = {
      consentStatus: accepted ? "accepted" : "declined",
      disclosure: "AI 身份与记录用途说明",
      disclosureVersion: "v1",
      intro: accepted ? "候选人简介" : undefined,
      resumeAvailable: accepted,
      visitorId: `visitor-${context.sessionId}`
    };
    this.states.set(context.sessionId, state);
    if (accepted) this.messages.set(context.sessionId, [{
      id: "intro",
      role: "assistant",
      text: "候选人简介",
      createdAt: "2026-09-11T01:00:00.000Z"
    }]);
    return state;
  }

  async listMessages(
    context: HrWebChatContext,
    input: { after?: string; limit: number }
  ): Promise<{ messages: HrWebChatMessage[]; cursor?: string }> {
    const all = this.messages.get(context.sessionId) ?? [];
    const start = input.after ? Math.max(0, all.findIndex((message) => message.id === input.after) + 1) : 0;
    const messages = all.slice(start, start + input.limit);
    return { messages, cursor: messages.at(-1)?.id ?? input.after };
  }

  async submitMessage(
    context: HrWebChatContext,
    input: { clientMessageId: string; text: string }
  ): Promise<{ acceptedMessageId: string; replyStatus: "pending"; visitorId?: string }> {
    assert.equal(this.state(context).consentStatus, "accepted");
    assert.ok(context.visitorId);
    const all = this.messages.get(context.sessionId) ?? [];
    all.push({ id: input.clientMessageId, role: "visitor", text: input.text, createdAt: "2026-09-11T01:01:00.000Z" });
    all.push({
      id: `reply-${input.clientMessageId}`,
      role: "assistant",
      text: "这是项目经验回答",
      createdAt: "2026-09-11T01:01:01.000Z",
      kind: "project-menu"
    });
    this.messages.set(context.sessionId, all);
    return { acceptedMessageId: input.clientMessageId, replyStatus: "pending", visitorId: context.visitorId };
  }

  async selectProject(
    context: HrWebChatContext,
    input: { projectId: string }
  ): Promise<{
    project: { id: string; title: string; category: string; summary: string };
    message: HrWebChatMessage;
    visitorId?: string;
  }> {
    assert.equal(this.state(context).consentStatus, "accepted");
    assert.ok(context.visitorId);
    const message: HrWebChatMessage = {
      id: `project-${input.projectId}`,
      role: "assistant",
      text: "我的角色：项目负责人。欢迎直接提问。",
      createdAt: "2026-09-11T01:01:02.000Z"
    };
    const all = this.messages.get(context.sessionId) ?? [];
    all.push(message);
    this.messages.set(context.sessionId, all);
    return {
      project: {
        id: input.projectId,
        title: "示例项目",
        category: "项目",
        summary: "示例项目摘要"
      },
      message,
      visitorId: context.visitorId
    };
  }

  async getResume(context: HrWebChatContext): Promise<{ path: string; name: string }> {
    assert.equal(this.state(context).consentStatus, "accepted");
    return { path: this.resumePath, name: "候选人简历.pdf" };
  }

  private state(context: HrWebChatContext): HrWebChatSessionState {
    return this.states.get(context.sessionId) ?? {
      consentStatus: "pending",
      disclosure: "AI 身份与记录用途说明",
      disclosureVersion: "v1",
      resumeAvailable: false
    };
  }
}

function responseCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const cookies = headers.getSetCookie?.() ?? [];
  if (cookies.length) return cookies;
  const combined = response.headers.get("set-cookie") ?? "";
  return combined.split(/,(?=\s*[A-Za-z0-9_]+=)/u).map((value) => value.trim()).filter(Boolean);
}

function cookieValue(cookies: string[], name: string): string {
  const cookie = cookies.find((value) => value.startsWith(`${name}=`));
  return cookie?.slice(name.length + 1).split(";", 1)[0] ?? "";
}

function rawHttpRequest(options: http.RequestOptions, body = ""): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(options, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.once("error", reject);
    request.end(body);
  });
}
