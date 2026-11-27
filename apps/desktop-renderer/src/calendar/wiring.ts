import type { DesktopCoachClientProvider } from "../coach-client";
import { rendererPlatformProjection } from "../platform-copy";
import type { useEnduragentStore } from "../state/store";
import { createCalendarController } from "./controller";

function localTodayDateKey(): number {
  const now = new Date();
  return now.getFullYear() * 10_000 + (now.getMonth() + 1) * 100 + now.getDate();
}

export function startCalendar(
  store: typeof useEnduragentStore,
  clients: DesktopCoachClientProvider,
): () => void {
  const controller = createCalendarController({
    read: async (range) =>
      (await clients.getClient()).call("plan.calendar", { action: "read", ...range }),
    firstDayOfWeek: () => rendererPlatformProjection().firstDayOfWeek,
    localTodayDateKey,
    publish: (next) => store.getState().setCalendar(next),
  });
  store.getState().bindCalendarActions({
    refresh: () => void controller.refresh(),
    previous: () => void controller.previous(),
    next: () => void controller.next(),
    today: () => void controller.today(),
    showWeekOf: (dateKey) => void controller.showWeekOf(dateKey),
  });
  const dispose = store.subscribe((state, previousState) => {
    if (state.activeView === "calendar" && previousState.activeView !== "calendar") {
      void controller.open();
    }
  });
  return () => {
    dispose();
    store.getState().bindCalendarActions(null);
  };
}
