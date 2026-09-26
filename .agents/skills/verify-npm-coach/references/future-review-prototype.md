# Accepted Telegram chart-card verification

Status: implemented in commit `0e9f8aff0a0869d95a557b458104178a86050d19` on PR #1089; the affected production chart flows have bounded live evidence, including structured edits and pending rename preservation. Read the [implementation record](/Users/yerzhansagyt/projects/cycling-coach/docs/initiatives/npm-workout-batch-approval/chart-cards/WORK.md) and its sanitized evidence before reusing a result.

The operator chose chart cards and approved the refinements below. Preserve the existing 51 approval criteria and all mutation restrictions. These presentation checks supplement that contract. The existing 175-entry inventory has not yet been re-inventoried for the chart-card source.

## Checks after implementation

| Scenario | Required visible result |
|---|---|
| Add one workout | Show its chart, readable steps, and one estimated training-load value before approval. |
| Add several workouts | Show each workout with its own chart and details, then one approval for the complete set. |
| Edit several structured workouts | Show the updated chart and changed values for each affected workout. Preserve unrelated workouts. |
| Change only a saved workout name or date | Show a compact before/after change without repeating unchanged charts or steps. |
| Rename a pending structured edit | Retain its proposed chart and exact steps even when the model repeats unchanged native description and duration fields. Keep untouched pending workouts identical. |
| Identify position in a batch | Show `1 of 2`, `2 of 2`, and equivalent `N of NN` labels on add, edit, and delete cards. |
| Delete one or several workouts | Name and date each removal explicitly. Do not present deleted workouts as additions. |
| Mixed batch | Distinguish additions, edits, and deletions. Approve the complete set with one control. |
| Identify a chart | Put the workout name and date inside the image. Match the reviewed duration and effort steps. |
| Review estimated load | Show the estimate once per workout. For an edit, show a changed estimate once as old to new. |
| Reach approval after scrolling | Keep complete counts beside approval, for example `Add 2 · Edit 1 · Delete 1`. |
| Check real calendar effects | Keep zero writes before approval; verify exact approved effects independently after approval. |

Use the 15-minute boundary workout when checking chart accuracy: five minutes of warmup, twice two minutes of effort plus one minute of recovery, then a separate four-minute finish. Require 900 seconds and the separate final step in Intervals.

## Evidence and limits

The [shared prototype](/Users/yerzhansagyt/projects/cycling-coach/docs/initiatives/npm-workout-batch-approval/prototypes/telegram-workout-options/index.html) and [Telegram preview results](/Users/yerzhansagyt/projects/cycling-coach/docs/initiatives/npm-workout-batch-approval/prototypes/telegram-workout-options/live-telegram/refined/verification.json) show fictional presentation messages. Their approval controls are demonstration controls. They prove neither production approval nor calendar persistence.

Core now builds semantic cards from the saved proposal in `packages/core/src/workout-change-sets/review.ts`. Telegram delivers local PNGs, captions, overflow and context before acknowledgement in `packages/core/src/channels/telegram.ts`. The final approval includes all action counts. Unsupported plots use readable text.

Real Telegram/OpenRouter/Intervals athlete 2 checks passed one and two additions, restart resend, compact name/date edits, a mixed batch with a simple edit, a targeted pending revision, stale-control rejection, long-caption continuation, and deletion cancellation. The 15-minute boundary workout saved as 900 seconds with a separate final step. Independent calendar reads preserved unrelated workouts. Production tests, final npm packaging, type checks and scoped OpenAI review passed.

Structured edit conversion and pending rename preservation passed in real Telegram with OpenRouter DeepSeek and athlete 2. The revised A FINAL review retained its chart; sanitized pending snapshots differed only in its name, with the second workout identical. The stale control wrote nothing; the current approval saved 780 and 900 seconds with the reviewed repeat boundary. Add, edit, and delete cards showed 1 of 2 and 2 of 2. Cleanup removed both disposable workouts and preserved unrelated calendar hashes; campaign model spend reached $0.149186131 of $2. A focused regression separately proves preservation when unchanged native fields are repeated. See rename-preservation evidence in the implementation record. The broader inventory was not re-audited.

The [heading investigation](/Users/yerzhansagyt/projects/cycling-coach/docs/initiatives/npm-workout-batch-approval/prototypes/telegram-workout-options/live-telegram/refined/findings.md) found the accepted mixed-batch heading through Web A search. Its absence from the current DOM did not prove failed delivery. The precise client cause remains unproved. Search the exact heading and inspect its surrounding messages before classifying a missing message. Keep the complete summary beside approval even when a separate heading exists.

Drive these production cards through ordinary Telegram messages and delivered controls, with independent calendar readback. No dedicated chart runner scenario exists. Do not invent a runner scenario from this document's headings. Search found a resent chart that Web A omitted from history during the current production run; missing DOM content alone still does not prove failed transport.
