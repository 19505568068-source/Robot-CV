import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HrWebStore } from "../src/server/hr-web-store.js";

test("persists one stable public entry token while hashing session and CSRF credentials", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-hr-web-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, "hr-web.json");
  const store = new HrWebStore(filePath);
  const initial = store.getSettings();
  assert.match(initial.entryToken, /^[A-Za-z0-9_-]{43}$/u);
  store.updateSettings({
    enabled: true,
    publicBaseUrl: "https://resume.example.com",
    candidateName: "候选人"
  });

  const created = store.createSession(initial.entryToken);
  assert.equal(store.authenticateSession(created.sessionToken).id, created.session.id);
  assert.doesNotThrow(() => store.verifyCsrf(created.session.id, created.csrfToken));
  assert.throws(() => store.verifyCsrf(created.session.id, "x".repeat(43)), /CSRF/i);

  const raw = fs.readFileSync(filePath, "utf8");
  assert.equal(raw.includes(created.sessionToken), false);
  assert.equal(raw.includes(created.csrfToken), false);
  assert.equal(raw.includes(created.session.tokenHash), true);

  const restarted = new HrWebStore(filePath);
  assert.equal(restarted.getSettings().entryToken, initial.entryToken);
  assert.equal(restarted.authenticateSession(created.sessionToken).id, created.session.id);
});

test("rotating the entry invalidates the old QR but preserves already-issued sessions", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-hr-web-rotate-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new HrWebStore(path.join(root, "hr-web.json"));
  store.updateSettings({ enabled: true });
  const oldEntry = store.getSettings().entryToken;
  const existing = store.createSession(oldEntry);

  const rotated = store.rotateEntryToken();
  assert.notEqual(rotated.entryToken, oldEntry);
  assert.equal(rotated.entryRevision, 2);
  assert.throws(() => store.createSession(oldEntry), /entry token/i);
  assert.equal(store.authenticateSession(existing.sessionToken).id, existing.session.id);
  assert.match(store.createSession(rotated.entryToken).sessionToken, /^[A-Za-z0-9_-]{43}$/u);
});

test("disabling web chat blocks both new and existing sessions", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-hr-web-disabled-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new HrWebStore(path.join(root, "hr-web.json"));
  store.updateSettings({ enabled: true });
  const settings = store.getSettings();
  const existing = store.createSession(settings.entryToken);
  store.updateSettings({ enabled: false });

  assert.throws(() => store.createSession(settings.entryToken), /disabled/i);
  assert.throws(() => store.authenticateSession(existing.sessionToken), /disabled/i);
});

test("permits HTTP only for loopback or private-LAN public origins", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-hr-web-origin-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new HrWebStore(path.join(root, "hr-web.json"));

  assert.equal(store.updateSettings({ publicBaseUrl: "http://192.168.1.20:8789" }).publicBaseUrl,
    "http://192.168.1.20:8789");
  assert.equal(store.updateSettings({ publicBaseUrl: "https://resume.example.com" }).publicBaseUrl,
    "https://resume.example.com");
  assert.throws(() => store.updateSettings({ publicBaseUrl: "http://resume.example.com" }), /HTTPS/i);
  assert.throws(() => store.updateSettings({ publicBaseUrl: "https://resume.example.com/chat" }), /origin/i);
});
