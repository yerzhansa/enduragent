---- MODULE CoachText ----
\* The coach's written text for one Activity (its review) or for one missed workout (its note).
\* It costs one reply on the athlete's model each time it is written.
\* Fixed = FALSE: the approved design. Fixed = TRUE: with the decisions.
EXTENDS Naturals
CONSTANT Fixed
VARIABLES match, open, text, startedFor, writtenFor, replies, asks, model, marker
vars == <<match, open, text, startedFor, writtenFor, replies, asks, model, marker>>
\* marker: the page shows "Written before you changed the match". Only the fixed app sets it.

\* match: "pending" (it may be a Plan Workout, the athlete has not said), "workout", "none".
\* text: "none", "writing", "kept", "failed". replies: replies spent. asks: times the athlete
\* opened it or pressed Write again or Try again (each may spend one reply).

Init == /\ match \in {"pending", "none"} /\ open = FALSE /\ text = "none"
        /\ startedFor = "-" /\ writtenFor = "-" /\ replies = 0 /\ asks = 0 /\ model \in {"up", "down"} /\ marker = FALSE

StartWriting == text' = "writing" /\ startedFor' = match /\ replies' = replies + 1

YouOpen ==
  /\ ~open /\ open' = TRUE /\ asks' = asks + 1
  /\ IF match # "pending" /\ text \in {"none", "failed"}
       THEN StartWriting /\ UNCHANGED <<match, writtenFor, model, marker>>
       ELSE UNCHANGED <<match, text, startedFor, writtenFor, replies, model, marker>>
YouLeave == open /\ open' = FALSE /\ UNCHANGED <<match, text, startedFor, writtenFor, replies, asks, model, marker>>
YouDecideTheMatch ==
  /\ match = "pending" /\ \E m \in {"workout", "none"} : match' = m
  /\ IF open /\ text = "none"
       THEN text' = "writing" /\ startedFor' = match' /\ replies' = replies + 1
       ELSE UNCHANGED <<text, startedFor, replies>>
  /\ UNCHANGED <<open, writtenFor, asks, model, marker>>
YouChangeTheMatchLater ==   \* from the calendar: "Is this it?" on another day, or undoing a Confirm
  /\ match \in {"workout", "none"} /\ match' = IF match = "workout" THEN "none" ELSE "workout"
  /\ marker' = IF Fixed THEN (text = "kept" /\ writtenFor # match') ELSE marker
  /\ UNCHANGED <<open, text, startedFor, writtenFor, replies, asks, model>>
WritingFinishes ==
  /\ text = "writing" /\ model = "up"
  /\ text' = "kept" /\ writtenFor' = startedFor
  /\ marker' = IF Fixed THEN startedFor # match ELSE marker
  /\ UNCHANGED <<match, open, startedFor, replies, asks, model>>
WritingFails ==
  /\ text = "writing" /\ model = "down" /\ text' = "failed"
  /\ UNCHANGED <<match, open, startedFor, writtenFor, replies, asks, model, marker>>
YouPressWriteAgain ==
  /\ open /\ text \in {"kept", "failed"} /\ match # "pending" /\ asks' = asks + 1
  /\ StartWriting /\ UNCHANGED <<match, open, writtenFor, model, marker>>
ModelChanges == model' = (IF model = "up" THEN "down" ELSE "up") /\ UNCHANGED <<match, open, text, startedFor, writtenFor, replies, asks, marker>>

Next == YouOpen \/ YouLeave \/ YouDecideTheMatch \/ YouChangeTheMatchLater \/ WritingFinishes
        \/ WritingFails \/ YouPressWriteAgain \/ ModelChanges

Small == replies <= 2 /\ asks <= 2

\* Rules.
NoReplyWithoutAsking == replies <= asks
NoTextBeforeTheMatch == text \in {"writing", "kept"} => startedFor # "pending"
\* A kept text describes the current match, or says plainly which match it was written for.
KeptTextIsHonest == (text = "kept" /\ writtenFor # match) => marker
====
