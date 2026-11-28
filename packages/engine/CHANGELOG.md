# @enduragent/engine

## 0.2.0

### Minor Changes

- 71a5e7d: User-facing: When you first open a ride in Activity review, the coach writes a short verdict on it with one reply on your own model; if that fails, the ride says so and spends nothing more until you press Write again. You can leave the coach a note on the ride that it reads when you write again, and Ask the coach, here and on a Calendar workout, now adds its question after whatever you have already typed in Chat.

  The `plan.calendar` RPC gains `read-review`, `write-verdict` (with an `expected` state and reply count, refusing with `review-changed` when they moved on) and `save-note`; `decide-ride` also starts the verdict when the athlete answers the match, and a verdict that cannot start never fails the saved match. The verdict moves only through the engine's `coachTextStep`, which now records whether a failure came from the model or from an interrupted write and writes again on open only after an interrupted one. It runs in the background on the athlete's chat model under the new `coach-text` caller, asks for low reasoning effort with a 600-token cap only where the provider honours it (OpenAI reasoning models, codex-agent; Anthropic keeps thinking off at 600) and otherwise keeps the provider's default effort with a 2,000-token cap, aborts before its lease runs out, never abandons a write whose job is still running, and is stored with the note, the failure's cause and the last kept verdict in the new `activity_review` table (migration 037). The engine exports the writer from `@enduragent/engine/coach-text-writer`. `createWorkoutCardController` drops `composerEmpty` and prefills through `requestComposerPrefill`, like Activity review's Ask.

- 09a5e23: User-facing: A new Plan now waits for your Approve before anything reaches intervals.icu. The Calendar shows this Training Week and next as one set to approve, and Settings can make each later week wait for its own Approve. You can also turn on starting Enduragent at login so later weeks go out on time.

  Activation writes "waiting for Approve" in the same transaction. While the first Approve waits, later weeks show the day they will go out. The renderer gains a Start at login bridge over two trusted IPC channels, reusing the tray's durable login-item path.

- 0bcd503: User-facing: When you edit, move or delete a Plan workout in intervals.icu, the Calendar now marks it and asks what you want. Keep makes the Plan follow your change; Put back restores the Plan's version on intervals.icu. Nothing is changed until you choose.

  The `plan.calendar` RPC gains change-detail, keep-change and put-back. Each reads the event back from intervals.icu before it acts, and a newer edit is shown first instead of being overwritten. Keep on an edit or move applies a Plan Change that keeps the physical workout id.

- 3436f66: User-facing: Your Plan now keeps this Training Week and next on intervals.icu, sending each new week 7 days before it starts. Changes you make to a Plan workout in intervals.icu are kept instead of being put back by the app.

  The desktop calendar mirror sends whole Training Weeks and keeps intervals.icu's own read-back of each workout as its baseline. It writes only after re-reading the event and finding it unchanged, and never sends a write that changes nothing. End and Replace remove the old Plan's own workouts from tomorrow on, and leave today's workout and the ones the athlete changed. A new `plan.calendar` call approves weeks and saves the "Approve each week" setting.

- dbe61e3: User-facing: When the coach can't answer because your Claude Code, Codex or ChatGPT sign-in has ended, your AI provider account is out of credits, or your provider no longer offers the model you picked, Chat now says so under your message and tells you what to do next. Before, it showed only a red icon and Retry, or blamed an API key you don't have.

  Core classifies a provider error whose code or type is `model_not_found`, or Anthropic's `not_found_error` on the anthropic route, as the new `model_unavailable` failure (a bare 404, which a wrong base URL also returns, stays generic), and an OpenAI 429 whose error type or code is a billing limit (`insufficient_quota`, `credit_balance_exhausted`, spend or usage limits) as `payment_required`, so it is no longer retried as a rate limit. The route comes from the chat model's provider; a 429 from any other provider stays a rate limit. The engine chooses the athlete copy from the failure and the provider: a sign-in failure on Claude Code, Codex or ChatGPT gets the new `subscription-signed-out` kind with the existing "sign in again" message, a 402 from a key provider other than OpenRouter gets the new `provider-credits` kind, and a missing model gets the new `model-unavailable` kind. Chat shows these three, and OpenRouter's credits notice, as a red notice under the kept message. A rejected API key, rate limits and other failures keep the icon and Retry. Telegram and the terminal keep their existing replies. The three new error kinds change the turn-event wire, so the coach protocol moves from 38 to 39.

- 1949824: User-facing: Enduragent now uses one FTP, the one in intervals.icu, shows each ride's FTP and FTP history on Activity review, and writes a coach's proposed FTP to intervals.icu only after you confirm. Chat's Change one thing no longer offers Correct FTP, past FTP changes stay in Plan history, and Plan details no longer shows old FTP guidance.
- b476f6d: User-facing: intervals.icu now shows each Plan workout's steps and load when it has your FTP, so your head unit gets watts for every step. Without an FTP in intervals.icu, workouts go there as before, with no steps.

  The Chat calendar mirror writes each workout's description at send time from its stored `content`, as step lines in % of FTP, and only while the one FTP is known. A "Warmup" line heads a warm-up step and a "Cooldown" line a cool-down step; both are intervals.icu syntax and stay in English in every locale, like "3x". The text is part of the send fingerprint, so an FTP appearing or being removed rewrites the workouts in the two-week window once. Athlete edits are still never overwritten, and a past workout keeps what intervals.icu has. A workout matched to a ride keeps its text there when only the text would change. A coach change to its day, name, sport or length still goes out, with the current text. When the steps are removed, intervals.icu keeps the load and intensity it computed from them. Rows without `content` keep any stored description unchanged.

### Patch Changes

- df8343a: User-facing: A new Activity review page, below Calendar, lists your rides by Training Week and shows each ride's facts. When the app asks "Is this the Plan Workout?", answer yes, no, or another day's workout, and the Calendar shows your answer.

  The `plan.calendar` RPC gains `rides`, which runs the match refresher over the active Plan's part of the range and lists cycling rides with a ride-centric Plan Workout match and the Plan's Training Weeks, and `decide-ride`, which confirms a suggestion, turns it down as Extra, or matches the ride to another nearby workout, and refuses with `match-changed` when the match differs from the `expected` one the page showed. The Plan Workout match repository now lets the athlete take back a confirmed heuristic match and confirm a pairing turned down earlier, and never stores a second confirmed match, or a new suggestion, for a workout or ride that already has a confirmed one; `observe` returns null when it stores nothing and leaves an unchanged suggestion as it was. Confirming a match deletes the other suggestions for that workout and that ride, and the new `withdraw` deletes a suggestion or an intervals.icu pairing the system derived, never the athlete's own answers, so both come back when the evidence returns. The match refresher stores no length for a zero-length ride, withdraws an intervals.icu pairing the ride no longer carries, and the Plan page projection prefers a confirmed match over a suggestion. Turning down or moving a ride's match records its current intervals.icu pairing as unpaired, so the pairing does not come back. Matching a ride again to a workout whose intervals.icu pairing the athlete turned down clears that unpaired row (`clearUnpaired`) and stores the athlete's own match.

- 78c0c28: User-facing: Starting a fresh session automatically no longer drops queued follow-up messages or prints two fresh-session notices.

  Preserves the durable chat queue across automatic stale-session resets, replays live queue events for overlapping `resumeChatQueue` callers, and removes the duplicate archive disclosure instruction from the model prompt.

- eefa039: User-facing: Today's spend in Settings now includes AI requests that failed, timed out or were stopped, with the usage your provider reported before they ended. A request that ended before reporting any usage adds $0.00, so today's total can be a little lower than your provider's bill.

  Every model-call row in the usage ledger now carries the turn that made it (`turnId`), whether the call succeeded (`outcome: "ok" | "error"`) and, for a failed call, why (`errorClass`: a failure reason or `aborted`). A failed, timed-out or aborted call now writes its row with the known usage of the steps that finished before it ended. The spend meter counts a failed call with no usage figure as a known zero, so one failed call does not mark the day incomplete. Known usage is a lower bound: an HTTP error carries no usage figure, and the provider may still bill the step that was in flight.

- 02c7694: The usage ledger's turn row (`kind: "turn"`) is now the sum of every chat-model call the turn made, failed and stopped attempts included, instead of the last successful call only. It is written on every exit that logs `turn_outcome`: a reply, a Coach decision, a failure after a write, a stop and a final failure. Each turn row carries `turnId`, `outcome` and, for a failed turn, `errorClass` (`aborted` for a stop, `budget` when the turn ran out of its budget). It sums known usage: a failed call with no usage figure is a known zero, so it keeps the turn's cost known, and a turn whose calls all failed that way records zero tokens and $0. A queue retry reuses the turn's ID, so the retry's turn row also adds the chat calls the earlier run left in the ledger; the latest turn row for a `turnId` is that turn's total. Compaction and memory-flush calls keep only their own rows. `pnpm usage:baseline` gains `--outcome ok|error|all`, defaulting to `ok` for every row kind, and keeps only the latest turn row for each `turnId`. Today's spend and season review read only per-call rows, so no figure an athlete sees changes.
- cb4af29: The engine now records an OpenTelemetry span tree for each coach turn: one `coach.turn` span, one `llm.generate` span per model call and one `tool.call` span per tool call. Spans carry the turn's random ID, provider, model, caller, attempt, outcome, error class, token counts, known-usage cost and durations. They never carry prompts, replies, tool arguments or results, error messages, memory or the chat ID. Nothing registers a tracer provider yet, so the spans are no-ops and nothing is exported.
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
  - @enduragent/kernel@0.2.0
  - @enduragent/i18n@0.4.0

## 0.1.0

### Minor Changes

- 0eb83f7: User-facing: When your OpenRouter account runs out of credits, Chat now says so and offers an Add credits button that opens OpenRouter's credits page. Your message stays in Chat, so you can send it again once you have added credits.

  Core classifies an HTTP 402, or OpenRouter's mid-stream `{ code: 402 }` error part, as the new `payment_required` failure ahead of the message-text heuristics. The engine turns it into the new `openrouter-credits` error kind only when the chat model runs on OpenRouter; a 402 from any other provider, and Telegram and the terminal, keep the generic message. The turn is not retried. Chat shows the message under the kept athlete message with Retry, and Add credits calls the existing main-process `openOpenRouterPage("credits")` bridge, so the renderer never builds a URL. The kind lives only on the in-memory turn, so after a relaunch the failed message shows the usual Retry without the credits text.

### Patch Changes

- 0992b39: User-facing: Plan workouts that the app puts on your intervals.icu calendar no longer pile up as extra copies each time the app checks the calendar. Workouts with steps now show those steps and their training load in intervals.icu. Copies made by earlier versions stay on your calendar.

  intervals.icu replaces a client's `uid` with its own, so the calendar mirror could never find the events it had made: it created them again on every run and never verified. The mirror now marks its events with `external_id`, which intervals.icu keeps, and no longer sends `upsertOnUid`. It sends only the description, because intervals.icu keeps a client `workout_doc` as is and then cannot read it.

  The reconciler and the outside-edit check no longer compare `workout_doc`, nor the duration of a described workout, since intervals.icu derives both from the description. Adopting an outside edit no longer copies intervals.icu's `workout_doc` into the Plan. Plan calendar events stay outside the chat workout tools, now that their `external_id` is visible. Events made by earlier versions are not recognised or removed.

- Updated dependencies [b0c88aa]
- Updated dependencies [0eb83f7]
- Updated dependencies [78ecb9c]
  - @enduragent/i18n@0.3.0
  - @enduragent/coach-contract@0.2.0

## 0.0.9

### Patch Changes

- Updated dependencies [2fd6f2e]
  - @enduragent/coach-contract@0.1.7
  - @enduragent/kernel@0.1.4
  - @enduragent/i18n@0.2.5

## 0.0.8

### Patch Changes

- 12d83db: Bump `@modelcontextprotocol/sdk` from 1.30.0 to 1.32.1 to clear GHSA-6qxp-vccf-f47h (CVE-2026-104850). The advisory covers the SDK's OAuth client, which no Enduragent code uses: the engine runs an MCP server with its own bearer-token check, and `@anthropic-ai/claude-agent-sdk` imports only the server and type modules. The bump keeps installs of `cycling-coach` off the vulnerable range.
- Updated dependencies [29e7393]
- Updated dependencies [2f95252]
  - @enduragent/i18n@0.2.4
  - @enduragent/coach-contract@0.1.6

## 0.0.7

### Patch Changes

- aae19b5: User-facing: The coach now tells a fatigue score you log apart from your training-load fatigue when it looks up wellness straight from intervals.icu.
  User-facing: The coach's wellness lookup now includes fitness and weekly fitness change for synced days.
  User-facing: The coach now says when some wellness days could not be read.

  `decodeWellnessRow` moves the score intervals.icu sends under `fatigue` to `subjectiveFatigue`, renames the load averages, and parses the day. It rejects a row that already carries a coach-only key, a row that still holds a platform load key after the renames, a score that is not a whole number, and a load average that is not a number. The live reader decodes each row, so `intervals_fetch_wellness` and the athlete snapshot read coach words in live mode. A row that cannot be decoded is skipped with a `notice` that names the first unreadable wellness field of each skipped day. A day skipped for a platform load key or for not being an object is counted but not named; when none can be decoded the read fails with `wellness_unreadable`. Stored days are unchanged, but the tool's key list now passes `fitness` and `weeklyFitnessChange` for them. Capture, projection and the legacy sync still use the rename and parse pair. Second of six changes for #1130.

- Updated dependencies [1cb7f32]
- Updated dependencies [d4be2cf]
- Updated dependencies [1e3c8f9]
- Updated dependencies [aae19b5]
  - @enduragent/i18n@0.2.3
  - @enduragent/kernel@0.1.3

## 0.0.6

### Patch Changes

- 514f5f9: User-facing: Model limits, image support, and usage costs now remain consistent while Enduragent refreshes its model information.
- 600295a: User-facing: The npm coach now starts the same 24-hour model-list refresh that desktop already runs, so Setup and Chat stay on one list.
- Updated dependencies [922c4ad]
  - @enduragent/coach-contract@0.1.5
  - @enduragent/i18n@0.2.2

## 0.0.5

### Patch Changes

- Updated dependencies [a372f86]
  - @enduragent/coach-contract@0.1.4
  - @enduragent/i18n@0.2.1

## 0.0.4

### Patch Changes

- 2354437: User-facing: Attached PDFs are read in full up to the size limit instead of half, and the coach is told plainly when a document was cut.
- 5a9f738: User-facing: Replies now appear word by word while the coach is still writing, on ChatGPT sign-in as well as API keys.
- 5ecffcc: Route fixed Telegram, terminal, and coach messages through the shared English catalog and preserve message descriptors alongside existing wire text.

  User-facing: The Telegram bot, the terminal setup, and the coach's fixed replies now use your language, and the terminal setup asks for your language when your computer's language is not one it speaks.

- c090b3e: User-facing: Saving your conversation to memory is faster and cheaper because the coach only reviews what is new since the last save.
- f09f4e4: User-facing: The coach already knows your profile and today's wellness when you start typing, so replies come faster and cost less.
- ae70f69: User-facing: If ChatGPT is still looking something up, a slow reply can retry instead of stopping on the first words. A memory save that fails during a long chat is retried after you reopen the app. Garmin labels stay on the facts they belong to.
- aff777d: User-facing: When you ask the coach about something you told it before, it finds the exact note and shows your most recent notes first.
- 074740b: User-facing: Long conversations cost less on API-key providers because earlier messages are reused from cache instead of being resent.
- f767b66: User-facing: If you close the app right after the first chat of the day, what you told the coach is still saved to memory the next time you open it.
- 7972d4c: User-facing: Deep ride reviews load faster because the coach no longer downloads thousands of second-by-second data points it was told not to use.
- b30d963: User-facing: Long conversations recover from slow replies more reliably, and the app no longer pauses to tidy its log on every line it writes.
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
  - @enduragent/kernel@0.1.2

## 0.0.3

### Patch Changes

- 09c5ca3: Refresh runtime dependencies, including XML parser security fixes and desktop updater compatibility updates.

  User-facing: This update improves the safety of imported files and refreshes the libraries used for coaching and app updates.

- 2d0128c: Add the privileged Chat attachment-admission contract and durable queued-Message attachment identities.
- b38ae00: User-facing: Coach answers can now offer a safe Continue in Plan card, resolve Workout date conflicts, retry failed handoffs without duplicates, and recover a Proposal when a local Plan save fails.

  Chat keeps typed Plan handoffs with their transcript turn, while Plan protects athlete-created Workouts and requires review before applying a new date or replacing a coach-owned Workout.

- 8c20aef: User-facing: Workout handoffs from Chat now open the same reviewable Plan Proposal after retries or relaunch, while Draft and Plan-creation requests continue in their exact Plan conversation.

  Planning stores the destination artifact and request relation together, preserves date conflicts for review, and keeps delivery retryable when destination intake is temporarily unavailable.

- dc24ae3: User-facing: Applying or rejecting a Chat-originated Plan Proposal now records the matching Chat result atomically, so relaunch cannot show a stale or contradictory handoff.

  Planning keeps revised Proposals attached to their originating request, rolls back the complete Plan change when terminal-result storage fails, and leaves calendar mirroring separate from local success.

- 1e07590: User-facing: Queued messages with only an attachment now keep that attachment when retried after reopening Chat.
- f191262: User-facing: After a long conversation is condensed, the coach no longer re-reads the same condensed notes twice on every message that day.
- 9d86d76: User-facing: The coach answers first and saves notes to memory afterwards, so the first message of the day and long conversations no longer wait on housekeeping.
- 3627ecd: Retain unsummarized conversation history after compaction failures and stop when it cannot safely fit.

  User-facing: If a conversation summary fails, the coach keeps the original context or asks you to try again instead of silently forgetting earlier goals and corrections.

- 2a2c852: User-facing: The usage log now counts cached tokens once, so the cost it shows for API-key providers matches what the provider bills.
- 3077144: User-facing: Your coach can remember decisions as you share them without saving duplicates, and find earlier versions of your stored information. Memory reads avoid repeating the athlete details already shown to your coach.
- c507634: End an active Plan locally before removing tomorrow-onward Plan-owned Intervals workouts, with durable retry and verify-only recovery that preserves today and athlete-created events.
- e649a25: Add display-only Estimated CP from two eligible recent measured-power efforts, including stale and unavailable states, an explanatory tooltip, evidence and route-assumption drawers, and strict isolation from FTP and Plan mutations.
- f6cacbb: Add forward-only race-readiness projections, explicit unavailable and changed-assumption states, refresh recovery, and taper safety refusal without mutating the active Plan.
- b02a1e8: User-facing: Plans now end automatically after their final date and let athletes record the race as Completed or Not completed without changing their saved Plan.
- b87174d: Replace an active Plan atomically while preserving today, verify tomorrow-onward cleanup of the old Plan before writing the replacement’s next seven days, and keep failures recoverable after relaunch.
- 3ad0c39: Show every active Plan week with phase, purpose, status, and planned time, plus a complete authoritative race-week schedule with separate training, race, and total accounting.
- a52086c: Add Plan-scoped settings with immediate persistence and safely auto-apply eligible future workout duration reductions.
- 6546ba5: User-facing: Active Plans can now show one automatic, score-free review of the latest completed week after a successful sync.
- 1594b20: Retire prompt instructions written for earlier models: remove the completed memory-section migration clause from the flush prompt, drop two redundant conduct rules and a numeric bullet cap from the cycling soul, soften two shouting registers, and give plan_save a real tool contract. Also drop the retired `.ralph/` gitignore entry.
- 391ff3f: User-facing: The coach reads a shorter set of instructions on every message, so each reply costs a little less. Power is now called weighted avg power everywhere, and the coach no longer rejects realistic FTP values.
- a5a366f: User-facing: Stopping a Chat response or losing connection now keeps the interrupted message retryable and sends later queued messages once, in order.
- eba82b9: User-facing: Chat recovery now survives repeated connection losses without duplicating your message after relaunch, while preserving every partial and completed Coach response.
- 2567965: User-facing: Plan coach conversations now collect durable training inputs, show a reviewable summary, and create a complete structured Draft before anything can activate or reach the Intervals calendar.

  The Plan composer stays at the bottom, optional Race Course attachment lives inside it, and interrupted intake saves recover from the conversation after relaunch.

- a415177: Add the internal training-history contract, persisted coverage evidence, calendar-aware capture plan, and state composition wiring.
- 3627ecd: Prepare explicit Astra selection on the public OpenAI API while retaining existing default models and restricting unverified subscription transports.

  User-facing: You can explicitly choose Astra with an OpenAI API key. Existing model choices stay unchanged, and unavailable cost estimates are not shown as known prices.

- 63a0f54: User-facing: When the coach looks up your recent activities or wellness, it now reads only the fields it needs, so those checks cost fewer tokens and long date ranges no longer flood a reply.
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
- Updated dependencies [30ca87f]
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
- Updated dependencies [4018b25]
- Updated dependencies [f65201d]
  - @enduragent/coach-contract@0.1.2
  - @enduragent/kernel@0.1.1
  - @enduragent/i18n@0.1.2

## 0.0.2

### Patch Changes

- 61a8940: Added desktop PKCE sign-in, daemon-owned OAuth profile storage, and keyless runtime configuration for the ChatGPT subscription provider.
- 1977c1b: Added provider-reported OpenRouter costs and aggregate authenticated spend methods for the desktop client.
- 67369bb: Add an internal append-only transcript writer with a 262,144-byte serialized-record bound and conversation reset boundaries for durable Desktop capture. Renderer history and hydration are not exposed in this slice.
- 037a09a: Upgrade the Intervals.icu client to 0.3.1 and keep canonical managed activities separate from the snake_case Reference persistence boundary.
- 89a6522: Migrate managed calendar writes to the Intervals.icu client's canonical camelCase request contract.
- Updated dependencies [8ac6eec]
- Updated dependencies [4f99951]
- Updated dependencies [a6f259c]
- Updated dependencies [ec24061]
- Updated dependencies [d22fb9a]
- Updated dependencies [fc9ed36]
- Updated dependencies [5428c22]
- Updated dependencies [61a8940]
- Updated dependencies [78971cb]
- Updated dependencies [1977c1b]
- Updated dependencies [2e437f8]
- Updated dependencies [810b29e]
- Updated dependencies [0ab935f]
- Updated dependencies [42c6efa]
- Updated dependencies [517a34f]
- Updated dependencies [c122f29]
- Updated dependencies [111261c]
- Updated dependencies [4e996bc]
- Updated dependencies [66fc866]
- Updated dependencies [b8a8ef0]
- Updated dependencies [0b73876]
- Updated dependencies [00ee9f4]
- Updated dependencies [e09a645]
- Updated dependencies [68821e7]
- Updated dependencies [10c6d16]
- Updated dependencies [9a7961c]
- Updated dependencies [ded6067]
- Updated dependencies [67174e9]
- Updated dependencies [aebc383]
- Updated dependencies [336462d]
- Updated dependencies [fd9cd3a]
  - @enduragent/kernel@0.1.0
  - @enduragent/coach-contract@0.1.1
