// Instagram publishing intentionally remains disabled in phase one. A future
// scheduled job can replace this implementation without coupling API handlers
// to Instagram credentials or network calls.
export function createPublishingService() {
  return Object.freeze({
    provider: "disabled",
    async publishApprovedSubmission() {
      return { ok: false, reason: "not_configured" };
    }
  });
}
