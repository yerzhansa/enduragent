import type { CoachClient } from "@enduragent/coach-client";
import type {
  ListPlansResult,
  PlanChangeModel,
  PlanChangeIntent,
} from "@enduragent/coach-contract";
import { describe, expect, it, vi } from "vitest";
import { createChatController } from "../src/chat/controller";
import {
  EMPTY_PLAN_CHANGE_SURFACE,
  PLAN_CHANGES_PAUSED_NOTICE,
  type PlanChangeSurfaceState,
} from "../src/state/chat-slice";

const change: PlanChangeModel = {
  changeId: "change-preview",
  planId: "plan-active",
  baseRevisionNumber: 1,
  status: "pending",
  title: "Limit weekday duration",
  intent: { kind: "weekday-duration", day: 2, minutes: 45 },
  diff: [],
  totals: {
    before: { plan: 120, weeks: [{ number: 1, minutes: 120 }] },
    after: { plan: 90, weeks: [{ number: 1, minutes: 90 }] },
  },
  supersedes: null,
  supersededBy: null,
  resultRevisionNumber: null,
  undo: null,
  confidence: "High",
  premises: [],
};

function harness(result: unknown, changes: PlanChangeModel[] = [change]) {
  let surface: PlanChangeSurfaceState = EMPTY_PLAN_CHANGE_SURFACE;
  let library: ListPlansResult = {
    calendarConnected: false,
    legacy: null,
    active: {
      planId: "plan-active",
      version: 7,
      name: "Build fitness",
      start: "1998-09-07",
      end: "1998-10-04",
      weeks: 4,
      status: "active",
      closeReason: null,
      closedAt: null,
      activatedAt: "1998-09-07",
      calendar: { status: "pending", window: null, currentThrough: null, error: null },
      creationId: null,
    },
    creation: null,
    closed: [],
    changesPaused: null,
    changes,
  };
  const call = vi.fn(async (_method: string, _request: unknown): Promise<never> => {
    if (result instanceof Error) throw result;
    return result as never;
  });
  const client: CoachClient = {
    handshake: {} as CoachClient["handshake"],
    call,
    close: vi.fn(async () => {}),
  };
  const refresh = vi.fn(async () => {});
  const controller = createChatController({
    clients: {
      getClient: async () => client,
      reconnect: async () => client,
      close: async () => {},
    },
    view: { render: vi.fn() },
    refreshTrainingContext: async () => {},
    refreshSpend: async () => {},
    readPlanLibrary: () => library,
    readPlanChange: () => surface,
    publishPlanChange: (next) => {
      surface = next;
    },
    refreshPlanLibrary: refresh,
  });
  return {
    controller,
    call,
    refresh,
    surface: () => surface,
    pause() {
      library = {
        ...library,
        changesPaused: { reason: "sync-stale", lastSuccessfulSyncAtMs: 900000000000 },
      };
    },
    updateVersion(version: number) {
      if (library.active) library = { ...library, active: { ...library.active, version } };
    },
  };
}

describe("Plan Change controller", () => {
  it.each(["preview", "apply"] as const)(
    "shows the pause notice without an alert after a sync-stale %s rejection",
    async (action) => {
      const h = harness({ status: "rejected", reason: "sync-stale" });
      h.controller.openPlanChangeEditor();
      if (action === "preview") await h.controller.previewPlanChange(change.intent);
      else await h.controller.applyPlanChange("apply");
      expect(h.surface()).toMatchObject({
        editorOpen: false,
        busy: false,
        error: null,
        notice: PLAN_CHANGES_PAUSED_NOTICE,
      });
      expect(h.refresh).toHaveBeenCalledOnce();
      expect(h.call).toHaveBeenCalledOnce();
    },
  );

  it.each(["preview", "apply"] as const)(
    "keeps the sync-stale %s notice when refresh fails",
    async (action) => {
      const h = harness({ status: "rejected", reason: "sync-stale" });
      h.refresh.mockRejectedValue(new Error("unavailable"));
      if (action === "preview") await h.controller.previewPlanChange(change.intent);
      else await h.controller.applyPlanChange("apply");
      expect(h.surface()).toMatchObject({
        error: null,
        notice: PLAN_CHANGES_PAUSED_NOTICE,
        busy: false,
      });
      expect(h.refresh).toHaveBeenCalledOnce();
    },
  );

  it("blocks preview and apply from the library flag but permits Cancel", async () => {
    const h = harness({ status: "cancelled", changeId: change.changeId, version: 8 });
    h.pause();
    h.controller.openPlanChangeEditor();
    expect(h.surface().editorOpen).toBe(false);
    await h.controller.previewPlanChange(change.intent);
    await h.controller.previewPlanChange({ kind: "inverse", changeId: "applied-change" });
    await h.controller.applyPlanChange("apply");
    expect(h.call).not.toHaveBeenCalled();
    await h.controller.applyPlanChange("cancel");
    expect(h.call).toHaveBeenCalledWith(
      "plan_change.apply",
      expect.objectContaining({ decision: "cancel" }),
    );
  });

  it("opens and backs out of the editor with explicit focus requests", () => {
    const h = harness(null);
    h.controller.openPlanChangeEditor();
    expect(h.surface()).toMatchObject({
      open: true,
      planId: "plan-active",
      editorOpen: true,
      focusRequest: { target: "editor", revision: 1 },
    });
    h.controller.backFromPlanChangeEditor();
    expect(h.surface()).toMatchObject({
      editorOpen: false,
      focusRequest: { target: "change", revision: 2 },
    });
  });

  it("previews with the summary version, refreshes, and focuses the preview", async () => {
    const h = harness({ status: "previewed", change, version: 8 }, []);
    h.controller.openPlanChangeEditor();
    await h.controller.previewPlanChange(change.intent);
    expect(h.call).toHaveBeenCalledWith("plan_change.preview", {
      planId: "plan-active",
      expectedVersion: 7,
      intent: change.intent,
      commandId: expect.any(String),
    });
    expect(h.refresh).toHaveBeenCalledOnce();
    expect(h.surface()).toMatchObject({
      editorOpen: false,
      busy: false,
      error: null,
      notice: "Review the exact changes before confirming.",
      focusRequest: { target: "preview" },
    });
  });

  it("previews an inverse with one command per attempt and ignores duplicate actions while busy", async () => {
    const intent: PlanChangeIntent = { kind: "inverse", changeId: "00000000000000000000000140" };
    const h = harness({ status: "previewed", change: { ...change, intent }, version: 8 }, []);
    const attempt = h.controller.previewPlanChange(intent);
    expect(h.surface().busy).toBe(true);
    await h.controller.previewPlanChange(intent);
    await attempt;
    expect(h.call).toHaveBeenCalledExactlyOnceWith("plan_change.preview", {
      planId: "plan-active",
      expectedVersion: 7,
      intent,
      commandId: expect.any(String),
    });
    expect(h.surface()).toMatchObject({
      busy: false,
      editorOpen: false,
      focusRequest: { target: "preview" },
    });
    await h.controller.previewPlanChange(intent);
    expect(h.call.mock.calls[1]?.[1]).not.toEqual(h.call.mock.calls[0]?.[1]);
  });

  it.each([false, true])(
    "announces inverse ineligibility and rereads the library even when refresh fails: %s",
    async (refreshFails) => {
      const h = harness({ status: "rejected", reason: "invalid-intent" });
      if (refreshFails) h.refresh.mockRejectedValue(new Error("unavailable"));
      await h.controller.previewPlanChange({
        kind: "inverse",
        changeId: "00000000000000000000000140",
      });
      expect(h.surface()).toMatchObject({
        busy: false,
        error: null,
        notice: "The latest Change is no longer eligible for Undo.",
      });
      expect(h.refresh).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    "keeps the editor open after a race-window refusal even when refresh fails: %s",
    async (refreshFails) => {
      const h = harness({
        status: "rejected",
        reason: "race-window",
        window: { start: "1998-09-07", end: "1998-09-13" },
      });
      if (refreshFails) h.refresh.mockRejectedValue(new Error("unavailable"));
      h.controller.openPlanChangeEditor();
      await h.controller.previewPlanChange(change.intent);
      expect(h.surface()).toMatchObject({
        editorOpen: true,
        busy: false,
        error: null,
        notice:
          "Only training reductions are allowed during this race window. Training is unchanged.",
      });
      expect(h.refresh).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    "preserves the pending Change after a race-window apply refusal even when refresh fails: %s",
    async (refreshFails) => {
      const h = harness({ status: "rejected", reason: "race-window" });
      if (refreshFails) h.refresh.mockRejectedValue(new Error("unavailable"));
      await h.controller.applyPlanChange("apply");
      expect(h.surface()).toMatchObject({
        busy: false,
        error: null,
        notice:
          "Only training reductions are allowed in the current race window. This Change was not applied.",
      });
      expect(h.refresh).toHaveBeenCalledOnce();
      await h.controller.applyPlanChange("apply");
      expect(h.call).toHaveBeenCalledTimes(2);
      expect(h.call.mock.calls[1]?.[1]).toMatchObject({ changeId: change.changeId });
      expect(h.call.mock.calls[1]?.[1]).not.toEqual(h.call.mock.calls[0]?.[1]);
    },
  );

  it("replays an inverse command after a lost response", async () => {
    const h = harness(new Error("lost response"));
    const intent: PlanChangeIntent = { kind: "inverse", changeId: "00000000000000000000000140" };
    await h.controller.previewPlanChange(intent);
    await h.controller.previewPlanChange(intent);
    expect(h.call).toHaveBeenCalledTimes(2);
    expect(h.call.mock.calls[1]).toEqual(h.call.mock.calls[0]);
  });

  it("names the superseded preview", async () => {
    const h = harness({
      status: "previewed",
      change: { ...change, changeId: "new-change", supersedes: change.changeId },
      version: 8,
    });
    await h.controller.previewPlanChange(change.intent);
    expect(h.surface().notice).toBe(
      "This preview supersedes “Limit weekday duration”. Training is unchanged until confirmation.",
    );
  });

  it.each([
    [
      "stale-version",
      change.intent,
      "This request used an older Plan revision. Request a fresh preview.",
    ],
    [
      "invalid-intent",
      { kind: "weekday-duration", day: 2, minutes: 45 },
      "Enter a duration above zero.",
    ],
    [
      "invalid-intent",
      { kind: "weekly-duration", hours: 6 },
      "Enter a weekly duration above zero.",
    ],
    ["invalid-intent", { kind: "weekday-unavailable", day: 2 }, "Choose the weekday to change."],
  ] satisfies [string, PlanChangeIntent, string][])(
    "shows %s preview rejection for %j",
    async (reason, intent, error) => {
      const h = harness({ status: "rejected", reason });
      h.controller.openPlanChangeEditor();
      await h.controller.previewPlanChange(intent);
      expect(h.surface()).toMatchObject({ editorOpen: true, busy: false, error });
      expect(h.refresh).toHaveBeenCalledTimes(reason === "stale-version" ? 1 : 0);
    },
  );

  it.each([
    [
      "apply",
      { status: "applied", changeId: change.changeId, revisionNumber: 2, version: 8 },
      "Change applied locally. Training now matches the confirmed preview.",
    ],
    [
      "cancel",
      { status: "cancelled", changeId: change.changeId, version: 8 },
      "Change cancelled. Training is unchanged; the preview remains in history.",
    ],
  ] as const)("sends %s and refreshes both Plan projections", async (decision, result, notice) => {
    const h = harness(result);
    await h.controller.applyPlanChange(decision);
    expect(h.call).toHaveBeenCalledWith("plan_change.apply", {
      planId: "plan-active",
      changeId: change.changeId,
      expectedVersion: 7,
      decision,
      commandId: expect.any(String),
    });
    expect(h.refresh).toHaveBeenCalledOnce();
    expect(h.surface()).toMatchObject({ busy: false, notice, focusRequest: { target: "change" } });
  });

  it.each([
    [
      "stale-version",
      "This preview is stale because the Plan or its sources changed. Request a fresh preview; no training changed.",
    ],
    ["not-pending", "This preview is no longer pending. Training is unchanged."],
    [
      "command-conflict",
      "This Change could not be applied. Training and the pending preview are unchanged.",
    ],
    [
      "no-active-plan",
      "This Change could not be applied. Training and the pending preview are unchanged.",
    ],
  ])("shows %s apply rejection", async (reason, notice) => {
    const h = harness({ status: "rejected", reason });
    await h.controller.applyPlanChange("apply");
    expect(h.surface()).toMatchObject({ busy: false, notice });
    expect(h.refresh).toHaveBeenCalledTimes(
      reason === "stale-version" || reason === "not-pending" ? 1 : 0,
    );
  });

  it.each(["stale-version", "not-pending"])(
    "refreshes after %s apply so the next preview uses the new version",
    async (reason) => {
      const h = harness({ status: "rejected", reason });
      h.refresh.mockImplementation(async () => h.updateVersion(8));
      await h.controller.applyPlanChange("apply");
      expect(h.refresh).toHaveBeenCalledOnce();
      h.controller.openPlanChangeEditor();
      await h.controller.previewPlanChange(change.intent);
      expect(h.call).toHaveBeenNthCalledWith(2, "plan_change.preview", {
        planId: "plan-active",
        expectedVersion: 8,
        intent: change.intent,
        commandId: expect.any(String),
      });
    },
  );

  it("refreshes a stale preview before another preview", async () => {
    const h = harness({ status: "rejected", reason: "stale-version" });
    h.refresh.mockImplementation(async () => h.updateVersion(8));
    await h.controller.previewPlanChange(change.intent);
    expect(h.refresh).toHaveBeenCalledOnce();
    await h.controller.previewPlanChange(change.intent);
    expect(h.call).toHaveBeenNthCalledWith(2, "plan_change.preview", {
      planId: "plan-active",
      expectedVersion: 8,
      intent: change.intent,
      commandId: expect.any(String),
    });
  });

  it.each(["apply", "preview"] as const)(
    "preserves stale %s copy if the library refresh fails",
    async (action) => {
      const h = harness({ status: "rejected", reason: "stale-version" });
      h.refresh.mockRejectedValue(new Error("unavailable"));
      if (action === "apply") await h.controller.applyPlanChange("apply");
      else await h.controller.previewPlanChange(change.intent);
      expect(h.refresh).toHaveBeenCalledOnce();
      expect(h.surface().busy).toBe(false);
      expect(action === "apply" ? h.surface().notice : h.surface().error).toBe(
        action === "apply"
          ? "This preview is stale because the Plan or its sources changed. Request a fresh preview; no training changed."
          : "This request used an older Plan revision. Request a fresh preview.",
      );
    },
  );

  it("refreshes the library without claiming an outcome on transport failure", async () => {
    const h = harness(new Error("offline"));
    await h.controller.applyPlanChange("apply");
    expect(h.surface()).toMatchObject({
      busy: false,
      notice:
        "The Change result could not be confirmed. The Plan library will show the current state after refresh.",
    });
    expect(h.refresh).toHaveBeenCalledOnce();
  });

  it.each([
    [{ kind: "weekday-duration", day: 2, minutes: 0 }, "Enter a duration above zero."],
    [{ kind: "longest-workout", minutes: Number.NaN }, "Enter a duration above zero."],
    [{ kind: "weekly-duration", hours: -1 }, "Enter a weekly duration above zero."],
    [{ kind: "weekly-duration", hours: 0 }, "Enter a weekly duration above zero."],
    [
      { kind: "weekly-duration", hours: 2.3 },
      "Enter weekly hours in quarter-hour steps, like 2.25.",
    ],
    [{ kind: "weekday-unavailable", day: 8 }, "Choose the weekday to change."],
  ] satisfies [PlanChangeIntent, string][])(
    "validates parameters before the RPC for %j",
    async (intent, error) => {
      const h = harness(null);
      await h.controller.previewPlanChange(intent);
      expect(h.surface().error).toBe(error);
      expect(h.call).not.toHaveBeenCalled();
    },
  );

  it.each(["preview", "apply"] as const)(
    "replays the exact %s confirmation after a lost response and refresh",
    async (action) => {
      const h = harness(new Error("lost response"));
      h.refresh.mockImplementation(async () => h.updateVersion(8));
      const submit = () =>
        action === "preview"
          ? h.controller.previewPlanChange(change.intent)
          : h.controller.applyPlanChange("apply");
      await submit();
      await submit();
      expect(h.call).toHaveBeenCalledTimes(2);
      expect(h.call.mock.calls[1]).toEqual(h.call.mock.calls[0]);
      expect(h.refresh).toHaveBeenCalledTimes(2);
      expect(h.surface().busy).toBe(false);
    },
  );

  it.each(["preview", "apply"] as const)(
    "clears a %s confirmation after a definitive rejection",
    async (action) => {
      const h = harness({ status: "rejected", reason: "stale-version" });
      const submit = () =>
        action === "preview"
          ? h.controller.previewPlanChange(change.intent)
          : h.controller.applyPlanChange("apply");
      await submit();
      await submit();
      expect(h.call.mock.calls[1]?.[1]).not.toEqual(h.call.mock.calls[0]?.[1]);
    },
  );

  it("starts a new command for a different preview intent after a lost response", async () => {
    const h = harness(new Error("lost response"));
    await h.controller.previewPlanChange(change.intent);
    await h.controller.previewPlanChange({ kind: "weekly-duration", hours: 2.25 });
    expect(h.call.mock.calls[1]?.[1]).toMatchObject({
      intent: { kind: "weekly-duration", hours: 2.25 },
    });
    expect(h.call.mock.calls[1]?.[1]).not.toEqual(h.call.mock.calls[0]?.[1]);
  });

  it("does not submit a retired preview", async () => {
    const h = harness(null, [{ ...change, status: "cancelled" }]);
    await h.controller.applyPlanChange("apply");
    expect(h.call).not.toHaveBeenCalled();
    expect(h.surface().notice).toBe("This preview is no longer pending. Training is unchanged.");
  });

  it("ignores actions and late responses after disposal", async () => {
    const h = harness(null);
    h.controller.dispose();
    await h.controller.previewPlanChange(change.intent);
    await h.controller.applyPlanChange("cancel");
    expect(h.call).not.toHaveBeenCalled();
    expect(h.surface()).toEqual(EMPTY_PLAN_CHANGE_SURFACE);
  });
});
