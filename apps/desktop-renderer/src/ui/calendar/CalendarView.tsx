import { usePhrasebook } from "@enduragent/i18n/react";
import { Button, Page } from "@enduragent/ui";
import { ChevronLeft, ChevronRight, TriangleAlert } from "lucide-react";
import type { ReactElement } from "react";
import { calendarRows, currentWeek, type PlanCalendarRead } from "../../calendar/grid";
import { rendererPlatformProjection } from "../../platform-copy";
import { useEnduragentStore } from "../../state/store";
import { CalendarGrid } from "./CalendarGrid";
import { SeasonStrip } from "./SeasonStrip";
import { useCalendarText } from "./calendar-text";

function useSubtitle(read: PlanCalendarRead | null): string | undefined {
  const { say } = usePhrasebook();
  const text = useCalendarText();
  if (read === null) return undefined;
  const plan = read.plan;
  if (plan === null) return say("plan.calendar.subtitle.noPlan");
  if (read.todayDateKey < plan.startDateKey) {
    return say("plan.calendar.subtitle.starts", {
      name: plan.name,
      date: text.weekdayDayMonth(plan.startDateKey),
    });
  }
  const week = currentWeek(read);
  if (week === null) return say("plan.calendar.subtitle.ended", { name: plan.name });
  return plan.phase === null
    ? say("plan.calendar.subtitle.week", {
        name: plan.name,
        week: week.index,
        total: plan.totalWeeks,
      })
    : say("plan.calendar.subtitle.weekPhase", {
        name: plan.name,
        week: week.index,
        total: plan.totalWeeks,
        phase: plan.phase,
      });
}

function NoPlanCard(): ReactElement {
  const { say } = usePhrasebook();
  const setActiveView = useEnduragentStore((state) => state.setActiveView);
  return (
    <section className="flex flex-wrap items-center justify-between gap-4 rounded-card border border-line bg-surface px-5 py-4.5">
      <div className="flex max-w-xl flex-col gap-1">
        <h2 className="m-0 text-sm font-semibold text-ink">{say("plan.calendar.noPlan.title")}</h2>
        <p className="m-0 text-sm text-ink-2">{say("plan.calendar.noPlan.body")}</p>
      </div>
      <Button type="button" onClick={() => setActiveView("chat")}>
        {say("plan.calendar.noPlan.start")}
      </Button>
    </section>
  );
}

function RefreshFailed(props: { readonly onRetry: () => void }): ReactElement {
  const { say } = usePhrasebook();
  return (
    <div
      className="flex flex-wrap items-center gap-2.5 rounded-card border border-warn bg-warn/10 px-3.5 py-2.5 text-sm"
      role="status"
    >
      <TriangleAlert className="size-4 text-warn" aria-hidden="true" />
      <span>{say("plan.calendar.refreshFailed")}</span>
      <Button type="button" variant="outline" size="sm" onClick={props.onRetry}>
        {say("plan.calendar.retry")}
      </Button>
    </div>
  );
}

export function CalendarView(): ReactElement {
  const { say } = usePhrasebook();
  const state = useEnduragentStore((store) => store.calendar);
  const actions = useEnduragentStore((store) => store.calendarActions);
  const read = state.kind === "ready" ? state.read : null;
  const subtitle = useSubtitle(read);
  const firstDay = rendererPlatformProjection().firstDayOfWeek;
  const navigation = (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label={say("plan.calendar.previous")}
        onClick={() => actions?.previous()}
      >
        <ChevronLeft aria-hidden="true" />
      </Button>
      <Button type="button" variant="outline" onClick={() => actions?.today()}>
        {say("plan.calendar.today")}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label={say("plan.calendar.next")}
        onClick={() => actions?.next()}
      >
        <ChevronRight aria-hidden="true" />
      </Button>
    </div>
  );
  return (
    <Page
      title={say("sidebar.views.calendar")}
      {...(subtitle === undefined ? {} : { subtitle })}
      busy={state.kind === "loading" || (state.kind === "ready" && state.refresh === "refreshing")}
      action={navigation}
      className="calendar-view"
      contentMode="workspace"
    >
      <div className="h-full min-h-0 overflow-auto px-5 pt-3.5 pb-6" data-page-scroll="">
        {state.kind === "unavailable" ? (
          <section className="flex flex-col items-start gap-3 py-6" role="alert">
            <p className="m-0 text-sm text-ink-2">{say("plan.calendar.unavailable")}</p>
            <Button type="button" variant="outline" onClick={() => actions?.refresh()}>
              {say("plan.calendar.retry")}
            </Button>
          </section>
        ) : null}
        {state.kind === "ready" ? (
          <div className="flex min-w-0 flex-col gap-3" data-calendar-state="ready">
            {state.refresh === "failed" ? (
              <RefreshFailed onRetry={() => actions?.refresh()} />
            ) : null}
            {state.read.plan === null ? (
              <NoPlanCard />
            ) : (
              <SeasonStrip
                plan={state.read.plan}
                onWeek={(dateKey) => actions?.showWeekOf(dateKey)}
              />
            )}
            <CalendarGrid
              read={state.read}
              rows={calendarRows(state.read, state.range)}
              firstDay={firstDay}
            />
          </div>
        ) : null}
      </div>
    </Page>
  );
}
