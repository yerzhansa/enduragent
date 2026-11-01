---
name: test-audit
description: "Invoke whenever writing, changing, reviewing, or sweeping tests. Authoring gate for new tests plus audit and campaign workflows for low-value, implementation-coupled, or duplicative tests and the test-only production seams they demand."
---

# Test Audit

Three modes, one value bar. Authoring mode gates every new or changed test at
write time. Audit mode runs focused sweeps of tests that re-assert source,
duplicate stronger proof, couple behavior to implementation, or keep test-only
production seams alive. Continue broad audits as separate coherent follow-up
PRs; optimize for confidence, not deletion count. Campaign mode prunes one
package's or app area's whole test surface; before starting one, read
[CAMPAIGN.md](CAMPAIGN.md).

## Authoring gate

Before adding any test, answer four questions; a missing answer means do not
add it yet:

1. What observable behavior, invariant, or independent contract does it protect?
2. What credible regression makes it fail?
3. Why does existing coverage not already catch that failure? Each contract has
   one primary test owner at the strongest boundary; another layer needs its
   own distinct risk, such as an IPC or lifecycle failure the owner cannot
   reach. Prefer extending a table-driven case or shared fixture over a
   near-duplicate test; consolidate duplicated setup in the same change.
4. Does it need a production seam (export, flag, wrapper, injection hook) that no
   production caller needs? If yes, move the test to the real boundary instead.

Then check the test against every [junk pattern](#junk-patterns); a match fails
the gate unless the [retention bar](#retention-bar) names the contract it
independently guards. A test that would break under behavior-preserving
refactoring is asserting implementation, not behavior; rewrite it at the
owning boundary before landing it.

Bug regression tests must fail on the pre-fix code for the intended reason and
pass after the owner-boundary repair. A regression test that never demonstrably
failed proves the mock, not the fix. One regression at the owner boundary
covers the bug; do not replay the same scenario at every layer it crosses.

## Junk patterns

The shared checklist for every mode: the authoring gate rejects a new test that
matches one, and audits hunt for existing tests that do.

- assertion-free coverage probes;
- self-comparisons and identity copiers;
- copied fixtures, inventories, manifests, or export lists;
- exact source, import, or string greps;
- private predicate or call-shape tests duplicated at real boundaries;
- duplicate invocations of the same contract;
- per-sport or per-connector replays of shared helpers;
- tests whose only purpose is preserving test-only exports, globals, or wrappers;
- dead production code whose only callers are tests;
- expected values produced by the helper or renderer under test;
- mocks that implement the asserted behavior, or one identical mock standing in
  for different APIs;
- fixtures that supply the result, ordering, or acknowledgement the owner should
  produce, or persistence asserted against a store the path never writes;
- capability or flag tests that restate declared values instead of exercising
  the behavior the flag promises;
- negative controls that pass for an unrelated reason, such as a denial from a
  different guard or a rejection the production path never reaches;
- names or fixtures that promise more than the input exercises, such as a test
  named for clearing a value that asserts the value was kept.

## Value bar

Tests justify their maintenance cost by protecting behavior, a credible
regression, or an independently meaningful contract. In an audit, an existing
test that must change for behavior-preserving source reorganization is suspect,
not automatically deletable; the authoring gate still rejects new ones.

Before judging a candidate, read the complete test and production owner, its
entry point, callers, callees, sibling implementations, overlapping tests, CI
routing, and relevant history. First read root `AGENTS.md`, `CONTRIBUTING.md`,
`CONTEXT-MAP.md`, and the nearest `CONTEXT.md`. When the test claims
dependency-backed behavior, inspect the dependency source or types directly.

## Discovery

Keep discovery read-only and report evidence before editing. For broad scope,
run parallel discovery lanes when available:

- kernel, core, and engine (`packages/kernel`, `packages/kernel-node`,
  `packages/core`, `packages/engine`);
- sport and sync packages (`packages/sport-*`, `packages/sync-*`);
- coach packages and i18n (`packages/coach*`, `packages/*-coach`,
  `packages/i18n`);
- desktop (`apps/desktop`, `apps/desktop-renderer`) and tooling (`tools/`);
- a cross-cutting pattern sweep.

Outside campaign mode, prefer a few high-confidence candidates over a large
speculative inventory. Hunt for the [junk patterns](#junk-patterns).

## Retention bar

Keep a test when it independently enforces a public package API, `Sport`
contract, coach contract, IPC, config, cache-file schema, migration, storage,
security, privacy, platform, default, prompt-byte, Reference metric parity,
i18n catalog, package, release, or architecture contract. Also keep:

- call ordering when order is observable behavior;
- regressions with a credible failure mode;
- source inspection when it is the cheapest independent guard: it fails when
  the contract changes (the user-facing key, byte, or path) and survives an
  identifier-only refactor;
- a retained test that fails on the baseline: treat it as a possible product
  bug, reproduce it, and repair the owner rather than deleting it.

Static or slow is not a deletion reason. A test that resembles implementation
may still be the independent contract; prove otherwise before removing it.

## Candidate evidence

Record every field below before editing. A missing field means the candidate is
not ready for deletion:

- exact test name and location;
- what failure it can actually detect;
- non-test callers of the covered production or support seam;
- stronger remaining owner-boundary proof, or why no proof is needed;
- relevant history and the reason the test or seam exists;
- production or test-support deletion unlocked;
- risk and the focused validation command.

## Edit shape

Choose one coherent owner-boundary batch. Delete obsolete test-only exports,
globals, wrappers, and dead production paths instead of preserving aliases.
Move retained regressions to their canonical owners. Consolidate repeated
package or dependency assertions into one generic contract.

Prefer net-negative production LOC. Do not add replacement tests that restate
the same implementation, and do not convert uncertain candidates into cleanup
to increase deletion counts.

## Validation

Never edit source or tests while Vitest is running in the checkout. Run
`vitest run`, never bare `vitest`.

1. Run the smallest owner and sibling tests from the repository root with
   `pnpm exec vitest run <path-or-filter>`. Run `pnpm build` first when a test
   reads `dist/` or `out/`, as desktop integration tests do.
2. For removed source greps, run the `tools/check-*.ts` check or script that
   owns the real contract.
3. Run `pnpm exec oxfmt <changed-paths>`, then `git diff --check`.
4. Run root `pnpm check` and `pnpm test`.
5. Inspect `git diff --numstat`; report production/tooling separately from
   tests and test support.
6. After final audit edits, review the diff with `$code-review-and-quality`
   and the `Review guidelines` in `AGENTS.md`. When a removed test covered a
   desktop flow, prove its keeper in the app with `$verify-enduragent`.

## Landing and continuation

Commit, push, open a PR, or land only when authorized. Follow
`CONTRIBUTING.md` for branch, commit, and PR shape. Land one coherent PR at a
time; after landing, refresh from current `main` and rerun read-only discovery
for the next high-confidence batch. A product defect fix that athletes can
notice needs a changeset with a `User-facing:` line.

## Handoff

Report:

- root cause and removed low-value categories;
- production owner simplifications;
- retained false positives and why they remain valuable;
- focused and full proof actually run;
- production versus test LOC;
- PR and merge state;
- named follow-ups.
