import { waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type {
  CredentialWriteResult,
  IntervalsCredentialMutationRefusalReason,
  IntervalsCredentialMutationResult,
  OnboardingCredentialWriteInput,
  OpenRouterCreditStatus,
  OpenRouterSignInResult,
} from "../src/onboarding/bridge";
import { useEnduragentStore } from "../src/state/store";
import { handoffCredential } from "../src/onboarding/credentials";
import {
  chooseLane,
  mountWizard,
  openApiKeyPanel,
  openTrainingPanel,
  panel,
  panelButton,
  passwordInput,
  resetOnboardingStore,
  rowState,
  saveModelKey,
  selectSetupOption,
  seedSecret,
  testBridge,
} from "./onboarding-harness";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

interface Transient {
  readonly slot: string;
  readonly value: string;
}

interface ExpectedIntervalsCredentialStatus {
  readonly slot: "intervals-icu";
  readonly state: "missing" | "configured" | "re-prompt";
  readonly runtimeState: "active" | "stored-inactive" | "failed" | null;
}

type ExpectedIntervalsCredentialMutationResult =
  | {
      readonly outcome: "applied";
      readonly current: ExpectedIntervalsCredentialStatus;
      readonly athleteName?: string;
    }
  | {
      readonly outcome: "refused";
      readonly reason: IntervalsCredentialMutationRefusalReason;
      readonly current: ExpectedIntervalsCredentialStatus;
    }
  | {
      readonly outcome: "saved-not-active";
      readonly current: ExpectedIntervalsCredentialStatus;
    }
  | {
      readonly outcome: "uncertain";
      readonly reason: "storage-uncertain";
      readonly current: ExpectedIntervalsCredentialStatus;
    };

type ExpectedOpenRouterSignInResult =
  | {
      readonly status: "connected";
      readonly operationId: string;
      readonly credit: OpenRouterCreditStatus;
    }
  | { readonly status: "awaiting-code"; readonly operationId: string }
  | {
      readonly status: "refused";
      readonly operationId: string;
      readonly reason:
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
    };

function domSurfaces(extra: Record<string, unknown>): Record<string, unknown> {
  const controls = Array.from(document.querySelectorAll("input, select, textarea"));
  return {
    innerHTML: document.body.innerHTML,
    outerHTML: document.body.outerHTML,
    text: document.body.textContent ?? "",
    attributes: controls.flatMap((element) =>
      Array.from(element.attributes, (attribute) => `${attribute.name}=${attribute.value}`),
    ),
    snapshot: Object.fromEntries(
      controls.map((element, index) => [String(index), element.getAttribute("value") ?? ""]),
    ),
    location: globalThis.location.href,
    browserStorage: [
      ...Object.entries({ ...localStorage }),
      ...Object.entries({ ...sessionStorage }),
    ],
    ...extra,
  };
}

describe("onboarding renderer secret boundary", () => {
  it("releases the anthropic password before the pending handoff settles", async () => {
    const slot = "anthropic";
    const sentinel = "synthetic-model-secret-sentinel";
    const input = { value: sentinel, dataset: { slot } };
    const gate = deferred();
    let transient: Transient | undefined;
    const write = async (value: OnboardingCredentialWriteInput) => {
      try {
        transient = { slot: value.slot, value: value.value };
        await gate.promise;
      } finally {
        transient = undefined;
      }
    };
    const pending = handoffCredential(input, write);
    expect(input.value).toBe("");
    expect(transient).toEqual({ slot, value: sentinel });
    gate.resolve();
    await pending;
    expect(input.value).toBe("");
    expect(transient).toBeUndefined();
    const capturedSurfaces = {
      innerHTML: "",
      outerHTML: '<input type="password">',
      text: "",
      attributes: ["type=password"],
      snapshot: { input: "" },
      location: "enduragent://app/index.html",
      console: [],
      bridgeResult: { slot, status: "configured", runtimeReady: true },
      rpc: [],
      browserStorage: [],
    };
    expect(JSON.stringify(capturedSurfaces)).not.toContain(sentinel);
  });

  it("clears the live control when the privileged handoff rejects", async () => {
    const sentinel = "synthetic-refused-secret-sentinel";
    const input = { value: sentinel, dataset: { slot: "openrouter" } };
    await expect(
      handoffCredential(input, async () => {
        throw new TypeError();
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(input.value).toBe("");
    expect(JSON.stringify(input)).not.toContain(sentinel);
  });
});

describe("mounted onboarding secret boundary", () => {
  const consoleCalls: unknown[] = [];
  const consoleSpies: Array<{ restore: () => void }> = [];

  beforeEach(() => {
    consoleCalls.splice(0);
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      const spy = vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleCalls.push(args);
      });
      consoleSpies.push({ restore: () => spy.mockRestore() });
    }
  });

  afterEach(() => {
    for (const spy of consoleSpies.splice(0)) spy.restore();
    resetOnboardingStore();
  });

  it("releases the coach-keys password before the pending write settles", async () => {
    const sentinel = "synthetic-wizard-model-secret";
    const user = userEvent.setup();
    const gate = deferred();
    const rpc: unknown[] = [];
    let transient: Transient | undefined;
    let bridgeResult: CredentialWriteResult | undefined;
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.credentialStatuses
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ slot: "anthropic", state: "configured", runtimeState: "active" }]);
    bridge.writeCredential.mockImplementation(async (value) => {
      rpc.push({ slot: value.slot, selection: value.selection });
      try {
        transient = { slot: value.slot, value: value.value };
        await gate.promise;
      } finally {
        transient = undefined;
      }
      bridgeResult = { slot: value.slot, status: "configured", runtimeReady: true };
      return bridgeResult;
    });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openApiKeyPanel(user);

    await user.type(passwordInput("anthropic"), sentinel);
    expect(passwordInput("anthropic").value).toBe(sentinel);
    await saveModelKey(user);

    await waitFor(() => {
      expect(transient).toEqual({ slot: "anthropic", value: sentinel });
    });
    expect(passwordInput("anthropic").value).toBe("");
    expect(JSON.stringify(domSurfaces({ console: consoleCalls, rpc }))).not.toContain(sentinel);

    gate.resolve();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    expect(transient).toBeUndefined();
    expect(JSON.stringify(domSurfaces({ console: consoleCalls, rpc, bridgeResult }))).not.toContain(
      sentinel,
    );
    wizard.controller.dispose();
  });

  it("uses only the closed Intervals sign-in metadata envelope", async () => {
    const user = userEvent.setup();
    const gate = deferred();
    const rpc: unknown[] = [];
    expectTypeOf<IntervalsCredentialMutationResult>().toEqualTypeOf<ExpectedIntervalsCredentialMutationResult>();
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.credentialStatuses.mockResolvedValue([
      { slot: "anthropic", state: "configured", runtimeState: "active" },
    ]);
    bridge.signInWithIntervals.mockImplementation(async (...args) => {
      rpc.push(args);
      await gate.promise;
      const result: IntervalsCredentialMutationResult = {
        outcome: "applied",
        current: { slot: "intervals-icu", state: "configured", runtimeState: "active" },
      };
      return result;
    });
    const wizard = mountWizard({ bridge });
    await wizard.open();

    await openTrainingPanel(user);
    const trainingPanel = panel("training");
    expect(trainingPanel?.querySelector('input[data-slot="intervals-icu"]')).toBeNull();
    await user.click(panelButton("training", "Sign in with Intervals.icu"));

    await waitFor(() => {
      expect(bridge.signInWithIntervals).toHaveBeenCalledOnce();
    });
    expect(bridge.signInWithIntervals.mock.calls[0]).toEqual([]);
    expect(bridge.writeCredential).not.toHaveBeenCalled();
    expect(rpc).toStrictEqual([[]]);

    gate.resolve();
    await waitFor(() => {
      expect(rowState("training")).toBe("ready");
    });
    wizard.controller.dispose();
  });

  it("signs in to OpenRouter with only an operation id and a selection crossing the bridge", async () => {
    const user = userEvent.setup();
    const rpc: unknown[] = [];
    expectTypeOf<OpenRouterSignInResult>().toEqualTypeOf<ExpectedOpenRouterSignInResult>();
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.openRouterSignIn.mockImplementation(async (input) => {
      rpc.push(input);
      bridge.credentialStatuses.mockResolvedValue([
        { slot: "openrouter", state: "configured", runtimeState: "active" },
      ]);
      return { status: "connected", operationId: input.operationId, credit: "paid" };
    });
    const wizard = mountWizard({ bridge });
    await wizard.open();

    await chooseLane(user, "openrouter");
    expect(document.querySelector('input[data-slot="openrouter"]')).toBeNull();
    await user.click(panelButton("openrouter", "Sign in with OpenRouter"));
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });

    expect(rpc).toHaveLength(1);
    expect(Object.keys(rpc[0] as object).sort()).toEqual(["operationId", "selection"]);
    expect(bridge.writeCredential).not.toHaveBeenCalled();
    expect(document.querySelector('input[data-slot="openrouter"]')).toBeNull();
    const surfaces = JSON.stringify(
      domSurfaces({ console: consoleCalls, rpc, store: useEnduragentStore.getState().onboarding }),
    );
    expect(surfaces).not.toMatch(/sk-or-/u);
    expect(surfaces).not.toMatch(/code_verifier|callback_url/u);
    wizard.controller.dispose();
  });

  it("clears the live control when the privileged write rejects", async () => {
    const sentinel = "synthetic-wizard-refused-secret";
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.writeCredential.mockRejectedValue(new TypeError());
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openApiKeyPanel(user);
    await selectSetupOption(user, "onboarding-llm-provider", "openrouter");

    await user.type(passwordInput("openrouter"), sentinel);
    await saveModelKey(user);

    await waitFor(() => {
      expect(wizard.controller.state().fixedError).toBe("credential-save-failed");
    });
    expect(passwordInput("openrouter").value).toBe("");
    expect(JSON.stringify(domSurfaces({ console: consoleCalls }))).not.toContain(sentinel);
    wizard.controller.dispose();
  });

  it("never lets a typed secret reach a value attribute or the wizard store", async () => {
    const sentinel = "synthetic-wizard-attribute-secret";
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openApiKeyPanel(user);

    await user.type(passwordInput("anthropic"), sentinel);
    await selectSetupOption(user, "onboarding-llm-provider", "openrouter");

    expect(document.querySelector('input[data-slot="anthropic"]')).toBeNull();
    expect(passwordInput("openrouter").getAttribute("value")).toBeNull();
    expect(JSON.stringify(domSurfaces({}))).not.toContain(sentinel);
    expect(JSON.stringify(wizard.controller.state())).not.toContain(sentinel);
    wizard.controller.dispose();
  });

  it("writes only the selected provider's slot when the model key is saved", async () => {
    const user = userEvent.setup();
    const modelSecret = "synthetic-scoped-model-secret";
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openApiKeyPanel(user);
    await openTrainingPanel(user);
    seedSecret("anthropic", modelSecret);

    await saveModelKey(user);

    await waitFor(() => {
      expect(bridge.writeCredential).toHaveBeenCalledOnce();
    });
    expect(bridge.writeCredential.mock.calls[0]?.[0]?.slot).toBe("anthropic");
    expect(bridge.signInWithIntervals).not.toHaveBeenCalled();
    expect(document.querySelector('input[data-slot="intervals-icu"]')).toBeNull();
    wizard.controller.dispose();
  });

  it("uses only the zero-argument sign-in port for Intervals and preserves the AI draft", async () => {
    const user = userEvent.setup();
    const modelSecret = "synthetic-scoped-model-secret-2";
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openApiKeyPanel(user);
    await openTrainingPanel(user);
    seedSecret("anthropic", modelSecret);

    await user.click(panelButton("training", "Sign in with Intervals.icu"));

    await waitFor(() => {
      expect(bridge.signInWithIntervals).toHaveBeenCalledOnce();
    });
    expect(bridge.signInWithIntervals.mock.calls[0]).toEqual([]);
    expect(bridge.writeCredential).not.toHaveBeenCalled();
    expect(document.querySelector('input[data-slot="intervals-icu"]')).toBeNull();
    expect(passwordInput("anthropic").value).toBe(modelSecret);
    wizard.controller.dispose();
  });
});
