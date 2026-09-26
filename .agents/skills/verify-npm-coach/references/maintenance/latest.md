# Latest npm coach verification maintenance

Status: **blocked**. Map corrections and most of the fictional Telegram drive are recorded. Setup, one language control, and fault injection did not finish.

Inspected product revision `3d6ecf7833a57248a90002039b9f799ff6cfc018` on macOS with Node 24. Product source and tests were not changed.

## Source coverage

Seventeen feature pages match the index. The coverage check reports 175 inventory entries, 12 Telegram commands, 43 metric keys, and 51 approval criteria. `sourceReviewRequired` is false for this revision.

## Verified corrections

- Setup offers a fixed language. Automatic is a Telegram `/language` choice.
- A strength addition takes a name, a duration in minutes, an effort line, and a free-text description.
- A base URL is asked only when the chosen provider declares a default endpoint.
- After a save, an unverified reply and a missed workout review are different notices. The error and review pages name both.
- The workout fixture answers the reply check with `no_preparation_required`, so a finished coaching reply is not replaced by the unverified notice. Incomplete, memory, data, and planning were re-driven after that correction and passed.

## Executed coverage

Doctor reported `DOCTOR: ready to drive built npm fixture`. Built terminal scenarios single, mixed, revision, cancel, long, stale, retry, incomplete, and mixed with restart passed. Coaching memory, data, and planning passed. The workout-preparation host file passed 44 tests. A private home added fictional sender `12345`, listed it, removed it, and was deleted. Each terminal and coaching result has empty `cleanup.livePids`, `scratchRemoved: true`, and `listenersOpened: 0`.

`pnpm check:fixture-privacy` reported 4089 source files and 21 golden fixtures clean. Temporary evidence was inspected separately. The sender file contains only the fictional id `12345` and the time of that command.

The fictional Telegram launcher used the authorized dev bot, scenario `single`, and fictional date `1998-09-07`. One poller only. UI actions were driven in Telegram for macOS. The launcher's own result file stays `NOT RUN` because startup is not the feature proof; the observations below are.

- `/version` replied `Cycling Coach v2026.5.9` before and after `/update`. The built package declares `2026.9.17`. Version delivery passed. Version correctness is FAIL.
- `Prepare one easy ride.` without `/start` produced the welcome, then one add for `1998-09-08`. Bare `resend` repeated that review. Cancel replied that the remaining changes were canceled. Fictional calendar events stayed at 3 and writes stayed at 0.
- `/language` disclosed that `ENDURAGENT_LANGUAGE` forces English. Choosing Español wrote owned `language.json` with `"language":"es"`. The Automatic control did not clear that property.
- `/sync` reported already up to date at `1998-09-07 12:33 UTC`.
- `/snapshot` returned the raw-only help. `/snapshot raw metadata` matched the owned `data/latest.json` metadata: schema version `4`, `last_updated` `1998-09-07T12:00:00.040Z`, freshness `fresh`.
- `/whatsnew` could not reach npm. Empty `/feedback` returned usage text and did not submit. `/update` could not check for updates and did not install.

Launcher cleanup reported an empty `livePids`, `scratchRemoved: true`, and `listenersOpened: 0`. Evidence was retained. Scratch was removed.

## Blocked

- Interactive setup reached the DeepSeek model list in an owned PTY and wrote no config. The collapsed model row did not reveal Other, so the base-URL cancellation was not completed.
- The Automatic language control did not register. Delivery-fault injection and a live provider outage still have no runner scenario.
- Terminal `/quit` settles the coach and does not clear the run breadcrumb. Only the Telegram signal path does. A later terminal launch can warn that the previous run was unclean. This is a product gap.
- Listing calendar events asks intervals.icu for workouts and A/B/C races, while the tool text says workouts only. This is a product gap.
