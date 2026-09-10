import { renderLocalized as render } from "./language-harness";
import type { PlanHistoryResult } from "@enduragent/coach-contract";
import { act, fireEvent, screen } from "@testing-library/react";
import { PlanView } from "../src/ui/plan/PlanView";
import { EMPTY_CHAT_SURFACE } from "../src/state/chat-slice";
import { EMPTY_PLAN_SURFACE } from "../src/state/plan-slice";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  requestPlanCalendarRetry,
  subscribePlanFinalDetailsRefresh,
} from "../src/plan/library-refresh";
import { useEnduragentStore } from "../src/state/store";
import { planCreationDraft } from "./plan-creation-draft-fixtures";

function history(
  calendar: NonNullable<PlanHistoryResult>["plan"]["calendar"],
): NonNullable<PlanHistoryResult> {
  const draft = planCreationDraft();
  return {
    plan: {
      planId: "closed-plan",
      version: 2,
      name: "Build steady power",
      start: draft.start,
      end: draft.end,
      weeks: draft.weeks.length,
      status: "closed",
      closeReason: "stopped",
      closedAt: "1998-09-14",
      activatedAt: "1998-09-07",
      calendar,
      creationId: "creation-closed",
    },
    closeActor: "fictional-device",
    revision: { revisionNumber: 1, fingerprint: draft.outputFingerprint, snapshot: draft },
    cleanup: calendar.status === "verified" ? "complete" : "pending",
  };
}

const pending = history({ status: "pending", window: null, currentThrough: null, error: null });
const running = history({ status: "running", window: null, currentThrough: null, error: null });
const failed = history({
  status: "failed",
  window: null,
  currentThrough: null,
  error: "Calendar cleanup failed. Retry available.",
});
const complete = history({
  status: "verified",
  window: null,
  currentThrough: "1998-09-13",
  error: null,
});

describe("closed Plan history refresh", () => {
  let unsubscribe = (): void => {};
  beforeEach(() => {
    vi.useFakeTimers();
    useEnduragentStore.setState({ activeView: "plan" });
  });
  afterEach(() => {
    unsubscribe();
    vi.useRealTimers();
  });

  it("reads the selected closed Plan every four seconds through cleanup completion", async () => {
    const readHistory = vi.fn().mockResolvedValueOnce(running).mockResolvedValueOnce(complete);
    const onHistory = vi.fn();
    unsubscribe = subscribePlanFinalDetailsRefresh({ history: pending, readHistory, onHistory });
    await vi.advanceTimersByTimeAsync(3_999);
    expect(readHistory).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(readHistory).toHaveBeenCalledExactlyOnceWith("closed-plan");
    expect(onHistory).toHaveBeenLastCalledWith(running);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(onHistory).toHaveBeenLastCalledWith(complete);
    await vi.advanceTimersByTimeAsync(80_000);
    expect(readHistory).toHaveBeenCalledTimes(2);
  });

  it("caps retryable cleanup at twenty reads and restarts only for that Plan's retry", async () => {
    const readHistory = vi.fn().mockResolvedValue(failed);
    unsubscribe = subscribePlanFinalDetailsRefresh({
      history: failed,
      readHistory,
      onHistory: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(100_000);
    expect(readHistory).toHaveBeenCalledTimes(20);
    requestPlanCalendarRetry("another-plan");
    await vi.advanceTimersByTimeAsync(4_000);
    expect(readHistory).toHaveBeenCalledTimes(20);
    requestPlanCalendarRetry("closed-plan");
    await vi.advanceTimersByTimeAsync(4_000);
    expect(readHistory).toHaveBeenCalledTimes(21);
  });

  it("keeps the last snapshot when a history read fails and retries on schedule", async () => {
    const readHistory = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(complete);
    const onHistory = vi.fn();
    unsubscribe = subscribePlanFinalDetailsRefresh({ history: pending, readHistory, onHistory });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(onHistory).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(onHistory).toHaveBeenCalledExactlyOnceWith(complete);
  });

  it.each(["leave", "unsubscribe"])("ignores a late read after %s", async (action) => {
    let resolveRead: (value: PlanHistoryResult) => void = () => {};
    const readHistory = vi.fn(
      () =>
        new Promise<PlanHistoryResult>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const onHistory = vi.fn();
    unsubscribe = subscribePlanFinalDetailsRefresh({ history: pending, readHistory, onHistory });
    await vi.advanceTimersByTimeAsync(4_000);
    if (action === "leave") useEnduragentStore.setState({ activeView: "chat" });
    else unsubscribe();
    resolveRead(complete);
    await vi.advanceTimersByTimeAsync(80_000);
    expect(onHistory).not.toHaveBeenCalled();
    expect(readHistory).toHaveBeenCalledOnce();
  });

  it("retries cleanup from final details, refreshes the library, and renders fresh history", async () => {
    const readPlanHistory = vi.fn().mockResolvedValue(failed);
    const refresh = vi.fn(async () => {
      readPlanHistory.mockResolvedValue(complete);
    });
    useEnduragentStore.setState({
      chat: EMPTY_CHAT_SURFACE,
      chatActions: null,
      plan: EMPTY_PLAN_SURFACE,
      planActions: null,
      planningReadActions: null,
      planLibrary: {
        status: "ready",
        value: {
          calendarConnected: true,
          legacy: null,
          creation: null,
          active: null,
          closed: [{ ...failed.plan, status: "closed" }],
          pendingChangeCheck: null,
          changesPaused: null,
          changes: [],
        },
      },
      planLibraryActions: {
        refresh,
        readPlanHistory,
        closePlan: vi.fn(),
        startCreation: vi.fn(),
        continueCreation: vi.fn(),
        changeInChat: vi.fn(),
      },
    });
    const view = render(<PlanView />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Read final details" }));
    });
    expect(screen.getByRole("row", { name: /^Calendar/ })).toHaveTextContent(
      "Calendar cleanup failed. Retry available.",
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry calendar" }));
    });
    expect(refresh).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(readPlanHistory).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("row", { name: /^Calendar/ })).toHaveTextContent("Cleanup complete");
    expect(screen.queryByRole("button", { name: "Retry calendar" })).not.toBeInTheDocument();
    view.unmount();
    await vi.advanceTimersByTimeAsync(80_000);
    expect(readPlanHistory).toHaveBeenCalledTimes(2);
  });

  it("does not poll a terminal cleanup failure", async () => {
    const terminal = history({
      status: "failed",
      window: null,
      currentThrough: null,
      error: "Calendar cleanup failed.",
    });
    const readHistory = vi.fn();
    unsubscribe = subscribePlanFinalDetailsRefresh({
      history: terminal,
      readHistory,
      onHistory: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(80_000);
    expect(readHistory).not.toHaveBeenCalled();
  });
});
