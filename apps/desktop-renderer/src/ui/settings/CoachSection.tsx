import { modelHintMessage, modelLabelMessage } from "../onboarding/copy";
import type { Phrasebook } from "@enduragent/i18n/messages";
import { usePhrasebook } from "@enduragent/i18n/react";
import { useEffect, useRef, type ReactElement } from "react";
import { Button } from "@enduragent/ui";
import { CUSTOM_MODEL_SELECTION, ONBOARDING_LLM_PROVIDER_LABELS } from "../../onboarding/constants";
import type {
  ProviderModelFormState,
  ProviderModelSettingsState,
} from "../../settings/provider-model-controller";
import { settingsMutationActive } from "../../state/settings-slice";
import { useEnduragentStore } from "../../state/store";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@enduragent/ui";
import { COACH_SAVE_ERROR_COPY, COACH_VALIDATION_COPY, providerLabelMessage } from "./copy";
import { settingsStyles as styles } from "./styles";

function formState(state: ProviderModelSettingsState): ProviderModelFormState | null {
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

function providerLabel(value: string, say: Phrasebook["say"]): string {
  const message = providerLabelMessage(value);
  return message === null ? value : say(message);
}

function modelText(value: string, say: Phrasebook["say"]): string {
  const message = modelLabelMessage(value);
  return message === null ? value : say(message);
}

function modelHint(value: string, say: Phrasebook["say"]): string {
  const message = modelHintMessage(value);
  return message === null ? value : say(message);
}

function modelLabel(form: ProviderModelFormState, say: Phrasebook["say"]): string {
  const draft = form.draft;
  if (draft === null) return "";
  if (draft.modelChoice === CUSTOM_MODEL_SELECTION) {
    return draft.customModel.trim() || say("settings.coach.chooseModel");
  }
  return modelText(
    draft.provider.models.find((model) => model.value === draft.modelChoice)?.label ??
      draft.modelChoice,
    say,
  );
}

function routeLabel(form: ProviderModelFormState, say: Phrasebook["say"]): string | null {
  if (form.draft !== null) {
    return `${providerLabel(ONBOARDING_LLM_PROVIDER_LABELS[form.draft.provider.provider], say)} → ${modelLabel(form, say)}`;
  }
  if (form.active === null) return null;
  return `${providerLabel(ONBOARDING_LLM_PROVIDER_LABELS[form.active.provider], say)} → ${form.active.model}`;
}

function feedbackCopy(state: ProviderModelSettingsState, say: Phrasebook["say"]): string | null {
  if (state.status === "closed" || state.status === "loading") return say("settings.coach.loading");
  if (state.status === "error" && state.kind === "load") {
    return say("settings.coach.unavailable");
  }
  if (state.status === "saving") return say("settings.coach.saving");
  if (state.status === "saved") return say("settings.coach.saved");
  if (state.status === "error" && state.kind === "save")
    return say(COACH_SAVE_ERROR_COPY[state.reason]);
  return null;
}

export function CoachSection(): ReactElement {
  const { say } = usePhrasebook();
  const state = useEnduragentStore((store) => store.settings.coach);
  const mutating = useEnduragentStore((store) => settingsMutationActive(store.settings));
  const port = useEnduragentStore((store) => store.settingsPorts?.coach ?? null);
  const customModel = useRef<HTMLInputElement>(null);
  const focusCustomModel = useRef(false);

  const editable = formState(state);
  const draft = editable?.draft ?? null;
  const custom = draft?.modelChoice === CUSTOM_MODEL_SELECTION;

  useEffect(() => {
    if (!focusCustomModel.current) return;
    focusCustomModel.current = false;
    if (custom) customModel.current?.focus();
  }, [custom]);

  const loadError = state.status === "error" && state.kind === "load";
  const credentialRequired =
    state.status === "error" && state.kind === "save" && state.reason === "credential-required";
  const saving = state.status === "saving";
  const canSave =
    editable !== null && draft !== null && editable.dirty && editable.validationError === null;
  const feedback = feedbackCopy(state, say);
  const routeSummary = editable === null ? null : routeLabel(editable, say);
  const route = routeSummary ?? say("settings.coach.notConfigured");
  const providerChangeRequired = editable?.providerChangeRequired === true;
  const routeState =
    routeSummary === null
      ? say("settings.coach.inactive")
      : providerChangeRequired
        ? say("settings.coach.changeRequired")
        : editable?.dirty === true
          ? say("settings.coach.unsaved")
          : say("settings.coach.active");
  const validation =
    editable?.validationError == null ? "" : say(COACH_VALIDATION_COPY[editable.validationError]);

  return (
    <>
      <h2 className={styles.heading}>{say("settings.coach.title")}</h2>
      <section className={styles.group} aria-label={say("settings.coach.title")}>
        <div className={styles.row}>
          <div className={styles.label}>
            <div className={styles.rowTitle}>{say("settings.coach.route")}</div>
            <div className={styles.rowDetail}>{route}</div>
          </div>
          <span
            className={styles.runtime}
            data-state={routeSummary === null || providerChangeRequired ? "failed" : "active"}
          >
            {routeState}
          </span>
        </div>
        {editable === null ? null : (
          <>
            {providerChangeRequired ? (
              <p className={styles.feedback} role="alert">
                {say("settings.coach.unsupported", {
                  operatingSystem: "Windows",
                  codex: "Codex",
                  claude: "Claude",
                })}
              </p>
            ) : null}
            <div className={styles.row}>
              <div className={styles.label} id="coach-provider-label">
                <span className={styles.rowTitle}>{say("settings.coach.provider")}</span>
                <span className={styles.rowDetail}>
                  {editable.active === null
                    ? say("settings.coach.activeUnavailable")
                    : say("settings.coach.currentRoute", {
                        provider: providerLabel(
                          ONBOARDING_LLM_PROVIDER_LABELS[editable.active.provider],
                          say,
                        ),
                        model: editable.active.model,
                      })}
                </span>
              </div>
              <Select
                items={editable.providers.map((entry) => ({
                  value: entry.provider,
                  label: providerLabel(ONBOARDING_LLM_PROVIDER_LABELS[entry.provider], say),
                }))}
                value={draft?.provider.provider ?? null}
                disabled={mutating}
                onValueChange={(value) => {
                  if (value !== null) port?.changeProvider(value);
                }}
              >
                <SelectTrigger
                  id="coach-provider"
                  className={styles.control}
                  aria-labelledby="coach-provider-label"
                >
                  <SelectValue placeholder={say("settings.coach.chooseProvider")} />
                </SelectTrigger>
                <SelectContent align="end">
                  {editable.providers.map((entry) => (
                    <SelectItem key={entry.provider} value={entry.provider}>
                      {providerLabel(ONBOARDING_LLM_PROVIDER_LABELS[entry.provider], say)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className={styles.row}>
              <div className={styles.label} id="coach-model-label">
                <span className={styles.rowTitle}>{say("settings.coach.model")}</span>
              </div>
              <Select
                items={
                  draft === null
                    ? []
                    : draft.provider.models
                        .map((entry) => ({
                          value: entry.value,
                          label:
                            entry.hint === undefined
                              ? modelText(entry.label, say)
                              : `${modelText(entry.label, say)} · ${modelHint(entry.hint, say)}`,
                        }))
                        .concat({
                          value: CUSTOM_MODEL_SELECTION,
                          label: say("settings.coach.otherModel"),
                        })
                }
                value={draft?.modelChoice ?? null}
                disabled={mutating || draft === null}
                onValueChange={(value) => {
                  if (value === null) return;
                  focusCustomModel.current = value === CUSTOM_MODEL_SELECTION;
                  port?.changeModel(value);
                }}
              >
                <SelectTrigger
                  id="coach-model"
                  className={styles.control}
                  aria-labelledby="coach-model-label"
                >
                  <SelectValue placeholder={say("settings.coach.chooseProviderFirst")} />
                </SelectTrigger>
                <SelectContent align="end">
                  {draft === null ? null : (
                    <>
                      {draft.provider.models.map((entry) => (
                        <SelectItem key={entry.value} value={entry.value}>
                          {entry.hint === undefined
                            ? modelText(entry.label, say)
                            : `${modelText(entry.label, say)} · ${modelHint(entry.hint, say)}`}
                        </SelectItem>
                      ))}
                      <SelectItem value={CUSTOM_MODEL_SELECTION}>
                        {say("settings.coach.otherModel")}
                      </SelectItem>
                    </>
                  )}
                </SelectContent>
              </Select>
            </div>
            {custom && draft !== null ? (
              <div className={`${styles.row} ${styles.rowStacked}`}>
                <label className={styles.rowTitle} htmlFor="coach-custom-model">
                  {say("settings.coach.customModel")}
                </label>
                <input
                  id="coach-custom-model"
                  ref={customModel}
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  className={`${styles.control} ${styles.controlWide}`}
                  value={draft.customModel}
                  disabled={mutating}
                  aria-invalid={editable.validationError === null ? undefined : "true"}
                  aria-describedby="coach-model-validation"
                  onChange={(event) => {
                    port?.changeCustomModel(event.target.value);
                  }}
                />
                <p className={styles.error} id="coach-model-validation" aria-live="polite">
                  {validation}
                </p>
              </div>
            ) : null}
            <div className={styles.row}>
              <div className={styles.label}>
                <div className={styles.rowTitle}>{say("settings.coach.endpoint")}</div>
                <div className={styles.rowDetail}>
                  {say("settings.coach.endpointDetail", { product: "Enduragent" })}
                </div>
              </div>
              <span className={styles.amount}>{say("settings.coach.automatic")}</span>
            </div>
          </>
        )}
        {feedback === null ? null : (
          <p className={styles.feedback} role="status" aria-live="polite" aria-atomic="true">
            {feedback}
          </p>
        )}
        <div className={styles.actions}>
          {loadError ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={mutating}
              onClick={() => {
                port?.retry();
              }}
            >
              {say("settings.coach.retry")}
            </Button>
          ) : null}
          {credentialRequired ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={mutating}
              onClick={() => {
                port?.openSetup();
              }}
            >
              {say("settings.coach.reviewSetup")}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="default"
            size="sm"
            disabled={mutating || !canSave}
            onClick={() => {
              port?.save();
            }}
          >
            {saving ? say("settings.saving") : say("settings.coach.save")}
          </Button>
        </div>
      </section>
    </>
  );
}
