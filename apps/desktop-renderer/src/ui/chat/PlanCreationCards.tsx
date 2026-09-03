import { useEffect, useRef, useState, type FormEvent, type ReactElement } from "react";
import type { PlanCreationAnswerInput, PlanCreationCardModel } from "@enduragent/coach-contract";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { useEnduragentStore } from "../../state/store";

const fieldClass =
  "min-h-[calc(var(--ctl-h-lg)+var(--inset))] resize-y rounded-ctl border border-line-2 bg-sunk px-3 py-2 text-sm leading-5 text-ink outline-none focus:border-ring focus:ring-3 focus:ring-ring/20";

export function PlanCreationDock(): ReactElement | null {
  const model = useEnduragentStore((state) => state.chat.planCreation);
  const loaded = useEnduragentStore((state) => state.chat.planCreationLoaded);
  const busy = useEnduragentStore((state) => state.chat.planCreationBusy);
  const error = useEnduragentStore((state) => state.chat.planCreationError);
  const decision = useEnduragentStore((state) => state.chat.decision);
  const actions = useEnduragentStore((state) => state.chatActions);
  const [goalMode, setGoalMode] = useState<"choices" | "manual" | "fitness">("choices");
  const heading = useRef<HTMLHeadingElement>(null);
  const question = model?.openQuestion ?? null;
  const decisionPending =
    decision?.status === "unanswered" ||
    (decision?.status === "answered" && decision.continuation.status === "pending");
  useEffect(() => {
    setGoalMode("choices");
    if (question !== null) heading.current?.focus();
  }, [model?.creationId, model?.version, question?.kind]);
  if (!loaded) return null;
  if (model === null) {
    return (
      <div className="flex min-w-0 justify-end rounded-card border border-line bg-surface px-4 py-3">
        <Button
          variant="outline"
          disabled={busy || actions === null || decisionPending}
          onClick={() => actions?.startPlanCreation()}
        >
          Start a Plan
        </Button>
      </div>
    );
  }
  if (question === null) return null;
  const answer = (value: PlanCreationAnswerInput): void => actions?.answerPlanCreation(value);
  const submitFitness = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const outcome = new FormData(event.currentTarget).get("outcome")?.toString().trim() ?? "";
    if (outcome) answer({ kind: "goal", goal: { kind: "fitness", outcome } });
  };
  const submitManual = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = data.get("name")?.toString().trim() ?? "";
    const date = data.get("date")?.toString() ?? "";
    if (name && date) answer({ kind: "goal", goal: { kind: "event-manual", name, date } });
  };
  const submitSuccess = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const text = new FormData(event.currentTarget).get("success")?.toString().trim() ?? "";
    if (text) answer({ kind: "success", success: { kind: "authored", text } });
  };
  return (
    <Card className="min-w-0 shadow-elev-2">
      <CardHeader>
        <p className="m-0 text-xs font-semibold uppercase tracking-wide text-ink-2">
          Plan Creation
        </p>
        <CardTitle>
          <h2 ref={heading} tabIndex={-1} className="m-0 outline-none">
            {question.prompt}
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid min-w-0 gap-inset">
        {question.kind === "goal-question" && goalMode === "choices" ? (
          <div className="grid min-w-0 gap-2 sm:grid-cols-2">
            {question.candidates.map((candidate) => (
              <Button
                key={candidate.candidateId}
                variant="outline"
                className="h-auto min-w-0 justify-start whitespace-normal text-left"
                disabled={busy}
                onClick={() =>
                  answer({
                    kind: "goal",
                    goal: { kind: "event-candidate", candidateId: candidate.candidateId },
                  })
                }
              >
                {candidate.name} · {candidate.date}
              </Button>
            ))}
            <Button variant="outline" disabled={busy} onClick={() => setGoalMode("manual")}>
              Event not listed
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => setGoalMode("fitness")}>
              Improve without an event
            </Button>
          </div>
        ) : question.kind === "goal-question" && goalMode === "fitness" ? (
          <form key="goal-fitness" className="grid min-w-0 gap-inset" onSubmit={submitFitness}>
            <textarea
              aria-label="Goal outcome"
              className={fieldClass}
              name="outcome"
              maxLength={2000}
              required
              rows={3}
            />
            <Button type="submit" className="justify-self-end" disabled={busy}>
              Confirm goal
            </Button>
          </form>
        ) : question.kind === "goal-question" ? (
          <form key="goal-manual" className="grid min-w-0 gap-inset sm:grid-cols-2" onSubmit={submitManual}>
            <input
              aria-label="Event name"
              className={fieldClass}
              name="name"
              placeholder="Event name"
              maxLength={512}
              required
            />
            <input
              aria-label="Event date"
              className={fieldClass}
              name="date"
              type="date"
              required
            />
            <Button type="submit" className="justify-self-end sm:col-span-2" disabled={busy}>
              Confirm goal
            </Button>
          </form>
        ) : question.input.kind === "authored" ? (
          <form key="success" className="grid min-w-0 gap-inset" onSubmit={submitSuccess}>
            <textarea
              aria-label="Success meaning"
              className={fieldClass}
              name="success"
              placeholder={question.input.placeholder}
              maxLength={2000}
              required
              rows={3}
            />
            <Button type="submit" className="justify-self-end" disabled={busy}>
              Confirm success
            </Button>
          </form>
        ) : (
          <div className="grid min-w-0 gap-2 sm:grid-cols-3">
            {question.input.options.map((option) => (
              <Button
                key={option.choice}
                variant="outline"
                className="h-auto whitespace-normal"
                disabled={busy}
                onClick={() =>
                  answer({
                    kind: "success",
                    success: { kind: "event-finish", choice: option.choice },
                  })
                }
              >
                {option.label}
              </Button>
            ))}
          </div>
        )}
        {error === null ? null : (
          <p className="m-0 text-xs text-danger" role="alert">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function PlanCreationConversation(props: {
  readonly model: PlanCreationCardModel | null;
}): ReactElement | null {
  if (props.model === null) return null;
  return (
    <section className="grid min-w-0 gap-inset" aria-label="Plan Creation progress">
      {props.model.answeredSummaries.length === 0 ? null : (
        <dl className="m-0 grid gap-2 rounded-card bg-sunk p-3">
          {props.model.answeredSummaries.map((summary) => (
            <div
              key={summary.answerKey}
              className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-inset text-sm"
            >
              <dt className="font-medium text-ink-2">{summary.title}</dt>
              <dd className="m-0 min-w-0 break-words">{summary.detail}</dd>
            </div>
          ))}
        </dl>
      )}
      <Card size="sm" className="min-w-0">
        <CardContent>
          <strong>Plan Creation</strong>
          <p className="m-0 text-xs text-ink-2">
            {props.model.answeredSummaries.length}{" "}
            {props.model.answeredSummaries.length === 1 ? "answer" : "answers"} confirmed
          </p>
        </CardContent>
      </Card>
    </section>
  );
}
