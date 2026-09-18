# Shell lifecycle

## Sub-features

- Owned scenario surfaces: `shell-bootstrap`, `shell-activation`, `shell-tray`, `shell-login`, `shell-power`, and `daemon-shutdown`, plus main-window creation, renderer shell settlement, and lifecycle error copy.
- Frozen Windows scenario-map rows: `shell.bootstrap.user-data`, `shell.bootstrap.app-identity`, `shell.single-instance.activation`, `shell.tray.window-residency`, `shell.tray.native-menu`, `shell.login.registration`, `shell.login.background-launch`, and `daemon.shutdown.quit-drain`.
- Supported executors: desktop and renderer `vitest` for executable behavior, desktop `vitest` for the frozen scenario map, and Playwright for an isolated development Electron launch. The same Playwright file also includes a hidden CDP startup-stage trace.

## How to get to it (user POV)

- Launch Enduragent from the operating-system app launcher or Windows Start menu. The main window settles into the language picker, the Setup gate, or the app shell after startup readiness is known.
- On Windows, launch again to bring the resident window forward; closing the main window keeps Enduragent in the tray, left-click opens it, and **Quit Enduragent** from the tray menu exits after accepted work drains.
- A terminal background-service failure shows path-free recovery guidance to quit and reopen Enduragent.

## Driving it with verify-enduragent

```bash
pnpm --filter @enduragent/desktop exec vitest run tests/main-window-creation.test.ts tests/desktop-lifecycle.test.ts tests/residency.test.ts tests/quit-coordinator.test.ts tests/lifecycle-messages.test.ts
pnpm --filter @enduragent/desktop-renderer exec vitest run tests/shell.test.tsx
pnpm --filter @enduragent/desktop check:verification-catalog
pnpm --filter @enduragent/desktop test:e2e tests/e2e/desktop-launch.spec.ts
```

Require Vitest to prove daemon-ready window construction, restore/show/focus activation order, app/gate shell states, Windows close-to-tray behavior, and a successful drain before normal exit. The catalog command proves frozen rows are valid and their deterministic citations exist; it does not execute the cited behavior.

Require Playwright's first test to prove one isolated development Electron process shows the **Enduragent** title, `#root`, a visible settled `app` or `gate` shell, no rendered athlete-home path, and the fixture-owned `userData` path. The second test traces hidden CDP startup stages through first navigation; it does not prove `#root`/shell settlement, packaged or installed launch, a second process, native tray/menu interaction, close-to-tray, or explicit quit/drain.

## Gotchas

- Run the skill's full Prepare build and Doctor first: Playwright launches `apps/desktop/out/main/index.js` through the installed Electron dependency and drives built renderer output. It blocks HTTP and uses temporary athlete-home and user-data directories; failure artifacts are under `apps/desktop/test-results/e2e/`. Isolated e2e sets `LANG=en_US.UTF-8`, so the language shell is usually skipped.
- `pnpm --filter @enduragent/desktop exec vitest run tests/windows-parity-scenarios.test.ts` fails: citation paths are repository-relative. Use `check:verification-catalog`.
- `shell.windows.second-launch`, `shell.windows.tray-residency`, `shell.windows.login-reboot`, and `shell.windows.power-events` remain `vm-only`. They require an installed Windows VM and real Start menu, process, Explorer tray, sign-in/reboot, or suspend/resume behavior.
- Do not treat deterministic Electron doubles or the Playwright development fixture as installed-Windows evidence.
