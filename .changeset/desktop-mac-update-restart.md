---
"@enduragent/desktop": patch
---

User-facing: Restarting to install a downloaded Mac update now finishes instead of staying on Restarting.

On darwin, electron-updater 6.8.9 MacUpdater only feeds the zip to native Squirrel.Mac during download when `autoInstallOnAppQuit` is true. The previous `false` setting deferred that handoff until `quitAndInstall` after drain, which never completed (ShipIt idle, UI stuck on installing). Windows/Linux BaseUpdater still keeps `autoInstallOnAppQuit` false so an ordinary quit does not install.
