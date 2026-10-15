---
"@enduragent/engine": patch
"cycling-coach": patch
---

Bump `@modelcontextprotocol/sdk` from 1.30.0 to 1.32.1 to clear GHSA-6qxp-vccf-f47h (CVE-2026-104850). The advisory covers the SDK's OAuth client, which no Enduragent code uses: the engine runs an MCP server with its own bearer-token check, and `@anthropic-ai/claude-agent-sdk` imports only the server and type modules. The bump keeps installs of `cycling-coach` off the vulnerable range.
