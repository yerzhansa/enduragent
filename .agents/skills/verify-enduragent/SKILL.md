---
name: verify-enduragent
description: Verify affected Enduragent desktop behavior through isolated fixtures and existing executors. Use for desktop verification or UI QA of Chat, Setup, Settings connections, shell lifecycle, Training, and Plan.
---

# Verify Enduragent

Verify only mapped, affected desktop behavior. Read repository instructions and [`references/features/README.md`](references/features/README.md), then read the selected feature page.

## Rules

- Preserve executor ownership; Playwright, Vitest, CDP, S8a, and manual checks are siblings.
- Never drive the operator's profile, athlete home, credentials, or production data.
- Rebuild dependencies, renderer, and desktop before Electron integration tests.
- Run deterministic citations before live flows.
- Treat the fixture's `finally` cleanup as mandatory; never kill processes by name.
- Report `passed`, `failed`, `blocked`, or `verified-unreachable`, with a concrete prerequisite for the last status.

## Prepare

```bash
pnpm --filter '@enduragent/desktop^...' build
pnpm --filter @enduragent/desktop-renderer build
pnpm --filter @enduragent/desktop build
```

If a build fails, stop with the failed command. Do not drive stale `dist/` or `out/` output.

## Doctor

```bash
pnpm exec tsx .agents/skills/verify-enduragent/scripts/doctor.ts
```

Require `DOCTOR: ready to drive` and exit code `0` before the first Electron drive. Doctor checks Node, macOS, Electron, `apps/desktop/out` freshness against desktop and renderer source, and loopback on `127.0.0.1`. It reports leftover `/tmp/eap-*` directories without deleting them.

## Verify

Follow the exact commands and proof requirements on the selected feature page. For Playwright, retain its failure screenshot, trace, and log under `apps/desktop/test-results/e2e/`; a passing run is supported by its visible-state assertions and command result.

Treat proofs from the `fresh` and `ready` profiles as renderer-only: both run against a scripted engine RPC backend and do not prove engine side effects. Cover engine side effects with a future `real` profile that boots the actual coach engine over a seeded athlete home, uses fakes only at the LLM-provider and intervals.icu boundaries, and reuses the `tools/s8a` provider machinery.

Run frozen scenario-catalog checks from the repository root with `pnpm --filter @enduragent/desktop check:verification-catalog`. `pnpm --filter @enduragent/desktop exec vitest run tests/windows-parity-scenarios.test.ts` fails because those citations are repository-relative.

Finish with `pnpm check:fixture-privacy`. Confirm the Electron fixture closed and report any retained evidence path. Do not upload evidence.
