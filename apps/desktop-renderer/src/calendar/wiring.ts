import type { DesktopCoachClientProvider } from "../coach-client";
import { rendererPlatformProjection } from "../platform-copy";
import type { useEnduragentStore } from "../state/store";
import { opensCalendarAfterActivate } from "./approval";
import { createApproveController } from "./approve-controller";
import { createChangeController } from "./change-controller";
import { createDetailsController, detailsEnding } from "./details-controller";
import { createMoveController } from "./move-controller";
import { createCalendarController } from "./controller";
import { createCalendarSettingsController } from "./settings-controller";

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
    publish: (next) => {
      store.getState().setCalendar(next);
      if (next.kind === "ready") approve.observe(next.read, next.refresh);
    },
  });
  const approve = createApproveController({
    approve: async ({ planId, scope, ticked }) =>
      (await clients.getClient()).call("plan.calendar", {
        action: "approve-weeks",
        planId,
        scope,
        ticked: [...ticked],
      }),
    sendAgain: async () =>
      (await clients.getClient()).call("plan.calendar", { action: "send-again" }),
    libraryChanged: () => void store.getState().planLibraryActions?.refresh(),
    refresh: () => void controller.refresh(),
    later: (run) => {
      const timer = setTimeout(run, 1_500);
      return () => clearTimeout(timer);
    },
    publish: (next) => store.getState().setCalendarApproval(next),
  });
  const settings = createCalendarSettingsController({
    readSettings: async () =>
      (await clients.getClient()).call("plan.calendar", { action: "read-settings" }),
    saveSettings: async (weekDelivery) =>
      (await clients.getClient()).call("plan.calendar", { action: "save-settings", weekDelivery }),
    readStartAtLogin: () => window.enduragentAuth.readStartAtLogin(),
    setStartAtLogin: (enabled) => window.enduragentAuth.setStartAtLogin(enabled),
    publish: (next) => store.getState().setCalendarSettings(next),
  });
  store.getState().bindCalendarApproveActions({
    open: (scope) => approve.open(scope),
    setRemoveChanges: (remove) => approve.setRemoveChanges(remove),
    approve: () => void approve.approve(),
    notNow: () => approve.notNow(),
    retry: () => void approve.retry(),
    connect: () => store.getState().setActiveView("settings"),
  });
  const change = createChangeController({
    call: async (request) => (await clients.getClient()).call("plan.calendar", request),
    refresh: () => void controller.refresh(),
    planChanged: () => void store.getState().planLibraryActions?.refresh(),
    publish: (next) => store.getState().setCalendarChange(next),
  });
  store.getState().bindCalendarChangeActions({
    open: (planId, planWorkoutId) => void change.open(planId, planWorkoutId),
    keep: () => void change.keep(),
    putBack: () => void change.putBack(),
    close: () => change.close(),
  });
  const move = createMoveController({
    call: async (request) => (await clients.getClient()).call("plan.calendar", request),
    refresh: () => void controller.refresh(),
    publish: (next) => store.getState().setCalendarMove(next),
  });
  store.getState().bindCalendarMoveActions({
    request: (planId, workoutId, toDateKey, swap) =>
      move.request(planId, workoutId, toDateKey, swap),
    setSwap: (swap) => move.setSwap(swap),
    confirm: (canSwap) => void move.confirm(canSwap),
    cancel: () => move.cancel(),
  });
  const details = createDetailsController({
    call: async (request) => (await clients.getClient()).call("plan.calendar", request),
    closePlan: async (request) => (await clients.getClient()).call("plan.close", request),
    newCommandId: () => globalThis.crypto.randomUUID(),
    ended: () => {
      void controller.refresh();
      void store.getState().planLibraryActions?.refresh();
    },
    publish: (next) => store.getState().setCalendarDetails(next),
  });
  store.getState().bindCalendarDetailsActions({
    open: (planId) => void details.open(planId),
    close: () => details.close(),
    startEnd: () => details.startEnd(),
    setRemoveChanges: (remove) => details.setRemoveChanges(remove),
    cancelEnd: () => details.cancelEnd(),
    confirmEnd: () => void details.confirmEnd(),
    replace: () => {
      if (detailsEnding(store.getState().calendarDetails)) return;
      details.close();
      store.getState().setActiveView("chat");
      store.getState().chatActions?.startPlanCreation();
    },
  });
  store.getState().bindCalendarSettingsActions({
    load: () => void settings.load(),
    setWeekDelivery: (value) => void settings.setWeekDelivery(value),
    setStartAtLogin: (enabled) => void settings.setStartAtLogin(enabled),
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
      approve.pageOpened();
      void controller.open();
    }
    const before = previousState.planLibrary.value;
    const activated = state.planLibrary.value?.active;
    if (
      before !== null &&
      activated != null &&
      opensCalendarAfterActivate(before.active, activated) &&
      state.activeView === "chat"
    ) {
      queueMicrotask(() => {
        if (store.getState().activeView === "chat") store.getState().setActiveView("calendar");
      });
    }
  });
  return () => {
    dispose();
    approve.dispose();
    store.getState().bindCalendarActions(null);
    store.getState().bindCalendarApproveActions(null);
    store.getState().bindCalendarSettingsActions(null);
    store.getState().bindCalendarChangeActions(null);
    store.getState().bindCalendarMoveActions(null);
    store.getState().bindCalendarDetailsActions(null);
  };
}
