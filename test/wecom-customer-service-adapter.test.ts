import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { SecretProtector } from "../src/security/dpapi.js";
import { HrService } from "../src/server/hr-service.js";
import { startWecomCallbackServer } from "../src/server/wecom-callback-server.js";
import {
  OfficialWecomCustomerServiceAdapter,
  stableContactScene,
  type WecomCallbackQuery
} from "../src/server/wecom-customer-service-adapter.js";
import { HrStore } from "../src/state/hr.js";
import { resolveStatePaths } from "../src/state/paths.js";

class FakeProtector implements SecretProtector {
  async protect(secret: string): Promise<string> { return `protected:${Buffer.from(secret).toString("base64")}`; }
  async unprotect(ciphertext: string): Promise<string> { return Buffer.from(ciphertext.slice(10), "base64").toString(); }
}

const corpId = "ww-corp";
const openKfid = "wk-service";
const callbackToken = "callbacktoken";
const encodingAesKey = Buffer.alloc(32, 7).toString("base64").slice(0, 43);

function createStore(t: test.TestContext): { root: string; store: HrStore } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-wecom-adapter-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, store: new HrStore(resolveStatePaths(root), new FakeProtector()) };
}

async function configure(store: HrStore, enabled = true): Promise<void> {
  await store.updateSettings({
    enabled,
    corpId,
    openKfid,
    serviceLink: "https://work.weixin.qq.com/kf/example?enc_scene=stable",
    callbackPublicUrl: "https://hr.example.com/wecom/callback",
    secret: "app-secret",
    token: callbackToken,
    encodingAesKey,
    welcomeMessage: "候选人欢迎语"
  });
}

function encryptPayload(message: string, receiveId = corpId): string {
  const key = Buffer.from(`${encodingAesKey}=`, "base64");
  const messageBuffer = Buffer.from(message);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(messageBuffer.length);
  const plain = Buffer.concat([Buffer.alloc(16, 3), length, messageBuffer, Buffer.from(receiveId)]);
  const paddingLength = 32 - (plain.length % 32);
  const padded = Buffer.concat([plain, Buffer.alloc(paddingLength, paddingLength)]);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
}

function freshTimestamp(offsetSeconds = 0): string {
  return String(Math.floor(Date.now() / 1_000) + offsetSeconds);
}

function signedQuery(encrypted: string, timestamp = freshTimestamp(), nonce = "nonce-1"): WecomCallbackQuery {
  return {
    timestamp,
    nonce,
    msgSignature: crypto.createHash("sha1")
      .update([callbackToken, timestamp, nonce, encrypted].sort().join(""))
      .digest("hex")
  };
}

function callbackBody(encrypted: string): Buffer {
  return Buffer.from(`<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`);
}

function callbackEvent(syncToken: string): string {
  return [
    "<xml>",
    `<ToUserName><![CDATA[${corpId}]]></ToUserName>`,
    "<CreateTime>1789000000</CreateTime>",
    "<MsgType><![CDATA[event]]></MsgType>",
    "<Event><![CDATA[kf_msg_or_event]]></Event>",
    `<Token><![CDATA[${syncToken}]]></Token>`,
    `<OpenKfId><![CDATA[${openKfid}]]></OpenKfId>`,
    "</xml>"
  ].join("");
}

test("verifies and decrypts the public callback without exposing callback secrets", async (t) => {
  const { store } = createStore(t);
  await configure(store);
  let networkCalls = 0;
  const adapter = new OfficialWecomCustomerServiceAdapter({
    store,
    handleInbound: () => { throw new Error("not expected"); },
    archiveOutbound: () => { throw new Error("not expected"); },
    setMaterialsDeliveryStatus: () => { throw new Error("not expected"); },
    getResumeFile: () => { throw new Error("not expected"); },
    fetchImpl: async () => { networkCalls += 1; throw new Error("not expected"); }
  });

  assert.equal(adapter.getStatus().receiving, false);
  const encrypted = encryptPayload("verification-ok");
  assert.equal(await adapter.verifyCallbackUrl(signedQuery(encrypted), encrypted), "verification-ok");
  assert.equal(adapter.getStatus().receiving, true);
  assert.equal(networkCalls, 0);

  await assert.rejects(
    adapter.verifyCallbackUrl({ ...signedQuery(encrypted), msgSignature: "0".repeat(40) }, encrypted),
    /signature is invalid/i
  );
});

test("stays offline while the integration is disabled or incomplete", async (t) => {
  const { store } = createStore(t);
  let networkCalls = 0;
  const adapter = new OfficialWecomCustomerServiceAdapter({
    store,
    handleInbound: () => { throw new Error("not expected"); },
    archiveOutbound: () => { throw new Error("not expected"); },
    setMaterialsDeliveryStatus: () => { throw new Error("not expected"); },
    getResumeFile: () => { throw new Error("not expected"); },
    fetchImpl: async () => { networkCalls += 1; throw new Error("not expected"); }
  });
  const service = new HrService({ store, adapter });

  assert.equal((await service.getBootstrap()).connection.state, "disabled");
  await assert.rejects(adapter.syncMessages("unused", openKfid), /disabled or incomplete/i);
  assert.equal(networkCalls, 0);
});

test("creates and persists an official contact way from a deterministic stable scene", async (t) => {
  const { store } = createStore(t);
  await store.updateSettings({
    corpId,
    openKfid,
    callbackPublicUrl: "https://hr.example.com/wecom/callback",
    secret: "app-secret",
    token: callbackToken,
    encodingAesKey
  });
  const requests: Array<{ pathname: string; body?: Record<string, unknown> }> = [];
  let service!: HrService;
  const adapter = new OfficialWecomCustomerServiceAdapter({
    store,
    handleInbound: (event) => service.handleVerifiedInbound(event),
    archiveOutbound: (event) => service.archiveVerifiedOutbound(event),
    setMaterialsDeliveryStatus: (visitorId, deliveryId, status) =>
      service.setMaterialsDeliveryStatus(visitorId, deliveryId, status),
    getResumeFile: (id) => service.getResumeFile(id),
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      requests.push({
        pathname: url.pathname,
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as Record<string, unknown> } : {})
      });
      if (url.pathname === "/cgi-bin/gettoken") {
        assert.equal(url.searchParams.get("corpid"), corpId);
        assert.equal(url.searchParams.get("corpsecret"), "app-secret");
        return Response.json({ errcode: 0, access_token: "access-token", expires_in: 7200 });
      }
      if (url.pathname === "/cgi-bin/kf/add_contact_way") {
        return Response.json({
          errcode: 0,
          errmsg: "ok",
          url: "https://work.weixin.qq.com/kf/generated?enc_scene=provider-value"
        });
      }
      throw new Error(`unexpected request: ${url.pathname}`);
    }
  });
  service = new HrService({ store, adapter, qrDataUrlFactory: async () => "data:image/png;base64,dGVzdA==" });

  const updated = await service.updateSettings({ enabled: true });
  assert.equal(updated.settings.enabled, true);
  assert.equal(updated.settings.serviceLink, "https://work.weixin.qq.com/kf/generated?enc_scene=provider-value");
  assert.equal(updated.connection.receiving, false);
  assert.deepEqual(requests.map((request) => request.pathname), ["/cgi-bin/gettoken", "/cgi-bin/kf/add_contact_way"]);
  assert.equal(requests[1].body?.scene, stableContactScene(updated.settings.stableId));
  assert.match(String(requests[1].body?.scene), /^[0-9a-zA-Z_-]{1,32}$/);
});

test("syncs every cursor page and keeps message bodies behind the consent gate", async (t) => {
  const { root, store } = createStore(t);
  await configure(store);
  const resumePath = path.join(root, "resume.pdf");
  fs.writeFileSync(resumePath, "%PDF-1.4\nresume\n");
  const disclosure = "a".repeat(1_024);
  await store.updateMaterials({ disclosure, bio: "候选人简介", resumePath });

  let syncCall = 0;
  let sentCounter = 0;
  let uploadCount = 0;
  const sentPayloads: Array<{ path: string; body?: Record<string, unknown> }> = [];
  let service!: HrService;
  const adapter = new OfficialWecomCustomerServiceAdapter({
    store,
    handleInbound: (event) => service.handleVerifiedInbound(event),
    archiveOutbound: (event) => service.archiveVerifiedOutbound(event),
    setMaterialsDeliveryStatus: (visitorId, deliveryId, status) =>
      service.setMaterialsDeliveryStatus(visitorId, deliveryId, status),
    getResumeFile: (id) => service.getResumeFile(id),
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      if (url.pathname === "/cgi-bin/gettoken") {
        return Response.json({ errcode: 0, access_token: "access-token", expires_in: 7200 });
      }
      if (url.pathname === "/cgi-bin/kf/sync_msg") {
        syncCall += 1;
        const request = JSON.parse(String(init?.body)) as { cursor?: string; token: string; open_kfid: string };
        assert.equal(request.open_kfid, openKfid);
        assert.match(request.token, /^sync-token-/);
        if (syncCall === 1) {
          assert.equal(request.cursor, undefined);
          return Response.json({ errcode: 0, next_cursor: "cursor-1", has_more: 1, msg_list: [] });
        }
        if (syncCall === 2) {
          assert.equal(request.cursor, "cursor-1");
          return Response.json({
            errcode: 0,
            next_cursor: "cursor-2",
            has_more: 0,
            msg_list: [
              {
                msgid: "enter-session",
                send_time: 1789000000,
                origin: 4,
                msgtype: "event",
                event: { event_type: "enter_session", open_kfid: openKfid, external_userid: "external-hr", welcome_code: "welcome-once" }
              },
              {
                msgid: "sensitive-before-consent",
                open_kfid: openKfid,
                external_userid: "external-hr",
                send_time: 1789000001,
                origin: 3,
                msgtype: "text",
                text: { content: "未同意前不可存档的招聘正文" }
              }
            ]
          });
        }
        assert.equal(request.cursor, "cursor-2");
        return Response.json({
          errcode: 0,
          next_cursor: "cursor-3",
          has_more: 0,
          msg_list: [{
            msgid: "accept-consent",
            open_kfid: openKfid,
            external_userid: "external-hr",
            send_time: 1789000002,
            origin: 3,
            msgtype: "text",
            text: { content: "同意并获取简历", menu_id: "consent:accept" }
          }]
        });
      }
      if (url.pathname === "/cgi-bin/media/upload") {
        uploadCount += 1;
        assert.equal(url.searchParams.get("type"), "file");
        assert.ok(init?.body instanceof FormData);
        return Response.json({ errcode: 0, media_id: "resume-media" });
      }
      if (url.pathname === "/cgi-bin/kf/send_msg" || url.pathname === "/cgi-bin/kf/send_msg_on_event") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sentPayloads.push({ path: url.pathname, body });
        sentCounter += 1;
        return Response.json({ errcode: 0, errmsg: "ok", msgid: `sent-${sentCounter}` });
      }
      throw new Error(`unexpected request: ${url.pathname}`);
    }
  });
  service = new HrService({ store, adapter });

  const firstEvent = encryptPayload(callbackEvent("sync-token-1"));
  await adapter.acceptCallback(signedQuery(firstEvent, freshTimestamp(), "nonce-1"), callbackBody(firstEvent));
  await adapter.waitForIdle();
  assert.equal(store.getSyncCursor(openKfid), "cursor-2");
  assert.equal(store.listOpportunities().length, 0);
  assert.equal(fs.readFileSync(path.join(root, "hr.json"), "utf8").includes("未同意前不可存档的招聘正文"), false);
  const welcomePayload = sentPayloads.find((item) => item.path.endsWith("send_msg_on_event"))?.body as {
    msgtype?: string;
    msgmenu?: { head_content?: string };
    file?: unknown;
  } | undefined;
  assert.equal(welcomePayload?.msgtype, "msgmenu");
  assert.equal("file" in (welcomePayload ?? {}), false);
  assert.equal(welcomePayload?.msgmenu?.head_content, disclosure);

  const secondEvent = encryptPayload(callbackEvent("sync-token-2"));
  await adapter.acceptCallback(signedQuery(secondEvent, freshTimestamp(1), "nonce-2"), callbackBody(secondEvent));
  await adapter.waitForIdle();
  assert.equal(store.getSyncCursor(openKfid), "cursor-3");
  assert.equal(store.listOpportunities().length, 1);
  const visitor = store.findVisitor(openKfid, "external-hr");
  assert.equal(visitor?.consentStatus, "accepted");
  assert.equal(visitor?.materialsStatus, "sent");
  assert.equal(uploadCount, 1);
  assert.ok(sentPayloads.some((item) => item.body?.msgtype === "file"));
  assert.equal(sentPayloads.every((item) => !Object.hasOwn(item.body ?? {}, "msgid")), true);
});

test("prioritizes enter-session consent, falls back from an expired welcome code and retries a later replay", async (t) => {
  const { root, store } = createStore(t);
  await configure(store);
  const sensitiveText = "未同意前不得存档";
  let syncCall = 0;
  const outbound: Array<{ path: string; body: Record<string, unknown> }> = [];
  let service!: HrService;
  const adapter = new OfficialWecomCustomerServiceAdapter({
    store,
    handleInbound: (event) => service.handleVerifiedInbound(event),
    archiveOutbound: (event) => service.archiveVerifiedOutbound(event),
    setMaterialsDeliveryStatus: (visitorId, deliveryId, status) =>
      service.setMaterialsDeliveryStatus(visitorId, deliveryId, status),
    getResumeFile: (id) => service.getResumeFile(id),
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      if (url.pathname === "/cgi-bin/gettoken") {
        return Response.json({ errcode: 0, access_token: "access-token", expires_in: 7200 });
      }
      if (url.pathname === "/cgi-bin/kf/sync_msg") {
        syncCall += 1;
        return Response.json({
          errcode: 0,
          next_cursor: `pending-cursor-${syncCall}`,
          has_more: 0,
          msg_list: syncCall === 1 ? [
            {
              msgid: "pending-text",
              open_kfid: openKfid,
              external_userid: "pending-hr",
              send_time: 1789000101,
              origin: 3,
              msgtype: "text",
              text: { content: sensitiveText }
            },
            {
              msgid: "pending-enter",
              send_time: 1789000100,
              origin: 4,
              msgtype: "event",
              event: {
                event_type: "enter_session",
                open_kfid: openKfid,
                external_userid: "pending-hr",
                welcome_code: "expired-welcome-code"
              }
            }
          ] : [{
            msgid: "pending-text",
            open_kfid: openKfid,
            external_userid: "pending-hr",
            send_time: 1789000101,
            origin: 3,
            msgtype: "text",
            text: { content: sensitiveText }
          }]
        });
      }
      if (url.pathname === "/cgi-bin/kf/send_msg_on_event") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        outbound.push({ path: url.pathname, body });
        return Response.json({ errcode: 95013, errmsg: "welcome code expired" });
      }
      if (url.pathname === "/cgi-bin/kf/send_msg") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        outbound.push({ path: url.pathname, body });
        return Response.json({ errcode: 0, errmsg: "ok", msgid: `prompt-${outbound.length}` });
      }
      throw new Error(`unexpected request: ${url.pathname}`);
    }
  });
  service = new HrService({ store, adapter });

  await adapter.syncMessages("pending-sync-1", openKfid);
  assert.deepEqual(outbound.map((request) => request.path), [
    "/cgi-bin/kf/send_msg_on_event",
    "/cgi-bin/kf/send_msg"
  ]);
  assert.equal(store.listOpportunities().length, 0);
  assert.equal(fs.readFileSync(path.join(root, "hr.json"), "utf8").includes(sensitiveText), false);

  await adapter.syncMessages("pending-sync-2", openKfid);
  assert.deepEqual(outbound.map((request) => request.path), [
    "/cgi-bin/kf/send_msg_on_event",
    "/cgi-bin/kf/send_msg",
    "/cgi-bin/kf/send_msg"
  ]);
  assert.equal(outbound.every((request) => !Object.hasOwn(request.body, "msgid")), true);
});

test("persists partial material progress, handles a late send failure and retries only the failed PDF", async (t) => {
  const { root, store } = createStore(t);
  await configure(store);
  const paths = resolveStatePaths(root);
  const resumePath = path.join(root, "resume.pdf");
  fs.writeFileSync(resumePath, "%PDF-1.4\nresume\n");
  await store.updateMaterials({ bio: "只应发送一次的候选人简介", resumePath });

  let syncCall = 0;
  let uploadCount = 0;
  let introSendCount = 0;
  let fileSendCount = 0;
  const outboundBodies: Record<string, unknown>[] = [];
  const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    if (url.pathname === "/cgi-bin/gettoken") {
      return Response.json({ errcode: 0, access_token: `access-token-${syncCall}`, expires_in: 7200 });
    }
    if (url.pathname === "/cgi-bin/kf/sync_msg") {
      syncCall += 1;
      if (syncCall === 3) {
        return Response.json({
          errcode: 0,
          next_cursor: "material-cursor-3",
          has_more: 0,
          msg_list: [{
            msgid: "late-failure-event",
            send_time: 1789000203,
            origin: 4,
            msgtype: "event",
            event: { event_type: "msg_send_fail", fail_msgid: "resume-provider-2" }
          }]
        });
      }
      const retryAfterFailure = syncCall === 4;
      return Response.json({
        errcode: 0,
        next_cursor: `material-cursor-${syncCall}`,
        has_more: 0,
        msg_list: [{
          msgid: retryAfterFailure ? "accept-material-retry" : "accept-material",
          open_kfid: openKfid,
          external_userid: "materials-hr",
          send_time: 1789000200 + syncCall,
          origin: 3,
          msgtype: "text",
          text: { content: "同意并获取简历", menu_id: "consent:accept" }
        }]
      });
    }
    if (url.pathname === "/cgi-bin/media/upload") {
      uploadCount += 1;
      return Response.json({ errcode: 0, media_id: `resume-media-${uploadCount}` });
    }
    if (url.pathname === "/cgi-bin/kf/send_msg") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      outboundBodies.push(body);
      if (body.msgtype === "text") {
        introSendCount += 1;
        return Response.json({ errcode: 0, errmsg: "ok", msgid: "intro-provider-1" });
      }
      fileSendCount += 1;
      if (fileSendCount === 1) {
        return Response.json({ errcode: 95000, errmsg: "temporary file send failure" });
      }
      return Response.json({
        errcode: 0,
        errmsg: "ok",
        msgid: fileSendCount === 2 ? "resume-provider-2" : "resume-provider-3"
      });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  };

  function createRuntime(runtimeStore: HrStore): { adapter: OfficialWecomCustomerServiceAdapter; service: HrService } {
    let runtimeService!: HrService;
    const runtimeAdapter = new OfficialWecomCustomerServiceAdapter({
      store: runtimeStore,
      handleInbound: (event) => runtimeService.handleVerifiedInbound(event),
      archiveOutbound: (event) => runtimeService.archiveVerifiedOutbound(event),
      setMaterialsDeliveryStatus: (visitorId, deliveryId, status) =>
        runtimeService.setMaterialsDeliveryStatus(visitorId, deliveryId, status),
      getResumeFile: (id) => runtimeService.getResumeFile(id),
      fetchImpl
    });
    runtimeService = new HrService({ store: runtimeStore, adapter: runtimeAdapter });
    return { adapter: runtimeAdapter, service: runtimeService };
  }

  const firstRuntime = createRuntime(store);
  await assert.rejects(firstRuntime.adapter.syncMessages("materials-sync-1", openKfid), /API error 95000/i);
  let visitor = store.findVisitor(openKfid, "materials-hr");
  assert.equal(visitor?.materialsStatus, "failed");
  let delivery = store.getMaterialDelivery(visitor!.materialsDeliveryId!);
  assert.equal(delivery?.components.intro?.status, "submitted");
  assert.equal(delivery?.components.resume?.status, "failed");

  await firstRuntime.adapter.syncMessages("materials-sync-2", openKfid);
  visitor = store.findVisitor(openKfid, "materials-hr");
  assert.equal(visitor?.materialsStatus, "sent");
  assert.equal(introSendCount, 1);
  assert.equal(fileSendCount, 2);
  assert.equal(uploadCount, 2);

  const restartedStore = new HrStore(paths, new FakeProtector());
  const restartedRuntime = createRuntime(restartedStore);
  delivery = restartedStore.getMaterialDelivery(visitor!.materialsDeliveryId!);
  assert.equal(delivery?.components.resume?.providerMessageId, "resume-provider-2");
  assert.deepEqual(delivery?.components.resume?.providerMessageIds, ["resume-provider-2"]);

  await restartedRuntime.adapter.syncMessages("materials-sync-3", openKfid);
  visitor = restartedStore.findVisitor(openKfid, "materials-hr");
  assert.equal(visitor?.materialsStatus, "failed");
  assert.equal(restartedStore.getMaterialDelivery(visitor!.materialsDeliveryId!)?.components.resume?.status, "failed");

  await restartedRuntime.adapter.syncMessages("materials-sync-4", openKfid);
  visitor = restartedStore.findVisitor(openKfid, "materials-hr");
  assert.equal(visitor?.materialsStatus, "sent");
  assert.equal(introSendCount, 1);
  assert.equal(fileSendCount, 3);
  assert.equal(uploadCount, 3);
  delivery = restartedStore.getMaterialDelivery(visitor!.materialsDeliveryId!);
  assert.equal(delivery?.components.intro?.providerMessageId, "intro-provider-1");
  assert.equal(delivery?.components.resume?.providerMessageId, "resume-provider-3");
  assert.deepEqual(delivery?.components.resume?.providerMessageIds, ["resume-provider-2", "resume-provider-3"]);
  assert.equal(outboundBodies.every((body) => !Object.hasOwn(body, "msgid")), true);
});

test("sends a narrow AI reply only for a non-duplicate accepted HR text message", async (t) => {
  const { store } = createStore(t);
  await configure(store);
  const visitor = (await store.recordPreConsentEvent({
    channelMessageId: "enter-ai",
    openKfid,
    externalUserId: "external-ai"
  })).visitor;
  await store.setVisitorConsent(visitor.id, "accepted");
  const sentTexts: string[] = [];
  let aiCalls = 0;
  let service!: HrService;
  const adapter = new OfficialWecomCustomerServiceAdapter({
    store,
    handleInbound: (event) => service.handleVerifiedInbound(event),
    archiveOutbound: (event) => service.archiveVerifiedOutbound(event),
    setMaterialsDeliveryStatus: (visitorId, deliveryId, status) =>
      service.setMaterialsDeliveryStatus(visitorId, deliveryId, status),
    getResumeFile: (id) => service.getResumeFile(id),
    generateAiReply: async (event, disposition) => {
      aiCalls += 1;
      assert.equal(event.text, "请介绍支付项目");
      assert.equal(disposition.localCodexAllowed, false);
      return "候选人负责过支付幂等项目，具体范围以简历资料为准。";
    },
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      if (url.pathname === "/cgi-bin/gettoken") {
        return Response.json({ errcode: 0, access_token: "access-token", expires_in: 7200 });
      }
      if (url.pathname === "/cgi-bin/kf/sync_msg") {
        return Response.json({
          errcode: 0,
          next_cursor: "cursor-ai",
          has_more: 0,
          msg_list: [{
            msgid: "question-ai",
            open_kfid: openKfid,
            external_userid: "external-ai",
            send_time: 1789000010,
            origin: 3,
            msgtype: "text",
            text: { content: "请介绍支付项目" }
          }]
        });
      }
      if (url.pathname === "/cgi-bin/kf/send_msg") {
        const payload = JSON.parse(String(init?.body)) as { text?: { content?: string } };
        sentTexts.push(payload.text?.content ?? "");
        return Response.json({ errcode: 0, errmsg: "ok", msgid: "sent-ai-reply" });
      }
      throw new Error(`unexpected request: ${url.pathname}`);
    }
  });
  service = new HrService({ store, adapter });

  await adapter.syncMessages("sync-ai", openKfid);
  assert.equal(aiCalls, 1);
  assert.deepEqual(sentTexts, ["候选人负责过支付幂等项目，具体范围以简历资料为准。"]) ;
  const opportunity = store.listOpportunities()[0];
  assert.ok(opportunity);
  const messages = store.getOpportunity(opportunity.id).messages;
  assert.deepEqual(messages.map((message) => message.direction), ["inbound", "outbound"]);
  assert.equal(messages[1]?.text, sentTexts[0]);

  await adapter.syncMessages("sync-ai-retry", openKfid);
  assert.equal(aiCalls, 1);
});

test("deduplicates callback replays and reconciles from the stored cursor without a callback token", async (t) => {
  const { store } = createStore(t);
  await configure(store);
  const syncBodies: Array<Record<string, unknown>> = [];
  let service!: HrService;
  const adapter = new OfficialWecomCustomerServiceAdapter({
    store,
    handleInbound: (event) => service.handleVerifiedInbound(event),
    archiveOutbound: (event) => service.archiveVerifiedOutbound(event),
    setMaterialsDeliveryStatus: (visitorId, deliveryId, status) =>
      service.setMaterialsDeliveryStatus(visitorId, deliveryId, status),
    getResumeFile: (id) => service.getResumeFile(id),
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      if (url.pathname === "/cgi-bin/gettoken") {
        return Response.json({ errcode: 0, access_token: "access-token", expires_in: 7200 });
      }
      if (url.pathname === "/cgi-bin/kf/sync_msg") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        syncBodies.push(body);
        return Response.json({
          errcode: 0,
          next_cursor: `replay-cursor-${syncBodies.length}`,
          has_more: 0,
          msg_list: []
        });
      }
      throw new Error(`unexpected request: ${url.pathname}`);
    }
  });
  service = new HrService({ store, adapter });

  const encrypted = encryptPayload(callbackEvent("short-lived-sync-token"));
  const query = signedQuery(encrypted, freshTimestamp(2), "replay-nonce");
  await Promise.all([
    adapter.acceptCallback(query, callbackBody(encrypted)),
    adapter.acceptCallback(query, callbackBody(encrypted))
  ]);
  await adapter.waitForIdle();
  assert.equal(syncBodies.length, 1);
  assert.equal(syncBodies[0]?.token, "short-lived-sync-token");

  await adapter.reconcileMessages();
  assert.equal(syncBodies.length, 2);
  assert.equal(Object.hasOwn(syncBodies[1]!, "token"), false);
  assert.equal(syncBodies[1]?.cursor, "replay-cursor-1");
});

test("serves encrypted callbacks on a dedicated listener", async (t) => {
  const { root, store } = createStore(t);
  await configure(store);
  let releaseSync!: () => void;
  const syncGate = new Promise<void>((resolve) => { releaseSync = resolve; });
  let service!: HrService;
  const adapter = new OfficialWecomCustomerServiceAdapter({
    store,
    handleInbound: (event) => service.handleVerifiedInbound(event),
    archiveOutbound: (event) => service.archiveVerifiedOutbound(event),
    setMaterialsDeliveryStatus: (visitorId, deliveryId, status) =>
      service.setMaterialsDeliveryStatus(visitorId, deliveryId, status),
    getResumeFile: (id) => service.getResumeFile(id),
    fetchImpl: async (input) => {
      const url = new URL(input);
      if (url.pathname === "/cgi-bin/gettoken") {
        return Response.json({ errcode: 0, access_token: "access-token", expires_in: 7200 });
      }
      if (url.pathname === "/cgi-bin/kf/sync_msg") {
        await syncGate;
        return Response.json({ errcode: 0, next_cursor: "cursor-http", has_more: 0, msg_list: [] });
      }
      throw new Error(`unexpected request: ${url.pathname}`);
    }
  });
  service = new HrService({ store, adapter });
  const server = await startWecomCallbackServer({
    hrService: service,
    port: 0
  });
  t.after(() => server.close());
  service.setCallbackListenerUrl(`${server.url}/wecom/callback`);
  assert.equal((await service.getEntry()).localCallbackTarget, `${server.url}/wecom/callback`);

  const echo = encryptPayload("public-verification-ok");
  const query = signedQuery(echo);
  const verificationUrl = new URL("/wecom/callback", server.url);
  verificationUrl.searchParams.set("msg_signature", query.msgSignature);
  verificationUrl.searchParams.set("timestamp", query.timestamp);
  verificationUrl.searchParams.set("nonce", query.nonce);
  verificationUrl.searchParams.set("echostr", echo);
  const verified = await fetch(verificationUrl, { headers: { Host: "hr.example.com" } });
  assert.equal(verified.status, 200);
  assert.equal(await verified.text(), "public-verification-ok");

  const encryptedEvent = encryptPayload(callbackEvent("sync-token-http"));
  const eventQuery = signedQuery(encryptedEvent, freshTimestamp(3), "nonce-http");
  const eventUrl = new URL("/wecom/callback", server.url);
  eventUrl.searchParams.set("msg_signature", eventQuery.msgSignature);
  eventUrl.searchParams.set("timestamp", eventQuery.timestamp);
  eventUrl.searchParams.set("nonce", eventQuery.nonce);
  const callback = await fetch(eventUrl, {
    method: "POST",
    headers: { Host: "hr.example.com", "Content-Type": "application/xml" },
    body: callbackBody(encryptedEvent)
  });
  assert.equal(callback.status, 200);
  assert.equal(await callback.text(), "success");
  assert.equal(store.getSyncCursor(openKfid), undefined);
  releaseSync();
  await adapter.waitForIdle();
  assert.equal(store.getSyncCursor(openKfid), "cursor-http");
});
