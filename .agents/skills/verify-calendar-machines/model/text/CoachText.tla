---- MODULE CoachText ----
\* The coach's written text for one Activity (its review) or for one missed workout (its note).
\* It costs one reply on the athlete's model each time it is written.
\* Fixed = FALSE: the approved design. Fixed = TRUE: with the decisions.
EXTENDS Naturals
CONSTANT Fixed
VARIABLES match, open, text, startedFor, writtenFor, replies, asks, model, marker, failedBy, spentAfterModelFailure
vars == <<match, open, text, startedFor, writtenFor, replies, asks, model, marker, failedBy, spentAfterModelFailure>>
\* marker: the page shows "Written before you changed the match". Only the fixed app sets it.
\* failedBy: why a failed text failed. "model": the model answered with an error or not at all.
\* "quit": the app quit while the coach wrote. Only the fixed app tells them apart on open.
\* spentAfterModelFailure: an open after a model failure spent a reply.

\* match: "pending" (it may be a Plan Workout, the athlete has not said), "workout", "none".
\* text: "none", "writing", "kept", "failed". replies: replies spent. asks: times the athlete
\* opened it or pressed Write again or Try again (each may spend one reply).

Init == /\ match \in {"pending", "none"} /\ open = FALSE /\ text = "none"
        /\ startedFor = "-" /\ writtenFor = "-" /\ replies = 0 /\ asks = 0 /\ model \in {"up", "down"} /\ marker = FALSE
        /\ failedBy = "-" /\ spentAfterModelFailure = FALSE

StartWriting == text' = "writing" /\ startedFor' = match /\ replies' = replies + 1 /\ failedBy' = "-"

OpenWrites == text = "none" \/ (text = "failed" /\ (failedBy = "quit" \/ ~Fixed))

YouOpen ==
  /\ ~open /\ open' = TRUE /\ asks' = asks + 1
  /\ IF match # "pending" /\ OpenWrites
       THEN /\ StartWriting
            /\ spentAfterModelFailure' = (spentAfterModelFailure \/ (text = "failed" /\ failedBy = "model"))
            /\ UNCHANGED <<match, writtenFor, model, marker>>
       ELSE UNCHANGED <<match, text, startedFor, writtenFor, replies, model, marker, failedBy, spentAfterModelFailure>>
YouLeave == open /\ open' = FALSE
  /\ UNCHANGED <<match, text, startedFor, writtenFor, replies, asks, model, marker, failedBy, spentAfterModelFailure>>
YouDecideTheMatch ==
  /\ match = "pending" /\ \E m \in {"workout", "none"} : match' = m
  /\ IF open /\ text = "none"
       THEN text' = "writing" /\ startedFor' = match' /\ replies' = replies + 1 /\ failedBy' = "-"
       ELSE UNCHANGED <<text, startedFor, replies, failedBy>>
  /\ UNCHANGED <<open, writtenFor, asks, model, marker, spentAfterModelFailure>>
YouChangeTheMatchLater ==   \* from the calendar: "Is this it?" on another day, or undoing a Confirm
  /\ match \in {"workout", "none"} /\ match' = IF match = "workout" THEN "none" ELSE "workout"
  /\ marker' = IF Fixed THEN (text = "kept" /\ writtenFor # match') ELSE marker
  /\ UNCHANGED <<open, text, startedFor, writtenFor, replies, asks, model, failedBy, spentAfterModelFailure>>
WritingFinishes ==
  /\ text = "writing" /\ model = "up"
  /\ text' = "kept" /\ writtenFor' = startedFor
  /\ marker' = IF Fixed THEN startedFor # match ELSE marker
  /\ UNCHANGED <<match, open, startedFor, replies, asks, model, failedBy, spentAfterModelFailure>>
WritingFails ==
  /\ text = "writing" /\ model = "down" /\ text' = "failed" /\ failedBy' = "model"
  /\ UNCHANGED <<match, open, startedFor, writtenFor, replies, asks, model, marker, spentAfterModelFailure>>
AppQuitsWhileWriting ==
  /\ text = "writing" /\ text' = "failed" /\ failedBy' = "quit" /\ open' = FALSE
  /\ UNCHANGED <<match, startedFor, writtenFor, replies, asks, model, marker, spentAfterModelFailure>>
YouPressWriteAgain ==
  /\ open /\ text \in {"kept", "failed"} /\ match # "pending" /\ asks' = asks + 1
  /\ StartWriting /\ UNCHANGED <<match, open, writtenFor, model, marker, spentAfterModelFailure>>
ModelChanges == model' = (IF model = "up" THEN "down" ELSE "up")
  /\ UNCHANGED <<match, open, text, startedFor, writtenFor, replies, asks, marker, failedBy, spentAfterModelFailure>>

Next == YouOpen \/ YouLeave \/ YouDecideTheMatch \/ YouChangeTheMatchLater \/ WritingFinishes
        \/ WritingFails \/ AppQuitsWhileWriting \/ YouPressWriteAgain \/ ModelChanges

Small == replies <= 2 /\ asks <= 2

\* Rules.
NoReplyWithoutAsking == replies <= asks
NoTextBeforeTheMatch == text \in {"writing", "kept"} => startedFor # "pending"
\* A kept text describes the current match, or says plainly which match it was written for.
KeptTextIsHonest == (text = "kept" /\ writtenFor # match) => marker
\* Opening a text the model failed to write shows the failure and Write again, and spends nothing.
OpenAfterModelFailureSpendsNothing == ~spentAfterModelFailure
====
