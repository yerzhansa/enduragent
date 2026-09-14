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
  | "configuration-unavailable"
  | "request-failed";

export interface ProviderModelDraft {
  readonly provider: OnboardingLlmProviderConfiguration;
  readonly modelChoice: string;
  readonly customModel: string;
}

export interface ProviderModelFormState {
  readonly catalogRevision: number;
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
    readonly onSave: () => void;
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
  readonly catalogRevision: number;
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
    catalogRevision: editable.catalogRevision,
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
  let loadOperation: Promise<void> | undefined;
  let saveOperation: Promise<void> | undefined;
  let providerDrafts = new Map<string, ProviderModelDraft>();

  const render = (state: Exclude<ProviderModelSettingsState, { status: "closed" }>): void => {
    currentState = state;
    input.view.render(state);
  };

  const startLoad = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    const operationGeneration = ++generation;
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
          const draft =
            configuration.active === null || activeProvider === undefined
              ? null
              : draftFor(activeProvider, configuration.active.model);
          if (draft !== null) providerDrafts.set(draft.provider.provider, draft);
          render({
            status: "ready",
            ...formState(
              {
                catalogRevision: configuration.catalogRevision,
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
    saveOperation = undefined;
    currentState = { status: "closed" };
    input.view.close();
  };

  const updateDraft = (draft: ProviderModelDraft): void => {
    if (disposed || currentState.status === "saving") return;
    const editable = editableState(currentState);
    if (editable === null) return;
    providerDrafts.set(draft.provider.provider, draft);
    render({
      status: "ready",
      ...formState({ ...editable, draft }, input.codexAgentSupported ?? true),
    });
  };

  const changeProvider = (providerName: string): void => {
    if (disposed || currentState.status === "saving") return;
    const editable = editableState(currentState);
    const provider = editable?.providers.find((entry) => entry.provider === providerName);
    if (editable === null || provider === undefined) return;
    updateDraft(providerDrafts.get(provider.provider) ?? draftFor(provider));
  };

  const changeModel = (model: string): void => {
    if (disposed || currentState.status === "saving") return;
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
  };

  const changeCustomModel = (model: string): void => {
    if (disposed || currentState.status === "saving") return;
    const editable = editableState(currentState);
    const draft = editable?.draft;
    if (draft === null || draft === undefined || draft.modelChoice !== CUSTOM_MODEL_SELECTION) {
      return;
    }
    updateDraft({ ...draft, customModel: model });
  };

  const save = (): Promise<void> => {
    if (disposed || saveOperation !== undefined) return saveOperation ?? Promise.resolve();
    const editable = editableState(currentState);
    if (editable === null || currentState.status === "saving") return Promise.resolve();
    const form = formState(editable, input.codexAgentSupported ?? true);
    if (form.draft === null || !form.dirty || form.validationError !== null) {
      return Promise.resolve();
    }
    const releaseMutation = input.beginMutation === undefined ? () => {} : input.beginMutation();
    if (releaseMutation === null) return Promise.resolve();
    const selection: OnboardingLlmSelection = {
      catalogRevision: form.catalogRevision,
      provider: form.draft.provider.provider,
      model: selectedModel(form.draft),
      endpoint: { mode: "automatic" },
    };
    const operationGeneration = ++generation;
    render({ status: "saving", ...form });
    const pending = Promise.resolve()
      .then(() => input.apply(selection))
      .then(
        async (result) => {
          if (disposed || generation !== operationGeneration) return;
          if (result.status === "refused" || result.status === "stale-draft") {
            render({
              status: "error",
              kind: "save",
              reason: result.status === "stale-draft" ? "configuration-unavailable" : result.reason,
              ...form,
            });
            return;
          }
          await input.onSaved?.(selection);
          if (disposed || generation !== operationGeneration) return;
          const active = { provider: selection.provider, model: selection.model };
          render({
            status: "saved",
            ...formState(
              {
                catalogRevision: form.catalogRevision,
                providers: form.providers,
                active,
                draft: form.draft,
              },
              input.codexAgentSupported ?? true,
            ),
          });
        },
        () => {
          if (!disposed && generation === operationGeneration) {
            render({
              status: "error",
              kind: "save",
              reason: "request-failed",
              ...form,
            });
          }
        },
      )
      .finally(() => {
        releaseMutation();
        if (saveOperation === pending) saveOperation = undefined;
      });
    saveOperation = pending;
    return pending;
  };

  const retry = (): void => {
    if (disposed) return;
    if (currentState.status === "error" && currentState.kind === "load") {
      void startLoad();
      return;
    }
    if (currentState.status === "error" && currentState.kind === "save") void save();
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
    onOpen: () => void startLoad(),
    onClose: close,
    onRetry: retry,
    onProviderChange: changeProvider,
    onModelChange: changeModel,
    onCustomModelChange: changeCustomModel,
    onSave: () => void save(),
    onOpenSetup: openSetup,
  });

  return {
    activate() {
      if (disposed) return Promise.resolve();
      if (currentState.status !== "closed") {
        input.view.open();
        return loadOperation ?? saveOperation ?? Promise.resolve();
      }
      return startLoad();
    },
    close,
    state: () => currentState,
    dispose() {
      if (disposed) return;
      disposed = true;
      ++generation;
      loadOperation = undefined;
      saveOperation = undefined;
      currentState = { status: "closed" };
      providerDrafts.clear();
      input.view.dispose();
    },
  };
}
