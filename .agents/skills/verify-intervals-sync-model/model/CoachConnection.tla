--------------------------- MODULE CoachConnection ---------------------------
(***************************************************************************)
(* The desktop window's shared connection to the coach, the calls that    *)
(* ride on it, the coach's sync windows, and the stored intervals.icu     *)
(* sign-in that main applies to the coach.                                 *)
(*                                                                         *)
(* Each action names the code it models. The coverage table in SKILL.md   *)
(* gives the file and function for every action at the sync commit.       *)
(* Each CONSTANT is one fact about the code. scripts/check.ts reads that  *)
(* fact from the code before it runs TLC, so the model runs with what the *)
(* code does today.                                                        *)
(***************************************************************************)
EXTENDS Naturals, Sequences

CONSTANTS
    \* activity-analysis/controller.ts load(): getActivityAnalysis gets { signal }.
    AnalysisPassesSignal,
    \* coach-client/src/client.ts call(): a caller's abort runs latchTerminal.
    AbortLatches,
    \* coach-client/src/client.ts call(): a call's timer runs latchTerminal
    \* (before PR 1185) rather than timeOut(), which rejects only that call.
    TimeoutLatches,
    \* training-sync.ts: after the provider opens a new connection, an
    \* interrupted sync asks the coach again by itself.
    RereadOnOpen,
    \* main: a stored sign-in refused for a network reason gets a retry.
    TransientRetry,
    \* training-sync.ts: a sync the coach ran with no key is a failure while
    \* the athlete has a saved sign-in.
    SkippedIsFailure,
    \* coach: a credential clear cancels the sync window that holds the lane.
    ClearCancelsWindow

\* Bounds. Each actor acts at most this often in one behavior.
MaxPresses == 2      \* Sync now / Try again
MaxLoads == 2        \* ride analysis loads
MaxDrops == 1        \* socket closes or protocol faults
MaxFlips == 2        \* network changes
MaxScheduled == 1    \* scheduled or initial coach windows

Calls == {"sync", "analysis", "chat"}

VARIABLES
    \* The window's selected CoachClient (apps/desktop-renderer/src/coach-client.ts).
    conn,          \* "open" | "lost"
    lostBy,        \* the cause latchTerminal latched last
    reopened,      \* the provider opened a new connection after a loss
    failedBy,      \* [Calls -> "none" | "own" | "connection" | "another-call"]
    \* The window's sync coordinator (apps/desktop-renderer/src/training-sync.ts).
    syncCall,      \* "none" | "waiting" | "rejected"
    answer,        \* the coach's answer, not yet published: "none" or a shown value
    win,           \* what the sidebar shows
    rereadDue,     \* an interrupted sync waits to ask the coach again
    presses,       \* Sync now presses left
    \* The coach (packages/coach/src/store-runtime.ts, operations.ts).
    lane,          \* who holds the window lane: "free" | "window" | "clear"
    laneQueue,     \* lane.waiting in order: "call" | "orphan" | "scheduler" | "clear"
    windowFor,     \* whom the running window answers: "none" | "call" | "orphan" | "scheduler"
    windowKey,     \* the running window read a non-empty intervals.icu key
    served,        \* what the coach's last window for a window request means
    contextStale,  \* the window's training context predates that window
    scheduled,     \* scheduled windows left
    coachKey,      \* the coach's runtime config holds an intervals.icu key
    \* Calls beside the sync on the same connection.
    analysis,      \* "none" | "loading"
    stale,         \* a superseded analysis call still waits on the connection
    loads,         \* analysis loads left
    chat,          \* "none" | "streaming" | "done" | "cut"
    drops,         \* connection drops left
    \* The stored sign-in (apps/desktop/src/main).
    network,       \* "up" | "down"
    flips,         \* network changes left
    slot,          \* vault runtime state of intervals-icu:
                   \* "stored" | "active" | "failed-network" | "failed" | "missing"
    retry,         \* "none" | "scheduled"
    \* Disconnect in Settings.
    disc,          \* "idle" | "waiting" | "applying" | "answered-applied"
                   \* | "answered-error" | "revoked" | "diverged"
    deadline       \* "none" | "coach-passed" | "client-timed-out"

connVars == <<conn, lostBy, reopened, failedBy>>
syncVars == <<syncCall, answer, win, rereadDue, presses>>
syncRest == <<answer, win, rereadDue, presses>>   \* syncVars less syncCall, which a latch changes
coachVars == <<lane, laneQueue, windowFor, windowKey, served, contextStale, scheduled, coachKey>>
callVars == <<analysis, stale, loads, chat, drops>>
signInVars == <<network, flips, slot, retry>>
discVars == <<disc, deadline>>
vars == <<connVars, syncVars, coachVars, callVars, signInVars, discVars>>

-----------------------------------------------------------------------------
(* Helpers *)

Launched == slot # "stored"
SavedSignIn == slot # "missing"

\* training-sync.ts begin(): how the coordinator publishes a SyncRpcResult,
\* and what the sidebar then shows (training-context/manual-sync.ts).
\*   "synced"      published or no-change after a fetch
\*   "local-only"  backfill "skipped-no-credential": success tone,
\*                 "Local training-data processing completed."
\*   "not-in-use"  the same result shown as a failure (the 410 fix)
\*   "failed"      a remote error: "Sync needs attention", Try again
Shown(result) ==
    CASE result = "fetched" -> "synced"
      [] result = "skipped" ->
            IF SkippedIsFailure /\ SavedSignIn THEN "not-in-use" ELSE "local-only"
      [] result = "cancelled" -> "failed"

\* What a call that latchTerminal rejects was failed by.
Classify(c, cause) ==
    IF cause \in {"analysis-abort", "analysis-timeout"}
    THEN IF c = "analysis" THEN "own" ELSE "another-call"
    ELSE "connection"

Pending(c) ==
    CASE c = "sync" -> syncCall = "waiting"
      [] c = "analysis" -> analysis = "loading" \/ stale
      [] c = "chat" -> chat = "streaming"

\* client.ts latchTerminal(): rejects every pending call, clears the send
\* queue, closes the socket and runs onTerminal, which clears the provider's
\* selected client (coach-client.ts onTerminal). One synchronous step.
\* The coach keeps running a sync whose caller went away: rpc-server.ts
\* passes the sync handler no detach signal, so its window becomes an orphan.
\* `after` is the connection state at the end of the step.
LatchTo(cause, after) ==
    /\ conn' = after
    /\ lostBy' = cause
    /\ failedBy' = [c \in Calls |-> IF Pending(c) THEN Classify(c, cause) ELSE failedBy[c]]
    /\ syncCall' = IF syncCall = "waiting" THEN "rejected" ELSE syncCall
    /\ windowFor' = IF windowFor = "call" THEN "orphan" ELSE windowFor
    /\ laneQueue' = [i \in 1..Len(laneQueue) |->
                        IF laneQueue[i] = "call" THEN "orphan" ELSE laneQueue[i]]
    /\ analysis' = "none"
    /\ stale' = FALSE
    /\ chat' = IF chat = "streaming" THEN "cut" ELSE chat

Latch(cause) == LatchTo(cause, "lost")

\* activity-analysis/controller.ts operation?.abort(), run by select(),
\* load() and invalidate(). The connection ends as `latched` when the abort
\* latches the client, and as `otherwise` when it does not.
Latching == analysis = "loading" /\ AnalysisPassesSignal /\ AbortLatches

CancelAnalysis(latched, otherwise) ==
    IF Latching THEN LatchTo("analysis-abort", latched)
    ELSE /\ conn' = otherwise
         /\ UNCHANGED <<lostBy, syncCall, windowFor, laneQueue, chat>>
         /\ IF analysis # "loading"
            THEN UNCHANGED <<failedBy, analysis, stale>>
            ELSE IF AnalysisPassesSignal
            THEN /\ analysis' = "none"
                 /\ failedBy' = [failedBy EXCEPT !["analysis"] = "own"]
                 /\ UNCHANGED stale
            \* No signal: the generation check drops the late answer (load()).
            ELSE /\ analysis' = "none"
                 /\ stale' = TRUE
                 /\ UNCHANGED failedBy

\* main: credential-vault.ts reapplyConfigured() / retryFailed() ->
\* index.ts reapplyCredential -> credential-runtime.ts reapplyStoredCredential
\* -> configureRuntime -> coach composition.ts applyRuntimeConfig ->
\* account-identity.ts owner check, which needs the network. Offline it is
\* refused as "ownership-unavailable" and the vault marks the slot failed.
ApplyStoredSignIn ==
    IF network = "up"
    THEN /\ slot' = "active"
         /\ coachKey' = TRUE
         /\ retry' = "none"
    ELSE /\ slot' = "failed-network"
         /\ coachKey' = coachKey
         /\ retry' = IF TransientRetry THEN "scheduled" ELSE "none"

-----------------------------------------------------------------------------
(* The stored sign-in *)

\* index.ts startup: `await vault.reapplyConfigured()` before the window opens.
LaunchReappliesSignIn ==
    /\ slot = "stored"
    /\ ApplyStoredSignIn
    /\ UNCHANGED <<connVars, syncVars, lane, laneQueue, windowFor, windowKey, served,
                   contextStale, scheduled, callVars, network, flips, discVars>>

\* The 410 fix: main retries a network refusal once the network is back.
\* A retry that fires offline fails into the same state, so it is left out.
\* The re-apply waits for the window lane like any intervals.icu change, so
\* the model lets it run only when the lane is free.
RetryFires ==
    /\ retry = "scheduled" /\ slot = "failed-network" /\ network = "up"
    /\ lane = "free" /\ disc = "idle"
    /\ ApplyStoredSignIn
    /\ UNCHANGED <<connVars, syncVars, lane, laneQueue, windowFor, windowKey, served,
                   contextStale, scheduled, callVars, network, flips, discVars>>

\* Settings / Setup "Retry saved keys": onboarding-ipc.ts -> vault.retryFailed().
AthleteRetriesSavedKeys ==
    /\ slot \in {"failed-network", "failed"}
    /\ lane = "free" /\ disc \in {"idle", "revoked", "diverged"}
    /\ ApplyStoredSignIn
    /\ UNCHANGED <<connVars, syncVars, lane, laneQueue, windowFor, windowKey, served,
                   contextStale, scheduled, callVars, network, flips, discVars>>

NetworkChanges ==
    /\ flips > 0
    /\ flips' = flips - 1
    /\ network' = IF network = "up" THEN "down" ELSE "up"
    /\ UNCHANGED <<connVars, syncVars, coachVars, callVars, slot, retry, discVars>>

-----------------------------------------------------------------------------
(* The window's sync *)

\* Sync now / Try again: training-sync.ts request() -> begin() -> getClient()
\* or reconnect(failedClient) -> call("sync"). The coach's sync handler
\* (operations.ts sync -> runWindowAfter) waits for the window lane.
AthletePressesSync ==
    /\ Launched /\ presses > 0
    /\ syncCall = "none" /\ answer = "none" /\ win # "running"
    /\ presses' = presses - 1
    /\ syncCall' = "waiting"
    /\ win' = "running"
    /\ rereadDue' = FALSE
    /\ laneQueue' = Append(laneQueue, "call")
    /\ conn' = "open"
    /\ reopened' = (reopened \/ conn = "lost")
    /\ UNCHANGED <<lostBy, failedBy, answer, lane, windowFor, windowKey, served,
                   contextStale, scheduled, coachKey, callVars, signInVars, discVars>>

\* The 413 fix: the coordinator asks the coach again once a new connection is
\* open, as Try again does, with no press.
WindowRereadsSyncState ==
    /\ rereadDue /\ conn = "open" /\ syncCall = "none" /\ answer = "none"
    /\ rereadDue' = FALSE
    /\ syncCall' = "waiting"
    /\ win' = "running"
    /\ laneQueue' = Append(laneQueue, "call")
    /\ UNCHANGED <<connVars, answer, presses, lane, windowFor, windowKey, served,
                   contextStale, scheduled, coachKey, callVars, signInVars, discVars>>

\* training-sync.ts begin() catch: a rejected, admitted sync with an
\* indeterminate error (disconnected, aborted, timed out) publishes
\* failed/indeterminate: "Connection interrupted. ... won't retry it
\* automatically." The coordinator sets needsReconnect and nothing else.
WindowSettlesRejectedSync ==
    /\ syncCall = "rejected"
    /\ syncCall' = "none"
    /\ win' = "interrupted"
    /\ UNCHANGED <<connVars, answer, rereadDue, presses, coachVars, callVars,
                   signInVars, discVars>>

\* training-sync.ts begin() after a terminal reply: refreshTrainingContext()
\* (boot.ts: rideAnalysisController.invalidate(), then the training context
\* and Plan refresh) and then publish. invalidate() aborts a loading
\* analysis. The refresh's getClient() opens a fresh connection when the
\* old one is gone, so the step always ends with the connection open.
WindowFinishesSync ==
    /\ answer # "none"
    /\ CancelAnalysis("open", "open")
    /\ reopened' = (reopened \/ conn = "lost" \/ Latching)
    /\ contextStale' = FALSE
    /\ win' = answer
    /\ answer' = "none"
    /\ UNCHANGED <<rereadDue, presses, lane, served, windowKey, scheduled, coachKey,
                   loads, drops, signInVars, discVars>>

\* Any later window call after a loss: coach-client.ts getClient() ->
\* connectFresh(). The coordinator's catch runs on a microtask, before an
\* IPC round trip can open a new connection, so a rejected sync has always
\* settled first.
ProviderReconnects ==
    /\ conn = "lost" /\ syncCall # "rejected"
    /\ conn' = "open"
    /\ reopened' = TRUE
    /\ rereadDue' = (RereadOnOpen /\ win = "interrupted")
    /\ UNCHANGED <<lostBy, failedBy, syncCall, answer, win, presses, coachVars,
                   callVars, signInVars, discVars>>

-----------------------------------------------------------------------------
(* The coach's window lane *)

\* store-runtime.ts scheduler -> runScheduledWindow() -> runWindow(), or the
\* initial refresh. It starts only with a key (composition.ts).
SchedulerStartsWindow ==
    /\ scheduled > 0 /\ coachKey
    /\ scheduled' = scheduled - 1
    /\ laneQueue' = Append(laneQueue, "scheduler")
    /\ UNCHANGED <<connVars, syncVars, lane, windowFor, windowKey, served, contextStale,
                   coachKey, callVars, signInVars, discVars>>

\* store-runtime.ts admit() -> enter() / leave(): the next waiter in
\* lane.waiting takes the lane. A sync reads its key first thing
\* (operations.ts sync: input.intervalsCredentials.read()).
LaneGrants ==
    /\ lane = "free" /\ laneQueue # <<>>
    /\ laneQueue' = Tail(laneQueue)
    /\ IF Head(laneQueue) = "clear"
       THEN /\ lane' = "clear"
            /\ disc' = IF disc = "waiting" THEN "applying" ELSE disc
            /\ UNCHANGED <<windowFor, windowKey>>
       ELSE /\ lane' = "window"
            /\ windowFor' = Head(laneQueue)
            /\ windowKey' = coachKey
            /\ UNCHANGED disc
    /\ UNCHANGED <<connVars, syncVars, served, contextStale, scheduled, coachKey,
                   callVars, signInVars, deadline>>

\* operations.ts sync: backfill (skipped when the key is empty, giving
\* "skipped-no-credential"), runWindowInternal, then the RPC reply. The reply
\* reaches the window only if its call is still on an open connection.
CoachFinishesWindow ==
    /\ lane = "window"
    /\ LET result == IF windowKey THEN "fetched" ELSE "skipped" IN
       /\ served' = IF windowFor \in {"call", "orphan"} THEN Shown(result) ELSE served
       /\ contextStale' = IF windowFor \in {"call", "orphan"} /\ result = "fetched"
                          THEN TRUE ELSE contextStale
       /\ syncCall' = IF windowFor = "call" THEN "none" ELSE syncCall
       /\ answer' = IF windowFor = "call" THEN Shown(result) ELSE answer
    /\ lane' = "free"
    /\ windowFor' = "none"
    /\ windowKey' = FALSE
    /\ UNCHANGED <<connVars, win, rereadDue, presses, laneQueue, scheduled, coachKey,
                   callVars, signInVars, discVars>>

\* The 412 fix: a waiting credential clear cancels the window that holds the
\* lane; the window's call gets a remote error.
CoachCancelsWindowForClear ==
    /\ ClearCancelsWindow /\ lane = "window"
    /\ \E i \in 1..Len(laneQueue) : laneQueue[i] = "clear"
    /\ served' = IF windowFor \in {"call", "orphan"} THEN Shown("cancelled") ELSE served
    /\ syncCall' = IF windowFor = "call" THEN "none" ELSE syncCall
    /\ answer' = IF windowFor = "call" THEN Shown("cancelled") ELSE answer
    /\ lane' = "free"
    /\ windowFor' = "none"
    /\ windowKey' = FALSE
    /\ UNCHANGED <<connVars, win, rereadDue, presses, laneQueue, contextStale, scheduled,
                   coachKey, callVars, signInVars, discVars>>

-----------------------------------------------------------------------------
(* Disconnect *)

\* Settings Disconnect: credential-controller.ts confirmDelete ->
\* onboarding-ipc.ts -> credential-vault.ts deleteCredential ->
\* clearCredential -> credential-runtime.ts clearCredential ->
\* configureRuntime({ intervals: { clear_credential } }) ->
\* operations.ts configureRuntime -> runOutsideWindow, which waits for the
\* window lane.
AthleteDisconnects ==
    /\ Launched /\ disc = "idle" /\ slot \in {"active", "failed-network"}
    /\ disc' = "waiting"
    /\ laneQueue' = Append(laneQueue, "clear")
    /\ UNCHANGED <<connVars, syncVars, lane, windowFor, windowKey, served, contextStale,
                   scheduled, coachKey, callVars, signInVars, deadline>>

\* operations.ts configureRuntime apply(): signal.throwIfAborted(), then
\* applyRuntimeConfig clears the key. After the coach's deadline the apply
\* throws, so the clear never lands. With no key the coach refuses
\* "credential-required", which main treats as "not-active": same outcome.
CoachAppliesClear ==
    /\ lane = "clear"
    /\ lane' = "free"
    /\ IF deadline = "none"
       THEN /\ coachKey' = FALSE
            /\ disc' = IF disc = "applying" THEN "answered-applied" ELSE disc
       ELSE /\ UNCHANGED coachKey
            /\ disc' = IF disc = "applying" THEN "answered-error" ELSE disc
    /\ UNCHANGED <<connVars, syncVars, laneQueue, windowFor, windowKey, served,
                   contextStale, scheduled, callVars, signInVars, deadline>>

\* operations.ts configureRuntime: AbortSignal.timeout(25 s). The waiter in
\* lane.waiting has no abort path, so the deadline only marks the request.
\* It can pass only while a window that will not be cancelled holds the lane.
CoachDeadlinePasses ==
    /\ disc = "waiting" /\ deadline = "none"
    /\ lane = "window" /\ ~ClearCancelsWindow
    /\ deadline' = "coach-passed"
    /\ UNCHANGED <<connVars, syncVars, coachVars, callVars, signInVars, disc>>

\* call-timeouts.ts configureRuntime: 30 s -> client.ts timeOut() ->
\* credential-runtime.ts clearCredential rejects -> credential-vault.ts
\* deleteCredential catch: slot "failed", refused "runtime-state-diverged",
\* before beforeRemove's revoke.
MainClientTimesOut ==
    /\ deadline = "coach-passed" /\ disc \in {"waiting", "applying"}
    /\ deadline' = "client-timed-out"
    /\ disc' = "diverged"
    /\ slot' = "failed"
    /\ retry' = "none"
    /\ UNCHANGED <<connVars, syncVars, coachVars, callVars, network, flips>>

\* credential-vault.ts deleteCredential after clearCredential returns:
\* beforeRemove revokes the token, then removeStoredCredential. An error
\* answer lands in the same catch as a timeout.
MainFinishesDisconnect ==
    /\ disc \in {"answered-applied", "answered-error"}
    /\ IF disc = "answered-applied"
       THEN /\ disc' = "revoked" /\ slot' = "missing" /\ retry' = "none"
       ELSE /\ disc' = "diverged" /\ slot' = "failed" /\ retry' = "none"
    /\ UNCHANGED <<connVars, syncVars, coachVars, callVars, network, flips, deadline>>

-----------------------------------------------------------------------------
(* Other calls on the shared connection *)

\* RideReview.tsx opens the analysis section -> controller start() / load()
\* -> call("getActivityAnalysis", ..., { signal }).
AthleteOpensAnalysis ==
    /\ Launched /\ loads > 0 /\ analysis = "none" /\ conn = "open"
    /\ loads' = loads - 1
    /\ analysis' = "loading"
    /\ UNCHANGED <<connVars, syncVars, coachVars, stale, chat, drops, signInVars, discVars>>

\* Another ride, the analysis refresh, or a ride import's invalidate().
AthleteChangesRide ==
    /\ analysis = "loading"
    /\ CancelAnalysis("lost", conn)
    /\ UNCHANGED <<reopened, syncRest, lane, served, windowKey, contextStale, scheduled,
                   coachKey, loads, drops, signInVars, discVars>>

CoachAnswersAnalysis ==
    /\ analysis = "loading" /\ conn = "open"
    /\ analysis' = "none"
    /\ UNCHANGED <<connVars, syncVars, coachVars, stale, loads, chat, drops,
                   signInVars, discVars>>

\* load(): selectedGeneration !== generation drops the late answer.
CoachAnswersStaleAnalysis ==
    /\ stale /\ conn = "open"
    /\ stale' = FALSE
    /\ UNCHANGED <<connVars, syncVars, coachVars, analysis, loads, chat, drops,
                   signInVars, discVars>>

\* call-timeouts.ts getActivityAnalysis: 120 s -> client.ts timer.
AnalysisTimesOut ==
    /\ analysis = "loading"
    /\ IF TimeoutLatches
       THEN Latch("analysis-timeout")
       ELSE /\ analysis' = "none"
            /\ failedBy' = [failedBy EXCEPT !["analysis"] = "own"]
            /\ UNCHANGED <<conn, lostBy, syncCall, windowFor, laneQueue, stale, chat>>
    /\ UNCHANGED <<reopened, syncRest, lane, served, windowKey, contextStale, scheduled,
                   coachKey, loads, drops, signInVars, discVars>>

\* chat/controller.ts send -> call("chat", ...) streaming coach.turnEvent.
AthleteSendsChat ==
    /\ Launched /\ chat = "none" /\ conn = "open"
    /\ chat' = "streaming"
    /\ UNCHANGED <<connVars, syncVars, coachVars, analysis, stale, loads, drops,
                   signInVars, discVars>>

ChatReplyEnds ==
    /\ chat = "streaming" /\ conn = "open"
    /\ chat' = "done"
    /\ UNCHANGED <<connVars, syncVars, coachVars, analysis, stale, loads, drops,
                   signInVars, discVars>>

\* chat/controller.ts failProtocol(): an envelope fails its check and the
\* controller aborts its call. With AbortLatches that closes the connection,
\* which is the protocol-fault close the client means it to be.
ChatDetectsProtocolFault ==
    /\ chat = "streaming" /\ drops > 0
    /\ drops' = drops - 1
    /\ IF AbortLatches
       THEN Latch("chat-protocol")
       ELSE /\ chat' = "cut"
            /\ failedBy' = [failedBy EXCEPT !["chat"] = "own"]
            /\ UNCHANGED <<conn, lostBy, syncCall, windowFor, laneQueue, analysis, stale>>
    /\ UNCHANGED <<reopened, syncRest, lane, served, windowKey, contextStale, scheduled,
                   coachKey, loads, signInVars, discVars>>

\* client.ts onSocketClose / onSocketError: the socket goes away, as when a
\* coach the app did not start drops. A connection-level loss.
SocketCloses ==
    /\ conn = "open" /\ drops > 0
    /\ drops' = drops - 1
    /\ Latch("socket")
    /\ UNCHANGED <<reopened, syncRest, lane, served, windowKey, contextStale, scheduled,
                   coachKey, loads, signInVars, discVars>>

-----------------------------------------------------------------------------

\* Steps that happen with no athlete click and no outside event.
Automatic ==
    \/ LaunchReappliesSignIn \/ RetryFires
    \/ LaneGrants \/ CoachFinishesWindow \/ CoachCancelsWindowForClear
    \/ CoachAppliesClear \/ CoachDeadlinePasses \/ MainClientTimesOut
    \/ MainFinishesDisconnect
    \/ CoachAnswersAnalysis \/ CoachAnswersStaleAnalysis \/ AnalysisTimesOut
    \/ ChatReplyEnds
    \/ WindowSettlesRejectedSync \/ WindowFinishesSync \/ WindowRereadsSyncState

\* Steps the athlete or the outside world takes.
Outside ==
    \/ AthletePressesSync \/ AthleteOpensAnalysis \/ AthleteChangesRide
    \/ AthleteSendsChat \/ AthleteDisconnects \/ AthleteRetriesSavedKeys
    \/ SocketCloses \/ ChatDetectsProtocolFault \/ ProviderReconnects
    \/ SchedulerStartsWindow \/ NetworkChanges

\* Nothing is left to do. Keeps TLC's deadlock check quiet for /statechart.
AllSettled ==
    /\ ~ENABLED (Automatic \/ Outside)
    /\ UNCHANGED vars

Init ==
    /\ conn = "open" /\ lostBy = "none" /\ reopened = FALSE
    /\ failedBy = [c \in Calls |-> "none"]
    /\ syncCall = "none" /\ answer = "none" /\ win = "idle" /\ rereadDue = FALSE
    /\ presses = MaxPresses
    /\ lane = "free" /\ laneQueue = <<>> /\ windowFor = "none" /\ windowKey = FALSE
    /\ served = "none" /\ contextStale = FALSE /\ scheduled = MaxScheduled
    /\ coachKey = FALSE
    /\ analysis = "none" /\ stale = FALSE /\ loads = MaxLoads /\ chat = "none"
    /\ drops = MaxDrops
    /\ network \in {"up", "down"} /\ flips = MaxFlips
    /\ slot = "stored" /\ retry = "none"
    /\ disc = "idle" /\ deadline = "none"

Next == Automatic \/ Outside \/ AllSettled

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* The rules. Each states what the athlete is promised. *)

Quiescent == ~ENABLED Automatic

\* 411: one call's cancel or timeout never fails another call.
OneCallsCancelNeverFailsAnother ==
    \A c \in Calls : failedBy[c] # "another-call"

\* 413: once the window's connection is open again and nothing is left to
\* run by itself, the sidebar shows what the coach's last sync for the
\* window found, and the training context is not older than it.
WindowCatchesUpAfterReconnect ==
    (Quiescent /\ conn = "open" /\ served # "none")
        => (win = served /\ ~contextStale)

\* 410: a stored sign-in refused for a network reason has a retry scheduled.
NetworkRefusalIsRetried ==
    slot = "failed-network" => retry = "scheduled"

\* 410: while a sign-in is saved, a sync that fetched nothing from
\* intervals.icu is never shown as a success. With no saved sign-in, local
\* processing is reported as such (issue 410's fix line).
EmptySyncNeverShownAsSuccess ==
    win = "local-only" => ~SavedSignIn

\* 412: Disconnect ends with the sign-in revoked or a clear refusal, inside
\* its deadline: never "could not be reconciled" with the token kept.
DisconnectRevokesOrRefusesClearly ==
    /\ disc # "diverged"
    /\ disc = "revoked" => (~coachKey /\ slot = "missing")

(* Witnesses. TLC must find each of these false, or the rule above it is   *)
(* about a state the model never reaches.                                   *)

WitnessOtherCallsPendingDuringAnalysis ==
    ~(analysis = "loading" /\ chat = "streaming" /\ syncCall = "waiting")

WitnessQuiescentAfterReconnect ==
    ~(Quiescent /\ conn = "open" /\ served # "none" /\ reopened)

WitnessNetworkRefusal ==
    slot # "failed-network"

WitnessEmptySyncWithSignIn ==
    ~(served \in {"local-only", "not-in-use"} /\ SavedSignIn)

WitnessDisconnectDuringSync ==
    ~(disc = "waiting" /\ lane = "window")

TypeOK ==
    /\ conn \in {"open", "lost"}
    /\ failedBy \in [Calls -> {"none", "own", "connection", "another-call"}]
    /\ syncCall \in {"none", "waiting", "rejected"}
    /\ win \in {"idle", "running", "synced", "local-only", "not-in-use", "failed", "interrupted"}
    /\ lane \in {"free", "window", "clear"}
    /\ \A i \in 1..Len(laneQueue) : laneQueue[i] \in {"call", "orphan", "scheduler", "clear"}
    /\ slot \in {"stored", "active", "failed-network", "failed", "missing"}
    /\ disc \in {"idle", "waiting", "applying", "answered-applied", "answered-error",
                 "revoked", "diverged"}
=============================================================================
