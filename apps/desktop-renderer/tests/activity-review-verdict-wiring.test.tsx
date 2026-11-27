import type { CoachClient } from "@enduragent/coach-client";
import type {
  AttachmentCapabilitiesReadModel,
  ChatAttachmentComposerReadModel,
  PlanCalendarRideReview,
} from "@enduragent/coach-contract";
import { act, waitFor } from "@testing-library/react";
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
  return new Proxy({ saveAttachmentDraftText, submit: vi.fn(async () => true) } as never, {
    get: (target: Record<string, unknown>, property: string) => target[property] ?? vi.fn(),
  });
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

describe("the coach's verdict wiring", () => {
  it("reads the shown ride's verdict and asks for it once per page open", async () => {
    const test = started();
    act(() => store.getState().setActiveView("activity-review"));
    await vi.waitFor(() => expect(store.getState().rideReview.kind).toBe("ready"));
    await vi.waitFor(() =>
      expect(test.actions()).toEqual(["rides", "read-review", "write-verdict"]),
    );
    act(() => store.getState().activityReviewActions?.refresh());
    await vi.waitFor(() =>
      expect(test.actions().filter((a) => a === "read-review")).toHaveLength(2),
    );
    expect(test.actions().filter((action) => action === "write-verdict")).toHaveLength(1);
    act(() => store.getState().setActiveView("chat"));
    expect(store.getState().rideReview).toEqual({ kind: "none" });
    test.dispose();
  });
});

describe("Ask the coach about this ride", () => {
  it("opens Chat with a draft that names the ride and sends nothing", async () => {
    const test = started();
    act(() => store.getState().setActiveView("activity-review"));
    await vi.waitFor(() => expect(store.getState().activityReview.kind).toBe("ready"));
    act(() =>
      store
        .getState()
        .activityReviewActions?.askCoach("What do you make of my ride on Thu 20 Aug, Road ride?"),
    );
    await vi.waitFor(() => expect(store.getState().activeView).toBe("chat"));
    render(<ChatView />);
    await waitFor(() =>
      expect(composer()).toHaveValue("What do you make of my ride on Thu 20 Aug, Road ride?"),
    );
    expect(store.getState().chatActions?.submit).not.toHaveBeenCalled();
    test.dispose();
  });

  it("keeps a draft the athlete already started and adds the ride after it", async () => {
    const test = started();
    store.setState({
      chat: { ...store.getState().chat, attachments: surface("Keep my question") },
    });
    act(() => store.getState().setActiveView("activity-review"));
    await vi.waitFor(() => expect(store.getState().activityReview.kind).toBe("ready"));
    act(() => store.getState().activityReviewActions?.askCoach("About my ride on Thu 20 Aug?"));
    await vi.waitFor(() => expect(store.getState().activeView).toBe("chat"));
    render(<ChatView />);
    await waitFor(() =>
      expect(composer()).toHaveValue("Keep my question\n\nAbout my ride on Thu 20 Aug?"),
    );
    test.dispose();
  });
});
