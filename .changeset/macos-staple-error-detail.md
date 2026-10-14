---
"@enduragent/desktop": patch
---

The macOS release verifier now adds the last lines of `codesign`, `stapler` or `spctl` output to its failure message, so a failed signing or staple check says why it failed.
