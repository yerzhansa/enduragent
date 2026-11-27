import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopCoachClientProvider } from "../src/coach-client";
import { startCalendar } from "../src/calendar/wiring";
import type { ChatActions } from "../src/state/chat-slice";
import type { PlanLibraryActions } from "../src/state/plan-slice";
import { useEnduragentStore } from "../src/state/store";
import { PLAN_ID, workoutId } from "./calendar-fixture";

const DRAFT = "Please change Long endurance on Wed 14 Jan:";

const clients: DesktopCoachClientProvider = {
  getClient: () => Promise.reject(new Error("no coach in this test")),
  reconnect: () => Promise.reject(new Error("no coach in this test")),
  onConnectionOpen: () => () => undefined,
  close: () => Promise.resolve(),
};

function start(typed: string) {
  const composer = document.createElement("textarea");
  composer.id = "message";
  composer.value = typed;
  document.body.append(composer);
  const saveAttachmentDraftText = vi.fn();
  const changeInChat = vi.fn();
  useEnduragentStore.setState({
    chatActions: { saveAttachmentDraftText } as Partial<ChatActions> as ChatActions,
    planLibraryActions: { changeInChat } as Partial<PlanLibraryActions> as PlanLibraryActions,
  });
  const dispose = startCalendar(useEnduragentStore, clients);
  return { dispose, saveAttachmentDraftText, changeInChat };
}

afterEach(() => {
  document.querySelector("#message")?.remove();
  useEnduragentStore.setState({ chatActions: null, planLibraryActions: null });
});

describe("asking the coach from a workout card", () => {
  it("fills an empty composer and opens Change in Chat", () => {
    const test = start("");
    useEnduragentStore.getState().calendarWorkoutActions?.open(PLAN_ID, workoutId(1));
    useEnduragentStore.getState().calendarWorkoutActions?.askCoach(DRAFT);
    expect(test.saveAttachmentDraftText).toHaveBeenCalledWith(DRAFT);
    expect(test.changeInChat).toHaveBeenCalledOnce();
    test.dispose();
  });

  it("keeps what the athlete is typing even before it is saved", () => {
    const test = start("About Saturday");
    useEnduragentStore.getState().calendarWorkoutActions?.open(PLAN_ID, workoutId(1));
    useEnduragentStore.getState().calendarWorkoutActions?.askCoach(DRAFT);
    expect(test.saveAttachmentDraftText).not.toHaveBeenCalled();
    expect(test.changeInChat).toHaveBeenCalledOnce();
    test.dispose();
  });
});
