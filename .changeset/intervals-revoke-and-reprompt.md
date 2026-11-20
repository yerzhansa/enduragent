---
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
"@enduragent/i18n": patch
"@enduragent/core": patch
"@enduragent/coach": patch
"@enduragent/coach-contract": patch
---

User-facing: Disconnecting Intervals.icu now also removes Enduragent's access on Intervals.icu, and the app asks you to sign in again if Intervals.icu stops accepting your sign-in.

Disconnect in Settings now revokes the signed-in token on intervals.icu (`disconnect-app`) through a scoped vault read, then deletes it locally even when the revoke fails, and the result line says which happened. A plain API key is only removed locally. Core tracks bearer credentials that intervals.icu rejects: a 401 marks the credential, a 403 is confirmed with one probe of the athlete endpoint, and any successful response clears it. The runtime config snapshot reports this as `intervals.credential_rejected`, and the renderer shows "Sign in again" on the Intervals.icu row and in the sidebar footer.
