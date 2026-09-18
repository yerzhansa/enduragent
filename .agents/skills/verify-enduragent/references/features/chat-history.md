# Chat and Past Chats

## Sub-features

- `chat.streaming.ordered`: visible ordered streaming and canonical completion; live executor `playwright`, deterministic citation `apps/desktop-renderer/tests/chat-controller.test.ts`.
- `chat.history.current-conversation`: earlier current-chat pages; executor `vitest`, citation `apps/desktop-renderer/tests/chat-surface.test.tsx`.
- `chat.history.past-list`: newest-first archive list; executor `vitest`, citation `apps/desktop-renderer/tests/archive-controller.test.ts`.
- `chat.history.past-viewer`: read-only archived transcript; executor `vitest`, citation `apps/desktop-renderer/tests/archive-surface.test.tsx`.

Fixture profile: `ready`.

## How to get to it (user POV)

- Choose **Chat** in Main navigation to send messages and read the current conversation.
- Scroll the current transcript to its top, or choose **Load earlier messages**, to load earlier turns when available.
- Choose **Past chats** in Main navigation, then open a conversation to read it without a composer.

## Driving it with verify-enduragent

```bash
pnpm --filter @enduragent/desktop-renderer exec vitest run tests/chat-controller.test.ts tests/chat-surface.test.tsx tests/archive-controller.test.ts tests/archive-surface.test.tsx
pnpm --filter @enduragent/desktop test:e2e tests/e2e/chat-core.spec.ts
```

Require the Playwright assertions to show the athlete message, ordered coach deltas, canonical completed response, and preserved draft and response across navigation to **Training**. Require the cited Vitest files to prove earlier-page loading, newest-first archives, and a read-only past-chat viewer.

## Gotchas

- The Playwright fixture uses isolated athlete and Electron state, memory credentials, blocked HTTP, and owner-scoped cleanup.
- The mapped `chat-core` Playwright fixture returns an empty archive list. Seeded live Past chats on that fixture is verified-unreachable until this page's Playwright fixture seeds archives. Do not substitute the operator's data or a Plan-owned e2e spec.
- Failure artifacts live under `apps/desktop/test-results/e2e/`; passing runs do not currently retain screenshots or traces.
