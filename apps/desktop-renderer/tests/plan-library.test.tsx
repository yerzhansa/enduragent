import type {
  LegacyPlanSummary,
  ListPlansResult,
  PlanCreationCardModel,
  PlanHistoryResult,
  PlanCloseResult,
} from "@enduragent/coach-contract";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { lazy, Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPlanController } from "../src/plan/controller";
import { requestPlanCalendarRetry, subscribePlanLibraryRefresh } from "../src/plan/library-refresh";
import { EMPTY_CHAT_SURFACE, type ChatActions } from "../src/state/chat-slice";
import { EMPTY_PLAN_SURFACE, type PlanActions } from "../src/state/plan-slice";
import { useEnduragentStore } from "../src/state/store";
import { PlanLibrary } from "../src/ui/plan/PlanLibrary";
import { PlanView } from "../src/ui/plan/PlanView";
import { planCreationDraft } from "./plan-creation-draft-fixtures";
import { planReadModel } from "./plan-fixtures";

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

function stubPlanActions(): PlanActions {
  return {
    open: vi.fn(),
    startPlan: vi.fn(),
    closeCoach: vi.fn(),
    submitCoach: vi.fn(async () => true),
    stopCoach: vi.fn(),
    removeQueuedCoachMessage: vi.fn(),
    retryQueuedCoachTurn: vi.fn(),
    answerCoachDecision: vi.fn(),
    skipCoachDecision: vi.fn(),
    saveFtp: vi.fn(),
    refreshFtp: vi.fn(),
    backToCoachInterview: vi.fn(),
    createDraft: vi.fn(),
    updateDraft: vi.fn(),
    openDiscardConfirmation: vi.fn(),
    closeDiscardConfirmation: vi.fn(),
    discardDraft: vi.fn(),
    openRevisionComposer: vi.fn(),
    closeRevisionComposer: vi.fn(),
    openCoursePicker: vi.fn(),
    closeCoursePicker: vi.fn(),
    chooseCourseFile: vi.fn(),
    continueWithoutCourse: vi.fn(),
    useCourseWithoutElevation: vi.fn(),
    removeCourse: vi.fn(),
    openDatePicker: vi.fn(),
    closeDatePicker: vi.fn(),
    recalculateStartDate: vi.fn(),
    approveDraft: vi.fn(),
    openReplacement: vi.fn(),
    closeReplacementConfirmation: vi.fn(),
    confirmReplacement: vi.fn(),
    retryReplacementCleanup: vi.fn(),
    verifyReplacementCleanup: vi.fn(),
    writeReplacementMirror: vi.fn(),
    openReplacementActivePlan: vi.fn(),
    reconcilePlan: vi.fn(),
    verifyReconciliation: vi.fn(),
    openSeason: vi.fn(),
    openReadiness: vi.fn(),
    closeReadiness: vi.fn(),
    refreshReadiness: vi.fn(),
    closeSeason: vi.fn(),
    openRaceWeek: vi.fn(),
    closeRaceWeek: vi.fn(),
    openWorkout: vi.fn(),
    closeWorkout: vi.fn(),
    resolveWorkoutMatch: vi.fn(),
    resolveWorkoutDrift: vi.fn(),
    openProposal: vi.fn(),
    closeProposal: vi.fn(),
    reviseProposal: vi.fn(),
    approveProposal: vi.fn(),
    rejectProposal: vi.fn(),
    openHistory: vi.fn(),
    closeHistory: vi.fn(),
    undoPlanChange: vi.fn(),
    openPlanSettings: vi.fn(),
    closePlanSettings: vi.fn(),
    setPlanSetting: vi.fn(),
    openEndConfirmation: vi.fn(),
    closeEndConfirmation: vi.fn(),
    confirmEndPlan: vi.fn(),
    retryPlanCleanup: vi.fn(),
    verifyPlanCleanup: vi.fn(),
    openRaceOutcome: vi.fn(),
    recordRaceOutcome: vi.fn(),
    openEndedConversation: vi.fn(),
    closeEndedConversation: vi.fn(),
    openAttention: vi.fn(),
    resolvePlanningRequestDate: vi.fn(),
    returnToCoach: vi.fn(),
    retry: vi.fn(),
  };
}

const creation: PlanCreationCardModel = {
  creationId: "creation-library",
  version: 1,
  status: "in-progress",
  readiness: "incomplete",
  draft: null,
  draftStale: false,
  commitmentsAcknowledgement: null,
  answeredSummaries: [],
  openQuestion: {
    kind: "goal-question",
    step: { current: 1, total: 9 },
    prompt: "What are you training for?",
    candidates: [],
    eventNotListedOption: {
      label: "Event not listed",
      detail: "Add your event.",
      editorLabel: "Event",
      placeholder: "Event name",
      nameLabel: "Name",
      dateLabel: "Date",
    },
    fitnessOption: { label: "General fitness", detail: "Build fitness." },
    authoredOption: {
      label: "Something else",
      detail: "Name an event.",
      editorLabel: "Event",
      placeholder: "Event name",
    },
  },
};
const active: NonNullable<ListPlansResult["active"]> = {
  planId: "active-library",
  version: 1,
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
const closed: ListPlansResult["closed"] = [
  {
    ...active,
    planId: "closed-recent",
    name: "Summer fitness",
    status: "closed",
    closedAt: "1998-09-06",
    closeReason: "completed",
  },
  {
    ...active,
    planId: "closed-older",
    name: "Spring fitness",
    status: "closed",
    closedAt: "1998-08-01",
    closeReason: "stopped",
  },
];
const combinations = [false, true].flatMap((hasCreation) =>
  [false, true].flatMap((hasActive) =>
    [false, true].map((hasClosed) => ({ hasCreation, hasActive, hasClosed })),
  ),
);

beforeEach(() => {
  useEnduragentStore.getState().setPlanCloseAttempt(null);
  useEnduragentStore.setState({
    chat: { ...EMPTY_CHAT_SURFACE, planCreation: creation },
    chatActions: stubActions(),
    plan: EMPTY_PLAN_SURFACE,
    planActions: null,
    planLibrary: { status: "loading", value: null },
    planLibraryActions: {
      closePlan: vi.fn(async (): Promise<PlanCloseResult> => ({
        status: "closed",
        planId: active.planId,
        closedAt: 904435200000,
        cleanupJobId: "cleanup-job",
      })),
      readPlanHistory: vi.fn(async () => null),
      refresh: vi.fn(async () => {}),
      startCreation: vi.fn(),
      continueCreation: vi.fn(),
      changeInChat: vi.fn(),
    },
    planningReadActions: null,
  });
});

describe("Plan library", () => {
  it("renders no extra card when the legacy summary is absent", () => {
    render(
      <PlanLibrary
        library={{
          calendarConnected: false,
          legacy: null,
          creation: null,
          active,
          closed,
          changesPaused: null,
          changes: [],
        }}
        readDetails={vi.fn()}
        readFinalDetails={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("region", { name: "Closed Plan" })).toHaveLength(closed.length);
    expect(screen.queryByText("Read only · Saved before Plans moved to Chat")).toBeNull();
  });

  it.each([1, 8])("renders the full legacy summary with %i weeks after closed Plans", (weeks) => {
    const legacy: LegacyPlanSummary = {
      name: "Earlier endurance training",
      goal: "Ride comfortably for four hours",
      weeks,
      sourceStatus: "active",
      createdAt: "1998-07-06",
      targetDate: "1998-08-30",
      readOnly: true,
      source: "current-plan.json",
    };
    render(
      <PlanLibrary
        library={{
          calendarConnected: false,
          legacy,
          creation,
          active,
          closed,
          changes: [],
          changesPaused: null,
        }}
        readDetails={vi.fn()}
        readFinalDetails={vi.fn()}
      />,
    );
    const cards = screen.getAllByRole("region", { name: "Closed Plan" });
    expect(cards).toHaveLength(closed.length + 1);
    const card = cards[cards.length - 1];
    if (card === undefined) throw new Error("Legacy card is missing");
    expect(within(card).getByText("Closed Plan", { exact: true })).toBeVisible();
    expect(within(card).getByRole("heading", { name: legacy.name })).toBeVisible();
    expect(within(card).getByText("Closed", { exact: true })).toBeVisible();
    expect(
      within(card).getByText(
        `Target 30 Aug 1998 · ${weeks} ${weeks === 1 ? "week" : "weeks"} · Goal: Ride comfortably for four hours · Unknown reason`,
        { exact: true },
      ),
    ).toBeVisible();
    expect(
      within(card).getByText("Read only · Saved before Plans moved to Chat", { exact: true }),
    ).toBeVisible();
    expect(within(card).queryByRole("button")).toBeNull();
    expect(within(card).queryByRole("link")).toBeNull();
    expect(card).not.toHaveTextContent("6 Jul 1998");
  });

  it("renders only Unknown reason in the summary when only the legacy name is known", () => {
    render(
      <PlanLibrary
        library={{
          calendarConnected: false,
          legacy: {
            name: "Earlier training",
            goal: null,
            weeks: null,
            sourceStatus: null,
            createdAt: null,
            targetDate: null,
            readOnly: true,
            source: "current-plan.json",
          },
          creation: null,
          active: null,
          closed: [],
          changesPaused: null,
          changes: [],
        }}
        readDetails={vi.fn()}
        readFinalDetails={vi.fn()}
      />,
    );
    const card = screen.getByRole("region", { name: "Closed Plan" });
    expect(within(card).getByRole("heading", { name: "Earlier training" })).toBeVisible();
    expect(within(card).getByText("Unknown reason", { exact: true })).toBeVisible();
    expect(
      within(card).getByText("Read only · Saved before Plans moved to Chat", { exact: true }),
    ).toBeVisible();
    expect(within(card).queryByRole("button")).toBeNull();
  });

  it.each([
    [
      {
        status: "verified",
        window: { start: "1998-09-07", end: "1998-09-13" },
        currentThrough: "1998-09-13",
        error: null,
      },
      "Calendar · 7 Sept 1998 to 13 Sept 1998 · Up to date",
    ],
    [
      {
        status: "pending",
        window: { start: "1998-09-07", end: "1998-09-13" },
        currentThrough: null,
        error: null,
      },
      "Calendar · Updating calendar",
    ],
    [
      {
        status: "running",
        window: { start: "1998-09-07", end: "1998-09-13" },
        currentThrough: null,
        error: null,
      },
      "Calendar · Updating calendar",
    ],
    [
      { status: "pending", window: null, currentThrough: null, error: null },
      "Calendar · Local only",
    ],
    [
      { status: "not-connected", window: null, currentThrough: null, error: null },
      "Calendar · Connect to mirror Workouts",
    ],
    [
      {
        status: "failed",
        window: null,
        currentThrough: null,
        error: "Calendar sync failed. Retry available.",
      },
      "Calendar sync failed. Retry available.",
    ],
    [
      { status: "failed", window: null, currentThrough: null, error: "Calendar sync failed." },
      "Calendar sync failed.",
    ],
    [
      {
        status: "failed",
        window: null,
        currentThrough: null,
        error: "Retry available. No attempts remain.",
      },
      "Calendar sync failed.",
    ],
  ] satisfies Array<[NonNullable<ListPlansResult["active"]>["calendar"], string]>)(
    "renders calendar %j",
    (calendar, copy) => {
      render(
        <PlanLibrary
          library={{
            calendarConnected: false,
            legacy: null,
            creation: null,
            active: { ...active, calendar },
            closed,
            changesPaused: null,
            changes: [],
          }}
          readDetails={vi.fn()}
          readFinalDetails={vi.fn()}
        />,
      );
      const card = screen.getByRole("region", { name: "Active Plan" });
      expect(
        within(card).getByRole(calendar.status === "failed" ? "alert" : "status"),
      ).toHaveTextContent(copy);
      const retry = within(card).queryByRole("button", { name: "Retry calendar" });
      if (calendar.status === "failed" && calendar.error.endsWith("Retry available.")) {
        expect(retry).toBeVisible();
        fireEvent.click(within(card).getByRole("button", { name: "Retry calendar" }));
        expect(useEnduragentStore.getState().planLibraryActions?.refresh).toHaveBeenCalledOnce();
      } else expect(retry).toBeNull();
      for (const card of screen.getAllByRole("region", { name: "Closed Plan" })) {
        expect(card).not.toHaveTextContent("Calendar");
      }
    },
  );

  it("shows the stale creation notice on the library", () => {
    const notice =
      "This creation is no longer unfinished. Open the Plan library for its current result.";
    useEnduragentStore.setState({
      chat: { ...EMPTY_CHAT_SURFACE, notice },
      planLibrary: {
        status: "ready",
        value: {
          calendarConnected: false,
          legacy: null,
          creation: null,
          active,
          closed,
          changesPaused: null,
          changes: [],
        },
      },
    });
    render(<PlanView />);
    expect(screen.getByText(notice, { exact: true })).toBeVisible();
    expect(screen.getByRole("region", { name: "Plan library" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Continue in Chat" })).toBeNull();
  });

  it.each(combinations)(
    "renders creation=$hasCreation active=$hasActive closed=$hasClosed in library order",
    ({ hasCreation, hasActive, hasClosed }) => {
      const library: ListPlansResult = {
        calendarConnected: false,
        legacy: null,
        creation: hasCreation ? creation : null,
        active: hasActive ? active : null,
        closed: hasClosed ? closed : [],
        changesPaused: null,
        changes: [],
      };
      useEnduragentStore.setState({ planLibrary: { status: "ready", value: library } });
      render(<PlanView />);
      const section = screen.getByRole("region", { name: "Plan library" });
      expect(
        within(section)
          .getAllByRole("heading")
          .map((heading) => heading.textContent),
      ).toEqual([
        ...(hasCreation ? ["New Plan"] : []),
        hasActive ? "Build steady power" : "No active Plan",
        ...(hasClosed ? ["Summer fitness", "Spring fitness"] : []),
      ]);
      if (hasCreation) {
        const card = within(section).getByRole("region", { name: "Plan creation" });
        expect(within(card).getByText("In progress")).toBeVisible();
        expect(
          within(card).getByText(
            `0 of 9 answered. ${hasActive ? "Build steady power keeps running." : "No Plan is active."}`,
          ),
        ).toBeVisible();
        expect(
          within(card)
            .getAllByRole("button")
            .map((button) => button.textContent),
        ).toEqual(["Discard", "Continue in Chat"]);
        expect(screen.queryByRole("button", { name: /^Start a (new )?Plan$/ })).toBeNull();
      } else {
        const start = screen.getByRole("button", {
          name: hasActive ? "Start a new Plan" : "Start a Plan",
        });
        fireEvent.click(start);
        expect(
          useEnduragentStore.getState().planLibraryActions?.startCreation,
        ).toHaveBeenCalledOnce();
      }
      if (hasActive) {
        const card = within(section).getByRole("region", { name: "Active Plan" });
        expect(within(card).getByText("7 Sept 1998 to 4 Oct 1998 · 4 weeks")).toBeVisible();
        expect(within(card).getByText("Active", { exact: true })).toBeVisible();
        expect(
          within(card)
            .getAllByRole("button")
            .map((button) => button.textContent),
        ).toEqual(["Stop Plan", "Read Plan details", "Change in Chat"]);
      } else {
        expect(within(section).getByText("Create a Plan when you are ready.")).toBeVisible();
      }
      if (hasClosed) {
        const cards = within(section).getAllByRole("region", { name: "Closed Plan" });
        expect(
          within(cards[0]!).getByText("7 Sept 1998 to 4 Oct 1998 · 4 weeks · Completed"),
        ).toBeVisible();
        expect(
          within(cards[1]!).getByText("7 Sept 1998 to 4 Oct 1998 · 4 weeks · Stopped"),
        ).toBeVisible();
        for (const card of cards)
          expect(within(card).getByRole("button", { name: "Read final details" })).toBeVisible();
      }
      expect(screen.queryAllByRole("button", { name: "Read final details" })).toHaveLength(
        hasClosed ? closed.length : 0,
      );
    },
  );

  it("dispatches each library action with the current creation", () => {
    const readDetails = vi.fn();
    render(
      <PlanLibrary
        readFinalDetails={vi.fn()}
        library={{
          calendarConnected: false,
          legacy: null,
          creation,
          active,
          closed,
          changes: [],
          changesPaused: null,
        }}
        readDetails={readDetails}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(
      useEnduragentStore.getState().chatActions?.openPlanCreationDiscard,
    ).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Continue in Chat" }));
    expect(useEnduragentStore.getState().planLibraryActions?.continueCreation).toHaveBeenCalledWith(
      creation,
    );
    fireEvent.click(screen.getByRole("button", { name: "Change in Chat" }));
    expect(useEnduragentStore.getState().planLibraryActions?.changeInChat).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Read Plan details" }));
    expect(readDetails).toHaveBeenCalledOnce();
  });

  it.each([
    ["continue", "Continue in Chat"],
    ["change", "Change in Chat"],
  ] as const)("restores the %s control after returning from Chat", async (target, label) => {
    const library = {
      calendarConnected: false,
      legacy: null,
      creation,
      active,
      closed,
      changesPaused: null,
      changes: [],
    };
    const view = render(
      <PlanLibrary library={library} readDetails={vi.fn()} readFinalDetails={vi.fn()} />,
    );
    view.unmount();
    useEnduragentStore.setState({
      chat: {
        ...useEnduragentStore.getState().chat,
        planCreationFocusRequest: { target, libraryTarget: target, revision: 2 },
      },
    });
    render(<PlanLibrary library={library} readDetails={vi.fn()} readFinalDetails={vi.fn()} />);
    await vi.waitFor(() => expect(screen.getByRole("button", { name: label })).toHaveFocus());
  });

  it("shows Paused only for the matching creation and Draft takes precedence", () => {
    useEnduragentStore.setState({
      chat: { ...EMPTY_CHAT_SURFACE, planCreation: creation, planCreationPaused: true },
    });
    const view = render(
      <PlanLibrary
        readFinalDetails={vi.fn()}
        library={{
          calendarConnected: false,
          legacy: null,
          creation,
          active: null,
          closed: [],
          changesPaused: null,
          changes: [],
        }}
        readDetails={vi.fn()}
      />,
    );
    expect(screen.getByText("Paused")).toBeVisible();
    view.rerender(
      <PlanLibrary
        readFinalDetails={vi.fn()}
        library={{
          calendarConnected: false,
          legacy: null,
          creation: { ...creation, draft: planCreationDraft() },
          active: null,
          closed: [],
          changesPaused: null,
          changes: [],
        }}
        readDetails={vi.fn()}
      />,
    );
    expect(screen.getByText("Draft")).toBeVisible();
    expect(screen.queryByText("Paused")).toBeNull();
  });

  it("preserves readable cards with an explicit retry on failure", () => {
    const refresh = vi.fn();
    const library: ListPlansResult = {
      calendarConnected: false,
      legacy: null,
      creation: null,
      active,
      closed,
      changesPaused: null,
      changes: [],
    };
    useEnduragentStore.setState({
      planLibrary: { status: "ready", value: library },
      planningReadActions: {
        refresh,
        openFromChat: vi.fn(),
        backToChat: vi.fn(),
        returnToChatRequest: vi.fn(),
      },
    });
    render(<PlanView />);
    expect(refresh).not.toHaveBeenCalled();
    act(() =>
      useEnduragentStore.setState({ planLibrary: { status: "unavailable", value: library } }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Plan library could not load. Try again.");
    expect(screen.getByRole("heading", { name: "Summer fitness" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it.each(["navigation", "relaunch"] as const)(
    "lists once on %s before a lazy mount, then once per refresh and reopen",
    async (entry) => {
      const store = useEnduragentStore;
      store.setState({ activeView: entry === "relaunch" ? "plan" : "chat" });
      const listPlans = vi.fn(async (): Promise<ListPlansResult> => ({
        calendarConnected: false,
        legacy: null,
        creation,
        active,
        closed,
        changesPaused: null,
        changes: [],
      }));
      const controller = createPlanController({
        listPlans,
        read: async () => ({
          schemaVersion: 1,
          status: "no-plan",
          asOfDateKey: 19980907,
          plan: null,
        }),
        renderLibrary: (next) => store.getState().setPlanLibrary(next),
        render: (next) => store.getState().setPlanSurface(next),
        navigate: (view) => store.getState().setActiveView(view),
        focus: (target, returnToChat) => store.getState().setPlanFocus(target, returnToChat),
      });
      store.getState().bindPlanningReadActions({
        refresh: () => void controller.refresh(),
        openFromChat: controller.openFromChat,
        backToChat: controller.backToChat,
        returnToChatRequest: vi.fn(),
      });
      const unsubscribe = subscribePlanLibraryRefresh(controller);
      let mountView!: (module: { default: typeof PlanView }) => void;
      const viewModule = new Promise<{ default: typeof PlanView }>((resolve) => {
        mountView = resolve;
      });
      const LazyPlanView = lazy(() => viewModule);
      try {
        if (entry === "relaunch") await controller.start();
        else {
          store.getState().setActiveView("plan");
          await vi.waitFor(() => expect(store.getState().planLibrary.status).toBe("ready"));
        }
        expect(listPlans).toHaveBeenCalledOnce();
        const view = render(
          <Suspense fallback={<div>Loading Plan view</div>}>
            <LazyPlanView />
          </Suspense>,
        );
        expect(screen.getByText("Loading Plan view")).toBeVisible();
        await act(async () => mountView({ default: PlanView }));
        expect(screen.getByRole("region", { name: "Plan library" })).toBeVisible();
        expect(listPlans).toHaveBeenCalledOnce();
        await act(async () =>
          store.setState({
            chat: {
              ...store.getState().chat,
              planCreation: structuredClone(creation),
              planCreationLoaded: true,
            },
          }),
        );
        expect(listPlans).toHaveBeenCalledOnce();

        await act(async () => store.getState().planningReadActions?.refresh());
        expect(listPlans).toHaveBeenCalledTimes(2);

        view.unmount();
        store.getState().setActiveView("chat");
        await act(async () => store.getState().setActiveView("plan"));
        render(<PlanView />);
        expect(listPlans).toHaveBeenCalledTimes(3);
      } finally {
        unsubscribe();
        controller.dispose();
      }
    },
  );
});

describe("Plan library refresh subscription", () => {
  function watchRefresh() {
    const refresh = vi.fn(async () => {});
    const unsubscribe = subscribePlanLibraryRefresh({
      refresh,
      start: vi.fn(async () => {}),
      openFromChat: vi.fn(),
      backToChat: vi.fn(),
      dispose: vi.fn(),
    });
    return { refresh, unsubscribe };
  }

  it("polls in-progress calendar work every four seconds and stops after twenty refreshes", async () => {
    vi.useFakeTimers();
    useEnduragentStore.setState({
      activeView: "plan",
      planLibrary: {
        status: "ready",
        value: {
          calendarConnected: false,
          legacy: null,
          creation,
          active,
          closed,
          changes: [],
          changesPaused: null,
        },
      },
    });
    const refresh = vi.fn(async () => {
      useEnduragentStore.getState().setPlanLibrary({
        status: "ready",
        value: {
          calendarConnected: false,
          legacy: null,
          creation,
          active: { ...active, calendar: { ...active.calendar, status: "running" } },
          closed,
          changesPaused: null,
          changes: [],
        },
      });
    });
    const unsubscribe = subscribePlanLibraryRefresh(
      { refresh, start: refresh, dispose: vi.fn(), openFromChat: vi.fn(), backToChat: vi.fn() },
      { setTimeout, clearTimeout },
    );
    try {
      await vi.advanceTimersByTimeAsync(3_999);
      expect(refresh).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(refresh).toHaveBeenCalledExactlyOnceWith(true, expect.any(Function));
      await vi.advanceTimersByTimeAsync(4_000 * 30);
      expect(refresh).toHaveBeenCalledTimes(20);
      expect(vi.getTimerCount()).toBe(0);
      useEnduragentStore.getState().setActiveView("chat");
      useEnduragentStore.getState().setActiveView("plan");
      await vi.advanceTimersByTimeAsync(4_000);
      expect(refresh).toHaveBeenCalledTimes(22);
    } finally {
      unsubscribe();
      vi.useRealTimers();
    }
  });

  it.each(["leave", "settle", "unsubscribe"])("cancels calendar polling on %s", async (end) => {
    vi.useFakeTimers();
    useEnduragentStore.setState({
      activeView: "plan",
      planLibrary: {
        status: "ready",
        value: {
          calendarConnected: false,
          legacy: null,
          creation,
          active,
          closed,
          changes: [],
          changesPaused: null,
        },
      },
    });
    const { refresh, unsubscribe } = watchRefresh();
    try {
      await vi.advanceTimersByTimeAsync(4_000);
      expect(refresh).toHaveBeenCalledOnce();
      if (end === "leave") useEnduragentStore.getState().setActiveView("chat");
      else if (end === "settle")
        useEnduragentStore.getState().setPlanLibrary({
          status: "ready",
          value: {
            calendarConnected: false,
            legacy: null,
            creation,
            active: {
              ...active,
              calendar: {
                status: "verified",
                window: null,
                currentThrough: "1998-09-13",
                error: null,
              },
            },
            closed,
            changesPaused: null,
            changes: [],
          },
        });
      else unsubscribe();
      await vi.advanceTimersByTimeAsync(40_000);
      expect(refresh).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      unsubscribe();
      vi.useRealTimers();
    }
  });

  it("polls failed retry snapshots through running to verified", async () => {
    vi.useFakeTimers();
    const failed: ListPlansResult = {
      calendarConnected: true,
      legacy: null,
      creation: null,
      closed: [],
      changesPaused: null,
      changes: [],
      active: {
        ...active,
        calendar: {
          status: "failed",
          window: null,
          currentThrough: null,
          error: "Retry available.",
        },
      },
    };
    const running: ListPlansResult = {
      ...failed,
      active: { ...active, calendar: { ...active.calendar, status: "running" } },
    };
    const verified: ListPlansResult = {
      ...failed,
      active: {
        ...active,
        calendar: { status: "verified", window: null, currentThrough: "1998-09-13", error: null },
      },
    };
    useEnduragentStore.setState({
      activeView: "plan",
      planLibrary: { status: "ready", value: failed },
    });
    const listPlans = vi
      .fn<() => Promise<ListPlansResult>>()
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(running)
      .mockResolvedValue(verified);
    const controller = createPlanController({
      listPlans,
      read: async () => ({
        schemaVersion: 1,
        status: "no-plan",
        asOfDateKey: 19980907,
        plan: null,
      }),
      renderLibrary: (value) => useEnduragentStore.getState().setPlanLibrary(value),
      render: vi.fn(),
      navigate: vi.fn(),
      focus: vi.fn(),
    });
    const actions = useEnduragentStore.getState().planLibraryActions;
    if (!actions) throw new Error("Missing library actions");
    useEnduragentStore.setState({
      planLibraryActions: { ...actions, refresh: () => controller.refresh() },
    });
    const unsubscribe = subscribePlanLibraryRefresh(controller);
    try {
      render(<PlanLibrary library={failed} readDetails={vi.fn()} readFinalDetails={vi.fn()} />);
      await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Retry calendar" })),
      );
      expect(useEnduragentStore.getState().planLibrary.value?.active?.calendar.status).toBe(
        "failed",
      );
      await vi.advanceTimersByTimeAsync(4_000);
      expect(useEnduragentStore.getState().planLibrary.value?.active?.calendar.status).toBe(
        "running",
      );
      await vi.advanceTimersByTimeAsync(4_000);
      expect(useEnduragentStore.getState().planLibrary.value?.active?.calendar.status).toBe(
        "verified",
      );
      await vi.advanceTimersByTimeAsync(80_000);
      expect(listPlans).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      unsubscribe();
      controller.dispose();
      vi.useRealTimers();
    }
  });

  it("keeps polling a retryable failure that follows a running snapshot until it verifies", async () => {
    vi.useFakeTimers();
    const running: ListPlansResult = {
      calendarConnected: true,
      legacy: null,
      creation: null,
      closed: [],
      changesPaused: null,
      changes: [],
      active: {
        ...active,
        calendar: { status: "running", window: null, currentThrough: null, error: null },
      },
    };
    const failed: ListPlansResult = {
      ...running,
      active: {
        ...active,
        calendar: {
          status: "failed",
          window: null,
          currentThrough: null,
          error: "Calendar sync failed. Retry available.",
        },
      },
    };
    const verified: ListPlansResult = {
      ...running,
      active: {
        ...active,
        calendar: { status: "verified", window: null, currentThrough: "1998-09-13", error: null },
      },
    };
    useEnduragentStore.setState({
      activeView: "plan",
      planLibrary: { status: "ready", value: running },
    });
    const listPlans = vi
      .fn<() => Promise<ListPlansResult>>()
      .mockResolvedValueOnce(failed)
      .mockResolvedValue(verified);
    const controller = createPlanController({
      listPlans,
      read: async () => ({
        schemaVersion: 1,
        status: "no-plan",
        asOfDateKey: 19980907,
        plan: null,
      }),
      renderLibrary: (value) => useEnduragentStore.getState().setPlanLibrary(value),
      render: vi.fn(),
      navigate: vi.fn(),
      focus: vi.fn(),
    });
    const unsubscribe = subscribePlanLibraryRefresh(controller);
    try {
      await vi.advanceTimersByTimeAsync(4_000);
      expect(useEnduragentStore.getState().planLibrary.value?.active?.calendar.status).toBe(
        "failed",
      );
      await vi.advanceTimersByTimeAsync(4_000);
      expect(useEnduragentStore.getState().planLibrary.value?.active?.calendar.status).toBe(
        "verified",
      );
      await vi.advanceTimersByTimeAsync(80_000);
      expect(listPlans).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      unsubscribe();
      controller.dispose();
      vi.useRealTimers();
    }
  });

  it("limits a retry that keeps returning failed to twenty polling refreshes", async () => {
    vi.useFakeTimers();
    useEnduragentStore.setState({
      activeView: "plan",
      planLibrary: {
        status: "ready",
        value: {
          calendarConnected: false,
          legacy: null,
          creation: null,
          closed: [],
          changesPaused: null,
          changes: [],
          active: {
            ...active,
            calendar: {
              status: "failed",
              window: null,
              currentThrough: null,
              error: "Retry available.",
            },
          },
        },
      },
    });
    const { refresh, unsubscribe } = watchRefresh();
    try {
      requestPlanCalendarRetry(active.planId);
      await vi.advanceTimersByTimeAsync(4_000 * 30);
      expect(refresh).toHaveBeenCalledTimes(20);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      unsubscribe();
      vi.useRealTimers();
    }
  });

  it.each(["leave", "settle", "unsubscribe", "dispose"])(
    "cancels a queued polling request on %s",
    async (end) => {
      vi.useFakeTimers();
      const library: ListPlansResult = {
        calendarConnected: false,
        legacy: null,
        creation: null,
        active,
        closed: [],
        changesPaused: null,
        changes: [],
      };
      useEnduragentStore.setState({
        activeView: "plan",
        planLibrary: { status: "ready", value: library },
      });
      let resolveLibrary: (value: ListPlansResult) => void = () => {};
      const delayed = new Promise<ListPlansResult>((resolve) => {
        resolveLibrary = resolve;
      });
      const listPlans = vi.fn(() => delayed);
      const controller = createPlanController({
        listPlans,
        read: async () => ({
          schemaVersion: 1,
          status: "no-plan",
          asOfDateKey: 19980907,
          plan: null,
        }),
        renderLibrary: (value) => useEnduragentStore.getState().setPlanLibrary(value),
        render: vi.fn(),
        navigate: vi.fn(),
        focus: vi.fn(),
      });
      const unsubscribe = subscribePlanLibraryRefresh(controller);
      const initial = controller.refresh();
      try {
        await vi.advanceTimersByTimeAsync(4_000);
        expect(listPlans).toHaveBeenCalledOnce();
        if (end === "leave") useEnduragentStore.getState().setActiveView("chat");
        if (end === "unsubscribe") unsubscribe();
        if (end === "dispose") controller.dispose();
        resolveLibrary(
          end === "settle"
            ? {
                ...library,
                active: {
                  ...active,
                  calendar: {
                    status: "verified",
                    window: null,
                    currentThrough: "1998-09-13",
                    error: null,
                  },
                },
              }
            : library,
        );
        await initial;
        await vi.advanceTimersByTimeAsync(0);
        expect(listPlans).toHaveBeenCalledOnce();
      } finally {
        unsubscribe();
        controller.dispose();
        vi.useRealTimers();
      }
    },
  );

  it("does not reread when Chat hydrates the creation already in the library", () => {
    useEnduragentStore.setState({
      chat: { ...EMPTY_CHAT_SURFACE, planCreation: null },
      planLibrary: {
        status: "ready",
        value: {
          calendarConnected: false,
          legacy: null,
          creation,
          active,
          closed,
          changes: [],
          changesPaused: null,
        },
      },
    });
    const { refresh, unsubscribe } = watchRefresh();
    try {
      useEnduragentStore.setState({
        chat: {
          ...EMPTY_CHAT_SURFACE,
          planCreation: structuredClone(creation),
          planCreationLoaded: true,
        },
      });
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it("ignores cloned creation objects with the same id and version", () => {
    useEnduragentStore.setState({
      chat: { ...EMPTY_CHAT_SURFACE, planCreation: creation, planCreationLoaded: true },
    });
    const { refresh, unsubscribe } = watchRefresh();
    try {
      useEnduragentStore.setState({
        chat: { ...useEnduragentStore.getState().chat, planCreation: structuredClone(creation) },
      });
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it.each([
    { ...creation, version: creation.version + 1 },
    { ...creation, creationId: "replacement-creation" },
  ])("refreshes once when creation identity changes to $creationId version $version", (next) => {
    useEnduragentStore.setState({
      chat: { ...EMPTY_CHAT_SURFACE, planCreation: creation, planCreationLoaded: true },
      planLibrary: {
        status: "ready",
        value: {
          calendarConnected: false,
          legacy: null,
          creation,
          active,
          closed,
          changes: [],
          changesPaused: null,
        },
      },
    });
    const { refresh, unsubscribe } = watchRefresh();
    try {
      useEnduragentStore.setState({
        chat: { ...useEnduragentStore.getState().chat, planCreation: next },
      });
      expect(refresh).toHaveBeenCalledExactlyOnceWith(true);
    } finally {
      unsubscribe();
    }
  });

  it("ignores active Plan hydration and clones but refreshes once for a different Plan id", () => {
    const model = planReadModel({ lifecycle: "active", planId: active.planId });
    useEnduragentStore.setState({
      planLibrary: {
        status: "ready",
        value: {
          calendarConnected: false,
          legacy: null,
          creation,
          active,
          closed,
          changes: [],
          changesPaused: null,
        },
      },
    });
    const { refresh, unsubscribe } = watchRefresh();
    try {
      useEnduragentStore.setState({
        plan: {
          ...EMPTY_PLAN_SURFACE,
          hydration: { status: "ready", state: model },
          lastReady: model,
        },
      });
      useEnduragentStore.setState({ plan: structuredClone(useEnduragentStore.getState().plan) });
      expect(refresh).not.toHaveBeenCalled();
      const next = { ...model, planId: "replacement-active-plan" };
      useEnduragentStore.setState({
        plan: {
          ...EMPTY_PLAN_SURFACE,
          hydration: { status: "ready", state: next },
          lastReady: next,
        },
      });
      expect(refresh).toHaveBeenCalledExactlyOnceWith(true);
    } finally {
      unsubscribe();
    }
  });

  it("joins the pending startup read when Chat hydrates instead of queuing another read", async () => {
    const store = useEnduragentStore;
    store.setState({
      activeView: "plan",
      chat: { ...EMPTY_CHAT_SURFACE, planCreation: null },
    });
    let resolveResult: (value: ListPlansResult) => void = () => {};
    const result = {
      promise: new Promise<ListPlansResult>((resolve) => {
        resolveResult = resolve;
      }),
      resolve: (value: ListPlansResult) => resolveResult(value),
    };
    const listPlans = vi.fn(() => result.promise);
    const controller = createPlanController({
      listPlans,
      read: async () => ({
        schemaVersion: 1,
        status: "no-plan",
        asOfDateKey: 19980907,
        plan: null,
      }),
      renderLibrary: (next) => store.getState().setPlanLibrary(next),
      render: (next) => store.getState().setPlanSurface(next),
      navigate: (view) => store.getState().setActiveView(view),
      focus: (target, returnToChat) => store.getState().setPlanFocus(target, returnToChat),
    });
    const refresh = vi.spyOn(controller, "refresh");
    const unsubscribe = subscribePlanLibraryRefresh(controller);
    try {
      const started = controller.start();
      store.setState({
        chat: {
          ...EMPTY_CHAT_SURFACE,
          planCreation: structuredClone(creation),
          planCreationLoaded: true,
        },
      });
      expect(refresh).toHaveBeenCalledExactlyOnceWith(false);
      result.resolve({
        calendarConnected: false,
        legacy: null,
        creation,
        active,
        closed,
        changesPaused: null,
        changes: [],
      });
      await started;
      await Promise.all(refresh.mock.results.map((call) => call.value));
      expect(listPlans).toHaveBeenCalledOnce();
      expect(store.getState().planLibrary).toEqual({
        status: "ready",
        value: {
          calendarConnected: false,
          legacy: null,
          creation,
          active,
          closed,
          changes: [],
          changesPaused: null,
        },
      });
    } finally {
      unsubscribe();
      controller.dispose();
    }
  });
});

describe("Plan creation title", () => {
  it.each(["manual", "candidate", "fitness"] as const)(
    "formats the %s goal from its typed answer",
    (kind) => {
      const candidate = {
        candidateId: "01J00000000000000000000000",
        name: "Autumn Hills Ride",
        date: "1998-10-04",
        sourceLabel: "Calendar",
      };
      const question = creation.openQuestion;
      if (question?.kind !== "goal-question") throw new Error("Goal question required");
      const answered: PlanCreationCardModel = {
        ...creation,
        answeredSummaries: [
          {
            answerKey: "goal",
            title: "Goal",
            detail: "Autumn Hills Ride · 1998-10-04",
            source: { kind: "athlete" },
            question: { ...question, candidates: [candidate] },
            answer: {
              kind: "goal",
              goal:
                kind === "fitness"
                  ? { kind: "fitness", outcome: "Build lasting fitness" }
                  : kind === "manual"
                    ? { kind: "event-manual", name: candidate.name, date: candidate.date }
                    : { kind: "event-candidate", candidateId: candidate.candidateId },
            },
          },
        ],
      };
      render(
        <PlanLibrary
          readFinalDetails={vi.fn()}
          library={{
            calendarConnected: false,
            legacy: null,
            creation: answered,
            active: null,
            closed: [],
            changesPaused: null,
            changes: [],
          }}
          readDetails={vi.fn()}
        />,
      );
      expect(
        screen.getByRole("heading", {
          name: kind === "fitness" ? "Build lasting fitness" : "Autumn Hills Ride · 4 Oct 1998",
        }),
      ).toBeVisible();
      expect(screen.getByText("1 of 9 answered. No Plan is active.")).toBeVisible();
    },
  );
});

it("keeps Plan history below the library while a creation occupies the header", () => {
  const planActions = stubPlanActions();
  const model = planReadModel({
    lifecycle: "active",
    scenarioId: "PL-S004",
    projection: "active",
    planId: active.planId,
    data: {
      plan: {
        id: active.planId,
        name: active.name,
        primaryGoal: "Build steady power",
        startDate: active.start,
        targetDate: active.end,
        kind: "full-plan",
        totalWeeks: active.weeks,
        weekStartDay: 1,
        workoutCount: 0,
        plannedDurationS: 0,
      },
      today: "1998-09-07",
      weekIndex: 1,
      todayWorkout: null,
      workouts: [],
    },
  });
  useEnduragentStore.setState({
    plan: { ...EMPTY_PLAN_SURFACE, hydration: { status: "ready", state: model }, lastReady: model },
    planActions,
    planLibrary: {
      status: "ready",
      value: {
        calendarConnected: false,
        legacy: null,
        creation,
        active,
        closed: [],
        changes: [],
        changesPaused: null,
      },
    },
  });
  render(<PlanView />);
  const library = screen.getByRole("region", { name: "Plan library" });
  const history = screen.getByRole("button", { name: "Plan history" });
  expect(within(library).queryByRole("button", { name: "Plan history" })).toBeNull();
  expect(library.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Start a (new )?Plan$/ })).toBeNull();
  fireEvent.click(history);
  expect(planActions.openHistory).toHaveBeenCalledOnce();
});

describe("Stop Plan", () => {
  function renderLibrary() {
    const readFinalDetails = vi.fn();
    render(
      <PlanLibrary
        library={{
          calendarConnected: false,
          legacy: null,
          creation: null,
          active,
          closed,
          changesPaused: null,
          changes: [],
        }}
        readDetails={vi.fn()}
        readFinalDetails={readFinalDetails}
      />,
    );
    return readFinalDetails;
  }

  it("orders active card actions and closed card navigation", () => {
    const readFinalDetails = renderLibrary();
    expect(
      within(screen.getByRole("region", { name: "Active Plan" }))
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Stop Plan", "Read Plan details", "Change in Chat"]);
    fireEvent.click(screen.getAllByRole("button", { name: "Read final details" })[0]!);
    expect(readFinalDetails).toHaveBeenCalledWith("closed-recent");
  });

  it.each(["Cancel", "Escape"])("focuses Cancel and returns focus after %s", async (method) => {
    const user = userEvent.setup();
    renderLibrary();
    const stop = screen.getByRole("button", { name: "Stop Plan" });
    await user.click(stop);
    const dialog = await screen.findByRole("dialog", { name: "Stop this Plan?" });
    expect(
      within(dialog).getByText("Final training stays readable. Calendar cleanup can finish later."),
    ).toBeVisible();
    expect(
      within(dialog)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Cancel", "Stop Plan"]);
    await vi.waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus(),
    );
    if (method === "Escape") await user.keyboard("{Escape}");
    else await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await vi.waitFor(() => expect(stop).toHaveFocus());
    expect(useEnduragentStore.getState().planLibraryActions?.closePlan).not.toHaveBeenCalled();
  });

  it("closes with the displayed version, refreshes and opens final details", async () => {
    const readFinalDetails = renderLibrary();
    fireEvent.click(screen.getByRole("button", { name: "Stop Plan" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Stop Plan" }),
    );
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const actions = useEnduragentStore.getState().planLibraryActions;
    expect(actions?.closePlan).toHaveBeenCalledExactlyOnceWith({
      planId: active.planId,
      expectedVersion: active.version,
      commandId: expect.any(String),
    });
    expect(actions?.refresh).toHaveBeenCalledOnce();
    expect(readFinalDetails).toHaveBeenCalledExactlyOnceWith(active.planId, true);
  });

  it("keeps stale rejection in the dialog until cancellation and review", async () => {
    const actions = useEnduragentStore.getState().planLibraryActions;
    if (actions === null) throw new Error("Missing library actions");
    vi.mocked(actions.closePlan).mockResolvedValue({ status: "rejected", reason: "stale-version" });
    const readFinalDetails = renderLibrary();
    fireEvent.click(screen.getByRole("button", { name: "Stop Plan" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop Plan" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "The Plan changed. Review its current details before stopping.",
    );
    expect(dialog).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Stop Plan" })).toBeDisabled();
    expect(readFinalDetails).not.toHaveBeenCalled();
    expect(actions.refresh).toHaveBeenCalledOnce();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("retries an unconfirmed stop with the original command and displayed version", async () => {
    const actions = useEnduragentStore.getState().planLibraryActions;
    if (actions === null) throw new Error("Missing library actions");
    vi.mocked(actions.closePlan).mockRejectedValueOnce(new Error("Response lost"));
    const readFinalDetails = renderLibrary();
    fireEvent.click(screen.getByRole("button", { name: "Stop Plan" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop Plan" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Stopping could not be confirmed. The library will show the current state after refresh.",
    );
    expect(actions.refresh).toHaveBeenCalledOnce();
    expect(readFinalDetails).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("button", { name: "Stop Plan" })).toBeEnabled();
    const first = vi.mocked(actions.closePlan).mock.calls[0]?.[0];
    expect(first).toEqual({
      planId: active.planId,
      expectedVersion: active.version,
      commandId: expect.any(String),
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop Plan" }));
    await vi.waitFor(() => expect(readFinalDetails).toHaveBeenCalledWith(active.planId, true));
    expect(actions.closePlan).toHaveBeenNthCalledWith(2, first);
    expect(actions.refresh).toHaveBeenCalledTimes(2);
  });

  it("reuses the stop command after cancelling and reopening an unconfirmed attempt", async () => {
    const actions = useEnduragentStore.getState().planLibraryActions;
    if (actions === null) throw new Error("Missing library actions");
    vi.mocked(actions.closePlan).mockRejectedValue(new Error("Response lost"));
    renderLibrary();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Stop Plan" }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Stop Plan" }));
      await within(dialog).findByRole("alert");
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }
    const calls = vi.mocked(actions.closePlan).mock.calls;
    expect(calls[0]?.[0]).toEqual(calls[1]?.[0]);
  });

  it("keeps an unconfirmed stop command across library remounts", async () => {
    const actions = useEnduragentStore.getState().planLibraryActions;
    if (actions === null) throw new Error("Missing library actions");
    vi.mocked(actions.closePlan).mockRejectedValueOnce(new Error("Response lost"));
    const library = {
      calendarConnected: false,
      legacy: null,
      creation: null,
      active,
      closed,
      changesPaused: null,
      changes: [],
    };
    const view = render(
      <PlanLibrary library={library} readDetails={vi.fn()} readFinalDetails={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop Plan" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Stop Plan" }),
    );
    await screen.findByRole("alert");
    const command = vi.mocked(actions.closePlan).mock.calls[0]?.[0];
    view.unmount();
    render(<PlanLibrary library={library} readDetails={vi.fn()} readFinalDetails={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop Plan" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Stop Plan" }),
    );
    await vi.waitFor(() => expect(actions.closePlan).toHaveBeenCalledTimes(2));
    expect(actions.closePlan).toHaveBeenNthCalledWith(2, command);
    await vi.waitFor(() => expect(useEnduragentStore.getState().planCloseAttempt).toBeNull());
  });

  it.each(["no-active-plan", "command-conflict"])(
    "closes the dialog after %s failure",
    async (failure) => {
      const actions = useEnduragentStore.getState().planLibraryActions;
      if (actions === null) throw new Error("Missing library actions");
      vi.mocked(actions.closePlan).mockResolvedValue({
        status: "rejected",
        reason: failure === "no-active-plan" ? "no-active-plan" : "command-conflict",
      });
      const readFinalDetails = renderLibrary();
      const stop = screen.getByRole("button", { name: "Stop Plan" });
      fireEvent.click(stop);
      fireEvent.click(
        within(await screen.findByRole("dialog")).getByRole("button", { name: "Stop Plan" }),
      );
      await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Stopping could not be saved locally. Your Plan is unchanged.",
      );
      await vi.waitFor(() => expect(stop).toHaveFocus());
      expect(actions.refresh).not.toHaveBeenCalled();
      expect(readFinalDetails).not.toHaveBeenCalled();
    },
  );

  it.each(["pending", "complete"] as const)(
    "opens final history in the Plan page with %s cleanup notice",
    async (cleanup) => {
      const actions = useEnduragentStore.getState().planLibraryActions;
      if (actions === null) throw new Error("Missing library actions");
      const history: NonNullable<PlanHistoryResult> = {
        plan: { ...active, status: "closed", closeReason: "stopped", closedAt: "1998-09-08" },
        closeActor: "fictional-device",
        revision: { revisionNumber: 1, fingerprint: "b".repeat(64), snapshot: planCreationDraft() },
        cleanup,
      };
      vi.mocked(actions.readPlanHistory).mockResolvedValue(history);
      vi.mocked(actions.refresh).mockImplementation(async () => {
        useEnduragentStore.setState({
          planLibrary: {
            status: "ready",
            value: {
              calendarConnected: false,
              legacy: null,
              creation: null,
              active: null,
              closed: [{ ...history.plan, status: "closed" }],
              changesPaused: null,
              changes: [],
            },
          },
        });
      });
      useEnduragentStore.setState({
        planLibrary: {
          status: "ready",
          value: {
            calendarConnected: false,
            legacy: null,
            creation: null,
            active,
            closed,
            changesPaused: null,
            changes: [],
          },
        },
      });
      render(<PlanView />);
      fireEvent.click(screen.getByRole("button", { name: "Stop Plan" }));
      fireEvent.click(
        within(await screen.findByRole("dialog")).getByRole("button", { name: "Stop Plan" }),
      );
      expect(await screen.findByRole("heading", { name: "Final Plan details" })).toBeVisible();
      expect(actions.readPlanHistory).toHaveBeenCalledExactlyOnceWith(active.planId);
      expect(
        screen.getByText(
          cleanup === "complete"
            ? "Plan closed. Cleanup complete."
            : "Plan closed. Calendar cleanup pending.",
        ),
      ).toBeVisible();
      expect(screen.queryByRole("button", { name: "Change in Chat" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Start a Plan" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Back to library" }));
      expect(screen.getByRole("region", { name: "Plan library" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Read final details" })).toBeVisible();
    },
  );

  it("queues a fresh library read when the Plan page opens during an earlier read", async () => {
    const store = useEnduragentStore;
    store.setState({ activeView: "chat" });
    let finishRead: (value: ListPlansResult) => void = () => {};
    const initial = new Promise<ListPlansResult>((resolve) => {
      finishRead = resolve;
    });
    const listPlans = vi.fn().mockReturnValueOnce(initial).mockResolvedValue({
      calendarConnected: false,
      legacy: null,
      creation: null,
      active: null,
      closed,
    });
    const controller = createPlanController({
      listPlans,
      read: async () => ({
        schemaVersion: 1,
        status: "no-plan",
        asOfDateKey: 19981005,
        plan: null,
      }),
      renderLibrary: (next) => store.getState().setPlanLibrary(next),
      render: (next) => store.getState().setPlanSurface(next),
      navigate: (view) => store.getState().setActiveView(view),
      focus: vi.fn(),
    });
    const unsubscribe = subscribePlanLibraryRefresh(controller);
    try {
      const started = controller.start();
      store.getState().setActiveView("plan");
      finishRead({
        calendarConnected: false,
        legacy: null,
        creation: null,
        active,
        closed,
        changesPaused: null,
        changes: [],
      });
      await started;
      await vi.waitFor(() => expect(listPlans).toHaveBeenCalledTimes(2));
      expect(store.getState().planLibrary.value?.active).toBeNull();
    } finally {
      unsubscribe();
      controller.dispose();
    }
  });
});
