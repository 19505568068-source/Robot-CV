import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const source = path.join(root, "src", "web");
const target = path.join(root, "dist", "web");
const chatSource = path.join(root, "src", "web-chat");
const chatTarget = path.join(root, "dist", "web-chat");
const standaloneTargets = [root, path.join(root, "cloudflare-site")];

fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(source, target, { recursive: true });
fs.rmSync(chatTarget, { recursive: true, force: true });
fs.cpSync(chatSource, chatTarget, { recursive: true });

// Keep both standalone entry points generated from the visitor H5 source.
const standaloneHtml = fs.readFileSync(path.join(chatSource, "index.html"), "utf8")
  .replace('href="/chat/styles.css"', 'href="./styles.css"')
  .replace('src="/chat/app.js"', 'src="./app.js"');
for (const standaloneTarget of standaloneTargets) {
  fs.mkdirSync(standaloneTarget, { recursive: true });
  fs.copyFileSync(path.join(chatSource, "app.js"), path.join(standaloneTarget, "app.js"));
  fs.copyFileSync(path.join(chatSource, "styles.css"), path.join(standaloneTarget, "styles.css"));
  fs.writeFileSync(path.join(standaloneTarget, "index.html"), standaloneHtml);
}
fs.mkdirSync(path.join(target, "vendor"), { recursive: true });
fs.copyFileSync(
  path.join(root, "node_modules", "lucide", "dist", "umd", "lucide.min.js"),
  path.join(target, "vendor", "lucide.min.js")
);
fs.copyFileSync(
  path.join(root, "node_modules", "marked", "lib", "marked.umd.js"),
  path.join(target, "vendor", "marked.umd.js")
);
fs.copyFileSync(
  path.join(root, "node_modules", "dompurify", "dist", "purify.min.js"),
  path.join(target, "vendor", "purify.min.js")
);
fs.chmodSync(path.join(root, "dist", "server", "index.js"), 0o755);
