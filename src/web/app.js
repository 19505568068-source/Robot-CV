const state = {
  version: "",
  requestToken: "",
  hrAvailable: null,
  hrLoaded: false,
  hrLoading: false,
  hrError: "",
  hrSettings: null,
  hrWeb: null,
  hrEntry: null,
  hrConnection: null,
  hrMaterials: null,
  hrAi: null,
  opportunities: [],
  opportunityFilter: "all",
  opportunityQuery: "",
  selectedOpportunityId: "",
  selectedOpportunity: null,
  opportunityDetailLoading: false,
  hrActionBusy: "",
  hrDraftBusy: "",
  hrSettingsSaving: false,
  hrMaterialsSaving: false,
  hrMaterialUploading: "",
  hrAiSaving: false
};

const els = {};

document.addEventListener("DOMContentLoaded", () => {
  Object.assign(els, {
    productVersion: document.querySelector("#productVersion"),
    hrEntryMetric: document.querySelector("#hrEntryMetric"),
    hrOpportunityMetric: document.querySelector("#hrOpportunityMetric"),
    hrPendingMetric: document.querySelector("#hrPendingMetric"),
    opportunitiesList: document.querySelector("#opportunitiesList"),
    opportunityFilters: document.querySelector("#opportunityFilters"),
    opportunitySearchInput: document.querySelector("#opportunitySearchInput"),
    opportunityTotalMetric: document.querySelector("#opportunityTotalMetric"),
    opportunityHighMetric: document.querySelector("#opportunityHighMetric"),
    opportunityPendingMetric: document.querySelector("#opportunityPendingMetric"),
    opportunityTodayMetric: document.querySelector("#opportunityTodayMetric"),
    opportunityDialog: document.querySelector("#opportunityDialog"),
    opportunityDialogCompany: document.querySelector("#opportunityDialogCompany"),
    opportunityDialogTitle: document.querySelector("#opportunityDialogTitle"),
    opportunityDialogContext: document.querySelector("#opportunityDialogContext"),
    opportunityDialogUpdated: document.querySelector("#opportunityDialogUpdated"),
    opportunityDetailBody: document.querySelector("#opportunityDetailBody"),
    hrEntryPanel: document.querySelector("#hrEntryPanel"),
    hrEntrySummaryText: document.querySelector("#hrEntrySummaryText"),
    hrEntryStatus: document.querySelector("#hrEntryStatus"),
    hrEntryStableId: document.querySelector("#hrEntryStableId"),
    hrEntryQrFrame: document.querySelector("#hrEntryQrFrame"),
    hrEntryPublicLink: document.querySelector("#hrEntryPublicLink"),
    copyHrEntryLinkButton: document.querySelector("#copyHrEntryLinkButton"),
    hrPublicListenerTarget: document.querySelector("#hrPublicListenerTarget"),
    copyHrPublicListenerButton: document.querySelector("#copyHrPublicListenerButton"),
    hrReachability: document.querySelector("#hrReachability"),
    hrReachabilityStatus: document.querySelector("#hrReachabilityStatus"),
    hrEntryValidityNote: document.querySelector("#hrEntryValidityNote"),
    hrSettingsForm: document.querySelector("#hrSettingsForm"),
    hrEnabledInput: document.querySelector("#hrEnabledInput"),
    hrCandidateNameInput: document.querySelector("#hrCandidateNameInput"),
    hrPublicBaseUrlInput: document.querySelector("#hrPublicBaseUrlInput"),
    rotateHrEntryButton: document.querySelector("#rotateHrEntryButton"),
    saveHrSettingsButton: document.querySelector("#saveHrSettingsButton"),
    hrAiSettingsForm: document.querySelector("#hrAiSettingsForm"),
    hrAiEnabledInput: document.querySelector("#hrAiEnabledInput"),
    hrAiEndpointInput: document.querySelector("#hrAiEndpointInput"),
    hrAiModelInput: document.querySelector("#hrAiModelInput"),
    hrAiApiKeyInput: document.querySelector("#hrAiApiKeyInput"),
    hrAiApiKeyStatus: document.querySelector("#hrAiApiKeyStatus"),
    hrAiStatus: document.querySelector("#hrAiStatus"),
    hrAiStatusDetail: document.querySelector("#hrAiStatusDetail"),
    saveHrAiSettingsButton: document.querySelector("#saveHrAiSettingsButton"),
    hrMaterialsForm: document.querySelector("#hrMaterialsForm"),
    hrMaterialsSupport: document.querySelector("#hrMaterialsSupport"),
    hrDisclosureInput: document.querySelector("#hrDisclosureInput"),
    hrBioInput: document.querySelector("#hrBioInput"),
    hrTargetRolesInput: document.querySelector("#hrTargetRolesInput"),
    hrProfileKeywordsInput: document.querySelector("#hrProfileKeywordsInput"),
    hrResumeFileInput: document.querySelector("#hrResumeFileInput"),
    selectHrResumeButton: document.querySelector("#selectHrResumeButton"),
    hrResumeUploadState: document.querySelector("#hrResumeUploadState"),
    hrKnowledgeFilesInput: document.querySelector("#hrKnowledgeFilesInput"),
    selectHrKnowledgeButton: document.querySelector("#selectHrKnowledgeButton"),
    hrKnowledgeUploadState: document.querySelector("#hrKnowledgeUploadState"),
    hrResumePathInput: document.querySelector("#hrResumePathInput"),
    hrKnowledgeBasePathsInput: document.querySelector("#hrKnowledgeBasePathsInput"),
    hrClearKnowledgeInput: document.querySelector("#hrClearKnowledgeInput"),
    hrResumeStatus: document.querySelector("#hrResumeStatus"),
    hrResumeLink: document.querySelector("#hrResumeLink"),
    hrKnowledgeStatus: document.querySelector("#hrKnowledgeStatus"),
    hrMaterialsHint: document.querySelector("#hrMaterialsHint"),
    saveHrMaterialsButton: document.querySelector("#saveHrMaterialsButton")
  });
  bindEvents();
  void bootstrap();
});

function bindEvents() {
  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
  document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => closeDialog(button.dataset.closeDialog)));
  document.querySelector("#refreshOpportunitiesButton").addEventListener("click", () => void loadHrData(true));
  document.querySelector("#refreshHrSettingsButton").addEventListener("click", () => void loadHrData(true));
  els.opportunityFilters.addEventListener("click", handleOpportunityFilter);
  els.opportunitySearchInput.addEventListener("input", handleOpportunitySearch);
  els.opportunitiesList.addEventListener("click", (event) => void handleOpportunityListAction(event));
  els.opportunityDialog.addEventListener("click", (event) => void handleOpportunityDialogAction(event));
  els.hrSettingsForm.addEventListener("submit", (event) => void saveHrSettings(event));
  els.hrAiSettingsForm.addEventListener("submit", (event) => void saveHrAiSettings(event));
  els.hrMaterialsForm.addEventListener("submit", (event) => void saveHrMaterials(event));
  els.selectHrResumeButton.addEventListener("click", () => els.hrResumeFileInput.click());
  els.selectHrKnowledgeButton.addEventListener("click", () => els.hrKnowledgeFilesInput.click());
  els.hrResumeFileInput.addEventListener("change", () => void uploadSelectedHrMaterials("resume"));
  els.hrKnowledgeFilesInput.addEventListener("change", () => void uploadSelectedHrMaterials("knowledge"));
  els.copyHrEntryLinkButton.addEventListener("click", () => void copyHrValue(state.hrEntry?.publicLink, "固定访客链接已复制"));
  els.copyHrPublicListenerButton.addEventListener("click", () => void copyHrValue(
    state.hrEntry?.listenerUrl || els.hrPublicListenerTarget.textContent,
    "访客服务地址已复制"
  ));
  els.rotateHrEntryButton.addEventListener("click", () => void rotateHrEntry());
  window.addEventListener("hashchange", () => showView(location.hash.slice(1) || "opportunities", false));
}

async function bootstrap() {
  try {
    const data = await api("/api/bootstrap", { token: false });
    state.requestToken = data.requestToken;
    state.version = data.version || "";
    await loadHrData(false, false);
    renderAll();
    showView(location.hash.slice(1) || "opportunities", false);
    window.setInterval(() => void loadHrData(false), 5000);
  } catch (error) {
    toast(error.message, true);
    els.opportunitiesList.innerHTML = emptyState("server-off", "无法连接 HR ClawBot 服务", "请确认本机服务正在运行");
  }
}

function renderAll() {
  renderProductVersion();
  renderMetrics();
  renderHrWorkspace();
  drawIcons();
}

function renderProductVersion() {
  const version = state.version.trim();
  els.productVersion.hidden = !version;
  els.productVersion.textContent = version ? `v${version.replace(/^v/i, "")}` : "";
}

function renderMetrics() {
  const opportunities = state.opportunities.map(normalizeOpportunity);
  const pendingCount = opportunities.filter(opportunityNeedsConfirmation).length;
  els.hrEntryMetric.textContent = hrEntryStateText(state.hrEntry);
  els.hrOpportunityMetric.textContent = String(opportunities.length);
  els.hrPendingMetric.textContent = String(pendingCount);
  const serviceText = document.querySelector("#serviceStateText");
  const serviceDot = document.querySelector("#serviceDot");
  if (state.hrAvailable === true && state.hrEntry?.enabled) {
    serviceText.textContent = "HR 助理接待中";
    serviceDot.classList.remove("is-error");
  } else {
    serviceText.textContent = state.hrAvailable === false
      ? "HR 功能尚未启用"
      : "微信扫码入口尚未启用";
    serviceDot.classList.add("is-error");
  }
}

async function loadHrData(notify = false, shouldRender = true) {
  if (state.hrLoading) return;
  state.hrLoading = true;
  state.hrError = "";
  document.querySelector("#refreshOpportunitiesButton")?.classList.add("is-loading");
  document.querySelector("#refreshHrSettingsButton")?.classList.add("is-loading");
  try {
    const data = await api("/api/hr/bootstrap");
    state.hrAvailable = true;
    state.hrLoaded = true;
    state.hrSettings = data.settings || {};
    state.hrWeb = data.web || null;
    state.hrEntry = data.web?.entry || data.entry || {};
    state.hrConnection = data.connection || null;
    state.hrMaterials = data.materials || data.publicProfile || null;
    state.hrAi = data.ai || null;
    state.opportunities = Array.isArray(data.opportunities) ? data.opportunities : [];
    if (notify) toast("招聘数据已刷新");
  } catch (error) {
    state.hrLoaded = true;
    state.hrAvailable = error.status === 404 ? false : null;
    state.hrError = error.status === 404 ? "" : (error.message || "无法读取招聘数据");
    if (notify && error.status !== 404) toast(state.hrError, true);
  } finally {
    state.hrLoading = false;
    document.querySelector("#refreshOpportunitiesButton")?.classList.remove("is-loading");
    document.querySelector("#refreshHrSettingsButton")?.classList.remove("is-loading");
    if (shouldRender) {
      renderMetrics();
      renderHrWorkspace();
      drawIcons();
    }
  }
}

function renderHrWorkspace() {
  renderOpportunitySummary();
  renderOpportunities();
  renderHrEntry();
  renderHrAi();
  renderHrMaterials();
}

function renderOpportunitySummary() {
  const opportunities = state.opportunities.map(normalizeOpportunity);
  const today = new Date();
  const isToday = (value) => {
    const date = new Date(value);
    return !Number.isNaN(date.getTime())
      && date.getFullYear() === today.getFullYear()
      && date.getMonth() === today.getMonth()
      && date.getDate() === today.getDate();
  };
  els.opportunityTotalMetric.textContent = String(opportunities.length);
  els.opportunityHighMetric.textContent = String(opportunities.filter((item) => item.priorityScore >= 70).length);
  els.opportunityPendingMetric.textContent = String(opportunities.filter(opportunityNeedsConfirmation).length);
  els.opportunityTodayMetric.textContent = String(opportunities.filter((item) => isToday(item.lastMessageAt)).length);
}

function renderOpportunities() {
  if (state.hrLoading && !state.hrLoaded) {
    els.opportunitiesList.innerHTML = `<div class="opportunity-loading"><span class="spinner" aria-hidden="true"></span><strong>正在读取招聘机会</strong></div>`;
    return;
  }
  if (state.hrAvailable === false) {
    els.opportunitiesList.innerHTML = emptyState(
      "briefcase-business",
      "HR 机会管理尚未启用",
      "请先启用微信扫码入口并配置对外资料",
      `<button class="button button-primary" type="button" data-view="wecom"><i data-lucide="settings-2"></i><span>打开扫码入口设置</span></button>`
    );
    els.opportunitiesList.querySelector("[data-view]")?.addEventListener("click", () => showView("wecom"));
    return;
  }
  if (state.hrError) {
    els.opportunitiesList.innerHTML = emptyState("cloud-off", "暂时无法读取招聘机会", state.hrError);
    return;
  }

  const query = state.opportunityQuery.trim().toLocaleLowerCase("zh-CN");
  const visible = state.opportunities
    .map(normalizeOpportunity)
    .filter((item) => opportunityMatchesFilter(item, state.opportunityFilter))
    .filter((item) => !query || opportunitySearchText(item).includes(query))
    .sort((left, right) => right.priorityScore - left.priorityScore || dateValue(right.lastMessageAt) - dateValue(left.lastMessageAt));

  if (!visible.length) {
    const filtering = state.opportunityFilter !== "all" || Boolean(query);
    els.opportunitiesList.innerHTML = emptyState(
      filtering ? "search-x" : "inbox",
      filtering ? "没有符合条件的机会" : "还没有招聘机会",
      filtering ? "调整筛选条件或搜索词后重试" : "HR 扫码并同意记录后，机会会自动出现在这里"
    );
    return;
  }

  els.opportunitiesList.innerHTML = visible.map((opportunity, index) => renderOpportunityCard(opportunity, index)).join("");
}

function renderOpportunityCard(opportunity, index) {
  const pending = opportunityNeedsConfirmation(opportunity);
  const consent = consentStatus(opportunity.consentStatus);
  const evidence = opportunity.evidence.slice(0, 2);
  const tier = opportunityPriorityTier(opportunity.priorityScore);
  const concerns = opportunity.concerns.slice(0, 3);
  return `<article class="opportunity-card priority-${tier}">
    <button class="opportunity-open" type="button" data-opportunity-id="${escapeAttr(opportunity.id)}" aria-label="查看 ${escapeAttr(opportunity.company)} ${escapeAttr(opportunity.role)} 机会详情">
      <div class="opportunity-rank" aria-label="优先级排名"><span>${String(index + 1).padStart(2, "0")}</span><small>${priorityDisplayName(tier)}</small></div>
      <div class="opportunity-main">
        <div class="opportunity-title-row">
          <div class="opportunity-title">
            <span>${escapeHtml(opportunity.company)}</span>
            <h2>${escapeHtml(opportunity.role)}</h2>
          </div>
          <div class="opportunity-badges">
            <span class="opportunity-stage">${escapeHtml(stageDisplayName(opportunity.stage, opportunity.status))}</span>
            <span class="opportunity-consent consent-${consent.className}"><i data-lucide="${escapeAttr(consent.icon)}"></i>${escapeHtml(consent.label)}</span>
            ${pending ? `<span class="opportunity-pending"><i data-lucide="circle-help"></i>待确认</span>` : ""}
          </div>
        </div>
        <div class="opportunity-meta">
          <span><i data-lucide="contact"></i>${escapeHtml(opportunity.visitorLabel)}</span>
          <span><i data-lucide="messages-square"></i>${opportunity.messageCount} 条消息</span>
          <time datetime="${escapeAttr(opportunity.lastMessageAt)}"><i data-lucide="clock-3"></i>${escapeHtml(relativeTime(opportunity.lastMessageAt))}</time>
        </div>
        ${concerns.length ? `<div class="opportunity-concerns" aria-label="HR 关注点">${concerns.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>` : ""}
        <div class="opportunity-evidence-preview">
          <span class="opportunity-evidence-title"><i data-lucide="quote"></i>判断依据</span>
          ${evidence.length
            ? evidence.map((item) => `<q>${escapeHtml(item.quote)}</q>`).join("")
            : `<span class="opportunity-evidence-empty">聊天证据不足，等待更多信息</span>`}
        </div>
      </div>
      <div class="opportunity-scores">
        ${renderScore("HR 邀约意向", opportunity.invitationScore, "invitation")}
        ${renderScore("岗位匹配度", opportunity.fitScore, "fit")}
      </div>
      <span class="opportunity-card-arrow" aria-hidden="true"><i data-lucide="chevron-right"></i></span>
    </button>
  </article>`;
}

function renderScore(label, value, kind) {
  const known = Number.isFinite(value);
  const score = known ? Math.max(0, Math.min(100, Math.round(value))) : 0;
  return `<div class="opportunity-score score-${kind}${known ? "" : " is-pending"}">
    <div><span>${escapeHtml(label)}</span><strong>${known ? score : "--"}<small>${known ? "/100" : "待确认"}</small></strong></div>
    <progress class="opportunity-score-track" max="100" value="${score}" aria-label="${escapeAttr(label)} ${known ? `${score} 分` : "待确认"}">${score}</progress>
  </div>`;
}

function handleOpportunityFilter(event) {
  const button = event.target.closest("[data-opportunity-filter]");
  if (!button) return;
  state.opportunityFilter = button.dataset.opportunityFilter;
  els.opportunityFilters.querySelectorAll("[data-opportunity-filter]").forEach((item) => {
    item.classList.toggle("is-active", item === button);
  });
  renderOpportunities();
  drawIcons();
}

function handleOpportunitySearch(event) {
  state.opportunityQuery = event.target.value;
  renderOpportunities();
  drawIcons();
}

function opportunityMatchesFilter(opportunity, filter) {
  if (filter === "high") return opportunity.priorityScore >= 70;
  if (filter === "pending") return opportunityNeedsConfirmation(opportunity);
  if (filter === "active") return !["closed", "rejected", "archived"].includes(opportunity.status) && opportunity.stage !== "closed";
  return true;
}

function opportunitySearchText(opportunity) {
  return [
    opportunity.company,
    opportunity.role,
    opportunity.visitorLabel,
    opportunity.stage,
    ...opportunity.concerns,
    ...opportunity.conditions,
    ...opportunity.evidence.map((item) => item.quote)
  ].join(" ").toLocaleLowerCase("zh-CN");
}

async function handleOpportunityListAction(event) {
  const button = event.target.closest("[data-opportunity-id]");
  if (!button) return;
  await openOpportunity(button.dataset.opportunityId);
}

async function openOpportunity(opportunityId) {
  const summary = state.opportunities.find((item) => String(item.id) === String(opportunityId));
  state.selectedOpportunityId = String(opportunityId || "");
  state.selectedOpportunity = summary || null;
  state.opportunityDetailLoading = true;
  renderOpportunityDetail();
  if (!els.opportunityDialog.open) els.opportunityDialog.showModal();
  drawIcons();
  try {
    const data = await api(`/api/hr/opportunities/${encodeURIComponent(state.selectedOpportunityId)}`);
    state.selectedOpportunity = data.opportunity || data;
  } catch (error) {
    if (!summary) {
      state.selectedOpportunity = { id: opportunityId, detailError: error.message || "无法读取机会详情" };
    } else {
      state.selectedOpportunity = { ...summary, detailError: error.message || "无法读取完整聊天记录" };
    }
  } finally {
    state.opportunityDetailLoading = false;
    renderOpportunityDetail();
    drawIcons();
  }
}

function renderOpportunityDetail() {
  if (state.opportunityDetailLoading && !state.selectedOpportunity) {
    els.opportunityDialogCompany.textContent = "RECRUITING OPPORTUNITY";
    els.opportunityDialogTitle.textContent = "招聘机会";
    els.opportunityDialogContext.textContent = "";
    els.opportunityDetailBody.innerHTML = `<div class="opportunity-detail-loading"><span class="spinner" aria-hidden="true"></span><strong>正在读取机会详情</strong></div>`;
    return;
  }

  const opportunity = normalizeOpportunity(state.selectedOpportunity || {});
  const raw = state.selectedOpportunity || {};
  els.opportunityDialogCompany.textContent = opportunity.company;
  els.opportunityDialogTitle.textContent = opportunity.role;
  els.opportunityDialogContext.textContent = `${opportunity.visitorLabel} · ${stageDisplayName(opportunity.stage, opportunity.status)}`;
  els.opportunityDialogUpdated.textContent = opportunity.lastMessageAt
    ? `最近更新 ${relativeTime(opportunity.lastMessageAt)} · 聊天记录由系统自动存档`
    : "聊天记录由系统自动存档";

  if (raw.detailError && !raw.company && !raw.role) {
    els.opportunityDetailBody.innerHTML = emptyState("cloud-off", "无法读取机会详情", raw.detailError);
    return;
  }

  const messages = opportunityMessages(raw);
  const drafts = opportunityDrafts(raw);
  const consent = consentStatus(opportunity.consentStatus);
  const rationale = firstText(raw.rationale, raw.reasoning, raw.assessmentReason, raw.analysis?.summary);
  els.opportunityDetailBody.innerHTML = `
    ${raw.detailError ? `<div class="opportunity-detail-warning"><i data-lucide="triangle-alert"></i><span>${escapeHtml(raw.detailError)}</span></div>` : ""}
    <section class="opportunity-detail-overview" aria-label="机会判断概览">
      <div class="opportunity-detail-identity">
        <span class="opportunity-detail-priority priority-${opportunityPriorityTier(opportunity.priorityScore)}">
          <small>综合优先级</small><strong>${Math.round(opportunity.priorityScore)}</strong>
        </span>
        <dl>
          <div><dt>公司</dt><dd>${escapeHtml(opportunity.company)}</dd></div>
          <div><dt>岗位</dt><dd>${escapeHtml(opportunity.role)}</dd></div>
          <div><dt>招聘阶段</dt><dd>${escapeHtml(stageDisplayName(opportunity.stage, opportunity.status))}</dd></div>
          <div><dt>访客同意</dt><dd><span class="detail-consent consent-${consent.className}"><i data-lucide="${escapeAttr(consent.icon)}"></i>${escapeHtml(consent.label)}</span></dd></div>
          <div><dt>信息状态</dt><dd>${opportunityNeedsConfirmation(opportunity) ? `<span class="detail-pending"><i data-lucide="circle-help"></i>待确认</span>` : "已提取"}</dd></div>
        </dl>
      </div>
      <div class="opportunity-detail-scores">
        ${renderScore("HR 邀约意向", opportunity.invitationScore, "invitation")}
        ${renderScore("岗位匹配度", opportunity.fitScore, "fit")}
      </div>
    </section>

    <section class="opportunity-detail-section">
      <div class="opportunity-detail-section-heading">
        <div><i data-lucide="list-checks"></i><h3>招聘条件与关注点</h3></div>
        <span>${opportunity.conditions.length + opportunity.concerns.length} 项</span>
      </div>
      <div class="opportunity-facts">
        ${renderFactGroup("招聘条件", opportunity.conditions, "对方尚未明确招聘条件")}
        ${renderFactGroup("HR 关注点", opportunity.concerns, "对方关注点仍待确认")}
        ${renderPendingFields(opportunity)}
      </div>
      ${rationale ? `<div class="opportunity-rationale"><strong>综合判断</strong><p>${escapeHtml(rationale)}</p></div>` : ""}
    </section>

    <section class="opportunity-detail-section opportunity-actions-section">
      <div class="opportunity-detail-section-heading">
        <div><i data-lucide="panels-top-left"></i><h3>生成与审核</h3></div>
        <span>${state.hrAi?.status?.ready ? "Codex 回答已启用" : "Codex 不可用时退回本地模板"}</span>
      </div>
      <div class="opportunity-action-grid">
        ${renderOpportunityAction("invitation-analysis", "target", "分析邀约意向", "招聘阶段、明确证据与待确认事项", drafts)}
        ${renderOpportunityAction("interview-advice", "lightbulb", "生成面试建议", "准备重点、可能追问与适合讲述的项目", drafts)}
        ${renderOpportunityAction("resume-improvements", "file-pen-line", "生成简历改进意见", "基于 HR 关注点引用真实经历提出修改建议", drafts)}
        ${renderOpportunityAction("follow-up", "message-square-reply", "生成跟进话术", "下一步回复与需要补问的内容", drafts)}
      </div>
      ${renderDrafts(drafts)}
    </section>

    <div class="opportunity-detail-columns">
      <section class="opportunity-detail-section opportunity-evidence-section">
        <div class="opportunity-detail-section-heading">
          <div><i data-lucide="quote"></i><h3>判断依据</h3></div>
          <span>${opportunity.evidence.length} 条</span>
        </div>
        ${renderEvidenceList(opportunity.evidence)}
      </section>
      <section class="opportunity-detail-section opportunity-transcript-section">
        <div class="opportunity-detail-section-heading">
          <div><i data-lucide="messages-square"></i><h3>聊天原文</h3></div>
          <span>${messages.length} 条</span>
        </div>
        ${renderOpportunityMessages(messages)}
      </section>
    </div>`;
}

function renderFactGroup(label, items, emptyText) {
  return `<div class="opportunity-fact-group"><strong>${escapeHtml(label)}</strong>${items.length
    ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : `<p>${escapeHtml(emptyText)}</p>`}</div>`;
}

function renderPendingFields(opportunity) {
  if (!opportunity.pendingFields.length) return "";
  return `<div class="opportunity-fact-group is-pending"><strong>待确认事项</strong><ul>${opportunity.pendingFields.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>`;
}

function renderOpportunityAction(type, icon, title, description, drafts) {
  const draft = drafts.find((item) => item.type === type);
  const busy = state.hrActionBusy === type;
  const status = busy ? { label: "生成中", className: "generating" } : draftStatus(draft?.status);
  return `<div class="opportunity-action-item">
    <span class="opportunity-action-icon"><i data-lucide="${escapeAttr(icon)}"></i></span>
    <div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(description)}</p><span class="draft-status status-${status.className}">${escapeHtml(status.label)}</span></div>
    <button class="button button-secondary" type="button" data-hr-action="${escapeAttr(type)}" ${busy ? "disabled" : ""}>
      <i data-lucide="${busy ? "loader-circle" : (draft ? "refresh-cw" : "file-plus-2")}"></i>
      <span>${busy ? "生成中" : (draft ? "重新生成" : "生成")}</span>
    </button>
  </div>`;
}

function renderDrafts(drafts) {
  if (!drafts.length) return `<div class="opportunity-drafts-empty"><i data-lucide="file-clock"></i><span>生成的内容会在这里等待审核，原始简历不会被改写。</span></div>`;
  return `<div class="opportunity-drafts"><div class="opportunity-drafts-heading"><strong>生成内容</strong><span>${drafts.length} 份</span></div>${drafts.map((draft) => {
    const status = draftStatus(draft.status);
    const busy = state.hrDraftBusy === draft.id;
    const localTemplate = !draft.generator || draft.generator === "local-template" || draft.isAiGenerated === false;
    const sourceLabel = localTemplate
      ? "本地模板生成，未调用 AI"
      : draft.generator === "codex"
        ? "Codex 生成"
        : "备用 Responses API 生成";
    return `<article class="opportunity-draft">
      <header><div><span>${escapeHtml(actionDisplayName(draft.type))}</span><time>${escapeHtml(relativeTime(draft.updatedAt || draft.createdAt))}</time></div><span class="draft-status status-${status.className}">${escapeHtml(status.label)}</span></header>
      <p class="opportunity-draft-source"><i data-lucide="${localTemplate ? "layout-template" : "sparkles"}"></i>${sourceLabel}</p>
      <div class="opportunity-draft-content">${renderMarkdown(draft.content || draft.text || "内容生成中")}</div>
      <footer class="opportunity-draft-actions">
        ${draft.content || draft.text ? `<button class="icon-button" type="button" data-copy-draft="${escapeAttr(draft.id)}" title="复制草稿" aria-label="复制草稿"><i data-lucide="copy"></i></button>` : ""}
        ${draft.status !== "reviewed" ? `<button class="button button-secondary" type="button" data-draft-id="${escapeAttr(draft.id)}" data-draft-status="reviewed" ${busy ? "disabled" : ""}>已审核</button>` : ""}
        ${draft.status !== "approved" ? `<button class="button button-primary" type="button" data-draft-id="${escapeAttr(draft.id)}" data-draft-status="approved" ${busy ? "disabled" : ""}>确认可用</button>` : ""}
        ${draft.status !== "rejected" ? `<button class="button button-danger" type="button" data-draft-id="${escapeAttr(draft.id)}" data-draft-status="rejected" ${busy ? "disabled" : ""}>退回</button>` : ""}
      </footer>
    </article>`;
  }).join("")}</div>`;
}

function renderEvidenceList(evidence) {
  if (!evidence.length) return `<div class="opportunity-section-empty"><i data-lucide="circle-help"></i><span>暂无足够的聊天证据</span></div>`;
  return `<ol class="opportunity-evidence-list">${evidence.map((item, index) => `<li>
    <span>${String(index + 1).padStart(2, "0")}</span>
    <div><q>${escapeHtml(item.quote)}</q><small>${escapeHtml(item.label || "聊天原文")}${item.createdAt ? ` · ${escapeHtml(messageTime(item.createdAt))}` : ""}</small></div>
  </li>`).join("")}</ol>`;
}

function renderOpportunityMessages(messages) {
  if (!messages.length) return `<div class="opportunity-section-empty"><i data-lucide="messages-square"></i><span>暂无可展示的聊天原文</span></div>`;
  return `<div class="opportunity-transcript">${messages.map((message) => `<div class="opportunity-transcript-message is-${escapeAttr(message.direction)}">
    <div><strong>${message.direction === "inbound" ? "HR" : "ClawBot"}</strong><time>${escapeHtml(messageTime(message.createdAt))}</time></div>
    <p>${escapeHtml(message.text)}</p>
  </div>`).join("")}</div>`;
}

async function handleOpportunityDialogAction(event) {
  const actionButton = event.target.closest("[data-hr-action]");
  if (actionButton) {
    await generateOpportunityDraft(actionButton.dataset.hrAction);
    return;
  }
  const reviewButton = event.target.closest("[data-draft-status]");
  if (reviewButton) {
    await updateHrDraftStatus(reviewButton.dataset.draftId, reviewButton.dataset.draftStatus);
    return;
  }
  const copyButton = event.target.closest("[data-copy-draft]");
  if (!copyButton) return;
  const draft = opportunityDrafts(state.selectedOpportunity || {}).find((item) => String(item.id) === copyButton.dataset.copyDraft);
  await copyHrValue(draft?.content || draft?.text, "草稿已复制");
}

async function generateOpportunityDraft(action) {
  if (!state.selectedOpportunityId || state.hrActionBusy) return;
  state.hrActionBusy = action;
  renderOpportunityDetail();
  drawIcons();
  try {
    const result = await api(
      `/api/hr/opportunities/${encodeURIComponent(state.selectedOpportunityId)}/actions/${encodeURIComponent(action)}`,
      { method: "POST", body: {} }
    );
    if (result.opportunity) state.selectedOpportunity = result.opportunity;
    const detail = await api(`/api/hr/opportunities/${encodeURIComponent(state.selectedOpportunityId)}`);
    state.selectedOpportunity = detail.opportunity || detail;
    const summaryIndex = state.opportunities.findIndex((item) => String(item.id) === state.selectedOpportunityId);
    if (summaryIndex >= 0) state.opportunities[summaryIndex] = { ...state.opportunities[summaryIndex], ...state.selectedOpportunity };
    renderOpportunities();
    const modeLabel = result.generation?.mode === "codex"
      ? "已由 Codex 生成"
      : result.generation?.mode === "responses-api"
        ? "已由备用 Responses API 生成"
        : "已由本地模板生成";
    toast(`${actionDisplayName(action)}${modeLabel}，等待你的审核`);
  } catch (error) {
    toast(error.message || "内容生成失败", true);
  } finally {
    state.hrActionBusy = "";
    renderOpportunityDetail();
    drawIcons();
  }
}

async function updateHrDraftStatus(draftId, status) {
  if (!draftId || state.hrDraftBusy) return;
  state.hrDraftBusy = draftId;
  renderOpportunityDetail();
  drawIcons();
  try {
    const result = await api(`/api/hr/drafts/${encodeURIComponent(draftId)}`, {
      method: "PATCH",
      body: { status }
    });
    if (result.draft && state.selectedOpportunity) {
      const drafts = Array.isArray(state.selectedOpportunity.drafts) ? state.selectedOpportunity.drafts : [];
      state.selectedOpportunity.drafts = drafts.map((draft) => String(draft.id) === String(draftId) ? result.draft : draft);
    }
    toast(({ reviewed: "已标记为审核完成", approved: "草稿已确认可用", rejected: "草稿已退回" })[status] || "审核状态已更新");
  } catch (error) {
    toast(error.message || "无法更新审核状态", true);
  } finally {
    state.hrDraftBusy = "";
    renderOpportunityDetail();
    drawIcons();
  }
}

function normalizeOpportunity(raw) {
  const evidenceSource = Array.isArray(raw?.evidence) ? raw.evidence : [];
  const pendingFields = [...new Set([
    ...stringList(raw?.pendingFields),
    ...stringList(raw?.missingFields),
    ...stringList(Array.isArray(raw?.needsConfirmation) ? raw.needsConfirmation : raw?.needsConfirmationItems)
  ])];
  const invitationScore = normalizedScore(raw?.invitationScore ?? raw?.invitationIntentScore);
  const fitScore = normalizedScore(raw?.fitScore ?? raw?.jobFitScore);
  const derivedPriority = [invitationScore, fitScore].filter(Number.isFinite);
  const priorityScore = normalizedScore(raw?.priorityScore)
    ?? (derivedPriority.length ? derivedPriority.reduce((sum, value) => sum + value, 0) / derivedPriority.length : 0);
  const companyValue = firstText(raw?.company, raw?.companyName);
  const roleValue = firstText(raw?.role, raw?.jobTitle, raw?.position);
  return {
    ...raw,
    id: String(raw?.id || raw?.opportunityId || ""),
    company: companyValue || "公司待确认",
    role: roleValue || "岗位待确认",
    visitorLabel: firstText(raw?.visitor?.displayName, raw?.visitorName, raw?.contactName, raw?.visitorLabel) || `扫码访客 ${shortId(String(raw?.visitorId || ""))}`.trim(),
    stage: String(raw?.stage || "unknown"),
    status: String(raw?.status || "active"),
    invitationScore,
    fitScore,
    priorityScore: Number.isFinite(priorityScore) ? priorityScore : 0,
    concerns: stringList(raw?.concerns || raw?.focusPoints),
    conditions: stringList(raw?.conditions || raw?.requirements),
    pendingFields,
    evidence: evidenceSource.map(normalizeEvidence).filter((item) => item.quote),
    messageCount: Math.max(0, Number(raw?.messageCount || (Array.isArray(raw?.messages) ? raw.messages.length : 0)) || 0),
    lastMessageAt: raw?.lastMessageAt || raw?.updatedAt || raw?.createdAt || "",
    consentStatus: normalizeConsentStatus(raw?.consentStatus ?? raw?.visitor?.consentStatus ?? raw?.consent?.status),
    consentedAt: raw?.consentedAt || raw?.visitor?.consentAt || raw?.consent?.acceptedAt || "",
    needsConfirmation: raw?.needsConfirmation === true
  };
}

function normalizeEvidence(item) {
  if (typeof item === "string") return { id: "", quote: item, label: "聊天原文", createdAt: "" };
  return {
    id: String(item?.id || item?.messageId || ""),
    quote: firstText(item?.quote, item?.text, item?.content),
    label: firstText(item?.label, item?.kind, item?.type),
    createdAt: item?.createdAt || item?.timestamp || ""
  };
}

function opportunityMessages(raw) {
  const source = Array.isArray(raw.messages) ? raw.messages : (Array.isArray(raw.transcript) ? raw.transcript : []);
  return source.map((message) => ({
    id: String(message?.id || message?.messageId || ""),
    direction: normalizeMessageDirection(message?.direction || message?.role || message?.sender),
    text: messageText(message?.text ?? message?.content ?? message?.body),
    createdAt: message?.createdAt || message?.timestamp || message?.time || ""
  })).filter((message) => message.text);
}

function opportunityDrafts(raw) {
  const source = Array.isArray(raw.drafts) ? raw.drafts : (Array.isArray(raw.generatedDrafts) ? raw.generatedDrafts : []);
  return source.map((draft) => ({
    ...draft,
    id: String(draft?.id || draft?.draftId || `${draft?.type || "draft"}-${draft?.createdAt || ""}`),
    type: normalizeActionType(draft?.type || draft?.action),
    status: String(draft?.status || "draft")
  })).sort((left, right) => dateValue(right.updatedAt || right.createdAt) - dateValue(left.updatedAt || left.createdAt));
}

function messageText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => typeof item === "string" ? item : firstText(item?.text, item?.content)).filter(Boolean).join("\n");
  if (value && typeof value === "object") return firstText(value.text, value.content);
  return "";
}

function normalizeMessageDirection(value) {
  const normalized = String(value || "").toLowerCase();
  return ["outbound", "assistant", "bot", "clawbot"].includes(normalized) ? "outbound" : "inbound";
}

function normalizeActionType(value) {
  const normalized = String(value || "").toLowerCase().replace(/_/g, "-");
  return ({
    "invitation": "invitation-analysis",
    "invitation-intent": "invitation-analysis",
    "interview": "interview-advice",
    "resume": "resume-improvements",
    "resume-improvement": "resume-improvements",
    "followup": "follow-up",
    "follow-up-copy": "follow-up"
  })[normalized] || normalized;
}

function actionDisplayName(type) {
  return ({
    "invitation-analysis": "邀约意向分析",
    "interview-advice": "面试建议",
    "resume-improvements": "简历改进意见",
    "follow-up": "跟进话术"
  })[normalizeActionType(type)] || "生成内容";
}

function draftStatus(value) {
  return ({
    generating: { label: "生成中", className: "generating" },
    queued: { label: "等待生成", className: "generating" },
    draft: { label: "待审核", className: "pending" },
    pending: { label: "待审核", className: "pending" },
    pending_review: { label: "待审核", className: "pending" },
    approved: { label: "已确认", className: "approved" },
    reviewed: { label: "已审核", className: "approved" },
    rejected: { label: "已退回", className: "rejected" },
    failed: { label: "生成失败", className: "rejected" }
  })[String(value || "").toLowerCase()] || { label: "尚未生成", className: "empty" };
}

function opportunityNeedsConfirmation(opportunity) {
  return Boolean(
    opportunity.needsConfirmation
    || opportunity.pendingFields.length
    || !Number.isFinite(opportunity.invitationScore)
    || !Number.isFinite(opportunity.fitScore)
    || opportunity.company === "公司待确认"
    || opportunity.role === "岗位待确认"
    || opportunity.consentStatus === "pending"
  );
}

function normalizedScore(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const scaled = numeric >= 0 && numeric <= 1 ? numeric * 100 : numeric;
  return Math.max(0, Math.min(100, scaled));
}

function opportunityPriorityTier(value) {
  if (value >= 70) return "high";
  if (value >= 45) return "medium";
  return "normal";
}

function priorityDisplayName(tier) {
  return ({ high: "高优先", medium: "需跟进", normal: "观察" })[tier] || "观察";
}

function stageDisplayName(stage, status = "") {
  const normalized = String(stage || status || "").toLowerCase().replace(/_/g, "-");
  return ({
    unknown: "阶段待确认",
    new: "新机会",
    sourcing: "初次接触",
    screening: "初步沟通",
    "interview-proposed": "已提议面试",
    "interview-scheduled": "面试已安排",
    "in-conversation": "沟通中",
    active: "沟通中",
    interview: "面试阶段",
    offer: "Offer 阶段",
    closed: "已结束",
    rejected: "已结束",
    archived: "已归档"
  })[normalized] || stage || status || "阶段待确认";
}

function normalizeConsentStatus(value) {
  const normalized = String(value || "").toLowerCase().replace(/_/g, "-");
  if (["accepted", "approved", "consented", "granted"].includes(normalized)) return "accepted";
  if (["declined", "rejected", "denied"].includes(normalized)) return "declined";
  if (["not-required", "notrequired"].includes(normalized)) return "not-required";
  return "pending";
}

function consentStatus(value) {
  return ({
    accepted: { label: "已同意记录用途", className: "accepted", icon: "badge-check" },
    declined: { label: "未同意记录", className: "declined", icon: "circle-x" },
    "not-required": { label: "无需确认", className: "neutral", icon: "minus" },
    pending: { label: "等待同意", className: "pending", icon: "clock-3" }
  })[value] || { label: "等待同意", className: "pending", icon: "clock-3" };
}

function stringList(value) {
  if (Array.isArray(value)) return value.map((item) => typeof item === "string" ? item : firstText(item?.text, item?.label, item?.value)).filter(Boolean);
  if (typeof value === "string") return value.split(/\r?\n|[,，；;]/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function firstText(...values) {
  const value = values.find((item) => typeof item === "string" && item.trim());
  return value ? value.trim() : "";
}

function dateValue(value) {
  const timestamp = new Date(value || 0).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function renderHrEntry() {
  const web = state.hrWeb || {};
  const entry = web.entry || state.hrEntry || {};
  const settings = web.settings || {};
  const available = state.hrAvailable === true && Boolean(state.hrWeb);
  const configured = Boolean(entry.configured);
  const enabled = Boolean(entry.enabled ?? settings.enabled);
  const publicLink = firstText(entry.publicLink);
  const listenerUrl = firstText(entry.listenerUrl) || "http://127.0.0.1:8789";
  const stableId = firstText(entry.stableId);
  const qrSource = firstText(entry.qrDataUrl, entry.qrImageUrl, String(entry.qrContent || "").startsWith("data:image/") ? entry.qrContent : "");
  const reachabilityLabels = {
    "public-https": ["公网 HTTPS", "可长期分享"],
    "local-network": ["同一局域网", "测试入口"],
    "this-device-only": ["仅本机", "不可供手机访问"]
  };
  const reachability = reachabilityLabels[entry.reachability] || ["正在检查", "检查中"];

  els.hrEntryStatus.className = `hr-entry-status${enabled ? " is-enabled" : (configured ? " is-ready" : "")}`;
  els.hrEntryStatus.textContent = !available ? "不可用" : (enabled ? "接待中" : "未启用");
  els.hrEntrySummaryText.textContent = !available
    ? "访客服务尚未加载"
    : (enabled ? `${reachability[0]}入口已启用` : "启用后，HR 可用微信扫码开始对话");
  els.hrEntryStableId.textContent = stableId || "尚未生成";
  els.hrEntryPublicLink.textContent = publicLink || "等待生成固定访客链接";
  els.hrEntryPublicLink.title = publicLink;
  els.copyHrEntryLinkButton.disabled = !publicLink;
  els.hrPublicListenerTarget.textContent = listenerUrl;
  els.hrPublicListenerTarget.title = listenerUrl;
  els.copyHrPublicListenerButton.disabled = !listenerUrl;
  els.hrReachability.textContent = reachability[0];
  els.hrReachabilityStatus.textContent = reachability[1];
  els.hrReachabilityStatus.className = `hr-entry-status${entry.reachability === "public-https" ? " is-enabled" : " is-ready"}`;
  els.hrEntryValidityNote.textContent = firstText(entry.validityNote) || "二维码保持不变；只有主动更换密钥时才会生成新入口。";

  if (qrSource) {
    els.hrEntryQrFrame.innerHTML = `<img src="${escapeAttr(qrSource)}" alt="微信扫码招聘对话入口二维码">`;
  } else {
    els.hrEntryQrFrame.innerHTML = `<span><i data-lucide="qr-code"></i></span><small>${publicLink ? "二维码图片等待后台生成" : "启用访客接待后生成"}</small>`;
  }

  const editing = els.hrSettingsForm.contains(document.activeElement);
  if (!editing) {
    els.hrEnabledInput.checked = enabled;
    els.hrCandidateNameInput.value = firstText(settings.candidateName);
    els.hrPublicBaseUrlInput.value = firstText(settings.publicBaseUrl);
  }
  [els.hrEnabledInput, els.hrCandidateNameInput, els.hrPublicBaseUrlInput, els.saveHrSettingsButton, els.rotateHrEntryButton]
    .forEach((element) => { element.disabled = !available || state.hrSettingsSaving; });
}

function renderCredentialState(element, configured, input) {
  element.textContent = configured ? "已配置" : "未配置";
  element.classList.toggle("is-configured", configured);
  input.placeholder = configured ? "已配置；输入新值可替换" : "输入后加密保存";
}

async function saveHrSettings(event) {
  event.preventDefault();
  if (state.hrAvailable !== true || state.hrSettingsSaving) return;
  const body = {
    enabled: els.hrEnabledInput.checked,
    candidateName: els.hrCandidateNameInput.value.trim() || null,
    publicBaseUrl: els.hrPublicBaseUrlInput.value.trim() || null
  };
  state.hrSettingsSaving = true;
  els.saveHrSettingsButton.disabled = true;
  els.saveHrSettingsButton.classList.add("is-loading");
  els.saveHrSettingsButton.querySelector("span").textContent = "保存中";
  try {
    const result = await api("/api/hr/web", { method: "PUT", body });
    state.hrWeb = result;
    state.hrEntry = result.entry || state.hrEntry;
    await loadHrData(false);
    toast("微信扫码入口设置已保存");
  } catch (error) {
    toast(error.message || "无法保存扫码入口设置", true);
  } finally {
    state.hrSettingsSaving = false;
    els.saveHrSettingsButton.classList.remove("is-loading");
    els.saveHrSettingsButton.querySelector("span").textContent = "保存入口设置";
    renderHrEntry();
    drawIcons();
  }
}

async function rotateHrEntry() {
  if (!state.hrWeb || state.hrSettingsSaving) return;
  if (!window.confirm("更换二维码后，旧二维码将不能再创建新会话。确认继续吗？")) return;
  state.hrSettingsSaving = true;
  renderHrEntry();
  try {
    const result = await api("/api/hr/web/rotate", { method: "POST", body: {} });
    state.hrWeb = result;
    state.hrEntry = result.entry || state.hrEntry;
    toast("已生成新的唯一二维码");
  } catch (error) {
    toast(error.message || "无法更换二维码", true);
  } finally {
    state.hrSettingsSaving = false;
    renderHrEntry();
    drawIcons();
  }
}

function renderHrAi() {
  const ai = state.hrAi || {};
  const settings = ai.settings || {};
  const status = ai.status || {};
  const available = state.hrAvailable === true && Boolean(state.hrAi);
  const ready = status.ready === true;
  const enabled = settings.enabled === true;
  els.hrAiStatus.className = `hr-entry-status${ready ? " is-enabled" : (enabled ? " is-ready" : "")}`;
  els.hrAiStatus.textContent = ready ? "已就绪" : (enabled ? "需检查" : "未启用");
  const detail = firstText(status.detail) || "备用模型未配置；访客回答仍会优先调用本机 Codex";
  els.hrAiStatusDetail.querySelector("span").textContent = detail;
  const editing = els.hrAiSettingsForm.contains(document.activeElement);
  if (!editing) {
    els.hrAiEnabledInput.checked = enabled;
    els.hrAiEndpointInput.value = firstText(settings.endpoint) || "https://api.openai.com/v1/responses";
    els.hrAiModelInput.value = firstText(settings.model);
  }
  const writable = available && settings.readOnly !== true;
  [els.hrAiEnabledInput, els.hrAiEndpointInput, els.hrAiModelInput, els.hrAiApiKeyInput, els.saveHrAiSettingsButton]
    .forEach((element) => { element.disabled = !writable || state.hrAiSaving; });
  renderCredentialState(els.hrAiApiKeyStatus, Boolean(settings.hasApiKey), els.hrAiApiKeyInput);
}

async function saveHrAiSettings(event) {
  event.preventDefault();
  if (!state.hrAi || state.hrAiSaving) return;
  const body = {
    enabled: els.hrAiEnabledInput.checked,
    endpoint: els.hrAiEndpointInput.value.trim() || null,
    model: els.hrAiModelInput.value.trim() || null
  };
  if (els.hrAiApiKeyInput.value) body.apiKey = els.hrAiApiKeyInput.value;
  state.hrAiSaving = true;
  renderHrAi();
  els.saveHrAiSettingsButton.classList.add("is-loading");
  els.saveHrAiSettingsButton.querySelector("span").textContent = "保存中";
  try {
    state.hrAi = await api("/api/hr/ai/settings", { method: "PUT", body });
    els.hrAiApiKeyInput.value = "";
    toast(state.hrAi?.status?.ready ? "备用 Responses API 已启用" : "备用设置已保存");
  } catch (error) {
    toast(error.message || "无法保存备用设置", true);
  } finally {
    state.hrAiSaving = false;
    els.saveHrAiSettingsButton.classList.remove("is-loading");
    els.saveHrAiSettingsButton.querySelector("span").textContent = "保存备用设置";
    renderHrAi();
    drawIcons();
  }
}

function renderHrMaterials() {
  const materials = state.hrMaterials;
  const supported = Boolean(materials && materials.supported !== false);
  const editable = Boolean(materials && materials.supported === true && materials.readOnly !== true);
  const disclosure = firstText(materials?.disclosure, materials?.aiDisclosure, materials?.consentMessage);
  const bio = firstText(materials?.bio, materials?.introduction, materials?.profile);
  const targetRoles = stringList(state.hrSettings?.targetRoles);
  const profileKeywords = stringList(state.hrSettings?.profileKeywords);
  const resume = materials?.resume || {};
  const knowledge = materials?.knowledgeBase || materials?.knowledge || {};
  const materialsBusy = state.hrMaterialsSaving || Boolean(state.hrMaterialUploading);

  els.hrMaterialsSupport.className = `hr-materials-support${supported ? " is-supported" : ""}`;
  els.hrMaterialsSupport.textContent = !materials ? "待配置" : (editable ? "可编辑" : "只读状态");
  const editing = els.hrMaterialsForm.contains(document.activeElement);
  if (!editing) {
    els.hrDisclosureInput.value = disclosure;
    els.hrBioInput.value = bio;
    els.hrTargetRolesInput.value = targetRoles.join("\n");
    els.hrProfileKeywordsInput.value = profileKeywords.join("\n");
  }
  els.hrDisclosureInput.disabled = !editable;
  els.hrBioInput.disabled = !editable;
  els.hrTargetRolesInput.disabled = !editable;
  els.hrProfileKeywordsInput.disabled = !editable;
  els.hrResumeFileInput.disabled = !editable || materialsBusy;
  els.selectHrResumeButton.disabled = !editable || materialsBusy;
  els.hrKnowledgeFilesInput.disabled = !editable || materialsBusy;
  els.selectHrKnowledgeButton.disabled = !editable || materialsBusy;
  els.hrResumePathInput.disabled = !editable || materialsBusy;
  els.hrKnowledgeBasePathsInput.disabled = !editable || materialsBusy;
  els.hrClearKnowledgeInput.disabled = !editable || materialsBusy;
  els.saveHrMaterialsButton.disabled = !editable || materialsBusy;
  els.hrMaterialsHint.textContent = editable
    ? "保存后用于访客同意流程；原始简历 PDF 不会被生成建议覆盖。"
    : "资料保存接口尚未启用；当前只展示后台返回的真实配置状态。";

  const resumeConfigured = Boolean(resume.configured ?? resume.url ?? resume.name);
  const resumeName = firstText(resume.name, resume.fileName);
  const resumeDetail = resumeConfigured
    ? `${resumeName || "简历 PDF 已配置"}${resume.hash ? ` · 校验 ${shortId(String(resume.hash))}` : ""}`
    : "未配置原始简历 PDF";
  els.hrResumeStatus.classList.toggle("is-configured", resumeConfigured);
  els.hrResumeStatus.querySelector("small").textContent = resumeDetail;
  const resumeUrl = firstText(resume.url, resume.downloadUrl);
  els.hrResumeLink.hidden = !resumeUrl;
  if (resumeUrl) els.hrResumeLink.href = resumeUrl;

  const knowledgeConfigured = Boolean(knowledge.configured ?? Number(knowledge.documentCount) > 0);
  const knowledgeCount = Math.max(0, Number(knowledge.documentCount || knowledge.count || 0) || 0);
  const knowledgeNames = (Array.isArray(knowledge.documents) ? knowledge.documents : [])
    .map((document) => firstText(document?.name, document?.title))
    .filter(Boolean);
  els.hrKnowledgeStatus.classList.toggle("is-configured", knowledgeConfigured);
  els.hrKnowledgeStatus.querySelector("small").textContent = knowledgeConfigured
    ? `${knowledgeCount ? `${knowledgeCount} 份资料` : "知识库已配置"}${knowledgeNames.length ? ` · ${knowledgeNames.slice(0, 3).join("、")}` : ""}${knowledge.updatedAt ? ` · ${relativeTime(knowledge.updatedAt)}更新` : ""}`
    : "回答知识库尚未配置";
  els.hrKnowledgeStatus.querySelector("small").title = knowledgeNames.join("、");
  const knowledgeBadge = els.hrKnowledgeStatus.querySelector(".hr-material-badge");
  knowledgeBadge.textContent = knowledgeConfigured ? "已就绪" : "待配置";
}

async function uploadSelectedHrMaterials(kind) {
  if (state.hrMaterialUploading) return;
  const input = kind === "resume" ? els.hrResumeFileInput : els.hrKnowledgeFilesInput;
  const files = Array.from(input.files || []);
  if (!files.length) return;
  if (kind === "resume" && files.length !== 1) {
    toast("一次只能上传一份简历 PDF", true);
    input.value = "";
    return;
  }
  if (kind === "knowledge" && files.length > 20) {
    toast("一次最多上传 20 份知识资料", true);
    input.value = "";
    return;
  }

  state.hrMaterialUploading = kind;
  renderHrMaterials();
  const status = kind === "resume" ? els.hrResumeUploadState : els.hrKnowledgeUploadState;
  const field = status.closest(".hr-upload-field");
  field?.classList.add("is-uploading");
  try {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const metadata = validateHrUploadFile(kind, file);
      status.textContent = files.length > 1
        ? `正在上传 ${index + 1}/${files.length}：${file.name}`
        : `正在上传：${file.name}`;
      const result = await uploadHrMaterialFile(kind, file, metadata.contentType);
      state.hrMaterials = result.materials || state.hrMaterials;
    }
    status.textContent = kind === "resume"
      ? `已上传：${files[0].name}`
      : `已追加 ${files.length} 份资料`;
    renderHrMaterials();
    toast(kind === "resume" ? "简历 PDF 已上传" : "知识资料已追加");
  } catch (error) {
    status.textContent = error.message || "上传失败";
    toast(error.message || "无法上传资料", true);
  } finally {
    input.value = "";
    field?.classList.remove("is-uploading");
    state.hrMaterialUploading = "";
    renderHrMaterials();
    drawIcons();
  }
}

function validateHrUploadFile(kind, file) {
  const extension = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  const rules = kind === "resume"
    ? { ".pdf": { contentType: "application/pdf", maxBytes: 20 * 1024 * 1024 } }
    : {
        ".pdf": { contentType: "application/pdf", maxBytes: 20 * 1024 * 1024 },
        ".docx": { contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", maxBytes: 20 * 1024 * 1024 },
        ".txt": { contentType: "text/plain", maxBytes: 512 * 1024 },
        ".md": { contentType: "text/markdown", maxBytes: 512 * 1024 }
      };
  const rule = rules[extension];
  if (!rule) throw new Error(kind === "resume" ? "简历只支持 PDF" : "知识资料只支持 PDF、DOCX、TXT、MD");
  if (!file.size) throw new Error(`${file.name} 是空文件`);
  if (file.size > rule.maxBytes) throw new Error(`${file.name} 超过大小限制`);
  return rule;
}

async function uploadHrMaterialFile(kind, file, contentType) {
  const response = await fetch(`/api/hr/materials/uploads/${encodeURIComponent(kind)}`, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      "X-Codex-Weixin-Token": state.requestToken,
      "X-Codex-Weixin-Filename": encodeURIComponent(file.name)
    },
    body: file
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `上传失败 (${response.status})`);
  return data;
}

async function saveHrMaterials(event) {
  event.preventDefault();
  const materials = state.hrMaterials;
  const editable = Boolean(materials && materials.supported === true && materials.readOnly !== true);
  if (!editable || state.hrMaterialsSaving || state.hrMaterialUploading) return;
  const endpoint = String(materials.saveEndpoint || "/api/hr/materials");
  if (!endpoint.startsWith("/api/hr/")) {
    toast("资料保存地址不受信任", true);
    return;
  }
  const disclosure = els.hrDisclosureInput.value.trim();
  if (new TextEncoder().encode(disclosure).byteLength > 1024) {
    toast("AI 身份与记录用途说明不能超过 1024 个 UTF-8 字节", true);
    return;
  }
  const bio = els.hrBioInput.value.trim();
  const introduction = [bio, state.hrSettings?.welcomeMessage]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join("\n\n");
  if (new TextEncoder().encode(introduction).byteLength > 2048) {
    toast("个人简介与欢迎语合计不能超过 2048 个 UTF-8 字节", true);
    return;
  }
  state.hrMaterialsSaving = true;
  els.saveHrMaterialsButton.disabled = true;
  els.saveHrMaterialsButton.classList.add("is-loading");
  try {
    const materialsBody = {
      disclosure,
      bio
    };
    const resumePath = els.hrResumePathInput.value.trim();
    const knowledgeBasePaths = els.hrKnowledgeBasePathsInput.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    if (resumePath) materialsBody.resumePath = resumePath;
    if (els.hrClearKnowledgeInput.checked) materialsBody.knowledgeBasePaths = [];
    else if (knowledgeBasePaths.length) materialsBody.knowledgeBasePaths = knowledgeBasePaths;
    const result = await api(endpoint, {
      method: "PUT",
      body: materialsBody
    });
    state.hrMaterials = result.materials || result;
    const settingsResult = await api("/api/hr/settings", {
      method: "PUT",
      body: {
        targetRoles: stringList(els.hrTargetRolesInput.value),
        profileKeywords: stringList(els.hrProfileKeywordsInput.value)
      }
    });
    state.hrSettings = settingsResult.settings || state.hrSettings;
    els.hrResumePathInput.value = "";
    els.hrKnowledgeBasePathsInput.value = "";
    els.hrClearKnowledgeInput.checked = false;
    renderHrMaterials();
    toast("对外资料已保存");
  } catch (error) {
    toast(error.message || "无法保存对外资料", true);
  } finally {
    state.hrMaterialsSaving = false;
    renderHrMaterials();
    drawIcons();
  }
}

function hrEntryStateText(entry) {
  if (state.hrAvailable === false) return "待启用";
  if (entry?.enabled) return "接待中";
  if (entry?.configured) return "已配置";
  return "未启用";
}

async function copyHrValue(value, successMessage) {
  const textValue = String(value || "");
  if (!textValue) return;
  try {
    await navigator.clipboard.writeText(textValue);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = textValue;
    textarea.className = "clipboard-fallback";
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
  toast(successMessage);
}

function showView(name, updateHash = true) {
  const valid = ["opportunities", "wecom"].includes(name) ? name : "opportunities";
  document.querySelectorAll("[data-view-panel]").forEach((panel) => {
    const visible = panel.dataset.viewPanel === valid;
    panel.hidden = !visible;
    panel.classList.toggle("is-visible", visible);
  });
  document.querySelectorAll(".tab[data-view]").forEach((tab) => tab.classList.toggle("is-active", tab.dataset.view === valid));
  if (updateHash && location.hash !== `#${valid}`) history.replaceState(null, "", `#${valid}`);
  if (!state.hrLoaded && !state.hrLoading) void loadHrData(false);
}

function closeDialog(id) {
  document.querySelector(`#${CSS.escape(id)}`)?.close();
}

async function api(url, options = {}) {
  const isFormData = options.body instanceof FormData;
  const headers = { ...(options.body && !isFormData ? { "Content-Type": "application/json" } : {}) };
  if (options.token !== false && state.requestToken) headers["X-Codex-Weixin-Token"] = state.requestToken;
  const response = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body ? (isFormData ? options.body : JSON.stringify(options.body)) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `请求失败 (${response.status})`);
    Object.assign(error, {
      status: response.status,
      ...(data.code ? { code: data.code } : {}),
      ...(Number.isInteger(data.activeTaskCount) ? { activeTaskCount: data.activeTaskCount } : {})
    });
    throw error;
  }
  return data;
}

function emptyState(icon, title, description = "", action = "") {
  return `<div class="empty-state"><div class="empty-state-inner"><span class="empty-icon"><i data-lucide="${escapeAttr(icon)}"></i></span><h2>${escapeHtml(title)}</h2>${description ? `<p>${escapeHtml(description)}</p>` : ""}${action}</div></div>`;
}

function shortId(value) {
  if (!value || value.length <= 26) return value || "--";
  return `${value.slice(0, 12)}...${value.slice(-8)}`;
}

function relativeTime(value) {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return "时间待确认";
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "刚刚";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(new Date(value));
}

function messageTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function toast(message, error = false) {
  const node = document.createElement("div");
  node.className = `toast${error ? " is-error" : ""}`;
  node.textContent = message;
  document.querySelector("#toastRegion").append(node);
  window.setTimeout(() => node.remove(), 3800);
}

function drawIcons() {
  window.lucide?.createIcons({ attrs: { "aria-hidden": "true" } });
}

function renderMarkdown(value) {
  const source = String(value ?? "");
  if (!window.marked?.parse || !window.DOMPurify?.sanitize) {
    return escapeHtml(source).replace(/\n/g, "<br>");
  }
  const rendered = window.marked.parse(source, { gfm: true, breaks: true });
  const clean = window.DOMPurify.sanitize(rendered, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "img"],
    FORBID_ATTR: ["style"]
  });
  const template = document.createElement("template");
  template.innerHTML = clean;
  template.content.querySelectorAll("a").forEach((link) => {
    link.target = "_blank";
    link.rel = "noreferrer noopener";
  });
  return template.innerHTML;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
