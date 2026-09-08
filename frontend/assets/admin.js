import { ApiClientError, apiRequest } from "./api.js";
import { adminAuth } from "./admin-auth.js";
import { formatText, getContent, loadContent } from "./content.js";

const MIN_DEV_TOKEN_LENGTH = 24;
const MIN_PASSWORD_LENGTH = 8;
const passwordSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme"
});

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
  pendingCount: "待審核 {count} 篇",
  pendingBadge: "待審核",
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

const authPanel = document.querySelector("#auth-panel");
const authKicker = document.querySelector("#auth-kicker");
const authDescription = document.querySelector("#auth-description");
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
const submissionsList = document.querySelector("#submissions-list");
const pendingCount = document.querySelector("#pending-count");
const queueStatus = document.querySelector("#queue-status");
const refreshButton = document.querySelector("#refresh-button");
const retryButton = document.querySelector("#retry-button");
const emptyRefreshButton = document.querySelector("#empty-refresh-button");
const clearAuthButton = document.querySelector("#clear-auth-button");
const teamTab = document.querySelector("#team-tab");
const queueTab = document.querySelector("#queue-tab");
const teamPanel = document.querySelector("#team-panel");
const queuePanel = document.querySelector("#queue-panel");
const teamList = document.querySelector("#team-list");
const teamStatus = document.querySelector("#team-status");
let teamRequest = 0;

const sessionAuthPanel = document.querySelector("#session-auth-panel");
const localAuthForm = document.querySelector("#local-auth-form");
const accessAuthPanel = document.querySelector("#access-auth-panel");
const localUsernameInput = document.querySelector("#local-username");
const localPasswordInput = document.querySelector("#local-password");
const localAuthSubmit = document.querySelector("#local-auth-submit");
const authDivider = document.querySelector("#auth-divider");
const passwordFormToggle = document.querySelector("#password-form-toggle");
const passwordAccountPanel = document.querySelector("#password-account-panel");
const passwordFormCancel = document.querySelector("#password-form-cancel");
const passwordChangeForm = document.querySelector("#password-change-form");
const currentPasswordInput = document.querySelector("#current-password");
const newPasswordInput = document.querySelector("#new-password");
const confirmPasswordInput = document.querySelector("#confirm-password");
const passwordChangeSubmit = document.querySelector("#password-change-submit");
const passwordFormStatus = document.querySelector("#password-form-status");
let enabledAuthProviders = Object.freeze({ github: false, local: false });

function setDevAuthBusy(isBusy) {
  authTokenInput.disabled = isBusy;
  authSubmit.disabled = isBusy;
  authSubmit.querySelector("span").textContent = isBusy
    ? messages.authenticating
    : messages.authSubmitLabel;
  authForm.setAttribute("aria-busy", String(isBusy));
}

function renderIdentity() {
  const identity = adminAuth.identity();
  adminUsername.textContent = formatText(messages.username, {
    username: identity?.username ?? identity?.githubUsername ?? identity?.accessEmail ?? ""
  });
  adminRole.textContent = formatText(messages.role, {
    role: identity?.role ?? ""
  });
  passwordFormToggle.hidden = !hasLocalIdentity() || adminAuth.mode === "dev";
  teamTab.hidden = identity?.role !== "owner";
}

function showAuth(message = "") {
  teamRequest++;
  teamList.replaceChildren();
  teamPanel.hidden = true;
  queuePanel.hidden = false;
  teamTab.setAttribute("aria-pressed", "false");
  queueTab.setAttribute("aria-pressed", "true");
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
  } else if (enabledAuthProviders.access) {
    document.querySelector("#access-sign-in").focus({ preventScroll: true });
  } else if (enabledAuthProviders.github) {
    githubSignIn.focus({ preventScroll: true });
  } else {
    authError.focus();
  }
}

function showDashboard() {
  authPanel.hidden = true;
  dashboard.hidden = false;
  renderIdentity();
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
  // Password authentication and its account controls are deferred on Workers Free.
  return false;
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

function makeButton(label, className, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `button ${className}`;
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function updatePendingCount(count) {
  pendingCount.textContent = formatText(messages.pendingCount, { count });
}

function announce(message) {
  queueStatus.textContent = "";
  requestAnimationFrame(() => {
    queueStatus.textContent = message;
  });
}

async function moderateSubmission(submission, action, card, controls) {
  const buttons = controls.querySelectorAll("button");
  buttons.forEach((button) => { button.disabled = true; });
  card.setAttribute("aria-busy", "true");

  const activeButton = controls.querySelector(`[data-action="${action}"]`);
  if (activeButton) {
    activeButton.textContent = action === "approve"
      ? messages.approving
      : messages.rejecting;
  }

  try {
    await apiRequest(`/api/admin/submissions/${submission.id}/${action}`, {
      method: "POST",
      headers: adminAuth.requestHeaders({ mutation: true })
    });

    card.remove();
    const remaining = submissionsList.childElementCount;
    updatePendingCount(remaining);
    announce(formatText(
      action === "approve" ? messages.approveSuccess : messages.rejectSuccess,
      { id: submission.id }
    ));

    if (remaining === 0) {
      setQueueView("empty");
    }
  } catch (error) {
    card.setAttribute("aria-busy", "false");

    if (error instanceof ApiClientError && [401, 403].includes(error.status)) {
      handleAuthFailure(error);
      return;
    }

    renderControls(submission, card, controls);
    const inlineError = card.querySelector(".submission-card__error");
    inlineError.textContent = error instanceof ApiClientError
      ? error.message
      : messages.genericModerationError;
  }
}

function showRejectConfirmation(submission, card, controls) {
  controls.replaceChildren();

  const prompt = document.createElement("span");
  prompt.className = "confirmation__prompt";
  prompt.textContent = messages.rejectPrompt;

  const cancelButton = makeButton(messages.cancel, "button--quiet", () => {
    renderControls(submission, card, controls);
  });

  const confirmButton = makeButton(messages.confirmReject, "button--danger", () => {
    moderateSubmission(submission, "reject", card, controls);
  });
  confirmButton.dataset.action = "reject";

  controls.append(prompt, cancelButton, confirmButton);
  confirmButton.focus();
}

function renderControls(submission, card, controls) {
  controls.replaceChildren();

  const rejectButton = makeButton(messages.reject, "button--secondary", () => {
    showRejectConfirmation(submission, card, controls);
  });
  rejectButton.dataset.action = "reject";

  const approveButton = makeButton(messages.approve, "button--primary", () => {
    moderateSubmission(submission, "approve", card, controls);
  });
  approveButton.dataset.action = "approve";

  controls.append(rejectButton, approveButton);
}

function renderSubmission(submission) {
  const card = document.createElement("article");
  card.className = "panel submission-card";

  const meta = document.createElement("div");
  meta.className = "submission-card__meta";

  const id = document.createElement("span");
  id.className = "submission-card__id";
  id.textContent = `#${submission.id}`;

  const time = document.createElement("time");
  time.dateTime = submission.createdAt;
  time.textContent = formatDate(submission.createdAt);

  const badge = document.createElement("span");
  badge.className = "status-badge status-badge--pending";
  badge.textContent = messages.pendingBadge;

  meta.append(id, time, badge);

  const content = document.createElement("p");
  content.className = "submission-card__content";
  content.textContent = submission.content;

  const inlineError = document.createElement("p");
  inlineError.className = "submission-card__error";
  inlineError.setAttribute("role", "status");

  const controls = document.createElement("div");
  controls.className = "submission-card__controls";
  renderControls(submission, card, controls);

  card.append(meta, content, inlineError, controls);
  return card;
}

function renderSubmissions(submissions) {
  submissionsList.replaceChildren(...submissions.map(renderSubmission));
  updatePendingCount(submissions.length);
  setQueueView(submissions.length ? "list" : "empty");
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

async function loadSubmissions({ authenticating = false } = {}) {
  if (!adminAuth.hasCredential()) {
    showAuth();
    return;
  }

  showDashboard();
  setQueueView("loading");
  refreshButton.disabled = true;

  try {
    const data = await apiRequest("/api/admin/submissions?limit=100", {
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

    errorStateMessage.textContent = error instanceof ApiClientError
      ? error.message
      : messages.defaultLoadError;
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
    local: false,
    access: !isDev && providerData.access === true
  });
  sessionAuthPanel.hidden = isDev;
  localAuthForm.hidden = !enabledAuthProviders.local;
  accessAuthPanel.hidden = !enabledAuthProviders.access;
  githubAuthPanel.hidden = !enabledAuthProviders.github;
  authDivider.hidden = !(enabledAuthProviders.access && enabledAuthProviders.github);
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
      const noProviderEnabled = !enabledAuthProviders.access && !enabledAuthProviders.github;
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
  if (!enabledAuthProviders.local) return;
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
    authError.textContent = formatText(messages.credentialTooShort, {
      min: MIN_DEV_TOKEN_LENGTH
    });
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

async function loadTeam() {
  if (adminAuth.identity()?.role !== "owner") return;
  const request = ++teamRequest;
  teamPanel.hidden = false;
  queuePanel.hidden = true;
  teamTab.setAttribute("aria-pressed", "true");
  queueTab.setAttribute("aria-pressed", "false");
  teamList.replaceChildren();
  teamStatus.textContent = "正在載入管理員⋯";
  try {
    const data = await apiRequest("/api/admin/admins", { headers: adminAuth.requestHeaders() });
    if (request !== teamRequest) return;
    for (const admin of data.admins) {
      const card = document.createElement("article");
      card.className = "team-member";
      const name = document.createElement("h3");
      name.textContent = admin.identity ?? `Admin #${admin.id}`;
      const email = document.createElement("p");
      email.textContent = admin.email ?? "尚未綁定 Email";
      const details = document.createElement("p");
      details.className = "team-member__meta";
      const labels = { github: "GitHub", access: "Email OTP", local: "Local（正式停用）" };
      details.textContent = `#${admin.id} · ${admin.role} · ${admin.enabled ? "啟用" : "停用"} · ${admin.providers.map(p => labels[p] ?? p).join(" / ")}`;
      card.append(name, email, details);
      teamList.append(card);
    }
    teamStatus.textContent = `${data.admins.length} 位管理員 · 僅供查閱`;
  } catch (error) {
    if (request !== teamRequest) return;
    if (error instanceof ApiClientError && [401, 403].includes(error.status)) { handleAuthFailure(error); return; }
    teamStatus.textContent = "無法載入管理員。請按重新整理再試。";
  }
}
teamTab.addEventListener("click", loadTeam);
queueTab.addEventListener("click", () => {
  teamRequest++;
  teamPanel.hidden = true;
  queuePanel.hidden = false;
  teamTab.setAttribute("aria-pressed", "false");
  queueTab.setAttribute("aria-pressed", "true");
  loadSubmissions();
});
refreshButton.addEventListener("click", () => teamPanel.hidden ? loadSubmissions() : loadTeam());
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

loadContent().then(async (content) => {
  Object.assign(messages, getContent(content, "admin.messages", {}));
  messages.authSubmitLabel = getContent(content, "admin.auth.submitLabel", messages.authSubmitLabel);
  messages.localSubmitLabel = getContent(content, "admin.auth.localSubmitLabel", messages.localSubmitLabel);
  messages.passwordSubmitLabel = getContent(content, "admin.password.submitLabel", messages.passwordSubmitLabel);
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
