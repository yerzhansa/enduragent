# Settings connections

## Sub-features

- Owned surface and user route: **Settings** in Main navigation (`activeView: "settings"`). `SettingsView` renders **Setup**, **Channels** (Telegram card), and **Coach** before other Settings sections; this page is not a complete Settings inventory. There is no visible **Training account** form.
- Coach and training scenario-map rows: `settings.providers.coach-route`, `settings.providers.credential-management`, `settings.intervals.connect`, `settings.intervals.delete-only`, and `settings.training-account.identity`.
- Telegram scenario-map rows: `settings.telegram.delete-only`, `telegram.setup.clipboard-connect`, `telegram.setup.refusal-recovery`, `telegram.connection.delete-only`, `telegram.pairing.webhook-removal`, `telegram.pairing.primary-user`, `telegram.allowed-senders.management`, and `telegram.lifecycle.turn-off-on`.
- Supported executors: renderer `vitest` for executable Settings behavior, desktop `vitest` for frozen scenario-map validation, and Playwright for hidden Training account plus Telegram Connect disclosure.

## How to get to it (user POV)

- Complete Setup, then choose **Settings** in Main navigation. Use [`setup.md`](setup.md) for the full-window gate, readiness, local ride-file import, and completion behavior.
- In **Setup**, change what powers the coach (the first row shows the coach in use), manage saved provider credentials, or connect/delete Intervals.icu. There is no Athlete ID field; missing-credential recovery on **Coach** offers **Review setup**.
- In **Channels**, the Telegram card connects a dedicated BotFather bot from the clipboard after **Connect**, can remove a webhook if requested, pair the primary user, manage additional allowed users, turn the connection off or on, or delete it locally.
- When sync drops Strava activities, a restriction card can appear under Coach.

## Driving it with verify-enduragent

```bash
pnpm --filter @enduragent/desktop-renderer exec vitest run tests/settings-surface.test.tsx tests/credential-settings.test.ts tests/athlete-settings.test.ts tests/telegram-settings.test.ts tests/telegram-settings-surface.test.tsx tests/onboarding-setup-card.test.tsx
pnpm --filter @enduragent/desktop check:verification-catalog
pnpm --filter @enduragent/desktop test:e2e tests/e2e/settings-training-account.spec.ts tests/e2e/telegram-disclosure.spec.ts
```

Require the renderer run to show Setup first, keep the in-use coach on Setup row 1, save a coach provider/model route, distinguish active and saved-not-in-use credentials, confirmation-gate local deletion, keep the Training account form hidden, keep secrets out of rendered fields, and expose truthful Telegram setup, pairing, allowed-user, recovery, and deletion states. Intervals connect/delete is in the Setup section and `onboarding-setup-card` citations.

Require Playwright to keep **Training account**, **Athlete ID**, and **Save athlete ID** absent across light/dark and two widths, and to open Telegram clipboard setup only after **Connect**, then collapse it on Settings reentry.

The catalog command validates the frozen manifests and that deterministic rows cite existing test names; it does not execute the mapped Settings behavior. The Telegram turn-off/on lifecycle row is catalog-validated; the listed renderer tests do not click Turn off/on.

## Gotchas

- Renderer tests use isolated state and mocked bridges. They do not exercise real provider or Intervals.icu credentials, local file selection/import, BotFather or Telegram networking, the OS clipboard, secure credential storage, or the Telegram daemon.
- Real Intervals.icu and Telegram connections require valid copied credentials and available OS secure storage; coach lanes may instead require browser sign-in, Claude CLI state, or a provider API key. Connection deletion is local; provider accounts, Telegram bots/chats, synced rides, and past chats follow the user-visible retention copy.
- `settings.windows.credential-wording`, `telegram.windows.setup-copy-storage`, `telegram.windows.packaged-connectivity`, and `telegram.windows.packaged-lifecycle` are `vm-only` and require an installed Windows VM plus manual credential, clipboard, network, and lifecycle checks.
- No S8A or native Windows automated flow is proved by these tests or manifests.
