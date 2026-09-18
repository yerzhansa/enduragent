# Setup

## Sub-features

- `settings.setup.inventory`: required full-window gate; citation `apps/desktop-renderer/tests/onboarding-setup-card.test.tsx`. Setup-first Settings projection; citation `apps/desktop-renderer/tests/settings-surface.test.tsx`.
- `settings.providers.lanes`: production-reported coach choices with the current lane identified, including the first Settings Setup row showing the in-use coach; citations `apps/desktop-renderer/tests/onboarding-setup-card.test.tsx`, `apps/desktop-renderer/tests/onboarding-lanes.test.ts`, and `apps/desktop-renderer/tests/settings-surface.test.tsx`.
- `training.setup.intervals-clipboard-connect` and `training.setup.file-import-fallback`: copied-key connection or local ride import; citation `apps/desktop-renderer/tests/onboarding-setup-card.test.tsx`.
- `settings.setup.readiness-gate`, `training.setup.readiness-sources`, and `training.setup.readiness-recovery`: provider, durable training data, and saved intake control readiness and recovery; citations `apps/desktop-renderer/tests/onboarding-setup-card.test.tsx` and `apps/desktop-renderer/tests/setup-readiness.test.tsx`.

Fixture profile: `first-run`. Deterministic placements: `gate` and `settings` from `apps/desktop-renderer/tests/onboarding-harness.tsx`. Supported executors: renderer `vitest` and the macOS Electron CDP fixture.

## How to get to it (user POV)

- On a first launch with no saved language, **Choose your language** replaces the rest of the app; after that, launch Enduragent before Setup is complete or when credential repair is required and the full-window Setup gate replaces app navigation.
- After Setup is complete, choose **Settings** in Main navigation; **Setup** is the first section and its first row shows the coach in use.
- From a Coach recovery prompt in Settings, choose **Review setup** to focus that section.
- In the gate, choose what powers the coach, connect Intervals.icu or import ride files, answer injury status, then choose **Start coaching**.

## Driving it with verify-enduragent

```bash
pnpm --filter @enduragent/desktop-renderer exec vitest run tests/onboarding-setup-card.test.tsx tests/onboarding-lanes.test.ts tests/setup-readiness.test.tsx tests/onboarding-completion.test.ts tests/settings-surface.test.tsx
```

After the skill's Prepare build and Doctor, run the macOS `first-run` CDP fixture with `pnpm --filter @enduragent/desktop exec vitest run tests/onboarding-first-run.integration.test.ts`.

Require `3 of 3 required ready`, enabled **Start coaching**, a persisted completion marker, gate removal, restored navigation, enabled Chat, and ready Training with a visible recent ride. Require Settings Setup to render first and show the in-use coach on row 1.

## Gotchas

- Install workspace dependencies and build missing renderer dependencies with `pnpm --filter '@enduragent/desktop-renderer^...' build` before renderer Vitest. The CDP fixture requires macOS, loopback access on `127.0.0.1`, and the skill's full Prepare build.
- Isolated Electron fixtures typically set `LANG=en_US.UTF-8`, so the language picker is renderer-covered and `verified-unreachable` on those CDP/Playwright profiles without an unset language preference.
- The deterministic fixtures use mocked bridges and no real credentials. A real Intervals.icu connection requires its API key copied to the clipboard; the fallback requires local FIT, TCX, or GPX files.
- No Setup-owned Playwright flow exists. `apps/desktop/tests/e2e/desktop-launch.spec.ts` only proves isolated shell launch, not Setup behavior.
