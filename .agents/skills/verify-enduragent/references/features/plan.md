# Plan

## Sub-features

- Owned user route: **Plan** in Main navigation (`activeView: "plan"`). `PlanView` hosts no-Plan, creation, active week, library, history, and settings.
- Empty and start: **No active Plan** with **Start a Plan**; citation `apps/desktop-renderer/tests/plan-surface.test.tsx`.
- Library and calendar: Plan library load/retry and the verified seven-day calendar window; citations `apps/desktop-renderer/tests/plan-library.test.tsx`, `apps/desktop-renderer/tests/plan-controller.test.ts`, and live executor `playwright` `apps/desktop/tests/e2e/plan-calendar.spec.ts`.
- Workout archive export from the visible WorkoutMatch list is proved on the [Training](training.md) page.

Supported executors: renderer `vitest` and Playwright. No windows-parity Plan rows.

## How to get to it (user POV)

- Complete Setup, then choose **Plan** in Main navigation.
- With no active Plan, choose **Start a Plan**.
- With an active Plan, read the week, open a Workout, retry calendar mirroring from the library when it fails, and stop a Plan to see completed cleanup in final details.

## Driving it with verify-enduragent

```bash
pnpm --filter @enduragent/desktop-renderer exec vitest run tests/plan-surface.test.tsx tests/plan-library.test.tsx tests/plan-controller.test.ts
pnpm --filter @enduragent/desktop test:e2e tests/e2e/plan-calendar.spec.ts
```

Require the renderer run to show **No active Plan** and **Start a Plan**, then an active week with WorkoutMatch export controls when workouts exist. Require Playwright to show calendar progress and the verified seven-day window, library retry after a failed mirror, and completed cleanup in final details after stopping a Plan.

## Gotchas

- Run the skill's Prepare build and Doctor before Playwright. The calendar fixture uses shifted 1998 dates, a scripted engine, and a memory calendar; it does not prove a live intervals.icu calendar or an installed app.
- Failure artifacts live under `apps/desktop/test-results/e2e/`.
