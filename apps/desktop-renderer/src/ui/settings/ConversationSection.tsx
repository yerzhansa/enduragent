import type { Phrasebook } from "@enduragent/i18n/messages";
import { usePhrasebook } from "@enduragent/i18n/react";
import type { ReactElement } from "react";
import { Button } from "@enduragent/ui";
import type {
  SessionSettingsFormState,
  SessionSettingsState,
} from "../../settings/session-controller";
import { useEnduragentStore } from "../../state/store";
import {
  CONVERSATION_FIELDS,
  MANAGED_BY_ENVIRONMENT_COPY,
  conversationSaveErrorCopy,
  conversationValidationMessage,
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

function feedbackCopy(state: SessionSettingsState, say: Phrasebook["say"]): string | null {
  if (state.status === "closed" || state.status === "loading") {
    return say("settings.conversation.loading");
  }
  if (state.status === "refreshing") return say("settings.conversation.refreshing");
  if (state.status === "error" && state.kind === "load") {
    return say("settings.conversation.unavailable");
  }
  if (state.status === "saving") return say("settings.conversation.saving");
  if (state.status === "saved") return say("settings.conversation.saved");
  if (state.status === "error" && state.kind === "save") {
    return say(conversationSaveErrorCopy(state.reason));
  }
  return null;
}

export function ConversationSection(): ReactElement {
  const { say } = usePhrasebook();
  const state = useEnduragentStore((store) => store.settings.conversation);
  const port = useEnduragentStore((store) => store.settingsPorts?.conversation ?? null);
  const controlsDisabled = useEnduragentStore((store) =>
    store.settings.savingOwners.some((owner) => owner !== "session"),
  );

  const editable = formState(state);
  const busy =
    controlsDisabled ||
    state.status === "refreshing" ||
    state.status === "loading" ||
    state.status === "closed";
  const retryVisible = state.status === "error" && (state.kind === "load" || state.kind === "save");
  const feedback = feedbackCopy(state, say);

  return (
    <>
      <h2 className={styles.heading}>{say("settings.conversation.title")}</h2>
      <section className={styles.group} aria-label={say("settings.conversation.ariaLabel")}>
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
                    {say(definition.label)}
                  </label>
                  <input
                    id={id}
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    className={`${styles.control} ${styles.controlWide}`}
                    value={editable.draft[definition.field]}
                    disabled={busy || managed}
                    aria-invalid={error === undefined ? undefined : "true"}
                    aria-describedby={describedBy}
                    onChange={(event) => {
                      port?.change(definition.field, event.target.value);
                    }}
                    onBlur={() => port?.commit()}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        port?.commit();
                      }
                    }}
                  />
                  <p className={styles.help} id={`${id}-help`}>
                    {say(definition.help)}
                  </p>
                  {managed ? (
                    <p className={styles.help} id={`${id}-managed`}>
                      {say(MANAGED_BY_ENVIRONMENT_COPY)}
                    </p>
                  ) : null}
                  <p className={styles.error} id={`${id}-error`} aria-live="polite">
                    {error === undefined
                      ? ""
                      : say(conversationValidationMessage(definition.field))}
                  </p>
                </div>
              );
            })}
        {feedback === null ? null : (
          <p className={styles.feedback} role="status" aria-live="polite" aria-atomic="true">
            {feedback}
          </p>
        )}
        {retryVisible ? (
          <div className={styles.actions}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                port?.retry();
              }}
            >
              {say("settings.conversation.reload")}
            </Button>
          </div>
        ) : null}
      </section>
    </>
  );
}
