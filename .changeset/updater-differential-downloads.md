---
"@enduragent/desktop": patch
---

User-facing: Desktop app updates download only what changed since your previous version, now from a server close to you, so future updates finish faster.

Both macOS and Windows release plans now emit `useMultipleRangeRequest: false` in `app-update.yml` so `electron-updater` asks for one byte range per request, which `updates.enduragent.icu` serves from its edge cache, instead of multi-range requests that older feed builds rejected with HTTP 502 and the current feed must fetch from GitHub range by range. `update-controller.ts` now wires a safe structured updater logger (`createSafeUpdaterLogger`) that records differential download plans, summaries, and fallback causes without leaking URLs, tokens, headers, or user paths, and a differential blockmap verification helper exercises `electron-updater`'s `computeOperations` and single-range download path.
