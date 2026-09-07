import type { ListPlansResult, PlanCreationCardModel } from "@enduragent/coach-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootRenderer } from "../src/boot";
import { createChatController } from "../src/chat/controller";
import { EMPTY_PLAN_CHANGE_SURFACE } from "../src/state/chat-slice";
import { useEnduragentStore as store } from "../src/state/store";

const mocks = vi.hoisted(() => ({
  reload: vi.fn(),
  call: vi.fn(),
  refresh: vi.fn(async () => {}),
  idle: () => ({
    start: vi.fn(),
    dispose: vi.fn(),
    activate: vi.fn(),
    close: vi.fn(),
    refresh: vi.fn(async () => {}),
  }),
}));

vi.mock("../src/coach-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/coach-client")>()),
  createDesktopCoachClientProvider: () => ({
    getClient: async () => ({ call: mocks.call }),
    close: async () => {},
  }),
}));
vi.mock("../src/chat/controller", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/chat/controller")>();
  return {
    ...actual,
    createChatController: vi.fn((input) => ({
      ...actual.createChatController(input),
      start: vi.fn(),
      refreshPlanningRequests: vi.fn(),
    })),
  };
});
vi.mock("../src/plan/controller", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/plan/controller")>()),
  createPlanController: () => ({ ...mocks.idle(), refresh: mocks.refresh }),
}));
vi.mock("../src/state/adapters/plan", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/state/adapters/plan")>()),
  createPlanViewAdapter: () => ({ ...mocks.idle(), reload: mocks.reload }),
  closePlan: vi.fn(),
  readPlanHistory: vi.fn(),
  listPlans: vi.fn(),
}));
vi.mock("../src/update/controller", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/update/controller")>()),
  createDesktopUpdateController: mocks.idle,
}));
vi.mock("../src/activity-analysis/controller", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/activity-analysis/controller")>()),
  createRideAnalysisController: mocks.idle,
}));
vi.mock("../src/training-export/controller", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/training-export/controller")>()),
  createTrainingExportController: mocks.idle,
}));
vi.mock("../src/training-context/controller", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/training-context/controller")>()),
  createTrainingContextController: mocks.idle,
}));
vi.mock("../src/training-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/training-sync")>()),
  createTrainingSyncCoordinator: mocks.idle,
}));
vi.mock("../src/training-context/manual-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/training-context/manual-sync")>()),
  createManualSyncController: mocks.idle,
}));
vi.mock("../src/spend-meter/controller", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/spend-meter/controller")>()),
  createSpendMeterController: mocks.idle,
}));
vi.mock("../src/archive/controller", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/archive/controller")>()),
  createArchiveController: mocks.idle,
}));
vi.mock("../src/first-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/first-sync")>()),
  createFirstSyncController: mocks.idle,
}));
vi.mock("../src/ride-import", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ride-import")>()),
  createRideImportController: mocks.idle,
  subscribeToDroppedRideImports: () => vi.fn(),
}));
vi.mock("../src/state/adapters/ride-import", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/state/adapters/ride-import")>()),
  createRideImportAdapter: () => ({ port: {}, dispose: vi.fn() }),
}));
vi.mock("../src/onboarding/controller", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/onboarding/controller")>()),
  createOnboardingController: mocks.idle,
  onboardingCredentialMutationActive: () => false,
}));
vi.mock("../src/initial-setup-status", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/initial-setup-status")>()),
  settleInitialSetupStatus: vi.fn(),
}));
vi.mock("../src/settings/session-controller", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/settings/session-controller")>()),
  createSessionSettingsController: mocks.idle,
}));
vi.mock("../src/settings/credential-controller", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/settings/credential-controller")>()),
  createCredentialSettingsController: mocks.idle,
  credentialChangesBlocked: () => false,
}));
vi.mock("../src/settings/athlete-controller", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/settings/athlete-controller")>()),
  createAthleteSettingsController: mocks.idle,
}));
vi.mock("../src/settings/provider-model-controller", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/settings/provider-model-controller")>()),
  createProviderModelSettingsController: mocks.idle,
}));
vi.mock("../src/settings/telegram-controller", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/settings/telegram-controller")>()),
  createTelegramSettingsController: mocks.idle,
}));

const creation: PlanCreationCardModel = {
  creationId: "creation-draft",
  version: 1,
  status: "in-progress",
  readiness: "incomplete",
  draft: null,
  draftStale: false,
  commitmentsAcknowledgement: null,
  answeredSummaries: [],
  openQuestion: {
    kind: "start-timing-question",
    step: { current: 5, total: 9 },
    prompt: "When could this Plan start?",
    earliestAllowed: "1998-10-01",
    options: [
      {
        timing: "as-soon-as-possible",
        label: "As soon as possible",
        detail: "Start at the earliest suitable week.",
      },
    ],
    dateLabel: "Earliest start date",
  },
};

function library(planId: string, pending = false): ListPlansResult {
  return {
    calendarConnected: false,
    legacy: null,
    active: {
      planId,
      version: 2,
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
    closed: [],
    creation,
    changesPaused: null,
    changes: pending
      ? [
          {
            changeId: "change-pending",
            planId,
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
          },
        ]
      : [],
  };
}

function controller() {
  const result = vi.mocked(createChatController).mock.results.at(-1);
  if (result?.type !== "return") throw new Error("Chat controller was not created");
  return result.value;
}

let dispose: (() => void) | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  store.setState(store.getInitialState(), true);
  vi.stubGlobal("window", {
    localStorage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() },
    enduragentAuth: { onDroppedChatAttachments: () => vi.fn() },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("document", { documentElement: { dataset: {} } });
  vi.stubGlobal("requestAnimationFrame", vi.fn());
  dispose = bootRenderer();
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.unstubAllGlobals();
});

describe("Plan Change boot wiring", () => {
  it("reloads the Plan page and library through the chat refresh hook", async () => {
    const input = vi.mocked(createChatController).mock.calls.at(-1)?.[0];
    expect(input?.refreshPlanLibrary).toBeTypeOf("function");
    await input?.refreshPlanLibrary?.();
    expect(mocks.reload).toHaveBeenCalledOnce();
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("resets Change interaction state when opening a different Plan", () => {
    store.getState().setPlanLibrary({ status: "ready", value: library("plan-new") });
    store.getState().setPlanChange({
      ...EMPTY_PLAN_CHANGE_SURFACE,
      planId: "plan-old",
      editorOpen: true,
      error: "Previous error",
      notice: "Previous notice",
      focusRequest: { target: "editor", revision: 4 },
    });
    store.getState().planLibraryActions?.changeInChat();
    expect(store.getState().planChange).toEqual({
      ...EMPTY_PLAN_CHANGE_SURFACE,
      open: true,
      planId: "plan-new",
    });
    expect(store.getState().activeView).toBe("chat");
  });

  it("retains Change interaction state when reopening the same Plan", () => {
    store.getState().setPlanLibrary({ status: "ready", value: library("plan-active") });
    const previous = {
      ...EMPTY_PLAN_CHANGE_SURFACE,
      planId: "plan-active",
      editorOpen: true,
      error: "Current error",
      notice: "Current notice",
      focusRequest: { target: "editor", revision: 4 } as const,
    };
    store.getState().setPlanChange(previous);
    store.getState().planLibraryActions?.changeInChat();
    expect(store.getState().planChange).toEqual({ ...previous, open: true });
  });

  it("pauses creation after Continue from the library finishes loading", async () => {
    controller().resumeCreation(creation);
    store.getState().setPlanLibrary({ status: "ready", value: library("plan-active", true) });
    mocks.call.mockResolvedValueOnce({ deliveries: [], planCreation: creation });
    store.getState().planLibraryActions?.continueCreation(creation);
    await vi.waitFor(() => expect(store.getState().chat.planCreationBusy).toBe(false));
    expect(mocks.call).toHaveBeenCalledExactlyOnceWith("listPlanningRequests", {
      chatId: "desktop",
    });
    expect(store.getState().chat.planCreationError).toBeNull();
    expect(store.getState().chat.planCreationPaused).toBe(true);
  });

  it.each(["creation-first", "change-first"])(
    "keeps creation paused after Continue with a pending Change (%s)",
    (order) => {
      if (order === "creation-first") controller().resumeCreation(creation);
      store.getState().setPlanLibrary({ status: "ready", value: library("plan-active", true) });
      if (order === "change-first") controller().resumeCreation(creation);
      expect(store.getState().chat.planCreationLoaded).toBe(true);
      expect(store.getState().chat.planCreationPaused).toBe(true);
      store.getState().chatActions?.continuePlanCreation();
      expect(store.getState().chat.planCreationPaused).toBe(true);
      expect(store.getState().planLibrary.value?.changes[0]?.status).toBe("pending");
      store.getState().setPlanLibrary({ status: "ready", value: library("plan-active") });
      store.getState().chatActions?.continuePlanCreation();
      expect(store.getState().chat.planCreationPaused).toBe(false);
    },
  );
});
