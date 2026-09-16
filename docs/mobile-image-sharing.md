# Mobile final-image sharing

The current-send view supports preparing either one final PNG or the whole ordered remaining group (1–10). Preparation reuses existing locking/rendering/upload logic without starting a ZIP download. A separate fresh click invokes Web Share synchronously with `files` only. No caption or preview-number image is shared. Existing PNG and ZIP downloads remain available.

Seven-day sent records also support single-image preparation using the existing authenticated image route. No new API, public R2 URL, migration, dependency or publication integration is added. Sharing never confirms publication or advances numbering.

Files live only in page memory. Leaving panels, switching tabs/batches, refreshing state, cancellation/reset/confirmation and pagehide clear files and revoke preview URLs. A preparation generation prevents an abandoned fetch from repopulating the cache. A partial fetch failure exposes no files.

Actual files are checked with `navigator.canShare`. Unsupported groups use individual preparation or PNG download/long-press previews. Browser/OS determines available destinations; neither API resolution nor download proves saving to Photos. AbortError is a normal cancellation; other failures permit retry. No unconditional success-to-album message is displayed.

Local automated tests cover file identity/order, synchronous share invocation, unsupported cases, failures and cache disposal. Browser tests mock the native share boundary; this is not physical iPhone validation. Before production rollout, test Safari over HTTPS on a real iPhone: single and multi-image Save Images, cancellation/retry, filenames/image numbers, and non-support fallback. localhost on a desktop is not reachable as localhost from a phone. Do not expose dev credentials or a local preview publicly for testing.

Not deployed. Existing English-weekday edits are preserved; saved captions are not rewritten.
