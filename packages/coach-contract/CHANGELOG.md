# @enduragent/coach-contract

## 0.3.0

### Minor Changes

- 71a5e7d: User-facing: When you first open a ride in Activity review, the coach writes a short verdict on it with one reply on your own model; if that fails, the ride says so and spends nothing more until you press Write again. You can leave the coach a note on the ride that it reads when you write again, and Ask the coach, here and on a Calendar workout, now adds its question after whatever you have already typed in Chat.

  The `plan.calendar` RPC gains `read-review`, `write-verdict` (with an `expected` state and reply count, refusing with `review-changed` when they moved on) and `save-note`; `decide-ride` also starts the verdict when the athlete answers the match, and a verdict that cannot start never fails the saved match. The verdict moves only through the engine's `coachTextStep`, which now records whether a failure came from the model or from an interrupted write and writes again on open only after an interrupted one. It runs in the background on the athlete's chat model under the new `coach-text` caller, asks for low reasoning effort with a 600-token cap only where the provider honours it (OpenAI reasoning models, codex-agent; Anthropic keeps thinking off at 600) and otherwise keeps the provider's default effort with a 2,000-token cap, aborts before its lease runs out, never abandons a write whose job is still running, and is stored with the note, the failure's cause and the last kept verdict in the new `activity_review` table (migration 037). The engine exports the writer from `@enduragent/engine/coach-text-writer`. `createWorkoutCardController` drops `composerEmpty` and prefills through `requestComposerPrefill`, like Activity review's Ask.

- df8343a: User-facing: A new Activity review page, below Calendar, lists your rides by Training Week and shows each ride's facts. When the app asks "Is this the Plan Workout?", answer yes, no, or another day's workout, and the Calendar shows your answer.

  The `plan.calendar` RPC gains `rides`, which runs the match refresher over the active Plan's part of the range and lists cycling rides with a ride-centric Plan Workout match and the Plan's Training Weeks, and `decide-ride`, which confirms a suggestion, turns it down as Extra, or matches the ride to another nearby workout, and refuses with `match-changed` when the match differs from the `expected` one the page showed. The Plan Workout match repository now lets the athlete take back a confirmed heuristic match and confirm a pairing turned down earlier, and never stores a second confirmed match, or a new suggestion, for a workout or ride that already has a confirmed one; `observe` returns null when it stores nothing and leaves an unchanged suggestion as it was. Confirming a match deletes the other suggestions for that workout and that ride, and the new `withdraw` deletes a suggestion or an intervals.icu pairing the system derived, never the athlete's own answers, so both come back when the evidence returns. The match refresher stores no length for a zero-length ride, withdraws an intervals.icu pairing the ride no longer carries, and the Plan page projection prefers a confirmed match over a suggestion. Turning down or moving a ride's match records its current intervals.icu pairing as unpaired, so the pairing does not come back. Matching a ride again to a workout whose intervals.icu pairing the athlete turned down clears that unpaired row (`clearUnpaired`) and stores the athlete's own match.

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

- 9ef4f21: User-facing: Every training workout in a new Chat Plan now has real steps, a zone, an estimated load and a line on why it is there, and its Calendar card shows them, with watts from your FTP in intervals.icu or as % of FTP until one is set.

  The creation builder moves to version 3 and stores typed `content` (steps as % of FTP, zone, load, why) on each non-event Draft workout. Plan Changes recompute it. Keeping an intervals.icu edit that changes a workout's length removes it, because the athlete's version is the truth. Undo restores it as it was, and Plans built before it keep no content until a change touches a workout. The `plan.calendar` read gains each workout's `content` and the current outdoor `ftp`, and the Draft card model gains `ftpWatts`. intervals.icu receives exactly what it did before; nothing new is sent.

### Patch Changes

- 6b2d249: User-facing: Stop now ends a reply at once even if you changed the coach in Settings while it was streaming. Changing the coach or deleting the AI key in use during a reply now fails right away with a "try again" message, instead of hanging or sending you to the Setup screen.

  A runtime change (`configureRuntime`) that arrives while a chat turn runs now returns the refusal `busy-replying` before it puts the barrier up, so Stop, the runtime config read and the transcript reads are not queued behind a drain that waits for the whole reply. A catalog pin moves into the replacement's prepare step, so a refused change does not pin the new catalog. The startup refresh still waits for running turns. On a key delete, the desktop maps `busy-replying` to a `runtime-unavailable` refusal and leaves the key and its runtime state as they were.

  The coach protocol version goes to 38, because the new `busy-replying` refusal reason is a wire change.

- 5de1cb7: User-facing: When the old Plan's workouts cannot be removed from your intervals.icu calendar, the new Plan's workouts now wait even if you replace the Plan again, and the active Plan shows "Calendar sync failed. Retry available." (or "Connect to mirror Workouts" while intervals.icu is not connected) instead of "Up to date".
  User-facing: Retry calendar now stays available after repeated failures and removes the old Plan's workouts at once.

  The calendar drain and the Plan library read one barrier from `readCleanupBarrier`: the active Plan's mirror waits while any cleanup of another Plan is not verified, not only the newest one, and the active card shows that cleanup. A failed cleanup always offers Retry. Retry sends `retryCalendar` on the next `plan.list`, which reopens failed cleanups. Automatic cleanup retries keep the 15-minute wait after five failures, and mirror jobs keep their five-failure budget.

## 0.2.0

### Minor Changes

- 0eb83f7: User-facing: When your OpenRouter account runs out of credits, Chat now says so and offers an Add credits button that opens OpenRouter's credits page. Your message stays in Chat, so you can send it again once you have added credits.

  Core classifies an HTTP 402, or OpenRouter's mid-stream `{ code: 402 }` error part, as the new `payment_required` failure ahead of the message-text heuristics. The engine turns it into the new `openrouter-credits` error kind only when the chat model runs on OpenRouter; a 402 from any other provider, and Telegram and the terminal, keep the generic message. The turn is not retried. Chat shows the message under the kept athlete message with Retry, and Add credits calls the existing main-process `openOpenRouterPage("credits")` bridge, so the renderer never builds a URL. The kind lives only on the in-memory turn, so after a relaunch the failed message shows the usual Retry without the credits text.

## 0.1.7

### Patch Changes

- 2fd6f2e: User-facing: Setup and Settings no longer ask for your injury status, so you can start coaching as soon as your AI and training data are connected.

  The `injury-status` Setup row, its intake draft and persistence in the onboarding controller, the `saveIntake` RPC, the `intake` field of `getSetupStatus`, the kernel intake repository, and the `setup.intake.*` and intake error catalog keys are removed. Setup now has two required items. `PROTOCOL_VERSION` moves from 36 to 37. The `intake_flags` table and any row an earlier version saved stay in the store untouched; nothing reads or writes them anymore, and no migration runs.

## 0.1.6

### Patch Changes

- 29e7393: User-facing: Disconnecting Intervals.icu now also removes Enduragent's access on Intervals.icu, and the app asks you to sign in again if Intervals.icu stops accepting your sign-in.

  Disconnect in Settings now revokes the signed-in token on intervals.icu (`disconnect-app`) through a scoped vault read, then deletes it locally even when the revoke fails, and the result line says which happened. A plain API key is only removed locally. Core tracks bearer credentials that intervals.icu rejects: a 401 marks the credential, a 403 is confirmed with one probe of the athlete endpoint, and any successful response clears it. The runtime config snapshot reports this as `intervals.credential_rejected`, and the renderer shows "Sign in again" on the Intervals.icu row and in the sidebar footer.

## 0.1.5

### Patch Changes

- 922c4ad: User-facing: Setup and Settings now show the latest accepted models while keeping an open model choice stable until you finish.

## 0.1.4

### Patch Changes

- a372f86: User-facing: Send /feedback plus a short note from Telegram or Desktop. It goes to the Enduragent authors, not to the coach.

## 0.1.3

### Patch Changes

- 5ecffcc: Route fixed Telegram, terminal, and coach messages through the shared English catalog and preserve message descriptors alongside existing wire text.

  User-facing: The Telegram bot, the terminal setup, and the coach's fixed replies now use your language, and the terminal setup asks for your language when your computer's language is not one it speaks.

## 0.1.2

### Patch Changes

- 39902fa: User-facing: A reviewed Draft can now become your active Plan. Activating closes any Plan that was running and keeps your answers with the new Plan.
- 09c5ca3: Refresh runtime dependencies, including XML parser security fixes and desktop updater compatibility updates.

  User-facing: This update improves the safety of imported files and refreshes the libraries used for coaching and app updates.

- b2ddccb: User-facing: Plan creation in Chat can now build a Draft from your answers, with every week and Workout laid out under your confirmed limits. The Draft keeps the answers it was built from when you edit them.
- 2d0128c: Add the privileged Chat attachment-admission contract and durable queued-Message attachment identities.
- b38ae00: User-facing: Coach answers can now offer a safe Continue in Plan card, resolve Workout date conflicts, retry failed handoffs without duplicates, and recover a Proposal when a local Plan save fails.

  Chat keeps typed Plan handoffs with their transcript turn, while Plan protects athlete-created Workouts and requires review before applying a new date or replacing a coach-owned Workout.

- d6d960f: Chat can securely rebuild a selected Workout handoff and restore its current Plan status after relaunch.

  The daemon resolves local Workout details instead of trusting renderer-provided snapshots, and durable handoffs can be listed by their source conversation.

- 2d09c46: User-facing: Past chats can now be permanently deleted with clear confirmation while imported activities and Plan work stay intact. Chat also keeps its safety note visible when cards stack up, orders those cards consistently, and closes the compact Training context drawer reliably from the keyboard.
- 9ed12a5: User-facing: The Plan page can now read your unfinished Plan creation, your active Plan, and your closed Plans together.
- ae1cbb1: User-facing: When you ask the coach to change your plan in chat, it understands weekdays, session lengths and weekly hours more reliably.
- 918600a: User-facing: Answer the essential Plan questions one at a time in chat by picking from clear choices or writing your own answer, change an earlier answer with Edit, and come back later to pick up where you left off.
- 9a9665f: Add a confirmation before discarding unfinished Plan Creation work in Chat.

  User-facing: Discard an unfinished Plan you started in chat without affecting your current Plan or your chat history.

- c507634: End an active Plan locally before removing tomorrow-onward Plan-owned Intervals workouts, with durable retry and verify-only recovery that preserves today and athlete-created events.
- e649a25: Add display-only Estimated CP from two eligible recent measured-power efforts, including stale and unavailable states, an explanatory tooltip, evidence and route-assumption drawers, and strict isolation from FTP and Plan mutations.
- f6cacbb: Add forward-only race-readiness projections, explicit unavailable and changed-assumption states, refresh recovery, and taper safety refusal without mutating the active Plan.
- b02a1e8: User-facing: Plans now end automatically after their final date and let athletes record the race as Completed or Not completed without changing their saved Plan.
- b87174d: Replace an active Plan atomically while preserving today, verify tomorrow-onward cleanup of the old Plan before writing the replacement’s next seven days, and keep failures recoverable after relaunch.
- 3ad0c39: Show every active Plan week with phase, purpose, status, and planned time, plus a complete authoritative race-week schedule with separate training, race, and total accounting.
- a52086c: Add Plan-scoped settings with immediate persistence and safely auto-apply eligible future workout duration reductions.
- 6546ba5: User-facing: Active Plans can now show one automatic, score-free review of the latest completed week after a successful sync.
- 2567965: User-facing: Plan coach conversations now collect durable training inputs, show a reviewable summary, and create a complete structured Draft before anything can activate or reach the Intervals calendar.

  The Plan composer stays at the bottom, optional Race Course attachment lives inside it, and interrupted intake saves recover from the conversation after relaunch.

- a415177: Add the internal training-history contract, persisted coverage evidence, calendar-aware capture plan, and state composition wiring.

## 0.1.1

### Patch Changes

- 4f99951: Add strict shared contracts for bounded activity analysis results.
- d22fb9a: User-facing: ChatGPT sign-in now finishes promptly after browser approval, shows clear progress, supports cancellation, and can retry coach activation without another login.
- fc9ed36: Add the engine/UI contract package: CoachEngine interface, request/response
  schemas, the TurnEvent union with a reserved streaming variant, AthleteState,
  PROTOCOL_VERSION, and CLI exit-code constants. Arm the contract dependency
  gate in the root check chain.
- 61a8940: Added desktop PKCE sign-in, daemon-owned OAuth profile storage, and keyless runtime configuration for the ChatGPT subscription provider.
- 78971cb: Adds boundary-scoped archived conversation reads (list plus a cursor-namespaced page reader) through the durable transcript store, daemon RPC registry, main-process IPC, and the validated preload bridge. Current-conversation hydration is untouched; the archived surface has no composer, retry, or resume path. Protocol version moves to 11 because the wire method set grew.
- 1977c1b: Added provider-reported OpenRouter costs and aggregate authenticated spend methods for the desktop client.
- 2e437f8: Add the privileged Desktop Telegram control plane with serialized suspend, resume, and generation-drain authority; truthful mutation outcomes; and one home-bound encrypted token-and-bot profile without exposing token material to the renderer.
- 810b29e: Add bounded, cursor-stable transcript pagination for the canonical Desktop conversation across the durable store, daemon RPC, main-process IPC, and validated preload bridge.
- e09a645: Project verified curve evidence into a bounded Power Progress training contract with independent freshness, stale-last-good failure context, and no raw provider data.
- 67174e9: Add authenticated intake persistence and in-memory runtime configuration operations to the daemon wire.
- aebc383: User-facing: Desktop ride reviews can now save FIT or GPX files, and the visible training plan can be saved as a ZIP of ZWO, MRC, ERG, or FIT workouts.

  Keep export credentials, provider identifiers, file paths, and downloaded bytes in trusted processes; enforce bounded downloads and atomically publish private mode-0600 files selected through the native save dialog.
