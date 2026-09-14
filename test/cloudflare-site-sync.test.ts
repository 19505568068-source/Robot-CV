import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(root, "src", "web-chat");
const standaloneRoots = [root, path.join(root, "cloudflare-site")];

test("keeps standalone visitor pages synchronized with the H5 source", () => {
  const sourceApp = fs.readFileSync(path.join(sourceRoot, "app.js"), "utf8");
  const sourceStyles = fs.readFileSync(path.join(sourceRoot, "styles.css"), "utf8");
  const expectedHtml = fs.readFileSync(path.join(sourceRoot, "index.html"), "utf8")
    .replace('href="/chat/styles.css"', 'href="./styles.css"')
    .replace('src="/chat/app.js"', 'src="./app.js"');

  for (const standaloneRoot of standaloneRoots) {
    assert.equal(fs.readFileSync(path.join(standaloneRoot, "app.js"), "utf8"), sourceApp);
    assert.equal(fs.readFileSync(path.join(standaloneRoot, "styles.css"), "utf8"), sourceStyles);
    assert.equal(fs.readFileSync(path.join(standaloneRoot, "index.html"), "utf8"), expectedHtml);
  }
});
