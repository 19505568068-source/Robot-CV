# WeChat QR HR ClawBot

HR ClawBot gives recruiters one stable QR code that opens a consent-gated H5 chat inside WeChat. After consent, it introduces the candidate, exposes the immutable resume PDF, answers from local PDF/DOCX/text sources through an isolated Codex runtime, and archives each visitor conversation for opportunity analysis.

This mode does not automate a personal WeChat account and does not require a WeCom tenant, CorpID, Secret, callback, SQL database, or vector database.

## Runtime

```text
Recruiter -> public visitor service 0.0.0.0:8789
Candidate -> local management UI   127.0.0.1:8787
```

The management service is never exposed by the visitor listener. The public surface uses a stable 256-bit entry token, per-browser 256-bit session and CSRF credentials, hashed credential storage, strict Host/Origin validation, request limits, and consent checks before messages or resume access.

Requirements: Windows 10/11, Node.js 22+, and a logged-in Codex CLI.

```powershell
cd D:\Weixin_claw\codex-weixin-main
npm ci
npm run build
npm start
```

Open `http://127.0.0.1:8787`, enable the QR entry, configure the candidate profile and local document paths, then scan the generated LAN QR from a phone on the same network.

For a durable remote entry, reverse proxy a fixed HTTPS origin such as `https://hr.example.com` only to `http://127.0.0.1:8789`, and save that HTTPS origin in the management UI. Never proxy port `8787`. The QR remains stable until its entry key is explicitly rotated, while the Node service, domain, certificate, and network must remain available.

Supported knowledge sources include searchable PDF, DOCX, and bounded UTF-8 text formats. The current resume PDF is included automatically. Legacy `.doc` and scanned-image OCR are not supported in the first release.

Codex runs in a dedicated empty read-only workspace and isolated `CODEX_HOME`. Plugins, skills, MCP, web search, shell/file changes, and dynamic tools are disabled and every approval or permission request is denied. Only bounded retrieved excerpts and consented conversation data are supplied to the model. Candidate commitments always require human confirmation.

An HTTPS Responses-compatible Codex provider can be selected with `CODEX_WEIXIN_CODEX_BASE_URL`, plus optional `CODEX_WEIXIN_CODEX_MODEL` and `CODEX_WEIXIN_CODEX_EFFORT`. That provider receives bounded resume excerpts and consented recruiter messages, so configure only a data processor you explicitly trust.

Validation:

```powershell
npm run typecheck
npm test
npm run build
npm audit
```

State is stored under `%USERPROFILE%\.codex-weixin`. It contains private candidate and recruiter data and must not be committed or shared publicly.
