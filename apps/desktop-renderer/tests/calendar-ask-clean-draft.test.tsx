import type { CoachClient } from "@enduragent/coach-client";
import type {
  AttachmentCapabilitiesReadModel,
  ChatAttachmentComposerReadModel,
  ListPlansResult,
  PlanCalendarRideReview,
} from "@enduragent/coach-contract";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ACTIVITY_REVIEW_START } from "../src/activity-review/controller";
import { RIDE_REVIEW_NONE } from "../src/activity-review/review-controller";
import { startCalendarPages } from "../src/page-wiring";
import {
  EMPTY_CHAT_SURFACE,
  EMPTY_PLAN_CHANGE_SURFACE,
  type ChatActions,
} from "../src/state/chat-slice";
import { READY_ONBOARDING } from "../src/state/onboarding-slice";
import { EMPTY_PLAN_SURFACE, type PlanLibraryActions } from "../src/state/plan-slice";
import { useEnduragentStore as store } from "../src/state/store";
import { EMPTY_TRAINING_SURFACE } from "../src/state/training-slice";
import { ChatView } from "../src/ui/chat/ChatView";
import { TODAY, ride, rideId, rides } from "./activity-review-fixture";
import { PLAN_ID, workoutId } from "./calendar-fixture";
import { renderLocalized as render } from "./language-harness";

const SETTLED = { timeout: 1_500 };
const CHANGE_DRAFT = "Please change “Long endurance” on Wed 14 Jan:";
const SECOND_CHANGE_DRAFT = "Please change “Tempo” on Thu 15 Jan:";
const SET_ASIDE_NOTICE = "Your earlier draft comes back after this change.";

const CAPABILITIES: AttachmentCapabilitiesReadModel = {
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
    checkedAt: "1998-09-02T00:00:00.000Z",
  },
};

function surface(text: string | null): ChatAttachmentComposerReadModel {
  return {
    schemaVersion: 1,
    capabilities: CAPABILITIES,
    draft:
      text === null || text.length === 0
        ? null
        : {
            schemaVersion: 1,
            chatId: "desktop",
            text,
            state: "active",
            updatedAt: "1998-09-02T00:00:00.000Z",
            attachments: [],
          },
  };
}

function activeLibrary(planId = PLAN_ID): ListPlansResult {
  return {
    calendarConnected: true,
    legacy: null,
    active: {
      planId,
      version: 1,
      name: "Build fitness",
      start: "1998-01-05",
      end: "1998-02-01",
      weeks: 4,
      status: "active",
      supportingEventCandidates: [],
      closeReason: null,
      closedAt: null,
      activatedAt: "1998-01-05",
      todayChoice: null,
      calendar: { status: "verified", window: null, currentThrough: "1998-01-18", error: null },
      creationId: null,
    },
    closed: [],
    creation: null,
    pendingChangeCheck: null,
    changesPaused: null,
    changes: [],
  };
}

function makeChatActions() {
  const saveAttachmentDraftText = vi.fn((text: string) => {
    queueMicrotask(() =>
      store.setState({ chat: { ...store.getState().chat, attachments: surface(text) } }),
    );
  });
  const submit = vi.fn(async (_message: string) => true);
  const backFromPlanChangeEditor = vi.fn(() => {
    const current = store.getState().planChange;
    store.setState({
      planChange: {
        ...current,
        open: false,
        textRouting: false,
        editorOpen: false,
        error: null,
        focusRequest: { target: "change", revision: (current.focusRequest?.revision ?? 0) + 1 },
      },
    });
  });
  const actions: Record<string, unknown> = {
    saveAttachmentDraftText,
    submit,
    backFromPlanChangeEditor,
  };
  return {
    saveAttachmentDraftText,
    submit,
    backFromPlanChangeEditor,
    proxy: new Proxy(actions, {
      get: (target, property: string) => target[property] ?? vi.fn(),
    }) as never as ChatActions,
  };
}

function makePlanLibraryActions(): PlanLibraryActions {
  const actions: Record<string, unknown> = {
    changeInChat: vi.fn(() => {
      const state = store.getState();
      const planId = state.planLibrary.value?.active?.planId ?? null;
      state.setPlanChange({
        ...(state.planChange.planId === planId ? state.planChange : EMPTY_PLAN_CHANGE_SURFACE),
        open: true,
        textRouting: true,
        planId,
      });
      store.getState().setActiveView("chat");
    }),
  };
  return new Proxy(actions, {
    get: (target, property: string) => target[property] ?? vi.fn(),
  }) as never as PlanLibraryActions;
}

function review(patch: Partial<PlanCalendarRideReview> = {}): PlanCalendarRideReview {
  return {
    activityId: rideId("a"),
    verdict: { state: "not-written" },
    replies: 0,
    blocked: "none",
    note: null,
    ...patch,
  };
}

function started() {
  let verdict = review();
  const call = vi.fn(async (_method: string, params: { readonly action: string }) => {
    switch (params.action) {
      case "rides":
        return rides([ride("a", TODAY, { name: "Road ride" })]);
      case "read-review":
        return { status: "review", review: verdict };
      case "write-verdict":
        verdict = review({ verdict: { state: "writing" }, replies: 1 });
        return { status: "review", review: verdict };
      default:
        return { status: "refused", reason: "no-active-plan" };
    }
  });
  const client: CoachClient = {
    handshake: {} as CoachClient["handshake"],
    call: call as never,
    close: vi.fn(async () => undefined),
  };
  const dispose = startCalendarPages(store, {
    getClient: async () => client,
    reconnect: async () => client,
    onConnectionOpen: () => () => undefined,
    close: async () => undefined,
  });
  return { dispose };
}

function composer(): HTMLTextAreaElement {
  const element = document.querySelector("textarea#message");
  if (!(element instanceof HTMLTextAreaElement)) throw new TypeError("composer missing");
  return element;
}

function askFromWorkoutCard(draft: string, id = workoutId(1)): void {
  act(() => {
    store.getState().setActiveView("calendar");
    store.getState().calendarWorkoutActions?.open(PLAN_ID, id);
    store.getState().calendarWorkoutActions?.askCoach(draft);
  });
}

let actions: ReturnType<typeof makeChatActions>;

beforeEach(() => {
  actions = makeChatActions();
  store.setState({
    activeView: "chat",
    runtimeReady: true,
    composerPrefill: null,
    planChange: EMPTY_PLAN_CHANGE_SURFACE,
    chat: { ...EMPTY_CHAT_SURFACE, attachments: surface(null) },
    firstSync: { status: "idle" },
    training: EMPTY_TRAINING_SURFACE,
    plan: EMPTY_PLAN_SURFACE,
    planLibrary: { status: "ready", value: activeLibrary() },
    planLibraryActions: makePlanLibraryActions(),
    planSurface: { status: "loading", value: null },
    planFocus: null,
    planReturnToChat: false,
    planActions: null,
    chatActions: actions.proxy,
    onboarding: READY_ONBOARDING,
  });
});

afterEach(() => {
  store.setState({
    activeView: "chat",
    composerPrefill: null,
    planChange: EMPTY_PLAN_CHANGE_SURFACE,
    planLibraryActions: null,
    activityReview: ACTIVITY_REVIEW_START,
    rideReview: RIDE_REVIEW_NONE,
  });
});

describe("Calendar workout card Ask with clean Plan-change draft", () => {
  it("sets aside an earlier draft, sends only the edited change request, and restores the earlier draft verbatim", async () => {
    const test = started();
    render(<ChatView />);
    const user = userEvent.setup();
    const earlier = "  Keep my earlier question  ";

    await user.type(composer(), earlier);
    await vi.waitFor(
      () => expect(store.getState().chat.attachments?.draft?.text).toBe(earlier),
      SETTLED,
    );

    askFromWorkoutCard(CHANGE_DRAFT);

    expect(store.getState().activeView).toBe("chat");
    expect(store.getState().planChange.textRouting).toBe(true);
    await waitFor(() => expect(composer()).toHaveValue(CHANGE_DRAFT), SETTLED);
    expect(screen.getByText(SET_ASIDE_NOTICE)).toBeVisible();
    expect(store.getState().chat.attachments?.draft?.text).toBe(earlier);

    await user.type(composer(), " make it 45 min");
    expect(composer()).toHaveValue(`${CHANGE_DRAFT} make it 45 min`);

    await user.keyboard("{Enter}");

    await vi.waitFor(() => expect(actions.submit).toHaveBeenCalledOnce(), SETTLED);
    expect(actions.submit).toHaveBeenCalledWith(`${CHANGE_DRAFT} make it 45 min`);
    await waitFor(() => expect(composer()).toHaveValue(earlier), SETTLED);
    expect(screen.queryByText(SET_ASIDE_NOTICE)).toBeNull();
    await vi.waitFor(
      () => expect(store.getState().chat.attachments?.draft?.text).toBe(earlier),
      SETTLED,
    );
    test.dispose();
  });

  it("restores the earlier draft when the athlete cancels Plan-change mode from the composer bar", async () => {
    const test = started();
    render(<ChatView />);
    const user = userEvent.setup();

    await user.type(composer(), "Keep my earlier question");
    askFromWorkoutCard(CHANGE_DRAFT);

    await waitFor(() => expect(composer()).toHaveValue(CHANGE_DRAFT), SETTLED);
    expect(screen.getByText(SET_ASIDE_NOTICE)).toBeVisible();

    await user.type(composer(), " shorten by 15 min");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(actions.backFromPlanChangeEditor).toHaveBeenCalledOnce();
    expect(store.getState().planChange.textRouting).toBe(false);
    await waitFor(() => expect(composer()).toHaveValue("Keep my earlier question"), SETTLED);
    expect(screen.queryByText(SET_ASIDE_NOTICE)).toBeNull();
    expect(actions.submit).not.toHaveBeenCalled();
    test.dispose();
  });

  it("restores the earlier draft when Plan-change mode is left externally", async () => {
    const test = started();
    render(<ChatView />);
    const user = userEvent.setup();

    await user.type(composer(), "Keep my earlier question");
    askFromWorkoutCard(CHANGE_DRAFT);

    await waitFor(() => expect(composer()).toHaveValue(CHANGE_DRAFT), SETTLED);
    expect(screen.getByText(SET_ASIDE_NOTICE)).toBeVisible();

    act(() => {
      store.getState().setPlanChange({
        ...store.getState().planChange,
        textRouting: false,
      });
    });

    await waitFor(() => expect(composer()).toHaveValue("Keep my earlier question"), SETTLED);
    expect(screen.queryByText(SET_ASIDE_NOTICE)).toBeNull();
    test.dispose();
  });

  it("preserves the original earlier draft if the athlete asks about a second workout before sending", async () => {
    const test = started();
    render(<ChatView />);
    const user = userEvent.setup();

    await user.type(composer(), "Original chat draft");
    askFromWorkoutCard(CHANGE_DRAFT, workoutId(1));
    await waitFor(() => expect(composer()).toHaveValue(CHANGE_DRAFT), SETTLED);

    askFromWorkoutCard(SECOND_CHANGE_DRAFT, workoutId(2));
    await waitFor(() => expect(composer()).toHaveValue(SECOND_CHANGE_DRAFT), SETTLED);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(composer()).toHaveValue("Original chat draft"), SETTLED);
    test.dispose();
  });

  it("keeps the edited change draft and set-aside state if sending fails, and restores on later cancel", async () => {
    actions.submit.mockResolvedValueOnce(false);
    const test = started();
    render(<ChatView />);
    const user = userEvent.setup();

    await user.type(composer(), "Keep my earlier question");
    askFromWorkoutCard(CHANGE_DRAFT);
    await waitFor(() => expect(composer()).toHaveValue(CHANGE_DRAFT), SETTLED);

    await user.type(composer(), " keep it easy");
    await user.keyboard("{Enter}");

    await vi.waitFor(() => expect(actions.submit).toHaveBeenCalledOnce(), SETTLED);
    expect(composer()).toHaveValue(`${CHANGE_DRAFT} keep it easy`);
    expect(screen.getByText(SET_ASIDE_NOTICE)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(composer()).toHaveValue("Keep my earlier question"), SETTLED);
    test.dispose();
  });

  it("discards the set-aside draft on New conversation instead of resurrecting it", async () => {
    const test = started();
    render(<ChatView />);
    const user = userEvent.setup();

    await user.type(composer(), "Draft from old conversation");
    askFromWorkoutCard(CHANGE_DRAFT);
    await waitFor(() => expect(composer()).toHaveValue(CHANGE_DRAFT), SETTLED);

    act(() => {
      store.setState({
        chat: { ...store.getState().chat, resetPhase: "resetting" },
      });
    });
    act(() => {
      store.setState({
        planChange: EMPTY_PLAN_CHANGE_SURFACE,
        chat: {
          ...store.getState().chat,
          resetPhase: "idle",
          resetCount: store.getState().chat.resetCount + 1,
          attachments: surface(null),
        },
      });
    });

    await waitFor(() => expect(composer()).toHaveValue(""), SETTLED);
    expect(screen.queryByText(SET_ASIDE_NOTICE)).toBeNull();
    test.dispose();
  });

  it("keeps one copy of each draft when Ask arrives while a coaching-choice editor is open", async () => {
    const test = started();
    render(<ChatView />);
    const user = userEvent.setup();
    const earlier = "Keep my earlier question";

    await user.type(composer(), earlier);
    act(() =>
      store.setState({
        chat: {
          ...store.getState().chat,
          decision: {
            decisionId: "decision-set-aside",
            chatId: "desktop",
            messageId: "message-set-aside",
            question: "Choose tomorrow’s priority.",
            status: "unanswered",
            options: [
              {
                id: "recovery",
                label: "Prioritize recovery",
                description: "Choose an easy day.",
                recommended: true,
                consequence: "Tomorrow becomes a recovery day.",
              },
            ],
          },
        },
      }),
    );
    await user.click(screen.getByRole("button", { name: /Something else/u }));
    expect(composer()).toBeDisabled();

    askFromWorkoutCard(CHANGE_DRAFT);

    await waitFor(() => expect(composer()).toHaveValue(CHANGE_DRAFT), SETTLED);
    expect(composer()).toBeDisabled();
    expect(store.getState().chat.attachments?.draft?.text).toBe(earlier);

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(composer()).toBeEnabled();
    expect(composer()).toHaveValue(CHANGE_DRAFT);
    expect(screen.getByText(SET_ASIDE_NOTICE)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(composer()).toHaveValue(earlier), SETTLED);
    await vi.waitFor(
      () => expect(store.getState().chat.attachments?.draft?.text).toBe(earlier),
      SETTLED,
    );
    expect(actions.submit).not.toHaveBeenCalled();
    test.dispose();
  });

  it("shows no set-aside notice and restores nothing when there was no earlier draft", async () => {
    const test = started();
    render(<ChatView />);
    const user = userEvent.setup();

    askFromWorkoutCard(CHANGE_DRAFT);

    await waitFor(() => expect(composer()).toHaveValue(CHANGE_DRAFT), SETTLED);
    expect(screen.queryByText(SET_ASIDE_NOTICE)).toBeNull();

    await user.click(screen.getByRole("button", { name: "Send message" }));
    await vi.waitFor(() => expect(actions.submit).toHaveBeenCalledWith(CHANGE_DRAFT), SETTLED);
    await waitFor(() => expect(composer()).toHaveValue(""), SETTLED);

    askFromWorkoutCard(SECOND_CHANGE_DRAFT, workoutId(2));
    await waitFor(() => expect(composer()).toHaveValue(SECOND_CHANGE_DRAFT), SETTLED);
    expect(screen.queryByText(SET_ASIDE_NOTICE)).toBeNull();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(composer()).toHaveValue(""), SETTLED);
    test.dispose();
  });

  it("keeps Activity review Ask appending after an existing draft without showing a set-aside notice", async () => {
    const test = started();
    render(<ChatView />);
    const user = userEvent.setup();

    await user.type(composer(), "Keep my question");
    act(() => store.getState().setActiveView("activity-review"));
    await vi.waitFor(() => expect(store.getState().activityReview.kind).toBe("ready"), SETTLED);
    act(() =>
      store
        .getState()
        .activityReviewActions?.askCoach("What do you make of my ride “Road ride” on Thu 20 Aug?"),
    );

    expect(store.getState().activeView).toBe("chat");
    await waitFor(
      () =>
        expect(composer()).toHaveValue(
          "Keep my question\n\nWhat do you make of my ride “Road ride” on Thu 20 Aug?",
        ),
      SETTLED,
    );
    expect(screen.queryByText(SET_ASIDE_NOTICE)).toBeNull();
    test.dispose();
  });
});
