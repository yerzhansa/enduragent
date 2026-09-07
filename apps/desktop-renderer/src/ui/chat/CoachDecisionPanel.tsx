import { ChevronRight, LoaderCircle, Plus, X } from "lucide-react";
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
      <section
        className="grid gap-inset rounded-card border border-line bg-surface p-4 shadow-elev-2"
        aria-live="polite"
      >
        <div className="grid gap-[calc(var(--inset)/2)]">
          <strong className="text-sm font-medium leading-5">Your choice is saved</strong>
          <p className="m-0 text-xs leading-4 text-ink-2">{answerLabel ?? "Your answer"}</p>
          <p className="m-0 text-xs leading-4 text-danger" role="alert">
            {error}
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
            Try again
          </Button>
        </div>
      </section>
    );
  }

  if (
    decision !== null &&
    (phase !== "idle" ||
      (decision.status === "answered" && decision.continuation.status === "pending"))
  ) {
    const recovering = phase === "recovering";
    return (
      <section
        className="grid grid-cols-[var(--ctl-h-sm)_minmax(0,1fr)] items-center gap-row rounded-card border border-line bg-surface p-ctl-px shadow-elev-2"
        aria-live="polite"
        aria-busy="true"
      >
        <LoaderCircle
          className="size-4 justify-self-center animate-spin text-ink-2 motion-reduce:animate-none"
          aria-hidden="true"
        />
        <div className="grid gap-[calc(var(--inset)/2)]">
          <strong className="text-sm font-medium leading-5">
            {recovering ? "Finishing your saved choice…" : "Continuing with your choice…"}
          </strong>
          <p className="m-0 text-xs leading-4 text-ink-2">
            {answerLabel ?? "Your answer"}
            {recovering ? " was saved before Enduragent reopened." : ""}
          </p>
          {error === null ? null : (
            <p className="m-0 text-xs leading-4 text-danger" role="alert">
              {error}
            </p>
          )}
          {error === null ? null : (
            <div className="flex justify-end pt-[calc(var(--inset)/2)]">
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
            </div>
          )}
        </div>
      </section>
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
    <section
      className="overflow-hidden rounded-card border border-line bg-surface shadow-elev-2"
      aria-labelledby={questionId}
      aria-live="polite"
      onKeyDown={onKeyDown}
    >
      <header className="flex items-center justify-between gap-inset border-b border-line px-4 pt-4 pb-2">
        <div className="grid gap-[calc(var(--inset)/2)]">
          <p className="m-0 text-xs font-semibold leading-4 text-ink-2">Coach needs your answer</p>
          <h2 id={questionId} className="m-0 text-sm font-medium leading-5">
            {decision.question}
          </h2>
        </div>
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
      </header>
      {customOpen ? (
        <div className="grid gap-inset px-4 py-4">
          <label
            className="text-xs font-semibold leading-4 text-ink-2"
            htmlFor="decision-custom-answer"
          >
            What would work better?
          </label>
          <textarea
            id="decision-custom-answer"
            ref={customInput}
            className="min-h-[calc(var(--ctl-h-lg)+var(--inset))] resize-y rounded-ctl border border-line-2 bg-sunk px-3 py-2 text-sm leading-5 text-ink outline-none focus:border-ring focus:ring-3 focus:ring-ring/20"
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
        </div>
      ) : (
        <div className="grid gap-1 p-2">
          {displayedOptions.map((option, index) => (
            <button
              key={option.id}
              ref={(element) => {
                optionRefs.current[index] = element;
              }}
              type="button"
              className="grid min-h-[calc(var(--ctl-h-lg)+var(--row-inset))] grid-cols-[var(--ctl-h-sm)_minmax(0,1fr)_20px] items-center gap-2 rounded-ctl border-0 bg-transparent px-2 py-1.5 text-left text-ink hover:bg-ink/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              onClick={() => {
                choose(option.id);
              }}
            >
              <span className="grid size-8 place-items-center rounded-full border border-line-2 text-xs leading-4 text-ink-2">
                {index + 1}
              </span>
              <span className="block min-w-0">
                <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium leading-5">
                  {option.label}
                  {option.recommended ? (
                    <span className="rounded-full bg-ink/7 px-1.5 py-0.5 text-xs font-medium leading-4 text-ink-2">
                      Recommended
                    </span>
                  ) : null}
                </span>
                <span className="mt-[calc(var(--inset)/2)] block text-sm leading-5 text-ink-2">
                  {option.description}
                </span>
              </span>
              <ChevronRight className="size-4 text-ink-2" aria-hidden="true" />
            </button>
          ))}
          <button
            ref={(element) => {
              optionRefs.current[displayedOptions.length] = element;
              customTrigger.current = element;
            }}
            type="button"
            className="grid min-h-[calc(var(--ctl-h-lg)+var(--row-inset))] grid-cols-[var(--ctl-h-sm)_minmax(0,1fr)_20px] items-center gap-2 rounded-ctl border-0 bg-transparent px-2 py-1.5 text-left text-ink hover:bg-ink/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            onClick={() => {
              setCustomOpen(true);
            }}
          >
            <span className="grid size-8 place-items-center rounded-full border border-line-2 text-ink-2">
              <Plus className="size-4" aria-hidden="true" />
            </span>
            <span className="block min-w-0">
              <strong className="block text-sm font-medium leading-5">Something else</strong>
              <span className="mt-[calc(var(--inset)/2)] block text-sm leading-5 text-ink-2">
                Answer in your own words.
              </span>
            </span>
            <ChevronRight className="size-4 text-ink-2" aria-hidden="true" />
          </button>
          {error === null ? null : (
            <p className="m-0 px-2 pb-2 text-xs leading-4 text-danger" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
