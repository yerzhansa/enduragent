import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { IntervalsCredentialMutationResult } from "../src/onboarding/bridge";
import { useEnduragentStore } from "../src/state/store";
import {
  errorText,
  mountWizard,
  openTrainingPanel,
  panel,
  panelButton,
  resetOnboardingStore,
  rowState,
  rowSubtitle,
  testBridge,
  type MountedWizard,
  type TestBridge,
  type UserEvent,
} from "./onboarding-harness";

const SIGN_IN = "Sign in with Intervals.icu";
const WAITING = "Waiting for browser…";
const COMPLETING = "Completing sign-in…";
const CANCEL_SIGN_IN = "Cancel sign-in";
const REOPEN = "Open the sign-in page again";
const IDLE_HINT =
  "Opens Intervals.icu in your browser. You approve access there, and Enduragent never sees your password.";
const WAITING_HINT = "Finish in your browser. Enduragent carries on by itself once you approve.";
const COMPLETING_HINT = "Approved. Saving the connection on this Mac…";

const MISSING = { slot: "intervals-icu", state: "missing", runtimeState: null } as const;
const ACTIVE = { slot: "intervals-icu", state: "configured", runtimeState: "active" } as const;

interface PendingSignIn {
  readonly promise: Promise<IntervalsCredentialMutationResult>;
  resolve(result: IntervalsCredentialMutationResult): void;
}

function pendingSignIn(): PendingSignIn {
  const settle: { resolve?: (result: IntervalsCredentialMutationResult) => void } = {};
  const promise = new Promise<IntervalsCredentialMutationResult>((resolve) => {
    settle.resolve = resolve;
  });
  return {
    promise,
    resolve(result) {
      settle.resolve?.(result);
    },
  };
}

function signInBridge(): { readonly bridge: TestBridge; readonly signIn: PendingSignIn } {
  const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
  bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
  const signIn = pendingSignIn();
  bridge.signInWithIntervals.mockImplementation(() => signIn.promise);
  return { bridge, signIn };
}

function trainingPanel(): HTMLElement {
  const host = panel("training");
  if (host === null) throw new Error("Training panel is not open");
  return host;
}

function buttonNames(): readonly string[] {
  return Array.from(trainingPanel().querySelectorAll("button"), (entry) => entry.textContent ?? "");
}

function signInPhase(): string {
  return useEnduragentStore.getState().onboarding.intervalsSignIn.phase;
}

async function startSignIn(user: UserEvent, bridge: TestBridge): Promise<void> {
  await openTrainingPanel(user);
  await user.click(panelButton("training", SIGN_IN));
  await waitFor(() => {
    expect(bridge.signInWithIntervals).toHaveBeenCalledOnce();
  });
  expect(signInPhase()).toBe("waiting-for-browser");
}

async function settle(
  wizard: MountedWizard,
  signIn: PendingSignIn,
  result: IntervalsCredentialMutationResult,
): Promise<void> {
  signIn.resolve(result);
  await waitFor(() => {
    expect(wizard.controller.state().busy).toBe(false);
  });
}

describe("Intervals.icu sign-in panel", () => {
  afterEach(() => {
    resetOnboardingStore();
  });

  it.each(["gate", "settings"] as const)(
    "offers sign-in, Cancel and ride import while idle (%s)",
    async (placement) => {
      const user = userEvent.setup();
      const { bridge } = signInBridge();
      const wizard = mountWizard({ bridge, placement });
      await wizard.open();

      await openTrainingPanel(user);

      expect(signInPhase()).toBe("idle");
      expect(buttonNames()).toEqual(["Cancel", SIGN_IN, "Import ride files instead"]);
      expect(panelButton("training", "Cancel Intervals.icu setup")).toBeEnabled();
      expect(panelButton("training", SIGN_IN)).toBeEnabled();
      expect(panelButton("training", "Import ride files instead")).toBeEnabled();
      expect(trainingPanel()).toHaveTextContent(IDLE_HINT);
      expect(bridge.signInWithIntervals).not.toHaveBeenCalled();
      wizard.controller.dispose();
    },
  );

  it.each(["gate", "settings"] as const)(
    "waits for the browser with Cancel sign-in and reopen controls (%s)",
    async (placement) => {
      const user = userEvent.setup();
      const { bridge, signIn } = signInBridge();
      const wizard = mountWizard({ bridge, placement });
      await wizard.open();

      await startSignIn(user, bridge);

      expect(buttonNames()).toEqual([CANCEL_SIGN_IN, WAITING, REOPEN]);
      expect(panelButton("training", CANCEL_SIGN_IN)).toBeEnabled();
      expect(panelButton("training", WAITING)).toBeDisabled();
      expect(panelButton("training", REOPEN)).toBeEnabled();
      expect(trainingPanel()).toHaveTextContent(WAITING_HINT);
      expect(bridge.signInWithIntervals.mock.calls[0]).toEqual([]);
      expect(bridge.writeCredential).not.toHaveBeenCalled();

      await settle(wizard, signIn, {
        outcome: "refused",
        reason: "sign-in-cancelled",
        current: MISSING,
      });
      wizard.controller.dispose();
    },
  );

  it("moves to completing when the browser approval arrives", async () => {
    const user = userEvent.setup();
    const { bridge, signIn } = signInBridge();
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await startSignIn(user, bridge);

    act(() => {
      bridge.emitIntervalsSignInProgress("completing-sign-in");
    });

    expect(signInPhase()).toBe("completing-sign-in");
    expect(buttonNames()).toEqual([COMPLETING]);
    expect(panelButton("training", COMPLETING)).toBeDisabled();
    expect(trainingPanel()).toHaveTextContent(COMPLETING_HINT);

    await settle(wizard, signIn, { outcome: "applied", current: ACTIVE });
    expect(rowState("training")).toBe("ready");
    expect(signInPhase()).toBe("idle");
    wizard.controller.dispose();
  });

  it("ignores sign-in progress when no sign-in is running", async () => {
    const user = userEvent.setup();
    const { bridge } = signInBridge();
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openTrainingPanel(user);

    act(() => {
      bridge.emitIntervalsSignInProgress("completing-sign-in");
    });

    expect(signInPhase()).toBe("idle");
    expect(buttonNames()).toEqual(["Cancel", SIGN_IN, "Import ride files instead"]);
    wizard.controller.dispose();
  });

  it("cancels a waiting sign-in and returns to idle without an error", async () => {
    const user = userEvent.setup();
    const { bridge, signIn } = signInBridge();
    bridge.cancelIntervalsSignIn.mockImplementation(async () => {
      signIn.resolve({ outcome: "refused", reason: "sign-in-cancelled", current: MISSING });
      return true;
    });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await startSignIn(user, bridge);

    await user.click(panelButton("training", CANCEL_SIGN_IN));

    expect(bridge.cancelIntervalsSignIn).toHaveBeenCalledOnce();
    expect(bridge.cancelIntervalsSignIn.mock.calls[0]).toEqual([]);
    await waitFor(() => {
      expect(signInPhase()).toBe("idle");
    });
    expect(wizard.controller.state().busy).toBe(false);
    expect(wizard.controller.state().fixedError).toBeNull();
    expect(errorText()).toBe("");
    expect(buttonNames()).toEqual(["Cancel", SIGN_IN, "Import ride files instead"]);
    expect(panelButton("training", SIGN_IN)).toBeEnabled();
    expect(rowState("training")).toBe("pending");
    expect(bridge.reopenIntervalsSignIn).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });

  it("clears an earlier sign-in error when the next sign-in is cancelled", async () => {
    const user = userEvent.setup();
    const { bridge } = signInBridge();
    bridge.signInWithIntervals
      .mockResolvedValueOnce({ outcome: "refused", reason: "sign-in-timed-out", current: MISSING })
      .mockResolvedValueOnce({ outcome: "refused", reason: "sign-in-cancelled", current: MISSING });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openTrainingPanel(user);

    await user.click(panelButton("training", SIGN_IN));
    await waitFor(() => {
      expect(errorText()).toBe(
        "Sign-in timed out after 5 minutes. Sign in again when you’re ready.",
      );
    });

    await user.click(panelButton("training", SIGN_IN));
    await waitFor(() => {
      expect(bridge.signInWithIntervals).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(wizard.controller.state().busy).toBe(false);
    });
    expect(wizard.controller.state().fixedError).toBeNull();
    expect(errorText()).toBe("");
    expect(signInPhase()).toBe("idle");
    wizard.controller.dispose();
  });

  it("reopens the sign-in page while waiting for the browser", async () => {
    const user = userEvent.setup();
    const { bridge, signIn } = signInBridge();
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await startSignIn(user, bridge);

    await user.click(panelButton("training", REOPEN));

    expect(bridge.reopenIntervalsSignIn).toHaveBeenCalledOnce();
    expect(bridge.reopenIntervalsSignIn.mock.calls[0]).toEqual([]);
    expect(bridge.cancelIntervalsSignIn).not.toHaveBeenCalled();
    expect(bridge.signInWithIntervals).toHaveBeenCalledOnce();
    expect(signInPhase()).toBe("waiting-for-browser");
    expect(buttonNames()).toEqual([CANCEL_SIGN_IN, WAITING, REOPEN]);

    await settle(wizard, signIn, {
      outcome: "refused",
      reason: "sign-in-cancelled",
      current: MISSING,
    });
    wizard.controller.dispose();
  });

  it("ignores cancel and reopen unless a sign-in waits for the browser", async () => {
    const user = userEvent.setup();
    const { bridge, signIn } = signInBridge();
    const wizard = mountWizard({ bridge });
    await wizard.open();

    wizard.controller.cancelIntervalsSignIn();
    wizard.controller.reopenIntervalsSignIn();
    expect(bridge.cancelIntervalsSignIn).not.toHaveBeenCalled();
    expect(bridge.reopenIntervalsSignIn).not.toHaveBeenCalled();

    await startSignIn(user, bridge);
    act(() => {
      bridge.emitIntervalsSignInProgress("completing-sign-in");
    });
    wizard.controller.cancelIntervalsSignIn();
    wizard.controller.reopenIntervalsSignIn();
    expect(bridge.cancelIntervalsSignIn).not.toHaveBeenCalled();
    expect(bridge.reopenIntervalsSignIn).not.toHaveBeenCalled();

    await settle(wizard, signIn, { outcome: "applied", current: ACTIVE });
    wizard.controller.dispose();
  });

  it("explains denied access under the Intervals.icu row and offers sign-in again", async () => {
    const user = userEvent.setup();
    const { bridge, signIn } = signInBridge();
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await startSignIn(user, bridge);

    await settle(wizard, signIn, {
      outcome: "refused",
      reason: "sign-in-denied",
      current: MISSING,
    });

    expect(wizard.controller.state().fixedError).toBe("intervals-sign-in-denied");
    expect(errorText()).toBe(
      "Access wasn’t allowed on Intervals.icu. Sign in again when you’re ready.",
    );
    expect(trainingPanel().contains(document.querySelector("#onboarding-error"))).toBe(true);
    expect(signInPhase()).toBe("idle");
    expect(buttonNames()).toEqual(["Cancel", SIGN_IN, "Import ride files instead"]);
    expect(panelButton("training", SIGN_IN)).toBeEnabled();
    expect(rowState("training")).toBe("pending");
    wizard.controller.dispose();
  });

  it.each(["gate", "settings"] as const)(
    "names the connected athlete after sign-in (%s)",
    async (placement) => {
      const user = userEvent.setup();
      const { bridge, signIn } = signInBridge();
      const wizard = mountWizard({ bridge, placement });
      await wizard.open();
      await startSignIn(user, bridge);

      await settle(wizard, signIn, {
        outcome: "applied",
        current: ACTIVE,
        athleteName: "Test Athlete",
      });

      await waitFor(() => {
        expect(rowState("training")).toBe("ready");
      });
      expect(rowSubtitle("training")).toBe(
        "Connected as Test Athlete · where your rides come from",
      );
      expect(panel("training")).toBeNull();
      expect(useEnduragentStore.getState().onboarding.intervalsSignIn).toEqual({
        phase: "idle",
        athleteName: "Test Athlete",
      });
      wizard.controller.dispose();
    },
  );

  it("keeps the plain connected subtitle when the athlete name is unknown", async () => {
    const user = userEvent.setup();
    const { bridge, signIn } = signInBridge();
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await startSignIn(user, bridge);

    await settle(wizard, signIn, { outcome: "applied", current: ACTIVE });

    await waitFor(() => {
      expect(rowState("training")).toBe("ready");
    });
    expect(rowSubtitle("training")).toBe("Connected · where your rides come from");
    wizard.controller.dispose();
  });

  it("cancels a waiting sign-in when the setup surface closes", async () => {
    const user = userEvent.setup();
    const { bridge, signIn } = signInBridge();
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await startSignIn(user, bridge);

    act(() => {
      wizard.controller.close();
    });

    expect(bridge.cancelIntervalsSignIn).toHaveBeenCalledOnce();
    expect(bridge.cancelIntervalsSignIn.mock.calls[0]).toEqual([]);
    signIn.resolve({ outcome: "refused", reason: "sign-in-cancelled", current: MISSING });
    await act(async () => {
      await signIn.promise;
    });
    wizard.controller.dispose();
    expect(bridge.cancelIntervalsSignIn).toHaveBeenCalledOnce();
  });

  it("stays busy after reopening until the cancelled sign-in settles", async () => {
    const user = userEvent.setup();
    const { bridge, signIn } = signInBridge();
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await startSignIn(user, bridge);

    act(() => {
      wizard.controller.close();
    });
    await wizard.open();

    expect(signInPhase()).toBe("waiting-for-browser");
    expect(wizard.controller.state().busy).toBe(true);
    signIn.resolve({ outcome: "refused", reason: "sign-in-cancelled", current: MISSING });
    await waitFor(() => {
      expect(signInPhase()).toBe("idle");
    });
    expect(wizard.controller.state().busy).toBe(false);
    expect(wizard.controller.state().fixedError).toBeNull();
    expect(bridge.signInWithIntervals).toHaveBeenCalledOnce();
    wizard.controller.dispose();
  });

  it("shows the validation error and frees the row when the sign-in bridge rejects", async () => {
    const user = userEvent.setup();
    const { bridge } = signInBridge();
    bridge.signInWithIntervals.mockRejectedValue(new TypeError());
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openTrainingPanel(user);

    await user.click(panelButton("training", SIGN_IN));

    await waitFor(() => {
      expect(wizard.controller.state().busy).toBe(false);
    });
    expect(signInPhase()).toBe("idle");
    expect(wizard.controller.state().fixedError).toBe("intervals-validation-unavailable");
    expect(buttonNames()).toContain(SIGN_IN);
    wizard.controller.dispose();
  });

  it("applies a sign-in that finishes after setup was closed and reopened", async () => {
    const user = userEvent.setup();
    const { bridge, signIn } = signInBridge();
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await startSignIn(user, bridge);
    act(() => {
      bridge.emitIntervalsSignInProgress("completing-sign-in");
    });

    act(() => {
      wizard.controller.close();
    });
    await wizard.open();
    expect(buttonNames()).toEqual([COMPLETING]);

    signIn.resolve({ outcome: "applied", current: ACTIVE, athleteName: "Test Athlete" });

    await waitFor(() => {
      expect(rowState("training")).toBe("ready");
    });
    expect(signInPhase()).toBe("idle");
    expect(wizard.controller.state().busy).toBe(false);
    expect(wizard.controller.state().fixedError).toBeNull();
    expect(rowSubtitle("training")).toBe("Connected as Test Athlete · where your rides come from");
    wizard.controller.dispose();
  });

  it("cancels a waiting sign-in when the setup surface is disposed", async () => {
    const user = userEvent.setup();
    const { bridge } = signInBridge();
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await startSignIn(user, bridge);

    act(() => {
      wizard.controller.dispose();
    });

    expect(bridge.cancelIntervalsSignIn).toHaveBeenCalledOnce();
  });

  it("does not cancel anything when setup closes without a waiting sign-in", async () => {
    const { bridge } = signInBridge();
    const wizard = mountWizard({ bridge });
    await wizard.open();

    act(() => {
      wizard.controller.close();
    });

    expect(bridge.cancelIntervalsSignIn).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });

  describe("when the sign-in finishes but the coach cannot use it", () => {
    const FAILED = { ...ACTIVE, runtimeState: "failed" } as const;
    const NOT_WORKING_ERROR =
      "Your Intervals.icu sign-in is saved, but Enduragent couldn’t start using it. Choose Retry saved keys, or Disconnect and sign in again.";
    const RETRY = "Retry saved keys";

    async function signInThatCannotBeUsed(placement: "gate" | "settings"): Promise<MountedWizard> {
      const user = userEvent.setup();
      const { bridge, signIn } = signInBridge();
      const wizard = mountWizard({ bridge, placement });
      await wizard.open();
      await startSignIn(user, bridge);
      await settle(wizard, signIn, {
        outcome: "uncertain",
        reason: "runtime-uncertain",
        current: FAILED,
      });
      return wizard;
    }

    it.each(["gate", "settings"] as const)(
      "says the sign-in is saved but not working and names Retry saved keys (%s)",
      async (placement) => {
        const wizard = await signInThatCannotBeUsed(placement);

        expect(rowState("training")).toBe("attention");
        expect(rowSubtitle("training")).toBe("Signed in, but not working yet");
        expect(errorText()).toBe(NOT_WORKING_ERROR);
        expect(errorText()).not.toContain("Reload credential status");
        const recovery = panel("training-recovery");
        expect(recovery?.contains(document.querySelector("#onboarding-error"))).toBe(true);
        expect(screen.getByRole("button", { name: RETRY })).toBeEnabled();
        expect(
          screen.getByRole("button", { name: "Disconnect Intervals.icu" }),
        ).toBeInTheDocument();
        wizard.controller.dispose();
      },
    );

    it.each(["gate", "settings"] as const)(
      "puts keyboard focus on Retry saved keys, not Disconnect (%s)",
      async (placement) => {
        const wizard = await signInThatCannotBeUsed(placement);

        await waitFor(() => {
          expect(screen.getByRole("button", { name: RETRY })).toHaveFocus();
        });
        wizard.controller.dispose();
      },
    );
  });

  describe("when intervals.icu stops accepting the sign-in", () => {
    const REJECTED_SUBTITLE =
      "Intervals.icu stopped accepting the sign-in. Sign in again to keep syncing.";
    const SIGN_IN_AGAIN = "Sign in again";

    afterEach(() => {
      useEnduragentStore.getState().setIntervalsSignInRejected(false);
    });

    function rejectedBridge() {
      const value = signInBridge();
      value.bridge.credentialStatuses.mockResolvedValue([ACTIVE]);
      return value;
    }

    function trainingRowActions(): readonly string[] {
      return Array.from(
        document.querySelectorAll<HTMLButtonElement>('[data-setup-row="training"] button'),
        (entry) => entry,
      )
        .filter((entry) => entry.closest("[data-setup-row-title]") === null)
        .map((entry) => entry.getAttribute("aria-label") ?? entry.textContent ?? "");
    }

    it.each(["gate", "settings"] as const)(
      "shows the warning with Disconnect beside Sign in again (%s)",
      async (placement) => {
        const { bridge } = rejectedBridge();
        const wizard = mountWizard({ bridge, placement });
        await wizard.open();
        expect(rowState("training")).toBe("ready");
        expect(trainingRowActions()).toEqual(["Disconnect Intervals.icu"]);

        act(() => {
          useEnduragentStore.getState().setIntervalsSignInRejected(true);
        });

        expect(rowState("training")).toBe("attention");
        expect(
          document.querySelector('[data-setup-row="training"] [data-setup-disc="attention"]'),
        ).toHaveTextContent("!");
        expect(rowSubtitle("training")).toBe(REJECTED_SUBTITLE);
        expect(trainingRowActions()).toEqual(["Disconnect Intervals.icu", SIGN_IN_AGAIN]);
        expect(bridge.signInWithIntervals).not.toHaveBeenCalled();
        wizard.controller.dispose();
      },
    );

    it("starts the existing sign-in flow from Sign in again", async () => {
      const user = userEvent.setup();
      const { bridge, signIn } = rejectedBridge();
      const wizard = mountWizard({ bridge, placement: "settings" });
      await wizard.open();
      act(() => {
        useEnduragentStore.getState().setIntervalsSignInRejected(true);
      });

      await user.click(screen.getByRole("button", { name: SIGN_IN_AGAIN }));

      await waitFor(() => {
        expect(bridge.signInWithIntervals).toHaveBeenCalledOnce();
      });
      expect(signInPhase()).toBe("waiting-for-browser");
      expect(buttonNames()).toEqual([CANCEL_SIGN_IN, WAITING, REOPEN]);
      expect(screen.getByRole("button", { name: SIGN_IN_AGAIN })).toBeDisabled();

      signIn.resolve({ outcome: "applied", current: ACTIVE, athleteName: "Test Athlete" });
      act(() => {
        useEnduragentStore.getState().setIntervalsSignInRejected(false);
      });
      await waitFor(() => {
        expect(rowState("training")).toBe("ready");
      });
      expect(rowSubtitle("training")).toBe(
        "Connected as Test Athlete · where your rides come from",
      );
      expect(panel("training")).toBeNull();
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Disconnect Intervals.icu" })).toHaveFocus();
      });
      wizard.controller.dispose();
    });

    it("keeps the warning and shows the reason when signing in again fails", async () => {
      const user = userEvent.setup();
      const { bridge, signIn } = rejectedBridge();
      const wizard = mountWizard({ bridge });
      await wizard.open();
      act(() => {
        useEnduragentStore.getState().setIntervalsSignInRejected(true);
      });
      await user.click(screen.getByRole("button", { name: SIGN_IN_AGAIN }));
      await waitFor(() => {
        expect(signInPhase()).toBe("waiting-for-browser");
      });

      await settle(wizard, signIn, {
        outcome: "refused",
        reason: "training-account-mismatch",
        current: ACTIVE,
      });

      expect(rowState("training")).toBe("attention");
      expect(rowSubtitle("training")).toBe(REJECTED_SUBTITLE);
      expect(errorText()).not.toBe("");
      expect(screen.getByRole("button", { name: SIGN_IN_AGAIN })).toBeEnabled();
      expect(document.querySelectorAll("#onboarding-error")).toHaveLength(1);
      wizard.controller.dispose();
    });

    it.each(["gate", "settings"] as const)(
      "shows the amber row instead of Retry when the saved sign-in failed to apply (%s)",
      async (placement) => {
        const user = userEvent.setup();
        const { bridge, signIn } = signInBridge();
        const FAILED = { ...ACTIVE, runtimeState: "failed" } as const;
        bridge.credentialStatuses.mockResolvedValue([FAILED]);
        const wizard = mountWizard({ bridge, placement });
        await wizard.open();
        expect(screen.getByRole("button", { name: "Retry saved keys" })).toBeInTheDocument();

        act(() => {
          useEnduragentStore.getState().setIntervalsSignInRejected(true);
        });

        expect(rowState("training")).toBe("attention");
        expect(rowSubtitle("training")).toBe(REJECTED_SUBTITLE);
        expect(screen.queryByRole("button", { name: "Retry saved keys" })).toBeNull();
        expect(panel("training-recovery")).toBeNull();

        await user.click(screen.getByRole("button", { name: SIGN_IN_AGAIN }));
        await waitFor(() => {
          expect(bridge.signInWithIntervals).toHaveBeenCalledOnce();
        });
        expect(signInPhase()).toBe("waiting-for-browser");
        expect(bridge.retryFailedCredentials).not.toHaveBeenCalled();

        signIn.resolve({ outcome: "applied", current: ACTIVE });
        act(() => {
          useEnduragentStore.getState().setIntervalsSignInRejected(false);
        });
        await waitFor(() => {
          expect(rowState("training")).toBe("ready");
        });
        expect(screen.queryByRole("button", { name: "Retry saved keys" })).toBeNull();
        wizard.controller.dispose();
      },
    );

    it("ignores a rejected flag when nothing is connected", async () => {
      const { bridge } = signInBridge();
      const wizard = mountWizard({ bridge });
      await wizard.open();
      act(() => {
        useEnduragentStore.getState().setIntervalsSignInRejected(true);
      });

      expect(rowState("training")).toBe("pending");
      expect(screen.queryByRole("button", { name: SIGN_IN_AGAIN })).toBeNull();
      wizard.controller.dispose();
    });
  });
});
