# @enduragent/desktop-renderer

## 0.6.0

### Minor Changes

- dbe61e3: User-facing: When the coach can't answer because your Claude Code, Codex or ChatGPT sign-in has ended, your AI provider account is out of credits, or your provider no longer offers the model you picked, Chat now says so under your message and tells you what to do next. Before, it showed only a red icon and Retry, or blamed an API key you don't have.

  Core classifies a provider error whose code or type is `model_not_found`, or Anthropic's `not_found_error` on the anthropic route, as the new `model_unavailable` failure (a bare 404, which a wrong base URL also returns, stays generic), and an OpenAI 429 whose error type or code is a billing limit (`insufficient_quota`, `credit_balance_exhausted`, spend or usage limits) as `payment_required`, so it is no longer retried as a rate limit. The route comes from the chat model's provider; a 429 from any other provider stays a rate limit. The engine chooses the athlete copy from the failure and the provider: a sign-in failure on Claude Code, Codex or ChatGPT gets the new `subscription-signed-out` kind with the existing "sign in again" message, a 402 from a key provider other than OpenRouter gets the new `provider-credits` kind, and a missing model gets the new `model-unavailable` kind. Chat shows these three, and OpenRouter's credits notice, as a red notice under the kept message. A rejected API key, rate limits and other failures keep the icon and Retry. Telegram and the terminal keep their existing replies. The three new error kinds change the turn-event wire, so the coach protocol moves from 38 to 39.

### Patch Changes

- 3adc44c: User-facing: Asking the coach to change a workout from the Calendar now opens a clean Plan-change draft and brings your earlier Chat draft back once the change is sent or cancelled.
- df97440: User-facing: When you type your own answer to a Plan or coaching question, the chat box stays at the bottom and says to finish your answer first, and Stop responding stays there while the coach is still replying.
- b4c2cc2: User-facing: Queued chat messages now keep sending after failed replies or removed commands, oversized plan edits no longer leave stray bubbles, and startup or file-drop hiccups recover cleanly.

  Unifies chat queue drain scheduling across failure, removal, and reset paths, clears draft errors after successful sends, serializes coach decision mutations away from active streams, retries failed startup probes individually, validates plan-change text before updating the transcript, guards async plan epochs and disposal, and adds timeout cleanup and busy-state Dismiss handling for dropped attachments.

- da117ef: User-facing: Chat decision shortcuts now respond only while Chat is open, drafts stay intact across view switches and slash commands, and messages no longer duplicate or blank when views refresh.

  Resets `queueRevision` on New Conversation, filters live turns out of reloaded history pages, flushes Composer drafts on unmount and slash acceptance, scopes Chat decision shortcuts to the Chat view, and preserves buffered streaming text when views remount.

- 6b2d249: User-facing: Stop now ends a reply at once even if you changed the coach in Settings while it was streaming. Changing the coach or deleting the AI key in use during a reply now fails right away with a "try again" message, instead of hanging or sending you to the Setup screen.

  A runtime change (`configureRuntime`) that arrives while a chat turn runs now returns the refusal `busy-replying` before it puts the barrier up, so Stop, the runtime config read and the transcript reads are not queued behind a drain that waits for the whole reply. A catalog pin moves into the replacement's prepare step, so a refused change does not pin the new catalog. The startup refresh still waits for running turns. On a key delete, the desktop maps `busy-replying` to a `runtime-unavailable` refusal and leaves the key and its runtime state as they were.

  The coach protocol version goes to 38, because the new `busy-replying` refusal reason is a wire change.

- a88cdea: User-facing: When ChatGPT stops accepting your sign-in, Setup now says the sign-in expired and offers Sign in with ChatGPT, which opens the browser so you can sign in again. Before, Setup kept showing ChatGPT as Connected and gave you no way to sign in again.

  When the coach's refresh of the ChatGPT token is rejected twice, it marks the stored profile in `auth-profiles.json` as rejected, compared against the profile it refreshed so a newer sign-in is never marked. A successful refresh or a new browser sign-in clears the mark. Main's ChatGPT status reports a marked profile as `{ state: "configured", runtimeReady: false, reason: "sign-in-expired" }`. The renderer keeps it as an expired credential that cannot be activated, so Sign in starts a fresh browser sign-in, and Settings refreshes the sign-in status when it opens. The coach's OAuth token reader moves out of `composition.ts` into `oauth-access-token.ts`.

- 1ab9418: User-facing: Enduragent now reopens automatically if installing a desktop update fails instead of closing without restarting. Update downloads, automatic background checks, and Try again now recover cleanly after errors, and the sidebar no longer flashes "Restarting…" while checking for updates.

  Replaces implicit update and quit flags across `update-controller.ts`, `update-state-machine.ts`, `quit-coordinator.ts`, `main/index.ts`, and the renderer update controller/UI with explicit closed phase unions. Detaches failed and ready operations immediately (eliminating retry wedges), resets the download transfer watermark on differential-to-full fallback, arms macOS Squirrel readiness listeners only after archive download completes, commits the updater only after configuration succeeds, keeps the 6-hour check timer scheduled on transient startup floor or config failure, freezes update IPC and controller synchronously before async shutdown awaits, relaunches the current app once on failed update drain/install handoff (including synchronous and asynchronous updater or native readiness errors), blocks renderer clicks before initial hydration, separates pending `checking` from `restarting` in `UpdateAvailableButton`, and surfaces IPC check rejections after intermediate pushes. Promotes all 10 findings in `.agents/skills/verify-update-download/` to guarded TLC controls.

- 7d6ed8b: User-facing: When your Intervals.icu sign-in is saved but the coach can't use it, Setup now says so and points you at the button on screen (Retry saved keys, or Sign in again), instead of asking you to reload a status that wasn't there.

  Main now reports a sign-in that was saved but could not be applied as `saved-not-active` instead of `uncertain` / `runtime-uncertain`, since the vault has already marked it `failed`. The renderer shows the new `setup.error.intervalsSavedNotActive` message (translated for every catalog) for a saved sign-in whose runtime state is `failed`, and keyboard focus lands on Retry saved keys after such a sign-in when that link is shown. While the row shows the "stopped accepting the sign-in" state, where Retry saved keys is hidden, the message keeps pointing at Sign in again instead. `setup.error.intervalsRuntimeUncertain` is removed.

- 858cff5: User-facing: If the coach is slow to answer right after you delete a key in Settings, you now stay in Settings with a Retry for the setup status, instead of being sent to the full Setup screen while your coach still works.

  The delete path's catch marked the deleted credential as needing repair when Setup's follow-up read timed out, and a repair credential makes Setup required. A failed read is not a reason to repair: the catch now keeps the repair state it had.

- c5b2b5e: User-facing: If the language you pick on first launch can't be saved, the language screen now stays open with a message and a Retry button, instead of jumping to Setup in English.

  The shell keeps the language screen up after a failed first-launch save, and the screen shows the failure in the chosen language. Settings keeps its existing "Language preference unavailable" message.

- bba219f: User-facing: When starting a new conversation fails partway, Chat now finds out whether it started and says so, and New chat works again without restarting the app. If Chat still can't tell, a Check again button lets you look again.

  After a failed reset, Chat reads the session, the newest transcript page and the queue once, and compares them with what was showing before. Turns and coach questions that are gone mean the reset landed, so Chat finishes it, keeping anything typed or sent after the failure; ones that are still there mean it never started, so Chat returns to normal. When the page can't tell, Chat stays uncertain. The reset itself is never sent twice.

- a6e5783: User-facing: If you open Enduragent without a network connection, it now reconnects to Intervals.icu by itself once the network is back. Until then, Sync tells you Intervals.icu isn't connected instead of saying your training data is synced.

  When main re-applies the saved intervals.icu sign-in and the coach refuses it as `ownership-unavailable`, main retries the saved keys after 15 s, 1, 2, 5, 10 and 15 min, waits without spending an attempt while the Mac is offline, restarts the schedule when the Mac wakes, and stops on shutdown. In the window, a sync that the coach skips for a missing key while a sign-in is saved fails as `not-in-use` with its own message. While Sync is in that state the window re-reads the coach's runtime configuration every 30 s and on focus, and syncs once when the coach has the key. The touched sync files no longer swallow errors silently.

- aebd0d5: User-facing: When Enduragent finds that Intervals.icu no longer accepts your sign-in, for example during its background sync, the sidebar now asks you to sign in again within a minute. Before, it waited until you came back to the window or synced.

  The coach learns of a rejected sign-in from its own syncs and chat tool calls, and the window reads that only through `getRuntimeConfig`. The window now re-reads it every 60 s while no sync is running, every 30 s while Sync reports the saved sign-in is not in use, and not at all during a sync, which ends with a read of its own. Focus and the read after each sync stay as they were.

- 5de1cb7: User-facing: When the old Plan's workouts cannot be removed from your intervals.icu calendar, the new Plan's workouts now wait even if you replace the Plan again, and the active Plan shows "Calendar sync failed. Retry available." (or "Connect to mirror Workouts" while intervals.icu is not connected) instead of "Up to date".
  User-facing: Retry calendar now stays available after repeated failures and removes the old Plan's workouts at once.

  The calendar drain and the Plan library read one barrier from `readCleanupBarrier`: the active Plan's mirror waits while any cleanup of another Plan is not verified, not only the newest one, and the active card shows that cleanup. A failed cleanup always offers Retry. Retry sends `retryCalendar` on the next `plan.list`, which reopens failed cleanups. Automatic cleanup retries keep the 15-minute wait after five failures, and mirror jobs keep their five-failure budget.

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

- 564916f: User-facing: The sidebar's Sign in again link for Intervals.icu now waits while Setup or a Settings change is busy, instead of opening Settings without starting the sign-in.

  The link switched to Settings and called `connectTrainingData`, which does nothing while a Setup credential operation runs. It is now disabled by `setupSignInBlocked`, which joins the two checks `connectTrainingData` refuses on: a running Setup credential operation and `credentialChangesBlocked`.

- f523d71: User-facing: If the coach turns a sync away before it starts, for example while it is getting ready for an update, the sidebar now offers Try again instead of a disabled "Sync unavailable" that asked you to quit and reopen Enduragent.

  The sync coordinator accepts an error reply that arrives before any progress notification as an operation failure the athlete can retry. It publishes that failure without refreshing the training context, since the coach ran nothing. A success with no progress is still a protocol fault, and an error after completed progress still is too. The desktop e2e fixture can take the coach's invocation coordinator, so a spec can close and reopen admission.

- e5cd8df: User-facing: When Enduragent can't read your Telegram settings, the Telegram row in Setup now says so and offers Retry, instead of offering Create as if no bot were set up.

  The Setup Telegram row now follows the Telegram settings state `{ status: "error", kind: "load" }`: the row shows the attention mark and the Settings pane's existing copy ("Telegram settings aren’t available. Keep the app open and try again."), and Retry (the existing `settings.telegram.retry` label) calls the Telegram settings port's `retry()`, which re-reads the status. Create is not offered, and an open bot setup panel cannot use a token or confirm a deletion, until a status read succeeds. No new copy.

- 1799249: User-facing: Settings now shows live download progress, transfer size, speed, and a preparing step while Enduragent downloads an app update.

  Surfaces throttled download progress (percentage, transferred and total megabytes, and transfer speed) and a dedicated macOS preparing phase from the desktop updater through preload and IPC into the Settings Application card, with localized strings across all 17 supported languages.

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
- Updated dependencies [3436f66]
- Updated dependencies [75e77dd]
- Updated dependencies [dbe61e3]
- Updated dependencies [6b2d249]
- Updated dependencies [a88cdea]
- Updated dependencies [7d6ed8b]
- Updated dependencies [c5b2b5e]
- Updated dependencies [bba219f]
- Updated dependencies [a6e5783]
- Updated dependencies [1949824]
- Updated dependencies [5de1cb7]
- Updated dependencies [9912a8c]
- Updated dependencies [1ebd764]
- Updated dependencies [9f32ae9]
- Updated dependencies [1799249]
- Updated dependencies [c12d9f1]
- Updated dependencies [9ef4f21]
  - @enduragent/coach-contract@0.3.0
  - @enduragent/i18n@0.4.0
  - @enduragent/coach-client@0.1.9

## 0.5.0

### Minor Changes

- b0c88aa: User-facing: You can now connect OpenRouter by signing in through your browser instead of pasting a key. Pasting an OpenRouter key still works, and Setup tells you when your OpenRouter account still needs credits.

  Setup and Settings gain an OpenRouter lane next to ChatGPT subscription. Sign-in uses OpenRouter's PKCE flow with a loopback callback on 127.0.0.1, or a code copied by hand when the browser cannot hand back. The key goes into the existing `openrouter` vault slot through the same write as a pasted key, and only an operation id, a phase, a closed refusal or the credit status reaches the renderer. The credit status comes from `is_free_tier` on `GET /api/v1/key` and is never stored. Intervals.icu now shares the loopback sign-in module in core.

- 0eb83f7: User-facing: When your OpenRouter account runs out of credits, Chat now says so and offers an Add credits button that opens OpenRouter's credits page. Your message stays in Chat, so you can send it again once you have added credits.

  Core classifies an HTTP 402, or OpenRouter's mid-stream `{ code: 402 }` error part, as the new `payment_required` failure ahead of the message-text heuristics. The engine turns it into the new `openrouter-credits` error kind only when the chat model runs on OpenRouter; a 402 from any other provider, and Telegram and the terminal, keep the generic message. The turn is not retried. Chat shows the message under the kept athlete message with Retry, and Add credits calls the existing main-process `openOpenRouterPage("credits")` bridge, so the renderer never builds a URL. The kind lives only on the in-memory turn, so after a relaunch the failed message shows the usual Retry without the credits text.

### Patch Changes

- 2cbc4a5: User-facing: The Model list in Setup and Settings now shows every model's full name, and the check mark next to the selected model no longer covers its name.

  The open model list now grows to fit its longest name instead of matching its button's width, stays inside the window, and the button keeps its width.

- aef6b47: User-facing: Moving to another ride while its analysis is still loading no longer interrupts a sync that is running or cuts off the coach's reply.

  The ride analysis passed an abort signal to `getActivityAnalysis`, and the coach client closes the window's whole shared connection on any caller's abort, so every other call on it failed. The analysis no longer passes a signal; a superseded load is dropped by its generation when its answer arrives. The client's abort behavior is unchanged.

- b0c88aa: User-facing: Settings now shows your new coach route and the Delete button for a newly connected AI provider right away, without leaving Settings and coming back.

  Every successful provider connection in Setup, pasted key, browser sign-in or reactivation, now refreshes the open Settings coach and credential panes in place, even when the Setup status refresh fails. The Coach pane keeps its current values until the new route arrives, keeps an unsaved model draft, and reloads after Review setup closed it.

- 78ecb9c: User-facing: When your rides come from imported ride files or are already saved on your computer, the Intervals.icu row in Setup now shows a green check and says your rides are saved, matching the "2 of 2 required ready" badge. Connect stays there if you want to sync new rides from Intervals.icu.

  The Setup training row now reads the same training-data readiness that the badge and Start coaching use. Without an Intervals.icu connection but with imported or kept rides, it shows a ready disc, a new `setup.training.subtitle.savedRides` subtitle (translated for every catalog), and keeps the Connect action.

- Updated dependencies [c404a91]
- Updated dependencies [b0c88aa]
- Updated dependencies [0eb83f7]
- Updated dependencies [78ecb9c]
  - @enduragent/coach-client@0.1.8
  - @enduragent/i18n@0.3.0
  - @enduragent/coach-contract@0.2.0

## 0.4.1

### Patch Changes

- 2b129f8: User-facing: When Intervals.icu stops accepting your sign-in, you can now disconnect it in the app as well as sign in again.

  The Intervals.icu row in the "sign-in stopped working" state now offers Disconnect beside Sign in again. Disconnect uses the same confirmation, revoke attempt and local removal as the connected row, and afterwards the row, the Settings warning and the sidebar notice return to not connected.

- 2fd6f2e: User-facing: Setup and Settings no longer ask for your injury status, so you can start coaching as soon as your AI and training data are connected.

  The `injury-status` Setup row, its intake draft and persistence in the onboarding controller, the `saveIntake` RPC, the `intake` field of `getSetupStatus`, the kernel intake repository, and the `setup.intake.*` and intake error catalog keys are removed. Setup now has two required items. `PROTOCOL_VERSION` moves from 36 to 37. The `intake_flags` table and any row an earlier version saved stay in the store untouched; nothing reads or writes them anymore, and no migration runs.

- 16539a7: User-facing: If you start a new chat while writing your own answer to a coach question, the message box now comes back instead of staying hidden until you restart the app.

  The coach decision panel now reports its custom editor as closed when it unmounts, the same way the Plan editors do, so the chat view stops hiding the composer for an editor that no longer exists.

- Updated dependencies [2fd6f2e]
  - @enduragent/coach-contract@0.1.7
  - @enduragent/coach-client@0.1.7
  - @enduragent/i18n@0.2.5

## 0.4.0

### Minor Changes

- 2f95252: User-facing: Connect intervals.icu by signing in with your browser instead of copying an API key.

  The intervals.icu row in onboarding and Settings now offers "Sign in with Intervals.icu". It opens the intervals.icu consent page, shows "Waiting for browser…" with "Cancel sign-in" and "Open the sign-in page again", then "Completing sign-in…" while the main process verifies the account against the training history on this Mac and stores the token in the encrypted vault, and finally "Connected as <name>". The clipboard paste channel is removed. API keys saved before this change keep working. Closing the setup surface cancels a sign-in that is still waiting for the browser.

### Patch Changes

- 29e7393: User-facing: Disconnecting Intervals.icu now also removes Enduragent's access on Intervals.icu, and the app asks you to sign in again if Intervals.icu stops accepting your sign-in.

  Disconnect in Settings now revokes the signed-in token on intervals.icu (`disconnect-app`) through a scoped vault read, then deletes it locally even when the revoke fails, and the result line says which happened. A plain API key is only removed locally. Core tracks bearer credentials that intervals.icu rejects: a 401 marks the credential, a 403 is confirmed with one probe of the athlete endpoint, and any successful response clears it. The runtime config snapshot reports this as `intervals.credential_rejected`, and the renderer shows "Sign in again" on the Intervals.icu row and in the sidebar footer.

- Updated dependencies [29e7393]
- Updated dependencies [2f95252]
  - @enduragent/i18n@0.2.4
  - @enduragent/coach-contract@0.1.6
  - @enduragent/coach-client@0.1.6

## 0.3.4

### Patch Changes

- Updated dependencies [1cb7f32]
  - @enduragent/i18n@0.2.3

## 0.3.3

### Patch Changes

- 313e2b9: User-facing: Settings Setup shows the AI that powers your coach in the first row, and no longer lists that same Active credential again underneath.

## 0.3.2

### Patch Changes

- 07f1aa9: User-facing: Chat keeps Plan reviews and coaching choices in conversation order after reopening, with notices that return you to anything still waiting for your review.
  User-facing: After your training data syncs, the sidebar shows a compact Sync action without repeating completion details.
- bc98674: User-facing: If a chat send fails, the warning and retry sit on your message as icons, not a separate Retry button under it.
- 30d7740: User-facing: If a chat send fails, Chat keeps your message in the thread with a warning and Retry, instead of moving it into Queued messages.
- f349e78: User-facing: When the coach cannot answer, such as a rate limit, Chat pins a red notice under the header with a Retry button beside it, and the Training context sidebar again lines up with the header.
- 1c46a93: User-facing: Chat tells you when Send is still connecting, and if a draft couldn’t save it says your message is still in the box.
- 161d07c: User-facing: Chat no longer shows a leftover “Couldn’t reach the coach” line after Send turns on.
- 922c4ad: User-facing: Setup and Settings now show the latest accepted models while keeping an open model choice stable until you finish.
- 07f1aa9: User-facing: If saving a message draft is interrupted, Chat now says the draft is still available in the current window instead of claiming an attachment failed.
- 07f1aa9: User-facing: A training data sync now stays connected if another part of the app reconnects at the same time.
- eb282e3: User-facing: When Strava hides rides, Enduragent now says Strava does not allow third-party AI tools to use that data, and links to a help page on how to get those rides.
- Updated dependencies [922c4ad]
- Updated dependencies [07f1aa9]
  - @enduragent/coach-contract@0.1.5
  - @enduragent/coach-client@0.1.5
  - @enduragent/i18n@0.2.2

## 0.3.1

### Patch Changes

- 4a2012d: User-facing: Setup no longer shows a separate Claude subscription status row.
- 0bf9483: User-facing: Settings no longer shows the Training account section or athlete ID editor. Your connected account stays saved and remains manageable in Setup.
- baf483d: User-facing: Attachments and queued messages now share one rounded composer, and your latest chat message stays fully visible above it.
- d3b69ee: User-facing: Training sync status is now easier to scan. Successful syncs no longer show a date, and Sync now stays hidden while a sync is in progress.
- c75c305: User-facing: Conversation settings now show only your timezone and save a valid timezone when you leave the field or press Enter. Your existing conversation timing and history preferences stay unchanged.

## 0.3.0

### Minor Changes

- a372f86: User-facing: Send /feedback plus a short note from Telegram or Desktop. It goes to the Enduragent authors, not to the coach.

### Patch Changes

- Updated dependencies [a372f86]
  - @enduragent/coach-contract@0.1.4
  - @enduragent/i18n@0.2.1
  - @enduragent/coach-client@0.1.4

## 0.2.0

### Minor Changes

- e62bd9b: Catalog desktop dialogs, file pickers, and tray copy, and render fixed coach messages in the selected language.

  User-facing: Desktop dialogs and fixed coach replies follow your language preference when translations are available. Your original conversation text stays saved.

- 9c07855: User-facing: Chat, including the plan cards, notices, and the composer, now appears in your chosen language.
- 1f41fe7: User-facing: Setup, Settings, the sidebar, and past conversations now appear in your chosen language.
- 602dd8c: User-facing: The Training and Plan pages now appear in your chosen language, with counts and dates written the way your language expects.
- 3e9e0e4: User-facing: On first launch the app asks for your language when your computer's language is not one it speaks, and Settings preferences now show in your chosen language.

### Patch Changes

- Updated dependencies [5ecffcc]
- Updated dependencies [e62bd9b]
- Updated dependencies [a30364f]
- Updated dependencies [9c07855]
- Updated dependencies [1f41fe7]
- Updated dependencies [602dd8c]
- Updated dependencies [3e9e0e4]
- Updated dependencies [b30d963]
  - @enduragent/i18n@0.2.0
  - @enduragent/coach-contract@0.1.3
  - @enduragent/coach-client@0.1.3

## 0.1.0

### Minor Changes

- be70e9b: Add a Language row to desktop Settings preferences.

  User-facing: Settings now has a Language choice above Units. Automatic follows your computer's language, or pick one of 17 languages for the app and the coach.

## 0.0.6

### Patch Changes

- b38ae00: User-facing: Coach answers can now offer a safe Continue in Plan card, resolve Workout date conflicts, retry failed handoffs without duplicates, and recover a Proposal when a local Plan save fails.

  Chat keeps typed Plan handoffs with their transcript turn, while Plan protects athlete-created Workouts and requires review before applying a new date or replacing a coach-owned Workout.

- 66579e6: User-facing: Chat safely resumes unfinished Plan handoffs after relaunch. Deleting Chat attachment data keeps delivered Plan work and its compact origin record intact.
- 21ab9fa: User-facing: Selected Workout files can now open a durable review in Plan, and Chat keeps a read-only card that returns to the same request after relaunch. Completed Plan requests can return to their exact Chat card.
- 47e4cd2: User-facing: New chat remains available when messages are queued or the Coach is waiting for an answer, and an uncertain reset keeps the entire conversation intact.
- 8a4e3ff: User-facing: Stopped Coach responses now keep Retry clearly grouped with the interruption message and separated from queued messages.
- 7291940: User-facing: Chat keeps your reading place when a response continues while you visit another page.
- 2d09c46: User-facing: Past chats can now be permanently deleted with clear confirmation while imported activities and Plan work stay intact. Chat also keeps its safety note visible when cards stack up, orders those cards consistently, and closes the compact Training context drawer reliably from the keyboard.
- 584b01b: User-facing: Training now uses a compact ride-import control without an extra file-selection message and ends after your recent rides. Ride review shows recorded analysis without the ride-export card.
- 87455a5: Replace the macOS tray popup with a native action menu and add a Settings shortcut.

  User-facing: Click the menu bar icon to open Enduragent, go to Settings, choose whether it starts at login, or quit.

- 5ba9576: User-facing: Coach responses in Chat now use the intended compact text size and line spacing.
- 3627ecd: Clarify the training-data setup subtitle.

  User-facing: Setup now says you can connect a service or import ride files.

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
- 5f707bc: Move planned Workout archive export to Plan and remove the Plan preview and aggregate adherence display from Training.

  User-facing: Export your planned workouts from the Plan page, right under this week's workout list. The Training page no longer shows the plan preview or the adherence percentage.

- 6546ba5: User-facing: Active Plans can now show one automatic, score-free review of the latest completed week after a successful sync.
- a5a366f: User-facing: Stopping a Chat response or losing connection now keeps the interrupted message retryable and sends later queued messages once, in order.
- eba82b9: User-facing: Chat recovery now survives repeated connection losses without duplicating your message after relaunch, while preserving every partial and completed Coach response.
- 0b1f72d: User-facing: Chat now rechecks attachment compatibility after you change coach models. An unsent attachment draft stays visible until starting a new conversation has safely cleared it.
- 2567965: User-facing: Plan coach conversations now collect durable training inputs, show a reviewable summary, and create a complete structured Draft before anything can activate or reach the Intervals calendar.

  The Plan composer stays at the bottom, optional Race Course attachment lives inside it, and interrupted intake saves recover from the conversation after relaunch.

- 2780350: User-facing: Chat now restores a stopped Coach decision response without a blank message or completed styling, and waits to show the saved choice until its continuation finishes.
- a438015: Move the Strava restricted-activity repair instructions from Training to Settings.

  User-facing: The "How to fix this" link for rides hidden by Strava now opens Settings, where the repair instructions live.

- 82f823b: User-facing: The sync status in the sidebar no longer cuts off mid-word.
- 7caeca5: User-facing: Training week labels now show both years when a week crosses New Year. The weekly chart and its data table use the same name for screen readers.
- b285eb8: User-facing: Telegram setup now always offers Create when no verified bot is connected, and Create repairs stale local Telegram setup from another athlete home.

  Add a disposable macOS development launcher that binds fresh Electron and athlete data roots before the visible unsigned app starts.

- a26ed6a: User-facing: Find your unfinished Plan creation, active Plan, and closed Plans together on the Plan page. Start or continue creating a Plan and return to Chat from there.
- 0db1852: User-facing: Training dates and ride times now follow your computer's regional format.
- c8f3f56: User-facing: The Training page now matches its approved design: week controls sit in the page bar, each ride shows its day, name, distance, time, and Load on one line, and Ride review groups key stats under their own heading.
- ca163a7: Keep last-recorded Training history during temporary storage failures, preserve selected rides unless refreshed history proves they were removed, and fence ride analysis cache invalidation against late results.

  User-facing: Training now keeps your last recorded history during temporary refresh problems. Ride review no longer closes or reuses out-of-date analysis when refreshed data cannot prove a ride was removed.

- f19225f: User-facing: Training now shows refresh failures and incomplete data without hiding them behind older successful sync details. The sidebar also keeps the exact sync outcome visible and announces it accessibly.
- 11efd16: User-facing: Training now reflows cleanly at the minimum window size and keeps ride callouts readable.
- 5b53e73: Replace the legacy Training panel stack with a week-first summary, six-week riding trend, recent-ride callouts, and inline Ride review.

  User-facing: The Training page now leads with your week: riding time, rides, distance and Load, a six-week trend, and your recent rides with the ride you should look at first. Ride review opens right on the page.

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
  - @enduragent/coach-client@0.1.2

## 0.0.5

### Patch Changes

- 4555c74: User-facing: Connecting intervals.icu now repairs an outdated saved Athlete ID when the copied key verifies the current training account, instead of rejecting a valid key.
  User-facing: Setup now tells you to copy the intervals.icu API key again when the clipboard is empty, instead of saying intervals.icu rejected it.
- 4555c74: User-facing: Setup is now its own full-window screen that opens first and stays up until you answer all three required questions — what powers your coach, Intervals.icu, and your injury status. Telegram remains available there as an optional connection.

  The desktop Shell renders the setup gate instead of the sidebar and views while setup is required, so the chat surface is unmounted rather than hosting an in-thread setup card. Credential repair stays reachable inside the gate through the shared credential feedback block.

- 4555c74: User-facing: Setup no longer asks whether a clinician has cleared you — an injury answer alone completes the injury question.
- 846b0d8: User-facing: Claude Code now starts only for Claude work and uses a private Enduragent folder with none of your files.

## 0.0.4

### Patch Changes

- 3e8fbe5: User-facing: Added optional Telegram bot setup directly to the desktop Chat setup screen.
  User-facing: Moved required desktop setup into Chat and kept it available in Settings for recovery.

  Setup now stays in Chat until the coach is ready and remains available at the top of Settings for credential and training-data recovery.

  Desktop setup readiness is rechecked from durable runtime state on every launch, and chat actions fail closed until the provider, training data, and saved safety intake are ready.

  Chat setup can connect a Telegram bot from a copied BotFather token and safely delete its connection from this Mac, and always keeps pairing and access management in Settings.

- a6a2cf4: User-facing: Desktop now asks you to quit and reopen the app when an update check cannot safely continue, instead of offering a retry that cannot run.

  Invalidate timed-out updater generations, fence late completions, and keep automated and manual checks disabled until process restart after timeouts or updater startup failures because the native macOS updater does not expose a supported instance reset.

- da84213: User-facing: Desktop update actions now wait for in-progress Settings changes to finish before restarting the app.

## 0.0.3

### Patch Changes

- 0da7580: User-facing: Desktop now uses the Enduragent logo as its app icon and has a simpler sidebar with clearer training-data sync status.

  Replace the default packaged application icon with the website mark, remove sidebar surfaces that duplicate Chat navigation or expose internal process state, and label successful refreshes as "Training data synced."

## 0.0.2

### Patch Changes

- d22fb9a: User-facing: ChatGPT sign-in now finishes promptly after browser approval, shows clear progress, supports cancellation, and can retry coach activation without another login.
- e4543b7: Render Desktop coach prose in the native system font, dropping the bundled Source Serif 4 webfont and its NOTICE entry.
- 78971cb: Adds boundary-scoped archived conversation reads (list plus a cursor-namespaced page reader) through the durable transcript store, daemon RPC registry, main-process IPC, and the validated preload bridge. Current-conversation hydration is untouched; the archived surface has no composer, retry, or resume path. Protocol version moves to 11 because the wire method set grew.
- 2e61329: Add curated and custom model selection, write-only endpoint overrides, explicit provider activation, and retry-safe non-secret Setup drafts.
- 2e437f8: User-facing: Added an optional Desktop-hosted Telegram bot with private pairing, local-only availability, and separate Telegram chat history.

  Added main-only clipboard capture, a strict redacted mutation contract, a coherent encrypted bot profile, visible replacement controls, background startup, transient sleep/resume handling, and generation-drained token replacement for Desktop Telegram setup.

- 810b29e: Add bounded, cursor-stable transcript pagination for the canonical Desktop conversation across the durable store, daemon RPC, main-process IPC, and validated preload bridge.
- 9f9d8c2: User-facing: Setup now remembers the Claude subscription lane instead of showing Anthropic when you reopen it.

  `credential_configured` was derived from a non-empty `llm.api_key` for every provider except `openai-codex`, so the keyless lanes that never write a key — `claude-cli` and `codex-agent` — were structurally false forever. That nulled the onboarding wizard's active provider, and the Setup draft then fell through to the first entry in the provider catalogue. The runtime check now short-circuits on `isKeylessProvider` and only falls through to the key-length test for providers that actually hold a key. The `openai-codex` branch stays ahead of that short-circuit, so the ChatGPT lane still depends on a stored auth profile rather than reporting itself configured with nothing on disk.

  Populating the active provider exposed a latent assumption in the Settings coach panel: it treated an active provider that is absent from the public model catalogue as an unloadable configuration. `codex-agent` is deliberately absent from the catalogue, so that path became reachable for the first time and would have left those athletes on a dead error screen with no way to switch away. The panel now loads with the provider list intact and no draft selection, and the coach route row reads the active provider off the runtime snapshot instead of the draft, so it no longer reports "Not configured" for a provider that is actually serving turns. An empty catalogue is still a genuine load error.

- fa0f19d: User-facing: Telegram settings now replace expired pairing instructions with the bot's current pairing state.

  Reconcile action feedback against semantic bot, power, channel, and pairing state so successful instructions cannot outlive the state that produced them, while preserving warnings and errors across health polls.

- 24437a7: User-facing: Telegram setup now explains how to recover when secure token storage or Keychain access is unavailable without changing the current bot.

  Preserve closed secure-storage refusal reasons across the Desktop process boundary, refuse unencrypted token storage, and emit stage-and-reason-only local diagnostics without exposing credential details.

- Updated dependencies [4f99951]
- Updated dependencies [d22fb9a]
- Updated dependencies [fc9ed36]
- Updated dependencies [61a8940]
- Updated dependencies [78971cb]
- Updated dependencies [1977c1b]
- Updated dependencies [2e437f8]
- Updated dependencies [810b29e]
- Updated dependencies [e09a645]
- Updated dependencies [67174e9]
- Updated dependencies [aebc383]
  - @enduragent/coach-contract@0.1.1
  - @enduragent/coach-client@0.1.1
