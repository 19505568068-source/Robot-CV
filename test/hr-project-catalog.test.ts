import assert from "node:assert/strict";
import test from "node:test";

import {
  formatHrWebProjectDetail,
  getHrWebProject,
  listHrWebProjectCards
} from "../src/server/hr-project-catalog.js";

test("discloses the verified HR ClawBot scope without claiming a complete public deployment", () => {
  const project = getHrWebProject("hr-clawbot");
  assert.ok(project);
  assert.match(project.statusLabel ?? "", /本机链路已验证/u);
  assert.match(project.result, /Cloudflare 当前只能承载 H5 静态外壳/u);
  assert.match(project.result, /api\/public\/\*/u);
  assert.match(project.result, /不能表述为已完成公网全栈部署/u);
  assert.match(project.result, /定向自动化测试与类型检查通过/u);
  assert.doesNotMatch(project.result, /完整自动化测试通过/u);
  assert.match(formatHrWebProjectDetail(project), /请从这段经历开始提问/u);
});

test("keeps the visitor menu grounded in the currently served resume and curated project disclosure", () => {
  const cards = listHrWebProjectCards();
  assert.deepEqual(cards.map((project) => project.id), [
    "hr-clawbot",
    "red-infinity",
    "linchang-fde-service",
    "dawan-delivery",
    "hulin-changchun",
    "fish-occurrence-database"
  ]);
  assert.equal(cards.some((project) => project.title.includes("Red Infinity")), true);
});
