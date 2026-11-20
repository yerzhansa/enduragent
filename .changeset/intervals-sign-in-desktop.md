---
"@enduragent/desktop": minor
"@enduragent/desktop-renderer": minor
"@enduragent/i18n": patch
---

User-facing: Connect intervals.icu by signing in with your browser instead of copying an API key.

The intervals.icu row in onboarding and Settings now offers "Sign in with Intervals.icu". It opens the intervals.icu consent page, shows "Waiting for browser…" with "Cancel sign-in" and "Open the sign-in page again", then "Completing sign-in…" while the main process verifies the account against the training history on this Mac and stores the token in the encrypted vault, and finally "Connected as <name>". The clipboard paste channel is removed. API keys saved before this change keep working. Closing the setup surface cancels a sign-in that is still waiting for the browser.
