// Labels for reading SetupOperations.tla results with the /statechart skill.

interface Entry {
  readonly op: string;
  readonly arg: string;
  readonly page: number;
}

interface Vars {
  readonly lockHolder: Entry;
  readonly lockQueue: Record<string, Entry>;
  readonly login: { readonly phase: string; readonly page: number };
  readonly signIn: { readonly phase: string; readonly page: number };
  readonly openRouter: { readonly phase: string; readonly page: number };
  readonly coach: { readonly status: string; readonly active: string; readonly lost: string };
  readonly page: { readonly id: number; readonly alive: boolean };
  readonly setup: {
    readonly busy: boolean;
    readonly active: string;
    readonly loading: boolean;
    readonly unavailable: boolean;
    readonly required: boolean;
    readonly chatgpt: string;
    readonly intervals: string;
    readonly keySave: string;
    readonly openRouter: string;
  };
  readonly settings: { readonly op: string; readonly repair: boolean };
}

const PROVIDERS: Record<string, string> = {
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
  "openai-codex": "ChatGPT",
  none: "no provider",
};

const OPERATIONS: Record<string, string> = {
  "chatgpt-login": "the ChatGPT sign-in",
  "chatgpt-activate": "the ChatGPT activation",
  "key-write": "a Setup key save",
  "coach-save": "a Coach save",
  "key-delete": "a key delete",
  "telegram-configure": "Telegram setup",
  "intervals-store": "the Intervals.icu key check",
  "openrouter-write": "the OpenRouter key save",
  reapply: "the restart's key replay",
};

function coachLabel(v: Vars): string {
  if (v.coach.status === "terminal") return "Coach stopped until relaunch";
  if (v.coach.status === "recovering") return "Coach restarting";
  return `Coach on ${PROVIDERS[v.coach.active] ?? v.coach.active}`;
}

function lockLabel(v: Vars): string {
  if (v.lockHolder.op === "none") return "lock free";
  const waiting = Object.keys(v.lockQueue).length;
  const holder = OPERATIONS[v.lockHolder.op] ?? v.lockHolder.op;
  const person = v.lockHolder.op === "chatgpt-login" && v.login.phase === "awaiting-browser";
  return `lock held by ${holder}${person ? " (waiting for you)" : ""}${waiting > 0 ? `, ${waiting} waiting` : ""}`;
}

function setupLabel(v: Vars): string {
  if (!v.page.alive) return "window page gone";
  const gate = v.setup.required || v.settings.repair;
  const working = [
    v.setup.keySave !== "none" ? "key save" : null,
    v.setup.chatgpt === "signing-in" ? "ChatGPT sign-in" : null,
    v.setup.chatgpt === "activating" ? "ChatGPT activation" : null,
    v.setup.intervals !== "idle" ? "Intervals.icu sign-in" : null,
    v.setup.openRouter !== "idle" ? "OpenRouter sign-in" : null,
  ].filter((entry) => entry !== null);
  const screen = gate
    ? "Setup screen"
    : `Setup shows ${PROVIDERS[v.setup.active] ?? v.setup.active}`;
  const status = v.setup.loading ? ", checking" : v.setup.unavailable ? ", couldn't load" : "";
  const busy = working.length > 0 ? `, running ${working.join(" and ")}` : v.setup.busy ? ", busy" : "";
  return `page ${v.page.id}: ${screen}${status}${busy}`;
}

export const title = "Setup's operations and the credential lock";

export const state = (v: Vars): string => `${coachLabel(v)} · ${lockLabel(v)} · ${setupLabel(v)}`;

export const step = (action: string, from: Vars, to: Vars): string => {
  switch (action) {
    case "LockGoesToNext":
      return from.lockQueue["1"]?.op === "chatgpt-login"
        ? "the ChatGPT tab opens in the browser"
        : `${OPERATIONS[from.lockQueue["1"]?.op ?? ""] ?? "the next change"} starts`;
    case "AthleteStartsChatGptSignIn":
      return "you click Sign in with ChatGPT";
    case "ChatGptBrowserWaitEnds":
      return "the ChatGPT sign-in is cancelled or times out";
    case "PersonFinishesChatGptInBrowser":
      return "you finish the ChatGPT sign-in in the browser";
    case "ChatGptSignInIsStored":
      return "the ChatGPT sign-in is saved and the coach starts activating";
    case "ChatGptActivationFinishes":
      return "activation ends";
    case "AthleteSavesKeyInSetup":
      return "you save an API key in Setup";
    case "SetupKeyWriteFinishes":
      return "the key is saved";
    case "AthleteStartsIntervalsSignIn":
      return from.signIn.phase === "idle"
        ? "you click Sign in with Intervals.icu"
        : "you click it again and see \"check your connection\"";
    case "PersonApprovesIntervalsInBrowser":
      return "you approve Intervals.icu in the browser";
    case "IntervalsBrowserWaitEnds":
      return "the Intervals.icu sign-in is cancelled or times out";
    case "IntervalsSignInIsStored":
      return "Intervals.icu is connected";
    case "AthleteStartsOpenRouterSignIn":
      return "you click Sign in with OpenRouter";
    case "PersonApprovesOpenRouterInBrowser":
      return "you approve OpenRouter in the browser";
    case "OpenRouterBrowserWaitEnds":
      return "the OpenRouter sign-in is cancelled or times out";
    case "OpenRouterSignInIsStored":
      return "OpenRouter is connected";
    case "AthleteSavesCoachInSettings": {
      const save = Object.values(to.lockQueue).find((entry) => entry.op === "coach-save");
      return `you pick ${PROVIDERS[save?.arg ?? ""] ?? "another provider"} in Settings, Coach`;
    }
    case "CoachSaveFinishes":
      return "the coach switches provider";
    case "AthleteDeletesKeyInSettings":
      return "you delete a saved key in Settings";
    case "KeyIsDeleted":
      return "the key is deleted and Setup checks its status again";
    case "SetupReadAnswers":
      return "the coach answers Setup's check";
    case "SetupReadTimesOut":
      return "the coach takes longer than 3 seconds to answer";
    case "AthletePastesTelegramToken":
      return "you click Use copied token for Telegram";
    case "TelegramConfigureFinishes":
      return "Telegram connects";
    case "CoachProcessExits":
      return "the coach process exits and the app restarts it";
    case "ReapplyFinishes":
      return "the restarted coach gets its keys back";
    case "ReadinessLimitPasses":
      return to.coach.lost === "behind-a-person"
        ? "5 seconds pass [while the replay waits behind the sign-in]"
        : "5 seconds pass [while intervals.icu is slow]";
    case "PageCrashes":
      return "the window's page crashes";
    case "AthleteClosesWindow":
      return "you close the window";
    case "MainHandlesChatGptCancel":
    case "MainHandlesIntervalsCancel":
      return "the app cancels the sign-in";
    case "WindowIsClosed":
      return "the window finishes closing";
    case "AthleteOpensWindow":
      return "you open the window again";
    default:
      return action;
  }
};
