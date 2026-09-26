# npm and Telegram verification feature map

This is the complete source-feature coverage map for `cycling-coach`. It maps 124 feature/behavior entries, eight coaching knowledge topics, and 43 diagnostic metric keys from the [source inventory](/Users/yerzhansagyt/projects/cycling-coach/docs/initiatives/npm-telegram-feature-inventory/inventory.md). The [coverage manifest](coverage.json) assigns each ID to exactly one page. It maps capabilities onto existing tests and scenario names; it does not replace their owning manifests or assertions.

Use one row or an affected set. Do not interpret page membership as runtime verification. Desktop and iOS parity remain separate future work. The four approval pages retain all 51 acceptance IDs and the existing [acceptance authority](/Users/yerzhansagyt/projects/cycling-coach/docs/initiatives/npm-workout-batch-approval/acceptance.md).

| Feature | Inventory IDs | Existing executor and live coverage limit |
|---|---|---|
| [Installation, hosting, and local data](install-and-hosting.md) | N01, N20, N25, N26 | Built terminal cancel; partial user-flow proof |
| [Setup, providers, and models](setup-and-providers.md) | N02, N03, N04, N05, N06, N07, N08, N09, N10, N11 | Existing Vitest plus page-specific manual route; live gaps explicit |
| [Credentials, connections, and sender administration](secrets-and-connections.md) | N12, N13, N14, N15, N16 | Existing Vitest plus page-specific manual route; live gaps explicit |
| [Language and locale](language.md) | N17, T14, T15, T16 | Existing Vitest plus page-specific manual route; live gaps explicit |
| [Conversation and session continuity](terminal-and-session.md) | N18, N19, C06, T04, T29, T30 | Built terminal incomplete; partial user-flow proof |
| [Athlete memory, recall, and saved plans](memory-and-recall.md) | C02, C03, C04, C05, C21 | Built coaching terminal memory; partial user-flow proof |
| [Athlete data and recorded-session review](athlete-data-and-review.md) | C07, C08, C09, C10, C11, C12, C13, C14, C15 | Built coaching terminal data; partial user-flow proof |
| [Coaching, zones, feasibility, and plan drafts](planning-and-coaching.md) | C01, C16, C17, C18, C19, C20, C22, C30, K01, K02, K03, K04, K05, K06, K07, K08 | Built coaching terminal planning; partial user-flow proof |
| [Calendar workouts and external delivery](calendar-workouts.md) | C23, C24, C25, C26, C27, C28, C29, T17 | Built terminal mixed; partial user-flow proof |
| [Telegram access and conversation](telegram-access-and-chat.md) | T01, T02, T03, T05, T06, T07, T08, T09, T10, T11, T26, T27 | Existing Vitest plus page-specific manual route; live gaps explicit |
| [Training synchronization and diagnostic snapshots](sync-and-snapshot.md) | N21, C31, T12, T22, T23, T24, T25, M01, M02, M03, M04, M05, M06, M07, M08, M09, M10, M11, M12, M13, M14, M15, M16, M17, M18, M19, M20, M21, M22, M23, M24, M25, M26, M27, M28, M29, M30, M31, M32, M33, M34, M35, M36, M37, M38, M39, M40, M41, M42, M43 | Existing Vitest plus page-specific manual route; live gaps explicit |
| [Version, releases, updates, and feedback](release-and-feedback.md) | N22, N23, N24, T13, T18, T19, T20, T21 | Existing Vitest plus page-specific manual route; live gaps explicit |
| [Error recovery and local diagnostics](errors-and-diagnostics.md) | N27, N28, T28 | Existing Vitest plus page-specific manual route; live gaps explicit |
| [Review and approval](review-and-approval.md) | W01, W02, W03, W04, W05, W06, W07, W08, W09, W10, W11, W12, W13, W14, W15, W16, W35 | Built terminal revision; partial user-flow proof |
| [Restrictions and approval validity](restrictions.md) | W17, W18, W19, W20, W21, W22, W23 | Built terminal mixed; partial user-flow proof |
| [Changed workouts and refreshed review](changed-workouts.md) | W24, W25, W26 | Built terminal stale; partial user-flow proof |
| [Failure, retry, and restart](recovery.md) | W27, W28, W29, W30, W31, W32, W33, W34 | Built terminal retry; partial user-flow proof |

## Coverage checks

Run `node .agents/skills/verify-npm-coach/scripts/check-feature-map.mjs --repo=<checkout>` from the main project. This verifies inventory-ID coverage, feature pages, required headings, source/test paths, registered Telegram commands, metric keys, and all 51 existing acceptance IDs. It does not run product tests or grant runtime PASS.

## Existing live executors

Terminal scenarios remain `single`, `mixed`, `revision`, `cancel`, `long`, `stale`, `retry`, and `incomplete`. Only `mixed --restart` proves pending-workout restart. The original scripted provider does not interpret arbitrary coaching messages. The separate `coaching-terminal.mjs` adds `memory`, `data`, and `planning` cases with real tool-result and persistence assertions; see [the coaching fixture report](../maintenance/coaching-extension/README.md). No new scenario name is implied by a page name.

Telegram driving remains one coordinator using the managed launcher and an isolated authenticated browser. The default doctor route requires dedicated configuration. Doctor validates identity and webhook state, not poller exclusivity. Establish poller ownership separately. An existing development bot/profile is available only under the parent skill's explicit session-authorization route; do not infer authorization from prior reports. Startup alone is NOT RUN. Missing prerequisites or unsupported fault/lifecycle controls are BLOCKED, never silently replaced by mocked dispatch tests. The current launcher forces English, preauthorizes the operator, starts a fresh home, and removes it on exit.

## Evidence and current maintenance

Use the parent skill's retained-evidence and cleanup contract. Record source coverage, component/service tests, built terminal proof, and actual Telegram browser proof independently. Keep exact revision and binary hash with each result. Read [the maintenance report](../maintenance/latest.md) for the latest attempted scope and blockers. This report does not replace per-run evidence.

## Earlier bounded evidence

The [earlier maintenance record](../maintenance.md) and [real Telegram report](/Users/yerzhansagyt/projects/cycling-coach/docs/initiatives/npm-workout-batch-approval/verification/telegram-real-report.md) retain their original scopes. That separately owned guarded harness proved bounded live-model/calendar behavior, including the repeat-boundary correction at 24e46aca. The fixture stores supplied durations without parsing native workout text, so it cannot prove the external parser. Preserve the existing real-provider recipe and its authorization requirements in [Review and approval](review-and-approval.md). The description-only preview correction and subsequent automatic chart implementation have separately scoped real-provider evidence. Current production chart, structured edit, pending rename and batch-position checks are in [chart-card verification](../future-review-prototype.md). Historical runs retain their original revisions and limits.
