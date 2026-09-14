import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startLocalHttpServer } from "../src/server/http-server.js";
import { resolveStatePaths } from "../src/state/paths.js";

test("legacy API profile routes are unavailable in HR-only mode", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-profile-http-retired-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = await startLocalHttpServer({ paths: resolveStatePaths(root), port: 0 });
  t.after(() => server.close());

  for (const endpoint of [
    "/api/api-profiles",
    "/api/api-profiles/legacy-profile",
    "/api/api-profiles/legacy-profile/test",
    "/api/api-profiles/legacy-profile/activate"
  ]) {
    const getResponse = await fetch(`${server.url}${endpoint}`);
    assert.equal(getResponse.status, 410, endpoint);
    assert.equal((await getResponse.json() as { code?: string }).code, "HR_ONLY", endpoint);

    const mutationResponse = await fetch(`${server.url}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    assert.equal(mutationResponse.status, 410, endpoint);
    assert.equal((await mutationResponse.json() as { code?: string }).code, "HR_ONLY", endpoint);
  }
});
