import { CoachClientDisconnectedError, CoachClientProtocolError } from "@enduragent/coach-client";
import type {
  ConfigureRuntimeRpcRefusalReason,
  RuntimeConfigSnapshot,
} from "@enduragent/coach-contract";
import type { DesktopCoachClient, DesktopCoachClientProvider } from "../coach-client";

export type AthleteSettingsValidationError =
  | "athlete-required"
  | "athlete-whitespace"
  | "athlete-too-long"
  | "athlete-control-characters";

export type AthleteSettingsSaveError =
  | ConfigureRuntimeRpcRefusalReason
  | "request-failed"
  | "not-applied"
  | "runtime-unavailable";

export interface AthleteSettingsFormState {
  readonly effective: RuntimeConfigSnapshot["intervals"];
  readonly draft: string;
  readonly dirty: boolean;
  readonly validationError: AthleteSettingsValidationError | null;
}

export type AthleteSettingsState =
  | { readonly status: "closed" }
  | { readonly status: "loading" }
  | ({ readonly status: "ready" | "refreshing" | "saving" | "saved" } & AthleteSettingsFormState)
  | {
      readonly status: "error";
      readonly kind: "load";
      readonly reason: "runtime-unavailable";
    }
  | ({
      readonly status: "error";
      readonly kind: "save";
      readonly reason: AthleteSettingsSaveError;
    } & AthleteSettingsFormState);

export interface AthleteSettingsView {
  bind(handlers: {
    readonly onRetry: () => void;
    readonly onChange: (value: string) => void;
    readonly onSave: () => void;
    readonly onOpenSetup: () => void;
  }): void;
  render(state: Exclude<AthleteSettingsState, { readonly status: "closed" }>): void;
  dispose(): void;
}

export interface AthleteSettingsController {
  activate(): Promise<void>;
  close(): void;
  state(): AthleteSettingsState;
  dispose(): void;
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159));
  });
}

function validationError(value: string): AthleteSettingsValidationError | null {
  if (value.length === 0) return "athlete-required";
  if (value.trim() !== value) return "athlete-whitespace";
  if (value.length > 512) return "athlete-too-long";
  if (hasControlCharacters(value)) return "athlete-control-characters";
  return null;
}

function formState(
  effective: RuntimeConfigSnapshot["intervals"],
  draft: string,
): AthleteSettingsFormState {
  return {
    effective,
    draft,
    dirty:
      effective.credential_configured &&
      !effective.managedByEnvironment.athleteId &&
      draft !== effective.athlete_id,
    validationError: validationError(draft),
  };
}

function editableState(state: AthleteSettingsState): AthleteSettingsFormState | null {
  if (
    state.status === "ready" ||
    state.status === "refreshing" ||
    state.status === "saving" ||
    state.status === "saved" ||
    (state.status === "error" && state.kind === "save")
  ) {
    return state;
  }
  return null;
}

function reconcileDraft(
  previous: AthleteSettingsFormState | null,
  effective: RuntimeConfigSnapshot["intervals"],
): string {
  if (
    effective.credential_configured &&
    !effective.managedByEnvironment.athleteId &&
    previous !== null &&
    previous.draft !== previous.effective.athlete_id
  ) {
    return previous.draft;
  }
  return effective.athlete_id;
}

export function createAthleteSettingsController(input: {
  readonly clients: DesktopCoachClientProvider;
  readonly view: AthleteSettingsView;
  readonly beginMutation: () => (() => void) | null;
  readonly openSetup: () => void;
}): AthleteSettingsController {
  let currentState: AthleteSettingsState = { status: "closed" };
  let generation = 0;
  let disposed = false;
  let operation: Promise<void> | undefined;
  let reconnectRequired = false;
  let failedClient: DesktopCoachClient | undefined;

  const render = (state: Exclude<AthleteSettingsState, { readonly status: "closed" }>): void => {
    currentState = state;
    input.view.render(state);
  };

  const clientForOperation = async (): Promise<DesktopCoachClient> => {
    if (!reconnectRequired) return input.clients.getClient();
    const current = await input.clients.getClient();
    const client =
      failedClient !== undefined && current === failedClient
        ? await input.clients.reconnect({ kind: "failed-client", client: failedClient })
        : current;
    reconnectRequired = false;
    failedClient = undefined;
    return client;
  };

  const noteFailure = (error: unknown, client: DesktopCoachClient | undefined): void => {
    if (error instanceof CoachClientDisconnectedError) {
      reconnectRequired = true;
      failedClient = client;
    }
  };

  const startLoad = (preserveDraft: boolean): Promise<void> => {
    if (disposed || operation !== undefined) return operation ?? Promise.resolve();
    const previous = preserveDraft ? editableState(currentState) : null;
    const operationGeneration = ++generation;
    if (previous === null) render({ status: "loading" });
    else render({ ...previous, status: "refreshing" });
    let activeClient: DesktopCoachClient | undefined;
    const pending = Promise.resolve()
      .then(async () => {
        activeClient = await clientForOperation();
        return activeClient.call("getRuntimeConfig", {});
      })
      .then(
        (snapshot) => {
          if (disposed || generation !== operationGeneration) return;
          const draft = reconcileDraft(previous, snapshot.intervals);
          render({ status: "ready", ...formState(snapshot.intervals, draft) });
        },
        (error: unknown) => {
          noteFailure(error, activeClient);
          if (disposed || generation !== operationGeneration) return;
          if (previous === null) {
            render({ status: "error", kind: "load", reason: "runtime-unavailable" });
          } else {
            render({
              ...previous,
              status: "error",
              kind: "save",
              reason: "runtime-unavailable",
            });
          }
        },
      )
      .finally(() => {
        if (operation === pending) operation = undefined;
      });
    operation = pending;
    return pending;
  };

  const change = (value: string): void => {
    if (disposed || currentState.status === "saving" || currentState.status === "refreshing")
      return;
    const editable = editableState(currentState);
    if (
      editable === null ||
      !editable.effective.credential_configured ||
      editable.effective.managedByEnvironment.athleteId
    ) {
      return;
    }
    render({ status: "ready", ...formState(editable.effective, value) });
  };

  const save = (): Promise<void> => {
    if (disposed || operation !== undefined) return operation ?? Promise.resolve();
    const editable = editableState(currentState);
    if (
      editable === null ||
      !editable.dirty ||
      editable.validationError !== null ||
      !editable.effective.credential_configured ||
      editable.effective.managedByEnvironment.athleteId
    ) {
      return Promise.resolve();
    }
    const releaseMutation = input.beginMutation();
    if (releaseMutation === null) return Promise.resolve();
    const operationGeneration = ++generation;
    render({ ...editable, status: "saving" });
    let activeClient: DesktopCoachClient | undefined;
    let applied = false;
    const pending = Promise.resolve()
      .then(async () => {
        activeClient = await clientForOperation();
        const result = await activeClient.call("configureRuntime", {
          intervals: { athlete_id: editable.draft },
        });
        if (result.status === "refused") return result;
        if (result.applied.intervals !== true) throw new CoachClientProtocolError();
        applied = true;
        return activeClient.call("getRuntimeConfig", {});
      })
      .then(
        (result) => {
          if (disposed || generation !== operationGeneration) return;
          if (!("intervals" in result)) {
            render({
              ...editable,
              status: "error",
              kind: "save",
              reason: result.reason,
            });
            return;
          }
          render({
            status: "saved",
            ...formState(result.intervals, result.intervals.athlete_id),
          });
        },
        (error: unknown) => {
          noteFailure(error, activeClient);
          if (disposed || generation !== operationGeneration) return;
          render({
            ...editable,
            status: "error",
            kind: "save",
            reason: applied
              ? "runtime-unavailable"
              : error instanceof CoachClientProtocolError
                ? "not-applied"
                : "request-failed",
          });
        },
      )
      .finally(() => {
        releaseMutation();
        if (operation === pending) operation = undefined;
      });
    operation = pending;
    return pending;
  };

  const openSetup = (): void => {
    const editable = editableState(currentState);
    const credentialRequired =
      editable?.effective.credential_configured === false ||
      (currentState.status === "error" &&
        currentState.kind === "save" &&
        currentState.reason === "credential-required");
    if (disposed || !credentialRequired) return;
    input.openSetup();
  };

  input.view.bind({
    onRetry: () => void startLoad(currentState.status === "error" && currentState.kind === "save"),
    onChange: change,
    onSave: () => void save(),
    onOpenSetup: openSetup,
  });

  return {
    activate() {
      if (disposed) return Promise.resolve();
      if (currentState.status !== "closed") return operation ?? Promise.resolve();
      return startLoad(false);
    },
    close() {
      if (disposed) return;
      ++generation;
      operation = undefined;
      currentState = { status: "closed" };
    },
    state: () => currentState,
    dispose() {
      if (disposed) return;
      disposed = true;
      ++generation;
      operation = undefined;
      currentState = { status: "closed" };
      input.view.dispose();
    },
  };
}
