import { ApiClientError, apiBinaryRequest, apiRequest } from "./api.js";
import { adminAuth } from "./admin-auth.js";
import { formatText, getContent, loadContent } from "./content.js";

const MIN_DEV_TOKEN_LENGTH = 24;
const MIN_PASSWORD_LENGTH = 8;
const passwordSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme"
});
const STATUS_ORDER = Object.freeze(["pending", "approved", "rejected"]);
const messages = {
  authenticating: "驗證中⋯",
  authSubmitLabel: "驗證並進入",
  localSubmitLabel: "登入管理後台",
  localLoginFailed: "帳號或密碼錯誤。",
  localLoginRateLimited: "登入嘗試次數過多，請稍後再試。",
  passwordSubmitLabel: "儲存新密碼",
  passwordSaving: "儲存中⋯",
  passwordMismatch: "新密碼與確認密碼不一致。",
  passwordTooShort: "新密碼需為 8–128 個字元，且不可只有空白。",
  passwordChanged: "密碼已更新，其他裝置的登入狀態已失效。",
  passwordChangeFailed: "暫時無法修改密碼，請再試一次。",
  sessionExpired: "管理員登入已過期，請重新登入。",
  unknownTime: "時間未知",
  pendingBadge: "待審核",
  approvedBadge: "已核准",
  rejectedBadge: "已拒絕",
  approve: "核准",
  reject: "拒絕",
  approving: "核准中⋯",
  rejecting: "拒絕中⋯",
  approveSuccess: "投稿 #{id} 已核准。",
  rejectSuccess: "投稿 #{id} 已拒絕。",
  rejectPrompt: "確定拒絕這篇投稿？",
  cancel: "取消",
  confirmReject: "確定拒絕",
  genericModerationError: "處理失敗，請再試一次。",
  authNotConfigured: "管理員登入尚未設定完成。",
  invalidCredential: "憑證無效，請重新輸入。",
  githubSessionExpired: "GitHub 管理員 session 已過期。",
  notAdministrator: "Unauthorized / Not an administrator",
  oauthCancelled: "GitHub 登入已取消。",
  oauthFailed: "GitHub 登入失敗，請重新嘗試。",
  signedOut: "已登出。",
  signedOutAuditWarning: "已登出，但稽核紀錄暫時無法寫入。",
  logoutFailed: "暫時無法登出，請再試一次。",
  backendUnavailable: "暫時無法連線到後端服務。",
  credentialTooShort: "請輸入至少 {min} 個字元的開發憑證。",
  defaultLoadError: "請確認後端服務是否正常。",
  username: "@{username}",
  role: "{role}"
};
const renderMessages = {
  statusLabel: "Render status: {status}",
  statuses: {
    notRendered: "Not rendered",
    rendering: "Rendering",
    ready: "Ready",
    failed: "Failed"
  },
  generatePreview: "Generate Preview",
  generatingPreview: "Generating…",
  preview: "Preview",
  regenerate: "Regenerate",
  regenerating: "Regenerating…",
  success: "投稿 #{id} 的預覽圖片已產生。",
  failed: "圖片產生失敗，請再試一次。",
  tooLong: "投稿內容太長，無法產生貼文圖片。",
  notConfigured: "正式圖片字型或儲存空間尚未設定完成。",
  previewAlt: "投稿 #{id} 的貼文預覽"
};

const authPanel = document.querySelector("#auth-panel");
const authKicker = document.querySelector("#auth-kicker");
const authDescription = document.querySelector("#auth-description");
const sessionAuthPanel = document.querySelector("#session-auth-panel");
const localAuthForm = document.querySelector("#local-auth-form");
const localUsernameInput = document.querySelector("#local-username");
const localPasswordInput = document.querySelector("#local-password");
const localAuthSubmit = document.querySelector("#local-auth-submit");
const authDivider = document.querySelector("#auth-divider");
const githubAuthPanel = document.querySelector("#github-auth-panel");
const githubSignIn = document.querySelector("#github-sign-in");
const authForm = document.querySelector("#admin-auth-form");
const authTokenInput = document.querySelector("#admin-token");
const authError = document.querySelector("#auth-error");
const authSubmit = document.querySelector("#auth-submit");
const dashboard = document.querySelector("#dashboard");
const devBanner = document.querySelector("#dev-banner");
const adminUsername = document.querySelector("#admin-username");
const adminRole = document.querySelector("#admin-role");
const loadingState = document.querySelector("#loading-state");
const errorState = document.querySelector("#error-state");
const errorStateMessage = document.querySelector("#error-state-message");
const emptyState = document.querySelector("#empty-state");
const emptyStateEyebrow = document.querySelector("#empty-state-eyebrow");
const emptyStateTitle = document.querySelector("#empty-state-title");
const emptyStateBody = document.querySelector("#empty-state-body");
const submissionsList = document.querySelector("#submissions-list");
const queuePanel = document.querySelector("#queue-panel");
const queueStatus = document.querySelector("#queue-status");
const refreshButton = document.querySelector("#refresh-button");
const retryButton = document.querySelector("#retry-button");
const emptyRefreshButton = document.querySelector("#empty-refresh-button");
const clearAuthButton = document.querySelector("#clear-auth-button");
const passwordFormToggle = document.querySelector("#password-form-toggle");
const passwordAccountPanel = document.querySelector("#password-account-panel");
const passwordFormCancel = document.querySelector("#password-form-cancel");
const passwordChangeForm = document.querySelector("#password-change-form");
const currentPasswordInput = document.querySelector("#current-password");
const newPasswordInput = document.querySelector("#new-password");
const confirmPasswordInput = document.querySelector("#confirm-password");
const passwordChangeSubmit = document.querySelector("#password-change-submit");
const passwordFormStatus = document.querySelector("#password-form-status");
const tabs = [...document.querySelectorAll(".queue-tab")];
const countElements = Object.freeze({
  pending: document.querySelector("#pending-count"),
  approved: document.querySelector("#approved-count"),
  rejected: document.querySelector("#rejected-count")
});

let activeStatus = "pending";
let contentCopy = {};
let enabledAuthProviders = Object.freeze({ github: false, local: false });
const previewUrls = new Set();

function revokePreviewUrls() {
  for (const url of previewUrls) {
    URL.revokeObjectURL(url);
  }
  previewUrls.clear();
}

function setDevAuthBusy(isBusy) {
  authTokenInput.disabled = isBusy;
  authSubmit.disabled = isBusy;
  authSubmit.querySelector("span").textContent = isBusy
    ? messages.authenticating
    : messages.authSubmitLabel;
  authForm.setAttribute("aria-busy", String(isBusy));
}

function setLocalAuthBusy(isBusy) {
  localUsernameInput.disabled = isBusy;
  localPasswordInput.disabled = isBusy;
  localAuthSubmit.disabled = isBusy;
  localAuthSubmit.querySelector("span").textContent = isBusy
    ? messages.authenticating
    : messages.localSubmitLabel;
  localAuthForm.setAttribute("aria-busy", String(isBusy));
}

function setPasswordBusy(isBusy) {
  for (const input of [currentPasswordInput, newPasswordInput, confirmPasswordInput]) {
    input.disabled = isBusy;
  }
  passwordChangeSubmit.disabled = isBusy;
  passwordFormCancel.disabled = isBusy;
  passwordChangeSubmit.textContent = isBusy
    ? messages.passwordSaving
    : messages.passwordSubmitLabel;
  passwordChangeForm.setAttribute("aria-busy", String(isBusy));
}

function hasLocalIdentity() {
  return adminAuth.identity()?.authMethods?.includes("local") === true;
}

function renderIdentity() {
  const identity = adminAuth.identity();
  adminUsername.textContent = formatText(messages.username, {
    username: identity?.username ?? identity?.githubUsername ?? ""
  });
  adminRole.textContent = formatText(messages.role, {
    role: identity?.role ?? ""
  });
  passwordFormToggle.hidden = !hasLocalIdentity() || adminAuth.mode === "dev";
}

function showAuth(message = "") {
  revokePreviewUrls();
  dashboard.hidden = true;
  authPanel.hidden = false;
  authError.textContent = message;
  authError.hidden = !message;
  adminUsername.textContent = "";
  adminRole.textContent = "";
  passwordFormToggle.hidden = true;
  closePasswordForm();
  if (adminAuth.mode === "dev") {
    authTokenInput.value = "";
    authTokenInput.focus();
  } else if (enabledAuthProviders.local) {
    localPasswordInput.value = "";
    localUsernameInput.focus();
  } else if (enabledAuthProviders.github) {
    githubSignIn.focus();
  } else {
    authError.focus();
  }
}

function showDashboard() {
  authPanel.hidden = true;
  dashboard.hidden = false;
  renderIdentity();
}

function clearPasswordFields() {
  currentPasswordInput.value = "";
  newPasswordInput.value = "";
  confirmPasswordInput.value = "";
  for (const input of [currentPasswordInput, newPasswordInput, confirmPasswordInput]) {
    input.removeAttribute("aria-invalid");
  }
}

function closePasswordForm({ restoreFocus = false } = {}) {
  passwordAccountPanel.hidden = true;
  passwordFormToggle.setAttribute("aria-expanded", "false");
  passwordFormStatus.textContent = "";
  clearPasswordFields();
  if (restoreFocus && !passwordFormToggle.hidden) {
    passwordFormToggle.focus();
  }
}

function openPasswordForm() {
  passwordAccountPanel.hidden = false;
  passwordFormToggle.setAttribute("aria-expanded", "true");
  passwordFormStatus.textContent = "";
  currentPasswordInput.focus();
}

function showPasswordStatus(message, { error = false, field } = {}) {
  passwordFormStatus.textContent = message;
  passwordFormStatus.classList.toggle("is-error", error);
  if (field) {
    field.setAttribute("aria-invalid", "true");
    field.focus();
    return;
  }
  passwordFormStatus.focus();
}

function showLocalAuthError(message) {
  authError.hidden = false;
  authError.textContent = message;
  localUsernameInput.setAttribute("aria-invalid", "true");
  localPasswordInput.setAttribute("aria-invalid", "true");
  localPasswordInput.focus();
}

function passwordGraphemeLength(value) {
  return [...passwordSegmenter.segment(value)].length;
}

function setQueueView(view) {
  loadingState.hidden = view !== "loading";
  errorState.hidden = view !== "error";
  emptyState.hidden = view !== "empty";
  submissionsList.hidden = view !== "list";
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return messages.unknownTime;
  }
  return new Intl.DateTimeFormat("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function formatPostId(id) {
  return `#${String(id).padStart(3, "0")}`;
}

function makeButton(label, className, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `button ${className}`;
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function updateCount(status, count) {
  if (countElements[status]) {
    countElements[status].textContent = String(Math.max(0, count));
  }
}

function currentCount(status) {
  return Number(countElements[status]?.textContent) || 0;
}

function announce(message) {
  queueStatus.textContent = "";
  requestAnimationFrame(() => {
    queueStatus.textContent = message;
  });
}

function emptyCopy(status, key, fallback) {
  return getContent(
    contentCopy,
    `admin.dashboard.empty.${status}.${key}`,
    fallback
  );
}

function updateQueueContext() {
  const activeTab = tabs.find((tab) => tab.dataset.status === activeStatus);
  queuePanel.setAttribute("aria-labelledby", activeTab?.id ?? "tab-pending");
  submissionsList.setAttribute(
    "aria-label",
    getContent(
      contentCopy,
      `admin.dashboard.listAriaLabels.${activeStatus}`,
      `${activeStatus} 投稿清單`
    )
  );
  const fallbacks = {
    pending: ["ALL CLEAR", "目前沒有待審核投稿", "新的投稿會顯示在這裡。"],
    approved: ["NO APPROVED POSTS", "目前沒有已核准投稿", "核准後的投稿會顯示在這裡。"],
    rejected: ["NO REJECTED POSTS", "目前沒有已拒絕投稿", "拒絕的投稿會保留在這裡供管理員查看。"]
  }[activeStatus];
  emptyStateEyebrow.textContent = emptyCopy(activeStatus, "eyebrow", fallbacks[0]);
  emptyStateTitle.textContent = emptyCopy(activeStatus, "title", fallbacks[1]);
  emptyStateBody.textContent = emptyCopy(activeStatus, "body", fallbacks[2]);
}

function selectTab(status) {
  if (!STATUS_ORDER.includes(status)) {
    return;
  }
  activeStatus = status;
  for (const tab of tabs) {
    const selected = tab.dataset.status === status;
    tab.classList.toggle("is-active", selected);
    tab.setAttribute("aria-selected", String(selected));
  }
  updateQueueContext();
}

function handleAuthFailure(error) {
  adminAuth.clearCredential();
  const message = error.code === "ADMIN_AUTH_NOT_CONFIGURED"
    ? messages.authNotConfigured
    : adminAuth.requiresCredentialEntry
      ? messages.invalidCredential
      : messages.sessionExpired;
  showAuth(message);
}

async function moderateSubmission(submission, action, card, controls) {
  controls.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  card.setAttribute("aria-busy", "true");
  const activeButton = controls.querySelector(`[data-action="${action}"]`);
  if (activeButton) {
    activeButton.textContent = action === "approve" ? messages.approving : messages.rejecting;
  }

  try {
    await apiRequest(`/api/admin/submissions/${submission.id}/${action}`, {
      method: "POST",
      headers: adminAuth.requestHeaders({ mutation: true })
    });
    card.remove();
    updateCount("pending", currentCount("pending") - 1);
    updateCount(action === "approve" ? "approved" : "rejected", currentCount(action === "approve" ? "approved" : "rejected") + 1);
    announce(formatText(action === "approve" ? messages.approveSuccess : messages.rejectSuccess, { id: submission.id }));
    if (submissionsList.childElementCount === 0) {
      setQueueView("empty");
    }
  } catch (error) {
    card.setAttribute("aria-busy", "false");
    if (error instanceof ApiClientError && [401, 403].includes(error.status)) {
      handleAuthFailure(error);
      return;
    }
    renderPendingControls(submission, card, controls);
    card.querySelector(".submission-card__error").textContent = error instanceof ApiClientError
      ? error.message
      : messages.genericModerationError;
  }
}

function showRejectConfirmation(submission, card, controls) {
  controls.replaceChildren();
  const prompt = document.createElement("span");
  prompt.className = "confirmation__prompt";
  prompt.textContent = messages.rejectPrompt;
  const cancelButton = makeButton(messages.cancel, "button--quiet", () => renderPendingControls(submission, card, controls));
  const confirmButton = makeButton(messages.confirmReject, "button--danger", () => moderateSubmission(submission, "reject", card, controls));
  confirmButton.dataset.action = "reject";
  controls.append(prompt, cancelButton, confirmButton);
  confirmButton.focus();
}

function renderPendingControls(submission, card, controls) {
  controls.replaceChildren();
  const rejectButton = makeButton(messages.reject, "button--secondary", () => showRejectConfirmation(submission, card, controls));
  rejectButton.dataset.action = "reject";
  const approveButton = makeButton(messages.approve, "button--primary", () => moderateSubmission(submission, "approve", card, controls));
  approveButton.dataset.action = "approve";
  controls.append(rejectButton, approveButton);
}

function renderStatusText(status) {
  const key = { not_rendered: "notRendered", rendering: "rendering", ready: "ready", failed: "failed" }[status] ?? "notRendered";
  return renderMessages.statuses[key];
}

function renderErrorMessage(error) {
  if (error?.code === "CONTENT_TOO_LONG_TO_RENDER") {
    return renderMessages.tooLong;
  }
  if (["RENDER_FONT_ASSET_MISSING", "RENDER_BACKGROUND_ASSET_MISSING", "IMAGE_STORAGE_NOT_CONFIGURED", "RENDERER_NOT_CONFIGURED"].includes(error?.code)) {
    return renderMessages.notConfigured;
  }
  return error instanceof ApiClientError ? error.message : renderMessages.failed;
}

async function loadPreview(submission, previewSlot) {
  try {
    const blob = await apiBinaryRequest(`/api/admin/submissions/${submission.id}/preview`, {
      headers: adminAuth.requestHeaders()
    });
    if (!previewSlot.isConnected) {
      return;
    }
    const url = URL.createObjectURL(blob);
    previewUrls.add(url);
    const figure = document.createElement("figure");
    figure.className = "render-preview";
    const label = document.createElement("figcaption");
    label.textContent = renderMessages.preview;
    const image = document.createElement("img");
    image.src = url;
    image.alt = formatText(renderMessages.previewAlt, { id: submission.id });
    image.addEventListener("load", () => previewSlot.setAttribute("aria-busy", "false"), { once: true });
    figure.append(label, image);
    previewSlot.replaceChildren(figure);
  } catch (error) {
    if (error instanceof ApiClientError && [401, 403].includes(error.status)) {
      handleAuthFailure(error);
      return;
    }
    previewSlot.setAttribute("aria-busy", "false");
    const message = document.createElement("p");
    message.className = "render-preview__error";
    message.textContent = error instanceof ApiClientError ? error.message : renderMessages.failed;
    previewSlot.replaceChildren(message);
  }
}

async function generatePreview(submission, card, renderPanel) {
  renderPanel.setAttribute("aria-busy", "true");
  renderPanel.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  const wasRendered = submission.renderStatus === "ready";
  renderPanel.querySelector(".render-status").textContent = formatText(renderMessages.statusLabel, {
    status: renderMessages.statuses.rendering
  });
  const button = renderPanel.querySelector("button");
  if (button) {
    button.textContent = wasRendered ? renderMessages.regenerating : renderMessages.generatingPreview;
  }

  try {
    const data = await apiRequest(`/api/admin/submissions/${submission.id}/render`, {
      method: "POST",
      headers: adminAuth.requestHeaders({ mutation: true })
    });
    const nextCard = renderSubmission(data.submission);
    card.replaceWith(nextCard);
    announce(formatText(renderMessages.success, { id: submission.id }));
  } catch (error) {
    if (error instanceof ApiClientError && [401, 403].includes(error.status)) {
      handleAuthFailure(error);
      return;
    }
    submission.renderStatus = "failed";
    submission.renderError = error?.code ?? "RENDER_FAILED";
    renderPanel.replaceWith(renderRenderPanel(submission, card));
    card.querySelector(".submission-card__error").textContent = renderErrorMessage(error);
    announce(renderErrorMessage(error));
  }
}

function renderRenderPanel(submission, card) {
  const panel = document.createElement("section");
  panel.className = "render-panel";
  panel.dataset.renderStatus = submission.renderStatus ?? "not_rendered";
  const status = document.createElement("p");
  status.className = "render-status";
  status.textContent = formatText(renderMessages.statusLabel, {
    status: renderStatusText(submission.renderStatus)
  });
  panel.append(status);

  if (submission.renderStatus === "ready" && submission.hasPreview) {
    const slot = document.createElement("div");
    slot.className = "render-preview-slot";
    slot.setAttribute("aria-busy", "true");
    const loading = document.createElement("p");
    loading.textContent = `${renderMessages.preview}…`;
    slot.append(loading);
    panel.append(slot);
    loadPreview(submission, slot);
  }

  const actions = document.createElement("div");
  actions.className = "render-actions";
  if (submission.renderStatus !== "rendering") {
    const label = submission.renderStatus === "not_rendered" || !submission.renderStatus
      ? renderMessages.generatePreview
      : renderMessages.regenerate;
    actions.append(makeButton(label, "button--render", () => generatePreview(submission, card, panel)));
  }
  panel.append(actions);
  return panel;
}

function renderSubmission(submission) {
  const card = document.createElement("article");
  card.className = "panel submission-card";
  const meta = document.createElement("div");
  meta.className = "submission-card__meta";
  const id = document.createElement("span");
  id.className = "submission-card__id";
  id.textContent = formatPostId(submission.id);
  const time = document.createElement("time");
  time.dateTime = submission.createdAt;
  time.textContent = formatDate(submission.createdAt);
  const badge = document.createElement("span");
  badge.className = `status-badge status-badge--${submission.status}`;
  badge.textContent = messages[`${submission.status}Badge`] ?? submission.status;
  meta.append(id, time, badge);
  const content = document.createElement("p");
  content.className = "submission-card__content";
  content.textContent = submission.content;
  const inlineError = document.createElement("p");
  inlineError.className = "submission-card__error";
  inlineError.setAttribute("role", "status");
  card.append(meta, content, inlineError);

  if (submission.status === "pending") {
    const controls = document.createElement("div");
    controls.className = "submission-card__controls";
    renderPendingControls(submission, card, controls);
    card.append(controls);
  } else if (submission.status === "approved") {
    card.append(renderRenderPanel(submission, card));
  }
  return card;
}

function renderSubmissions(submissions) {
  revokePreviewUrls();
  submissionsList.replaceChildren(...submissions.map(renderSubmission));
  updateCount(activeStatus, submissions.length);
  setQueueView(submissions.length ? "list" : "empty");
}

async function loadSubmissions({ authenticating = false } = {}) {
  if (!adminAuth.hasCredential()) {
    showAuth();
    return;
  }
  showDashboard();
  updateQueueContext();
  setQueueView("loading");
  refreshButton.disabled = true;
  try {
    const data = await apiRequest(`/api/admin/submissions?status=${encodeURIComponent(activeStatus)}&limit=100`, {
      headers: adminAuth.requestHeaders()
    });
    renderSubmissions(data.submissions);
  } catch (error) {
    if (error instanceof ApiClientError && [401, 403, 503].includes(error.status)) {
      handleAuthFailure(error);
      return;
    }
    if (authenticating) {
      showAuth(messages.backendUnavailable);
      return;
    }
    errorStateMessage.textContent = error instanceof ApiClientError ? error.message : messages.defaultLoadError;
    setQueueView("error");
  } finally {
    refreshButton.disabled = false;
    setDevAuthBusy(false);
  }
}

function consumeAuthResult() {
  const url = new URL(window.location.href);
  const result = url.searchParams.get("auth");
  if (result !== null) {
    url.searchParams.delete("auth");
    history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }
  return result;
}

function configureAuthMode(content, providerData = {}) {
  const isDev = adminAuth.mode === "dev";
  enabledAuthProviders = Object.freeze({
    github: !isDev && providerData.github === true,
    local: !isDev && providerData.local === true
  });
  sessionAuthPanel.hidden = isDev;
  localAuthForm.hidden = !enabledAuthProviders.local;
  githubAuthPanel.hidden = !enabledAuthProviders.github;
  authDivider.hidden = !(enabledAuthProviders.local && enabledAuthProviders.github);
  authForm.hidden = !isDev;
  devBanner.hidden = !isDev;
  githubSignIn.href = adminAuth.signInUrl();
  if (isDev) {
    authKicker.textContent = getContent(content, "admin.auth.devKicker", "DEVELOPMENT ACCESS");
    authDescription.textContent = getContent(content, "admin.auth.devDescription", "使用本機開發憑證。");
  }
}

async function initializeSession(authResult) {
  if (authResult === "unauthorized") {
    showAuth(messages.notAdministrator);
    return;
  }
  if (authResult === "cancelled") {
    showAuth(messages.oauthCancelled);
    return;
  }
  if (authResult === "error") {
    showAuth(messages.oauthFailed);
    return;
  }
  try {
    const session = await apiRequest("/api/auth/me");
    adminAuth.setSession(session);
    await loadSubmissions();
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 401) {
      const noProviderEnabled = !enabledAuthProviders.local && !enabledAuthProviders.github;
      showAuth(authResult === "success"
        ? messages.githubSessionExpired
        : noProviderEnabled
          ? messages.authNotConfigured
          : "");
      return;
    }
    showAuth(error instanceof ApiClientError && error.status === 503
      ? messages.authNotConfigured
      : messages.backendUnavailable);
  }
}

localAuthForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const username = localUsernameInput.value.trim();
  const password = localPasswordInput.value;
  authError.textContent = "";
  authError.hidden = true;
  localUsernameInput.removeAttribute("aria-invalid");
  localPasswordInput.removeAttribute("aria-invalid");
  if (!username || !password) {
    showLocalAuthError(messages.localLoginFailed);
    return;
  }

  setLocalAuthBusy(true);
  try {
    const session = await apiRequest("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    adminAuth.setSession(session);
    localUsernameInput.value = "";
    localPasswordInput.value = "";
    await loadSubmissions();
  } catch (error) {
    const message = error instanceof ApiClientError && error.status === 429
      ? messages.localLoginRateLimited
      : error instanceof ApiClientError && error.status === 401
        ? messages.localLoginFailed
        : error instanceof ApiClientError && error.status === 503
          ? messages.authNotConfigured
          : messages.backendUnavailable;
    localPasswordInput.value = "";
    showLocalAuthError(message);
  } finally {
    setLocalAuthBusy(false);
  }
});

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const token = authTokenInput.value.trim();
  if (token.length < MIN_DEV_TOKEN_LENGTH) {
    authError.textContent = formatText(messages.credentialTooShort, { min: MIN_DEV_TOKEN_LENGTH });
    authTokenInput.focus();
    return;
  }
  authError.textContent = "";
  adminAuth.setCredential(token);
  setDevAuthBusy(true);
  await loadSubmissions({ authenticating: true });
});

passwordFormToggle.addEventListener("click", () => {
  if (passwordAccountPanel.hidden) {
    openPasswordForm();
  } else {
    closePasswordForm({ restoreFocus: true });
  }
});

passwordFormCancel.addEventListener("click", () => {
  closePasswordForm({ restoreFocus: true });
});

passwordChangeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const currentPassword = currentPasswordInput.value;
  const newPassword = newPasswordInput.value;
  const confirmPassword = confirmPasswordInput.value;
  passwordFormStatus.textContent = "";
  passwordFormStatus.classList.remove("is-error");
  for (const input of [currentPasswordInput, newPasswordInput, confirmPasswordInput]) {
    input.removeAttribute("aria-invalid");
  }

  if (newPassword !== confirmPassword) {
    showPasswordStatus(messages.passwordMismatch, {
      error: true,
      field: confirmPasswordInput
    });
    return;
  }
  if (
    passwordGraphemeLength(newPassword) < MIN_PASSWORD_LENGTH
    || !newPassword.trim()
  ) {
    showPasswordStatus(messages.passwordTooShort, {
      error: true,
      field: newPasswordInput
    });
    return;
  }

  setPasswordBusy(true);
  try {
    const session = await apiRequest("/api/admin/account/password", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...adminAuth.requestHeaders({ mutation: true })
      },
      body: JSON.stringify({ currentPassword, newPassword, confirmPassword })
    });
    adminAuth.setSession(session);
    clearPasswordFields();
    showPasswordStatus(messages.passwordChanged);
  } catch (error) {
    if (error instanceof ApiClientError && error.code === "INVALID_CURRENT_PASSWORD") {
      currentPasswordInput.value = "";
      showPasswordStatus(error.message, { error: true, field: currentPasswordInput });
      return;
    }
    if (error instanceof ApiClientError && [401, 403].includes(error.status)) {
      handleAuthFailure(error);
      return;
    }
    const field = error instanceof ApiClientError
      && error.code === "PASSWORD_CONFIRMATION_MISMATCH"
      ? confirmPasswordInput
      : error instanceof ApiClientError && error.code === "PASSWORD_POLICY_INVALID"
        ? newPasswordInput
        : undefined;
    showPasswordStatus(
      error instanceof ApiClientError ? error.message : messages.passwordChangeFailed,
      { error: true, field }
    );
  } finally {
    setPasswordBusy(false);
  }
});

for (const input of [localUsernameInput, localPasswordInput]) {
  input.addEventListener("input", () => {
    input.removeAttribute("aria-invalid");
    authError.textContent = "";
    authError.hidden = true;
  });
}

for (const tab of tabs) {
  tab.addEventListener("click", async () => {
    selectTab(tab.dataset.status);
    await loadSubmissions();
  });
  tab.addEventListener("keydown", (event) => {
    if (!new Set(["ArrowLeft", "ArrowRight"]).has(event.key)) {
      return;
    }
    event.preventDefault();
    const index = STATUS_ORDER.indexOf(tab.dataset.status);
    const offset = event.key === "ArrowRight" ? 1 : -1;
    const nextStatus = STATUS_ORDER[(index + offset + STATUS_ORDER.length) % STATUS_ORDER.length];
    const nextTab = tabs.find((candidate) => candidate.dataset.status === nextStatus);
    nextTab.focus();
    nextTab.click();
  });
}

refreshButton.addEventListener("click", () => loadSubmissions());
retryButton.addEventListener("click", () => loadSubmissions());
emptyRefreshButton.addEventListener("click", () => loadSubmissions());
clearAuthButton.addEventListener("click", async () => {
  if (adminAuth.mode === "dev") {
    adminAuth.clearCredential();
    showAuth(messages.signedOut);
    return;
  }
  clearAuthButton.disabled = true;
  try {
    await apiRequest("/api/auth/logout", {
      method: "POST",
      headers: adminAuth.requestHeaders({ mutation: true })
    });
    adminAuth.clearCredential();
    showAuth(messages.signedOut);
  } catch (error) {
    if (error instanceof ApiClientError && error.code === "AUDIT_LOG_FAILED") {
      adminAuth.clearCredential();
      showAuth(messages.signedOutAuditWarning);
      return;
    }
    if (error instanceof ApiClientError && [401, 403].includes(error.status)) {
      adminAuth.clearCredential();
      showAuth(messages.sessionExpired);
      return;
    }
    announce(messages.logoutFailed);
  } finally {
    clearAuthButton.disabled = false;
  }
});

window.addEventListener("pagehide", revokePreviewUrls);

loadContent().then(async (content) => {
  contentCopy = content;
  Object.assign(messages, getContent(content, "admin.messages", {}));
  const configuredRenderMessages = getContent(content, "admin.render", {});
  Object.assign(renderMessages, configuredRenderMessages, {
    statuses: {
      ...renderMessages.statuses,
      ...(configuredRenderMessages.statuses ?? {})
    }
  });
  messages.authSubmitLabel = getContent(content, "admin.auth.submitLabel", messages.authSubmitLabel);
  messages.localSubmitLabel = getContent(content, "admin.auth.localSubmitLabel", messages.localSubmitLabel);
  messages.passwordSubmitLabel = getContent(content, "admin.password.submitLabel", messages.passwordSubmitLabel);
  updateQueueContext();
  const authResult = consumeAuthResult();
  if (adminAuth.mode === "dev") {
    configureAuthMode(content);
    await loadSubmissions();
    return;
  }

  try {
    const data = await apiRequest("/api/auth/providers");
    configureAuthMode(content, data.providers);
  } catch (error) {
    configureAuthMode(content);
    showAuth(error instanceof ApiClientError && error.status === 503
      ? messages.authNotConfigured
      : messages.backendUnavailable);
    return;
  }
  await initializeSession(authResult);
});
