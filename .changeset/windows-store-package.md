---
"@enduragent/desktop": patch
---

Add `package:win-store`, which builds an unsigned x64 AppX for Microsoft Store submission from the Partner Center identity in `ENDURAGENT_STORE_IDENTITY_NAME`, `ENDURAGENT_STORE_PUBLISHER`, and `ENDURAGENT_STORE_PUBLISHER_DISPLAY_NAME`, with tile images generated from the Windows app icon. When the app runs from a Store package (`process.windowsStore`), it never becomes update-eligible, keeps the package's own AppUserModelID, and leaves the start-at-login item out of the tray menu. The Windows CI job builds the package with a synthetic identity and checks its manifest. Nothing ships to the Store from this change.
