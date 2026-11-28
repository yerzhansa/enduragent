import { usePhrasebook } from "@enduragent/i18n/react";
import { useEffect, useId, useRef, useState, type ReactElement } from "react";
import {
  ChoiceActions,
  ChoiceList,
  ChoiceRow,
  CustomActions,
  ErrorText,
  fieldClass,
  type QuestionFormProps,
} from "./plan-creation-choices";

export function SuccessForm(props: QuestionFormProps): ReactElement {
  const { say } = usePhrasebook();
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
            setError(say("chat.planCreation.successRequired"));
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
            aria-label={say("chat.planCreation.successLabel")}
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
            label={
              authoredOption.label === "Something else"
                ? say("chat.planCreation.customAnswer")
                : say("chat.planCreation.addCommitments")
            }
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
