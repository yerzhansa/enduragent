# Training

## Sub-features

- Owned user route: **Training** in Main navigation (`activeView: "training"`). Manifest surfaces: `training-setup`, `first-sync`, `training-import`, `training`, `ride-review`, `wellness`, `training-export`, and `training-sync`.
- Setup and first sync: [`setup.md`](setup.md) owns the Setup scenarios; Training owns `training.first-sync.provider-backfill`, `training.first-sync.file-only`, and `training.first-sync.failure-recovery`.
- Week-first overview and recovery: `training.view.panel-inventory`, `training.view.readiness-states`, `training.view.context-recovery`, `training.view.anchor-load-plan-adherence`, `training.power-progress.hidden`, and `training.wellness.trend`. Weekly summary owns riding time, rides, distance, Load, and the six-week trend; Recent rides owns the scoped callout.
- Ride review, import, export, and sync: `training.ride-review.navigation`, `training.ride-review.local-analysis`, `training.import.progress-results`, `training.export.activity-formats`, `training.sync.lifecycle`, and `training.sync.protocol-failure`. Ride review opens inline on the Training route. The sidebar owns the sync action (**Sync now** before the first success, **Sync** after), and Plan proves `training.export.workout-formats` beside its WorkoutMatch list.

Fixture/profile: isolated renderer `ready()` state with shifted fixture dates and no athlete profile or credentials. Supported executors: renderer and desktop `vitest`; native Windows scenarios remain `vm-only`.

## How to get to it (user POV)

- Complete Setup, then choose **Training** in Main navigation.
- Compare **This week** with **Previous week**, read the six-week riding-time trend, and start with the recent ride marked **Worth a look**.
- Use the sidebar sync action (**Sync now** when training has never synced, **Sync** after a successful sync) or **Import ride files** on Training. Open a ride from **Recent rides** for inline **Ride review**, then use **Back to training** to restore focus.
- Open **Recorded analysis** to load recorded analysis. Choose **Plan** to export its visible Workouts as a ZWO, MRC, ERG, or FIT archive.

## Driving it with verify-enduragent

```bash
pnpm --filter @enduragent/desktop-renderer exec vitest run tests/plan-surface.test.tsx tests/training-surface.test.tsx tests/training-context.test.ts tests/training-sync.test.ts tests/training-export.test.ts tests/activity-analysis-controller.test.ts tests/ride-interval-evidence.test.tsx tests/ride-import.test.ts tests/ride-import-adapter.test.tsx tests/sidebar-surface.test.tsx tests/first-sync.test.ts
pnpm --filter @enduragent/desktop check:verification-catalog
```

Require the renderer run to show **Weekly summary** and **Recent rides** in order, with **Power progress** absent. Weekly summary must show riding time, rides, distance, Load, and the six-week trend; Recent rides must show recorded facts and at most one **Worth a look** callout. Require truthful partial, zero, stale, sparse, and unavailable states, an import live region that persists through idle and suppressed states, inline Ride review with deferred analysis, recorded evidence without ride-export controls, sidebar sync recovery with a disabled-chip focus fallback, the ride export request, the Plan WorkoutMatch archive request, provider-backed first sync, and file-only first sync skipping provider sync. The standalone cycling anchor, power zones, Cycling Load, Plan, aggregate Adherence, and Wellness panels must remain absent. Require the catalog command to validate the frozen Training manifest and its deterministic citations; it does not execute the mapped behavior.

## Gotchas

- Setup must be complete before Main navigation is available; use the Setup feature page for the `training-setup` surface.
- Renderer tests use isolated state and mocked actions. They do not exercise real credentials, provider data, native file dialogs, or an installed application.
- `training.windows.ride-import-copy`, `training.windows.ride-import-native`, and `training.windows.export-native` require an installed Windows VM and have no deterministic citations.
- No Training-owned Playwright, CDP, S8A, or other live-driver flow is proved by the mapped Training tests or fixture.
