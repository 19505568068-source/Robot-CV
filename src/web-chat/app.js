const state = {
  session: null,
  messages: [],
  messageNodes: new Map(),
  projectOptions: [],
  projectOptionsSignature: "",
  selectedProjectIds: new Set(),
  cursor: "",
  scrollOnNextMessage: false,
  sending: false,
  polling: false,
  pollTimer: null
};

const elements = {
  candidateName: document.querySelector("#candidateName"),
  connectionState: document.querySelector("#connectionState"),
  messages: document.querySelector("#messages"),
  loadingState: document.querySelector("#loadingState"),
  projectMenu: document.querySelector("#projectMenu"),
  projectList: document.querySelector("#projectList"),
  resumeLink: document.querySelector("#resumeLink"),
  consentPanel: document.querySelector("#consentPanel"),
  disclosure: document.querySelector("#disclosure"),
  acceptConsent: document.querySelector("#acceptConsent"),
  declineConsent: document.querySelector("#declineConsent"),
  consentError: document.querySelector("#consentError"),
  composer: document.querySelector("#composer"),
  messageInput: document.querySelector("#messageInput"),
  sendButton: document.querySelector("#sendButton"),
  fatalState: document.querySelector("#fatalState"),
  fatalMessage: document.querySelector("#fatalMessage")
};

elements.acceptConsent.addEventListener("click", () => void updateConsent("accept"));
elements.declineConsent.addEventListener("click", () => void updateConsent("decline"));
elements.composer.addEventListener("submit", (event) => void sendMessage(event));
elements.messageInput.addEventListener("input", resizeComposer);
elements.projectList?.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-project-id]");
  if (!button || button.disabled) return;
  void selectProject(button.dataset.projectId, button);
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void pollMessages();
});

void bootstrap();

async function bootstrap() {
  try {
    const entryToken = entryTokenFromPath();
    const payload = entryToken
      ? await api("/api/public/sessions", { method: "POST", body: { entryToken }, csrf: false })
      : await api("/api/public/session", { csrf: false });
    state.session = payload.session;
    if (entryToken) history.replaceState(null, "", "/chat");
    renderSession();
    if (state.session.consentStatus === "accepted") await pollMessages();
  } catch (error) {
    showFatal(error.code === "SESSION_REQUIRED"
      ? "会话已过期，请重新扫描候选人提供的二维码。"
      : (error.message || "链接当前不可用，请稍后再试。"));
  }
}

async function updateConsent(action) {
  if (!state.session) return;
  elements.consentError.textContent = "";
  elements.acceptConsent.disabled = true;
  elements.declineConsent.disabled = true;
  try {
    const payload = await api("/api/public/session/consent", {
      method: "POST",
      body: { action, disclosureVersion: state.session.disclosureVersion }
    });
    state.session = payload.session;
    renderSession();
    if (state.session.consentStatus === "accepted") {
      await pollMessages();
      elements.messageInput.focus();
    }
  } catch (error) {
    elements.consentError.textContent = error.message || "无法保存选择，请重试。";
  } finally {
    elements.acceptConsent.disabled = false;
    elements.declineConsent.disabled = false;
  }
}

async function sendMessage(event) {
  event.preventDefault();
  const text = elements.messageInput.value.trim();
  if (!text || state.sending || state.session?.consentStatus !== "accepted") return;
  state.sending = true;
  state.scrollOnNextMessage = true;
  elements.messageInput.value = "";
  resizeComposer();
  renderComposer();
  try {
    await api("/api/public/session/messages", {
      method: "POST",
      body: { clientMessageId: newClientMessageId(), text }
    });
    await pollMessages();
  } catch (error) {
    state.scrollOnNextMessage = false;
    elements.messageInput.value = text;
    resizeComposer();
    elements.connectionState.textContent = error.message || "发送失败，请重试";
  } finally {
    state.sending = false;
    renderComposer();
  }
}

function newClientMessageId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function pollMessages() {
  if (state.polling || state.session?.consentStatus !== "accepted") return;
  state.polling = true;
  clearTimeout(state.pollTimer);
  try {
    const query = state.cursor ? `?after=${encodeURIComponent(state.cursor)}&limit=100` : "?limit=100";
    const page = await api(`/api/public/session/messages${query}`, { csrf: false });
    const shouldAutoScroll = state.messages.length === 0
      || state.scrollOnNextMessage
      || isNearMessageEnd();
    state.projectOptions = Array.isArray(page.projectOptions) ? page.projectOptions : [];
    renderProjectMenu();
    const appended = appendMessages(Array.isArray(page.messages) ? page.messages : []);
    if (appended) {
      state.scrollOnNextMessage = false;
      if (shouldAutoScroll) scrollMessagesToEnd();
    }
    if (typeof page.cursor === "string") state.cursor = page.cursor;
    elements.connectionState.textContent = "在线";
  } catch (error) {
    if (error.status === 401) {
      showFatal("会话已过期，请重新扫描候选人提供的二维码。");
      return;
    }
    elements.connectionState.textContent = "正在重连";
  } finally {
    state.polling = false;
    if (!elements.fatalState.hidden) return;
    state.pollTimer = setTimeout(() => void pollMessages(), document.visibilityState === "visible" ? 1800 : 8000);
  }
}

function renderSession() {
  const session = state.session || {};
  const accepted = session.consentStatus === "accepted";
  elements.candidateName.textContent = session.candidateName
    ? `${session.candidateName}的 AI 助理`
    : "候选人 AI 助理";
  document.title = elements.candidateName.textContent;
  elements.connectionState.textContent = accepted ? "在线" : "等待确认";
  elements.disclosure.textContent = session.disclosure || "";
  elements.acceptConsent.textContent = session.resumeAvailable
    ? "同意并查看简历"
    : "同意并开始沟通";
  elements.consentPanel.hidden = accepted;
  elements.resumeLink.hidden = !(accepted && session.resumeAvailable);
  elements.loadingState?.remove();
  if (!accepted) {
    state.messages = [];
    state.messageNodes.clear();
    state.projectOptions = [];
    state.projectOptionsSignature = "";
    state.selectedProjectIds.clear();
    state.cursor = "";
    state.scrollOnNextMessage = false;
    elements.messages.replaceChildren();
  }
  renderProjectMenu();
  if (accepted) ensureProjectMenuPlacement();
  renderComposer();
}

function appendMessages(messages) {
  const known = new Set(state.messages.map((message) => message.id));
  const added = [];
  for (const message of messages) {
    if (!message || known.has(message.id) || !["visitor", "assistant"].includes(message.role)) continue;
    known.add(message.id);
    state.messages.push(message);
    added.push(message);
  }
  if (added.length === 0) return false;
  state.messages.sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  added.sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  for (const message of added) insertMessageNode(message);
  ensureProjectMenuPlacement();
  return true;
}

function insertMessageNode(message) {
  const article = messageNode(message);
  state.messageNodes.set(message.id, article);
  const index = state.messages.indexOf(message);
  const followingNode = state.messages
    .slice(index + 1)
    .map((item) => state.messageNodes.get(item.id))
    .find(Boolean);
  if (followingNode) elements.messages.insertBefore(article, followingNode);
  else elements.messages.append(article);
}

function ensureProjectMenuPlacement() {
  if (!elements.projectMenu) return;
  const anchor = state.messages.find((message) => message.kind === "project-menu");
  const anchorNode = anchor ? state.messageNodes.get(anchor.id) : null;
  if (anchorNode) {
    if (anchorNode.nextElementSibling !== elements.projectMenu) anchorNode.after(elements.projectMenu);
    return;
  }
  if (elements.projectMenu.parentElement !== elements.messages
    || elements.projectMenu !== elements.messages.lastElementChild) {
    elements.messages.append(elements.projectMenu);
  }
}

function isNearMessageEnd() {
  const remaining = elements.messages.scrollHeight
    - elements.messages.scrollTop
    - elements.messages.clientHeight;
  return remaining <= 96;
}

function scrollMessagesToEnd() {
  requestAnimationFrame(() => { elements.messages.scrollTop = elements.messages.scrollHeight; });
}

function messageNode(message) {
  const article = document.createElement("article");
  article.className = `message message-${message.role}`;
  article.dataset.messageId = String(message.id || "");
  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  bubble.textContent = String(message.text || "");
  const time = document.createElement("time");
  time.dateTime = String(message.createdAt || "");
  time.textContent = formatTime(message.createdAt);
  article.append(bubble, time);
  return article;
}

function renderComposer() {
  const enabled = state.session?.consentStatus === "accepted" && !state.sending;
  elements.messageInput.disabled = !enabled;
  elements.sendButton.disabled = !enabled || !elements.messageInput.value.trim();
  elements.sendButton.classList.toggle("is-sending", state.sending);
}

function renderProjectMenu() {
  const accepted = state.session?.consentStatus === "accepted";
  const options = Array.isArray(state.projectOptions) ? state.projectOptions : [];
  if (!elements.projectMenu || !elements.projectList) return;
  elements.projectMenu.hidden = !accepted || options.length === 0;
  const signature = JSON.stringify(options);
  if (signature === state.projectOptionsSignature) return;
  state.projectOptionsSignature = signature;
  elements.projectList.replaceChildren(...options.map(projectNode));
  ensureProjectMenuPlacement();
}

function projectNode(project) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "project-card";
  button.dataset.projectId = String(project.id || "");
  button.title = `查看${String(project.title || "项目经历")}详情`;
  button.disabled = state.selectedProjectIds.has(button.dataset.projectId);
  const meta = document.createElement("span");
  meta.className = "project-card-meta";
  meta.textContent = [project.category, project.dateLabel, project.statusLabel]
    .filter((value) => typeof value === "string" && value.trim())
    .join(" · ");
  const title = document.createElement("strong");
  title.className = "project-card-title";
  title.textContent = String(project.title || "项目经历");
  const summary = document.createElement("span");
  summary.className = "project-card-summary";
  summary.textContent = String(project.summary || "");
  const arrow = document.createElement("span");
  arrow.className = "project-card-arrow";
  arrow.setAttribute("aria-hidden", "true");
  arrow.textContent = button.disabled ? "已展开" : "→";
  button.append(meta, title, summary, arrow);
  return button;
}

async function selectProject(projectId, button) {
  const id = String(projectId || "");
  if (!id || state.session?.consentStatus !== "accepted" || state.selectedProjectIds.has(id)) return;
  state.scrollOnNextMessage = true;
  button.disabled = true;
  const arrow = button.querySelector(".project-card-arrow");
  if (arrow) arrow.textContent = "加载中";
  try {
    await api("/api/public/session/projects", {
      method: "POST",
      body: { projectId: id }
    });
    state.selectedProjectIds.add(id);
    if (arrow) arrow.textContent = "已展开";
    await pollMessages();
  } catch (error) {
    state.scrollOnNextMessage = false;
    button.disabled = false;
    if (arrow) arrow.textContent = "→";
    elements.connectionState.textContent = error.message || "项目详情暂不可用，请稍后重试";
  }
}

function resizeComposer() {
  elements.messageInput.style.height = "auto";
  elements.messageInput.style.height = `${Math.min(132, elements.messageInput.scrollHeight)}px`;
  renderComposer();
}

function entryTokenFromPath() {
  const match = /^\/e\/([A-Za-z0-9_-]{43})$/u.exec(location.pathname);
  return match ? match[1] : "";
}

async function api(url, options = {}) {
  const headers = options.body ? { "Content-Type": "application/json" } : {};
  if (options.csrf !== false && options.method && options.method !== "GET") {
    headers["X-HR-Web-CSRF"] = readCookie("hr_web_csrf");
  }
  const response = await fetch(url, {
    method: options.method || "GET",
    headers,
    credentials: "same-origin",
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `请求失败 (${response.status})`);
    error.status = response.status;
    error.code = payload.code;
    throw error;
  }
  return payload;
}

function readCookie(name) {
  const prefix = `${name}=`;
  const item = document.cookie.split(";").map((value) => value.trim()).find((value) => value.startsWith(prefix));
  if (!item) return "";
  try { return decodeURIComponent(item.slice(prefix.length)); } catch { return ""; }
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
}

function showFatal(message) {
  clearTimeout(state.pollTimer);
  document.querySelector(".chat-shell").hidden = true;
  elements.fatalState.hidden = false;
  elements.fatalMessage.textContent = message;
}
