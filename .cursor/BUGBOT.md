# Bugbot review rules

## Priorities

- Prioritize correctness, privacy, security, and user-visible behavior regressions over style-only feedback.
- Treat missing tests or missing verification for changed behavior as findings when the change is not obviously mechanical.
- For athlete-facing changes, check that a changeset exists and includes a `User-facing:` line when users should see the release note.
- Flag real athlete identifiers or current-era dates in fixtures, logs, and test data.
- Flag an intervals.icu ID matching `i\d{8,9}` or a large bare-integer activity ID in committed files.
- In public prose and identifiers, prefer project-owned language for the Reference layer and flag upstream-implementation branding unless it is the explicit subject.
- Flag user-visible text that does not use intervals.icu plain-English metric names.

## Code quality

- Flag every new code comment. Rationale belongs in the PR description or an ADR.
- Flag a swallowed error: `catch {}`, `.catch(() => {})`, or `.catch(() => undefined)`.
- Flag a fallback, retry, delay, flag, or special case that hides a failure instead of fixing its cause.
- Flag `@ts-ignore`, `@ts-nocheck`, `as unknown as`, `eslint-disable`, or `oxlint-disable` outside tests.
- Flag `TODO`, `FIXME`, `HACK`, or temporary code.
- Flag a new helper, hook, store, or RPC that duplicates an existing one.
- Flag a non-test source file that grows past 800 lines, and any growth of a file already over 800 lines.
- Flag a second writer for a piece of state that already has one.
- Flag code in `apps/desktop-renderer/src/ui/` that calls `window.enduragent*`, `fetch`, `setTimeout`, or `setInterval`.
- Flag a behavior change without a test that fails without it.
- Flag new `.js`, `.jsx`, `.mjs`, or `.cjs` files. Source, tests, tooling, and executable config are TypeScript.
- Flag references to plan artifacts such as wave numbers, phase letters, or decision IDs in code.
