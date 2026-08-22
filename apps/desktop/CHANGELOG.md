# @enduragent/desktop

## 0.1.6

### Patch Changes

- b60e591: User-facing: Removed the What’s new window from Desktop settings.
- 11950d6: User-facing: Updated the conversation archive list and reader to the new interface system.
- 93cc0a6: User-facing: Updated chat cards, shortcuts, queued messages, and confirmation dialogs to the new interface system.
- 12d09bf: User-facing: Updated the coaching conversation, composer, history controls, and slash-command menu to the new consistent component system.
- 20144c2: User-facing: The desktop app now uses the Inter typeface, with real tabular figures so numbers in tables and metrics align at every weight; monospace surfaces use Geist Mono.
- 2f94075: User-facing: Fixed overlapping and clipped desktop controls in compact layouts.

  Restored palette swatch sizing, archive row flow, release-note centering, and opaque chat controls.

- 04f52c2: User-facing: Completed the new interface migration and standardized all desktop controls.
- c30e606: User-facing: Updated setup menus, labels, and status controls to the new interface system.
- daf701b: User-facing: The desktop interface now uses a consistent Primer-based type, spacing, control, radius, and contrast system.
- 131343b: User-facing: Updated settings controls, palettes, forms, and status panels to the new interface system.
- 424a57f: User-facing: Added a consistent accessible component foundation for desktop buttons, cards, dialogs, selects, popovers, tooltips, and menus.
- fb656ce: Added the shadcn component foundation while preserving the existing runtime palette system and Tailwind migration boundary.
- a6b5a20: User-facing: Updated the desktop shell, page headers, and shared confirmation controls to the new consistent component system.
- 795ec2a: User-facing: Updated the desktop sidebar, navigation, sync status, and update action to the new consistent component system.
- 4afb4b2: User-facing: Updated training summaries, progress tables, wellness trends, and export controls to the new interface system.
- e5ee01b: User-facing: Updated ride distributions and power-to-heart-rate analysis to the new interface system.
- b7af11c: User-facing: Updated ride lists, ride summaries, intervals, and best-effort analysis to the new interface system.
- 5691c18: User-facing: Updated the menu-bar status window to the new interface system.

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
