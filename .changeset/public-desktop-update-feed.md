---
"@enduragent/desktop": patch
---

User-facing: Versions 0.3.0 and 0.4.0 cannot update themselves. Download the latest macOS installer from https://enduragent.icu/download/mac. This version and later will check for updates again.

Packaged `app-update.yml` now points at `https://updates.enduragent.icu/`, a Cloudflare Worker that follows GitHub Releases latest/download redirects on the server and returns YAML and artifacts with no `Location` header. GitHub remains the canonical publish target. Installed 0.3.0 and 0.4.0 builds still use the GitHub URL and cannot self-heal.
