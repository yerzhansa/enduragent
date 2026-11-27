---- MODULE WorkoutOutcome ----
\* The result shown on one Plan Workout's calendar card (ADR-0050: suggest and confirm).
\* Fixed = FALSE: the approved design. Fixed = TRUE: with the decisions.
CONSTANT Fixed
VARIABLES day, ride, rideDay, seen, covered, match, removed, movedHere
vars == <<day, ride, rideDay, seen, covered, match, removed, movedHere>>

\* day: "before" the workout's day ends, "over" after it, "morning" the morning after.
\* ride: the athlete rode (truth, in intervals.icu). rideDay: on the workout's day ("planned")
\* or on the day it was planned before the athlete moved it in intervals.icu ("old").
\* seen: the ride has synced to the app. covered: a sync ran after the day ended.
\* movedHere: the athlete moved this workout in intervals.icu and pressed Keep.

Init == /\ day = "before" /\ ride = FALSE /\ rideDay = "none" /\ seen = FALSE
        /\ covered = FALSE /\ match = "none" /\ removed = FALSE /\ movedHere \in BOOLEAN

\* Which day the matcher compares against. Approved design: not said, today's matcher
\* uses the date the Plan Workout was first written. Fixed: the Plan's current day.
MatchDay == IF Fixed \/ ~movedHere THEN "planned" ELSE "old"

Label ==
  IF removed THEN "Removed by you"
  ELSE IF match = "confirmed" THEN (IF rideDay = "planned" THEN "Done" ELSE "Moved")
  ELSE IF seen /\ match = "suggested" THEN "Is this it?"
  ELSE IF day = "morning" /\ (~Fixed \/ covered) THEN "Missed"
  ELSE IF day = "morning" THEN "Not synced yet"
  ELSE "Planned"

DayEnds == day = "before" /\ day' = "over" /\ UNCHANGED <<ride, rideDay, seen, covered, match, removed, movedHere>>
MorningComes == day = "over" /\ day' = "morning" /\ UNCHANGED <<ride, rideDay, seen, covered, match, removed, movedHere>>
YouRide ==
  /\ ~ride /\ ride' = TRUE
  /\ rideDay' \in (IF day = "before" THEN {"planned", "old"} ELSE {"old"})
  /\ UNCHANGED <<day, seen, covered, match, removed, movedHere>>
SyncRuns ==
  /\ (ride /\ ~seen) \/ (day # "before" /\ ~covered)
  /\ seen' = ride /\ covered' = (covered \/ day # "before")
  \* the matcher suggests a ride only on the day it compares against
  /\ match' = IF ride /\ match = "none" /\ rideDay = MatchDay THEN "suggested" ELSE match
  /\ UNCHANGED <<day, ride, rideDay, removed, movedHere>>
YouConfirm == match = "suggested" /\ match' = "confirmed" /\ UNCHANGED <<day, ride, rideDay, seen, covered, removed, movedHere>>
NotThisOne == match = "suggested" /\ match' = "rejected" /\ UNCHANGED <<day, ride, rideDay, seen, covered, removed, movedHere>>
YouPickThisRide ==   \* "Is this it?" from the ride's side, for a ride on another day
  /\ seen /\ match \in {"none", "rejected"} /\ match' = "confirmed"
  /\ UNCHANGED <<day, ride, rideDay, seen, covered, removed, movedHere>>
YouKeepTheDelete == ~removed /\ match # "confirmed" /\ removed' = TRUE /\ UNCHANGED <<day, ride, rideDay, seen, covered, match, movedHere>>
Settled == day = "morning" /\ covered /\ (ride => seen) /\ UNCHANGED vars

Next == DayEnds \/ MorningComes \/ YouRide \/ SyncRuns \/ YouConfirm \/ NotThisOne \/ YouPickThisRide \/ YouKeepTheDelete \/ Settled

\* Rules.
MissedIsTrue == Label = "Missed" => (covered /\ ~(ride /\ rideDay = "planned" /\ match # "rejected"))
RemovedIsNeverMissed == removed => Label # "Missed"
OnlyConfirmedCounts == Label \in {"Done", "Moved"} => match = "confirmed"
RideOnTheDayIsSuggested == (seen /\ rideDay = "planned" /\ match = "none") => FALSE
====
