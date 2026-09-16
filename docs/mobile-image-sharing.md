# Mobile final-image sharing

The current-send view has one Generate Images action for the whole ordered remaining group (1–10). It saves edits and reuses existing locking/rendering/upload logic, then loads every final file without starting a download. The same area then offers Save to Phone and Download ZIP. Save to Phone invokes Web Share synchronously with `files` only, without instructions or another confirmation. No caption or preview-number image is shared. Reopening a completed group loads its existing final files without regenerating or assigning numbers. Failed generation/loading offers Retry and never exposes incomplete group output.

Each existing final-image card has one Save This Image action, enabled after its file loads. Seven-day sent records use the same action and existing authenticated image route, without a separate preparation panel or duplicate preview. No new API, public R2 URL, migration, dependency or publication integration is added. Sharing never confirms publication or advances numbering.

Files live only in page memory. Leaving panels, switching tabs/batches, refreshing state, cancellation/reset/confirmation and pagehide clear files and revoke preview URLs. A preparation generation prevents an abandoned fetch from repopulating the cache. A partial fetch failure exposes no files.

Actual files are checked with `navigator.canShare`. Unsupported groups use individual sharing; wholly unsupported browsers offer PNG download and the existing long-press image previews. Browser/OS determines available destinations; neither API resolution nor download proves saving to Photos. AbortError is a normal cancellation; other failures permit retry. No success-to-album message is displayed.

Local automated tests cover file identity/order, synchronous share invocation, unsupported cases, failures and cache disposal. Browser tests mock the native share boundary; this is not physical iPhone validation. Before production rollout, test Safari over HTTPS on a real iPhone: single and multi-image Save Images, cancellation/retry, filenames/image numbers, and non-support fallback. localhost on a desktop is not reachable as localhost from a phone. Do not expose dev credentials or a local preview publicly for testing.

Not deployed. Existing English-weekday edits are preserved; saved captions are not rewritten.
