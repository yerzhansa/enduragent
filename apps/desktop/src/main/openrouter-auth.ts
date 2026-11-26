import {
  OPENROUTER_CREDITS_PAGE_URL,
  OPENROUTER_KEYS_PAGE_URL,
  OpenRouterSignInError,
  parseOpenRouterCode,
  type OpenRouterCodeSignIn,
  type OpenRouterCreditStatus,
  type OpenRouterSignInOptions,
  type OpenRouterSignInPhase,
} from "@enduragent/core";
import type { Clipboard } from "electron";

export const OPENROUTER_CODE_ATTEMPT_LIFETIME_MS = 15 * 60 * 1000;

export type OpenRouterSignInRefusal =
  | "already-in-progress"
  | "cancelled"
  | "not-finished"
  | "unreachable"
  | "not-saved"
  | "saved-not-active"
  | "clipboard-no-code"
  | "clipboard-unavailable"
  | "code-expired"
  | "invalid-input";

export type OpenRouterSignInResult =
  | {
      readonly status: "connected";
      readonly operationId: string;
      readonly credit: OpenRouterCreditStatus;
    }
  | { readonly status: "awaiting-code"; readonly operationId: string }
  | {
      readonly status: "refused";
      readonly operationId: string;
      readonly reason: OpenRouterSignInRefusal;
    };

export type OpenRouterStoreOutcome = "connected" | "saved-not-active" | "not-saved";

export type OpenRouterKeyStore = (key: string) => Promise<OpenRouterStoreOutcome>;

export type OpenRouterPage = "credits" | "keys";

export interface OpenRouterSignInPorts {
  readonly openExternal: (url: string) => Promise<void>;
  readonly signIn: (options: OpenRouterSignInOptions) => Promise<string>;
  readonly startCodeSignIn: () => OpenRouterCodeSignIn;
  readonly readCreditStatus: (key: string, signal?: AbortSignal) => Promise<OpenRouterCreditStatus>;
}

export interface OpenRouterAuthDependencies {
  readonly ports: OpenRouterSignInPorts;
  readonly clipboard: Pick<Clipboard, "readText" | "clear">;
  readonly readStoredKey: () => Promise<string | undefined>;
}

export interface OpenRouterAuthController {
  signIn(
    operationId: string,
    store: OpenRouterKeyStore,
    onPhase: (phase: OpenRouterSignInPhase) => void,
  ): Promise<OpenRouterSignInResult>;
  startCodeSignIn(operationId: string, store: OpenRouterKeyStore): OpenRouterSignInResult;
  useCopiedCode(
    operationId: string,
    onPhase: (phase: OpenRouterSignInPhase) => void,
  ): Promise<OpenRouterSignInResult>;
  cancel(operationId: string): boolean;
  reopen(operationId: string): Promise<boolean>;
  readCreditStatus(): Promise<OpenRouterCreditStatus>;
  openPage(page: OpenRouterPage): Promise<boolean>;
  dispose(): void;
}

type OpenRouterAttempt =
  | { readonly kind: "none" }
  | {
      readonly kind: "browser";
      readonly operationId: string;
      readonly abort: AbortController;
      readonly authorizeUrl: string | null;
      readonly phase: OpenRouterSignInPhase;
    }
  | {
      readonly kind: "code";
      readonly operationId: string;
      readonly authorizeUrl: string;
      readonly exchange: (text: string, signal?: AbortSignal) => Promise<string>;
      readonly expiresAt: number;
      readonly store: OpenRouterKeyStore;
      readonly phase: "awaiting-code" | "completing-sign-in";
    };

const NO_ATTEMPT: OpenRouterAttempt = { kind: "none" };

const PAGE_URLS: Readonly<Record<OpenRouterPage, string>> = {
  credits: OPENROUTER_CREDITS_PAGE_URL,
  keys: OPENROUTER_KEYS_PAGE_URL,
};

const BROWSER_FAILURES = {
  "timed-out": "not-finished",
  "access-denied": "not-finished",
  cancelled: "cancelled",
  "callback-unavailable": "not-finished",
  "exchange-failed": "unreachable",
  unreachable: "unreachable",
  "code-rejected": "unreachable",
} as const satisfies Readonly<Record<OpenRouterSignInError["reason"], OpenRouterSignInRefusal>>;

const CODE_FAILURES = {
  ...BROWSER_FAILURES,
  "code-rejected": "code-expired",
} as const satisfies Readonly<Record<OpenRouterSignInError["reason"], OpenRouterSignInRefusal>>;

function refused(operationId: string, reason: OpenRouterSignInRefusal): OpenRouterSignInResult {
  return { status: "refused", operationId, reason };
}

function failureOf(
  error: unknown,
  failures: Readonly<Record<OpenRouterSignInError["reason"], OpenRouterSignInRefusal>>,
): OpenRouterSignInRefusal {
  return error instanceof OpenRouterSignInError ? failures[error.reason] : "unreachable";
}

type ClipboardRead =
  | { readonly status: "read"; readonly text: string; readonly code: string | null }
  | { readonly status: "unavailable" };

async function readClipboardCode(clipboard: Pick<Clipboard, "readText">): Promise<ClipboardRead> {
  try {
    const text: unknown = await clipboard.readText();
    return typeof text === "string"
      ? { status: "read", text, code: parseOpenRouterCode(text) }
      : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}

async function clearClipboardIfUnchanged(
  clipboard: Pick<Clipboard, "readText" | "clear">,
  text: string,
): Promise<void> {
  try {
    if ((await clipboard.readText()) === text) clipboard.clear();
  } catch {
    return;
  }
}

export function createOpenRouterAuth(
  dependencies: OpenRouterAuthDependencies & {
    readonly now?: () => number;
  },
): OpenRouterAuthController {
  const now = dependencies.now ?? Date.now;
  const lifetime = new AbortController();
  let attempt: OpenRouterAttempt = NO_ATTEMPT;

  const owns = (operationId: string, kind: "browser" | "code"): boolean =>
    attempt.kind === kind && attempt.operationId === operationId;

  const release = (operationId: string, kind: "browser" | "code"): void => {
    if (owns(operationId, kind)) attempt = NO_ATTEMPT;
  };

  const finish = async (
    operationId: string,
    key: string,
    store: OpenRouterKeyStore,
  ): Promise<OpenRouterSignInResult> => {
    if (lifetime.signal.aborted) return refused(operationId, "cancelled");
    const stored = await store(key).catch((): OpenRouterStoreOutcome => "not-saved");
    if (lifetime.signal.aborted) return refused(operationId, "cancelled");
    if (stored !== "connected") return refused(operationId, stored);
    const credit = await dependencies.ports
      .readCreditStatus(key, lifetime.signal)
      .catch((): OpenRouterCreditStatus => "unknown");
    return { status: "connected", operationId, credit };
  };

  const beginCode = (operationId: string, store: OpenRouterKeyStore): OpenRouterSignInResult => {
    const code = dependencies.ports.startCodeSignIn();
    attempt = {
      kind: "code",
      operationId,
      authorizeUrl: code.authorizeUrl,
      exchange: code.exchange,
      expiresAt: now() + OPENROUTER_CODE_ATTEMPT_LIFETIME_MS,
      store,
      phase: "awaiting-code",
    };
    void dependencies.ports.openExternal(code.authorizeUrl).then(
      () => true,
      () => false,
    );
    return { status: "awaiting-code", operationId };
  };

  const updateBrowser = (
    operationId: string,
    change: { readonly authorizeUrl?: string; readonly phase?: OpenRouterSignInPhase },
  ): void => {
    if (attempt.kind !== "browser" || attempt.operationId !== operationId) return;
    attempt = { ...attempt, ...change };
  };

  return {
    async signIn(operationId, store, onPhase) {
      if (lifetime.signal.aborted) return refused(operationId, "cancelled");
      if (
        attempt.kind === "browser" ||
        (attempt.kind === "code" && attempt.phase !== "awaiting-code")
      ) {
        return refused(operationId, "already-in-progress");
      }
      const abort = new AbortController();
      let browserFailed = false;
      attempt = {
        kind: "browser",
        operationId,
        abort,
        authorizeUrl: null,
        phase: "waiting-for-browser",
      };
      let key: string;
      try {
        key = await dependencies.ports.signIn({
          openExternal: dependencies.ports.openExternal,
          onAuthorizeUrl: (authorizeUrl) => updateBrowser(operationId, { authorizeUrl }),
          onBrowserOpenFailed: () => {
            browserFailed = true;
            abort.abort();
          },
          onPhase: (phase) => {
            if (!owns(operationId, "browser")) return;
            updateBrowser(operationId, { phase });
            onPhase(phase);
          },
          signal: AbortSignal.any([lifetime.signal, abort.signal]),
        });
      } catch (error) {
        if (!owns(operationId, "browser")) return refused(operationId, "cancelled");
        attempt = NO_ATTEMPT;
        if (browserFailed) return refused(operationId, "not-finished");
        if (lifetime.signal.aborted || abort.signal.aborted)
          return refused(operationId, "cancelled");
        if (error instanceof OpenRouterSignInError && error.reason === "callback-unavailable") {
          return beginCode(operationId, store);
        }
        return refused(operationId, failureOf(error, BROWSER_FAILURES));
      }
      try {
        if (!owns(operationId, "browser")) return refused(operationId, "cancelled");
        return await finish(operationId, key, store);
      } finally {
        release(operationId, "browser");
      }
    },
    startCodeSignIn(operationId, store) {
      if (lifetime.signal.aborted) return refused(operationId, "cancelled");
      if (attempt.kind !== "none" && attempt.phase === "completing-sign-in") {
        return refused(operationId, "already-in-progress");
      }
      if (attempt.kind === "browser") attempt.abort.abort();
      return beginCode(operationId, store);
    },
    async useCopiedCode(operationId, onPhase) {
      if (lifetime.signal.aborted) return refused(operationId, "cancelled");
      const current = attempt;
      if (current.kind !== "code" || current.operationId !== operationId) {
        return refused(operationId, "code-expired");
      }
      if (current.phase !== "awaiting-code") return refused(operationId, "already-in-progress");
      if (now() > current.expiresAt) {
        attempt = NO_ATTEMPT;
        return refused(operationId, "code-expired");
      }
      const reading: OpenRouterAttempt = { ...current, phase: "completing-sign-in" };
      attempt = reading;
      const read = await readClipboardCode(dependencies.clipboard);
      if (attempt !== reading) return refused(operationId, "cancelled");
      if (read.status === "unavailable" || read.code === null) {
        attempt = current;
        return refused(
          operationId,
          read.status === "unavailable" ? "clipboard-unavailable" : "clipboard-no-code",
        );
      }
      onPhase("completing-sign-in");
      let key: string;
      try {
        key = await current.exchange(read.code, lifetime.signal);
      } catch (error) {
        const reason = failureOf(error, CODE_FAILURES);
        if (reason === "unreachable" && attempt === reading && !lifetime.signal.aborted) {
          attempt = current;
        } else {
          release(operationId, "code");
        }
        return refused(operationId, reason);
      }
      await clearClipboardIfUnchanged(dependencies.clipboard, read.text);
      try {
        if (!owns(operationId, "code")) return refused(operationId, "cancelled");
        return await finish(operationId, key, current.store);
      } finally {
        release(operationId, "code");
      }
    },
    cancel(operationId) {
      if (attempt.kind === "none" || attempt.operationId !== operationId) return false;
      if (attempt.phase === "completing-sign-in") return false;
      if (attempt.kind === "browser") attempt.abort.abort();
      attempt = NO_ATTEMPT;
      return true;
    },
    reopen(operationId) {
      if (attempt.kind === "none" || attempt.operationId !== operationId) {
        return Promise.resolve(false);
      }
      if (attempt.phase === "completing-sign-in" || attempt.authorizeUrl === null) {
        return Promise.resolve(false);
      }
      if (attempt.kind === "code" && now() > attempt.expiresAt) {
        attempt = NO_ATTEMPT;
        return Promise.resolve(false);
      }
      return dependencies.ports.openExternal(attempt.authorizeUrl).then(
        () => true,
        () => false,
      );
    },
    async readCreditStatus() {
      let key: string | undefined;
      try {
        key = await dependencies.readStoredKey();
      } catch {
        return "unknown";
      }
      if (key === undefined || lifetime.signal.aborted) return "unknown";
      return dependencies.ports
        .readCreditStatus(key, lifetime.signal)
        .catch((): OpenRouterCreditStatus => "unknown");
    },
    openPage(page) {
      return dependencies.ports.openExternal(PAGE_URLS[page]).then(
        () => true,
        () => false,
      );
    },
    dispose() {
      lifetime.abort();
      if (attempt.kind === "browser") attempt.abort.abort();
      attempt = NO_ATTEMPT;
    },
  };
}
