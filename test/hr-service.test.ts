import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HrService } from "../src/server/hr-service.js";
import type { SecretProtector } from "../src/security/dpapi.js";
import { HR_CHANNEL, HrStore } from "../src/state/hr.js";
import { resolveStatePaths } from "../src/state/paths.js";

class FakeProtector implements SecretProtector {
  async protect(secret: string): Promise<string> { return `protected:${Buffer.from(secret).toString("base64")}`; }
  async unprotect(ciphertext: string): Promise<string> { return Buffer.from(ciphertext.slice(10), "base64").toString(); }
}

async function setup(t: test.TestContext, withAdapter = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-hr-service-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new HrStore(resolveStatePaths(root), new FakeProtector());
  await store.updateSettings({
    enabled: true,
    corpId: "ww-corp",
    openKfid: "wk-service",
    serviceLink: "https://work.weixin.qq.com/kf/example?scene=stable",
    callbackPublicUrl: "https://callback.example.com/wecom/callback",
    secret: "secret",
    token: "token",
    encodingAesKey: "e".repeat(43),
    welcomeMessage: "感谢关注这个机会。"
  });
  const resume = path.join(root, "candidate.pdf");
  fs.writeFileSync(resume, "%PDF-1.4\nresume\n");
  await store.updateMaterials({ bio: "候选人简介", resumePath: resume });
  const service = new HrService({
    store,
    qrDataUrlFactory: async (content) => `data:image/test,${content}`,
    ...(withAdapter ? {
      adapter: {
        channel: HR_CHANNEL,
        getStatus: () => ({ state: "ready" as const, receiving: true, detail: "connected" })
      }
    } : {})
  });
  return { root, store, service };
}

test("reports a stable entry separately from callback connectivity", async (t) => {
  const { service } = await setup(t);
  const bootstrap = await service.getBootstrap();

  assert.equal(bootstrap.entry.publicLink, "https://work.weixin.qq.com/kf/example?scene=stable");
  assert.equal(bootstrap.entry.qrContent, bootstrap.entry.publicLink);
  assert.match(bootstrap.entry.qrDataUrl ?? "", /^data:image\/test,/);
  assert.equal(bootstrap.entry.providerManaged, true);
  assert.equal(bootstrap.entry.validity, "until-revoked-or-changed");
  assert.equal(bootstrap.connection.state, "awaiting-adapter");
  assert.equal(bootstrap.connection.receiving, false);
  assert.equal(bootstrap.settings.hasSecret, true);
  assert.equal(JSON.stringify(bootstrap).includes('"secret":"secret"'), false);
});

test("keeps pre-consent visitors out of full archives, analysis and local Codex", async (t) => {
  const { root, store, service } = await setup(t);
  const baseEvent = {
    corpId: "ww-corp",
    openKfid: "wk-service",
    externalUserId: "external-hr",
    messageType: "text",
    createdAt: "2026-09-10T02:00:00.000Z"
  };

  const pending = await service.handleVerifiedInbound({
    ...baseEvent,
    channelMessageId: "message-before-consent",
    text: "未同意前的招聘敏感正文"
  });
  assert.equal(pending.disposition, "consent-required");
  assert.equal(pending.localCodexAllowed, false);
  assert.equal(pending.duplicate, false);
  assert.deepEqual(pending.consentPlan?.menu.map((item) => item.id), ["consent:accept", "consent:decline"]);
  assert.equal(store.listOpportunities().length, 0);
  assert.equal(fs.readFileSync(path.join(root, "hr.json"), "utf8").includes("未同意前的招聘敏感正文"), false);

  const accepted = await service.handleVerifiedInbound({
    ...baseEvent,
    channelMessageId: "consent-click",
    text: "同意并获取简历",
    consentAction: "accept"
  });
  assert.equal(accepted.disposition, "archived-isolated");
  assert.equal(accepted.localCodexAllowed, false);
  assert.equal(accepted.visitor.consentStatus, "accepted");
  assert.equal(accepted.visitor.materialsStatus, "pending");
  assert.equal(accepted.postConsentPlan?.text, "候选人简介\n\n感谢关注这个机会。");
  assert.equal(accepted.postConsentPlan?.resume?.name, "candidate.pdf");

  const commandLikeMessage = await service.handleVerifiedInbound({
    ...baseEvent,
    channelMessageId: "visitor-command",
    text: "/bind C:\\sensitive"
  });
  assert.equal(commandLikeMessage.disposition, "archived-isolated");
  assert.equal(commandLikeMessage.localCodexAllowed, false);
  assert.equal(commandLikeMessage.message?.text, "/bind C:\\sensitive");
  assert.equal((await service.setMaterialsDeliveryStatus(
    accepted.visitor.id,
    accepted.postConsentPlan!.deliveryId,
    "sent"
  )).materialsStatus, "sent");
});

test("requires account identity matching and supports explicit decline", async (t) => {
  const { store, service } = await setup(t);
  await assert.rejects(service.handleVerifiedInbound({
    corpId: "ww-other",
    openKfid: "wk-service",
    externalUserId: "external-hr",
    channelMessageId: "wrong-account",
    text: "hello"
  }), /does not match/i);

  const declined = await service.handleVerifiedInbound({
    corpId: "ww-corp",
    openKfid: "wk-service",
    externalUserId: "declined-hr",
    channelMessageId: "decline",
    text: "暂不同意",
    consentAction: "decline"
  });
  assert.equal(declined.disposition, "consent-declined");
  assert.equal(declined.visitor.consentStatus, "declined");
  assert.equal(store.listOpportunities().length, 0);
  await assert.rejects(
    service.setMaterialsDeliveryStatus(declined.visitor.id, "not-a-delivery", "sent"),
    /before visitor consent/i
  );
});

test("uses an injected verified callback adapter without exposing it through localhost", async (t) => {
  const { service } = await setup(t, true);
  assert.deepEqual(service.getConnectionStatus(), {
    state: "ready",
    receiving: true,
    detail: "connected"
  });
});

test("makes consent, material delivery and withdrawal idempotent", async (t) => {
  const { store, service } = await setup(t);
  const base = {
    corpId: "ww-corp",
    openKfid: "wk-service",
    externalUserId: "idempotent-hr"
  };
  await service.handleVerifiedInbound({
    ...base,
    channelMessageId: "hello",
    text: "你好"
  });
  const accepted = await service.handleVerifiedInbound({
    ...base,
    channelMessageId: "accept-1",
    text: "同意并获取简历",
    consentAction: "accept"
  });
  const firstDeliveryId = accepted.postConsentPlan?.deliveryId;
  assert.ok(firstDeliveryId);
  assert.equal(accepted.visitor.consentVersion?.length, 64);
  await assert.rejects(
    service.setMaterialsDeliveryStatus(accepted.visitor.id, "stale-delivery", "sent"),
    /stale|does not match/i
  );
  await service.setMaterialsDeliveryStatus(accepted.visitor.id, firstDeliveryId!, "sent");

  const repeated = await service.handleVerifiedInbound({
    ...base,
    channelMessageId: "accept-1",
    text: "同意并获取简历",
    consentAction: "accept"
  });
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.postConsentPlan, undefined);
  assert.equal(repeated.visitor.materialsStatus, "sent");
  assert.equal(repeated.visitor.materialsDeliveryId, firstDeliveryId);
  const opportunityId = repeated.opportunity!.id;
  assert.equal(store.getOpportunity(opportunityId).messages.length, 1);

  await service.updateSettings({ aiDisclosure: "更新后的 AI 身份与聊天记录用途说明" });
  const resetVisitor = store.findVisitor("wk-service", "idempotent-hr")!;
  assert.equal(resetVisitor.consentStatus, "pending");
  assert.equal(resetVisitor.materialsStatus, "not-sent");
  assert.equal(resetVisitor.consentAt, undefined);
  assert.equal(store.getOpportunity(opportunityId).consentStatus, "pending");

  const blocked = await service.handleVerifiedInbound({
    ...base,
    channelMessageId: "job-before-renewed-consent",
    text: "岗位：安全工程师"
  });
  assert.equal(blocked.disposition, "consent-required");
  assert.equal(store.getOpportunity(opportunityId).messages.length, 1);

  const replayedOldConsent = await service.handleVerifiedInbound({
    ...base,
    channelMessageId: "accept-1",
    text: "同意并获取简历",
    consentAction: "accept"
  });
  assert.equal(replayedOldConsent.disposition, "consent-required");
  assert.equal(replayedOldConsent.duplicate, true);
  assert.equal(replayedOldConsent.visitor.consentStatus, "pending");
  assert.equal(replayedOldConsent.postConsentPlan, undefined);

  const renewed = await service.handleVerifiedInbound({
    ...base,
    channelMessageId: "accept-2",
    text: "同意并获取简历",
    consentAction: "accept"
  });
  assert.ok(renewed.postConsentPlan?.deliveryId);
  assert.notEqual(renewed.postConsentPlan?.deliveryId, firstDeliveryId);
  assert.notEqual(renewed.visitor.consentVersion, accepted.visitor.consentVersion);
  await assert.rejects(
    service.setMaterialsDeliveryStatus(renewed.visitor.id, firstDeliveryId!, "sent"),
    /stale|does not match/i
  );

  const declined = await service.handleVerifiedInbound({
    ...base,
    channelMessageId: "decline-1",
    text: "暂不同意",
    consentAction: "decline"
  });
  assert.equal(declined.visitor.consentStatus, "declined");
  assert.equal(store.getOpportunity(opportunityId).consentStatus, "declined");
  const messageCount = store.getOpportunity(opportunityId).messages.length;
  const afterWithdrawal = await service.handleVerifiedInbound({
    ...base,
    channelMessageId: "after-withdrawal",
    text: "这条正文不应归档"
  });
  assert.equal(afterWithdrawal.disposition, "consent-declined");
  assert.equal(store.getOpportunity(opportunityId).messages.length, messageCount);
  const repeatedDecline = await service.handleVerifiedInbound({
    ...base,
    channelMessageId: "decline-1",
    text: "暂不同意",
    consentAction: "decline"
  });
  assert.equal(repeatedDecline.duplicate, true);
});

test("serializes concurrent consent events and emits one material delivery plan", async (t) => {
  const { service } = await setup(t);
  const base = {
    corpId: "ww-corp",
    openKfid: "wk-service",
    externalUserId: "concurrent-hr"
  };
  await service.handleVerifiedInbound({ ...base, channelMessageId: "hello", text: "你好" });

  const results = await Promise.all([
    service.handleVerifiedInbound({
      ...base,
      channelMessageId: "accept-concurrent-a",
      text: "同意并获取简历",
      consentAction: "accept"
    }),
    service.handleVerifiedInbound({
      ...base,
      channelMessageId: "accept-concurrent-b",
      text: "同意并获取简历",
      consentAction: "accept"
    })
  ]);

  assert.equal(results.filter((result) => result.postConsentPlan).length, 1);
  assert.equal(results.every((result) => result.visitor.consentStatus === "accepted"), true);
  assert.equal(new Set(results.map((result) => result.visitor.materialsDeliveryId)).size, 1);
});
