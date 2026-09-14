# Cloudflare deployment

The repository contains the HR ClawBot frontend and Node.js backend source. The `cloudflare-site/` directory is only the generated visitor H5 static entry used by Cloudflare.

## Current status

The local and same-LAN flow has been verified. No public HTTPS backend is currently configured. A Cloudflare static deployment is therefore not a working public HR ClawBot until same-origin `/api/public/*` requests reach the Node backend and the full flow is tested end to end.

## GitHub-connected deployment

In Cloudflare Workers & Pages, create a Git-connected Worker/Pages deployment for this repository with:

- Repository: `19505568068-source/Robot-CV`
- Production branch: `main`
- Build command: `npm run build`
- Static output directory: `cloudflare-site`

The build regenerates `cloudflare-site/` from `src/web-chat/`, including the project menu. Do not edit the generated directory directly. The generated Cloudflare URL can serve the H5 shell, but the browser still calls same-origin `/api/public/*`, which must be routed to a reachable HR ClawBot backend.

## Backend limitation

The Node.js backend under `src/server` uses the local filesystem, DPAPI, local resume/document paths, and the Codex CLI. It is not executable as-is in Cloudflare Pages or a static-assets Worker. Run it on a Windows host or a Node-capable server and expose only port `8789` through a trusted HTTPS reverse proxy or Cloudflare Tunnel. Never expose the `8787` management server.

Do not commit `%USERPROFILE%\\.codex-weixin`, resume files, `hr.json`, API keys, or other runtime state.
