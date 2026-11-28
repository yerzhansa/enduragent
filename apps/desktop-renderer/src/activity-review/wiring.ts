import type { PlanCalendarRideDecision } from "@enduragent/coach-contract";
import type { DesktopCoachClientProvider } from "../coach-client";
import { localTodayDateKey } from "../calendar/dates";
import { planChangePendingCheck } from "../state/chat-slice";
import type { EnduragentState, useEnduragentStore } from "../state/store";
import { createActivityReviewController } from "./controller";
import { createFtpController, type FtpPanelState } from "./ftp-controller";
import { createRideReviewController } from "./review-controller";
import { selectedRide } from "./rides";

const POLL_MS = 1_500;

function ftpHistorySignature(panel: Extract<FtpPanelState, { readonly kind: "ready" }>): string {
  const current = panel.read.current;
  return JSON.stringify([
    current === null ? null : [current.watts, current.dateKey, current.source],
    panel.read.history.map((entry) => [entry.watts, entry.dateKey, entry.source]),
  ]);
}

function shownRideId(state: EnduragentState): string | null {
  if (state.activeView !== "activity-review" || state.activityReview.kind !== "ready") return null;
  return (
    selectedRide(state.activityReview.read, state.activityReview.selectedId)?.activityId ?? null
  );
}

function askCoach(store: typeof useEnduragentStore, draft: string): void {
  const state = store.getState();
  if (
    state.planChange.textRouting &&
    !state.planChange.busy &&
    planChangePendingCheck(state.planChange, state.planLibrary.value) === null
  ) {
    state.chatActions?.backFromPlanChangeEditor();
  }
  store.getState().requestComposerPrefill(draft);
  store.getState().setActiveView("chat");
}

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
  const review = createRideReviewController({
    read: async (activityId) =>
      (await clients.getClient()).call("plan.calendar", { action: "read-review", activityId }),
    write: async (request) =>
      (await clients.getClient()).call("plan.calendar", { action: "write-verdict", ...request }),
    saveNote: async (request) =>
      (await clients.getClient()).call("plan.calendar", { action: "save-note", ...request }),
    later: (run) => {
      const timer = setTimeout(run, POLL_MS);
      return () => clearTimeout(timer);
    },
    publish: (next) => store.getState().setRideReview(next),
  });
  let lastFtpHistory: string | null = null;
  const ftp = createFtpController({
    read: async () => (await clients.getClient()).call("plan.calendar", { action: "ftp" }),
    answer: async (request) =>
      (await clients.getClient()).call("plan.calendar", { action: "ftp-answer", ...request }),
    publish: (next) => {
      store.getState().setFtpPanel(next);
      if (next.kind === "ready") {
        const signature = ftpHistorySignature(next);
        const changed = lastFtpHistory !== null && lastFtpHistory !== signature;
        lastFtpHistory = signature;
        if (changed && next.notice !== "written") void controller.refresh();
      }
    },
    written: () => {
      void controller.refresh();
      store.getState().syncActions?.refreshQuietly();
    },
  });
  store.getState().bindFtpActions({
    open: () => ftp.open(),
    close: () => ftp.close(),
    answer: (answer) => void ftp.answer(answer),
    planTest: (request) => {
      ftp.close();
      askCoach(store, request);
    },
  });
  const decide = (decision: PlanCalendarRideDecision): void => {
    void controller.decide(decision).then(() => review.refresh());
  };
  store.getState().bindActivityReviewActions({
    refresh: () => {
      void controller.refresh();
      void review.refresh();
      void ftp.load();
    },
    select: (activityId) => controller.select(activityId),
    change: () => controller.change(),
    otherDay: () => controller.otherDay(),
    closeChoices: () => controller.closeChoices(),
    confirm: (planWorkoutId) => decide({ kind: "confirm", planWorkoutId }),
    extra: () => decide({ kind: "extra" }),
    rematch: (planWorkoutId) => decide({ kind: "rematch", planWorkoutId }),
    showInCalendar: (dateKey) => {
      store.getState().setActiveView("calendar");
      store.getState().calendarActions?.showWeekOf(dateKey);
    },
    writeAgain: () => void review.writeAgain(),
    saveNote: (text) => void review.saveNote(text),
    askCoach: (draft) => askCoach(store, draft),
  });
  let shown: string | null = null;
  const dispose = store.subscribe((state, previous) => {
    if (state.activeView === "activity-review" && previous.activeView !== "activity-review") {
      void controller.open();
      void ftp.load();
    }
    const next = shownRideId(state);
    if (next === shown) return;
    shown = next;
    void review.show(next);
  });
  return () => {
    dispose();
    review.dispose();
    store.getState().bindActivityReviewActions(null);
    store.getState().bindFtpActions(null);
  };
}
