---
"@enduragent/desktop": patch
---

User-facing: The Windows app in the Microsoft Store now installs on Windows 10 as well as Windows 11.

The Store package's minimum Windows version drops from `10.0.22000.0` to `10.0.19041.0`. CI now registers the Store package on a Windows Server 2022 runner (build 20348, below Windows 11) and runs the packaged self-test against its executable.
