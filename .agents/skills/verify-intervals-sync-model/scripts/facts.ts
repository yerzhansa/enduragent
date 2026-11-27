// What the model says about the code, in one place.
// FLAGS: each model CONSTANT and how to read its value from the code.
// RULES: each invariant, the issue it guards, when it must hold, and how to break it.
// COVERED: the code each model action describes; check.ts fingerprints it.

export type FlagName =
  | "AnalysisPassesSignal"
  | "AbortLatches"
  | "TimeoutLatches"
  | "RereadOnOpen"
  | "TransientRetry"
  | "SkippedIsFailure"
  | "ClearCancelsWindow";

export type Flags = Record<FlagName, boolean>;

export interface Source {
  read(file: string): string;
  // The `{ ... }` body that follows the first match of `needle`.
  block(file: string, needle: string): string;
  // The `( ... )` call that contains the first match of `needle`.
  call(file: string, needle: string): string;
  // From `needle` to the end of its statement.
  statement(file: string, needle: string): string;
}

export interface FlagFact {
  readonly name: FlagName;
  readonly says: string;
  readonly read: (source: Source) => boolean;
}

const CLIENT = "packages/coach-client/src/client.ts";
const ANALYSIS = "apps/desktop-renderer/src/activity-analysis/controller.ts";
const SYNC = "apps/desktop-renderer/src/training-sync.ts";
const PROVIDER = "apps/desktop-renderer/src/coach-client.ts";
const BOOT = "apps/desktop-renderer/src/boot.ts";
const CHAT = "apps/desktop-renderer/src/chat/controller.ts";
const STORE_RUNTIME = "packages/coach/src/store-runtime.ts";
const OPERATIONS = "packages/coach/src/operations.ts";
const RPC_SERVER = "packages/coach/src/daemon/rpc-server.ts";
const COMPOSITION = "packages/coach/src/composition.ts";
const TIMEOUTS = "packages/coach-client/src/call-timeouts.ts";
const MAIN = "apps/desktop/src/main/index.ts";
const RUNTIME = "apps/desktop/src/main/credential-runtime.ts";
const VAULT = "apps/desktop/src/main/credential-vault.ts";

export const FLAGS: readonly FlagFact[] = [
  {
    name: "AnalysisPassesSignal",
    says: "the ride analysis passes its AbortController's signal to getActivityAnalysis",
    read: (s) => /\bsignal\b/.test(s.call(ANALYSIS, '"getActivityAnalysis"')),
  },
  {
    name: "AbortLatches",
    says: "a caller's abort runs latchTerminal and closes the shared connection",
    read: (s) => /latchTerminal/.test(s.statement(CLIENT, "const onAbort =")),
  },
  {
    name: "TimeoutLatches",
    says: "a call's timeout closes the shared connection instead of failing only that call",
    read: (s) =>
      /latchTerminal/.test(s.statement(CLIENT, "pending.timer = setTimeout(")) ||
      /latchTerminal/.test(s.block(CLIENT, "private timeOut(")),
  },
  {
    name: "RereadOnOpen",
    says: "the sync coordinator asks the coach again when the provider opens a new connection",
    read: (s) => /onConnectionOpen/.test(s.block(SYNC, "export function createTrainingSyncCoordinator(")),
  },
  {
    name: "TransientRetry",
    says: "main retries a stored intervals.icu sign-in that was refused for a network reason",
    read: (s) => /createIntervalsSignInRetry\(/.test(s.read(MAIN)),
  },
  {
    name: "SkippedIsFailure",
    says: "a keyless sync is a failure while an intervals.icu sign-in is saved",
    read: (s) =>
      /"skipped-no-credential"/.test(s.block(SYNC, "export function createTrainingSyncCoordinator(")),
  },
  {
    name: "ClearCancelsWindow",
    says: "an intervals.icu credential clear cancels the sync window that holds the lane",
    read: (s) => /abortActiveWindow/.test(s.read(STORE_RUNTIME)),
  },
];

// A rule breaks for a cause. A cause with an issue is a known, open finding.
// A cause with no issue is a regression: the check fails on it.
export interface BreakCause {
  readonly when: (flags: Flags) => boolean;
  readonly issue?: string;
  readonly because: string;
}

export interface RuleFact {
  readonly name: string;
  readonly says: string;
  readonly harm: string;
  // The rule breaks exactly when one of these causes is present.
  readonly breaksWhen: readonly BreakCause[];
  // Flag values that must break the rule, whatever the code says today.
  readonly breakWith: Partial<Flags>;
  readonly witness: string;
}

export const RULES: readonly RuleFact[] = [
  {
    name: "OneCallsCancelNeverFailsAnother",
    says: "One call's cancel or timeout never fails another call on the window's connection.",
    harm: "Clicking another ride while its analysis loads shows a running sync as interrupted and cuts off a coach reply.",
    breaksWhen: [
      {
        when: (f) => f.AnalysisPassesSignal && f.AbortLatches,
        issue: "411",
        because: "the ride analysis cancel closes the shared connection",
      },
      {
        when: (f) => f.TimeoutLatches,
        because: "a call's timeout closes the shared connection again (PR 1185 undone)",
      },
    ],
    breakWith: { TimeoutLatches: true },
    witness: "WitnessOtherCallsPendingDuringAnalysis",
  },
  {
    name: "WindowCatchesUpAfterReconnect",
    says: "Once the connection is open again and nothing runs by itself, the sidebar shows the coach's last sync result and the training context is not older than it.",
    harm: "After a dropped connection the sidebar keeps \"Connection interrupted\" and old Training and Plan data until the athlete presses Try again.",
    breaksWhen: [
      { when: (f) => !f.RereadOnOpen, issue: "413", because: "nothing re-reads the sync after a reconnect" },
    ],
    breakWith: { RereadOnOpen: false },
    witness: "WitnessQuiescentAfterReconnect",
  },
  {
    name: "NetworkRefusalIsRetried",
    says: "A stored sign-in refused for a network reason always has a retry scheduled.",
    harm: "After a launch with no network, intervals.icu stays off all session.",
    breaksWhen: [
      { when: (f) => !f.TransientRetry, issue: "410", because: "only Retry saved keys re-applies the sign-in" },
    ],
    breakWith: { TransientRetry: false },
    witness: "WitnessNetworkRefusal",
  },
  {
    name: "EmptySyncNeverShownAsSuccess",
    says: "While a sign-in is saved, a sync that fetched nothing from intervals.icu is never shown as a success.",
    harm: "Sync now turns green and the sidebar says synced while nothing was fetched.",
    breaksWhen: [
      { when: (f) => !f.SkippedIsFailure, issue: "410", because: "skipped-no-credential maps to a no-change success" },
    ],
    breakWith: { SkippedIsFailure: false },
    witness: "WitnessEmptySyncWithSignIn",
  },
  {
    name: "DisconnectRevokesOrRefusesClearly",
    says: "Disconnect ends with the sign-in revoked or a clear refusal inside its deadline, never \"could not be reconciled\" with the token kept.",
    harm: "Disconnect during a long sync fails after 30 seconds, locks Settings, and leaves the token on the computer and on intervals.icu.",
    breaksWhen: [
      { when: (f) => !f.ClearCancelsWindow, issue: "412", because: "the clear waits behind the whole sync with no way out" },
    ],
    breakWith: { ClearCancelsWindow: false },
    witness: "WitnessDisconnectDuringSync",
  },
];

// Plain words for each action, used when check.ts prints a counterexample.
export const STEPS: Record<string, string> = {
  Initial: "the app starts with a stored intervals.icu sign-in",
  LaunchReappliesSignIn: "at launch main re-applies the stored sign-in (index.ts reapplyConfigured)",
  RetryFires: "main's scheduled retry re-applies the stored sign-in",
  AthleteRetriesSavedKeys: "the athlete presses Retry saved keys",
  NetworkChanges: "the network goes up or down",
  AthletePressesSync: "the athlete presses Sync now or Try again (training-sync.ts request)",
  WindowRereadsSyncState: "the window asks the coach for the sync again by itself",
  WindowSettlesRejectedSync: "the window publishes failed/indeterminate: \"Connection interrupted\"",
  WindowFinishesSync: "the window refreshes Training and Plan and publishes the sync result",
  ProviderReconnects: "a later window call opens a new connection (coach-client.ts getClient)",
  SchedulerStartsWindow: "the coach's scheduler starts a sync window",
  LaneGrants: "the next waiter takes the coach's window lane (store-runtime.ts admit)",
  CoachFinishesWindow: "the coach finishes the sync window and answers",
  CoachCancelsWindowForClear: "the coach cancels the sync so the Disconnect can run",
  AthleteDisconnects: "the athlete confirms Disconnect in Settings (configureRuntime clear_credential)",
  CoachAppliesClear: "the coach applies the clear, or throws if its deadline passed",
  CoachDeadlinePasses: "25 s pass: the coach's configureRuntime deadline expires while it waits",
  MainClientTimesOut: "30 s pass: main's client gives up; the vault marks the slot failed, runtime-state-diverged",
  MainFinishesDisconnect: "main revokes and removes the token, or reports runtime-state-diverged",
  AthleteOpensAnalysis: "the athlete opens a ride's analysis (getActivityAnalysis with signal)",
  AthleteChangesRide: "the athlete clicks another ride, so the analysis is cancelled",
  CoachAnswersAnalysis: "the coach answers the analysis",
  CoachAnswersStaleAnalysis: "the coach answers a cancelled analysis; the window ignores it",
  AnalysisTimesOut: "120 s pass: the analysis call times out",
  AthleteSendsChat: "the athlete sends a chat message; the reply streams",
  ChatReplyEnds: "the coach reply finishes",
  ChatDetectsProtocolFault: "the chat sees a bad envelope and aborts its call (protocol fault)",
  SocketCloses: "the window's socket to the coach closes",
  AllSettled: "nothing is left to do",
};

export interface Covered {
  readonly file: string;
  readonly needle: string;
  readonly kind: "block" | "statement" | "call";
  readonly models: string;
}

// Each entry is fingerprinted. A changed fingerprint means the model may no
// longer describe that code: re-read it before you trust a result.
export const COVERED: readonly Covered[] = [
  { file: CLIENT, needle: "private call<", kind: "block", models: "every call; AbortLatches" },
  { file: CLIENT, needle: "pending.timer = setTimeout(", kind: "statement", models: "AnalysisTimesOut; TimeoutLatches" },
  { file: CLIENT, needle: "private timeOut(", kind: "block", models: "AnalysisTimesOut; TimeoutLatches" },
  { file: CLIENT, needle: "private latchTerminal(", kind: "block", models: "LatchTo" },
  { file: CLIENT, needle: "private readonly onSocketClose", kind: "block", models: "SocketCloses" },
  { file: TIMEOUTS, needle: "getActivityAnalysis:", kind: "statement", models: "AnalysisTimesOut (120 s)" },
  { file: TIMEOUTS, needle: "configureRuntime:", kind: "statement", models: "MainClientTimesOut (30 s)" },
  { file: PROVIDER, needle: "export function createDesktopCoachClientProvider(", kind: "block", models: "ProviderReconnects; LatchTo onTerminal" },
  { file: SYNC, needle: "export function createTrainingSyncCoordinator(", kind: "block", models: "AthletePressesSync; WindowSettlesRejectedSync; WindowFinishesSync; Shown; RereadOnOpen; SkippedIsFailure" },
  { file: BOOT, needle: "refreshTrainingContext: async () =>", kind: "block", models: "WindowFinishesSync (invalidate, refresh)" },
  { file: ANALYSIS, needle: "export function createRideAnalysisController(", kind: "block", models: "AthleteOpensAnalysis; AthleteChangesRide; CoachAnswersStaleAnalysis; AnalysisPassesSignal" },
  { file: CHAT, needle: "const failProtocol = (): void =>", kind: "block", models: "ChatDetectsProtocolFault" },
  { file: STORE_RUNTIME, needle: "runWindowAfter(", kind: "block", models: "LaneGrants (sync)" },
  { file: STORE_RUNTIME, needle: "runOutsideWindow<T>(", kind: "block", models: "LaneGrants (clear)" },
  { file: STORE_RUNTIME, needle: "private admit<T>(", kind: "block", models: "LaneGrants; CoachDeadlinePasses (no abort path)" },
  { file: STORE_RUNTIME, needle: "private enter(", kind: "block", models: "LaneGrants" },
  { file: STORE_RUNTIME, needle: "private leave(", kind: "block", models: "LaneGrants" },
  { file: STORE_RUNTIME, needle: "private async runScheduledWindow()", kind: "block", models: "SchedulerStartsWindow" },
  { file: OPERATIONS, needle: "sync(request: SyncRpcParams, onEvent)", kind: "block", models: "LaneGrants windowKey; CoachFinishesWindow" },
  { file: OPERATIONS, needle: "): Promise<ConfigureRuntimeRpcResult> {", kind: "block", models: "CoachAppliesClear; CoachDeadlinePasses" },
  { file: RPC_SERVER, needle: 'case "sync":', kind: "block", models: "orphan windows: the sync handler gets no detach signal" },
  { file: COMPOSITION, needle: "pendingOwnerClaim = await assertIntervalsOwner(", kind: "statement", models: "ApplyStoredSignIn (owner check needs the network)" },
  { file: RUNTIME, needle: "reapplyStoredCredential(slot, value, storedCredentialSlots) {", kind: "block", models: "ApplyStoredSignIn" },
  { file: RUNTIME, needle: "async clearCredential(credential) {", kind: "block", models: "AthleteDisconnects; MainClientTimesOut" },
  { file: VAULT, needle: "const reapplyConfigured = async", kind: "block", models: "LaunchReappliesSignIn" },
  { file: VAULT, needle: "const retryFailed = async", kind: "block", models: "AthleteRetriesSavedKeys; RetryFires" },
  { file: VAULT, needle: "if (shouldClearRuntime) {", kind: "block", models: "MainClientTimesOut; MainFinishesDisconnect" },
  { file: MAIN, needle: "await vault.reapplyConfigured();", kind: "statement", models: "LaunchReappliesSignIn" },
];
