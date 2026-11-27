import { startActivityReview } from "../activity-review/wiring";
import type { DesktopCoachClientProvider } from "../coach-client";
import type { useEnduragentStore } from "../state/store";
import { startCalendar } from "./wiring";

export function startCalendarPages(
  store: typeof useEnduragentStore,
  clients: DesktopCoachClientProvider,
): () => void {
  const disposeCalendar = startCalendar(store, clients);
  const disposeReview = startActivityReview(store, clients);
  return () => {
    disposeReview();
    disposeCalendar();
  };
}

export function refreshOpenCalendarPage(store: typeof useEnduragentStore): void {
  const state = store.getState();
  if (state.activeView === "calendar") state.calendarActions?.refresh();
  if (state.activeView === "activity-review") state.activityReviewActions?.refresh();
}
