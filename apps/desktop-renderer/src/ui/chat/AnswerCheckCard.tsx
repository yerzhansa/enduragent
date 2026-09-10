import {
  formatCivilDate,
  type AnswerCheckAction,
  type PlanChangeIntent,
  type PlanChangePendingCheck,
  type PlanCreationCommitmentRule,
  type PlanCreationPendingCheck,
} from "@enduragent/coach-contract";
import { Button } from "@enduragent/ui";
import { useEffect, useRef, type ReactElement } from "react";
import { Fact, PlanCard } from "../plan/plan-card";

type PendingCheck = PlanCreationPendingCheck | PlanChangePendingCheck;
type ReadyCheck = Extract<PendingCheck, { state: "ready" }>;
type CheckedValue = Extract<ReadyCheck["result"], { outcome: "understood" }>["value"];

const fieldLabels = {
  commitments: "Commitments",
  success: "Success",
  event: "Event",
  change: "Change",
};
const days = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function supportingEventText(
  intent: Extract<PlanChangeIntent, { kind: "supporting-event" }>,
): string {
  switch (intent.operation) {
    case "add":
      return `${intent.name} · ${formatCivilDate(intent.date)} · ${intent.role}`;
    case "manual":
      return `${intent.name} · ${formatCivilDate(intent.date)}`;
    case "name":
      return intent.name;
    case "role":
      return `Supporting Event · ${intent.role}`;
    case "remove":
      return "Remove the supporting Event";
    case "source-update":
      return "Use the supporting Event's updated name and date";
    default: {
      const exhaustive: never = intent;
      return exhaustive;
    }
  }
}

function ruleText(rule: PlanCreationCommitmentRule | PlanChangeIntent): string {
  switch (rule.kind) {
    case "weekday-duration":
      return `${days[rule.day]} · at most ${rule.minutes} min`;
    case "weekday-unavailable":
      return `${days[rule.day]} · unavailable`;
    case "hard-weekday":
      return `${days[rule.day]} · no hard training`;
    case "time-off":
      return `Off ${formatCivilDate(rule.start)} to ${formatCivilDate(rule.end)}`;
    case "weekly-duration":
      return `At most ${rule.hours} hours each week`;
    case "longest-workout":
      return `Longest Workout · at most ${rule.minutes} min`;
    case "ftp":
      return `Functional threshold power · ${rule.watts} W`;
    case "choose-workout":
      return "Use the selected Workout today";
    case "inverse":
      return "Undo the selected Plan change";
    case "supporting-event":
      return supportingEventText(rule);
    default: {
      const exhaustive: never = rule;
      return exhaustive;
    }
  }
}

function checkedValueText(value: CheckedValue): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.map(ruleText);
  if ("kind" in value) return [ruleText(value)];
  return [`${value.name} · ${formatCivilDate(value.date)}`];
}

export function AnswerCheckCard(props: {
  readonly check: PendingCheck;
  readonly onAction: (action: AnswerCheckAction["action"]) => void;
  readonly onEdit: () => void;
  readonly neutralDefault: string;
  readonly focusRevision?: number;
  readonly disabled?: boolean;
  readonly fieldLabel?: string;
  readonly scope?: string;
  readonly summaryId?: string;
}): ReactElement {
  const { check, onAction, onEdit } = props;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [check.checkId, check.state, check.attempt, props.focusRevision]);

  if (check.state === "busy") {
    return (
      <div role="status" aria-live="polite">
        <h3 ref={heading} tabIndex={-1} className="m-0 text-sm leading-5 font-normal text-ink-2">
          Checking your answer…
        </h3>
      </div>
    );
  }

  const fieldLabel = props.fieldLabel ?? fieldLabels[check.submission.field];
  const scope =
    props.scope ?? (check.submission.field === "change" ? "Plan change" : "Plan creation");
  const title = check.state === "error" ? "I could not check that answer" : check.result.title;
  const secondary = (): { label: string; run: () => void } => {
    if (check.state === "error") return { label: "Cancel", run: () => onAction("cancel") };
    switch (check.result.outcome) {
      case "understood":
        return { label: "Change it", run: onEdit };
      case "skip":
        return { label: "Let me answer again", run: onEdit };
      case "ask":
        return check.submission.field === "event"
          ? { label: "Back to list", run: () => onAction("cancel") }
          : { label: "Skip for now", run: () => onAction("skip") };
    }
  };
  const primary = (): { label: string; run: () => void } => {
    if (check.state === "error") return { label: "Retry", run: () => onAction("retry") };
    switch (check.result.outcome) {
      case "understood":
        return { label: "Confirm", run: () => onAction("confirm") };
      case "skip":
        return { label: `Yes, ${props.neutralDefault}`, run: () => onAction("skip") };
      case "ask":
        return { label: "Answer", run: onEdit };
    }
  };
  const secondaryAction = { ...secondary(), primary: false };
  const primaryAction = { ...primary(), primary: true };
  const buttonActions =
    check.state === "ready" && check.result.outcome === "skip"
      ? [primaryAction, secondaryAction]
      : [secondaryAction, primaryAction];

  return (
    <PlanCard
      eyebrow={`${scope} · ${fieldLabel}`}
      title={title}
      aria-label={title}
      summary={check.state === "ready" ? check.result.body : undefined}
      summaryId={props.summaryId}
      headingRef={heading}
      headingTabIndex={-1}
    >
      {check.state === "error" ? (
        <p role="alert" className="mt-0 mb-inset text-sm leading-5 text-danger">
          {check.message}
        </p>
      ) : null}
      <div role="table" aria-label={fieldLabel} className="border-t border-line">
        <Fact label="You wrote">{check.submission.text}</Fact>
        {check.submission.field === "event" ? (
          <Fact label="Date">{formatCivilDate(check.submission.date)}</Fact>
        ) : null}
        {check.state === "ready" && check.result.outcome === "understood"
          ? checkedValueText(check.result.value).map((value, index) => (
              <Fact key={index} label="I understood">
                {value}
              </Fact>
            ))
          : null}
      </div>
      <div className="mt-[var(--row-inset)] flex flex-wrap gap-2">
        {buttonActions.map((action) => (
          <Button
            key={action.label}
            variant={action.primary ? "default" : "outline"}
            className={action.primary ? undefined : "border-line bg-surface"}
            disabled={props.disabled}
            onClick={action.run}
          >
            {action.label}
          </Button>
        ))}
      </div>
    </PlanCard>
  );
}
