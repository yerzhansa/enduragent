import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ONBOARDING_STATUS_COLD_START_TIMEOUT_MS,
  ONBOARDING_STATUS_RETRY_BASE_DELAY_MS,
} from "../src/onboarding/status-read";
import { useEnduragentStore } from "../src/state/store";
import {
  chooseLane,
  mountWizard,
  panel,
  resetOnboardingStore,
  rowState,
  testBridge,
} from "./onboarding-harness";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function manualPaintScheduler(): {
  readonly schedule: (callback: () => void) => () => void;
  runNext(): void;
} {
  const pending: Array<{ callback: () => void; cancelled: boolean }> = [];
  return {
    schedule(callback) {
      const entry = { callback, cancelled: false };
      pending.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    runNext() {
      const entry = pending.shift();
      if (entry === undefined) throw new Error("No activation is waiting for a paint boundary");
      if (!entry.cancelled) entry.callback();
    },
  };
}

function expectChatGptPhase(phase: string, copy: string): void {
  const status = panel("chatgpt")?.querySelector<HTMLElement>("[data-chatgpt-phase]");
  expect(status?.dataset.chatgptPhase).toBe(phase);
  expect(status?.textContent).toContain(copy);
}

async function flushAsyncWork(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("ChatGPT onboarding lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetOnboardingStore();
  });

  it("does not restore transient Ready copy when setup opens with ChatGPT ready", async () => {
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    const wizard = mountWizard({ bridge });

    await wizard.open();

    expect(rowState("ai")).toBe("ready");
    expect(document.querySelector(".onboarding-action-status")).toBeNull();
    wizard.controller.dispose();
  });

  it("restores Signed in copy when setup opens before ChatGPT activation", async () => {
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.chatGptStatus.mockResolvedValue({ state: "configured", runtimeReady: false });
    const wizard = mountWizard({ bridge });

    await wizard.open();

    expectChatGptPhase("signed-in", "Signed in");
    wizard.controller.dispose();
  });

  it("renders every phase inside the ChatGPT row", async () => {
    const login = deferred<void>();
    const activation = deferred<void>();
    const paint = manualPaintScheduler();
    const bridge = testBridge(async () => {
      await login.promise;
      return { status: "configured", runtimeReady: true };
    });
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.applyLlmSelection.mockImplementation(async () => {
      await activation.promise;
      return { status: "configured", runtimeReady: true };
    });
    const wizard = mountWizard({
      bridge,
      createOperationId: () => "login-phase-operation",
      afterPaint: paint.schedule,
    });
    const user = userEvent.setup();
    await wizard.open();
    await chooseLane(user, "openai-codex");

    act(() => {
      wizard.controller.startChatGptLogin();
    });
    expectChatGptPhase("waiting-for-browser", "Waiting for browser…");

    act(() => {
      bridge.emitChatGptProgress({
        operationId: "login-phase-operation",
        phase: "waiting-for-browser",
      });
    });
    expectChatGptPhase("waiting-for-browser", "Waiting for browser…");

    act(() => {
      bridge.emitChatGptProgress({
        operationId: "login-phase-operation",
        phase: "completing-sign-in",
      });
    });
    expectChatGptPhase("completing-sign-in", "Completing sign-in…");

    login.resolve(undefined);
    await flushAsyncWork();
    expectChatGptPhase("signed-in", "Signed in");
    expect(bridge.applyLlmSelection).not.toHaveBeenCalled();

    act(() => {
      paint.runNext();
    });
    expectChatGptPhase("activating-coach", "Activating coach…");

    activation.resolve(undefined);
    await flushAsyncWork();
    expect(rowState("ai")).toBe("ready");
    expect(panel("chatgpt")).toBeNull();
    wizard.controller.dispose();
  });

  it("cancels the matching operation and ignores its late progress and result", async () => {
    const firstLogin = deferred<void>();
    const secondLogin = deferred<void>();
    const cancelAck = deferred<{
      readonly status: "cancelling";
      readonly operationId: string;
    }>();
    let loginCount = 0;
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.chatGptLogin.mockImplementation(async ({ operationId }) => {
      loginCount += 1;
      await (loginCount === 1 ? firstLogin.promise : secondLogin.promise);
      return { status: "stored", operationId };
    });
    bridge.cancelChatGptLogin.mockImplementation(() => cancelAck.promise);
    const operationIds = ["cancelled-operation", "current-operation"];
    const wizard = mountWizard({
      bridge,
      createOperationId: () => operationIds.shift() ?? "unexpected-operation",
    });
    const user = userEvent.setup();
    await wizard.open();
    await chooseLane(user, "openai-codex");
    act(() => {
      wizard.controller.startChatGptLogin();
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    expect(bridge.cancelChatGptLogin).toHaveBeenCalledOnce();
    expect(bridge.cancelChatGptLogin).toHaveBeenCalledWith("cancelled-operation");

    act(() => {
      wizard.controller.close();
    });
    await wizard.open();
    act(() => {
      wizard.controller.selectProvider("openai-codex");
      wizard.controller.startChatGptLogin();
    });
    expect(wizard.controller.state()).toMatchObject({
      chatGptOperationId: "current-operation",
      chatGptLoginPhase: "waiting-for-browser",
      chatGptCredentialState: "absent",
    });

    act(() => {
      bridge.emitChatGptProgress({
        operationId: "cancelled-operation",
        phase: "completing-sign-in",
      });
    });
    expect(wizard.controller.state()).toMatchObject({
      chatGptOperationId: "current-operation",
      chatGptLoginPhase: "waiting-for-browser",
    });

    firstLogin.resolve(undefined);
    await flushAsyncWork();
    expect(wizard.controller.state()).toMatchObject({
      chatGptOperationId: "current-operation",
      chatGptLoginPhase: "waiting-for-browser",
      chatGptCredentialState: "absent",
    });
    expect(bridge.applyLlmSelection).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });

  it("retries activation without starting OAuth again", async () => {
    const paint = manualPaintScheduler();
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.applyLlmSelection
      .mockResolvedValueOnce({ status: "refused", reason: "runtime-unavailable" })
      .mockResolvedValueOnce({ status: "configured", runtimeReady: true });
    const wizard = mountWizard({
      bridge,
      createOperationId: () => "single-oauth-operation",
      afterPaint: paint.schedule,
    });
    const user = userEvent.setup();
    await wizard.open();
    await chooseLane(user, "openai-codex");

    fireEvent.click(screen.getByRole("button", { name: "Sign in with ChatGPT" }));
    await flushAsyncWork();
    expectChatGptPhase("signed-in", "Signed in");
    expect(bridge.chatGptLogin).toHaveBeenCalledOnce();

    act(() => {
      paint.runNext();
    });
    await flushAsyncWork();
    expect(wizard.controller.state().chatGptRuntimeState).toBe("failed");
    expect(screen.getByRole("button", { name: "Retry activation" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Retry activation" }));
    await flushAsyncWork();
    expect(bridge.applyLlmSelection).toHaveBeenCalledTimes(2);
    expect(bridge.chatGptLogin).toHaveBeenCalledOnce();
    expect(wizard.controller.state().chatGptRuntimeState).toBe("ready");
    expect(rowState("ai")).toBe("ready");
    wizard.controller.dispose();
  });

  it("accepts a stored-profile activation response just after the main deadline", async () => {
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.chatGptStatus.mockResolvedValue({ state: "configured", runtimeReady: false });
    bridge.applyLlmSelection.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () => resolve({ status: "configured" as const, runtimeReady: true as const }),
            10_001,
          );
        }),
    );
    const wizard = mountWizard({ bridge });
    await wizard.open();

    vi.useFakeTimers();
    act(() => {
      wizard.controller.selectProvider("openai-codex");
    });
    expect(wizard.controller.state().chatGptRuntimeState).toBe("activating");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_001);
    });

    expect(wizard.controller.state().chatGptRuntimeState).toBe("ready");
    expect(rowState("ai")).toBe("ready");
    expect(bridge.applyLlmSelection).toHaveBeenCalledOnce();
    expect(bridge.chatGptLogin).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });

  it("does not let a pre-login status result overwrite a later Stored and Ready state", async () => {
    vi.useFakeTimers();
    const staleStatus = deferred<{ readonly state: "absent"; readonly runtimeReady: false }>();
    const paint = manualPaintScheduler();
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.chatGptStatus
      .mockImplementationOnce(() => staleStatus.promise)
      .mockResolvedValue({ state: "absent", runtimeReady: false });
    const wizard = mountWizard({
      bridge,
      createOperationId: () => "status-race-operation",
      afterPaint: paint.schedule,
    });

    await act(async () => {
      const opening = wizard.controller.open();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(
        ONBOARDING_STATUS_COLD_START_TIMEOUT_MS + ONBOARDING_STATUS_RETRY_BASE_DELAY_MS,
      );
      await opening;
    });
    expect(wizard.controller.state().chatGptCredentialState).toBe("absent");
    expect(bridge.chatGptStatus).toHaveBeenCalledTimes(2);
    expect(useEnduragentStore.getState().onboarding.loadUnavailable).toBe(false);

    await act(async () => {
      wizard.controller.startChatGptLogin();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(wizard.controller.state().chatGptCredentialState).toBe("stored");
    expectChatGptPhase("signed-in", "Signed in");

    act(() => {
      paint.runNext();
    });
    await flushAsyncWork();
    expect(wizard.controller.state()).toMatchObject({
      chatGptCredentialState: "stored",
      chatGptRuntimeState: "ready",
    });

    staleStatus.resolve({ state: "absent", runtimeReady: false });
    await flushAsyncWork();
    expect(wizard.controller.state()).toMatchObject({
      chatGptCredentialState: "stored",
      chatGptRuntimeState: "ready",
    });
    expect(rowState("ai")).toBe("ready");
    wizard.controller.dispose();
  });
});
