# Notices and Attributions

This file lists upstream projects whose code or design Cycling Coach (and the
broader `enduragent` workspace) carries, along with the licenses they were
distributed under and the modifications introduced during the port.

---

## section-11

Cycling Coach's **Reference** submodule (the data + sport-aware adapter
substrate that grounds coaching in verified athlete numerics) is a port of
[section-11](https://github.com/CrankAddict/section-11) by CrankAddict,
specifically protocol v11.43, released under the MIT License.

### Original license (verbatim)

```
MIT License

Copyright (c) 2026 CrankAddict

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Modifications introduced in this port

The portable Reference metrics, schemas, validation modules, top-level modules,
and concurrency primitives are canonical in `packages/kernel/src/`; Reference
sync, audit, I/O, runtime, paths, adapters, services, validation gates, and
compatibility shims remain in `packages/core/src/reference/`. The following
modifications were applied during the port:

- **Trademark substitution.** Section-11 was authored against TrainingPeaks
  vocabulary. This codebase uses intervals.icu's plain-English alternatives
  throughout — the substitution is enforced by `pnpm check:trademarks` and
  documented in [`CONTRIBUTING.md`](https://github.com/yerzhansa/enduragent/blob/main/CONTRIBUTING.md#trademark-hygiene).
- **Multi-sport adapter pattern.** Per ADR-0010, the Reference layer gains a
  per-sport seam — sports plug in via an optional `referenceAdapters?()`
  method on the `Sport` interface, returning an array of layer-owned adapters
  with declarative metadata plus optional algorithm hooks (e.g.,
  `computeDfa`, `computePowerCurve`). Section-11's single-sport design is
  preserved as the cycling adapter; running and duathlon compose via the
  same seam.
- **Zod-strict schemas as drift gate.** Every cache file (`latest.json`,
  `history.json`, `intervals.json`, `routes.json`, `ftp_history.json`,
  `.scheduler.json`, `error_state.json`) is parsed through a `.strict()` Zod
  schema. Forgotten-field drift fails loudly instead of silently dropping
  data; a unit test enumerates every schema and asserts strictness.
- **Mutex / cooldown discipline for sync.** A single mutex-protected
  `runSync()` orchestrates scheduled, lazy-fallback, and `/sync`-triggered
  refreshes with a 30 s acquire timeout, 2 min outer timeout, and 30 s
  per-chat cooldown. The orchestrator lives at
  `packages/core/src/reference/sync/run-sync.ts`; the underlying
  primitives (`AsyncMutex`, `chainedSignal`, `Cooldown`) are canonical in
  `packages/kernel/src/concurrency/` and are reused by future horizontal
  layers per ADR-0011.
- **Host-binding portability.** The response fingerprint used only for log
  correlation is supplied by the Node host as a synchronous SHA-256 function;
  the portable Reference layer retains no host import. This changes no metric
  or training result.
- **Three-layer validation.** Layer 1 sync gate (mechanical), Layer 2
  Zod-validated LLM output with one retry on citation mismatch, Layer 3
  prompt rules.
- **Display-units conversion at prompt-injection time.** Canonical metric on
  disk; `formatQuantity(quantity, athleteUnits)` renders to the athlete's
  preferred system. Section-11's mixed-units assumptions are removed.

### Canonical attribution surfaces

This file (`NOTICE.md`) and the [`README.md` Credits section](https://github.com/yerzhansa/enduragent#credits)
are the canonical attribution surfaces. The full upstream repository is at
https://github.com/CrankAddict/section-11.

---

## @mariozechner/pi-ai

The ChatGPT-subscription ("openai-codex") provider under
`packages/core/src/agent/codex/` — OAuth login + token refresh (`oauth.ts`),
the JWT account-id helper (`jwt.ts`), the Responses-API round-trip
(`responses.ts`), and the per-million pricing catalog (`cost.ts`) — is adapted
from [`@mariozechner/pi-ai`](https://www.npmjs.com/package/@mariozechner/pi-ai)
v0.67.6 by Mario Zechner, distributed under the MIT License.

### Original license (verbatim)

```
MIT License

Copyright (c) Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Modifications introduced

The codex provider is not a verbatim copy; it was re-expressed in this
codebase's own type vocabulary and trimmed to what the coach needs:

- **AI-SDK types throughout.** The provider consumes/produces the Vercel AI SDK
  `ModelMessage[]` / `LanguageModelUsage` shapes used by every other provider,
  rather than pi-ai's parallel `Context` / `AssistantMessage` / `Usage` types.
  The single message↔wire conversion is folded into `responses.ts`.
- **SSE transport only.** The WebSocket transport and its session-connection
  cache are dropped; the coach collapses each reply to a single message.
- **No internal retry loop.** Retry/backoff is owned by the agent's shared
  retry primitive; the provider performs exactly one request attempt and throws
  structured errors (`httpStatus` / `retryAfterMs`, or a raw network throw with
  its errno cause) for the outer loop to classify.
- **Native token-endpoint redaction.** Failed token exchange/refresh logs only
  the HTTP status and a boolean field-presence object — never response bodies or
  token JSON. (This replaces a previously-maintained dependency patch.)
- **Client identification.** The Responses request `originator` header is
  `codex` and the `User-Agent` product token is `cycling-coach`.
- **Pricing as a static snapshot.** `cost.ts` carries a per-million price table
  for the priced providers, extracted from pi-ai's generated model catalog at
  v0.67.6; a table miss yields no cost rather than a fabricated figure.
- **Text-only message scope.** The coach is a text chat agent, so the
  message↔wire conversion handles text content only; pi-ai's `input_image`
  emission for image/file content parts (in user messages and tool results) is
  not carried over.
- **Strict tool-argument parsing.** Final tool-call arguments are parsed with a
  strict `JSON.parse` (no `partial-json` tolerant fallback). Malformed or
  truncated arguments collapse to `{}`, so the tool's own schema validation
  rejects the call cleanly rather than the model executing on a best-effort
  partial object — preferable for a write-capable coach.
---

## fit-file-parser

FIT decoding uses a modified copy of fit-file-parser 3.0.2, distributed under
the MIT License. The local patch corrects declared developer-field base-type
decoding, preserves occurrence identity in decoded session, lap, and record
messages, and makes CRC failures terminate; the existing flattened field-name
view is retained for compatibility.

### Original license (verbatim)

The MIT License (MIT)

Copyright (c) 2015 Pierre Jacquier
http://pierrejacquier.com | @pierremtb

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

## T3 Code (MIT)

Portions of the desktop visual styling are derived from
[T3 Code](https://github.com/pingdotgg/t3code).

```
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Desktop UI dependencies

The desktop renderer bundles the following third-party packages. Each is used as published,
without modification.

### lucide-react (ISC)

Icon set used for the desktop navigation and controls.

```
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather
(MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any purpose with or
without fee is hereby granted, provided that the above copyright notice and this permission
notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS
SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL
THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY
DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF
CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE
OR PERFORMANCE OF THIS SOFTWARE.
```

### Tailwind CSS (MIT)

Utility styling layer for the desktop renderer. Copyright (c) Tailwind Labs, Inc.

### Base UI (MIT)

Headless React primitives for accessible dialogs, menus and form controls.
Copyright (c) Base UI contributors / MUI.

### DM Sans (SIL Open Font License 1.1)

Typeface, vendored via `@fontsource-variable/dm-sans`. Copyright (c) Colophon Foundry,
Jonny Pinhorn and Indian Type Foundry. The full OFL text ships inside the package at
`node_modules/@fontsource-variable/dm-sans/LICENSE`.

### Noto Sans CJK SC (SIL Open Font License 1.1)

Typeface used for deterministic workout chart images. Copyright 2014-2021 Adobe.
Noto is a trademark of Google Inc. The full OFL text ships beside the font at
`dist/workout-chart-font.LICENSE.txt`.

---

## Cursor pstack verification skills (MIT)

The project-local `create-verification-skill` and `maintain-verification-skill` Codex skills
adapt the corresponding pstack skills from
[`cursor/plugins`](https://github.com/cursor/plugins/tree/main/pstack/skills) by Lauren Tan.
They are distributed under the MIT License.

### Original license (verbatim)

```
MIT License

Copyright (c) 2026 Lauren Tan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Modifications introduced

The Cursor paths and slash-command vocabulary were replaced with Codex project-skill paths,
`$skill-name` invocation, and `agents/openai.yaml` policy. The workflows also preserve existing
executor ownership, enforce isolated Enduragent data and process cleanup, retain privacy-scanned
evidence, and follow this repository's verification and delivery boundaries.
