import type {
  ListPlansResult,
  PlanChangeIntent,
  PlanChangeModel,
  PlanChangeWorkout,
} from "@enduragent/coach-contract";
import {
  PlanChangeEventSourceSchema,
  PlanChangeFtpSourcesSchema,
  PlanChangeIntentSchema,
} from "@enduragent/coach-contract";
import { useEffect, useRef, useState, type ReactElement, type ReactNode, type Ref } from "react";
import { Button } from "@enduragent/ui";
import { Card, CardContent } from "@enduragent/ui";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@enduragent/ui";
import { PLAN_CHANGES_PAUSED_NOTICE } from "../../state/chat-slice";
import { useEnduragentStore } from "../../state/store";

import { SupportingEventFields } from "./SupportingEventFields";
import { currentSupportingEvents, supportingEventDifference } from "../../plan/supporting-events";

const changeOptions = [
  { value: "weekday-duration", label: "Weekday duration cap" },
  { value: "weekday-unavailable", label: "Weekday unavailable" },
  { value: "hard-weekday", label: "No hard training on a weekday" },
  { value: "weekly-duration", label: "Weekly duration cap" },
  { value: "longest-workout", label: "Longest-Workout cap" },
  { value: "ftp", label: "Correct FTP" },
  { value: "supporting-event", label: "Supporting Event" },
] satisfies Array<{ value: PlanChangeIntent["kind"]; label: string }>;
const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const statusLabels = {
  pending: "Pending",
  applied: "Applied",
  cancelled: "Cancelled",
  superseded: "Superseded",
  stale: "Stale",
} satisfies Record<PlanChangeModel["status"], string>;

function ChangeCard(props: {
  eyebrow: string;
  title: string;
  status?: string;
  summary?: string;
  headingRef?: Ref<HTMLHeadingElement>;
  children: ReactNode;
}): ReactElement {
  return (
    <Card size="sm" className="min-w-0" role="region" aria-label={props.title}>
      <CardContent className="grid gap-inset">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-inset">
          <div className="grid min-w-0 gap-[calc(var(--inset)/2)]">
            <p className="m-0 text-xs font-semibold uppercase tracking-wide text-ink-2">
              {props.eyebrow}
            </p>
            <h3
              ref={props.headingRef}
              tabIndex={-1}
              className="m-0 text-base leading-6 font-semibold break-words"
            >
              {props.title}
            </h3>
          </div>
          {props.status ? (
            <span className="rounded-chip bg-ink/7 px-2 py-1 text-xs font-medium text-ink-2">
              {props.status}
            </span>
          ) : null}
        </div>
        {props.summary ? <p className="m-0 text-sm leading-5 text-ink-2">{props.summary}</p> : null}
        {props.children}
      </CardContent>
    </Card>
  );
}

function Fact(props: { label: string; children: ReactNode }): ReactElement {
  return (
    <div
      role="row"
      className="grid grid-cols-[minmax(104px,0.72fr)_minmax(0,1.28fr)] gap-4 border-t border-line py-3 first:border-t-0 max-[560px]:grid-cols-1 max-[560px]:gap-1"
    >
      <span role="rowheader" className="text-xs leading-4 text-ink-2">
        {props.label}
      </span>
      <div
        role="cell"
        className="text-right text-sm leading-5 font-semibold [overflow-wrap:anywhere] max-[560px]:text-left"
      >
        {props.children}
      </div>
    </div>
  );
}

function workoutValue(workout: PlanChangeWorkout | null): string {
  if (workout === null) return "Not in Plan";
  const date =
    workout.date === null
      ? "Undated"
      : new Intl.DateTimeFormat("en-GB", {
          day: "numeric",
          month: "short",
          year: "numeric",
          timeZone: "UTC",
        }).format(new Date(`${workout.date}T12:00:00Z`));
  return `${date} · ${workout.minutes} min${workout.power === null ? "" : ` · ${workout.power} W`}`;
}

function eventDate(date: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
}

function Difference({
  change,
  library,
}: {
  change: PlanChangeModel;
  library: ListPlansResult;
}): ReactElement {
  const events = supportingEventDifference(library, change);
  const weekNumbers = [
    ...new Set(
      [...change.totals.before.weeks, ...change.totals.after.weeks].map((week) => week.number),
    ),
  ];
  return (
    <>
      {change.intent.kind === "supporting-event" ||
      (change.intent.kind === "inverse" &&
        JSON.stringify(events.before) !== JSON.stringify(events.after)) ? (
        <div role="table" aria-label="Supporting Events">
          <Fact label="Supporting Events before">
            {events.before
              .map((event) => `${event.name} · ${eventDate(event.date)} · ${event.role}`)
              .join("; ") || "None"}
          </Fact>
          <Fact label="Supporting Events after">
            {events.after
              .map((event) => `${event.name} · ${eventDate(event.date)} · ${event.role}`)
              .join("; ") || "None"}
          </Fact>
        </div>
      ) : null}
      <div role="table" aria-label="Affected individual Workouts">
        {change.diff.map((row) => (
          <Fact key={row.workoutId} label={row.before?.name ?? row.after?.name ?? "Workout"}>
            {workoutValue(row.before)} → {workoutValue(row.after)}
            {row.before && row.after && row.before.name !== row.after.name
              ? ` · ${row.after.name}`
              : ""}
          </Fact>
        ))}
      </div>
      <div role="table" aria-label="Before and after totals">
        <Fact label="Plan totals">
          {change.totals.before.plan} min → {change.totals.after.plan} min
        </Fact>
        {weekNumbers.map((number) => (
          <Fact key={number} label={`Week ${number}`}>
            {change.totals.before.weeks.find((week) => week.number === number)?.minutes ??
              "Not in Plan"}{" "}
            min →{" "}
            {change.totals.after.weeks.find((week) => week.number === number)?.minutes ??
              "Not in Plan"}{" "}
            min
          </Fact>
        ))}
      </div>
      {change.diff.length === 0 ? (
        <p className="m-0 text-sm text-ink-2">No Workout changes.</p>
      ) : null}
    </>
  );
}

function premiseValue(premise: PlanChangeModel["premises"][number]): ReactNode {
  if (premise.id === "ftp-sources") {
    const parsed = PlanChangeFtpSourcesSchema.safeParse(premise.value);
    if (!parsed.success) return premise.label;
    const labels = {
      manual: "Saved athlete FTP",
      "intervals-ftp": "Intervals.icu FTP",
      "intervals-eftp": "Intervals.icu eFTP",
    };
    return (
      <ul className="m-0 grid list-none gap-1 p-0">
        {parsed.data.candidates.map((candidate) => (
          <li key={candidate.source}>
            {labels[candidate.source]} · {candidate.watts} W
            {candidate.selected ? " · selected" : ""}
          </li>
        ))}
        {parsed.data.requestedFtp !== null ? (
          <li>Your entry · {parsed.data.requestedFtp} W</li>
        ) : null}
      </ul>
    );
  }
  if (premise.id === "event-source") {
    const parsed = PlanChangeEventSourceSchema.safeParse(premise.value);
    return parsed.success
      ? `${parsed.data.name} · ${eventDate(parsed.data.date)} · ${parsed.data.category}`
      : premise.label;
  }
  if (premise.id === "undone-change") {
    const value = premise.value;
    return value !== null &&
      typeof value === "object" &&
      "title" in value &&
      typeof value.title === "string"
      ? value.title
      : premise.label;
  }
  const parsed = PlanChangeIntentSchema.safeParse(premise.value);
  if (!parsed.success) return premise.label;
  const intent = parsed.data;
  switch (intent.kind) {
    case "weekday-duration":
      return `${days[intent.day - 1]} · ${intent.minutes} min`;
    case "weekday-unavailable":
      return `${days[intent.day - 1]} · Unavailable`;
    case "hard-weekday":
      return `${days[intent.day - 1]} · No hard training`;
    case "weekly-duration":
      return `${intent.hours} hours each week`;
    case "longest-workout":
      return `${intent.minutes} min`;
    case "choose-workout":
    case "inverse":
    case "supporting-event":
      return premise.label;
    case "ftp":
      return `${intent.watts} W`;
  }
}

function ChangeEditor(): ReactElement {
  const [kind, setKind] = useState<(typeof changeOptions)[number]["value"]>("weekday-duration");
  const library = useEnduragentStore((store) => store.planLibrary.value);
  const [eventIntent, setEventIntent] = useState<
    Extract<PlanChangeIntent, { kind: "supporting-event" }>
  >({ kind: "supporting-event", operation: "add", name: "", date: "", role: "Training" });
  const [day, setDay] = useState(3);
  const [minutes, setMinutes] = useState("30");
  const [hours, setHours] = useState("3");
  const [watts, setWatts] = useState("220");
  const state = useEnduragentStore((store) => store.planChange);
  const actions = useEnduragentStore((store) => store.chatActions);
  const firstControl = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    firstControl.current?.focus();
  }, []);
  const weekday =
    kind === "weekday-duration" || kind === "weekday-unavailable" || kind === "hard-weekday";
  return (
    <ChangeCard eyebrow="Plan Change" title="What needs to change?">
      <form
        className="grid gap-inset"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          let intent: PlanChangeIntent;
          switch (kind) {
            case "supporting-event":
              intent = eventIntent;
              break;
            case "weekday-duration":
              intent = { kind, day, minutes: Number(minutes) };
              break;
            case "weekday-unavailable":
            case "hard-weekday":
              intent = { kind, day };
              break;
            case "weekly-duration":
              intent = { kind, hours: Number(hours) };
              break;
            case "ftp":
              intent = { kind, watts: Number(watts) };
              break;
            case "longest-workout":
              intent = { kind, minutes: Number(minutes) };
              break;
          }
          actions?.previewPlanChange(intent);
        }}
      >
        <div className="grid gap-[calc(var(--inset)/2)]">
          <label htmlFor="plan-change-kind" className="text-xs text-ink-2">
            Change
          </label>
          <Select
            value={kind}
            items={changeOptions}
            disabled={state.busy}
            onValueChange={(value) => {
              const option = changeOptions.find((option) => option.value === value);
              if (!option) return;
              setKind(option.value);
              setDay(option.value === "hard-weekday" ? 1 : 3);
              setMinutes(option.value === "longest-workout" ? "60" : "30");
              setHours("3");
              setWatts("220");
            }}
          >
            <SelectTrigger id="plan-change-kind" ref={firstControl} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {changeOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {kind === "supporting-event" ? (
          <SupportingEventFields
            events={library ? currentSupportingEvents(library) : []}
            candidates={library?.active?.supportingEventCandidates ?? []}
            busy={state.busy}
            onIntentChange={setEventIntent}
          />
        ) : null}
        {weekday ? (
          <div className="grid gap-[calc(var(--inset)/2)]">
            <label htmlFor="plan-change-day" className="text-xs text-ink-2">
              Weekday
            </label>
            <Select
              value={day}
              items={days.map((label, index) => ({ value: index + 1, label }))}
              disabled={state.busy}
              onValueChange={(value) => {
                if (value !== null) setDay(value);
              }}
            >
              <SelectTrigger id="plan-change-day" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {days.map((label, index) => (
                  <SelectItem key={label} value={index + 1}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        {kind === "weekday-duration" || kind === "longest-workout" ? (
          <div className="grid gap-[calc(var(--inset)/2)]">
            <label htmlFor="plan-change-minutes" className="text-xs text-ink-2">
              Duration limit in minutes
            </label>
            <input
              className="min-h-[var(--ctl-h-lg)] rounded-ctl border border-line-2 bg-sunk px-ctl-px-sm py-2 text-sm font-normal leading-5 text-ink outline-none focus:border-ring focus:ring-3 focus:ring-ring/20"
              id="plan-change-minutes"
              type="number"
              min="1"
              value={minutes}
              disabled={state.busy}
              onChange={(event) => setMinutes(event.target.value)}
            />
          </div>
        ) : null}
        {kind === "weekly-duration" ? (
          <div className="grid gap-[calc(var(--inset)/2)]">
            <label htmlFor="plan-change-hours" className="text-xs text-ink-2">
              Weekly limit in hours
            </label>
            <input
              className="min-h-[var(--ctl-h-lg)] rounded-ctl border border-line-2 bg-sunk px-ctl-px-sm py-2 text-sm font-normal leading-5 text-ink outline-none focus:border-ring focus:ring-3 focus:ring-ring/20"
              id="plan-change-hours"
              type="number"
              min="0.25"
              step="0.25"
              value={hours}
              disabled={state.busy}
              onChange={(event) => setHours(event.target.value)}
            />
          </div>
        ) : null}
        {kind === "ftp" ? (
          <div className="grid gap-[calc(var(--inset)/2)]">
            <label htmlFor="plan-change-watts" className="text-xs text-ink-2">
              FTP in watts
            </label>
            <input
              className="min-h-[var(--ctl-h-lg)] rounded-ctl border border-line-2 bg-sunk px-ctl-px-sm py-2 text-sm font-normal leading-5 text-ink outline-none focus:border-ring focus:ring-3 focus:ring-ring/20"
              id="plan-change-watts"
              type="number"
              min="1"
              step="1"
              value={watts}
              disabled={state.busy}
              onChange={(event) => setWatts(event.target.value)}
            />
          </div>
        ) : null}
        {state.error ? (
          <p role="alert" className="m-0 text-xs text-danger">
            {state.error}
          </p>
        ) : null}
        <div className="mt-row flex flex-wrap gap-inset">
          <Button
            type="button"
            variant="outline"
            disabled={state.busy}
            onClick={() => actions?.backFromPlanChangeEditor()}
          >
            Back
          </Button>
          <Button type="submit" disabled={state.busy || actions === null}>
            Preview change
          </Button>
        </div>
      </form>
    </ChangeCard>
  );
}

export function PlanChangeCards(): ReactElement | null {
  const library = useEnduragentStore((store) => store.planLibrary.value);
  const state = useEnduragentStore((store) => store.planChange);
  const actions = useEnduragentStore((store) => store.chatActions);
  const setActiveView = useEnduragentStore((store) => store.setActiveView);
  const activeView = useEnduragentStore((store) => store.activeView);
  const [source, setSource] = useState<{ change: PlanChangeModel; difference: boolean } | null>(
    null,
  );
  const sourceHeading = useRef<HTMLHeadingElement>(null);
  const sourceOpener = useRef<HTMLButtonElement | null>(null);
  const changeButton = useRef<HTMLButtonElement>(null);
  const pauseNotice = useRef<HTMLParagraphElement>(null);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const pending = library?.changes.find((change) => change.status === "pending");
  const paused = library?.changesPaused != null;
  useEffect(() => {
    if (activeView !== "chat" || state.busy) return;
    if (state.focusRequest?.target === "preview" && pending) previewHeading.current?.focus();
    if (state.focusRequest?.target === "change") {
      if (paused) pauseNotice.current?.focus();
      else changeButton.current?.focus();
    }
  }, [state.focusRequest, state.busy, pending?.changeId, activeView, paused]);
  useEffect(() => {
    if (source) sourceHeading.current?.focus();
  }, [source]);
  const activePlanId = library?.active?.planId ?? null;
  useEffect(() => {
    setSource(null);
  }, [activePlanId]);
  if (!library?.active || (!pending && !(state.open && state.planId === library.active.planId)))
    return null;
  const openSource = (
    change: PlanChangeModel,
    difference: boolean,
    button: HTMLButtonElement,
  ): void => {
    sourceOpener.current = button;
    setSource({ change, difference });
  };
  const notice = paused
    ? PLAN_CHANGES_PAUSED_NOTICE
    : (state.notice ?? (pending ? "Review the exact changes before confirming." : null));
  const pausedReason = paused ? "plan-changes-notice" : undefined;
  return (
    <section aria-label="Plan Changes" className="grid min-w-0 gap-inset">
      {notice ? (
        <p
          ref={pauseNotice}
          id="plan-changes-notice"
          role="status"
          tabIndex={-1}
          className="m-0 text-sm text-ink-2"
        >
          {notice}
        </p>
      ) : null}
      {!state.editorOpen && state.error ? (
        <p role="alert" className="m-0 text-xs text-danger">
          {state.error}
        </p>
      ) : null}
      <ChangeCard
        eyebrow="Active Plan"
        title={library.active.name}
        summary={
          library.creation
            ? "Your separate Plan creation is still open."
            : "Changes affect future, uncompleted training."
        }
      >
        <div className="mt-row flex flex-wrap gap-inset">
          <Button
            ref={changeButton}
            disabled={paused || state.busy || actions === null}
            aria-describedby={pausedReason}
            onClick={() => actions?.openPlanChangeEditor()}
          >
            Change one thing
          </Button>
          <Button variant="outline" onClick={() => setActiveView("plan")}>
            Open Plan
          </Button>
        </div>
      </ChangeCard>
      {state.editorOpen && !paused ? <ChangeEditor /> : null}
      {library.active.todayChoice ? (
        <ChangeCard eyebrow="Today" title="Choose one eligible Workout">
          <ul className="m-0 grid list-none p-0">
            {library.active.todayChoice.eligible.map((workout) => (
              <li
                key={workout.workoutId}
                className="flex flex-wrap items-center justify-between gap-inset border-t border-line py-3 first:border-t-0"
              >
                <span className="text-sm leading-5">
                  {workout.name} · {workout.minutes} min
                </span>
                <Button
                  variant="outline"
                  disabled={paused || state.busy || actions === null}
                  aria-describedby={pausedReason}
                  onClick={() =>
                    actions?.previewPlanChange({
                      kind: "choose-workout",
                      workoutId: workout.workoutId,
                    })
                  }
                >
                  Review {workout.name}
                </Button>
              </li>
            ))}
            {library.active.todayChoice.blocked.map((workout) => (
              <li
                key={workout.workoutId}
                className="flex flex-wrap items-center justify-between gap-inset border-t border-line py-3 first:border-t-0"
              >
                <span className="text-sm leading-5">{workout.name}</span>
                <span className="text-sm leading-5 text-ink-2">{workout.reason}</span>
              </li>
            ))}
          </ul>
          {library.active.todayChoice.eligible.length === 0 && library.active.todayChoice.reason ? (
            <p className="m-0 text-sm leading-5 text-ink-2">{library.active.todayChoice.reason}</p>
          ) : null}
        </ChangeCard>
      ) : null}
      {pending ? (
        <ChangeCard
          eyebrow="Plan Change"
          title={pending.title}
          status="Pending"
          headingRef={previewHeading}
          summary={
            pending.intent.kind === "inverse"
              ? "Restore the previewed future training. Completed and past training stays unchanged."
              : "Review this exact difference. Training stays unchanged until you confirm."
          }
        >
          {pending.details ? (
            <p className="m-0 text-sm leading-5 text-ink-2">{pending.details}</p>
          ) : null}
          <Difference change={pending} library={library} />
          <div role="table" aria-label="Facts">
            <Fact label="Main Goal">{library.active.name}</Fact>
            <Fact label="Confidence">{pending.confidence}</Fact>
          </div>
          <div>
            <Button
              variant="outline"
              onClick={(event) => openSource(pending, false, event.currentTarget)}
            >
              View evidence
            </Button>
          </div>
          <div className="mt-row flex flex-wrap gap-inset">
            <Button
              variant="outline"
              disabled={state.busy || actions === null}
              onClick={() => actions?.applyPlanChange("cancel")}
            >
              Cancel
            </Button>
            <Button
              disabled={paused || state.busy || actions === null}
              aria-describedby={pausedReason}
              onClick={() => actions?.applyPlanChange("apply")}
            >
              Apply to Plan
            </Button>
          </div>
        </ChangeCard>
      ) : null}
      {library.changes
        .filter((change) => change.status !== "pending")
        .map((change) => (
          <ChangeCard
            key={change.changeId}
            eyebrow="Plan Change history"
            title={change.title}
            status={statusLabels[change.status]}
            summary="Earlier decisions remain readable."
          >
            <div className="mt-row flex flex-wrap gap-inset">
              <Button
                variant="outline"
                onClick={(event) => openSource(change, false, event.currentTarget)}
              >
                Read historical evidence
              </Button>
              {change.status === "applied" && change.undo?.eligible ? (
                <Button
                  variant="outline"
                  disabled={paused || state.busy || actions === null}
                  aria-describedby={pausedReason}
                  onClick={() =>
                    actions?.previewPlanChange({ kind: "inverse", changeId: change.changeId })
                  }
                >
                  Undo
                </Button>
              ) : null}
              <Button
                variant="outline"
                onClick={(event) => openSource(change, true, event.currentTarget)}
              >
                Read this difference
              </Button>
            </div>
          </ChangeCard>
        ))}
      {source ? (
        <ChangeCard eyebrow="Evidence" title="Source details" headingRef={sourceHeading}>
          {source.difference ? (
            <>
              <p className="m-0 text-sm text-ink-2">{statusLabels[source.change.status]}</p>
              <Difference change={source.change} library={library} />
            </>
          ) : null}
          <div role="table" aria-label="Source details">
            {source.change.premises.map((premise) => (
              <Fact key={premise.id} label={`${premise.label} · ${premise.source}`}>
                {premiseValue(premise)}
              </Fact>
            ))}
          </div>
          <div className="mt-row flex flex-wrap gap-inset">
            <Button
              variant="outline"
              onClick={() => {
                setSource(null);
                sourceOpener.current?.focus();
              }}
            >
              Back
            </Button>
          </div>
        </ChangeCard>
      ) : null}
    </section>
  );
}
