# HR ClawBot 访客端

这是 HR ClawBot 的微信/H5 访客聊天端静态资源，包含 `index.html`、`app.js` 和 `styles.css`。它依赖 HR ClawBot 的公共访客服务接口（`/api/public/*`），不能单独提供会话、同意门禁、简历下载或 AI 回复。

## 导入来源

资源来自 HR ClawBot 项目的 `src/web-chat`。为避免泄露招聘资料、运行时状态或管理后台，仓库只包含访客端源码，不包含 `hr.json`、简历文件、密钥、`node_modules` 或服务器代码。

## 集成方式

将本目录静态文件部署到 HR ClawBot 的访客服务路径 `/chat/`，或使用项目构建脚本复制到 `dist/web-chat`。访客入口 `/e/<entryToken>` 由 HR ClawBot 服务创建并在首次请求时建立会话。

## 本地预览

直接打开 `index.html` 只能检查布局；接口请求需要由 HR ClawBot 的 `8789` 访客服务提供。
