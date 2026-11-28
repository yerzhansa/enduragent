--------------------------- MODULE SetupOperations ---------------------------
(***************************************************************************)
(* Setup's operations in the Enduragent desktop app and the one credential  *)
(* mutation lock they share with the coach restart and Telegram.           *)
(*                                                                         *)
(* Each action names the code it stands for. The coverage record, the      *)
(* sync commit and the bounds are in ../SKILL.md.                          *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    MaxPage,          \* how many pages the window may load in one run
    MaxAthleteSteps,  \* how many clicks the athlete may make in one run
    Events            \* which environment events and athlete actions are on

KeyProviders == {"anthropic", "openrouter"}
ChatGpt == "openai-codex"
IntervalsSlot == "intervals-icu"
NoOne == "none"

\* One entry of the credential mutation lock (credential-envelope-lock.ts,
\* createCredentialMutationLock). `page` is a ghost: the page that asked.
Entry(op, arg, pg) == [op |-> op, arg |-> arg, page |-> pg]
NoEntry == Entry(NoOne, NoOne, 0)
Idle == [phase |-> "idle", page |-> 0]
LoginIdle == [phase |-> "idle", page |-> 0, aborted |-> FALSE]

VARIABLES
    lockHolder,     \* the entry that holds the lock, or NoEntry
    lockQueue,      \* entries waiting for the lock, in order
    login,          \* chatgpt-auth.ts activeLogin: idle | queued | awaiting-browser | storing, and whether it was aborted
    signIn,         \* intervals-ipc.ts activeSignIn: idle | awaiting-browser | storing
    openRouter,     \* openrouter auth session in main: idle | awaiting-browser | storing
    coach,          \* daemon-lifecycle.ts state and restart step, the coach's active provider, and why a restart was lost
    stored,         \* credentials on disk
    page,           \* the window's page: its generation and whether it is alive
    onboardingIpc,  \* onboarding-ipc.ts handlers for this window: registered | disposed
    pendingCancel,  \* cancels that pagehide sent and main has not handled yet
    setup,          \* onboarding/controller.ts state for the live page
    settings,       \* the Settings page's credential and coach operations
    telegramRow,    \* TelegramRow.tsx: idle | connecting
    steps           \* clicks so far

mainVars == <<lockHolder, lockQueue, login, signIn, openRouter, coach, stored>>
windowVars == <<page, onboardingIpc, pendingCancel>>
rendererVars == <<setup, settings, telegramRow>>
vars == <<mainVars, windowVars, rendererVars, steps>>

On(event) == event \in Events

FreshSetup(active) ==
    [busy |-> FALSE, active |-> active, loading |-> FALSE, unavailable |-> FALSE,
     required |-> FALSE, chatgpt |-> "idle", intervals |-> "idle",
     keySave |-> NoOne, openRouter |-> "idle", loadedActive |-> active]

FreshSettings == [op |-> "idle", arg |-> NoOne, repair |-> FALSE]

-----------------------------------------------------------------------------
(* Derived values *)

CoachReady == coach.status = "ready"

\* selectedProviderReady(state, active, active) on fresh credential statuses.
ReadyFor(p) == CoachReady /\ p # NoOne /\ p \in stored /\ coach.active = p

CoachWorks == ReadyFor(coach.active)

\* A reply reaches the page that asked only while that page is alive.
Owns(pg) == page.alive /\ page.id = pg

InLock(op) ==
    \/ lockHolder.op = op
    \/ \E i \in 1..Len(lockQueue) : lockQueue[i].op = op

Without(op) == SelectSeq(lockQueue, LAMBDA e : e.op # op)

\* The holder waits for the athlete in a browser tab, up to 5 minutes
\* (packages/core/src/agent/codex/oauth.ts authorization timeout).
WaitsForPerson(e) == e.op = "chatgpt-login" /\ login.phase = "awaiting-browser"

\* The holder waits on intervals.icu, longer than the 5 s readiness limit: the
\* owner check allows 20 s (packages/coach/src/account-identity.ts), and a
\* Disconnect's revoke allows 10 s (intervals-sign-in-ports.ts), both inside the lock.
WaitsForIntervals(e) ==
    /\ On("slow-intervals")
    /\ \/ e.op = "intervals-store"
       \/ e.op = "reapply" /\ IntervalsSlot \in stored
       \/ e.op = "key-delete" /\ e.arg = IntervalsSlot

\* Setup's mutation guards: setupStatusBlocksMutations(), setupOperationRunning()
\* (setup-operation.ts: busy, a ChatGPT sign-in or activation, the OpenRouter or
\* Intervals.icu sign-in, a ride import) and credentialMutationsBlocked(), which is
\* credentialChangesBlocked: a non-Telegram Settings mutation or a repair credential.
\* Its open delete confirmation and ride imports are not modeled.
SetupMayMutate ==
    /\ page.alive
    /\ ~setup.loading
    /\ ~setup.unavailable
    /\ ~setup.busy
    /\ setup.keySave = NoOne
    /\ setup.chatgpt = "idle"
    /\ setup.intervals = "idle"
    /\ setup.openRouter = "idle"
    /\ settings.op = "idle"
    /\ ~settings.repair

\* AiRow.tsx shows one panel at a time. Its Change menu is disabled while ChatGPT
\* activates or OpenRouter signs in, and leaving the OpenRouter panel dismisses
\* that sign-in, so the AI row runs one operation at a time.
AiRowIdle ==
    /\ setup.chatgpt = "idle"
    /\ setup.openRouter = "idle"
    /\ setup.keySave = NoOne

\* controller.ts onboardingCredentialMutationActive, which gates Settings deletes.
OnboardingCredentialMutationActive ==
    \/ setup.loading
    \/ setup.unavailable
    \/ setup.busy
    \/ setup.keySave # NoOne
    \/ setup.chatgpt \in {"signing-in", "activating"}
    \/ setup.intervals # "idle"
    \/ setup.openRouter # "idle"

\* The Setup operations the live page has in flight.
InFlight ==
    IF ~page.alive THEN {}
    ELSE (IF setup.keySave # NoOne THEN {"key-save"} ELSE {})
         \cup (IF setup.chatgpt = "signing-in" THEN {"chatgpt-sign-in"} ELSE {})
         \cup (IF setup.chatgpt = "activating" THEN {"chatgpt-activation"} ELSE {})
         \cup (IF setup.intervals # "idle" THEN {"intervals-sign-in"} ELSE {})
         \cup (IF setup.openRouter # "idle" THEN {"openrouter-sign-in"} ELSE {})

\* state/onboarding-slice.ts setupDisposition = "required": the full Setup gate.
GateShown == page.alive /\ (setup.required \/ settings.repair)

\* Nothing is loading, saving or waiting, so Setup has heard every change.
Quiet ==
    /\ page.alive
    /\ CoachReady
    /\ ~setup.loading
    /\ ~setup.unavailable
    /\ settings.op = "idle"
    /\ InFlight = {}
    /\ lockHolder = NoEntry
    /\ lockQueue = <<>>

\* Work that finishes on its own in well under 5 s is done, or it is stuck
\* behind a wait for the person or for intervals.icu.
BoundedWorkDone ==
    /\ pendingCancel = {}
    /\ \/ lockHolder = NoEntry /\ lockQueue = <<>>
       \/ WaitsForPerson(lockHolder)
       \/ WaitsForIntervals(lockHolder)

Athlete == steps < MaxAthleteSteps /\ steps' = steps + 1

-----------------------------------------------------------------------------
(* Start: the athlete finished Setup earlier and coaches on Anthropic. *)

Init ==
    /\ lockHolder = NoEntry
    /\ lockQueue = <<>>
    /\ login = LoginIdle
    /\ signIn = Idle
    /\ openRouter = Idle
    /\ coach = [status |-> "ready", restart |-> "none", active |-> "anthropic", lost |-> NoOne,
                 exited |-> FALSE]
    /\ stored \in {{"anthropic", "openrouter"}, {"anthropic", "openrouter", IntervalsSlot}}
    /\ page = [id |-> 1, alive |-> TRUE]
    /\ onboardingIpc = "registered"
    /\ pendingCancel = {}
    /\ setup = FreshSetup("anthropic")
    /\ settings = FreshSettings
    /\ telegramRow = "idle"
    /\ steps = 0

-----------------------------------------------------------------------------
(* The lock *)

\* createCredentialMutationLock: the next queued operation starts.
\* For a ChatGPT login that is its store step. A login aborted while its store
\* waits gets "cancelled" from throwIfAborted at once and frees the lock.
LockGoesToNext ==
    /\ lockHolder = NoEntry
    /\ lockQueue # <<>>
    /\ lockQueue' = Tail(lockQueue)
    /\ IF Head(lockQueue).op = "chatgpt-login" /\ login.aborted
       THEN /\ lockHolder' = NoEntry
            /\ login' = LoginIdle
            /\ setup' = IF Owns(login.page) /\ setup.chatgpt = "signing-in"
                        THEN [setup EXCEPT !.chatgpt = "idle", !.busy = FALSE]
                        ELSE setup
       ELSE /\ lockHolder' = Head(lockQueue)
            /\ UNCHANGED <<login, setup>>
    /\ UNCHANGED <<signIn, openRouter, coach, stored, windowVars, settings, telegramRow, steps>>

-----------------------------------------------------------------------------
(* ChatGPT sign-in: controller.ts startChatGptLogin, chatgpt-auth.ts login *)

\* login() refuses while activeLogin is set, else runs performLogin, whose runLogin
\* opens the browser without the lock.
AthleteStartsChatGptSignIn ==
    /\ Athlete
    /\ SetupMayMutate
    /\ AiRowIdle
    /\ ChatGpt \notin stored
    /\ IF login.phase = "idle"
       THEN /\ login' = [phase |-> "awaiting-browser", page |-> page.id, aborted |-> FALSE]
            /\ setup' = [setup EXCEPT !.chatgpt = "signing-in", !.busy = TRUE]
       ELSE UNCHANGED <<login, setup>>
    /\ UNCHANGED <<lockHolder, lockQueue, signIn, openRouter, coach, stored, windowVars, settings, telegramRow>>

\* Cancel sign-in (cancelLogin aborts the controller) or the 5-minute limit.
ChatGptBrowserWaitEnds ==
    /\ login.phase = "awaiting-browser"
    /\ login' = LoginIdle
    /\ setup' = IF Owns(login.page) /\ setup.chatgpt = "signing-in"
                THEN [setup EXCEPT !.chatgpt = "idle", !.busy = FALSE]
                ELSE setup
    /\ UNCHANGED <<lockHolder, lockQueue, signIn, openRouter, coach, stored, windowVars, settings, telegramRow, steps>>

\* Cancel sign-in while the login's store step still waits for the lock: cancelLogin only aborts.
\* activeLogin and Setup's busy stay until the lock reaches the login.
AthleteCancelsQueuedChatGptSignIn ==
    /\ login.phase = "storing"
    /\ lockHolder.op # "chatgpt-login"
    /\ ~login.aborted
    /\ Owns(login.page) /\ setup.chatgpt = "signing-in"
    /\ login' = [login EXCEPT !.aborted = TRUE]
    /\ UNCHANGED <<lockHolder, lockQueue, signIn, openRouter, coach, stored, windowVars, rendererVars, steps>>

\* performLogin then queues signal.throwIfAborted() and storeProfile in
\* serializeCredentialMutation.
PersonFinishesChatGptInBrowser ==
    /\ login.phase = "awaiting-browser"
    /\ login' = [login EXCEPT !.phase = "storing"]
    /\ lockQueue' = Append(lockQueue, Entry("chatgpt-login", ChatGpt, login.page))
    /\ UNCHANGED <<lockHolder, signIn, openRouter, coach, stored, windowVars, rendererVars, steps>>

\* storeProfile, then the lock frees. The page that asked takes the result
\* (withChatGptLoginResult) and, after the next paint, beginChatGptActivation
\* sends applyLlmSelection with busy false (withChatGptActivationPending).
ChatGptSignInIsStored ==
    /\ login.phase = "storing"
    /\ lockHolder.op = "chatgpt-login"
    /\ stored' = stored \cup {ChatGpt}
    /\ login' = LoginIdle
    /\ lockHolder' = NoEntry
    /\ IF Owns(login.page) /\ setup.chatgpt = "signing-in"
       THEN IF ~setup.loading /\ ~setup.unavailable /\ settings.op = "idle"
            THEN /\ setup' = [setup EXCEPT !.chatgpt = "activating", !.busy = FALSE]
                 /\ lockQueue' = Append(lockQueue, Entry("chatgpt-activate", ChatGpt, page.id))
            ELSE /\ setup' = [setup EXCEPT !.chatgpt = "idle", !.busy = FALSE]
                 /\ UNCHANGED lockQueue
       ELSE UNCHANGED <<setup, lockQueue>>
    /\ UNCHANGED <<signIn, openRouter, coach, windowVars, settings, telegramRow, steps>>

\* chatGptAuth.activate under the lock; withChatGptActivationResult sets busy
\* false; recordActiveSelection copies the provider into Setup.
ChatGptActivationFinishes ==
    /\ lockHolder.op = "chatgpt-activate"
    /\ lockHolder' = NoEntry
    /\ coach' = IF CoachReady /\ ChatGpt \in stored THEN [coach EXCEPT !.active = ChatGpt] ELSE coach
    /\ setup' = IF Owns(lockHolder.page) /\ setup.chatgpt = "activating"
                THEN [setup EXCEPT !.chatgpt = "idle", !.busy = FALSE,
                                   !.active = IF CoachReady THEN ChatGpt ELSE @]
                ELSE setup
    /\ UNCHANGED <<lockQueue, login, signIn, openRouter, stored, windowVars, settings, telegramRow, steps>>

-----------------------------------------------------------------------------
(* Key save in Setup: controller.ts saveModelKey, vault.writeCredential *)

AthleteSavesKeyInSetup(p) ==
    /\ Athlete
    /\ SetupMayMutate
    /\ AiRowIdle
    /\ setup' = [setup EXCEPT !.busy = TRUE, !.keySave = p]
    /\ lockQueue' = Append(lockQueue, Entry("key-write", p, page.id))
    /\ UNCHANGED <<lockHolder, login, signIn, openRouter, coach, stored, windowVars, settings, telegramRow>>

SetupKeyWriteFinishes ==
    /\ lockHolder.op = "key-write"
    /\ LET p == lockHolder.arg IN
       /\ stored' = stored \cup {p}
       /\ coach' = IF CoachReady THEN [coach EXCEPT !.active = p] ELSE coach
       /\ setup' = IF Owns(lockHolder.page) /\ setup.keySave = p
                   THEN [setup EXCEPT !.busy = FALSE, !.keySave = NoOne,
                                      !.active = IF CoachReady THEN p ELSE @]
                   ELSE setup
    /\ lockHolder' = NoEntry
    /\ UNCHANGED <<lockQueue, login, signIn, openRouter, windowVars, settings, telegramRow, steps>>

-----------------------------------------------------------------------------
(* Intervals.icu sign-in: controller.ts connectTrainingData, intervals-ipc.ts signIn *)

\* Main allows one session and throws for a second; the renderer's catch sets
\* the phase idle and busy false ("check your connection", no Cancel).
AthleteStartsIntervalsSignIn ==
    /\ Athlete
    /\ SetupMayMutate
    /\ IF signIn.phase = "idle"
       THEN /\ signIn' = [phase |-> "awaiting-browser", page |-> page.id]
            /\ setup' = [setup EXCEPT !.intervals = "waiting", !.busy = TRUE]
       ELSE /\ UNCHANGED signIn
            /\ setup' = [setup EXCEPT !.intervals = "idle", !.busy = FALSE]
    /\ UNCHANGED <<lockHolder, lockQueue, login, openRouter, coach, stored, windowVars, settings, telegramRow>>

\* After approval the token exchange runs, then runCapturedCredential takes
\* the lock through vault.runExclusiveMutation and verifies the key.
PersonApprovesIntervalsInBrowser ==
    /\ signIn.phase = "awaiting-browser"
    /\ signIn' = [signIn EXCEPT !.phase = "storing"]
    /\ lockQueue' = Append(lockQueue, Entry("intervals-store", IntervalsSlot, signIn.page))
    /\ UNCHANGED <<lockHolder, login, openRouter, coach, stored, windowVars, rendererVars, steps>>

\* Cancel sign-in or the 5-minute limit. The renderer's result handler sets
\* the phase idle and busy false without checking who owns busy.
IntervalsBrowserWaitEnds ==
    /\ signIn.phase = "awaiting-browser"
    /\ signIn' = Idle
    /\ setup' = IF Owns(signIn.page) THEN [setup EXCEPT !.intervals = "idle", !.busy = FALSE] ELSE setup
    /\ UNCHANGED <<lockHolder, lockQueue, login, openRouter, coach, stored, windowVars, settings, telegramRow, steps>>

IntervalsSignInIsStored ==
    /\ lockHolder.op = "intervals-store"
    /\ stored' = stored \cup {IntervalsSlot}
    /\ signIn' = Idle
    /\ lockHolder' = NoEntry
    /\ setup' = IF Owns(lockHolder.page) THEN [setup EXCEPT !.intervals = "idle", !.busy = FALSE] ELSE setup
    /\ UNCHANGED <<lockQueue, login, openRouter, coach, windowVars, settings, telegramRow, steps>>

-----------------------------------------------------------------------------
(* OpenRouter sign-in: openrouter-sign-in.ts, openrouter-ipc.ts. It runs
   outside state.busy; canMutate checks only Setup's guards. *)

AthleteStartsOpenRouterSignIn ==
    /\ On("openrouter")
    /\ Athlete
    /\ SetupMayMutate
    /\ AiRowIdle
    /\ openRouter.phase = "idle"
    /\ openRouter' = [phase |-> "awaiting-browser", page |-> page.id]
    /\ setup' = [setup EXCEPT !.openRouter = "signing-in"]
    /\ UNCHANGED <<lockHolder, lockQueue, login, signIn, coach, stored, windowVars, settings, telegramRow>>

PersonApprovesOpenRouterInBrowser ==
    /\ openRouter.phase = "awaiting-browser"
    /\ openRouter' = [openRouter EXCEPT !.phase = "storing"]
    /\ lockQueue' = Append(lockQueue, Entry("openrouter-write", "openrouter", openRouter.page))
    /\ UNCHANGED <<lockHolder, login, signIn, coach, stored, windowVars, rendererVars, steps>>

OpenRouterBrowserWaitEnds ==
    /\ openRouter.phase = "awaiting-browser"
    /\ openRouter' = Idle
    /\ setup' = IF Owns(openRouter.page) THEN [setup EXCEPT !.openRouter = "idle"] ELSE setup
    /\ UNCHANGED <<lockHolder, lockQueue, login, signIn, coach, stored, windowVars, settings, telegramRow, steps>>

\* The key is written under the lock; sync() copies the selection into Setup.
OpenRouterSignInIsStored ==
    /\ lockHolder.op = "openrouter-write"
    /\ stored' = stored \cup {"openrouter"}
    /\ coach' = IF CoachReady THEN [coach EXCEPT !.active = "openrouter"] ELSE coach
    /\ openRouter' = Idle
    /\ lockHolder' = NoEntry
    /\ setup' = IF Owns(lockHolder.page) /\ setup.openRouter # "idle"
                THEN [setup EXCEPT !.openRouter = "idle",
                                   !.active = IF CoachReady THEN "openrouter" ELSE @]
                ELSE setup
    /\ UNCHANGED <<lockQueue, login, signIn, windowVars, settings, telegramRow, steps>>

-----------------------------------------------------------------------------
(* Settings: Coach provider save and key delete *)

\* provider-model-controller.ts commit -> vault.applyLlmSelection. CoachSection's
\* controlsDisabled also holds while onboardingCredentialMutationActive.
AthleteSavesCoachInSettings(p) ==
    /\ On("coach-save")
    /\ Athlete
    /\ page.alive
    /\ settings.op = "idle"
    /\ telegramRow = "idle"
    /\ ~OnboardingCredentialMutationActive
    /\ p \in stored \cap (KeyProviders \cup {ChatGpt})
    /\ p # coach.active
    /\ settings' = [settings EXCEPT !.op = "coach-save", !.arg = p]
    /\ lockQueue' = Append(lockQueue, Entry("coach-save", p, page.id))
    /\ UNCHANGED <<lockHolder, login, signIn, openRouter, coach, stored, windowVars, setup, telegramRow>>

\* boot.ts onSaved calls onboarding.refresh(false), which returns early while a
\* load runs. The load's configuration read happens at once, so it reads main's
\* coach as it is at this step.
CoachSaveFinishes ==
    /\ lockHolder.op = "coach-save"
    /\ LET next == IF CoachReady /\ lockHolder.arg \in stored
                    THEN [coach EXCEPT !.active = lockHolder.arg] ELSE coach
       IN /\ coach' = next
          /\ setup' = IF Owns(lockHolder.page) /\ ~setup.loading
                      THEN [setup EXCEPT !.loading = TRUE, !.loadedActive = next.active]
                      ELSE setup
    /\ settings' = IF Owns(lockHolder.page) THEN FreshSettings ELSE settings
    /\ lockHolder' = NoEntry
    /\ UNCHANGED <<lockQueue, login, signIn, openRouter, stored, windowVars, telegramRow, steps>>

\* credential-controller.ts delete, gated on onboardingCredentialMutationActive.
AthleteDeletesKeyInSettings(p) ==
    /\ Athlete
    /\ page.alive
    /\ settings.op = "idle"
    /\ telegramRow = "idle"
    /\ ~OnboardingCredentialMutationActive
    /\ p \in stored \cap (KeyProviders \cup {IntervalsSlot})
    /\ settings' = [settings EXCEPT !.op = "deleting", !.arg = p]
    /\ lockQueue' = Append(lockQueue, Entry("key-delete", p, page.id))
    /\ UNCHANGED <<lockHolder, login, signIn, openRouter, coach, stored, windowVars, setup, telegramRow>>

\* vault.deleteCredential, then onDeleted -> refreshOnboardingCredentials ->
\* onboarding.refresh() -> load(false, false): one read with a 3 s budget.
KeyIsDeleted ==
    /\ lockHolder.op = "key-delete"
    /\ stored' = stored \ {lockHolder.arg}
    /\ coach' = IF coach.active = lockHolder.arg THEN [coach EXCEPT !.active = NoOne] ELSE coach
    /\ lockHolder' = NoEntry
    /\ IF Owns(lockHolder.page) /\ settings.op = "deleting"
       THEN /\ settings' = [settings EXCEPT !.op = "refreshing-setup"]
            /\ setup' = [setup EXCEPT !.loading = TRUE,
                                       !.loadedActive = IF coach.active = lockHolder.arg
                                                        THEN NoOne ELSE coach.active]
       ELSE UNCHANGED <<settings, setup>>
    /\ UNCHANGED <<lockQueue, login, signIn, openRouter, windowVars, telegramRow, steps>>

\* load(): every successful read adopts main's configuration, including `active`
\* (the athlete's own draft is kept, which the model leaves out).
\* createOnboardingState rebuilds the wizard; busy follows the intervals phase.
SetupReadAnswers ==
    /\ setup.loading
    /\ CoachReady
    /\ setup' = [setup EXCEPT !.loading = FALSE, !.unavailable = FALSE,
                              !.busy = (setup.intervals # "idle"),
                              !.chatgpt = "idle", !.keySave = NoOne,
                              !.active = setup.loadedActive,
                              !.required = @ \/ ~ReadyFor(setup.loadedActive)]
    /\ settings' = IF settings.op = "refreshing-setup" THEN FreshSettings ELSE settings
    /\ UNCHANGED <<mainVars, windowVars, telegramRow, steps>>

\* finishUnavailableLoad. After a delete, refreshOnboardingCredentials throws;
\* the catch keeps the repair state it had (content.repairCredential), so
\* nothing calls requireCompletion().
SetupReadTimesOut ==
    /\ setup.loading
    /\ On("slow-coach") \/ ~CoachReady
    /\ IF settings.op = "refreshing-setup"
       THEN /\ setup' = [setup EXCEPT !.loading = FALSE, !.unavailable = TRUE]
            /\ settings' = [FreshSettings EXCEPT !.repair = settings.repair]
       ELSE /\ setup' = [setup EXCEPT !.loading = FALSE, !.unavailable = TRUE]
            /\ UNCHANGED settings
    /\ UNCHANGED <<mainVars, windowVars, telegramRow, steps>>

-----------------------------------------------------------------------------
(* Telegram: Use copied token. The row is not gated by Setup, but
   beginSettingsMutation lets only one Settings mutation run at a time. *)

AthletePastesTelegramToken ==
    /\ On("telegram")
    /\ Athlete
    /\ page.alive
    /\ telegramRow = "idle"
    /\ settings.op = "idle"
    /\ telegramRow' = "connecting"
    /\ lockQueue' = Append(lockQueue, Entry("telegram-configure", NoOne, page.id))
    /\ UNCHANGED <<lockHolder, login, signIn, openRouter, coach, stored, windowVars, setup, settings>>

TelegramConfigureFinishes ==
    /\ lockHolder.op = "telegram-configure"
    /\ lockHolder' = NoEntry
    /\ telegramRow' = IF Owns(lockHolder.page) THEN "idle" ELSE telegramRow
    /\ UNCHANGED <<lockQueue, login, signIn, openRouter, coach, stored, windowVars, setup, settings, steps>>

-----------------------------------------------------------------------------
(* Coach restart: daemon-lifecycle.ts recover, publishSuccessor *)

\* recoverCurrent closes the old process and waits out the restart backoff.
CoachProcessExits ==
    /\ On("coach-exit")
    /\ CoachReady
    /\ ~coach.exited
    /\ coach' = [coach EXCEPT !.status = "recovering", !.restart = "spawning", !.exited = TRUE]
    /\ UNCHANGED <<lockHolder, lockQueue, login, signIn, openRouter, stored, windowVars, rendererVars, steps>>

\* publishSuccessor starts the 5 s readiness timer and calls prepareReady, which
\* is reapplyCredentials: successorVault.reapplyConfigured() under the lock.
SuccessorStarts ==
    /\ coach.restart = "spawning"
    /\ coach' = [coach EXCEPT !.restart = "replaying"]
    /\ lockQueue' = Append(lockQueue, Entry("reapply", NoOne, 0))
    /\ UNCHANGED <<lockHolder, login, signIn, openRouter, stored, windowVars, rendererVars, steps>>

\* Then, for an app-supervised coach, successorTelegramCoordinator.reconcile()
\* takes the lock again through runMutation.
ReapplyFinishes ==
    /\ lockHolder.op = "reapply"
    /\ lockHolder' = NoEntry
    /\ lockQueue' = Append(lockQueue, Entry("telegram-reconcile", NoOne, 0))
    /\ UNCHANGED <<coach, login, signIn, openRouter, stored, windowVars, rendererVars, steps>>

ReconcileFinishes ==
    /\ lockHolder.op = "telegram-reconcile"
    /\ lockHolder' = NoEntry
    /\ coach' = IF coach.status = "recovering"
                THEN [coach EXCEPT !.status = "ready", !.restart = "none"]
                ELSE [coach EXCEPT !.restart = "none"]
    /\ UNCHANGED <<lockQueue, login, signIn, openRouter, stored, windowVars, rendererVars, steps>>

\* READINESS_TIMEOUT_MS: 5 s after publishSuccessor, then enterTerminal("unavailable").
\* Only a wait for the person or for intervals.icu outlasts it (see SKILL.md, Bounds).
ReadinessLimitPasses ==
    /\ coach.status = "recovering"
    /\ coach.restart = "replaying"
    /\ \/ /\ WaitsForPerson(lockHolder)
          /\ coach' = [coach EXCEPT !.status = "terminal", !.lost = "behind-a-person"]
       \/ /\ WaitsForIntervals(lockHolder)
          /\ coach' = [coach EXCEPT !.status = "terminal", !.lost = "slow-intervals"]
    /\ UNCHANGED <<lockHolder, lockQueue, login, signIn, openRouter, stored, windowVars, rendererVars, steps>>

-----------------------------------------------------------------------------
(* The window's page *)

\* render-process-gone. index.ts only releases the initial refresh: no
\* sign-in is ended, and pagehide never runs.
PageCrashes ==
    /\ On("page-crash")
    /\ page.alive
    /\ page' = [page EXCEPT !.alive = FALSE]
    /\ UNCHANGED <<mainVars, onboardingIpc, pendingCancel, rendererVars, steps>>

\* A plain close on macOS: pagehide runs dispose(), which sends cancelChatGptLogin
\* and, while waiting for the browser, cancelIntervalsSignIn.
AthleteClosesWindow ==
    /\ On("window-close")
    /\ Athlete
    /\ page.alive
    /\ page' = [page EXCEPT !.alive = FALSE]
    /\ pendingCancel' = (IF setup.chatgpt = "signing-in" THEN {"chatgpt"} ELSE {})
                        \cup (IF setup.intervals = "waiting" THEN {"intervals"} ELSE {})
    /\ UNCHANGED <<mainVars, onboardingIpc, rendererVars>>

\* cancelLogin aborts the attempt controller; the lock frees once performLogin returns.
MainHandlesChatGptCancel ==
    /\ "chatgpt" \in pendingCancel
    /\ onboardingIpc = "registered"
    /\ pendingCancel' = pendingCancel \ {"chatgpt"}
    /\ IF login.phase = "awaiting-browser"
       THEN /\ login' = LoginIdle
            /\ UNCHANGED lockHolder
       ELSE IF login.phase = "storing" /\ lockHolder.op = "chatgpt-login"
            THEN /\ login' = LoginIdle
                 /\ lockHolder' = NoEntry
            ELSE IF login.phase = "storing"
                 THEN /\ login' = [login EXCEPT !.aborted = TRUE]
                      /\ UNCHANGED lockHolder
                 ELSE UNCHANGED <<login, lockHolder>>
    /\ UNCHANGED <<lockQueue, signIn, openRouter, coach, stored, page, onboardingIpc, rendererVars, steps>>

\* intervals-ipc.ts is installed once per app, so this cancel always lands.
\* An approved sign-in refuses the cancel.
MainHandlesIntervalsCancel ==
    /\ "intervals" \in pendingCancel
    /\ pendingCancel' = pendingCancel \ {"intervals"}
    /\ signIn' = IF signIn.phase = "awaiting-browser" THEN Idle ELSE signIn
    /\ UNCHANGED <<lockHolder, lockQueue, login, openRouter, coach, stored, page, onboardingIpc, rendererVars, steps>>

\* The window's "closed" event disposes onboarding IPC: it cancels the ChatGPT
\* logins this window's registration started, removes the cancel handler, and
\* disposes the window's OpenRouter auth. The page's webContents emits
\* "destroyed", which ends its Intervals.icu sign-in before approval.
WindowIsClosed ==
    /\ ~page.alive
    /\ onboardingIpc = "registered"
    /\ onboardingIpc' = "disposed"
    /\ pendingCancel' = pendingCancel \ {"chatgpt", "intervals"}
    /\ openRouter' = IF openRouter.phase = "awaiting-browser" THEN Idle ELSE openRouter
    /\ signIn' = IF signIn.phase = "awaiting-browser" /\ signIn.page = page.id THEN Idle ELSE signIn
    /\ IF login.page = page.id /\ login.phase = "awaiting-browser"
       THEN /\ login' = LoginIdle
            /\ UNCHANGED lockHolder
       ELSE IF login.page = page.id /\ login.phase = "storing" /\ lockHolder.op = "chatgpt-login"
            THEN /\ login' = LoginIdle
                 /\ lockHolder' = NoEntry
            ELSE IF login.page = page.id /\ login.phase = "storing"
                 THEN /\ login' = [login EXCEPT !.aborted = TRUE]
                      /\ UNCHANGED lockHolder
                 ELSE UNCHANGED <<login, lockHolder>>
    /\ UNCHANGED <<lockQueue, coach, stored, page, rendererVars, steps>>

\* The athlete opens the window again. The new page starts idle and open()
\* loads Setup with hydration from main's answers.
AthleteOpensWindow ==
    /\ Athlete
    /\ ~page.alive
    /\ onboardingIpc = "disposed"
    /\ page.id < MaxPage
    /\ BoundedWorkDone
    /\ page' = [id |-> page.id + 1, alive |-> TRUE]
    /\ onboardingIpc' = "registered"
    /\ setup' = IF CoachReady
                THEN [FreshSetup(coach.active) EXCEPT !.required = ~ReadyFor(coach.active)]
                ELSE [FreshSetup(coach.active) EXCEPT !.unavailable = TRUE]
    /\ settings' = FreshSettings
    /\ telegramRow' = "idle"
    /\ UNCHANGED <<mainVars, pendingCancel>>

-----------------------------------------------------------------------------

Next ==
    \/ LockGoesToNext
    \/ AthleteStartsChatGptSignIn
    \/ ChatGptBrowserWaitEnds
    \/ AthleteCancelsQueuedChatGptSignIn
    \/ PersonFinishesChatGptInBrowser
    \/ ChatGptSignInIsStored
    \/ ChatGptActivationFinishes
    \/ \E p \in KeyProviders : AthleteSavesKeyInSetup(p)
    \/ SetupKeyWriteFinishes
    \/ AthleteStartsIntervalsSignIn
    \/ PersonApprovesIntervalsInBrowser
    \/ IntervalsBrowserWaitEnds
    \/ IntervalsSignInIsStored
    \/ AthleteStartsOpenRouterSignIn
    \/ PersonApprovesOpenRouterInBrowser
    \/ OpenRouterBrowserWaitEnds
    \/ OpenRouterSignInIsStored
    \/ \E p \in KeyProviders \cup {ChatGpt} : AthleteSavesCoachInSettings(p)
    \/ CoachSaveFinishes
    \/ \E p \in KeyProviders \cup {IntervalsSlot} : AthleteDeletesKeyInSettings(p)
    \/ KeyIsDeleted
    \/ SetupReadAnswers
    \/ SetupReadTimesOut
    \/ AthletePastesTelegramToken
    \/ TelegramConfigureFinishes
    \/ CoachProcessExits
    \/ SuccessorStarts
    \/ ReapplyFinishes
    \/ ReconcileFinishes
    \/ ReadinessLimitPasses
    \/ PageCrashes
    \/ AthleteClosesWindow
    \/ MainHandlesChatGptCancel
    \/ MainHandlesIntervalsCancel
    \/ WindowIsClosed
    \/ AthleteOpensWindow

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Rules. Each group is one property the operator stated; its members are
   the conjunction of that property, split so each path reports on its own. *)

TypeOK ==
    /\ login.phase \in {"idle", "queued", "awaiting-browser", "storing"}
    /\ login.aborted \in BOOLEAN
    /\ signIn.phase \in {"idle", "awaiting-browser", "storing"}
    /\ openRouter.phase \in {"idle", "awaiting-browser", "storing"}
    /\ coach.status \in {"ready", "recovering", "terminal"}
    /\ coach.restart \in {"none", "spawning", "replaying"}
    /\ steps \in 0..MaxAthleteSteps

\* 1. A coach restart always reaches ready.
NoRestartLostBehindAPerson == coach.lost # "behind-a-person"
NoRestartLostToSlowIntervals == coach.lost # "slow-intervals"

\* 2. Nothing waits behind a wait for a person.
NothingWaitsBehindAPerson == WaitsForPerson(lockHolder) => lockQueue = <<>>

\* 3. A busy Setup has exactly one named owner.
Alone(x) == x \in InFlight => InFlight = {x}
KeySaveHasSetupAlone == Alone("key-save")
ChatGptSignInHasSetupAlone == Alone("chatgpt-sign-in")
ChatGptActivationHasSetupAlone == Alone("chatgpt-activation")
IntervalsSignInHasSetupAlone == Alone("intervals-sign-in")
OpenRouterSignInHasSetupAlone == Alone("openrouter-sign-in")
BusySetupNamesItsOwner == (page.alive /\ setup.busy) => InFlight # {}

\* 4. A sign-in never outlives the page that started it.
ChatGptSignInEndsWithItsPage ==
    login.phase \in {"queued", "awaiting-browser"} => login.page = page.id
IntervalsSignInEndsWithItsPage ==
    signIn.phase = "awaiting-browser" => signIn.page = page.id
OpenRouterSignInEndsWithItsPage ==
    openRouter.phase = "awaiting-browser" => openRouter.page = page.id

\* 5. After any sequence, Setup's view of the active coach equals the coach's.
SetupShowsTheActiveCoach ==
    (Quiet /\ ~GateShown) => setup.active = coach.active
NeverSentToSetupWithAWorkingCoach ==
    [][(~GateShown /\ GateShown') => ~CoachWorks']_vars

=============================================================================
