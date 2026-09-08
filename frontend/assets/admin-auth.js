const TOKEN_KEY = "anonymous-submissions.dev-admin-token";

function apiUrl(path) {
  const baseUrl = window.APP_CONFIG?.API_BASE_URL?.trim().replace(/\/+$/, "") ?? "";
  return `${baseUrl}${path}`;
}

const devProvider = {
  mode: "dev",
  requiresCredentialEntry: true,
  hasCredential() {
    return Boolean(sessionStorage.getItem(TOKEN_KEY));
  },
  setCredential(token) {
    sessionStorage.setItem(TOKEN_KEY, token);
  },
  setSession() {},
  clearCredential() {
    sessionStorage.removeItem(TOKEN_KEY);
  },
  requestHeaders() {
    const token = sessionStorage.getItem(TOKEN_KEY) ?? "";
    return token ? { Authorization: `Bearer ${token}` } : {};
  },
  signInUrl() {
    return "";
  },
  identity() {
    return {
      username: "local-development",
      githubUsername: null,
      authMethods: ["dev"],
      role: "admin"
    };
  }
};

const sessionState = {
  csrfToken: "",
  user: null
};

const sessionProvider = {
  mode: "session",
  requiresCredentialEntry: false,
  hasCredential() {
    return Boolean(sessionState.user && sessionState.csrfToken);
  },
  setCredential() {},
  setSession(session) {
    sessionState.csrfToken = typeof session?.csrfToken === "string"
      ? session.csrfToken
      : "";
    sessionState.user = session?.user ?? null;
  },
  clearCredential() {
    sessionState.csrfToken = "";
    sessionState.user = null;
  },
  requestHeaders({ mutation = false } = {}) {
    if (!mutation || !sessionState.csrfToken) {
      return {};
    }
    return { "X-CSRF-Token": sessionState.csrfToken };
  },
  signInUrl() {
    return apiUrl("/api/auth/github");
  },
  identity() {
    return sessionState.user;
  }
};

const providers = Object.freeze({
  dev: Object.freeze(devProvider),
  github: Object.freeze(sessionProvider),
  local: Object.freeze(sessionProvider),
  session: Object.freeze(sessionProvider)
});

const configuredMode = window.APP_CONFIG?.ADMIN_AUTH_MODE?.trim().toLowerCase()
  ?? "github";

export const adminAuth = providers[configuredMode] ?? providers.github;
