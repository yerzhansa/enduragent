# Blind Visual Review (`calendar-ask-clean-draft`)

Reviewer: `blind-4e` (independent visual review from still frames only)

| Check | Desktop (2560x1756, light) |
| --- | --- |
| 1. Earlier Chat draft present | **pass** — `after/frames-after/frame-02.png` shows `"Should I add an easy spin before the weekend?"` typed in the composer before navigating to Calendar (`frame-01.png` starts empty). |
| 2. Calendar workout card Ask | **pass** — `after/frames-after/frame-04.png` opens Calendar; `frame-05.png` (and `frame-11.png`) shows the Wed 7 Jan `"Endurance ride"` workout card dialog with the `"Ask the coach to change it"` button. |
| 3. Clean Plan-change composer | **pass** — `after/frames-after/frame-06.png`–`frame-08.png` show only `Please change “Endurance ride” on Wed 7 Jan:` in the composer with no earlier draft text prepended and no scrollbar overflow. |
| 4. Set-aside notice and Cancel button | **pass** — `after/frames-after/frame-06.png`–`frame-08.png` and `frame-12.png` show one plain line above the composer reading `"Your earlier draft comes back after this change."` with `"Cancel"` on the right. |
| 5. Cancel restores earlier draft | **pass** — `after/frames-after/frame-09.png` and `frame-10.png` remove the notice and Cancel button and restore `"Should I add an easy spin before the weekend?"` verbatim in the composer. |
| 6. Send restores earlier draft verbatim | **pass** — After re-opening the workout card (`frame-11.png`) and appending `" make it 45 min"` (`frame-12.png`), `frame-13.png`–`frame-16.png` show only `Please change “Endurance ride” on Wed 7 Jan: make it 45 min` in the submitted message, the notice and Cancel button gone, and `"Should I add an easy spin before the weekend?"` verbatim in the composer without `" make it 45 min"`. |
| 7. Layout and readability | **pass** — `after/frames-after/frame-01.png`–`frame-16.png` render cleanly in full-window light theme with readable contrast, level notice/Cancel baseline, and no clipping, overlap, or misaligned buttons around the composer. |
| 8. Compared with BEFORE | **pass** — Gone: `before/frames-before/frame-05.png`–`frame-08.png` kept the earlier draft at the top of a scrollable composer with no notice or Cancel button, whereas `after/frames-after/frame-06.png`–`frame-08.png` show only the clean change prompt with the set-aside notice and Cancel button. |

Other issues:
- `after/frames-after/frame-13.png`–`frame-16.png`: after Send, while the restored earlier draft sits in the composer, the Send button (`↑`) stays disabled (greyed out) and the footer stays `"Training changes need your confirmation."` — likely expected while the `PLAN CHANGE · CHANGE` (`"I could not use that answer"` / `Skip for now` / `Answer`) card is open above the thread, though not verifiable from still frames alone.
- `after/frames-after/frame-06.png` -> `frame-07.png`: returning from Calendar to Chat renders one frame with the right `"Training context"` sidebar closed (`frame-06.png`) before reopening (`frame-07.png`), shifting the composer and notice bar left.
- `after/frames-after/frame-06.png`–`frame-08.png`, `frame-12.png`: minor spacing detail — the `"Cancel"` label ends ~12 CSS px inset to the left of the Send button's right edge rather than flush with it.
- `after/frames-after/frame-13.png`–`frame-16.png`: in the existing Plan Change card, the `"You wrote"` text wraps only `"min"` onto a second right-aligned line.

VERIFIED
