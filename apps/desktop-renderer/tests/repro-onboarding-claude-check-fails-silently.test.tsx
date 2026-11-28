import { act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { ClaudeCliStatus } from "../src/onboarding/machine";
import { useEnduragentStore } from "../src/state/store";
import {
  chooseLane,
  claudeCliNoteText,
  errorText,
  mountWizard,
  resetOnboardingStore,
  testBridge,
} from "./onboarding-harness";

describe("repro onboarding G11a: Claude Code check fails", () => {
  afterEach(() => resetOnboardingStore());

  it("tells the athlete when the Claude Code check fails", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
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
    let fail!: (error: Error) => void;
    bridge.claudeCliStatus.mockReturnValue(
      new Promise<ClaudeCliStatus>((_resolve, reject) => {
        fail = reject;
      }),
    );
    const wizard = mountWizard({ bridge });
    await wizard.open();

    await chooseLane(user, "claude-cli");
    await waitFor(() => expect(bridge.claudeCliStatus).toHaveBeenCalledOnce());
    expect(useEnduragentStore.getState().onboarding.wizard.busy).toBe(true);

    await act(async () => fail(new Error("claude CLI status probe timed out")));

    const state = useEnduragentStore.getState().onboarding;
    console.info(
      `G11a row: ${document.querySelector('[data-setup-row="ai"]')?.textContent ?? ""}; note: ${String(claudeCliNoteText())}`,
    );
    expect({
      busy: state.wizard.busy,
      errorShown: state.wizard.fixedError !== null,
      errorText: errorText(),
    }).toEqual({ busy: false, errorShown: true, errorText: expect.stringMatching(/\S/u) });
    expect(bridge.applyLlmSelection).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });
});
