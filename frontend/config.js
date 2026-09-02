// This file is public configuration, not a place for secrets.
// Keep this empty for same-origin local development. The GitHub Pages workflow
// generates a production-only copy from the PAGES_API_BASE_URL repository
// variable; never place secrets in this public file.
window.APP_CONFIG = Object.freeze({
  API_BASE_URL: "",
  ADMIN_AUTH_MODE: "github"
});
