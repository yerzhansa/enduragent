---
"@enduragent/desktop": patch
---

User-facing: The Mac app has a new icon, three riders in an echelon, in the Dock and the menu bar.

Replaces the teal "e" app icon with the E0 mark on Asphalt. `app-icon.png` and `app-icon.svg` now follow the macOS icon grid (an 824 px rounded square with a shadow on a 1024 px canvas), and the menu-bar templates are drawn on whole pixels at 16 and 32 px. Windows icons now come from the full-bleed `app-icon-windows.png`, so the 16 px tray frame is not shrunk by the macOS padding. The README header shows the horizontal lockup, with a light and a dark version.
