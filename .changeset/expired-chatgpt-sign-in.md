---
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
"@enduragent/coach": patch
"@enduragent/core": patch
"@enduragent/i18n": patch
---

User-facing: When ChatGPT stops accepting your sign-in, Setup now says the sign-in expired and offers Sign in with ChatGPT, which opens the browser so you can sign in again. Before, Setup kept showing ChatGPT as Connected and gave you no way to sign in again.

When the coach's refresh of the ChatGPT token is rejected twice, it marks the stored profile in `auth-profiles.json` as rejected, compared against the profile it refreshed so a newer sign-in is never marked. A successful refresh or a new browser sign-in clears the mark. Main's ChatGPT status reports a marked profile as `{ state: "configured", runtimeReady: false, reason: "sign-in-expired" }`. The renderer keeps it as an expired credential that cannot be activated, so Sign in starts a fresh browser sign-in, and Settings refreshes the sign-in status when it opens. The coach's OAuth token reader moves out of `composition.ts` into `oauth-access-token.ts`.
