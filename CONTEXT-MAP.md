# Context Map

This repo is a multi-package monorepo for the enduragent AI coaching agent platform. Engine defines the Sport contract, sport packages supply domain behavior, and host packages compose them.

## Contexts

- [I18n](./packages/i18n/CONTEXT.md) — shared language registry, resolution, athlete-wide language preference, catalogs, phrasebooks, and training-term glossaries.
- [Core](./packages/core/CONTEXT.md) — shared CLI entry point, setup, memory, secrets, and channels. Defines `BinaryConfig` and re-exports Engine’s sport contract. Depends on Engine and Kernel through transitional edges.
- [Engine](./packages/engine/src/sport.ts) — defines `Sport`, `SportRuntimePorts`, and the `CoreDeps` alias at `@enduragent/engine/sport`.
- [Kernel](./packages/kernel/package.json) — declares portable compute, store, planning, and Reference exports. Its dependency rule forbids workspace imports and Node builtins.
- [Kernel Node](./packages/kernel-node/package.json) — declares Node host adapter exports and depends on Kernel.
- [Coach](./packages/coach/package.json) — declares runtime, sync, store-runtime, and serve exports; depends on Engine, Kernel, Kernel Node, and transitionally Core.
- [Cycling](./packages/sport-cycling/CONTEXT.md) — FTP-based zones, power-prescribed workouts, bike equipment, cyclist persona. Implements `Sport`. Bundled into the `cycling-coach` binary.
- [Running](./packages/sport-running/CONTEXT.md) — critical-speed pace zones, schemas, workout serialization, running tools, and a Reference adapter. Implements `Sport`.
- [Duathlon](./packages/sport-duathlon/CONTEXT.md) — coordinator context. Brick workouts, transitions, dual periodization. Stub.
- [Cycling Coach](./packages/cycling-coach/CONTEXT.md) — published `cycling-coach` binary; 7-line shim wiring cyclingSport + cyclingBinary into Core's runBinary.
- [Running Coach](./packages/running-coach/CONTEXT.md) — private binary whose entry point calls Core’s `runBinary(runningSport, runningBinary)`.
- [Duathlon Coach](./packages/duathlon-coach/CONTEXT.md) — `duathlon-coach` binary stub; placeholder banner.

## Relationships

- **Engine → sport packages**: **Open Host Service**. Engine defines `Sport` at `@enduragent/engine/sport`; Cycling and Running implement it. Coordinate contract changes across consumers. Consult [the dependency checker](./tools/check-package-deps.ts) for allowed and transitional package edges.
- **Cycling ↔ Running**: **Partnership**. Peer contexts that evolve in lockstep when the `Sport` interface or shared infrastructure changes. Neither is upstream of the other.
- **Duathlon → Cycling, Running**: intended **Customer/Supplier (Conformist flavor)**. The planned coordinator reuses their tools, personas, and zones and adds brick workouts, transitions, and dual periodization. The current Duathlon source is a stub; this relationship is not implemented.

## Why Duathlon is a Customer, not a peer

The intended composition follows two rules:

1. **It doesn't redefine upstream vocabulary.** "FTP" means the same thing inside Duathlon as inside Cycling. If a duathlete asks about FTP, Cycling's persona answers verbatim.
2. **It adds, never overrides.** Brick, transition, dual periodization are _new_ concepts that don't exist in Cycling or Running.

Once that composition is implemented, improvements to sport-cycling’s FTP-test guidance will also reach sport-duathlon. This is the load-bearing reason for the Customer pattern over Partnership.

## Status

Current state of the Core/Sport seam:

- **Core** — implemented private workspace package consumed by CLI binaries. Its `Sport` export forwards Engine’s definition. The dependency checker explicitly marks its Engine and Kernel dependencies transitional; shared infrastructure has not all moved out of Core.
- **Cycling** — implemented at `packages/sport-cycling/`. SOUL.md + skills/\*.md inlined into the bundle via tsup `.md: text` loader and skills.generated.ts codegen. Private workspace package (`@enduragent/sport-cycling`); bundled into the `cycling-coach` binary at publish time, not separately published.
- **Cycling Coach** — implemented at `packages/cycling-coach/`. 7-line bin shim. Published as `cycling-coach` on npm (CalVer continues). The published tarball is self-contained — `@enduragent/*` workspace code is inlined via `tsup` `noExternal`.
- **Running and Running Coach** — private workspace packages with implemented sport/tool composition and a CLI entry point. Source inspection establishes this wiring; it does not establish end-to-end coaching behavior or publication readiness.
- **Duathlon and Duathlon Coach** — private stubs at `packages/sport-duathlon/` and `packages/duathlon-coach/`; the sport exports a status constant and the binary prints a placeholder banner.
- **Scoped packages** — `check:package-deps` requires `@enduragent/*` packages to remain private. A declared export is a workspace API, not a publication commitment.

## Release flow

Changesets-driven, tag-triggered release split:

1. **`version-pr.yml`** opens or updates the bot-managed "Version Packages" PR. When that PR is merged, it tags and dispatches only public packages whose versions changed; a changed desktop app is independently tagged as `enduragent-desktop@<SemVer>`, given a draft release bound to the exact commit and desktop changelog, and dispatched to `desktop-release.yml`.
2. **`release.yml`** handles npm packages only. It gates on build + test + smoke-install, publishes via OIDC trusted publisher, and creates a non-latest GitHub Release so package releases cannot replace the desktop updater feed.
3. **`desktop-release.yml`** signs and notarizes on macOS, independently verifies the signed updater envelope, publishes the exact four updater assets to the bound draft, promotes it to repository latest, and confirms the production feed serves the new version.
4. **`desktop-windows-release.yml`** is the separate `workflow_dispatch` workflow for appending verified Windows assets to an existing published desktop release. The operator uploads the assets before it runs; the workflow verifies them and records the result as the `Enduragent-<version>-x64-verification.json` release asset without changing the release body, and it never gates `desktop-release.yml`.

Currently only `cycling-coach` is npm-publishable (per ADR-0009). The private desktop app follows its own SemVer and release transaction; changing it never changes or publishes `cycling-coach`. See `CONTRIBUTING.md` for the contributor-side steps.
