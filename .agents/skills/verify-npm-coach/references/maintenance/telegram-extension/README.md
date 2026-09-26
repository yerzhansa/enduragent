# Live Telegram verification extension

Status: partial live coverage; full maintenance remains **blocked**.

On 2026-09-21, the existing authorized development bot and signed-in Chrome profile were used after an explicit poller handoff from the source task. `TELEGRAM_BOT_TOKEN` came from the project `.env` through the private derived runner configuration. No credential values were copied into this record. The application used fictional model responses and calendar storage; no real calendar writes or paid model requests were performed by this fixture.

## Observed actions and results

| Action through Telegram Web | Observed result | Independent proof |
|---|---|---|
| Send `/version` | Fresh reply: `Cycling Coach v2026.5.9` | Authenticated UI and owned ready launcher |
| Request `Prepare my mixed set of four workout changes.` | Review showed two additions, one edit, one deletion, 155 minutes, readable repeated steps, and the existing 45-minute ride | [Calendar before approval](calendar-before-confirm.json) has zero writes |
| Click the new review's Cancel button | `The remaining changes were canceled.` | Calendar still had zero writes |
| Request the same mixed batch again; click its Confirm button once | Four completed rows and `All reviewed changes are complete.` | [Final calendar](calendar.json) records exactly POST, POST, PUT, DELETE; event 101 is 75 minutes, event 102 is absent, and unrelated event 103 equals the baseline |
| Send `/language`; choose Español | UI disclosed that the environment forces English and saved choices are inactive | [Saved Spanish preference](language-spanish.json) contains `language: es` |
| Choose Automatic | The forced-English disclosure remains | [Automatic preference](language-automatic.json) has no language property |

The UI observations above came from the target bot's fresh messages through `cua_repl`. No whole-browser screenshot or unrelated chat history was retained. These are coordinator observations, not an automated browser assertion suite.

## Artifact identity and cleanup

The source task committed its staged wording changes while this run was active. The launch context was `5cd3a43f1165f9dafd81f9052f922c185e071610` with the rebuilt estimated-training-load wording. At cleanup, HEAD was `4c0a13e6cdb9137aa8a5b1fc9c0e529b604037fa` and the checkout was clean. The actual tested binary SHA-256 is `c959492c2c7dfdd505fe95197ac11f63f417e98ba98363cec55f785bf03cbb41`. This does not refresh the entire source inventory to the newer revision.

The launcher's [result](result.json) deliberately says `NOT RUN`: startup alone is not feature proof. The action/result table above supplies the separate live evidence. [Runtime output](runtime.txt) is sanitized. Session `63022` exited code 0 after Ctrl+C; cleanup recorded no live owned child, removed scratch storage, and zero opened listeners. Verification tab `1035870752` was closed. The source task's original tab was left alone. Bot ownership was returned, and the source task confirmed its normal runtime restored in owned session `23913`. Recheck current ownership in the linked tasks in [the access guide](../../telegram-access.md).

## Remaining work

This run does not prove effective translated replies because the fixture forces English. It does not prove first pairing, sender administration, Telegram recovery across restarts, all 51 approval criteria through Telegram, arbitrary coaching judgment, or every feature in the 175-ID inventory. The coaching fixture extension provides separate built-terminal evidence. Source coverage, component tests, terminal runs, and Telegram runs remain distinct.
