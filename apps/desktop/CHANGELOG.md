# @enduragent/desktop

## 0.8.0

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

- dbe61e3: User-facing: When the coach can't answer because your Claude Code, Codex or ChatGPT sign-in has ended, your AI provider account is out of credits, or your provider no longer offers the model you picked, Chat now says so under your message and tells you what to do next. Before, it showed only a red icon and Retry, or blamed an API key you don't have.

  Core classifies a provider error whose code or type is `model_not_found`, or Anthropic's `not_found_error` on the anthropic route, as the new `model_unavailable` failure (a bare 404, which a wrong base URL also returns, stays generic), and an OpenAI 429 whose error type or code is a billing limit (`insufficient_quota`, `credit_balance_exhausted`, spend or usage limits) as `payment_required`, so it is no longer retried as a rate limit. The route comes from the chat model's provider; a 429 from any other provider stays a rate limit. The engine chooses the athlete copy from the failure and the provider: a sign-in failure on Claude Code, Codex or ChatGPT gets the new `subscription-signed-out` kind with the existing "sign in again" message, a 402 from a key provider other than OpenRouter gets the new `provider-credits` kind, and a missing model gets the new `model-unavailable` kind. Chat shows these three, and OpenRouter's credits notice, as a red notice under the kept message. A rejected API key, rate limits and other failures keep the icon and Retry. Telegram and the terminal keep their existing replies. The three new error kinds change the turn-event wire, so the coach protocol moves from 38 to 39.

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

- 3adc44c: User-facing: Asking the coach to change a workout from the Calendar now opens a clean Plan-change draft and brings your earlier Chat draft back once the change is sent or cancelled.
- cf69384: User-facing: When intervals.icu stops accepting your sign-in, your Plan no longer says "Updating calendar" while nothing is being sent; it asks you to connect instead. After you sign in again, your planned workouts go to your intervals.icu calendar right away, without waiting for you to open Plan or for the next sync.

  The Plan calendar status and the plan-creation calendar line now treat a rejected intervals.icu sign-in as not connected, using the same check as the plan calendar drain. The 24-hour stale-sync pause on Plan Changes and the Supporting Event candidates still count any saved sign-in, so a rejected one neither lifts the pause nor hides synced races. Every store window, including the refresh after a new sign-in, now kicks the calendar drain when it finishes.

- df97440: User-facing: When you type your own answer to a Plan or coaching question, the chat box stays at the bottom and says to finish your answer first, and Stop responding stays there while the coach is still replying.
- b4c2cc2: User-facing: Queued chat messages now keep sending after failed replies or removed commands, oversized plan edits no longer leave stray bubbles, and startup or file-drop hiccups recover cleanly.

  Unifies chat queue drain scheduling across failure, removal, and reset paths, clears draft errors after successful sends, serializes coach decision mutations away from active streams, retries failed startup probes individually, validates plan-change text before updating the transcript, guards async plan epochs and disposal, and adds timeout cleanup and busy-state Dismiss handling for dropped attachments.

- 5a13099: Add Discard next to Retry message when a Chat reply is stopped or fails. Discard drops the held message through the new `discardQueuedTurn` queue call, so later queued messages send and New chat stays available while a message waits for retry.

  User-facing: After you stop a reply or a reply fails, you can now discard that message instead of retrying it. Messages you sent afterwards then go to your coach, and New chat stays available.

- 78c0c28: User-facing: Starting a fresh session automatically no longer drops queued follow-up messages or prints two fresh-session notices.

  Preserves the durable chat queue across automatic stale-session resets, replays live queue events for overlapping `resumeChatQueue` callers, and removes the duplicate archive disclosure instruction from the model prompt.

- da117ef: User-facing: Chat decision shortcuts now respond only while Chat is open, drafts stay intact across view switches and slash commands, and messages no longer duplicate or blank when views refresh.

  Resets `queueRevision` on New Conversation, filters live turns out of reloaded history pages, flushes Composer drafts on unmount and slash acceptance, scopes Chat decision shortcuts to the Chat view, and preserves buffered streaming text when views remount.

- b928891: User-facing: While a ChatGPT sign-in is open in the browser, the coach can now restart without stopping, and Telegram setup no longer waits for the sign-in to finish.

  The ChatGPT login used to hold the main process's credential mutation lock for the whole browser wait, up to 5 minutes. A coach restart's key replay queued behind it, ran out the 5 s readiness limit, and left the coach unavailable until relaunch. The login now takes the lock only to store the sign-in, with the abort check inside the lock.

- 3255d8f: User-facing: When an earlier Claude Code check finishes long after you checked again, Setup now keeps your newer result, so Continue does not fail after Setup showed Claude Code ready.

  A Claude Code check that missed its 72 s deadline and settled later cleared the newest "ready" result, so activation probed again and could time out. The late check still clears the account probe cache, but the ready result is now recorded and cleared only by the newest check that settled.

- f8d2fe0: User-facing: Choosing Claude Code in Setup no longer trusts a Claude Code sign-in check from long ago: when the last check is more than a minute old, it checks again before switching your coach to Claude Code.

  Activation reused the last "ready" result of the Claude Code check with no age limit. It now reuses it only within `CLAUDE_CLI_READY_REUSE_MS` (60 s). After that it joins a check already running, or forces a fresh one that clears the 5-minute account probe cache.

  A check that is not forced can still use the account probe that Claude Code's own cache kept for up to 5 minutes, and activation reuses a check that finished within the last minute. Both are pinned in `claude-cli-status.test.ts` to avoid a second probe right after the athlete's selection.

- 6b2d249: User-facing: Stop now ends a reply at once even if you changed the coach in Settings while it was streaming. Changing the coach or deleting the AI key in use during a reply now fails right away with a "try again" message, instead of hanging or sending you to the Setup screen.

  A runtime change (`configureRuntime`) that arrives while a chat turn runs now returns the refusal `busy-replying` before it puts the barrier up, so Stop, the runtime config read and the transcript reads are not queued behind a drain that waits for the whole reply. A catalog pin moves into the replacement's prepare step, so a refused change does not pin the new catalog. The startup refresh still waits for running turns. On a key delete, the desktop maps `busy-replying` to a `runtime-unavailable` refusal and leaves the key and its runtime state as they were.

  The coach protocol version goes to 38, because the new `busy-replying` refusal reason is a wire change.

- 4383fe4: User-facing: Disconnecting Intervals.icu while a sync is running now stops the sync and disconnects right away. Before, Disconnect could wait 30 seconds, fail with "could not be reconciled", lock Settings and leave the sign-in in place.

  The coach's configureRuntime aborts the sync window that holds the store lane, and any window that starts while the clear waits, when it receives an intervals.icu clear_credential. The clear then applies inside the 25 s deadline and the vault revokes and removes the token. A sign-in replacement still waits for the sync.

- a88cdea: User-facing: When ChatGPT stops accepting your sign-in, Setup now says the sign-in expired and offers Sign in with ChatGPT, which opens the browser so you can sign in again. Before, Setup kept showing ChatGPT as Connected and gave you no way to sign in again.

  When the coach's refresh of the ChatGPT token is rejected twice, it marks the stored profile in `auth-profiles.json` as rejected, compared against the profile it refreshed so a newer sign-in is never marked. A successful refresh or a new browser sign-in clears the mark. Main's ChatGPT status reports a marked profile as `{ state: "configured", runtimeReady: false, reason: "sign-in-expired" }`. The renderer keeps it as an expired credential that cannot be activated, so Sign in starts a fresh browser sign-in, and Settings refreshes the sign-in status when it opens. The coach's OAuth token reader moves out of `composition.ts` into `oauth-access-token.ts`.

- 1ab9418: User-facing: Enduragent now reopens automatically if installing a desktop update fails instead of closing without restarting. Update downloads, automatic background checks, and Try again now recover cleanly after errors, and the sidebar no longer flashes "Restarting…" while checking for updates.

  Replaces implicit update and quit flags across `update-controller.ts`, `update-state-machine.ts`, `quit-coordinator.ts`, `main/index.ts`, and the renderer update controller/UI with explicit closed phase unions. Detaches failed and ready operations immediately (eliminating retry wedges), resets the download transfer watermark on differential-to-full fallback, arms macOS Squirrel readiness listeners only after archive download completes, commits the updater only after configuration succeeds, keeps the 6-hour check timer scheduled on transient startup floor or config failure, freezes update IPC and controller synchronously before async shutdown awaits, relaunches the current app once on failed update drain/install handoff (including synchronous and asynchronous updater or native readiness errors), blocks renderer clicks before initial hydration, separates pending `checking` from `restarting` in `UpdateAvailableButton`, and surfaces IPC check rejections after intermediate pushes. Promotes all 10 findings in `.agents/skills/verify-update-download/` to guarded TLC controls.

- eefa039: User-facing: Today's spend in Settings now includes AI requests that failed, timed out or were stopped, with the usage your provider reported before they ended. A request that ended before reporting any usage adds $0.00, so today's total can be a little lower than your provider's bill.

  Every model-call row in the usage ledger now carries the turn that made it (`turnId`), whether the call succeeded (`outcome: "ok" | "error"`) and, for a failed call, why (`errorClass`: a failure reason or `aborted`). A failed, timed-out or aborted call now writes its row with the known usage of the steps that finished before it ended. The spend meter counts a failed call with no usage figure as a known zero, so one failed call does not mark the day incomplete. Known usage is a lower bound: an HTTP error carries no usage figure, and the provider may still bill the step that was in flight.

- aac85bb: User-facing: If you quit the app while your first sync is still downloading your intervals.icu history, the app now finishes that download by itself the next time you open it. Your recent rides still show up right away, and the older ones fill in after. Before, your older rides stayed missing until you pressed Sync now.

  The coach's startup refresh publishes the usual 84-day snapshot first, as before. Then the coach reads the saved history-download state: not started, in progress at a saved cursor, or complete. Only a download in progress resumes, in a store window of its own that captures again when the download finishes. The store lane stays free during each intervals.icu request. A complete download is left alone. A download that never started is left to the first sync that runs when Setup finishes. Nothing resumes while intervals.icu rejects the sign-in. A failed resume is logged as `history_download_resume_failed` and changes neither the startup refresh nor the six-hour schedule. The next launch or Sync now picks the download up again from its cursor. Quitting the app stops the resumed download.

- 7d6ed8b: User-facing: When your Intervals.icu sign-in is saved but the coach can't use it, Setup now says so and points you at the button on screen (Retry saved keys, or Sign in again), instead of asking you to reload a status that wasn't there.

  Main now reports a sign-in that was saved but could not be applied as `saved-not-active` instead of `uncertain` / `runtime-uncertain`, since the vault has already marked it `failed`. The renderer shows the new `setup.error.intervalsSavedNotActive` message (translated for every catalog) for a saved sign-in whose runtime state is `failed`, and keyboard focus lands on Retry saved keys after such a sign-in when that link is shown. While the row shows the "stopped accepting the sign-in" state, where Retry saved keys is hidden, the message keeps pointing at Sign in again instead. `setup.error.intervalsRuntimeUncertain` is removed.

- 858cff5: User-facing: If the coach is slow to answer right after you delete a key in Settings, you now stay in Settings with a Retry for the setup status, instead of being sent to the full Setup screen while your coach still works.

  The delete path's catch marked the deleted credential as needing repair when Setup's follow-up read timed out, and a repair credential makes Setup required. A failed read is not a reason to repair: the catch now keeps the repair state it had.

- 3c671c6: User-facing: If your Mac's Keychain was locked when the app started, unlocking it now lets Setup save your keys right away. Before, every save said macOS encryption was unavailable until you pressed Retry in Settings or restarted the app.

  Before each credential write, the app now asks the Keychain again whenever it is not using it. The flag that allowed that re-check only while a key cleanup was pending is gone: the backend selection is the only state.

- c5b2b5e: User-facing: If the language you pick on first launch can't be saved, the language screen now stays open with a message and a Retry button, instead of jumping to Setup in English.

  The shell keeps the language screen up after a failed first-launch save, and the screen shows the failure in the chosen language. Settings keeps its existing "Language preference unavailable" message.

- a4187b3: User-facing: Setup and Settings now offer each AI provider's current models, with up-to-date prices, and new setups start on a current model. If a provider has retired the model you picked, the app now uses its replacement.

  Bundled model catalog seed revision 12, matching the published catalog revision 12. Revision 12 is revision 10 plus the old DeepSeek name `deepseek-v4-flash`, labelled "DeepSeek V4.1 Flash (old name)": released builds still default to it, and DeepSeek serves it with V4.1 Flash at the same price. New defaults: Anthropic `claude-sonnet-5-5`, OpenAI `gpt-6.2-sol`, Google `gemini-4-hydrogen`, DeepSeek `deepseek-flash` (replaces the retired `deepseek-v4-flash` name), Qwen `qwen4-max`, Kimi `kimi-k3.1-pro`, Z.ai `glm-5.3`, OpenRouter `deepseek/deepseek-v4.1-flash-1017`. Summariser defaults: Anthropic `claude-haiku-5-5`, OpenRouter `deepseek/deepseek-v4.1-flash-1017`. Retired or withdrawn ids are removed: MiniMax M2.7 and M2.7 Highspeed, Kimi K2.6 and K2.7 Code, Gemini 3.7 Flash, and `qwen/qwen3.8-max` on OpenRouter. Sign-in lanes (ChatGPT, Codex agent, Claude subscription) are unchanged. Saved configs that name a model its provider retired load with the replacement: `gemini-3.7-flash` to `gemini-3.8-flash`, `deepseek-v4-flash` to `deepseek-flash`, `MiniMax-M2.7` to `MiniMax-M3`, `MiniMax-M2.7-highspeed` to `MiniMax-M3.1-Flash`, and `qwen/qwen3.8-max` to `qwen/qwen4-max` on OpenRouter.

- bba219f: User-facing: When starting a new conversation fails partway, Chat now finds out whether it started and says so, and New chat works again without restarting the app. If Chat still can't tell, a Check again button lets you look again.

  After a failed reset, Chat reads the session, the newest transcript page and the queue once, and compares them with what was showing before. Turns and coach questions that are gone mean the reset landed, so Chat finishes it, keeping anything typed or sent after the failure; ones that are still there mean it never started, so Chat returns to normal. When the page can't tell, Chat stays uncertain. The reset itself is never sent twice.

- a6e5783: User-facing: If you open Enduragent without a network connection, it now reconnects to Intervals.icu by itself once the network is back. Until then, Sync tells you Intervals.icu isn't connected instead of saying your training data is synced.

  When main re-applies the saved intervals.icu sign-in and the coach refuses it as `ownership-unavailable`, main retries the saved keys after 15 s, 1, 2, 5, 10 and 15 min, waits without spending an attempt while the Mac is offline, restarts the schedule when the Mac wakes, and stops on shutdown. In the window, a sync that the coach skips for a missing key while a sign-in is saved fails as `not-in-use` with its own message. While Sync is in that state the window re-reads the coach's runtime configuration every 30 s and on focus, and syncs once when the coach has the key. The touched sync files no longer swallow errors silently.

- 0c559cf: User-facing: If a new Intervals.icu sign-in is refused while your current one still works, Intervals.icu now stays connected. Before, the sidebar and Setup asked you to sign in again although sync kept working with your current sign-in.

  The coach's rejected-sign-in check in getRuntimeConfig now tests the applied intervals.icu credential when one is applied, and falls back to the offered credential only when none is. Before, it also tested the offered credential, which configureRuntime stores before the apply and keeps after a refusal. A replacement that intervals.icu answered with 401 during the account check, and that the coach then refused as ownership-unavailable, made the healthy credential in use read as rejected. A refused first sign-in, with nothing applied, still reads as rejected until it is replaced or removed.

- aebd0d5: User-facing: When Enduragent finds that Intervals.icu no longer accepts your sign-in, for example during its background sync, the sidebar now asks you to sign in again within a minute. Before, it waited until you came back to the window or synced.

  The coach learns of a rejected sign-in from its own syncs and chat tool calls, and the window reads that only through `getRuntimeConfig`. The window now re-reads it every 60 s while no sync is running, every 30 s while Sync reports the saved sign-in is not in use, and not at all during a sync, which ends with a read of its own. Focus and the read after each sync stay as they were.

- 5de1cb7: User-facing: When the old Plan's workouts cannot be removed from your intervals.icu calendar, the new Plan's workouts now wait even if you replace the Plan again, and the active Plan shows "Calendar sync failed. Retry available." (or "Connect to mirror Workouts" while intervals.icu is not connected) instead of "Up to date".
  User-facing: Retry calendar now stays available after repeated failures and removes the old Plan's workouts at once.

  The calendar drain and the Plan library read one barrier from `readCleanupBarrier`: the active Plan's mirror waits while any cleanup of another Plan is not verified, not only the newest one, and the active card shows that cleanup. A failed cleanup always offers Retry. Retry sends `retryCalendar` on the next `plan.list`, which reopens failed cleanups. Automatic cleanup retries keep the 15-minute wait after five failures, and mirror jobs keep their five-failure budget.

- 48c0d42: User-facing: After a storage warning at startup, "Remove all credentials" now leaves Setup ready to save new keys. Before, every save kept failing until you restarted the app.

  A successful credential reset now returns the vault's storage state to pending: it clears the store-wide "uncertain" latch, the per-slot uncertain marks, the pending reconciliation and the verified parent folder, inside the vault's own lock while the reset still holds the credential mutation lock. The latch itself still lasts until restart when nothing resets the storage.

- 9912a8c: User-facing: When the model your coach uses leaves Enduragent's model list, Settings → Coach and Setup → API key → Advanced now name it as no longer listed instead of showing it as a model you typed, say that your coach keeps using it, and offer a one-press switch to its replacement when there is one. Nothing changes until you press Switch or pick another model.

  Main now answers the LLM configuration with the saved model classified as `listed`, `retired` (with `replacedBy`, or null when the model list offers no replacement) or `custom`, carried on `active` as `kind`. The classification reads the new `DROPPED_MODELS` table in `@enduragent/core`, which names the replacement for each model the list dropped but saved configurations keep, and offers a replacement only when the list the window received lists it. The preload checks the new keys exactly. Setup and Coach show the retired model as its own option, keep it selected, and re-send it unchanged when saved; the Switch button saves the replacement through the existing Coach and Setup save paths.

- 4d6757a: User-facing: Pressing Review setup in Settings, Coach now only takes you to Setup. The Coach section keeps showing your coach and its controls instead of "Not configured" and "Loading coach settings…".

  The Coach settings controller no longer closes its pane before handing off to the inline Setup panel. Settings stays mounted, so nothing reopened the pane; it now stays in its current state and still reloads once Setup connects a provider.

- a98a899: User-facing: After you switch provider in Settings, Coach, the Setup panel shows the provider your coach really uses, and deleting a key you no longer use keeps you in Settings instead of sending you to the Setup screen. While Setup is saving or signing in, the Coach controls wait for it.

  Setup kept its own copy of the active coach from its first load and dropped the configuration on every later refresh. Now every successful load adopts the configuration, and Setup's draft is kept only when the athlete edited it. A Coach save refreshes Setup, and the Coach pane is disabled while a Setup credential operation runs, so that refresh cannot drop a running Setup operation.

- 03053ce: User-facing: Setup now runs one sign-in at a time. While your coach activates or another sign-in waits for your browser, the Intervals.icu buttons, "Import ride files instead" and Start coaching stay locked, so a second click no longer shows a false "check your connection" error or hides Cancel sign-in.

  Every Setup action and row control now reads one shared check for a running Setup operation: a busy step, a ChatGPT sign-in or activation, an OpenRouter browser sign-in, an Intervals.icu sign-in, or a ride import. The OpenRouter panel's own Reopen and Enter a code links stay usable during its sign-in.

- 4be4457: User-facing: When the coach comes back after a slow start, Setup now loads its status again by itself instead of waiting on "Setup status couldn't be loaded" until you choose Retry.

  When the cold-start reads ran out, Setup's unavailable state latched, and the lifecycle `ready` event refreshed only the language. It now also refreshes Setup while Setup's last read failed.

- 1ebd764: User-facing: If the app can't use your saved Intervals.icu sign-in, the Intervals.icu row in Setup now shows a warning and "Signed in, but not working yet" instead of a green "Connected".

  The Setup training row now checks that the saved Intervals.icu sign-in is active in the coach, the same way training-data readiness does. A sign-in that is saved but `failed` or `stored-inactive` gets a new `not-working` row state with an attention disc, a new `setup.training.subtitle.notWorking` subtitle (translated for every catalog) and the Disconnect action; the existing retry and error panel are unchanged.

- c33bbf7: User-facing: Screen readers now read the Setup screen in your app language instead of as English.

  `SetupGate` hard-coded `lang="en"` on its `main` element. It now uses the active phrasebook's language tag, as the checking screen in `Shell` already does.

- a32be64: Keep the startup checking screen up until the first language check finishes when the computer language is unsupported, so Setup does not flash before the language picker.

  User-facing: Fixed a brief flash of the Setup screen before the language picker on first launch.

- d928eff: User-facing: Desktop app updates now download much less data, and Telegram workout chart labels render reliably in the desktop app.

  Exclude non-runtime TypeScript declarations, TypeScript sources under `node_modules`, workspace `src/` directories, build-time i18n catalogs/glossaries, and unused browser bundles from `app.asar`, and unpack `clawpdf`'s `pdfium.esm.wasm` and `@enduragent/core`'s `workout-chart-font.otf` into `app.asar.unpacked` so differential updates reuse immutable large binaries and `@resvg/resvg-js` can read the chart font from disk.

- 564916f: User-facing: The sidebar's Sign in again link for Intervals.icu now waits while Setup or a Settings change is busy, instead of opening Settings without starting the sign-in.

  The link switched to Settings and called `connectTrainingData`, which does nothing while a Setup credential operation runs. It is now disabled by `setupSignInBlocked`, which joins the two checks `connectTrainingData` refuses on: a running Setup credential operation and `credentialChangesBlocked`.

- a8e100c: User-facing: If the app's window crashes or closes during a ChatGPT or Intervals.icu sign-in, opening the window again now lets you sign in right away, instead of saying "check your connection" or that a sign-in is already in progress.

  A browser sign-in now belongs to the window that started it. Disposing a window's onboarding IPC cancels the ChatGPT login that window started, and an Intervals.icu sign-in that is not approved yet ends when the asking page's webContents is destroyed.

- c9a1cc7: User-facing: If intervals.icu refuses your API key or sign-in while a sync downloads ride recordings, the sync now says it couldn't finish instead of saying your training data synced.

  A 401 on a recording download no longer counts as an unfetched recording. `attempt` in the capture's lane report rethrows a refused sign-in, so the reference capture fails, the store window fails, and Sync shows its retryable failure. The older reference fetch now fails its stream loop on a 401 the same way. A 403 or a 404 on a recording download still counts as an unfetched recording. An OAuth 403 already starts the sign-in check, which marks the sign-in rejected when the check confirms the refusal. The change also runs `oxfmt` over `lane-report.ts` and the live-bundle test, which the format gate requires once a file changes.

- 3cb16f8: User-facing: Changing your coach model in Settings no longer leaves chat summaries or memory saves stuck on a costlier model. Summaries stay on your provider's cheaper default when one exists, and follow your chosen model again after trying GPT-6 Astra.

  Tracks explicit summary (`compactModel`) and memory-save (`flushModel`) overrides separately from derived defaults (`provider-default`, `follow-chat`, `astra-fallback`) in `resolveRuntimeConfig`, persists explicit overrides, the provider's summary default as before, and `before_astra_model` while on GPT-6 Astra; it no longer persists a summary or memory model that only followed the chat model or the pre-Astra model, which is what made them stick. `config.yaml` names the explicit ones in `explicit_background_models`, written only when there is one. `loadConfigFromYaml` reads a file without that list, as older versions wrote it, by value: a `compact_model` equal to the provider's summary default or to the chat model is derived again (the provider's summary default where there is one, else the chat model), because older versions moved a `compact_model` equal to the chat model along with every model pick; a `flush_model` equal to the chat model follows the chat model; on GPT-6 Astra both are the model used before Astra; any other saved value stays explicit. `LLM_COMPACT_MODEL` and `LLM_FLUSH_MODEL` stay explicit.

- 7cb2cf2: User-facing: After your Mac wakes from sleep, your training data now starts refreshing within a minute if a scheduled sync was missed while it slept. Before, with the app window closed, it could stay out of date for up to six more hours.

  The six-hour store refresh now waits in steps of at most one minute and runs once the wall clock reaches the six-hour mark. Before, it waited on one timer for the whole gap. macOS does not count sleep time toward that timer, so a Mac that slept past the mark synced up to six hours late unless something else woke the coach. A wall clock set back a little no longer runs the refresh just before the mark and then again at it.

- f523d71: User-facing: If the coach turns a sync away before it starts, for example while it is getting ready for an update, the sidebar now offers Try again instead of a disabled "Sync unavailable" that asked you to quit and reopen Enduragent.

  The sync coordinator accepts an error reply that arrives before any progress notification as an operation failure the athlete can retry. It publishes that failure without refreshing the training context, since the coach ran nothing. A success with no progress is still a protocol fault, and an error after completed progress still is too. The desktop e2e fixture can take the coach's invocation coordinator, so a spec can close and reopen admission.

- e5cd8df: User-facing: When Enduragent can't read your Telegram settings, the Telegram row in Setup now says so and offers Retry, instead of offering Create as if no bot were set up.

  The Setup Telegram row now follows the Telegram settings state `{ status: "error", kind: "load" }`: the row shows the attention mark and the Settings pane's existing copy ("Telegram settings aren’t available. Keep the app open and try again."), and Retry (the existing `settings.telegram.retry` label) calls the Telegram settings port's `retry()`, which re-reads the status. Create is not offered, and an open bot setup panel cannot use a token or confirm a deletion, until a status read succeeds. No new copy.

- 0e2786b: User-facing: When intervals.icu asks the app to slow down during a sync, the app now waits a moment and tries the training-data check once more, so your training data still updates. Before, Sync now could end on "Sync needs attention", and a scheduled sync could leave your training data out of date until the next one.

  A 429 on the reference refresh's athlete, activities, wellness or events request now ends that run as `fetch_failed` with the Retry-After it returned, as ADR-0011 asks. The sync window then waits that long, at least one second and only when it is 30 seconds or less, and runs the reference refresh once more inside the same window and request budget. A second 429, or a longer Retry-After, ends the window as before, and the next scheduled sync tries again. A 429 on the athlete, wellness or events request no longer blocks coaching as if the data were invalid.

- 1799249: User-facing: Settings now shows live download progress, transfer size, speed, and a preparing step while Enduragent downloads an app update.

  Surfaces throttled download progress (percentage, transferred and total megabytes, and transfer speed) and a dedicated macOS preparing phase from the desktop updater through preload and IPC into the Settings Application card, with localized strings across all 17 supported languages.

- 47463fa: User-facing: Desktop app updates download only what changed since your previous version, now from a server close to you, so future updates finish faster.

  Both macOS and Windows release plans now emit `useMultipleRangeRequest: false` in `app-update.yml` so `electron-updater` asks for one byte range per request, which `updates.enduragent.icu` serves from its edge cache, instead of multi-range requests that older feed builds rejected with HTTP 502 and the current feed must fetch from GitHub range by range. `update-controller.ts` now wires a safe structured updater logger (`createSafeUpdaterLogger`) that records differential download plans, summaries, and fallback causes without leaking URLs, tokens, headers, or user paths, and a differential blockmap verification helper exercises `electron-updater`'s `computeOperations` and single-range download path.

- c12d9f1: User-facing: If the connection drops while a sync is running, Enduragent now checks the sync again by itself once it reconnects, so the sidebar and your training data catch up without pressing Try again. The sidebar now says "Connection interrupted. Enduragent will check the sync again when it reconnects."

  The window's connection provider gains `onConnectionOpen`, which fires after a new connection replaces one that was lost or retired, never for the first one. The sync coordinator asks the coach again at once when it is left on an interrupted sync with nothing running. When those re-asks keep getting interrupted, each next one waits longer (5 s, 30 s, 2 min, then every 5 min) until the athlete or first sync starts one again. The training context reads the athlete state again when its last refresh failed and no read of its own is running. Both stop listening when disposed. Old code-quality findings in the touched files are cleared without changing behavior.

- Updated dependencies [71a5e7d]
- Updated dependencies [df8343a]
- Updated dependencies [09a5e23]
- Updated dependencies [3adc44c]
- Updated dependencies [0bcd503]
- Updated dependencies [95d3c9a]
- Updated dependencies [d984b4f]
- Updated dependencies [2efcf2b]
- Updated dependencies [7cba733]
- Updated dependencies [cf69384]
- Updated dependencies [3436f66]
- Updated dependencies [75e77dd]
- Updated dependencies [78c0c28]
- Updated dependencies [dbe61e3]
- Updated dependencies [6b2d249]
- Updated dependencies [4383fe4]
- Updated dependencies [a88cdea]
- Updated dependencies [eefa039]
- Updated dependencies [aac85bb]
- Updated dependencies [7d6ed8b]
- Updated dependencies [c5b2b5e]
- Updated dependencies [a4187b3]
- Updated dependencies [bba219f]
- Updated dependencies [a6e5783]
- Updated dependencies [1949824]
- Updated dependencies [0c559cf]
- Updated dependencies [5de1cb7]
- Updated dependencies [9912a8c]
- Updated dependencies [1ebd764]
- Updated dependencies [d928eff]
- Updated dependencies [9f32ae9]
- Updated dependencies [c9a1cc7]
- Updated dependencies [3cb16f8]
- Updated dependencies [7cb2cf2]
- Updated dependencies [f15d20d]
- Updated dependencies [0e2786b]
- Updated dependencies [02c7694]
- Updated dependencies [1799249]
- Updated dependencies [c12d9f1]
- Updated dependencies [9ef4f21]
- Updated dependencies [b476f6d]
  - @enduragent/coach@0.2.0
  - @enduragent/coach-contract@0.3.0
  - @enduragent/i18n@0.4.0
  - @enduragent/coach-client@0.1.9
  - @enduragent/core@0.3.0

## 0.7.0

### Minor Changes

- b0c88aa: User-facing: You can now connect OpenRouter by signing in through your browser instead of pasting a key. Pasting an OpenRouter key still works, and Setup tells you when your OpenRouter account still needs credits.

  Setup and Settings gain an OpenRouter lane next to ChatGPT subscription. Sign-in uses OpenRouter's PKCE flow with a loopback callback on 127.0.0.1, or a code copied by hand when the browser cannot hand back. The key goes into the existing `openrouter` vault slot through the same write as a pasted key, and only an operation id, a phase, a closed refusal or the credit status reaches the renderer. The credit status comes from `is_free_tier` on `GET /api/v1/key` and is never stored. Intervals.icu now shares the loopback sign-in module in core.

- 0eb83f7: User-facing: When your OpenRouter account runs out of credits, Chat now says so and offers an Add credits button that opens OpenRouter's credits page. Your message stays in Chat, so you can send it again once you have added credits.

  Core classifies an HTTP 402, or OpenRouter's mid-stream `{ code: 402 }` error part, as the new `payment_required` failure ahead of the message-text heuristics. The engine turns it into the new `openrouter-credits` error kind only when the chat model runs on OpenRouter; a 402 from any other provider, and Telegram and the terminal, keep the generic message. The turn is not retried. Chat shows the message under the kept athlete message with Retry, and Add credits calls the existing main-process `openOpenRouterPage("credits")` bridge, so the renderer never builds a URL. The kind lives only on the in-memory turn, so after a relaunch the failed message shows the usual Retry without the credits text.

### Patch Changes

- c404a91: User-facing: You can now chat with your coach while your first training-data sync is still running. Before, typing a message or opening Settings during a long first sync could leave the app on "Connection interrupted" until you quit and reopened it.

  A sync no longer holds the store lane while an intervals.icu request is in flight. The backfill, the capture and the curve refresh fetch through the store runtime, which frees the lane until the whole response has arrived and takes it back before the next store step; the wait for the legacy refresh frees it too. Preference reads, setup status, chat drafts and chat turns now run between the sync's store steps. File imports and intervals.icu sign-in changes still wait for the whole sync. A coach call that times out now fails alone instead of closing the shared connection and failing every other call on it; a caller's abort and a protocol fault still close it.

- 2cbc4a5: User-facing: The Model list in Setup and Settings now shows every model's full name, and the check mark next to the selected model no longer covers its name.

  The open model list now grows to fit its longest name instead of matching its button's width, stays inside the window, and the button keeps its width.

- 0992b39: User-facing: Plan workouts that the app puts on your intervals.icu calendar no longer pile up as extra copies each time the app checks the calendar. Workouts with steps now show those steps and their training load in intervals.icu. Copies made by earlier versions stay on your calendar.

  intervals.icu replaces a client's `uid` with its own, so the calendar mirror could never find the events it had made: it created them again on every run and never verified. The mirror now marks its events with `external_id`, which intervals.icu keeps, and no longer sends `upsertOnUid`. It sends only the description, because intervals.icu keeps a client `workout_doc` as is and then cannot read it.

  The reconciler and the outside-edit check no longer compare `workout_doc`, nor the duration of a described workout, since intervals.icu derives both from the description. Adopting an outside edit no longer copies intervals.icu's `workout_doc` into the Plan. Plan calendar events stay outside the chat workout tools, now that their `external_id` is visible. Events made by earlier versions are not recognised or removed.

- aef6b47: User-facing: Moving to another ride while its analysis is still loading no longer interrupts a sync that is running or cuts off the coach's reply.

  The ride analysis passed an abort signal to `getActivityAnalysis`, and the coach client closes the window's whole shared connection on any caller's abort, so every other call on it failed. The analysis no longer passes a signal; a superseded load is dropped by its generation when its answer arrives. The client's abort behavior is unchanged.

- b0c88aa: User-facing: Settings now shows your new coach route and the Delete button for a newly connected AI provider right away, without leaving Settings and coming back.

  Every successful provider connection in Setup, pasted key, browser sign-in or reactivation, now refreshes the open Settings coach and credential panes in place, even when the Setup status refresh fails. The Coach pane keeps its current values until the new route arrives, keeps an unsaved model draft, and reloads after Review setup closed it.

- 78ecb9c: User-facing: When your rides come from imported ride files or are already saved on your computer, the Intervals.icu row in Setup now shows a green check and says your rides are saved, matching the "2 of 2 required ready" badge. Connect stays there if you want to sync new rides from Intervals.icu.

  The Setup training row now reads the same training-data readiness that the badge and Start coaching use. Without an Intervals.icu connection but with imported or kept rides, it shows a ready disc, a new `setup.training.subtitle.savedRides` subtitle (translated for every catalog), and keeps the Connect action.

- Updated dependencies [c404a91]
- Updated dependencies [b0c88aa]
- Updated dependencies [0eb83f7]
- Updated dependencies [0992b39]
- Updated dependencies [78ecb9c]
  - @enduragent/coach@0.1.9
  - @enduragent/coach-client@0.1.8
  - @enduragent/core@0.2.0
  - @enduragent/i18n@0.3.0
  - @enduragent/coach-contract@0.2.0

## 0.6.1

### Patch Changes

- 50a36f2: User-facing: After you sign in to intervals.icu again, today's plan now reaches your intervals.icu calendar the next time your plan refreshes. Before, the calendar could keep showing "Calendar sync failed." after you signed in again.

  While intervals.icu rejects the signed-in token, two calls that nobody asked for now wait for a working sign-in. Re-applying the same sign-in to a running coach no longer starts a store refresh, and the plan-calendar push leaves today's job untouched instead of using up its five attempts. Sync now still sends its requests, the first request after a coach start still detects the rejection, and a plain API key works as before.

- 2b129f8: User-facing: When Intervals.icu stops accepting your sign-in, you can now disconnect it in the app as well as sign in again.

  The Intervals.icu row in the "sign-in stopped working" state now offers Disconnect beside Sign in again. Disconnect uses the same confirmation, revoke attempt and local removal as the connected row, and afterwards the row, the Settings warning and the sidebar notice return to not connected.

- 2fd6f2e: User-facing: Setup and Settings no longer ask for your injury status, so you can start coaching as soon as your AI and training data are connected.

  The `injury-status` Setup row, its intake draft and persistence in the onboarding controller, the `saveIntake` RPC, the `intake` field of `getSetupStatus`, the kernel intake repository, and the `setup.intake.*` and intake error catalog keys are removed. Setup now has two required items. `PROTOCOL_VERSION` moves from 36 to 37. The `intake_flags` table and any row an earlier version saved stay in the store untouched; nothing reads or writes them anymore, and no migration runs.

- 16539a7: User-facing: If you start a new chat while writing your own answer to a coach question, the message box now comes back instead of staying hidden until you restart the app.

  The coach decision panel now reports its custom editor as closed when it unmounts, the same way the Plan editors do, so the chat view stops hiding the composer for an editor that no longer exists.

- 72e5255: While intervals.icu rejects the signed-in token, the six-hour store refresh skips its turn and logs `scheduled_store_refresh_skipped`. An owner check that is retried with a token already marked as rejected is refused without a request. That guards a daemon started with a signed-in token in its config or environment; the desktop app does not start its daemon that way. A new sign-in resumes the refresh, and Sync now still sends its requests. A plain API key syncs as before.
- 759c8d9: User-facing: The Windows app in the Microsoft Store now installs on Windows 10 as well as Windows 11.

  The Store package's minimum Windows version drops from `10.0.22000.0` to `10.0.19041.0`. CI now registers the Store package on a Windows Server 2022 runner (build 20348, below Windows 11) and runs the packaged self-test against its executable.

- Updated dependencies [50a36f2]
- Updated dependencies [2fd6f2e]
- Updated dependencies [72e5255]
  - @enduragent/coach@0.1.8
  - @enduragent/coach-contract@0.1.7
  - @enduragent/coach-client@0.1.7
  - @enduragent/i18n@0.2.5
  - @enduragent/core@0.1.11

## 0.6.0

### Minor Changes

- 2f95252: User-facing: Connect intervals.icu by signing in with your browser instead of copying an API key.

  The intervals.icu row in onboarding and Settings now offers "Sign in with Intervals.icu". It opens the intervals.icu consent page, shows "Waiting for browser…" with "Cancel sign-in" and "Open the sign-in page again", then "Completing sign-in…" while the main process verifies the account against the training history on this Mac and stores the token in the encrypted vault, and finally "Connected as <name>". The clipboard paste channel is removed. API keys saved before this change keep working. Closing the setup surface cancels a sign-in that is still waiting for the browser.

### Patch Changes

- 4cdb8f3: User-facing: The Mac app has a new icon, three riders in an echelon, in the Dock and the menu bar.

  Replaces the teal "e" app icon with the E0 mark on Asphalt. `app-icon.png` and `app-icon.svg` now follow the macOS icon grid (an 824 px rounded square with a shadow on a 1024 px canvas), and the menu-bar templates are drawn on whole pixels at 16 and 32 px. Windows icons now come from the full-bleed `app-icon-windows.png`, so the 16 px tray frame is not shrunk by the macOS padding. The README header shows the horizontal lockup, with a light and a dark version.

- 8798eb3: Bump Electron from 44.4.3 to 44.9.1 to fix a pointer-lock permission request that could be attributed to the wrong frame. Bump Vite from 7.3.6 to 7.3.7 in `apps/desktop` and `apps/desktop-renderer` to pick up the patched `launch-editor`, which fixes three Windows advisories in the dev server's open-in-editor route. Vite runs only during development and builds, so the Vite bump does not change the shipped app.
- 29e7393: User-facing: Disconnecting Intervals.icu now also removes Enduragent's access on Intervals.icu, and the app asks you to sign in again if Intervals.icu stops accepting your sign-in.

  Disconnect in Settings now revokes the signed-in token on intervals.icu (`disconnect-app`) through a scoped vault read, then deletes it locally even when the revoke fails, and the result line says which happened. A plain API key is only removed locally. Core tracks bearer credentials that intervals.icu rejects: a 401 marks the credential, a 403 is confirmed with one probe of the athlete endpoint, and any successful response clears it. The runtime config snapshot reports this as `intervals.credential_rejected`, and the renderer shows "Sign in again" on the Intervals.icu row and in the sidebar footer.

- 0f98543: Correct the two `@resvg/resvg-js` 2.6.2 Windows integrity hashes in `pnpm-lock.yaml` so pnpm installs `@resvg/resvg-js-win32-x64-msvc` on Windows, and let the Windows package verifier accept that one native module, which electron-builder unpacks to `app.asar.unpacked`. The verifier accepts it only at `node_modules/@resvg/resvg-js-win32-x64-msvc/resvgjs.win32-x64-msvc.node`, in the ASAR index and on disk, only as an x64 PE binary, and only when a runtime package declares `@resvg/resvg-js`. Every other native module is still rejected. Without the binary, the Telegram workout review could not render its chart on Windows.
- 9cc7ea2: Add `package:win-store`, which builds an unsigned x64 AppX for Microsoft Store submission from the Partner Center identity in `ENDURAGENT_STORE_IDENTITY_NAME`, `ENDURAGENT_STORE_PUBLISHER`, and `ENDURAGENT_STORE_PUBLISHER_DISPLAY_NAME`, with tile images generated from the Windows app icon. When the app runs from a Store package (`process.windowsStore`), it never becomes update-eligible, keeps the package's own AppUserModelID, and leaves the start-at-login item out of the tray menu. The Windows CI job builds the package with a synthetic identity and checks its manifest. Nothing ships to the Store from this change.
- Updated dependencies [edd9d10]
- Updated dependencies [29e7393]
- Updated dependencies [2f95252]
- Updated dependencies [4346aa2]
  - @enduragent/core@0.1.10
  - @enduragent/i18n@0.2.4
  - @enduragent/coach@0.1.7
  - @enduragent/coach-contract@0.1.6
  - @enduragent/coach-client@0.1.6

## 0.5.9

### Patch Changes

- 5ca1eb3: The macOS release verifier now adds the last lines of `codesign`, `stapler` or `spctl` output to its failure message, so a failed signing or staple check says why it failed.

## 0.5.8

### Patch Changes

- 1cb7f32: User-facing: Norwegian, Swedish, and Chinese training messages now use plain words for fitness, fatigue, and form.
- d4be2cf: User-facing: A wellness day that leaves out weight, resting heart rate, heart-rate variability, or sleep is no longer skipped.

  `WellnessDaySchema` required `weight`, `restingHR`, `hrv`, `sleepSecs` and `sleepQuality` to be present, so a day that omitted one failed to parse and was dropped. The five keys now default to `null`. First of six changes for #1130.

- 0852155: User-facing: If a sync cannot keep any of the wellness days it fetched, the coach now says the sync failed instead of saying you have no data.
  User-facing: If a sync keeps only some of the wellness days it fetched, the coach now says how many of the days you asked about are missing.

  `laneHealth` reads a lane's report as `ok`, `partial` or `lost`, and `judgedDrops` lists the drops it judges: every drop except rows the provider withheld, with recordings whose download failed left out. `laneStanding` pairs that health with the civil dates of the judged drops. `runReferenceCapture` returns the report beside the manifest. The store runtime logs `capture_lane_lost` or `capture_lane_partial` with the lane, its counts and up to five judged drop lines, still publishes the capture, and hands the wellness lane's standing to the store reader. The reader answers a lost lane with `wellness_unreadable`, and a partial lane with a `notice` that counts only the dropped days inside the requested range. A dropped row without a civil date is logged and adds no notice. The capture command prints one line per lane that dropped a row, with `dropped=` for judged drops, `withheld=` for rows the provider withheld, `first_drop=` taken from the judged drops and `first_unfetched=` for a failed request. It exits 3 when a lane is lost, and reads the failure category through the store writer's wrapper. A capture named by `--replaces` is loaded and replayed before the first request and the first store write, and a capture that cannot be is refused with nothing written. The store runtime logs that refusal as `capture_replacement_refused` with the capture id. Sixth of six changes for #1130.

- 1e3c8f9: User-facing: Wellness days sync again, so the coach can see your resting heart rate, heart-rate variability, and sleep.
  User-facing: A fatigue score you log yourself is kept apart from your training-load fatigue in synced days.

  Every path that turns a platform wellness day into a `WellnessDay` now goes through `decodeWellnessRow`: capture, the paged pull, the stored projection, the legacy sync, capture replay, and the two fixture tools. The raw fetch tool `tools/fetch-real-athlete.ts` still writes days as the platform sends them. `landWellnessRow` in the sync package turns one wire day into its archive identity and its typed store row. The store column `fatigue` holds only the self-reported score, and the field archive keeps the load averages under `load`. `renameTpFieldsOnWellnessRow`, `parseRenamedWellnessRow` and the injected wellness decoder are removed. A day with a value that cannot be stored is rejected whole. The paged pull names the key of a value it cannot store, and the fixture tool names the key of a day it cannot decode. Capture still skips that day without a count until the next change adds the per-lane report. Third of six changes for #1130.

- aae19b5: User-facing: The coach now tells a fatigue score you log apart from your training-load fatigue when it looks up wellness straight from intervals.icu.
  User-facing: The coach's wellness lookup now includes fitness and weekly fitness change for synced days.
  User-facing: The coach now says when some wellness days could not be read.

  `decodeWellnessRow` moves the score intervals.icu sends under `fatigue` to `subjectiveFatigue`, renames the load averages, and parses the day. It rejects a row that already carries a coach-only key, a row that still holds a platform load key after the renames, a score that is not a whole number, and a load average that is not a number. The live reader decodes each row, so `intervals_fetch_wellness` and the athlete snapshot read coach words in live mode. A row that cannot be decoded is skipped with a `notice` that names the first unreadable wellness field of each skipped day. A day skipped for a platform load key or for not being an object is counted but not named; when none can be decoded the read fails with `wellness_unreadable`. Stored days are unchanged, but the tool's key list now passes `fitness` and `weeklyFitnessChange` for them. Capture, projection and the legacy sync still use the rename and parse pair. Second of six changes for #1130.

- Updated dependencies [1cb7f32]
- Updated dependencies [1b37d2b]
- Updated dependencies [129a0d1]
- Updated dependencies [0852155]
- Updated dependencies [1e3c8f9]
- Updated dependencies [aae19b5]
  - @enduragent/i18n@0.2.3
  - @enduragent/coach@0.1.6
  - @enduragent/core@0.1.9

## 0.5.7

### Patch Changes

- f6b439c: User-facing: On a Mac, Restart appears only after an update is ready to install. If preparation fails, the app stays open so you can try again. Install this version once by hand if the app you have now cannot update itself.

## 0.5.6

### Patch Changes

- 313e2b9: User-facing: Settings Setup shows the AI that powers your coach in the first row, and no longer lists that same Active credential again underneath.

## 0.5.5

### Patch Changes

- 6e57252: User-facing: Setup and Settings keep the usual model list when a saved catalog update would have left providers empty.

  A higher-revision installation snapshot with only a Synthetic provider previously beat the bundled catalog, so a selected provider such as OpenAI Codex became custom-only with no models. Live candidate evaluation and local snapshot selection now skip catalogs that drop bundled suggested providers.

- fcf49e8: User-facing: After you reopen Chat with a stopped coach reply, the notice again explains that the response stopped and still offers Retry beside that copy.

  `queue-snapshot` restores `progress` with `CHAT_RESPONSE_STOPPED_COPY` when it hydrates `retryRequired`. `projectTurnRecovery` uses that copy when Retry is offered and no other notice exists.

- 3e71af4: User-facing: Restarting to install a downloaded Mac update now finishes instead of staying on Restarting.

  On darwin, electron-updater 6.8.9 MacUpdater only feeds the zip to native Squirrel.Mac during download when `autoInstallOnAppQuit` is true. The previous `false` setting left `squirrelDownloadedUpdate` false, so `completeInstallAfterDrain` → `quitAndInstall` used the deferred native `checkForUpdates` path after drain. That returns `"started"` without `app.exit` and without launching ShipIt (live: 0.5.2 still running, zip in updater cache, ShipIt logs stale). Windows/Linux BaseUpdater still keeps `autoInstallOnAppQuit` false so an ordinary quit does not install.

- Updated dependencies [6e57252]
  - @enduragent/core@0.1.8
  - @enduragent/coach@0.1.5

## 0.5.4

### Patch Changes

- b7227db: User-facing: macOS release verification and catalog extract no longer fail on large signed zips.

  Notes-only follow-on to #1075 (`4fe61753`). Signed macOS zip extract now streams `app.asar` past `unzip` stdout maxBuffer so Version Packages can ship `@enduragent/desktop@0.5.4`. Does not retarget `enduragent-desktop@0.5.3`.

## 0.5.3

### Patch Changes

- 514f5f9: User-facing: Model limits, image support, and usage costs now remain consistent while Enduragent refreshes its model information.
- e7bc80f: User-facing: Setup and Settings now list newer models, including GPT-6 Astra, Claude Fable 5.1, and Gemini 3.8 Flash.
- 07f1aa9: User-facing: Chat keeps Plan reviews and coaching choices in conversation order after reopening, with notices that return you to anything still waiting for your review.
  User-facing: After your training data syncs, the sidebar shows a compact Sync action without repeating completion details.
- bc98674: User-facing: If a chat send fails, the warning and retry sit on your message as icons, not a separate Retry button under it.
- 30d7740: User-facing: If a chat send fails, Chat keeps your message in the thread with a warning and Retry, instead of moving it into Queued messages.
- f349e78: User-facing: When the coach cannot answer, such as a rate limit, Chat pins a red notice under the header with a Retry button beside it, and the Training context sidebar again lines up with the header.
- 1c46a93: User-facing: Chat tells you when Send is still connecting, and if a draft couldn’t save it says your message is still in the box.
- 161d07c: User-facing: Chat no longer shows a leftover “Couldn’t reach the coach” line after Send turns on.
- 922c4ad: User-facing: Setup and Settings now show the latest accepted models while keeping an open model choice stable until you finish.
- 85e9979: Pin one validated model catalog snapshot per source commit across npm, GHCR, macOS, and Windows release artifacts.
- 07f1aa9: User-facing: If saving a message draft is interrupted, Chat now says the draft is still available in the current window instead of claiming an attachment failed.
- 07f1aa9: User-facing: A training data sync now stays connected if another part of the app reconnects at the same time.
- eb282e3: User-facing: When Strava hides rides, Enduragent now says Strava does not allow third-party AI tools to use that data, and links to a help page on how to get those rides.
- 45c904f: User-facing: Enduragent now starts when chat history folders were created with looser permissions, and tightens those folders so only you can read them.
- Updated dependencies [514f5f9]
- Updated dependencies [2ab873b]
- Updated dependencies [e7bc80f]
- Updated dependencies [600295a]
- Updated dependencies [922c4ad]
- Updated dependencies [07f1aa9]
- Updated dependencies [45c904f]
  - @enduragent/coach@0.1.4
  - @enduragent/core@0.1.7
  - @enduragent/coach-contract@0.1.5
  - @enduragent/coach-client@0.1.5
  - @enduragent/i18n@0.2.2

## 0.5.2

### Patch Changes

- 69d56c1: User-facing: Your daily spending cap now saves automatically when you leave the field or press Enter. Invalid or incomplete values stay unsaved so your existing cap remains active.
- 4a2012d: User-facing: Setup no longer shows a separate Claude subscription status row.
- 0bf9483: User-facing: Settings no longer shows the Training account section or athlete ID editor. Your connected account stays saved and remains manageable in Setup.
- baf483d: User-facing: Attachments and queued messages now share one rounded composer, and your latest chat message stays fully visible above it.
- 52532e6: User-facing: Your saved color palette stays selected when its name changes.
- d3b69ee: User-facing: Training sync status is now easier to scan. Successful syncs no longer show a date, and Sync now stays hidden while a sync is in progress.
- 3610880: User-facing: Telegram setup now stays collapsed until you choose Connect. Cancel or returning to Settings brings back the compact connection row.
- c75c305: User-facing: Conversation settings now show only your timezone and save a valid timezone when you leave the field or press Enter. Your existing conversation timing and history preferences stay unchanged.
- 76b59b4: User-facing: Your coach provider and model choices now save automatically. Custom model names save when you leave the field or press Enter.

## 0.5.1

### Patch Changes

- a1f4c72: User-facing: Desktop can check for and install updates again.

## 0.5.0

### Minor Changes

- a372f86: User-facing: Send /feedback plus a short note from Telegram or Desktop. It goes to the Enduragent authors, not to the coach.

### Patch Changes

- Updated dependencies [a372f86]
  - @enduragent/coach-contract@0.1.4
  - @enduragent/core@0.1.6
  - @enduragent/i18n@0.2.1
  - @enduragent/coach@0.1.3
  - @enduragent/coach-client@0.1.4

## 0.4.1

### Patch Changes

- 7d4f827: User-facing: Versions 0.3.0 and 0.4.0 cannot update themselves. Download the latest macOS installer from https://enduragent.icu/download/mac. This version and later will check for updates again.

  Packaged `app-update.yml` now points at `https://updates.enduragent.icu/`, a Cloudflare Worker that follows GitHub Releases latest/download redirects on the server and returns YAML and artifacts with no `Location` header. GitHub remains the canonical publish target. Installed 0.3.0 and 0.4.0 builds still use the GitHub URL and cannot self-heal.

## 0.4.0

### Minor Changes

- e62bd9b: Catalog desktop dialogs, file pickers, and tray copy, and render fixed coach messages in the selected language.

  User-facing: Desktop dialogs and fixed coach replies follow your language preference when translations are available. Your original conversation text stays saved.

- 9e501ea: User-facing: The desktop app now ships the system menus and the Windows installer in all 17 supported languages.
- 9c07855: User-facing: Chat, including the plan cards, notices, and the composer, now appears in your chosen language.
- 1f41fe7: User-facing: Setup, Settings, the sidebar, and past conversations now appear in your chosen language.
- 602dd8c: User-facing: The Training and Plan pages now appear in your chosen language, with counts and dates written the way your language expects.
- 3e9e0e4: User-facing: On first launch the app asks for your language when your computer's language is not one it speaks, and Settings preferences now show in your chosen language.

### Patch Changes

- 2354437: User-facing: Attached PDFs are read in full up to the size limit instead of half, and the coach is told plainly when a document was cut.
- 6454dc5: User-facing: Chat leaves space between the last coach message and the card or message box below it.
- 32a54c4: User-facing: While the coach is writing a reply, Chat shows a spinner and Coach is working… without a box around it.
- 5a9f738: User-facing: Replies now appear word by word while the coach is still writing, on ChatGPT sign-in as well as API keys.
- 784f692: User-facing: Cards above the message box now keep a consistent gap, so questions, attachments, and queued messages stay visually separate from the composer.
- d65e701: User-facing: The coach checks typed event details, success measures, training commitments, and plan changes, then asks you to confirm before using them. If a check fails, you can retry or cancel.
- c090b3e: User-facing: Saving your conversation to memory is faster and cheaper because the coach only reviews what is new since the last save.
- f09f4e4: User-facing: The coach already knows your profile and today's wellness when you start typing, so replies come faster and cost less.
- ae70f69: User-facing: If ChatGPT is still looking something up, a slow reply can retry instead of stopping on the first words. A memory save that fails during a long chat is retried after you reopen the app. Garmin labels stay on the facts they belong to.
- aff777d: User-facing: When you ask the coach about something you told it before, it finds the exact note and shows your most recent notes first.
- 47a8e77: User-facing: When the coach could not use a typed commitment, the card asking you to answer again or skip stays above the message box until you deal with it.
- 074740b: User-facing: Long conversations cost less on API-key providers because earlier messages are reused from cache instead of being resent.
- 250632d: User-facing: Chat keeps the newest message in view while a plan is being created. Status and Discard live in the Chat header.
- 025d173: User-facing: When a typed commitment needs clarifying, the Clarify your commitment card now sits right under the Plan creation progress card, next to the Build Draft button it holds back.
- f767b66: User-facing: If you close the app right after the first chat of the day, what you told the coach is still saved to memory the next time you open it.
- 35966d7: User-facing: Chat content now lines up with the message box, with no extra padding above the composer.
- 7972d4c: User-facing: Deep ride reviews load faster because the coach no longer downloads thousands of second-by-second data points it was told not to use.
- b30d963: User-facing: Long conversations recover from slow replies more reliably, and the app no longer pauses to tidy its log on every line it writes.
- Updated dependencies [5ecffcc]
- Updated dependencies [e62bd9b]
- Updated dependencies [c090b3e]
- Updated dependencies [a30364f]
- Updated dependencies [ae70f69]
- Updated dependencies [aff777d]
- Updated dependencies [f767b66]
- Updated dependencies [9c07855]
- Updated dependencies [1f41fe7]
- Updated dependencies [602dd8c]
- Updated dependencies [3e9e0e4]
- Updated dependencies [b30d963]
  - @enduragent/core@0.1.5
  - @enduragent/i18n@0.2.0
  - @enduragent/coach-contract@0.1.3
  - @enduragent/coach@0.1.2
  - @enduragent/coach-client@0.1.3

## 0.3.0

### Minor Changes

- be70e9b: Add a Language row to desktop Settings preferences.

  User-facing: Settings now has a Language choice above Units. Automatic follows your computer's language, or pick one of 17 languages for the app and the coach.

### Patch Changes

- 68151cd: The macOS release lane reads the Electron fuse constants through the package's CommonJS entry points and exits non-zero when any release stage fails.

## 0.2.0

### Minor Changes

- 4ffaf59: Add a language preference and make the coach reply in it.

  User-facing: Choose your language with /language in Telegram and the coach answers in that language. With no choice saved, the coach follows the language you write in. The desktop Settings control arrives with the next release.

### Patch Changes

- 39902fa: User-facing: A reviewed Draft can now become your active Plan. Activating closes any Plan that was running and keeps your answers with the new Plan.
- a9f8a64: User-facing: Aligned the AI setup choices with their menu heading.
- 8f6a401: User-facing: Prevented Enduragent from deleting its encryption key when credential storage cannot be safely inspected.

  Credential envelope scans now bind both vault roots before automatic Keychain key retirement and
  fail closed when either root is unsafe or changes during the scan.

- c00a360: User-facing: Prevented unsafe credential files or a changed macOS Keychain key from making saved credentials unreadable.

  Automatic key retirement now requires a bounded, stable cross-vault census, and every credential write revalidates the persisted key without user interaction.

- 09c5ca3: Refresh runtime dependencies, including XML parser security fixes and desktop updater compatibility updates.

  User-facing: This update improves the safety of imported files and refreshes the libraries used for coaching and app updates.

- b2ddccb: User-facing: Plan creation in Chat can now build a Draft from your answers, with every week and Workout laid out under your confirmed limits. The Draft keeps the answers it was built from when you edit them.
- 2e60bfc: User-facing: Kept credential recovery available when secure storage or its local inventory cannot be inspected safely.
- 78ff76f: User-facing: Prevented locked or inaccessible macOS Keychain items from deleting stored credential keys.
- ccfee17: Attach supported documents, activities, planned workouts, and images to Coach messages while keeping drafts and file processing local.
- c4d7395: Restore sent attachment cards after relaunch and harden attachment cleanup, recovery, and privacy-safe diagnostics.
- 92ca64a: User-facing: Added a standard Coach decision panel for important training choices, with custom answers, Skip, saved consequences, and relaunch recovery.

  Important coaching choices now remain blocked until answered or skipped, and interrupted continuations resume once after relaunch.

- 6f68281: Stop showing the retired file-based plan to the coach once Plans are managed in Chat.

  User-facing: Once you start creating a Plan in Chat, the coach no longer reads your old saved plan file, so its advice is based on the Plan you manage in Chat.

- b38ae00: User-facing: Coach answers can now offer a safe Continue in Plan card, resolve Workout date conflicts, retry failed handoffs without duplicates, and recover a Proposal when a local Plan save fails.

  Chat keeps typed Plan handoffs with their transcript turn, while Plan protects athlete-created Workouts and requires review before applying a new date or replacing a coach-owned Workout.

- 66579e6: User-facing: Chat safely resumes unfinished Plan handoffs after relaunch. Deleting Chat attachment data keeps delivered Plan work and its compact origin record intact.
- 21ab9fa: User-facing: Selected Workout files can now open a durable review in Plan, and Chat keeps a read-only card that returns to the same request after relaunch. Completed Plan requests can return to their exact Chat card.
- 8c20aef: User-facing: Workout handoffs from Chat now open the same reviewable Plan Proposal after retries or relaunch, while Draft and Plan-creation requests continue in their exact Plan conversation.

  Planning stores the destination artifact and request relation together, preserves date conflicts for review, and keeps delivery retryable when destination intake is temporarily unavailable.

- 7df1924: User-facing: Added a read-only Plan destination and current Plan details to Chat’s Training context.

  Planning now owns the strict current-Plan, current-week, and Workout projection used by Desktop; Chat can navigate to the relevant Plan context but cannot mutate Plan data.

- 2dee7a4: User-facing: Added read-only current Plan, current week, and Workout cards to relevant Coach answers, with one Open Plan action.

  Plan cards are host-owned typed projections, persist only their Planning reference, re-resolve against current Plan data after relaunch, and never mutate Plan, Calendar, or Training from Chat.

- dc24ae3: User-facing: Applying or rejecting a Chat-originated Plan Proposal now records the matching Chat result atomically, so relaunch cannot show a stale or contradictory handoff.

  Planning keeps revised Proposals attached to their originating request, rolls back the complete Plan change when terminal-result storage fails, and leaves calendar mirroring separate from local success.

- 1e07590: User-facing: Queued messages with only an attachment now keep that attachment when retried after reopening Chat.
- dfba9a5: User-facing: Redesigned Chat as a calmer Reading room with Training context, a clearer composer, and a Stop control that preserves partial responses.

  Stopped responses now remain in conversation history after relaunch, and the shared Coach connection stays available for the next message.

- 47e4cd2: User-facing: New chat remains available when messages are queued or the Coach is waiting for an answer, and an uncertain reset keeps the entire conversation intact.
- 8a4e3ff: User-facing: Stopped Coach responses now keep Retry clearly grouped with the interruption message and separated from queued messages.
- 7291940: User-facing: Chat keeps your reading place when a response continues while you visit another page.
- 2d09c46: User-facing: Past chats can now be permanently deleted with clear confirmation while imported activities and Plan work stay intact. Chat also keeps its safety note visible when cards stack up, orders those cards consistently, and closes the compact Training context drawer reliably from the keyboard.
- 31432c5: Keep the signed macOS backend-selection probe free of dependency deprecation output.
- 0ee56e2: User-facing: Failed macOS secure-storage setup no longer leaves an unusable encryption key behind.
- ba1b6ae: User-facing: A credential reset finished while Settings is closed no longer keeps a stale repair prompt for the next open.
- 68bf244: Read selected activity files during processing and traverse XML without recursion.

  User-facing: Importing a batch of activity files uses less memory. Deeply nested GPX and TCX files no longer interrupt the import with a stack error.

- f191262: User-facing: After a long conversation is condensed, the coach no longer re-reads the same condensed notes twice on every message that day.
- 390823a: User-facing: Activate your reviewed Draft from Chat. The coach asks you to confirm first and tells you when a running Plan will close.
- 0e37ca0: Add schema-valid Plan and populated Training inspection fixtures for isolated desktop development.
- 795fccf: User-facing: Saved queued Chat messages across app restarts, added explicit recovery actions, and now keeps a queued message visible with an error when removal cannot be saved.
- 0d27009: User-facing: Activating a Plan now double-checks the Plan it replaces, Chat-created rides reach intervals.icu as Ride events, past and completed Workouts stay untouched by later Changes, and a stopped Plan's final details keep their calendar status fresh with a Retry button.
- 7a8e703: Plan Changes now respect confirmed commitments for Supporting Events and daily choices, keep Undo consistent with kept Workouts, ignore stale typed requests after a cancel, and give typed requests enough time. Plan creation reads no longer write derived answers, the activation dialog shows the calendar window in the athlete's timezone, legacy Plan authoring is closed, ordinary chat returns after a Change, paused submissions keep the typed text, and Continue resumes a creation while a Change is pending.

  User-facing: Changing your Plan in Chat now honours your confirmed time off, keeps typed requests after a relaunch, and lets you go back to normal chat once a change is done.

- 584b01b: User-facing: Training now uses a compact ride-import control without an extra file-selection message and ends after your recent rides. Ride review shows recorded analysis without the ride-export card.
- 3627ecd: Distinguish confirmation guard refusals and returned failures from completed changes.

  User-facing: When a workout can no longer be changed, the coach explains why instead of saying it is done.

- ae481be: Visible desktop test-harness windows no longer pin the page to a fake fixed viewport, so resizing the window resizes the app.
- 9d86d76: User-facing: The coach answers first and saves notes to memory afterwards, so the first message of the day and long conversations no longer wait on housekeeping.
- 4ab3aab: User-facing: Fixed saving credentials failing with "encryption unavailable" on macOS.
- 87455a5: Replace the macOS tray popup with a native action menu and add a Settings shortcut.

  User-facing: Click the menu bar icon to open Enduragent, go to Settings, choose whether it starts at login, or quit.

- 204820a: User-facing: Credential deletion on Windows and Linux now protects another athlete’s Telegram profile and keeps credentials that cannot be restored.
- 48f6422: User-facing: Diagnostic logs now hide sensitive error text and credential-bearing URLs. Secret helper failures show an exit code and setup guidance without exposing helper output.
- f7b776b: User-facing: Review every week and Workout in your Draft in Chat before activation. You can edit your answers and rebuild while keeping the earlier Draft available for comparison.
- 8d5e9df: User-facing: Removing credentials no longer marks an environment-managed provider as needing repair.
- db15233: Use shared presentation components in Chat, Training, and Plan while retaining application-owned behavior.

  User-facing: Cards, questions, workout rows, and training summaries use consistent styling. Your conversations, training calculations, and Plan actions work as before.

- 3627ecd: Retain unsummarized conversation history after compaction failures and stop when it cannot safely fit.

  User-facing: If a conversation summary fails, the coach keeps the original context or asks you to try again instead of silently forgetting earlier goals and corrections.

- 2a2c852: User-facing: The usage log now counts cached tokens once, so the cost it shows for API-key providers matches what the provider bills.
- f3a8b51: User-facing: Adding more than five files now keeps the first five. Pasted images show as `Pasted image.png`.
- 0aec54a: User-facing: On Linux, Enduragent now starts its local service itself when none is running instead of reporting that it could not reach the service.

  Registration reads treat Linux like Windows: app-supervised with no launchd registration, unless a caller supplies an explicit registration state. The isolated development profile binding also accepts Linux, so the Linux desktop E2E job runs the same startup path as the packaged macOS fixture.

- 9ed12a5: User-facing: The Plan page can now read your unfinished Plan creation, your active Plan, and your closed Plans together.
- 3077144: User-facing: Your coach can remember decisions as you share them without saving duplicates, and find earlier versions of your stored information. Memory reads avoid repeating the athlete details already shown to your coach.
- 5ba9576: User-facing: Coach responses in Chat now use the intended compact text size and line spacing.
- 3627ecd: Clarify the training-data setup subtitle.

  User-facing: Setup now says you can connect a service or import ride files.

- 69e5ec7: User-facing: Plan approval now activates locally first, then updates only today and the next six days in Intervals with visible retry and verification controls.

  Interrupted calendar updates resume safely after relaunch without duplicating workouts.

- dcf7366: Mirror Chat-owned Plans to intervals.icu: activation, changes, and stops enqueue calendar work that runs in the background, and the Plan library reports its calendar state.

  User-facing: Workouts from a Plan you start or change in Chat now appear on your intervals.icu calendar for the coming week, and stopping a Plan removes the ones from tomorrow onward.

- ccbecf6: User-facing: Your Plan now shows whether its dated Workouts are up to date on your calendar, still updating, or waiting for a connection. You can retry a failed calendar update and check cleanup after stopping a Plan.
- 5b5a1c3: Add Plan Change previews and confirmed apply for the five Schedule intents to the coach service.

  User-facing: The coach can now show you exactly which future Workouts would change when you limit a weekday, keep a day free, avoid hard training on a day, cap your weekly hours, or cap your longest ride, and it only changes your Plan after you confirm.

- 79299e5: User-facing: Choose an eligible Workout for today from your flexible Plan, review its date, and confirm when ready. Undo returns the Workout to its undated state.
- dda55c6: User-facing: Choose an eligible workout for today in a flexible Plan after reviewing the change. Undo returns it to the undated choices.
- abd69af: User-facing: Add, edit, rename, or remove Supporting Events with a preview before changing your Plan. See the event details and Undo your latest change.
- dbc5305: User-facing: Preview and confirm supporting event changes to adjust your training around an event. Important events shorten nearby workouts, and Undo restores your previous Plan.
- 68fc766: Correct your FTP from Chat and see the power each Workout will use.

  User-facing: Choose Correct FTP in the Plan Change editor, enter your watts, and review which Workouts change and which FTP sources the coach compared before you confirm.

- 7cba66d: User-facing: Correct your FTP through a previewed Plan Change to update future workout power guidance and save your FTP. Undo restores the previous Plan values.
- ae1cbb1: User-facing: When you ask the coach to change your plan in chat, it understands weekdays, session lengths and weekly hours more reliably.
- 09ddb36: Refuse training increases in the final week before your goal event.

  User-facing: In the final week before your goal event, you can reduce your training but cannot add longer or harder workouts before the event.

- c2d5ea2: Preview and apply Plan Schedule changes from Chat.

  User-facing: Ask for one schedule change to your active Plan, such as a shorter Wednesday or a free weekday, review the exact Workouts it would touch, and apply or cancel it.

- 6eb0b3a: Show why Plan Changes are paused when training data is stale.

  User-facing: When your training data has not synced for over a day, Chat tells you Plan Changes are paused, keeps your pending preview safe, and lets you know when sources are available again.

- 60a0354: Pause Plan Changes while synchronized training is older than 24 hours.

  User-facing: If your connected training data has not synced for more than a day, Plan Changes wait until you refresh the connection, so the coach never changes your Plan on stale information.

- ee26271: User-facing: Type a change while reviewing your Plan changes to preview it before confirming. Requests that cannot be handled explain why, and separate changes must be requested one at a time.
- 841763b: User-facing: You can preview a Plan change from a written request. Ask for one change at a time and confirm the preview before your Plan changes.
- 1f1cdbc: Prepare Undo for the latest applied Plan Change as a previewed inverse.

  User-facing: The coach can now work out the exact opposite of your latest applied Plan Change so you can review and confirm it before anything moves back.

- 918f2ae: Undo the latest applied Plan Change from Chat after reviewing the exact reverse.

  User-facing: Your latest applied Plan Change now has an Undo button. It shows you exactly what would move back, leaves completed and past training alone, and changes nothing until you confirm.

- 7d87aae: Add Plan closure, automatic completion after the final day, and final history reads to the coach service.

  User-facing: Your Plan finishes on its own the day after its last week ends, and the coach keeps its final training readable.

- 2871fe2: Add the Stop Plan dialog, closed Plan history reading, and host-driven completion to the Plan page.

  User-facing: You can stop your active Plan from the Plan page, and every closed Plan keeps its final training readable in the library.

- 4cb231f: User-facing: Add or skip a GPX/FIT Race Course while creating a Plan, recover from invalid or elevation-free files, and recalculate Drafts without changing the active Plan.
- 4f47a7a: User-facing: Review the exact limits understood from your written commitments before confirming them. You can clarify or cancel a correction, and your last confirmed limits stay in place until you confirm.
- 383312b: Block Plan activation until written commitments are acknowledged.

  User-facing: When you type fixed commitments or time off that the Draft could not fit into Workouts, the Plan waits for you to confirm those limits before it activates.

- e7e53cf: User-facing: Your written scheduling limits and time off now shape your plan after you confirm them. Unclear limits wait for clarification, and cancelling a correction keeps your previous limits.
- 972adbe: User-facing: Start creating a training Plan by chatting with the coach: confirm your goal and what success means, and pick up where you left off after restarting the app.
- 918600a: User-facing: Answer the essential Plan questions one at a time in chat by picking from clear choices or writing your own answer, change an earlier answer with Edit, and come back later to pick up where you left off.
- 9a9665f: Add a confirmation before discarding unfinished Plan Creation work in Chat.

  User-facing: Discard an unfinished Plan you started in chat without affecting your current Plan or your chat history.

- b33490d: User-facing: Choose a Plan start date in a compact calendar, review full or short-block consequences, safely retry recalculation, and approve the completed Draft.
- 07b0a8d: User-facing: The active Plan now shows race-day Form and goal feasibility at a glance, with clearer race-week and readiness details. Ended Plans can open their saved coach conversation as read-only history.
- 851e7eb: User-facing: Added manual and Intervals FTP resolution to Plan creation, including source precedence, retry recovery, and automatic return to Draft planning.
- 36e7041: User-facing: Plan now keeps an immutable change history and lets you undo only the newest eligible future coach-owned Workout change.
- 696f1d4: Plan-in-Chat surfaces now follow the prototype: question cards carry Later in the header, the progress card shows Discard as a button, choice rows omit filler details, the availability weekdays are a labelled fieldset, Draft and Change cards use the prototype's spacing and status pills, compact layouts stack facts, and scroll areas no longer show permanent scrollbars.

  User-facing: Plan cards in Chat use consistent dates, shorter choices, and clear calendar status. Repeated notices and labels have been removed.

- 5da0e88: User-facing: A Plan saved before Plans moved to Chat now appears in the Plan library as a read-only closed Plan, so its name, goal and target stay visible.
- c03d713: User-facing: Added a dedicated coach conversation inside Plan, including streamed replies, queued follow-ups, Stop and retry recovery, and reviewable Draft creation and revision.
- 75065a2: User-facing: Plan changes now show an exact before-and-after Proposal with its evidence, and require explicit approval before changing future training.

  Proposal revisions preserve the active Plan until approved, stale changes are revalidated, rejected changes leave the Plan untouched, and malformed changes cannot apply.

- b02a1e8: User-facing: Plans now end automatically after their final date and let athletes record the race as Completed or Not completed without changing their saved Plan.
- a0c3913: User-facing: Added a Plan workspace that starts planning with the coach and highlights decisions that need attention.
- 2d526d8: Plan creation in Chat starts from the `/plan` command in the composer; the Chat surface no longer shows a Start a Plan button. Pressing Enter on an exactly typed slash command sends it immediately.

  User-facing: Type /plan in the chat box to start a Plan. The Start a Plan button in Chat is gone; the Plan page keeps its own.

- 5f707bc: Move planned Workout archive export to Plan and remove the Plan preview and aggregate adherence display from Training.

  User-facing: Export your planned workouts from the Plan page, right under this week's workout list. The Training page no longer shows the plan preview or the adherence percentage.

- 6546ba5: User-facing: Active Plans can now show one automatic, score-free review of the latest completed week after a successful sync.
- 697f674: User-facing: A workout sent from Chat can now become a reviewable Plan addition, and the newest eligible addition can be undone from Plan history.
- 6622b6a: User-facing: The active Plan now highlights workouts changed directly in Intervals and asks whether to adopt the edit or restore the Plan workout.

  Outside edits are never silently overwritten, and failed restores remain visible for retry until Intervals is verified.

- 036ebce: User-facing: The active Plan now shows whether this week’s workouts were completed as planned, adjusted, moved, missed, or extra, and asks before counting an uncertain activity match.

  Workout decisions remain local, survive relaunch, and never change Intervals pairings.

- 41f33ec: User-facing: Once you start a Plan in Chat, the app remembers that Chat owns your Plans, even after restarts, backups, or restores. The app no longer copies an older saved Plan into its records at startup, and the old Plan page no longer shows a separate calendar update box.
- 391ff3f: User-facing: The coach reads a shorter set of instructions on every message, so each reply costs a little less. Power is now called weighted avg power everywhere, and the coach no longer rejects realistic FTP values.
- 8efe207: User-facing: Hardened the macOS credential key against access-control changes by other local applications.

  The native Keychain backend now preserves and validates the protected owner ACL while retaining prompt-free Team-ID access.

- e209128: User-facing: Prevented unsafe credential-key replacement when local credential files cannot be inspected consistently.

  The macOS binding now scopes every key operation to the default Keychain and deletes only the exact validated Enduragent item. A failed envelope inspection no longer masquerades as a pending key deletion during recovery. Automatic key retirement now syncs both vault directories before proving that no dependent envelope survives. Ordinary credential removal revalidates the exact Keychain key without creating a replacement, a missing-key recovery state now offers a non-creating Retry action, and an explicitly removed legacy Telegram envelope no longer requires a missing custom key.

- 6619d98: User-facing: Prevented macOS Keychain password and reset dialogs during credential startup and recovery.

  Enduragent now preserves old or unavailable credentials for explicit inline recovery and never invokes Electron `safeStorage` on macOS.

- 031bdb4: User-facing: Closing Settings while credentials are being removed no longer blocks setup until Settings is reopened.
- a5a366f: User-facing: Stopping a Chat response or losing connection now keeps the interrupted message retryable and sends later queued messages once, in order.
- eba82b9: User-facing: Chat recovery now survives repeated connection losses without duplicating your message after relaunch, while preserving every partial and completed Coach response.
- 7166ed1: User-facing: Prevented “Remove all credentials” from following redirected credential folders.

  The full reset now validates both credential vault roots before removing any encrypted credential or shared Keychain key.

- 0b1f72d: User-facing: Chat now rechecks attachment compatibility after you change coach models. An unsent attachment draft stays visible until starting a new conversation has safely cleared it.
- eb6ca3b: User-facing: “Remove all credentials” now completes reliably on Windows.
- b60e591: User-facing: Removed the What’s new window from Desktop settings.
- 2567965: User-facing: Plan coach conversations now collect durable training inputs, show a reviewable summary, and create a complete structured Draft before anything can activate or reach the Intervals calendar.

  The Plan composer stays at the bottom, optional Race Course attachment lives inside it, and interrupted intake saves recover from the conversation after relaunch.

- f98673e: User-facing: Fixed “Remove all credentials” after an uncertain credential deletion.

  The explicit full reset remains visible and bypasses the per-credential repair lock while other destructive actions remain blocked.

- 8f7ee84: User-facing: Official Desktop releases now send a once-daily installation heartbeat containing only the fixed Enduragent Desktop product label, a random installation ID, app version, and platform. Set `ENDURAGENT_NO_USAGE_PING=1` before launch to disable it without disabling update checks.
- 2780350: User-facing: Chat now restores a stopped Coach decision response without a blank message or completed styling, and waits to show the saved choice until its continuation finishes.
- 88dab94: User-facing: Saved credentials are no longer deleted when the macOS Keychain cannot confirm their encryption key.
- a438015: Move the Strava restricted-activity repair instructions from Training to Settings.

  User-facing: The "How to fix this" link for rides hidden by Strava now opens Settings, where the repair instructions live.

- 82f823b: User-facing: The sync status in the sidebar no longer cuts off mid-word.
- 7caeca5: User-facing: Training week labels now show both years when a week crosses New Year. The weekly chart and its data table use the same name for screen readers.
- b285eb8: User-facing: Telegram setup now always offers Create when no verified bot is connected, and Create repairs stale local Telegram setup from another athlete home.

  Add a disposable macOS development launcher that binds fresh Electron and athlete data roots before the visible unsigned app starts.

- a26ed6a: User-facing: Find your unfinished Plan creation, active Plan, and closed Plans together on the Plan page. Start or continue creating a Plan and return to Chat from there.
- 3627ecd: Prepare explicit Astra selection on the public OpenAI API while retaining existing default models and restricting unverified subscription transports.

  User-facing: You can explicitly choose Astra with an OpenAI API key. Existing model choices stay unchanged, and unavailable cost estimates are not shown as known prices.

- 63a0f54: User-facing: When the coach looks up your recent activities or wellness, it now reads only the fields it needs, so those checks cost fewer tokens and long date ranges no longer flood a reply.
- 4018b25: Keep Training History freshness and calendar windows anchored to the current successful sync and the athlete's active timezone.

  User-facing: Training History now stays current after a successful sync that finds no new data, and its week boundaries follow your active timezone without requiring a restart.

- f65201d: User-facing: Training History now marks only the dates affected by dropped activities as incomplete. Open weeks and comparison callouts no longer claim totals for days that have not finished.
- 0db1852: User-facing: Training dates and ride times now follow your computer's regional format.
- c8f3f56: User-facing: The Training page now matches its approved design: week controls sit in the page bar, each ride shows its day, name, distance, time, and Load on one line, and Ride review groups key stats under their own heading.
- ca163a7: Keep last-recorded Training history during temporary storage failures, preserve selected rides unless refreshed history proves they were removed, and fence ride analysis cache invalidation against late results.

  User-facing: Training now keeps your last recorded history during temporary refresh problems. Ride review no longer closes or reuses out-of-date analysis when refreshed data cannot prove a ride was removed.

- f19225f: User-facing: Training now shows refresh failures and incomplete data without hiding them behind older successful sync details. The sidebar also keeps the exact sync outcome visible and announces it accessibly.
- 11efd16: User-facing: Training now reflows cleanly at the minimum window size and keeps ride callouts readable.
- 5b53e73: Replace the legacy Training panel stack with a week-first summary, six-week riding trend, recent-ride callouts, and inline Ride review.

  User-facing: The Training page now leads with your week: riding time, rides, distance and Load, a six-week trend, and your recent rides with the ride you should look at first. Ride review opens right on the page.

- 6619d98: User-facing: Hardened macOS credential protection by removing unauthenticated helper access and requiring the signed Enduragent host for native binding calls.

  Replaced the separately invokable Keychain helper boundary with a main-process native binding and hardened Electron runtime entry points.

- e94cd93: User-facing: A credential removal that fails partway no longer shows providers as active when the daemon has already dropped them.
- 11950d6: User-facing: Updated the conversation archive list and reader to the new interface system.
- 93cc0a6: User-facing: Updated chat cards, shortcuts, queued messages, and confirmation dialogs to the new interface system.
- 12d09bf: User-facing: Updated the coaching conversation, composer, history controls, and slash-command menu to the new consistent component system.
- 2ae4280: Added a local component foundation while preserving the existing runtime palette system and Tailwind migration boundary.
- 2ae4280: User-facing: Added a consistent accessible local component foundation for desktop buttons, cards, dialogs, selects, popovers, tooltips, and menus.
- 20144c2: User-facing: The desktop app now uses the Inter typeface, with real tabular figures so numbers in tables and metrics align at every weight; monospace surfaces use Geist Mono.
- 2f94075: User-facing: Fixed overlapping and clipped desktop controls in compact layouts.

  Restored palette swatch sizing, archive row flow, release-note centering, and opaque chat controls.

- 04f52c2: User-facing: Completed the new interface migration and standardized all desktop controls.
- c30e606: User-facing: Updated setup menus, labels, and status controls to the new interface system.
- 2dbcfc8: User-facing: Improved keyboard, touch, and screen-reader access for desktop help and slash-command popups.
- daf701b: User-facing: The desktop interface now uses a consistent Primer-based type, spacing, control, radius, and contrast system.
- 131343b: User-facing: Updated settings controls, palettes, forms, and status panels to the new interface system.
- a6b5a20: User-facing: Updated the desktop shell, page headers, and shared confirmation controls to the new consistent component system.
- 795ec2a: User-facing: Updated the desktop sidebar, navigation, sync status, and update action to the new consistent component system.
- 4afb4b2: User-facing: Updated training summaries, progress tables, wellness trends, and export controls to the new interface system.
- e5ee01b: User-facing: Updated ride distributions and power-to-heart-rate analysis to the new interface system.
- b7af11c: User-facing: Updated ride lists, ride summaries, intervals, and best-effort analysis to the new interface system.
- 5691c18: User-facing: Updated the menu-bar status window to the new interface system.
- f907e22: User-facing: Removing all credentials no longer leaves the setup screen locked until restart.
- b5cb428: Add certificate-independent Windows release signature verification scaffolding.
- 7e4e18c: Add the Windows release envelope: release planner, asset verifier, operator upload script, Windows-aware desktop release transaction, and the dispatch-only Windows verification workflow. Authenticode verification is a pending W19 hook.
- 6279da3: Windows release lane: builder config accepted by electron-builder 26.15.3, workflow refuses to mark assets while Authenticode is pending, upload script binds the release tag commit, refuses drafts and prereleases, preflights the upload record, and the verifier binds the blockmap to the installer bytes.
- dec7537: Roll back Windows release assets when the release stops being latest during the upload and record workflow verification as a release asset instead of editing the release body.
- e9d505a: Windows release lane: the uploader requires local Authenticode verification and a real publisher DN before any release mutation, records partially uploaded assets on failure, and refuses an upload record inside the artifact directory; the verification workflow runs on `windows-latest` and binds the installer's sealed release commit; the updater round-trip recomputes blockmap chunk checksums against the installer bytes.
- e1f04b5: Wire Windows updater plumbing: platform-gated update eligibility with Windows present but inactive, disableWebInstaller on the updater, and a pure N-to-N+1 Windows updater round-trip verifier with a negative-scenario harness. Windows update activation and Authenticode publisher checks stay pending until the first signed release.
- a3a410d: Windows release upload: uploads read-only copies of the exact verified bytes and reconciles GitHub asset digests against them, verifies the packaged `app-update.yml` publisher and seals its digest into the installer provenance, and refuses uploads to a release that is not the repository's latest.
- Updated dependencies [39902fa]
- Updated dependencies [09c5ca3]
- Updated dependencies [b2ddccb]
- Updated dependencies [2d0128c]
- Updated dependencies [b38ae00]
- Updated dependencies [66579e6]
- Updated dependencies [8c20aef]
- Updated dependencies [d6d960f]
- Updated dependencies [dc24ae3]
- Updated dependencies [2d09c46]
- Updated dependencies [68bf244]
- Updated dependencies [f191262]
- Updated dependencies [3627ecd]
- Updated dependencies [48f6422]
- Updated dependencies [f3a8b51]
- Updated dependencies [9ed12a5]
- Updated dependencies [3077144]
- Updated dependencies [ae1cbb1]
- Updated dependencies [918600a]
- Updated dependencies [9a9665f]
- Updated dependencies [07b0a8d]
- Updated dependencies [c507634]
- Updated dependencies [e649a25]
- Updated dependencies [f6cacbb]
- Updated dependencies [b02a1e8]
- Updated dependencies [b87174d]
- Updated dependencies [3ad0c39]
- Updated dependencies [a52086c]
- Updated dependencies [6546ba5]
- Updated dependencies [a5a366f]
- Updated dependencies [eba82b9]
- Updated dependencies [2567965]
- Updated dependencies [a415177]
- Updated dependencies [3627ecd]
- Updated dependencies [4018b25]
- Updated dependencies [f65201d]
- Updated dependencies [ca163a7]
- Updated dependencies [5b53e73]
  - @enduragent/coach-contract@0.1.2
  - @enduragent/coach@0.1.1
  - @enduragent/coach-client@0.1.2
  - @enduragent/core@0.1.4

## 0.1.5

### Patch Changes

- fb370fb: User-facing: Saving a timezone now keeps the timezone and its pin together, so Enduragent cannot lose the saved choice between two separate writes.
- 10678ab: User-facing: Delete buttons in setup and settings now sit at the same weight as the buttons beside them and differ only in colour, the confirm button in a delete prompt is a filled red so it never reads as the same control as Cancel, and buttons, links and dropdowns across setup and settings show the hand cursor on hover.

  Danger is a colour, not a button weight. The renderer now exports exactly two danger constants: `BUTTON_DANGER_QUIET_SM` at the quiet weight (no border, transparent background) for every in-row destructive action, and `BUTTON_DANGER_SOLID_SM` at the solid weight for the confirm button in `InlineConfirmation`, where a fill keeps the destructive action distinguishable from Cancel without relying on colour alone. `surface.module.css` `.dangerous` mirrors the quiet variant so the Reset conversation button matches without migrating that file to Tailwind.

- 85fd087: User-facing: Fixed Desktop startup when an existing Intervals refresh cannot be saved.
- be36645: Log renderer and child-process crashes from the desktop main process and start Electron's crash reporter with local-only minidumps (`uploadToServer: false`). Fields are collapsed to one stderr line, query strings and fragments are dropped from the crashed URL, and oversized values are truncated.
- 63637ca: User-facing: The native window title bar now follows the appearance you pick in Preferences, so a dark app no longer sits under light window chrome.
- 7438087: User-facing: The first launch after installing no longer reports a fully-configured install as unconfigured — setup status now retries while the coach is still starting, shows a neutral "Checking setup…" state until it is known, and the Training page keeps reporting ride imports once setup is complete.
- d7dc601: User-facing: Enduragent now uses this computer's timezone by default and refreshes it every time it starts, so a machine that moves zones no longer coaches on the old one. Save a timezone yourself in Settings → Conversation & time and Enduragent keeps that one from then on. COACH_TZ still owns the timezone when it is set.
- 73269ae: User-facing: Settings now shows the coach Provider row's title and its active-route detail on separate lines instead of running them together.
- 381ea8a: User-facing: Removing an additional Telegram user now asks for confirmation and explains that the user loses access until re-added by sender ID.
- 479180d: Ship the `en-US` Chromium locale pak in the Windows package. `electronLanguages: [en]` matched nothing under app-builder-lib's inverted prefix filter, so every locale pak was deleted from `win-unpacked/locales/` and Blink null-dereferenced in `Locale::DefaultLocale` the first time a renderer wrote a value into a number input. The Windows package verifier now requires a present, non-empty `locales/en-US.pak` and rejects any other locale entry.
- a0571e3: Verify the Windows installer envelope and retained application tree with native Node.js tooling, and emit immutable SHA-256 package evidence without relying on a machine-installed archive utility.
- a0571e3: User-facing: Uninstalling Enduragent on Windows now removes both owned login-start registry values while preserving athlete data and desktop settings.
- b4c0197: User-facing: The Windows app now enforces the update downgrade floor; previously it was silently inactive on Windows.

## 0.1.4

### Patch Changes

- f59bf52: User-facing: Deleting the Telegram connection now completes while offline and cancels any pending pairing.
- 4555c74: User-facing: Connecting intervals.icu now repairs an outdated saved Athlete ID when the copied key verifies the current training account, instead of rejecting a valid key.
  User-facing: Setup now tells you to copy the intervals.icu API key again when the clipboard is empty, instead of saying intervals.icu rejected it.
- 4555c74: User-facing: Setup is now its own full-window screen that opens first and stays up until you answer all three required questions — what powers your coach, Intervals.icu, and your injury status. Telegram remains available there as an optional connection.

  The desktop Shell renders the setup gate instead of the sidebar and views while setup is required, so the chat surface is unmounted rather than hosting an in-thread setup card. Credential repair stays reachable inside the gate through the shared credential feedback block.

- 4555c74: User-facing: Setup no longer asks whether a clinician has cleared you — an injury answer alone completes the injury question.
- 846b0d8: User-facing: Claude Code now starts only for Claude work and uses a private Enduragent folder with none of your files.

## 0.1.3

### Patch Changes

- 00402f8: User-facing: Desktop update checks now recover from stalled network requests instead of remaining stuck indefinitely.
- 3e8fbe5: User-facing: Added optional Telegram bot setup directly to the desktop Chat setup screen.
  User-facing: Moved required desktop setup into Chat and kept it available in Settings for recovery.

  Setup now stays in Chat until the coach is ready and remains available at the top of Settings for credential and training-data recovery.

  Desktop setup readiness is rechecked from durable runtime state on every launch, and chat actions fail closed until the provider, training data, and saved safety intake are ready.

  Chat setup can connect a Telegram bot from a copied BotFather token and safely delete its connection from this Mac, and always keeps pairing and access management in Settings.

- a45d3bb: User-facing: Enduragent now exits safely instead of hanging indefinitely when background cleanup cannot finish.
- d020f92: User-facing: Connect Intervals.icu by copying your API key - no typing it into the app.
- 9eadc87: User-facing: Delete your Intervals.icu connection from Chat or Settings, and reconnect any time with a copied API key.
- e1c4786: User-facing: Desktop now checks for updates every six hours while running, in addition to checking at startup.
- a6a2cf4: User-facing: Desktop now asks you to quit and reopen the app when an update check cannot safely continue, instead of offering a retry that cannot run.

  Invalidate timed-out updater generations, fence late completions, and keep automated and manual checks disabled until process restart after timeouts or updater startup failures because the native macOS updater does not expose a supported instance reset.

- da84213: User-facing: Desktop update actions now wait for in-progress Settings changes to finish before restarting the app.
- 41fe0aa: User-facing: Telegram bot management is now delete-and-reconnect - delete the connection, then connect a new bot with a copied token.

## 0.1.1

### Patch Changes

- 0da7580: User-facing: Desktop now uses the Enduragent logo as its app icon and has a simpler sidebar with clearer training-data sync status.

  Replace the default packaged application icon with the website mark, remove sidebar surfaces that duplicate Chat navigation or expose internal process state, and label successful refreshes as "Training data synced."

## 0.1.0

### Minor Changes

- Start the independent desktop SemVer sequence and bind packaged application identity, update metadata, signed artifacts, and native update acceptance to that version.

## 0.0.3

### Patch Changes

- 718e34e: Add a one-time, fail-closed macOS release genesis path that proves the signed, notarized updater envelope without weakening routine baseline continuity checks.

## 0.0.2

### Patch Changes

- d22fb9a: User-facing: ChatGPT sign-in now finishes promptly after browser approval, shows clear progress, supports cancellation, and can retry coach activation without another login.
- 0115dfe: Preserve closed configuration-readiness failures through app-supervised utility termination without retrying terminal configuration errors.
- b4e5365: Let Desktop start from an existing configuration that omits `data_dir`.
- 78971cb: Adds boundary-scoped archived conversation reads (list plus a cursor-namespaced page reader) through the durable transcript store, daemon RPC registry, main-process IPC, and the validated preload bridge. Current-conversation hydration is untouched; the archived surface has no composer, retry, or resume path. Protocol version moves to 11 because the wire method set grew.
- 2e61329: Add curated and custom model selection, write-only endpoint overrides, explicit provider activation, and retry-safe non-secret Setup drafts.
- 2e437f8: Add the privileged Desktop Telegram control plane with serialized suspend, resume, and generation-drain authority; truthful mutation outcomes; and one home-bound encrypted token-and-bot profile without exposing token material to the renderer.
- 2e437f8: User-facing: Added an optional Desktop-hosted Telegram bot with private pairing, local-only availability, and separate Telegram chat history.

  Added main-only clipboard capture, a strict redacted mutation contract, a coherent encrypted bot profile, visible replacement controls, background startup, transient sleep/resume handling, and generation-drained token replacement for Desktop Telegram setup.

- 810b29e: Add bounded, cursor-stable transcript pagination for the canonical Desktop conversation across the durable store, daemon RPC, main-process IPC, and validated preload bridge.
- 2e437f8: User-facing: Desktop now starts with a fresh Enduragent profile and leaves old npm-library data untouched.

  Removed the obsolete automatic home migrator from local coach startup and made first-run Desktop configuration independent of the old npm home.

- d1e548d: Read intervals.icu credentials live in Reference layer sync so automatic training-data sync picks up a key entered during Desktop onboarding.
- 1fd7ebc: User-facing: Fixed Desktop Telegram turning itself back on after the user chose Turn off.

  Treat the stored power choice as authoritative across status polling, reconciliation, restart recovery, pairing cancellation, and pairing-lease races while preserving the configured bot and paired primary user for a later explicit Turn on.

- 24437a7: User-facing: Telegram setup now explains how to recover when secure token storage or Keychain access is unavailable without changing the current bot.

  Preserve closed secure-storage refusal reasons across the Desktop process boundary, refuse unencrypted token storage, and emit stage-and-reason-only local diagnostics without exposing credential details.

- Updated dependencies [8ac6eec]
- Updated dependencies [4f99951]
- Updated dependencies [a6f259c]
- Updated dependencies [ec24061]
- Updated dependencies [d22fb9a]
- Updated dependencies [4655bd1]
- Updated dependencies [f76081e]
- Updated dependencies [fc9ed36]
- Updated dependencies [d36c593]
- Updated dependencies [180df32]
- Updated dependencies [e20ada6]
- Updated dependencies [8619dc3]
- Updated dependencies [ea56807]
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
- Updated dependencies [d6213bb]
- Updated dependencies [2e437f8]
- Updated dependencies [517a34f]
- Updated dependencies [9f9d8c2]
- Updated dependencies [51cd022]
- Updated dependencies [00ee9f4]
- Updated dependencies [e09a645]
- Updated dependencies [2e437f8]
- Updated dependencies [037a09a]
- Updated dependencies [68821e7]
- Updated dependencies [3553f83]
- Updated dependencies [10c6d16]
- Updated dependencies [9a7961c]
- Updated dependencies [22364df]
- Updated dependencies [67174e9]
- Updated dependencies [0d1ad65]
- Updated dependencies [a5b415b]
- Updated dependencies [56b2f24]
- Updated dependencies [aebc383]
- Updated dependencies [118c2a6]
- Updated dependencies [89a6522]
- Updated dependencies [0afbcad]
- Updated dependencies [b25c3c1]
  - @enduragent/coach@0.1.0
  - @enduragent/coach-contract@0.1.1
  - @enduragent/core@0.1.3
  - @enduragent/coach-client@0.1.1
