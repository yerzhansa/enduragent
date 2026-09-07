<!-- trademark-lint:skip-file — the "Trademark hygiene" section below documents
the substitution table and must legitimately name the forbidden tokens. -->

# Contributing

## Branch Naming

Branches use full English-word prefixes (NOT the abbreviated commit-type form):

```
feature/<short-description>      — new feature or capability
bugfix/<short-description>       — bug fix
chore/<short-description>        — maintenance, deps, config
docs/<short-description>         — documentation only
refactor/<short-description>     — code restructuring, no behavior change
test/<short-description>         — test-only changes
performance/<short-description>  — performance improvement
ci/<short-description>           — CI/CD changes
style/<short-description>        — formatting, no logic change
```

Use lowercase, kebab-case. Keep the description under 50 characters.

Examples: `feature/session-management`, `bugfix/telegram-html-escape`, `chore/bump-intervals-api`, `performance/snapshot-harness-parallel`.

**Branch prefix vs commit type.** Branches use full words (`feature/`, `bugfix/`, `performance/`); commit messages keep Conventional Commits' abbreviated forms (`feat:`, `fix:`, `perf:`). This is deliberate — branch names are read by humans navigating `git branch`, commit messages are read by tooling.

## Pull Requests

- **Title**: imperative mood, under 70 characters (e.g., "Add session management and context compaction")
- **Branch**: always branch off `main`, PR back into `main`
- **One concern per PR**: don't mix unrelated features in a single PR
- **Description**: include a Summary (what and why) and a Test Plan

## Commits

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>
```

**Types:**

| Type       | When                                   |
| ---------- | -------------------------------------- |
| `feat`     | New feature or capability              |
| `fix`      | Bug fix                                |
| `chore`    | Maintenance, deps, config              |
| `docs`     | Documentation only                     |
| `refactor` | Code restructuring, no behavior change |
| `test`     | Adding or updating tests               |
| `perf`     | Performance improvement                |
| `ci`       | CI/CD changes                          |
| `style`    | Formatting, no logic change            |

**Scope** is optional — use the module name when helpful: `core`, `telegram`, `soul`, `config`, `tools`, `memory`.

**Examples:**

```
feat(core): add rate limit retry with backoff
fix(soul): prevent coaching tone drift and emoji-only responses
chore(deps): update intervals-icu-api to 0.1.2
refactor(telegram): extract error formatting helper
test(endurance): add 100-message endurance test
docs(readme): document the /whatsnew command
```

**Rules:**

- Imperative mood: "add X", "fix Y", not "added X" or "fixes Y"
- Lowercase after the colon
- One logical change per commit when practical

**Flake remediation marker.** A commit that fixes or remediates a test flake carries a `flake:` note — either a `flake:` trailer line in the body or a `flake:` marker in the subject — so `git log --grep=flake` is a deliberate, durable measurement surface for flake-remediation history. This is a searchable marker for measurement, **not** a new Conventional-Commits type: the subject still uses one of the types above (`fix(test):`, `test:`, `chore:` as appropriate), and the release tooling does not interpret `flake:`.

## Test determinism

- **Restore real timers.** A test that calls `vi.useFakeTimers()` MUST restore real timers in `afterEach` via `vi.useRealTimers()`. The default `vi.restoreAllMocks()` does NOT restore fake timers, so a converted test that forgets this leaks faked time into the next test in the file.
- **Never run fake-timer tests under `isolate: false`.** Shared fake-timer state across files corrupts unrelated suites. The root `vitest.config.ts` pins `pool: "forks"` + `isolate: true` precisely so each file gets its own process and clock; do not weaken that to `isolate: false`.
- **Prefer fake-timer or injected-clock determinism over wall-clock sleeps.** Tests that assert on elapsed time (mutex acquire timeouts, run-sync phase ordering) drive time through `vi.advanceTimersByTimeAsync` or an injected clock seam rather than racing a real `setTimeout`, so they cannot flake on a slow runner.

## Desktop UI verification

Shared controls, themes, fonts, and Storybook belong in [enduragent-ui](https://github.com/yerzhansa/enduragent-ui). Experimental flows belong in [enduragent-prototypes](https://github.com/yerzhansa/enduragent-prototypes). App consumes the same versioned GitHub release tarball as Prototypes. The UI library uses SemVer, starting at `0.1.0`. Pin its exact URL and SHA-512 integrity with pnpm 11; do not use an npm registry version, moving branch, or local file dependency in a submitted change.

Run `pnpm build`, then `pnpm check:ui-states` on macOS 26 with Apple Silicon. The production Electron fixture covers five application states in wide/compact and light/dark layouts, plus four Settings structure and image negative controls. It uses isolated profiles and scripted loopback responses with real navigation, storage, and native appearance. Run `pnpm check:ui-structure` for the structural checker tests. Affected desktop journeys still require application QA.

Native captures record source, build, UI artifact, Electron, and embedded Chromium identities. The sealed manifest lives in `apps/desktop/tests/e2e/application-ui-states/baselines/`. To replace a reference, choose a new baseline version in the configuration and identity helper, rebuild, capture with `--update-snapshots`, inspect every image, then run the adjacent `seal-baseline.ts` with `--reviewed`. Keep prior versions intact. Frozen verification rejects recapture and altered or missing images. The historical Storybook archive remains in App as origin evidence. Regression references do not replace feature acceptance.

## Trademark hygiene

The Reference submodule (`packages/core/src/reference/`) ports from an MIT-licensed upstream; the full attribution (author, copyright, license text, and source link) lives in [`NOTICE.md`](./NOTICE.md). That upstream was authored against TrainingPeaks vocabulary; this codebase uses [intervals.icu](https://intervals.icu)'s plain-English alternatives throughout. **PRs that introduce the forbidden tokens in Reference source or docs are rejected by the lint.**

| TrainingPeaks (forbidden) | intervals.icu (use this) |
| ------------------------- | ------------------------ |
| CTL                       | Fitness                  |
| ATL                       | Fatigue                  |
| TSB                       | Form                     |
| TSS                       | Load                     |
| IF                        | Intensity                |
| NP / "Normalized Power"   | weighted average power   |

`pnpm check:trademarks` runs the AST-walking linter at `tools/check-trademarks.ts`. For TypeScript files, only string literals, template literals, and comment trivia are checked — code identifiers are ignored, so a name like `IF` as an identifier never trips a false positive. Markdown files are scanned with word-boundary regex, with fenced code blocks excluded.

A file that legitimately needs to mention the forbidden tokens (the linter's own source, a glossary file, a test fixture) opts out by placing `trademark-lint:skip-file` in any commenting style within the first 1 KB of the file. Use sparingly; the default scope is the Reference submodule and `tools/`.

## Reference schema-version policy

Each cache file under `<coach-home>/data/` (`latest.json`, `history.json`, `intervals.json`, `routes.json`, `ftp_history.json`) declares its own `<FILE>_SCHEMA_VERSION` constant in `packages/core/src/reference/schemas/`. **Bump only the file whose shape changed; never bump them in lockstep.** The version is informational — Zod-strict-as-gate is what handles drift via discard-and-resync. There is no `migrations/` directory; a schema bump is a code-only change that triggers a fresh sync on the next `runSync()`.

## Fixture stewardship

The committed fixture at `packages/core/tests/fixtures/golden/realistic-athlete.json` is derived from a real operator's intervals.icu account, sanitized via `tools/sanitize-fixture.ts` per the schema-derived allowlist policy. The fixture lives next to a SHA-256 checksum (`realistic-athlete.json.sha256`) that CI verifies on every PR — a mismatch fires `realistic-athlete-fixture-checksum.test.ts` and surfaces accidental in-place mutation (bad merge, editor save, formatter pass).

The deeper provenance check — re-running the sanitize CLI against the saved source mock and comparing bytes — is operator-machine-only: `sanitize-cli-fixture-stability.test.ts` skips when `docs/mocks/intervals-icu-raw-2026-05-11.json` is absent (gitignored, so absent on CI and on fresh clones). The operator is responsible for re-running it before any fixture-regen PR.

**Operator regen flow:**

```
INTERVALS_API_KEY=… pnpm exec tsx tools/fetch-real-athlete.ts
pnpm exec tsx tools/sanitize-fixture.ts <bundle path printed by fetch-real-athlete> realistic-athlete --force
```

The fetch step writes the unsanitized bundle to a private per-run temp directory (mode 0600) and prints the path; delete it once the sanitized fixture is committed.

The second command writes both `realistic-athlete.json` and `realistic-athlete.json.sha256`. Commit both, or neither. Reviewers don't read the 70 KB JSON diff line-by-line — the review focuses on the `SanitizeSummary` the CLI prints (which keys were dropped, which were transformed) and a green metric-test suite.

**Reviewer checklist for schema-adding PRs.** When a PR adds a field to any of the seven input schemas in `packages/core/src/reference/schemas/inputs.ts`, the new field is now auto-allowed in committed fixtures via `ALLOWED_FIXTURE_KEYS`. Confirm the field is either (a) not present in the source mock, or (b) carries no PII once the mock includes it. If neither holds, the field must land with a value-level transform in `TRANSFORMS` (see `source` as precedent) or be excluded via a schema-shape carve-out.

## Fixture privacy

Golden fixtures under `packages/core/tests/fixtures/golden/` derive from a real intervals.icu athlete account. Two classes of identifier must NEVER reach a committed fixture:

1. **Account-linking ids.** Real intervals.icu activity ids have the shape `i` + 8-9 digits (string form) or a large bare integer (number form). The operator sanitizer (`tools/sanitize-fixture.ts` -> `tools/sanitize-fixture-transform.ts`) redacts every numeric `id`/`*_id` to the `12345` sentinel; synthetic build fixtures use the reserved ranges `90101+` (curve-equipped) and `90201+` (dfa-equipped).
2. **The athlete's real training calendar.** ISO dates are no longer ridden through verbatim — the sanitizer and the `build-*-fixture.ts` scripts shift every date back one full Gregorian cycle to a synthetic pre-2010 epoch via the shared `tools/shift-to-synthetic-epoch.ts` util. A full-cycle (year -= 28) shift preserves every date-to-date day-delta exactly, so temporal metrics stay bit-identical in shape AND value.

A static gate, `pnpm check:fixture-privacy` (`tools/check-fixture-privacy.ts`), runs in CI and enforces both invariants by SHAPE: it forbids the real id shape `i\d{8,9}` anywhere under `packages/` and `tools/` (outside the documented synthetic-placeholder allowlist or a `fixture-privacy-lint:skip-file` marker), and forbids ISO dates with year >= 2015 inside real-data golden fixtures. Fully-synthetic golden fixtures (hand-crafted / fuzz-derived, zero real data — see the provenance column in `packages/core/tests/fixtures/README.md`) are exempt from the date rule via `SYNTHETIC_FIXTURE_ALLOWLIST`.

Every FIT, TCX, or GPX file, matched case-insensitively under the gate's default scan paths, must appear in the canonical SHA-256 manifest and have an exact checksum sidecar. TCX and GPX coordinates must remain inside the repository's synthetic geography, every date-shaped value must be pre-2015, and required times must carry an explicit zone. The skip-file marker and both synthetic allowlists apply only to the legacy source checks; they never bypass binary or XML validation.

Never commit bytes from a real athlete recording. Gate tests use only fabricated bytes created in temporary directories, and committed fixture landing is a later, separately reviewed change. The manifest is an integrity and review surface, not proof of provenance. After changing any fixture surface, run `pnpm check:fixture-privacy` locally.

## Telegram allowlist file

The bot enforces a per-user-ID allowlist via `~/.cycling-coach/allowed-senders.json` (mode `0600`). Schema and validation live in `packages/core/src/channels/allowed-senders.ts`. CLI mutations (`add-sender`, `remove-sender`) acquire a PID lockfile at `~/.cycling-coach/.allowed-senders.lock` so concurrent invocations serialize cleanly. **Do not edit `allowed-senders.json` by hand while the bot is running** — the bot re-reads it on every inbound message, but a hand-edit during a write loses updates. Use the CLI subcommands instead.

`dmPolicy: "open"` is rejected when read from the file (defense in depth — only settable via the `CYCLING_COACH_DM_POLICY=open` env var, intended for debugging). The setup wizard never offers it.

## Versioning

Calendar-based for npm-published binaries: stable, SemVer-compatible UTC calendar dates in `YYYY.M.D` form (for example, 2026-08-08 is `2026.8.8`). The final component is the day of the month, not a release counter, and new releases never use a prerelease suffix. Historical counter-based and suffixed versions remain accepted as release history but are never generated again. If the current UTC date is already occupied or would not be greater than published history, release automation fails closed rather than inventing a suffix or future date. Private workspace packages (`@enduragent/*`, stub binaries) use SemVer and are not published. See ADR-0007 and ADR-0009.

## Releasing

Changesets-driven and CI-automated. Contributors do **not** create tags or GitHub Releases by hand. npm packages use `<package>@<version>` tags; the independent desktop app uses `enduragent-desktop@<SemVer>`.

1. **Add a changeset to your PR.** Run `pnpm exec changeset`, pick the affected publishable package(s), describe the change in athlete-readable language. Commit the resulting `.changeset/<slug>.md`. A PR with a user-visible change but no changeset skips release — this is intentional, not a bug. The required patch/minor/major choice is overridden by the CalVer policy for binary packages.

   For user-visible changes, add a `User-facing: <one-sentence description>` line at the top of the changeset body — see `.changeset/README.md` for the convention. The bot's `/whatsnew` command surfaces only those lines to athletes; engineering details, hashes, and infra-only changesets stay in `CHANGELOG.md` for git history but never reach users.

2. **Merge your PR to `main`.** `version-pr.yml` opens (or updates) a bot-managed "Version Packages" PR aggregating all pending changesets.
3. **Merge the "Version Packages" PR when ready to ship.** It bumps only the packages listed by pending changesets. On merge, `version-pr.yml` tags and dispatches only public package versions that changed; if `apps/desktop/package.json` changed, it separately creates `enduragent-desktop@<SemVer>`, creates a draft release bound to the desktop changelog, and dispatches `desktop-release.yml` on that tag.
4. **The matching release path runs.** `release.yml` publishes changed npm packages via OIDC and keeps their GitHub Releases non-latest. `desktop-release.yml` publishes no npm package; it signs and notarizes on macOS, independently verifies the signed envelope, publishes the exact four updater assets, and promotes the release to repository latest.

Today only `cycling-coach` is `private: false`, so only `cycling-coach@<v>` is tagged. When a stub binary (`running-coach`, `duathlon-coach`) graduates by flipping `private: false`, it auto-tags on the next Version-PR merge.

**If a release fails partway**, re-run the matching workflow with its existing tag: `release.yml` for npm, or `desktop-release.yml` for desktop (the version-pr run's failed step prints the exact dispatch command). A rerun never creates or moves a tag.

`tools/bump-binaries-to-calver.ts` runs after `changeset version`. It reads the committed pre-Changesets version and all occupied npm versions, then overrides binary versions with the next stable release number for the current UTC month. It rewrites only the new matching changelog header; historical entries are immutable.

## Windows release (operator)

- Keep `desktop-release.yml` macOS-only and fully automatic.
- Never make `desktop-release.yml` wait for Windows.
- Use one GitHub release per desktop version.
- Append Windows assets after the macOS release.
- Append Windows assets only while `enduragent-desktop@<x.y.z>` is the repository's latest release. The updater feed is `/releases/latest/download/`, so Windows clients cannot discover assets on an older release.
- Skip Windows for a version once a newer desktop release exists. Ship it with the next version instead.
- State which platforms shipped in the release notes.
- Build and sign in one `electron-builder` run on the operator's Windows VM inside an open SimplySign session.
- Approve the single signing OTP with one phone tap.
- Never build, repackage, or re-sign a Windows asset in CI.
- Require every shipped Windows build to carry a valid Authenticode signature from `<PUBLISHER_NAME>`.
- Do not put the certificate organisation field in shipped docs. The publisher line uses the `<PUBLISHER_NAME>` placeholder until the first signed release.
- Never attach an unsigned installer to a GitHub release or the website.
- Use unsigned CI builds only as test artifacts.
- Keep `DESKTOP_UPDATE_PLATFORM_ACTIVATION` at `win32: false` until the first signed release and a signed N→N+1 update proof pass.
- Upload only `Enduragent-<x.y.z>-x64.exe`, `Enduragent-<x.y.z>-x64.exe.blockmap`, and `latest.yml` from the repository root on the signing host, using absolute paths:

  ```bash
  node apps/desktop/scripts/upload-windows-release.mjs --version <x.y.z> --directory <absolute-artifact-dir> --commit <release-commit-sha> --authenticode verify --publisher-dn "<PUBLISHER_DN>" --app-update-metadata <absolute-dist-dir>/win-unpacked/resources/app-update.yml --record <absolute-path>/windows-release-<x.y.z>.json
  ```

- Pass `--authenticode verify` and the exact certificate subject as `--publisher-dn`. The uploader rejects every other mode and the placeholder DN.
- Pass `--thumbprint <40-hex>` to pin the signing certificate. Omit it to accept any trusted certificate with the expected subject.
- Run the upload on a Windows host with PowerShell 7 and `signtool.exe`. Local Authenticode verification runs before any release mutation.
- Pass `--app-update-metadata` pointing at the packaged `win-unpacked/resources/app-update.yml` from the same build. The uploader refuses it unless `publisherName` equals `--publisher-dn`.
- Keep `--record` outside `--directory`. The uploader refuses a record path inside the artifact directory.
- Omit `--record` only when no local JSON record is required.
- Leave `--repo` unset to use `yerzhansa/enduragent`.
- Let `upload-windows-release.mjs` run `verify-windows-release.mjs` locally, including Authenticode and provenance verification.
- Stop the upload when `enduragent-desktop@<x.y.z>` is missing, still a draft, a prerelease, or not the latest release.
- Refuse the upload when any Windows envelope asset already exists on the release.
- Upload owner-only, read-only copies of the verified bytes through `gh-personal release upload`. The original artifact paths are never uploaded.
- Re-read the release after upload and fail unless all three assets are present and each GitHub asset `digest` and size equals the uploaded bytes.
- Re-check `releases/latest` after the digest reconciliation. When the release stopped being latest during the upload, the uploader deletes its three assets and fails with `release lost latest status during upload; Windows assets removed`. Re-run the whole Windows release for the newer version.
- Treat a failed record with `uploaded: true` or `uploaded: "unknown"` after that rollback as an incomplete upload. Remove the listed assets by hand; with `uploadedAssets: null`, inspect the release by hand.
- Read `uploadedAssets` in a failed record before retrying. A partial upload lists the assets that became public.
- Trigger the separate verification workflow from the repository root:

  ```bash
  gh-personal workflow run desktop-windows-release.yml -f version=<x.y.z> -f dry_run=false -f authenticode=verify -f publisher_dn="<PUBLISHER_DN>"
  ```

- Leave `dry_run` at its `true` default to verify without editing the release.
- Pass `dry_run=false` only when the completed verification must be recorded on the release. The workflow refuses `dry_run=false` without `authenticode=verify` and a real `publisher_dn`.
- Keep `desktop-windows-release.yml` to its single `verify-windows-envelope` job on `windows-latest`. `Get-AuthenticodeSignature` and `signtool.exe` exist only on Windows.
- Reject a non-stable SemVer or a missing, draft, prerelease, or non-latest `enduragent-desktop@<version>` release in `verify-windows-envelope`.
- Require exactly `Enduragent-<version>-x64.exe`, `Enduragent-<version>-x64.exe.blockmap`, and `latest.yml` as the Windows envelope among the release assets.
- Download only those three Windows assets in `verify-windows-envelope`.
- Resolve the release tag to its commit and pass it as `--commit`.
- Run `node apps/desktop/scripts/verify-windows-release.mjs <dir> --version <version> --commit <sha> --authenticode verify --publisher-dn <dn>` against the downloaded envelope.
- Record the verification only when `dry_run=false`, as the release asset `Enduragent-<version>-x64-verification.json` (`schemaVersion`, `tag`, `version`, `commit`, `arch`, `authenticode`, `installerSha256`, `publisherDnSha256`, and the exact Windows asset IDs/sizes/SHA-256 digests in `files`). Recheck those three asset identities before and after the evidence upload. Never edit the release body: a body `PATCH` overwrites concurrent release-note edits.
- Skip the upload when an identical evidence asset exists. Fail when an evidence asset with different bytes exists; remove it by hand before retrying.
- Never create, move, or delete a release or tag in `desktop-windows-release.yml`, and never delete or replace a pre-existing asset there. The evidence asset is the only asset the workflow creates; if release identity or latest status changes during that upload, delete only the exact evidence asset created by that run.
- Leave uploaded assets in place when verification fails.
- Remove failed Windows assets by hand before retrying.
- Build provenance: `windows-release-plan.mjs` seals the release commit, SHA-256 of the publisher DN, and SHA-256 of the exact electron-builder-serialized `app-update.yml` into the installer's signed `LegalTrademarks` version string. Verification reads it from the signed installer and requires all three bindings to match before upload.
