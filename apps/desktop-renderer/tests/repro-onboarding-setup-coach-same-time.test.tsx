import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { onboardingCredentialMutationsBlocked } from "../src/state/onboarding-slice";
import type { OnboardingLlmConfiguration, OnboardingLlmSelection } from "../src/onboarding/bridge";
import {
  createProviderModelSettingsController,
  type ProviderModelSettingsController,
} from "../src/settings/provider-model-controller";
import { createCoachSettingsAdapter } from "../src/state/adapters/settings";
import { useEnduragentStore } from "../src/state/store";
import { CoachSection } from "../src/ui/settings/CoachSection";
import { renderLocalized } from "./language-harness";
import {
  mountWizard,
  openApiKeyPanel,
  panelButton,
  passwordInput,
  resetOnboardingStore,
  selectSetupOption,
  TEST_LLM_CONFIGURATION,
  testBridge,
  type MountedWizard,
} from "./onboarding-harness";

const OPENROUTER_KEY = `sk-or-v1-${"0".repeat(64)}`;

interface Route {
  readonly provider: string;
  readonly model: string;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

type HoldPoint = "persist" | "runtime";

function lock() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T,>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

const CONFIGURATION: OnboardingLlmConfiguration = {
  ...TEST_LLM_CONFIGURATION,
  providers: TEST_LLM_CONFIGURATION.providers.map((provider) =>
    provider.provider === "anthropic"
      ? {
          ...provider,
          models: [...provider.models, { value: "claude-opus-4-6", label: "Claude Opus 4.6" }],
        }
      : provider,
  ),
};

function fakeMain() {
  const main = {
    active: { provider: "anthropic", model: "claude-sonnet-4-6" } as Route,
    stored: new Set(["anthropic", "openai"]),
    holdKeyWrite: null as HoldPoint | null,
    keyWriteHeld: false,
    releaseKeyWrite: deferred(),
    holdApply: false,
    applyHeld: false,
    releaseApply: deferred(),
    refuseNextApply: false,
    appliesRequestedDuringKeyWrite: 0,
  };
  const credentialLock = lock();
  const runtimeLock = lock();
  const holdKeyWrite = async (point: HoldPoint) => {
    if (main.holdKeyWrite !== point) return;
    main.keyWriteHeld = true;
    await main.releaseKeyWrite.promise;
    main.keyWriteHeld = false;
  };
  const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
  bridge.getSetupStatus = async () => ({ schemaVersion: 1 as const, durableTrainingData: true });
  bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
  bridge.llmConfiguration.mockImplementation(async () => ({
    ...CONFIGURATION,
    active: main.active as OnboardingLlmConfiguration["active"],
  }));
  bridge.credentialStatuses.mockImplementation(() =>
    credentialLock(async () =>
      [...main.stored].map((slot) => ({
        slot: slot as "anthropic",
        state: "configured" as const,
        runtimeState:
          slot === main.active.provider ? ("active" as const) : ("stored-inactive" as const),
      })),
    ),
  );
  bridge.writeCredential.mockImplementation((input) =>
    credentialLock(async () => {
      await holdKeyWrite("persist");
      main.stored.add(input.slot);
      return runtimeLock(async () => {
        await holdKeyWrite("runtime");
        if (input.selection !== undefined) {
          main.active = { provider: input.selection.provider, model: input.selection.model };
        }
        return { slot: input.slot, status: "configured" as const, runtimeReady: true };
      });
    }),
  );
  const applyLlmSelection = (selection: OnboardingLlmSelection) => {
    if (main.keyWriteHeld) main.appliesRequestedDuringKeyWrite += 1;
    const apply = async () => {
      if (main.holdApply) {
        main.applyHeld = true;
        await main.releaseApply.promise;
      }
      if (main.refuseNextApply) {
        main.refuseNextApply = false;
        return { status: "refused" as const, reason: "runtime-unavailable" as const };
      }
      main.active = { provider: selection.provider, model: selection.model };
      return { status: "configured" as const, runtimeReady: true as const };
    };
    if (selection.provider === main.active.provider) return runtimeLock(apply);
    return credentialLock(() => runtimeLock(apply));
  };
  bridge.applyLlmSelection.mockImplementation(applyLlmSelection);
  return { main, bridge, applyLlmSelection };
}

interface Mounted {
  readonly main: ReturnType<typeof fakeMain>["main"];
  readonly bridge: ReturnType<typeof fakeMain>["bridge"];
  readonly wizard: MountedWizard;
  readonly coach: ProviderModelSettingsController;
}

async function mountSettings(): Promise<Mounted> {
  const { main, bridge, applyLlmSelection } = fakeMain();
  const store = useEnduragentStore;
  const coachAdapter = createCoachSettingsAdapter({
    publish: (state) => store.getState().patchSettings({ coach: state }),
  });
  let wizard: MountedWizard | undefined;
  const coach = createProviderModelSettingsController({
    load: () => bridge.llmConfiguration(),
    apply: applyLlmSelection,
    onSaved: () => void wizard?.controller.refresh(false),
    openSetup: () => {},
    beginMutation: () => store.getState().beginSettingsMutation("provider-model"),
    view: coachAdapter.view,
  });
  store.getState().bindSettingsPorts({ coach: coachAdapter.port } as never);
  wizard = mountWizard({
    bridge,
    placement: "settings",
    credentialMutationsBlocked: () => onboardingCredentialMutationsBlocked(store.getState()),
    onActiveSelectionChanged: () => void coach.refresh(),
  });
  renderLocalized(<CoachSection />);
  await wizard.open();
  await act(async () => coach.activate());
  return { main, bridge, wizard, coach };
}

function coachProvider(): HTMLElement {
  const element = document.querySelector<HTMLElement>("#coach-provider");
  if (element === null) throw new Error("Coach provider control not found");
  return element;
}

async function chooseCoachProvider(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(coachProvider());
  await user.click(await screen.findByRole("option", { name: label }));
}

async function chooseCoachModel(user: ReturnType<typeof userEvent.setup>, label: string) {
  const control = document.querySelector<HTMLElement>("#coach-model");
  if (control === null) throw new Error("Coach model control not found");
  await user.click(control);
  await user.click(await screen.findByRole("option", { name: label }));
}

async function startSetupOpenRouterSave(
  user: ReturnType<typeof userEvent.setup>,
  main: Mounted["main"],
  holdAt: HoldPoint = "runtime",
) {
  main.holdKeyWrite = holdAt;
  await openApiKeyPanel(user);
  await selectSetupOption(user, "onboarding-llm-provider", "openrouter");
  await user.type(passwordInput("openrouter"), OPENROUTER_KEY);
  await user.click(panelButton("api-key", "Save API key"));
  await waitFor(() => expect(main.keyWriteHeld).toBe(true));
  expect(useEnduragentStore.getState().onboarding.wizard.busy).toBe(true);
}

async function leaveCoachOnRetry(
  user: ReturnType<typeof userEvent.setup>,
  main: Mounted["main"],
  change: "provider" | "model" = "provider",
) {
  main.refuseNextApply = true;
  if (change === "provider") await chooseCoachProvider(user, "OpenAI");
  else await chooseCoachModel(user, "Claude Opus 4.6");
  await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeVisible());
  expect(main.active.provider).toBe("anthropic");
}

describe("lead: Setup and Coach saving routes at the same time", () => {
  let mounted: Mounted | undefined;
  beforeEach(() => resetOnboardingStore());
  afterEach(() => {
    mounted?.main.releaseKeyWrite.resolve();
    mounted?.main.releaseApply.resolve();
    mounted?.wizard.controller.dispose();
    mounted?.coach.dispose();
    mounted = undefined;
    resetOnboardingStore();
  });

  it("locks the Coach provider and model while a Setup key save is in flight", async () => {
    const user = userEvent.setup();
    mounted = await mountSettings();
    await startSetupOpenRouterSave(user, mounted.main);

    expect(coachProvider()).toBeDisabled();
    expect(document.querySelector("#coach-model")).toBeDisabled();
  });

  it("locks Setup's Save while a Coach save is in flight", async () => {
    const user = userEvent.setup();
    mounted = await mountSettings();
    const { main } = mounted;
    await openApiKeyPanel(user);
    await selectSetupOption(user, "onboarding-llm-provider", "openrouter");
    await user.type(passwordInput("openrouter"), OPENROUTER_KEY);
    main.holdApply = true;
    await chooseCoachProvider(user, "OpenAI");
    await waitFor(() => expect(main.applyHeld).toBe(true));

    await user.click(panelButton("api-key", "Save API key"));
    act(() => mounted?.wizard.controller.saveModelKey());
    await act(async () => Promise.resolve());

    expect(mounted.bridge.writeCredential).not.toHaveBeenCalled();
    expect(useEnduragentStore.getState().onboarding.wizard.busy).toBe(false);
    main.releaseApply.resolve();
    await waitFor(() => expect(main.active.provider).toBe("openai"));
    expect([...main.stored]).not.toContain("openrouter");
  });

  it("locks Coach's Retry while a Setup key save is in flight", async () => {
    const user = userEvent.setup();
    mounted = await mountSettings();
    await leaveCoachOnRetry(user, mounted.main);
    await startSetupOpenRouterSave(user, mounted.main);

    expect(
      screen.getByRole("button", { name: "Retry" }),
      "Coach's Retry stays enabled while Setup is still saving a different provider",
    ).toBeDisabled();
  });

  it.each([
    ["Coach switching provider, key write held while it applies", "provider", "runtime"],
    ["Coach changing model, key write held while the key is stored", "model", "persist"],
  ] as const)(
    "leaves Setup, Coach and the running coach on one route after Retry during a Setup save (%s)",
    async (_case, change, holdAt) => {
      const user = userEvent.setup();
      mounted = await mountSettings();
      const { main } = mounted;
      await leaveCoachOnRetry(user, main, change);
      await startSetupOpenRouterSave(user, main, holdAt);

      await user.click(screen.getByRole("button", { name: "Retry" }));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
      main.releaseKeyWrite.resolve();
      await waitFor(() => {
        const state = useEnduragentStore.getState();
        expect(main.keyWriteHeld).toBe(false);
        expect(state.onboarding.wizard.busy).toBe(false);
        expect(state.settings.savingOwners).toEqual([]);
        expect(state.onboarding.loading).toBe(false);
      });
      await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));

      const state = useEnduragentStore.getState();
      const coachState = state.settings.coach as { readonly active?: Route | null };
      expect(
        {
          running: main.active,
          setup: state.onboarding.configuration?.active,
          coach: coachState.active,
        },
        "Setup and Coach show one route while the coach runs another",
      ).toEqual({ running: main.active, setup: main.active, coach: main.active });
    },
  );
  it.each([
    ["Setup's status could not be loaded", { loadUnavailable: true }],
    [
      "a ride import runs",
      { rideImport: { status: "running" as const, owner: "resident" as const } },
    ],
  ] as const)("keeps Coach usable while %s", async (_case, patch) => {
    mounted = await mountSettings();
    const onboarding = useEnduragentStore.getState().onboarding;
    act(() => {
      useEnduragentStore.getState().setOnboarding({ ...onboarding, ...patch } as typeof onboarding);
    });
    expect(coachProvider()).toBeEnabled();
    expect(document.querySelector("#coach-model")).toBeEnabled();
  });
});
