import { usePhrasebook } from "@enduragent/i18n/react";
import { Button } from "@enduragent/ui";
import { useId, useState, type ReactElement } from "react";
import { regionWeekStart } from "../../calendar/week-start";
import { usePlanDate } from "../plan/plan-date";
import {
  ChoiceList,
  ChoiceRow,
  ErrorText,
  fieldClass,
  type QuestionFormProps,
} from "./plan-creation-choices";

export function StartTimingForm(props: QuestionFormProps): ReactElement {
  const { say } = usePhrasebook();
  const planDate = usePlanDate();
  const question = props.question.kind === "start-timing-question" ? props.question : null;
  const [firstDay, earliest] = ["first-day-of-week", "earliest"].map((timing) =>
    question?.options.find((option) => option.timing === timing),
  );
  if (question === null || earliest === undefined)
    throw new TypeError("start timing question required");
  const latest = question.latestAllowed;
  const regionStart = regionWeekStart(question.earliestAllowed);
  const beforeEvent = latest !== undefined && regionStart > latest;
  const weekStart = beforeEvent ? question.earliestAllowed : regionStart;
  const current = props.currentAnswer?.kind === "start-timing" ? props.currentAnswer.timing : null;
  const chosen = current?.kind === "earliest" ? current.date : null;
  const [picking, setPicking] = useState(chosen !== null && chosen !== weekStart);
  const [date, setDate] = useState(chosen ?? "");
  const [error, setError] = useState<string>();
  const errorId = useId();
  const answer = (start: string) =>
    props.onAnswer({ kind: "start-timing", timing: { kind: "earliest", date: start } });
  return (
    <form
      className="grid gap-inset"
      onSubmit={(event) => {
        event.preventDefault();
        if (date.length === 0 || date < question.earliestAllowed) {
          setError(
            say("chat.planCreation.startDateMinimum", {
              date: planDate(question.earliestAllowed),
            }),
          );
          return;
        }
        if (latest !== undefined && date > latest) {
          setError(say("chat.planCreation.startDateMaximum", { date: planDate(latest) }));
          return;
        }
        setError(undefined);
        answer(date);
      }}
      noValidate
    >
      <ChoiceList>
        {[
          <ChoiceRow
            key="first-day"
            answerId="first-day"
            number={1}
            label={planDate(weekStart, { weekday: "short", day: "numeric", month: "short" })}
            detail={beforeEvent ? say("chat.planCreation.startBeforeEvent") : firstDay?.label}
            selected={chosen === weekStart && !picking}
            disabled={props.busy}
            onClick={() => answer(weekStart)}
          />,
          <ChoiceRow
            key="earliest"
            answerId="earliest"
            number={2}
            label={earliest.label}
            detail={earliest.detail}
            selected={picking}
            disabled={props.busy}
            onClick={() => {
              setPicking(true);
              setError(undefined);
            }}
          />,
        ]}
      </ChoiceList>
      {picking ? (
        <label className="grid gap-[calc(var(--inset)/2)] px-4 text-xs font-semibold leading-4 text-ink-2">
          {question.dateLabel}
          <input
            className={fieldClass}
            type="date"
            min={question.earliestAllowed}
            max={latest}
            value={date}
            aria-describedby={error === undefined ? undefined : errorId}
            aria-invalid={error !== undefined}
            onChange={(event) => setDate(event.currentTarget.value)}
          />
        </label>
      ) : null}
      <ErrorText id={errorId}>{error}</ErrorText>
      <div className="flex justify-end gap-inset px-4 pb-4">
        {props.editing ? (
          <Button
            type="button"
            variant="outline"
            className="mr-auto border-line bg-surface"
            disabled={props.busy}
            onClick={props.onCancel}
          >
            {say("chat.planCreation.backToAnswers")}
          </Button>
        ) : null}
        {picking ? (
          <Button type="submit" disabled={props.busy}>
            {say("chat.planCreation.continue")}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
