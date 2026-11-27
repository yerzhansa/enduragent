---
"@enduragent/core": patch
"@enduragent/desktop": patch
---

User-facing: Desktop app updates now download much less data, and Telegram workout chart labels render reliably in the desktop app.

Exclude non-runtime TypeScript declarations, TypeScript sources under `node_modules`, workspace `src/` directories, build-time i18n catalogs/glossaries, and unused browser bundles from `app.asar`, and unpack `clawpdf`'s `pdfium.esm.wasm` and `@enduragent/core`'s `workout-chart-font.otf` into `app.asar.unpacked` so differential updates reuse immutable large binaries and `@resvg/resvg-js` can read the chart font from disk.
