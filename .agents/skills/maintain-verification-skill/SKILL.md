---
name: maintain-verification-skill
description: Audit and repair exactly one project-local verification skill without changing product behavior. Use only when explicitly invoked as `$maintain-verification-skill`.
---

# Maintain Verification Skill

Keep one verification skill, its feature map, and its owned runner aligned with current source and runtime behavior.

## Locate one target

Read repository instructions and locate the verification skill named by the invocation.

- If none exists, return `blocked` and point to `$create-verification-skill`.
- If several match, ask which one to maintain.
- Never combine multiple verification skills in one pass.

## Edit boundary

Edit only the selected skill and files explicitly owned by its verification runner. Do not change product source or product tests. Correct map drift and runner gaps; report product regressions without repairing or hiding them.

Preserve every existing executor and its ownership. Playwright, CDP, Vitest, and manual checks may be siblings; do not replace one with another for convenience.

## Maintenance pass

1. Compare the feature index with its feature pages and fix missing, duplicate, extra, or dead entries.
2. Run one read-only source investigation per feature, batching within available concurrency. Each returns cited entry points, likely drift or `none`, and one live recipe. Investigators do not edit or drive the app.
3. Reconcile every feature summary with the map. Require a concrete source path before adding a missing feature.
4. Keep all live driving in one coordinator. Run the target skill's doctor before the first drive and after surprising behavior, then exercise every feature once with its assigned executor.
5. Apply only proven map or runner corrections. Re-run focused tests and re-drive each runner correction.
6. Clean up after failures and after the final drive. Confirm evidence remains and no owned process, listener, profile, or data directory survives.

Use `verified-unreachable` only when the attempted route and a concrete platform, authentication, entitlement, or external-state prerequisite are recorded. Preserve evidence through every cleanup attempt, run the repository privacy check, and never upload evidence automatically.

## Result

End with exactly one status:

- `clean` — every feature received source and live coverage; no correction was needed.
- `changed` — verified corrections were made only within the edit boundary.
- `blocked` — coverage or a safe correction could not finish; state the blocker.

Create at most one verification-infrastructure PR, and only when the invocation authorizes PR delivery. Do not create a PR for `clean` or `blocked`.
