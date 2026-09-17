---
"@enduragent/desktop": patch
---

User-facing: Restarting to install a downloaded Mac update now finishes instead of staying on Restarting.

On darwin, electron-updater 6.8.9 MacUpdater only feeds the zip to native Squirrel.Mac during download when `autoInstallOnAppQuit` is true. The previous `false` setting left `squirrelDownloadedUpdate` false, so `completeInstallAfterDrain` → `quitAndInstall` used the deferred native `checkForUpdates` path after drain. That returns `"started"` without `app.exit` and without launching ShipIt (live: 0.5.2 still running, zip in updater cache, ShipIt logs stale). Windows/Linux BaseUpdater still keeps `autoInstallOnAppQuit` false so an ordinary quit does not install.
