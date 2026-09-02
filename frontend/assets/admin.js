import { ApiClientError, apiRequest } from "./api.js";
import { adminAuth } from "./admin-auth.js";
import { formatText, getContent, loadContent } from "./content.js";

const MIN_DEV_TOKEN_LENGTH = 24;
const messages = {
  authenticating: "驗證中⋯",
  authSubmitLabel: "驗證並進入",
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

// Set the cross-origin Worker URL before editable content finishes loading.
if (adminAuth.mode === "github") {
  githubSignIn.href = adminAuth.signInUrl();
}

function setAuthBusy(isBusy) {
  if (!adminAuth.requiresCredentialEntry) {
    return;
  }

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
    username: identity?.githubUsername ?? ""
  });
  adminRole.textContent = formatText(messages.role, {
    role: identity?.role ?? ""
  });
}

function showAuth(message = "") {
  dashboard.hidden = true;
  authPanel.hidden = false;
  authError.textContent = message;
  adminUsername.textContent = "";
  adminRole.textContent = "";

  if (adminAuth.requiresCredentialEntry) {
    authTokenInput.value = "";
    authTokenInput.focus();
  } else {
    githubSignIn.focus();
  }
}

function showDashboard() {
  authPanel.hidden = true;
  dashboard.hidden = false;
  renderIdentity();
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
      : messages.githubSessionExpired;
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
    setAuthBusy(false);
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

function configureAuthMode(content) {
  const isDev = adminAuth.mode === "dev";
  githubAuthPanel.hidden = isDev;
  authForm.hidden = !isDev;
  devBanner.hidden = !isDev;
  githubSignIn.href = adminAuth.signInUrl();

  if (isDev) {
    authKicker.textContent = getContent(
      content,
      "admin.auth.devKicker",
      "DEVELOPMENT ACCESS"
    );
    authDescription.textContent = getContent(
      content,
      "admin.auth.devDescription",
      "使用本機開發憑證。"
    );
  }
}

async function initializeGithub(authResult) {
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
      showAuth(authResult === "success" ? messages.githubSessionExpired : "");
      return;
    }

    showAuth(error instanceof ApiClientError && error.status === 503
      ? messages.authNotConfigured
      : messages.backendUnavailable);
  }
}

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
  setAuthBusy(true);
  await loadSubmissions({ authenticating: true });
});

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
      showAuth(messages.githubSessionExpired);
      return;
    }
    announce(messages.logoutFailed);
  } finally {
    clearAuthButton.disabled = false;
  }
});

loadContent().then(async (content) => {
  Object.assign(messages, getContent(content, "admin.messages", {}));
  messages.authSubmitLabel = getContent(
    content,
    "admin.auth.submitLabel",
    messages.authSubmitLabel
  );
  configureAuthMode(content);
  const authResult = consumeAuthResult();

  if (adminAuth.mode === "github") {
    await initializeGithub(authResult);
  } else {
    await loadSubmissions();
  }
});
