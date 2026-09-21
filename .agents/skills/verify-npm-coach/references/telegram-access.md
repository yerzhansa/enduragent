# Telegram verification access

Read this note before asking the operator for Telegram credentials or a browser profile. The project `.env` is the source of truth for tokens (operator, 2026-09-21). These resources already exist on this Mac. Recheck their current state before use.

## Where to find the setup

Last observed on 2026-09-21.

| Resource | Location or identity | Observed state |
|---|---|---|
| Token source | `/Users/yerzhansagyt/projects/cycling-coach/.env` | `TELEGRAM_BOT_TOKEN` is configured. Values were not printed. |
| Derived verification configuration | `/tmp/npm-telegram-authorized-test.json` | File exists, mode `0600`; it contains the runner’s token, bot identity, and operator ID fields. |
| Development test bot | `@cycling_coach_111_bot` | Matches the private file; `operatorAuthorized` is true. |
| Existing browser | Chrome, accessed through `cua_repl` | Authenticated in this task through a fresh tab in Chrome profile `Person 1`; no new login was needed. |
| Telegram chat | `https://web.telegram.org/k/#@cycling_coach_111_bot` | Source tab `1035870751` remains source-owned. This task created and closed its own tab `1035870752`. |
| Real-session metadata | `/tmp/npm-real-telegram-active.json` | Contains `runHome` and `model`; it does not contain a launcher PID. |
| Last recorded real-session home | `/tmp/npm-real-telegram-Y9DCX2` | Read the metadata again rather than assuming this path is current. |
| Source task | [Investigate issue 1088 flow](thread://01a0be42-5b8e-78b3-b886-e0ebc3808d2f?hostId=local) | Owns the existing bot/browser setup and its handoff information. |
| Originating verification task | [Originating task](thread://01a0bff3-3c98-7de3-8e9b-8a64933bd31e?hostId=local) | Contains the operator's approvals, direction to reuse the source task's setup, and the handoff request. |

The source task already ran the Telegram doctor successfully with this file and the existing-development-bot flag. This task checked the file metadata and confirmed that its token matches `TELEGRAM_BOT_TOKEN` in the project `.env`. Neither observation proves current exclusive ownership of a polling process.

Regenerate a missing derived configuration from `TELEGRAM_BOT_TOKEN` and the source task’s verified bot/operator metadata. Preserve mode `0600`. Read only the required token when preparing this configuration; do not load the full `.env` into the fictional fixture process.

The `/tmp` files and browser tab are temporary. Their recorded presence is a discovery lead, not a permanent resource guarantee.

## Live training-data test configuration

By default, use `INTERVALS_API_KEY_2` with `INTERVALS_ATHLETE_ID_2` from `/Users/yerzhansagyt/projects/cycling-coach/.env`, alongside OpenRouter’s `deepseek/deepseek-v4.1-flash` model. Read `OPENROUTER_API_KEY` from the same `.env` file. Keep the matching `_2` pair together; do not substitute the default Intervals credentials.

Use real coaching replies for these live checks. Scripted fixtures may return diagnostic JSON and do not prove real-model response quality. Workout verification includes the operator-authorized additions, edits, and deletions of marked disposable test workouts. Keep unrelated training-data checks read-only. Save variable names and redacted observations only; never save credential values, real athlete identifiers, or raw athlete data in this guide or retained evidence.

## Continue without asking for the same details again

1. Read both linked tasks with `read_thread` before relying on their current instructions or handoff state.
2. Preserve the operator's existing approval when continuing the same verification scope.
3. Resolve `TELEGRAM_BOT_TOKEN` from the project `.env` without printing its value.
4. Check the derived file’s existence, ownership, permissions, token match, and expected bot identity.
5. Read the source task's latest handoff before controlling its browser tab or replacing its bot connection.
6. Establish the active poller's owner and launcher handle before starting another launcher.
7. Have the owning task release or mark its Telegram tab for handoff when its checks finish.
8. Verify the bot header and signed-in browser state through fresh UI observations after handoff.
9. Ask the source task for replacement locations if a temporary file or tab has disappeared.
10. If required tokens, permissions, or browser authentication are missing or invalid after these checks, ask the operator to restore that access locally.
11. Keep dependent live checks blocked while access is missing; never substitute fictional responses or another athlete account.

The source task released the bot after its real poller in session `14060` stopped cleanly. This task then ran fictional launcher session `63022`, verified `/version`, mixed-batch cancel and confirm, and language preference persistence. That launcher exited with code 0, no live owned child, and removed scratch storage. Its own Chrome tab was closed. Ownership was explicitly returned to the source task. It confirmed the normal runtime restored through `/tmp/npm-real-qa/launch.mjs --resume` in its owned session `23913`, with Telegram startup ready. A later source-task check recorded replacement real-runtime session `62907` using the same launcher. The chart-review maintenance reused its existing Web A tab `1035870768` for read-only commands and did not replace or stop that runtime. Recheck the linked task for current ownership before starting another poller. See [retained Telegram evidence](maintenance/telegram-extension/README.md).

The private `operatorAuthorized` flag records configuration state. Read the actual operator instructions to establish the permitted work. This note does not expand permission to real-calendar writes, paid model usage, unrelated chats, or unrelated processes.

## Live workout scenarios

Run affected scenarios through ordinary Telegram messages with the real model. When asked for workout batch verification without a narrower scope, cover this table. Read the real calendar independently before the request, before approval, and after the result.

| Scenario | Required result |
|---|---|
| Add one workout | Review one workout; approve once; verify one exact addition. |
| Add several workouts | Review every addition; approve the whole set once; verify every saved workout. |
| Edit one or several workouts | Review changed values; approve once; verify intended fields and unchanged unrelated fields. |
| Rename or reschedule | Verify only the requested fields change, including unchanged duration and steps. |
| Delete one or several workouts | Identify every removal; approve once; verify only the marked targets were removed. |
| Mixed add, edit, and delete | Review the complete set; approve once; verify each effect and retained unrelated entries. |
| Revise pending work | Revise selected items; verify untouched items stay identical and previous approval is inactive. |
| Cancel | Cancel the pending set; verify zero calendar writes. |
| Repeat or stale approval | Verify no duplicate effects. If a marked target changed externally, apply nothing and require a refreshed review. |

Use coach-created test workouts dated today or later. Preserve protection of past and unowned workouts. Completion detection is excluded by the accepted batch contract (B12–B13): missing activity pairing does not prove incompleteness, and present pairing does not add a prohibition. Already applied proposal changes must not be revised or replayed. Exercise unsupported fault injection through its existing executor and report that limit separately. Never represent a service test as live Telegram proof.

Use the existing real-calendar guard and its allowed test marker. The current campaign uses `QA-BATCH-0920`; inspect the guard before choosing dates or names. Mutate only the test workouts owned by this campaign. Keep raw athlete identifiers out of retained evidence. Keep current dates necessary for live actions out of reusable fictional fixtures.

Read the usage ledger before and after real-model requests. Keep cumulative campaign spend within the approved $2 budget. Ask the human if the remaining budget cannot be established or further work would exceed it.

Read [chart-card checks](future-review-prototype.md) when presentation is in scope. The standalone preview sender does not prove the production renderer. Record unimplemented cards as blocked instead of sending prototype images to manufacture a pass.

## Select the correct runner

The default route uses the existing real runtime, whose recorded launcher is `/tmp/npm-real-qa/launch.mjs --resume`. Inspect that file and current ownership before use; temporary paths may disappear. Confirm the configured provider, model, calendar account, and write guard. Do not execute this launcher alongside an active poller.

Use the parent skill's [existing-development-bot route](../SKILL.md#launch) for fictional model/calendar verification. Set the existing credential-file path for that process:

```sh
NPM_VERIFY_TELEGRAM_CONFIG=/tmp/npm-telegram-authorized-test.json node /Users/yerzhansagyt/projects/cycling-coach/.agents/skills/verify-npm-coach/scripts/telegram.mjs --repo=/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval --authorized-existing-dev-bot --doctor-only
```

The latest doctor passed after the source task rebuilt the package. It checked the configured bot identity and empty webhook queue before the live run. A previous stale-build failure is resolved; run doctor again for the checkout you intend to verify.

The real-session metadata points to a separate setup with a real model and real calendar. Do not use its launcher as the fictional fixture runner. A successful doctor does not release a browser tab or prove that another poller has stopped.

Follow the parent skill for launch, browser driving, evidence, and cleanup. Keep bot tokens, operator IDs, browser authentication data, and credential-file contents out of Markdown and retained evidence.
