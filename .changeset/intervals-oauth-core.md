---
"@enduragent/core": patch
---

Add intervals.icu OAuth support to Core, ahead of the desktop sign-in button. `signInWithIntervals` runs the authorization-code flow with PKCE (S256) as a public client: a loopback listener on `127.0.0.1` with an OS-chosen port, a state check, a five-minute wait and the code exchange, with no client secret. It returns the token only as a stored intervals credential string with an `intervals-oauth:` prefix, and `revokeIntervalsAccess` takes that stored credential and calls intervals.icu's disconnect endpoint. The three request builders in the intervals client factory now send `Authorization: Bearer` for a signed-in credential and Basic auth for a plain API key.
