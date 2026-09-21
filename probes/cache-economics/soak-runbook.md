# Cache-economics soak runbook

Operator runbook for measuring the real cache economics of the desktop-branch
build on your own bot over at least one week, then landing a report with the
band verdict. The executor ships the tooling; running the soak and filling in
the report is your work, after the cache-split and role-routing changes have
merged to `desktop`.

## 1. Purpose

Measure the real cache economics of the desktop-branch build on your own bot
over at least one week (the soak). The acceptance band is:

- **>= 60% of chat-role input tokens billed at cache-read pricing**, scoped to
  breakpoint-capable routes (direct Anthropic, and OpenRouter `qwen/`-prefixed
  models), AND
- **projected steady-state <= $0.25/day** on your real usage.

Falling below either bound **reprices the product cost story — it is a report
verdict, not a rollback** of the cache work. The often-quoted $0.08/day figure
is a best-case bound (it assumes ~100% of input is priced at cache-read rates);
realistic steady state is plausibly 2–4x that. This soak measures the real
number, so the report never quotes the best-case figure as if it were measured.

## 2. Preconditions (mechanical)

Run these on `desktop` before starting:

1. The two-block cache split has landed:
   `grep -r "PROMPT_LINEAGE_SCHEMA_VERSION" packages/core/src` returns matches.
2. Role-based model routing has landed: after a day of soaking,
   `pnpm usage:baseline --kind generate --caller compact` shows a
   background-class (Haiku-class) model, not the chat model.
3. `pnpm check` is green on `desktop`.

## 3. Bot-token decision (RECORD THE CHOICE — it goes in the report)

Running two long-pollers against one Telegram bot token starts an
update-stealing conflict war, and the hosted deployment drops pending updates
on restart. Before starting the soak, choose exactly one:

- **Option A** — stop or pause the hosted deployment's poller for the whole
  soak week and run the local desktop build with the production bot token.
- **Option B** — create a **dedicated dogfood bot token** via BotFather and run
  the local desktop build with that token, leaving the hosted bot untouched.

Never run both pollers on one token. Record which option you chose and why — it
is a required field in the report.

## 4. Soak steps

1. Record the soak-start instant: `date -u +%Y-%m-%dT%H:%M:%SZ`.
2. From the `desktop` branch, run the bot the way you normally run it locally
   (`pnpm dev` with your real `.env`), on a **breakpoint-capable chat route** —
   a direct Anthropic key, or OpenRouter with a `qwen/`-prefixed model. The
   stock OpenRouter default model is not `qwen/`-prefixed, so pin a `qwen/`
   model explicitly. The ratio bound is only measurable on those routes;
   soaking on a non-breakpoint-capable route yields zero eligible lines and an
   UNDETERMINED verdict.
3. Use your existing athlete home (a fresh empty home skews cache behavior). If
   you set `CYCLING_COACH_HOME`, use the same value later for the analysis.
4. Chat normally — at least one real turn most days, across separate sittings
   (across-sitting cold turns are part of the honest number).
5. Keep this going for at least 7 days.
6. Do NOT run any ledger-seeding tool against this home during the soak.
   Synthetic back-to-back turns hit a warm provider cache and inflate the ratio.

## 5. Analysis

Run:

```
pnpm usage:cache-band --since <soak-start-instant>
```

Add `--data-dir <dir>` if your data dir is non-default. If the verdict is
UNDETERMINED for `unpriced-token-share-exceeds-threshold`, add a price override
using the provider's current per-million USD prices:

```
pnpm usage:cache-band --since <soak-start-instant> --price "openrouter:<model>=<input>/<output>/<cacheRead>/<cacheWrite>"
```

The tool reads the rotated `usage-ledger.jsonl.1` automatically (a week-long
soak can rotate). Exit codes: `0` PASS / `2` REPRICE / `3` UNDETERMINED / `1`
operational error.

## 6. Report

Copy `report-template.md` to `report-YYYY-MM-DD.md` in this directory, fill
every field, and paste the tool's `--json` output block.

**Privacy rule (binding):** the committed report carries aggregates and the
verdict ONLY — never raw ledger lines, message content, chat excerpts, or file
paths from your machine beyond the data-dir source label. Land the filled-in
report as its own one-file PR to `desktop`.

## 7. Reading the verdict

- **PASS** — the cost story holds as shipped.
- **REPRICE** — keep the cache work; rewrite the product cost story to the
  measured number.
- **UNDETERMINED** — fix the stated reason (soak longer, supply `--price`, or
  investigate a token-semantics violation) and re-run. Do not publish a verdict
  from an UNDETERMINED run.
