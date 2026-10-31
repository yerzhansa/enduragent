---
"@enduragent/desktop": patch
---

Bump Electron from 44.4.3 to 44.9.1 to fix a pointer-lock permission request that could be attributed to the wrong frame. Bump Vite from 7.3.6 to 7.3.7 in `apps/desktop` and `apps/desktop-renderer` to pick up the patched `launch-editor`, which fixes three Windows advisories in the dev server's open-in-editor route. Vite runs only during development and builds, so the Vite bump does not change the shipped app.
