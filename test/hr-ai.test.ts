import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HrAiService, enforceNoCommitment, looksLikeHrQuestion } from "../src/server/hr-ai-service.js";
import type { HrCodexEngine, HrCodexDraftInput } from "../src/server/hr-codex-engine.js";
import { HR_KNOWLEDGE_LIMITS, retrieveHrKnowledge } from "../src/server/hr-knowledge.js";
import { HrService } from "../src/server/hr-service.js";
import { startLocalHttpServer } from "../src/server/http-server.js";
import type { SecretProtector } from "../src/security/dpapi.js";
import { HrAiStore } from "../src/state/hr-ai.js";
import { HrStore } from "../src/state/hr.js";
import { resolveStatePaths } from "../src/state/paths.js";

class FakeProtector implements SecretProtector {
  async protect(secret: string): Promise<string> { return `cipher:${Buffer.from(secret).toString("base64")}`; }
  async unprotect(ciphertext: string): Promise<string> { return Buffer.from(ciphertext.slice(7), "base64").toString(); }
}

async function fixture(
  t: test.TestContext,
  fetchImpl?: typeof fetch,
  codexEngine?: Pick<HrCodexEngine, "generateDraft" | "model">
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-hr-ai-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);
  const protector = new FakeProtector();
  const hrStore = new HrStore(paths, protector);
  const aiStore = new HrAiStore(paths, protector);
  const knowledgeDir = path.join(root, "knowledge");
  fs.mkdirSync(knowledgeDir);
  fs.writeFileSync(path.join(knowledgeDir, "projects.md"), [
    "# 支付系统项目",
    "候选人使用 TypeScript 负责支付系统幂等改造，将重复扣款告警降低 60%。",
    "api_key=should-not-be-sent"
  ].join("\n\n"));
  await hrStore.updateSettings({ targetRoles: ["后端工程师"], profileKeywords: ["TypeScript"] });
  await hrStore.updateMaterials({ bio: "候选人是一名后端工程师。", knowledgeBasePaths: [knowledgeDir] });
  const visitor = (await hrStore.recordPreConsentEvent({
    channelMessageId: "enter",
    openKfid: "wk-test",
    externalUserId: "hr-test"
  })).visitor;
  await hrStore.setVisitorConsent(visitor.id, "accepted");
  const archived = await hrStore.archiveInbound({
    channelMessageId: "question",
    openKfid: "wk-test",
    externalUserId: "hr-test",
    messageType: "text",
    text: "请介绍 TypeScript 支付项目，下周三可以面试吗？"
  });
  const service = new HrAiService({
    store: aiStore,
    hrStore,
    hrStatePath: paths.hrPath,
    ...(codexEngine ? { codexEngine } : {}),
    ...(fetchImpl ? { fetchImpl } : {})
  });
  return { root, paths, hrStore, aiStore, archived, service };
}

test("stores a separate DPAPI-protected HR AI key and never returns plaintext", async (t) => {
  const { aiStore, hrStore } = await fixture(t);
  const settings = await aiStore.updateSettings({
    enabled: true,
    endpoint: "https://model.example/v1/responses",
    model: "test-model",
    apiKey: "top-secret-key"
  });
  assert.equal(settings.configured, true);
  assert.equal(settings.hasApiKey, true);
  assert.equal(settings.toolsAllowed, false);
  assert.equal("apiKey" in settings, false);
  const stored = fs.readFileSync(aiStore.filePath, "utf8");
  assert.equal(stored.includes("top-secret-key"), false);
  assert.match(stored, /encryptedApiKey/);
  await assert.rejects(
    aiStore.updateSettings({ endpoint: "http://model.example/v1/responses" }),
    /HTTPS URL/i
  );
  assert.equal(hrStore.getMaterials().knowledgeBase.documentCount, 1);
  await hrStore.updateMaterials({ knowledgeBasePaths: [] });
  assert.equal(hrStore.getMaterials().knowledgeBase.documentCount, 0);
});

test("reads only bounded UTF-8 allowlisted files and excludes symbolic links", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-hr-kb-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "good.md"), "真实项目：订单平台 TypeScript 重构");
  fs.writeFileSync(path.join(root, "ignored.exe"), "订单平台但类型不允许");
  fs.writeFileSync(path.join(root, "large.txt"), Buffer.alloc(HR_KNOWLEDGE_LIMITS.maxFileBytes + 1, 65));
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.txt`);
  fs.writeFileSync(outside, "不应读取的外部秘密");
  t.after(() => fs.rmSync(outside, { force: true }));
  try {
    fs.symlinkSync(outside, path.join(root, "linked.txt"), "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  }

  const result = await retrieveHrKnowledge([root], "TypeScript 订单平台");
  assert.equal(result.scannedFiles, 1);
  assert.match(result.chunks[0]?.text ?? "", /TypeScript/);
  assert.equal(JSON.stringify(result).includes("外部秘密"), false);
  assert.ok(result.skippedFiles >= 2);
});

test("generates AI drafts through an injected tool-free Responses request", async (t) => {
  let requestBody: Record<string, unknown> | undefined;
  let authorization = "";
  const { aiStore, hrStore, archived, service, root } = await fixture(t, async (_input, init) => {
    authorization = String((init?.headers as Record<string, string>).Authorization);
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ output_text: "## 面试准备\n\n讲述支付幂等改造及 60% 告警下降；面试时间待确认。" });
  });
  await aiStore.updateSettings({
    enabled: true,
    endpoint: "https://model.example/v1/responses",
    model: "test-model",
    apiKey: "top-secret-key"
  });

  const result = await service.generateDraft(archived.opportunity.id, "interview-advice");
  assert.equal(result.generation.mode, "responses-api");
  assert.equal(result.generation.ai, true);
  assert.equal(result.draft.generator, "responses-api");
  assert.equal(result.draft.isAiGenerated, true);
  assert.equal(authorization, "Bearer top-secret-key");
  assert.equal("tools" in (requestBody ?? {}), false);
  const serialized = JSON.stringify(requestBody);
  assert.match(serialized, /支付系统项目/);
  assert.match(serialized, /\[已移除敏感值\]/);
  assert.match(serialized, /问题发现—采用方法—选择原因—结果或当前状态/u);
  assert.match(serialized, /已有证据与可迁移方法/u);
  assert.match(serialized, /当前任务是 draft/u);
  assert.match(serialized, /可以使用中文 Markdown/u);
  assert.equal(serialized.includes("should-not-be-sent"), false);
  assert.equal(serialized.includes(root), false);
  assert.equal(serialized.includes("top-secret-key"), false);
  const decorated = service.decorateOpportunity(hrStore.getOpportunity(archived.opportunity.id));
  assert.equal(decorated.drafts.some((draft) => draft.generator === "responses-api"), true);
});

test("uses isolated Codex first for all four opportunity draft actions", async (t) => {
  const calls: HrCodexDraftInput[] = [];
  let responsesCalls = 0;
  const codexEngine = {
    model: "codex-cli",
    async generateDraft(input: HrCodexDraftInput) {
      calls.push(input);
      return { content: `Codex 草稿：${input.instruction}`, model: "codex-cli" };
    }
  } satisfies Pick<HrCodexEngine, "generateDraft" | "model">;
  const { aiStore, archived, service, root, paths } = await fixture(t, async () => {
    responsesCalls += 1;
    return Response.json({ output_text: "不应调用" });
  }, codexEngine);
  await aiStore.updateSettings({
    enabled: true,
    endpoint: "https://model.example/v1/responses",
    model: "backup-model",
    apiKey: "backup-key"
  });

  const types = [
    "invitation-analysis",
    "interview-advice",
    "resume-improvements",
    "follow-up"
  ] as const;
  for (const type of types) {
    const result = await service.generateDraft(archived.opportunity.id, type);
    assert.equal(result.generation.mode, "codex");
    assert.equal(result.generation.ai, true);
    assert.equal(result.generation.model, "codex-cli");
    assert.equal(result.draft.generator, "codex");
    assert.equal(result.draft.model, "codex-cli");
  }

  assert.equal(calls.length, 4);
  assert.equal(responsesCalls, 0);
  assert.equal(service.getStatus().state, "ready");
  assert.match(service.getStatus().detail, /Codex/u);
  const serialized = JSON.stringify(calls);
  assert.match(serialized, /支付系统项目/u);
  assert.match(serialized, /\[S1\]/u);
  assert.equal(serialized.includes("should-not-be-sent"), false);
  assert.equal(serialized.includes(root), false);
  assert.ok(Buffer.byteLength(JSON.stringify(calls[0].context), "utf8") <= 32_000);

  const reloaded = new HrAiStore(paths, new FakeProtector());
  assert.equal(reloaded.listDrafts(archived.opportunity.id).filter((draft) => draft.generator === "codex").length, 4);
});

test("uses configured Responses only after Codex draft generation fails", async (t) => {
  let codexCalls = 0;
  let responsesCalls = 0;
  const codexEngine = {
    model: "codex-cli",
    async generateDraft() {
      codexCalls += 1;
      throw new Error("Codex unavailable");
    }
  } satisfies Pick<HrCodexEngine, "generateDraft" | "model">;
  const { aiStore, archived, service } = await fixture(t, async () => {
    responsesCalls += 1;
    return Response.json({ output_text: "备用模型生成的跟进草稿" });
  }, codexEngine);
  await aiStore.updateSettings({
    enabled: true,
    endpoint: "https://model.example/v1/responses",
    model: "backup-model",
    apiKey: "backup-key"
  });

  const result = await service.generateDraft(archived.opportunity.id, "follow-up");
  assert.equal(codexCalls, 1);
  assert.equal(responsesCalls, 1);
  assert.equal(result.generation.mode, "responses-api");
  assert.equal(result.draft.generator, "responses-api");
  assert.equal(service.getStatus().state, "ready");
});

test("uses the local template last when Codex fails and no Responses backup is configured", async (t) => {
  const codexEngine = {
    model: "codex-cli",
    async generateDraft() {
      throw new Error("Codex unavailable");
    }
  } satisfies Pick<HrCodexEngine, "generateDraft" | "model">;
  const { archived, service } = await fixture(t, undefined, codexEngine);

  const result = await service.generateDraft(archived.opportunity.id, "resume-improvements");

  assert.equal(result.generation.mode, "local-template");
  assert.equal(result.generation.fallbackReason, "provider-error");
  assert.equal(result.draft.generator, "local-template");
  assert.equal(service.getStatus().state, "error");
});

test("falls back honestly to a local template when the AI provider fails", async (t) => {
  const { aiStore, archived, service } = await fixture(t, async () => {
    throw new TypeError("network failed");
  });
  await aiStore.updateSettings({
    enabled: true,
    endpoint: "https://model.example/v1/responses",
    model: "test-model",
    apiKey: "key"
  });
  const result = await service.generateDraft(archived.opportunity.id, "follow-up");
  assert.equal(result.draft.generator, "local-template");
  assert.deepEqual(result.generation, {
    mode: "local-template",
    ai: false,
    fallbackReason: "provider-error"
  });
  assert.equal(service.getStatus().state, "error");
});

test("answers only accepted text messages and blocks candidate commitments", async (t) => {
  const { aiStore, archived, service } = await fixture(t, async () => Response.json({
    output: [{ content: [{ type: "output_text", text: "我确认参加下周三面试。" }] }]
  }));
  await aiStore.updateSettings({
    enabled: true,
    endpoint: "https://model.example/v1/responses",
    model: "test-model",
    apiKey: "key"
  });
  const reply = await service.generateReply({
    corpId: "ww-test",
    openKfid: "wk-test",
    externalUserId: "hr-test",
    channelMessageId: "question",
    messageType: "text",
    text: "下周三可以面试吗？"
  }, {
    ...archived,
    disposition: "archived-isolated",
    localCodexAllowed: false
  });
  assert.match(reply ?? "", /^待确认：/);
  assert.match(enforceNoCommitment("候选人接受这个 Offer"), /^待确认：/);
  assert.equal(looksLikeHrQuestion("岗位在上海，薪资范围稍后同步。"), false);
  assert.equal(looksLikeHrQuestion("请介绍支付项目"), true);
  const duplicateReply = await service.generateReply({
    corpId: "ww-test",
    openKfid: "wk-test",
    externalUserId: "hr-test",
    channelMessageId: "question",
    messageType: "text",
    text: "你好"
  }, {
    ...archived,
    duplicate: true,
    disposition: "archived-isolated",
    localCodexAllowed: false
  });
  assert.equal(duplicateReply, undefined);
});

test("exposes a separate protected AI management API and AI draft review flow", async (t) => {
  const { paths, hrStore, aiStore, archived, service } = await fixture(t, async () => Response.json({
    output_text: "仅依据资料生成的面试建议；时间待确认。"
  }));
  const server = await startLocalHttpServer({
    paths,
    hrService: new HrService({ store: hrStore }),
    hrAiService: service,
    port: 0
  });
  t.after(() => server.close());
  const headers = {
    Origin: server.url,
    "Content-Type": "application/json",
    "X-Codex-Weixin-Token": server.requestToken
  };

  const initial = await (await fetch(`${server.url}/api/hr/bootstrap`)).json() as {
    ai: { settings: { hasApiKey: boolean; apiKey?: string }; status: { state: string; toolsAllowed: boolean } };
  };
  assert.equal(initial.ai.settings.hasApiKey, false);
  assert.equal(initial.ai.settings.apiKey, undefined);
  assert.equal(initial.ai.status.state, "disabled");
  assert.equal(initial.ai.status.toolsAllowed, false);

  const unauthorized = await fetch(`${server.url}/api/hr/ai/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: false })
  });
  assert.equal(unauthorized.status, 403);
  const configured = await fetch(`${server.url}/api/hr/ai/settings`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      enabled: true,
      endpoint: "https://model.example/v1/responses",
      model: "test-model",
      apiKey: "api-key-from-ui"
    })
  });
  assert.equal(configured.status, 200);
  const configuredJson = await configured.json() as {
    settings: { hasApiKey: boolean; apiKey?: string };
    status: { ready: boolean };
  };
  assert.equal(configuredJson.settings.hasApiKey, true);
  assert.equal(configuredJson.settings.apiKey, undefined);
  assert.equal(configuredJson.status.ready, true);
  assert.equal(fs.readFileSync(aiStore.filePath, "utf8").includes("api-key-from-ui"), false);

  const generated = await fetch(
    `${server.url}/api/hr/opportunities/${archived.opportunity.id}/actions/interview-advice`,
    { method: "POST", headers, body: "{}" }
  );
  assert.equal(generated.status, 201);
  const generatedJson = await generated.json() as {
    draft: { id: string; generator: string };
    generation: { ai: boolean; mode: string };
  };
  assert.equal(generatedJson.draft.generator, "responses-api");
  assert.deepEqual(generatedJson.generation.ai, true);
  const detail = await (await fetch(
    `${server.url}/api/hr/opportunities/${archived.opportunity.id}`
  )).json() as { opportunity: { drafts: Array<{ id: string; generator: string }> } };
  assert.equal(detail.opportunity.drafts.some((draft) => draft.id === generatedJson.draft.id), true);
  const reviewed = await fetch(`${server.url}/api/hr/drafts/${generatedJson.draft.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ status: "approved" })
  });
  assert.equal(reviewed.status, 200);
  assert.equal((await reviewed.json() as { draft: { status: string } }).draft.status, "approved");
});
