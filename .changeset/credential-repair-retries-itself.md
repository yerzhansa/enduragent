---
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
"@enduragent/i18n": patch
---

User-facing: If the coach stops answering while you delete a key in Settings, Enduragent now reconnects and checks the key by itself instead of sending you to the Setup screen; it asks you to reload only if the coach is back and still won't use the saved key.

A delete refused with `runtime-state-diverged` now leaves a retrying repair (`{ retrying: credential }`) instead of a repair that needs the athlete. While it retries, credential changes stay blocked, Settings says "The credential was not deleted. Reconnecting to the coach…", and no Setup gate or Reload button shows. Each try re-sends failed stored keys (`retryFailedCredentials`), then re-reads the saved key states and the coach's runtime config: right away, then after 1, 2, 4, 8 and 15 seconds (capped), and at once when the coach connection reopens. The repair clears when the key is no longer failed. If the coach answers and the key is still failed, the repair becomes the existing "needs the athlete" state with the gate and Reload credential status. The retry keeps running after the athlete leaves Settings. Storage-uncertain deletes keep today's manual reload. The credential list code moved to `settings/credential-entries.ts`, and the retry scheduler lives in `settings/credential-repair.ts`.
