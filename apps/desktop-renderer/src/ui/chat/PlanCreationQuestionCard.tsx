import { formatCivilDate } from "@enduragent/coach-contract";
import type { PlanCreationAnswerInput, PlanCreationOpenQuestion } from "@enduragent/coach-contract";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
  type RefObject,
} from "react";
import { ChevronRight, Plus } from "lucide-react";
import { Button } from "@enduragent/ui";
import { Card, CardContent, CardHeader, CardTitle } from "@enduragent/ui";

const fieldClass =
  "min-h-[var(--ctl-h-lg)] rounded-ctl border border-line-2 bg-sunk px-ctl-px-sm py-2 text-sm font-semibold leading-5 text-ink outline-none focus:border-ring focus:ring-3 focus:ring-ring/20";
const choiceClass =
  "grid min-h-[calc(var(--ctl-h-lg)+var(--row-inset))] w-full grid-cols-[var(--ctl-h-sm)_minmax(0,1fr)_20px] max-md:grid-cols-[var(--ctl-h-sm)_minmax(0,1fr)] items-center gap-2 rounded-ctl border-0 bg-transparent px-2 py-1.5 text-left text-ink hover:bg-ink/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-pressed:bg-primary/10 disabled:pointer-events-none disabled:opacity-50";

interface QuestionFormProps {
  readonly commitmentStatus?: "confirm" | "clarify";
  readonly question: PlanCreationOpenQuestion;
  readonly currentAnswer: PlanCreationAnswerInput | null;
  readonly editing: boolean;
  readonly busy: boolean;
  readonly onAnswer: (answer: PlanCreationAnswerInput) => void;
  readonly onLater: () => void;
  readonly onCancel: () => void;
  readonly onEditorOpenChange: (open: boolean) => void;
}

function ChoiceRow(props: {
  readonly answerId: string;
  readonly label: string;
  readonly detail?: string;
  readonly number?: number;
  readonly selected?: boolean;
  readonly custom?: boolean;
  readonly disabled: boolean;
  readonly buttonRef?: RefObject<HTMLButtonElement | null>;
  readonly onClick: () => void;
}): ReactElement {
  return (
    <button
      ref={props.buttonRef}
      type="button"
      className={choiceClass}
      data-parity={props.custom === true ? "choice.custom" : "choice.row"}
      data-answer={props.answerId}
      aria-label={props.label}
      aria-pressed={props.selected}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <span
        className={
          props.selected
            ? "grid size-ctl-sm place-items-center rounded-full border border-primary bg-primary text-xs leading-4 text-primary-foreground"
            : "grid size-ctl-sm place-items-center rounded-full border border-line-2 text-xs leading-4 text-ink-2"
        }
        data-parity="choice.row.number"
      >
        {props.number === undefined ? <Plus className="size-4" aria-hidden="true" /> : props.number}
      </span>
      <span className="block min-w-0">
        <strong className="block text-sm font-medium leading-5" data-parity="choice.row.label">
          {props.label}
        </strong>
        {props.detail === undefined ? null : (
          <span
            className="mt-[calc(var(--inset)/2)] block text-sm leading-5 text-ink-2"
            data-parity="choice.row.detail"
          >
            {props.detail}
          </span>
        )}
      </span>
      <ChevronRight className="size-4 text-ink-2 max-md:hidden" aria-hidden="true" />
    </button>
  );
}

function ChoiceList(props: {
  readonly children: ReactElement | readonly ReactElement[];
}): ReactElement {
  return (
    <div
      className="grid gap-inset px-inset pt-inset pb-[calc(var(--inset)/2)]"
      data-parity="choice.list"
    >
      {props.children}
    </div>
  );
}

function ChoiceActions(props: QuestionFormProps): ReactElement | null {
  if (!props.editing) return null;
  return (
    <Button
      type="button"
      variant="outline"
      className="mr-auto border-line bg-surface"
      disabled={props.busy}
      onClick={props.onCancel}
    >
      Back to answers
    </Button>
  );
}

function CustomActions(props: {
  readonly editing: boolean;
  readonly onCancel: () => void;
  readonly busy: boolean;
  readonly continueDisabled: boolean;
  readonly onBack: () => void;
}): ReactElement {
  return (
    <div className="flex flex-wrap justify-end gap-inset" data-parity="custom.actions">
      {props.editing ? (
        <Button
          type="button"
          variant="outline"
          className="mr-auto border-line bg-surface"
          disabled={props.busy}
          onClick={props.onCancel}
        >
          Back to answers
        </Button>
      ) : null}
      <div className="flex gap-inset">
        <Button
          type="button"
          variant="outline"
          className="border-line bg-surface"
          disabled={props.busy}
          onClick={props.onBack}
        >
          Back
        </Button>
        <Button type="submit" disabled={props.busy || props.continueDisabled}>
          Continue
        </Button>
      </div>
    </div>
  );
}

function ErrorText(props: {
  readonly id: string;
  readonly children?: string;
}): ReactElement | null {
  return props.children === undefined ? null : (
    <p id={props.id} className="m-0 text-xs leading-4 text-danger" role="alert">
      {props.children}
    </p>
  );
}

function GoalForm(props: QuestionFormProps): ReactElement {
  const question = props.question.kind === "goal-question" ? props.question : null;
  if (question === null) throw new TypeError("goal question required");
  const currentGoal = props.currentAnswer?.kind === "goal" ? props.currentAnswer.goal : null;
  const [manual, setManual] = useState(currentGoal?.kind === "event-manual");
  const [name, setName] = useState(currentGoal?.kind === "event-manual" ? currentGoal.name : "");
  const [date, setDate] = useState(currentGoal?.kind === "event-manual" ? currentGoal.date : "");
  const [errors, setErrors] = useState<{ name?: string; date?: string }>({});
  const editor = useRef<HTMLInputElement>(null);
  const eventNotListedTrigger = useRef<HTMLButtonElement>(null);
  const nameErrorId = useId();
  const dateErrorId = useId();
  useEffect(() => {
    props.onEditorOpenChange(manual);
    if (manual) queueMicrotask(() => editor.current?.focus());
    return () => props.onEditorOpenChange(false);
  }, [manual, props.onEditorOpenChange]);
  const back = (): void => {
    setErrors({});
    setManual(false);
    queueMicrotask(() => eventNotListedTrigger.current?.focus());
  };
  if (manual) {
    const editorCopy = question.eventNotListedOption;
    const submit = (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      const nextErrors = {
        ...(name.trim().length === 0 ? { name: "Enter the event name." } : {}),
        ...(date.length === 0 ? { date: "Choose the event date." } : {}),
      };
      setErrors(nextErrors);
      if (Object.keys(nextErrors).length > 0) return;
      props.onAnswer({
        kind: "check-submit",
        submission: { field: "event", text: name.trim(), date },
      });
    };
    return (
      <form
        className="grid gap-inset pt-ctl-px pr-ctl-px-lg pb-ctl-px-lg pl-ctl-px-lg"
        data-parity="custom.editor"
        onSubmit={submit}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          back();
        }}
        noValidate
      >
        <div className="grid gap-inset">
          <label className="grid gap-[calc(var(--inset)/2)] text-xs font-semibold leading-4 text-ink-2">
            {question.eventNotListedOption.nameLabel}
            <input
              ref={editor}
              className={fieldClass}
              data-parity="custom.textarea"
              value={name}
              placeholder={editorCopy.placeholder}
              maxLength={2000}
              aria-describedby={errors.name === undefined ? undefined : nameErrorId}
              aria-invalid={errors.name !== undefined}
              onChange={(event) => setName(event.currentTarget.value)}
            />
            <ErrorText id={nameErrorId}>{errors.name}</ErrorText>
          </label>
          <label className="grid gap-[calc(var(--inset)/2)] text-xs font-semibold leading-4 text-ink-2">
            {question.eventNotListedOption.dateLabel}
            <input
              className={fieldClass}
              type="date"
              value={date}
              aria-describedby={errors.date === undefined ? undefined : dateErrorId}
              aria-invalid={errors.date !== undefined}
              onChange={(event) => setDate(event.currentTarget.value)}
            />
            <ErrorText id={dateErrorId}>{errors.date}</ErrorText>
          </label>
        </div>
        <CustomActions
          editing={props.editing}
          onCancel={props.onCancel}
          busy={props.busy}
          continueDisabled={name.trim().length === 0 || date.length === 0}
          onBack={back}
        />
      </form>
    );
  }
  const selectedCandidate =
    currentGoal?.kind === "event-candidate" ? currentGoal.candidateId : null;
  return (
    <div>
      <ChoiceList>
        {[
          ...question.candidates.map((candidate, index) => (
            <ChoiceRow
              key={candidate.candidateId}
              answerId={candidate.candidateId}
              number={index + 1}
              label={`${candidate.name} · ${formatCivilDate(candidate.date)}`}
              detail={candidate.sourceLabel}
              selected={candidate.candidateId === selectedCandidate}
              disabled={props.busy}
              onClick={() =>
                props.onAnswer({
                  kind: "goal",
                  goal: { kind: "event-candidate", candidateId: candidate.candidateId },
                })
              }
            />
          )),
          <ChoiceRow
            key="event-not-listed"
            buttonRef={eventNotListedTrigger}
            answerId="event-not-listed"
            number={question.candidates.length + 1}
            label={question.eventNotListedOption.label}
            detail={question.eventNotListedOption.detail}
            selected={currentGoal?.kind === "event-manual"}
            disabled={props.busy}
            onClick={() => setManual(true)}
          />,
          <ChoiceRow
            key="fitness"
            answerId="fitness"
            number={question.candidates.length + 2}
            label={question.fitnessOption.label}
            detail={question.fitnessOption.detail}
            selected={currentGoal?.kind === "fitness"}
            disabled={props.busy}
            onClick={() => props.onAnswer({ kind: "goal", goal: { kind: "fitness" } })}
          />,
        ]}
      </ChoiceList>
      <ChoiceActions {...props} />
    </div>
  );
}

function SuccessForm(props: QuestionFormProps): ReactElement {
  const question = props.question.kind === "success-question" ? props.question : null;
  if (question === null) throw new TypeError("success question required");
  const currentSuccess =
    props.currentAnswer?.kind === "success" ? props.currentAnswer.success : null;
  const [authored, setAuthored] = useState(currentSuccess?.kind === "authored");
  const [text, setText] = useState(currentSuccess?.kind === "authored" ? currentSuccess.text : "");
  const [error, setError] = useState<string>();
  const editor = useRef<HTMLTextAreaElement>(null);
  const customTrigger = useRef<HTMLButtonElement>(null);
  const errorId = useId();
  useEffect(() => {
    props.onEditorOpenChange(authored);
    if (authored) queueMicrotask(() => editor.current?.focus());
    return () => props.onEditorOpenChange(false);
  }, [authored, props.onEditorOpenChange]);
  const back = (): void => {
    setError(undefined);
    setAuthored(false);
    queueMicrotask(() => customTrigger.current?.focus());
  };
  if (authored) {
    const custom =
      question.input.kind === "event-finish"
        ? question.input.authored
        : { ...question.input.authored, placeholder: question.input.placeholder };
    return (
      <form
        className="grid gap-inset pt-ctl-px pr-ctl-px-lg pb-ctl-px-lg pl-ctl-px-lg"
        data-parity="custom.editor"
        onSubmit={(event) => {
          event.preventDefault();
          if (!/\S/u.test(text)) {
            setError("Describe what success means.");
            return;
          }
          setError(undefined);
          props.onAnswer({
            kind: "check-submit",
            submission: { field: "success", text: text.trim() },
          });
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          back();
        }}
        noValidate
      >
        <label className="grid gap-[calc(var(--inset)/2)] text-xs font-semibold leading-4 text-ink-2">
          <span data-parity="custom.label">{custom.editorLabel}</span>
          <textarea
            ref={editor}
            aria-label="Success meaning"
            className={`${fieldClass} resize-y`}
            data-parity="custom.textarea"
            value={text}
            placeholder={custom.placeholder}
            maxLength={2000}
            rows={3}
            aria-describedby={error === undefined ? undefined : errorId}
            aria-invalid={error !== undefined}
            onChange={(event) => setText(event.currentTarget.value)}
          />
        </label>
        <ErrorText id={errorId}>{error}</ErrorText>
        <CustomActions
          editing={props.editing}
          onCancel={props.onCancel}
          busy={props.busy}
          continueDisabled={!/\S/u.test(text)}
          onBack={back}
        />
      </form>
    );
  }
  const options =
    question.input.kind === "event-finish"
      ? question.input.options.map((option, index) => (
          <ChoiceRow
            key={option.choice}
            answerId={option.choice}
            number={index + 1}
            label={option.label}
            detail={option.detail}
            selected={
              currentSuccess?.kind === "event-finish" && currentSuccess.choice === option.choice
            }
            disabled={props.busy}
            onClick={() =>
              props.onAnswer({
                kind: "success",
                success: { kind: "event-finish", choice: option.choice },
              })
            }
          />
        ))
      : question.input.options.map((option, index) => (
          <ChoiceRow
            key={option.choice}
            answerId={option.choice}
            number={index + 1}
            label={option.label}
            detail={option.detail}
            selected={
              currentSuccess?.kind === "fitness-choice" && currentSuccess.choice === option.choice
            }
            disabled={props.busy}
            onClick={() =>
              props.onAnswer({
                kind: "success",
                success: { kind: "fitness-choice", choice: option.choice },
              })
            }
          />
        ));
  const authoredOption = question.input.authored;
  return (
    <div>
      <ChoiceList>
        {[
          ...options,
          <ChoiceRow
            key="custom"
            buttonRef={customTrigger}
            answerId="custom"
            label={authoredOption.label}
            detail={authoredOption.detail}
            custom
            disabled={props.busy}
            onClick={() => setAuthored(true)}
          />,
        ]}
      </ChoiceList>
      <ChoiceActions {...props} />
    </div>
  );
}

function PlanLengthForm(props: QuestionFormProps): ReactElement {
  const question = props.question.kind === "plan-length-question" ? props.question : null;
  if (question === null) throw new TypeError("plan length question required");
  const current = props.currentAnswer?.kind === "plan-length" ? props.currentAnswer.weeks : null;
  return (
    <div>
      <ChoiceList>
        {question.options.map((option, index) => (
          <ChoiceRow
            key={option.weeks}
            answerId={String(option.weeks)}
            number={index + 1}
            label={option.label}
            detail={option.detail}
            selected={option.weeks === current}
            disabled={props.busy}
            onClick={() => props.onAnswer({ kind: "plan-length", weeks: option.weeks })}
          />
        ))}
      </ChoiceList>
      <ChoiceActions {...props} />
    </div>
  );
}

function ScheduleModeForm(props: QuestionFormProps): ReactElement {
  const question = props.question.kind === "schedule-mode-question" ? props.question : null;
  if (question === null) throw new TypeError("schedule mode question required");
  const current = props.currentAnswer?.kind === "schedule-mode" ? props.currentAnswer.mode : null;
  return (
    <div>
      <ChoiceList>
        {question.options.map((option, index) => (
          <ChoiceRow
            key={option.mode}
            answerId={option.mode}
            number={index + 1}
            label={option.label}
            detail={option.detail}
            selected={option.mode === current}
            disabled={props.busy}
            onClick={() => props.onAnswer({ kind: "schedule-mode", mode: option.mode })}
          />
        ))}
      </ChoiceList>
      <ChoiceActions {...props} />
    </div>
  );
}

function AvailabilityForm(props: QuestionFormProps): ReactElement {
  const question = props.question.kind === "availability-question" ? props.question : null;
  if (question === null) throw new TypeError("availability question required");
  const initial = props.currentAnswer?.kind === "availability" ? props.currentAnswer : null;
  const [weeklyHours, setWeeklyHours] = useState<number | null>(initial?.weeklyHoursLimit ?? null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const weeklyErrorId = useId();
  const longestErrorId = useId();
  const weekdaysErrorId = useId();
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const longestWorkoutHours = Number(data.get("longestWorkoutHours"));
    const nextErrors: Record<string, string> = {};
    if (weeklyHours === null) nextErrors.weekly = "Choose weekly hours.";
    if (!Number.isFinite(longestWorkoutHours) || longestWorkoutHours <= 0) {
      nextErrors.longest = "Enter a longest ride greater than 0 hours.";
    } else if (weeklyHours !== null && longestWorkoutHours > weeklyHours) {
      nextErrors.longest = "The longest ride cannot exceed the weekly limit.";
    }
    const usableWeekdays = data.getAll("usableWeekdays").map(Number);
    if (question.mode === "fixed" && usableWeekdays.length === 0) {
      nextErrors.weekdays = "Choose at least one usable weekday.";
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0 || weeklyHours === null) return;
    props.onAnswer(
      question.mode === "fixed"
        ? {
            kind: "availability",
            mode: "fixed",
            weeklyHoursLimit: weeklyHours,
            longestWorkoutHours,
            usableWeekdays,
          }
        : {
            kind: "availability",
            mode: "flexible",
            weeklyHoursLimit: weeklyHours,
            longestWorkoutHours,
          },
    );
  };
  return (
    <form className="grid gap-inset" onSubmit={submit} noValidate>
      <ChoiceList>
        {question.weeklyHoursOptions.map((option, index) => (
          <ChoiceRow
            key={option.id}
            answerId={option.id}
            number={index + 1}
            label={option.label}
            detail={option.detail}
            selected={weeklyHours === option.weeklyHoursLimit}
            disabled={props.busy}
            onClick={() => {
              setWeeklyHours(option.weeklyHoursLimit);
              setErrors((current) => ({ ...current, weekly: "" }));
            }}
          />
        ))}
      </ChoiceList>
      <ErrorText id={weeklyErrorId}>{errors.weekly || undefined}</ErrorText>
      <label className="grid gap-[calc(var(--inset)/2)] px-4 text-xs font-semibold leading-4 text-ink-2">
        {question.longestWorkoutLabel}
        <input
          className={fieldClass}
          data-parity="availability.longest"
          name="longestWorkoutHours"
          type="number"
          defaultValue={initial?.longestWorkoutHours ?? ""}
          aria-describedby={errors.longest === undefined ? undefined : longestErrorId}
          aria-invalid={errors.longest !== undefined}
        />
        <ErrorText id={longestErrorId}>{errors.longest}</ErrorText>
      </label>
      {question.mode === "fixed" ? (
        <fieldset
          className="mx-4 my-0 flex min-w-0 flex-wrap gap-inset border-0 p-0"
          aria-describedby={weekdaysErrorId}
        >
          <legend className="mb-inset px-0.5 text-sm font-normal leading-5 text-ink">
            Usable weekdays
          </legend>
          <div className="flex flex-wrap gap-inset">
            {question.weekdayOptions.map((option) => (
              <label
                key={option.weekday}
                className="flex items-center gap-[calc(var(--inset)/2)] text-xs font-semibold leading-4 text-ink-2"
              >
                <input
                  type="checkbox"
                  className="my-0.75 size-4 accent-primary"
                  disabled={props.busy}
                  name="usableWeekdays"
                  value={option.weekday}
                  defaultChecked={
                    initial?.mode === "fixed" && initial.usableWeekdays.includes(option.weekday)
                  }
                  aria-label={option.label}
                />
                {option.label}
              </label>
            ))}
          </div>
          <ErrorText id={weekdaysErrorId}>{errors.weekdays}</ErrorText>
        </fieldset>
      ) : (
        <p className="m-0 px-4 text-xs leading-4 text-ink-2">{question.derivedPoolNote}</p>
      )}
      <div className="flex justify-end gap-inset px-4 pb-4">
        {props.editing ? (
          <Button
            type="button"
            variant="outline"
            className="mr-auto border-line bg-surface"
            disabled={props.busy}
            onClick={props.onCancel}
          >
            Back to answers
          </Button>
        ) : null}
        <Button type="submit" disabled={props.busy}>
          Continue
        </Button>
      </div>
    </form>
  );
}

function StartTimingForm(props: QuestionFormProps): ReactElement {
  const question = props.question.kind === "start-timing-question" ? props.question : null;
  if (question === null) throw new TypeError("start timing question required");
  const current = props.currentAnswer?.kind === "start-timing" ? props.currentAnswer.timing : null;
  const [timing, setTiming] = useState<"earliest" | null>(
    current?.kind === "earliest" ? "earliest" : null,
  );
  const [date, setDate] = useState(current?.kind === "earliest" ? current.date : "");
  const [error, setError] = useState<string>();
  const errorId = useId();
  const asap = question.options.find((option) => option.timing === "as-soon-as-possible")!;
  const earliest = question.options.find((option) => option.timing === "earliest")!;
  return (
    <form
      className="grid gap-inset"
      onSubmit={(event) => {
        event.preventDefault();
        if (timing === null) {
          setError("Choose when this Plan can start.");
          return;
        }
        if (date.length === 0 || date < question.earliestAllowed) {
          setError(`Choose a date on or after ${formatCivilDate(question.earliestAllowed)}.`);
          return;
        }
        setError(undefined);
        props.onAnswer({ kind: "start-timing", timing: { kind: "earliest", date } });
      }}
      noValidate
    >
      <ChoiceList>
        {[
          <ChoiceRow
            key="asap"
            answerId="asap"
            number={1}
            label={asap.label}
            detail={asap.detail}
            selected={current?.kind === "as-soon-as-possible"}
            disabled={props.busy}
            onClick={() =>
              props.onAnswer({ kind: "start-timing", timing: { kind: "as-soon-as-possible" } })
            }
          />,
          <ChoiceRow
            key="earliest"
            answerId="earliest"
            number={2}
            label={earliest.label}
            detail={earliest.detail}
            selected={timing === "earliest"}
            disabled={props.busy}
            onClick={() => {
              setTiming("earliest");
              setError(undefined);
            }}
          />,
        ]}
      </ChoiceList>
      {timing === "earliest" ? (
        <label className="grid gap-[calc(var(--inset)/2)] px-4 text-xs font-semibold leading-4 text-ink-2">
          {question.dateLabel}
          <input
            className={fieldClass}
            type="date"
            min={question.earliestAllowed}
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
            Back to answers
          </Button>
        ) : null}
        {timing === "earliest" ? (
          <Button type="submit" disabled={props.busy}>
            Continue
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function CommitmentsForm(props: QuestionFormProps): ReactElement {
  const question = props.question.kind === "commitments-question" ? props.question : null;
  if (question === null) throw new TypeError("commitments question required");
  const current =
    props.currentAnswer?.kind === "commitments" ? props.currentAnswer.commitments : null;
  const [authored, setAuthored] = useState(current?.kind === "interpreted");
  const [text, setText] = useState(current?.kind === "interpreted" ? current.text : "");
  const [error, setError] = useState<string>();
  const editor = useRef<HTMLTextAreaElement>(null);
  const customTrigger = useRef<HTMLButtonElement>(null);
  const errorId = useId();
  const hintId = useId();
  const clarify = props.commitmentStatus === "clarify";
  useEffect(() => {
    props.onEditorOpenChange(authored);
    if (authored) queueMicrotask(() => editor.current?.focus());
    return () => props.onEditorOpenChange(false);
  }, [authored, props.onEditorOpenChange]);
  const back = (): void => {
    setError(undefined);
    setAuthored(false);
    queueMicrotask(() => customTrigger.current?.focus());
  };
  if (authored) {
    return (
      <form
        className="grid gap-inset pt-ctl-px pr-ctl-px-lg pb-ctl-px-lg pl-ctl-px-lg"
        data-parity="custom.editor"
        onSubmit={(event) => {
          event.preventDefault();
          if (!/\S/u.test(text)) {
            setError("Add the scheduling details or choose Nothing fixed.");
            return;
          }
          setError(undefined);
          props.onAnswer({
            kind: "check-submit",
            submission: { field: "commitments", text: text.trim() },
          });
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          back();
        }}
        noValidate
      >
        <label className="grid gap-[calc(var(--inset)/2)] text-xs font-semibold leading-4 text-ink-2">
          <span data-parity="custom.label">Commitments or time off</span>
          <textarea
            ref={editor}
            className={`${fieldClass} resize-y`}
            data-parity="custom.textarea"
            value={text}
            placeholder={question.authoredOption.placeholder}
            maxLength={2000}
            rows={3}
            aria-describedby={
              [error === undefined ? null : errorId, clarify ? hintId : null]
                .filter(Boolean)
                .join(" ") || undefined
            }
            aria-invalid={error !== undefined}
            onChange={(event) => setText(event.currentTarget.value)}
          />
        </label>
        {clarify ? (
          <p id={hintId} className="m-0 text-sm leading-5 text-ink-2">
            Give the weekday and exact limit, or the exact time-off dates.
          </p>
        ) : null}
        <ErrorText id={errorId}>{error}</ErrorText>
        <CustomActions
          editing={props.editing}
          onCancel={props.onCancel}
          busy={props.busy}
          continueDisabled={!/\S/u.test(text)}
          onBack={back}
        />
      </form>
    );
  }
  return (
    <div>
      <ChoiceList>
        {[
          <ChoiceRow
            key="none"
            answerId="none"
            number={1}
            label={question.noneOption.label}
            detail={question.noneOption.detail}
            selected={current?.kind === "none"}
            disabled={props.busy}
            onClick={() => props.onAnswer({ kind: "commitments", commitments: { kind: "none" } })}
          />,
          <ChoiceRow
            key="custom"
            buttonRef={customTrigger}
            answerId="custom"
            label={question.authoredOption.label}
            detail={question.authoredOption.detail}
            custom
            disabled={props.busy}
            onClick={() => setAuthored(true)}
          />,
        ]}
      </ChoiceList>
      <ChoiceActions {...props} />
    </div>
  );
}

function BaselineForm(props: QuestionFormProps): ReactElement {
  const question = props.question.kind === "baseline-question" ? props.question : null;
  if (question === null) throw new TypeError("baseline question required");
  const current = props.currentAnswer?.kind === "baseline" ? props.currentAnswer.baseline : null;
  return (
    <div>
      <ChoiceList>
        {question.options.map((option, index) => (
          <ChoiceRow
            key={option.baseline}
            answerId={option.baseline}
            number={index + 1}
            label={option.label}
            detail={option.detail}
            selected={option.baseline === current}
            disabled={props.busy}
            onClick={() => props.onAnswer({ kind: "baseline", baseline: option.baseline })}
          />
        ))}
      </ChoiceList>
      <ChoiceActions {...props} />
    </div>
  );
}

type RestrictionKind = "none" | "no-training" | "no-hard-training" | "max-duration";

function RestrictionForm(props: QuestionFormProps): ReactElement {
  const question = props.question.kind === "restriction-question" ? props.question : null;
  if (question === null) throw new TypeError("restriction question required");
  const current =
    props.currentAnswer?.kind === "restriction" ? props.currentAnswer.restriction : null;
  const [kind, setKind] = useState<Exclude<RestrictionKind, "none"> | null>(
    current !== null && current.kind !== "none" ? current.kind : null,
  );
  const [hours, setHours] = useState(current?.kind === "max-duration" ? String(current.hours) : "");
  const [endDate, setEndDate] = useState(
    current !== null && current.kind !== "none" ? (current.endDate ?? "") : "",
  );
  const [error, setError] = useState<string>();
  const errorId = useId();
  return (
    <form
      className="grid gap-inset"
      onSubmit={(event) => {
        event.preventDefault();
        if (kind === null) {
          setError("Choose a Training Restriction.");
          return;
        }
        setError(undefined);
        if (kind === "max-duration") {
          const duration = Number(hours);
          if (!Number.isFinite(duration) || duration <= 0) {
            setError("Enter a duration greater than 0 hours.");
            return;
          }
          props.onAnswer({
            kind: "restriction",
            restriction: {
              kind,
              hours: duration,
              ...(endDate.length === 0 ? {} : { endDate }),
            },
          });
          return;
        }
        props.onAnswer({
          kind: "restriction",
          restriction: {
            kind,
            ...(endDate.length === 0 ? {} : { endDate }),
          },
        });
      }}
      noValidate
    >
      <ChoiceList>
        {question.options.map((option, index) => (
          <ChoiceRow
            key={option.kind}
            answerId={option.kind}
            number={index + 1}
            label={option.label}
            detail={option.detail}
            selected={option.kind === "none" ? current?.kind === "none" : kind === option.kind}
            disabled={props.busy}
            onClick={() => {
              setError(undefined);
              if (option.kind === "none") {
                setKind(null);
                setEndDate("");
                props.onAnswer({ kind: "restriction", restriction: { kind: "none" } });
                return;
              }
              setKind(option.kind);
            }}
          />
        ))}
      </ChoiceList>
      {kind === null ? null : (
        <div className="grid gap-inset px-4">
          {kind === "max-duration" ? (
            <label className="grid gap-[calc(var(--inset)/2)] text-xs font-semibold leading-4 text-ink-2">
              Maximum duration hours
              <input
                className={fieldClass}
                type="number"
                value={hours}
                aria-describedby={error === undefined ? undefined : errorId}
                aria-invalid={error !== undefined}
                onChange={(event) => setHours(event.currentTarget.value)}
              />
            </label>
          ) : null}
          <label className="grid gap-[calc(var(--inset)/2)] text-xs font-semibold leading-4 text-ink-2">
            Optional end date
            <input
              className={fieldClass}
              type="date"
              value={endDate}
              onChange={(event) => setEndDate(event.currentTarget.value)}
            />
          </label>
        </div>
      )}
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
            Back to answers
          </Button>
        ) : null}
        {kind === null ? null : (
          <Button type="submit" disabled={props.busy}>
            Continue
          </Button>
        )}
      </div>
    </form>
  );
}

function QuestionForm(props: QuestionFormProps): ReactElement {
  switch (props.question.kind) {
    case "goal-question":
      return <GoalForm {...props} />;
    case "success-question":
      return <SuccessForm {...props} />;
    case "plan-length-question":
      return <PlanLengthForm {...props} />;
    case "start-timing-question":
      return <StartTimingForm {...props} />;
    case "schedule-mode-question":
      return <ScheduleModeForm {...props} />;
    case "availability-question":
      return <AvailabilityForm {...props} />;
    case "commitments-question":
      return <CommitmentsForm {...props} />;
    case "baseline-question":
      return <BaselineForm {...props} />;
    case "restriction-question":
      return <RestrictionForm {...props} />;
  }
}

const questionAnswerKey = (question: PlanCreationOpenQuestion): PlanCreationAnswerInput["kind"] => {
  switch (question.kind) {
    case "goal-question":
      return "goal";
    case "success-question":
      return "success";
    case "plan-length-question":
      return "plan-length";
    case "start-timing-question":
      return "start-timing";
    case "schedule-mode-question":
      return "schedule-mode";
    case "availability-question":
      return "availability";
    case "commitments-question":
      return "commitments";
    case "baseline-question":
      return "baseline";
    case "restriction-question":
      return "restriction";
  }
};

export function PlanCreationQuestionCard(
  props: QuestionFormProps & { readonly error: string | null; readonly focusRevision: number },
): ReactElement {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [props.focusRevision, props.question.kind]);
  return (
    <Card
      className="min-w-0 gap-0 overflow-hidden py-0 shadow-elev-2"
      data-parity="question.card"
      data-question={questionAnswerKey(props.question)}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        props.onLater();
      }}
    >
      <CardHeader className="flex items-center justify-between gap-inset rounded-none border-b border-line pt-4 pr-3 pb-inset! pl-4">
        <div className="min-w-0">
          <p
            className="m-0 mb-[calc(var(--inset)/2)] text-xs font-semibold leading-4 text-ink-2"
            data-parity="question.eyebrow"
          >
            Plan creation · question {props.question.step.current} of {props.question.step.total}
          </p>
          <CardTitle>
            <h2
              ref={heading}
              tabIndex={-1}
              className="m-0 font-medium outline-none"
              data-parity="question.title"
            >
              {props.question.prompt}
            </h2>
          </CardTitle>
        </div>
        <Button
          type="button"
          variant="outline"
          className="border-line bg-surface"
          aria-label="Later"
          disabled={props.busy}
          onClick={props.onLater}
        >
          Later
        </Button>
      </CardHeader>
      <CardContent className="grid min-w-0 gap-inset p-0">
        <QuestionForm {...props} />
        {props.error === null ? null : (
          <p className="m-0 px-4 pb-4 text-xs leading-4 text-danger" role="alert">
            {props.error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
