---
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
---

User-facing: Enduragent now reopens automatically if installing a desktop update fails instead of closing without restarting. Update downloads, automatic background checks, and Try again now recover cleanly after errors, and the sidebar no longer flashes "Restarting…" while checking for updates.

Replaces implicit update and quit flags across `update-controller.ts`, `update-state-machine.ts`, `quit-coordinator.ts`, `main/index.ts`, and the renderer update controller/UI with explicit closed phase unions. Detaches failed and ready operations immediately (eliminating retry wedges), resets the download transfer watermark on differential-to-full fallback, arms macOS Squirrel readiness listeners only after archive download completes, commits the updater only after configuration succeeds, keeps the 6-hour check timer scheduled on transient startup floor or config failure, freezes update IPC and controller synchronously before async shutdown awaits, relaunches the current app once on failed update drain/install handoff (including synchronous and asynchronous updater or native readiness errors), blocks renderer clicks before initial hydration, separates pending `checking` from `restarting` in `UpdateAvailableButton`, and surfaces IPC check rejections after intermediate pushes. Promotes all 10 findings in `.agents/skills/verify-update-download/` to guarded TLC controls.
