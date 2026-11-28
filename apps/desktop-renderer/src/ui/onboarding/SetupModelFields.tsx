import { modelHintMessage, modelLabelMessage } from "./copy";
import { usePhrasebook } from "@enduragent/i18n/react";
import type { ReactElement } from "react";
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@enduragent/ui";
import type { SavedModel } from "../../onboarding/bridge";
import { CUSTOM_MODEL_SELECTION } from "../../onboarding/constants";
import type { OnboardingActions } from "../../onboarding/controller";
import { retiredModel, type LlmSelectionDraft } from "../../onboarding/selection";
import { SELECT_LIST_FIT_CLASS } from "../select-list";
import {
  SETUP_FIELD_CLASS,
  SETUP_HINT_CLASS,
  SETUP_LABEL_CLASS,
  SETUP_SELECT_CLASS,
} from "./SetupCard";

export function SetupModelFields(props: {
  readonly draft: LlmSelectionDraft;
  readonly active: SavedModel | null;
  readonly actions: OnboardingActions | null;
  readonly disabled: boolean;
  readonly describedBy: string | undefined;
  readonly onSwitch: (model: string) => void;
}): ReactElement {
  const { say } = usePhrasebook();
  const { draft, actions, disabled, describedBy } = props;
  const modelLabel = (value: string): string => {
    const message = modelLabelMessage(value);
    return message === null ? value : say(message);
  };
  const modelHint = (value: string): string => {
    const message = modelHintMessage(value);
    return message === null ? value : say(message);
  };
  const retired = retiredModel(props.active, draft.provider);
  const replacedBy = retired?.replacedBy ?? null;
  const noticeShown = retired !== null && draft.modelChoice === retired.model;
  const options = [
    ...draft.provider.models.map((model) => ({
      value: model.value,
      label:
        model.hint === undefined
          ? modelLabel(model.label)
          : say("setup.ai.modelHint", {
              model: modelLabel(model.label),
              hint: modelHint(model.hint),
            }),
    })),
    ...(retired === null
      ? []
      : [{ value: retired.model, label: say("setup.ai.retiredModel", { model: retired.model }) }]),
    { value: CUSTOM_MODEL_SELECTION, label: say("setup.ai.otherModel") },
  ];
  return (
    <>
      <div>
        <label className={SETUP_LABEL_CLASS} htmlFor="onboarding-llm-model">
          {say("setup.ai.model")}
        </label>
        <Select
          disabled={disabled}
          items={options}
          value={draft.modelChoice}
          onValueChange={(value) => {
            if (value !== null) actions?.selectModel(value);
          }}
        >
          <SelectTrigger
            id="onboarding-llm-model"
            className={SETUP_SELECT_CLASS}
            aria-describedby={noticeShown ? "onboarding-llm-model-retired" : undefined}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start" className={SELECT_LIST_FIT_CLASS}>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {noticeShown ? (
          <>
            <p className={SETUP_HINT_CLASS} id="onboarding-llm-model-retired">
              {say(
                replacedBy === null
                  ? "setup.ai.retiredNoticeNoReplacement"
                  : "setup.ai.retiredNotice",
                { model: retired.model },
              )}
            </p>
            {replacedBy === null ? null : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                disabled={disabled}
                onClick={() => {
                  props.onSwitch(replacedBy);
                }}
              >
                {say("setup.ai.switchModel", {
                  model: modelLabel(
                    draft.provider.models.find((model) => model.value === replacedBy)?.label ??
                      replacedBy,
                  ),
                })}
              </Button>
            )}
          </>
        ) : null}
      </div>
      {draft.modelChoice === CUSTOM_MODEL_SELECTION ? (
        <div>
          <label className={SETUP_LABEL_CLASS} htmlFor="onboarding-custom-model">
            {say("setup.ai.customModel")}
          </label>
          <input
            id="onboarding-custom-model"
            className={SETUP_FIELD_CLASS}
            type="text"
            autoComplete="off"
            maxLength={512}
            disabled={disabled}
            value={draft.customModel}
            aria-describedby={describedBy}
            onChange={(event) => {
              actions?.setCustomModel(event.target.value);
            }}
          />
        </div>
      ) : null}
    </>
  );
}
