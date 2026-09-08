import { CoachRpcRemoteError } from "@enduragent/coach-client";
import type { CoachClient } from "@enduragent/coach-client";
import type {
  ChatAttachmentComposerReadModel,
  ListPlansResult,
  PlanTodayChoice,
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

const todayChoice: PlanTodayChoice = {
  date: "1998-09-07",
  eligible: [
    { workoutId: "workout-first", name: "Easy spin", minutes: 30, kind: "easy" },
    { workoutId: "workout-second", name: "Endurance ride", minutes: 60, kind: "endurance" },
  ],
  blocked: [{ workoutId: "workout-hard", name: "Hard intervals", reason: "Recovery is required." }],
  reason: null,
};

const emptyComposer: ChatAttachmentComposerReadModel = {
  schemaVersion: 1,
  capabilities: {
    schemaVersion: 1,
    active: { provider: "test", model: "text-only", transport: "test" },
    documents: { enabled: true, extensions: ["pdf", "txt", "csv", "docx"] },
    completedActivities: { enabled: true, extensions: ["fit", "tcx", "gpx"] },
    plannedWorkouts: { enabled: true, extensions: ["zwo", "erg", "mrc"] },
    images: {
      enabled: false,
      mediaTypes: [],
      reason: "model_incompatible",
      source: "maintained_catalogue",
      checkedAt: "1998-09-07T00:00:00.000Z",
    },
  },
  draft: null,
};

function harness(result: unknown, changes: PlanChangeModel[] = [change]) {
  let surface: PlanChangeSurfaceState = EMPTY_PLAN_CHANGE_SURFACE;
  let library: ListPlansResult = {
    calendarConnected: false,
    legacy: null,
    active: {
      supportingEventCandidates: [],
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
      todayChoice: null,
      calendar: { status: "pending", window: null, currentThrough: null, error: null },
      creationId: null,
    },
    creation: null,
    closed: [],
    changesPaused: null,
    changes,
  };
  const call = vi.fn(async (_method: string, _request: unknown): Promise<never> => {
    const response =
      _method === "saveChatAttachmentDraftText" || _method === "getChatAttachmentComposer"
        ? emptyComposer
        : _method === "enqueueChatMessage"
          ? { schemaVersion: 1, revision: 1, items: [] }
          : result;
    if (response instanceof Error) throw response;
    return response as never;
  });
  const client: CoachClient = {
    handshake: {} as CoachClient["handshake"],
    call,
    close: vi.fn(async () => {}),
  };
  const refresh = vi.fn(async () => {});
  const render = vi.fn();
  const controller = createChatController({
    clients: {
      getClient: async () => client,
      reconnect: async () => client,
      close: async () => {},
    },
    view: { render },
    initialQueueSnapshot: { schemaVersion: 1, revision: 0, items: [] },
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
    render,
    call,
    refresh,
    surface: () => surface,
    clearActivePlan() {
      library = { ...library, active: null };
    },
    pause() {
      library = {
        ...library,
        changesPaused: { reason: "sync-stale", lastSuccessfulSyncAtMs: 900000000000 },
      };
    },
    setTodayChoice(choice: PlanTodayChoice | null = todayChoice) {
      if (library.active)
        library = { ...library, active: { ...library.active, todayChoice: choice } };
    },
    setSurface(patch: Partial<PlanChangeSurfaceState>) {
      surface = { ...surface, ...patch };
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

  it("previews the selected Workout through the existing confirmation path", async () => {
    const intent: PlanChangeIntent = { kind: "choose-workout", workoutId: "workout-second" };
    const h = harness({ status: "previewed", change: { ...change, intent }, version: 8 }, []);
    await h.controller.previewPlanChange(intent);
    expect(h.call).toHaveBeenCalledExactlyOnceWith("plan_change.preview", {
      planId: "plan-active",
      expectedVersion: 7,
      intent,
      commandId: expect.any(String),
    });
    expect(h.refresh).toHaveBeenCalledOnce();
    expect(h.surface()).toMatchObject({
      busy: false,
      error: null,
      focusRequest: { target: "preview" },
    });
  });

  it("preserves the host explanation when a Workout choice preview is refused", async () => {
    const explanation = "This Workout needs a recovery day first.";
    const h = harness({ status: "rejected", reason: "invalid-intent", message: explanation });
    await h.controller.previewPlanChange({ kind: "choose-workout", workoutId: "workout-hard" });
    expect(h.surface()).toMatchObject({ error: explanation, busy: false });
  });

  describe.each([
    [
      "day-changed",
      "The day changed while this choice was open. Request a fresh choice for today; no date was assigned.",
    ],
    ["not-eligible", "This Workout is no longer eligible."],
  ])("%s choice apply refusal", (reason, notice) => {
    it.each([false, true])(
      "retains the notice and refreshes when refresh fails: %s",
      async (refreshFails) => {
        const h = harness({ status: "rejected", reason }, [
          { ...change, intent: { kind: "choose-workout", workoutId: "workout-first" } },
        ]);
        if (refreshFails) h.refresh.mockRejectedValue(new Error("unavailable"));
        else h.refresh.mockImplementation(async () => h.updateVersion(8));
        await h.controller.applyPlanChange("apply");
        expect(h.surface()).toMatchObject({ busy: false, error: null, notice });
        expect(h.refresh).toHaveBeenCalledOnce();
        if (!refreshFails) {
          await h.controller.previewPlanChange({
            kind: "choose-workout",
            workoutId: "workout-second",
          });
          expect(h.call).toHaveBeenNthCalledWith(
            2,
            "plan_change.preview",
            expect.objectContaining({ expectedVersion: 8 }),
          );
        }
      },
    );
  });

  it.each([
    "wednesdays at most 30 minutes",
    "my ftp is 220",
    "what should i ride today",
    "WHAT SHOULD I RIDE TODAY?!",
    " What Should I Ride Today...  ",
  ])(
    "routes %j through text preview, echoes it, and clears the persisted composer draft",
    async (message) => {
      const h = harness({ status: "previewed", change, version: 8 }, []);
      h.setTodayChoice();
      h.controller.openPlanChangeEditor();
      expect(await h.controller.submit(message)).toBe(true);
      expect(h.call).toHaveBeenCalledWith(
        "plan_change.preview",
        expect.objectContaining({
          request: { kind: "text", text: message },
        }),
      );
      expect(h.render.mock.lastCall?.[0].messages).toContainEqual(
        expect.objectContaining({ role: "athlete", text: message, delivery: "complete" }),
      );
      expect(h.surface()).toMatchObject({ busy: false, focusRequest: { target: "preview" } });
      expect(h.call).toHaveBeenCalledWith("saveChatAttachmentDraftText", {
        chatId: "desktop",
        text: "",
      });
      expect(h.call.mock.calls.some(([method]) => method === "enqueueChatMessage")).toBe(false);
      h.controller.dispose();
    },
  );

  it("clears the submitted draft before the preview returns so newer text survives", async () => {
    const h = harness(null, []);
    h.setTodayChoice(todayChoice);
    h.controller.openPlanChangeEditor();
    const order: string[] = [];
    const original = h.call.getMockImplementation();
    h.call.mockImplementation(async (method: string, request: unknown): Promise<never> => {
      order.push(method);
      if (method === "plan_change.preview") return new Promise<never>(() => {});
      return original!(method, request);
    });
    void h.controller.submit("what should i ride today?");
    await vi.waitFor(() => expect(order).toContain("plan_change.preview"));
    expect(order.indexOf("saveChatAttachmentDraftText")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("saveChatAttachmentDraftText")).toBeLessThan(
      order.indexOf("plan_change.preview"),
    );
    h.controller.dispose();
  });

  it.each([null, { ...todayChoice, eligible: [], reason: "Recovery is required." }])(
    "announces that no Workout is eligible without sending chat when the choice is %j",
    async (choice) => {
      const h = harness(
        {
          status: "rejected",
          reason: "unsupported-request",
          explanation: "No eligible Workout can be selected today.",
        },
        [],
      );
      h.setTodayChoice(choice);
      h.controller.openPlanChangeEditor();
      expect(await h.controller.submit("what should i ride today?")).toBe(true);
      expect(h.surface().notice).toBe("No eligible Workout can be selected today.");
      expect(h.call).toHaveBeenCalledWith(
        "plan_change.preview",
        expect.objectContaining({ request: { kind: "text", text: "what should i ride today?" } }),
      );
      expect(h.call).toHaveBeenCalledWith("saveChatAttachmentDraftText", {
        chatId: "desktop",
        text: "",
      });
      h.controller.dispose();
    },
  );

  it.each([
    "unrelated text",
    "what should i ride today please",
    "what should i ride today? And tomorrow?",
  ])("sends %j through normal chat when Change is closed", async (message) => {
    const h = harness(null, []);
    h.setTodayChoice();
    expect(await h.controller.submit(message)).toBe(true);
    expect(h.call).toHaveBeenCalledWith(
      "enqueueChatMessage",
      expect.objectContaining({ text: message }),
    );
    expect(h.call.mock.calls.some(([method]) => method === "plan_change.preview")).toBe(false);
    h.controller.dispose();
  });

  it.each(["closed", "attachments"])(
    "keeps the today question in normal chat with %s",
    async (scope) => {
      const h = harness(null, []);
      h.setTodayChoice();
      if (scope === "attachments") h.controller.openPlanChangeEditor();
      const attachmentIds = scope === "attachments" ? ["attachment-workout"] : [];
      expect(await h.controller.submit("what should i ride today?", attachmentIds)).toBe(true);
      expect(h.call).toHaveBeenCalledWith(
        "enqueueChatMessage",
        expect.objectContaining({
          text: "what should i ride today?",
          ...(attachmentIds.length ? { attachmentIds } : {}),
        }),
      );
      expect(h.call.mock.calls.some(([method]) => method === "plan_change.preview")).toBe(false);
      h.controller.dispose();
    },
  );

  it.each(["different-plan", "no-active-plan"])(
    "keeps text in normal chat with %s",
    async (scope) => {
      const h = harness(null, []);
      h.setSurface({ open: true, planId: "another-plan" });
      if (scope === "no-active-plan") h.clearActivePlan();
      await h.controller.submit("my ftp is 220");
      expect(h.call).toHaveBeenCalledWith(
        "enqueueChatMessage",
        expect.objectContaining({ text: "my ftp is 220" }),
      );
      expect(h.call.mock.calls.some(([method]) => method === "plan_change.preview")).toBe(false);
      h.controller.dispose();
    },
  );

  it("routes text while the active Plan has a pending preview", async () => {
    const h = harness({ status: "previewed", change, version: 8 });
    await h.controller.submit("my ftp is 220");
    expect(h.call).toHaveBeenCalledWith(
      "plan_change.preview",
      expect.objectContaining({ request: { kind: "text", text: "my ftp is 220" } }),
    );
    h.controller.dispose();
  });

  it.each(["busy", "paused"])(
    "does not preview or enqueue today's question while %s",
    async (state) => {
      const h = harness(null, []);
      h.setTodayChoice();
      h.controller.openPlanChangeEditor();
      if (state === "busy") h.setSurface({ busy: true });
      else h.pause();
      expect(await h.controller.submit("what should i ride today?")).toBe(state === "paused");
      expect(
        h.call.mock.calls.some(
          ([method]) => method === "plan_change.preview" || method === "enqueueChatMessage",
        ),
      ).toBe(false);
      h.controller.dispose();
    },
  );

  it.each([
    "This request is not supported yet. Choose one of the available actions.",
    "Ask for one change at a time.",
  ])("renders the backend rejection as a notice: %s", async (explanation) => {
    const h = harness({ status: "rejected", reason: "unsupported-request", explanation }, []);
    h.controller.openPlanChangeEditor();
    await h.controller.submit("some request");
    expect(h.surface()).toMatchObject({ busy: false, error: null, notice: explanation });
    expect(h.render.mock.lastCall?.[0].messages).toContainEqual(
      expect.objectContaining({ role: "athlete", text: "some request" }),
    );
    expect(h.call.mock.calls.some(([method]) => method === "enqueueChatMessage")).toBe(false);
    h.controller.dispose();
  });

  it("keeps host validation explanations in a text request notice", async () => {
    const explanation = "This Plan has no remaining Workouts on Wednesday.";
    const h = harness({ status: "rejected", reason: "invalid-intent", explanation }, []);
    h.controller.openPlanChangeEditor();
    await h.controller.submit("no training on wednesdays");
    expect(h.surface()).toMatchObject({ busy: false, error: null, notice: explanation });
    h.controller.dispose();
  });

  it("reserves one attempt while saving the draft and uses a new command for the next submission", async () => {
    const h = harness({ status: "previewed", change, version: 8 }, []);
    h.controller.openPlanChangeEditor();
    const first = h.controller.submit("my ftp is 220");
    expect(await h.controller.submit("my ftp is 230")).toBe(false);
    await first;
    await h.controller.submit("my ftp is 220");
    const previews = h.call.mock.calls.filter(([method]) => method === "plan_change.preview");
    expect(previews).toHaveLength(2);
    expect(previews[0]?.[1]).not.toEqual(previews[1]?.[1]);
    expect(h.render.mock.lastCall?.[0].messages).toHaveLength(2);
    h.controller.dispose();
  });

  it("sends the FTP intent and keeps daemon rejection copy", async () => {
    const h = harness({ status: "rejected", reason: "command-conflict" });
    await h.controller.previewPlanChange({ kind: "ftp", watts: 220 });
    expect(h.call).toHaveBeenCalledWith(
      "plan_change.preview",
      expect.objectContaining({ intent: { kind: "ftp", watts: 220 } }),
    );
    expect(h.surface().error).toBe("This Change could not be previewed. Training is unchanged.");
  });

  it("shows the daemon message when an FTP preview is refused remotely", async () => {
    const h = harness(new CoachRpcRemoteError(-32000, "Enter 1–9999 whole watts."));
    await h.controller.previewPlanChange({ kind: "ftp", watts: 220 });
    expect(h.surface().error).toBe("Enter 1–9999 whole watts.");
  });

  it("preserves the FTP source notice when the library cannot be re-read", async () => {
    const h = harness({ status: "rejected", reason: "ftp-sources-changed" });
    h.refresh.mockRejectedValue(new Error("unavailable"));
    await h.controller.applyPlanChange("apply");
    expect(h.refresh).toHaveBeenCalledOnce();
    expect(h.surface()).toMatchObject({
      busy: false,
      error: null,
      notice: "The FTP sources changed. Request a fresh preview before applying this correction.",
    });
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
      "ftp-sources-changed",
      "The FTP sources changed. Request a fresh preview before applying this correction.",
    ],
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
      reason === "stale-version" || reason === "not-pending" || reason === "ftp-sources-changed"
        ? 1
        : 0,
    );
  });

  it.each(["stale-version", "not-pending", "ftp-sources-changed"])(
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
    ...[0, -1, Number.NaN, Infinity, 1.5, 10000].map((watts): [PlanChangeIntent, string] => [
      { kind: "ftp", watts },
      "Enter FTP above zero.",
    ]),
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

  it("keeps a newer composer draft typed while a text submission is still starting", async () => {
    const h = harness({ status: "previewed", change, version: 8 }, []);
    h.setTodayChoice();
    h.controller.openPlanChangeEditor();
    const submission = h.controller.submit("wednesdays at most 30 minutes");
    h.controller.saveAttachmentDraftText("newer composer text");
    expect(await submission).toBe(true);
    const saves = h.call.mock.calls
      .filter(([method]) => method === "saveChatAttachmentDraftText")
      .map(([, request]) => (request as { text: string }).text);
    expect(saves.at(-1)).toBe("newer composer text");
    h.controller.dispose();
  });

  it("ignores actions and late responses after disposal", async () => {
    const h = harness(null);
    h.controller.dispose();
    await h.controller.previewPlanChange(change.intent);
    await h.controller.applyPlanChange("cancel");
    expect(h.call).not.toHaveBeenCalled();
    expect(h.surface()).toEqual(EMPTY_PLAN_CHANGE_SURFACE);
  });
  it("preserves the backend Supporting Event validation explanation in the editor", async () => {
    const explanation = "The event date conflicts with a confirmed training limit.";
    const h = harness({ status: "rejected", reason: "invalid-intent", explanation });
    h.controller.openPlanChangeEditor();
    await h.controller.previewPlanChange({
      kind: "supporting-event",
      operation: "add",
      name: "River ride",
      date: "1998-09-13",
      role: "Training",
    });
    expect(h.surface()).toMatchObject({ editorOpen: true, error: explanation, busy: false });
  });

  it("uses event validation copy before sending malformed parameters", async () => {
    const h = harness(null);
    await h.controller.previewPlanChange({
      kind: "supporting-event",
      operation: "add",
      name: "",
      date: "",
      role: "Training",
    });
    expect(h.surface().error).toBe("Enter the event name and exact date.");
    await h.controller.previewPlanChange({
      kind: "supporting-event",
      operation: "remove",
      eventId: "",
    });
    expect(h.surface().error).toBe("Choose a Supporting Event already accepted in this Plan.");
    expect(h.call).not.toHaveBeenCalled();
  });

  it("re-reads the library and retains the pending event after synchronized source drift", async () => {
    const h = harness({ status: "rejected", reason: "event-source-changed" });
    await h.controller.applyPlanChange("apply");
    expect(h.surface()).toMatchObject({
      notice: "The synchronized event changed. Request a fresh preview before applying.",
      error: null,
      busy: false,
    });
    expect(h.refresh).toHaveBeenCalledOnce();
    await h.controller.applyPlanChange("cancel");
    expect(h.call).toHaveBeenCalledTimes(2);
  });
});
