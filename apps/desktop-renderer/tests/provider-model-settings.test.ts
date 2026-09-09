import { describe, expect, it, vi } from "vitest";
import type {
  OnboardingLlmConfiguration,
  OnboardingLlmProviderConfiguration,
  OnboardingLlmSelectionResult,
} from "../src/onboarding/bridge";
import { CUSTOM_MODEL_SELECTION } from "../src/onboarding/constants";
import {
  createProviderModelSettingsController,
  type ProviderModelSettingsController,
  type ProviderModelSettingsView,
} from "../src/settings/provider-model-controller";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const PROVIDERS = [
  {
    provider: "anthropic",
    defaultModel: "claude-sonnet",
    models: [
      { value: "claude-sonnet", label: "Claude Sonnet" },
      { value: "claude-opus", label: "Claude Opus" },
    ],
  },
  {
    provider: "openai",
    defaultModel: "gpt-standard",
    models: [
      { value: "gpt-standard", label: "GPT Standard" },
      { value: "gpt-reasoning", label: "GPT Reasoning", hint: "More deliberate" },
    ],
  },
] as const satisfies readonly OnboardingLlmProviderConfiguration[];

function configuration(
  active: OnboardingLlmConfiguration["active"] = {
    provider: "anthropic",
    model: "claude-sonnet",
  },
): OnboardingLlmConfiguration {
  return { schemaVersion: 1, providers: PROVIDERS, active };
}

function fakeView() {
  let handlers:
    | {
        readonly onOpen: () => void;
        readonly onClose: () => void;
        readonly onRetry: () => void;
        readonly onProviderChange: (provider: string) => void;
        readonly onModelChange: (model: string) => void;
        readonly onCustomModelChange: (model: string) => void;
        readonly onSave: () => void;
        readonly onOpenSetup: () => void;
      }
    | undefined;
  const view: ProviderModelSettingsView = {
    bind: vi.fn((value) => {
      handlers = value;
    }),
    open: vi.fn(),
    close: vi.fn(),
    render: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    view,
    open: () => handlers?.onOpen(),
    close: () => handlers?.onClose(),
    retry: () => handlers?.onRetry(),
    provider: (value: string) => handlers?.onProviderChange(value),
    model: (value: string) => handlers?.onModelChange(value),
    customModel: (value: string) => handlers?.onCustomModelChange(value),
    save: () => handlers?.onSave(),
    openSetup: () => handlers?.onOpenSetup(),
  };
}

function createSubject(input: {
  readonly load?: () => Promise<OnboardingLlmConfiguration>;
  readonly apply?: () => Promise<OnboardingLlmSelectionResult>;
  readonly onSaved?: () => Promise<void> | void;
  readonly openSetup?: () => void;
  readonly codexAgentSupported?: boolean;
}) {
  const subject = fakeView();
  const load = input.load ?? vi.fn(async () => configuration());
  const apply =
    input.apply ??
    vi.fn(async () => ({ status: "configured" as const, runtimeReady: true as const }));
  const controller = createProviderModelSettingsController({
    load,
    apply,
    ...(input.onSaved === undefined ? {} : { onSaved: input.onSaved }),
    openSetup: input.openSetup ?? vi.fn(),
    ...(input.codexAgentSupported === undefined
      ? {}
      : { codexAgentSupported: input.codexAgentSupported }),
    view: subject.view,
  });
  return { controller, subject, load, apply };
}

function formState(controller: ProviderModelSettingsController) {
  const state = controller.state();
  if (
    state.status !== "ready" &&
    state.status !== "saving" &&
    state.status !== "saved" &&
    !(state.status === "error" && state.kind === "save")
  ) {
    throw new Error(`Expected form state, received ${state.status}`);
  }
  return state;
}

describe("provider and model settings controller", () => {
  it("opens with visible loading state before resolving a known active model", async () => {
    const gate = deferred<OnboardingLlmConfiguration>();
    const { controller, subject } = createSubject({ load: vi.fn(() => gate.promise) });

    const pending = controller.activate();

    expect(subject.view.open).toHaveBeenCalled();
    expect(controller.state()).toEqual({ status: "loading" });
    expect(subject.view.render).toHaveBeenLastCalledWith({ status: "loading" });

    gate.resolve(configuration());
    await pending;
    expect(formState(controller)).toMatchObject({
      status: "ready",
      active: { provider: "anthropic", model: "claude-sonnet" },
      draft: {
        provider: { provider: "anthropic" },
        modelChoice: "claude-sonnet",
        customModel: "",
      },
      dirty: false,
      validationError: null,
    });
  });

  it("represents an unknown active model as Other without making it dirty", async () => {
    const { controller } = createSubject({
      load: vi.fn(async () => configuration({ provider: "anthropic", model: "claude-future" })),
    });

    await controller.activate();

    expect(formState(controller)).toMatchObject({
      status: "ready",
      draft: {
        modelChoice: CUSTOM_MODEL_SELECTION,
        customModel: "claude-future",
      },
      dirty: false,
      validationError: null,
    });
  });

  it("leaves active:null unconfigured until the athlete chooses a provider", async () => {
    const { controller, subject } = createSubject({
      load: vi.fn(async () => configuration(null)),
    });

    await controller.activate();
    expect(formState(controller)).toMatchObject({
      status: "ready",
      active: null,
      draft: null,
      dirty: false,
    });

    subject.provider("openai");
    expect(formState(controller)).toMatchObject({
      draft: {
        provider: { provider: "openai" },
        modelChoice: "gpt-standard",
      },
      dirty: true,
    });
  });

  it("keeps the panel usable when the active provider is absent from the catalogue", async () => {
    const { controller, subject, apply } = createSubject({
      load: vi.fn(async () => configuration({ provider: "codex-agent", model: "gpt-codex" })),
    });

    await controller.activate();
    expect(formState(controller)).toMatchObject({
      status: "ready",
      active: { provider: "codex-agent", model: "gpt-codex" },
      draft: null,
      dirty: false,
      validationError: null,
    });
    expect(formState(controller).providers).toEqual(PROVIDERS);

    subject.provider("openai");
    expect(formState(controller)).toMatchObject({
      draft: {
        provider: { provider: "openai" },
        modelChoice: "gpt-standard",
      },
      dirty: true,
    });

    subject.save();
    await vi.waitFor(() => expect(controller.state().status).toBe("saved"));
    expect(apply).toHaveBeenCalledWith({
      provider: "openai",
      model: "gpt-standard",
      endpoint: { mode: "automatic" },
    });
    expect(formState(controller)).toMatchObject({
      active: { provider: "openai", model: "gpt-standard" },
      dirty: false,
    });
  });

  it("requires a provider change when Windows reports Codex agent unsupported", async () => {
    const { controller, subject, apply } = createSubject({
      load: vi.fn(async () => configuration({ provider: "codex-agent", model: "gpt-codex" })),
      codexAgentSupported: false,
    });

    await controller.activate();
    expect(formState(controller)).toMatchObject({
      active: { provider: "codex-agent", model: "gpt-codex" },
      draft: null,
      providerChangeRequired: true,
    });

    subject.provider("anthropic");
    subject.save();
    await vi.waitFor(() => expect(controller.state().status).toBe("saved"));
    expect(apply).toHaveBeenCalledWith({
      provider: "anthropic",
      model: "claude-sonnet",
      endpoint: { mode: "automatic" },
    });
    expect(formState(controller)).toMatchObject({
      active: { provider: "anthropic", model: "claude-sonnet" },
      providerChangeRequired: false,
      dirty: false,
    });
  });

  it("treats an empty provider catalogue as an unavailable configuration", async () => {
    const { controller } = createSubject({
      load: vi.fn(async () => ({ schemaVersion: 1 as const, providers: [], active: null })),
    });

    await controller.activate();

    expect(controller.state()).toEqual({
      status: "error",
      kind: "load",
      reason: "configuration-unavailable",
    });
  });

  it("uses each provider default first and retains a previously edited provider draft", async () => {
    const { controller, subject } = createSubject({});
    await controller.activate();

    subject.provider("openai");
    expect(formState(controller).draft).toMatchObject({
      provider: { provider: "openai" },
      modelChoice: "gpt-standard",
    });
    subject.model(CUSTOM_MODEL_SELECTION);
    subject.customModel("  gpt-private  ");
    subject.provider("anthropic");
    subject.model("claude-opus");
    subject.provider("openai");

    expect(formState(controller).draft).toMatchObject({
      provider: { provider: "openai" },
      modelChoice: CUSTOM_MODEL_SELECTION,
      customModel: "  gpt-private  ",
    });
  });

  it("validates trimmed custom model names for presence, length, and control characters", async () => {
    const { controller, subject, apply } = createSubject({});
    await controller.activate();
    subject.model(CUSTOM_MODEL_SELECTION);
    expect(formState(controller).validationError).toBe("model-required");

    subject.customModel(`valid\u0007name`);
    expect(formState(controller).validationError).toBe("model-control-characters");

    subject.customModel(`valid\u0085name`);
    expect(formState(controller).validationError).toBe("model-control-characters");

    subject.customModel("x".repeat(513));
    expect(formState(controller).validationError).toBe("model-too-long");
    subject.save();
    await Promise.resolve();
    expect(apply).not.toHaveBeenCalled();

    subject.customModel(`  ${"x".repeat(512)}  `);
    expect(formState(controller).validationError).toBeNull();

    subject.save();
    await vi.waitFor(() => expect(controller.state().status).toBe("saved"));
    expect(apply).toHaveBeenCalledWith({
      provider: "anthropic",
      model: "x".repeat(512),
      endpoint: { mode: "automatic" },
    });

    subject.customModel("  claude-private  ");
    expect(formState(controller)).toMatchObject({
      validationError: null,
      dirty: true,
    });
  });

  it("submits the exact automatic-endpoint payload once and makes success current", async () => {
    const gate = deferred<OnboardingLlmSelectionResult>();
    const apply = vi.fn(() => gate.promise);
    const { controller, subject } = createSubject({ apply });
    await controller.activate();
    subject.model(CUSTOM_MODEL_SELECTION);
    subject.customModel("  claude-private  ");

    subject.save();
    subject.save();
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(apply).toHaveBeenCalledWith({
      provider: "anthropic",
      model: "claude-private",
      endpoint: { mode: "automatic" },
    });
    expect(controller.state().status).toBe("saving");

    gate.resolve({ status: "configured", runtimeReady: true });
    await vi.waitFor(() => expect(controller.state().status).toBe("saved"));
    expect(formState(controller)).toMatchObject({
      status: "saved",
      active: { provider: "anthropic", model: "claude-private" },
      dirty: false,
    });
  });

  it("refreshes dependent surfaces after the new route is active", async () => {
    const order: string[] = [];
    const onSaved = vi.fn(async () => {
      order.push("refresh");
    });
    const { controller, subject, apply } = createSubject({
      apply: vi.fn(async () => {
        order.push("apply");
        return { status: "configured" as const, runtimeReady: true as const };
      }),
      onSaved,
    });
    await controller.activate();
    subject.model("claude-opus");

    subject.save();
    await vi.waitFor(() => expect(controller.state().status).toBe("saved"));

    expect(apply).toHaveBeenCalledOnce();
    expect(onSaved).toHaveBeenCalledWith({
      provider: "anthropic",
      model: "claude-opus",
      endpoint: { mode: "automatic" },
    });
    expect(order).toEqual(["apply", "refresh"]);
  });

  it.each(["invalid-input", "credential-required", "runtime-unavailable"] as const)(
    "retains the draft after %s and allows Save to retry",
    async (reason) => {
      const apply = vi
        .fn()
        .mockResolvedValueOnce({ status: "refused", reason })
        .mockResolvedValueOnce({ status: "configured", runtimeReady: true });
      const { controller, subject } = createSubject({ apply });
      await controller.activate();
      subject.provider("openai");
      subject.model("gpt-reasoning");

      subject.save();
      await vi.waitFor(() =>
        expect(controller.state()).toMatchObject({
          status: "error",
          kind: "save",
          reason,
          draft: {
            provider: { provider: "openai" },
            modelChoice: "gpt-reasoning",
          },
          dirty: true,
        }),
      );

      subject.save();
      await vi.waitFor(() => expect(controller.state().status).toBe("saved"));
      expect(apply).toHaveBeenCalledTimes(2);
    },
  );

  it("closes Settings before opening Setup for credential recovery", async () => {
    const sequence: string[] = [];
    const { controller, subject } = createSubject({
      apply: vi.fn(async (): Promise<OnboardingLlmSelectionResult> => ({
        status: "refused",
        reason: "credential-required",
      })),
      openSetup: () => sequence.push("setup"),
    });
    vi.mocked(subject.view.close).mockImplementation(() => sequence.push("close"));
    await controller.activate();
    subject.provider("openai");
    subject.save();
    await vi.waitFor(() => expect(controller.state().status).toBe("error"));

    subject.openSetup();

    expect(sequence).toEqual(["close", "setup"]);
    expect(controller.state()).toEqual({ status: "closed" });
  });

  it("ignores a stale load after close and reopen", async () => {
    const first = deferred<OnboardingLlmConfiguration>();
    const second = deferred<OnboardingLlmConfiguration>();
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { controller } = createSubject({ load });
    const firstOpen = controller.activate();
    controller.close();
    const secondOpen = controller.activate();

    first.resolve(configuration({ provider: "anthropic", model: "claude-future" }));
    await firstOpen;
    expect(controller.state()).toEqual({ status: "loading" });

    second.resolve(configuration({ provider: "openai", model: "gpt-standard" }));
    await secondOpen;
    expect(formState(controller)).toMatchObject({
      status: "ready",
      draft: { provider: { provider: "openai" }, modelChoice: "gpt-standard" },
    });
  });

  it("ignores a stale save after close and a fresh reload", async () => {
    const saveGate = deferred<OnboardingLlmSelectionResult>();
    const load = vi
      .fn()
      .mockResolvedValueOnce(configuration())
      .mockResolvedValueOnce(configuration({ provider: "openai", model: "gpt-standard" }));
    const { controller, subject } = createSubject({
      load,
      apply: vi.fn(() => saveGate.promise),
    });
    await controller.activate();
    subject.model("claude-opus");
    subject.save();
    await vi.waitFor(() => expect(controller.state().status).toBe("saving"));
    controller.close();
    await controller.activate();

    saveGate.resolve({ status: "configured", runtimeReady: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(formState(controller)).toMatchObject({
      status: "ready",
      active: { provider: "openai", model: "gpt-standard" },
      draft: { provider: { provider: "openai" }, modelChoice: "gpt-standard" },
    });
  });

  it.each(["load", "save"] as const)(
    "does not render a stale %s completion after disposal",
    async (operation) => {
      const loadGate = deferred<OnboardingLlmConfiguration>();
      const saveGate = deferred<OnboardingLlmSelectionResult>();
      const { controller, subject } = createSubject({
        load: operation === "load" ? vi.fn(() => loadGate.promise) : undefined,
        apply: vi.fn(() => saveGate.promise),
      });
      const pending = controller.activate();
      if (operation === "save") {
        await pending;
        subject.model("claude-opus");
        subject.save();
        await vi.waitFor(() => expect(controller.state().status).toBe("saving"));
      }
      const renders = vi.mocked(subject.view.render).mock.calls.length;
      controller.dispose();
      if (operation === "load") loadGate.resolve(configuration());
      else saveGate.resolve({ status: "configured", runtimeReady: true });
      await Promise.resolve();
      await Promise.resolve();

      expect(subject.view.render).toHaveBeenCalledTimes(renders);
      expect(subject.view.dispose).toHaveBeenCalledOnce();
      expect(controller.state()).toEqual({ status: "closed" });
    },
  );

  it("maps a rejected load to a retryable loading cycle", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("private detail"))
      .mockResolvedValueOnce(configuration());
    const { controller, subject } = createSubject({ load });
    await controller.activate();
    expect(controller.state()).toEqual({
      status: "error",
      kind: "load",
      reason: "configuration-unavailable",
    });

    subject.retry();
    await vi.waitFor(() => expect(controller.state().status).toBe("ready"));
    expect(load).toHaveBeenCalledTimes(2);
  });
});
