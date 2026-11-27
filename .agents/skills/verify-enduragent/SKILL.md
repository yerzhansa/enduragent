---
name: verify-enduragent
description: Verify affected Enduragent desktop behavior through isolated fixtures and existing executors. Use for desktop verification or UI QA of Chat, Setup, Settings connections, shell lifecycle, Training, and Plan, to reproduce a desktop UI bug live, or to prove a desktop change in the running app.
---

# Verify Enduragent

Verify only mapped, affected desktop behavior. Read repository instructions and [`references/features/README.md`](references/features/README.md), then read the selected feature page.

## Rules

- Preserve executor ownership; Playwright, Vitest, CDP, and manual checks are siblings.
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

Treat proofs from the `fresh` and `ready` profiles as renderer-only: both run against a scripted engine RPC backend and do not prove engine side effects. Cover engine side effects with a future `real` profile that boots the actual coach engine over a seeded athlete home, uses fakes only at the LLM-provider and intervals.icu boundaries.

Run frozen scenario-catalog checks from the repository root with `pnpm --filter @enduragent/desktop check:verification-catalog`. `pnpm --filter @enduragent/desktop exec vitest run tests/windows-parity-scenarios.test.ts` fails because those citations are repository-relative.

Finish with `pnpm check:fixture-privacy`. Confirm the Electron fixture closed and report any retained evidence path. Upload only the PR before and after videos that AGENTS.md requires.

## Drive ad hoc

Use the CDP driver when no mapped executor covers the change, to reproduce a desktop UI bug live, or when a task ends with "prove it in the app". It launches the built app hidden with its own home, userData, token, and RPC server, and drives the renderer over CDP against a scripted engine on the `ready` profile. Run drive scripts from the repository root:

```bash
pnpm exec tsx .agents/skills/verify-enduragent/scripts/chat-send-proof.ts
pnpm exec tsx .agents/skills/verify-enduragent/scripts/chat-failed-send-proof.ts
```

Both are executed references. The first sends a chat message and proves the streamed reply renders with no visible error notice. The second proves a rate-limited send leaves **Retry message**.

- `launchReadyDesktop()` from `scripts/verify-driver.ts` starts the app on `baseScript()` and waits until the Chat composer is enabled. It throws with diagnostics if the Setup gate shows instead. Pass `{ script: baseScript(override) }` to change responses; an override that returns `undefined` falls through to the base.
- `baseScript()` is a ready, onboarded state: Setup done, an empty chat queue, an empty Plan library, and no spend. Chat sends go through `enqueueChatMessage` and the streamed `resumeChatQueue`. To script another reply or a failure, override `resumeChatQueue` and keep your own queue state, as `chat-failed-send-proof.ts` does.
- An RPC without a handler prints `verify-driver baseScript: unhandled RPC "<method>"` and throws. Copy response shapes from `apps/desktop/tests/e2e/fixtures/chat-desktop.ts` or the desktop integration tests; never invent them. Strict contract schemas reject stale shapes, and the app then shows only an error notice. Check each new response with `COACH_RPC_METHOD_REGISTRY[method].responseSchema.safeParse(value)` from `packages/coach-contract/src/index.ts`.
- `fixture.evaluate(source)` runs `source` inside an async function in the renderer and returns `{}` when it throws. Return a diagnostic object and assert in Node.
- Select by role, aria label, id, `data-*` state attribute, or BEM class; the renderer has no `data-testid`. Type with the native value setter plus an `input` event, then click the real button. Poll with 20 ms sleeps under a 10–15 s deadline.
- Write evidence to `await evidenceDir("<kebab-name>")`, which is `/tmp/enduragent-verify/<stamp>-<name>/`: a screenshot before and after the action, `result.json` with the asserted values, and `dom.html` from `fixture.readCapturedSurface("dom")` when the DOM carries the proof. Cleanup never touches this folder.
- Call `fixture.close()` in `finally` and report any PIDs in its `livePids`.
- stderr logs `desktop Planning unavailable` for `desktop:planning:read` because the fixture does not route `getPlanningReadModel`. Nothing shows in the app.
