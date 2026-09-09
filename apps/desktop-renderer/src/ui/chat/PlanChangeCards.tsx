import { usePhrasebook } from "@enduragent/i18n/react";
import type { CatalogKey } from "@enduragent/i18n";
import type { Phrasebook } from "@enduragent/i18n/messages";
import { chatFeedbackMessage } from "./copy";
import { useChatDate } from "./use-chat-date";
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
  PlanChangeRequestSchema,
} from "@enduragent/coach-contract";
import { useEffect, useRef, useState, type ReactElement, type ReactNode, type Ref } from "react";
import { Button } from "@enduragent/ui";
import { Fact, PlanCard } from "../plan/plan-card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@enduragent/ui";
import { useEnduragentStore } from "../../state/store";

import { SupportingEventFields } from "./SupportingEventFields";
import { currentSupportingEvents, supportingEventDifference } from "../../plan/supporting-events";

const days: readonly CatalogKey[] = [
  "chat.planChange.day.mon",
  "chat.planChange.day.tue",
  "chat.planChange.day.wed",
  "chat.planChange.day.thu",
  "chat.planChange.day.fri",
  "chat.planChange.day.sat",
  "chat.planChange.day.sun",
];
const statusLabels = {
  pending: "chat.planChange.status.pending",
  applied: "chat.planChange.status.applied",
  cancelled: "chat.planChange.status.cancelled",
  superseded: "chat.planChange.status.superseded",
  stale: "chat.planChange.status.stale",
} satisfies Record<PlanChangeModel["status"], CatalogKey>;

function calendarStatusLabel(
  calendar: NonNullable<ListPlansResult["active"]>["calendar"],
  { say }: Phrasebook,
  formatCivilDate: (value: string) => string,
): string {
  switch (calendar.status) {
    case "verified":
      return calendar.window === null
        ? say("chat.planChange.calendar.current")
        : say("chat.planChange.calendar.window", {
            start: formatCivilDate(calendar.window.start),
            end: formatCivilDate(calendar.window.end),
          });
    case "pending":
      return say(
        calendar.window === null
          ? "chat.planChange.calendar.local"
          : "chat.planChange.calendar.updating",
      );
    case "running":
      return say("chat.planChange.calendar.updating");
    case "not-connected":
      return say("chat.planChange.calendar.connect");
    case "failed":
      return say(
        calendar.error.endsWith("Retry available.")
          ? "chat.planChange.calendar.failedRetry"
          : "chat.planChange.calendar.failed",
      );
  }
}

function sayFeedback(value: string, say: Phrasebook["say"]): string {
  const message = chatFeedbackMessage(value);
  return message === null ? value : say(message);
}

function ChangeCard(props: {
  eyebrow: string;
  title: string;
  status?: string;
  summary?: string;
  headingRef?: Ref<HTMLHeadingElement>;
  children: ReactNode;
}): ReactElement {
  return (
    <PlanCard
      {...props}
      aria-label={props.title}
      headingTabIndex={-1}
      statusClassName="inline-flex shrink-0 items-center gap-[calc(var(--row-inset)/2)] text-xs font-normal whitespace-nowrap text-ink-2"
    />
  );
}

function workoutValue(
  workout: PlanChangeWorkout | null,
  { say, format }: Phrasebook,
  formatCivilDate: (value: string) => string,
): string {
  if (workout === null) return say("chat.planChange.notInPlan");
  const date =
    workout.date === null ? say("chat.planChange.undated") : formatCivilDate(workout.date);
  return say(
    workout.power === null ? "chat.planChange.workoutValue" : "chat.planChange.workoutPower",
    {
      date,
      minutes: format.number(workout.minutes, { useGrouping: false }),
      watts: workout.power === null ? "" : format.number(workout.power, { useGrouping: false }),
    },
  );
}

function SupportingEventFacts({
  change,
  library,
}: {
  change: PlanChangeModel;
  library: ListPlansResult;
}): ReactElement {
  const phrasebook = usePhrasebook();
  const { say } = phrasebook;
  const formatCivilDate = useChatDate();
  const events = supportingEventDifference(library, change);
  return (
    <>
      <Fact valueAs="div" label={say("chat.planChange.eventsBefore")}>
        {events.before
          .map((event) =>
            say("chat.planChange.eventValue", {
              name: event.name,
              date: formatCivilDate(event.date),
              role: say(
                event.role === "Important"
                  ? "chat.supportingEvent.role.important"
                  : "chat.supportingEvent.role.training",
              ),
            }),
          )
          .join("; ") || say("chat.planChange.none")}
      </Fact>
      <Fact valueAs="div" label={say("chat.planChange.eventsAfter")}>
        {events.after
          .map((event) =>
            say("chat.planChange.eventValue", {
              name: event.name,
              date: formatCivilDate(event.date),
              role: say(
                event.role === "Important"
                  ? "chat.supportingEvent.role.important"
                  : "chat.supportingEvent.role.training",
              ),
            }),
          )
          .join("; ") || say("chat.planChange.none")}
      </Fact>
    </>
  );
}

function Difference({
  change,
  library,
  showSupportingEvents = true,
}: {
  change: PlanChangeModel;
  library: ListPlansResult;
  showSupportingEvents?: boolean;
}): ReactElement {
  const phrasebook = usePhrasebook();
  const { say, format } = phrasebook;
  const formatCivilDate = useChatDate();
  const events = supportingEventDifference(library, change);
  const weekNumbers = [
    ...new Set(
      [...change.totals.before.weeks, ...change.totals.after.weeks].map((week) => week.number),
    ),
  ];
  return (
    <>
      {showSupportingEvents &&
      (change.intent.kind === "supporting-event" ||
        (change.intent.kind === "inverse" &&
          JSON.stringify(events.before) !== JSON.stringify(events.after))) ? (
        <div
          role="table"
          className="border-t border-line [&+[role=table]]:border-t-0"
          aria-label={say("chat.planChange.events")}
        >
          <SupportingEventFacts change={change} library={library} />
        </div>
      ) : null}
      <div
        role="table"
        className="border-t border-line [&+[role=table]]:border-t-0"
        aria-label={say("chat.planChange.affectedWorkouts")}
      >
        {change.diff.map((row) => (
          <Fact
            valueAs="div"
            key={row.workoutId}
            label={row.before?.name ?? row.after?.name ?? say("chat.planChange.workout")}
          >
            {say(
              row.before && row.after && row.before.name !== row.after.name
                ? "chat.planChange.renamedDifference"
                : "chat.planChange.difference",
              {
                before: workoutValue(row.before, phrasebook, formatCivilDate),
                after: workoutValue(row.after, phrasebook, formatCivilDate),
                name: row.after?.name ?? "",
              },
            )}
          </Fact>
        ))}
      </div>
      <div
        role="table"
        className="border-t border-line [&+[role=table]]:border-t-0"
        aria-label={say("chat.planChange.totals")}
      >
        <Fact valueAs="div" label={say("chat.planChange.planTotals")}>
          {say("chat.planChange.minuteDifference", {
            before: format.number(change.totals.before.plan, { useGrouping: false }),
            after: format.number(change.totals.after.plan, { useGrouping: false }),
          })}
        </Fact>
        {weekNumbers.map((number) => {
          const before = change.totals.before.weeks.find((week) => week.number === number);
          const after = change.totals.after.weeks.find((week) => week.number === number);
          return (
            <Fact
              valueAs="div"
              key={number}
              label={say("chat.planChange.week", {
                number: format.number(number, { useGrouping: false }),
              })}
            >
              {say("chat.planChange.minuteDifference", {
                before:
                  before === undefined
                    ? say("chat.planChange.notInPlan")
                    : format.number(before.minutes, { useGrouping: false }),
                after:
                  after === undefined
                    ? say("chat.planChange.notInPlan")
                    : format.number(after.minutes, { useGrouping: false }),
              })}
            </Fact>
          );
        })}
      </div>
      {change.diff.length === 0 ? (
        <p className="m-0 text-sm text-ink-2">{say("chat.planChange.noChanges")}</p>
      ) : null}
    </>
  );
}

function premiseValue(
  premise: PlanChangeModel["premises"][number],
  { say, format }: Phrasebook,
  formatCivilDate: (value: string) => string,
): ReactNode {
  if (premise.id === "confirmed-limits") {
    return typeof premise.value === "string" && premise.value.trim() ? premise.value : null;
  }
  if (premise.id === "request") {
    const parsed = PlanChangeRequestSchema.safeParse(premise.value);
    if (parsed.success && parsed.data.kind === "text") return parsed.data.text;
  }
  if (premise.id === "ftp-sources") {
    const parsed = PlanChangeFtpSourcesSchema.safeParse(premise.value);
    if (!parsed.success) return null;
    const labels = {
      manual: say("chat.planChange.ftpSource.manual"),
      "intervals-ftp": say("chat.planChange.ftpSource.intervalsFtp", { provider: "Intervals.icu" }),
      "intervals-eftp": say("chat.planChange.ftpSource.intervalsEftp", {
        provider: "Intervals.icu",
      }),
    };
    return (
      <ul className="m-0 grid list-none gap-1 p-0">
        {parsed.data.candidates.map((candidate) => (
          <li key={candidate.source}>
            {say(
              candidate.selected ? "chat.planChange.ftpSelected" : "chat.planChange.ftpCandidate",
              {
                source: labels[candidate.source],
                watts: format.number(candidate.watts, { useGrouping: false }),
              },
            )}
          </li>
        ))}
        {parsed.data.requestedFtp !== null ? (
          <li>
            {say("chat.planChange.ftpEntry", {
              watts: format.number(parsed.data.requestedFtp, { useGrouping: false }),
            })}
          </li>
        ) : null}
      </ul>
    );
  }
  if (premise.id === "event-source") {
    const parsed = PlanChangeEventSourceSchema.safeParse(premise.value);
    return parsed.success
      ? say("chat.planChange.eventValue", {
          name: parsed.data.name,
          date: formatCivilDate(parsed.data.date),
          role: parsed.data.category,
        })
      : null;
  }
  if (premise.id === "undone-change") {
    const value = premise.value;
    return value !== null &&
      typeof value === "object" &&
      "title" in value &&
      typeof value.title === "string"
      ? value.title
      : null;
  }
  const parsed = PlanChangeIntentSchema.safeParse(premise.value);
  if (!parsed.success) return null;
  const intent = parsed.data;
  switch (intent.kind) {
    case "weekday-duration":
      return say("chat.planChange.weekdayMinutes", {
        day: say(days[intent.day - 1]!),
        minutes: format.number(intent.minutes, { useGrouping: false }),
      });
    case "weekday-unavailable":
      return say("chat.planChange.weekdayBlocked", { day: say(days[intent.day - 1]!) });
    case "hard-weekday":
      return say("chat.planChange.weekdayEasy", { day: say(days[intent.day - 1]!) });
    case "weekly-duration":
      return say("chat.planChange.weeklyHours", {
        count: intent.hours,
        hours: format.number(intent.hours, { useGrouping: false }),
      });
    case "longest-workout":
      return say("chat.planChange.minutes", {
        minutes: format.number(intent.minutes, { useGrouping: false }),
      });
    case "choose-workout":
    case "inverse":
    case "supporting-event":
      return null;
    case "ftp":
      return say("chat.planChange.watts", {
        watts: format.number(intent.watts, { useGrouping: false }),
      });
  }
}

function ChangeEditor(): ReactElement {
  const { say } = usePhrasebook();
  const changeOptions = [
    { value: "weekday-duration", label: say("chat.planChange.option.weekdayDuration") },
    { value: "weekday-unavailable", label: say("chat.planChange.option.weekdayUnavailable") },
    { value: "hard-weekday", label: say("chat.planChange.option.hardWeekday") },
    { value: "weekly-duration", label: say("chat.planChange.option.weeklyDuration") },
    { value: "longest-workout", label: say("chat.planChange.option.longestWorkout") },
    { value: "ftp", label: say("chat.planChange.option.ftp") },
    { value: "supporting-event", label: say("chat.planChange.option.supportingEvent") },
  ] satisfies Array<{ value: PlanChangeIntent["kind"]; label: string }>;

  const dayLabels = days.map((key) => say(key));
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
    <ChangeCard eyebrow={say("chat.planChange.title")} title={say("chat.planChange.editorTitle")}>
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
            {say("chat.planChange.change")}
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
              {say("chat.planChange.weekday")}
            </label>
            <Select
              value={day}
              items={dayLabels.map((label, index) => ({ value: index + 1, label }))}
              disabled={state.busy}
              onValueChange={(value) => {
                if (value !== null) setDay(value);
              }}
            >
              <SelectTrigger id="plan-change-day" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {dayLabels.map((label, index) => (
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
              {say("chat.planChange.durationLimit")}
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
              {say("chat.planChange.weeklyLimit")}
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
              {say("chat.planChange.ftpWatts")}
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
            {sayFeedback(state.error, say)}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-inset">
          <Button
            type="button"
            variant="outline"
            className="border-line bg-surface"
            disabled={state.busy}
            onClick={() => actions?.backFromPlanChangeEditor()}
          >
            {say("common.back")}
          </Button>
          <Button type="submit" disabled={state.busy || actions === null}>
            {say("chat.planChange.preview")}
          </Button>
        </div>
      </form>
    </ChangeCard>
  );
}

export function PlanChangeCards(): ReactElement | null {
  const phrasebook = usePhrasebook();
  const { say, format } = phrasebook;
  const formatCivilDate = useChatDate();
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
  const pauseNotice = useRef<HTMLDivElement>(null);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const pending = library?.changes.find((change) => change.status === "pending");
  const paused = library?.changesPaused != null;
  useEffect(() => {
    if (activeView !== "chat" || state.busy) return;
    if (state.focusRequest?.target === "preview" && pending) previewHeading.current?.focus();
    if (state.focusRequest?.target === "change") {
      if (!state.open && !pending) {
        const composer = document.querySelector("#message");
        if (composer instanceof HTMLTextAreaElement) composer.focus();
      } else if (paused) pauseNotice.current?.focus();
      else changeButton.current?.focus();
    }
  }, [state.focusRequest, state.busy, state.open, pending?.changeId, activeView, paused]);
  useEffect(() => {
    if (source) sourceHeading.current?.focus();
  }, [source]);
  const activePlanId = library?.active?.planId ?? null;
  useEffect(() => {
    setSource(null);
  }, [activePlanId]);
  if (
    !library?.active ||
    (library.creation !== null &&
      !pending &&
      !(state.open && state.planId === library.active.planId))
  )
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
    ? say("chat.planChange.paused", { hours: format.number(24, { useGrouping: false }) })
    : (state.notice ?? (pending ? say("chat.planChange.reviewNotice") : null));
  const pausedReason = paused ? "plan-changes-notice" : undefined;
  return (
    <section aria-label={say("chat.planChange.section")} className="grid min-w-0 gap-4">
      {notice ? (
        <div
          ref={pauseNotice}
          id="plan-changes-notice"
          role="status"
          tabIndex={-1}
          className="m-0 rounded-ctl bg-surface-2 p-row text-sm text-ink"
        >
          <p className="m-0 text-xs leading-4 text-ink-2">{sayFeedback(notice, say)}</p>
        </div>
      ) : null}
      {!state.editorOpen && state.error ? (
        <p role="alert" className="m-0 text-xs text-danger">
          {sayFeedback(state.error, say)}
        </p>
      ) : null}
      <ChangeCard
        eyebrow={say("chat.planChange.activePlan")}
        title={library.active.name}
        summary={
          library.creation
            ? say("chat.planChange.separateCreation")
            : say("chat.planChange.futureChanges")
        }
      >
        <p aria-live="polite" className="m-0 mb-inset text-sm leading-5 text-ink-2">
          {calendarStatusLabel(library.active.calendar, phrasebook, formatCivilDate)}
        </p>
        <div className="flex flex-wrap gap-inset">
          <Button
            ref={changeButton}
            variant="outline"
            className="border-line bg-surface"
            disabled={paused || state.busy || actions === null}
            aria-describedby={pausedReason}
            onClick={() => actions?.openPlanChangeEditor()}
          >
            {say("chat.planChange.changeOne")}
          </Button>
          <Button
            variant="outline"
            className="border-line bg-surface"
            onClick={() => setActiveView("plan")}
          >
            {say("chat.planChange.openPlan")}
          </Button>
        </div>
      </ChangeCard>
      {state.editorOpen && !paused ? <ChangeEditor /> : null}
      {library.active.todayChoice ? (
        <ChangeCard
          eyebrow={say("chat.planChange.today")}
          title={say("chat.planChange.chooseWorkout")}
        >
          <ul className="m-0 grid list-none p-0">
            {library.active.todayChoice.eligible.map((workout) => (
              <li
                key={workout.workoutId}
                className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] items-start gap-3 border-b border-line py-[calc(var(--row-inset)+1px)] last:border-b-0 max-md:grid-cols-1 max-md:gap-1"
              >
                <span className="text-sm leading-5">
                  {say("chat.planChange.workoutOption", {
                    name: workout.name,
                    minutes: format.number(workout.minutes, { useGrouping: false }),
                  })}
                </span>
                <Button
                  variant="outline"
                  className="justify-self-start border-line bg-surface"
                  disabled={paused || state.busy || actions === null}
                  aria-describedby={pausedReason}
                  onClick={() =>
                    actions?.previewPlanChange({
                      kind: "choose-workout",
                      workoutId: workout.workoutId,
                    })
                  }
                >
                  {say("chat.planChange.reviewWorkout", { name: workout.name })}
                </Button>
              </li>
            ))}
            {library.active.todayChoice.blocked.map((workout) => (
              <li
                key={workout.workoutId}
                className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] items-start gap-3 border-b border-line py-[calc(var(--row-inset)+1px)] last:border-b-0 max-md:grid-cols-1 max-md:gap-1"
              >
                <span className="text-sm leading-5">{workout.name}</span>
                <div className="text-sm leading-5">{workout.reason}</div>
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
          eyebrow={say("chat.planChange.title")}
          title={pending.title}
          status={say("chat.planChange.status.pending")}
          headingRef={previewHeading}
          summary={
            pending.intent.kind === "inverse"
              ? say("chat.planChange.restoreSummary")
              : say("chat.planChange.reviewSummary")
          }
        >
          {pending.details ? (
            <div
              data-plan-change-details
              className="m-0 rounded-ctl bg-surface-2 p-row text-sm leading-5 text-ink"
            >
              <p className="m-0 text-xs leading-4 text-ink-2">{pending.details}</p>
            </div>
          ) : null}
          <Difference change={pending} library={library} showSupportingEvents={false} />
          <div
            role="table"
            className="border-t border-line [&+[role=table]]:border-t-0"
            aria-label={say("chat.planChange.facts")}
          >
            <Fact valueAs="div" label={say("chat.planChange.mainGoal")}>
              {library.active.name}
            </Fact>
            <SupportingEventFacts change={pending} library={library} />
            <Fact valueAs="div" label={say("chat.planChange.confidence")}>
              {pending.confidence}
            </Fact>
          </div>
          <div>
            <Button
              variant="outline"
              className="border-line bg-surface"
              onClick={(event) => openSource(pending, false, event.currentTarget)}
            >
              {say("chat.planChange.viewEvidence")}
            </Button>
          </div>
          <div className="mt-row flex flex-wrap gap-inset">
            <Button
              variant="outline"
              className="border-line bg-surface"
              disabled={state.busy || actions === null}
              onClick={() => actions?.applyPlanChange("cancel")}
            >
              {say("common.cancel")}
            </Button>
            <Button
              disabled={paused || state.busy || actions === null}
              aria-describedby={pausedReason}
              onClick={() => actions?.applyPlanChange("apply")}
            >
              {say("chat.planChange.apply")}
            </Button>
          </div>
        </ChangeCard>
      ) : null}
      {library.changes
        .filter((change) => change.status !== "pending")
        .map((change) => (
          <ChangeCard
            key={change.changeId}
            eyebrow={say("chat.planChange.history")}
            title={change.title}
            status={say(statusLabels[change.status])}
            summary={say("chat.planChange.historySummary")}
          >
            <div className="flex flex-wrap gap-inset">
              <Button
                variant="outline"
                className="border-line bg-surface"
                onClick={(event) => openSource(change, false, event.currentTarget)}
              >
                {say("chat.planChange.historicalEvidence")}
              </Button>
              {change.status === "applied" && change.undo?.eligible ? (
                <Button
                  variant="outline"
                  className="border-line bg-surface"
                  disabled={paused || state.busy || actions === null}
                  aria-describedby={pausedReason}
                  onClick={() =>
                    actions?.previewPlanChange({ kind: "inverse", changeId: change.changeId })
                  }
                >
                  {say("chat.planChange.undo")}
                </Button>
              ) : null}
              <Button
                variant="outline"
                className="border-line bg-surface"
                onClick={(event) => openSource(change, true, event.currentTarget)}
              >
                {say("chat.planChange.readDifference")}
              </Button>
            </div>
          </ChangeCard>
        ))}
      {source ? (
        <ChangeCard
          eyebrow={say("chat.planChange.evidence")}
          title={say("chat.planChange.sourceDetails")}
          headingRef={sourceHeading}
        >
          {source.difference ? (
            <>
              <p className="m-0 text-sm text-ink-2">{say(statusLabels[source.change.status])}</p>
              <Difference change={source.change} library={library} />
            </>
          ) : null}
          <div
            role="table"
            className="border-t border-line [&+[role=table]]:border-t-0"
            aria-label={say("chat.planChange.sourceDetails")}
          >
            {source.change.premises.map((premise) => {
              const value = premiseValue(premise, phrasebook, formatCivilDate);
              return value === null ? null : (
                <Fact
                  valueAs="div"
                  key={premise.id}
                  label={say("chat.planChange.premiseLabel", {
                    label: premise.label,
                    source: premise.source,
                  })}
                >
                  {value}
                </Fact>
              );
            })}
          </div>
          <div className="mt-row flex flex-wrap gap-inset">
            <Button
              variant="outline"
              className="border-line bg-surface"
              onClick={() => {
                setSource(null);
                sourceOpener.current?.focus();
              }}
            >
              {say("common.back")}
            </Button>
          </div>
        </ChangeCard>
      ) : null}
    </section>
  );
}
