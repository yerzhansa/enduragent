# Privacy

The full policy, covering both the website and the software, is at
<https://enduragent.icu/privacy.html>. This page covers the minimal background installation
heartbeats made by the self-hosted bot and official Desktop releases.

Your training data stays on your machine. There is no Enduragent account, no server of ours that
holds your training history, and no behavioral analytics in the product. Your prompt and the
training numbers in it go to the model provider you chose; your intervals.icu key goes to
intervals.icu.

Access to a self-hosted Telegram bot is limited to an allowlist you control — see
[telegram.md](./telegram.md).

### Update checks & usage counting

As part of its background version-check behavior, Cycling Coach can make an HTTPS request to `ping.enduragent.icu`. That endpoint returns the latest published version (the same answer `registry.npmjs.org` gives) and records a pseudonymous installation count so the project can see roughly how many instances are running across install channels. The request contains no athlete data, message content, or credentials.

The bot attempts telemetry on Telegram-mode startup and again every 24 hours, but a timestamp in the installation data directory limits it to at most once in any 24-hour period even across restarts. The timestamp is saved before the request, so a crash or an unreachable endpoint cannot retry telemetry for 24 hours. If the endpoint is unavailable or rate-limited, the bot silently falls back to `registry.npmjs.org` for the version result.

Set `CYCLING_COACH_NO_UPDATE_CHECK=1` to disable the automatic background checks (both the startup check and the daily re-check). The operator-initiated `/update` and `/whatsnew` commands never initiate telemetry; their version lookups use `registry.npmjs.org` and reuse a recent or already-running result. `/whatsnew` also reaches the GitHub Releases API for release notes. In managed container deploys, `/update` does not run npm; image hosts update by redeploying the container image.

An official Desktop release separately attempts an HTTPS installation heartbeat at startup and on
its daily timer. A timestamp in the Desktop preferences directory limits it to at most once in any
24-hour period across restarts and is saved before the request, so an unavailable endpoint is not
retried until the next daily opportunity. The request contains only `enduragent-desktop`, the app
version, the platform channel (`macos` or `windows`), and a random UUID generated once and stored in
that preferences directory. It contains no athlete data, message content, credentials,
configuration, hardware identifier, or feature activity. Set `ENDURAGENT_NO_USAGE_PING=1` before
launch to disable it; disabled and unofficial builds create no heartbeat state.

The heartbeat endpoint stores those four fields, a count, and the time the request was received for
up to three months so the project can estimate active installations. Like any HTTPS service, its
hosting provider can receive ordinary network metadata such as an IP address and user agent. The
Desktop updater remains separate: it checks `https://updates.enduragent.icu/` for the latest
GitHub release artifacts and never depends on the heartbeat endpoint. That host can receive the
same ordinary network metadata as the heartbeat endpoint.

Desktop does not fetch release notes in the background. Choosing **What’s new** explicitly contacts
`registry.npmjs.org` for the latest published version and the GitHub Releases API for that exact
version’s athlete-facing notes. Those requests send no installation identifier, credential,
configuration, or athlete data.
