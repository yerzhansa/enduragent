import type { CoachClient } from "@enduragent/coach-client";
import type {
  AttachmentCapabilitiesReadModel,
  ChatAttachmentComposerReadModel,
  PlanCalendarRideReview,
} from "@enduragent/coach-contract";
import { act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ACTIVITY_REVIEW_START } from "../src/activity-review/controller";
import { RIDE_REVIEW_NONE } from "../src/activity-review/review-controller";
import { startCalendarPages } from "../src/page-wiring";
import { EMPTY_CHAT_SURFACE, type ChatActions } from "../src/state/chat-slice";
import { READY_ONBOARDING } from "../src/state/onboarding-slice";
import { EMPTY_PLAN_SURFACE } from "../src/state/plan-slice";
import { useEnduragentStore as store } from "../src/state/store";
import { EMPTY_TRAINING_SURFACE } from "../src/state/training-slice";
import { ChatView } from "../src/ui/chat/ChatView";
import { TODAY, ride, rideId, rides } from "./activity-review-fixture";
import { renderLocalized as render } from "./language-harness";

const SETTLED = { timeout: 5_000 };

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
      text === null
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

function chatActions(): ChatActions {
  const saveAttachmentDraftText = vi.fn((text: string) => {
    queueMicrotask(() =>
      store.setState({ chat: { ...store.getState().chat, attachments: surface(text) } }),
    );
  });
  const actions: Record<string, unknown> = {
    saveAttachmentDraftText,
    submit: vi.fn(async () => true),
  };
  return new Proxy(actions, {
    get: (target, property: string) => target[property] ?? vi.fn(),
  }) as never;
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
  const actions = () => call.mock.calls.map(([, params]) => params.action);
  return { dispose, actions };
}

beforeEach(() => {
  store.setState({
    activeView: "chat",
    runtimeReady: true,
    chat: { ...EMPTY_CHAT_SURFACE, attachments: surface(null) },
    firstSync: { status: "idle" },
    training: EMPTY_TRAINING_SURFACE,
    plan: EMPTY_PLAN_SURFACE,
    planLibrary: { status: "loading", value: null },
    planSurface: { status: "loading", value: null },
    planFocus: null,
    planReturnToChat: false,
    planActions: null,
    chatActions: chatActions(),
    onboarding: READY_ONBOARDING,
  });
});

afterEach(() => {
  store.setState({
    activeView: "chat",
    activityReview: ACTIVITY_REVIEW_START,
    rideReview: RIDE_REVIEW_NONE,
  });
});

function composer(): HTMLTextAreaElement {
  const element = document.querySelector("textarea#message");
  if (!(element instanceof HTMLTextAreaElement)) throw new TypeError("composer missing");
  return element;
}

describe("Ask the coach with Chat already mounted, as Shell keeps it", () => {
  it("shows the ride question in the composer when the athlete already has a draft", async () => {
    const test = started();
    render(<ChatView />);
    const user = userEvent.setup();
    await user.type(composer(), "Keep my question");
    await vi.waitFor(
      () => expect(store.getState().chat.attachments?.draft?.text).toBe("Keep my question"),
      SETTLED,
    );
    act(() => store.getState().setActiveView("activity-review"));
    await vi.waitFor(() => expect(store.getState().activityReview.kind).toBe("ready"), SETTLED);
    act(() => store.getState().activityReviewActions?.askCoach("About my ride on Thu 20 Aug?"));
    await vi.waitFor(() => expect(store.getState().activeView).toBe("chat"), SETTLED);
    expect(store.getState().chat.attachments?.draft?.text).toBe(
      "Keep my question\n\nAbout my ride on Thu 20 Aug?",
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(composer()).toHaveValue("Keep my question\n\nAbout my ride on Thu 20 Aug?");
    test.dispose();
  });

  it("control: shows the ride question when the composer is empty", async () => {
    const test = started();
    render(<ChatView />);
    act(() => store.getState().setActiveView("activity-review"));
    await vi.waitFor(() => expect(store.getState().activityReview.kind).toBe("ready"), SETTLED);
    act(() => store.getState().activityReviewActions?.askCoach("About my ride on Thu 20 Aug?"));
    await vi.waitFor(() => expect(store.getState().activeView).toBe("chat"), SETTLED);
    await waitFor(() => expect(composer()).toHaveValue("About my ride on Thu 20 Aug?"), SETTLED);
    test.dispose();
  });

  it("puts the question alone while a send waits for its acknowledgement", async () => {
    let acknowledge: (acknowledged: boolean) => void = () => undefined;
    const submit = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          acknowledge = resolve;
        }),
    );
    store.setState({
      chatActions: { ...(store.getState().chatActions as ChatActions), submit } as never,
    });
    const test = started();
    render(<ChatView />);
    const user = userEvent.setup();
    await user.type(composer(), "Sent before the ride question{Enter}");
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce(), SETTLED);
    act(() => store.getState().setActiveView("activity-review"));
    await vi.waitFor(() => expect(store.getState().activityReview.kind).toBe("ready"), SETTLED);
    act(() => store.getState().activityReviewActions?.askCoach("About my ride on Thu 20 Aug?"));
    await waitFor(() => expect(composer()).toHaveValue("About my ride on Thu 20 Aug?"), SETTLED);
    await act(async () => acknowledge(true));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(composer()).toHaveValue("About my ride on Thu 20 Aug?");
    expect(store.getState().chat.attachments?.draft?.text).toBe("About my ride on Thu 20 Aug?");
    test.dispose();
  });

  it("adds the question once when the athlete asks twice", async () => {
    const test = started();
    render(<ChatView />);
    const user = userEvent.setup();
    await user.type(composer(), "Keep my question");
    act(() => store.getState().setActiveView("activity-review"));
    await vi.waitFor(() => expect(store.getState().activityReview.kind).toBe("ready"), SETTLED);
    act(() => store.getState().activityReviewActions?.askCoach("About my ride on Thu 20 Aug?"));
    await waitFor(
      () => expect(composer()).toHaveValue("Keep my question\n\nAbout my ride on Thu 20 Aug?"),
      SETTLED,
    );
    act(() => store.getState().setActiveView("activity-review"));
    act(() => store.getState().activityReviewActions?.askCoach("About my ride on Thu 20 Aug?"));
    expect(store.getState().activeView).toBe("chat");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(composer()).toHaveValue("Keep my question\n\nAbout my ride on Thu 20 Aug?");
    test.dispose();
  });
});

describe("Ask the coach around a message the athlete sent", () => {
  it("does not bring back a Tab-completed slash command once it was sent", async () => {
    const test = started();
    render(<ChatView />);
    const user = userEvent.setup();
    await user.type(composer(), "/stat");
    await user.keyboard("{Enter}");
    expect(composer()).toHaveValue("/status ");
    await user.keyboard("{Enter}");
    await vi.waitFor(
      () => expect(store.getState().chatActions?.submit).toHaveBeenCalled(),
      SETTLED,
    );
    await vi.waitFor(() => expect(composer()).toHaveValue(""), SETTLED);
    act(() => store.getState().setActiveView("activity-review"));
    await vi.waitFor(() => expect(store.getState().activityReview.kind).toBe("ready"), SETTLED);
    act(() => store.getState().activityReviewActions?.askCoach("About my ride?"));
    await vi.waitFor(() => expect(store.getState().activeView).toBe("chat"), SETTLED);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(composer()).toHaveValue("About my ride?");
    test.dispose();
  });

  it("keeps what the athlete typed after pressing send when Ask comes before the acknowledgement", async () => {
    let acknowledge: (acknowledged: boolean) => void = () => undefined;
    const submit = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          acknowledge = resolve;
        }),
    );
    store.setState({
      chatActions: { ...(store.getState().chatActions as ChatActions), submit } as never,
    });
    const test = started();
    render(<ChatView />);
    const user = userEvent.setup();
    await user.type(composer(), "First message{Enter}");
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce(), SETTLED);
    await user.clear(composer());
    await user.type(composer(), "Typed while it sends");
    act(() => store.getState().setActiveView("activity-review"));
    await vi.waitFor(() => expect(store.getState().activityReview.kind).toBe("ready"), SETTLED);
    act(() => store.getState().activityReviewActions?.askCoach("About my ride?"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await act(async () => acknowledge(true));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(composer()).toHaveValue("Typed while it sends\n\nAbout my ride?");
    test.dispose();
  });
});

describe("both Ask the coach buttons with a draft already typed", () => {
  it("adds the Calendar card's question, then Activity review's, after the draft, and sends nothing", async () => {
    const test = started();
    render(<ChatView />);
    const user = userEvent.setup();
    await user.type(composer(), "Keep my question");
    act(() => {
      store.getState().setActiveView("calendar");
      store.getState().calendarWorkoutActions?.open(`${"0".repeat(25)}P`, `${"0".repeat(24)}11`);
      store
        .getState()
        .calendarWorkoutActions?.askCoach("Please change “Long endurance” on Wed 14 Jan:");
    });
    expect(store.getState().activeView).toBe("chat");
    await waitFor(
      () =>
        expect(composer()).toHaveValue(
          "Keep my question\n\nPlease change “Long endurance” on Wed 14 Jan:",
        ),
      SETTLED,
    );
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
          "Keep my question\n\nPlease change “Long endurance” on Wed 14 Jan:\n\nWhat do you make of my ride “Road ride” on Thu 20 Aug?",
        ),
      SETTLED,
    );
    await vi.waitFor(
      () =>
        expect(store.getState().chat.attachments?.draft?.text).toBe(
          "Keep my question\n\nPlease change “Long endurance” on Wed 14 Jan:\n\nWhat do you make of my ride “Road ride” on Thu 20 Aug?",
        ),
      SETTLED,
    );
    expect(store.getState().chatActions?.submit).not.toHaveBeenCalled();
    test.dispose();
  });
});
