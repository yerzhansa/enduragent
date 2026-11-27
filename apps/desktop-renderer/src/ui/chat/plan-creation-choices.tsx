import { usePhrasebook } from "@enduragent/i18n/react";
import type { PlanCreationAnswerInput, PlanCreationOpenQuestion } from "@enduragent/coach-contract";
import type { ReactElement, RefObject } from "react";
import { ChevronRight, Plus } from "lucide-react";

export const fieldClass =
  "min-h-[var(--ctl-h-lg)] rounded-ctl border border-line-2 bg-sunk px-ctl-px-sm py-2 text-sm font-semibold leading-5 text-ink outline-none focus:border-ring focus:ring-3 focus:ring-ring/20";
const choiceClass =
  "grid min-h-[calc(var(--ctl-h-lg)+var(--row-inset))] w-full grid-cols-[var(--ctl-h-sm)_minmax(0,1fr)_20px] max-md:grid-cols-[var(--ctl-h-sm)_minmax(0,1fr)] items-center gap-2 rounded-ctl border-0 bg-transparent px-2 py-1.5 text-left text-ink hover:bg-ink/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-pressed:bg-primary/10 disabled:pointer-events-none disabled:opacity-50";

export interface QuestionFormProps {
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

export function ChoiceRow(props: {
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
  const { format } = usePhrasebook();
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
        {props.number === undefined ? (
          <Plus className="size-4" aria-hidden="true" />
        ) : (
          format.number(props.number, { useGrouping: false })
        )}
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

export function ChoiceList(props: {
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

export function ErrorText(props: {
  readonly id: string;
  readonly children?: string;
}): ReactElement | null {
  return props.children === undefined ? null : (
    <p id={props.id} className="m-0 text-xs leading-4 text-danger" role="alert">
      {props.children}
    </p>
  );
}
