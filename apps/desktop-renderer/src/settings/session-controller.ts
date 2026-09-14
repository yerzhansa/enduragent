import { CoachClientDisconnectedError, CoachClientProtocolError } from "@enduragent/coach-client";
import type { RuntimeConfigSnapshot } from "@enduragent/coach-contract";
import type { DesktopCoachClient, DesktopCoachClientProvider } from "../coach-client";

export const SESSION_SETTING_FIELDS = ["timezone"] as const;

export type SessionSettingField = (typeof SESSION_SETTING_FIELDS)[number];

export type SessionSettingsValidationErrors = Readonly<
  Partial<Record<SessionSettingField, string>>
>;

export interface SessionSettingsDraft {
  readonly timezone: string;
}

export interface SessionSettingsFormState {
  readonly effective: RuntimeConfigSnapshot["session"];
  readonly draft: SessionSettingsDraft;
  readonly dirtyFields: ReadonlySet<SessionSettingField>;
  readonly validationErrors: SessionSettingsValidationErrors;
}

export type SessionSettingsState =
  | { readonly status: "closed" }
  | { readonly status: "loading" }
  | ({ readonly status: "ready" | "refreshing" | "saving" | "saved" } & SessionSettingsFormState)
  | {
      readonly status: "error";
      readonly kind: "load";
      readonly reason: "runtime-unavailable";
    }
  | ({
      readonly status: "error";
      readonly kind: "save";
      readonly reason: "request-failed" | "not-applied" | "runtime-unavailable";
    } & SessionSettingsFormState);

export interface SessionSettingsView {
  bind(handlers: {
    readonly onRetry: () => void;
    readonly onChange: (field: SessionSettingField, value: string) => void;
    readonly onCommit: () => void;
  }): void;
  render(state: Exclude<SessionSettingsState, { readonly status: "closed" }>): void;
  dispose(): void;
}

export interface SessionSettingsController {
  activate(): Promise<void>;
  close(): void;
  state(): SessionSettingsState;
  dispose(): void;
}

type SaveAttempt =
  | { readonly kind: "applied"; readonly snapshot: RuntimeConfigSnapshot }
  | {
      readonly kind: "failed";
      readonly reason: "request-failed" | "not-applied" | "runtime-unavailable";
    };

function systemTimezone(): string {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return timezone.length > 0 ? timezone : "UTC";
}

function effectiveTimezone(value: string): string {
  return value.length === 0 ? systemTimezone() : value;
}

function draftFrom(effective: RuntimeConfigSnapshot["session"]): SessionSettingsDraft {
  return { timezone: effectiveTimezone(effective.timezone) };
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159));
  });
}

function validTimezone(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value ||
    hasControlCharacters(value)
  ) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function isManaged(effective: RuntimeConfigSnapshot["session"]): boolean {
  return effective.managedByEnvironment.timezone;
}

function draftChanged(form: SessionSettingsFormState): boolean {
  return form.draft.timezone !== effectiveTimezone(form.effective.timezone);
}

function formState(
  effective: RuntimeConfigSnapshot["session"],
  draft: SessionSettingsDraft,
): SessionSettingsFormState {
  const managed = isManaged(effective);
  const valid = validTimezone(draft.timezone);
  return {
    effective,
    draft,
    dirtyFields: new Set<SessionSettingField>(
      !managed && valid && draft.timezone !== effectiveTimezone(effective.timezone)
        ? ["timezone"]
        : [],
    ),
    validationErrors:
      managed || valid ? {} : { timezone: "Enter a valid IANA timezone, such as Europe/London." },
  };
}

function editableState(state: SessionSettingsState): SessionSettingsFormState | null {
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
  previous: SessionSettingsFormState | null,
  effective: RuntimeConfigSnapshot["session"],
): SessionSettingsDraft {
  if (previous !== null && !isManaged(effective) && draftChanged(previous)) {
    return previous.draft;
  }
  return draftFrom(effective);
}

function requestFailure(error: unknown): "request-failed" | "not-applied" {
  return error instanceof CoachClientProtocolError ? "not-applied" : "request-failed";
}

export function createSessionSettingsController(input: {
  readonly clients: DesktopCoachClientProvider;
  readonly view: SessionSettingsView;
  readonly beginMutation: () => (() => void) | null;
}): SessionSettingsController {
  let currentState: SessionSettingsState = { status: "closed" };
  let generation = 0;
  let disposed = false;
  let visible = false;
  let loadOperation: Promise<void> | undefined;
  let saveOperation: Promise<void> | undefined;
  let queuedTimezone: string | undefined;
  let reconnectRequired = false;
  let failedClient: DesktopCoachClient | undefined;

  const render = (state: Exclude<SessionSettingsState, { readonly status: "closed" }>): void => {
    currentState = state;
    if (visible && !disposed) input.view.render(state);
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
    if (disposed) return Promise.resolve();
    if (saveOperation !== undefined) return saveOperation;
    if (loadOperation !== undefined) return loadOperation;
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
          const draft = reconcileDraft(previous, snapshot.session);
          render({ status: "ready", ...formState(snapshot.session, draft) });
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
        if (loadOperation === pending) loadOperation = undefined;
      });
    loadOperation = pending;
    return pending;
  };

  const attemptSave = async (timezone: string): Promise<SaveAttempt> => {
    let activeClient: DesktopCoachClient | undefined;
    try {
      activeClient = await clientForOperation();
      const result = await activeClient.call("configureRuntime", {
        session: { timezone },
      });
      if (result.status !== "applied" || result.applied.session !== true) {
        throw new CoachClientProtocolError();
      }
    } catch (error) {
      noteFailure(error, activeClient);
      return { kind: "failed", reason: requestFailure(error) };
    }
    try {
      const snapshot = await activeClient.call("getRuntimeConfig", {});
      return { kind: "applied", snapshot };
    } catch (error) {
      noteFailure(error, activeClient);
      return { kind: "failed", reason: "runtime-unavailable" };
    }
  };

  const drain = async (): Promise<void> => {
    while (!disposed && queuedTimezone !== undefined) {
      const timezone = queuedTimezone;
      queuedTimezone = undefined;
      const editable = editableState(currentState);
      if (editable === null || isManaged(editable.effective)) return;
      if (timezone === effectiveTimezone(editable.effective.timezone)) continue;
      const result = await attemptSave(timezone);
      if (disposed) return;
      const latest = editableState(currentState);
      if (latest === null) return;
      if (result.kind === "failed") {
        queuedTimezone = undefined;
        render({ ...latest, status: "error", kind: "save", reason: result.reason });
        return;
      }
      const authoritative = result.snapshot.session;
      const draft =
        !isManaged(authoritative) && latest.draft.timezone !== timezone
          ? latest.draft
          : draftFrom(authoritative);
      const next = formState(authoritative, draft);
      if (
        latest.draft.timezone === timezone &&
        effectiveTimezone(authoritative.timezone) !== timezone
      ) {
        render({
          ...next,
          draft: latest.draft,
          status: "error",
          kind: "save",
          reason: "not-applied",
        });
        return;
      }
      render({ ...next, status: "saving" });
    }
    if (disposed) return;
    const latest = editableState(currentState);
    if (latest === null) return;
    const nextStatus =
      latest.dirtyFields.size > 0 || Object.keys(latest.validationErrors).length > 0
        ? "ready"
        : "saved";
    render({ ...latest, status: nextStatus });
  };

  const change = (field: SessionSettingField, value: string): void => {
    if (disposed || !visible) return;
    const editable = editableState(currentState);
    if (editable === null || isManaged(editable.effective) || field !== "timezone") return;
    queuedTimezone = undefined;
    const next = formState(editable.effective, { timezone: value });
    render({ ...next, status: saveOperation === undefined ? "ready" : "saving" });
  };

  const commit = (): void => {
    if (disposed || !visible) return;
    if (currentState.status === "error" && currentState.kind === "save") {
      reloadAndCommit();
      return;
    }
    const editable = editableState(currentState);
    if (
      editable === null ||
      isManaged(editable.effective) ||
      editable.validationErrors.timezone !== undefined ||
      (editable.dirtyFields.size === 0 && saveOperation === undefined)
    ) {
      return;
    }
    queuedTimezone = editable.draft.timezone;
    if (saveOperation !== undefined) return;
    const releaseMutation = input.beginMutation();
    if (releaseMutation === null) {
      queuedTimezone = undefined;
      return;
    }
    render({ ...editable, status: "saving" });
    const pending = Promise.resolve().then(async () => {
      try {
        do {
          await drain();
        } while (!disposed && queuedTimezone !== undefined);
      } finally {
        if (saveOperation === pending) saveOperation = undefined;
        if (!visible) currentState = { status: "closed" };
        releaseMutation();
      }
    });
    saveOperation = pending;
  };

  const reloadAndCommit = (): void => {
    void startLoad(true).then(() => {
      if (disposed || !visible || currentState.status !== "ready") return;
      if (
        currentState.dirtyFields.size === 0 &&
        Object.keys(currentState.validationErrors).length === 0
      ) {
        render({ ...currentState, status: "saved" });
        return;
      }
      commit();
    });
  };

  const retry = (): void => {
    if (disposed || !visible) return;
    if (currentState.status === "error" && currentState.kind === "load") {
      void startLoad(false);
      return;
    }
    if (currentState.status !== "error" || currentState.kind !== "save") return;
    reloadAndCommit();
  };

  input.view.bind({
    onRetry: retry,
    onChange: change,
    onCommit: commit,
  });

  const activate = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    visible = true;
    if (currentState.status !== "closed") {
      input.view.render(currentState);
      return loadOperation ?? saveOperation ?? Promise.resolve();
    }
    return startLoad(false);
  };

  return {
    activate,
    close() {
      if (disposed) return;
      visible = false;
      if (loadOperation !== undefined) {
        ++generation;
        loadOperation = undefined;
      }
      if (saveOperation === undefined) currentState = { status: "closed" };
    },
    state: () => (visible ? currentState : { status: "closed" }),
    dispose() {
      if (disposed) return;
      disposed = true;
      visible = false;
      queuedTimezone = undefined;
      ++generation;
      loadOperation = undefined;
      saveOperation = undefined;
      currentState = { status: "closed" };
      input.view.dispose();
    },
  };
}
