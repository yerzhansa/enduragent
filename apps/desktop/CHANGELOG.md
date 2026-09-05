# @enduragent/desktop

## 0.1.6

### Patch Changes

- a9f8a64: User-facing: Aligned the AI setup choices with their menu heading.
- 8f6a401: User-facing: Prevented Enduragent from deleting its encryption key when credential storage cannot be safely inspected.

  Credential envelope scans now bind both vault roots before automatic Keychain key retirement and
  fail closed when either root is unsafe or changes during the scan.

- c00a360: User-facing: Prevented unsafe credential files or a changed macOS Keychain key from making saved credentials unreadable.

  Automatic key retirement now requires a bounded, stable cross-vault census, and every credential write revalidates the persisted key without user interaction.

- 2e60bfc: User-facing: Kept credential recovery available when secure storage or its local inventory cannot be inspected safely.
- 78ff76f: User-facing: Prevented locked or inaccessible macOS Keychain items from deleting stored credential keys.
- ccfee17: Attach supported documents, activities, planned workouts, and images to Coach messages while keeping drafts and file processing local.
- c4d7395: Restore sent attachment cards after relaunch and harden attachment cleanup, recovery, and privacy-safe diagnostics.
- 92ca64a: User-facing: Added a standard Coach decision panel for important training choices, with custom answers, Skip, saved consequences, and relaunch recovery.

  Important coaching choices now remain blocked until answered or skipped, and interrupted continuations resume once after relaunch.

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

- 0e37ca0: Add schema-valid Plan and populated Training inspection fixtures for isolated desktop development.
- 795fccf: User-facing: Saved queued Chat messages across app restarts, added explicit recovery actions, and now keeps a queued message visible with an error when removal cannot be saved.
- 584b01b: User-facing: Training now uses a compact ride-import control without an extra file-selection message and ends after your recent rides. Ride review shows recorded analysis without the ride-export card.
- 3627ecd: Distinguish confirmation guard refusals and returned failures from completed changes.

  User-facing: When a workout can no longer be changed, the coach explains why instead of saying it is done.

- ae481be: Visible desktop test-harness windows no longer pin the page to a fake fixed viewport, so resizing the window resizes the app.
- 4ab3aab: User-facing: Fixed saving credentials failing with "encryption unavailable" on macOS.
- 204820a: User-facing: Credential deletion on Windows and Linux now protects another athlete’s Telegram profile and keeps credentials that cannot be restored.
- 48f6422: User-facing: Diagnostic logs now hide sensitive error text and credential-bearing URLs. Secret helper failures show an exit code and setup guidance without exposing helper output.
- 8d5e9df: User-facing: Removing credentials no longer marks an environment-managed provider as needing repair.
- 3627ecd: Retain unsummarized conversation history after compaction failures and stop when it cannot safely fit.

  User-facing: If a conversation summary fails, the coach keeps the original context or asks you to try again instead of silently forgetting earlier goals and corrections.

- f3a8b51: User-facing: Adding more than five files now keeps the first five. Pasted images show as `Pasted image.png`.
- 5ba9576: User-facing: Coach responses in Chat now use the intended compact text size and line spacing.
- 3627ecd: Clarify the training-data setup subtitle.

  User-facing: Setup now says you can connect a service or import ride files.

- 69e5ec7: User-facing: Plan approval now activates locally first, then updates only today and the next six days in Intervals with visible retry and verification controls.

  Interrupted calendar updates resume safely after relaunch without duplicating workouts.

- 4cb231f: User-facing: Add or skip a GPX/FIT Race Course while creating a Plan, recover from invalid or elevation-free files, and recalculate Drafts without changing the active Plan.
- b33490d: User-facing: Choose a Plan start date in a compact calendar, review full or short-block consequences, safely retry recalculation, and approve the completed Draft.
- 07b0a8d: User-facing: The active Plan now shows race-day Form and goal feasibility at a glance, with clearer race-week and readiness details. Ended Plans can open their saved coach conversation as read-only history.
- 851e7eb: User-facing: Added manual and Intervals FTP resolution to Plan creation, including source precedence, retry recovery, and automatic return to Draft planning.
- 36e7041: User-facing: Plan now keeps an immutable change history and lets you undo only the newest eligible future coach-owned Workout change.
- c03d713: User-facing: Added a dedicated coach conversation inside Plan, including streamed replies, queued follow-ups, Stop and retry recovery, and reviewable Draft creation and revision.
- 75065a2: User-facing: Plan changes now show an exact before-and-after Proposal with its evidence, and require explicit approval before changing future training.

  Proposal revisions preserve the active Plan until approved, stale changes are revalidated, rejected changes leave the Plan untouched, and malformed changes cannot apply.

- b02a1e8: User-facing: Plans now end automatically after their final date and let athletes record the race as Completed or Not completed without changing their saved Plan.
- a0c3913: User-facing: Added a Plan workspace that starts planning with the coach and highlights decisions that need attention.
- 5f707bc: Move planned Workout archive export to Plan and remove the Plan preview and aggregate adherence display from Training.

  User-facing: Export your planned workouts from the Plan page, right under this week's workout list. The Training page no longer shows the plan preview or the adherence percentage.

- 6546ba5: User-facing: Active Plans can now show one automatic, score-free review of the latest completed week after a successful sync.
- 697f674: User-facing: A workout sent from Chat can now become a reviewable Plan addition, and the newest eligible addition can be undone from Plan history.
- 6622b6a: User-facing: The active Plan now highlights workouts changed directly in Intervals and asks whether to adopt the edit or restore the Plan workout.

  Outside edits are never silently overwritten, and failed restores remain visible for retry until Intervals is verified.

- 036ebce: User-facing: The active Plan now shows whether this week’s workouts were completed as planned, adjusted, moved, missed, or extra, and asks before counting an uncertain activity match.

  Workout decisions remain local, survive relaunch, and never change Intervals pairings.

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

- 3627ecd: Prepare explicit Astra selection on the public OpenAI API while retaining existing default models and restricting unverified subscription transports.

  User-facing: You can explicitly choose Astra with an OpenAI API key. Existing model choices stay unchanged, and unavailable cost estimates are not shown as known prices.

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
- Updated dependencies [2d0128c]
- Updated dependencies [b38ae00]
- Updated dependencies [66579e6]
- Updated dependencies [8c20aef]
- Updated dependencies [d6d960f]
- Updated dependencies [dc24ae3]
- Updated dependencies [2d09c46]
- Updated dependencies [68bf244]
- Updated dependencies [3627ecd]
- Updated dependencies [48f6422]
- Updated dependencies [f3a8b51]
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
  - @enduragent/coach-client@0.1.2
  - @enduragent/core@0.1.4
  - @enduragent/coach@0.1.1

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
