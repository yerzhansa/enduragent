import type { DesktopCoachClientProvider } from "../coach-client";
import { localTodayDateKey } from "../calendar/dates";
import type { useEnduragentStore } from "../state/store";
import { createActivityReviewController } from "./controller";

export function startActivityReview(
  store: typeof useEnduragentStore,
  clients: DesktopCoachClientProvider,
): () => void {
  const controller = createActivityReviewController({
    read: async (range) =>
      (await clients.getClient()).call("plan.calendar", { action: "rides", ...range }),
    decide: async (request) =>
      (await clients.getClient()).call("plan.calendar", { action: "decide-ride", ...request }),
    localTodayDateKey: () => localTodayDateKey(),
    publish: (next) => store.getState().setActivityReview(next),
  });
  store.getState().bindActivityReviewActions({
    refresh: () => void controller.refresh(),
    select: (activityId) => controller.select(activityId),
    change: () => controller.change(),
    otherDay: () => controller.otherDay(),
    closeChoices: () => controller.closeChoices(),
    confirm: (planWorkoutId) => void controller.decide({ kind: "confirm", planWorkoutId }),
    extra: () => void controller.decide({ kind: "extra" }),
    rematch: (planWorkoutId) => void controller.decide({ kind: "rematch", planWorkoutId }),
    showInCalendar: (dateKey) => {
      store.getState().setActiveView("calendar");
      store.getState().calendarActions?.showWeekOf(dateKey);
    },
  });
  const dispose = store.subscribe((state, previous) => {
    if (state.activeView === "activity-review" && previous.activeView !== "activity-review") {
      void controller.open();
    }
  });
  return () => {
    dispose();
    store.getState().bindActivityReviewActions(null);
  };
}
