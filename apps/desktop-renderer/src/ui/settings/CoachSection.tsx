import { useEffect, useRef, type ReactElement } from "react";
import { Button } from "@enduragent/ui";
import {
  CUSTOM_MODEL_SELECTION,
  ONBOARDING_LLM_PROVIDER_LABELS,
} from "../../onboarding/constants";
import type {
  ProviderModelFormState,
  ProviderModelSettingsState,
} from "../../settings/provider-model-controller";
import { settingsMutationActive } from "../../state/settings-slice";
import { useEnduragentStore } from "../../state/store";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@enduragent/ui";
import { COACH_SAVE_ERROR_COPY, COACH_VALIDATION_COPY } from "./copy";
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

function modelLabel(form: ProviderModelFormState): string {
  const draft = form.draft;
  if (draft === null) return "";
  if (draft.modelChoice === CUSTOM_MODEL_SELECTION) {
    return draft.customModel.trim() || "Choose a model";
  }
  return (
    draft.provider.models.find((model) => model.value === draft.modelChoice)?.label ??
    draft.modelChoice
  );
}

function routeLabel(form: ProviderModelFormState): string | null {
  if (form.draft !== null) {
    return `${ONBOARDING_LLM_PROVIDER_LABELS[form.draft.provider.provider]} → ${modelLabel(form)}`;
  }
  if (form.active === null) return null;
  return `${ONBOARDING_LLM_PROVIDER_LABELS[form.active.provider]} → ${form.active.model}`;
}

function feedbackCopy(state: ProviderModelSettingsState): string | null {
  if (state.status === "closed" || state.status === "loading") return "Loading coach settings…";
  if (state.status === "error" && state.kind === "load") {
    return "Coach settings aren’t available right now. Try again.";
  }
  if (state.status === "saving") return "Saving coach settings…";
  if (state.status === "saved") return "Coach settings saved.";
  if (state.status === "error" && state.kind === "save") return COACH_SAVE_ERROR_COPY[state.reason];
  return null;
}

export function CoachSection(): ReactElement {
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
  const feedback = feedbackCopy(state);
  const routeSummary = editable === null ? null : routeLabel(editable);
  const route = routeSummary ?? "Not configured";
  const providerChangeRequired = editable?.providerChangeRequired === true;
  const routeState =
    routeSummary === null
      ? "Not active"
      : providerChangeRequired
        ? "Change required"
        : editable?.dirty === true
          ? "Unsaved"
          : "Active";
  const validation =
    editable?.validationError == null ? "" : COACH_VALIDATION_COPY[editable.validationError];

  return (
    <>
      <h2 className={styles.heading}>Coach</h2>
      <section className={styles.group} aria-label="Coach">
        <div className={styles.row}>
          <div className={styles.label}>
            <div className={styles.rowTitle}>Coach route</div>
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
                Codex agent isn’t supported on Windows. Choose Claude subscription or an API-key
                provider, then save the coach route. Your credentials, athlete data, conversations,
                and other settings stay unchanged.
              </p>
            ) : null}
            <div className={styles.row}>
              <div className={styles.label} id="coach-provider-label">
                <span className={styles.rowTitle}>Provider</span>
                <span className={styles.rowDetail}>
                  {editable.active === null
                    ? "Active coach settings are unavailable or not configured."
                    : `Currently active: ${ONBOARDING_LLM_PROVIDER_LABELS[editable.active.provider]} · ${editable.active.model}`}
                </span>
              </div>
              <Select
                items={editable.providers.map((entry) => ({
                  value: entry.provider,
                  label: ONBOARDING_LLM_PROVIDER_LABELS[entry.provider],
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
                  <SelectValue placeholder="Choose a provider" />
                </SelectTrigger>
                <SelectContent align="end">
                  {editable.providers.map((entry) => (
                    <SelectItem key={entry.provider} value={entry.provider}>
                      {ONBOARDING_LLM_PROVIDER_LABELS[entry.provider]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className={styles.row}>
              <div className={styles.label} id="coach-model-label">
                <span className={styles.rowTitle}>Model</span>
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
                              ? entry.label
                              : `${entry.label} · ${entry.hint}`,
                        }))
                        .concat({ value: CUSTOM_MODEL_SELECTION, label: "Other model…" })
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
                  <SelectValue placeholder="Choose a provider first" />
                </SelectTrigger>
                <SelectContent align="end">
                  {draft === null ? null : (
                    <>
                      {draft.provider.models.map((entry) => (
                        <SelectItem key={entry.value} value={entry.value}>
                          {entry.hint === undefined
                            ? entry.label
                            : `${entry.label} · ${entry.hint}`}
                        </SelectItem>
                      ))}
                      <SelectItem value={CUSTOM_MODEL_SELECTION}>Other model…</SelectItem>
                    </>
                  )}
                </SelectContent>
              </Select>
            </div>
            {custom && draft !== null ? (
              <div className={`${styles.row} ${styles.rowStacked}`}>
                <label className={styles.rowTitle} htmlFor="coach-custom-model">
                  Custom model name
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
                <div className={styles.rowTitle}>Endpoint</div>
                <div className={styles.rowDetail}>
                  Enduragent picks the provider’s endpoint for this route.
                </div>
              </div>
              <span className={styles.amount}>Automatic</span>
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
              Retry
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
              Review setup
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
            {saving ? "Saving…" : "Save coach route"}
          </Button>
        </div>
      </section>
    </>
  );
}
