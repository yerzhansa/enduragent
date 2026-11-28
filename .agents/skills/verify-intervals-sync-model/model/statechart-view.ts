// View for /statechart: what the athlete sees in each model state.
type Vars = Record<string, unknown>;

const SIDEBAR: Record<string, string> = {
  idle: "Last session's status",
  running: "Syncing",
  synced: "Synced, Intervals.icu checked",
  "local-only": "Shown as synced, Intervals.icu not used",
  "not-in-use": "Sync needs attention: sign-in not in use",
  failed: "Sync needs attention",
  interrupted: "Connection interrupted",
};

const SIGN_IN: Record<string, string> = {
  stored: "Stored, not applied yet",
  active: "In use",
  "failed-network": "Refused while offline",
  failed: "Failed",
  missing: "Removed",
};

const DISCONNECT: Record<string, string> = {
  idle: "Not pressed",
  waiting: "Waiting for the sync",
  applying: "Clearing",
  "answered-applied": "Clearing",
  "answered-error": "Clearing",
  "answered-busy": "Clearing",
  revoked: "Revoked",
  "removed-unrevoked": "Removed here, not revoked (offline)",
  diverged: "Could not be reconciled",
  "refused-busy": "Not deleted: the coach is replying",
};

export const title = "Window, coach connection and intervals.icu sign-in";

export const state = (v: Vars) => ({
  Connection: v.conn === "open" ? "Connected" : "Connection lost",
  Sidebar: SIDEBAR[String(v.win)] ?? String(v.win),
  "Sign-in": SIGN_IN[String(v.slot)] ?? String(v.slot),
  Disconnect: DISCONNECT[String(v.disc)] ?? String(v.disc),
});

const STEP: Record<string, string> = {
  LaunchReappliesSignIn: "the app opens and applies the stored sign-in",
  RetryFires: "the app retries the sign-in",
  AthleteRetriesSavedKeys: "you press Retry saved keys",
  NetworkChanges: "the network changes",
  AthletePressesSync: "you press Sync now",
  AthleteConfirmsFtp: "you confirm an FTP on Activity review",
  WindowRereadsSyncState: "the window asks the coach again by itself",
  WindowSettlesRejectedSync: "the window gives up on the sync (a quiet one goes back to what the sidebar showed)",
  WindowStartsRefresh: "the window refreshes Training",
  TrainingRefreshLands: "Training refreshes",
  WindowPublishesSyncResult: "the window shows the sync result",
  ProviderReconnects: "the window reconnects by itself",
  SchedulerStartsWindow: "a scheduled sync starts",
  LaneGrants: "the coach starts the next job",
  CoachFinishesWindow: "the coach finishes the sync",
  CoachCancelsWindowForClear: "the coach stops the sync for Disconnect",
  AthleteDisconnects: "you press Disconnect",
  CoachAppliesClear: "the coach clears the sign-in",
  CoachDeadlinePasses: "25 seconds pass",
  MainClientTimesOut: "30 seconds pass",
  MainFinishesDisconnect: "the app finishes Disconnect",
  AthleteOpensAnalysis: "you open a ride's analysis",
  AthleteChangesRide: "you click another ride",
  CoachAnswersAnalysis: "the analysis loads and shows",
  CoachAnswersStaleAnalysis: "a cancelled analysis answers late",
  AnalysisTimesOut: "the analysis times out",
  AthleteSendsChat: "you send a chat message",
  ChatReplyEnds: "the coach reply ends",
  ChatDetectsProtocolFault: "the chat gets a broken message",
  SocketCloses: "the connection drops",
  AllSettled: "nothing happens",
};

export const step = (action: string) => STEP[action] ?? action;
