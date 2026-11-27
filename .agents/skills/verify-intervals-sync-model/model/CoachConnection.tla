--------------------------- MODULE CoachConnection ---------------------------
(***************************************************************************)
(* The desktop window's shared connection to the coach, the calls that    *)
(* ride on it, the coach's sync windows, and the stored intervals.icu     *)
(* sign-in that main applies to the coach.                                 *)
(*                                                                         *)
(* Each action names the code it models. The coverage table in SKILL.md   *)
(* gives the file and function for every action. Each CONSTANT is one     *)
(* fact about the code; scripts/check.ts reads it from the code before it *)
(* runs TLC, so the model runs with what the code does today.             *)
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
    \* training-sync.ts: once the provider opens a new connection, the window
    \* asks the coach again for an interrupted sync and refreshes Training if
    \* its last refresh failed.
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
MaxLoads == 1        \* ride analysis opens
MaxDrops == 2        \* socket closes or chat protocol faults
MaxFlips == 2        \* network changes
MaxScheduled == 1    \* scheduled or initial coach windows

Calls == {"sync", "analysis", "chat", "refresh"}

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
    rereadDue,     \* the window will ask the coach again by itself
    presses,       \* Sync now presses left
    refresh,       \* Training and Plan refresh: "none" | "pending" | "done" | "failed"
    refreshFailed, \* Training shows its refresh-unavailable state
    \* The coach (packages/coach/src/store-runtime.ts, operations.ts).
    lane,          \* who holds the window lane: "free" | "window" | "clear"
    laneQueue,     \* lane.waiting in order: "call" | "orphan" | "scheduler" | "clear"
    windowFor,     \* whom the running window answers: "none" | "call" | "orphan" | "scheduler"
    windowKey,     \* the running window read a non-empty intervals.icu key
    served,        \* what the coach's last window for a window request means
    orphanServed,  \* a window finished for a request whose caller had gone
    contextStale,  \* the window's training context predates that window
    scheduled,     \* scheduled windows left
    coachKey,      \* the coach's runtime config holds an intervals.icu key
    \* Calls beside the sync on the same connection.
    analysis,      \* "none" | "loading" | "shown"
    stale,         \* a superseded analysis call still on the connection:
                   \* "none" | "ignored" (dropped by generation) | "aborted" (by the client)
    loads,         \* analysis opens left
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
                   \* | "answered-error" | "revoked" | "removed-unrevoked" | "diverged"
    deadline       \* "none" | "coach-passed" | "client-timed-out"

connVars == <<conn, lostBy, reopened, failedBy>>
syncVars == <<syncCall, answer, win, rereadDue, presses, refresh, refreshFailed>>
coachVars == <<lane, laneQueue, windowFor, windowKey, served, orphanServed, contextStale,
               scheduled, coachKey>>
callVars == <<analysis, stale, loads, chat, drops>>
signInVars == <<network, flips, slot, retry>>
discVars == <<disc, deadline>>
vars == <<connVars, syncVars, coachVars, callVars, signInVars, discVars>>

-----------------------------------------------------------------------------
(* Helpers *)

Launched == slot # "stored"
SavedSignIn == slot # "missing"

\* training-sync.ts begin(): what the coordinator publishes for a SyncRpcResult
\* and what the athlete then sees (training-context/manual-sync.ts). The app
\* shows "Local training-data processing completed." both for a fetch that
\* found nothing new and for a sync with no key; the model keeps the cause.
\*   "synced"      the coach fetched from intervals.icu
\*   "local-only"  backfill "skipped-no-credential", shown with the success tone
\*   "not-in-use"  the same result shown as a failure (the 410 fix)
\*   "failed"      a remote error: "Sync needs attention", Try again
Shown(result) ==
    CASE result = "fetched" -> "synced"
      [] result = "skipped" ->
            IF SkippedIsFailure /\ SavedSignIn THEN "not-in-use" ELSE "local-only"
      [] result = "cancelled" -> "failed"

\* What a call that latchTerminal rejects was failed by.
Classify(c, cause) ==
    IF cause \in {"analysis-abort", "analysis-timeout", "analysis-late-reply"}
    THEN IF c = "analysis" THEN "own" ELSE "another-call"
    ELSE "connection"

Pending(c) ==
    CASE c = "sync" -> syncCall = "waiting"
      [] c = "analysis" -> analysis = "loading" \/ stale # "none"
      [] c = "chat" -> chat = "streaming"
      [] c = "refresh" -> refresh = "pending"

\* client.ts latchTerminal(): rejects every pending call, clears the send
\* queue, closes the socket and runs onTerminal, which clears the provider's
\* selected client (coach-client.ts onTerminal). One synchronous step.
\* The coach keeps running a sync whose caller went away: rpc-server.ts
\* passes the sync handler no detach signal, so its window becomes an orphan.
\* `after` is the connection state at the end of the step. A rejected
\* Training refresh leaves Training on refresh-unavailable
\* (training-context/controller.ts) and the sync still publishes.
LatchTo(cause, after) ==
    /\ conn' = after
    /\ lostBy' = cause
    /\ failedBy' = [c \in Calls |-> IF Pending(c) THEN Classify(c, cause) ELSE failedBy[c]]
    /\ syncCall' = IF syncCall = "waiting" THEN "rejected" ELSE syncCall
    /\ windowFor' = IF windowFor = "call" THEN "orphan" ELSE windowFor
    /\ laneQueue' = [i \in 1..Len(laneQueue) |->
                        IF laneQueue[i] = "call" THEN "orphan" ELSE laneQueue[i]]
    /\ analysis' = IF analysis = "shown" THEN "shown" ELSE "none"
    /\ stale' = "none"
    /\ chat' = IF chat = "streaming" THEN "cut" ELSE chat
    /\ refresh' = IF refresh = "pending"
                  THEN IF answer = "none" THEN "none" ELSE "failed"
                  ELSE refresh
    /\ refreshFailed' = (refreshFailed \/ refresh = "pending")

Latch(cause) == LatchTo(cause, "lost")

LatchVars == <<conn, lostBy, failedBy, syncCall, windowFor, laneQueue, analysis, stale,
               chat, refresh, refreshFailed>>

\* activity-analysis/controller.ts operation?.abort() on a loading analysis,
\* run by select(), load() and invalidate().
Latching == analysis = "loading" /\ AnalysisPassesSignal /\ AbortLatches

\* What a cancel that does not latch leaves on the connection: with no signal
\* the call stays and its answer is dropped by generation (load()); with a
\* signal the client rejects it locally, and the coach's later answer then
\* has an unknown id (client.ts handleTerminal -> failProtocol).
StaleAfterCancel ==
    IF analysis # "loading" THEN stale
    ELSE IF AnalysisPassesSignal THEN "aborted" ELSE "ignored"

CancelAnalysis ==
    IF Latching THEN Latch("analysis-abort")
    ELSE /\ UNCHANGED <<conn, lostBy, syncCall, windowFor, laneQueue, chat, refresh,
                        refreshFailed>>
         /\ failedBy' = IF analysis = "loading" /\ AnalysisPassesSignal
                        THEN [failedBy EXCEPT !["analysis"] = "own"] ELSE failedBy
         /\ stale' = StaleAfterCancel
         /\ analysis' = "none"

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
                   orphanServed, contextStale, scheduled, callVars, network, flips, discVars>>

\* The 410 fix: main retries a network refusal once the network is back. A
\* retry that fires offline is rescheduled into the same state, so the model
\* leaves it out; a fix must keep retrying, which the rule's second half
\* checks. The re-apply waits for the window lane like any intervals.icu
\* change, so the model runs it only when the lane is free.
RetryFires ==
    /\ retry = "scheduled" /\ slot = "failed-network" /\ network = "up"
    /\ lane = "free" /\ disc = "idle"
    /\ ApplyStoredSignIn
    /\ UNCHANGED <<connVars, syncVars, lane, laneQueue, windowFor, windowKey, served,
                   orphanServed, contextStale, scheduled, callVars, network, flips, discVars>>

\* Settings / Setup "Retry saved keys": onboarding-ipc.ts -> vault.retryFailed().
AthleteRetriesSavedKeys ==
    /\ slot \in {"failed-network", "failed"}
    /\ lane = "free" /\ disc \in {"idle", "revoked", "removed-unrevoked", "diverged"}
    /\ ApplyStoredSignIn
    /\ UNCHANGED <<connVars, syncVars, lane, laneQueue, windowFor, windowKey, served,
                   orphanServed, contextStale, scheduled, callVars, network, flips, discVars>>

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
    /\ syncCall = "none" /\ answer = "none" /\ win # "running" /\ refresh = "none"
    /\ presses' = presses - 1
    /\ syncCall' = "waiting"
    /\ win' = "running"
    /\ rereadDue' = FALSE
    /\ laneQueue' = Append(laneQueue, "call")
    /\ conn' = "open"
    /\ reopened' = (reopened \/ conn = "lost")
    /\ UNCHANGED <<lostBy, failedBy, answer, refresh, refreshFailed, lane, windowFor,
                   windowKey, served, orphanServed, contextStale, scheduled, coachKey,
                   callVars, signInVars, discVars>>

\* The 413 fix: once a new connection is open, the coordinator asks the coach
\* again for an interrupted sync, as Try again does, or refreshes Training if
\* its last refresh failed.
WindowRereadsSyncState ==
    /\ rereadDue /\ conn = "open" /\ syncCall = "none" /\ answer = "none"
    /\ refresh = "none"
    /\ rereadDue' = FALSE
    /\ IF win = "interrupted"
       THEN /\ syncCall' = "waiting"
            /\ win' = "running"
            /\ laneQueue' = Append(laneQueue, "call")
            /\ UNCHANGED refresh
       ELSE /\ refresh' = IF refreshFailed THEN "pending" ELSE "none"
            /\ UNCHANGED <<syncCall, win, laneQueue>>
    /\ UNCHANGED <<connVars, answer, presses, refreshFailed, lane, windowFor, windowKey,
                   served, orphanServed, contextStale, scheduled, coachKey, callVars,
                   signInVars, discVars>>

\* training-sync.ts begin() catch: a rejected, admitted sync with an
\* indeterminate error (disconnected, aborted, timed out) publishes
\* failed/indeterminate: "Connection interrupted. ... won't retry it
\* automatically." The coordinator sets needsReconnect and nothing else.
WindowSettlesRejectedSync ==
    /\ syncCall = "rejected"
    /\ syncCall' = "none"
    /\ win' = "interrupted"
    /\ UNCHANGED <<connVars, answer, rereadDue, presses, refresh, refreshFailed, coachVars,
                   callVars, signInVars, discVars>>

\* training-sync.ts begin() after a terminal reply runs refreshTrainingContext:
\* boot.ts calls rideAnalysisController.invalidate(), which aborts a loading
\* analysis and reloads an open one (controller.ts invalidate), then starts
\* the Training and Plan refresh. Those calls use getClient(), which opens a
\* fresh connection when the old one is gone.
WindowStartsRefresh ==
    /\ answer # "none" /\ refresh = "none"
    /\ LET latching == Latching
           reload == analysis \in {"loading", "shown"}
       IN /\ conn' = "open"
          /\ reopened' = (reopened \/ conn = "lost" \/ latching)
          /\ lostBy' = IF latching THEN "analysis-abort" ELSE lostBy
          /\ failedBy' = IF latching
                         THEN [c \in Calls |-> IF Pending(c) THEN Classify(c, "analysis-abort")
                                                ELSE failedBy[c]]
                         ELSE IF analysis = "loading" /\ AnalysisPassesSignal
                              THEN [failedBy EXCEPT !["analysis"] = "own"]
                              ELSE failedBy
          /\ syncCall' = IF latching /\ syncCall = "waiting" THEN "rejected" ELSE syncCall
          /\ windowFor' = IF latching /\ windowFor = "call" THEN "orphan" ELSE windowFor
          /\ laneQueue' = IF latching
                          THEN [i \in 1..Len(laneQueue) |->
                                  IF laneQueue[i] = "call" THEN "orphan" ELSE laneQueue[i]]
                          ELSE laneQueue
          /\ chat' = IF latching /\ chat = "streaming" THEN "cut" ELSE chat
          /\ stale' = IF latching THEN "none" ELSE StaleAfterCancel
          /\ analysis' = IF reload THEN "loading" ELSE "none"
    /\ refresh' = "pending"
    /\ UNCHANGED <<answer, win, rereadDue, presses, refreshFailed, lane, windowKey, served,
                   orphanServed, contextStale, scheduled, coachKey, loads, drops,
                   signInVars, discVars>>

\* training-context/controller.ts refresh() and the Plan refresh answer.
TrainingRefreshLands ==
    /\ refresh = "pending" /\ conn = "open"
    /\ refresh' = IF answer = "none" THEN "none" ELSE "done"
    /\ refreshFailed' = FALSE
    /\ contextStale' = FALSE
    /\ UNCHANGED <<connVars, syncCall, answer, win, rereadDue, presses, lane, laneQueue,
                   windowFor, windowKey, served, orphanServed, scheduled, coachKey,
                   callVars, signInVars, discVars>>

\* training-sync.ts begin(): refreshTrainingContext swallows its errors, then
\* the coordinator publishes the sync result.
WindowPublishesSyncResult ==
    /\ answer # "none" /\ refresh \in {"done", "failed"}
    /\ win' = answer
    /\ answer' = "none"
    /\ refresh' = "none"
    /\ UNCHANGED <<connVars, syncCall, rereadDue, presses, refreshFailed, coachVars,
                   callVars, signInVars, discVars>>

\* A later window call after a loss opens a fresh connection
\* (coach-client.ts getClient -> connectFresh). intervals-sign-in-health.ts
\* follow() makes one after every sync result and on focus, so this happens
\* with no athlete action. The coordinator's catch runs on a microtask, before
\* an IPC round trip can open the connection, so a rejected sync has always
\* settled first.
ProviderReconnects ==
    /\ conn = "lost" /\ syncCall # "rejected"
    /\ conn' = "open"
    /\ reopened' = TRUE
    /\ rereadDue' = (RereadOnOpen /\ (win = "interrupted" \/ refreshFailed))
    /\ UNCHANGED <<lostBy, failedBy, syncCall, answer, win, presses, refresh,
                   refreshFailed, coachVars, callVars, signInVars, discVars>>

-----------------------------------------------------------------------------
(* The coach's window lane *)

\* store-runtime.ts scheduler -> runScheduledWindow() -> runWindow(), or the
\* initial refresh. It starts only with a key (composition.ts).
SchedulerStartsWindow ==
    /\ scheduled > 0 /\ coachKey
    /\ scheduled' = scheduled - 1
    /\ laneQueue' = Append(laneQueue, "scheduler")
    /\ UNCHANGED <<connVars, syncVars, lane, windowFor, windowKey, served, orphanServed,
                   contextStale, coachKey, callVars, signInVars, discVars>>

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
    /\ UNCHANGED <<connVars, syncVars, served, orphanServed, contextStale, scheduled,
                   coachKey, callVars, signInVars, deadline>>

\* operations.ts sync: backfill (skipped when the key is empty, giving
\* "skipped-no-credential"), runWindowInternal, then the RPC reply. The reply
\* reaches the window only if its call is still on an open connection.
CoachFinishesWindow ==
    /\ lane = "window"
    /\ LET result == IF windowKey THEN "fetched" ELSE "skipped" IN
       /\ served' = IF windowFor \in {"call", "orphan"} THEN Shown(result) ELSE served
       /\ orphanServed' = (orphanServed \/ windowFor = "orphan")
       /\ contextStale' = IF windowFor \in {"call", "orphan"} /\ result = "fetched"
                          THEN TRUE ELSE contextStale
       /\ syncCall' = IF windowFor = "call" THEN "none" ELSE syncCall
       /\ answer' = IF windowFor = "call" THEN Shown(result) ELSE answer
    /\ lane' = "free"
    /\ windowFor' = "none"
    /\ windowKey' = FALSE
    /\ UNCHANGED <<connVars, win, rereadDue, presses, refresh, refreshFailed, laneQueue,
                   scheduled, coachKey, callVars, signInVars, discVars>>

\* The 412 fix: a waiting credential clear cancels the window that holds the
\* lane; the window's call gets a remote error.
CoachCancelsWindowForClear ==
    /\ ClearCancelsWindow /\ lane = "window"
    /\ \E i \in 1..Len(laneQueue) : laneQueue[i] = "clear"
    /\ served' = IF windowFor \in {"call", "orphan"} THEN Shown("cancelled") ELSE served
    /\ orphanServed' = (orphanServed \/ windowFor = "orphan")
    /\ syncCall' = IF windowFor = "call" THEN "none" ELSE syncCall
    /\ answer' = IF windowFor = "call" THEN Shown("cancelled") ELSE answer
    /\ lane' = "free"
    /\ windowFor' = "none"
    /\ windowKey' = FALSE
    /\ UNCHANGED <<connVars, win, rereadDue, presses, refresh, refreshFailed, laneQueue,
                   contextStale, scheduled, coachKey, callVars, signInVars, discVars>>

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
    /\ UNCHANGED <<connVars, syncVars, lane, windowFor, windowKey, served, orphanServed,
                   contextStale, scheduled, coachKey, callVars, signInVars, deadline>>

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
                   orphanServed, contextStale, scheduled, callVars, signInVars, deadline>>

\* operations.ts configureRuntime: AbortSignal.timeout(25 s). The waiter in
\* lane.waiting has no abort path, so the deadline only marks the request.
\* It can pass only while a window that will not be cancelled holds the lane;
\* a cancel for a clear is assumed to land well inside 25 s.
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
\* beforeRemove revokes the token on intervals.icu (onboarding-ipc.ts
\* revokeIntervalsAccess, which needs the network), then
\* removeStoredCredential. Offline the window says plainly that the token was
\* removed here but not revoked (credential-delete-copy.ts revokeFailed). An
\* error answer lands in the same catch as a timeout.
MainFinishesDisconnect ==
    /\ disc \in {"answered-applied", "answered-error"}
    /\ IF disc = "answered-applied"
       THEN /\ disc' = IF network = "up" THEN "revoked" ELSE "removed-unrevoked"
            /\ slot' = "missing"
            /\ retry' = "none"
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

\* Another ride, the analysis refresh, or a ride import's invalidate(): the
\* open analysis goes away, and a loading one is cancelled.
AthleteChangesRide ==
    /\ analysis \in {"loading", "shown"}
    /\ CancelAnalysis
    /\ UNCHANGED <<reopened, answer, win, rereadDue, presses, lane, served, orphanServed,
                   windowKey, contextStale, scheduled, coachKey, loads, drops,
                   signInVars, discVars>>

CoachAnswersAnalysis ==
    /\ analysis = "loading" /\ conn = "open"
    /\ analysis' = "shown"
    /\ UNCHANGED <<connVars, syncVars, coachVars, stale, loads, chat, drops,
                   signInVars, discVars>>

\* The coach answers a superseded analysis. load() drops it by generation;
\* a call the client already rejected has an unknown id and latches a
\* protocol fault (client.ts handleTerminal -> failProtocol).
CoachAnswersStaleAnalysis ==
    /\ stale # "none" /\ conn = "open"
    /\ IF stale = "aborted"
       THEN Latch("analysis-late-reply")
       ELSE /\ stale' = "none"
            /\ UNCHANGED <<conn, lostBy, failedBy, syncCall, windowFor, laneQueue, analysis,
                           chat, refresh, refreshFailed>>
    /\ UNCHANGED <<reopened, answer, win, rereadDue, presses, lane, served, orphanServed,
                   windowKey, contextStale, scheduled, coachKey, loads, drops,
                   signInVars, discVars>>

\* call-timeouts.ts getActivityAnalysis: 120 s -> client.ts timer.
AnalysisTimesOut ==
    /\ analysis = "loading"
    /\ IF TimeoutLatches
       THEN Latch("analysis-timeout")
       ELSE /\ analysis' = "none"
            /\ failedBy' = [failedBy EXCEPT !["analysis"] = "own"]
            /\ UNCHANGED <<conn, lostBy, syncCall, windowFor, laneQueue, stale, chat,
                           refresh, refreshFailed>>
    /\ UNCHANGED <<reopened, answer, win, rereadDue, presses, lane, served, orphanServed,
                   windowKey, contextStale, scheduled, coachKey, loads, drops,
                   signInVars, discVars>>

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
            /\ UNCHANGED <<conn, lostBy, syncCall, windowFor, laneQueue, analysis, stale,
                           refresh, refreshFailed>>
    /\ UNCHANGED <<reopened, answer, win, rereadDue, presses, lane, served, orphanServed,
                   windowKey, contextStale, scheduled, coachKey, loads, signInVars, discVars>>

\* client.ts onSocketClose / onSocketError: the socket goes away, as when a
\* coach the app did not start drops. A connection-level loss.
SocketCloses ==
    /\ conn = "open" /\ drops > 0
    /\ drops' = drops - 1
    /\ Latch("socket")
    /\ UNCHANGED <<reopened, answer, win, rereadDue, presses, lane, served, orphanServed,
                   windowKey, contextStale, scheduled, coachKey, loads, signInVars, discVars>>

-----------------------------------------------------------------------------

\* Steps that happen with no athlete click and no outside event.
Automatic ==
    \/ LaunchReappliesSignIn \/ RetryFires
    \/ LaneGrants \/ CoachFinishesWindow \/ CoachCancelsWindowForClear
    \/ CoachAppliesClear \/ CoachDeadlinePasses \/ MainClientTimesOut
    \/ MainFinishesDisconnect
    \/ CoachAnswersAnalysis \/ CoachAnswersStaleAnalysis \/ AnalysisTimesOut
    \/ ChatReplyEnds
    \/ WindowSettlesRejectedSync \/ WindowStartsRefresh \/ TrainingRefreshLands
    \/ WindowPublishesSyncResult \/ WindowRereadsSyncState \/ ProviderReconnects

\* Steps the athlete or the outside world takes.
Outside ==
    \/ AthletePressesSync \/ AthleteOpensAnalysis \/ AthleteChangesRide
    \/ AthleteSendsChat \/ AthleteDisconnects \/ AthleteRetriesSavedKeys
    \/ SocketCloses \/ ChatDetectsProtocolFault
    \/ SchedulerStartsWindow \/ NetworkChanges

\* Nothing is left to do. Keeps TLC's deadlock check quiet for /statechart.
AllSettled ==
    /\ ~ENABLED (Automatic \/ Outside)
    /\ UNCHANGED vars

Init ==
    /\ conn = "open" /\ lostBy = "none" /\ reopened = FALSE
    /\ failedBy = [c \in Calls |-> "none"]
    /\ syncCall = "none" /\ answer = "none" /\ win = "idle" /\ rereadDue = FALSE
    /\ presses = MaxPresses /\ refresh = "none" /\ refreshFailed = FALSE
    /\ lane = "free" /\ laneQueue = <<>> /\ windowFor = "none" /\ windowKey = FALSE
    /\ served = "none" /\ orphanServed = FALSE /\ contextStale = FALSE
    /\ scheduled = MaxScheduled /\ coachKey = FALSE
    /\ analysis = "none" /\ stale = "none" /\ loads = MaxLoads /\ chat = "none"
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

\* 413: once nothing is left to run by itself, the sidebar shows what the
\* coach's last sync for the window found, and Training is not older than it.
\* (A lost connection reconnects by itself, so this covers every reconnect.)
WindowCatchesUpAfterReconnect ==
    (Quiescent /\ conn = "open" /\ served # "none")
        => (win = served /\ ~contextStale)

\* 410: a stored sign-in refused for a network reason has a retry scheduled,
\* and once nothing is left to run with the network up, it is not still refused.
NetworkRefusalIsRetried ==
    /\ slot = "failed-network" => retry = "scheduled"
    /\ (Quiescent /\ network = "up") => slot # "failed-network"

\* 410: while a sign-in is saved, a sync that fetched nothing from
\* intervals.icu is never shown as a success. With no saved sign-in, local
\* processing is reported as such (issue 410's fix line).
EmptySyncNeverShownAsSuccess ==
    win = "local-only" => ~SavedSignIn

\* 412: Disconnect ends with the sign-in removed (revoked, or a plain message
\* that it could not be revoked offline) or a clear refusal, inside its
\* deadline: never "could not be reconciled" with the token kept.
DisconnectRevokesOrRefusesClearly ==
    /\ disc # "diverged"
    /\ disc \in {"revoked", "removed-unrevoked"} => (~coachKey /\ slot = "missing")

(* Witnesses. TLC must find each of these false, or the rule above it is   *)
(* about a state the model never reaches.                                   *)

WitnessOtherCallsPendingDuringAnalysis ==
    ~(analysis = "loading" /\ chat = "streaming" /\ syncCall = "waiting")

WitnessQuiescentAfterOrphanedSync ==
    ~(Quiescent /\ conn = "open" /\ orphanServed)

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
    /\ refresh \in {"none", "pending", "done", "failed"}
    /\ win \in {"idle", "running", "synced", "local-only", "not-in-use", "failed", "interrupted"}
    /\ lane \in {"free", "window", "clear"}
    /\ \A i \in 1..Len(laneQueue) : laneQueue[i] \in {"call", "orphan", "scheduler", "clear"}
    /\ analysis \in {"none", "loading", "shown"}
    /\ stale \in {"none", "ignored", "aborted"}
    /\ slot \in {"stored", "active", "failed-network", "failed", "missing"}
    /\ disc \in {"idle", "waiting", "applying", "answered-applied", "answered-error",
                 "revoked", "removed-unrevoked", "diverged"}
=============================================================================
