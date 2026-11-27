---- MODULE PlanLifecycle ----
\* End Plan and Replace Plan from "Plan details" (G5), on ADR-0058 and ADR-0067.
\* Fixed = FALSE: G5 read literally ("removes future workouts"; Replace sends the new Plan's
\* Change Set when approved). Fixed = TRUE: with the decisions.
CONSTANT Fixed
VARIABLES old, confirm, todayW, laterW, editedW, tick, cleanup, repl, newSent
vars == <<old, confirm, todayW, laterW, editedW, tick, cleanup, repl, newSent>>
\* editedW: a future Plan Workout the athlete changed in intervals.icu and kept ("none" if none).
\* tick: in the confirm, the athlete ticked "remove the ones you changed too" (fixed app only).

\* old: the running Plan, "active" or "closed". todayW / laterW: its workout today, and its
\* workouts from tomorrow on, on intervals.icu ("there" or "removed").
\* cleanup: "none", "running", "failed", "verified". repl: the replacement, "none", "review"
\* (being made with the coach), "active". newSent: its first workouts are on intervals.icu.

Init == /\ old = "active" /\ confirm = FALSE /\ todayW = "there" /\ laterW = "there" /\ editedW = "none" /\ tick = FALSE
        /\ cleanup = "none" /\ repl = "none" /\ newSent = FALSE

U(x) == UNCHANGED x
YouPressEnd == old = "active" /\ repl = "none" /\ ~confirm /\ confirm' = TRUE /\ U(<<old, todayW, laterW, editedW, tick, cleanup, repl, newSent>>)
YouCancel == confirm /\ confirm' = FALSE /\ U(<<old, todayW, laterW, editedW, tick, cleanup, repl, newSent>>)
YouConfirmEnd ==
  /\ confirm /\ confirm' = FALSE /\ old' = "closed" /\ cleanup' = "running"
  /\ tick' \in (IF Fixed /\ editedW = "there" THEN BOOLEAN ELSE {FALSE})
  /\ U(<<todayW, laterW, editedW, repl, newSent>>)
YouEditAFutureWorkout == old = "active" /\ editedW = "none" /\ editedW' = "there" /\ U(<<old, confirm, todayW, laterW, tick, cleanup, repl, newSent>>)
CleanupWorks ==
  /\ cleanup \in {"running", "failed"} /\ cleanup' = "verified" /\ laterW' = "removed"
  /\ todayW' = IF Fixed THEN todayW ELSE "removed"      \* "future" read as today and later
  \* literal G5: every future Plan Workout goes. Fixed: one you changed goes only if you ticked it.
  /\ editedW' = IF editedW = "there" /\ (~Fixed \/ tick) THEN "removed" ELSE editedW
  /\ U(<<old, confirm, tick, repl, newSent>>)
CleanupFails == cleanup = "running" /\ cleanup' = "failed" /\ U(<<old, confirm, todayW, laterW, editedW, tick, repl, newSent>>)
YouStartReplacing == old = "active" /\ repl = "none" /\ ~confirm /\ repl' = "review" /\ U(<<old, confirm, todayW, laterW, editedW, tick, cleanup, newSent>>)
YouApproveReplacement ==
  /\ repl = "review" /\ repl' = "active" /\ old' = "closed" /\ cleanup' = "running"
  /\ tick' \in (IF Fixed /\ editedW = "there" THEN BOOLEAN ELSE {FALSE})
  /\ newSent' = ~Fixed                                  \* literal: the Change Set is sent at Approve
  /\ U(<<confirm, todayW, laterW, editedW>>)
NewPlanGoesOut == Fixed /\ repl = "active" /\ cleanup = "verified" /\ ~newSent /\ newSent' = TRUE /\ U(<<old, confirm, todayW, laterW, editedW, tick, cleanup, repl>>)
RaceDayPasses == old = "active" /\ repl = "none" /\ ~confirm /\ old' = "closed" /\ U(<<confirm, todayW, laterW, editedW, tick, cleanup, repl, newSent>>)
Done == old = "closed" /\ cleanup \in {"none", "verified"} /\ (repl = "active" => newSent) /\ UNCHANGED vars

Next == YouPressEnd \/ YouCancel \/ YouConfirmEnd \/ YouEditAFutureWorkout \/ CleanupWorks \/ CleanupFails
        \/ YouStartReplacing \/ YouApproveReplacement \/ NewPlanGoesOut \/ RaceDayPasses \/ Done

\* Rules (ADR-0058, and grill round 1 Q1).
TodayIsKept == todayW = "there"
NeverTwoPlansOnIntervals == ~(newSent /\ laterW = "there")
LocalFirst == cleanup = "failed" => old = "closed"
YourChangesAreNotDeletedByItself == editedW = "removed" => tick
====
