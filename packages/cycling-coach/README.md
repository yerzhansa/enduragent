# Cycling Coach

AI cycling coaching agent. Bring your own LLM API key **or sign in with a ChatGPT Plus subscription**, connect [intervals.icu](https://intervals.icu) for real athlete data, chat via Telegram or CLI.

Training data and coaching insights may include data from Garmin devices.

## Install

Requires [Node.js](https://nodejs.org/) 22+.

```bash
npm install -g enduragent
enduragent setup
enduragent
```

The setup wizard asks for your LLM provider — an API key for Anthropic / OpenAI / Google / DeepSeek / Qwen / MiniMax / Kimi / Z.AI / OpenRouter, **or OAuth sign-in with your ChatGPT subscription** (no API key needed). Then optionally connects [intervals.icu](https://intervals.icu) and Telegram. After setup, `enduragent` starts in CLI mode — or Telegram mode if you provided a bot token.

```
Cycling Coach (CLI mode). Type your message:
> Create a 2-hour Z2 ride with sprints
> Create 3x15 min sweet spot intervals
> Create VO2max intervals
> Review my last ride
> Build me a 12-week plan for a gran fondo
> What should I do today?
```

## What it does

- Analyzes fitness, fatigue, and form from your real rides
- Builds periodized plans toward your goal event
- Pushes structured workouts to your intervals.icu calendar (auto-syncs to Garmin, Wahoo, Hammerhead, COROS, Suunto, Zwift)

## LLM provider options

- **Anthropic (Claude)** — API key from [Anthropic Console](https://console.anthropic.com/). Recommended default.
- **OpenAI (GPT)** — API key from [OpenAI Platform](https://platform.openai.com/).
- **Google (Gemini)** — API key from [Google AI Studio](https://aistudio.google.com/).
- **DeepSeek** — API key from [DeepSeek Platform](https://platform.deepseek.com/).
- **Qwen** — API key from Alibaba Cloud DashScope.
- **MiniMax** — API key from [MiniMax Platform](https://platform.minimaxi.com/).
- **Kimi** — API key from [Moonshot AI](https://platform.moonshot.ai/).
- **Z.AI (GLM)** — API key from [Z.AI](https://z.ai/).
- **OpenRouter** — API key from [OpenRouter](https://openrouter.ai/).
- **ChatGPT subscription (experimental)** — browser OAuth sign-in with your ChatGPT Plus / Pro / Business / Edu / Enterprise account. No API key; uses your subscription quota. Models: `gpt-5.4` (recommended) and `gpt-5.4-mini` (faster, smaller context). Cost is covered by the subscription regardless of which model you pick.

Anthropic's Claude Pro/Max subscription does **not** support OAuth for third-party tools — the only supported Anthropic path is the console API key.

## Optional integrations

- **intervals.icu** API key from [intervals.icu/settings](https://intervals.icu/settings) > Developer Settings.
- **Telegram bot** token from [@BotFather](https://t.me/BotFather) (`/newbot`).

## Railway template

Want the bot running 24/7 without keeping your computer on? Use the Railway template:

https://railway.com/deploy/cycling-coach

Railway deploys your own private container from `ghcr.io/yerzhansa/enduragent:stable` with persistent `/data` storage and image auto-updates. The bot runs inside your Railway project and uses your Railway variables to call Telegram, intervals.icu, and your chosen LLM provider. We do not run a shared backend or store your secrets, athlete data, or Telegram messages. Your hosting and billing relationship is with Railway. Railway currently lists Hobby as the practical minimum for always-on apps: $5 minimum usage/month, including $5 monthly usage credits.

Before you click **Deploy**, prepare three accounts: one LLM provider account, intervals.icu, and Telegram.

Fill these template variables:

| Variable | What to enter | Where to get it |
| --- | --- | --- |
| `LLM_PROVIDER` | One lower-case provider id: `anthropic`, `openai`, `google`, `deepseek`, `qwen`, `minimax`, `kimi`, `zai`, or `openrouter`. Start with `anthropic` if unsure. | Pick the provider that issued your `LLM_API_KEY`. ChatGPT Plus login is not supported in Railway because it needs an interactive browser login. |
| `LLM_API_KEY` | API key for the provider in `LLM_PROVIDER`. | [Anthropic Console](https://console.anthropic.com/), [OpenAI Platform](https://platform.openai.com/), [Google AI Studio](https://aistudio.google.com/), [DeepSeek Platform](https://platform.deepseek.com/), Alibaba Cloud DashScope, [MiniMax Platform](https://platform.minimaxi.com/), [Moonshot AI](https://platform.moonshot.ai/), [Z.AI](https://z.ai/), or [OpenRouter](https://openrouter.ai/). |
| `INTERVALS_API_KEY` | Your intervals.icu API key. | [intervals.icu/settings](https://intervals.icu/settings) > Developer Settings. |
| `INTERVALS_ATHLETE_ID` | Your intervals.icu athlete id, usually like `i12345`. Include the leading `i` when intervals.icu shows one. | Open your intervals.icu profile/settings URL and copy the athlete id from the URL or profile details. |
| `TELEGRAM_BOT_TOKEN` | Token for the Telegram bot users will message. | In Telegram, open [@BotFather](https://t.me/BotFather), run `/newbot`, choose a name and username, then copy the token. |
| `CYCLING_COACH_OPERATOR_ID` | Your numeric Telegram user id, for example `123456789`. This is not the bot token and not the bot username. | In Telegram, message a helper bot such as [@userinfobot](https://t.me/userinfobot) and copy your numeric id. Only this Telegram user is allowed to talk to your bot by default. |

Railway does not run `cycling-coach setup`; the variables above are the setup. After deploy, open Telegram and send `/start` to the bot you created with BotFather. If a value is wrong, edit the service variables in Railway and redeploy or restart the service.

## Telegram commands

| Command | What it does |
|---------|-------------|
| `/start` | Welcome message + available commands |
| `/plan` | Builds a periodized plan, asks to push to calendar |
| `/workout` | Suggests today's workout from current fitness, fatigue, and form |
| `/status` | Shows fitness, fatigue, form, and coaching notes |
| `/sync` | Pushes next 1-2 weeks of planned workouts to intervals.icu |

Free-form chat works too — ask anything about training, report an injury, request plan adjustments.

## Where state lives

`~/.cycling-coach/` (override with `CYCLING_COACH_HOME`):

- `config.yaml` — provider/model selection (env vars take precedence)
- `auth-profiles.json` — OAuth tokens (mode `0600`, rotated automatically)
- `memory/MEMORY.md` — long-term: goals, injury history, preferences
- `memory/YYYY-MM-DD.md` — daily conversation notes
- `plans/current-plan.json` — active training plan
- `sessions/<chatId>.jsonl` — per-chat history

The agent reads memory at the start of each conversation and writes to it when significant decisions are made (new goal, plan change, injury).

## Troubleshooting

**`enduragent: command not found`** — if you installed without the `-g` flag, the binary isn't on your `$PATH`. Either re-install globally (`npm install -g enduragent`), or run it via `npx`:

```bash
npx enduragent setup
npx enduragent
```

`npx` ships with Node.js, so no extra install step is needed.

## More

- Follow [@yerzhansa](https://x.com/yerzhansa) on X.com for updates, or drop a question/feedback anytime.
- **Secrets backends** (1Password, macOS Keychain, Vault, AWS/GCP Secret Manager, age, env), **architecture diagram**, and **development setup** — see the [GitHub repo](https://github.com/yerzhansa/enduragent#readme).
- **Issues**: <https://github.com/yerzhansa/enduragent/issues>
- **License**: MIT

## Notices

License and attribution details for the installed package are in
`dist/NOTICE.md` and `dist/THIRD_PARTY_LICENSES.txt`.
