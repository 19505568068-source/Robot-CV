import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { SecretProtector } from "../src/security/dpapi.js";
import type { HrAiService } from "../src/server/hr-ai-service.js";
import { HrWebChatPublicError } from "../src/server/hr-web-chat-server.js";
import { HrWebChatService } from "../src/server/hr-web-chat-service.js";
import { HrStore } from "../src/state/hr.js";
import { resolveStatePaths } from "../src/state/paths.js";

class FakeProtector implements SecretProtector {
  async protect(secret: string): Promise<string> { return `protected:${secret}`; }
  async unprotect(ciphertext: string): Promise<string> { return ciphertext.slice("protected:".length); }
}

test("connects a consented H5 visitor to the existing archive, resume and opportunity flow", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-hr-web-service-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);
  const store = new HrStore(paths, new FakeProtector());
  const resumePath = path.join(root, "candidate.pdf");
  fs.writeFileSync(resumePath, "%PDF-1.4\nresume\n");
  await store.updateMaterials({
    disclosure: "我是候选人的 AI 助手；同意后会保存招聘对话并用于回答和机会分析。",
    bio: "候选人拥有企业 AI 产品经验。",
    resumePath
  });
  let releaseReply!: () => void;
  let markReplyStarted!: () => void;
  const replyGate = new Promise<void>((resolve) => { releaseReply = resolve; });
  const replyStarted = new Promise<void>((resolve) => { markReplyStarted = resolve; });
  const aiService = {
    generateReply: async () => {
      markReplyStarted();
      await replyGate;
      return "感谢介绍，方便说明岗位的工作地点吗？";
    }
  } as unknown as HrAiService;
  const service = new HrWebChatService({ store, aiService });
  const context = { sessionId: "browser-session-1" };

  const pending = await service.getSessionState(context);
  assert.equal(pending.consentStatus, "pending");
  assert.equal(pending.resumeAvailable, false);
  assert.equal((await service.listMessages(context, { limit: 100 })).messages.length, 0);

  await assert.rejects(
    service.setConsent(context, { action: "accept", disclosureVersion: "stale" }),
    (error: unknown) => error instanceof HrWebChatPublicError && error.code === "DISCLOSURE_CHANGED"
  );

  const accepted = await service.setConsent(context, {
    action: "accept",
    disclosureVersion: pending.disclosureVersion
  });
  assert.equal(accepted.consentStatus, "accepted");
  assert.equal(accepted.resumeAvailable, true);
  assert.equal((await service.getResume({ ...context, visitorId: accepted.visitorId })).name, "candidate.pdf");

  const result = await service.submitMessage(
    { ...context, visitorId: accepted.visitorId },
    { clientMessageId: "deec3d0f-501d-4599-94ab-459a164bb0eb", text: "我们是星河科技，招聘 AI 产品经理岗位。" }
  );
  assert.equal(result.replyStatus, "pending");
  await replyStarted;

  const beforeReply = await service.listMessages(
    { ...context, visitorId: accepted.visitorId },
    { limit: 100 }
  );
  assert.deepEqual(beforeReply.messages.map((message) => message.role), ["assistant", "assistant", "assistant", "visitor", "assistant"]);
  assert.equal(beforeReply.projectOptions?.length, 6);
  assert.match(beforeReply.messages.at(-1)!.text, /项目与实习经历/u);
  assert.equal(beforeReply.messages.at(-1)!.kind, "project-menu");
  releaseReply();
  await waitFor(() => store.listMessagesForVisitor(accepted.visitorId!).some((message) => message.messageType === "ai-text"));

  const page = await service.listMessages(
    { ...context, visitorId: accepted.visitorId },
    { limit: 100 }
  );
  assert.deepEqual(page.messages.map((message) => message.role), ["assistant", "assistant", "assistant", "visitor", "assistant", "assistant"]);
  assert.match(page.messages[0]!.text, /企业 AI 产品经验/u);
  assert.match(page.messages[1]!.text, /candidate\.pdf/u);
  assert.match(page.messages[2]!.text, /哪家公司/u);
  assert.match(page.messages[4]!.text, /项目与实习经历/u);
  assert.equal(page.messages[4]!.kind, "project-menu");
  assert.match(page.messages[5]!.text, /工作地点/u);
  assert.equal((await service.listMessages({ ...context, visitorId: accepted.visitorId }, { limit: 100 })).projectOptions?.length, 6);
  assert.equal(store.listOpportunities()[0]?.company, "星河科技");
  assert.equal(store.listOpportunities()[0]?.role, "AI 产品经理");

  const project = await service.selectProject(
    { ...context, visitorId: accepted.visitorId },
    { projectId: "red-infinity" }
  );
  assert.equal(project.project.id, "red-infinity");
  assert.match(project.message.text, /我的角色：游戏策划/u);
  assert.match(project.message.text, /欢迎直接从这段经历开始提问/u);
  const afterProject = store.listMessagesForVisitor(accepted.visitorId!);
  assert.equal(afterProject.filter((message) => message.messageType === "project-detail").length, 1);
  const duplicateProject = await service.selectProject(
    { ...context, visitorId: accepted.visitorId },
    { projectId: "red-infinity" }
  );
  assert.equal(duplicateProject.message.id, project.message.id);
  assert.equal(store.listMessagesForVisitor(accepted.visitorId!).filter((message) => message.messageType === "project-detail").length, 1);

  const duplicate = await service.submitMessage(
    { ...context, visitorId: accepted.visitorId },
    { clientMessageId: "deec3d0f-501d-4599-94ab-459a164bb0eb", text: "重复提交" }
  );
  assert.equal(duplicate.replyStatus, "sent");
  assert.equal((await service.listMessages({ ...context, visitorId: accepted.visitorId }, { limit: 100 })).messages.length, 7);
});

test("applies the commitment guard to Codex replies on the H5 primary path", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-hr-web-codex-guard-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);
  const store = new HrStore(paths, new FakeProtector());
  await store.updateMaterials({
    disclosure: "同意后保存招聘对话。",
    bio: "候选人有产品与工程经历。"
  });
  const service = new HrWebChatService({
    store,
    hrStatePath: paths.hrPath,
    codexEngine: {
      async reply() {
        return { text: "我确认参加下周一面试。", threadId: "thread-guard" };
      }
    } as never
  });
  const pending = await service.getSessionState({ sessionId: "guard-session" });
  const accepted = await service.setConsent(
    { sessionId: "guard-session" },
    { action: "accept", disclosureVersion: pending.disclosureVersion }
  );
  await service.submitMessage(
    { sessionId: "guard-session", visitorId: accepted.visitorId },
    { clientMessageId: "guard-message", text: "下周一可以面试吗？" }
  );
  await waitFor(() => store.listMessagesForVisitor(accepted.visitorId!).some((message) => message.messageType === "ai-text"));
  const reply = store.listMessagesForVisitor(accepted.visitorId!).find((message) => message.messageType === "ai-text")?.text ?? "";
  assert.match(reply, /^待确认：/u);
  assert.doesNotMatch(reply, /确认参加/u);
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for background reply");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
