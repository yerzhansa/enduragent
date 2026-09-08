import type {
  ListPlansResult,
  PlanChangeModel,
  PlanChangeWorkout,
  PlanCreationCardModel,
} from "@enduragent/coach-contract";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createChatController } from "../src/chat/controller";
import {
  EMPTY_CHAT_SURFACE,
  PLAN_CHANGES_PAUSED_NOTICE,
  PLAN_CHANGES_RESUMED_NOTICE,
  type ChatActions,
} from "../src/state/chat-slice";
import { useEnduragentStore } from "../src/state/store";
import { READY_ONBOARDING } from "../src/state/onboarding-slice";
import { ChatView } from "../src/ui/chat/ChatView";
import { PlanChangeCards } from "../src/ui/chat/PlanChangeCards";

function stubActions(): ChatActions {
  return {
    openPlanChangeEditor: vi.fn(),
    backFromPlanChangeEditor: vi.fn(),
    previewPlanChange: vi.fn(),
    applyPlanChange: vi.fn(),
    submit: vi.fn(async () => true),
    chooseAttachments: vi.fn(),
    pasteAttachment: vi.fn(),
    receiveAttachmentAdmissions: vi.fn(),
    saveAttachmentDraftText: vi.fn(),
    removeAttachment: vi.fn(),
    retryAttachment: vi.fn(),
    selectAttachmentWorkout: vi.fn(),
    reviewAttachmentInPlan: vi.fn(),
    continueMessageInPlan: vi.fn(),
    openPlanningRequest: vi.fn(),
    retryPlanningRequest: vi.fn(),
    retryPlanningRequestLoad: vi.fn(),
    clearPlanningRequestFocus: vi.fn(),
    startPlanCreation: vi.fn(),
    buildPlanCreationDraft: vi.fn(),
    answerPlanCreation: vi.fn(),
    pausePlanCreation: vi.fn(),
    continuePlanCreation: vi.fn(),
    editPlanCreation: vi.fn(),
    cancelPlanCreationEdit: vi.fn(),
    openPlanCreationDiscard: vi.fn(),
    cancelPlanCreationDiscard: vi.fn(),
    confirmPlanCreationDiscard: vi.fn(),
    openPlanCreationActivate: vi.fn(),
    cancelPlanCreationActivate: vi.fn(),
    confirmPlanCreationActivate: vi.fn(),
    stop: vi.fn(),
    removeQueued: vi.fn(),
    runQueuedCommand: vi.fn(),
    retryQueuedTurn: vi.fn(),
    retry: vi.fn(),
    loadEarlier: vi.fn(),
    retryHydration: vi.fn(),
    retryDecision: vi.fn(),
    openNewConversation: vi.fn(),
    cancelNewConversation: vi.fn(),
    confirmNewConversation: vi.fn(),
    retryFirstSync: vi.fn(),
    answerDecision: vi.fn(),
    skipDecision: vi.fn(),
  };
}

const active: NonNullable<ListPlansResult["active"]> = {
  supportingEventCandidates: [],
  planId: "active-change",
  version: 7,
  name: "Build steady power",
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
};
const workout: PlanChangeWorkout = {
  id: "workout-one",
  name: "Endurance ride",
  kind: "endurance",
  date: "1998-09-09",
  minutes: 60,
  pinned: false,
  guidance: "Ride comfortably",
  power: null,
};
function change(patch: Partial<PlanChangeModel> = {}): PlanChangeModel {
  return {
    changeId: "change-pending",
    planId: active.planId,
    baseRevisionNumber: 1,
    status: "pending",
    title: "Limit Wednesday training",
    intent: { kind: "weekday-duration", day: 3, minutes: 30 },
    diff: [{ workoutId: workout.id, before: workout, after: { ...workout, minutes: 30 } }],
    totals: {
      before: { plan: 1234, weeks: [{ number: 1, minutes: 321 }] },
      after: { plan: 1204, weeks: [{ number: 1, minutes: 291 }] },
    },
    supersedes: null,
    supersededBy: null,
    resultRevisionNumber: null,
    undo: null,
    confidence: "Confirmed schedule limits",
    premises: [
      {
        id: "premise-one",
        label: "Wednesday limit",
        source: "Your confirmed request",
        value: { kind: "weekday-duration", day: 3, minutes: 30 },
      },
    ],
    ...patch,
  };
}
function setChanges(changes: PlanChangeModel[]): void {
  act(() =>
    useEnduragentStore.setState({
      planLibrary: {
        status: "ready",
        value: {
          calendarConnected: false,
          legacy: null,
          active,
          creation: null,
          closed: [],
          changesPaused: null,
          changes,
        },
      },
    }),
  );
}
function patchChange(
  patch: Partial<ReturnType<typeof useEnduragentStore.getState>["planChange"]>,
): void {
  act(() =>
    useEnduragentStore.setState({
      planChange: { ...useEnduragentStore.getState().planChange, ...patch },
    }),
  );
}

function connectController(result: unknown, refresh: () => Promise<void>) {
  const call = vi.fn().mockResolvedValue(result);
  const controller = createChatController({
    clients: {
      getClient: vi.fn().mockResolvedValue({ call }),
      reconnect: vi.fn().mockResolvedValue({ call }),
      close: vi.fn(),
    },
    view: { render: vi.fn() },
    refreshTrainingContext: async () => {},
    refreshSpend: async () => {},
    readPlanLibrary: () => useEnduragentStore.getState().planLibrary.value,
    readPlanChange: () => useEnduragentStore.getState().planChange,
    publishPlanChange: (planChange) => useEnduragentStore.setState({ planChange }),
    refreshPlanLibrary: refresh,
  });
  useEnduragentStore.setState({
    chatActions: { ...stubActions(), applyPlanChange: controller.applyPlanChange },
  });
  return { controller, call };
}

beforeEach(() => {
  useEnduragentStore.setState({
    activeView: "chat",
    chat: EMPTY_CHAT_SURFACE,
    chatActions: stubActions(),
    planChange: {
      open: true,
      textRouting: false,
      planId: active.planId,
      editorOpen: false,
      busy: false,
      error: null,
      notice: null,
      focusRequest: null,
    },
    planLibrary: {
      status: "ready",
      value: {
        calendarConnected: false,
        legacy: null,
        active,
        creation: null,
        closed: [],
        changesPaused: null,
        changes: [],
      },
    },
    planLibraryActions: null,
  });
});

describe("Plan Change cards", () => {
  it("reads the persisted typed request from pending Change evidence after remount", async () => {
    const text = "wednesdays at most 30 minutes";
    setChanges([
      change({
        premises: [
          {
            id: "request",
            label: "Your request",
            source: "Your message",
            value: { kind: "text", text },
          },
        ],
      }),
    ]);
    const view = render(<PlanChangeCards />);
    view.unmount();
    render(<PlanChangeCards />);

    await userEvent.click(screen.getByRole("button", { name: "View evidence" }));

    expect(
      within(screen.getByRole("table", { name: "Source details" })).getByRole("cell", {
        name: text,
      }),
    ).toBeVisible();
  });

  function setTodayChoice(
    todayChoice: NonNullable<ListPlansResult["active"]>["todayChoice"],
  ): void {
    const value = useEnduragentStore.getState().planLibrary.value;
    if (!value?.active) throw new Error("Missing active Plan");
    const activePlan = value.active;
    act(() =>
      useEnduragentStore.setState({
        planLibrary: {
          status: "ready",
          value: { ...value, active: { ...activePlan, todayChoice } },
        },
      }),
    );
  }

  it("shows host-eligible Workouts and previews the selected row", async () => {
    setTodayChoice({
      date: "1998-09-07",
      eligible: [
        { workoutId: "easy", name: "Easy ride", minutes: 30, kind: "endurance" },
        { workoutId: "steady", name: "Steady ride", minutes: 45, kind: "endurance" },
      ],
      blocked: [
        { workoutId: "hard", name: "Hill repeats", reason: "No hard training today." },
        { workoutId: "long", name: "Long ride", reason: "Today is limited to 45 minutes." },
      ],
      reason: null,
    });
    render(<PlanChangeCards />);
    const card = screen.getByRole("region", { name: "Choose one eligible Workout" });
    expect(within(card).getByText("Today")).toBeVisible();
    expect(within(card).getByText("Easy ride · 30 min")).toBeVisible();
    expect(within(card).getByText("Steady ride · 45 min")).toBeVisible();
    expect(within(card).getByText("No hard training today.")).toBeVisible();
    expect(within(card).getByText("Today is limited to 45 minutes.")).toBeVisible();
    expect(within(card).queryByRole("button", { name: "Review Hill repeats" })).toBeNull();
    await userEvent.click(within(card).getByRole("button", { name: "Review Steady ride" }));
    expect(
      useEnduragentStore.getState().chatActions?.previewPlanChange,
    ).toHaveBeenCalledExactlyOnceWith({
      kind: "choose-workout",
      workoutId: "steady",
    });
  });

  it("shows the Plan-level blocker when no Workout is eligible", () => {
    setTodayChoice({
      date: "1998-09-07",
      eligible: [],
      blocked: [],
      reason: "Today already belongs to a dated Workout.",
    });
    render(<PlanChangeCards />);
    const card = screen.getByRole("region", { name: "Choose one eligible Workout" });
    expect(within(card).getByText("Today already belongs to a dated Workout.")).toBeVisible();
    expect(within(card).queryByRole("button")).toBeNull();
  });

  it("omits the Today card when the host exposes no choice", () => {
    render(<PlanChangeCards />);
    expect(screen.queryByRole("region", { name: "Choose one eligible Workout" })).toBeNull();
  });

  it.each(["busy", "paused", "disconnected"])("disables daily review while %s", (state) => {
    setTodayChoice({
      date: "1998-09-07",
      eligible: [{ workoutId: "easy", name: "Easy ride", minutes: 30, kind: "endurance" }],
      blocked: [],
      reason: null,
    });
    if (state === "busy") patchChange({ busy: true });
    if (state === "disconnected") useEnduragentStore.setState({ chatActions: null });
    if (state === "paused") {
      const value = useEnduragentStore.getState().planLibrary.value;
      if (!value) throw new Error("Missing library");
      useEnduragentStore.setState({
        planLibrary: {
          status: "ready",
          value: { ...value, changesPaused: { reason: "sync-stale", lastSuccessfulSyncAtMs: 0 } },
        },
      });
    }
    render(<PlanChangeCards />);
    expect(screen.getByRole("button", { name: "Review Easy ride" })).toBeDisabled();
  });

  it("shows the daily choice guarantee beside the exact date difference", () => {
    setChanges([
      change({
        title: "Choose a Workout for today",
        intent: { kind: "choose-workout", workoutId: workout.id },
        details: "Only this Workout will receive today’s date after confirmation.",
        diff: [
          {
            workoutId: workout.id,
            before: { ...workout, date: null },
            after: { ...workout, date: "1998-09-07" },
          },
        ],
      }),
    ]);
    render(<PlanChangeCards />);
    const card = screen.getByRole("region", { name: "Choose a Workout for today" });
    expect(
      within(card).getByText("Only this Workout will receive today’s date after confirmation."),
    ).toBeVisible();
    expect(within(card).getByText("Undated · 60 min → 7 Sept 1998 · 60 min")).toBeVisible();
    expect(within(card).getByRole("button", { name: "Apply to Plan" })).toBeEnabled();
  });

  it("announces recovery when a paused library loaded before the surface opened turns fresh", () => {
    setChanges([]);
    patchChange({ open: false, notice: null });
    const value = useEnduragentStore.getState().planLibrary.value;
    if (!value) throw new Error("Missing library");
    act(() =>
      useEnduragentStore.getState().setPlanLibrary({
        status: "ready",
        value: { ...value, changesPaused: { reason: "sync-stale", lastSuccessfulSyncAtMs: 0 } },
      }),
    );
    expect(useEnduragentStore.getState().planChange.notice).toBeNull();
    patchChange({ open: true, planId: active.planId });
    render(<PlanChangeCards />);
    expect(screen.getByRole("status")).toHaveTextContent(PLAN_CHANGES_PAUSED_NOTICE);
    act(() => useEnduragentStore.getState().setPlanLibrary({ status: "ready", value }));
    expect(screen.getByRole("status")).toHaveTextContent(PLAN_CHANGES_RESUMED_NOTICE);
  });

  it.each(["preview", "apply"] as const)(
    "recovers after a sync-stale %s rejection and a failed library refresh",
    async (action) => {
      setChanges([change()]);
      const value = useEnduragentStore.getState().planLibrary.value;
      if (!value) throw new Error("Missing library");
      const refresh = vi.fn(async () => {
        useEnduragentStore.getState().setPlanLibrary({ status: "unavailable", value });
        throw new Error("unavailable");
      });
      const { controller } = connectController(
        { status: "rejected", reason: "sync-stale" },
        refresh,
      );
      render(<PlanChangeCards />);
      await act(async () => {
        if (action === "preview") await controller.previewPlanChange(change().intent);
        else await controller.applyPlanChange("apply");
      });
      expect(refresh).toHaveBeenCalledOnce();
      expect(useEnduragentStore.getState().planLibrary).toEqual({ status: "unavailable", value });
      expect(value.changesPaused).toBeNull();
      expect(screen.getByRole("status")).toHaveTextContent(PLAN_CHANGES_PAUSED_NOTICE);
      act(() => useEnduragentStore.getState().setPlanLibrary({ status: "ready", value }));
      expect(screen.getByRole("status")).toHaveTextContent(PLAN_CHANGES_RESUMED_NOTICE);
      patchChange({ notice: "Review the exact changes before confirming." });
      act(() => useEnduragentStore.getState().setPlanLibrary({ status: "ready", value }));
      expect(screen.getByRole("status")).toHaveTextContent(
        "Review the exact changes before confirming.",
      );
      controller.dispose();
    },
  );

  it("keeps Change history visible and focuses the pause notice after cancelling", async () => {
    setChanges([change()]);
    const value = useEnduragentStore.getState().planLibrary.value;
    if (!value) throw new Error("Missing library");
    const pausedLibrary: ListPlansResult = {
      ...value,
      changesPaused: { reason: "sync-stale", lastSuccessfulSyncAtMs: 900000000000 },
    };
    useEnduragentStore.getState().setPlanLibrary({ status: "ready", value: pausedLibrary });
    const { controller, call } = connectController(
      { status: "cancelled", changeId: change().changeId, version: 8 },
      async () => {
        useEnduragentStore.getState().setPlanLibrary({
          status: "ready",
          value: { ...pausedLibrary, changes: [change({ status: "cancelled" })] },
        });
      },
    );
    useEnduragentStore.setState({ runtimeReady: true, onboarding: READY_ONBOARDING });
    render(<ChatView />);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(call).toHaveBeenCalledWith(
      "plan_change.apply",
      expect.objectContaining({ decision: "cancel" }),
    );
    const section = screen.getByRole("region", { name: "Plan Changes" });
    const notice = within(section).getByRole("status");
    await waitFor(() => expect(notice).toHaveFocus());
    expect(notice).toHaveTextContent(PLAN_CHANGES_PAUSED_NOTICE);
    expect(useEnduragentStore.getState().planChange).toMatchObject({
      open: true,
      textRouting: false,
    });
    expect(within(section).getByText("Cancelled", { exact: true })).toBeVisible();
    expect(screen.getByRole("button", { name: "Change one thing" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    controller.dispose();
  });

  it("keeps the pending preview and Cancel while explaining every paused action", () => {
    setChanges([
      change(),
      change({
        changeId: "change-applied",
        status: "applied",
        undo: { eligible: true },
        resultRevisionNumber: 2,
      }),
    ]);
    patchChange({ editorOpen: true, error: "Earlier validation error" });
    render(<PlanChangeCards />);
    const value = useEnduragentStore.getState().planLibrary.value;
    if (!value) throw new Error("Missing library");
    act(() =>
      useEnduragentStore.getState().setPlanLibrary({
        status: "ready",
        value: {
          ...value,
          changesPaused: { reason: "sync-stale", lastSuccessfulSyncAtMs: 900000000000 },
        },
      }),
    );
    const section = screen.getByRole("region", { name: "Plan Changes" });
    const notice = within(section).getByRole("status");
    expect(notice).toHaveTextContent(PLAN_CHANGES_PAUSED_NOTICE);
    expect(section.firstElementChild).toBe(notice);
    for (const name of ["Change one thing", "Undo", "Apply to Plan"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("aria-describedby", notice.id);
      expect(button).toHaveAccessibleDescription(PLAN_CHANGES_PAUSED_NOTICE);
    }
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(screen.getAllByRole("region", { name: "Limit Wednesday training" })).toHaveLength(2);
    expect(screen.queryByRole("region", { name: "What needs to change?" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(useEnduragentStore.getState().planChange.editorOpen).toBe(false);
  });

  it("announces a fresh sync once and lets the next preview replace the notice", () => {
    setChanges([change()]);
    render(<PlanChangeCards />);
    const value = useEnduragentStore.getState().planLibrary.value;
    if (!value) throw new Error("Missing library");
    const refresh = (changesPaused: ListPlansResult["changesPaused"]) =>
      act(() =>
        useEnduragentStore
          .getState()
          .setPlanLibrary({ status: "ready", value: { ...value, changesPaused } }),
      );
    refresh({ reason: "sync-stale", lastSuccessfulSyncAtMs: 900000000000 });
    refresh(null);
    expect(screen.getByRole("status")).toHaveTextContent(PLAN_CHANGES_RESUMED_NOTICE);
    expect(screen.getByRole("button", { name: "Change one thing" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Apply to Plan" })).not.toHaveAttribute(
      "aria-describedby",
    );
    patchChange({ notice: "Review the exact changes before confirming." });
    refresh(null);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Review the exact changes before confirming.",
    );
    refresh({ reason: "sync-stale", lastSuccessfulSyncAtMs: 900000000000 });
    refresh(null);
    expect(screen.getByRole("status")).toHaveTextContent(PLAN_CHANGES_RESUMED_NOTICE);
  });

  it("does not announce recovery when the Change surface is closed", () => {
    patchChange({ open: false });
    const value = useEnduragentStore.getState().planLibrary.value;
    if (!value) throw new Error("Missing library");
    useEnduragentStore.getState().setPlanLibrary({
      status: "ready",
      value: {
        ...value,
        changesPaused: { reason: "sync-stale", lastSuccessfulSyncAtMs: 900000000000 },
      },
    });
    useEnduragentStore.getState().setPlanLibrary({ status: "ready", value });
    expect(useEnduragentStore.getState().planChange.notice).toBeNull();
  });

  it("restores pending Changes in Chat alongside separate creation and an enabled composer", async () => {
    const creation: PlanCreationCardModel = {
      creationId: "separate-creation",
      version: 1,
      status: "in-progress",
      readiness: "incomplete",
      draft: null,
      draftStale: false,
      calendarWindow: null,
      pendingCommitment: null,
      answeredSummaries: [],
      openQuestion: null,
    };
    useEnduragentStore.setState({
      runtimeReady: true,
      onboarding: READY_ONBOARDING,
      chat: {
        ...EMPTY_CHAT_SURFACE,
        planCreation: creation,
        planCreationLoaded: true,
        planCreationPaused: true,
        timeline: [{ kind: "plan-creation", model: creation }],
      },
      planLibrary: {
        status: "ready",
        value: {
          calendarConnected: false,
          legacy: null,
          active,
          creation,
          closed: [],
          changesPaused: null,
          changes: [change()],
        },
      },
    });
    patchChange({ open: false, planId: null });
    render(<ChatView />);
    expect(screen.getByRole("region", { name: "Plan Changes" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Plan Creation progress" })).toBeVisible();
    expect(screen.getByText("Your separate Plan creation is still open.")).toBeVisible();
    expect(screen.getByText("Training changes need your confirmation.")).toBeVisible();
    const composer = screen.getByRole("combobox", { name: "Message your coach" });
    expect(composer).toBeEnabled();
    await userEvent.type(composer, "How should I pace tomorrow?");
    expect(composer).toHaveValue("How should I pace tomorrow?");
  });

  it("shows the active Plan only after entry and restores a pending preview without entry", () => {
    patchChange({ open: false, planId: null });
    const view = render(<PlanChangeCards />);
    expect(screen.queryByRole("region", { name: "Plan Changes" })).toBeNull();
    setChanges([change()]);
    expect(screen.getByRole("heading", { name: active.name })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Limit Wednesday training" })).toBeVisible();
    expect(screen.getByText("Changes affect future, uncompleted training.")).toBeVisible();
    view.unmount();
    render(<PlanChangeCards />);
    expect(screen.getByText("Pending", { exact: true })).toBeVisible();
  });

  it("orders notice, active Plan, editor, pending preview, then oldest to newest history", () => {
    setChanges([
      change({ changeId: "old", title: "Old decision", status: "applied" }),
      change({ changeId: "new", title: "New decision", status: "cancelled" }),
      change(),
    ]);
    patchChange({ editorOpen: true, notice: "Review the exact changes before confirming." });
    render(<PlanChangeCards />);
    const surface = screen.getByRole("region", { name: "Plan Changes" });
    const headings = within(surface)
      .getAllByRole("heading")
      .map((heading) => heading.textContent);
    expect(headings).toEqual([
      active.name,
      "What needs to change?",
      "Limit Wednesday training",
      "Old decision",
      "New decision",
    ]);
    expect(
      screen
        .getByText("Review the exact changes before confirming.")
        .compareDocumentPosition(screen.getByRole("heading", { name: active.name })),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.getByText("Applied", { exact: true })).toBeVisible();
    expect(screen.getByText("Cancelled", { exact: true })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Undo|Refresh preview/ })).toBeNull();
  });

  it("offers Undo only on the eligible applied history card and shares preview busy state", async () => {
    setChanges([
      change({
        changeId: "older",
        status: "applied",
        undo: { eligible: false, reason: "not-newest" },
      }),
      change({
        changeId: "latest",
        title: "Latest limit",
        status: "applied",
        undo: { eligible: true },
      }),
      change({ changeId: "cancelled", status: "cancelled" }),
      change({ changeId: "superseded", status: "superseded" }),
      change({ changeId: "stale", status: "stale" }),
      change(),
    ]);
    render(<PlanChangeCards />);
    expect(screen.getAllByRole("button", { name: "Undo" })).toHaveLength(1);
    const history = screen.getByRole("region", { name: "Latest limit" });
    expect(
      within(history)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Read historical evidence", "Undo", "Read this difference"]);
    const undo = within(history).getByRole("button", { name: "Undo" });
    await userEvent.click(undo);
    expect(useEnduragentStore.getState().chatActions?.previewPlanChange).toHaveBeenCalledWith({
      kind: "inverse",
      changeId: "latest",
    });
    patchChange({ busy: true });
    expect(undo).toBeDisabled();
    expect(screen.getByRole("button", { name: "Apply to Plan" })).toBeDisabled();
    patchChange({ busy: false });
    act(() => useEnduragentStore.setState({ chatActions: null }));
    expect(undo).toBeDisabled();
  });

  it.each(["not-newest", "inverse", "nothing-to-restore", "plan-changed"] as const)(
    "keeps applied history readable without Undo when eligibility is %s",
    (reason) => {
      setChanges([change({ status: "applied", undo: { eligible: false, reason } })]);
      render(<PlanChangeCards />);
      expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
      expect(screen.getByRole("button", { name: "Read this difference" })).toBeEnabled();
    },
  );

  it("renders and focuses the inverse through the shared pending card with its captured title", async () => {
    setChanges([
      change({
        title: "Undo the latest Change",
        intent: { kind: "inverse", changeId: "latest" },
        premises: [
          {
            id: "undone-change",
            label: "Undo",
            source: "Applied Change",
            value: { changeId: "latest", title: "Earlier Wednesday limit" },
          },
        ],
      }),
    ]);
    patchChange({ focusRequest: { target: "preview", revision: 1 } });
    render(<PlanChangeCards />);
    const preview = screen.getByRole("region", { name: "Undo the latest Change" });
    expect(within(preview).getByRole("heading")).toHaveFocus();
    expect(preview).toHaveTextContent(
      "Restore the previewed future training. Completed and past training stays unchanged.",
    );
    expect(preview).not.toHaveTextContent("Review this exact difference.");
    expect(
      within(preview)
        .getAllByRole("button")
        .slice(-2)
        .map((button) => button.textContent),
    ).toEqual(["Cancel", "Apply to Plan"]);
    await userEvent.click(within(preview).getByRole("button", { name: "View evidence" }));
    expect(screen.getByRole("region", { name: "Source details" })).toHaveTextContent(
      "Earlier Wednesday limit",
    );
  });

  it("offers Schedule and FTP changes in order and submits their defaults", async () => {
    patchChange({ editorOpen: true });
    render(<PlanChangeCards />);
    const actions = useEnduragentStore.getState().chatActions;
    const select = screen.getByRole("combobox", { name: "Change" });
    expect(screen.getByRole("combobox", { name: "Weekday" })).toHaveTextContent("Wed");
    expect(screen.getByRole("spinbutton", { name: "Duration limit in minutes" })).toHaveValue(30);
    await userEvent.click(screen.getByRole("button", { name: "Preview change" }));
    expect(actions?.previewPlanChange).toHaveBeenLastCalledWith({
      kind: "weekday-duration",
      day: 3,
      minutes: 30,
    });
    await userEvent.click(select);
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
      "Weekday duration cap",
      "Weekday unavailable",
      "No hard training on a weekday",
      "Weekly duration cap",
      "Longest-Workout cap",
      "Correct FTP",
      "Supporting Event",
    ]);
    await userEvent.click(await screen.findByRole("option", { name: "Weekday unavailable" }));
    expect(screen.getByRole("combobox", { name: "Weekday" })).toHaveTextContent("Wed");
    expect(screen.queryByRole("spinbutton")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Preview change" }));
    expect(actions?.previewPlanChange).toHaveBeenLastCalledWith({
      kind: "weekday-unavailable",
      day: 3,
    });
    await userEvent.click(select);
    await userEvent.click(
      await screen.findByRole("option", { name: "No hard training on a weekday" }),
    );
    expect(screen.getByRole("combobox", { name: "Weekday" })).toHaveTextContent("Mon");
    await userEvent.click(screen.getByRole("button", { name: "Preview change" }));
    expect(actions?.previewPlanChange).toHaveBeenLastCalledWith({ kind: "hard-weekday", day: 1 });
    await userEvent.click(select);
    await userEvent.click(await screen.findByRole("option", { name: "Weekly duration cap" }));
    expect(screen.queryByRole("combobox", { name: "Weekday" })).toBeNull();
    expect(screen.getByRole("spinbutton", { name: "Weekly limit in hours" })).toHaveValue(3);
    expect(screen.getByRole("spinbutton", { name: "Weekly limit in hours" })).toHaveAttribute(
      "min",
      "0.25",
    );
    expect(screen.getByRole("spinbutton", { name: "Weekly limit in hours" })).toHaveAttribute(
      "step",
      "0.25",
    );
    await userEvent.click(screen.getByRole("button", { name: "Preview change" }));
    expect(actions?.previewPlanChange).toHaveBeenLastCalledWith({
      kind: "weekly-duration",
      hours: 3,
    });
    await userEvent.click(select);
    await userEvent.click(await screen.findByRole("option", { name: "Longest-Workout cap" }));
    expect(screen.getByRole("spinbutton", { name: "Duration limit in minutes" })).toHaveValue(60);
    await userEvent.click(screen.getByRole("button", { name: "Preview change" }));
    expect(actions?.previewPlanChange).toHaveBeenLastCalledWith({
      kind: "longest-workout",
      minutes: 60,
    });
  });

  it("edits FTP in whole watts and disables the field while busy", async () => {
    patchChange({ editorOpen: true });
    render(<PlanChangeCards />);
    await userEvent.click(screen.getByRole("combobox", { name: "Change" }));
    await userEvent.click(await screen.findByRole("option", { name: "Correct FTP" }));
    const field = screen.getByRole("spinbutton", { name: "FTP in watts" });
    expect(field).toHaveValue(220);
    expect(field).toHaveAttribute("step", "1");
    expect(field).toHaveAttribute("min", "1");
    expect(screen.queryByRole("combobox", { name: "Weekday" })).toBeNull();
    await userEvent.clear(field);
    await userEvent.type(field, "245");
    await userEvent.click(screen.getByRole("button", { name: "Preview change" }));
    expect(useEnduragentStore.getState().chatActions?.previewPlanChange).toHaveBeenCalledWith({
      kind: "ftp",
      watts: 245,
    });
    patchChange({ busy: true });
    expect(field).toBeDisabled();
  });

  it("shows watts on either diff side while preserving absent and undated Workouts", () => {
    setChanges([
      change({
        diff: [
          { workoutId: "corrected", before: workout, after: { ...workout, power: 220 } },
          { workoutId: "undone", before: { ...workout, power: 220 }, after: workout },
          { workoutId: "added", before: null, after: { ...workout, date: null, power: 230 } },
          { workoutId: "removed", before: { ...workout, date: null, power: 230 }, after: null },
        ],
      }),
    ]);
    render(<PlanChangeCards />);
    const table = screen.getByRole("table", { name: "Affected individual Workouts" });
    expect(
      within(table)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual([
      "9 Sept 1998 · 60 min → 9 Sept 1998 · 60 min · 220 W",
      "9 Sept 1998 · 60 min · 220 W → 9 Sept 1998 · 60 min",
      "Not in Plan → Undated · 60 min · 230 W",
      "Undated · 60 min · 230 W → Not in Plan",
    ]);
  });

  it.each([true, false])("renders FTP sources with synchronized evidence %s", async (synced) => {
    setChanges([
      change({
        premises: [
          {
            id: "ftp-sources",
            label: "FTP source comparison at this decision",
            source: "Saved profile and synchronized FTP evidence",
            value: {
              acceptedPlanFtp: null,
              requestedFtp: 220,
              candidates: [
                { source: "manual", watts: 210, selected: true },
                ...(synced
                  ? [
                      { source: "intervals-ftp", watts: 205, selected: false },
                      { source: "intervals-eftp", watts: 215, selected: false },
                    ]
                  : []),
              ],
            },
          },
        ],
      }),
    ]);
    render(<PlanChangeCards />);
    await userEvent.click(screen.getByRole("button", { name: "View evidence" }));
    const source = screen.getByRole("region", { name: "Source details" });
    expect(source).toHaveTextContent(
      "FTP source comparison at this decision · Saved profile and synchronized FTP evidence",
    );
    expect(
      within(source)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Saved athlete FTP · 210 W · selected",
      ...(synced ? ["Intervals.icu FTP · 205 W", "Intervals.icu eFTP · 215 W"] : []),
      "Your entry · 220 W",
    ]);
  });

  it("omits an entry when Undo restores an unset FTP and falls back for malformed evidence", async () => {
    setChanges([
      change({
        premises: [
          {
            id: "ftp-sources",
            label: "FTP comparison",
            source: "Stored sources",
            value: {
              acceptedPlanFtp: 220,
              requestedFtp: null,
              candidates: [{ source: "manual", watts: 220, selected: true }],
            },
          },
        ],
      }),
    ]);
    const view = render(<PlanChangeCards />);
    await userEvent.click(screen.getByRole("button", { name: "View evidence" }));
    expect(screen.getByRole("listitem")).toHaveTextContent("Saved athlete FTP · 220 W · selected");
    expect(screen.queryByText(/Your entry/)).toBeNull();
    view.unmount();
    setChanges([
      change({
        premises: [
          {
            id: "ftp-sources",
            label: "FTP comparison unavailable",
            source: "Stored sources",
            value: { candidates: [{ source: "unknown", watts: 200, selected: true }] },
          },
        ],
      }),
    ]);
    render(<PlanChangeCards />);
    await userEvent.click(screen.getByRole("button", { name: "View evidence" }));
    expect(
      within(screen.getByRole("region", { name: "Source details" })).getByRole("cell"),
    ).toHaveTextContent("FTP comparison unavailable");
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("keeps a pending card actionable after FTP sources change", () => {
    setChanges([change({ title: "Correct FTP", intent: { kind: "ftp", watts: 220 } })]);
    patchChange({
      notice: "The FTP sources changed. Request a fresh preview before applying this correction.",
    });
    render(<PlanChangeCards />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "The FTP sources changed. Request a fresh preview before applying this correction.",
    );
    expect(screen.getByText("Pending", { exact: true })).toBeVisible();
    expect(screen.getByRole("button", { name: "View evidence" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Change one thing" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("shows host totals and both null and undated sides with the changed after name", () => {
    setChanges([
      change({
        diff: [
          {
            workoutId: "renamed",
            before: workout,
            after: { ...workout, name: "Easy recovery", minutes: 30 },
          },
          { workoutId: "added", before: null, after: { ...workout, id: "added", date: null } },
          { workoutId: "removed", before: { ...workout, id: "removed", date: null }, after: null },
        ],
      }),
    ]);
    render(<PlanChangeCards />);
    const differences = screen.getByRole("table", { name: "Affected individual Workouts" });
    expect(within(differences).getByText(/Easy recovery/)).toBeVisible();
    expect(within(differences).getAllByText(/Not in Plan/)).toHaveLength(2);
    expect(within(differences).getAllByText(/Undated/)).toHaveLength(2);
    const totals = screen.getByRole("table", { name: "Before and after totals" });
    expect(
      within(totals)
        .getAllByRole("rowheader")
        .map((row) => row.textContent),
    ).toEqual(["Plan totals", "Week 1"]);
    expect(totals).toHaveTextContent("1234 min → 1204 min");
    expect(totals).toHaveTextContent("321 min → 291 min");
    const facts = screen.getByRole("table", { name: "Facts" });
    expect(
      within(facts)
        .getAllByRole("rowheader")
        .map((row) => row.textContent),
    ).toEqual(["Main Goal", "Supporting Events before", "Supporting Events after", "Confidence"]);
    expect(within(facts).getAllByText("None", { exact: true })).toHaveLength(2);
    expect(screen.getByText("Main Goal", { exact: true })).toBeVisible();
    expect(screen.getByText("Confidence", { exact: true })).toBeVisible();
    expect(screen.getByText("Confirmed schedule limits", { exact: true })).toBeVisible();
  });

  it("reads current and historical evidence and differences without mutation actions", async () => {
    setChanges([
      change({ changeId: "old", title: "Earlier limit", status: "superseded" }),
      change(),
    ]);
    render(<PlanChangeCards />);
    await userEvent.click(screen.getByRole("button", { name: "View evidence" }));
    let source = screen.getByRole("region", { name: "Source details" });
    expect(
      within(source).getByRole("rowheader", { name: "Wednesday limit · Your confirmed request" }),
    ).toBeVisible();
    expect(source).toHaveTextContent("Your confirmed request");
    await userEvent.click(within(source).getByRole("button", { name: "Back" }));
    expect(screen.queryByRole("region", { name: "Source details" })).toBeNull();
    expect(screen.getByText("Superseded", { exact: true })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Read historical evidence" }));
    source = screen.getByRole("region", { name: "Source details" });
    await userEvent.click(within(source).getByRole("button", { name: "Back" }));
    await userEvent.click(screen.getByRole("button", { name: "Read this difference" }));
    const history = screen.getByRole("region", { name: "Source details" });
    expect(
      within(history).getByRole("table", { name: "Affected individual Workouts" }),
    ).toBeVisible();
    expect(within(history).queryByRole("button", { name: "Apply to Plan" })).toBeNull();
    expect(within(history).queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("renders unrecognized premise values as their plain labels", async () => {
    const values: PlanChangeModel["premises"][number]["value"][] = [
      null,
      true,
      42,
      "text",
      ["nested"],
      { changeId: "prior-change", title: "Earlier limit" },
      { kind: "weekday-duration", day: "invalid", minutes: 30 },
      { kind: "inverse", changeId: "00000000000000000000000140" },
    ];
    setChanges([
      change({
        premises: values.map((value, index) => ({
          id: `premise-${index}`,
          label: `Evidence ${index}`,
          source: "Your confirmed request",
          value,
        })),
      }),
    ]);
    render(<PlanChangeCards />);
    await userEvent.click(screen.getByRole("button", { name: "View evidence" }));
    const source = screen.getByRole("region", { name: "Source details" });
    expect(
      within(source)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual(values.map((_, index) => `Evidence ${index}`));
  });

  it("moves focus to the editor, back to Change one thing, and to a new preview heading", async () => {
    const actions = stubActions();
    actions.openPlanChangeEditor = vi.fn(() =>
      patchChange({ editorOpen: true, focusRequest: { target: "editor", revision: 1 } }),
    );
    actions.backFromPlanChangeEditor = vi.fn(() =>
      patchChange({ editorOpen: false, focusRequest: { target: "change", revision: 2 } }),
    );
    actions.applyPlanChange = vi.fn(() => {
      setChanges([change({ status: "cancelled" })]);
      patchChange({ busy: true, focusRequest: { target: "change", revision: 4 } });
    });
    useEnduragentStore.setState({ chatActions: actions });
    render(<PlanChangeCards />);
    const entry = screen.getByRole("button", { name: "Change one thing" });
    await userEvent.click(entry);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Change" })).toHaveFocus());
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(entry).toHaveFocus());
    setChanges([change()]);
    patchChange({ focusRequest: { target: "preview", revision: 3 } });
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Limit Wednesday training" })).toHaveFocus(),
    );
    const preview = screen.getByRole("region", { name: "Limit Wednesday training" });
    expect(
      within(preview)
        .getAllByRole("button")
        .slice(-2)
        .map((button) => button.textContent),
    ).toEqual(["Cancel", "Apply to Plan"]);
    await userEvent.click(within(preview).getByRole("button", { name: "Cancel" }));
    expect(actions.applyPlanChange).toHaveBeenCalledWith("cancel");
    expect(entry).toBeDisabled();
    expect(entry).not.toHaveFocus();
    patchChange({ busy: false });
    await waitFor(() => expect(entry).toHaveFocus());
  });

  it.each([
    "Review the exact changes before confirming.",
    "This preview supersedes “Earlier limit”. Training is unchanged until confirmation.",
    "The latest Change is no longer eligible for Undo.",
    "Only training reductions are allowed during this race window. Training is unchanged.",
    "Only training reductions are allowed in the current race window. This Change was not applied.",
    "Change applied locally. Training now matches the confirmed preview.",
    "Change cancelled. Training is unchanged; the preview remains in history.",
    "This preview is stale because the Plan or its sources changed. Request a fresh preview; no training changed.",
    "This preview is no longer pending. Training is unchanged.",
    "This Change could not be applied. Training and the pending preview are unchanged.",
  ])("announces %s", (notice) => {
    patchChange({ notice });
    render(<PlanChangeCards />);
    expect(screen.getByRole("status")).toHaveTextContent(notice);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the request editable alongside the race-window preview notice", () => {
    patchChange({
      editorOpen: true,
      notice:
        "Only training reductions are allowed during this race window. Training is unchanged.",
    });
    render(<PlanChangeCards />);
    expect(screen.getByRole("region", { name: "What needs to change?" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Preview change" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the pending preview alongside the race-window apply notice", () => {
    setChanges([change()]);
    patchChange({
      notice:
        "Only training reductions are allowed in the current race window. This Change was not applied.",
    });
    render(<PlanChangeCards />);
    expect(screen.getByText("Pending", { exact: true })).toBeVisible();
    expect(screen.getByRole("button", { name: "Apply to Plan" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders parameter errors as alerts and disables submission while busy", () => {
    patchChange({ editorOpen: true, error: "Enter a duration above zero.", busy: true });
    render(<PlanChangeCards />);
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a duration above zero.");
    expect(screen.getByRole("button", { name: "Preview change" })).toBeDisabled();
  });

  it("renders request errors as alerts while the editor is closed", () => {
    patchChange({
      editorOpen: false,
      error: "This request used an older Plan revision. Request a fresh preview.",
    });
    render(<PlanChangeCards />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This request used an older Plan revision. Request a fresh preview.",
    );
  });
  it("renders Supporting Event facts and synchronized evidence", async () => {
    setChanges([
      change({
        title: "Add a Supporting Event",
        intent: {
          kind: "supporting-event",
          operation: "add",
          name: "River ride",
          date: "1998-09-13",
          role: "Training",
          providerId: "17",
        },
        diff: [
          {
            workoutId: "event-workout",
            before: null,
            after: {
              ...workout,
              id: "event-workout",
              supportingEventId: "river",
              name: "River ride",
              date: "1998-09-13",
              kind: "event",
              pinned: true,
            },
          },
        ],
        premises: [
          {
            id: "event-source",
            label: "Supporting Event source at this decision",
            source: "Intervals.icu event",
            value: {
              providerId: "17",
              sourceRevision: "a".repeat(64),
              name: "River ride",
              date: "1998-09-13",
              category: "RACE_B",
            },
          },
        ],
      }),
    ]);
    render(<PlanChangeCards />);
    const facts = screen.getByRole("table", { name: "Facts" });
    expect(facts).toHaveTextContent("Supporting Events beforeNone");
    expect(facts).toHaveTextContent("Supporting Events afterRiver ride · 13 Sept 1998 · Training");
    await userEvent.click(screen.getByRole("button", { name: "View evidence" }));
    const source = screen.getByRole("region", { name: "Source details" });
    expect(source).toHaveTextContent("Intervals.icu event");
    expect(source).toHaveTextContent("River ride · 13 Sept 1998 · RACE_B");
  });

  it("selects a synchronized candidate from the library and keeps manual entry available", async () => {
    const value = useEnduragentStore.getState().planLibrary.value;
    if (!value) throw new Error("Missing library");
    useEnduragentStore.setState({
      planLibrary: {
        status: "ready",
        value: {
          ...value,
          calendarConnected: true,
          active: {
            ...active,
            supportingEventCandidates: [
              {
                providerId: "17",
                name: "River ride",
                date: "1998-09-13",
                category: "RACE_B",
                sourceLabel: "Intervals.icu event",
              },
            ],
          },
        },
      },
    });
    patchChange({ editorOpen: true });
    render(<PlanChangeCards />);
    await userEvent.click(screen.getByRole("combobox", { name: "Change" }));
    await userEvent.click(await screen.findByRole("option", { name: "Supporting Event" }));
    await userEvent.click(screen.getByRole("combobox", { name: "Synchronized event" }));
    expect(await screen.findByRole("option", { name: "Manual entry" })).toBeVisible();
    await userEvent.click(screen.getByRole("option", { name: "River ride · Intervals.icu event" }));
    await userEvent.click(screen.getByRole("button", { name: "Preview change" }));
    expect(useEnduragentStore.getState().chatActions?.previewPlanChange).toHaveBeenLastCalledWith({
      kind: "supporting-event",
      operation: "add",
      name: "River ride",
      date: "1998-09-13",
      role: "Training",
      providerId: "17",
    });
  });

  it("submits manual event fields through the shared editor and shows validation inline", async () => {
    patchChange({ editorOpen: true, error: "Choose a Supporting Event inside this Plan span." });
    render(<PlanChangeCards />);
    await userEvent.click(screen.getByRole("combobox", { name: "Change" }));
    await userEvent.click(await screen.findByRole("option", { name: "Supporting Event" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Event name" }), "River ride");
    const date = screen.getByLabelText("Event date");
    expect(date).toHaveAttribute("type", "date");
    await userEvent.type(date, "1998-09-13");
    await userEvent.click(screen.getByRole("button", { name: "Preview change" }));
    expect(useEnduragentStore.getState().chatActions?.previewPlanChange).toHaveBeenLastCalledWith({
      kind: "supporting-event",
      operation: "add",
      name: "River ride",
      date: "1998-09-13",
      role: "Training",
    });
    expect(
      within(screen.getByRole("region", { name: "What needs to change?" })).getByRole("alert"),
    ).toHaveTextContent("Choose a Supporting Event inside this Plan span.");
  });
});
