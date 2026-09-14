import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { SecretProtector } from "../src/security/dpapi.js";
import { HrStore } from "../src/state/hr.js";
import { resolveStatePaths } from "../src/state/paths.js";

class FakeProtector implements SecretProtector {
  async protect(secret: string): Promise<string> {
    return Buffer.from(secret, "utf8").toString("base64");
  }

  async unprotect(ciphertext: string): Promise<string> {
    return Buffer.from(ciphertext, "base64").toString("utf8");
  }
}

function setup(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-hr-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);
  return { root, paths, store: new HrStore(paths, new FakeProtector()) };
}

test("persists a stable WeChat Customer Service entry and redacts all credentials", async (t) => {
  const { paths, store } = setup(t);
  const initialStableId = store.getSettings().stableId;
  const encodingAesKey = "a".repeat(43);

  const settings = await store.updateSettings({
    enabled: true,
    corpId: "ww-corp",
    openKfId: "wk-service",
    contactUrl: "https://work.weixin.qq.com/kf/example?scene=stable-scene",
    callbackPublicUrl: "https://hr-bot.example.com/wecom/callback",
    secret: "corp-secret",
    token: "callbacktoken",
    encodingAesKey,
    targetRoles: ["AI 产品经理"],
    profileKeywords: ["AI", "增长"]
  });

  assert.equal(settings.channel, "wecom-wechat-customer-service");
  assert.equal(settings.stableId, initialStableId);
  assert.equal(settings.openKfid, "wk-service");
  assert.equal(settings.openKfId, "wk-service");
  assert.equal("agentId" in settings, false);
  assert.equal(settings.configured, true);
  assert.equal(settings.hasSecret, true);
  assert.equal(settings.hasToken, true);
  assert.equal(settings.hasEncodingAesKey, true);
  assert.equal(JSON.stringify(settings).includes("corp-secret"), false);

  const stored = fs.readFileSync(paths.hrPath, "utf8");
  assert.equal(stored.includes("corp-secret"), false);
  assert.equal(stored.includes("callbacktoken"), false);
  assert.equal(stored.includes(encodingAesKey), false);
  const restarted = new HrStore(paths, new FakeProtector());
  assert.equal(restarted.getSettings().stableId, initialStableId);
  assert.deepEqual(await restarted.readCredentials(), {
    corpId: "ww-corp",
    openKfid: "wk-service",
    secret: "corp-secret",
    token: "callbacktoken",
    encodingAesKey
  });

  await restarted.updateSettings({ secret: "", token: "" });
  assert.equal(restarted.getSettings().hasSecret, true);
  assert.equal(restarted.getSettings().hasToken, true);
});

test("rejects ambiguous or non-public WeChat Customer Service settings", async (t) => {
  const { store } = setup(t);
  await assert.rejects(
    store.updateSettings({ openKfid: "wk-one", openKfId: "wk-two" }),
    /must refer to the same/i
  );
  await assert.rejects(
    store.updateSettings({ callbackPublicUrl: "https://127.0.0.1/wecom/callback" }),
    /public internet/i
  );
  await assert.rejects(
    store.updateSettings({ serviceLink: "https://example.com/kf/not-official" }),
    /official/i
  );
  await assert.rejects(store.updateSettings({ token: "contains-hyphen" }), /letters or digits/i);
  await assert.rejects(store.updateSettings({ token: "a".repeat(33) }), /1 to 32/i);
  await assert.rejects(store.updateSettings({ encodingAesKey: `${"a".repeat(42)}-` }), /43 English letters or digits/i);
});

test("keeps the combined introduction within the WeChat Customer Service text limit", async (t) => {
  const { store } = setup(t);
  await store.updateSettings({ welcomeMessage: "欢".repeat(300) });
  await assert.rejects(
    store.updateMaterials({ bio: "介".repeat(400) }),
    /introduction and welcome message.*2048 UTF-8 bytes/i
  );
  assert.equal(store.getMaterials().bio, undefined);
  await store.updateMaterials({ bio: "介".repeat(300) });
  assert.equal(store.getMaterials().bio, "介".repeat(300));
});

test("invalidates the active integration when corp or customer-service identity changes", async (t) => {
  const { store } = setup(t);
  await store.updateSettings({
    enabled: true,
    corpId: "ww-corp",
    openKfid: "wk-service",
    serviceLink: "https://work.weixin.qq.com/kf/example?scene=stable",
    callbackPublicUrl: "https://callback.example.com/wecom/callback",
    secret: "secret",
    token: "token",
    encodingAesKey: "e".repeat(43)
  });
  await store.setSyncCursor("wk-service", "cursor-before-corp-change");
  await store.markCallbackVerified();

  const changedCorp = await store.updateSettings({ corpId: "ww-new-corp", enabled: true });
  assert.equal(changedCorp.enabled, false);
  assert.equal(changedCorp.serviceLink, undefined);
  assert.equal(store.getSyncCursor("wk-service"), undefined);
  assert.equal(store.getCallbackVerifiedAt(), undefined);

  await store.updateSettings({
    serviceLink: "https://work.weixin.qq.com/kf/rebound?scene=stable",
    enabled: true
  });
  await store.setSyncCursor("wk-service", "cursor-before-kf-change");
  await store.setSyncCursor("wk-new-service", "stale-cursor-for-new-account");
  await store.markCallbackVerified();

  const changedKf = await store.updateSettings({ openKfid: "wk-new-service", enabled: true });
  assert.equal(changedKf.enabled, false);
  assert.equal(changedKf.serviceLink, undefined);
  assert.equal(store.getSyncCursor("wk-service"), undefined);
  assert.equal(store.getSyncCursor("wk-new-service"), undefined);
  assert.equal(store.getCallbackVerifiedAt(), undefined);
});

test("serializes settings and visitor mutations through one queue", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-hr-queue-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let releaseProtection!: () => void;
  let protectionStarted!: () => void;
  const protectionGate = new Promise<void>((resolve) => { releaseProtection = resolve; });
  const started = new Promise<void>((resolve) => { protectionStarted = resolve; });
  const protector: SecretProtector = {
    async protect(secret: string) {
      protectionStarted();
      await protectionGate;
      return `protected:${secret}`;
    },
    async unprotect(ciphertext: string) {
      return ciphertext.slice("protected:".length);
    }
  };
  const store = new HrStore(resolveStatePaths(root), protector);
  const settingsUpdate = store.updateSettings({ secret: "queued-secret" });
  await started;
  const visitorMutation = store.recordPreConsentEvent({
    channelMessageId: "queued-event",
    openKfid: "wk-service",
    externalUserId: "queued-hr"
  });

  assert.equal(store.findVisitor("wk-service", "queued-hr"), undefined);
  releaseProtection();
  await settingsUpdate;
  const visitor = await visitorMutation;
  assert.equal(visitor.visitor.externalUserId, "queued-hr");
  assert.equal(store.getSettings().hasSecret, true);
});

test("does not retain message text or create opportunities before consent", async (t) => {
  const { paths, store } = setup(t);
  const input = {
    channelMessageId: "pre-consent-message",
    openKfid: "wk-service",
    externalUserId: "external-hr",
    text: "这里包含未授权保存的敏感招聘内容",
    createdAt: "2026-09-10T01:00:00.000Z"
  };

  const pending = await store.recordPreConsentEvent(input);
  assert.equal(pending.visitor.consentStatus, "pending");
  assert.equal(store.listOpportunities().length, 0);
  assert.equal(fs.readFileSync(paths.hrPath, "utf8").includes(input.text), false);
  await assert.rejects(store.archiveInbound(input), /consent is required/i);

  const acceptedVisitor = await store.setVisitorConsent(pending.visitor.id, "accepted");
  await store.updateSettings({ targetRoles: ["AI 产品经理"], profileKeywords: ["AI"] });
  const result = await store.archiveInbound({
    ...input,
    channelMessageId: "accepted-message",
    text: "我们是未来科技的 HR，招聘岗位：AI 产品经理，地点上海，想约你周五下午 3:00 面试。"
  });

  assert.equal(result.duplicate, false);
  assert.equal(result.opportunity.company, "未来科技");
  assert.equal(result.opportunity.role, "AI 产品经理");
  assert.equal(result.opportunity.stage, "interview-scheduled");
  assert.ok(result.opportunity.invitationScore >= 88);
  assert.ok((result.opportunity.fitScore ?? 0) >= 70);
  assert.ok(result.opportunity.evidence.some((item) => item.kind === "invitation" && item.messageId === result.message.id));
  assert.ok(result.opportunity.evidence.some((item) => item.kind === "fit" && item.messageId === result.message.id));
  assert.equal(result.opportunity.consentStatus, "accepted");
  assert.equal(result.opportunity.consentedAt, acceptedVisitor.consentAt);

  const duplicate = await store.archiveInbound({
    ...input,
    channelMessageId: "accepted-message",
    text: "重复投递不应覆盖原文"
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(store.getOpportunity(result.opportunity.id).messages.length, 1);
});

test("keeps immutable resume versions and exposes only safe material metadata", async (t) => {
  const { root, store } = setup(t);
  const resumeOne = path.join(root, "resume-v1.pdf");
  const resumeTwo = path.join(root, "resume-v2.pdf");
  const knowledge = path.join(root, "projects.md");
  fs.writeFileSync(resumeOne, "%PDF-1.4\nfirst resume\n");
  fs.writeFileSync(resumeTwo, "%PDF-1.4\nsecond resume\n");
  fs.writeFileSync(knowledge, "verified project history\n");

  const first = await store.updateMaterials({
    disclosure: "我是 AI 助手，记录仅用于招聘沟通。",
    bio: "真实候选人简介",
    resumePath: resumeOne,
    knowledgeBasePaths: [knowledge]
  });
  const second = await store.updateMaterials({ resumePath: resumeTwo });

  assert.equal(first.resume.version, 1);
  assert.equal(second.resume.version, 2);
  assert.equal(second.resumeVersions.length, 2);
  assert.equal(second.resumeVersions[0]?.hash.length, 64);
  assert.equal(JSON.stringify(second).includes(resumeOne), false);
  assert.equal(second.knowledgeBase.documentCount, 1);
  assert.equal(second.knowledgeBase.documents[0]?.name, "projects.md");
  const archivedResume = store.getResumeFile(second.resume.id!);
  assert.notEqual(archivedResume.path, resumeTwo);
  assert.equal(fs.readFileSync(archivedResume.path, "utf8"), "%PDF-1.4\nsecond resume\n");
  fs.writeFileSync(resumeTwo, "%PDF-1.4\nchanged source\n");
  assert.equal(fs.readFileSync(store.getResumeFile(second.resume.id!).path, "utf8"), "%PDF-1.4\nsecond resume\n");
  fs.rmSync(resumeTwo);
  assert.equal(fs.readFileSync(store.getResumeFile(second.resume.id!).path, "utf8"), "%PDF-1.4\nsecond resume\n");

  const cleared = await store.updateMaterials({ resumePath: null });
  assert.equal(cleared.resume.configured, false);
  assert.equal(cleared.resumeVersions.length, 2);
});

test("rejects spoofed and oversized resume PDFs before importing a version", async (t) => {
  const { root, store } = setup(t);
  const spoofed = path.join(root, "spoofed.pdf");
  const oversized = path.join(root, "oversized.pdf");
  fs.writeFileSync(spoofed, "not a PDF\n");
  fs.writeFileSync(oversized, "%PDF-1.7\n");
  fs.truncateSync(oversized, (20 * 1024 * 1024) + 1);

  await assert.rejects(store.updateMaterials({ resumePath: spoofed }), /valid PDF header/i);
  await assert.rejects(store.updateMaterials({ resumePath: oversized }), /20 MiB/i);
  const materials = store.getMaterials();
  assert.equal(materials.resume.configured, false);
  assert.equal(materials.resumeVersions.length, 0);
  assert.equal(fs.existsSync(path.join(root, "hr-materials", "resumes")), false);
});

test("validates a material update completely before committing any field", async (t) => {
  const { root, store } = setup(t);
  const resume = path.join(root, "resume.pdf");
  fs.writeFileSync(resume, "%PDF-1.4\nresume\n");
  const before = store.getMaterials();

  await assert.rejects(store.updateMaterials({
    disclosure: "不应留下的披露文案",
    bio: "不应留下的简介",
    resumePath: resume,
    knowledgeBasePaths: [path.join(root, "missing-knowledge-base")]
  }), /not found/i);

  assert.deepEqual(store.getMaterials(), before);
  assert.equal(fs.existsSync(path.join(root, "hr-materials", "resumes")), false);
});

test("keeps the consent disclosure and version hash byte-exact within the msgmenu limit", async (t) => {
  const { store } = setup(t);
  const exactLimit = `${"界".repeat(341)}a`;
  assert.equal(Buffer.byteLength(exactLimit, "utf8"), 1_024);

  const accepted = await store.updateMaterials({ disclosure: exactLimit });
  assert.equal(accepted.disclosure, exactLimit);
  assert.equal(
    store.currentConsentVersion(),
    crypto.createHash("sha256").update(exactLimit, "utf8").digest("hex")
  );
  const beforeRejectedUpdate = store.getMaterials();

  await assert.rejects(
    store.updateMaterials({ disclosure: `${exactLimit}b`, bio: "不应提交" }),
    /1024 UTF-8 bytes/i
  );
  assert.deepEqual(store.getMaterials(), beforeRejectedUpdate);
  await assert.rejects(store.updateSettings({ aiDisclosure: `${exactLimit}b` }), /1024 UTF-8 bytes/i);
  assert.equal(store.currentConsentVersion(), crypto.createHash("sha256").update(exactLimit, "utf8").digest("hex"));
});

test("loads an oversized legacy disclosure without truncation and disables delivery until it is corrected", async (t) => {
  const { paths, store } = setup(t);
  await store.updateSettings({
    enabled: true,
    corpId: "ww-corp",
    openKfid: "wk-service",
    serviceLink: "https://work.weixin.qq.com/kf/example?scene=stable",
    callbackPublicUrl: "https://callback.example.com/wecom/callback",
    secret: "secret",
    token: "token",
    encodingAesKey: "e".repeat(43)
  });
  const oversizedDisclosure = "旧".repeat(1_000);
  const raw = JSON.parse(fs.readFileSync(paths.hrPath, "utf8")) as {
    settings: { enabled: boolean; aiDisclosure: string };
  };
  raw.settings.enabled = true;
  raw.settings.aiDisclosure = oversizedDisclosure;
  fs.writeFileSync(paths.hrPath, `${JSON.stringify(raw, null, 2)}\n`);

  const migrated = new HrStore(paths, new FakeProtector());
  assert.equal(migrated.getSettings().aiDisclosure, oversizedDisclosure);
  assert.equal(migrated.getSettings().enabled, false);
  assert.equal(migrated.getSettings().configured, false);
  assert.equal((JSON.parse(fs.readFileSync(paths.hrPath, "utf8")) as {
    settings: { enabled: boolean; aiDisclosure: string };
  }).settings.enabled, false);
  await assert.rejects(migrated.updateSettings({ enabled: true }), /aiDisclosure.*1024 UTF-8 bytes/i);

  await migrated.updateMaterials({ disclosure: "合规且完整的 AI 身份与聊天记录用途说明" });
  const reenabled = await migrated.updateSettings({ enabled: true });
  assert.equal(reenabled.enabled, true);
  assert.equal(reenabled.configured, true);
});

test("disables an oversized legacy introduction without discarding it", async (t) => {
  const { paths, store } = setup(t);
  await store.updateSettings({
    enabled: true,
    corpId: "ww-corp",
    openKfid: "wk-service",
    serviceLink: "https://work.weixin.qq.com/kf/example?scene=stable",
    callbackPublicUrl: "https://callback.example.com/wecom/callback",
    secret: "secret",
    token: "token",
    encodingAesKey: "e".repeat(43)
  });
  const oversizedBio = "旧".repeat(1_000);
  const raw = JSON.parse(fs.readFileSync(paths.hrPath, "utf8")) as {
    settings: { enabled: boolean };
    materials: { bio?: string };
  };
  raw.settings.enabled = true;
  raw.materials.bio = oversizedBio;
  fs.writeFileSync(paths.hrPath, `${JSON.stringify(raw, null, 2)}\n`);

  const migrated = new HrStore(paths, new FakeProtector());
  assert.equal(migrated.getMaterials().bio, oversizedBio);
  assert.equal(migrated.getSettings().enabled, false);
  assert.equal(migrated.getSettings().configured, false);
  assert.equal((JSON.parse(fs.readFileSync(paths.hrPath, "utf8")) as {
    settings: { enabled: boolean };
  }).settings.enabled, false);
  await assert.rejects(migrated.updateSettings({ enabled: true }), /2048 UTF-8 bytes/i);
});

test("migrates singular provider IDs and removes components no longer in the material plan", async (t) => {
  const { paths, store } = setup(t);
  const pending = await store.recordPreConsentEvent({
    channelMessageId: "provider-migration-enter",
    openKfid: "wk-service",
    externalUserId: "provider-migration-hr"
  });
  const accepted = await store.transitionVisitorConsent(pending.visitor.id, "accepted");
  const deliveryId = accepted.visitor.materialsDeliveryId!;
  await store.ensureMaterialDelivery({
    deliveryId,
    visitorId: accepted.visitor.id,
    components: ["intro", "resume"]
  });
  await store.markMaterialComponentSubmitted(deliveryId, "intro", "legacy-provider-id");
  await store.markMaterialComponentFailed(deliveryId, "resume");
  await store.ensureMaterialDelivery({
    deliveryId,
    visitorId: accepted.visitor.id,
    components: ["intro"]
  });
  assert.equal(store.getMaterialDelivery(deliveryId)?.components.resume, undefined);
  assert.equal(store.getVisitor(accepted.visitor.id)?.materialsStatus, "sent");

  const raw = JSON.parse(fs.readFileSync(paths.hrPath, "utf8")) as {
    integration: { materialDeliveries: Array<{ components: { intro: { providerMessageIds?: string[] } } }> };
  };
  delete raw.integration.materialDeliveries[0]!.components.intro.providerMessageIds;
  fs.writeFileSync(paths.hrPath, `${JSON.stringify(raw, null, 2)}\n`);
  const migrated = new HrStore(paths, new FakeProtector());
  assert.deepEqual(
    migrated.getMaterialDelivery(deliveryId)?.components.intro?.providerMessageIds,
    ["legacy-provider-id"]
  );
  const persisted = JSON.parse(fs.readFileSync(paths.hrPath, "utf8")) as {
    integration: { materialDeliveries: Array<{ components: { intro: { providerMessageIds?: string[] } } }> };
  };
  assert.deepEqual(persisted.integration.materialDeliveries[0]!.components.intro.providerMessageIds, ["legacy-provider-id"]);
});

test("persists only a bounded provider-message history for material failure correlation", async (t) => {
  const { paths, store } = setup(t);
  const pending = await store.recordPreConsentEvent({
    channelMessageId: "bounded-history-enter",
    openKfid: "wk-service",
    externalUserId: "bounded-history-hr"
  });
  const accepted = await store.transitionVisitorConsent(pending.visitor.id, "accepted");
  const deliveryId = accepted.visitor.materialsDeliveryId!;
  await store.ensureMaterialDelivery({
    deliveryId,
    visitorId: accepted.visitor.id,
    components: ["resume"]
  });
  for (let index = 0; index < 7; index += 1) {
    await store.markMaterialComponentSubmitted(deliveryId, "resume", `provider-${index}`);
  }

  const restarted = new HrStore(paths, new FakeProtector());
  assert.deepEqual(
    restarted.getMaterialDelivery(deliveryId)?.components.resume?.providerMessageIds,
    ["provider-2", "provider-3", "provider-4", "provider-5", "provider-6"]
  );
  assert.deepEqual(await restarted.markMaterialComponentFailedByProviderMessageId("provider-0"), {
    matched: false,
    currentAttempt: false
  });
  const lateFailure = await restarted.markMaterialComponentFailedByProviderMessageId("provider-6");
  assert.equal(lateFailure.matched, true);
  assert.equal(lateFailure.currentAttempt, true);
  assert.equal(restarted.getVisitor(accepted.visitor.id)?.materialsStatus, "failed");
});

test("migrates version 1 HR state, resets consent and copies resumes into managed storage", async (t) => {
  const { root, paths, store } = setup(t);
  const source = path.join(root, "legacy-resume.pdf");
  fs.writeFileSync(source, "%PDF-1.4\nlegacy resume\n");
  const materials = await store.updateMaterials({ resumePath: source });
  const legacyVisitor = (await store.recordPreConsentEvent({
    channelMessageId: "legacy-accept-event",
    openKfid: "wk-service",
    externalUserId: "legacy-hr"
  })).visitor;
  await store.setVisitorConsent(legacyVisitor.id, "accepted");
  const legacyOpportunity = (await store.archiveInbound({
    channelMessageId: "legacy-job",
    openKfid: "wk-service",
    externalUserId: "legacy-hr",
    text: "岗位：后端工程师"
  })).opportunity;
  const raw = JSON.parse(fs.readFileSync(paths.hrPath, "utf8")) as {
    version: number;
    materials: { resumeVersions: Array<{ path: string }> };
  };
  raw.version = 1;
  raw.materials.resumeVersions[0]!.path = source;
  fs.rmSync(paths.hrMaterialsDir, { recursive: true, force: true });
  fs.writeFileSync(paths.hrPath, `${JSON.stringify(raw, null, 2)}\n`);

  const migrated = new HrStore(paths, new FakeProtector());
  const resume = migrated.getResumeFile(materials.resume.id!);
  assert.equal(resume.path.startsWith(paths.hrMaterialsDir), true);
  fs.rmSync(source);
  assert.equal(fs.readFileSync(migrated.getResumeFile(materials.resume.id!).path, "utf8"), "%PDF-1.4\nlegacy resume\n");
  const migratedVisitor = migrated.getVisitor(legacyVisitor.id)!;
  assert.equal(migratedVisitor.consentStatus, "pending");
  assert.equal(migratedVisitor.consentAt, undefined);
  assert.equal(migratedVisitor.consentVersion, undefined);
  assert.equal(migratedVisitor.materialsDeliveryId, undefined);
  assert.deepEqual(migratedVisitor.processedConsentEventIds, ["legacy-accept-event"]);
  assert.equal(migrated.getOpportunity(legacyOpportunity.id).consentStatus, "pending");
  assert.equal(migrated.getOpportunity(legacyOpportunity.id).consentedAt, undefined);
  assert.equal((JSON.parse(fs.readFileSync(paths.hrPath, "utf8")) as { version: number }).version, 2);
});

test("creates reviewable local templates without claiming AI generation", async (t) => {
  const { store } = setup(t);
  const visitor = (await store.recordPreConsentEvent({
    channelMessageId: "first",
    openKfid: "wk-service",
    externalUserId: "external-hr"
  })).visitor;
  await store.setVisitorConsent(visitor.id, "accepted");
  const opportunity = (await store.archiveInbound({
    channelMessageId: "job",
    openKfid: "wk-service",
    externalUserId: "external-hr",
    text: "岗位：后端工程师，想邀请你参加面试。"
  })).opportunity;

  for (const type of ["invitation-analysis", "interview-advice", "resume-improvements", "follow-up"] as const) {
    const draft = await store.generateDraft(opportunity.id, type);
    assert.equal(draft.generator, "local-template");
    assert.equal(draft.isAiGenerated, false);
    assert.equal(draft.status, "draft");
    assert.ok(draft.content.length > 20);
    assert.equal((await store.setDraftStatus(draft.id, "reviewed")).status, "reviewed");
  }
  assert.equal(store.getOpportunity(opportunity.id).drafts.length, 4);
});
