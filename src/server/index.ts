#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import open from "open";

import { WindowsDpapiProtector } from "../security/dpapi.js";
import { HrAiStore } from "../state/hr-ai.js";
import { HrStore } from "../state/hr.js";
import { resolveStatePaths } from "../state/paths.js";
import { parseServerCommand, serverHelpText } from "./arguments.js";
import { startLocalHttpServer } from "./http-server.js";
import { HrAiService } from "./hr-ai-service.js";
import { HrCodexEngine } from "./hr-codex-engine.js";
import { HrService } from "./hr-service.js";
import { HrWebAdminService } from "./hr-web-admin-service.js";
import { startHrWebChatServer } from "./hr-web-chat-server.js";
import { HrWebChatService } from "./hr-web-chat-service.js";
import { HrWebStore } from "./hr-web-store.js";
import { acquireServiceProcessLock } from "./process-lock.js";
import { launchRestartHelper } from "./restart.js";

async function main(): Promise<void> {
  const stateDir = process.env.CODEX_WEIXIN_STATE_DIR;
  const port = parsePort(process.env.CODEX_WEIXIN_PORT, "CODEX_WEIXIN_PORT", 8787);
  const publicPort = parsePort(process.env.CODEX_WEIXIN_PUBLIC_PORT, "CODEX_WEIXIN_PUBLIC_PORT", 8789);
  const publicHost = process.env.CODEX_WEIXIN_PUBLIC_HOST?.trim() || "0.0.0.0";
  const paths = resolveStatePaths(stateDir);
  const processLock = acquireServiceProcessLock(paths.root);
  const secretProtector = new WindowsDpapiProtector();
  const hrStore = new HrStore(paths, secretProtector);
  const hrAiStore = new HrAiStore(paths, secretProtector);
  const hrCodexEngine = new HrCodexEngine({
    runtimeRoot: path.join(paths.root, "hr-codex-runtime"),
    codexBin: process.env.CHAT_CODEX_BIN ?? "codex",
    ...(process.env.CODEX_WEIXIN_CODEX_MODEL?.trim()
      ? { model: process.env.CODEX_WEIXIN_CODEX_MODEL.trim() }
      : {}),
    ...(process.env.CODEX_WEIXIN_CODEX_EFFORT?.trim()
      ? { effort: process.env.CODEX_WEIXIN_CODEX_EFFORT.trim() }
      : {}),
    ...(process.env.CODEX_WEIXIN_CODEX_BASE_URL?.trim()
      ? { providerBaseUrl: process.env.CODEX_WEIXIN_CODEX_BASE_URL.trim() }
      : {})
  });
  const hrAiService = new HrAiService({
    store: hrAiStore,
    hrStore,
    hrStatePath: paths.hrPath,
    codexEngine: hrCodexEngine
  });
  const hrService = new HrService({ store: hrStore });
  const hrWebStore = new HrWebStore(path.join(paths.root, "hr-web.json"));
  const hrWebChatService = new HrWebChatService({
    store: hrStore,
    aiService: hrAiService,
    codexEngine: hrCodexEngine,
    hrStatePath: paths.hrPath
  });
  let server: Awaited<ReturnType<typeof startLocalHttpServer>> | undefined;
  let publicServer: Awaited<ReturnType<typeof startHrWebChatServer>> | undefined;
  let shuttingDown = false;
  let restartScheduled = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await Promise.allSettled([server?.close(), publicServer?.close()]);
    } finally {
      hrCodexEngine.close();
      processLock.release();
    }
  };
  const scheduleRestart = (version: string) => {
    if (restartScheduled) return;
    restartScheduled = true;
    const timer = setTimeout(() => {
      try {
        launchRestartHelper({
          parentPid: process.pid,
          entryPath: fileURLToPath(import.meta.url),
          stateDir: paths.root,
          port
        });
      } catch (error) {
        restartScheduled = false;
        console.error(`[codex-weixin] unable to restart after update: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      console.log(`[codex-weixin] updated to ${version}; restarting`);
      void shutdown().finally(() => process.exit(0));
    }, 500);
    timer.unref();
  };
  try {
    publicServer = await startHrWebChatServer({
      store: hrWebStore,
      backend: hrWebChatService,
      port: publicPort,
      host: publicHost,
      onError: (error) => console.warn(
        `[codex-weixin] public chat request failed: ${error instanceof Error ? error.message : String(error)}`
      )
    });
    const actualPublicPort = Number(new URL(publicServer.listenerUrl).port || 80);
    const hrWebAdminService = new HrWebAdminService({
      store: hrWebStore,
      port: actualPublicPort,
      host: publicHost,
      listenerUrl: publicServer.listenerUrl
    });
    server = await startLocalHttpServer({
      paths,
      hrService,
      hrAiService,
      hrWebAdminService,
      port,
      onUpdateInstalled: scheduleRestart
    });
  } catch (error) {
    await Promise.allSettled([server?.close(), publicServer?.close()]);
    processLock.release();
    throw error;
  }

  console.log(`HR ClawBot management is running at ${server.url}`);
  console.log(`HR ClawBot visitor entry is running at ${publicServer.entryUrl}`);
  console.log(`State directory: ${paths.root}`);
  if (process.env.CODEX_WEIXIN_OPEN !== "0") {
    void open(server.url).catch((error: unknown) => {
      console.warn(`Unable to open the browser automatically: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
}

function parsePort(value: string | undefined, name: string, fallback: number): number {
  if (!value) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return port;
}

async function run(): Promise<void> {
  const command = parseServerCommand(process.argv.slice(2));
  if (command === "help") {
    console.log(serverHelpText());
    return;
  }
  await main();
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
