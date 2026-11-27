import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopCoachClientProvider } from "../src/coach-client";
import { startCalendar } from "../src/calendar/wiring";
import type { ChatActions } from "../src/state/chat-slice";
import type { PlanLibraryActions } from "../src/state/plan-slice";
import { useEnduragentStore } from "../src/state/store";
import { PLAN_ID, workoutId } from "./calendar-fixture";

const DRAFT = "Please change “Long endurance” on Wed 14 Jan:";

const clients: DesktopCoachClientProvider = {
  getClient: () => Promise.reject(new Error("no coach in this test")),
  reconnect: () => Promise.reject(new Error("no coach in this test")),
  onConnectionOpen: () => () => undefined,
  close: () => Promise.resolve(),
};

function start() {
  const saveAttachmentDraftText = vi.fn();
  const submit = vi.fn();
  const changeInChat = vi.fn();
  useEnduragentStore.setState({
    chatActions: { saveAttachmentDraftText, submit } as Partial<ChatActions> as ChatActions,
    planLibraryActions: { changeInChat } as Partial<PlanLibraryActions> as PlanLibraryActions,
  });
  const dispose = startCalendar(useEnduragentStore, clients);
  return { dispose, saveAttachmentDraftText, submit, changeInChat };
}

afterEach(() => {
  useEnduragentStore.setState({
    chatActions: null,
    planLibraryActions: null,
    composerPrefill: null,
  });
});

describe("asking the coach from a workout card", () => {
  it("asks Chat to put the question in the composer and opens Change in Chat, sending nothing", () => {
    const test = start();
    useEnduragentStore.getState().calendarWorkoutActions?.open(PLAN_ID, workoutId(1));
    useEnduragentStore.getState().calendarWorkoutActions?.askCoach(DRAFT);
    expect(useEnduragentStore.getState().composerPrefill).toMatchObject({ text: DRAFT });
    expect(test.changeInChat).toHaveBeenCalledOnce();
    expect(test.saveAttachmentDraftText).not.toHaveBeenCalled();
    expect(test.submit).not.toHaveBeenCalled();
    test.dispose();
  });

  it("asks nothing when no workout card is open", () => {
    const test = start();
    useEnduragentStore.getState().calendarWorkoutActions?.askCoach(DRAFT);
    expect(useEnduragentStore.getState().composerPrefill).toBeNull();
    expect(test.changeInChat).not.toHaveBeenCalled();
    test.dispose();
  });
});
