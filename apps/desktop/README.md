# Enduragent desktop

## Releases and updates

The desktop app uses its own SemVer from `apps/desktop/package.json` and releases under `enduragent-desktop@<version>`; desktop releases never publish or bump the npm package. The protected macOS workflow signs with Developer ID, notarizes with Apple, verifies the DMG, ZIP, blockmap, and `latest-mac.yml`, runs the signed update round trip, and makes the tested release the updater feed only after those checks pass. Packaged update checks use `https://updates.enduragent.icu/`, which serves the GitHub Release artifacts without sending the client through GitHub's download redirects.

Official releases send a separate installation heartbeat to `ping.enduragent.icu` at startup and
on a daily timer, limited to one attempt per installation in any 24-hour period. It contains only
the fixed product label `enduragent-desktop`, a random persisted installation UUID, the app
version, and the platform channel; set
`ENDURAGENT_NO_USAGE_PING=1` before launch to disable it without disabling update checks.

## Windows

Windows targets Windows 11 x64 with the per-user, one-click `Enduragent-<version>-x64.exe` installer, its `.blockmap`, and `latest.yml`; the installer requests no elevation, adds a Start Menu shortcut but no desktop shortcut, and ships only with an Authenticode signature from `<PUBLISHER_NAME>`, although SmartScreen can still prompt while a new publisher identity builds reputation. Windows assets are appended to the existing desktop release, may lag or skip a version, and never hold the macOS release; update checks use the same public updater feed and switch on with the first signed release. Closing the main window keeps the app running in the tray until it is explicitly quit, while uninstalling retains `%LOCALAPPDATA%\Enduragent` for the athlete to remove by hand. Follow the operator runbook in `CONTRIBUTING.md`.

### Microsoft Store package

`pnpm --filter @enduragent/desktop package:win-store` builds an unsigned x64 `Enduragent-<version>-x64.appx` in `dist/windows-store` for upload to Partner Center; the Store signs it, so a Store install shows no SmartScreen prompt. The package identity comes from the `ENDURAGENT_STORE_IDENTITY_NAME`, `ENDURAGENT_STORE_PUBLISHER`, and `ENDURAGENT_STORE_PUBLISHER_DISPLAY_NAME` environment variables, copied from Partner Center's product identity page; the build refuses to run without them. Inside a Store package the Store owns updates, so the app never checks the update feed, and the tray menu leaves out the start-at-login item because Windows ignores the registry entry it would write. Windows keeps a Store install's new `%LOCALAPPDATA%\Enduragent` files in a private per-package folder and deletes them on uninstall, unlike the installer build; the athlete home in `~/.enduragent` stays. The package targets Windows 11 (minimum `10.0.22000.0`), declares only `runFullTrust` and only `en-US`, and its tile images in `build/appx/` come from `resources/app-icon-windows.png` through `scripts/generate-windows-store-assets.mjs`. The installation heartbeat runs as in other official releases.

## Open at Login and uninstalling

Turn off **Open at Login** from Enduragent's menu-bar menu before removing the app. macOS can retain an inactive background-items record after unregistering it; Electron may report that record as `not-registered`. This is expected when both login-launch flags are off and does not mean Enduragent starts at login.
