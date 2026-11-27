---
"@enduragent/coach": minor
"@enduragent/engine": minor
"@enduragent/kernel": minor
"@enduragent/desktop": minor
"@enduragent/i18n": minor
---

User-facing: A new Plan now waits for your Approve before anything reaches intervals.icu. The Calendar shows this Training Week and next as one set to approve, and Settings can make each later week wait for its own Approve. You can also turn on starting Enduragent at login so later weeks go out on time.

Activation writes "waiting for Approve" in the same transaction. While the first Approve waits, later weeks show the day they will go out. The renderer gains a Start at login bridge over two trusted IPC channels, reusing the tray's durable login-item path.
