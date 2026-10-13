---
"@enduragent/core": patch
---

Reading a calendar event before changing or deleting it now rejects an event whose tags are not a list of text or whose external id is not text, instead of passing the malformed value on.
