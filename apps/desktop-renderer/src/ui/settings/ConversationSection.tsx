import type { ReactElement } from "react";
import { Button } from "@enduragent/ui";
import type {
  SessionSettingsFormState,
  SessionSettingsState,
} from "../../settings/session-controller";
import { settingsMutationActive } from "../../state/settings-slice";
import { useEnduragentStore } from "../../state/store";
import {
  CONVERSATION_FIELDS,
  MANAGED_BY_ENVIRONMENT_COPY,
  conversationSaveErrorCopy,
} from "./copy";
import { settingsStyles as styles } from "./styles";

function formState(state: SessionSettingsState): SessionSettingsFormState | null {
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

function feedbackCopy(state: SessionSettingsState): string | null {
  if (state.status === "closed" || state.status === "loading") {
    return "Loading conversation settings…";
  }
  if (state.status === "refreshing") return "Reconnecting and checking current settings…";
  if (state.status === "error" && state.kind === "load") {
    return "Conversation settings aren’t available. Reconnect and reload.";
  }
  if (state.status === "saving") return "Saving conversation settings…";
  if (state.status === "saved") return "Conversation settings saved.";
  if (state.status === "error" && state.kind === "save") {
    return conversationSaveErrorCopy(state.reason);
  }
  return null;
}

export function ConversationSection(): ReactElement {
  const state = useEnduragentStore((store) => store.settings.conversation);
  const mutating = useEnduragentStore((store) => settingsMutationActive(store.settings));
  const port = useEnduragentStore((store) => store.settingsPorts?.conversation ?? null);

  const editable = formState(state);
  const busy =
    mutating ||
    state.status === "refreshing" ||
    state.status === "loading" ||
    state.status === "closed";
  const saving = state.status === "saving";
  const retryVisible = state.status === "error" && (state.kind === "load" || state.kind === "save");
  const feedback = feedbackCopy(state);
  const canSave =
    editable !== null &&
    editable.dirtyFields.size > 0 &&
    Object.keys(editable.validationErrors).length === 0;

  return (
    <>
      <h2 className={styles.heading}>Conversation &amp; time</h2>
      <section className={styles.group} aria-label="Conversation and time">
        <p className={styles.note}>
          Set when conversations renew and how much recent context your coach carries forward.
        </p>
        {editable === null
          ? null
          : CONVERSATION_FIELDS.map((definition) => {
              const managed = editable.effective.managedByEnvironment[definition.field];
              const error = editable.validationErrors[definition.field];
              const id = `conversation-${definition.field}`;
              const describedBy = [
                `${id}-help`,
                ...(managed ? [`${id}-managed`] : []),
                ...(error === undefined ? [] : [`${id}-error`]),
              ].join(" ");
              return (
                <div key={definition.field} className={`${styles.row} ${styles.rowStacked}`}>
                  <label className={styles.rowTitle} htmlFor={id}>
                    {definition.label}
                    {definition.suffix === undefined ? "" : ` (${definition.suffix})`}
                  </label>
                  <input
                    id={id}
                    type={definition.type}
                    autoComplete="off"
                    inputMode={definition.type === "number" ? "decimal" : undefined}
                    spellCheck={definition.field === "timezone" ? false : undefined}
                    min={definition.min}
                    max={definition.max}
                    step={definition.step}
                    className={`${styles.control} ${styles.controlWide}`}
                    value={editable.draft[definition.field]}
                    disabled={busy || managed}
                    aria-invalid={error === undefined ? undefined : "true"}
                    aria-describedby={describedBy}
                    onChange={(event) => {
                      port?.change(definition.field, event.target.value);
                    }}
                  />
                  <p className={styles.help} id={`${id}-help`}>
                    {definition.help}
                  </p>
                  {managed ? (
                    <p className={styles.help} id={`${id}-managed`}>
                      {MANAGED_BY_ENVIRONMENT_COPY}
                    </p>
                  ) : null}
                  <p className={styles.error} id={`${id}-error`} aria-live="polite">
                    {error ?? ""}
                  </p>
                </div>
              );
            })}
        {feedback === null ? null : (
          <p className={styles.feedback} role="status" aria-live="polite" aria-atomic="true">
            {feedback}
          </p>
        )}
        <div className={styles.actions}>
          {retryVisible ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                port?.retry();
              }}
            >
              Reconnect &amp; reload
            </Button>
          ) : null}
          <Button
            type="button"
            variant="default"
            size="sm"
            disabled={busy || !canSave}
            onClick={() => {
              port?.save();
            }}
          >
            {saving ? "Saving…" : "Save conversation settings"}
          </Button>
        </div>
      </section>
    </>
  );
}
