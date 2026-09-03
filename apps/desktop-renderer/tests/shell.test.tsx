import type { TrainingHistoryComputed } from "@enduragent/coach-contract";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../src/app/Shell";
import type { OnboardingController } from "../src/onboarding/controller";
import type { CredentialSettingsState } from "../src/settings/credential-controller";
import { EMPTY_CHAT_SURFACE, type ChatActions } from "../src/state/chat-slice";
import { resetChatStream } from "../src/state/chat-stream";
import {
  CLOSED_ONBOARDING,
  READY_ONBOARDING,
  setupBlocked,
  setupRequired,
  setupSurfaceOnScreen,
} from "../src/state/onboarding-slice";
import { EMPTY_PLAN_SURFACE, type PlanActions } from "../src/state/plan-slice";
import { useEnduragentStore } from "../src/state/store";
import { IDLE_MANUAL_SYNC } from "../src/state/sync-slice";
import { EMPTY_TRAINING_SURFACE } from "../src/state/training-slice";
import { toManualSyncViewState } from "../src/training-context/manual-sync";
import {
  clearTrainingRestrictionFocusRequest,
  requestTrainingRestrictionFocus,
  takeTrainingRestrictionFocusRequest,
} from "../src/ui/settings/restriction-focus";
import { planReadModel } from "./plan-fixtures";

const REPAIR_REQUIRED_CREDENTIALS: CredentialSettingsState = {
  status: "ready",
  entries: [],
  providerStatuses: [],
  confirmation: null,
  announcement: "That saved key could not be used. Enter it again to continue.",
  recovery: { state: "ready", unverifiedEnvelopes: 0 },
  repairCredential: "anthropic",
  recoveryAvailable: false,
  focus: null,
};

const REQUIRED_ONBOARDING = Object.freeze({
  ...CLOSED_ONBOARDING,
  open: true,
  initialized: true,
  loading: false,
  completionRequired: true,
});

const SELECTED_RIDE = Object.freeze({
  id: "a".repeat(64),
  title: null,
  subSport: "road",
  startEpochSeconds: 900_000_000,
  timezoneOffsetSeconds: 0,
  localDate: "1998-07-09",
  ridingSeconds: 3_500,
  ridingTimeBasis: "moving" as const,
  elapsedSeconds: 3_600,
  distanceMeters: 32_000,
  load: null,
  averagePowerWatts: null,
  averageHeartRateBpm: null,
  perceivedExertion: null,
  energyKilojoules: null,
});

const SELECTED_RIDE_HISTORY = {
  kind: "computed",
  asOf: "1998-07-19T08:00:00.000Z",
  calendarTimeZone: "UTC",
  displayMode: "current",
  coverage: {
    kind: "contiguous",
    start: "1998-06-01",
    through: "1998-07-19",
    committedAt: "1998-07-19T07:55:00.000Z",
  },
  anchorWeek: {
    id: "anchor",
    window: { start: "1998-07-06", end: "1998-07-12" },
    calendarState: "closed",
    coverage: { kind: "complete" },
    totals: {
      rideCount: { kind: "computed", value: 1 },
      ridingSeconds: { kind: "computed", value: 3_500 },
      distanceMeters: { kind: "computed", value: 32_000 },
      load: { kind: "unavailable", reason: "no-recorded-value" },
    },
    rides: {
      count: { kind: "exact", value: 1 },
      items: [SELECTED_RIDE],
      truncated: false,
    },
    trend: { kind: "unavailable", reason: "limited-history" },
    callout: null,
  },
  previousWeek: null,
} as const satisfies TrainingHistoryComputed;

function stubActions(): ChatActions {
  return {
    submit: vi.fn(),
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
    answerPlanCreation: vi.fn(),
    stop: vi.fn(),
    removeQueued: vi.fn(),
    runQueuedCommand: vi.fn(),
    retryQueuedTurn: vi.fn(),
    retry: vi.fn(),
    loadEarlier: vi.fn(),
    retryHydration: vi.fn(),
    openNewConversation: vi.fn(),
    cancelNewConversation: vi.fn(),
    confirmNewConversation: vi.fn(),
    retryFirstSync: vi.fn(),
    answerDecision: vi.fn(),
    skipDecision: vi.fn(),
    retryDecision: vi.fn(),
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
    openEndedConversation: vi.fn(),
    closeEndedConversation: vi.fn(),
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
    openAttention: vi.fn(),
    resolvePlanningRequestDate: vi.fn(),
    returnToCoach: vi.fn(),
    retry: vi.fn(),
  };
}

function stravaDroppedActivities() {
  return {
    overall: {
      total: 67,
      visible: 5,
      restrictions: [{ reason: "source-restricted" as const, source: "STRAVA", count: 60 }],
      other: 2,
    },
    recent7Days: {
      total: 5,
      visible: 1,
      restrictions: [{ reason: "source-restricted" as const, source: "STRAVA", count: 4 }],
      other: 0,
    },
  };
}

async function preloadLazyViews(): Promise<void> {
  await Promise.all([
    import("../src/ui/archive/ArchiveView"),
    import("../src/ui/training/TrainingView"),
    import("../src/ui/plan/PlanView"),
    import("../src/ui/settings/SettingsView"),
  ]);
}

describe("shell", () => {
  beforeAll(preloadLazyViews);

  beforeEach(() => {
    useEnduragentStore.setState({
      activeView: "chat",
      runtimeReady: true,
      chat: { ...EMPTY_CHAT_SURFACE, newConversationUnavailable: false },
      chatActions: stubActions(),
      training: EMPTY_TRAINING_SURFACE,
      selectedRide: null,
      sync: IDLE_MANUAL_SYNC,
      syncActions: null,
      onboarding: READY_ONBOARDING,
      onboardingActions: null,
      onboardingStartupSettled: true,
      plan: EMPTY_PLAN_SURFACE,
      planActions: stubPlanActions(),
      settings: {
        ...useEnduragentStore.getState().settings,
        savingOwners: [],
      },
    });
  });

  afterEach(() => {
    useEnduragentStore.setState({
      chat: EMPTY_CHAT_SURFACE,
      chatActions: null,
      training: EMPTY_TRAINING_SURFACE,
      selectedRide: null,
      sync: IDLE_MANUAL_SYNC,
      syncActions: null,
      onboarding: CLOSED_ONBOARDING,
      onboardingActions: null,
      onboardingStartupSettled: false,
      plan: EMPTY_PLAN_SURFACE,
      planActions: null,
      settings: {
        ...useEnduragentStore.getState().settings,
        credentials: { status: "closed" },
        savingOwners: [],
      },
    });
    clearTrainingRestrictionFocusRequest();
    resetChatStream();
  });

  it("renders the sidebar and the chat region by default", () => {
    render(<Shell onReady={() => {}} />);

    expect(screen.getByText("Enduragent")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New chat" })).toBeEnabled();
    expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeInTheDocument();
    expect(screen.getByLabelText("Coaching conversation")).toBeInTheDocument();
    expect(document.querySelector("div.thread")).not.toBeNull();
    expect(document.querySelector("div.composer-wrap")).not.toBeNull();
    expect(document.querySelector("textarea#message")).not.toBeNull();
    expect(document.querySelector("button.sync-chip")).not.toBeNull();
    expect(document.querySelector("[data-sidebar-setup-readiness]")).toBeNull();
    expect(screen.getByRole("heading", { name: "Chat" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide training context" })).toBeInTheDocument();
    expect(document.querySelector('[data-view="chat"]')).not.toBeNull();
    expect(document.querySelector('[data-onboarding="settled"]')).not.toBeNull();
    expect(document.querySelector("[data-setup-host]")).toBeNull();
    expect(document.querySelector('[data-shell="app"]')).not.toBeNull();
  });

  it("retires the training drawer, data spine and topbar strip", () => {
    render(<Shell onReady={() => {}} />);

    expect(document.querySelector('.drawer[aria-label="Training data"]')).toBeNull();
    expect(document.querySelector(".data-spine")).toBeNull();
    expect(document.querySelector("header.topbar")).toBeNull();
    expect(document.querySelector(".setup-button")).toBeNull();
  });

  it("signals boot readiness once", () => {
    const onReady = vi.fn<() => void>();

    const { rerender } = render(<Shell onReady={onReady} />);
    rerender(<Shell onReady={onReady} />);

    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("switches the main region between the registered views", async () => {
    const user = userEvent.setup();
    render(<Shell onReady={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Past chats" }));
    expect(await screen.findByRole("region", { name: "Past chats" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Training" }));
    expect(await screen.findByRole("region", { name: "Training" })).toBeInTheDocument();

    const planState = planReadModel();
    act(() => {
      useEnduragentStore.setState({
        plan: {
          ...EMPTY_PLAN_SURFACE,
          hydration: { status: "ready", state: planState },
          lastReady: planState,
        },
      });
    });
    await user.click(screen.getByRole("button", { name: "Plan" }));
    expect(await screen.findByRole("region", { name: "Plan" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Train toward one clear goal" }),
    ).toBeInTheDocument();
    expect(document.querySelector("div.thread")).not.toBeNull();
    const conversation = screen.getByLabelText("Coaching conversation");
    expect(conversation.closest(".hidden")).not.toBeNull();
    expect(screen.getByRole("region", { name: "Plan" }).querySelector("div.thread")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("region", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "App palette" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Chat" }));
    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "Settings" })).toBeNull();
    });
    expect(screen.getByLabelText("Coaching conversation")).toBeInTheDocument();
  });

  it("keeps focus on the Training navigation button while switching views", async () => {
    const user = userEvent.setup();
    render(<Shell onReady={() => {}} />);
    const trainingButton = screen.getByRole("button", { name: "Training" });

    await user.click(trainingButton);
    await screen.findByRole("region", { name: "Training" });

    expect(trainingButton).toHaveFocus();
  });

  it("moves focus from a mounted ride review to the Settings action card", async () => {
    const user = userEvent.setup();
    const request = vi.fn();
    useEnduragentStore.setState({
      activeView: "training",
      training: {
        ...EMPTY_TRAINING_SURFACE,
        status: "ready",
        metadata: {
          lastUpdated: "1998-07-19T08:00:00.000Z",
          lastSynced: "1998-07-19T07:55:00.000Z",
          freshness: "fresh",
          degraded: false,
        },
        trainingContext: {
          ...EMPTY_TRAINING_SURFACE.trainingContext,
          trainingHistory: SELECTED_RIDE_HISTORY,
        },
      },
      selectedRide: SELECTED_RIDE,
      sync: toManualSyncViewState({
        status: "succeeded",
        operation: 1,
        kind: "published",
        droppedActivities: stravaDroppedActivities(),
      }),
      syncActions: { request },
    });
    render(<Shell onReady={() => {}} />);
    expect(screen.getByRole("region", { name: "Ride review" })).toBeInTheDocument();

    const remedy = screen.getByRole("link", {
      name: "60 hidden by Strava. How to fix this",
    });
    remedy.focus();
    await user.keyboard("{Enter}");

    const settings = await screen.findByRole("region", { name: "Settings" });
    const card = await waitFor(() => {
      const element = settings.querySelector<HTMLElement>("#strava-restricted-activities");
      expect(element).not.toBeNull();
      return element;
    });
    await waitFor(() => {
      expect(card).toHaveFocus();
    });
    expect(useEnduragentStore.getState().activeView).toBe("settings");
    expect(useEnduragentStore.getState().selectedRide).toEqual(SELECTED_RIDE);
    expect(request).not.toHaveBeenCalled();
  });

  it("focuses the Settings action card when saving keeps Settings active", async () => {
    const user = userEvent.setup();
    const request = vi.fn();
    useEnduragentStore.setState({
      activeView: "settings",
      selectedRide: SELECTED_RIDE,
      settings: {
        ...useEnduragentStore.getState().settings,
        savingOwners: ["session"],
      },
      sync: toManualSyncViewState({
        status: "succeeded",
        operation: 1,
        kind: "published",
        droppedActivities: stravaDroppedActivities(),
      }),
      syncActions: { request },
    });
    render(<Shell onReady={() => {}} />);

    const settings = await screen.findByRole("region", { name: "Settings" });
    await user.click(screen.getByRole("link", { name: "60 hidden by Strava. How to fix this" }));

    const card = await waitFor(() => {
      const element = settings.querySelector<HTMLElement>("#strava-restricted-activities");
      expect(element).not.toBeNull();
      return element;
    });
    await waitFor(() => {
      expect(card).toHaveFocus();
    });
    expect(useEnduragentStore.getState().activeView).toBe("settings");
    expect(useEnduragentStore.getState().selectedRide).toEqual(SELECTED_RIDE);
    expect(takeTrainingRestrictionFocusRequest()).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("drops an unconsumed repair-focus request when navigation leaves Settings", async () => {
    const user = userEvent.setup();
    useEnduragentStore.setState({
      activeView: "settings",
      sync: toManualSyncViewState({
        status: "succeeded",
        operation: 1,
        kind: "published",
        droppedActivities: stravaDroppedActivities(),
      }),
    });
    render(<Shell onReady={() => {}} />);
    await screen.findByRole("region", { name: "Settings" });

    requestTrainingRestrictionFocus();
    await user.click(screen.getByRole("button", { name: "Training" }));
    await screen.findByRole("region", { name: "Training" });

    expect(takeTrainingRestrictionFocusRequest()).toBe(false);
  });

  it("keeps the chat surface mounted while another view is shown", async () => {
    const user = userEvent.setup();
    const onReady = vi.fn<() => void>();
    render(<Shell onReady={onReady} />);
    const thread = document.querySelector("div.thread");
    const noticeHost = document.querySelector("div.chat-notice-host");

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByRole("region", { name: "Settings" });

    expect(thread?.isConnected).toBe(true);
    expect(noticeHost?.isConnected).toBe(true);
    expect(document.querySelector("textarea#message")).not.toBeNull();
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("keeps a neutral shell while the setup decision is unknown", () => {
    useEnduragentStore.setState({ onboarding: CLOSED_ONBOARDING });
    render(<Shell onReady={() => {}} />);

    expect(setupRequired(useEnduragentStore.getState())).toBe(false);
    expect(setupBlocked(useEnduragentStore.getState())).toBe(true);
    expect(document.querySelector('[data-shell="unknown"]')).not.toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Checking setup…");
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    expect(document.querySelector("[data-setup-host]")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Main navigation" })).toBeNull();
    expect(screen.queryByLabelText("Coaching conversation")).toBeNull();
    expect(document.querySelector("textarea#message")).toBeNull();
  });

  it("keeps an initialized state without a committed setup load neutral", () => {
    useEnduragentStore.setState({
      activeView: "training",
      onboarding: { ...CLOSED_ONBOARDING, open: true, initialized: true, loading: false },
    });
    render(<Shell onReady={() => {}} />);

    expect(document.querySelector('[data-shell="unknown"]')).not.toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Checking setup…");
    expect(document.querySelector("[data-setup-host]")).toBeNull();
    expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
    expect(document.querySelector("textarea#message")).toBeNull();
  });

  it("keeps the known app shell mounted while setup status refreshes", () => {
    useEnduragentStore.setState({
      onboarding: { ...READY_ONBOARDING, loading: true },
    });
    render(<Shell onReady={() => {}} />);

    expect(setupRequired(useEnduragentStore.getState())).toBe(false);
    expect(setupBlocked(useEnduragentStore.getState())).toBe(false);
    expect(document.querySelector('[data-shell="app"]')).not.toBeNull();
    expect(document.querySelector('[data-setup-host="gate"]')).toBeNull();
    expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New chat" })).toBeEnabled();
    expect(screen.getByLabelText("Message your coach")).toBeEnabled();
  });

  it("keeps the known app shell mounted when a refresh becomes unavailable", () => {
    useEnduragentStore.setState({
      onboarding: { ...READY_ONBOARDING, loadUnavailable: true },
    });
    render(<Shell onReady={() => {}} />);

    expect(document.querySelector('[data-shell="app"]')).not.toBeNull();
    expect(document.querySelector('[data-setup-host="gate"]')).toBeNull();
    expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New chat" })).toBeEnabled();
    expect(screen.getByLabelText("Message your coach")).toBeEnabled();
  });

  it("routes an unavailable initial decision to the setup recovery gate", () => {
    useEnduragentStore.setState({
      onboarding: {
        ...CLOSED_ONBOARDING,
        open: true,
        initialized: true,
        loading: false,
        loadUnavailable: true,
      },
    });
    render(<Shell onReady={() => {}} />);

    expect(document.querySelector('[data-shell="gate"]')).not.toBeNull();
    expect(document.querySelector('[data-setup-host="gate"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "Retry setup status" })).toBeEnabled();
    expect(document.querySelector("[data-setup-readiness]")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Main navigation" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
    expect(document.querySelector("textarea#message")).toBeNull();
  });

  it("replaces the shell with the setup gate while setup is required", () => {
    useEnduragentStore.setState({ onboarding: REQUIRED_ONBOARDING });
    render(<Shell onReady={() => {}} />);

    expect(setupRequired(useEnduragentStore.getState())).toBe(true);
    expect(setupBlocked(useEnduragentStore.getState())).toBe(true);
    expect(document.querySelectorAll('[data-setup-host="gate"]')).toHaveLength(1);
    expect(document.querySelectorAll("#setup-panel-title")).toHaveLength(1);
    expect(document.querySelector('[data-shell="gate"]')).not.toBeNull();

    expect(screen.queryByRole("navigation", { name: "Main navigation" })).toBeNull();
    expect(screen.queryByLabelText("Coaching conversation")).toBeNull();
    expect(document.querySelector("div.thread")).toBeNull();
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
    expect(document.querySelector("textarea#message")).toBeNull();
  });

  it("ignores the persisted destination while setup is required", () => {
    useEnduragentStore.setState({
      activeView: "training",
      onboarding: REQUIRED_ONBOARDING,
    });
    render(<Shell onReady={() => {}} />);

    expect(setupSurfaceOnScreen(useEnduragentStore.getState())).toBe(true);
    expect(screen.queryByRole("region", { name: "Training" })).toBeNull();
    expect(document.querySelector('[data-setup-host="gate"]')).not.toBeNull();
    expect(document.querySelector('[data-view="training"]')).not.toBeNull();
    expect(document.querySelector('[data-view="setup"]')).toBeNull();
    expect(document.querySelector("[data-sidebar-setup-readiness]")).toBeNull();
    expect(useEnduragentStore.getState().activeView).toBe("training");
  });

  it("holds the gate even when the stored destination is Settings", () => {
    useEnduragentStore.setState({
      activeView: "settings",
      onboarding: REQUIRED_ONBOARDING,
    });
    render(<Shell onReady={() => {}} />);

    expect(screen.queryByRole("region", { name: "Settings" })).toBeNull();
    expect(document.querySelector('[data-setup-host="gate"]')).not.toBeNull();
    expect(document.querySelector('[data-setup-host="settings"]')).toBeNull();
    expect(document.querySelector('[data-view="setup"]')).toBeNull();
  });

  it.each([
    {
      activeView: "chat" as const,
      focusTarget: () => screen.getByLabelText("Message your coach"),
    },
    {
      activeView: "training" as const,
      focusTarget: () => screen.getByRole("heading", { name: "Training", level: 1 }),
    },
    {
      activeView: "settings" as const,
      focusTarget: () => screen.getByRole("heading", { name: "Setup", level: 2 }),
    },
  ])(
    "hands focus to the preserved $activeView view after setup finishes",
    async ({ activeView, focusTarget }) => {
      const user = userEvent.setup();
      const finish = vi.fn(() => {
        useEnduragentStore.setState({ onboarding: READY_ONBOARDING });
      });
      useEnduragentStore.setState({
        activeView,
        onboarding: {
          ...READY_ONBOARDING,
          open: true,
          completionRequired: true,
          wizard: {
            ...READY_ONBOARDING.wizard,
            intake: { injuryStatus: "none" },
          },
        },
        onboardingActions: { finish } as unknown as OnboardingController,
      });
      render(<Shell onReady={() => {}} />);
      const gate = document.querySelector('[data-setup-host="gate"]');

      await user.click(screen.getByRole("button", { name: "Start coaching" }));

      expect(finish).toHaveBeenCalledOnce();
      expect(useEnduragentStore.getState().activeView).toBe(activeView);
      await waitFor(() => {
        expect(gate).not.toBeInTheDocument();
        expect(focusTarget()).toHaveFocus();
      });
    },
  );

  it("offers no dismiss, skip or close control on the gate", () => {
    useEnduragentStore.setState({ onboarding: REQUIRED_ONBOARDING });
    render(<Shell onReady={() => {}} />);

    const gate = document.querySelector('[data-setup-host="gate"]');
    if (!(gate instanceof HTMLElement)) throw new TypeError("setup gate missing");
    expect(screen.queryByRole("dialog")).toBeNull();
    for (const label of ["Dismiss", "Skip", "Close", "Cancel setup", "Later"]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
    expect(fireEvent.keyDown(gate, { key: "Escape" })).toBe(true);
    expect(document.querySelector('[data-setup-host="gate"]')).not.toBeNull();
  });

  it("holds the gate at three ready until setup completion is acknowledged", () => {
    const onReady = vi.fn<() => void>();
    useEnduragentStore.setState({ onboarding: REQUIRED_ONBOARDING });
    render(<Shell onReady={onReady} />);

    expect(document.querySelector('[data-setup-host="gate"]')).not.toBeNull();

    act(() => {
      useEnduragentStore.setState({
        onboarding: {
          ...READY_ONBOARDING,
          open: true,
          completionRequired: true,
        },
      });
    });

    expect(document.querySelector('[data-setup-host="gate"]')).not.toBeNull();
    expect(screen.queryByRole("navigation", { name: "Main navigation" })).toBeNull();

    act(() => {
      useEnduragentStore.setState({ onboarding: READY_ONBOARDING });
    });

    expect(document.querySelector("[data-setup-host]")).toBeNull();
    expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeInTheDocument();
    expect(document.querySelector("div.thread")).not.toBeNull();
    expect(document.querySelector("textarea#message")).not.toBeNull();
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("keeps credential repair reachable on the gate for a non-Intervals credential", () => {
    useEnduragentStore.setState({
      onboarding: READY_ONBOARDING,
      settings: {
        ...useEnduragentStore.getState().settings,
        credentials: REPAIR_REQUIRED_CREDENTIALS,
      },
    });
    render(<Shell onReady={() => {}} />);

    const gate = document.querySelector('[data-setup-host="gate"]');
    expect(gate).not.toBeNull();
    const feedback = gate?.querySelector("[data-credential-feedback]");
    expect(feedback).not.toBeNull();
    expect(screen.getByRole("button", { name: "Reload credential status" })).toBeEnabled();
    expect(screen.queryByRole("navigation", { name: "Main navigation" })).toBeNull();
  });

  it("preserves global reset uncertainty when settings panes close", () => {
    useEnduragentStore.getState().patchSettings({
      credentials: { status: "closed", resetUncertain: true },
    });

    useEnduragentStore.getState().closeSettingsPanes();

    expect(useEnduragentStore.getState().settings.credentials).toEqual({
      status: "closed",
      resetUncertain: true,
    });
  });

  it("holds a repair-triggered gate after reconciliation until Start coaching", () => {
    const requireCompletion = vi.fn(() => {
      useEnduragentStore.setState((state) => ({
        onboarding: { ...state.onboarding, completionRequired: true },
      }));
    });
    useEnduragentStore.getState().bindOnboardingActions({
      requireCompletion,
    } as unknown as OnboardingController);
    render(<Shell onReady={() => {}} />);

    act(() => {
      useEnduragentStore.getState().patchSettings({
        credentials: REPAIR_REQUIRED_CREDENTIALS,
      });
    });

    expect(requireCompletion).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-shell="gate"]')).not.toBeNull();

    act(() => {
      useEnduragentStore.getState().patchSettings({ credentials: { status: "closed" } });
    });

    expect(document.querySelector('[data-shell="gate"]')).not.toBeNull();
    expect(screen.queryByRole("navigation", { name: "Main navigation" })).toBeNull();
  });

  it("reports onboarding startup as pending until the decision settles", () => {
    useEnduragentStore.setState({ onboardingStartupSettled: false });
    render(<Shell onReady={() => {}} />);

    expect(document.querySelector('[data-onboarding="pending"]')).not.toBeNull();

    act(() => {
      useEnduragentStore.getState().setOnboardingStartupSettled(true);
    });
    expect(document.querySelector('[data-onboarding="settled"]')).not.toBeNull();
  });

  it("disables the new chat button until the chat controller is bound", () => {
    useEnduragentStore.setState({ chatActions: null });
    render(<Shell onReady={() => {}} />);

    expect(screen.getByRole("button", { name: "New chat" })).toBeDisabled();
  });

  it("routes the new chat button at the controller's new-conversation flow", async () => {
    const user = userEvent.setup();
    const actions = stubActions();
    useEnduragentStore.setState({ chatActions: actions, activeView: "settings" });
    render(<Shell onReady={() => {}} />);

    await user.click(screen.getByRole("button", { name: "New chat" }));

    expect(actions.openNewConversation).toHaveBeenCalledTimes(1);
    expect(useEnduragentStore.getState().activeView).toBe("chat");
  });

  it("keeps the new chat button focusable while a reset outcome is uncertain", async () => {
    const user = userEvent.setup();
    const actions = stubActions();
    useEnduragentStore.setState({
      chatActions: actions,
      chat: {
        ...EMPTY_CHAT_SURFACE,
        newConversationUnavailable: true,
        resetPhase: "uncertain",
      },
    });
    render(<Shell onReady={() => {}} />);

    const opener = screen.getByRole("button", { name: "New chat" });
    expect(opener).toBeEnabled();
    expect(opener).toHaveAttribute("aria-disabled", "true");

    await user.click(opener);
    expect(actions.openNewConversation).not.toHaveBeenCalled();
  });
});
