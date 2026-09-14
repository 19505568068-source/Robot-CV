# Cloudflare deployment

The repository contains the complete HR ClawBot source (frontend and Node.js backend). The `cloudflare-site/` directory is the visitor H5 static entry used by the Cloudflare deployment.

## GitHub-connected deployment

In Cloudflare Workers & Pages, create a Git-connected Worker/Pages deployment for this repository with:

- Repository: `19505568068-source/Robot-CV`
- Production branch: `main`
- Build command: leave empty for a static upload
- Static output directory: `cloudflare-site`

The generated Cloudflare URL can serve the H5 shell. The browser still calls `/api/public/*`, which must be served by a reachable HR ClawBot backend.

## Backend limitation

The Node.js backend under `src/server` uses the local filesystem, DPAPI, local resume/document paths, and the Codex CLI. It is not executable as-is in Cloudflare Pages or a static-assets Worker. Run it on a Windows host or a Node-capable server and expose only port `8789` through a trusted HTTPS reverse proxy or Cloudflare Tunnel. Never expose the `8787` management server.

Do not commit `%USERPROFILE%\\.codex-weixin`, resume files, `hr.json`, API keys, or other runtime state.
