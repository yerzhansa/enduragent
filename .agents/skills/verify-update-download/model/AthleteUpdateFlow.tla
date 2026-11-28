------------------------- MODULE AthleteUpdateFlow -------------------------
(***************************************************************************)
(* Athlete-facing desktop update & download lifecycle projection for       *)
(* /statechart visualization. Small state space (<= 500 states) so         *)
(* /statechart renders the full athlete flow plus broken-rule markers.     *)
(*                                                                         *)
(* Maps 1-to-1 to main/update-controller.ts and main/quit-coordinator.ts   *)
(* at origin/main (0c559cf8).                                              *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    DetachSettledOperation,     \* FALSE on origin/main (BUG-1), TRUE when fixed
    RelaunchOnInstallFailure    \* FALSE on origin/main (BUG-3 / #391), TRUE when fixed

VARIABLES
    phase,   \* "idle" | "checking" | "current" | "downloading" | "preparing"
             \* | "downloaded" | "installing" | "installed" | "relaunching"
             \* | "failed" | "restart-required" | "stranded"
    wedged   \* boolean: dead activeOperation blocks Retry after error event (BUG-1)

vars == <<phase, wedged>>

Init ==
    /\ phase = "idle"
    /\ wedged = FALSE

StartCheck ==
    /\ phase \in {"idle", "current"}
    /\ phase' = "checking"
    /\ wedged' = FALSE

RetryCheck ==
    /\ phase = "failed"
    /\ ~wedged
    /\ phase' = "checking"
    /\ wedged' = FALSE

CheckCurrent ==
    /\ phase = "checking"
    /\ phase' = "current"
    /\ wedged' = FALSE

CheckFindsUpdate ==
    /\ phase = "checking"
    /\ phase' = "downloading"
    /\ wedged' = FALSE

CheckFails ==
    /\ phase = "checking"
    /\ phase' = "failed"
    /\ wedged' = FALSE

CheckErrorsBeforeSettle ==
    /\ phase = "checking"
    /\ ~DetachSettledOperation
    /\ phase' = "failed"
    /\ wedged' = TRUE

CheckTimesOutOrLoadFails ==
    /\ phase = "checking"
    /\ phase' = "restart-required"
    /\ wedged' = FALSE

ZipDownloadFinishes ==
    /\ phase = "downloading"
    /\ phase' = "preparing"
    /\ wedged' = FALSE

DownloadFails ==
    /\ phase = "downloading"
    /\ phase' = "failed"
    /\ wedged' = FALSE

DownloadStallsOrTimesOut ==
    /\ phase = "downloading"
    /\ phase' = "restart-required"
    /\ wedged' = FALSE

NativeVerificationFinishes ==
    /\ phase = "preparing"
    /\ phase' = "downloaded"
    /\ wedged' = FALSE

NativeVerificationFails ==
    /\ phase = "preparing"
    /\ phase' = "failed"
    /\ wedged' = FALSE

NativeVerificationTimesOut ==
    /\ phase = "preparing"
    /\ phase' = "restart-required"
    /\ wedged' = FALSE

PreparedUpdateInvalidated ==
    /\ phase = "downloaded"
    /\ phase' = "failed"
    /\ wedged' = FALSE

ClickRestartToUpdate ==
    /\ phase = "downloaded"
    /\ phase' = "installing"
    /\ wedged' = FALSE

InstallHandoffSucceeds ==
    /\ phase = "installing"
    /\ phase' = "installed"
    /\ wedged' = FALSE

InstallHandoffFails ==
    /\ phase = "installing"
    /\ phase' = IF RelaunchOnInstallFailure THEN "relaunching" ELSE "stranded"
    /\ wedged' = FALSE

Done ==
    /\ phase \in {"installed", "relaunching", "stranded", "restart-required"} \/ (phase = "failed" /\ wedged)
    /\ UNCHANGED vars

Next ==
    \/ StartCheck
    \/ RetryCheck
    \/ CheckCurrent
    \/ CheckFindsUpdate
    \/ CheckFails
    \/ CheckErrorsBeforeSettle
    \/ CheckTimesOutOrLoadFails
    \/ ZipDownloadFinishes
    \/ DownloadFails
    \/ DownloadStallsOrTimesOut
    \/ NativeVerificationFinishes
    \/ NativeVerificationFails
    \/ NativeVerificationTimesOut
    \/ PreparedUpdateInvalidated
    \/ ClickRestartToUpdate
    \/ InstallHandoffSucceeds
    \/ InstallHandoffFails
    \/ Done

Spec == Init /\ [][Next]_vars

\* User promises (never weakened)
NoPermanentRetryWedge == ~(phase = "failed" /\ wedged)
RestartToUpdateNeverStrandsApp == phase # "stranded"

=============================================================================
