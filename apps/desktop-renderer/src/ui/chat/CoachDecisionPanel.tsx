import {
  RecordedAnswer,
  QuestionCard,
  QuestionOptions,
  QuestionOption,
  QuestionEditor,
  QuestionInput,
} from "@enduragent/ui";
import { Plus, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from "react";
import { Button } from "@enduragent/ui";
import { useEnduragentStore } from "../../state/store";
import type { CoachDecisionAnswer, CoachDecisionReadModel } from "@enduragent/coach-contract";

export function CoachDecisionPanel(props: {
  readonly onCustomOpenChange: (open: boolean) => void;
  readonly surface?: {
    readonly decision: CoachDecisionReadModel | null;
    readonly phase: "idle" | "continuing" | "recovering";
    readonly answerLabel: string | null;
    readonly error: string | null;
    readonly loadError: string | null;
    answer(decisionId: string, answer: CoachDecisionAnswer): void;
    skip(decisionId: string): void;
    retry(): void;
  };
}): ReactElement | null {
  const chatDecision = useEnduragentStore((state) => state.chat.decision);
  const chatPhase = useEnduragentStore((state) => state.chat.decisionPhase);
  const chatAnswerLabel = useEnduragentStore((state) => state.chat.decisionAnswerLabel);
  const chatError = useEnduragentStore((state) => state.chat.decisionError);
  const chatLoadError = useEnduragentStore((state) => state.chat.decisionLoadError);
  const actions = useEnduragentStore((state) => state.chatActions);
  const decision = props.surface?.decision ?? chatDecision;
  const phase = props.surface?.phase ?? chatPhase;
  const answerLabel = props.surface?.answerLabel ?? chatAnswerLabel;
  const error = props.surface?.error ?? chatError;
  const loadError = props.surface?.loadError ?? chatLoadError;
  const available = props.surface !== undefined || actions !== null;
  const answer = useCallback(
    (decisionId: string, value: CoachDecisionAnswer): void => {
      if (props.surface === undefined) actions?.answerDecision(decisionId, value);
      else props.surface.answer(decisionId, value);
    },
    [actions, props.surface],
  );
  const skipDecision = useCallback(
    (decisionId: string): void => {
      if (props.surface === undefined) actions?.skipDecision(decisionId);
      else props.surface.skip(decisionId);
    },
    [actions, props.surface],
  );
  const retryDecision = useCallback((): void => {
    if (props.surface === undefined) actions?.retryDecision();
    else props.surface.retry();
  }, [actions, props.surface]);
  const [customOpen, setCustomOpen] = useState(false);
  const [customText, setCustomText] = useState("");
  const questionId = useId();
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const customInput = useRef<HTMLTextAreaElement>(null);
  const customTrigger = useRef<HTMLButtonElement>(null);
  const restoreCustomTriggerFocus = useRef(false);
  const displayedOptions = useMemo(() => {
    if (decision === null) return [];
    const recommended = decision.options.filter((option) => option.recommended);
    const remaining = decision.options.filter((option) => !option.recommended);
    return [...recommended, ...remaining];
  }, [decision]);

  useEffect(() => {
    setCustomOpen(false);
    setCustomText("");
    props.onCustomOpenChange(false);
  }, [decision?.decisionId, props.onCustomOpenChange]);

  useEffect(() => {
    props.onCustomOpenChange(customOpen);
    if (customOpen) customInput.current?.focus();
    else if (restoreCustomTriggerFocus.current) {
      restoreCustomTriggerFocus.current = false;
      customTrigger.current?.focus();
    }
  }, [customOpen, props.onCustomOpenChange]);

  useEffect(() => {
    if (decision?.status !== "unanswered" || phase !== "idle") setCustomOpen(false);
  }, [decision?.status, phase]);

  useEffect(() => {
    if (decision?.status !== "unanswered" || phase !== "idle") return;
    const onShortcut = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"]') !== null) return;
      if (event.key === "Escape") {
        event.preventDefault();
        skipDecision(decision.decisionId);
        return;
      }
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement
      ) {
        return;
      }
      const number = Number(event.key);
      if (!Number.isInteger(number) || number < 1 || number > displayedOptions.length) return;
      const option = displayedOptions[number - 1];
      if (option === undefined) return;
      event.preventDefault();
      answer(decision.decisionId, { kind: "option", optionId: option.id });
    };
    document.addEventListener("keydown", onShortcut);
    return () => {
      document.removeEventListener("keydown", onShortcut);
    };
  }, [answer, decision, displayedOptions, phase, skipDecision]);

  if (decision === null && loadError !== null) {
    return (
      <section className="grid gap-inset rounded-card border border-line bg-surface p-4 shadow-elev-2">
        <div className="grid gap-[calc(var(--inset)/2)]">
          <strong className="text-sm font-medium leading-5">Reconnect to check Chat</strong>
          <p className="m-0 text-xs leading-4 text-ink-2" role="alert">
            {loadError}
          </p>
        </div>
        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            disabled={!available}
            onClick={() => {
              retryDecision();
            }}
          >
            Reconnect
          </Button>
        </div>
      </section>
    );
  }

  if (
    decision?.status === "answered" &&
    decision.continuation.status === "pending" &&
    error !== null
  ) {
    return (
      <RecordedAnswer
        title="Your choice is saved"
        aria-live="polite"
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              disabled={!available}
              onClick={() => {
                retryDecision();
              }}
            >
              Try again
            </Button>
          </>
        }
      >
        <p className="m-0 text-xs leading-4 text-ink-2">{answerLabel ?? "Your answer"}</p>
        <p className="m-0 text-xs leading-4 text-danger" role="alert">
          {error}
        </p>
      </RecordedAnswer>
    );
  }

  if (
    decision !== null &&
    (phase !== "idle" ||
      (decision.status === "answered" && decision.continuation.status === "pending"))
  ) {
    const recovering = phase === "recovering";
    return (
      <RecordedAnswer
        title={recovering ? "Finishing your saved choice…" : "Continuing with your choice…"}
        busy
        aria-live="polite"
        actions={
          error === null ? undefined : (
            <Button type="button" variant="outline" disabled={!available} onClick={retryDecision}>
              Try again
            </Button>
          )
        }
      >
        <p className="m-0 text-xs leading-4 text-ink-2">
          {answerLabel ?? "Your answer"}
          {recovering ? " was saved before Enduragent reopened." : ""}
        </p>
        {error === null ? null : (
          <p className="m-0 text-xs leading-4 text-danger" role="alert">
            {error}
          </p>
        )}
      </RecordedAnswer>
    );
  }

  if (decision?.status !== "unanswered") return null;

  const skip = (): void => {
    skipDecision(decision.decisionId);
  };
  const choose = (optionId: string): void => {
    answer(decision.decisionId, { kind: "option", optionId });
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      skip();
      return;
    }
    if (customOpen || event.target instanceof HTMLTextAreaElement) return;
    const number = Number(event.key);
    if (Number.isInteger(number) && number >= 1 && number <= displayedOptions.length) {
      const option = displayedOptions[number - 1];
      if (option !== undefined) {
        event.preventDefault();
        choose(option.id);
      }
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const controls = optionRefs.current.filter((control) => control !== null);
    if (controls.length === 0) return;
    event.preventDefault();
    const currentIndex = controls.findIndex((control) => control === document.activeElement);
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex =
      currentIndex === -1 ? 0 : (currentIndex + delta + controls.length) % controls.length;
    controls[nextIndex]?.focus();
  };

  return (
    <QuestionCard
      title={decision.question}
      titleId={questionId}
      eyebrow="Coach needs your answer"
      aria-live="polite"
      onKeyDown={onKeyDown}
      actions={
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Skip question"
          disabled={!available}
          onClick={skip}
        >
          <X aria-hidden="true" />
        </Button>
      }
    >
      {customOpen ? (
        <QuestionEditor>
          <label
            className="text-xs font-semibold leading-4 text-ink-2"
            htmlFor="decision-custom-answer"
          >
            What would work better?
          </label>
          <QuestionInput
            id="decision-custom-answer"
            ref={customInput}
            rows={2}
            maxLength={2000}
            value={customText}
            onChange={(event) => {
              setCustomText(event.currentTarget.value);
            }}
          />
          <div className="flex justify-end gap-inset pt-[calc(var(--inset)/2)]">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                restoreCustomTriggerFocus.current = true;
                setCustomOpen(false);
              }}
            >
              Back
            </Button>
            <Button
              type="button"
              disabled={!/\S/u.test(customText) || !available}
              onClick={() => {
                answer(decision.decisionId, {
                  kind: "custom",
                  text: customText.trim(),
                });
              }}
            >
              Continue
            </Button>
          </div>
        </QuestionEditor>
      ) : (
        <QuestionOptions>
          {displayedOptions.map((option, index) => (
            <QuestionOption
              key={option.id}
              ref={(element) => {
                optionRefs.current[index] = element;
              }}
              marker={index + 1}
              label={option.label}
              description={option.description}
              annotation={option.recommended ? "Recommended" : undefined}
              onClick={() => {
                choose(option.id);
              }}
            />
          ))}
          <QuestionOption
            ref={(element) => {
              optionRefs.current[displayedOptions.length] = element;
              customTrigger.current = element;
            }}
            marker={<Plus className="size-4" aria-hidden="true" />}
            label="Something else"
            description="Answer in your own words."
            onClick={() => {
              setCustomOpen(true);
            }}
          />
          {error === null ? null : (
            <p className="m-0 px-2 pb-2 text-xs leading-4 text-danger" role="alert">
              {error}
            </p>
          )}
        </QuestionOptions>
      )}
    </QuestionCard>
  );
}
