import type { ReactElement } from "react";
import { Button } from "@enduragent/ui";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@enduragent/ui";
import type { OnboardingActions, OnboardingSurfaceState } from "../../onboarding/controller";
import { errorSection } from "../../onboarding/lanes";
import { RETRY_INTAKE_SAVE_LABEL } from "./copy";
import { SETUP_LINK_BUTTON, SETUP_SELECT_CLASS } from "./SetupCard";
import { SetupError, SetupRow, SetupSubPanel } from "./SetupRow";
import type { SetupPlacement } from "./OnboardingWizard";

const UNSET = "";

const INJURY_OPTIONS = [
  [UNSET, "Select…"],
  ["none", "No current injury"],
  ["managing", "Managing an injury"],
  ["returning", "Returning after an injury"],
] as const;

function IntakeSelect(props: {
  readonly id: string;
  readonly value: string;
  readonly options: ReadonlyArray<readonly [string, string]>;
  readonly disabled: boolean;
  readonly describedBy?: string;
  readonly onSelect: (value: string) => void;
}): ReactElement {
  return (
    <Select
      disabled={props.disabled}
      items={props.options.map(([value, label]) => ({ value, label }))}
      value={props.value}
      onValueChange={(value) => {
        if (value !== null) props.onSelect(value);
      }}
    >
      <SelectTrigger
        id={props.id}
        className={`${SETUP_SELECT_CLASS} w-[180px]`}
        aria-describedby={props.describedBy}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {props.options.map(([value, label]) => (
          <SelectItem key={value} value={value}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function IntakeRows(props: {
  readonly surface: OnboardingSurfaceState;
  readonly actions: OnboardingActions | null;
  readonly placement: SetupPlacement;
}): ReactElement {
  const { surface, actions } = props;
  const wizard = surface.wizard;
  const intake = wizard.intake;
  const controlsDisabled = wizard.busy || surface.loading || surface.loadUnavailable;
  const ownsError = errorSection(wizard.fixedError, surface.lastCommit) === "intake";
  const describedBy = ownsError ? { describedBy: "onboarding-error" } : {};

  return (
    <>
      <SetupRow
        id="injury-status"
        status={intake.injuryStatus === null ? "pending" : "ready"}
        title="Injury status right now"
        subtitle="Records your current injury or return context."
        titleFor="onboarding-injury-status"
        trailing={
          <IntakeSelect
            id="onboarding-injury-status"
            value={intake.injuryStatus ?? UNSET}
            options={INJURY_OPTIONS}
            disabled={controlsDisabled}
            {...describedBy}
            onSelect={(value) => {
              actions?.setIntake(
                "injuryStatus",
                value === UNSET ? null : (value as "none" | "managing" | "returning"),
                { persistWhenComplete: props.placement === "settings" },
              );
            }}
          />
        }
      />
      {ownsError ? (
        <SetupSubPanel name="intake-error">
          <SetupError surface={surface} section="intake" />
          {props.placement === "settings" && wizard.fixedError === "intake-save-failed" ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className={SETUP_LINK_BUTTON}
              disabled={controlsDisabled}
              onClick={() => {
                actions?.retryIntakeSave();
              }}
            >
              {RETRY_INTAKE_SAVE_LABEL}
            </Button>
          ) : null}
        </SetupSubPanel>
      ) : null}
    </>
  );
}
