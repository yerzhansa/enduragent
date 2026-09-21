# Failure, retry, and restart

Source inspected at `3d6ecf78`.

## Sub-features

Inventory mapping for this page follows. Existing acceptance IDs remain authoritative.

| Inventory ID | Capability |
|---|---|
| W27 | Report partial success |
| W28 | Retry only remaining work |
| W29 | Refresh stale remaining work |
| W30 | Recover a pending review after restart |
| W31 | Recover partial execution after restart |
| W32 | Resolve uncertain writes conservatively |
| W33 | Distinguish observed state from confirmed action |
| W34 | Preserve completed and canceled outcomes |

Refer to acceptance D01–D12.

| Acceptance IDs | Existing scenario or test entry |
|---|---|
| D01–D04 | Terminal `retry`; service test `retries only remaining work and retains successful receipts across restart` |
| D05–D06 | Service test `revalidates remaining work after partial failure` |
| D07 | Terminal `mixed --restart`; service test `restores a pending token after restart and blocks a second writer` |
| D08 | `retries only remaining work and retains successful receipts across restart` |
| D09 | `recovers the durable pre-write image after remote acceptance without repeating creation`; `flushes attempt before dispatch and receipt before the next request` |
| D10–D11 | `never replays an uncertain creation`, `does not turn absent delete into an acknowledged success`, and `recovers a lost update response by observing its exact desired state` |
| D12 | `retains the completed outcome on restart without reusing its old approval` |

Production entry points are `packages/core/src/workout-change-sets/service.ts`, `record.ts`, and `store.ts`. Terminal startup presents durable pending work at `packages/core/src/run-binary.ts:688`; Telegram redisplay is routed by the `resend` text branch in `packages/core/src/channels/telegram.ts:1175`.

## How to get to it (user POV)

Approve a reviewed set in terminal or isolated Telegram. After a confirmed partial failure, inspect successes and remaining work, then use terminal `retry` or Telegram **Retry remaining**. Following restart, read the restored terminal review or send `resend` to the isolated Telegram bot. Do not use the legacy Plan controls as workout approval.

## Driving it with npm-coach verification

```bash
cd /Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval
pnpm exec vitest run packages/core/tests/workout-change-sets.test.ts packages/core/tests/workout-change-set-protection.test.ts packages/core/tests/workout-approval-channel.test.ts packages/core/tests/telegram-dispatch.test.ts
node /Users/yerzhansagyt/projects/cycling-coach/.agents/skills/verify-npm-coach/scripts/terminal.mjs --repo=/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval --scenario=retry
node /Users/yerzhansagyt/projects/cycling-coach/.agents/skills/verify-npm-coach/scripts/terminal.mjs --repo=/Users/yerzhansagyt/projects/cycling-coach/.worktrees/npm-workout-batch-approval --scenario=mixed --restart
```

The existing terminal retry fixture rejects the third mutation after two successes. Retain the first result and retry input, and independently inspect final calendar writes to prove the two successful creations were not replayed. The restart option stops and relaunches only the runner-owned process while retaining its isolated store, then approves the restored review. It covers pending-review restart; it does not by itself cover every crash window or uncertain response.

The service tests own durable pre-write image restoration, lost responses, unreadable outcomes, receipt ordering, stale retry, and completed-token restart. Preserve these tests; do not replace them with an ordinary successful UI retry. For Telegram UI on macOS, require exclusive ownership of the disposable bot poller, a dedicated test account/browser, and synthetic calendar fault controls before starting. Record the actual error/retry controls and independently read resulting calendar state. Unsupported fault injection is `BLOCKED` for that channel.

Retain the run’s `result.json`, `transcript.txt`, and `calendar.json` under the unique evidence directory described in the [index](README.md). Record this feature’s criterion IDs alongside the results; do not infer a pass for unmapped or undriven cases.

## Gotchas

The Telegram launcher has no restart-preserving mode and deletes scratch on exit. Ctrl+C followed by a new launcher is not restart recovery proof. Keep terminal mixed --restart and service crash-window tests as separate evidence; This limitation belongs to the fixture launcher. The separately owned guarded real runtime has an authorized `--resume` route and retained pending-review restart evidence; inspect its owner and state before use.

Verify durable resend, targeted revision of remaining work, previous-control rejection, and observed-state versus confirmed-write copy with the existing service tests. The terminal retry scenario requires exactly POST, POST, PUT, DELETE after its injected rejection, without replayed creations.

Never restart or kill a shared developer bot without explicit lifecycle ownership for that run. Stop only recorded runner-owned PIDs; keep the isolated data directory until the intended restart step finishes, then run cleanup. A partial result after execution starts differs from zero writes during preflight. Observed desired state after lost acknowledgement is not a confirmed receipt. An uncertain result must not be treated as permission to create again. Retain sanitized evidence before deleting scratch state, and verify no owned process or listener survives.

### Cold-cache resend coverage

Include `packages/core/tests/telegram-dispatch.test.ts:1042` for D07. It covers pending controls and text-only durable outcomes after the in-memory reply cache is absent. Adjacent tests at lines 1092 and 1111 cover genuinely missing content and delivery failures.

On an authorized Telegram restart run, send `resend` and require the saved review or durable outcome, including chart titles, steps and current batch positions when present. Reject a response that both restores content and says there is nothing to resend. For failed delivery, require the delivery error and no enabled approval. Terminal `mixed --restart` does not replace these Telegram delivery observations.
