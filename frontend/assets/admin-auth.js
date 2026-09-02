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
    return { githubUsername: "local-development", role: "admin" };
  }
};

const githubState = {
  csrfToken: "",
  user: null
};

const githubProvider = {
  mode: "github",
  requiresCredentialEntry: false,
  hasCredential() {
    return Boolean(githubState.user && githubState.csrfToken);
  },
  setCredential() {},
  setSession(session) {
    githubState.csrfToken = typeof session?.csrfToken === "string"
      ? session.csrfToken
      : "";
    githubState.user = session?.user ?? null;
  },
  clearCredential() {
    githubState.csrfToken = "";
    githubState.user = null;
  },
  requestHeaders({ mutation = false } = {}) {
    if (!mutation || !githubState.csrfToken) {
      return {};
    }
    return { "X-CSRF-Token": githubState.csrfToken };
  },
  signInUrl() {
    return apiUrl("/api/auth/github");
  },
  identity() {
    return githubState.user;
  }
};

const providers = Object.freeze({
  dev: Object.freeze(devProvider),
  github: Object.freeze(githubProvider)
});

const configuredMode = window.APP_CONFIG?.ADMIN_AUTH_MODE?.trim().toLowerCase()
  ?? "github";

export const adminAuth = providers[configuredMode] ?? providers.github;
