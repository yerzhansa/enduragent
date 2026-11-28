# @enduragent/i18n

## 0.4.0

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

- 3adc44c: User-facing: Asking the coach to change a workout from the Calendar now opens a clean Plan-change draft and brings your earlier Chat draft back once the change is sent or cancelled.
- a88cdea: User-facing: When ChatGPT stops accepting your sign-in, Setup now says the sign-in expired and offers Sign in with ChatGPT, which opens the browser so you can sign in again. Before, Setup kept showing ChatGPT as Connected and gave you no way to sign in again.

  When the coach's refresh of the ChatGPT token is rejected twice, it marks the stored profile in `auth-profiles.json` as rejected, compared against the profile it refreshed so a newer sign-in is never marked. A successful refresh or a new browser sign-in clears the mark. Main's ChatGPT status reports a marked profile as `{ state: "configured", runtimeReady: false, reason: "sign-in-expired" }`. The renderer keeps it as an expired credential that cannot be activated, so Sign in starts a fresh browser sign-in, and Settings refreshes the sign-in status when it opens. The coach's OAuth token reader moves out of `composition.ts` into `oauth-access-token.ts`.

- 7d6ed8b: User-facing: When your Intervals.icu sign-in is saved but the coach can't use it, Setup now says so and points you at the button on screen (Retry saved keys, or Sign in again), instead of asking you to reload a status that wasn't there.

  Main now reports a sign-in that was saved but could not be applied as `saved-not-active` instead of `uncertain` / `runtime-uncertain`, since the vault has already marked it `failed`. The renderer shows the new `setup.error.intervalsSavedNotActive` message (translated for every catalog) for a saved sign-in whose runtime state is `failed`, and keyboard focus lands on Retry saved keys after such a sign-in when that link is shown. While the row shows the "stopped accepting the sign-in" state, where Retry saved keys is hidden, the message keeps pointing at Sign in again instead. `setup.error.intervalsRuntimeUncertain` is removed.

- c5b2b5e: User-facing: If the language you pick on first launch can't be saved, the language screen now stays open with a message and a Retry button, instead of jumping to Setup in English.

  The shell keeps the language screen up after a failed first-launch save, and the screen shows the failure in the chosen language. Settings keeps its existing "Language preference unavailable" message.

- bba219f: User-facing: When starting a new conversation fails partway, Chat now finds out whether it started and says so, and New chat works again without restarting the app. If Chat still can't tell, a Check again button lets you look again.

  After a failed reset, Chat reads the session, the newest transcript page and the queue once, and compares them with what was showing before. Turns and coach questions that are gone mean the reset landed, so Chat finishes it, keeping anything typed or sent after the failure; ones that are still there mean it never started, so Chat returns to normal. When the page can't tell, Chat stays uncertain. The reset itself is never sent twice.

- a6e5783: User-facing: If you open Enduragent without a network connection, it now reconnects to Intervals.icu by itself once the network is back. Until then, Sync tells you Intervals.icu isn't connected instead of saying your training data is synced.

  When main re-applies the saved intervals.icu sign-in and the coach refuses it as `ownership-unavailable`, main retries the saved keys after 15 s, 1, 2, 5, 10 and 15 min, waits without spending an attempt while the Mac is offline, restarts the schedule when the Mac wakes, and stops on shutdown. In the window, a sync that the coach skips for a missing key while a sign-in is saved fails as `not-in-use` with its own message. While Sync is in that state the window re-reads the coach's runtime configuration every 30 s and on focus, and syncs once when the coach has the key. The touched sync files no longer swallow errors silently.

- 9912a8c: User-facing: When the model your coach uses leaves Enduragent's model list, Settings → Coach and Setup → API key → Advanced now name it as no longer listed instead of showing it as a model you typed, say that your coach keeps using it, and offer a one-press switch to its replacement when there is one. Nothing changes until you press Switch or pick another model.

  Main now answers the LLM configuration with the saved model classified as `listed`, `retired` (with `replacedBy`, or null when the model list offers no replacement) or `custom`, carried on `active` as `kind`. The classification reads the new `DROPPED_MODELS` table in `@enduragent/core`, which names the replacement for each model the list dropped but saved configurations keep, and offers a replacement only when the list the window received lists it. The preload checks the new keys exactly. Setup and Coach show the retired model as its own option, keep it selected, and re-send it unchanged when saved; the Switch button saves the replacement through the existing Coach and Setup save paths.

- 1ebd764: User-facing: If the app can't use your saved Intervals.icu sign-in, the Intervals.icu row in Setup now shows a warning and "Signed in, but not working yet" instead of a green "Connected".

  The Setup training row now checks that the saved Intervals.icu sign-in is active in the coach, the same way training-data readiness does. A sign-in that is saved but `failed` or `stored-inactive` gets a new `not-working` row state with an attention disc, a new `setup.training.subtitle.notWorking` subtitle (translated for every catalog) and the Disconnect action; the existing retry and error panel are unchanged.

- 1799249: User-facing: Settings now shows live download progress, transfer size, speed, and a preparing step while Enduragent downloads an app update.

  Surfaces throttled download progress (percentage, transferred and total megabytes, and transfer speed) and a dedicated macOS preparing phase from the desktop updater through preload and IPC into the Settings Application card, with localized strings across all 17 supported languages.

- c12d9f1: User-facing: If the connection drops while a sync is running, Enduragent now checks the sync again by itself once it reconnects, so the sidebar and your training data catch up without pressing Try again. The sidebar now says "Connection interrupted. Enduragent will check the sync again when it reconnects."

  The window's connection provider gains `onConnectionOpen`, which fires after a new connection replaces one that was lost or retired, never for the first one. The sync coordinator asks the coach again at once when it is left on an interrupted sync with nothing running. When those re-asks keep getting interrupted, each next one waits longer (5 s, 30 s, 2 min, then every 5 min) until the athlete or first sync starts one again. The training context reads the athlete state again when its last refresh failed and no read of its own is running. Both stop listening when disposed. Old code-quality findings in the touched files are cleared without changing behavior.

- Updated dependencies [71a5e7d]
- Updated dependencies [df8343a]
- Updated dependencies [0bcd503]
- Updated dependencies [95d3c9a]
- Updated dependencies [d984b4f]
- Updated dependencies [2efcf2b]
- Updated dependencies [7cba733]
- Updated dependencies [3436f66]
- Updated dependencies [75e77dd]
- Updated dependencies [dbe61e3]
- Updated dependencies [6b2d249]
- Updated dependencies [1949824]
- Updated dependencies [5de1cb7]
- Updated dependencies [9f32ae9]
- Updated dependencies [9ef4f21]
  - @enduragent/coach-contract@0.3.0

## 0.3.0

### Minor Changes

- b0c88aa: User-facing: You can now connect OpenRouter by signing in through your browser instead of pasting a key. Pasting an OpenRouter key still works, and Setup tells you when your OpenRouter account still needs credits.

  Setup and Settings gain an OpenRouter lane next to ChatGPT subscription. Sign-in uses OpenRouter's PKCE flow with a loopback callback on 127.0.0.1, or a code copied by hand when the browser cannot hand back. The key goes into the existing `openrouter` vault slot through the same write as a pasted key, and only an operation id, a phase, a closed refusal or the credit status reaches the renderer. The credit status comes from `is_free_tier` on `GET /api/v1/key` and is never stored. Intervals.icu now shares the loopback sign-in module in core.

- 0eb83f7: User-facing: When your OpenRouter account runs out of credits, Chat now says so and offers an Add credits button that opens OpenRouter's credits page. Your message stays in Chat, so you can send it again once you have added credits.

  Core classifies an HTTP 402, or OpenRouter's mid-stream `{ code: 402 }` error part, as the new `payment_required` failure ahead of the message-text heuristics. The engine turns it into the new `openrouter-credits` error kind only when the chat model runs on OpenRouter; a 402 from any other provider, and Telegram and the terminal, keep the generic message. The turn is not retried. Chat shows the message under the kept athlete message with Retry, and Add credits calls the existing main-process `openOpenRouterPage("credits")` bridge, so the renderer never builds a URL. The kind lives only on the in-memory turn, so after a relaunch the failed message shows the usual Retry without the credits text.

### Patch Changes

- 78ecb9c: User-facing: When your rides come from imported ride files or are already saved on your computer, the Intervals.icu row in Setup now shows a green check and says your rides are saved, matching the "2 of 2 required ready" badge. Connect stays there if you want to sync new rides from Intervals.icu.

  The Setup training row now reads the same training-data readiness that the badge and Start coaching use. Without an Intervals.icu connection but with imported or kept rides, it shows a ready disc, a new `setup.training.subtitle.savedRides` subtitle (translated for every catalog), and keeps the Connect action.

- Updated dependencies [0eb83f7]
  - @enduragent/coach-contract@0.2.0

## 0.2.5

### Patch Changes

- 2fd6f2e: User-facing: Setup and Settings no longer ask for your injury status, so you can start coaching as soon as your AI and training data are connected.

  The `injury-status` Setup row, its intake draft and persistence in the onboarding controller, the `saveIntake` RPC, the `intake` field of `getSetupStatus`, the kernel intake repository, and the `setup.intake.*` and intake error catalog keys are removed. Setup now has two required items. `PROTOCOL_VERSION` moves from 36 to 37. The `intake_flags` table and any row an earlier version saved stay in the store untouched; nothing reads or writes them anymore, and no migration runs.

- Updated dependencies [2fd6f2e]
  - @enduragent/coach-contract@0.1.7

## 0.2.4

### Patch Changes

- 29e7393: User-facing: Disconnecting Intervals.icu now also removes Enduragent's access on Intervals.icu, and the app asks you to sign in again if Intervals.icu stops accepting your sign-in.

  Disconnect in Settings now revokes the signed-in token on intervals.icu (`disconnect-app`) through a scoped vault read, then deletes it locally even when the revoke fails, and the result line says which happened. A plain API key is only removed locally. Core tracks bearer credentials that intervals.icu rejects: a 401 marks the credential, a 403 is confirmed with one probe of the athlete endpoint, and any successful response clears it. The runtime config snapshot reports this as `intervals.credential_rejected`, and the renderer shows "Sign in again" on the Intervals.icu row and in the sidebar footer.

- 2f95252: User-facing: Connect intervals.icu by signing in with your browser instead of copying an API key.

  The intervals.icu row in onboarding and Settings now offers "Sign in with Intervals.icu". It opens the intervals.icu consent page, shows "Waiting for browser…" with "Cancel sign-in" and "Open the sign-in page again", then "Completing sign-in…" while the main process verifies the account against the training history on this Mac and stores the token in the encrypted vault, and finally "Connected as <name>". The clipboard paste channel is removed. API keys saved before this change keep working. Closing the setup surface cancels a sign-in that is still waiting for the browser.

- Updated dependencies [29e7393]
  - @enduragent/coach-contract@0.1.6

## 0.2.3

### Patch Changes

- 1cb7f32: User-facing: Norwegian, Swedish, and Chinese training messages now use plain words for fitness, fatigue, and form.

## 0.2.2

### Patch Changes

- Updated dependencies [922c4ad]
  - @enduragent/coach-contract@0.1.5

## 0.2.1

### Patch Changes

- a372f86: User-facing: Send /feedback plus a short note from Telegram or Desktop. It goes to the Enduragent authors, not to the coach.
- Updated dependencies [a372f86]
  - @enduragent/coach-contract@0.1.4

## 0.2.0

### Minor Changes

- a30364f: Add typed message catalogs, isolated phrasebooks, translation metadata, training-term glossaries, and catalog extraction and coverage checks.
- 9c07855: User-facing: Chat, including the plan cards, notices, and the composer, now appears in your chosen language.
- 1f41fe7: User-facing: Setup, Settings, the sidebar, and past conversations now appear in your chosen language.
- 602dd8c: User-facing: The Training and Plan pages now appear in your chosen language, with counts and dates written the way your language expects.
- 3e9e0e4: User-facing: On first launch the app asks for your language when your computer's language is not one it speaks, and Settings preferences now show in your chosen language.

### Patch Changes

- 5ecffcc: Route fixed Telegram, terminal, and coach messages through the shared English catalog and preserve message descriptors alongside existing wire text.

  User-facing: The Telegram bot, the terminal setup, and the coach's fixed replies now use your language, and the terminal setup asks for your language when your computer's language is not one it speaks.

- e62bd9b: Catalog desktop dialogs, file pickers, and tray copy, and render fixed coach messages in the selected language.

  User-facing: Desktop dialogs and fixed coach replies follow your language preference when translations are available. Your original conversation text stays saved.

- Updated dependencies [5ecffcc]
  - @enduragent/coach-contract@0.1.3

## 0.1.2

### Patch Changes

- Updated dependencies [39902fa]
- Updated dependencies [09c5ca3]
- Updated dependencies [b2ddccb]
- Updated dependencies [2d0128c]
- Updated dependencies [b38ae00]
- Updated dependencies [d6d960f]
- Updated dependencies [2d09c46]
- Updated dependencies [9ed12a5]
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
- Updated dependencies [2567965]
- Updated dependencies [a415177]
  - @enduragent/coach-contract@0.1.2
