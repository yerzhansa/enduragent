# @enduragent/coach

## 0.2.0

### Minor Changes

- 71a5e7d: User-facing: When you first open a ride in Activity review, the coach writes a short verdict on it with one reply on your own model; if that fails, the ride says so and spends nothing more until you press Write again. You can leave the coach a note on the ride that it reads when you write again, and Ask the coach, here and on a Calendar workout, now adds its question after whatever you have already typed in Chat.

  The `plan.calendar` RPC gains `read-review`, `write-verdict` (with an `expected` state and reply count, refusing with `review-changed` when they moved on) and `save-note`; `decide-ride` also starts the verdict when the athlete answers the match, and a verdict that cannot start never fails the saved match. The verdict moves only through the engine's `coachTextStep`, which now records whether a failure came from the model or from an interrupted write and writes again on open only after an interrupted one. It runs in the background on the athlete's chat model under the new `coach-text` caller, asks for low reasoning effort with a 600-token cap only where the provider honours it (OpenAI reasoning models, codex-agent; Anthropic keeps thinking off at 600) and otherwise keeps the provider's default effort with a 2,000-token cap, aborts before its lease runs out, never abandons a write whose job is still running, and is stored with the note, the failure's cause and the last kept verdict in the new `activity_review` table (migration 037). The engine exports the writer from `@enduragent/engine/coach-text-writer`. `createWorkoutCardController` drops `composerEmpty` and prefills through `requestComposerPrefill`, like Activity review's Ask.

- df8343a: User-facing: A new Activity review page, below Calendar, lists your rides by Training Week and shows each ride's facts. When the app asks "Is this the Plan Workout?", answer yes, no, or another day's workout, and the Calendar shows your answer.

  The `plan.calendar` RPC gains `rides`, which runs the match refresher over the active Plan's part of the range and lists cycling rides with a ride-centric Plan Workout match and the Plan's Training Weeks, and `decide-ride`, which confirms a suggestion, turns it down as Extra, or matches the ride to another nearby workout, and refuses with `match-changed` when the match differs from the `expected` one the page showed. The Plan Workout match repository now lets the athlete take back a confirmed heuristic match and confirm a pairing turned down earlier, and never stores a second confirmed match, or a new suggestion, for a workout or ride that already has a confirmed one; `observe` returns null when it stores nothing and leaves an unchanged suggestion as it was. Confirming a match deletes the other suggestions for that workout and that ride, and the new `withdraw` deletes a suggestion or an intervals.icu pairing the system derived, never the athlete's own answers, so both come back when the evidence returns. The match refresher stores no length for a zero-length ride, withdraws an intervals.icu pairing the ride no longer carries, and the Plan page projection prefers a confirmed match over a suggestion. Turning down or moving a ride's match records its current intervals.icu pairing as unpaired, so the pairing does not come back. Matching a ride again to a workout whose intervals.icu pairing the athlete turned down clears that unpaired row (`clearUnpaired`) and stores the athlete's own match.

- 09a5e23: User-facing: A new Plan now waits for your Approve before anything reaches intervals.icu. The Calendar shows this Training Week and next as one set to approve, and Settings can make each later week wait for its own Approve. You can also turn on starting Enduragent at login so later weeks go out on time.

  Activation writes "waiting for Approve" in the same transaction. While the first Approve waits, later weeks show the day they will go out. The renderer gains a Start at login bridge over two trusted IPC channels, reusing the tray's durable login-item path.

- 0bcd503: User-facing: When you edit, move or delete a Plan workout in intervals.icu, the Calendar now marks it and asks what you want. Keep makes the Plan follow your change; Put back restores the Plan's version on intervals.icu. Nothing is changed until you choose.

  The `plan.calendar` RPC gains change-detail, keep-change and put-back. Each reads the event back from intervals.icu before it acts, and a newer edit is shown first instead of being overwritten. Keep on an edit or move applies a Plan Change that keeps the physical workout id.

- 95d3c9a: User-facing: You can drag a workout to another day on the Calendar. The app asks first, offers to swap with a workout already on that day, and moves it on intervals.icu too. The card then reads "Moved by you".

  The `plan.calendar` RPC gains `move-workout`. It applies one Plan Change with a `move-by-you` intent, which keeps physical workout ids, and marks the intervals.icu copies as moving so the next run updates the same events. Calendar workouts gain `movable` and `movedByYou`.

- d984b4f: User-facing: A new Calendar page shows your Plan one Training Week per row, with each workout's result: done as planned, done differently, missed, or waiting for you to confirm a ride. Each week shows whether it is on intervals.icu yet, and rows start on your region's first day of the week. Without a Plan, it lists your Activities by date.

  The `plan.calendar` call gains a `read` action that returns a date range of the active Plan's workouts, outcomes, copy states and Training Week status, plus the athlete's Activities. The desktop passes the region's first day of the week to the renderer from `app.getLocaleCountryCode()`.

- 2efcf2b: User-facing: The Calendar has a Plan details panel with your Plan's dates, progress and history, and with Replace Plan and End Plan. Ending a Plan keeps today's workout and any workout you changed in intervals.icu, unless you choose to remove those too.

  The `plan.calendar` RPC gains `plan-details` (history from applied Plan Changes, plus what End would remove, keep for today, and leave as the athlete's own) and `save-end-choice`, which stores the athlete's ticks for the cleanup run before the existing `plan.close`.

- 7cba733: User-facing: Replacing your Plan no longer changes intervals.icu until you approve, so Not now leaves your old Plan there. The Approve sheet lists the old Plan's workouts that come off from tomorrow on, and the new Plan's first two Training Weeks go on only after those are gone.

  Replace activation records a cleanup hold (migration 036, `plan_cleanup_hold`) instead of a cleanup job. The new Plan's first `approve-weeks` releases it in the same transaction through the engine's `athlete-approves-replacement` step, and can carry the athlete's ticked changes as the old Plan's close choice. Ending or completing the waiting Plan releases its holds, and the drain releases any hold whose replacement no longer waits. The `plan.calendar` read gains `replacing`.

- 3436f66: User-facing: Your Plan now keeps this Training Week and next on intervals.icu, sending each new week 7 days before it starts. Changes you make to a Plan workout in intervals.icu are kept instead of being put back by the app.

  The desktop calendar mirror sends whole Training Weeks and keeps intervals.icu's own read-back of each workout as its baseline. It writes only after re-reading the event and finding it unchanged, and never sends a write that changes nothing. End and Replace remove the old Plan's own workouts from tomorrow on, and leave today's workout and the ones the athlete changed. A new `plan.calendar` call approves weeks and saves the "Approve each week" setting.

- 75e77dd: User-facing: Click a workout on the Calendar to open its card, where you can see whether it is on intervals.icu, move it to another day, ask the coach to change it, or export that day's workouts. A new Plan now starts on the first day of your week by default, or today when your event comes sooner, and you can still pick another day.

  Workout cards in the grid are buttons that open the card over the grid; a workout changed in intervals.icu still opens its change sheet. Only one Calendar sheet is open at a time. Move… opens the existing move dialog, which gains Earlier day and Later day buttons that step over days the workout cannot move to and keep focus at the ends. Ask the coach saves a draft naming the workout and day into an empty composer and opens Change in Chat; nothing is sent. Export reuses the workout archive export for that day.

  The start-timing question offers `first-day-of-week` (answered as `earliest` with the next first day of the computer's region week, computed in the renderer) and `earliest` ("Pick another day"), and gains an optional `latestAllowed`, the event date, which the coach enforces. A picked day is now the Plan's start; the draft builder moves it only by whole weeks, past weeks with no day to train or a picked day that has already passed, and the answer summary states that start. Stored `as-soon-as-possible` answers and stored questions keep their old meaning. The cycling creation builder version is now 2.

- 1949824: User-facing: Enduragent now uses one FTP, the one in intervals.icu, shows each ride's FTP and FTP history on Activity review, and writes a coach's proposed FTP to intervals.icu only after you confirm. Chat's Change one thing no longer offers Correct FTP, past FTP changes stay in Plan history, and Plan details no longer shows old FTP guidance.
- 9f32ae9: User-facing: In Settings › Spending you can now choose what happens when today's spend reaches your daily cap. Warn keeps the coach answering as before; Stop makes the coach skip new messages until tomorrow or until you raise the cap, and a message you send in the app meanwhile waits and goes out then.

  The daily cap file moves to version 2 with a `mode` of `warn` or `enforce`; a version 1 file reads as `warn` with its amount unchanged, and a version 2 file round-trips instead of falling back to the $0.50 default. The coach engine adapter checks the cap before each of its six turn-running methods and, when the cap is enforced and reached, returns a `spend-cap-reached` refusal without calling the model. An unknown status never refuses. Protocol version 40 adds `capMode` to the spend summary, an optional `mode` to `setDailySpendCap`, and an optional `refusal` to chat, queue and decision results.

- f15d20d: User-facing: You can now send a trace of each coach turn to a tracing tool you run yourself, such as Jaeger, to see how long the model and each tool took and what each turn cost. It is off unless you turn it on with two settings described in the privacy guide, and it never sends your messages, the coach's replies or your training data.

  When the coach process starts with `ENDURAGENT_OTEL=1` and `OTEL_EXPORTER_OTLP_ENDPOINT` set, `withLocalCoach` starts an OpenTelemetry trace provider (service `enduragent-coach`) with a batch processor and an OTLP/HTTP exporter to `<endpoint>/v1/traces`, and flushes it after the coach shuts down. The SDK and exporter load by dynamic import only then; with either variable missing nothing loads and nothing is sent. An unusable endpoint prints a warning and keeps tracing off. Exports give up after 2 seconds, so a collector that is down loses that batch with a warning and never fails or holds up a turn or an exit. The README and the privacy guide name the exporter as an outbound request.

- 9ef4f21: User-facing: Every training workout in a new Chat Plan now has real steps, a zone, an estimated load and a line on why it is there, and its Calendar card shows them, with watts from your FTP in intervals.icu or as % of FTP until one is set.

  The creation builder moves to version 3 and stores typed `content` (steps as % of FTP, zone, load, why) on each non-event Draft workout. Plan Changes recompute it. Keeping an intervals.icu edit that changes a workout's length removes it, because the athlete's version is the truth. Undo restores it as it was, and Plans built before it keep no content until a change touches a workout. The `plan.calendar` read gains each workout's `content` and the current outdoor `ftp`, and the Draft card model gains `ftpWatts`. intervals.icu receives exactly what it did before; nothing new is sent.

- b476f6d: User-facing: intervals.icu now shows each Plan workout's steps and load when it has your FTP, so your head unit gets watts for every step. Without an FTP in intervals.icu, workouts go there as before, with no steps.

  The Chat calendar mirror writes each workout's description at send time from its stored `content`, as step lines in % of FTP, and only while the one FTP is known. A "Warmup" line heads a warm-up step and a "Cooldown" line a cool-down step; both are intervals.icu syntax and stay in English in every locale, like "3x". The text is part of the send fingerprint, so an FTP appearing or being removed rewrites the workouts in the two-week window once. Athlete edits are still never overwritten, and a past workout keeps what intervals.icu has. A workout matched to a ride keeps its text there when only the text would change. A coach change to its day, name, sport or length still goes out, with the current text. When the steps are removed, intervals.icu keeps the load and intensity it computed from them. Rows without `content` keep any stored description unchanged.

### Patch Changes

- cf69384: User-facing: When intervals.icu stops accepting your sign-in, your Plan no longer says "Updating calendar" while nothing is being sent; it asks you to connect instead. After you sign in again, your planned workouts go to your intervals.icu calendar right away, without waiting for you to open Plan or for the next sync.

  The Plan calendar status and the plan-creation calendar line now treat a rejected intervals.icu sign-in as not connected, using the same check as the plan calendar drain. The 24-hour stale-sync pause on Plan Changes and the Supporting Event candidates still count any saved sign-in, so a rejected one neither lifts the pause nor hides synced races. Every store window, including the refresh after a new sign-in, now kicks the calendar drain when it finishes.

- 6b2d249: User-facing: Stop now ends a reply at once even if you changed the coach in Settings while it was streaming. Changing the coach or deleting the AI key in use during a reply now fails right away with a "try again" message, instead of hanging or sending you to the Setup screen.

  A runtime change (`configureRuntime`) that arrives while a chat turn runs now returns the refusal `busy-replying` before it puts the barrier up, so Stop, the runtime config read and the transcript reads are not queued behind a drain that waits for the whole reply. A catalog pin moves into the replacement's prepare step, so a refused change does not pin the new catalog. The startup refresh still waits for running turns. On a key delete, the desktop maps `busy-replying` to a `runtime-unavailable` refusal and leaves the key and its runtime state as they were.

  The coach protocol version goes to 38, because the new `busy-replying` refusal reason is a wire change.

- 4383fe4: User-facing: Disconnecting Intervals.icu while a sync is running now stops the sync and disconnects right away. Before, Disconnect could wait 30 seconds, fail with "could not be reconciled", lock Settings and leave the sign-in in place.

  The coach's configureRuntime aborts the sync window that holds the store lane, and any window that starts while the clear waits, when it receives an intervals.icu clear_credential. The clear then applies inside the 25 s deadline and the vault revokes and removes the token. A sign-in replacement still waits for the sync.

- a88cdea: User-facing: When ChatGPT stops accepting your sign-in, Setup now says the sign-in expired and offers Sign in with ChatGPT, which opens the browser so you can sign in again. Before, Setup kept showing ChatGPT as Connected and gave you no way to sign in again.

  When the coach's refresh of the ChatGPT token is rejected twice, it marks the stored profile in `auth-profiles.json` as rejected, compared against the profile it refreshed so a newer sign-in is never marked. A successful refresh or a new browser sign-in clears the mark. Main's ChatGPT status reports a marked profile as `{ state: "configured", runtimeReady: false, reason: "sign-in-expired" }`. The renderer keeps it as an expired credential that cannot be activated, so Sign in starts a fresh browser sign-in, and Settings refreshes the sign-in status when it opens. The coach's OAuth token reader moves out of `composition.ts` into `oauth-access-token.ts`.

- eefa039: User-facing: Today's spend in Settings now includes AI requests that failed, timed out or were stopped, with the usage your provider reported before they ended. A request that ended before reporting any usage adds $0.00, so today's total can be a little lower than your provider's bill.

  Every model-call row in the usage ledger now carries the turn that made it (`turnId`), whether the call succeeded (`outcome: "ok" | "error"`) and, for a failed call, why (`errorClass`: a failure reason or `aborted`). A failed, timed-out or aborted call now writes its row with the known usage of the steps that finished before it ended. The spend meter counts a failed call with no usage figure as a known zero, so one failed call does not mark the day incomplete. Known usage is a lower bound: an HTTP error carries no usage figure, and the provider may still bill the step that was in flight.

- aac85bb: User-facing: If you quit the app while your first sync is still downloading your intervals.icu history, the app now finishes that download by itself the next time you open it. Your recent rides still show up right away, and the older ones fill in after. Before, your older rides stayed missing until you pressed Sync now.

  The coach's startup refresh publishes the usual 84-day snapshot first, as before. Then the coach reads the saved history-download state: not started, in progress at a saved cursor, or complete. Only a download in progress resumes, in a store window of its own that captures again when the download finishes. The store lane stays free during each intervals.icu request. A complete download is left alone. A download that never started is left to the first sync that runs when Setup finishes. Nothing resumes while intervals.icu rejects the sign-in. A failed resume is logged as `history_download_resume_failed` and changes neither the startup refresh nor the six-hour schedule. The next launch or Sync now picks the download up again from its cursor. Quitting the app stops the resumed download.

- 0c559cf: User-facing: If a new Intervals.icu sign-in is refused while your current one still works, Intervals.icu now stays connected. Before, the sidebar and Setup asked you to sign in again although sync kept working with your current sign-in.

  The coach's rejected-sign-in check in getRuntimeConfig now tests the applied intervals.icu credential when one is applied, and falls back to the offered credential only when none is. Before, it also tested the offered credential, which configureRuntime stores before the apply and keeps after a refusal. A replacement that intervals.icu answered with 401 during the account check, and that the coach then refused as ownership-unavailable, made the healthy credential in use read as rejected. A refused first sign-in, with nothing applied, still reads as rejected until it is replaced or removed.

- 5de1cb7: User-facing: When the old Plan's workouts cannot be removed from your intervals.icu calendar, the new Plan's workouts now wait even if you replace the Plan again, and the active Plan shows "Calendar sync failed. Retry available." (or "Connect to mirror Workouts" while intervals.icu is not connected) instead of "Up to date".
  User-facing: Retry calendar now stays available after repeated failures and removes the old Plan's workouts at once.

  The calendar drain and the Plan library read one barrier from `readCleanupBarrier`: the active Plan's mirror waits while any cleanup of another Plan is not verified, not only the newest one, and the active card shows that cleanup. A failed cleanup always offers Retry. Retry sends `retryCalendar` on the next `plan.list`, which reopens failed cleanups. Automatic cleanup retries keep the 15-minute wait after five failures, and mirror jobs keep their five-failure budget.

- 3cb16f8: User-facing: Changing your coach model in Settings no longer leaves chat summaries or memory saves stuck on a costlier model. Summaries stay on your provider's cheaper default when one exists, and follow your chosen model again after trying GPT-6 Astra.

  Tracks explicit summary (`compactModel`) and memory-save (`flushModel`) overrides separately from derived defaults (`provider-default`, `follow-chat`, `astra-fallback`) in `resolveRuntimeConfig`, persists explicit overrides, the provider's summary default as before, and `before_astra_model` while on GPT-6 Astra; it no longer persists a summary or memory model that only followed the chat model or the pre-Astra model, which is what made them stick. `config.yaml` names the explicit ones in `explicit_background_models`, written only when there is one. `loadConfigFromYaml` reads a file without that list, as older versions wrote it, by value: a `compact_model` equal to the provider's summary default or to the chat model is derived again (the provider's summary default where there is one, else the chat model), because older versions moved a `compact_model` equal to the chat model along with every model pick; a `flush_model` equal to the chat model follows the chat model; on GPT-6 Astra both are the model used before Astra; any other saved value stays explicit. `LLM_COMPACT_MODEL` and `LLM_FLUSH_MODEL` stay explicit.

- 7cb2cf2: User-facing: After your Mac wakes from sleep, your training data now starts refreshing within a minute if a scheduled sync was missed while it slept. Before, with the app window closed, it could stay out of date for up to six more hours.

  The six-hour store refresh now waits in steps of at most one minute and runs once the wall clock reaches the six-hour mark. Before, it waited on one timer for the whole gap. macOS does not count sleep time toward that timer, so a Mac that slept past the mark synced up to six hours late unless something else woke the coach. A wall clock set back a little no longer runs the refresh just before the mark and then again at it.

- 02c7694: The usage ledger's turn row (`kind: "turn"`) is now the sum of every chat-model call the turn made, failed and stopped attempts included, instead of the last successful call only. It is written on every exit that logs `turn_outcome`: a reply, a Coach decision, a failure after a write, a stop and a final failure. Each turn row carries `turnId`, `outcome` and, for a failed turn, `errorClass` (`aborted` for a stop, `budget` when the turn ran out of its budget). It sums known usage: a failed call with no usage figure is a known zero, so it keeps the turn's cost known, and a turn whose calls all failed that way records zero tokens and $0. A queue retry reuses the turn's ID, so the retry's turn row also adds the chat calls the earlier run left in the ledger; the latest turn row for a `turnId` is that turn's total. Compaction and memory-flush calls keep only their own rows. `pnpm usage:baseline` gains `--outcome ok|error|all`, defaulting to `ok` for every row kind, and keeps only the latest turn row for each `turnId`. Today's spend and season review read only per-call rows, so no figure an athlete sees changes.
- Updated dependencies [71a5e7d]
- Updated dependencies [df8343a]
- Updated dependencies [09a5e23]
- Updated dependencies [3adc44c]
- Updated dependencies [0bcd503]
- Updated dependencies [95d3c9a]
- Updated dependencies [d984b4f]
- Updated dependencies [2efcf2b]
- Updated dependencies [7cba733]
- Updated dependencies [3436f66]
- Updated dependencies [75e77dd]
- Updated dependencies [78c0c28]
- Updated dependencies [dbe61e3]
- Updated dependencies [6b2d249]
- Updated dependencies [a88cdea]
- Updated dependencies [eefa039]
- Updated dependencies [7d6ed8b]
- Updated dependencies [c5b2b5e]
- Updated dependencies [a4187b3]
- Updated dependencies [bba219f]
- Updated dependencies [a6e5783]
- Updated dependencies [1949824]
- Updated dependencies [5de1cb7]
- Updated dependencies [9912a8c]
- Updated dependencies [1ebd764]
- Updated dependencies [d928eff]
- Updated dependencies [9f32ae9]
- Updated dependencies [c9a1cc7]
- Updated dependencies [3cb16f8]
- Updated dependencies [0e2786b]
- Updated dependencies [02c7694]
- Updated dependencies [cb4af29]
- Updated dependencies [1799249]
- Updated dependencies [c12d9f1]
- Updated dependencies [9ef4f21]
- Updated dependencies [b476f6d]
  - @enduragent/coach-contract@0.3.0
  - @enduragent/kernel@0.2.0
  - @enduragent/engine@0.2.0
  - @enduragent/i18n@0.4.0
  - @enduragent/sport-cycling@0.1.0
  - @enduragent/core@0.3.0
  - @enduragent/sync-intervals-icu@0.1.5
  - @enduragent/coach-cli@0.1.9
  - @enduragent/kernel-node@0.1.5

## 0.1.9

### Patch Changes

- c404a91: User-facing: You can now chat with your coach while your first training-data sync is still running. Before, typing a message or opening Settings during a long first sync could leave the app on "Connection interrupted" until you quit and reopened it.

  A sync no longer holds the store lane while an intervals.icu request is in flight. The backfill, the capture and the curve refresh fetch through the store runtime, which frees the lane until the whole response has arrived and takes it back before the next store step; the wait for the legacy refresh frees it too. Preference reads, setup status, chat drafts and chat turns now run between the sync's store steps. File imports and intervals.icu sign-in changes still wait for the whole sync. A coach call that times out now fails alone instead of closing the shared connection and failing every other call on it; a caller's abort and a protocol fault still close it.

- 0992b39: User-facing: Plan workouts that the app puts on your intervals.icu calendar no longer pile up as extra copies each time the app checks the calendar. Workouts with steps now show those steps and their training load in intervals.icu. Copies made by earlier versions stay on your calendar.

  intervals.icu replaces a client's `uid` with its own, so the calendar mirror could never find the events it had made: it created them again on every run and never verified. The mirror now marks its events with `external_id`, which intervals.icu keeps, and no longer sends `upsertOnUid`. It sends only the description, because intervals.icu keeps a client `workout_doc` as is and then cannot read it.

  The reconciler and the outside-edit check no longer compare `workout_doc`, nor the duration of a described workout, since intervals.icu derives both from the description. Adopting an outside edit no longer copies intervals.icu's `workout_doc` into the Plan. Plan calendar events stay outside the chat workout tools, now that their `external_id` is visible. Events made by earlier versions are not recognised or removed.

- Updated dependencies [b0c88aa]
- Updated dependencies [0eb83f7]
- Updated dependencies [0992b39]
- Updated dependencies [78ecb9c]
  - @enduragent/core@0.2.0
  - @enduragent/i18n@0.3.0
  - @enduragent/coach-contract@0.2.0
  - @enduragent/engine@0.1.0
  - @enduragent/coach-cli@0.1.8
  - @enduragent/sport-cycling@0.0.14

## 0.1.8

### Patch Changes

- 50a36f2: User-facing: After you sign in to intervals.icu again, today's plan now reaches your intervals.icu calendar the next time your plan refreshes. Before, the calendar could keep showing "Calendar sync failed." after you signed in again.

  While intervals.icu rejects the signed-in token, two calls that nobody asked for now wait for a working sign-in. Re-applying the same sign-in to a running coach no longer starts a store refresh, and the plan-calendar push leaves today's job untouched instead of using up its five attempts. Sync now still sends its requests, the first request after a coach start still detects the rejection, and a plain API key works as before.

- 2fd6f2e: User-facing: Setup and Settings no longer ask for your injury status, so you can start coaching as soon as your AI and training data are connected.

  The `injury-status` Setup row, its intake draft and persistence in the onboarding controller, the `saveIntake` RPC, the `intake` field of `getSetupStatus`, the kernel intake repository, and the `setup.intake.*` and intake error catalog keys are removed. Setup now has two required items. `PROTOCOL_VERSION` moves from 36 to 37. The `intake_flags` table and any row an earlier version saved stay in the store untouched; nothing reads or writes them anymore, and no migration runs.

- 72e5255: While intervals.icu rejects the signed-in token, the six-hour store refresh skips its turn and logs `scheduled_store_refresh_skipped`. An owner check that is retried with a token already marked as rejected is refused without a request. That guards a daemon started with a signed-in token in its config or environment; the desktop app does not start its daemon that way. A new sign-in resumes the refresh, and Sync now still sends its requests. A plain API key syncs as before.
- Updated dependencies [2fd6f2e]
  - @enduragent/coach-contract@0.1.7
  - @enduragent/kernel@0.1.4
  - @enduragent/i18n@0.2.5
  - @enduragent/coach-cli@0.1.7
  - @enduragent/core@0.1.11
  - @enduragent/engine@0.0.9
  - @enduragent/kernel-node@0.1.4
  - @enduragent/sport-cycling@0.0.13
  - @enduragent/sync-intervals-icu@0.1.4

## 0.1.7

### Patch Changes

- 29e7393: User-facing: Disconnecting Intervals.icu now also removes Enduragent's access on Intervals.icu, and the app asks you to sign in again if Intervals.icu stops accepting your sign-in.

  Disconnect in Settings now revokes the signed-in token on intervals.icu (`disconnect-app`) through a scoped vault read, then deletes it locally even when the revoke fails, and the result line says which happened. A plain API key is only removed locally. Core tracks bearer credentials that intervals.icu rejects: a 401 marks the credential, a 403 is confirmed with one probe of the athlete endpoint, and any successful response clears it. The runtime config snapshot reports this as `intervals.credential_rejected`, and the renderer shows "Sign in again" on the Intervals.icu row and in the sidebar footer.

- Updated dependencies [edd9d10]
- Updated dependencies [29e7393]
- Updated dependencies [2f95252]
- Updated dependencies [12d83db]
- Updated dependencies [4346aa2]
  - @enduragent/core@0.1.10
  - @enduragent/i18n@0.2.4
  - @enduragent/coach-contract@0.1.6
  - @enduragent/engine@0.0.8
  - @enduragent/coach-cli@0.1.6
  - @enduragent/sport-cycling@0.0.12

## 0.1.6

### Patch Changes

- 1b37d2b: A reference capture now returns a report beside its records. For each of the four lanes (settings, activities, wellness, streams) the report holds the rows fetched, the rows landed, and one drop record for every fetched row that did not land. A drop record names the lane, the row's index, a checked id and date, the step that failed, the reason, and the field. It never holds a value or an error message. A recording whose download failed is listed apart, because no row arrived. The capture loop no longer skips a row without counting it, and an error in wellness landing that is not a row rejection now fails the capture. The batch field `dropped_activity_rows` is replaced by `activityDropEvidence(batch.report.activities)`. Fourth of six changes for #1130.
- 0852155: User-facing: If a sync cannot keep any of the wellness days it fetched, the coach now says the sync failed instead of saying you have no data.
  User-facing: If a sync keeps only some of the wellness days it fetched, the coach now says how many of the days you asked about are missing.

  `laneHealth` reads a lane's report as `ok`, `partial` or `lost`, and `judgedDrops` lists the drops it judges: every drop except rows the provider withheld, with recordings whose download failed left out. `laneStanding` pairs that health with the civil dates of the judged drops. `runReferenceCapture` returns the report beside the manifest. The store runtime logs `capture_lane_lost` or `capture_lane_partial` with the lane, its counts and up to five judged drop lines, still publishes the capture, and hands the wellness lane's standing to the store reader. The reader answers a lost lane with `wellness_unreadable`, and a partial lane with a `notice` that counts only the dropped days inside the requested range. A dropped row without a civil date is logged and adds no notice. The capture command prints one line per lane that dropped a row, with `dropped=` for judged drops, `withheld=` for rows the provider withheld, `first_drop=` taken from the judged drops and `first_unfetched=` for a failed request. It exits 3 when a lane is lost, and reads the failure category through the store writer's wrapper. A capture named by `--replaces` is loaded and replayed before the first request and the first store write, and a capture that cannot be is refused with nothing written. The store runtime logs that refusal as `capture_replacement_refused` with the capture id. Sixth of six changes for #1130.

- 1e3c8f9: User-facing: Wellness days sync again, so the coach can see your resting heart rate, heart-rate variability, and sleep.
  User-facing: A fatigue score you log yourself is kept apart from your training-load fatigue in synced days.

  Every path that turns a platform wellness day into a `WellnessDay` now goes through `decodeWellnessRow`: capture, the paged pull, the stored projection, the legacy sync, capture replay, and the two fixture tools. The raw fetch tool `tools/fetch-real-athlete.ts` still writes days as the platform sends them. `landWellnessRow` in the sync package turns one wire day into its archive identity and its typed store row. The store column `fatigue` holds only the self-reported score, and the field archive keeps the load averages under `load`. `renameTpFieldsOnWellnessRow`, `parseRenamedWellnessRow` and the injected wellness decoder are removed. A day with a value that cannot be stored is rejected whole. The paged pull names the key of a value it cannot store, and the fixture tool names the key of a day it cannot decode. Capture still skips that day without a count until the next change adds the per-lane report. Third of six changes for #1130.

- Updated dependencies [1cb7f32]
- Updated dependencies [1b37d2b]
- Updated dependencies [d4be2cf]
- Updated dependencies [129a0d1]
- Updated dependencies [0852155]
- Updated dependencies [1e3c8f9]
- Updated dependencies [aae19b5]
  - @enduragent/i18n@0.2.3
  - @enduragent/sync-intervals-icu@0.1.3
  - @enduragent/kernel@0.1.3
  - @enduragent/core@0.1.9
  - @enduragent/engine@0.0.7
  - @enduragent/kernel-node@0.1.3
  - @enduragent/sport-cycling@0.0.11

## 0.1.5

### Patch Changes

- Updated dependencies [6e57252]
  - @enduragent/core@0.1.8

## 0.1.4

### Patch Changes

- 514f5f9: User-facing: Model limits, image support, and usage costs now remain consistent while Enduragent refreshes its model information.
- 2ab873b: Keep catalog-to-engine projection as a read. Persist selected model profiles only when an engine is constructed.
- 600295a: User-facing: The npm coach now starts the same 24-hour model-list refresh that desktop already runs, so Setup and Chat stay on one list.
- 922c4ad: User-facing: Setup and Settings now show the latest accepted models while keeping an open model choice stable until you finish.
- Updated dependencies [514f5f9]
- Updated dependencies [2ab873b]
- Updated dependencies [e7bc80f]
- Updated dependencies [600295a]
- Updated dependencies [922c4ad]
- Updated dependencies [45c904f]
  - @enduragent/core@0.1.7
  - @enduragent/engine@0.0.6
  - @enduragent/coach-contract@0.1.5
  - @enduragent/sport-cycling@0.0.10
  - @enduragent/coach-cli@0.1.5
  - @enduragent/i18n@0.2.2

## 0.1.3

### Patch Changes

- Updated dependencies [a372f86]
  - @enduragent/coach-contract@0.1.4
  - @enduragent/core@0.1.6
  - @enduragent/i18n@0.2.1
  - @enduragent/coach-cli@0.1.4
  - @enduragent/engine@0.0.5
  - @enduragent/sport-cycling@0.0.9

## 0.1.2

### Patch Changes

- 5ecffcc: Route fixed Telegram, terminal, and coach messages through the shared English catalog and preserve message descriptors alongside existing wire text.

  User-facing: The Telegram bot, the terminal setup, and the coach's fixed replies now use your language, and the terminal setup asks for your language when your computer's language is not one it speaks.

- b30d963: User-facing: Long conversations recover from slow replies more reliably, and the app no longer pauses to tidy its log on every line it writes.
- Updated dependencies [2354437]
- Updated dependencies [5a9f738]
- Updated dependencies [5ecffcc]
- Updated dependencies [e62bd9b]
- Updated dependencies [c090b3e]
- Updated dependencies [a30364f]
- Updated dependencies [f09f4e4]
- Updated dependencies [ae70f69]
- Updated dependencies [aff777d]
- Updated dependencies [074740b]
- Updated dependencies [f767b66]
- Updated dependencies [9c07855]
- Updated dependencies [1f41fe7]
- Updated dependencies [602dd8c]
- Updated dependencies [3e9e0e4]
- Updated dependencies [7972d4c]
- Updated dependencies [b30d963]
  - @enduragent/kernel-node@0.1.2
  - @enduragent/engine@0.0.4
  - @enduragent/core@0.1.5
  - @enduragent/i18n@0.2.0
  - @enduragent/coach-contract@0.1.3
  - @enduragent/sport-cycling@0.0.8
  - @enduragent/kernel@0.1.2
  - @enduragent/coach-cli@0.1.3
  - @enduragent/sync-intervals-icu@0.1.2

## 0.1.1

### Patch Changes

- 39902fa: User-facing: A reviewed Draft can now become your active Plan. Activating closes any Plan that was running and keeps your answers with the new Plan.
- 09c5ca3: Refresh runtime dependencies, including XML parser security fixes and desktop updater compatibility updates.

  User-facing: This update improves the safety of imported files and refreshes the libraries used for coaching and app updates.

- b2ddccb: User-facing: Plan creation in Chat can now build a Draft from your answers, with every week and Workout laid out under your confirmed limits. The Draft keeps the answers it was built from when you edit them.
- 2d0128c: Add the privileged Chat attachment-admission contract and durable queued-Message attachment identities.
- b38ae00: User-facing: Coach answers can now offer a safe Continue in Plan card, resolve Workout date conflicts, retry failed handoffs without duplicates, and recover a Proposal when a local Plan save fails.

  Chat keeps typed Plan handoffs with their transcript turn, while Plan protects athlete-created Workouts and requires review before applying a new date or replacing a coach-owned Workout.

- 66579e6: User-facing: Chat safely resumes unfinished Plan handoffs after relaunch. Deleting Chat attachment data keeps delivered Plan work and its compact origin record intact.
- 8c20aef: User-facing: Workout handoffs from Chat now open the same reviewable Plan Proposal after retries or relaunch, while Draft and Plan-creation requests continue in their exact Plan conversation.

  Planning stores the destination artifact and request relation together, preserves date conflicts for review, and keeps delivery retryable when destination intake is temporarily unavailable.

- d6d960f: Chat can securely rebuild a selected Workout handoff and restore its current Plan status after relaunch.

  The daemon resolves local Workout details instead of trusting renderer-provided snapshots, and durable handoffs can be listed by their source conversation.

- dc24ae3: User-facing: Applying or rejecting a Chat-originated Plan Proposal now records the matching Chat result atomically, so relaunch cannot show a stale or contradictory handoff.

  Planning keeps revised Proposals attached to their originating request, rolls back the complete Plan change when terminal-result storage fails, and leaves calendar mirroring separate from local success.

- 2d09c46: User-facing: Past chats can now be permanently deleted with clear confirmation while imported activities and Plan work stay intact. Chat also keeps its safety note visible when cards stack up, orders those cards consistently, and closes the compact Training context drawer reliably from the keyboard.
- 68bf244: Read selected activity files during processing and traverse XML without recursion.

  User-facing: Importing a batch of activity files uses less memory. Deeply nested GPX and TCX files no longer interrupt the import with a stack error.

- 48f6422: User-facing: Diagnostic logs now hide sensitive error text and credential-bearing URLs. Secret helper failures show an exit code and setup guidance without exposing helper output.
- f3a8b51: User-facing: Adding more than five files now keeps the first five. Pasted images show as `Pasted image.png`.
- 9ed12a5: User-facing: The Plan page can now read your unfinished Plan creation, your active Plan, and your closed Plans together.
- 918600a: User-facing: Answer the essential Plan questions one at a time in chat by picking from clear choices or writing your own answer, change an earlier answer with Edit, and come back later to pick up where you left off.
- 9a9665f: Add a confirmation before discarding unfinished Plan Creation work in Chat.

  User-facing: Discard an unfinished Plan you started in chat without affecting your current Plan or your chat history.

- 07b0a8d: User-facing: The active Plan now shows race-day Form and goal feasibility at a glance, with clearer race-week and readiness details. Ended Plans can open their saved coach conversation as read-only history.
- c507634: End an active Plan locally before removing tomorrow-onward Plan-owned Intervals workouts, with durable retry and verify-only recovery that preserves today and athlete-created events.
- e649a25: Add display-only Estimated CP from two eligible recent measured-power efforts, including stale and unavailable states, an explanatory tooltip, evidence and route-assumption drawers, and strict isolation from FTP and Plan mutations.
- f6cacbb: Add forward-only race-readiness projections, explicit unavailable and changed-assumption states, refresh recovery, and taper safety refusal without mutating the active Plan.
- b02a1e8: User-facing: Plans now end automatically after their final date and let athletes record the race as Completed or Not completed without changing their saved Plan.
- b87174d: Replace an active Plan atomically while preserving today, verify tomorrow-onward cleanup of the old Plan before writing the replacement’s next seven days, and keep failures recoverable after relaunch.
- 3ad0c39: Show every active Plan week with phase, purpose, status, and planned time, plus a complete authoritative race-week schedule with separate training, race, and total accounting.
- a52086c: Add Plan-scoped settings with immediate persistence and safely auto-apply eligible future workout duration reductions.
- 6546ba5: User-facing: Active Plans can now show one automatic, score-free review of the latest completed week after a successful sync.
- a5a366f: User-facing: Stopping a Chat response or losing connection now keeps the interrupted message retryable and sends later queued messages once, in order.
- eba82b9: User-facing: Chat recovery now survives repeated connection losses without duplicating your message after relaunch, while preserving every partial and completed Coach response.
- 2567965: User-facing: Plan coach conversations now collect durable training inputs, show a reviewable summary, and create a complete structured Draft before anything can activate or reach the Intervals calendar.

  The Plan composer stays at the bottom, optional Race Course attachment lives inside it, and interrupted intake saves recover from the conversation after relaunch.

- a415177: Add the internal training-history contract, persisted coverage evidence, calendar-aware capture plan, and state composition wiring.
- 4018b25: Keep Training History freshness and calendar windows anchored to the current successful sync and the athlete's active timezone.

  User-facing: Training History now stays current after a successful sync that finds no new data, and its week boundaries follow your active timezone without requiring a restart.

- f65201d: User-facing: Training History now marks only the dates affected by dropped activities as incomplete. Open weeks and comparison callouts no longer claim totals for days that have not finished.
- ca163a7: Keep last-recorded Training history during temporary storage failures, preserve selected rides unless refreshed history proves they were removed, and fence ride analysis cache invalidation against late results.

  User-facing: Training now keeps your last recorded history during temporary refresh problems. Ride review no longer closes or reuses out-of-date analysis when refreshed data cannot prove a ride was removed.

- 5b53e73: Replace the legacy Training panel stack with a week-first summary, six-week riding trend, recent-ride callouts, and inline Ride review.

  User-facing: The Training page now leads with your week: riding time, rides, distance and Load, a six-week trend, and your recent rides with the ride you should look at first. Ride review opens right on the page.

- Updated dependencies [39902fa]
- Updated dependencies [09c5ca3]
- Updated dependencies [b2ddccb]
- Updated dependencies [2d0128c]
- Updated dependencies [b38ae00]
- Updated dependencies [66579e6]
- Updated dependencies [8c20aef]
- Updated dependencies [d6d960f]
- Updated dependencies [dc24ae3]
- Updated dependencies [1e07590]
- Updated dependencies [2d09c46]
- Updated dependencies [68bf244]
- Updated dependencies [f191262]
- Updated dependencies [3627ecd]
- Updated dependencies [9d86d76]
- Updated dependencies [30ca87f]
- Updated dependencies [48f6422]
- Updated dependencies [3627ecd]
- Updated dependencies [2a2c852]
- Updated dependencies [9ed12a5]
- Updated dependencies [3077144]
- Updated dependencies [ae1cbb1]
- Updated dependencies [918600a]
- Updated dependencies [9a9665f]
- Updated dependencies [c507634]
- Updated dependencies [e649a25]
- Updated dependencies [f6cacbb]
- Updated dependencies [b02a1e8]
- Updated dependencies [b87174d]
- Updated dependencies [3ad0c39]
- Updated dependencies [a52086c]
- Updated dependencies [6546ba5]
- Updated dependencies [1594b20]
- Updated dependencies [391ff3f]
- Updated dependencies [a5a366f]
- Updated dependencies [eba82b9]
- Updated dependencies [2567965]
- Updated dependencies [a415177]
- Updated dependencies [3627ecd]
- Updated dependencies [63a0f54]
- Updated dependencies [4018b25]
- Updated dependencies [f65201d]
  - @enduragent/coach-contract@0.1.2
  - @enduragent/kernel@0.1.1
  - @enduragent/kernel-node@0.1.1
  - @enduragent/engine@0.0.3
  - @enduragent/core@0.1.4
  - @enduragent/sport-cycling@0.0.7
  - @enduragent/sync-intervals-icu@0.1.1
  - @enduragent/coach-cli@0.1.2
  - @enduragent/i18n@0.1.2

## 0.1.0

### Minor Changes

- 10c6d16: Add read-only local bundle projection for the Reference layer.

### Patch Changes

- 8ac6eec: Record one store-level owner fingerprint from the resolved intervals.icu athlete identifier at sync time, compare it read-only before credential saves, allow saves when the comparison is unavailable, and keep credential rotation independent from account ownership.
- a6f259c: Add resumable incremental activity-history preparation and materialization while retaining the full Reference layer rebuild as an invariant oracle. Internal operator infrastructure; ships nothing to athletes.
- d22fb9a: User-facing: ChatGPT sign-in now finishes promptly after browser approval, shows clear progress, supports cancellation, and can retry coach activation without another login.
- 4655bd1: Add scriptable CLI verbs with stable JSON output, explicit session selection, daemon-client startup, and a lock-safe local fallback. Public package and image distribution remain unchanged.
- f76081e: Add the internal contract-only terminal surface and lock-owning local dogfood executable composition. Public package and image distribution remain unchanged.
- d36c593: Add the governed Reference layer sync composition root and share the existing Node writer lifecycle. Internal infrastructure; ships nothing to athletes.
- 180df32: Attribute coach store writer failures precisely: recognize write-lock contention across bundle copies by error name, and carry the underlying failure cause through the writer result onto the thrown error.
- e20ada6: Add the internal localhost daemon core, authenticated RPC projection, wall-clock scheduler, and safe newer-store refusal.
- 8619dc3: Reuse the daemon lifecycle's authoritative store writer during refresh windows instead of attempting a nested writer acquisition, so a fresh athlete home starts normally and Reference sync errors render usefully.
- ea56807: Start the local service without an intervals.icu API key by skipping the provider capture lane, and report over-long fence socket paths truthfully instead of as an active handoff reservation.
- 61a8940: Added desktop PKCE sign-in, daemon-owned OAuth profile storage, and keyless runtime configuration for the ChatGPT subscription provider.
- 0115dfe: Preserve closed configuration-readiness failures through app-supervised utility termination without retrying terminal configuration errors.
- b4e5365: Let Desktop start from an existing configuration that omits `data_dir`.
- 78971cb: Adds boundary-scoped archived conversation reads (list plus a cursor-namespaced page reader) through the durable transcript store, daemon RPC registry, main-process IPC, and the validated preload bridge. Current-conversation hydration is untouched; the archived surface has no composer, retry, or resume path. Protocol version moves to 11 because the wire method set grew.
- 1977c1b: Added provider-reported OpenRouter costs and aggregate authenticated spend methods for the desktop client.
- 2e437f8: Add the privileged Desktop Telegram control plane with serialized suspend, resume, and generation-drain authority; truthful mutation outcomes; and one home-bound encrypted token-and-bot profile without exposing token material to the renderer.
- 67369bb: Add an internal append-only transcript writer with a 262,144-byte serialized-record bound and conversation reset boundaries for durable Desktop capture. Renderer history and hydration are not exposed in this slice.
- 810b29e: Add bounded, cursor-stable transcript pagination for the canonical Desktop conversation across the durable store, daemon RPC, main-process IPC, and validated preload bridge.
- d6213bb: Repair daemon socket callback handling, upgrade-fence cleanup, and deterministic socket-suite synchronization.
- 2e437f8: User-facing: Desktop now starts with a fresh Enduragent profile and leaves old npm-library data untouched.

  Removed the obsolete automatic home migrator from local coach startup and made first-run Desktop configuration independent of the old npm home.

- 9f9d8c2: User-facing: Setup now remembers the Claude subscription lane instead of showing Anthropic when you reopen it.

  `credential_configured` was derived from a non-empty `llm.api_key` for every provider except `openai-codex`, so the keyless lanes that never write a key — `claude-cli` and `codex-agent` — were structurally false forever. That nulled the onboarding wizard's active provider, and the Setup draft then fell through to the first entry in the provider catalogue. The runtime check now short-circuits on `isKeylessProvider` and only falls through to the key-length test for providers that actually hold a key. The `openai-codex` branch stays ahead of that short-circuit, so the ChatGPT lane still depends on a stored auth profile rather than reporting itself configured with nothing on disk.

  Populating the active provider exposed a latent assumption in the Settings coach panel: it treated an active provider that is absent from the public model catalogue as an unloadable configuration. `codex-agent` is deliberately absent from the catalogue, so that path became reachable for the first time and would have left those athletes on a dead error screen with no way to switch away. The panel now loads with the provider list intact and no draft selection, and the coach route row reads the active provider off the runtime snapshot instead of the draft, so it no longer reports "Not configured" for a provider that is actually serving turns. An empty catalogue is still a genuine load error.

- 51cd022: Add macOS service installation, status, restart, and fail-closed service-owner arbitration for the internal enduragent executable.
- 00ee9f4: Persist per-source synchronization failures and keep mixed API and FIT activity presentations deterministic.
- e09a645: Project verified curve evidence into a bounded Power Progress training contract with independent freshness, stale-last-good failure context, and no raw provider data.
- 2e437f8: Bind protocol-12 daemon connections to a physical athlete home and give the Desktop renderer a restricted, process-scoped capability instead of the privileged daemon token.
- 68821e7: Add immutable Reference capture sidecars with replayable endpoint evidence and exact live-fetch ordering. Private infrastructure; ships nothing to athletes.
- 3553f83: Add a private Reference layer capture-once gate for store projection.
- 67174e9: Add authenticated intake persistence and in-memory runtime configuration operations to the daemon wire.
- a5b415b: Persist redacted sync-subsystem diagnostics when a scheduled training-store refresh fails.
- 56b2f24: Add a private cycling season review prototype over the configured store-backed coaching path.
- aebc383: User-facing: Desktop ride reviews can now save FIT or GPX files, and the visible training plan can be saved as a ZIP of ZWO, MRC, ERG, or FIT workouts.

  Keep export credentials, provider identifiers, file paths, and downloaded bytes in trusted processes; enforce bounded downloads and atomically publish private mode-0600 files selected through the native save dialog.

- 0afbcad: User-facing: Local coaching can read historical athlete data from the training store and disclose when it was last synchronized.
- Updated dependencies [8ac6eec]
- Updated dependencies [a17fdef]
- Updated dependencies [4f99951]
- Updated dependencies [a6f259c]
- Updated dependencies [e2ef5f7]
- Updated dependencies [ec24061]
- Updated dependencies [d22fb9a]
- Updated dependencies [4655bd1]
- Updated dependencies [f76081e]
- Updated dependencies [fc9ed36]
- Updated dependencies [d36c593]
- Updated dependencies [180df32]
- Updated dependencies [5428c22]
- Updated dependencies [e20ada6]
- Updated dependencies [8619dc3]
- Updated dependencies [68e2a75]
- Updated dependencies [61a8940]
- Updated dependencies [0115dfe]
- Updated dependencies [b4e5365]
- Updated dependencies [78971cb]
- Updated dependencies [a42fb2c]
- Updated dependencies [2e61329]
- Updated dependencies [1977c1b]
- Updated dependencies [2e437f8]
- Updated dependencies [67369bb]
- Updated dependencies [810b29e]
- Updated dependencies [e932ede]
- Updated dependencies [0ab935f]
- Updated dependencies [42c6efa]
- Updated dependencies [a2ac0c4]
- Updated dependencies [517a34f]
- Updated dependencies [c122f29]
- Updated dependencies [111261c]
- Updated dependencies [4e996bc]
- Updated dependencies [66fc866]
- Updated dependencies [b8a8ef0]
- Updated dependencies [0b73876]
- Updated dependencies [51cd022]
- Updated dependencies [00ee9f4]
- Updated dependencies [e09a645]
- Updated dependencies [037a09a]
- Updated dependencies [68821e7]
- Updated dependencies [10c6d16]
- Updated dependencies [9a7961c]
- Updated dependencies [ded6067]
- Updated dependencies [22364df]
- Updated dependencies [67174e9]
- Updated dependencies [0d1ad65]
- Updated dependencies [aebc383]
- Updated dependencies [c0714a0]
- Updated dependencies [336462d]
- Updated dependencies [118c2a6]
- Updated dependencies [89a6522]
- Updated dependencies [0afbcad]
- Updated dependencies [fd9cd3a]
- Updated dependencies [b25c3c1]
- Updated dependencies [edbc0a1]
  - @enduragent/kernel@0.1.0
  - @enduragent/kernel-node@0.1.0
  - @enduragent/coach-contract@0.1.1
  - @enduragent/core@0.1.3
  - @enduragent/sport-cycling@0.0.6
  - @enduragent/coach-cli@0.1.1
  - @enduragent/engine@0.0.2
  - @enduragent/sync-intervals-icu@0.1.0
