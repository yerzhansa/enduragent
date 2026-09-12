# @enduragent/i18n

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
