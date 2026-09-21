# Coaching fixture extension

Status: **blocked** for a complete live maintenance pass. The three new local coaching fixtures pass. Actual Telegram access and wider platform scenarios remain unavailable.

## What changed

The sibling `coaching-terminal.mjs` runner supports `memory`, `data`, and `planning`. Its provider overlay imports the original workout fixture, then serves exact coaching tool sequences and fictional athlete data. The original terminal runner, Telegram launcher, doctor, and workout fixture remain unchanged. Product source and tests were not modified.

The conversation-case table stores user requests and tool calls. The provider selects those real production tools and echoes their actual results. Assertions compare returned values with independent expected values and saved files. Unknown requests and unavailable tools fail rather than returning a made-up successful answer. All external data is fictional, the date remains 1998-09-07, and all three scenarios require zero calendar writes.

This applies Model the Domain through the conversation-case table, and Prove It Works through built-app execution plus independent persisted-state checks.

## Executed proof

Source and built binary revision: `5cd3a43f1165f9dafd81f9052f922c185e071610`. Per-run results retain the binary hash and runtime. See [summary.json](summary.json).

| Run | Observed result | Evidence |
|---|---|---|
| Memory | Preference write and replacement, daily/general notes, ledger, inclusive date recall, non-injected memory read, and context/history after restart passed. | [Result](memory/result.json), [transcript](memory/transcript.txt), [tool results](memory/coaching-trace.json) |
| Athlete data | Profile/wellness, activity listing, detail/laps, computed stream statistics, and numeric repeat read passed. Calendar writes stayed empty. | [Result](data/result.json), [transcript](data/transcript.txt), [tool results](data/coaching-trace.json) |
| Planning | Six zone rows, feasibility, available-day sample week, 12-week draft, decline without saving, approval with full object preservation, and identical plan reload after restart passed. | [Result](planning/result.json), [transcript](planning/transcript.txt), [tool results](planning/coaching-trace.json) |
| Existing mixed workout | Original runner still passed reviewed writes and retained-workout checks. | [Result](existing-mixed/result.json) |
| Corrupted power data | Deliberately replacing watt samples with zero made the actual data assertion fail on min/max/mean. This is expected negative proof. | [Result](negative-data/result.json) |

The first memory attempt failed because the fixture asked for `memory_read` when all stored sections were already injected into context. Source confirmed the tool is intentionally omitted in that state. The corrected scenario saves a general note that is not injected before requesting `memory_read`. Its subsequent full run passed. The [initial failure](initial-memory-failure/result.json) remains retained.

Every attempted runner reports an empty live-child list, removed scratch home, and zero listeners opened. Evidence remains in this directory. No owned Telegram child, browser tab, or browser profile was created. The sender command was stopped by the host hook before execution.

The source delta since the previous map is confined to the workout edit-description preview, its tests, and a changeset. The new source clears stale structured steps when description changes. Its 71 focused tests passed. The earlier description-preview discrepancy is historical; new real-provider proof remains separate.

The repository privacy check passed 4,079 source files and 21 golden fixtures. A separate scan of ignored scripts and retained fictional evidence found no athlete-ID or credential patterns. Local links and JavaScript syntax validation passed. The feature-map consistency check and skill-format validator are rerun against the installed artifact.

## Remaining boundaries

These are partial live terminal checks. A scripted tool sequence does not prove model interpretation, medical/scientific judgment, all knowledge topics, all input combinations, grouped-session reasoning, numeric review table formatting, or genuine remote provider behavior. The Telegram launcher does not yet load these coaching scenarios.

Live Telegram access needs the path to a private mode-600 dedicated bot configuration, a signed-in isolated browser profile, and confirmed exclusive ownership of its poller. Permission alone does not supply those resources. Do not use a normal athlete calendar or shared bot as a substitute.

The operator approved the optional sender check and removal of its exact temporary fixture. The local PreToolUse safety hook nevertheless rejected the recursive cleanup expression again. No command ran, no sender fixture was created, and no bypass was attempted. That check remains blocked by host enforcement, not missing operator approval.

## Run again

Use the commands in the three feature pages and the parent skill. Retain transcripts, input fixtures, actual tool-result traces, calendar writes, and saved memory/plan files. Keep full live maintenance marked blocked until the outstanding routes have their own evidence.
