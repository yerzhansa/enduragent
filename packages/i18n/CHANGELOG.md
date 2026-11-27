# @enduragent/i18n

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
