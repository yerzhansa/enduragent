import { describe, expect, it, vi } from "vitest";
import type {
  OnboardingBridge,
  OnboardingLlmConfiguration,
  OnboardingLlmSelection,
  OpenRouterSignInResult,
} from "../src/onboarding/bridge";
import {
  createOpenRouterSignIn,
  openRouterSignInBusy,
  type OpenRouterSignInView,
} from "../src/onboarding/openrouter-sign-in";
import { CUSTOM_MODEL_SELECTION } from "../src/onboarding/constants";
import { draftForProvider, type LlmSelectionDraft } from "../src/onboarding/selection";
import { openRouterTestBridge } from "./openrouter-test-bridge";

const CONFIGURATION: OnboardingLlmConfiguration = {
  schemaVersion: 1,
  catalogRevision: 11,
  providers: [
    {
      provider: "openrouter",
      defaultModel: "deepseek/deepseek-v4-flash",
      models: [{ value: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash" }],
      defaultBaseUrl: "https://openrouter.ai/api/v1",
    },
  ],
  active: null,
};

const SELECTION: OnboardingLlmSelection = {
  catalogRevision: 11,
  provider: "openrouter",
  model: "deepseek/deepseek-v4-flash",
  endpoint: { mode: "default" },
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function harness(options: { readonly draft?: LlmSelectionDraft } = {}) {
  let active = false;
  let canMutate = true;
  let operation = 0;
  let focus: (() => void) | undefined;
  const bridge = {
    ...openRouterTestBridge(),
    applyLlmSelection: vi.fn<OnboardingBridge["applyLlmSelection"]>(async () => ({
      status: "configured",
      runtimeReady: true,
    })),
  };
  const sync = vi.fn(async (selection: OnboardingLlmSelection | null) => {
    if (selection !== null) active = true;
  });
  const fail = vi.fn();
  const views: OpenRouterSignInView[] = [];
  const signIn = createOpenRouterSignIn({
    bridge,
    createOperationId: () => `op-${++operation}`,
    publish: () => views.push(signIn.view()),
    configuration: () => CONFIGURATION,
    draft: () => options.draft,
    canMutate: () => canMutate,
    active: () => active,
    sync,
    fail,
    onWindowFocus: (listener) => {
      focus = listener;
      return () => {
        focus = undefined;
      };
    },
  });
  return {
    signIn,
    bridge,
    sync,
    fail,
    views,
    view: () => signIn.view(),
    focus: () => focus?.(),
    setActive: (next: boolean) => {
      active = next;
    },
    setCanMutate: (next: boolean) => {
      canMutate = next;
    },
  };
}

describe("OpenRouter sign-in surface", () => {
  it("signs in with the catalog's default OpenRouter model and the default endpoint", async () => {
    const subject = harness();
    const pending = deferred<OpenRouterSignInResult>();
    subject.bridge.openRouterSignIn.mockReturnValueOnce(pending.promise);
    subject.signIn.actions.start();
    expect(subject.view().signIn).toEqual({ phase: "waiting-for-browser", operationId: "op-1" });
    expect(openRouterSignInBusy(subject.view())).toBe(true);
    expect(subject.bridge.openRouterSignIn).toHaveBeenCalledWith({
      operationId: "op-1",
      selection: SELECTION,
    });
    subject.bridge.emitOpenRouterProgress({ operationId: "op-1", phase: "completing-sign-in" });
    expect(subject.view().signIn).toEqual({ phase: "completing-sign-in", operationId: "op-1" });
    pending.resolve({ status: "connected", operationId: "op-1", credit: "never-paid" });
    await settle();
    expect(subject.sync).toHaveBeenCalledWith(SELECTION);
    expect(subject.view()).toEqual({
      signIn: { phase: "idle" },
      credit: "never-paid",
      activating: false,
      readingCode: false,
    });
  });

  it("keeps the selected OpenRouter model from the current draft", async () => {
    const draft = {
      ...draftForProvider(CONFIGURATION.providers[0]!, 11),
      modelChoice: CUSTOM_MODEL_SELECTION,
      customModel: "athlete/chosen-model",
    };
    const bridge = { ...openRouterTestBridge(), applyLlmSelection: vi.fn() };
    const signIn = createOpenRouterSignIn({
      bridge,
      createOperationId: () => "op-draft",
      publish: () => undefined,
      configuration: () => CONFIGURATION,
      draft: () => draft,
      canMutate: () => true,
      active: () => false,
      sync: async () => undefined,
      fail: vi.fn(),
      onWindowFocus: () => () => undefined,
    });
    signIn.actions.start();
    expect(bridge.openRouterSignIn.mock.calls[0]?.[0].selection).toMatchObject({
      model: "athlete/chosen-model",
      endpoint: { mode: "default" },
    });
    signIn.dispose();
  });

  it.each([
    ["an unfinished custom endpoint", { endpointMode: "custom", customEndpoint: "https://" }],
    ["an empty custom model", { modelChoice: CUSTOM_MODEL_SELECTION, customModel: " " }],
  ] as const)("signs in with the default endpoint despite %s in the draft", (_case, change) => {
    const subject = harness({
      draft: { ...draftForProvider(CONFIGURATION.providers[0]!, 11), ...change },
    });
    subject.signIn.actions.start();
    expect(subject.fail).not.toHaveBeenCalled();
    expect(subject.bridge.openRouterSignIn).toHaveBeenCalledWith({
      operationId: "op-1",
      selection: SELECTION,
    });
  });

  it("returns to the idle panel with no error after Cancel sign-in", async () => {
    const subject = harness();
    const pending = deferred<OpenRouterSignInResult>();
    subject.bridge.openRouterSignIn.mockReturnValueOnce(pending.promise);
    subject.bridge.cancelOpenRouterSignIn.mockImplementationOnce(async (operationId) => {
      pending.resolve({ status: "refused", operationId, reason: "cancelled" });
      return true;
    });
    subject.signIn.actions.start();
    subject.signIn.actions.cancel();
    await settle();
    expect(subject.bridge.cancelOpenRouterSignIn).toHaveBeenCalledWith("op-1");
    expect(subject.view().signIn).toEqual({ phase: "idle" });
    expect(subject.fail).not.toHaveBeenCalled();
  });

  it("moves a waiting sign-in to code mode and ignores the replaced browser result", async () => {
    const subject = harness();
    const browser = deferred<OpenRouterSignInResult>();
    subject.bridge.openRouterSignIn.mockReturnValueOnce(browser.promise);
    subject.signIn.actions.start();
    subject.signIn.actions.enterCode();
    await settle();
    expect(subject.bridge.startOpenRouterCodeSignIn).toHaveBeenCalledWith({
      operationId: "op-2",
      selection: SELECTION,
    });
    expect(subject.view().signIn).toEqual({
      phase: "awaiting-code",
      operationId: "op-2",
      problem: null,
    });
    browser.resolve({ status: "refused", operationId: "op-1", reason: "cancelled" });
    await settle();
    expect(subject.view().signIn).toMatchObject({ phase: "awaiting-code", operationId: "op-2" });
    subject.signIn.actions.reopen();
    expect(subject.bridge.reopenOpenRouterSignIn).toHaveBeenCalledWith("op-2");
  });

  it.each([
    ["clipboard-no-code", "clipboard-no-code"],
    ["clipboard-unavailable", "clipboard-unavailable"],
    ["code-expired", "code-expired"],
  ] as const)("keeps the code panel open for %s", async (reason, problem) => {
    const subject = harness();
    subject.signIn.actions.enterCode();
    await settle();
    subject.bridge.useCopiedOpenRouterCode.mockResolvedValueOnce({
      status: "refused",
      operationId: "op-1",
      reason,
    });
    subject.signIn.actions.useCopiedCode();
    await settle();
    expect(subject.view().signIn).toEqual({ phase: "awaiting-code", operationId: "op-1", problem });
  });

  it("keeps the code attempt open when OpenRouter does not answer the copied code", async () => {
    const subject = harness();
    subject.signIn.actions.enterCode();
    await settle();
    subject.bridge.useCopiedOpenRouterCode.mockResolvedValueOnce({
      status: "refused",
      operationId: "op-1",
      reason: "unreachable",
    });
    subject.signIn.actions.useCopiedCode();
    await settle();
    expect(subject.view().signIn).toEqual({
      phase: "awaiting-code",
      operationId: "op-1",
      problem: "unreachable",
    });
    subject.signIn.actions.useCopiedCode();
    await settle();
    expect(subject.bridge.useCopiedOpenRouterCode).toHaveBeenLastCalledWith("op-1");
    expect(subject.view()).toMatchObject({ signIn: { phase: "idle" }, credit: "paid" });
  });

  it("does not cancel or replace a code attempt while main reads the copied code", async () => {
    const subject = harness();
    subject.signIn.actions.enterCode();
    await settle();
    const read = deferred<OpenRouterSignInResult>();
    subject.bridge.useCopiedOpenRouterCode.mockReturnValueOnce(read.promise);
    subject.signIn.actions.useCopiedCode();
    expect(subject.view().readingCode).toBe(true);
    expect(openRouterSignInBusy(subject.view())).toBe(true);
    subject.signIn.actions.cancel();
    subject.signIn.actions.dismiss();
    subject.signIn.actions.enterCode();
    subject.signIn.actions.reopen();
    expect(subject.bridge.cancelOpenRouterSignIn).not.toHaveBeenCalled();
    expect(subject.bridge.startOpenRouterCodeSignIn).toHaveBeenCalledOnce();
    expect(subject.bridge.reopenOpenRouterSignIn).not.toHaveBeenCalled();
    expect(subject.view().signIn).toMatchObject({ phase: "awaiting-code", operationId: "op-1" });
    read.resolve({ status: "connected", operationId: "op-1", credit: "paid" });
    await settle();
    expect(subject.sync).toHaveBeenCalledWith(SELECTION);
    expect(subject.view()).toMatchObject({ signIn: { phase: "idle" }, readingCode: false });
  });

  it("lets a new code attempt use its copied code while an older read is still pending", async () => {
    const subject = harness();
    subject.signIn.actions.enterCode();
    await settle();
    const stale = deferred<OpenRouterSignInResult>();
    subject.bridge.useCopiedOpenRouterCode.mockReturnValueOnce(stale.promise);
    subject.signIn.actions.useCopiedCode();
    subject.signIn.reset();
    subject.signIn.actions.enterCode();
    await settle();
    expect(subject.view()).toMatchObject({
      signIn: { phase: "awaiting-code", operationId: "op-2" },
      readingCode: false,
    });
    subject.signIn.actions.useCopiedCode();
    expect(subject.bridge.useCopiedOpenRouterCode).toHaveBeenLastCalledWith("op-2");
    stale.resolve({ status: "connected", operationId: "op-1", credit: "paid" });
    await settle();
    expect(subject.view().signIn).toMatchObject({ phase: "idle" });
  });

  it("ignores a second Enter a code instead while the first code attempt is open", async () => {
    const subject = harness();
    subject.signIn.actions.enterCode();
    subject.signIn.actions.enterCode();
    await settle();
    expect(subject.bridge.startOpenRouterCodeSignIn).toHaveBeenCalledOnce();
    expect(subject.view().signIn).toMatchObject({ operationId: "op-1", problem: null });
  });

  it("shows Get a new code when main no longer holds the code attempt to reopen", async () => {
    const subject = harness();
    subject.signIn.actions.enterCode();
    await settle();
    subject.bridge.reopenOpenRouterSignIn.mockResolvedValueOnce(false);
    subject.signIn.actions.reopen();
    await settle();
    expect(subject.view().signIn).toEqual({
      phase: "awaiting-code",
      operationId: "op-1",
      problem: "code-expired",
    });

    subject.bridge.openRouterSignIn.mockReturnValueOnce(new Promise(() => undefined));
    subject.signIn.reset();
    subject.signIn.actions.start();
    subject.bridge.reopenOpenRouterSignIn.mockResolvedValueOnce(false);
    subject.signIn.actions.reopen();
    await settle();
    expect(subject.view().signIn).toEqual({ phase: "waiting-for-browser", operationId: "op-2" });
  });

  it("starts a fresh code attempt from Get a new code and connects with the copied code", async () => {
    const subject = harness();
    subject.signIn.actions.enterCode();
    await settle();
    subject.bridge.useCopiedOpenRouterCode.mockResolvedValueOnce({
      status: "refused",
      operationId: "op-1",
      reason: "code-expired",
    });
    subject.signIn.actions.useCopiedCode();
    await settle();
    subject.signIn.actions.enterCode();
    await settle();
    expect(subject.view().signIn).toMatchObject({ operationId: "op-2", problem: null });
    subject.signIn.actions.useCopiedCode();
    subject.signIn.actions.useCopiedCode();
    await settle();
    expect(subject.bridge.useCopiedOpenRouterCode).toHaveBeenCalledTimes(2);
    expect(subject.bridge.useCopiedOpenRouterCode).toHaveBeenLastCalledWith("op-2");
    expect(subject.sync).toHaveBeenCalledWith(SELECTION);
    expect(subject.view()).toMatchObject({ signIn: { phase: "idle" }, credit: "paid" });
  });

  it.each([
    ["not-finished", "not-finished"],
    ["already-in-progress", "not-finished"],
    ["unreachable", "unreachable"],
    ["not-saved", "not-saved"],
    ["saved-not-active", "saved-not-active"],
  ] as const)("shows the %s refusal as a %s failure", async (reason, failure) => {
    const subject = harness();
    subject.bridge.openRouterSignIn.mockResolvedValueOnce({
      status: "refused",
      operationId: "op-1",
      reason,
    });
    subject.signIn.actions.start();
    await settle();
    expect(subject.view().signIn).toEqual({ phase: "failed", reason: failure });
    expect(subject.sync).toHaveBeenCalledTimes(reason === "saved-not-active" ? 1 : 0);
    subject.signIn.actions.dismiss();
    expect(subject.view().signIn).toEqual({ phase: "idle" });
  });

  it("treats a rejected bridge call as OpenRouter not answering", async () => {
    const subject = harness();
    subject.bridge.openRouterSignIn.mockRejectedValueOnce(new TypeError());
    subject.signIn.actions.start();
    await settle();
    expect(subject.view().signIn).toEqual({ phase: "failed", reason: "unreachable" });
  });

  it("reports a stale selection through the setup error instead of a sign-in failure", async () => {
    const subject = harness();
    subject.bridge.openRouterSignIn.mockResolvedValueOnce({
      status: "refused",
      operationId: "op-1",
      reason: "invalid-input",
    });
    subject.signIn.actions.start();
    await settle();
    expect(subject.fail).toHaveBeenCalledWith("configuration-unavailable");
    expect(subject.view().signIn).toEqual({ phase: "idle" });
  });

  it("retries activation with the saved key and reads the credit status afterwards", async () => {
    const subject = harness();
    subject.bridge.openRouterSignIn.mockResolvedValueOnce({
      status: "refused",
      operationId: "op-1",
      reason: "saved-not-active",
    });
    subject.signIn.actions.start();
    await settle();
    subject.bridge.openRouterCreditStatus.mockResolvedValueOnce("never-paid");
    subject.signIn.actions.retryActivation();
    expect(subject.view().activating).toBe(true);
    expect(subject.bridge.openRouterSignIn).toHaveBeenCalledOnce();
    await settle();
    expect(subject.bridge.applyLlmSelection).toHaveBeenCalledWith(SELECTION);
    expect(subject.sync).toHaveBeenLastCalledWith(SELECTION);
    expect(subject.view()).toEqual({
      signIn: { phase: "idle" },
      credit: "never-paid",
      activating: false,
      readingCode: false,
    });
  });

  it("re-enables the panel when refreshing setup after a retried activation fails", async () => {
    const subject = harness();
    subject.bridge.openRouterSignIn.mockResolvedValueOnce({
      status: "refused",
      operationId: "op-1",
      reason: "saved-not-active",
    });
    subject.signIn.actions.start();
    await settle();
    subject.sync.mockRejectedValueOnce(new TypeError());
    const published = subject.views.length;
    subject.signIn.actions.retryActivation();
    await settle();
    expect(subject.view()).toMatchObject({
      signIn: { phase: "failed", reason: "saved-not-active" },
      activating: false,
    });
    expect(subject.views.at(-1)?.activating).toBe(false);
    expect(subject.views.length).toBeGreaterThan(published + 1);
    expect(openRouterSignInBusy(subject.view())).toBe(false);
  });

  it("stays on the activation failure when the retry is refused", async () => {
    const subject = harness();
    subject.bridge.openRouterSignIn.mockResolvedValueOnce({
      status: "refused",
      operationId: "op-1",
      reason: "saved-not-active",
    });
    subject.signIn.actions.start();
    await settle();
    subject.bridge.applyLlmSelection.mockResolvedValueOnce({
      status: "refused",
      reason: "runtime-unavailable",
    });
    subject.signIn.actions.retryActivation();
    await settle();
    expect(subject.view()).toMatchObject({
      signIn: { phase: "failed", reason: "saved-not-active" },
      activating: false,
    });
  });

  it("reads credits only while OpenRouter is active and re-reads a never-paid account on focus", async () => {
    const subject = harness();
    subject.signIn.refreshCredit();
    expect(subject.bridge.openRouterCreditStatus).not.toHaveBeenCalled();
    subject.setActive(true);
    subject.bridge.openRouterCreditStatus.mockResolvedValueOnce("never-paid");
    subject.signIn.refreshCredit();
    await settle();
    expect(subject.view().credit).toBe("never-paid");
    subject.bridge.openRouterCreditStatus.mockResolvedValueOnce("paid");
    subject.focus();
    await settle();
    expect(subject.bridge.openRouterCreditStatus).toHaveBeenCalledTimes(2);
    expect(subject.view().credit).toBe("paid");
    subject.focus();
    await settle();
    expect(subject.bridge.openRouterCreditStatus).toHaveBeenCalledTimes(2);
    subject.setActive(false);
    expect(subject.view().credit).toBeNull();
  });

  it("forgets the credit of the previous key before reading the new one", async () => {
    const subject = harness();
    subject.setActive(true);
    subject.bridge.openRouterCreditStatus.mockResolvedValueOnce("never-paid");
    subject.signIn.refreshCredit();
    await settle();
    expect(subject.view().credit).toBe("never-paid");

    const recheck = deferred<"never-paid" | "paid" | "unknown">();
    subject.bridge.openRouterCreditStatus.mockReturnValueOnce(recheck.promise);
    subject.signIn.actions.checkCredits();
    expect(subject.view().credit).toBe("never-paid");
    recheck.resolve("never-paid");
    await settle();

    const fresh = deferred<"never-paid" | "paid" | "unknown">();
    subject.bridge.openRouterCreditStatus.mockReturnValueOnce(fresh.promise);
    subject.signIn.refreshCredit();
    expect(subject.view().credit).toBeNull();
    expect(subject.views.at(-1)?.credit).toBeNull();
    fresh.resolve("paid");
    await settle();
    expect(subject.view().credit).toBe("paid");
  });

  it("drops a stale sign-in state and re-reads credits when a key connects OpenRouter", async () => {
    const subject = harness();
    subject.signIn.actions.enterCode();
    await settle();
    subject.setActive(true);
    subject.bridge.openRouterCreditStatus.mockResolvedValueOnce("never-paid");
    subject.signIn.connectedByKey();
    expect(subject.bridge.cancelOpenRouterSignIn).toHaveBeenCalledWith("op-1");
    expect(subject.view().signIn).toEqual({ phase: "idle" });
    await settle();
    expect(subject.view().credit).toBe("never-paid");

    subject.bridge.openRouterSignIn.mockResolvedValueOnce({
      status: "refused",
      operationId: "op-2",
      reason: "saved-not-active",
    });
    subject.signIn.actions.start();
    await settle();
    subject.signIn.connectedByKey();
    expect(subject.view().signIn).toEqual({ phase: "idle" });
  });

  it("opens the fixed OpenRouter pages by name", () => {
    const subject = harness();
    subject.signIn.actions.addCredits();
    subject.signIn.actions.openKeys();
    expect(subject.bridge.openOpenRouterPage.mock.calls).toEqual([["credits"], ["keys"]]);
  });

  it("does nothing while setup mutations are blocked and cancels on dispose", async () => {
    const subject = harness();
    subject.setCanMutate(false);
    subject.signIn.actions.start();
    expect(subject.bridge.openRouterSignIn).not.toHaveBeenCalled();
    subject.setCanMutate(true);
    subject.bridge.openRouterSignIn.mockReturnValueOnce(new Promise(() => undefined));
    subject.signIn.actions.start();
    subject.signIn.dispose();
    expect(subject.bridge.cancelOpenRouterSignIn).toHaveBeenCalledWith("op-1");
    expect(subject.view().signIn).toEqual({ phase: "idle" });
  });
});
