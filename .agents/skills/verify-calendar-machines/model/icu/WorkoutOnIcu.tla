---- MODULE WorkoutOnIcu ----
\* One Plan Workout that is already on intervals.icu (inside this Training Week or next).
\* Fixes = {}: the approved design before the statechart pass. Each fix in Fixes turns one decision on:
\*   "readback" remember intervals.icu's read-back after our write, not what we sent;
\*   "recheck"  Keep and Put back act only on the version the card shows, else the card refreshes;
\*   "staleSet" a Change Set whose workout changed after it was shown updates before Approve.
\* Every Plan starts in the new mode: no one ran the desktop before the update, so the
\* upgrade path ("old" mode and its "checkNow" fix) is not built.
CONSTANT Fixes
VARIABLES mode, plan, icu, base, agreed, card, shown, prop, propOn, flag, kept, okFlag,
          lost, lostKept, needless
vars == <<mode, plan, icu, base, agreed, card, shown, prop, propOn, flag, kept, okFlag,
          lost, lostKept, needless>>
\* agreed: what intervals.icu held at the last point the athlete and the app agreed on
\* (after our verified write, Keep or Put back). base: what the app remembers of it.

Athlete == {"E", "gone"}                 \* the athlete edits it, or deletes it, in intervals.icu
Norm(x) == CASE x = "P" -> "Pn" [] x = "Q" -> "Qn" [] OTHER -> x  \* intervals.icu stores what we send in its own format
Remember(x) == IF "readback" \in Fixes THEN Norm(x) ELSE x
Hist == <<lost, lostKept, needless>>

Init == /\ mode = "new"
        /\ plan = "P" /\ icu = "Pn" /\ base = Remember("P") /\ agreed = "Pn"
        /\ card = "none" /\ shown = "none"
        /\ prop = "none" /\ propOn = "none" /\ flag = FALSE /\ kept = "none" /\ okFlag = FALSE
        /\ lost = FALSE /\ lostKept = FALSE /\ needless = FALSE

Write ==
  /\ icu' = Norm(plan) /\ base' = Remember(plan) /\ agreed' = Norm(plan)
  /\ lost' = (lost \/ icu # agreed)
  /\ lostKept' = (lostKept \/ (kept # "none" /\ icu = kept /\ ~okFlag))
  /\ needless' = (needless \/ icu = Norm(plan))
  /\ kept' = "none" /\ okFlag' = FALSE

\* The background run (app start, every 6 hours, after a Plan change).
AppRuns ==
  /\ card = "none"
  /\ (icu # Norm(plan) \/ icu # base)
  /\ IF (mode = "old" /\ "checkNow" \notin Fixes) \/ icu = base
       THEN Write /\ UNCHANGED <<mode, plan, card, shown, prop, propOn, flag>>
       ELSE /\ card' = "open" /\ shown' = icu
            /\ UNCHANGED <<mode, plan, icu, base, agreed, prop, propOn, flag, kept, okFlag>> /\ UNCHANGED Hist

AthleteChangesIt ==
  /\ \E v \in Athlete \ {icu} : icu' = v
  /\ UNCHANGED <<mode, plan, base, agreed, card, shown, prop, propOn, flag, kept, okFlag>> /\ UNCHANGED Hist

CardRefreshes ==
  /\ "recheck" \in Fixes /\ card = "open" /\ icu # shown
  /\ IF icu = base THEN card' = "none" /\ shown' = "none" ELSE shown' = icu /\ card' = card
  /\ UNCHANGED <<mode, plan, icu, base, agreed, prop, propOn, flag, kept, okFlag>> /\ UNCHANGED Hist

Keep ==
  /\ card = "open" /\ ("recheck" \notin Fixes \/ icu = shown)
  /\ plan' = shown /\ base' = shown /\ agreed' = shown /\ kept' = shown
  /\ card' = "none" /\ shown' = "none"
  /\ UNCHANGED <<mode, icu, prop, propOn, flag, okFlag>> /\ UNCHANGED Hist

PutBack ==
  /\ card = "open" /\ ("recheck" \notin Fixes \/ icu = shown)
  /\ icu' = Norm(plan) /\ base' = Remember(plan) /\ agreed' = Norm(plan)
  /\ lost' = (lost \/ icu # shown)
  /\ card' = "none" /\ shown' = "none" /\ kept' = "none" /\ okFlag' = FALSE
  /\ UNCHANGED <<mode, plan, prop, propOn, flag, lostKept, needless>>

CoachProposes ==
  /\ prop = "none" /\ plan # "Q"
  /\ prop' = "open" /\ propOn' = plan /\ flag' = (plan \in Athlete)
  /\ UNCHANGED <<mode, plan, icu, base, agreed, card, shown, kept, okFlag>> /\ UNCHANGED Hist

ChangeSetRefreshes ==
  /\ "staleSet" \in Fixes /\ prop = "open" /\ propOn # plan
  /\ propOn' = plan /\ flag' = (plan \in Athlete)
  /\ UNCHANGED <<mode, plan, icu, base, agreed, card, shown, prop, kept, okFlag>> /\ UNCHANGED Hist

Approve ==
  /\ prop = "open" /\ ("staleSet" \notin Fixes \/ propOn = plan)
  /\ plan' = "Q" /\ okFlag' = flag
  /\ prop' = "none" /\ propOn' = "none" /\ flag' = FALSE
  /\ UNCHANGED <<mode, icu, base, agreed, card, shown, kept>> /\ UNCHANGED Hist

ApproveKeepMine ==
  /\ prop = "open" /\ flag
  /\ prop' = "none" /\ propOn' = "none" /\ flag' = FALSE
  /\ UNCHANGED <<mode, plan, icu, base, agreed, card, shown, kept, okFlag>> /\ UNCHANGED Hist

UpdateApproved ==
  /\ mode = "old" /\ mode' = "new"
  /\ UNCHANGED <<plan, icu, base, agreed, card, shown, prop, propOn, flag, kept, okFlag>> /\ UNCHANGED Hist

Next == AppRuns \/ AthleteChangesIt \/ CardRefreshes \/ Keep \/ PutBack \/ CoachProposes
        \/ ChangeSetRefreshes \/ Approve \/ ApproveKeepMine \/ UpdateApproved

\* Rules the operator agreed to.
NeverUndoneByItself == ~lost          \* an athlete's change in intervals.icu is replaced only by Put back on that exact version
KeptEditReplacedOnlyWhenFlagged == ~lostKept
CardOnlyForRealChanges == card = "open" => shown # agreed
NoRewriteOfSameWorkout == ~needless
====
