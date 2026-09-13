import type {
  OnboardingLlmConfiguration,
  OnboardingLlmProviderConfiguration,
  OnboardingLlmSelection,
  OnboardingLlmSelectionResult,
} from "../onboarding/bridge";
import { CUSTOM_MODEL_SELECTION } from "../onboarding/constants";

export type ProviderModelValidationError =
  | "model-required"
  | "model-too-long"
  | "model-control-characters";

export type ProviderModelSaveError =
  | Extract<OnboardingLlmSelectionResult, { readonly status: "refused" }>["reason"]
  | "request-failed";

export interface ProviderModelDraft {
  readonly provider: OnboardingLlmProviderConfiguration;
  readonly modelChoice: string;
  readonly customModel: string;
}

export interface ProviderModelFormState {
  readonly providers: readonly OnboardingLlmProviderConfiguration[];
  readonly active: OnboardingLlmConfiguration["active"];
  readonly draft: ProviderModelDraft | null;
  readonly providerChangeRequired: boolean;
  readonly dirty: boolean;
  readonly validationError: ProviderModelValidationError | null;
}

export type ProviderModelSettingsState =
  | { readonly status: "closed" }
  | { readonly status: "loading" }
  | ({ readonly status: "ready" | "saving" | "saved" } & ProviderModelFormState)
  | {
      readonly status: "error";
      readonly kind: "load";
      readonly reason: "configuration-unavailable";
    }
  | ({
      readonly status: "error";
      readonly kind: "save";
      readonly reason: ProviderModelSaveError;
    } & ProviderModelFormState);

export interface ProviderModelSettingsView {
  bind(handlers: {
    readonly onOpen: () => void;
    readonly onClose: () => void;
    readonly onRetry: () => void;
    readonly onProviderChange: (provider: string) => void;
    readonly onModelChange: (model: string) => void;
    readonly onCustomModelChange: (model: string) => void;
    readonly onCommitCustomModel: () => void;
    readonly onOpenSetup: () => void;
  }): void;
  open(): void;
  close(): void;
  render(state: Exclude<ProviderModelSettingsState, { readonly status: "closed" }>): void;
  dispose(): void;
}

export interface ProviderModelSettingsController {
  activate(): Promise<void>;
  close(): void;
  state(): ProviderModelSettingsState;
  dispose(): void;
}

interface EditableState {
  readonly providers: readonly OnboardingLlmProviderConfiguration[];
  readonly active: OnboardingLlmConfiguration["active"];
  readonly draft: ProviderModelDraft | null;
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159));
  });
}

function draftFor(
  provider: OnboardingLlmProviderConfiguration,
  model = provider.defaultModel,
): ProviderModelDraft {
  const known = provider.models.some((option) => option.value === model);
  return {
    provider,
    modelChoice: known ? model : CUSTOM_MODEL_SELECTION,
    customModel: known ? "" : model,
  };
}

function selectedModel(draft: ProviderModelDraft): string {
  return (
    draft.modelChoice === CUSTOM_MODEL_SELECTION ? draft.customModel : draft.modelChoice
  ).trim();
}

function validationError(draft: ProviderModelDraft | null): ProviderModelValidationError | null {
  if (draft === null || draft.modelChoice !== CUSTOM_MODEL_SELECTION) return null;
  if (hasControlCharacters(draft.customModel)) return "model-control-characters";
  const model = draft.customModel.trim();
  if (model.length === 0) return "model-required";
  if (model.length > 512) return "model-too-long";
  return null;
}

function isDirty(
  active: OnboardingLlmConfiguration["active"],
  draft: ProviderModelDraft | null,
): boolean {
  if (draft === null) return false;
  if (active === null) return true;
  return active.provider !== draft.provider.provider || active.model !== selectedModel(draft);
}

function formState(editable: EditableState, codexAgentSupported: boolean): ProviderModelFormState {
  return {
    providers: editable.providers,
    active: editable.active,
    draft: editable.draft,
    providerChangeRequired: !codexAgentSupported && editable.active?.provider === "codex-agent",
    dirty: isDirty(editable.active, editable.draft),
    validationError: validationError(editable.draft),
  };
}

function editableState(state: ProviderModelSettingsState): EditableState | null {
  if (
    state.status === "ready" ||
    state.status === "saving" ||
    state.status === "saved" ||
    (state.status === "error" && state.kind === "save")
  ) {
    return state;
  }
  return null;
}

export function createProviderModelSettingsController(input: {
  readonly load: () => Promise<OnboardingLlmConfiguration>;
  readonly apply: (selection: OnboardingLlmSelection) => Promise<OnboardingLlmSelectionResult>;
  readonly onSaved?: (selection: OnboardingLlmSelection) => Promise<void> | void;
  readonly openSetup: () => void;
  readonly view: ProviderModelSettingsView;
  readonly beginMutation?: () => (() => void) | null;
  readonly codexAgentSupported?: boolean;
}): ProviderModelSettingsController {
  let currentState: ProviderModelSettingsState = { status: "closed" };
  let generation = 0;
  let disposed = false;
  let visible = false;
  let queuedSelection: OnboardingLlmSelection | undefined;
  let loadOperation: Promise<void> | undefined;
  let saveOperation: Promise<void> | undefined;
  let providerDrafts = new Map<string, ProviderModelDraft>();
  const committedCustomModels = new Map<string, string>();

  const render = (state: Exclude<ProviderModelSettingsState, { status: "closed" }>): void => {
    currentState = state;
    if (visible && !disposed) input.view.render(state);
  };

  const startLoad = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    const operationGeneration = ++generation;
    visible = true;
    render({ status: "loading" });
    input.view.open();
    const pending = Promise.resolve()
      .then(() => input.load())
      .then(
        (configuration) => {
          if (disposed || generation !== operationGeneration) return;
          const activeProvider =
            configuration.active === null
              ? undefined
              : configuration.providers.find(
                  (provider) => provider.provider === configuration.active?.provider,
                );
          if (configuration.providers.length === 0) {
            render({
              status: "error",
              kind: "load",
              reason: "configuration-unavailable",
            });
            return;
          }
          providerDrafts = new Map();
          committedCustomModels.clear();
          const draft =
            configuration.active === null || activeProvider === undefined
              ? null
              : draftFor(activeProvider, configuration.active.model);
          if (draft !== null) {
            providerDrafts.set(draft.provider.provider, draft);
            if (draft.modelChoice === CUSTOM_MODEL_SELECTION) {
              committedCustomModels.set(draft.provider.provider, selectedModel(draft));
            }
          }
          render({
            status: "ready",
            ...formState(
              {
                providers: configuration.providers,
                active: configuration.active,
                draft,
              },
              input.codexAgentSupported ?? true,
            ),
          });
        },
        () => {
          if (!disposed && generation === operationGeneration) {
            render({
              status: "error",
              kind: "load",
              reason: "configuration-unavailable",
            });
          }
        },
      )
      .finally(() => {
        if (loadOperation === pending) loadOperation = undefined;
      });
    loadOperation = pending;
    return pending;
  };

  const close = (): void => {
    if (disposed) return;
    ++generation;
    loadOperation = undefined;
    visible = false;
    if (saveOperation === undefined) currentState = { status: "closed" };
    input.view.close();
  };

  const updateDraft = (draft: ProviderModelDraft): void => {
    if (disposed || !visible) return;
    const editable = editableState(currentState);
    if (editable === null) return;
    queuedSelection = undefined;
    providerDrafts.set(draft.provider.provider, draft);
    render({
      status: saveOperation === undefined ? "ready" : "saving",
      ...formState({ ...editable, draft }, input.codexAgentSupported ?? true),
    });
  };

  const changeProvider = (providerName: string): void => {
    if (disposed || !visible) return;
    const editable = editableState(currentState);
    const provider = editable?.providers.find((entry) => entry.provider === providerName);
    if (editable === null || provider === undefined) return;
    const draft = providerDrafts.get(provider.provider) ?? draftFor(provider);
    updateDraft(draft);
    commit(committedCustomModels.get(provider.provider) === selectedModel(draft));
  };

  const changeModel = (model: string): void => {
    if (disposed || !visible) return;
    const editable = editableState(currentState);
    const draft = editable?.draft;
    if (
      draft === null ||
      draft === undefined ||
      (model !== CUSTOM_MODEL_SELECTION &&
        !draft.provider.models.some((option) => option.value === model))
    ) {
      return;
    }
    updateDraft({ ...draft, modelChoice: model });
    commit(false);
  };

  const changeCustomModel = (model: string): void => {
    if (disposed || !visible) return;
    const editable = editableState(currentState);
    const draft = editable?.draft;
    if (draft === null || draft === undefined || draft.modelChoice !== CUSTOM_MODEL_SELECTION) {
      return;
    }
    updateDraft({ ...draft, customModel: model });
  };

  const drain = async (): Promise<void> => {
    while (!disposed && queuedSelection !== undefined) {
      const selection = queuedSelection;
      queuedSelection = undefined;
      const editable = editableState(currentState);
      if (editable === null) return;
      if (
        editable.active?.provider === selection.provider &&
        editable.active.model === selection.model
      ) {
        continue;
      }
      const result = await Promise.resolve()
        .then(() => input.apply(selection))
        .catch((): { readonly status: "refused"; readonly reason: "request-failed" } => ({
          status: "refused",
          reason: "request-failed",
        }));
      if (disposed) return;
      const latest = editableState(currentState);
      if (latest === null) return;
      if (result.status === "refused") {
        if (queuedSelection !== undefined) continue;
        render({
          status: "error",
          kind: "save",
          reason: result.reason,
          ...formState(latest, input.codexAgentSupported ?? true),
        });
        return;
      }
      render({
        status: "saving",
        ...formState(
          { ...latest, active: { provider: selection.provider, model: selection.model } },
          input.codexAgentSupported ?? true,
        ),
      });
      await Promise.resolve()
        .then(() => input.onSaved?.(selection))
        .catch(() => undefined);
    }
    if (disposed) return;
    const latest = editableState(currentState);
    if (latest !== null) {
      const form = formState(latest, input.codexAgentSupported ?? true);
      render({ status: form.dirty ? "ready" : "saved", ...form });
    }
  };

  const commit = (custom: boolean): void => {
    if (disposed || !visible) return;
    const editable = editableState(currentState);
    if (editable === null) return;
    const form = formState(editable, input.codexAgentSupported ?? true);
    if (
      form.draft === null ||
      form.validationError !== null ||
      (form.draft.modelChoice === CUSTOM_MODEL_SELECTION && !custom) ||
      (!form.dirty && saveOperation === undefined)
    )
      return;
    if (form.draft.modelChoice === CUSTOM_MODEL_SELECTION) {
      committedCustomModels.set(form.draft.provider.provider, selectedModel(form.draft));
    }
    queuedSelection = {
      provider: form.draft.provider.provider,
      model: selectedModel(form.draft),
      endpoint: { mode: "automatic" },
    };
    if (saveOperation !== undefined) return;
    const releaseMutation = input.beginMutation === undefined ? () => {} : input.beginMutation();
    if (releaseMutation === null) {
      queuedSelection = undefined;
      return;
    }
    render({ status: "saving", ...form });
    const pending = Promise.resolve().then(async () => {
      try {
        do {
          await drain();
        } while (!disposed && queuedSelection !== undefined);
      } finally {
        saveOperation = undefined;
        if (!visible) currentState = { status: "closed" };
        releaseMutation();
      }
    });
    saveOperation = pending;
  };

  const retry = (): void => {
    if (disposed) return;
    if (currentState.status === "error" && currentState.kind === "load") {
      void startLoad();
      return;
    }
    if (currentState.status === "error" && currentState.kind === "save") commit(true);
  };

  const openSetup = (): void => {
    if (
      disposed ||
      currentState.status !== "error" ||
      currentState.kind !== "save" ||
      currentState.reason !== "credential-required"
    ) {
      return;
    }
    close();
    input.openSetup();
  };

  input.view.bind({
    onOpen: () => void activate(),
    onClose: close,
    onRetry: retry,
    onProviderChange: changeProvider,
    onModelChange: changeModel,
    onCustomModelChange: changeCustomModel,
    onCommitCustomModel: () => {
      const editable = editableState(currentState);
      if (editable?.draft?.modelChoice === CUSTOM_MODEL_SELECTION) commit(true);
    },
    onOpenSetup: openSetup,
  });

  const activate = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (currentState.status !== "closed") {
      visible = true;
      input.view.open();
      input.view.render(currentState);
      return loadOperation ?? saveOperation ?? Promise.resolve();
    }
    return startLoad();
  };

  return {
    activate,
    close,
    state: () => (visible ? currentState : { status: "closed" }),
    dispose() {
      if (disposed) return;
      disposed = true;
      visible = false;
      queuedSelection = undefined;
      ++generation;
      loadOperation = undefined;
      saveOperation = undefined;
      currentState = { status: "closed" };
      providerDrafts.clear();
      committedCustomModels.clear();
      input.view.dispose();
    },
  };
}
