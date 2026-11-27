import { act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { ClaudeCliStatus } from "../src/onboarding/machine";
import { useEnduragentStore } from "../src/state/store";
import { IDLE_MANUAL_SYNC } from "../src/state/sync-slice";
import { SyncChip } from "../src/ui/sidebar/SyncChip";
import { renderWithLanguage } from "./language-harness";
import { mountWizard, resetOnboardingStore, testBridge } from "./onboarding-harness";

describe("repro onboarding G13b: sidebar Sign in again while Setup is busy", () => {
  afterEach(() => {
    resetOnboardingStore();
    useEnduragentStore.setState({ activeView: "chat", intervalsSignInRejected: false });
  });

  it("does not turn Sign in again into a silent jump to Settings while Setup is busy", async () => {
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.credentialStatuses.mockResolvedValue([
      { slot: "intervals-icu", state: "configured", runtimeState: "active" },
    ]);
    bridge.llmConfiguration.mockResolvedValue({
      schemaVersion: 1,
      catalogRevision: 7,
      providers: [
        {
          provider: "anthropic",
          defaultModel: "claude-sonnet-4-6",
          models: [{ value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" }],
        },
        {
          provider: "claude-cli",
          defaultModel: "sonnet",
          models: [{ value: "sonnet", label: "Claude Sonnet" }],
        },
      ],
      active: null,
    });
    bridge.claudeCliStatus.mockReturnValue(new Promise<ClaudeCliStatus>(() => {}));
    const wizard = mountWizard({ bridge, placement: "settings" });
    await wizard.open();
    useEnduragentStore.setState({
      activeView: "chat",
      sync: IDLE_MANUAL_SYNC,
      intervalsSignInRejected: true,
    });
    await renderWithLanguage(<SyncChip />);

    act(() => wizard.controller.selectProvider("claude-cli"));
    await waitFor(() => expect(useEnduragentStore.getState().onboarding.wizard.busy).toBe(true));

    const signInAgain = document.querySelector<HTMLButtonElement>("[data-sync-sign-in-again]");
    if (signInAgain === null) throw new Error("sidebar Sign in again is not shown");
    const user = userEvent.setup();
    await user.click(signInAgain);

    const clickedThrough = useEnduragentStore.getState().activeView === "settings";
    const started = bridge.signInWithIntervals.mock.calls.length > 0;
    console.info(`G13b: offered while blocked: ${String(!signInAgain.disabled)}`);
    expect({
      openedSettings: clickedThrough,
      signInStarted: started,
    }).toEqual({ openedSettings: clickedThrough, signInStarted: clickedThrough });
    wizard.controller.dispose();
  });
});
