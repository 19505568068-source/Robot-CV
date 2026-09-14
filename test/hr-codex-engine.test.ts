import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { CodexRunnerInput } from "../src/codex/app-server-runner.js";
import {
  buildHardenedCodexEnvironment,
  HrCodexEngine,
  type HrCodexGroundingContext
} from "../src/server/hr-codex-engine.js";

function groundingContext(): HrCodexGroundingContext {
  return {
    candidateProfile: {
      name: "张三",
      skills: ["TypeScript", "Node.js"]
    },
    opportunity: { title: "后端工程师" },
    knowledgeExcerpts: [{ source: "resume.pdf#page=1", text: "五年后端开发经验" }],
    recentConversation: [{ speaker: "hr", text: "方便介绍一下吗？" }]
  };
}

test("runs HR turns with bounded grounding, a restricted workspace, and structured output", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-hr-codex-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls: CodexRunnerInput[] = [];
  let savedThreadId = "";
  let closed = false;
  const engine = new HrCodexEngine({
    runtimeRoot: root,
    turnTimeoutMs: 1_234,
    runner: {
      async run(input) {
        calls.push(input);
        const threadId = input.threadId ?? "thread-visitor-1";
        await input.onThreadStarted?.(threadId);
        return {
          text: JSON.stringify({ reply: "您好， 我有五年后端开发经验。\n可以继续交流岗位重点。" }),
          threadId,
          raw: ""
        };
      },
      close() {
        closed = true;
      }
    }
  });
  t.after(() => engine.close());

  const result = await engine.reply({
    visitorId: "visitor-1",
    message: "请介绍一下自己",
    context: groundingContext(),
    onThreadStarted(threadId) {
      savedThreadId = threadId;
    }
  });

  assert.deepEqual(result, {
    text: "您好， 我有五年后端开发经验。 可以继续交流岗位重点。",
    threadId: "thread-visitor-1"
  });
  assert.equal(savedThreadId, "thread-visitor-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, engine.workspace);
  assert.equal(calls[0].turnTimeoutMs, 1_234);
  assert.deepEqual(calls[0].sandboxPolicy, {
    type: "readOnly",
    permissionProfile: "hr-public-read-only",
    networkAccess: false,
    access: {
      type: "restricted",
      includePlatformDefaults: false,
      readableRoots: [engine.workspace]
    }
  });
  assert.deepEqual(calls[0].outputSchema, {
    type: "object",
    additionalProperties: false,
    required: ["reply"],
    properties: {
      reply: {
        type: "string",
        description: "可直接发送给 HR 的简短中文纯文本回复"
      }
    }
  });
  assert.match(calls[0].prompt, /resume\.pdf#page=1/u);
  assert.match(calls[0].prompt, /请介绍一下自己/u);
  assert.match(calls[0].prompt, /当前任务是 reply/u);
  assert.match(calls[0].prompt, /最多追问一个单一目标的问题/u);
  assert.doesNotMatch(calls[0].prompt, /当前任务是 draft/u);
  assert.doesNotMatch(calls[0].prompt, /visitor-1/u);
  assert.deepEqual(fs.readdirSync(engine.workspace), []);

  const config = fs.readFileSync(path.join(engine.codexHome, "config.toml"), "utf8");
  assert.match(config, /approval_policy = "never"/u);
  assert.match(config, /default_permissions = "hr-public-read-only"/u);
  assert.match(config, /web_search = "disabled"/u);
  assert.match(config, /shell_tool = false/u);
  assert.match(config, /问题发现—采用方法—选择原因—结果或当前状态/u);
  assert.match(config, /项目记录显示/u);
  assert.match(config, /":root" = "deny"/u);
  assert.match(config, /":workspace_roots" = "read"/u);
  assert.match(config, /\[permissions\.hr-public-read-only\.network\]\nenabled = false/u);
  assert.doesNotMatch(config, /mcp_servers/u);

  engine.close();
  assert.equal(closed, true);
});

test("generates review-only HR drafts with the same tool-free sandbox and a strict content schema", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-hr-codex-draft-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls: CodexRunnerInput[] = [];
  const engine = new HrCodexEngine({
    runtimeRoot: root,
    model: "codex-test-model",
    runner: {
      async run(input) {
        calls.push(input);
        return {
          text: JSON.stringify({ content: "## 邀约分析\n\n- 阶段：待确认\n- 证据：[S1] 五年后端开发经验" }),
          threadId: "thread-draft",
          raw: ""
        };
      },
      close() {}
    }
  });
  t.after(() => engine.close());

  const result = await engine.generateDraft({
    opportunityId: "opportunity-1",
    instruction: "分析邀约意向",
    context: groundingContext()
  });

  assert.deepEqual(result, {
    content: "## 邀约分析\n\n- 阶段：待确认\n- 证据：[S1] 五年后端开发经验",
    model: "codex-test-model"
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].threadId, undefined);
  assert.equal(calls[0].cwd, engine.workspace);
  assert.deepEqual(calls[0].sandboxPolicy, {
    type: "readOnly",
    permissionProfile: "hr-public-read-only",
    networkAccess: false,
    access: {
      type: "restricted",
      includePlatformDefaults: false,
      readableRoots: [engine.workspace]
    }
  });
  assert.deepEqual(calls[0].outputSchema, {
    type: "object",
    additionalProperties: false,
    required: ["content"],
    properties: {
      content: {
        type: "string",
        description: "供候选人审核的中文 Markdown 草稿；所有事实判断须对应已提供的聊天或资料证据"
      }
    }
  });
  assert.match(calls[0].prompt, /供候选人审核/u);
  assert.match(calls[0].prompt, /分析邀约意向/u);
  assert.match(calls[0].prompt, /当前任务是 draft/u);
  assert.doesNotMatch(calls[0].prompt, /当前任务是 reply/u);
  assert.doesNotMatch(calls[0].prompt, /opportunity-1/u);
});

test("serializes turns for the same HR visitor", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-hr-codex-serial-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let active = 0;
  let maximumActive = 0;
  let sequence = 0;
  const engine = new HrCodexEngine({
    runtimeRoot: root,
    maxConcurrentTurns: 4,
    runner: {
      async run(input) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        const current = ++sequence;
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        const threadId = input.threadId ?? "thread-shared";
        await input.onThreadStarted?.(threadId);
        return { text: JSON.stringify({ reply: `回复${current}` }), threadId, raw: "" };
      },
      close() {}
    }
  });
  t.after(() => engine.close());

  const [first, second] = await Promise.all([
    engine.reply({ visitorId: "same", message: "一", context: groundingContext() }),
    engine.reply({ visitorId: "same", threadId: "thread-shared", message: "二", context: groundingContext() })
  ]);

  assert.equal(maximumActive, 1);
  assert.equal(first.text, "回复1");
  assert.equal(second.text, "回复2");
});

test("rejects secrets, non-JSON context, and malformed model output", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-hr-codex-validation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  const engine = new HrCodexEngine({
    runtimeRoot: root,
    runner: {
      async run() {
        calls += 1;
        return { text: "not-json", threadId: "thread-invalid", raw: "" };
      },
      close() {}
    }
  });
  t.after(() => engine.close());

  const secretContext = groundingContext();
  secretContext.candidateProfile = { api_key: "must-not-reach-codex" };
  await assert.rejects(
    engine.reply({ visitorId: "visitor-secret", message: "你好", context: secretContext }),
    /forbidden sensitive key/i
  );
  assert.equal(calls, 0);

  const nonJsonContext = groundingContext() as HrCodexGroundingContext & { candidateProfile: Record<string, unknown> };
  nonJsonContext.candidateProfile = { generatedAt: new Date() };
  await assert.rejects(
    engine.reply({ visitorId: "visitor-date", message: "你好", context: nonJsonContext as HrCodexGroundingContext }),
    /plain JSON object/i
  );
  assert.equal(calls, 0);

  await assert.rejects(
    engine.reply({ visitorId: "visitor-output", message: "你好", context: groundingContext() }),
    /invalid structured HR reply/i
  );
  assert.equal(calls, 1);
});

test("builds an allowlisted environment with an independent CODEX_HOME", () => {
  const codexHome = path.resolve(os.tmpdir(), "isolated-hr-codex-home");
  const environment = buildHardenedCodexEnvironment({
    Path: "C:\\Windows\\System32",
    OPENAI_API_KEY: "allowed-auth-value",
    DATABASE_URL: "must-not-leak",
    AWS_SECRET_ACCESS_KEY: "must-not-leak",
    USERPROFILE: "C:\\Users\\private"
  }, codexHome);

  assert.deepEqual(environment, {
    Path: "C:\\Windows\\System32",
    OPENAI_API_KEY: "allowed-auth-value",
    CODEX_HOME: codexHome
  });
});

test("copies only a validated auth.json into the isolated Codex home", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-hr-codex-auth-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source-auth.json");
  fs.writeFileSync(source, JSON.stringify({ OPENAI_API_KEY: "test-only-value" }), "utf8");
  const engine = new HrCodexEngine({
    runtimeRoot: path.join(root, "runtime"),
    authSourcePath: source,
    runner: { async run() { throw new Error("unused"); }, close() {} }
  });
  t.after(() => engine.close());

  const destination = path.join(engine.codexHome, "auth.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(destination, "utf8")), { OPENAI_API_KEY: "test-only-value" });
  if (process.platform !== "win32") assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(engine.codexHome).sort(), ["auth.json", "config.toml"]);
});

test("writes only a validated HTTPS compatible provider into the isolated config", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-hr-codex-provider-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const engine = new HrCodexEngine({
    runtimeRoot: root,
    authSourcePath: false,
    providerBaseUrl: "https://provider.example/v1/",
    runner: { async run() { throw new Error("unused"); }, close() {} }
  });
  t.after(() => engine.close());

  const config = fs.readFileSync(path.join(engine.codexHome, "config.toml"), "utf8");
  assert.match(config, /model_provider = "hr-compatible-provider"/u);
  assert.match(config, /base_url = "https:\/\/provider\.example\/v1"/u);
  assert.match(config, /wire_api = "responses"/u);
  assert.match(config, /requires_openai_auth = true/u);

  assert.throws(() => new HrCodexEngine({
    runtimeRoot: path.join(root, "invalid"),
    authSourcePath: false,
    providerBaseUrl: "http://provider.example",
    runner: { async run() { throw new Error("unused"); }, close() {} }
  }), /must be HTTPS/i);
});

test("rejects malformed explicit Codex auth sources", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-hr-codex-bad-auth-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source-auth.json");
  fs.writeFileSync(source, "not-json", "utf8");

  assert.throws(() => new HrCodexEngine({
    runtimeRoot: path.join(root, "runtime"),
    authSourcePath: source,
    runner: { async run() { throw new Error("unused"); }, close() {} }
  }), /not valid JSON/i);
});
