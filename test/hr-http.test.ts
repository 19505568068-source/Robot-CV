import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HrService } from "../src/server/hr-service.js";
import { startLocalHttpServer } from "../src/server/http-server.js";
import type { SecretProtector } from "../src/security/dpapi.js";
import { HrStore } from "../src/state/hr.js";
import { resolveStatePaths } from "../src/state/paths.js";

class FakeProtector implements SecretProtector {
  async protect(secret: string): Promise<string> { return Buffer.from(`encrypted:${secret}`).toString("base64"); }
  async unprotect(ciphertext: string): Promise<string> { return Buffer.from(ciphertext, "base64").toString().slice(10); }
}

test("HR management API protects mutations, redacts secrets and exposes reviewable opportunities", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-hr-http-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);
  const store = new HrStore(paths, new FakeProtector());
  const hrService = new HrService({ store, qrDataUrlFactory: async () => "data:image/png;base64,dGVzdA==" });
  const server = await startLocalHttpServer({
    paths,
    hrService,
    port: 0
  });
  t.after(() => server.close());
  const headers = {
    "Content-Type": "application/json",
    "X-Codex-Weixin-Token": server.requestToken,
    Origin: server.url
  };
  const settingsBody = {
    enabled: true,
    corpId: "ww-corp",
    openKfId: "wk-service",
    contactUrl: "https://work.weixin.qq.com/kf/example?scene=long-lived",
    callbackUrl: "https://callback.example.com/wecom/callback",
    secret: "must-not-leak",
    token: "callbacktoken",
    encodingAesKey: "k".repeat(43),
    targetRoles: ["后端工程师"],
    profileKeywords: ["TypeScript"]
  };

  const unauthorized = await fetch(`${server.url}/api/hr/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settingsBody)
  });
  assert.equal(unauthorized.status, 403);

  const configured = await fetch(`${server.url}/api/hr/settings`, {
    method: "PUT",
    headers,
    body: JSON.stringify(settingsBody)
  });
  assert.equal(configured.status, 200);
  const configuredJson = await configured.json() as {
    settings: { openKfId: string; hasSecret: boolean; secret?: string };
    connection: { state: string; receiving: boolean };
  };
  assert.equal(configuredJson.settings.openKfId, "wk-service");
  assert.equal(configuredJson.settings.hasSecret, true);
  assert.equal(configuredJson.settings.secret, undefined);
  assert.deepEqual(configuredJson.connection, {
    state: "awaiting-adapter",
    receiving: false,
    detail: "配置已保存；公网加密回调适配器尚未安装，本机管理 API 不接收企业微信回调"
  });

  const bootstrap = await (await fetch(`${server.url}/api/hr/bootstrap`)).json() as {
    entry: { publicLink: string; qrDataUrl: string; providerManaged: boolean; validity: string };
    materials: { supported: boolean };
  };
  assert.equal(bootstrap.entry.publicLink, settingsBody.contactUrl);
  assert.match(bootstrap.entry.qrDataUrl, /^data:image\/png/);
  assert.equal(bootstrap.entry.providerManaged, true);
  assert.equal(bootstrap.entry.validity, "until-revoked-or-changed");
  assert.equal(bootstrap.materials.supported, true);

  const preConsent = (await store.recordPreConsentEvent({
    channelMessageId: "first",
    openKfid: "wk-service",
    externalUserId: "external-hr"
  })).visitor;
  await store.setVisitorConsent(preConsent.id, "accepted");
  const opportunity = (await store.archiveInbound({
    channelMessageId: "job",
    openKfid: "wk-service",
    externalUserId: "external-hr",
    text: "岗位：TypeScript 后端工程师，邀请你周五上午面试。"
  })).opportunity;

  const list = await (await fetch(`${server.url}/api/hr/opportunities`)).json() as {
    opportunities: Array<{ id: string; invitationScore: number; fitScore?: number }>;
  };
  assert.equal(list.opportunities[0]?.id, opportunity.id);
  assert.ok((list.opportunities[0]?.invitationScore ?? 0) >= 70);
  assert.ok((list.opportunities[0]?.fitScore ?? 0) >= 70);

  const detail = await (await fetch(`${server.url}/api/hr/opportunities/${opportunity.id}`)).json() as {
    opportunity: { messages: Array<{ text: string }>; evidence: Array<{ messageId: string }> };
  };
  assert.equal(detail.opportunity.messages[0]?.text.includes("TypeScript"), true);
  assert.equal(detail.opportunity.evidence.every((item) => Boolean(item.messageId)), true);

  const generated = await fetch(`${server.url}/api/hr/opportunities/${opportunity.id}/actions/interview-advice`, {
    method: "POST",
    headers,
    body: "{}"
  });
  assert.equal(generated.status, 201);
  const generatedJson = await generated.json() as {
    draft: { id: string; status: string; generator: string; isAiGenerated: boolean };
    generation: { mode: string; ai: boolean };
  };
  assert.equal(generatedJson.draft.generator, "local-template");
  assert.equal(generatedJson.draft.isAiGenerated, false);
  assert.deepEqual(generatedJson.generation, { mode: "local-template", ai: false });

  const reviewed = await fetch(`${server.url}/api/hr/drafts/${generatedJson.draft.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ status: "approved" })
  });
  assert.equal(reviewed.status, 200);
  assert.equal((await reviewed.json() as { draft: { status: string } }).draft.status, "approved");

  const resumePath = path.join(root, "resume.pdf");
  fs.writeFileSync(resumePath, "%PDF-1.4\nresume body\n");
  const materials = await fetch(`${server.url}/api/hr/materials`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ bio: "candidate bio", resumePath })
  });
  assert.equal(materials.status, 200);
  const materialJson = await materials.json() as { materials: { resume: { url: string; hash: string } } };
  assert.equal(materialJson.materials.resume.hash.length, 64);
  const resume = await fetch(`${server.url}${materialJson.materials.resume.url}`);
  assert.equal(resume.status, 200);
  assert.equal(resume.headers.get("content-type"), "application/pdf");
  assert.match(await resume.text(), /^%PDF-1\.4/);
});

test("main bootstrap identifies HR mode and hides retained personal accounts", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-hr-bootstrap-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);
  const hrService = new HrService({ store: new HrStore(paths, new FakeProtector()) });
  const server = await startLocalHttpServer({
    paths,
    hrService,
    port: 0
  });
  t.after(() => server.close());

  const bootstrap = await (await fetch(`${server.url}/api/bootstrap`)).json() as {
    product: string;
    accounts: unknown[];
    sessions: unknown[];
    hr: unknown;
  };
  assert.equal(bootstrap.product, "微信扫码 HR ClawBot");
  assert.deepEqual(bootstrap.accounts, []);
  assert.deepEqual(bootstrap.sessions, []);
  assert.ok(bootstrap.hr);

  for (const retiredPath of [
    "/api/accounts",
    "/api/accounts/legacy-account/start",
    "/api/logins",
    "/api/logins/legacy-login",
    "/api/sessions",
    "/api/sessions/legacy-account/legacy-session/messages",
    "/api/config",
    "/api/api-profiles"
  ]) {
    const response = await fetch(`${server.url}${retiredPath}`);
    assert.equal(response.status, 410, retiredPath);
    assert.equal((await response.json() as { code?: string }).code, "HR_ONLY", retiredPath);
  }

  const retiredMutation = await fetch(`${server.url}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  assert.equal(retiredMutation.status, 410);
  assert.equal((await retiredMutation.json() as { code?: string }).code, "HR_ONLY");
});

test("local HR material uploads validate content, use random storage names and append knowledge", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-hr-upload-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);
  const store = new HrStore(paths, new FakeProtector());
  const hrService = new HrService({ store });
  const server = await startLocalHttpServer({ paths, hrService, port: 0 });
  t.after(() => server.close());

  const uploadHeaders = (fileName: string, contentType: string, includeToken = true) => ({
    "Content-Type": contentType,
    "X-Codex-Weixin-Filename": encodeURIComponent(fileName),
    ...(includeToken ? { "X-Codex-Weixin-Token": server.requestToken } : {}),
    Origin: server.url
  });

  const unauthorized = await fetch(`${server.url}/api/hr/materials/uploads/resume`, {
    method: "POST",
    headers: uploadHeaders("resume.pdf", "application/pdf", false),
    body: Buffer.from("%PDF-1.4\nresume\n")
  });
  assert.equal(unauthorized.status, 403);

  const unsafeName = await fetch(`${server.url}/api/hr/materials/uploads/resume`, {
    method: "POST",
    headers: uploadHeaders("../resume.pdf", "application/pdf"),
    body: Buffer.from("%PDF-1.4\nresume\n")
  });
  assert.equal(unsafeName.status, 400);

  const invalidPdf = await fetch(`${server.url}/api/hr/materials/uploads/resume`, {
    method: "POST",
    headers: uploadHeaders("resume.pdf", "application/pdf"),
    body: Buffer.from("not a pdf")
  });
  assert.equal(invalidPdf.status, 400);
  assert.equal(fs.existsSync(path.join(paths.hrMaterialsDir, "resumes")), false);

  const mismatchedMime = await fetch(`${server.url}/api/hr/materials/uploads/resume`, {
    method: "POST",
    headers: uploadHeaders("resume.pdf", "text/plain"),
    body: Buffer.from("%PDF-1.4\nresume\n")
  });
  assert.equal(mismatchedMime.status, 400);
  assert.equal(fs.existsSync(path.join(paths.hrMaterialsDir, "resumes")), false);

  const uploadedResume = await fetch(`${server.url}/api/hr/materials/uploads/resume`, {
    method: "POST",
    headers: uploadHeaders("候选人简历.pdf", "application/pdf"),
    body: Buffer.from("%PDF-1.4\nresume body\n")
  });
  assert.equal(uploadedResume.status, 201);
  const resumeJson = await uploadedResume.json() as {
    uploaded: { kind: string; name: string; size: number; path?: string };
    materials: { resume: { name?: string; hash?: string; path?: string } };
  };
  assert.equal(resumeJson.uploaded.kind, "resume");
  assert.equal(resumeJson.uploaded.name, "候选人简历.pdf");
  assert.equal(resumeJson.uploaded.path, undefined);
  assert.equal(resumeJson.materials.resume.name, "候选人简历.pdf");
  assert.equal(resumeJson.materials.resume.path, undefined);
  assert.equal(resumeJson.materials.resume.hash?.length, 64);
  const resumeFiles = fs.readdirSync(path.join(paths.hrMaterialsDir, "resumes"));
  assert.equal(resumeFiles.length, 1);
  assert.match(resumeFiles[0], /^[0-9a-f-]{36}\.pdf$/u);
  assert.notEqual(resumeFiles[0], "候选人简历.pdf");

  const existingKnowledgePath = path.join(root, "existing.txt");
  fs.writeFileSync(existingKnowledgePath, "existing knowledge", "utf8");
  await hrService.updateMaterials({ knowledgeBasePaths: [existingKnowledgePath] });

  const uploadedKnowledge = await fetch(`${server.url}/api/hr/materials/uploads/knowledge`, {
    method: "POST",
    headers: uploadHeaders("project-notes.md", "text/markdown"),
    body: Buffer.from("# Project\nTypeScript delivery details", "utf8")
  });
  assert.equal(uploadedKnowledge.status, 201);
  const knowledgeJson = await uploadedKnowledge.json() as {
    uploaded: { name: string; path?: string };
    materials: {
      knowledgeBase: {
        documentCount: number;
        documents: Array<{ name: string; path?: string }>;
      };
    };
  };
  assert.equal(knowledgeJson.uploaded.name, "project-notes.md");
  assert.equal(knowledgeJson.uploaded.path, undefined);
  assert.equal(knowledgeJson.materials.knowledgeBase.documentCount, 2);
  assert.deepEqual(
    knowledgeJson.materials.knowledgeBase.documents.map((document) => document.name),
    ["existing.txt", "project-notes.md"]
  );
  assert.equal(knowledgeJson.materials.knowledgeBase.documents.some((document) => "path" in document), false);
  const knowledgeFiles = fs.readdirSync(path.join(paths.hrMaterialsDir, "knowledge"));
  assert.equal(knowledgeFiles.length, 1);
  assert.match(knowledgeFiles[0], /^[0-9a-f-]{36}\.md$/u);
  assert.notEqual(knowledgeFiles[0], "project-notes.md");

  const invalidUtf8 = await fetch(`${server.url}/api/hr/materials/uploads/knowledge`, {
    method: "POST",
    headers: uploadHeaders("broken.txt", "text/plain"),
    body: Buffer.from([0xc3, 0x28])
  });
  assert.equal(invalidUtf8.status, 400);
  assert.deepEqual(fs.readdirSync(path.join(paths.hrMaterialsDir, "knowledge")), knowledgeFiles);

  const invalidDocx = await fetch(`${server.url}/api/hr/materials/uploads/knowledge`, {
    method: "POST",
    headers: uploadHeaders("fake.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    body: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])
  });
  assert.equal(invalidDocx.status, 400);
  assert.deepEqual(fs.readdirSync(path.join(paths.hrMaterialsDir, "knowledge")), knowledgeFiles);

  const leakedResponse = JSON.stringify(knowledgeJson);
  assert.equal(leakedResponse.includes("existingKnowledgePath"), false);
  assert.equal(Object.values(resumeJson.uploaded).some((value) => typeof value === "string" && path.isAbsolute(value)), false);
});
