----------------------------- MODULE CoachChange -----------------------------
(***************************************************************************)
(* How a coach change reaches the running coach.                           *)
(*                                                                         *)
(* One streaming chat reply, one Stop, one coach change (a model change    *)
(* from Settings, a key delete, or a ChatGPT activation), one runtime-     *)
(* config read and one transcript read, on one coach process.              *)
(*                                                                         *)
(* Granularity follows the JavaScript event loop. A step is one run of     *)
(* code between two awaits. "Macro" steps are things that arrive from      *)
(* outside: an RPC, a provider stream ending, file I/O finishing, a timer. *)
(* They can happen only when no promise continuation is ready, because    *)
(* Node runs every ready microtask before the next macrotask. The rules    *)
(* are checked in Settled states, the ones a person or another process    *)
(* can observe.                                                            *)
(*                                                                         *)
(* Time is abstract. A timer can fire only while its owner is in a long    *)
(* wait, and in the order the real timeouts allow:                         *)
(*   Stop client call 10 s   (packages/coach-client/src/call-timeouts.ts:8)  *)
(*   ChatGPT activation 10 s (apps/desktop/src/main/chatgpt-auth.ts:26)    *)
(*   coach deadline 25 s     (packages/coach/src/operations.ts:165-168)    *)
(*   configureRuntime 30 s   (packages/coach-client/src/call-timeouts.ts:45) *)
(*   getRuntimeConfig and transcript reads 30 s, started after the change  *)
(*   (packages/coach-client/src/call-timeouts.ts:29,47), so they fire      *)
(*   only after the coach deadline.                                        *)
(*                                                                         *)
(* Each design constant is one fix point. FALSE is the code at the sync    *)
(* commit in ../SKILL.md. A fix flips its constant in CoachChange.cfg.     *)
(***************************************************************************)
EXTENDS Naturals, TLC

CONSTANTS
    ChangeKinds,               \* subset of {"model-change", "key-delete", "chatgpt-activation"}
    StopBypassesAdmission,     \* stopChat runs on the active bundle without awaiting admission
    ReadsBypassAdmission,      \* transcript reads run on the active bundle without awaiting admission
    RuntimeConfigReadOffLane,  \* getRuntimeConfig does not wait on the serialized lane
    QueueCallsBypassAdmission, \* getChatQueue and enqueueChatMessage run without awaiting admission
    ReplaceHonoursDeadline,    \* replace() stops waiting for the drain when the change's signal aborts
    DeadlineRefusesBusy,       \* a change dropped at its deadline answers busy-replying, not an error
    RefuseWhileReplying,       \* a change that finds a reply running is refused (busy-replying)
    ClearBusyRefusal,          \* what the desktop's clearCredential does with busy-replying:
                               \*   "throws" (today), "refusal" (passes it on), "not-active" (wrong)
    PinMovedIntoPrepare,       \* composition.ts:1491's catalog pin runs inside replace()'s prepare
    PrepareIsPure              \* prepare writes nothing shared; the writes happen in commit

VARIABLES
    reply,          \* the chat call: "absent", "admitting", "streaming", "stopping", "stopped", "finished"
    replyCapture,   \* the admission the chat call captured when it started: "open" or "barrier"
    replyBundle,    \* the bundle the reply runs on: "none", "old", "new"
    stop,           \* "absent", "admitting", "reached", "missed", "timed-out"
    stopCapture,
    stopGaveUp,     \* history: Stop timed out while the reply was still in progress
    replyOutranStop,\* history: the reply ended on its own after Stop was pressed
    change,         \* "absent", "queued", "building", "draining", "committing", "applied", "failed", "refused"
    kind,           \* "none" or one of ChangeKinds
    aborted,        \* the change's AbortSignal: the deadline or the caller's detach
    deadlineFired,
    clientGaveUp,   \* the desktop's call for the change timed out
    barrier,        \* replace()'s admission barrier: "none", "held", "released"
    cfgRead,        \* getRuntimeConfig: "absent", "queued", "answered", "timed-out"
    pageRead,       \* getTranscriptPage: "absent", "admitting", "answered", "timed-out"
    pageCapture,
    queueCall,      \* getChatQueue or enqueueChatMessage: "absent", "admitting", "answered", "timed-out"
    queueCapture,
    active,         \* the bundle run() selects: "old" or "new"
    catalogSession, \* composition.ts catalogSession (model list pin): "old" or "new"
    engineConfig,   \* composition.ts currentEngineConfig (attachment limits): "old" or "new"
    profilesFile,   \* model-catalog/selected-model-profiles.json: "old" or "new"
    configFile,     \* config.yaml and unapprovedConfig: "old" or "new"
    desktop,        \* what the desktop was told: "none", "waiting", "applied", "failed", "refused"
    slot,           \* the vault's runtime state for the key: "active", "failed", "deleted"
    storedKey,      \* the key file: "present", "removed"
    screen          \* the window: "app" or "setup-gate"

vars == <<reply, replyCapture, replyBundle, stop, stopCapture, stopGaveUp, replyOutranStop, change, kind,
          aborted, deadlineFired, clientGaveUp, barrier, cfgRead, pageRead, pageCapture,
          queueCall, queueCapture, active, catalogSession, engineConfig, profilesFile, configFile,
          desktop, slot, storedKey, screen>>

coachParts == <<active, catalogSession, engineConfig, profilesFile, configFile>>
windowParts == <<screen, slot, storedKey>>
readParts == <<cfgRead, pageRead, pageCapture, queueCall, queueCapture>>

-----------------------------------------------------------------------------
(* Derived state *)

\* runtime-bundle.ts:54 counts a call from admission to its end. Only the
\* reply lasts long enough to matter. Stop and the reads are one step each.
ActiveCalls == IF reply \in {"streaming", "stopping"} THEN 1 ELSE 0

\* runtime-bundle.ts:53 awaits the admission promise that was current when
\* the call started. replace() installs the barrier synchronously (:130-133).
Capture == IF barrier = "held" THEN "barrier" ELSE "open"
Open(capture) == capture = "open" \/ barrier = "released"

\* operations.ts:156-163: the lane's tail is the change's task until it settles.
LaneHeldByChange == change \in {"queued", "building", "draining", "committing"}

\* A change kind that carries a model list snapshot and a model: Settings
\* sends one (index.ts runtimeConfigurationForExistingSelection), ChatGPT
\* activation sends one (chatgpt-auth.ts runtimeConfigurationForSelection).
\* A key delete sends only clear_credential (credential-runtime.ts:131-137).
ChangesModel == kind \in {"model-change", "chatgpt-activation"}

\* Ready promise continuations (microtasks).
ReplyReady  == reply = "admitting" /\ Open(replyCapture)
StopReady   == stop = "admitting" /\ Open(stopCapture) /\ ~ReplyReady \* the chat call captured first, so it resumes first
PageReady   == pageRead = "admitting" /\ Open(pageCapture)
QueueReady  == queueCall = "admitting" /\ Open(queueCapture)
CfgReady    == cfgRead = "queued" /\ ~LaneHeldByChange
ChangeReady == \/ change \in {"queued", "committing"}
               \/ change = "draining" /\ (ActiveCalls = 0 \/ (ReplaceHonoursDeadline /\ aborted))

MicrotaskReady == ReplyReady \/ StopReady \/ PageReady \/ QueueReady \/ CfgReady \/ ChangeReady
Settled == ~MicrotaskReady

-----------------------------------------------------------------------------
(* What the desktop does with the answer to a change *)

\* credential-runtime.ts clearCredential throws on an error or an unmapped
\* refusal. credential-vault.ts:978-981 catches it, sets the slot "failed"
\* and returns runtime-state-diverged. credential-controller.ts sets
\* repairCredential, settings-slice.ts calls requireCompletion, and
\* Shell.tsx shows the Setup gate. A model change shows "Coach settings
\* couldn't become active" and an activation returns runtime-unavailable:
\* neither changes the window parts modelled here.
DesktopSeesError ==
    /\ desktop' = "failed"
    /\ IF kind = "key-delete"
         THEN slot' = "failed" /\ screen' = "setup-gate"
         ELSE UNCHANGED <<slot, screen>>
    /\ UNCHANGED storedKey

\* For a key delete the refusal reaches credential-vault.ts through
\* credential-runtime.ts clearCredential. "throws" is today's TypeError, so the
\* vault records a divergence. "not-active" (the mapping credential-required
\* gets) makes the vault delete the key file and report it deleted while the
\* coach keeps the key.
DesktopSeesRefusal ==
    \/ /\ kind # "key-delete" \/ ClearBusyRefusal = "refusal"
       /\ desktop' = "refused"
       /\ UNCHANGED <<slot, screen, storedKey>>
    \/ /\ kind = "key-delete" /\ ClearBusyRefusal = "throws"
       /\ desktop' = "refused"
       /\ slot' = "failed" /\ screen' = "setup-gate"
       /\ UNCHANGED storedKey
    \/ /\ kind = "key-delete" /\ ClearBusyRefusal = "not-active"
       /\ desktop' = "applied"
       /\ slot' = "deleted" /\ storedKey' = "removed"
       /\ UNCHANGED screen

\* credential-vault.ts:994-1009: the runtime cleared, then the key file goes.
DesktopSeesSuccess ==
    /\ desktop' = "applied"
    /\ IF kind = "key-delete"
         THEN slot' = "deleted" /\ storedKey' = "removed"
         ELSE UNCHANGED <<slot, storedKey>>
    /\ UNCHANGED screen

-----------------------------------------------------------------------------
(* Macro steps: they arrive from outside the coach's promise chains *)

ReplyArrives ==   \* a chat RPC reaches runtime-bundle.ts:78 and captures admission
    /\ Settled /\ reply = "absent"
    /\ reply' = "admitting" /\ replyCapture' = Capture
    /\ UNCHANGED <<replyBundle, stop, stopCapture, stopGaveUp, replyOutranStop, change, kind, aborted,
                   deadlineFired, clientGaveUp, barrier, readParts, coachParts,
                   desktop, windowParts>>

ReplyFinishes ==  \* the provider stream ends on its own; runtime-bundle.ts:58-63 resolves drain waiters
    /\ Settled /\ reply = "streaming"
    /\ reply' = "finished"
    /\ replyOutranStop' = (replyOutranStop \/ stop \in {"admitting", "missed"})
    /\ UNCHANGED <<replyCapture, replyBundle, stop, stopCapture, stopGaveUp, change, kind, aborted,
                   deadlineFired, clientGaveUp, barrier, readParts, coachParts,
                   desktop, windowParts>>

ReplyStops ==     \* the aborted turn unwinds (coach-agent.ts stopChat aborted its controller)
    /\ Settled /\ reply = "stopping"
    /\ reply' = "stopped"
    /\ UNCHANGED <<replyCapture, replyBundle, stop, stopCapture, stopGaveUp, replyOutranStop, change, kind,
                   aborted, deadlineFired, clientGaveUp, barrier, readParts, coachParts,
                   desktop, windowParts>>

\* chat/controller.ts requestStop sends stopChat only once the turn is bound
\* (its first turn event); a Stop pressed earlier is held until then.
StopArrives ==
    /\ Settled /\ stop = "absent" /\ reply = "streaming"
    /\ stop' = "admitting"
    /\ stopCapture' = IF StopBypassesAdmission THEN "open" ELSE Capture
    /\ UNCHANGED <<reply, replyCapture, replyBundle, stopGaveUp, replyOutranStop, change, kind, aborted,
                   deadlineFired, clientGaveUp, barrier, readParts, coachParts,
                   desktop, windowParts>>

StopTimesOut ==   \* 10 s client timeout; chat/controller.ts never resends Stop
    \* Settled with stop "admitting" means Stop waits behind the barrier. Only
    \* the drain holds the barrier long enough for a 10 s timer.
    /\ Settled /\ stop = "admitting" /\ change = "draining"
    /\ stop' = "timed-out"
    /\ stopGaveUp' = (stopGaveUp \/ reply \in {"admitting", "streaming"})
    /\ UNCHANGED <<reply, replyCapture, replyBundle, stopCapture, replyOutranStop, change, kind, aborted,
                   deadlineFired, clientGaveUp, barrier, readParts, coachParts,
                   desktop, windowParts>>

ChangeArrives(k) == \* configureRuntime reaches operations.ts:343 and joins the lane
    /\ Settled /\ change = "absent"
    /\ change' = "queued" /\ kind' = k /\ desktop' = "waiting"
    /\ UNCHANGED <<reply, replyCapture, replyBundle, stop, stopCapture, stopGaveUp, replyOutranStop, aborted,
                   deadlineFired, clientGaveUp, barrier, readParts, coachParts,
                   slot, storedKey, screen>>

BuildIoDone ==    \* buildBundle's awaited I/O returns (composition.ts:1247), the rest of prepare runs
    /\ Settled /\ change = "building"
    \* composition.ts:1259-1262 writes the profiles file (new content only when
    \* the model changes); composition.ts:1263 sets currentEngineConfig for every
    \* kind, and for a key delete its llm.apiKey is "" (attachment checks read it).
    /\ profilesFile' = IF ChangesModel /\ ~PrepareIsPure THEN "new" ELSE profilesFile
    /\ engineConfig' = IF ~PrepareIsPure THEN "new" ELSE engineConfig
    \* runtime-bundle.ts:137-139: wait for running calls, with no signal
    /\ change' = IF ActiveCalls > 0 THEN "draining" ELSE "committing"
    /\ UNCHANGED <<reply, replyCapture, replyBundle, stop, stopCapture, stopGaveUp, replyOutranStop, kind,
                   aborted, deadlineFired, clientGaveUp, barrier, readParts,
                   active, catalogSession, configFile, desktop, windowParts>>

DeadlineFires ==  \* operations.ts:348 AbortSignal.timeout(25 s) while the change waits for the reply
    /\ Settled /\ change = "draining" /\ ~deadlineFired
    /\ deadlineFired' = TRUE /\ aborted' = TRUE
    /\ UNCHANGED <<reply, replyCapture, replyBundle, stop, stopCapture, stopGaveUp, replyOutranStop, change,
                   kind, clientGaveUp, barrier, readParts, coachParts, desktop, windowParts>>

ClientGivesUp ==  \* the desktop's call times out, closes its connection, the coach detaches
    /\ Settled /\ change = "draining" /\ ~clientGaveUp
    /\ (kind = "chatgpt-activation" \/ deadlineFired)
    /\ clientGaveUp' = TRUE /\ aborted' = TRUE
    /\ DesktopSeesError
    /\ UNCHANGED <<reply, replyCapture, replyBundle, stop, stopCapture, stopGaveUp, replyOutranStop, change,
                   kind, deadlineFired, barrier, readParts, coachParts>>

CfgReadArrives == \* getRuntimeConfig, operations.ts:405-416
    /\ Settled /\ cfgRead = "absent"
    /\ cfgRead' = IF RuntimeConfigReadOffLane THEN "answered" ELSE "queued"
    /\ UNCHANGED <<queueCall, queueCapture, reply, replyCapture, replyBundle, stop, stopCapture, stopGaveUp, replyOutranStop, change,
                   kind, aborted, deadlineFired, clientGaveUp, barrier, pageRead,
                   pageCapture, coachParts, desktop, windowParts>>

CfgReadTimesOut == \* onboarding-ipc.ts then reports active as null: Coach shows "Not configured"
    /\ Settled /\ cfgRead = "queued" /\ deadlineFired
    /\ cfgRead' = "timed-out"
    /\ UNCHANGED <<queueCall, queueCapture, reply, replyCapture, replyBundle, stop, stopCapture, stopGaveUp, replyOutranStop, change,
                   kind, aborted, deadlineFired, clientGaveUp, barrier, pageRead,
                   pageCapture, coachParts, desktop, windowParts>>

PageReadArrives == \* getTranscriptPage, runtime-bundle.ts:117-118
    /\ Settled /\ pageRead = "absent"
    /\ pageRead' = "admitting"
    /\ pageCapture' = IF ReadsBypassAdmission THEN "open" ELSE Capture
    /\ UNCHANGED <<queueCall, queueCapture, reply, replyCapture, replyBundle, stop, stopCapture, stopGaveUp, replyOutranStop, change,
                   kind, aborted, deadlineFired, clientGaveUp, barrier, cfgRead,
                   coachParts, desktop, windowParts>>

PageReadTimesOut ==
    /\ Settled /\ pageRead = "admitting" /\ deadlineFired
    /\ pageRead' = "timed-out"
    /\ UNCHANGED <<queueCall, queueCapture, reply, replyCapture, replyBundle, stop, stopCapture, stopGaveUp, replyOutranStop, change,
                   kind, aborted, deadlineFired, clientGaveUp, barrier, cfgRead,
                   pageCapture, coachParts, desktop, windowParts>>

QueueCallArrives == \* the window's getChatQueue or enqueueChatMessage, runtime-bundle.ts:81-84
    /\ Settled /\ queueCall = "absent"
    /\ queueCall' = "admitting"
    /\ queueCapture' = IF QueueCallsBypassAdmission THEN "open" ELSE Capture
    /\ UNCHANGED <<reply, replyCapture, replyBundle, stop, stopCapture, stopGaveUp,
                   replyOutranStop, change, kind, aborted, deadlineFired, clientGaveUp,
                   barrier, cfgRead, pageRead, pageCapture, coachParts, desktop, windowParts>>

QueueCallTimesOut == \* 30 s client timeout (call-timeouts.ts), started after the change
    /\ Settled /\ queueCall = "admitting" /\ deadlineFired
    /\ queueCall' = "timed-out"
    /\ UNCHANGED <<reply, replyCapture, replyBundle, stop, stopCapture, stopGaveUp,
                   replyOutranStop, change, kind, aborted, deadlineFired, clientGaveUp,
                   barrier, cfgRead, pageRead, pageCapture, queueCapture, coachParts,
                   desktop, windowParts>>

-----------------------------------------------------------------------------
(* Micro steps: promise continuations *)

ReplyAdmitted ==  \* runtime-bundle.ts:54-57 selects the active bundle
    /\ ReplyReady
    /\ reply' = "streaming" /\ replyBundle' = active
    /\ UNCHANGED <<replyCapture, stop, stopCapture, stopGaveUp, replyOutranStop, change, kind, aborted,
                   deadlineFired, clientGaveUp, barrier, readParts, coachParts,
                   desktop, windowParts>>

StopAdmitted ==   \* runtime-bundle.ts:79-80 then coach-agent.ts stopChat on the selected bundle
    /\ StopReady
    /\ IF reply = "streaming" /\ replyBundle = active
         THEN reply' = "stopping" /\ stop' = "reached"
         ELSE UNCHANGED reply /\ stop' = "missed"
    /\ UNCHANGED <<replyCapture, replyBundle, stopCapture, stopGaveUp, replyOutranStop, change, kind, aborted,
                   deadlineFired, clientGaveUp, barrier, readParts, coachParts,
                   desktop, windowParts>>

PageReadAdmitted ==
    /\ PageReady
    /\ pageRead' = "answered"
    /\ UNCHANGED <<queueCall, queueCapture, reply, replyCapture, replyBundle, stop, stopCapture, stopGaveUp, replyOutranStop, change,
                   kind, aborted, deadlineFired, clientGaveUp, barrier, cfgRead,
                   pageCapture, coachParts, desktop, windowParts>>

QueueCallAdmitted ==
    /\ QueueReady
    /\ queueCall' = "answered"
    /\ UNCHANGED <<reply, replyCapture, replyBundle, stop, stopCapture, stopGaveUp,
                   replyOutranStop, change, kind, aborted, deadlineFired, clientGaveUp,
                   barrier, cfgRead, pageRead, pageCapture, queueCapture, coachParts,
                   desktop, windowParts>>

CfgReadRuns ==
    /\ CfgReady
    /\ cfgRead' = "answered"
    /\ UNCHANGED <<queueCall, queueCapture, reply, replyCapture, replyBundle, stop, stopCapture, stopGaveUp, replyOutranStop, change,
                   kind, aborted, deadlineFired, clientGaveUp, barrier, pageRead,
                   pageCapture, coachParts, desktop, windowParts>>

\* The lane task starts: operations.ts:353-363, composition.ts:1439-1596 run
\* synchronously for an LLM-only request, then replace() installs the barrier
\* (runtime-bundle.ts:127-133), and prepare runs up to its first I/O.
\* composition.ts:1491 pins the request's model list snapshot before replace(),
\* so today it lands even when the change is then refused or dropped. With
\* PinMovedIntoPrepare it runs inside prepare, as composition.ts:1226 does.
PinnedBeforeReplace == ChangesModel /\ ~PinMovedIntoPrepare

ChangeStarts ==
    /\ change = "queued"
    /\ IF RefuseWhileReplying /\ ActiveCalls > 0
         THEN /\ change' = "refused"
              /\ DesktopSeesRefusal
              /\ catalogSession' = IF PinnedBeforeReplace THEN "new" ELSE catalogSession
              /\ UNCHANGED barrier
         ELSE /\ change' = "building"
              /\ barrier' = "held"
              /\ catalogSession' =
                   IF PinnedBeforeReplace \/ (ChangesModel /\ ~PrepareIsPure)
                     THEN "new" ELSE catalogSession
              /\ UNCHANGED <<desktop, windowParts>>
    /\ UNCHANGED <<reply, replyCapture, replyBundle, stop, stopCapture, stopGaveUp, replyOutranStop, kind,
                   aborted, deadlineFired, clientGaveUp, readParts,
                   active, engineConfig, profilesFile, configFile>>

\* After the drain (or right away): commit, then replace()'s finally releases
\* the barrier (runtime-bundle.ts:140-144) and the lane task settles.
ChangeFinishes ==
    /\ ChangeReady /\ change \in {"committing", "draining"}
    /\ barrier' = "released"
    /\ IF aborted
         \* composition.ts:1624 throwIfAborted: the commit is dropped
         THEN /\ IF DeadlineRefusesBusy /\ deadlineFired /\ ~clientGaveUp
                   THEN change' = "refused" /\ DesktopSeesRefusal
                   ELSE /\ change' = "failed"
                        /\ IF clientGaveUp THEN UNCHANGED <<desktop, windowParts>> ELSE DesktopSeesError
              /\ UNCHANGED coachParts
         \* composition.ts:1630-1657 persists, then the new bundle becomes active
         ELSE /\ change' = "applied"
              /\ active' = "new" /\ configFile' = "new"
              /\ IF PrepareIsPure
                   THEN /\ engineConfig' = "new"
                        /\ catalogSession' = IF ChangesModel THEN "new" ELSE catalogSession
                        /\ profilesFile' = IF ChangesModel THEN "new" ELSE profilesFile
                   ELSE UNCHANGED <<catalogSession, engineConfig, profilesFile>>
              /\ DesktopSeesSuccess
    /\ UNCHANGED <<reply, replyCapture, replyBundle, stop, stopCapture, stopGaveUp, replyOutranStop, kind,
                   aborted, deadlineFired, clientGaveUp, readParts>>

-----------------------------------------------------------------------------

Init ==
    /\ reply = "absent" /\ replyCapture = "open" /\ replyBundle = "none"
    /\ stop = "absent" /\ stopCapture = "open"
    /\ stopGaveUp = FALSE /\ replyOutranStop = FALSE
    /\ change = "absent" /\ kind = "none"
    /\ aborted = FALSE /\ deadlineFired = FALSE /\ clientGaveUp = FALSE
    /\ barrier = "none"
    /\ cfgRead = "absent" /\ pageRead = "absent" /\ pageCapture = "open"
    /\ queueCall = "absent" /\ queueCapture = "open"
    /\ active = "old" /\ catalogSession = "old" /\ engineConfig = "old"
    /\ profilesFile = "old" /\ configFile = "old"
    /\ desktop = "none" /\ slot = "active" /\ storedKey = "present" /\ screen = "app"

Step ==
    \/ ReplyArrives \/ ReplyFinishes \/ ReplyStops
    \/ StopArrives \/ StopTimesOut
    \/ \E k \in ChangeKinds : ChangeArrives(k)
    \/ BuildIoDone \/ DeadlineFires \/ ClientGivesUp
    \/ CfgReadArrives \/ CfgReadTimesOut \/ PageReadArrives \/ PageReadTimesOut
    \/ QueueCallArrives \/ QueueCallTimesOut
    \/ ReplyAdmitted \/ StopAdmitted \/ PageReadAdmitted \/ QueueCallAdmitted \/ CfgReadRuns
    \/ ChangeStarts \/ ChangeFinishes

\* Nothing left to happen: every actor has had its one turn and none waits.
AllFinished ==
    /\ reply \in {"absent", "stopped", "finished"}
    /\ stop # "admitting"
    /\ change \in {"absent", "applied", "failed", "refused"}
    /\ cfgRead # "queued" /\ pageRead # "admitting" /\ queueCall # "admitting"
Done == AllFinished /\ ~ENABLED Step /\ UNCHANGED vars

Next == Step \/ Done

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* The rules *)

TypeOK ==
    /\ reply \in {"absent", "admitting", "streaming", "stopping", "stopped", "finished"}
    /\ replyCapture \in {"open", "barrier"} /\ stopCapture \in {"open", "barrier"}
    /\ pageCapture \in {"open", "barrier"}
    /\ replyBundle \in {"none", "old", "new"}
    /\ stop \in {"absent", "admitting", "reached", "missed", "timed-out"}
    /\ change \in {"absent", "queued", "building", "draining", "committing",
                   "applied", "failed", "refused"}
    /\ kind \in ChangeKinds \cup {"none"}
    /\ barrier \in {"none", "held", "released"}
    /\ cfgRead \in {"absent", "queued", "answered", "timed-out"}
    /\ pageRead \in {"absent", "admitting", "answered", "timed-out"}
    /\ queueCall \in {"absent", "admitting", "answered", "timed-out"}
    /\ queueCapture \in {"open", "barrier"}
    /\ {active, catalogSession, engineConfig, profilesFile, configFile} \subseteq {"old", "new"}
    /\ desktop \in {"none", "waiting", "applied", "failed", "refused"}
    /\ slot \in {"active", "failed", "deleted"} /\ storedKey \in {"present", "removed"}
    /\ screen \in {"app", "setup-gate"}

\* 1. Stop is always admitted while a reply runs: a Stop pressed while the
\*    reply is in progress reaches that reply before its client timeout (1a)
\*    and before the reply ends on its own (1b).
StopNeverGivesUpDuringAReply == ~stopGaveUp
StopReachesReplyBeforeItEnds == ~replyOutranStop

\* 2. A coach change never blocks reads past its deadline: the runtime-config
\*    read, the transcript read and the window's chat-queue calls.
ReadsNotBlockedPastDeadline ==
    /\ cfgRead # "timed-out" /\ pageRead # "timed-out" /\ queueCall # "timed-out"
    /\ (Settled /\ deadlineFired) =>
         (cfgRead # "queued" /\ pageRead # "admitting" /\ queueCall # "admitting")

\* 3. A coach change that fails leaves no part of it applied, in the coach
\*    (3a) and in the window (3b).
ChangeFailed == change \in {"failed", "refused"} \/ desktop \in {"failed", "refused"}

FailedChangeLeavesCoachUnchanged ==
    (Settled /\ ChangeFailed) => coachParts = <<"old", "old", "old", "old", "old">>

FailedChangeLeavesWindowUnchanged ==
    (Settled /\ ChangeFailed) => (screen = "app" /\ slot = "active" /\ storedKey = "present")

\* Companion that holds today, pinned on purpose by composition.test.ts
\* "drains active runtime work before clearing...": the coach never swaps
\* bundles under a reply that still runs on the old one.
NoSwapUnderARunningReply ==
    active = "new" => ~(reply \in {"streaming", "stopping"} /\ replyBundle = "old")

=============================================================================
