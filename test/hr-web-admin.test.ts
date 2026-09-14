import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { SecretProtector } from "../src/security/dpapi.js";
import { HrService } from "../src/server/hr-service.js";
import { HrWebAdminService } from "../src/server/hr-web-admin-service.js";
import { HrWebStore } from "../src/server/hr-web-store.js";
import { startLocalHttpServer } from "../src/server/http-server.js";
import { HrStore } from "../src/state/hr.js";
import { resolveStatePaths } from "../src/state/paths.js";

class FakeProtector implements SecretProtector {
  async protect(value: string): Promise<string> { return `protected:${value}`; }
  async unprotect(value: string): Promise<string> { return value.slice("protected:".length); }
}

test("manages the H5 entry locally without exposing its entry token", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-hr-web-admin-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);
  const webStore = new HrWebStore(path.join(root, "hr-web.json"));
  const admin = new HrWebAdminService({
    store: webStore,
    host: "127.0.0.1",
    port: 8789,
    listenerUrl: "http://127.0.0.1:8789",
    qrDataUrlFactory: async () => "data:image/png;base64,dGVzdA=="
  });
  const server = await startLocalHttpServer({
    paths,
    hrService: new HrService({ store: new HrStore(paths, new FakeProtector()) }),
    hrWebAdminService: admin,
    port: 0
  });
  t.after(() => server.close());

  const initial = await (await fetch(`${server.url}/api/bootstrap`)).json() as {
    product: string;
    requestToken: string;
    hr: { web: { settings: Record<string, unknown>; entry: { publicLink: string; enabled: boolean } } };
  };
  assert.equal(initial.product, "微信扫码 HR ClawBot");
  assert.equal(initial.hr.web.entry.enabled, false);
  assert.equal("entryToken" in initial.hr.web.settings, false);
  assert.equal(JSON.stringify(initial).includes(webStore.getSettings().entryToken), true);

  const rejected = await fetch(`${server.url}/api/hr/web`, {
    method: "PUT",
    headers: { Origin: server.url, "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: true })
  });
  assert.equal(rejected.status, 403);

  const updatedResponse = await fetch(`${server.url}/api/hr/web`, {
    method: "PUT",
    headers: {
      Origin: server.url,
      "Content-Type": "application/json",
      "X-Codex-Weixin-Token": initial.requestToken
    },
    body: JSON.stringify({ enabled: true, candidateName: "测试候选人", publicBaseUrl: "https://hr.example.com" })
  });
  assert.equal(updatedResponse.status, 200);
  const updated = await updatedResponse.json() as {
    settings: Record<string, unknown>;
    entry: { publicLink: string; enabled: boolean; reachability: string };
  };
  assert.equal(updated.entry.enabled, true);
  assert.equal(updated.entry.reachability, "public-https");
  assert.match(updated.entry.publicLink, /^https:\/\/hr\.example\.com\/e\//u);
  assert.equal("entryToken" in updated.settings, false);

  const priorLink = updated.entry.publicLink;
  const rotatedResponse = await fetch(`${server.url}/api/hr/web/rotate`, {
    method: "POST",
    headers: {
      Origin: server.url,
      "Content-Type": "application/json",
      "X-Codex-Weixin-Token": initial.requestToken
    },
    body: "{}"
  });
  const rotated = await rotatedResponse.json() as { entry: { publicLink: string } };
  assert.notEqual(rotated.entry.publicLink, priorLink);
});

