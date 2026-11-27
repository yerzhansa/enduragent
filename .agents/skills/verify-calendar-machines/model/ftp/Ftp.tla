---- MODULE Ftp ----
\* One FTP: the one in intervals.icu. Fixed = FALSE: the approved design on today's engine.
\* Fixed = TRUE: with the decisions.
CONSTANTS Fixed, AppStart, Proposals   \* AppStart and Proposals only cut the model down for the charts
VARIABLES icu, app, ask, prop, confirmFrom, cool, evidence, checked, lostIcu
vars == <<icu, app, ask, prop, confirmFrom, cool, evidence, checked, lostIcu>>

\* icu: FTP in intervals.icu ("A" now, "B" the coach's proposal, "C" one the athlete sets there).
\* app: an FTP kept only in the app from today's "Correct FTP" ("none" or "D").
\* ask: the one-time question after the update about two FTPs.
\* prop: the coach's proposal: "none", "shown", "confirm" (the write confirm is open), "writing".
\* cool: the 4 weeks after Keep. evidence: "none", "test" (a planned FTP test), "drift"
\* (the estimate 3% or more away for 14 days), "oneRide".

Init == /\ icu = "A" /\ app \in AppStart /\ ask = IF app = "D" THEN "open" ELSE "none"
        /\ prop = "none" /\ confirmFrom = "-" /\ cool = FALSE /\ evidence = "none"
        /\ checked = FALSE /\ lostIcu = FALSE

\* The FTP the coach and the Activity review use. Today's engine prefers the app's own FTP.
CoachFtp == IF Fixed THEN icu ELSE (IF app # "none" THEN app ELSE icu)

Evidence ==
  /\ Proposals /\ evidence = "none" /\ prop = "none"
  /\ \E e \in {"test", "drift", "oneRide"} : evidence' = e
  /\ checked' = FALSE
  /\ UNCHANGED <<icu, app, ask, prop, confirmFrom, cool, lostIcu>>
AppChecks ==   \* after each sync
  /\ ~checked /\ checked' = TRUE
  /\ prop' = IF prop = "none" /\ evidence \in {"test", "drift"}
                /\ (~cool \/ (Fixed /\ evidence = "test")) THEN "shown" ELSE prop
  /\ evidence' = IF evidence = "oneRide" THEN "none" ELSE evidence   \* one ride alone is dropped
  /\ UNCHANGED <<icu, app, ask, confirmFrom, cool, lostIcu>>
Keep ==
  /\ prop = "shown" /\ prop' = "none" /\ cool' = TRUE /\ evidence' = "none"
  /\ UNCHANGED <<icu, app, ask, confirmFrom, checked, lostIcu>>
WeeksPass == cool /\ cool' = FALSE /\ checked' = FALSE /\ UNCHANGED <<icu, app, ask, prop, confirmFrom, evidence, lostIcu>>
Use ==
  /\ prop = "shown" /\ prop' = "confirm" /\ confirmFrom' = icu
  /\ UNCHANGED <<icu, app, ask, cool, evidence, checked, lostIcu>>
ConfirmWrite ==
  /\ prop = "confirm"
  /\ IF Fixed /\ icu # confirmFrom
       THEN confirmFrom' = icu /\ UNCHANGED <<prop, lostIcu>>   \* the confirm shows the new number first
       ELSE prop' = "writing" /\ lostIcu' = (lostIcu \/ icu # confirmFrom) /\ UNCHANGED confirmFrom
  /\ UNCHANGED <<icu, app, ask, cool, evidence, checked>>
CancelConfirm == prop = "confirm" /\ prop' = "shown" /\ UNCHANGED <<icu, app, ask, confirmFrom, cool, evidence, checked, lostIcu>>
WriteWorks ==
  /\ prop = "writing" /\ icu' = "B" /\ prop' = "none" /\ evidence' = "none"
  /\ UNCHANGED <<app, ask, confirmFrom, cool, checked, lostIcu>>
WriteFails == prop = "writing" /\ prop' = "shown" /\ UNCHANGED <<icu, app, ask, confirmFrom, cool, evidence, checked, lostIcu>>
YouSetFtpInIcu ==
  /\ icu # "C" /\ icu' = "C"
  /\ UNCHANGED <<app, ask, prop, confirmFrom, cool, evidence, checked, lostIcu>>
AnswerUseApp ==   \* "Use D": written to intervals.icu
  /\ ask \in {"open", "later"} /\ ask' = "done" /\ icu' = app /\ app' = "none"
  /\ UNCHANGED <<prop, confirmFrom, cool, evidence, checked, lostIcu>>
AnswerUseIcu == ask \in {"open", "later"} /\ ask' = "done" /\ app' = "none" /\ UNCHANGED <<icu, prop, confirmFrom, cool, evidence, checked, lostIcu>>
AskMeLater == ask = "open" /\ ask' = "later" /\ UNCHANGED <<icu, app, prop, confirmFrom, cool, evidence, checked, lostIcu>>

Quiet == prop = "none" /\ checked /\ ~cool /\ ask \in {"none", "done"} /\ UNCHANGED vars
Next == Quiet \/ Evidence \/ AppChecks \/ Keep \/ WeeksPass \/ Use \/ ConfirmWrite \/ CancelConfirm
        \/ WriteWorks \/ WriteFails \/ YouSetFtpInIcu \/ AnswerUseApp \/ AnswerUseIcu \/ AskMeLater

\* Rules.
OneFtp == CoachFtp = icu                          \* the coach and the head unit use the same FTP
NeverOverwriteAnUnseenFtp == ~lostIcu              \* we never replace an intervals.icu FTP the confirm did not show
NoProposalFromOneRide == prop # "none" => evidence \in {"test", "drift"}
PlannedTestIsAnswered == (checked /\ evidence = "test") => prop # "none"
====
