---
"@enduragent/desktop": patch
---

User-facing: If your Mac's Keychain was locked when the app started, unlocking it now lets Setup save your keys right away. Before, every save said macOS encryption was unavailable until you pressed Retry in Settings or restarted the app.

Before each credential write, the app now asks the Keychain again whenever it is not using it. The flag that allowed that re-check only while a key cleanup was pending is gone: the backend selection is the only state.
