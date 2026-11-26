import type {
  OnboardingBridge,
  OnboardingLlmConfiguration,
  OnboardingLlmSelection,
  OpenRouterCreditStatus,
  OpenRouterSignInBridge,
  OpenRouterSignInResult,
} from "./bridge";
import type { OnboardingErrorCode } from "./machine";
import { draftForProvider, llmSelectionFromDraft, type LlmSelectionDraft } from "./selection";

export type OpenRouterCodeProblem =
  | "clipboard-no-code"
  | "clipboard-unavailable"
  | "code-expired"
  | "unreachable";

export type OpenRouterSignInFailure =
  | "not-finished"
  | "unreachable"
  | "not-saved"
  | "saved-not-active";

export type OpenRouterSignInSurface =
  | { readonly phase: "idle" }
  | {
      readonly phase: "waiting-for-browser" | "completing-sign-in";
      readonly operationId: string;
    }
  | {
      readonly phase: "awaiting-code";
      readonly operationId: string;
      readonly problem: OpenRouterCodeProblem | null;
    }
  | { readonly phase: "failed"; readonly reason: OpenRouterSignInFailure };

export interface OpenRouterSignInView {
  readonly signIn: OpenRouterSignInSurface;
  readonly credit: OpenRouterCreditStatus | null;
  readonly activating: boolean;
  readonly readingCode: boolean;
}

export interface OpenRouterSignInActions {
  start(): void;
  cancel(): void;
  dismiss(): void;
  reopen(): void;
  enterCode(): void;
  useCopiedCode(): void;
  retryActivation(): void;
  checkCredits(): void;
  addCredits(): void;
  openKeys(): void;
}

export interface OpenRouterSignInHost {
  readonly bridge: OpenRouterSignInBridge & Pick<OnboardingBridge, "applyLlmSelection">;
  readonly createOperationId: () => string;
  readonly publish: () => void;
  readonly configuration: () => OnboardingLlmConfiguration | undefined;
  readonly draft: () => LlmSelectionDraft | undefined;
  readonly canMutate: () => boolean;
  readonly active: () => boolean;
  readonly sync: (selection: OnboardingLlmSelection | null) => Promise<void>;
  readonly fail: (code: OnboardingErrorCode) => void;
  readonly onWindowFocus?: (listener: () => void) => () => void;
}

export interface OpenRouterSignIn {
  readonly actions: OpenRouterSignInActions;
  view(): OpenRouterSignInView;
  refreshCredit(): void;
  connectedByKey(): void;
  reset(): void;
  dispose(): void;
}

const IDLE: OpenRouterSignInSurface = Object.freeze({ phase: "idle" });

export const IDLE_OPENROUTER_SIGN_IN: OpenRouterSignInView = Object.freeze({
  signIn: IDLE,
  credit: null,
  activating: false,
  readingCode: false,
});

export function openRouterSignInBusy(view: OpenRouterSignInView): boolean {
  return (
    view.activating ||
    view.readingCode ||
    view.signIn.phase === "waiting-for-browser" ||
    view.signIn.phase === "completing-sign-in"
  );
}

export function openRouterSignInBridge(auth: OpenRouterSignInBridge): OpenRouterSignInBridge {
  return {
    openRouterSignIn: (input) => auth.openRouterSignIn(input),
    startOpenRouterCodeSignIn: (input) => auth.startOpenRouterCodeSignIn(input),
    useCopiedOpenRouterCode: (operationId) => auth.useCopiedOpenRouterCode(operationId),
    cancelOpenRouterSignIn: (operationId) => auth.cancelOpenRouterSignIn(operationId),
    reopenOpenRouterSignIn: (operationId) => auth.reopenOpenRouterSignIn(operationId),
    openRouterCreditStatus: () => auth.openRouterCreditStatus(),
    openOpenRouterPage: (page) => auth.openOpenRouterPage(page),
    onOpenRouterSignInProgress: (listener) => auth.onOpenRouterSignInProgress(listener),
  };
}

function windowFocus(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener("focus", listener);
  return () => window.removeEventListener("focus", listener);
}

function operationOf(surface: OpenRouterSignInSurface): string | null {
  return "operationId" in surface ? surface.operationId : null;
}

export function createOpenRouterSignIn(host: OpenRouterSignInHost): OpenRouterSignIn {
  let signIn = IDLE;
  let chosen: OnboardingLlmSelection | null = null;
  let credit: OpenRouterCreditStatus | null = null;
  let activating = false;
  let readingOperationId: string | null = null;
  let creditGeneration = 0;
  let disposed = false;

  const show = (next: OpenRouterSignInSurface): void => {
    signIn = next;
    host.publish();
  };

  const reading = (): boolean =>
    readingOperationId !== null && readingOperationId === operationOf(signIn);

  const selection = (): OnboardingLlmSelection | null => {
    const configuration = host.configuration();
    const provider = configuration?.providers.find((entry) => entry.provider === "openrouter");
    if (configuration === undefined || provider === undefined) return null;
    const fallback = draftForProvider(provider, configuration.catalogRevision);
    const current = host.draft();
    const parsed = llmSelectionFromDraft(
      current?.provider.provider === "openrouter"
        ? { ...current, endpointMode: "default", customEndpoint: "" }
        : fallback,
    );
    const usable = parsed.error === null ? parsed : llmSelectionFromDraft(fallback);
    return usable.error === null ? { ...usable.selection, endpoint: { mode: "default" } } : null;
  };

  const readCredit = (clearShown: boolean): void => {
    const generation = ++creditGeneration;
    if (disposed) return;
    if (!host.active()) {
      credit = null;
      return;
    }
    if (clearShown && credit !== null) {
      credit = null;
      host.publish();
    }
    void host.bridge
      .openRouterCreditStatus()
      .catch((): OpenRouterCreditStatus => "unknown")
      .then((status) => {
        if (disposed || generation !== creditGeneration) return;
        credit = status;
        host.publish();
      });
  };

  const refreshCredit = (): void => readCredit(true);

  const current = (operationId: string): boolean =>
    !disposed && operationOf(signIn) === operationId;

  const settle = async (operationId: string, result: OpenRouterSignInResult): Promise<void> => {
    if (!current(operationId)) return;
    if (result.status === "awaiting-code") {
      show({ phase: "awaiting-code", operationId, problem: null });
      return;
    }
    if (result.status === "connected") {
      show({ phase: "completing-sign-in", operationId });
      await host.sync(chosen);
      if (!current(operationId)) return;
      creditGeneration += 1;
      credit = result.credit;
      show(IDLE);
      return;
    }
    switch (result.reason) {
      case "clipboard-no-code":
      case "clipboard-unavailable":
      case "code-expired":
        show({ phase: "awaiting-code", operationId, problem: result.reason });
        return;
      case "cancelled":
        show(IDLE);
        return;
      case "invalid-input":
        signIn = IDLE;
        host.fail("configuration-unavailable");
        return;
      case "already-in-progress":
        show({ phase: "failed", reason: "not-finished" });
        return;
      case "saved-not-active":
        await host.sync(null);
        if (current(operationId)) show({ phase: "failed", reason: "saved-not-active" });
        return;
      default:
        show({ phase: "failed", reason: result.reason });
    }
  };

  const begin = (kind: "browser" | "code"): void => {
    if (disposed || !host.canMutate() || activating) return;
    const next = selection();
    if (next === null) {
      host.fail("configuration-unavailable");
      return;
    }
    const operationId = host.createOperationId();
    chosen = next;
    show(
      kind === "browser"
        ? { phase: "waiting-for-browser", operationId }
        : { phase: "awaiting-code", operationId, problem: null },
    );
    const request =
      kind === "browser"
        ? host.bridge.openRouterSignIn({ operationId, selection: next })
        : host.bridge.startOpenRouterCodeSignIn({ operationId, selection: next });
    void request
      .catch((): OpenRouterSignInResult => ({
        status: "refused",
        operationId,
        reason: "unreachable",
      }))
      .then((result) => settle(operationId, result));
  };

  const cancel = (): void => {
    const operationId = operationOf(signIn);
    if (operationId === null || signIn.phase === "completing-sign-in" || reading()) return;
    if (signIn.phase === "awaiting-code") show(IDLE);
    void host.bridge.cancelOpenRouterSignIn(operationId).catch(() => false);
  };

  const removeProgress = host.bridge.onOpenRouterSignInProgress((progress) => {
    if (!current(progress.operationId) || progress.phase !== "completing-sign-in") return;
    if (signIn.phase !== "completing-sign-in") {
      show({ phase: "completing-sign-in", operationId: progress.operationId });
    }
  });

  const removeFocus = (host.onWindowFocus ?? windowFocus)(() => {
    if (!disposed && credit === "never-paid" && host.active()) readCredit(false);
  });

  const dismiss = (): void => {
    if (signIn.phase === "failed") show(IDLE);
    else cancel();
  };

  const actions: OpenRouterSignInActions = {
    start() {
      if (signIn.phase === "idle" || signIn.phase === "failed") begin("browser");
    },
    cancel,
    dismiss,
    reopen() {
      if (signIn.phase !== "waiting-for-browser" && signIn.phase !== "awaiting-code") return;
      if (reading()) return;
      const operationId = signIn.operationId;
      void host.bridge
        .reopenOpenRouterSignIn(operationId)
        .catch(() => false)
        .then((opened) => {
          if (opened || signIn.phase !== "awaiting-code" || !current(operationId)) return;
          show({ phase: "awaiting-code", operationId, problem: "code-expired" });
        });
    },
    enterCode() {
      if (signIn.phase === "completing-sign-in" || reading()) return;
      if (signIn.phase === "awaiting-code" && signIn.problem !== "code-expired") return;
      begin("code");
    },
    useCopiedCode() {
      if (disposed || signIn.phase !== "awaiting-code" || reading()) return;
      const operationId = signIn.operationId;
      readingOperationId = operationId;
      host.publish();
      void host.bridge
        .useCopiedOpenRouterCode(operationId)
        .catch((): OpenRouterSignInResult => ({
          status: "refused",
          operationId,
          reason: "unreachable",
        }))
        .then((result) => {
          if (readingOperationId === operationId) readingOperationId = null;
          if (result.status !== "refused" || result.reason !== "unreachable") {
            void settle(operationId, result);
          } else if (current(operationId)) {
            show({ phase: "awaiting-code", operationId, problem: "unreachable" });
          }
        });
    },
    retryActivation() {
      if (signIn.phase !== "failed" || signIn.reason !== "saved-not-active") return;
      if (disposed || activating || !host.canMutate()) return;
      const next = selection();
      if (next === null) {
        host.fail("configuration-unavailable");
        return;
      }
      activating = true;
      host.publish();
      const finish = (applied: boolean): void => {
        activating = false;
        if (disposed) return;
        if (applied) signIn = IDLE;
        host.publish();
        if (applied) refreshCredit();
      };
      void host.bridge
        .applyLlmSelection(next)
        .then(
          (result) => result.status === "configured",
          () => false,
        )
        .then(async (applied) => {
          if (applied) await host.sync(next);
          return applied;
        })
        .then(finish, () => finish(false));
    },
    checkCredits: () => readCredit(false),
    addCredits() {
      void host.bridge.openOpenRouterPage("credits").catch(() => false);
    },
    openKeys() {
      void host.bridge.openOpenRouterPage("keys").catch(() => false);
    },
  };

  return {
    actions,
    view: () => ({
      signIn,
      credit: host.active() ? credit : null,
      activating,
      readingCode: reading(),
    }),
    refreshCredit,
    connectedByKey() {
      dismiss();
      refreshCredit();
    },
    reset() {
      cancel();
      if (!reading()) signIn = IDLE;
    },
    dispose() {
      cancel();
      disposed = true;
      signIn = IDLE;
      removeProgress();
      removeFocus();
    },
  };
}
