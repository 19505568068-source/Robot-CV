import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AccountManager } from "../src/server/account-manager.js";
import { checkCodex, startLocalHttpServer } from "../src/server/http-server.js";
import type { StartupService } from "../src/server/startup.js";
import { defaultConfig, saveConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { saveAccount } from "../src/weixin/accounts.js";

test("Codex status probe reuses the runner command resolver", async () => {
  const codexBin = fileURLToPath(new URL("./fixtures/fake-codex-version.mjs", import.meta.url));

  assert.deepEqual(await checkCodex(codexBin), {
    ready: true,
    version: "codex-cli windows-shim-test"
  });
});

test("startup status is exposed through the local API and startup changes require authentication", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-startup-http-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);
  saveConfig(paths, defaultConfig(root));
  let enabled = false;
  const requested: boolean[] = [];
  const startupService: StartupService = {
    getStartupStatus: () => ({
      supported: true,
      enabled,
      shortcutPath: "C:\\Users\\Test\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\Codex 微信 ClawBot.lnk"
    }),
    setStartupEnabled: async (nextEnabled) => {
      requested.push(nextEnabled);
      enabled = nextEnabled;
      return startupService.getStartupStatus();
    }
  };
  const server = await startLocalHttpServer({
    paths,
    accountManager: new AccountManager({ paths }),
    startupService,
    codexCheck: async () => ({ ready: true }),
    codexRuntimeCheck: async () => ({}),
    codexModelsCheck: async () => [],
    port: 0
  });
  t.after(() => server.close());
  const headers = {
    "Content-Type": "application/json",
    "X-Codex-Weixin-Token": server.requestToken,
    Origin: server.url
  };

  const bootstrap = await (await fetch(`${server.url}/api/bootstrap`)).json() as { startup?: unknown };
  assert.deepEqual(bootstrap.startup, startupService.getStartupStatus());
  const status = await fetch(`${server.url}/api/startup`);
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), startupService.getStartupStatus());

  const unauthorized = await fetch(`${server.url}/api/startup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: true })
  });
  assert.equal(unauthorized.status, 403);
  assert.deepEqual(requested, []);

  const invalid = await fetch(`${server.url}/api/startup`, {
    method: "POST",
    headers,
    body: JSON.stringify({ enabled: "yes" })
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(requested, []);

  const updated = await fetch(`${server.url}/api/startup`, {
    method: "POST",
    headers,
    body: JSON.stringify({ enabled: true })
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(await updated.json(), startupService.getStartupStatus());
  assert.deepEqual(requested, [true]);
});

test("personal account mutations are retired without touching retained data", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-delete-api-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls: Array<{ accountId: string; retainHistory?: boolean }> = [];
  const server = await startLocalHttpServer({
    paths: resolveStatePaths(root),
    accountManager: {
      async removeAccount(accountId: string, options: { retainHistory?: boolean }) {
        calls.push({ accountId, retainHistory: options.retainHistory });
      }
    } as never,
    port: 0
  });
  t.after(() => server.close());
  const headers = {
    "Content-Type": "application/json",
    "X-Codex-Weixin-Token": server.requestToken,
    Origin: server.url
  };

  const retained = await fetch(`${server.url}/api/accounts/account-one`, {
    method: "DELETE",
    headers,
    body: JSON.stringify({ retainHistory: true })
  });
  assert.equal(retained.status, 410);
  assert.equal((await retained.json() as { code?: string }).code, "HR_ONLY");

  const deleted = await fetch(`${server.url}/api/accounts/account-two`, {
    method: "DELETE",
    headers
  });
  assert.equal(deleted.status, 410);
  assert.equal((await deleted.json() as { code?: string }).code, "HR_ONLY");
  assert.deepEqual(calls, []);
});

test("local API redacts credentials and protects mutations", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-http-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);
  saveConfig(paths, defaultConfig(root));
  saveAccount(paths, {
    accountId: "account-one",
    token: "must-never-reach-browser",
    baseUrl: "https://example.test",
    cdnBaseUrl: "https://cdn.example.test",
    savedAt: new Date().toISOString(),
    enabled: false
  });
  const manager = new AccountManager({ paths });
  const updateChecks: boolean[] = [];
  let updateInstallCalls = 0;
  let restartCalls = 0;
  const server = await startLocalHttpServer({
    paths,
    accountManager: manager,
    port: 0,
    productVersion: "9.8.7",
    codexCheck: async () => ({ ready: true, version: "codex-cli test" }),
    codexRuntimeCheck: async () => ({ model: "runtime-model", effort: "high" }),
    codexModelsCheck: async () => [{
      model: "runtime-model",
      displayName: "Runtime Model",
      description: "Runtime model description",
      isDefault: true,
      defaultEffort: "medium",
      supportedEfforts: [{ effort: "medium", description: "Balanced" }]
    }],
    updateService: {
      check: async (force = false) => {
        updateChecks.push(force);
        return {
          currentVersion: "9.8.7",
          latestVersion: "9.9.0",
          updateAvailable: true,
          checkedAt: "2026-07-15T00:00:00.000Z",
          registry: "npmmirror"
        };
      },
      installLatest: async () => {
        updateInstallCalls += 1;
        return { version: "9.9.0", registry: "npmmirror" };
      }
    },
    onUpdateInstalled: () => { restartCalls += 1; }
  });
  t.after(() => server.close());

  const bootstrapResponse = await fetch(`${server.url}/api/bootstrap`);
  assert.equal(bootstrapResponse.status, 200);
  const bootstrap = await bootstrapResponse.json() as {
    product: string;
    version: string;
    requestToken: string;
    accounts: Array<Record<string, unknown>>;
    codex?: unknown;
    codexRuntime?: unknown;
    codexModels?: unknown;
  };
  assert.equal(bootstrap.product, "微信扫码 HR ClawBot");
  assert.equal(bootstrap.version, "9.8.7");
  assert.deepEqual(bootstrap.accounts, []);
  assert.equal(bootstrap.codex, undefined);
  assert.equal(bootstrap.codexRuntime, undefined);
  assert.equal(bootstrap.codexModels, undefined);
  assert.equal(JSON.stringify(bootstrap).includes("must-never-reach-browser"), false);

  const pageResponse = await fetch(server.url);
  const pageHtml = await pageResponse.text();
  assert.match(pageHtml, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/);
  assert.match(pageHtml, /<title>微信扫码 HR ClawBot<\/title>/);
  assert.match(pageHtml, /id="opportunitiesList"/);
  assert.match(pageHtml, /id="hrSettingsForm"/);
  assert.match(pageHtml, /id="hrEntryQrFrame"/);
  assert.match(pageHtml, /id="hrConsentFlowTitle"/);
  const faviconResponse = await fetch(`${server.url}/favicon.svg`);
  assert.equal(faviconResponse.status, 200);
  assert.match(faviconResponse.headers.get("content-type") ?? "", /^image\/svg\+xml/);
  assert.match(await faviconResponse.text(), /<title>微信扫码 HR ClawBot<\/title>/);

  const updateResponse = await fetch(`${server.url}/api/update`);
  assert.equal(updateResponse.status, 410);
  assert.equal((await updateResponse.json() as { code?: string }).code, "HR_ONLY");
  const unauthorizedForcedUpdate = await fetch(`${server.url}/api/update?force=1`);
  assert.equal(unauthorizedForcedUpdate.status, 410);
  const forcedUpdateResponse = await fetch(`${server.url}/api/update?force=1`, {
    headers: {
      "X-Codex-Weixin-Token": bootstrap.requestToken,
      Origin: server.url
    }
  });
  assert.equal(forcedUpdateResponse.status, 410);
  assert.deepEqual(updateChecks, []);
  const unauthorizedUpdate = await fetch(`${server.url}/api/update`, { method: "POST" });
  assert.equal(unauthorizedUpdate.status, 410);
  const installedUpdate = await fetch(`${server.url}/api/update`, {
    method: "POST",
    headers: {
      "X-Codex-Weixin-Token": bootstrap.requestToken,
      Origin: server.url
    }
  });
  assert.equal(installedUpdate.status, 410);
  assert.equal((await installedUpdate.json() as { code?: string }).code, "HR_ONLY");
  assert.equal(updateInstallCalls, 0);
  assert.equal(restartCalls, 0);

  const retiredRename = await fetch(`${server.url}/api/accounts/account-one`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName: "工作微信" })
  });
  assert.equal(retiredRename.status, 410);
  assert.equal((await retiredRename.json() as { code?: string }).code, "HR_ONLY");
  assert.equal(manager.listAccounts()[0]?.displayName, undefined);
});

test("personal session message API is retired", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-chat-api-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);
  const calls: string[] = [];
  const manager = {
    async getSessionMessages(accountId: string, sessionId: string) {
      calls.push(`get:${accountId}:${sessionId}`);
      return [{ id: "message-1", role: "assistant", text: "历史回答" }];
    },
    async continueSession(accountId: string, sessionId: string, text: string) {
      calls.push(`post:${accountId}:${sessionId}:${text}`);
      return {
        threadId: "thread-1",
        message: { id: "message-2", role: "assistant", text: "继续回答" }
      };
    }
  } as never;
  const server = await startLocalHttpServer({ paths, accountManager: manager, port: 0 });
  t.after(() => server.close());
  const messagesUrl = `${server.url}/api/sessions/account-one/session-one/messages`;

  const historyResponse = await fetch(messagesUrl);
  assert.equal(historyResponse.status, 410);
  assert.equal((await historyResponse.json() as { code?: string }).code, "HR_ONLY");

  const unauthorized = await fetch(messagesUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "继续" })
  });
  assert.equal(unauthorized.status, 410);

  const continued = await fetch(messagesUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Codex-Weixin-Token": server.requestToken,
      Origin: server.url
    },
    body: JSON.stringify({ text: "继续" })
  });
  assert.equal(continued.status, 410);
  assert.deepEqual(calls, []);
});

test("retired session upload API does not parse or forward files", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-upload-api-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);
  saveConfig(paths, { ...defaultConfig(root), maxInboundBytes: 8 });
  const calls: Array<{ accountId: string; sessionId: string; text: string; files: Array<{ name: string; data: string }> }> = [];
  const manager = {
    async continueSession(accountId: string, sessionId: string, text: string, uploads: Array<{ name: string; data: Buffer }>) {
      calls.push({
        accountId,
        sessionId,
        text,
        files: uploads.map((upload) => ({ name: upload.name, data: upload.data.toString("utf8") }))
      });
      return {
        threadId: "thread-upload",
        message: { id: "message-upload", role: "assistant", text: "收到附件" }
      };
    }
  } as never;
  const server = await startLocalHttpServer({ paths, accountManager: manager, port: 0 });
  t.after(() => server.close());
  const url = `${server.url}/api/sessions/account-one/session-one/messages`;
  const form = new FormData();
  form.append("text", "分析这份文件");
  form.append("files", new File(["content"], "report.txt", { type: "text/plain" }));
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "X-Codex-Weixin-Token": server.requestToken,
      Origin: server.url
    },
    body: form
  });

  assert.equal(response.status, 410);
  assert.deepEqual(calls, []);

  const oversized = new FormData();
  oversized.append("files", new File(["123456789"], "large.txt"));
  const oversizedResponse = await fetch(url, {
    method: "POST",
    headers: {
      "X-Codex-Weixin-Token": server.requestToken,
      Origin: server.url
    },
    body: oversized
  });
  assert.equal(oversizedResponse.status, 410);
  assert.equal(calls.length, 0);
});

test("retired session stream API never starts a stream", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-stream-api-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);
  const manager = {
    isSessionStreamEnabled() {
      return true;
    },
    async continueSession(
      _accountId: string,
      _sessionId: string,
      _text: string,
      _uploads: unknown[],
      onProgress?: (message: string) => Promise<void>
    ) {
      await onProgress?.("正在查询资料。");
      return {
        threadId: "thread-stream",
        message: { id: "message-stream", role: "assistant", text: "第一段。\n\n第二段。" }
      };
    }
  } as never;
  const server = await startLocalHttpServer({ paths, accountManager: manager, port: 0 });
  t.after(() => server.close());
  const response = await fetch(`${server.url}/api/sessions/account-one/session-one/messages?stream=1`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Codex-Weixin-Token": server.requestToken,
      Origin: server.url
    },
    body: JSON.stringify({ text: "开始" })
  });

  assert.equal(response.status, 410);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal((await response.json() as { code?: string }).code, "HR_ONLY");
});

test("retired session attachment API never reads retained attachment files", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-attachment-api-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const videoPath = path.join(root, "demo.mp4");
  fs.writeFileSync(videoPath, "0123456789");
  const manager = {
    async getSessionMessages() {
      return [{
        id: "message/video",
        role: "assistant",
        text: "视频已发送",
        attachments: [{ index: 0, type: "video", name: "demo.mp4", size: 10, available: true }]
      }];
    },
    async getSessionAttachment(accountId: string, sessionId: string, messageId: string, index: number) {
      assert.deepEqual([accountId, sessionId, messageId, index], ["account-one", "session-one", "message/video", 0]);
      return { index: 0, type: "video", name: "demo.mp4", size: 10, available: true, path: videoPath };
    }
  } as never;
  const server = await startLocalHttpServer({ paths: resolveStatePaths(root), accountManager: manager, port: 0 });
  t.after(() => server.close());

  const historyResponse = await fetch(`${server.url}/api/sessions/account-one/session-one/messages`);
  assert.equal(historyResponse.status, 410);
  const rangeResponse = await fetch(`${server.url}/api/sessions/account-one/session-one/messages/message%2Fvideo/attachments/0`, {
    headers: { Range: "bytes=2-5" }
  });
  assert.equal(rangeResponse.status, 410);
  assert.equal((await rangeResponse.json() as { code?: string }).code, "HR_ONLY");
  assert.equal(fs.readFileSync(videoPath, "utf8"), "0123456789");
});
