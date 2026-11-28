---- MODULE Ftp ----
\* One FTP: the one in intervals.icu. Fixed = FALSE: the approved design on today's engine.
\* Fixed = TRUE: with the decisions.
CONSTANTS Fixed, AppStart, Proposals   \* AppStart and Proposals only cut the model down for the charts
VARIABLES icu, app, ask, prop, propFor, confirmFrom, cool, evidence, checked, lostIcu
vars == <<icu, app, ask, prop, propFor, confirmFrom, cool, evidence, checked, lostIcu>>

\* icu: FTP in intervals.icu ("A" now, "B" the coach's proposal, "C" one the athlete sets there).
\* app: an FTP kept only in the app from today's "Correct FTP" ("none" or "D").
\* ask: the one-time question after the update about two FTPs.
\* prop: the coach's proposal: "none", "shown", "confirm" (the write confirm is open), "writing".
\* propFor: the intervals.icu FTP the shown proposal was made against ("-" when there is none).
\* cool: the 4 weeks after Keep. evidence: "none", "test" (a planned FTP test), "drift"
\* (the estimate 3% or more away for 14 days), "oneRide".

Init == /\ icu = "A" /\ app \in AppStart /\ ask = IF app = "D" THEN "open" ELSE "none"
        /\ prop = "none" /\ propFor = "-" /\ confirmFrom = "-" /\ cool = FALSE /\ evidence = "none"
        /\ checked = FALSE /\ lostIcu = FALSE

\* The FTP the coach and the Activity review use. Today's engine prefers the app's own FTP.
CoachFtp == IF Fixed THEN icu ELSE (IF app # "none" THEN app ELSE icu)

Evidence ==
  /\ Proposals /\ evidence = "none" /\ prop = "none"
  /\ \E e \in {"test", "drift", "oneRide"} : evidence' = e
  /\ checked' = FALSE
  /\ UNCHANGED <<icu, app, ask, prop, propFor, confirmFrom, cool, lostIcu>>
\* With the decisions, a check retires a shown card made against an FTP that intervals.icu no
\* longer holds and decides afresh: the estimate is never raised on the check that sees a new FTP.
AppChecks ==   \* after each sync
  /\ ~checked /\ checked' = TRUE
  /\ LET retire == Fixed /\ prop = "shown" /\ propFor # icu
         base == IF retire THEN "none" ELSE prop
         show == /\ base = "none" /\ evidence \in {"test", "drift"}
                 /\ (~cool \/ (Fixed /\ evidence = "test"))
                 /\ ~(retire /\ evidence = "drift")
     IN /\ prop' = IF show THEN "shown" ELSE base
        /\ propFor' = IF show THEN icu ELSE IF base = "none" THEN "-" ELSE propFor
  /\ evidence' = IF evidence = "oneRide" THEN "none" ELSE evidence   \* one ride alone is dropped
  /\ UNCHANGED <<icu, app, ask, confirmFrom, cool, lostIcu>>
Keep ==
  /\ prop = "shown" /\ prop' = "none" /\ propFor' = "-" /\ cool' = TRUE /\ evidence' = "none"
  /\ UNCHANGED <<icu, app, ask, confirmFrom, checked, lostIcu>>
WeeksPass == cool /\ cool' = FALSE /\ checked' = FALSE /\ UNCHANGED <<icu, app, ask, prop, propFor, confirmFrom, evidence, lostIcu>>
Use ==
  /\ prop = "shown" /\ prop' = "confirm" /\ confirmFrom' = icu
  /\ UNCHANGED <<icu, app, ask, propFor, cool, evidence, checked, lostIcu>>
ConfirmWrite ==
  /\ prop = "confirm"
  /\ IF Fixed /\ icu # confirmFrom
       THEN confirmFrom' = icu /\ UNCHANGED <<prop, lostIcu>>   \* the confirm shows the new number first
       ELSE prop' = "writing" /\ lostIcu' = (lostIcu \/ icu # confirmFrom) /\ UNCHANGED confirmFrom
  /\ UNCHANGED <<icu, app, ask, propFor, cool, evidence, checked>>
\* The app checks again after every answer, so Cancel and a failed write are followed by a check.
CancelConfirm == prop = "confirm" /\ prop' = "shown" /\ checked' = FALSE /\ UNCHANGED <<icu, app, ask, propFor, confirmFrom, cool, evidence, lostIcu>>
WriteWorks ==
  /\ prop = "writing" /\ icu' = "B" /\ prop' = "none" /\ propFor' = "-" /\ evidence' = "none"
  /\ UNCHANGED <<app, ask, confirmFrom, cool, checked, lostIcu>>
WriteFails == prop = "writing" /\ prop' = "shown" /\ checked' = FALSE /\ UNCHANGED <<icu, app, ask, propFor, confirmFrom, cool, evidence, lostIcu>>
YouSetFtpInIcu ==   \* the next sync brings it, so a check follows
  /\ icu # "C" /\ icu' = "C" /\ checked' = FALSE
  /\ UNCHANGED <<app, ask, prop, propFor, confirmFrom, cool, evidence, lostIcu>>
YouSetProposedInIcu ==   \* the athlete types the coach's number into intervals.icu
  /\ prop \in {"shown", "confirm"} /\ icu # "B" /\ icu' = "B" /\ checked' = FALSE
  /\ UNCHANGED <<app, ask, prop, propFor, confirmFrom, cool, evidence, lostIcu>>
\* With the decisions, Use or Confirm on a number intervals.icu already holds ends the proposal
\* as a write would, without writing.
IcuHoldsProposal ==
  /\ Fixed /\ prop = "confirm" /\ icu = "B"
  /\ prop' = "none" /\ propFor' = "-" /\ evidence' = "none"
  /\ UNCHANGED <<icu, app, ask, confirmFrom, cool, checked, lostIcu>>
AnswerUseApp ==   \* "Use D": written to intervals.icu
  /\ ask \in {"open", "later"} /\ ask' = "done" /\ icu' = app /\ app' = "none"
  /\ UNCHANGED <<prop, propFor, confirmFrom, cool, evidence, checked, lostIcu>>
AnswerUseIcu == ask \in {"open", "later"} /\ ask' = "done" /\ app' = "none" /\ UNCHANGED <<icu, prop, propFor, confirmFrom, cool, evidence, checked, lostIcu>>
AskMeLater == ask = "open" /\ ask' = "later" /\ UNCHANGED <<icu, app, prop, propFor, confirmFrom, cool, evidence, checked, lostIcu>>

Quiet == prop = "none" /\ checked /\ ~cool /\ ask \in {"none", "done"} /\ UNCHANGED vars
Next == Quiet \/ Evidence \/ AppChecks \/ Keep \/ WeeksPass \/ Use \/ ConfirmWrite \/ CancelConfirm
        \/ WriteWorks \/ WriteFails \/ YouSetFtpInIcu \/ YouSetProposedInIcu \/ IcuHoldsProposal
        \/ AnswerUseApp \/ AnswerUseIcu \/ AskMeLater

\* Rules.
OneFtp == CoachFtp = icu                          \* the coach and the head unit use the same FTP
NeverOverwriteAnUnseenFtp == ~lostIcu              \* we never replace an intervals.icu FTP the confirm did not show
NoProposalFromOneRide == prop # "none" => evidence \in {"test", "drift"}
PlannedTestIsAnswered == (checked /\ evidence = "test") => prop # "none"
ShownProposalFollowsIcu == (checked /\ prop = "shown") => propFor = icu   \* a shown card is about the FTP intervals.icu holds
====
