<h1 align="center">Enduragent</h1>

<p align="center">
  <b>An AI cycling coach that runs on your own machine.</b><br>
  It reads your real rides, writes your week, and never sends your training history to us.<br>
  Chat in the Mac app, or pair it with your own Telegram bot and coach from your phone.
</p>

<p align="center">
  Bring your own LLM API key, <b>sign in with a ChatGPT Plus subscription, or use your Claude
  subscription through the Claude Code CLI you already run locally</b>, connect
  <a href="https://intervals.icu">intervals.icu</a> for real athlete data, and chat from the
  desktop app, Telegram, or the terminal.
</p>

<p align="center">
  <a href="https://enduragent.icu/"><b>enduragent.icu</b></a> ·
  <a href="https://enduragent.icu/download/mac">Download for macOS</a> ·
  <a href="https://enduragent.icu/privacy.html">Privacy</a> ·
  <a href="https://railway.com/deploy/cycling-coach">Deploy the 24/7 bot</a>
</p>

<p align="center">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue">
  <img alt="npm" src="https://img.shields.io/npm/v/cycling-coach?label=cycling-coach">
  <img alt="Platform" src="https://img.shields.io/badge/desktop-macOS%20arm64-black">
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/yerzhansa/enduragent/main/guides/images/desktop-app.webp" alt="Enduragent on macOS: the coach explains why one hard session fits this weekend, then writes a VO2max 5x3 min workout and confirms it was added to the intervals.icu calendar." width="612">
  <img src="https://raw.githubusercontent.com/yerzhansa/enduragent/main/guides/images/telegram-workout.webp" alt="The same coach in Telegram: the rider says a meeting ran late and asks to turn tonight's 90 minutes into 40; it rewrites the session as 3x6 min sweet spot at 233-249 W and updates the intervals.icu calendar." width="170">
</p>

<p align="center">
  <i>The same coach, two front ends &mdash; the Mac app, and your own Telegram bot paired to it.</i>
</p>

---

Ask it what to ride today and it answers from your numbers, not from a questionnaire: your FTP,
your zones, the load you actually carried last week, and how you slept. Then it writes the session
to your intervals.icu calendar, which syncs on to your head unit.

Free, MIT licensed, and there is no paid version with the good features in it.

## Three things, done properly

### It reads your real numbers

Paste your intervals.icu API key and it pulls your profile, FTP, zones and weight, your
activities, and your power and heart-rate curves. Fitness, Fatigue, Form, Load and Intensity come
from the rides you did.

- Wellness too: HRV, resting heart rate and sleep, when you log them.
- No platform account? Drop in `.fit`, `.tcx` or `.gpx` files — parsed on your device.
- Zones, plan skeletons and feasibility checks are computed locally, with no model call.
- It remembers you: goals, injuries, equipment, schedule — plain files, yours to open or delete.

### It plans your season

Periodized plans toward a goal event — linear, block, reverse linear, polarized or pyramidal —
with volume tiers, hard-session spacing, and an honest feasibility check on FTP or W/kg targets.

### It puts the session where you'll see it

Structured intervals pushed to your intervals.icu calendar, which auto-syncs to Garmin, Wahoo,
Hammerhead, COROS, Suunto and Zwift. Nothing is written to your calendar unless you ask.

Away from the desk, pair the app with your own Telegram bot: tell it your meeting ran late, and
the rewritten session lands on the same calendar before you have changed into kit.

## Install

### macOS app

[**Download for macOS**](https://enduragent.icu/download/mac) — Apple Silicon, signed and
notarized. Download, chat, connect. Linux has no desktop build; see the Windows subsection below.

In **Settings → Telegram** you can pair the app with a bot of your own: ask BotFather for a token,
paste it once, and the same coach answers in Telegram with your athlete memory, training data and
plans shared. It replies while the app is running and your Mac is awake — for a bot that answers
around the clock, see below.

### Windows app

[**Download for Windows**](https://enduragent.icu/download/windows) — available with the first
signed release, for Windows 11 x64 only. Windows builds ship only with an Authenticode signature
from `<PUBLISHER_NAME>`. A valid signature under a new publisher identity can still trigger a
SmartScreen prompt while its reputation builds.

The per-user one-click installer adds a Start Menu shortcut without asking for administrator
access; it does not add a desktop shortcut. Closing the main window hides it while Enduragent keeps
running in the tray; quit it explicitly from the tray menu.

Uninstalling keeps your data in `%LOCALAPPDATA%\Enduragent`; remove that folder by hand to erase
it. Windows update checks use the same generic GitHub release feed as macOS and switch on with the
first signed release. Windows assets can arrive later than macOS, and Windows may lag or skip a
version; release notes say which platforms shipped.

### Terminal

```bash
npm install -g cycling-coach
cycling-coach setup
cycling-coach
```

Node 22+, macOS or Linux. The wizard walks you through model provider, intervals.icu, and
optionally Telegram.

### Telegram, around the clock

Telegram works two ways, and both are your own bot:

- **Paired to the Mac app** — the pairing above. Nothing else to host; it answers while the app is
  running and your Mac is awake.
- **Self-hosted, always on** — [deploy your own copy to
  Railway](https://railway.com/deploy/cycling-coach) so it replies day and night. Your instance,
  your keys, a sender allowlist so only you can talk to it.

Either way the commands are the same, and anyone who finds your bot's username but isn't on the
allowlist is dropped before the coach sees them.

> The npm package and CLI binary are still named `cycling-coach`. The project and the Mac app are
> Enduragent.

## Bring your own model

Enduragent does not resell tokens. You point it at an account you already have and your provider
bills you. If you already pay for ChatGPT or Claude, sign in with it and add no new cost.

| | Provider | How you pay |
|---|---|---|
| 🔑 | Anthropic (Claude) | API key |
| 🔑 | OpenAI (GPT) | API key |
| 🔑 | Google (Gemini) | API key |
| 🔑 | DeepSeek · Qwen · MiniMax · Kimi · Z.AI (GLM) | API key |
| 🔑 | OpenRouter | API key |
| ✨ | **ChatGPT subscription** *(experimental)* | OAuth sign-in, Plus or higher |
| ✨ | **Claude subscription** *(experimental)* | Via the Claude Code CLI you signed into |

Neither subscription lane brokers a login — you sign in yourself with the CLI, and the app never
reads or stores your tokens. Both are macOS/Linux only and don't work in containers or on Railway.
Details, model choices and kill switches: [docs/providers.md](./guides/providers.md).

A spend meter with a daily cap you set shows what the day cost before the invoice does. It's a
local estimate, not a billing control — set limits with your provider too.

## Your data stays on your device

There is no Enduragent account, no server holding your training history, and no behavioral
analytics in the product. Nowhere for us to look at your rides or conversations, because we did
not build the place to look.

**Files you can open.** Your athlete data lives under `~/.enduragent`: a local SQLite store, an
archive of the raw data it read, plain-Markdown memory files, and your transcripts. Desktop also
keeps preferences, its random installation UUID, and encrypted credentials under
`~/Library/Application Support/Enduragent` on macOS or `%LOCALAPPDATA%\Enduragent` on Windows.
Delete both locations to remove all locally stored Enduragent data.

**Credentials encrypted at rest.** Desktop encrypts API keys and ChatGPT sign-in tokens with the
operating system's credential backend. If secure storage is unavailable, desktop refuses to save
credentials. Existing desktop ChatGPT profiles migrate after encrypted storage is verified.
Stop CLI processes using the desktop home before migration. Use a separate home and sign in
again for CLI use; CLI profiles retain private-file storage. Backups and older copies are not erased.

**What does leave.** Your prompt and the training numbers in it go to the model provider you
chose. Your intervals.icu key goes to intervals.icu. The self-hosted Telegram bot and official
Desktop releases may contact `ping.enduragent.icu` at startup and on a daily timer, but at most
once per installation in any 24 hours. The request contains the product, version, install channel,
and a random installation UUID — no athlete data, messages, or credentials. Set
`CYCLING_COACH_NO_UPDATE_CHECK=1` for the bot or `ENDURAGENT_NO_USAGE_PING=1` for Desktop to switch
it off. Manual commands never initiate telemetry; Desktop update checks remain separate and go
directly to GitHub.

Full policy: [enduragent.icu/privacy.html](https://enduragent.icu/privacy.html).

## Pricing

**$0.** No tiers, no trial, no upsell screen, no account to create. MIT licensed — read it, fork
it, change it, ship your own version. You pay your model provider, not us.

## Telegram commands

| Command | What it does |
|---------|-------------|
| `/start` | Welcome message + available commands |
| `/plan` | Builds a periodized plan from your data, asks to push it to the calendar |
| `/workout` | Suggests today's session from current fitness, fatigue and form |
| `/status` | Fitness, fatigue, form, and coaching notes |
| `/sync` | Pushes the next 1–2 weeks of planned workouts to intervals.icu |
| `/whatsnew` | What changed in the latest release |
| `/update` | Updates an npm install to the verified registry version |

Free-form chat works too, and the commands are identical whether your bot is paired to the Mac app
or self-hosted. Who can talk to your bot: [docs/telegram.md](./guides/telegram.md).

## Docs

The website — what it is, how it works, screenshots and the full privacy policy — lives at
**<https://enduragent.icu/>**. The reference material is here in the repo:

| | |
|---|---|
| [Configuration](./guides/configuration.md) | `config.yaml`, env vars, and where to keep secrets |
| [Providers](./guides/providers.md) | Every model lane, in detail |
| [Deploy](./guides/deploy.md) | Railway, containers, and hosts that break this app |
| [Telegram](./guides/telegram.md) | Allowlist, pairing, adding friends |
| [Architecture](./guides/architecture.md) | Monorepo layout and conventions |
| [Privacy](./guides/privacy.md) | Every outbound request, named |

## Development

Full-workspace commands use the Node.js 24 runtime resolved from the root `devEngines.runtime`
range and locked by pnpm.

```bash
git clone git@github.com:yerzhansa/enduragent.git
cd enduragent && pnpm install && pnpm build
pnpm dev     # auto-reload
pnpm check   # full workspace verification
pnpm test    # vitest
```

Set `CYCLING_COACH_HOME=~/.cycling-coach-dev` in `.env` so dev never collides with your real
install. Built with the [Vercel AI SDK](https://sdk.vercel.ai/),
[grammY](https://grammy.dev/), [Zod](https://zod.dev/), TypeScript, Vitest and
[oxc](https://oxc.rs/); the desktop app is Electron.

## Not medical advice

Enduragent is not a doctor and not a certified coach. A workout on your calendar is a suggestion,
not an instruction.

## Credits

The data substrate that grounds coaching in verified athlete numerics is a port of
[section-11](https://github.com/CrankAddict/section-11) (CrankAddict, MIT). Full attribution in
[`NOTICE.md`](./NOTICE.md).

The project-local verification meta-skills adapt Lauren Tan's
[Cursor pstack verification skills](https://github.com/cursor/plugins/tree/main/pstack/skills)
(MIT). Full attribution is in [`NOTICE.md`](./NOTICE.md).

Follow [@yerzhansa](https://x.com/yerzhansa) for updates.

## License

MIT
