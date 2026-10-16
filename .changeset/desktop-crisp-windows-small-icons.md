---
"@enduragent/desktop": patch
---

The 16, 20 and 24 px frames of the Windows `app-icon.ico` and `tray.ico` now come from `app-icon-windows-16.png`, `-20.png` and `-24.png`, which the logo generator draws on the pixel grid. Shrinking the 512 px source with `sips` had turned the two lower riders into grey smudges at those sizes. The 32 px and larger frames are still resampled from `app-icon-windows.png`.
