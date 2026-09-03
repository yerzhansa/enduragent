import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_CHAT_SURFACE, type ChatActions } from "../src/state/chat-slice";
import { restoreManualSyncFocus, setManualSyncFocusTarget } from "../src/state/manual-sync-focus";
import { CLOSED_ONBOARDING, READY_ONBOARDING } from "../src/state/onboarding-slice";
import { EMPTY_PLAN_SURFACE, type PlanActions } from "../src/state/plan-slice";
import { EMPTY_SETTINGS_SURFACE } from "../src/state/settings-slice";
import { useEnduragentStore } from "../src/state/store";
import { IDLE_MANUAL_SYNC } from "../src/state/sync-slice";
import { EMPTY_TRAINING_SURFACE } from "../src/state/training-slice";
import {
  type ManualSyncViewState,
  toManualSyncViewState,
} from "../src/training-context/manual-sync";
import { Sidebar } from "../src/ui/sidebar/Sidebar";
import { clearTrainingRestrictionFocusRequest } from "../src/ui/settings/restriction-focus";
import { planReadModel } from "./plan-fixtures";

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

function update(patch: Partial<Parameters<typeof useEnduragentStore.setState>[0]>): void {
  act(() => {
    useEnduragentStore.setState(patch);
  });
}

function chip(): HTMLElement {
  const element = document.querySelector("button.sync-chip");
  if (!(element instanceof HTMLElement)) throw new TypeError("sync chip missing");
  return element;
}

function chipSurface(): HTMLElement {
  const element = document.querySelector<HTMLElement>("[data-sync-chip]");
  if (element === null) throw new TypeError("sync chip surface missing");
  return element;
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

function noDroppedActivities() {
  return {
    overall: { total: 5, visible: 5, restrictions: [], other: 0 },
    recent7Days: { total: 5, visible: 5, restrictions: [], other: 0 },
  };
}

beforeEach(() => {
  useEnduragentStore.setState({
    activeView: "chat",
    chat: { ...EMPTY_CHAT_SURFACE, newConversationUnavailable: false },
    chatActions: stubActions(),
    training: EMPTY_TRAINING_SURFACE,
    sync: IDLE_MANUAL_SYNC,
    syncActions: null,
    onboarding: READY_ONBOARDING,
    onboardingActions: null,
    settings: EMPTY_SETTINGS_SURFACE,
    settingsPorts: null,
    plan: EMPTY_PLAN_SURFACE,
    planActions: stubPlanActions(),
  });
});

afterEach(() => {
  setManualSyncFocusTarget(null);
  clearTrainingRestrictionFocusRequest();
  useEnduragentStore.setState({
    chat: EMPTY_CHAT_SURFACE,
    chatActions: null,
    training: EMPTY_TRAINING_SURFACE,
    sync: IDLE_MANUAL_SYNC,
    syncActions: null,
    onboarding: CLOSED_ONBOARDING,
    onboardingActions: null,
    settings: EMPTY_SETTINGS_SURFACE,
    settingsPorts: null,
    plan: EMPTY_PLAN_SURFACE,
    planActions: null,
  });
});

describe("Plan navigation attention", () => {
  it("shows no badge when Plan has no athlete action", () => {
    render(<Sidebar />);

    expect(screen.getByRole("button", { name: "Plan" })).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it.each([
    { count: 1, name: "Plan, 1 item needs attention" },
    { count: 3, name: "Plan, 3 items need attention" },
  ])("shows the exact count for $count unresolved item(s)", ({ count, name }) => {
    const readModel = planReadModel({
      attentionCount: count,
      lifecycle: "active",
      planId: "plan-1",
    });
    update({
      plan: {
        ...EMPTY_PLAN_SURFACE,
        hydration: { status: "ready", state: readModel },
        lastReady: readModel,
      },
    });
    render(<Sidebar />);

    expect(screen.getByRole("button", { name })).toHaveTextContent(String(count));
  });

  it("keeps Plan selected and asks the adapter to resolve its destination", async () => {
    const user = userEvent.setup();
    const planActions = stubPlanActions();
    update({ planActions });
    render(<Sidebar />);

    const plan = screen.getByRole("button", { name: "Plan" });
    plan.focus();
    await user.keyboard("{Enter}");

    expect(useEnduragentStore.getState().activeView).toBe("plan");
    expect(planActions.open).toHaveBeenCalledOnce();
    expect(plan).toHaveFocus();
  });
});

describe("sidebar update action", () => {
  it("appears only when an update is ready and names its version", () => {
    render(<Sidebar />);

    const hiddenStates = [
      { status: "disabled" },
      { status: "idle" },
      { status: "checking" },
      { status: "current" },
      { status: "downloading", version: "1998.7.7" },
      { status: "failed", stage: "check" },
      { status: "failed", stage: "download" },
    ] as const;
    for (const state of hiddenStates) {
      update({
        settings: {
          ...EMPTY_SETTINGS_SURFACE,
          update: { state, actionDisabled: false },
        },
      });
      expect(screen.queryByText("Update available")).not.toBeInTheDocument();
    }

    update({
      settings: {
        ...EMPTY_SETTINGS_SURFACE,
        update: {
          state: { status: "downloaded", version: "1998.7.7" },
          actionDisabled: false,
        },
      },
    });

    expect(
      screen.getByRole("button", { name: "Install update version 1998.7.7" }),
    ).toHaveTextContent("Update available");
  });

  it("activates the existing updater port once", async () => {
    const user = userEvent.setup();
    const activate = vi.fn();
    useEnduragentStore.setState({
      settings: {
        ...EMPTY_SETTINGS_SURFACE,
        update: {
          state: { status: "downloaded", version: "1998.7.7" },
          actionDisabled: false,
        },
      },
      settingsPorts: { update: { activate } } as never,
    });
    render(<Sidebar />);

    await user.click(screen.getByRole("button", { name: "Install update version 1998.7.7" }));

    expect(activate).toHaveBeenCalledOnce();
  });

  it("keeps the restarting state visible, busy and inert", () => {
    useEnduragentStore.setState({
      settings: {
        ...EMPTY_SETTINGS_SURFACE,
        update: {
          state: { status: "downloaded", version: "1998.7.7" },
          actionDisabled: true,
        },
      },
      settingsPorts: { update: { activate: vi.fn() } } as never,
    });
    render(<Sidebar />);

    const restarting = screen.getByRole("button", {
      name: "Restarting to install update version 1998.7.7",
    });
    expect(restarting).toHaveTextContent("Restarting…");
    expect(restarting).toBeDisabled();
    expect(restarting).toHaveAttribute("aria-busy", "true");

    update({
      settings: {
        ...EMPTY_SETTINGS_SURFACE,
        update: {
          state: { status: "installing", version: "1998.7.8" },
          actionDisabled: false,
        },
      },
    });
    expect(
      screen.getByRole("button", {
        name: "Restarting to install update version 1998.7.8",
      }),
    ).toBeDisabled();
  });

  it("announces availability politely and respects sidebar locks", () => {
    useEnduragentStore.setState({ settingsPorts: { update: { activate: vi.fn() } } as never });
    render(<Sidebar />);

    const announcement = document.querySelector(".update-announcement");
    expect(announcement).toHaveAttribute("role", "status");
    expect(announcement).toHaveAttribute("aria-live", "polite");
    expect(announcement).toHaveAttribute("aria-atomic", "true");
    expect(announcement).toBeEmptyDOMElement();

    update({
      settings: {
        ...EMPTY_SETTINGS_SURFACE,
        update: {
          state: { status: "downloaded", version: "1998.7.7" },
          actionDisabled: false,
        },
      },
      onboarding: { ...CLOSED_ONBOARDING, open: true },
    });
    expect(announcement).toHaveTextContent("Update version 1998.7.7 is available");
    expect(screen.getByRole("button", { name: "Install update version 1998.7.7" })).toBeEnabled();

    update({
      onboarding: CLOSED_ONBOARDING,
      activeView: "settings",
      settings: {
        ...EMPTY_SETTINGS_SURFACE,
        savingOwners: ["synthetic-lock"],
        update: {
          state: { status: "downloaded", version: "1998.7.7" },
          actionDisabled: false,
        },
      },
    });
    expect(screen.getByRole("button", { name: "Install update version 1998.7.7" })).toBeDisabled();
  });
});

describe("sidebar information hierarchy", () => {
  it("omits redundant conversation and process-status surfaces", () => {
    render(<Sidebar />);

    expect(screen.queryByText("Conversations")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Current conversation/u })).not.toBeInTheDocument();
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
    expect(document.querySelector(".connection-status")).not.toBeInTheDocument();
  });
});

describe("sidebar styling", () => {
  it("uses local UI buttons and Tailwind without the legacy module or mono copy", async () => {
    const sources = await Promise.all(
      ["Sidebar.tsx", "SyncChip.tsx", "UpdateAvailableButton.tsx"].map((name) =>
        readFile(resolve(import.meta.dirname, "..", "src", "ui", "sidebar", name), "utf8"),
      ),
    );
    expect(sources.every((source) => source.includes("components/ui/button"))).toBe(true);
    expect(sources.join("\n")).not.toContain("Sidebar.module.css");
    expect(sources.join("\n")).not.toContain("font-mono");
  });
});

describe("sidebar sync chip", () => {
  it("walks the loading, synced, syncing and attention states", () => {
    render(<Sidebar />);

    expect(chip()).toHaveAttribute("data-status", "loading");
    expect(chipSurface()).toHaveClass("min-w-0");
    expect(chipSurface()).toHaveTextContent("Loading training data");
    expect(screen.getByText("Sync now")).toHaveAttribute("data-sync-action");
    expect(chip()).toHaveAccessibleName("Sync now · Loading training data");

    update({
      training: {
        ...EMPTY_TRAINING_SURFACE,
        status: "ready",
        metadata: {
          lastUpdated: "1998-07-19T08:00:00.000Z",
          lastSynced: "1998-07-19T07:55:00.000Z",
          freshness: "fresh",
          degraded: false,
        },
      },
    });
    expect(chip()).toHaveAttribute("data-status", "synced");
    expect(chipSurface()).toHaveTextContent("Training data synced");
    expect(chipSurface()).toHaveTextContent("1998-07-19 07:55:00 UTC");
    expect(screen.getByText("Sync now")).toHaveAttribute("data-sync-action");
    expect(chip()).toHaveAccessibleName(
      "Sync now · Training data synced · 1998-07-19 07:55:00 UTC",
    );

    update({ sync: toManualSyncViewState({ status: "running", operation: 1 }) });
    expect(chip()).toHaveAttribute("data-status", "syncing");
    expect(chip()).toBeDisabled();
    expect(chipSurface()).toHaveTextContent("Syncing");
    expect(screen.getByText("Sync now")).toHaveAttribute("data-sync-action");
    expect(chip()).toHaveAccessibleName("Sync now · Syncing · Syncing training data…");

    update({
      sync: toManualSyncViewState({
        status: "failed",
        operation: 1,
        kind: "partial",
        retryable: true,
      }),
    });
    expect(chip()).toHaveAttribute("data-status", "attention");
    expect(chipSurface()).toHaveTextContent("Sync needs attention");
    expect(chipSurface()).toHaveTextContent("Try again");
    expect(screen.getByText("Try again")).toHaveAttribute("data-sync-action");
    expect(chip()).toHaveAccessibleName(
      "Try again · Sync needs attention · Training-data processing partially completed. Try again to finish.",
    );
  });

  it("keeps refresh failure ahead of retained sync success", () => {
    useEnduragentStore.setState({
      training: {
        ...EMPTY_TRAINING_SURFACE,
        status: "refresh-unavailable",
        metadata: {
          lastUpdated: "1998-07-19T08:00:00.000Z",
          lastSynced: "1998-07-19T07:55:00.000Z",
          freshness: "flag",
          degraded: false,
        },
      },
    });
    render(<Sidebar />);

    expect(chip()).toHaveAttribute("data-status", "attention");
    expect(chipSurface()).toHaveTextContent("Sync needs attention");
    expect(chipSurface()).not.toHaveTextContent("Training data synced");
  });

  it("shows and politely announces each exact manual sync message once", () => {
    render(<Sidebar />);

    const announcement = chipSurface().querySelector('[role="status"]');
    expect(announcement).toHaveAttribute("aria-live", "polite");
    expect(announcement).toHaveAttribute("aria-atomic", "true");

    const syncMessages = [
      [toManualSyncViewState({ status: "queued", operation: 1 }), "Sync queued."],
      [toManualSyncViewState({ status: "running", operation: 1 }), "Syncing training data…"],
      [
        toManualSyncViewState({
          status: "succeeded",
          operation: 1,
          kind: "published",
          droppedActivities: noDroppedActivities(),
        }),
        "Training-data check completed.",
      ],
      [
        toManualSyncViewState({
          status: "failed",
          operation: 1,
          kind: "partial",
          retryable: true,
        }),
        "Training-data processing partially completed. Try again to finish.",
      ],
      [
        toManualSyncViewState({
          status: "failed",
          operation: 1,
          kind: "indeterminate",
          retryable: true,
        }),
        "Connection interrupted. The sync may still be finishing. Enduragent won’t retry it automatically.",
      ],
      [
        toManualSyncViewState({
          status: "failed",
          operation: 1,
          kind: "protocol",
          retryable: false,
        }),
        "Enduragent couldn’t verify the sync result. Quit and reopen Enduragent.",
      ],
    ] satisfies ReadonlyArray<readonly [ManualSyncViewState, string]>;

    for (const [state, message] of syncMessages) {
      update({ sync: state });
      expect(announcement?.textContent).toBe(message);
      expect(chipSurface().querySelectorAll('[role="status"]')).toHaveLength(1);
    }
  });

  it("keeps Strava remedy navigation independent from syncing", async () => {
    const user = userEvent.setup();
    const request = vi.fn();
    useEnduragentStore.setState({ syncActions: { request } });
    render(<Sidebar />);

    update({
      training: {
        ...EMPTY_TRAINING_SURFACE,
        status: "ready",
        metadata: {
          lastUpdated: "1998-07-19T08:00:00.000Z",
          lastSynced: "1998-07-19T07:55:00.000Z",
          freshness: "fresh",
          degraded: false,
        },
      },
      sync: toManualSyncViewState({
        status: "succeeded",
        operation: 1,
        kind: "published",
        droppedActivities: stravaDroppedActivities(),
      }),
    });

    expect(chip()).toHaveAttribute("data-status", "synced");
    expect(chipSurface()).toHaveTextContent("60 hidden by Strava");
    expect(chipSurface()).toHaveTextContent("How to fix this");
    expect(screen.getByText("Sync again")).toHaveAttribute("data-sync-action");
    expect(chipSurface()).not.toHaveTextContent("1998-07-19 07:55:00 UTC");
    expect(chip()).toHaveAttribute("title", "1998-07-19 07:55:00 UTC");
    expect(chip()).toHaveAccessibleName(
      "Sync again · Training data synced · Training-data check completed. A Strava API restriction prevents intervals.icu from sharing 60 activities, so they aren’t included.",
    );
    expect(
      chip().querySelector("a, button, input, select, textarea, [role='button'], [tabindex]"),
    ).toBeNull();

    const link = screen.getByRole("link", {
      name: "60 hidden by Strava. How to fix this",
    });
    expect(link).toHaveAttribute("href", "#strava-restricted-activities");
    expect(link).toHaveAttribute("data-info-tip");
    await user.hover(link);
    await waitFor(() => {
      expect(document.querySelector("[data-info-tip-popup]")).not.toBeNull();
    });
    expect(screen.getByText("60 activities hidden by Strava")).toBeInTheDocument();
    const popup = document.querySelector<HTMLElement>("[data-info-tip-popup]");
    expect(
      popup?.querySelector("a, button, input, select, textarea, [role='button'], [tabindex]"),
    ).toBeNull();

    await user.click(link);
    expect(useEnduragentStore.getState().activeView).toBe("settings");
    expect(request).not.toHaveBeenCalled();

    clearTrainingRestrictionFocusRequest();
    update({ activeView: "chat" });
    chip().focus();
    await user.tab();
    expect(link).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(useEnduragentStore.getState().activeView).toBe("settings");
    expect(request).not.toHaveBeenCalled();

    clearTrainingRestrictionFocusRequest();
    update({ activeView: "chat" });
    fireEvent.pointerDown(link, { pointerType: "touch" });
    fireEvent.click(link, { detail: 1 });
    expect(useEnduragentStore.getState().activeView).toBe("settings");
    expect(request).not.toHaveBeenCalled();

    clearTrainingRestrictionFocusRequest();
    update({
      activeView: "chat",
      sync: {
        ...toManualSyncViewState({ status: "running", operation: 2 }),
        droppedActivities: stravaDroppedActivities(),
      },
    });
    expect(chip()).toBeDisabled();
    expect(link).toBeEnabled();
    await user.click(link);
    expect(useEnduragentStore.getState().activeView).toBe("settings");
    expect(request).not.toHaveBeenCalled();

    update({
      sync: toManualSyncViewState({
        status: "succeeded",
        operation: 2,
        kind: "no-change",
        droppedActivities: {
          overall: { total: 5, visible: 5, restrictions: [], other: 0 },
          recent7Days: { total: 5, visible: 5, restrictions: [], other: 0 },
        },
      }),
    });
    expect(chipSurface()).toHaveTextContent("Local training-data processing completed.");
    expect(chipSurface()).not.toHaveTextContent("1998-07-19 07:55:00 UTC");
    expect(chip()).not.toHaveAttribute("title");
    expect(chipSurface().querySelector("[data-info-tip]")).toBeNull();
  });

  it("reports never-synced and unavailable training data honestly", () => {
    render(<Sidebar />);

    update({ training: { ...EMPTY_TRAINING_SURFACE, status: "ready" } });
    expect(chip()).toHaveAttribute("data-status", "never");
    expect(chipSurface()).toHaveTextContent("Not synced yet");
    expect(screen.getByText("Sync now")).toHaveAttribute("data-sync-action");
    expect(chip()).toHaveAccessibleName("Sync now · Not synced yet");

    update({ training: { ...EMPTY_TRAINING_SURFACE, status: "unavailable" } });
    expect(chip()).toHaveAttribute("data-status", "unavailable");
    expect(chipSurface()).toHaveTextContent("Training data unavailable");
    expect(screen.getByText("Sync now")).toHaveAttribute("data-sync-action");
    expect(chip()).toHaveAccessibleName("Sync now · Training data unavailable");
  });

  it("requests a manual sync and restores keyboard focus to the activator", async () => {
    const user = userEvent.setup();
    const request = vi.fn();
    useEnduragentStore.setState({ syncActions: { request } });
    render(<Sidebar />);

    await user.click(chip());
    expect(request).toHaveBeenNthCalledWith(1, "pointer");
    act(() => {
      chip().blur();
    });
    restoreManualSyncFocus();
    expect(document.activeElement).toBe(document.body);

    fireEvent.click(chip());
    expect(request).toHaveBeenNthCalledWith(2, "keyboard");
    restoreManualSyncFocus();
    expect(document.activeElement).toBe(chip());
  });

  it("restores keyboard focus to the chip wrapper when the activator becomes disabled", () => {
    const request = vi.fn();
    useEnduragentStore.setState({ syncActions: { request } });
    render(<Sidebar />);

    fireEvent.click(chip());
    expect(request).toHaveBeenCalledWith("keyboard");
    update({ sync: toManualSyncViewState({ status: "running", operation: 1 }) });
    act(() => {
      chip().blur();
      restoreManualSyncFocus();
    });

    expect(chip()).toBeDisabled();
    expect(chipSurface()).toHaveAttribute("tabindex", "-1");
    expect(document.activeElement).toBe(chipSurface());
  });

  it("stays inert until the sync controller is bound", () => {
    render(<Sidebar />);

    expect(chip()).toBeDisabled();
  });
});

describe("sidebar setup gating", () => {
  it("does not repeat setup readiness in the resident sidebar", () => {
    render(<Sidebar />);
    expect(document.querySelector("[data-sidebar-setup-readiness]")).toBeNull();
    expect(document.querySelector("[data-sidebar-setup-dot]")).toBeNull();
    expect(screen.queryByText("Ready")).toBeNull();
    expect(screen.queryByText("Waiting for setup")).toBeNull();
    expect(screen.queryByText("Checking setup…")).toBeNull();
  });

  it("has no Setup destination and keeps non-chat destinations usable", async () => {
    const user = userEvent.setup();
    useEnduragentStore.setState({ onboarding: CLOSED_ONBOARDING });
    render(<Sidebar />);

    expect(screen.queryByRole("button", { name: "Setup" })).toBeNull();
    expect(screen.getByRole("button", { name: "New chat" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Training" }));
    expect(useEnduragentStore.getState().activeView).toBe("training");
  });
});
