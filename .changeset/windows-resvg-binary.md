---
"@enduragent/desktop": patch
---

Correct the two `@resvg/resvg-js` 2.6.2 Windows integrity hashes in `pnpm-lock.yaml` so pnpm installs `@resvg/resvg-js-win32-x64-msvc` on Windows, and let the Windows package verifier accept that one native module inside `app.asar`. The verifier accepts it only at `node_modules/@resvg/resvg-js-win32-x64-msvc/resvgjs.win32-x64-msvc.node`, only as an x64 PE binary, and only when a runtime package declares `@resvg/resvg-js`. Every other native module in the ASAR is still rejected. Without the binary, the Telegram workout review could not render its chart on Windows.
