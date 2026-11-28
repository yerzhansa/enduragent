---
"@enduragent/desktop": patch
---

User-facing: If the app's window crashes or closes during a ChatGPT or Intervals.icu sign-in, opening the window again now lets you sign in right away, instead of saying "check your connection" or that a sign-in is already in progress.

A browser sign-in now belongs to the window that started it. Disposing a window's onboarding IPC cancels the ChatGPT login that window started, and an Intervals.icu sign-in that is not approved yet ends when the asking page's webContents is destroyed.
