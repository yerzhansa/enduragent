---
"@enduragent/desktop": patch
"@enduragent/desktop-renderer": patch
---

User-facing: If you chose a language that differs from your computer's, the app no longer briefly switches to your computer's language when you open Settings or when the coach reconnects.

The language preference now has one meaning for `loading`: nothing has been read yet. Re-reading a known preference keeps the confirmed value on screen until the answer arrives, and the view state type no longer allows `loading` to carry a value.
