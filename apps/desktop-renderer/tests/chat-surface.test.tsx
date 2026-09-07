import { readUiStylesheet } from "./ui-styles";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  AttachmentCapabilitiesReadModel,
  ChatAttachmentComposerReadModel,
  CoachDecisionReadModel,
  PlanCreationCardModel,
  PlanCreationOpenQuestion,
  PlanningRequestDelivery,
  PlanningRequestReadModel,
} from "@enduragent/coach-contract";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../src/app/Shell";
import {
  EMPTY_CHAT_SURFACE,
  type ChatActions,
  type ChatMessageView,
  type ChatSurfaceState,
} from "../src/state/chat-slice";
import { resetChatStream } from "../src/state/chat-stream";
import { CLOSED_ONBOARDING, READY_ONBOARDING } from "../src/state/onboarding-slice";
import { EMPTY_TRAINING_SURFACE } from "../src/state/training-slice";
import { useEnduragentStore } from "../src/state/store";
import { SLASH_COMMANDS } from "../src/chat/commands";
import { ChatView } from "../src/ui/chat/ChatView";
import { planCreationDraft } from "./plan-creation-draft-fixtures";
import { planReadModel } from "./plan-fixtures";
import { EMPTY_PLAN_SURFACE } from "../src/state/plan-slice";

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

function setChat(patch: Partial<ChatSurfaceState>): void {
  act(() => {
    useEnduragentStore.setState({ chat: { ...useEnduragentStore.getState().chat, ...patch } });
  });
}

function Harness(): ReactElement {
  return <ChatView />;
}

function composer(): HTMLTextAreaElement {
  const element = document.querySelector("textarea#message");
  if (!(element instanceof HTMLTextAreaElement)) throw new TypeError("composer missing");
  return element;
}

type PlanLengthQuestion = Extract<
  PlanCreationOpenQuestion,
  { readonly kind: "plan-length-question" }
>;
type GoalQuestion = Extract<PlanCreationOpenQuestion, { readonly kind: "goal-question" }>;
type SuccessQuestion = Extract<PlanCreationOpenQuestion, { readonly kind: "success-question" }>;
type StartTimingQuestion = Extract<
  PlanCreationOpenQuestion,
  { readonly kind: "start-timing-question" }
>;
type AvailabilityQuestion = Extract<
  PlanCreationOpenQuestion,
  { readonly kind: "availability-question" }
>;
type CommitmentsQuestion = Extract<
  PlanCreationOpenQuestion,
  { readonly kind: "commitments-question" }
>;
type ScheduleModeQuestion = Extract<
  PlanCreationOpenQuestion,
  { readonly kind: "schedule-mode-question" }
>;
type BaselineQuestion = Extract<PlanCreationOpenQuestion, { readonly kind: "baseline-question" }>;
type RestrictionQuestion = Extract<
  PlanCreationOpenQuestion,
  { readonly kind: "restriction-question" }
>;

const fixtureStep = { current: 1, total: 9 } as const;
const fixtureAuthoredOption = {
  label: "Something else",
  detail: "Answer in your own words.",
  editorLabel: "Write your answer.",
  placeholder: "Type an answer",
} as const;

function goalQuestion(prompt: string): GoalQuestion {
  return {
    kind: "goal-question",
    step: fixtureStep,
    prompt,
    candidates: [],
    eventNotListedOption: {
      label: "Event not listed",
      detail: "Tell me the event name and its exact date.",
      editorLabel: "Name the event and include its exact date.",
      placeholder: "Event name",
      nameLabel: "Event name",
      dateLabel: "Event date",
    },
    fitnessOption: {
      label: "Improve without an event",
      detail: "Build fitness for a fixed number of weeks.",
    },
    authoredOption: fixtureAuthoredOption,
  } satisfies PlanCreationOpenQuestion;
}

function fitnessSuccessQuestion(prompt: string, placeholder = "Describe success"): SuccessQuestion {
  return {
    kind: "success-question",
    step: fixtureStep,
    prompt,
    input: {
      kind: "fitness-choice",
      options: [
        {
          choice: "train-consistently",
          label: "Train consistently",
          detail: "Repeat most planned weeks.",
        },
        {
          choice: "climb-stronger",
          label: "Climb stronger",
          detail: "Hold steady on longer climbs.",
        },
        {
          choice: "ride-farther",
          label: "Ride farther comfortably",
          detail: "Finish longer rides comfortably.",
        },
      ],
      authored: {
        label: fixtureAuthoredOption.label,
        detail: fixtureAuthoredOption.detail,
        editorLabel: fixtureAuthoredOption.editorLabel,
      },
      placeholder,
    },
  } satisfies PlanCreationOpenQuestion;
}

function eventSuccessQuestion(prompt: string): SuccessQuestion {
  return {
    kind: "success-question",
    step: fixtureStep,
    prompt,
    input: {
      kind: "event-finish",
      options: [
        {
          choice: "finish-comfortably",
          label: "Finish comfortably",
          detail: "Complete the event feeling in control.",
        },
        { choice: "finish-fast", label: "Finish fast", detail: "Aim for a faster finish." },
        {
          choice: "race-for-result",
          label: "Race for a result",
          detail: "Prepare for a competitive result.",
        },
      ],
      authored: fixtureAuthoredOption,
    },
  } satisfies PlanCreationOpenQuestion;
}

function planLengthQuestion(prompt: string): PlanLengthQuestion {
  return {
    kind: "plan-length-question",
    step: fixtureStep,
    prompt,
    options: [
      { weeks: 4, label: "4 weeks", detail: "Choose a 4-week Plan." },
      { weeks: 8, label: "8 weeks", detail: "Choose an 8-week Plan." },
      { weeks: 12, label: "12 weeks", detail: "Choose a 12-week Plan." },
      { weeks: 16, label: "16 weeks", detail: "Choose a 16-week Plan." },
    ],
  } satisfies PlanCreationOpenQuestion;
}

function startTimingQuestion(prompt: string, earliestAllowed: string): StartTimingQuestion {
  return {
    kind: "start-timing-question",
    step: fixtureStep,
    prompt,
    earliestAllowed,
    options: [
      {
        timing: "as-soon-as-possible",
        label: "As soon as possible",
        detail: "Start at the earliest suitable week.",
      },
      { timing: "earliest", label: "From a date", detail: "Set an earliest date." },
    ],
    dateLabel: "Earliest start date",
  } satisfies PlanCreationOpenQuestion;
}

function commitmentsQuestion(prompt: string, placeholder: string): CommitmentsQuestion {
  return {
    kind: "commitments-question",
    step: fixtureStep,
    prompt,
    noneOption: { label: "Nothing fixed", detail: "There is nothing fixed to add." },
    authoredOption: {
      ...fixtureAuthoredOption,
      editorLabel: "Scheduling details",
      placeholder,
    },
  } satisfies PlanCreationOpenQuestion;
}

function scheduleModeQuestion(prompt: string): ScheduleModeQuestion {
  return {
    kind: "schedule-mode-question",
    step: fixtureStep,
    prompt,
    options: [
      {
        mode: "fixed",
        label: "Fixed Schedule",
        detail: "Place each Workout on one of your available weekdays.",
      },
      {
        mode: "flexible",
        label: "Flexible Schedule",
        detail: "Choose from an ordered Workout pool during each week.",
      },
    ],
  } satisfies PlanCreationOpenQuestion;
}

function availabilityQuestion(
  prompt: string,
  mode: AvailabilityQuestion["mode"],
  derivedPoolNote: string,
): AvailabilityQuestion {
  return {
    kind: "availability-question",
    step: fixtureStep,
    prompt,
    mode,
    weeklyHoursOptions: [
      { id: "hours-6", weeklyHoursLimit: 6, label: "5–6 hours", detail: "Usual volume." },
      { id: "hours-8", weeklyHoursLimit: 8, label: "7–8 hours", detail: "A small step." },
      { id: "hours-10", weeklyHoursLimit: 10, label: "9+ hours", detail: "More volume." },
    ],
    longestWorkoutLabel: "Longest ride in hours",
    weekdayOptions: [
      { weekday: 1, label: "Mon" },
      { weekday: 2, label: "Tue" },
      { weekday: 3, label: "Wed" },
      { weekday: 4, label: "Thu" },
      { weekday: 5, label: "Fri" },
      { weekday: 6, label: "Sat" },
      { weekday: 7, label: "Sun" },
    ],
    derivedPoolNote,
  } satisfies PlanCreationOpenQuestion;
}

function baselineQuestion(prompt: string): BaselineQuestion {
  return {
    kind: "baseline-question",
    step: fixtureStep,
    prompt,
    options: [
      { baseline: "regular", label: "Regular", detail: "Consistent training." },
      { baseline: "occasional", label: "Occasional", detail: "Some training." },
      { baseline: "starting-again", label: "Starting again", detail: "Returning to training." },
    ],
  } satisfies PlanCreationOpenQuestion;
}

function restrictionQuestion(prompt: string): RestrictionQuestion {
  return {
    kind: "restriction-question",
    step: fixtureStep,
    prompt,
    options: [
      { kind: "none", label: "None", detail: "No Training Restriction." },
      { kind: "no-training", label: "No training", detail: "Schedule no training." },
      {
        kind: "no-hard-training",
        label: "No hard training",
        detail: "Schedule no hard training.",
      },
      {
        kind: "max-duration",
        label: "Maximum Workout duration",
        detail: "Limit each Workout duration.",
      },
    ],
  } satisfies PlanCreationOpenQuestion;
}

type PlanCreationSummaryFixture = Omit<
  PlanCreationCardModel["answeredSummaries"][number],
  "source"
> & {
  readonly source?: PlanCreationCardModel["answeredSummaries"][number]["source"];
};

interface PlanCreationModelPatch {
  readonly version?: number;
  readonly readiness?: PlanCreationCardModel["readiness"];
  readonly answeredSummaries?: readonly PlanCreationSummaryFixture[];
}

function planCreationModel(
  openQuestion: PlanCreationOpenQuestion | null,
  patch: PlanCreationModelPatch = {},
): PlanCreationCardModel {
  return {
    draft: null,
    draftStale: false,
    commitmentsAcknowledgement: null,
    creationId: "01J00000000000000000000000",
    version: patch.version ?? 1,
    status: "in-progress",
    readiness: patch.readiness ?? (openQuestion === null ? "ready" : "incomplete"),
    openQuestion,
    answeredSummaries: (patch.answeredSummaries ?? []).map((summary) => ({
      ...summary,
      source: summary.source ?? { kind: "athlete" },
    })),
  };
}

const ATTACHMENT_CAPABILITIES: AttachmentCapabilitiesReadModel = {
  schemaVersion: 1,
  active: { provider: "test", model: "vision", transport: "test" },
  documents: { enabled: true, extensions: ["pdf", "txt", "csv", "docx"] },
  completedActivities: { enabled: true, extensions: ["fit", "tcx", "gpx"] },
  plannedWorkouts: { enabled: true, extensions: ["zwo", "erg", "mrc"] },
  images: {
    enabled: true,
    mediaTypes: ["image/png", "image/jpeg", "image/webp"],
    reason: "supported",
    source: "maintained_catalogue",
    checkedAt: "2026-08-26T00:00:00.000Z",
  },
};

function attachmentSurface(
  attachment: NonNullable<ChatAttachmentComposerReadModel["draft"]>["attachments"][number],
  text = "Review this",
  state: "active" | "restored" = "active",
): ChatAttachmentComposerReadModel {
  return {
    schemaVersion: 1,
    capabilities: ATTACHMENT_CAPABILITIES,
    draft: {
      schemaVersion: 1,
      chatId: "desktop",
      text,
      state,
      updatedAt: "2026-08-26T00:00:00.000Z",
      attachments: [attachment],
    },
  };
}

function planningDelivery(
  lifecycle: "open" | "applied" | "rejected" = "open",
): PlanningRequestDelivery {
  const terminal: PlanningRequestReadModel["terminalResult"] =
    lifecycle === "applied"
      ? {
          kind: "applied",
          resultId: "result-1",
          completedAtMs: 3,
          title: "Added to Plan",
          detail: "Tempo 3 × 12 · Wednesday · 64 min",
          workoutRef: { setId: "set-1", workoutId: "tempo" },
          planRevisionId: "revision-1",
        }
      : lifecycle === "rejected"
        ? {
            kind: "rejected",
            resultId: "result-1",
            completedAtMs: 3,
            title: "Proposal rejected",
            detail: "The active Plan remains unchanged.",
            workoutRef: { setId: "set-1", workoutId: "tempo" },
            planRevisionId: null,
          }
        : null;
  return {
    requestId: "request-plan-1",
    source: {
      kind: "workout_review",
      intent: "Review Tempo 3 × 12 in Plan.",
      chatId: "desktop",
      messageId: "message-plan-1",
      attachmentId: "attachment-workout",
    },
    state: "delivered",
    attemptCount: 1,
    failureCode: null,
    retryable: false,
    createdAtMs: 1,
    updatedAtMs: 3,
    deliveredAtMs: 2,
    planningRequest: {
      requestId: "request-plan-1",
      kind: "workout_review",
      target: "active_plan",
      intent: "Review Tempo 3 × 12 in Plan.",
      planConversationId: "plan-conversation-1",
      proposalId: lifecycle === "open" ? "proposal-1" : null,
      requestedDateKey: null,
      resolvedDateKey: null,
      source: { chatId: "desktop", messageId: "message-plan-1", available: true },
      lifecycle,
      attention: lifecycle === "open" ? "needs_review" : "none",
      revision: 1,
      createdAtMs: 1,
      updatedAtMs: 3,
      terminalResult: terminal,
    },
  };
}

function unansweredDecision(): Extract<CoachDecisionReadModel, { status: "unanswered" }> {
  return {
    decisionId: "decision-1",
    chatId: "desktop",
    messageId: "message-1",
    question: "Choose tomorrow’s priority.",
    status: "unanswered",
    options: [
      {
        id: "recovery",
        label: "Prioritize recovery",
        description: "Choose an easy day to protect the weekend session.",
        recommended: true,
        consequence: "Tomorrow becomes a recovery day.",
      },
      {
        id: "tempo",
        label: "Keep the tempo session",
        description: "Keep the planned workout if your legs feel normal.",
        recommended: false,
        consequence: "Tomorrow keeps the planned tempo session.",
      },
    ],
  };
}

let actions: ChatActions;

describe("chat surface", () => {
  beforeEach(() => {
    actions = stubActions();
    useEnduragentStore.setState({
      activeView: "chat",
      runtimeReady: true,
      chat: EMPTY_CHAT_SURFACE,
      firstSync: { status: "idle" },
      training: EMPTY_TRAINING_SURFACE,
      plan: EMPTY_PLAN_SURFACE,
      planSurface: { status: "loading", value: null },
      planFocus: null,
      planReturnToChat: false,
      planActions: null,
      chatActions: actions,
      onboarding: READY_ONBOARDING,
    });
  });

  afterEach(() => {
    useEnduragentStore.setState({
      chat: EMPTY_CHAT_SURFACE,
      firstSync: { status: "idle" },
      training: EMPTY_TRAINING_SURFACE,
      plan: EMPTY_PLAN_SURFACE,
      planSurface: { status: "loading", value: null },
      planFocus: null,
      planReturnToChat: false,
      planActions: null,
      chatActions: null,
      onboarding: CLOSED_ONBOARDING,
    });
    resetChatStream();
  });

  it("renders completed Plan activation once as a transcript status", () => {
    render(<Harness />);
    setChat({
      planCreation: null,
      planCreationLoaded: true,
      timeline: [{ kind: "plan-creation", model: null }],
    });
    expect(screen.getAllByText("Plan activated locally.")).toHaveLength(1);
    expect(screen.getByText("Plan activated locally.")).toHaveAttribute("role", "status");
    expect(document.querySelector(".chat-notice")).not.toBeVisible();
  });

  it("preserves and focuses the draft after enqueue failure and clears only after acknowledgment", async () => {
    const user = userEvent.setup();
    let reject!: (error: Error) => void;
    const failed = new Promise<boolean>((_resolve, fail) => {
      reject = fail;
    });
    vi.mocked(actions.submit).mockReturnValueOnce(failed).mockResolvedValueOnce(true);
    render(<Harness />);
    const input = composer();
    await user.type(input, "Keep this draft");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(input).toHaveValue("Keep this draft");
    reject(new Error("durable enqueue failed"));
    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toHaveValue("Keep this draft");

    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(input).toHaveValue(""));
  });

  describe("Coach decision", () => {
    it("blocks normal Send and submits a numbered option through the decision action", async () => {
      const user = userEvent.setup();
      setChat({
        decision: unansweredDecision(),
        sendDisabled: true,
        inputDisabled: false,
      });
      render(<Harness />);

      expect(screen.getByText("Coach needs your answer")).toBeVisible();
      expect(screen.getByRole("heading", { name: "Choose tomorrow’s priority." })).toBeVisible();
      expect(screen.getByText("Recommended")).toBeVisible();
      expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
      expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();

      await user.click(screen.getByRole("button", { name: /Keep the tempo session/u }));
      expect(actions.answerDecision).toHaveBeenCalledWith("decision-1", {
        kind: "option",
        optionId: "tempo",
      });
      await user.keyboard("{Escape}");
      expect(actions.skipDecision).toHaveBeenCalledWith("decision-1");
    });

    it("replaces all options with one custom editor and preserves the normal draft", async () => {
      const user = userEvent.setup();
      render(<Harness />);
      const normalComposer = composer();
      await user.type(normalComposer, "Keep this draft");
      setChat({ decision: unansweredDecision(), sendDisabled: true, inputDisabled: false });

      await user.click(screen.getByRole("button", { name: /Something else/u }));
      expect(screen.queryByRole("button", { name: /Prioritize recovery/u })).toBeNull();
      expect(normalComposer).not.toBeVisible();
      const custom = screen.getByLabelText("What would work better?");
      await user.type(custom, "Move tempo to Thursday");
      const back = screen.getByRole("button", { name: "Back" });
      const continueButton = screen.getByRole("button", { name: "Continue" });
      expect(
        back.compareDocumentPosition(continueButton) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();

      await user.click(continueButton);
      expect(actions.answerDecision).toHaveBeenCalledWith("decision-1", {
        kind: "custom",
        text: "Move tempo to Thursday",
      });
      await user.click(back);
      expect(composer()).toHaveValue("Keep this draft");
      expect(screen.getByRole("button", { name: /Something else/u })).toHaveFocus();
    });

    it("shows continuing and relaunch recovery states", () => {
      const pending: CoachDecisionReadModel = {
        ...unansweredDecision(),
        status: "answered",
        answer: { kind: "option", optionId: "recovery" },
        consequence: "Tomorrow becomes a recovery day.",
        continuation: { continuationId: "continuation-1", status: "pending" },
      };
      setChat({
        decision: pending,
        decisionPhase: "continuing",
        decisionAnswerLabel: "Prioritize recovery",
        sendDisabled: true,
        inputDisabled: false,
      });
      const { rerender } = render(<Harness />);
      expect(screen.getByText("Continuing with your choice…")).toBeVisible();

      setChat({ decisionPhase: "recovering" });
      rerender(<Harness />);
      expect(screen.getByText("Finishing your saved choice…")).toBeVisible();
      expect(screen.getByText(/was saved before Enduragent reopened/u)).toBeVisible();
    });

    it("shows a settled retry state when a saved continuation stops", async () => {
      const user = userEvent.setup();
      const pending: CoachDecisionReadModel = {
        ...unansweredDecision(),
        status: "answered",
        answer: { kind: "option", optionId: "recovery" },
        consequence: "Tomorrow becomes a recovery day.",
        continuation: { continuationId: "continuation-1", status: "pending" },
      };
      setChat({
        decision: pending,
        decisionPhase: "recovering",
        decisionAnswerLabel: "Prioritize recovery",
        decisionError: "Response stopped. Your partial response is preserved.",
        sendDisabled: true,
        inputDisabled: false,
      });
      render(<Harness />);

      const title = screen.getByText("Your choice is saved");
      const panel = title.closest("section");
      expect(panel).not.toBeNull();
      expect(panel).not.toHaveAttribute("aria-busy");
      expect(panel?.querySelector(".animate-spin")).toBeNull();
      expect(screen.getByText("Prioritize recovery")).toBeVisible();
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Response stopped. Your partial response is preserved.",
      );
      expect(screen.queryByText(/before Enduragent reopened/u)).toBeNull();
      expect(screen.queryByText("Finishing your saved choice…")).toBeNull();

      await user.click(screen.getByRole("button", { name: "Try again" }));
      expect(actions.retryDecision).toHaveBeenCalledOnce();
    });

    it("surfaces a decision hydration failure with a reconnect action", async () => {
      const user = userEvent.setup();
      setChat({
        decisionLoadError: "We couldn’t check for a saved Coach question.",
        sendDisabled: true,
        inputDisabled: false,
      });
      render(<Harness />);

      expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
      expect(screen.getByRole("alert")).toHaveTextContent("saved Coach question");
      await user.click(screen.getByRole("button", { name: "Reconnect" }));
      expect(actions.retryDecision).toHaveBeenCalledOnce();
    });

    it("renders recorded and skipped consequences as compact transcript items", () => {
      setChat({
        timeline: [
          {
            kind: "choice",
            choice: {
              id: "decision-1",
              label: "Prioritize recovery",
              consequence: "Tomorrow becomes a recovery day.",
              skipped: false,
              historical: false,
            },
          },
          {
            kind: "choice",
            choice: {
              id: "decision-2",
              label: "Question skipped",
              consequence: "No coaching choice was applied.",
              skipped: true,
              historical: true,
            },
          },
          {
            kind: "choice",
            choice: {
              id: "decision-3",
              label: "Move tempo to Thursday",
              consequence: null,
              skipped: false,
              historical: true,
            },
          },
        ],
      });
      render(<Harness />);

      expect(screen.getAllByLabelText("Choice consequence")).toHaveLength(3);
      expect(screen.getByText("Prioritize recovery")).toBeVisible();
      expect(screen.getByText("Question skipped")).toBeVisible();
      expect(screen.getAllByText("Move tempo to Thursday")).toHaveLength(1);
    });

    it("leaves provider text fallback as an ordinary Coach response", () => {
      setChat({
        messages: [
          {
            id: "fallback",
            role: "coach",
            delivery: "complete",
            historical: false,
            text: "1. Prioritize recovery\n2. Keep the tempo session\nYou can answer in your own words or say skip.",
          },
        ],
        timeline: [
          {
            kind: "message",
            message: {
              id: "fallback",
              role: "coach",
              delivery: "complete",
              historical: false,
              text: "1. Prioritize recovery\n2. Keep the tempo session\nYou can answer in your own words or say skip.",
            },
          },
        ],
      });
      render(<Harness />);

      expect(screen.queryByText("Coach needs your answer")).toBeNull();
      expect(screen.getByText(/Prioritize recovery/u)).toBeVisible();
    });
  });

  describe("Reading room shell", () => {
    it("renders one quiet header and toggles the wide Training context", async () => {
      const user = userEvent.setup();
      render(<Harness />);

      expect(screen.getByRole("heading", { name: "Chat" })).toBeInTheDocument();
      expect(screen.getByRole("complementary", { name: "Training context" })).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Hide training context" }));
      expect(screen.queryByRole("complementary", { name: "Training context" })).toBeNull();
      expect(screen.getByRole("button", { name: "Show training context" })).toBeInTheDocument();
    });

    it("keeps compact drawer focus trapped and lets Escape restore its trigger", async () => {
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(private readonly callback: ResizeObserverCallback) {}

          observe(): void {
            this.callback(
              [{ contentRect: { width: 760 } } as ResizeObserverEntry],
              this as unknown as ResizeObserver,
            );
          }

          disconnect(): void {}

          unobserve(): void {}
        },
      );
      const user = userEvent.setup();
      setChat({ decision: unansweredDecision(), sendDisabled: true, inputDisabled: false });

      try {
        render(<Harness />);
        const trigger = await screen.findByRole("button", { name: "Show training context" });
        await user.click(trigger);
        const dialog = screen.getByRole("dialog", { name: "Training context" });

        expect(dialog.contains(document.activeElement)).toBe(true);
        await user.tab();
        await user.tab();
        await user.tab({ shift: true });
        await user.tab({ shift: true });
        expect(dialog).toBeInTheDocument();
        expect(trigger).not.toHaveFocus();
        await user.keyboard("{Escape}");

        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        expect(trigger).toHaveFocus();
        expect(actions.skipDecision).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("projects only available workout, Load, and cycling-anchor facts", () => {
      act(() => {
        useEnduragentStore.setState({
          planSurface: {
            status: "ready",
            value: {
              schemaVersion: 1,
              status: "ready",
              asOfDateKey: 19980825,
              plan: {
                id: "plan-1",
                name: "Eight-week consistency",
                goal: "Build consistency",
                lifecycle: "active",
                startDateKey: 19980824,
                targetDateKey: null,
                currentWeek: 1,
                totalWeeks: 8,
                phase: "Base",
                weekStartDateKey: 19980824,
                weekEndDateKey: 19980830,
                workouts: [
                  {
                    id: "workout-1",
                    dateKey: 19980825,
                    sport: "cycling",
                    name: "Tempo builder",
                    durationSeconds: 3_600,
                    origin: "coach",
                    navigation: { destination: "plan", focus: "workout", entityId: "workout-1" },
                  },
                  {
                    id: "workout-2",
                    dateKey: 19980827,
                    sport: "cycling",
                    name: "Recovery spin",
                    durationSeconds: 2_700,
                    origin: "coach",
                    navigation: { destination: "plan", focus: "workout", entityId: "workout-2" },
                  },
                ],
                todayWorkout: {
                  id: "workout-1",
                  dateKey: 19980825,
                  sport: "cycling",
                  name: "Tempo builder",
                  durationSeconds: 3_600,
                  origin: "coach",
                  navigation: { destination: "plan", focus: "workout", entityId: "workout-1" },
                },
                navigation: { destination: "plan", focus: "active-plan", entityId: "plan-1" },
              },
            },
          },
          training: {
            ...EMPTY_TRAINING_SURFACE,
            status: "ready",
            trainingContext: {
              ...EMPTY_TRAINING_SURFACE.trainingContext,
              plan: {
                kind: "computed",
                asOf: "1998-08-24",
                items: [
                  {
                    id: "workout-1",
                    date: "1998-08-25",
                    name: "Tempo builder",
                    category: "cycling",
                    workoutType: "Tempo",
                  },
                  {
                    id: "workout-2",
                    date: "1998-08-27",
                    name: "Recovery spin",
                    category: "cycling",
                    workoutType: "Recovery",
                  },
                ],
              },
              cyclingLoad: {
                kind: "computed",
                asOf: "1998-08-24",
                source: "intervals.icu",
                windowDays: 7,
                value: 42,
                activityCount: 4,
                missingLoadCount: 0,
              },
              anchorZones: {
                kind: "computed",
                asOf: "1998-08-24",
                anchor: {
                  watts: 182,
                  validFrom: "1998-08-01",
                  source: "manual",
                  confidence: "manual",
                  ageDays: 23,
                  stalenessBand: "fresh",
                  stale: false,
                },
                zones: Array.from({ length: 6 }, (_, index) => ({
                  name: `Zone ${index + 1}`,
                  range: `${index + 1} W`,
                  overlaps: false,
                })),
              },
            },
          },
        });
      });

      render(<Harness />);
      const context = screen.getByRole("complementary", { name: "Training context" });
      expect(context).toHaveTextContent("Tempo builder");
      expect(context).toHaveTextContent("60 min · cycling");
      expect(context).toHaveTextContent("Eight-week consistency");
      expect(context).toHaveTextContent("Week 1 of 8 · Base");
      expect(context).toHaveTextContent("4 cycling activities · 7 days");
      expect(context).toHaveTextContent("182 W");
      expect(context).not.toHaveTextContent(/Fitness|Fatigue|Form|Memory|Updated|Fresh 2m/u);
    });

    it("keeps unavailable and saved-context states explicit", () => {
      render(<Harness />);
      expect(screen.getByText("Loading training context…")).toBeVisible();

      act(() => {
        useEnduragentStore.setState({
          training: { ...EMPTY_TRAINING_SURFACE, status: "unavailable" },
        });
      });
      expect(screen.getByText("Training context is temporarily unavailable.")).toBeVisible();

      act(() => {
        useEnduragentStore.setState({
          training: { ...EMPTY_TRAINING_SURFACE, status: "refresh-unavailable" },
        });
      });
      expect(screen.getByText("Showing saved context; refresh is unavailable.")).toBeVisible();
    });
  });

  describe("slash popup", () => {
    it("filters as the athlete types after a slash", async () => {
      const user = userEvent.setup();
      render(<Harness />);

      await user.click(composer());
      await user.keyboard("/");
      expect(screen.getAllByRole("option")).toHaveLength(SLASH_COMMANDS.length);

      await user.keyboard("st");
      expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
        "/startStart a fresh session",
        "/statusCheck current fitness, fatigue, and form",
      ]);

      await user.keyboard("zz");
      expect(screen.queryByRole("listbox")).toBeNull();
    });

    it("closes once the draft carries whitespace", async () => {
      const user = userEvent.setup();
      render(<Harness />);

      await user.click(composer());
      await user.keyboard("/plan");
      expect(screen.getByRole("listbox", { name: "Commands" })).toBeInTheDocument();

      await user.keyboard(" ");
      expect(screen.queryByRole("listbox")).toBeNull();
    });

    it("exposes the command list as the composer's active suggestion list", async () => {
      const user = userEvent.setup();
      render(<Harness />);
      const input = composer();

      expect(input).toHaveAttribute("role", "combobox");
      expect(input).toHaveAttribute("aria-autocomplete", "list");
      expect(input).toHaveAttribute("aria-expanded", "false");
      expect(input).not.toHaveAttribute("aria-controls");
      expect(input).not.toHaveAttribute("aria-activedescendant");

      await user.click(input);
      await user.keyboard("/st");

      const listbox = screen.getByRole("listbox", { name: "Commands" });
      const options = screen.getAllByRole("option");
      const first = options.at(0);
      const second = options.at(1);
      if (first === undefined || second === undefined) {
        throw new TypeError("command options missing");
      }
      expect(input).toHaveAttribute("aria-expanded", "true");
      expect(input).toHaveAttribute("aria-controls", listbox.id);
      expect(input).toHaveAttribute("aria-activedescendant", first.id);

      await user.keyboard("{ArrowDown}");
      expect(input).toHaveAttribute("aria-activedescendant", second.id);

      await user.keyboard("{Escape}");
      expect(input).toHaveAttribute("aria-expanded", "false");
      expect(input).not.toHaveAttribute("aria-controls");
      expect(input).not.toHaveAttribute("aria-activedescendant");
      expect(document.activeElement).toBe(input);
    });

    it("moves the selection with the arrow keys and accepts with Enter", async () => {
      const user = userEvent.setup();
      render(<Harness />);

      await user.click(composer());
      await user.keyboard("/st");
      expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");

      await user.keyboard("{ArrowDown}");
      expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");

      await user.keyboard("{ArrowUp}{ArrowUp}");
      expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");

      await user.keyboard("{Enter}");
      expect(composer()).toHaveValue("/status ");
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(actions.submit).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(composer());
    });

    it("accepts a command on click without sending it", async () => {
      const user = userEvent.setup();
      render(<Harness />);

      await user.click(composer());
      await user.keyboard("/rev");
      setChat({ status: "streaming", sendDisabled: true });
      await user.click(screen.getByRole("option", { name: /\/review/u }));

      expect(composer()).toHaveValue("/review ");
      expect(actions.submit).not.toHaveBeenCalled();
    });

    it("closes on Escape and keeps the draft", async () => {
      const user = userEvent.setup();
      render(<Harness />);

      await user.click(composer());
      await user.keyboard("/pl");
      await user.keyboard("{Escape}");

      expect(screen.queryByRole("listbox")).toBeNull();
      expect(composer()).toHaveValue("/pl");
    });
  });

  describe("composer", () => {
    it("places the medical disclaimer directly below the composer", () => {
      render(<Harness />);

      const disclaimer = screen.getByText(
        "Not medical advice, and not a substitute for a doctor or a certified coach.",
      );
      const form = composer().closest("form");

      expect(form?.nextElementSibling).toBe(disclaimer);
      expect(disclaimer.parentElement).toHaveClass("composer-wrap");
      expect(disclaimer.parentElement).toHaveClass("bg-bg");
      expect(disclaimer.parentElement).toHaveClass("max-h-full", "overflow-hidden");
      expect(disclaimer).toHaveClass("mt-inset", "text-xs");
      expect(document.querySelector(".composer-projections")).toHaveClass(
        "min-h-0",
        "overflow-y-auto",
        "overscroll-contain",
      );
    });

    it("orders decision, attachment, and queued work before the composer", () => {
      setChat({
        decision: unansweredDecision(),
        sendDisabled: true,
        inputDisabled: false,
        attachmentBusy: true,
        queued: [{ id: "queued-1", text: "Later work", command: false, restored: false }],
      });
      render(<Harness />);

      const projections = document.querySelector(".composer-projections");
      const decision = screen
        .getByText("Coach needs your answer")
        .closest("section")?.parentElement;
      const attachment = screen.getByText("Adding files…").parentElement;
      const queue = screen.getByRole("region", { name: "Queued messages, 1 queued message" });
      const form = composer().closest("form");

      if (
        !(projections instanceof HTMLElement) ||
        !(decision instanceof HTMLElement) ||
        !(attachment instanceof HTMLElement) ||
        !(form instanceof HTMLFormElement)
      ) {
        throw new TypeError("Composer projections are incomplete.");
      }
      expect(decision.parentElement).toBe(projections);
      expect(attachment.parentElement).toBe(projections);
      expect(queue.parentElement).toBe(projections);
      expect(
        decision.compareDocumentPosition(attachment) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        attachment.compareDocumentPosition(queue) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(projections.nextElementSibling).toBe(form);
    });

    it("focuses the enabled composer when Chat mounts after required setup", () => {
      render(<Harness />);

      expect(composer()).toBeEnabled();
      expect(composer()).toHaveFocus();
    });

    it("removes the file drop target while chat work is blocked", () => {
      render(<Harness />);
      const form = composer().closest("form");

      expect(form).toHaveAttribute("data-chat-attachment-dropzone", "true");
      setChat({ inputDisabled: true });
      expect(form).not.toHaveAttribute("data-chat-attachment-dropzone");
    });

    it("leaves the composer unfocused when the app mounts on another destination", () => {
      useEnduragentStore.setState({ activeView: "training" });
      render(<Harness />);

      expect(composer()).not.toHaveFocus();
    });

    it("never submits while an IME composition is in flight", async () => {
      render(<Harness />);
      const textarea = composer();
      const draft = "回復走を";
      textarea.focus();
      textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      act(() => {
        textarea.value = draft;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });

      const composing = new KeyboardEvent("keydown", {
        key: "Enter",
        isComposing: true,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        textarea.dispatchEvent(composing);
      });

      expect(composing.defaultPrevented).toBe(false);
      expect(actions.submit).not.toHaveBeenCalled();
      expect(textarea).toHaveValue(draft);
      expect(document.activeElement).toBe(textarea);

      textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      const committed = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        textarea.dispatchEvent(committed);
      });

      expect(committed.defaultPrevented).toBe(true);
      expect(actions.submit).toHaveBeenCalledWith(draft);
      await waitFor(() => expect(textarea).toHaveValue(""));
    });

    it("keeps Shift+Enter as a newline and ignores blank drafts", async () => {
      const user = userEvent.setup();
      render(<Harness />);

      await user.click(composer());
      await user.keyboard("first{Shift>}{Enter}{/Shift}second");
      expect(composer()).toHaveValue("first\nsecond");
      expect(actions.submit).not.toHaveBeenCalled();

      await user.clear(composer());
      await user.keyboard("   {Enter}");
      expect(actions.submit).not.toHaveBeenCalled();

      await user.keyboard("ride{Enter}");
      expect(actions.submit).toHaveBeenCalledWith("   ride");
    });

    it("keeps the draft available while streaming and exposes a truthful Stop control", async () => {
      const user = userEvent.setup();
      render(<Harness />);
      const textarea = composer();
      await user.click(textarea);
      await user.keyboard("Plan tomorrow");
      setChat({ status: "streaming", sendDisabled: false, inputDisabled: false });

      expect(textarea).toBeEnabled();
      expect(textarea).toHaveFocus();
      const stop = screen.getByRole("button", { name: "Stop responding" });
      expect(stop).toBeEnabled();
      expect(stop.querySelector("svg")).toHaveClass("size-2.5", "fill-current", "stroke-none");
      expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();

      await user.keyboard("{Enter}");

      expect(actions.submit).toHaveBeenCalledWith("Plan tomorrow");
      expect(textarea).toHaveValue("");
      expect(textarea).toHaveFocus();
      await user.click(stop);
      expect(actions.stop).toHaveBeenCalledTimes(1);
    });

    it("locks the composer while work is blocked", () => {
      render(<Harness />);
      setChat({ sendDisabled: true, inputDisabled: true });

      expect(composer()).toBeDisabled();
      expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    });

    it("does not render a fixed shortcut row", () => {
      render(<Harness />);
      expect(screen.queryByRole("group", { name: "Coaching shortcuts" })).toBeNull();
      expect(screen.queryByRole("button", { name: /command$/u })).toBeNull();
    });
  });

  describe("attachments", () => {
    it("restores document text and sends the stable attachment without requiring message text", async () => {
      const user = userEvent.setup();
      setChat({
        attachments: attachmentSurface(
          {
            schemaVersion: 1,
            attachmentId: "attachment-doc",
            displayName: "training-notes.pdf",
            kind: "document",
            extension: "pdf",
            byteSize: 1_800_000,
            status: "ready",
            preview: { kind: "document", extractedTextChars: 12_000, visualPageCount: 0 },
          },
          "",
          "restored",
        ),
      });
      render(<Harness />);

      expect(screen.getByLabelText("training-notes.pdf attachment")).toBeVisible();
      expect(screen.getByText("Stored locally")).toBeVisible();
      await user.click(screen.getByRole("button", { name: "Send message" }));
      expect(actions.saveAttachmentDraftText).toHaveBeenCalledWith("");
      expect(actions.submit).toHaveBeenCalledWith("", ["attachment-doc"]);
    });

    it("previews a completed activity and keeps Remove scoped to that attachment", async () => {
      const user = userEvent.setup();
      setChat({
        attachments: attachmentSurface({
          schemaVersion: 1,
          attachmentId: "attachment-fit",
          displayName: "sunday-endurance.fit",
          kind: "activity",
          extension: "fit",
          byteSize: 842_000,
          status: "ready",
          preview: {
            kind: "activity",
            sourceFormat: "fit",
            sessions: [
              {
                sport: "cycling",
                startUtc: 1_777_000_000,
                durationSeconds: 8_040,
                distanceMeters: 68_400,
              },
            ],
          },
        }),
      });
      render(<Harness />);

      expect(screen.getByText("Will add to Training when sent")).toBeVisible();
      expect(screen.getByText("68.4 km")).toBeVisible();
      await user.click(screen.getByRole("button", { name: "Remove" }));
      expect(actions.removeAttachment).toHaveBeenCalledWith("attachment-fit");
    });

    it("requires and records one planned-Workout selection", async () => {
      const user = userEvent.setup();
      setChat({
        sendDisabled: true,
        attachments: attachmentSurface({
          schemaVersion: 1,
          attachmentId: "attachment-workout",
          displayName: "workouts.zwo",
          kind: "workout",
          extension: "zwo",
          byteSize: 2_400,
          status: "ready",
          preview: {
            kind: "workout",
            sourceFormat: "zwo",
            selectedWorkoutId: null,
            workouts: [
              {
                workoutId: "vo2",
                title: "VO₂ step builder",
                durationSeconds: 3_300,
                target: "105–120% FTP",
                purpose: "Build aerobic power",
              },
              {
                workoutId: "tempo",
                title: "Tempo 3 × 12",
                durationSeconds: 3_840,
                target: "88–92% FTP",
                purpose: "Sustainable power",
              },
            ],
          },
        }),
      });
      render(<Harness />);

      expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
      await user.click(screen.getByRole("button", { name: /Tempo 3 × 12/u }));
      expect(actions.selectAttachmentWorkout).toHaveBeenCalledWith("attachment-workout", "tempo");
    });

    it("offers the selected Workout to Plan without changing the Send path", async () => {
      const user = userEvent.setup();
      setChat({
        planningRequestsLoaded: true,
        attachments: attachmentSurface({
          schemaVersion: 1,
          attachmentId: "attachment-workout",
          displayName: "tempo.mrc",
          kind: "workout",
          extension: "mrc",
          byteSize: 2_400,
          status: "ready",
          preview: {
            kind: "workout",
            sourceFormat: "mrc",
            selectedWorkoutId: "tempo",
            workouts: [
              {
                workoutId: "tempo",
                title: "Tempo 3 × 12",
                durationSeconds: 3_840,
                target: "88–92% FTP",
                purpose: "Sustainable power",
              },
            ],
          },
        }),
      });
      render(<Harness />);

      expect(screen.getByText("Tempo 3 × 12 selected")).toBeVisible();
      expect(screen.getByText(/Send asks Coach to analyze it/u)).toBeVisible();
      await user.click(screen.getByRole("button", { name: "Review in Plan" }));
      expect(actions.reviewAttachmentInPlan).toHaveBeenCalledWith("attachment-workout");
    });

    it("renders open and terminal request cards with one typed Plan action", async () => {
      const user = userEvent.setup();
      const open = planningDelivery("open");
      setChat({
        planningRequests: [open],
        planningRequestsLoaded: true,
        timeline: [{ kind: "planning-request", delivery: open }],
      });
      render(<Harness />);

      expect(screen.getByRole("heading", { name: "Review Tempo 3 × 12 in Plan." })).toBeVisible();
      expect(screen.getByText("Needs review")).toBeVisible();
      await user.click(screen.getByRole("button", { name: "Review in Plan" }));
      expect(actions.openPlanningRequest).toHaveBeenCalledWith("request-plan-1");

      const applied = planningDelivery("applied");
      setChat({
        planningRequests: [applied],
        timeline: [{ kind: "planning-request", delivery: applied }],
      });
      expect(screen.getByText("Added to Plan")).toBeVisible();
      await user.click(screen.getByRole("button", { name: "Open Plan" }));
      expect(actions.openPlanningRequest).toHaveBeenLastCalledWith("request-plan-1");
    });

    it("renders one host-owned text handoff and keeps Plan unchanged until continued", async () => {
      const user = userEvent.setup();
      const message: ChatMessageView = {
        id: "message-live-1",
        turnId: "turn-1",
        role: "coach",
        delivery: "complete",
        historical: false,
        text: "This change should be reviewed in Plan.",
        planHandoff: {
          kind: "plan_change",
          title: "Review a lighter Friday",
          intent: "Move Friday's endurance Workout to Saturday and keep Friday easy.",
        },
      };
      setChat({
        messages: [message],
        planningRequestsLoaded: true,
        timeline: [{ kind: "message", message }],
      });
      render(<Harness />);

      expect(screen.getByRole("heading", { name: "Review a lighter Friday" })).toBeVisible();
      expect(screen.getByText(/Nothing changes until you approve it/u)).toBeVisible();
      await user.click(screen.getByRole("button", { name: "Continue in Plan" }));
      expect(actions.continueMessageInPlan).toHaveBeenCalledWith("turn-1", message.planHandoff);
    });

    it("shows a retry action for a safely saved failed Plan handoff", async () => {
      const user = userEvent.setup();
      const delivered = planningDelivery("open");
      const failed: PlanningRequestDelivery = {
        ...delivered,
        state: "failed",
        failureCode: "planning_unavailable",
        retryable: true,
        deliveredAtMs: null,
        planningRequest: null,
      };
      setChat({
        planningRequests: [failed],
        planningRequestsLoaded: true,
        timeline: [{ kind: "planning-request", delivery: failed }],
      });
      render(<Harness />);

      expect(screen.getByText("Couldn’t open")).toBeVisible();
      expect(screen.getAllByText(/will not create a duplicate/u)).not.toHaveLength(0);
      await user.click(screen.getByRole("button", { name: "Try again" }));
      expect(actions.retryPlanningRequest).toHaveBeenCalledWith(failed.requestId);
    });

    it("shows model-incompatible image recovery and retryable parser failure", async () => {
      const user = userEvent.setup();
      setChat({
        attachments: attachmentSurface({
          schemaVersion: 1,
          attachmentId: "attachment-image",
          displayName: "bike-position.jpg",
          kind: "image",
          extension: "jpg",
          byteSize: 2_400_000,
          status: "blocked",
          reason: "model_incompatible",
        }),
      });
      render(<Harness />);
      expect(screen.getByText("This model can’t view this file")).toBeVisible();
      await user.click(screen.getByRole("button", { name: "Open Settings" }));
      expect(useEnduragentStore.getState().activeView).toBe("settings");

      setChat({
        attachments: attachmentSurface({
          schemaVersion: 1,
          attachmentId: "attachment-failed",
          displayName: "broken.csv",
          kind: "document",
          extension: "csv",
          byteSize: 2_000,
          status: "failed",
          stage: "parsing",
          failureCode: "csv_invalid",
          retryable: true,
        }),
      });
      await user.click(screen.getByRole("button", { name: "Try again" }));
      expect(actions.retryAttachment).toHaveBeenCalledWith("attachment-failed");
    });

    it("explains an unknown format without losing or sending the restored draft", async () => {
      setChat({
        sendDisabled: true,
        attachments: {
          schemaVersion: 1,
          capabilities: ATTACHMENT_CAPABILITIES,
          draft: {
            schemaVersion: 1,
            chatId: "desktop",
            text: "Keep my question",
            state: "restored",
            updatedAt: "2026-08-26T00:00:00.000Z",
            attachments: [],
          },
        },
        attachmentAdmissions: [
          {
            selectionId: "selection-unknown",
            displayName: "ride-data.xyz",
            status: "rejected",
            reason: "format_unsupported",
          },
        ],
      });
      render(<Harness />);
      await waitFor(() => expect(composer()).toHaveValue("Keep my question"));
      expect(screen.getByText("This file type isn’t supported")).toBeVisible();
      expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
      expect(actions.submit).not.toHaveBeenCalled();
    });

    it("opens the native picker from the centered Composer attachment control", async () => {
      const user = userEvent.setup();
      setChat({
        attachments: { schemaVersion: 1, capabilities: ATTACHMENT_CAPABILITIES, draft: null },
      });
      render(<Harness />);
      await user.click(screen.getByRole("button", { name: "Attach files" }));
      expect(actions.chooseAttachments).toHaveBeenCalledOnce();
    });
  });

  describe("queued messages", () => {
    function strip(): HTMLElement | null {
      const element = document.querySelector(".chat-queue");
      return element instanceof HTMLElement ? element : null;
    }

    function texts(): readonly string[] {
      return [...document.querySelectorAll(".chat-queue__text")].map(
        (node) => node.textContent ?? "",
      );
    }

    it("stays out of the way until a message is queued", () => {
      render(<Harness />);
      expect(strip()).toBeNull();

      setChat({
        queued: [{ id: "queued-1", text: "And my long ride?", command: false, restored: false }],
      });

      expect(strip()).not.toBeNull();
      expect(texts()).toEqual(["And my long ride?"]);
      expect(document.querySelectorAll(".chat-message")).toHaveLength(0);
    });

    it("hands each remove button to the controller with its own message id", async () => {
      const user = userEvent.setup();
      render(<Harness />);
      setChat({
        queued: [
          { id: "queued-1", text: "And my long ride?", command: false, restored: false },
          { id: "queued-2", text: "/status", command: true, restored: false },
        ],
      });

      expect(texts()).toEqual(["And my long ride?", "/status"]);
      await user.click(screen.getByRole("button", { name: "Remove queued message 2" }));
      expect(actions.removeQueued).toHaveBeenCalledWith("queued-2");

      await user.click(screen.getByRole("button", { name: "Remove queued message 1" }));
      expect(actions.removeQueued).toHaveBeenNthCalledWith(2, "queued-1");
    });

    it("runs only restored commands and offers durable recovery without a second retry", async () => {
      const user = userEvent.setup();
      render(<Harness />);
      setChat({
        interrupted: true,
        queued: [
          { id: "queued-1", text: "Try this again", command: false, restored: true },
          { id: "queued-2", text: "/status", command: true, restored: true },
        ],
        retryRequired: {
          claimId: "claim-1",
          queuedMessageIds: ["queued-1"],
          turnId: "turn-1",
          status: "retry-required",
        },
      });

      expect(screen.getByRole("button", { name: "Retry interrupted message" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Remove queued message 1" })).toBeDisabled();
      const ordinaryRetry = document.querySelector(".chat-retry");
      expect(ordinaryRetry).toBeInstanceOf(HTMLButtonElement);
      expect((ordinaryRetry as HTMLButtonElement).hidden).toBe(true);
      await user.click(screen.getByRole("button", { name: "Retry interrupted message" }));
      expect(actions.retryQueuedTurn).toHaveBeenCalledWith("claim-1");

      setChat({ interrupted: false, retryRequired: null });
      await user.click(screen.getByRole("button", { name: "Run command" }));
      expect(actions.runQueuedCommand).toHaveBeenCalledWith("queued-2");
    });

    it("wraps long rows, announces queue changes, and shows removal feedback", () => {
      render(<Harness />);
      setChat({
        queued: [
          {
            id: "queued-1",
            text: "This is a very long queued question that must wrap on compact and wide layouts without hiding its actions",
            command: false,
            restored: false,
          },
          { id: "queued-2", text: "/status", command: true, restored: true },
        ],
        queueMutationError: "We couldn’t remove that saved message. Try again.",
      });

      expect(
        screen.getByRole("region", { name: "Queued messages, 2 queued messages" }),
      ).toBeVisible();
      const live = strip()?.querySelector('[role="status"][aria-live="polite"]');
      expect(live).toHaveTextContent("2 queued messages");
      expect(document.querySelector(".chat-queue__text")).toHaveClass(
        "whitespace-pre-wrap",
        "break-words",
      );
      expect(document.querySelector(".chat-queue__text")).not.toHaveClass("truncate");
      expect(strip()).toHaveClass("rounded-card", "shadow-elev-2");
      expect(screen.getByRole("heading", { name: "Queued messages" })).toHaveClass(
        "text-xs",
        "font-semibold",
      );
      expect(document.querySelector(".chat-queue__item")).toHaveClass("flex-wrap", "items-center");
      expect(screen.getByRole("button", { name: "Run command" })).toHaveClass("text-xs");
      expect(screen.getByRole("button", { name: "Remove queued message 1" })).toHaveClass(
        "text-xs",
      );
      expect(screen.getByText("We couldn’t remove that saved message. Try again.")).toBeVisible();
    });

    it("marks queued commands without restoring the legacy monospace face", () => {
      render(<Harness />);
      setChat({
        queued: [
          { id: "queued-1", text: "And my long ride?", command: false, restored: false },
          { id: "queued-2", text: "/status", command: true, restored: false },
        ],
      });

      expect(
        [...document.querySelectorAll(".chat-queue__text")].map((node) =>
          node.classList.contains("chat-queue__command"),
        ),
      ).toEqual([false, true]);
      expect(document.querySelector(".chat-queue__command")).not.toHaveClass("font-mono");
    });

    it("locks removal while work is blocked", async () => {
      const user = userEvent.setup();
      render(<Harness />);
      setChat({
        queued: [{ id: "queued-1", text: "And my long ride?", command: false, restored: false }],
        workBlocked: true,
      });

      const remove = screen.getByRole("button", { name: "Remove queued message 1" });
      expect(remove).toBeDisabled();
      await user.click(remove);
      expect(actions.removeQueued).not.toHaveBeenCalled();
    });

    it("keeps the strip inert until the chat actions are bound", () => {
      act(() => {
        useEnduragentStore.setState({ chatActions: null });
      });
      render(<Harness />);
      setChat({
        queued: [{ id: "queued-1", text: "And my long ride?", command: false, restored: false }],
      });

      const remove = screen.getByRole("button", { name: "Remove queued message 1" });
      expect(remove).toBeDisabled();
      act(() => {
        remove.click();
      });
      expect(actions.removeQueued).not.toHaveBeenCalled();
    });
  });

  describe("transcript notice and retry", () => {
    function notice(): HTMLElement {
      const element = document.querySelector(".chat-notice");
      if (!(element instanceof HTMLElement)) throw new TypeError("notice missing");
      return element;
    }

    function retry(): HTMLButtonElement {
      const element = document.querySelector(".chat-retry");
      if (!(element instanceof HTMLButtonElement)) throw new TypeError("retry bar missing");
      return element;
    }

    it("hides the notice until the coach reports progress or an error", () => {
      render(<Harness />);
      expect(notice().hidden).toBe(true);
      expect(notice().textContent).toBe("");

      setChat({ notice: "Coach is working…" });
      expect(notice().hidden).toBe(false);
      expect(notice()).toHaveTextContent("Coach is working…");

      setChat({ notice: "The coach is unreachable right now." });
      expect(notice()).toHaveTextContent("The coach is unreachable right now.");

      setChat({ notice: null });
      expect(notice().hidden).toBe(true);
    });

    it("renders Coach progress after the transcript instead of above the composer", () => {
      setChat({ status: "streaming", coachProgress: "Checking your training data…" });
      render(<Harness />);

      const progress = document.querySelector(".coach-progress");
      if (!(progress instanceof HTMLElement)) throw new TypeError("progress missing");
      expect(progress).toHaveTextContent("Checking your training data…");
      expect(progress.closest(".thread")).not.toBeNull();
      expect(progress.closest(".composer-wrap")).toBeNull();
    });

    it("offers the retry bar only on an interrupted turn and hands the click to the controller", async () => {
      const user = userEvent.setup();
      render(<Harness />);
      expect(retry().hidden).toBe(true);

      setChat({ interrupted: true });
      expect(retry().hidden).toBe(false);
      await user.click(retry());
      expect(actions.retry).toHaveBeenCalledTimes(1);

      setChat({ workBlocked: true });
      expect(retry()).toBeDisabled();
      await user.click(retry());
      expect(actions.retry).toHaveBeenCalledTimes(1);

      setChat({ workBlocked: false, interrupted: false });
      expect(retry().hidden).toBe(true);
    });

    it("groups interrupted recovery above later queued messages", () => {
      setChat({
        notice: "Response stopped. Your partial response is preserved.",
        interrupted: true,
        queued: [
          {
            id: "queued-1",
            text: "Also account for Sunday’s long ride.",
            command: false,
            restored: false,
          },
          { id: "queued-2", text: "/status", command: true, restored: false },
        ],
      });
      render(<Harness />);

      const host = document.querySelector(".chat-notice-host");
      const queue = screen.getByRole("region", { name: "Queued messages, 2 queued messages" });
      if (!(host instanceof HTMLElement)) throw new TypeError("notice host missing");

      expect(host).toContainElement(notice());
      expect(host).toContainElement(retry());
      expect(queue).not.toContainElement(retry());
      expect(retry()).toHaveClass("mt-row", "mb-row");
      expect(
        retry().compareDocumentPosition(queue) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it("keeps the retry bar inert until the chat actions are bound", () => {
      act(() => {
        useEnduragentStore.setState({ chatActions: null });
      });
      render(<Harness />);
      setChat({ interrupted: true });

      act(() => {
        retry().click();
      });
      expect(actions.retry).not.toHaveBeenCalled();
    });
  });

  describe("command chips", () => {
    function messages(...texts: readonly string[]): readonly ChatMessageView[] {
      return texts.map((text, index) => ({
        id: `a${index}`,
        role: "athlete" as const,
        delivery: "complete" as const,
        historical: false,
        text,
      }));
    }

    function chipped(): readonly (string | null)[] {
      return [...document.querySelectorAll(".chat-message--athlete .chat-message__text")].map(
        (node) => (node.classList.contains("chat-message__command") ? "command" : null),
      );
    }

    it("marks athlete turns that open with a known slash command", () => {
      render(<Harness />);
      setChat({
        messages: messages(
          "/status",
          "  /WORKOUT tomorrow  ",
          "/plan my week",
          "what is /status",
          "/synthetic-unknown",
          "Plan my week",
        ),
      });

      expect(chipped()).toEqual(["command", "command", "command", null, null, null]);
    });

    it("leaves the command face off coach turns", () => {
      render(<Harness />);
      setChat({
        messages: [
          {
            id: "c1",
            role: "coach",
            delivery: "complete",
            historical: false,
            text: "/status is a command you can send me.",
          },
        ],
      });

      const coach = document.querySelector(".chat-message--coach .chat-message__text");
      expect(coach?.classList.contains("chat-message__command")).toBe(false);
    });
  });

  describe("hydration controls", () => {
    it("offers load-earlier only while earlier pages remain", async () => {
      const user = userEvent.setup();
      render(<Harness />);
      const load = document.querySelector(".chat-history-load");
      const controls = document.querySelector(".chat-history-controls");
      if (!(load instanceof HTMLButtonElement) || !(controls instanceof HTMLElement)) {
        throw new TypeError("history controls missing");
      }

      expect(controls.hidden).toBe(true);
      expect(load.hidden).toBe(true);

      setChat({ hydrationHasEarlier: true, hydrationStatus: "ready" });
      expect(controls.hidden).toBe(false);
      expect(load.hidden).toBe(false);
      await user.click(load);
      expect(actions.loadEarlier).toHaveBeenCalledTimes(1);

      setChat({ hydrationStatus: "loading" });
      expect(load).toBeDisabled();

      setChat({ hydrationStatus: "ready", workBlocked: true });
      expect(load).toBeDisabled();
    });

    it("swaps to the failure copy and a retry control when history is unavailable", async () => {
      const user = userEvent.setup();
      render(<Harness />);
      setChat({ hydrationHasEarlier: true, hydrationStatus: "failed" });

      const load = document.querySelector(".chat-history-load");
      const failure = document.querySelector(".chat-history-failure");
      const retry = document.querySelector(".chat-history-retry");
      if (
        !(load instanceof HTMLButtonElement) ||
        !(failure instanceof HTMLElement) ||
        !(retry instanceof HTMLButtonElement)
      ) {
        throw new TypeError("history controls missing");
      }

      expect(load.hidden).toBe(true);
      expect(failure.hidden).toBe(false);
      expect(failure.textContent).toBe("Conversation history is temporarily unavailable.");
      expect(retry.hidden).toBe(false);

      await user.click(retry);
      expect(actions.retryHydration).toHaveBeenCalledTimes(1);
    });

    it("auto-loads earlier pages when the transcript is scrolled to the top", () => {
      render(<Harness />);
      setChat({ hydrationHasEarlier: true, hydrationStatus: "ready" });
      const conversation = document.querySelector(".conversation");
      if (!(conversation instanceof HTMLElement)) throw new TypeError("conversation missing");
      Object.defineProperty(conversation, "offsetParent", {
        configurable: true,
        value: document.body,
      });

      conversation.scrollTop = 0;
      act(() => {
        conversation.dispatchEvent(new Event("scroll"));
      });
      expect(actions.loadEarlier).toHaveBeenCalledTimes(1);

      setChat({ hydrationStatus: "loading" });
      act(() => {
        conversation.dispatchEvent(new Event("scroll"));
      });
      expect(actions.loadEarlier).toHaveBeenCalledTimes(1);
    });

    it("ignores scroll resets while the transcript is hidden", () => {
      render(<Harness />);
      setChat({ hydrationHasEarlier: true, hydrationStatus: "ready" });
      const conversation = document.querySelector(".conversation");
      if (!(conversation instanceof HTMLElement)) throw new TypeError("conversation missing");

      conversation.scrollTop = 0;
      act(() => {
        conversation.dispatchEvent(new Event("scroll"));
      });

      expect(actions.loadEarlier).not.toHaveBeenCalled();
    });
  });

  describe("new conversation dialog", () => {
    it("walks the confirm flow and hands focus back to the composer", async () => {
      const user = userEvent.setup();
      render(<Shell onReady={() => {}} />);
      expect(screen.queryByRole("dialog")).toBeNull();

      setChat({ resetPhase: "confirming" });
      const dialog = screen.getByRole("dialog");
      await waitFor(() => {
        expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
      });

      await user.click(screen.getByRole("button", { name: "Start new conversation" }));
      expect(actions.confirmNewConversation).toHaveBeenCalledTimes(1);

      setChat({ resetPhase: "resetting" });
      expect(dialog.getAttribute("aria-busy")).toBe("true");
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Start new conversation" })).toBeDisabled();

      composer().value = "leftover draft";
      setChat({ resetPhase: "idle", resetCount: 1 });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(composer()).toHaveValue("");
      expect(document.activeElement).toBe(composer());
      await waitFor(() => {
        expect(dialog).not.toBeInTheDocument();
      });
    });

    it("cancels a pending draft save when reset succeeds", () => {
      vi.useFakeTimers();
      try {
        render(<Harness />);
        fireEvent.change(composer(), { target: { value: "pending reset draft" } });

        setChat({ resetPhase: "confirming" });
        setChat({ resetPhase: "resetting" });
        setChat({ resetPhase: "idle", resetCount: 1 });
        act(() => vi.advanceTimersByTime(300));

        expect(composer()).toHaveValue("");
        expect(actions.saveAttachmentDraftText).not.toHaveBeenCalled();
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    });

    it("returns focus to the opener when the athlete cancels", async () => {
      const user = userEvent.setup();
      useEnduragentStore.setState({
        chat: { ...EMPTY_CHAT_SURFACE, newConversationUnavailable: false },
      });
      render(<Shell onReady={() => {}} />);

      setChat({ resetPhase: "confirming" });
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(actions.cancelNewConversation).toHaveBeenCalledTimes(1);

      setChat({ resetPhase: "idle" });
      await waitFor(() => {
        expect(document.activeElement).toBe(screen.getByRole("button", { name: "New chat" }));
      });
    });

    it("names the restored history in the confirmation copy", () => {
      render(<Harness />);
      setChat({ resetPhase: "confirming" });
      expect(screen.getByText(/Your visible conversation will be cleared\./u)).toBeInTheDocument();

      setChat({ hasHydratedHistory: true });
      expect(
        screen.getByText(/earlier messages restored on this Mac will be cleared/u),
      ).toBeInTheDocument();
    });
  });

  describe("first sync card", () => {
    it("shows nothing until the first sync is under way", () => {
      render(<Harness />);
      expect(document.querySelector(".first-sync")).toBeNull();

      act(() => {
        useEnduragentStore.setState({ firstSync: { status: "syncing" } });
      });
      expect(screen.getByRole("progressbar", { name: "Syncing training history" })).toBeVisible();

      act(() => {
        useEnduragentStore.setState({ firstSync: { status: "ready" } });
      });
      expect(document.querySelector(".first-sync")).toBeNull();
    });

    it("retries a recoverable sync failure and refuses one that needs a relaunch", async () => {
      const user = userEvent.setup();
      render(<Harness />);
      act(() => {
        useEnduragentStore.setState({
          firstSync: { status: "failed", kind: "operation", retryable: true },
        });
      });

      const retry = screen.getByRole("button", { name: "Retry sync" });
      await user.click(retry);
      expect(actions.retryFirstSync).toHaveBeenCalledTimes(1);
      expect(retry).toBeDisabled();

      act(() => {
        useEnduragentStore.setState({
          firstSync: { status: "failed", kind: "protocol", retryable: false },
        });
      });
      expect(screen.queryByRole("button", { name: "Retry sync" })).toBeNull();
      expect(screen.getByText("Quit and reopen Enduragent.")).toBeInTheDocument();
    });
  });

  describe("coach prose", () => {
    function message(patch: Partial<ChatMessageView> & { readonly id: string }): ChatMessageView {
      return {
        role: "coach",
        delivery: "complete",
        historical: false,
        text: "Ride steady on Tuesday.",
        ...patch,
      };
    }

    it("sets compact typography on every coach turn without changing athlete copy", () => {
      render(<Harness />);
      setChat({
        messages: [
          message({ id: "a1", role: "athlete", text: "Plan my week" }),
          message({ id: "c1", delivery: "streaming", text: "Ride " }),
          message({ id: "c2" }),
          message({ id: "c3", delivery: "interrupted", text: "Connection stopped." }),
          message({ id: "c4", historical: true, text: "Nice work last week." }),
        ],
      });

      for (const id of ["c1", "c2", "c3", "c4"]) {
        const row = document.querySelector(`[data-message-id="${id}"]`);
        expect(row).toHaveClass("text-sm", "leading-5", "max-w-full");
        expect(row).not.toHaveClass("text-base");
        expect(row).not.toHaveClass("leading-6");
        const copy = row?.querySelector(".chat-message__text");
        expect(copy).toHaveClass("leading-5");
        expect(copy).not.toHaveClass("leading-[1.6]");
      }
      const athlete = document.querySelector('[data-message-id="a1"]');
      expect(athlete).not.toHaveClass("text-base");
      expect(athlete).not.toHaveClass("text-sm");
      expect(athlete).not.toHaveClass("leading-5");
      expect(athlete?.classList.contains("chat-message--athlete")).toBe(true);
      expect(athlete).toHaveClass("max-w-[76%]");
      const athleteCopy = athlete?.querySelector(".chat-message__text");
      expect(athleteCopy).toHaveClass("leading-[1.6]");
      expect(athleteCopy).not.toHaveClass("leading-5");
      expect(screen.queryByText("Coach")).toBeNull();
      expect(screen.queryByText("You")).toBeNull();
    });

    it("keeps the prose face on the row so streaming text never reflows when the turn settles", () => {
      render(<Harness />);
      setChat({ messages: [message({ id: "c1", delivery: "streaming", text: "Ride " })] });
      const row = document.querySelector('[data-message-id="c1"]');
      const streamingClassName = row?.className;

      setChat({ messages: [message({ id: "c1" })] });
      expect(document.querySelector('[data-message-id="c1"]')).toBe(row);
      expect(row?.className).toBe(streamingClassName);
    });

    it("renders Plan Creation in the dock and submits the Fitness Goal", async () => {
      const actions = stubActions();
      useEnduragentStore.getState().bindChatActions(actions);
      render(<Harness />);
      setChat({ planCreationLoaded: true, decision: unansweredDecision() });
      const startButton = screen.getByRole("button", { name: "Start a Plan" });
      expect(startButton).toBeDisabled();
      await userEvent.click(startButton);
      expect(actions.startPlanCreation).not.toHaveBeenCalled();
      setChat({ decision: null });
      expect(startButton).toBeEnabled();
      await userEvent.click(startButton);
      expect(actions.startPlanCreation).toHaveBeenCalledOnce();
      setChat({
        planCreation: planCreationModel(goalQuestion("What are you preparing for?")),
        sendDisabled: true,
        inputDisabled: true,
        composerPlaceholder: "Finish the Plan question above",
      });
      const heading = screen.getByRole("heading", { name: "What are you preparing for?" });
      await waitFor(() => expect(heading).toHaveFocus());
      expect(screen.getByText("Plan creation · question 1 of 9", { exact: true })).toBeVisible();
      expect(composer()).toBeDisabled();
      expect(composer()).toHaveAttribute("placeholder", "Finish the Plan question above");
      expect(screen.getByRole("button", { name: "Attach files" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Something else" })).toBeEnabled();
      expect(document.querySelector('[data-parity="question.card"]')).toHaveAttribute(
        "data-question",
        "goal",
      );
      expect(document.querySelector('[data-parity="composer"]')).toBeVisible();
      await userEvent.click(screen.getByRole("button", { name: "Improve without an event" }));
      expect(actions.answerPlanCreation).toHaveBeenCalledWith({
        kind: "goal",
        goal: { kind: "fitness" },
      });
      expect(
        heading.compareDocumentPosition(composer()) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).not.toBe(0);
      expect(heading.closest('[data-slot="card"]')).toHaveClass("min-w-0");
      setChat({
        planCreation: planCreationModel(fitnessSuccessQuestion("What would success mean?"), {
          version: 2,
          answeredSummaries: [
            {
              answerKey: "goal",
              title: "Goal",
              detail: "Build steady power",
              question: goalQuestion("What are you preparing for?"),
              answer: { kind: "goal", goal: { kind: "fitness", outcome: "Build steady power" } },
            },
          ],
        }),
      });
      expect(screen.queryByRole("textbox", { name: "Success meaning" })).toBeNull();
      await userEvent.click(screen.getByRole("button", { name: "Something else" }));
      expect(screen.getByRole("textbox", { name: "Success meaning" })).toHaveValue("");
      expect(document.querySelector('[data-parity="composer"]')).toBeNull();
      expect(document.querySelector('[data-parity="custom.editor"]')).toBeVisible();
      expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
      await userEvent.click(screen.getByRole("button", { name: "Back" }));
      expect(document.querySelector('[data-parity="composer"]')).toBeVisible();
      expect(screen.getByRole("button", { name: "Something else" })).toHaveFocus();
    });

    it("submits a manually entered Event Goal", async () => {
      const actions = stubActions();
      useEnduragentStore.getState().bindChatActions(actions);
      render(<Harness />);
      setChat({
        planCreationLoaded: true,
        planCreation: planCreationModel(goalQuestion("What are you preparing for?")),
      });
      await userEvent.click(screen.getByRole("button", { name: "Something else" }));
      const eventName = screen.getByRole("textbox", { name: "Event name" });
      const eventDate = screen.getByLabelText("Event date");
      expect(screen.getByText("Write your answer.")).toBeVisible();
      expect(eventName).toHaveAttribute("placeholder", "Type an answer");
      expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
      await userEvent.type(eventName, "Highland Tour");
      fireEvent.change(eventDate, { target: { value: "1998-10-18" } });
      await userEvent.click(screen.getByRole("button", { name: "Continue" }));
      expect(actions.answerPlanCreation).toHaveBeenCalledWith({
        kind: "goal",
        goal: { kind: "event-manual", name: "Highland Tour", date: "1998-10-18" },
      });
    });

    it("submits each Event Goal finish option", async () => {
      const actions = stubActions();
      useEnduragentStore.getState().bindChatActions(actions);
      render(<Harness />);
      setChat({
        planCreationLoaded: true,
        planCreation: planCreationModel(eventSuccessQuestion("What would success mean?"), {
          version: 2,
          answeredSummaries: [
            {
              answerKey: "goal",
              title: "Goal",
              detail: "Highland Tour · 1998-10-18",
              question: goalQuestion("What are you preparing for?"),
              answer: {
                kind: "goal",
                goal: { kind: "event-manual", name: "Highland Tour", date: "1998-10-18" },
              },
            },
          ],
        }),
      });
      const options = [
        ["Finish comfortably", "finish-comfortably"],
        ["Finish fast", "finish-fast"],
        ["Race for a result", "race-for-result"],
      ] as const;
      for (const [label, choice] of options) {
        const button = screen.getByRole("button", { name: label });
        expect(button).toBeEnabled();
        await userEvent.click(button);
        expect(actions.answerPlanCreation).toHaveBeenLastCalledWith({
          kind: "success",
          success: { kind: "event-finish", choice },
        });
      }
    });

    it("submits Plan length, start timing, and Schedule mode answers", async () => {
      const user = userEvent.setup();
      setChat({
        planCreationLoaded: true,
        planCreation: planCreationModel(
          planLengthQuestion("How long should this Fitness Plan be?"),
        ),
      });
      render(<Harness />);

      await user.click(screen.getByRole("button", { name: "12 weeks" }));
      expect(actions.answerPlanCreation).toHaveBeenLastCalledWith({
        kind: "plan-length",
        weeks: 12,
      });

      setChat({
        planCreation: planCreationModel(
          startTimingQuestion("When could this Plan start?", "1998-10-01"),
          { version: 2 },
        ),
      });
      expect(document.querySelector('[data-parity="choice.row"][aria-pressed="true"]')).toBeNull();
      await user.click(screen.getByRole("button", { name: "From a date" }));
      const startDate = screen.getByLabelText("Earliest start date");
      expect(startDate).toHaveAttribute("min", "1998-10-01");
      fireEvent.change(startDate, { target: { value: "1998-10-05" } });
      await user.click(screen.getByRole("button", { name: "Continue" }));
      expect(actions.answerPlanCreation).toHaveBeenLastCalledWith({
        kind: "start-timing",
        timing: { kind: "earliest", date: "1998-10-05" },
      });

      setChat({
        planCreation: planCreationModel(
          scheduleModeQuestion("Should this Plan use a Fixed or Flexible Schedule?"),
          { version: 3 },
        ),
      });
      await user.click(screen.getByRole("button", { name: /Flexible Schedule/u }));
      expect(actions.answerPlanCreation).toHaveBeenLastCalledWith({
        kind: "schedule-mode",
        mode: "flexible",
      });
    });

    it("submits Fixed and Flexible availability with labelled limits", async () => {
      const user = userEvent.setup();
      setChat({
        planCreationLoaded: true,
        planCreation: planCreationModel(
          availabilityQuestion(
            "How much training fits in a usual week?",
            "fixed",
            "Choose every weekday you can usually train.",
          ),
        ),
      });
      render(<Harness />);

      await user.click(screen.getByRole("button", { name: "7–8 hours" }));
      await user.type(screen.getByLabelText("Longest ride in hours"), "3.5");
      await user.click(screen.getByRole("checkbox", { name: "Tue" }));
      await user.click(screen.getByRole("checkbox", { name: "Sat" }));
      await user.click(screen.getByRole("button", { name: "Continue" }));
      expect(actions.answerPlanCreation).toHaveBeenLastCalledWith({
        kind: "availability",
        mode: "fixed",
        weeklyHoursLimit: 8,
        longestWorkoutHours: 3.5,
        usableWeekdays: [2, 6],
      });

      setChat({
        planCreation: planCreationModel(
          availabilityQuestion(
            "How much training fits in a usual week?",
            "flexible",
            "Your weekly limit sets 3 Workouts up to 6 h, 4 up to 8 h, or 5 above 8 h.",
          ),
          { version: 2 },
        ),
      });
      expect(screen.getByText(/weekly limit sets 3 Workouts/u)).toBeVisible();
      expect(screen.queryByRole("checkbox", { name: "Tue" })).toBeNull();
      await user.click(screen.getByRole("button", { name: "5–6 hours" }));
      await user.type(screen.getByLabelText("Longest ride in hours"), "2");
      await user.click(screen.getByRole("button", { name: "Continue" }));
      expect(actions.answerPlanCreation).toHaveBeenLastCalledWith({
        kind: "availability",
        mode: "flexible",
        weeklyHoursLimit: 6,
        longestWorkoutHours: 2,
      });
    });

    it("places availability validation errors beside their controls", async () => {
      const user = userEvent.setup();
      setChat({
        planCreationLoaded: true,
        planCreation: planCreationModel(
          availabilityQuestion(
            "How much training fits in a usual week?",
            "fixed",
            "Choose every weekday you can usually train.",
          ),
        ),
      });
      render(<Harness />);

      await user.click(screen.getByRole("button", { name: "Continue" }));
      const longest = document.querySelector('[data-parity="availability.longest"]');
      const weeklyError = screen.getByText("Choose weekly hours.");
      const longestError = screen.getByText(/Enter a longest ride/u);
      expect(weeklyError).toBeVisible();
      expect(longest).toHaveAttribute("aria-describedby", longestError.id);
      expect(screen.getByText("Choose at least one usable weekday.")).toBeVisible();
      expect(actions.answerPlanCreation).not.toHaveBeenCalled();
    });

    it("submits commitments and recent training baseline answers", async () => {
      const user = userEvent.setup();
      setChat({
        planCreationLoaded: true,
        planCreation: planCreationModel(
          commitmentsQuestion(
            "Any fixed commitments, other training, or time off to account for?",
            "Add only the scheduling details this Plan should account for",
          ),
        ),
      });
      render(<Harness />);

      expect(screen.queryByLabelText("Scheduling details")).toBeNull();
      await user.click(screen.getByRole("button", { name: "Nothing fixed" }));
      expect(actions.answerPlanCreation).toHaveBeenLastCalledWith({
        kind: "commitments",
        commitments: { kind: "none" },
      });
      await user.click(screen.getByRole("button", { name: "Something else" }));
      const commitments = screen.getByLabelText("Scheduling details");
      expect(commitments).toHaveAttribute(
        "placeholder",
        "Add only the scheduling details this Plan should account for",
      );
      await user.type(commitments, "Pilates on Thursday");
      await user.click(screen.getByRole("button", { name: "Continue" }));
      expect(actions.answerPlanCreation).toHaveBeenLastCalledWith({
        kind: "commitments",
        commitments: { kind: "authored", text: "Pilates on Thursday" },
      });

      setChat({
        planCreation: planCreationModel(
          baselineQuestion("What best describes your recent training?"),
          { version: 2 },
        ),
      });
      await user.click(screen.getByRole("button", { name: /Starting again/u }));
      expect(actions.answerPlanCreation).toHaveBeenLastCalledWith({
        kind: "baseline",
        baseline: "starting-again",
      });
    });

    it("shows restriction-specific fields and submits the operational restriction", async () => {
      const user = userEvent.setup();
      setChat({
        planCreationLoaded: true,
        planCreation: planCreationModel(
          restrictionQuestion("What Training Restriction should this Plan respect?"),
        ),
      });
      render(<Harness />);

      expect(screen.queryByLabelText("Optional end date")).toBeNull();
      expect(document.querySelector('[data-parity="choice.row"][aria-pressed="true"]')).toBeNull();
      await user.click(screen.getByRole("button", { name: "No training" }));
      expect(actions.answerPlanCreation).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "No training" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      fireEvent.change(screen.getByLabelText("Optional end date"), {
        target: { value: "1998-10-15" },
      });
      await user.click(screen.getByRole("button", { name: "Continue" }));
      expect(actions.answerPlanCreation).toHaveBeenLastCalledWith({
        kind: "restriction",
        restriction: { kind: "no-training", endDate: "1998-10-15" },
      });
      await user.click(screen.getByRole("button", { name: "No hard training" }));
      fireEvent.change(screen.getByLabelText("Optional end date"), { target: { value: "" } });
      await user.click(screen.getByRole("button", { name: "Continue" }));
      expect(actions.answerPlanCreation).toHaveBeenLastCalledWith({
        kind: "restriction",
        restriction: { kind: "no-hard-training" },
      });
      await user.click(screen.getByRole("button", { name: "Maximum Workout duration" }));
      await user.type(screen.getByLabelText("Maximum duration hours"), "1.5");
      fireEvent.change(screen.getByLabelText("Optional end date"), {
        target: { value: "1998-11-01" },
      });
      await user.click(screen.getByRole("button", { name: "Continue" }));
      expect(actions.answerPlanCreation).toHaveBeenLastCalledWith({
        kind: "restriction",
        restriction: { kind: "max-duration", hours: 1.5, endDate: "1998-11-01" },
      });
      await user.click(screen.getByRole("button", { name: "None" }));
      expect(actions.answerPlanCreation).toHaveBeenLastCalledWith({
        kind: "restriction",
        restriction: { kind: "none" },
      });
      expect(screen.queryByLabelText("Optional end date")).toBeNull();
    });

    it("edits a summary, cancels to the unanswered Card, and restores focus", async () => {
      const user = userEvent.setup();
      const model = planCreationModel(
        startTimingQuestion("When could this Plan start?", "1998-10-01"),
        {
          version: 4,
          answeredSummaries: [
            {
              answerKey: "plan-length",
              title: "Plan length",
              detail: "12 weeks",
              question: planLengthQuestion("How long should this Fitness Plan be?"),
              answer: { kind: "plan-length", weeks: 12 },
            },
          ],
        },
      );
      vi.mocked(actions.editPlanCreation).mockImplementation((answerKey) => {
        setChat({ planCreationEditingKey: answerKey, planCreationFocusRevision: 1 });
      });
      vi.mocked(actions.cancelPlanCreationEdit).mockImplementation(() => {
        setChat({ planCreationEditingKey: null, planCreationFocusRevision: 2 });
      });
      setChat({
        planCreationLoaded: true,
        planCreation: model,
        timeline: [{ kind: "plan-creation", model }],
        sendDisabled: true,
      });
      render(<Harness />);

      await user.click(screen.getByRole("button", { name: "Edit Plan length" }));
      const editHeading = screen.getByRole("heading", {
        name: "How long should this Fitness Plan be?",
      });
      await waitFor(() => expect(editHeading).toHaveFocus());
      expect(screen.getByRole("button", { name: "12 weeks" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await user.click(screen.getByRole("button", { name: "Back to answers" }));
      const openHeading = screen.getByRole("heading", { name: "When could this Plan start?" });
      await waitFor(() => expect(openHeading).toHaveFocus());
      expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    });

    it("disables every summary Edit action while an answer editor is open", async () => {
      const user = userEvent.setup();
      const model = planCreationModel(
        startTimingQuestion("When could this Plan start?", "1998-10-01"),
        {
          version: 4,
          answeredSummaries: [
            {
              answerKey: "goal",
              title: "Goal",
              detail: "Build steady power",
              question: goalQuestion("What are you preparing for?"),
              answer: {
                kind: "goal",
                goal: { kind: "fitness", outcome: "Build steady power" },
              },
            },
            {
              answerKey: "plan-length",
              title: "Plan length",
              detail: "12 weeks",
              question: planLengthQuestion("How long should this Fitness Plan be?"),
              answer: { kind: "plan-length", weeks: 12 },
            },
          ],
        },
      );
      vi.mocked(actions.editPlanCreation).mockImplementation((answerKey) => {
        setChat({ planCreationEditingKey: answerKey, planCreationFocusRevision: 1 });
      });
      setChat({
        planCreationLoaded: true,
        planCreation: model,
        timeline: [{ kind: "plan-creation", model }],
        sendDisabled: true,
      });
      render(<Harness />);

      expect(screen.getByRole("list")).toBeVisible();
      await user.click(screen.getByRole("button", { name: "Edit Plan length" }));
      expect(actions.editPlanCreation).toHaveBeenCalledOnce();
      expect(actions.editPlanCreation).toHaveBeenCalledWith("plan-length");
      const editActions = screen.getAllByRole("button", { name: /^Edit /u });
      expect(editActions).toHaveLength(2);
      for (const editAction of editActions) expect(editAction).toBeDisabled();
      await user.click(screen.getByRole("button", { name: "Edit Goal" }));
      expect(actions.editPlanCreation).toHaveBeenCalledOnce();
    });

    it("restores focus to Event not listed when backing out of an edited manual Event Goal", async () => {
      const user = userEvent.setup();
      const model = planCreationModel(null, {
        version: 10,
        readiness: "ready",
        answeredSummaries: [
          {
            answerKey: "goal",
            title: "Goal",
            detail: "Highland Tour · 1998-10-18",
            question: goalQuestion("What do you want this Plan to prepare you for?"),
            answer: {
              kind: "goal",
              goal: { kind: "event-manual", name: "Highland Tour", date: "1998-10-18" },
            },
          },
        ],
      });
      vi.mocked(actions.editPlanCreation).mockImplementation((answerKey) => {
        setChat({ planCreationEditingKey: answerKey, planCreationFocusRevision: 1 });
      });
      setChat({
        planCreationLoaded: true,
        planCreation: model,
        timeline: [{ kind: "plan-creation", model }],
      });
      render(<Harness />);

      await user.click(screen.getByRole("button", { name: "Edit Goal" }));
      expect(screen.getByRole("textbox", { name: "Event name" })).toHaveValue("Highland Tour");
      await user.click(screen.getByRole("button", { name: "Back" }));

      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Event not listed" })).toHaveFocus(),
      );
    });

    it("keeps a rejected Edit Card visible with its host answer and error", () => {
      const model = planCreationModel(null, {
        version: 4,
        readiness: "ready",
        answeredSummaries: [
          {
            answerKey: "plan-length",
            title: "Plan length",
            detail: "12 weeks",
            question: planLengthQuestion("How long should this Fitness Plan be?"),
            answer: { kind: "plan-length", weeks: 12 },
          },
        ],
      });
      setChat({
        planCreationLoaded: true,
        planCreation: model,
        planCreationEditingKey: "plan-length",
        planCreationError: "Plan Creation couldn’t save that. Try again.",
        timeline: [{ kind: "plan-creation", model }],
        sendDisabled: true,
        inputDisabled: true,
      });

      render(<Harness />);

      expect(
        screen.getByRole("heading", { name: "How long should this Fitness Plan be?" }),
      ).toBeVisible();
      expect(screen.getByRole("button", { name: "12 weeks" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Plan Creation couldn’t save that. Try again.",
      );
    });

    it("edits from host-authored questions and structured current answers", async () => {
      const user = userEvent.setup();
      const model = planCreationModel(
        scheduleModeQuestion("Should this Plan use a Fixed or Flexible Schedule?"),
        {
          version: 5,
          answeredSummaries: [
            {
              answerKey: "goal",
              title: "Goal",
              detail: "Build Fitness by 1998-12-01",
              question: goalQuestion("What do you want this Plan to prepare you for?"),
              answer: {
                kind: "goal",
                goal: { kind: "fitness", outcome: "Build Fitness by 1998-12-01" },
              },
            },
            {
              answerKey: "success",
              title: "Success",
              detail: "Ride steadily",
              question: fitnessSuccessQuestion("What would success mean for this Fitness Goal?"),
              answer: {
                kind: "success",
                success: { kind: "authored", text: "Ride steadily" },
              },
            },
            {
              answerKey: "start-timing",
              title: "Start timing",
              detail: "Earliest start 1998-10-10",
              question: startTimingQuestion("When could this Plan start?", "1998-10-01"),
              answer: {
                kind: "start-timing",
                timing: { kind: "earliest", date: "1998-10-10" },
              },
            },
          ],
        },
      );
      vi.mocked(actions.editPlanCreation).mockImplementation((answerKey) => {
        setChat({ planCreationEditingKey: answerKey, planCreationFocusRevision: 1 });
      });
      vi.mocked(actions.cancelPlanCreationEdit).mockImplementation(() => {
        setChat({ planCreationEditingKey: null, planCreationFocusRevision: 2 });
      });
      setChat({
        planCreationLoaded: true,
        planCreation: model,
        timeline: [{ kind: "plan-creation", model }],
        sendDisabled: true,
      });
      render(<Harness />);

      await user.click(screen.getByRole("button", { name: "Edit Success" }));
      expect(
        screen.getByRole("heading", { name: "What would success mean for this Fitness Goal?" }),
      ).toBeVisible();
      expect(screen.getByRole("textbox", { name: "Success meaning" })).toHaveValue("Ride steadily");
      await user.click(screen.getByRole("button", { name: "Back" }));
      expect(screen.getByRole("button", { name: "Something else" })).toBeVisible();
      await user.click(screen.getByRole("button", { name: "Back to answers" }));
      await user.click(screen.getByRole("button", { name: "Edit Success" }));
      await user.clear(screen.getByRole("textbox", { name: "Success meaning" }));
      await user.type(screen.getByRole("textbox", { name: "Success meaning" }), "Unsaved success");
      await user.click(screen.getByRole("button", { name: "Back to answers" }));
      expect(actions.answerPlanCreation).not.toHaveBeenCalled();
      expect(
        screen.getByRole("heading", { name: "Should this Plan use a Fixed or Flexible Schedule?" }),
      ).toBeVisible();

      await user.click(screen.getByRole("button", { name: "Edit Start timing" }));
      const startDate = screen.getByLabelText("Earliest start date");
      expect(startDate).toHaveAttribute("min", "1998-10-01");
      expect(startDate).toHaveValue("1998-10-10");
      fireEvent.change(startDate, { target: { value: "1998-10-05" } });
      await user.click(screen.getByRole("button", { name: "Continue" }));
      expect(actions.answerPlanCreation).toHaveBeenLastCalledWith({
        kind: "start-timing",
        timing: { kind: "earliest", date: "1998-10-05" },
      });
    });

    it("pauses with Later or Escape and Continue restores the focused Card", async () => {
      const user = userEvent.setup();
      const model = planCreationModel(planLengthQuestion("How long should this Fitness Plan be?"));
      vi.mocked(actions.pausePlanCreation).mockImplementation(() => {
        setChat({ planCreationPaused: true, sendDisabled: false });
      });
      vi.mocked(actions.continuePlanCreation).mockImplementation(() => {
        setChat({ planCreationPaused: false, sendDisabled: true, planCreationFocusRevision: 1 });
      });
      setChat({
        planCreationLoaded: true,
        planCreation: model,
        timeline: [{ kind: "plan-creation", model }],
        sendDisabled: true,
      });
      render(<Harness />);

      const outsideCard = screen.getByRole("button", { name: "Hide training context" });
      outsideCard.focus();
      await user.keyboard("{Escape}");
      expect(actions.pausePlanCreation).not.toHaveBeenCalled();
      expect(screen.getByRole("heading", { name: model.openQuestion?.prompt })).toBeVisible();

      await user.click(screen.getByRole("button", { name: "Later" }));
      expect(actions.pausePlanCreation).toHaveBeenCalledOnce();
      expect(screen.queryByRole("heading", { name: model.openQuestion?.prompt })).toBeNull();
      expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
      await user.click(screen.getByRole("button", { name: "Continue" }));
      await waitFor(() =>
        expect(screen.getByRole("heading", { name: model.openQuestion?.prompt })).toHaveFocus(),
      );
      await user.keyboard("{Escape}");
      expect(actions.pausePlanCreation).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
    });

    it.each([
      ["Goal", goalQuestion("What do you want this Plan to prepare you for?")],
      ["Success", fitnessSuccessQuestion("What would success mean for this Fitness Goal?")],
      [
        "Commitments",
        commitmentsQuestion(
          "Any fixed commitments, other training, or time off to account for?",
          "Add scheduling details",
        ),
      ],
    ] as const)("returns from the %s editor on Escape without pausing", async (_name, question) => {
      const user = userEvent.setup();
      setChat({
        planCreationLoaded: true,
        planCreation: planCreationModel(question),
        sendDisabled: true,
      });
      render(<Harness />);

      await user.click(screen.getByRole("button", { name: "Something else" }));
      expect(document.querySelector('[data-parity="custom.editor"]')).not.toBeNull();
      expect(document.querySelector('[data-parity="composer"]')).toBeNull();
      await user.keyboard("{Escape}");
      expect(actions.pausePlanCreation).not.toHaveBeenCalled();
      expect(document.querySelector('[data-parity="custom.editor"]')).toBeNull();
      expect(screen.getByRole("button", { name: "Something else" })).toBeVisible();
      expect(document.querySelector('[data-parity="composer"]')).not.toBeNull();
    });

    it("lets Escape close command suggestions before it pauses the Card", async () => {
      const user = userEvent.setup();
      const model = planCreationModel(planLengthQuestion("How long should this Fitness Plan be?"));
      setChat({ planCreationLoaded: true, planCreation: model, sendDisabled: true });
      render(<Harness />);

      await user.type(composer(), "/");
      expect(screen.getByRole("listbox", { name: "Commands" })).toBeVisible();
      await user.keyboard("{Escape}");
      expect(actions.pausePlanCreation).not.toHaveBeenCalled();
      expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();
      expect(screen.getByRole("heading", { name: model.openQuestion?.prompt })).toBeVisible();
    });

    it("shows the ready state and does not carry goal text into the next textarea", async () => {
      const user = userEvent.setup();
      setChat({
        planCreationLoaded: true,
        planCreation: planCreationModel(
          goalQuestion("What do you want this Plan to prepare you for?"),
        ),
      });
      render(<Harness />);
      await user.click(screen.getByRole("button", { name: "Improve without an event" }));
      expect(actions.answerPlanCreation).toHaveBeenLastCalledWith({
        kind: "goal",
        goal: { kind: "fitness" },
      });

      setChat({
        planCreation: planCreationModel(
          commitmentsQuestion(
            "Any fixed commitments, other training, or time off to account for?",
            "Add only the scheduling details this Plan should account for",
          ),
          { version: 2 },
        ),
      });
      expect(screen.queryByLabelText("Scheduling details")).toBeNull();
      await user.click(screen.getByRole("button", { name: "Something else" }));
      expect(screen.getByLabelText("Scheduling details")).toHaveValue("");

      const ready = planCreationModel(null, {
        version: 10,
        readiness: "ready",
        answeredSummaries: [
          {
            answerKey: "restriction",
            title: "Training Restriction",
            detail: "No training restrictions",
            question: restrictionQuestion("What Training Restriction should this Plan respect?"),
            answer: { kind: "restriction", restriction: { kind: "none" } },
          },
        ],
      });
      setChat({
        planCreation: ready,
        timeline: [{ kind: "plan-creation", model: ready }],
        sendDisabled: false,
      });
      expect(screen.getByText("The essentials are complete.")).toBeVisible();
      expect(screen.getByRole("button", { name: "Build Draft" })).toBeVisible();
      expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
      await user.click(screen.getByRole("button", { name: "Build Draft" }));
      expect(actions.buildPlanCreationDraft).toHaveBeenCalledOnce();
      expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
    });

    it("renders the whole Draft with closed builder details and separate review actions", async () => {
      const draft = planCreationDraft();
      const model: PlanCreationCardModel = {
        ...planCreationModel(null),
        status: "review",
        draft,
      };
      setChat({
        planCreationLoaded: true,
        planCreation: model,
        timeline: [{ kind: "plan-creation", model }],
      });
      render(<Harness />);

      expect(screen.getByText("Review the whole Draft before activating.")).toBeVisible();
      expect(screen.getByRole("heading", { name: "Every week and Workout" })).toBeVisible();
      expect(screen.getByText("4 weeks · 3 Workouts · 180 min")).toBeVisible();
      expect(screen.getAllByText("Priority 1 · Undated")).toHaveLength(3);
      expect(screen.getByText("No Workouts this week.")).toBeVisible();
      expect(screen.getByText("Confirmed limits leave no Workouts in this week.")).toBeVisible();
      for (const week of draft.weeks) {
        expect(screen.getByText(new RegExp(`Week ${week.number} ·`))).toBeVisible();
      }
      const disclosure = screen.getByText("How this Plan was built").closest("details");
      expect(disclosure).not.toHaveAttribute("open");
      await userEvent.click(screen.getByText("How this Plan was built"));
      expect(disclosure).toHaveAttribute("open");
      expect(
        screen.getByText("Endurance ride limited to 60 minutes by your confirmed limits."),
      ).toBeVisible();
      const discard = screen.getByRole("button", { name: "Discard" });
      const edit = screen.getByRole("button", { name: "Edit answers" });
      const activate = screen.getByRole("button", { name: "Activate Plan" });
      expect(activate).toBeEnabled();
      await userEvent.click(activate);
      expect(actions.openPlanCreationActivate).toHaveBeenCalledOnce();
      expect(discard.compareDocumentPosition(edit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(
        edit.compareDocumentPosition(activate) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      await userEvent.click(discard);
      expect(actions.openPlanCreationDiscard).toHaveBeenCalledOnce();
      expect(composer()).toBeEnabled();
    });

    it("requires written commitments confirmation before activation and focuses activation after confirmation", async () => {
      const model: PlanCreationCardModel = {
        ...planCreationModel(null),
        status: "review",
        draft: planCreationDraft(),
        commitmentsAcknowledgement: { text: "Keep Fridays free for family." },
      };
      setChat({
        planCreationLoaded: true,
        planCreation: model,
        timeline: [{ kind: "plan-creation", model }],
      });
      render(<Harness />);
      const card = screen.getByRole("region", { name: "Confirm your written commitments" });
      const activate = screen.getByRole("button", { name: "Activate Plan" });
      expect(within(card).getByText("Written commitments")).toBeVisible();
      expect(within(card).getByText("Not yet confirmed")).toBeVisible();
      expect(within(card).getByRole("rowheader", { name: "Submitted" })).toBeVisible();
      expect(within(card).getByRole("cell")).toHaveTextContent("Keep Fridays free for family.");
      expect(activate).toBeDisabled();
      expect(activate).toHaveAccessibleDescription(
        "These commitments are recorded but were not applied to Workouts. Activation waits for your confirmation.",
      );
      expect(
        card.compareDocumentPosition(activate) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        within(card)
          .getAllByRole("button")
          .map((button) => button.textContent),
      ).toEqual(["Edit commitments", "Confirm limits"]);
      await userEvent.click(within(card).getByRole("button", { name: "Confirm limits" }));
      expect(actions.answerPlanCreation).toHaveBeenCalledExactlyOnceWith({
        kind: "commitments",
        commitments: {
          kind: "authored",
          text: "Keep Fridays free for family.",
          acknowledged: true,
        },
      });
      setChat({ planCreationBusy: true });
      for (const button of within(card).getAllByRole("button")) expect(button).toBeDisabled();
      await userEvent.click(within(card).getByRole("button", { name: "Confirm limits" }));
      expect(actions.answerPlanCreation).toHaveBeenCalledOnce();
      const confirmed = { ...model, version: model.version + 1, commitmentsAcknowledgement: null };
      setChat({
        planCreationBusy: false,
        planCreation: confirmed,
        timeline: [{ kind: "plan-creation", model: confirmed }],
        planCreationFocusRequest: { target: "activate", revision: 1 },
      });
      expect(screen.queryByRole("region", { name: "Confirm your written commitments" })).toBeNull();
      expect(activate).toBeEnabled();
      expect(activate).not.toHaveAttribute("aria-describedby");
      await waitFor(() => expect(activate).toHaveFocus());
    });

    it("edits pending written commitments in the existing prefilled editor", async () => {
      const text = "Keep Fridays free for family.";
      const model: PlanCreationCardModel = {
        ...planCreationModel(null, {
          answeredSummaries: [
            {
              answerKey: "commitments",
              title: "Commitments",
              detail: text,
              question: commitmentsQuestion("What should this Plan work around?", "Your limits"),
              answer: { kind: "commitments", commitments: { kind: "authored", text } },
            },
          ],
        }),
        status: "review",
        draft: planCreationDraft(),
        commitmentsAcknowledgement: { text },
      };
      vi.mocked(actions.editPlanCreation).mockImplementation((answerKey) => {
        setChat({ planCreationEditingKey: answerKey, planCreationFocusRevision: 1 });
      });
      setChat({
        planCreationLoaded: true,
        planCreation: model,
        timeline: [{ kind: "plan-creation", model }],
      });
      render(<Harness />);
      await userEvent.click(screen.getByRole("button", { name: "Edit commitments" }));
      expect(actions.editPlanCreation).toHaveBeenCalledExactlyOnceWith("commitments");
      const editor = screen.getByRole("textbox", { name: "Scheduling details" });
      expect(editor).toHaveValue(text);
      await waitFor(() => expect(editor).toHaveFocus());
      expect(screen.getByRole("button", { name: "Confirm limits" })).toBeDisabled();
      expect(actions.answerPlanCreation).not.toHaveBeenCalled();
    });

    it("keeps fixed Workout dates and pinned status visible during Draft review", () => {
      const draft = planCreationDraft();
      draft.mode = "fixed";
      for (const week of draft.weeks) {
        for (const workout of week.workouts) {
          workout.date = week.start;
          workout.pinned = true;
        }
      }
      const model: PlanCreationCardModel = {
        ...planCreationModel(null),
        status: "review",
        draft,
      };
      setChat({
        planCreationLoaded: true,
        planCreation: model,
        timeline: [{ kind: "plan-creation", model }],
      });
      render(<Harness />);

      expect(screen.queryByText("Priority 1 · Undated")).toBeNull();
      expect(screen.getAllByText("planned · Pinned")).toHaveLength(3);
      for (const date of ["7 Sept 1998", "21 Sept 1998", "28 Sept 1998"]) {
        expect(screen.getByText(date, { exact: true })).toBeVisible();
      }
    });

    it("preserves Draft inputs below changed answers and rebuilds with the current card", async () => {
      const original = planCreationModel(null, {
        answeredSummaries: [
          {
            answerKey: "plan-length",
            title: "Plan length",
            detail: "4 weeks",
            question: planLengthQuestion("How long should this Fitness Plan be?"),
            answer: { kind: "plan-length", weeks: 4 },
          },
        ],
      });
      const model: PlanCreationCardModel = {
        ...original,
        version: 3,
        status: "review",
        draft: planCreationDraft(original.answeredSummaries),
        draftStale: true,
        answeredSummaries: original.answeredSummaries.map((summary) => ({
          ...summary,
          detail: "8 weeks",
          answer: { kind: "plan-length", weeks: 8 },
        })),
      };
      setChat({
        planCreationLoaded: true,
        planCreation: model,
        timeline: [{ kind: "plan-creation", model }],
      });
      render(<Harness />);

      const changed = screen.getByRole("heading", { name: "Changed answers" });
      const outline = screen.getByRole("heading", { name: "Every week and Workout" });
      expect(
        changed.compareDocumentPosition(outline) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(screen.getByText("4 weeks", { exact: true })).toBeVisible();
      expect(screen.getByText("8 weeks", { exact: true })).toBeVisible();
      expect(screen.getByText("Plan length · current answer")).toBeVisible();
      expect(
        screen.getByText(
          "This Draft preserves the earlier answers and Workouts. Rebuild before activation.",
        ),
      ).toBeVisible();
      expect(screen.queryByRole("button", { name: "Activate Plan" })).toBeNull();
      await userEvent.click(screen.getByRole("button", { name: "Rebuild Draft" }));
      expect(actions.buildPlanCreationDraft).toHaveBeenCalledOnce();
      await userEvent.click(screen.getByRole("button", { name: "Edit answers" }));
      expect(screen.getByText("A changed answer makes the Draft stale.")).toBeVisible();
      expect(screen.getByRole("button", { name: "Edit Plan length" })).toBeEnabled();
      await userEvent.click(screen.getByRole("button", { name: "Back to Draft" }));
      expect(screen.getByRole("heading", { name: "Every week and Workout" })).toBeVisible();
    });

    it("keeps summaries in the conversation and submits authored success", async () => {
      const actions = stubActions();
      useEnduragentStore.getState().bindChatActions(actions);
      render(<Harness />);
      const successQuestion = fitnessSuccessQuestion("What would success mean?");
      const model = planCreationModel(successQuestion, {
        version: 2,
        answeredSummaries: [
          {
            answerKey: "goal" as const,
            title: "Goal",
            detail: "Build steady power",
            question: goalQuestion("What are you preparing for?"),
            answer: {
              kind: "goal" as const,
              goal: { kind: "fitness" as const, outcome: "Build steady power" },
            },
          },
        ],
      });
      setChat({
        planCreation: model,
        planCreationLoaded: true,
        sendDisabled: true,
        inputDisabled: true,
        composerPlaceholder: "Finish the Plan question above",
        timeline: [{ kind: "plan-creation", model }],
      });
      await waitFor(() =>
        expect(screen.getByRole("heading", { name: "What would success mean?" })).toHaveFocus(),
      );
      expect(screen.getByText("Build steady power")).toBeVisible();
      expect(screen.getByText("Goal · your answer", { exact: true })).toBeVisible();
      expect(screen.getByText("1 of 9 answered.")).toBeVisible();
      const answerRow = screen.getByRole("listitem", { name: "Goal answer" });
      expect(answerRow).not.toHaveAttribute("role", "status");
      expect(composer()).toBeDisabled();
      expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
      await userEvent.click(screen.getByRole("button", { name: "Something else" }));
      await userEvent.type(
        screen.getByRole("textbox", { name: "Success meaning" }),
        "Ride four steady hours",
      );
      await userEvent.click(screen.getByRole("button", { name: "Continue" }));
      expect(actions.answerPlanCreation).toHaveBeenCalledWith({
        kind: "success",
        success: { kind: "authored", text: "Ride four steady hours" },
      });
      const complete = planCreationModel(
        planLengthQuestion("How long should this Fitness Plan be?"),
        {
          version: 3,
          answeredSummaries: [
            ...model.answeredSummaries,
            {
              answerKey: "success" as const,
              title: "Success",
              detail: "Ride four steady hours",
              question: successQuestion,
              answer: {
                kind: "success" as const,
                success: { kind: "authored" as const, text: "Ride four steady hours" },
              },
            },
          ],
        },
      );
      setChat({
        planCreation: complete,
        sendDisabled: true,
        timeline: [{ kind: "plan-creation", model: complete }],
      });
      expect(screen.queryByRole("heading", { name: "What would success mean?" })).toBeNull();
      expect(screen.getByText("2 of 9 answered.")).toBeVisible();
      expect(
        screen.getByRole("heading", { name: "How long should this Fitness Plan be?" }),
      ).toBeVisible();
      expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    });

    it.each([false, true])(
      "confirms activation with the active Plan copy and restores focus on Escape (active: %s)",
      async (hasActivePlan) => {
        const model: PlanCreationCardModel = {
          ...planCreationModel(null),
          status: "review",
          draft: planCreationDraft(),
        };
        useEnduragentStore.setState({
          planLibrary: {
            status: "ready",
            value: {
              calendarConnected: false,
              legacy: null,
              creation: null,
              closed: [],
              changesPaused: null,
              changes: [],
              active: hasActivePlan
                ? {
                    planId: "00000000000000000000000003",
                    version: 2,
                    name: "Steady autumn",
                    start: "1998-07-06",
                    end: "1998-10-04",
                    weeks: 12,
                    status: "active",
                    supportingEventCandidates: [],
                    closeReason: null,
                    closedAt: null,
                    activatedAt: "1998-07-06",
                    todayChoice: null,
                    creationId: null,
                    calendar: {
                      status: "pending",
                      window: null,
                      currentThrough: null,
                      error: null,
                    },
                  }
                : null,
            },
          },
        });
        if (hasActivePlan) {
          useEnduragentStore.getState().setPlanHydration({
            status: "ready",
            state: planReadModel({
              lifecycle: "active",
              title: "Plan active locally",
              scenarioId: "PL-S004",
              projection: "active",
              planId: "00000000000000000000000003",
              data: {
                plan: {
                  id: "00000000000000000000000003",
                  name: "Steady autumn",
                  primaryGoal: "Build steady power",
                  startDate: "1998-07-06",
                  targetDate: "1998-10-04",
                  kind: "full-plan",
                  totalWeeks: 12,
                  weekStartDay: 1,
                  workoutCount: 0,
                  plannedDurationS: 0,
                },
                today: "1998-07-13",
                weekIndex: 2,
                todayWorkout: null,
                workouts: [],
              },
            }),
          });
        }
        actions.openPlanCreationActivate = vi.fn(() =>
          setChat({
            planCreationActivateConfirmationOpen: true,
            planCreationActivePlanKnowledge: hasActivePlan
              ? { kind: "active", name: "Steady autumn" }
              : { kind: "none" },
          }),
        );
        actions.cancelPlanCreationActivate = vi.fn(() =>
          setChat({
            planCreationActivateConfirmationOpen: false,
            planCreationFocusRequest: { target: "activate", revision: 1 },
          }),
        );
        setChat({
          planCreationLoaded: true,
          planCreation: model,
          timeline: [{ kind: "plan-creation", model }],
        });
        render(<Harness />);
        const trigger = screen.getByRole("button", { name: "Activate Plan" });
        await userEvent.click(trigger);
        const dialog = screen.getByRole("dialog");
        expect(dialog).toHaveAccessibleName(
          hasActivePlan ? "Close and activate?" : "Activate Plan?",
        );
        expect(
          screen.getByText(
            hasActivePlan
              ? "Steady autumn closes. Today’s calendar Workout stays. The new Plan activates now."
              : "The new Plan activates now.",
          ),
        ).toBeVisible();
        const cancel = within(dialog).getByRole("button", { name: "Cancel" });
        const confirm = within(dialog).getByRole("button", {
          name: hasActivePlan ? "Activate new Plan" : "Activate Plan",
        });
        expect(
          cancel.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        await waitFor(() => expect(cancel).toHaveFocus());
        await userEvent.keyboard("{Escape}");
        expect(actions.cancelPlanCreationActivate).toHaveBeenCalledOnce();
        expect(screen.queryByRole("dialog")).toBeNull();
        await waitFor(() => expect(trigger).toHaveFocus());
        expect(useEnduragentStore.getState().chat.planCreation).toEqual(model);
        expect(actions.confirmPlanCreationActivate).not.toHaveBeenCalled();
      },
    );

    it.each([null, "Activation could not be saved locally. Your previous Plan is unchanged."])(
      "keeps the dialog closed while the current Plan is unknown (error: %s)",
      async (error) => {
        const model: PlanCreationCardModel = {
          ...planCreationModel(null),
          status: "review",
          draft: planCreationDraft(),
        };
        setChat({
          planCreationLoaded: true,
          planCreation: model,
          timeline: [{ kind: "plan-creation", model }],
          planCreationActivateConfirmationOpen: false,
          planCreationActivePlanKnowledge: { kind: "unknown" },
          planCreationBusy: error === null,
          planCreationError: error,
        });
        render(<Harness />);
        expect(screen.queryByRole("dialog")).toBeNull();
        const trigger = screen.getByRole("button", { name: "Activate Plan" });
        if (error === null) {
          expect(trigger).toBeDisabled();
        } else {
          expect(trigger).toBeEnabled();
          expect(screen.getByRole("alert")).toHaveTextContent(error);
          await userEvent.click(trigger);
          expect(actions.openPlanCreationActivate).toHaveBeenCalledOnce();
        }
        expect(actions.confirmPlanCreationActivate).not.toHaveBeenCalled();
      },
    );

    it("shows activation failure inside the open dialog without losing review cards", async () => {
      const model: PlanCreationCardModel = {
        ...planCreationModel(null),
        status: "review",
        draft: planCreationDraft(),
      };
      useEnduragentStore.setState({
        planLibrary: {
          status: "ready",
          value: {
            calendarConnected: false,
            legacy: null,
            creation: null,
            active: null,
            closed: [],
            changesPaused: null,
            changes: [],
          },
        },
        planLibraryActions: {
          refresh: vi.fn(async () => {}),
          closePlan: vi.fn(),
          readPlanHistory: vi.fn(),
          startCreation: vi.fn(),
          continueCreation: vi.fn(),
          changeInChat: vi.fn(),
        },
      });
      actions.confirmPlanCreationActivate = vi.fn(() =>
        setChat({
          planCreationError:
            "Activation could not be saved locally. Your previous Plan is unchanged.",
        }),
      );
      setChat({
        planCreationLoaded: true,
        planCreation: model,
        planCreationActivateConfirmationOpen: true,
        planCreationActivePlanKnowledge: { kind: "none" },
        timeline: [{ kind: "plan-creation", model }],
      });
      render(<Harness />);
      const dialog = screen.getByRole("dialog");
      await waitFor(() =>
        expect(within(dialog).getByRole("button", { name: "Activate Plan" })).toBeEnabled(),
      );
      await userEvent.click(within(dialog).getByRole("button", { name: "Activate Plan" }));
      expect(
        within(dialog).getByText(
          "Activation could not be saved locally. Your previous Plan is unchanged.",
        ),
      ).toBeVisible();
      expect(useEnduragentStore.getState().chat.planCreation).toEqual(model);
      expect(screen.getByRole("dialog")).toBeVisible();
    });

    it("disables activation for a Draft without Workouts", () => {
      const draft = planCreationDraft();
      draft.weeks = draft.weeks.map((week) => ({ ...week, workouts: [] }));
      const model: PlanCreationCardModel = { ...planCreationModel(null), status: "review", draft };
      setChat({
        planCreationLoaded: true,
        planCreation: model,
        timeline: [{ kind: "plan-creation", model }],
      });
      render(<Harness />);
      expect(screen.getByRole("button", { name: "Activate Plan" })).toBeDisabled();
    });

    it("confirms discarding in a modal and restores the initiating control on Escape", async () => {
      const actions = stubActions();
      const model = planCreationModel(fitnessSuccessQuestion("What would success mean?"), {
        version: 2,
        answeredSummaries: [
          {
            answerKey: "goal",
            title: "Goal",
            detail: "Build steady power",
            question: goalQuestion("What are you preparing for?"),
            answer: { kind: "goal", goal: { kind: "fitness", outcome: "Build steady power" } },
          },
        ],
      });
      actions.openPlanCreationDiscard = vi.fn(() => {
        setChat({
          planCreationDiscardConfirmationOpen: true,
          sendDisabled: true,
          inputDisabled: true,
        });
      });
      actions.cancelPlanCreationDiscard = vi.fn(() => {
        setChat({
          planCreationDiscardConfirmationOpen: false,
          planCreationFocusRequest: { target: "discard", revision: 1 },
          sendDisabled: true,
          inputDisabled: true,
        });
      });
      useEnduragentStore.getState().bindChatActions(actions);
      render(<Harness />);
      setChat({
        decision: unansweredDecision(),
        planCreation: model,
        planCreationLoaded: true,
        sendDisabled: true,
        inputDisabled: true,
        timeline: [{ kind: "plan-creation", model }],
      });

      const discard = screen.getByRole("button", { name: "Discard" });
      expect(discard).toHaveClass("bg-destructive/10");
      await userEvent.click(discard);

      expect(screen.getByRole("heading", { name: "Discard this Plan creation?" })).toBeVisible();
      expect(composer()).toBeDisabled();
      expect(
        screen.getByText(
          "No Plan is created. Your active Plan, Schedule, training restrictions, closed Plans, saved preferences, and chat history are unchanged.",
        ),
      ).toBeVisible();
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Keep creating" })).toHaveFocus(),
      );
      expect(screen.getByRole("button", { name: "Discard creation" })).toHaveClass(
        "bg-destructive",
      );

      await userEvent.keyboard("{Escape}");

      expect(actions.cancelPlanCreationDiscard).toHaveBeenCalledOnce();
      expect(screen.queryByRole("heading", { name: "Discard this Plan creation?" })).toBeNull();
      expect(screen.getByRole("heading", { name: "What would success mean?" })).toBeVisible();
      expect(screen.getByText("Choose tomorrow’s priority.")).toBeVisible();
      await waitFor(() => expect(discard).toHaveFocus());
    });

    it("disables discard confirmation in flight and focuses Start after success", async () => {
      const actions = stubActions();
      const model = planCreationModel(null, {
        version: 3,
        answeredSummaries: [
          {
            answerKey: "goal",
            title: "Goal",
            detail: "Build steady power",
            question: goalQuestion("What are you preparing for?"),
            answer: { kind: "goal", goal: { kind: "fitness", outcome: "Build steady power" } },
          },
        ],
      });
      actions.openPlanCreationDiscard = vi.fn(() => {
        setChat({
          planCreationDiscardConfirmationOpen: true,
          sendDisabled: true,
          inputDisabled: true,
        });
      });
      actions.confirmPlanCreationDiscard = vi.fn(() => {
        setChat({ planCreationBusy: true });
      });
      useEnduragentStore.getState().bindChatActions(actions);
      render(<Harness />);
      setChat({
        planCreation: model,
        planCreationLoaded: true,
        timeline: [{ kind: "plan-creation", model }],
      });

      await userEvent.click(screen.getByRole("button", { name: "Discard" }));
      await userEvent.click(screen.getByRole("button", { name: "Discard creation" }));

      expect(actions.confirmPlanCreationDiscard).toHaveBeenCalledOnce();
      expect(screen.getByRole("button", { name: "Keep creating" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Discard creation" })).toBeDisabled();
      setChat({
        planCreation: null,
        planCreationBusy: false,
        planCreationDiscardConfirmationOpen: false,
        planCreationFocusRequest: { target: "start", revision: 1 },
        sendDisabled: false,
        inputDisabled: false,
        timeline: [{ kind: "plan-creation-discard", eventId: "01J00000000000000000000000" }],
      });
      const start = screen.getByRole("button", { name: "Start a Plan" });
      await waitFor(() => expect(start).toHaveFocus());
      const discarded = document.querySelector('[data-parity="discarded.record"]');
      expect(discarded).not.toBeNull();
      expect(discarded?.compareDocumentPosition(start)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      expect(composer()).toBeEnabled();
      expect(screen.queryByText("Build steady power", { exact: true })).toBeNull();
      expect(screen.getByText("Plan creation discarded")).toBeVisible();
      expect(
        screen.getByText(
          "No Plan was created. Your active Plan, Schedule, training restrictions, saved preferences, and chat history are unchanged.",
        ),
      ).toBeVisible();
    });

    it("closes discard confirmation and shows the returned Card after rejection", async () => {
      const actions = stubActions();
      const model = planCreationModel(planLengthQuestion("How long should this Fitness Plan be?"), {
        version: 3,
        answeredSummaries: [
          {
            answerKey: "goal",
            title: "Goal",
            detail: "Build steady power",
            question: goalQuestion("What are you preparing for?"),
            answer: {
              kind: "goal",
              goal: { kind: "fitness", outcome: "Build steady power" },
            },
          },
        ],
      });
      const returned = { ...model, version: 4 };
      actions.openPlanCreationDiscard = vi.fn(() => {
        setChat({
          planCreationDiscardConfirmationOpen: true,
          sendDisabled: true,
          inputDisabled: true,
        });
      });
      actions.confirmPlanCreationDiscard = vi.fn(() => {
        setChat({
          planCreation: returned,
          planCreationDiscardConfirmationOpen: false,
          planCreationFocusRequest: { target: "discard", revision: 1 },
          sendDisabled: false,
          inputDisabled: false,
          notice:
            "Plan Creation changed before it could be discarded. The latest version is shown.",
          timeline: [{ kind: "plan-creation", model: returned }],
        });
      });
      useEnduragentStore.getState().bindChatActions(actions);
      render(<Harness />);
      setChat({
        planCreation: model,
        planCreationLoaded: true,
        timeline: [{ kind: "plan-creation", model }],
      });

      await userEvent.click(screen.getByRole("button", { name: "Discard" }));
      await userEvent.click(screen.getByRole("button", { name: "Discard creation" }));

      expect(screen.queryByRole("heading", { name: "Discard this Plan creation?" })).toBeNull();
      expect(screen.getByText("Build steady power", { exact: true })).toBeVisible();
      expect(
        screen.getByText(
          "Plan Creation changed before it could be discarded. The latest version is shown.",
        ),
      ).toHaveClass("chat-notice");
      await waitFor(() => expect(screen.getByRole("button", { name: "Discard" })).toHaveFocus());
    });

    it("declares the Inter and Geist font foundation", async () => {
      const sourceRoot = resolve(import.meta.dirname, "..", "src");
      const [transcript, tokens, fonts] = await Promise.all([
        readFile(resolve(sourceRoot, "ui/chat/Transcript.tsx"), "utf8"),
        readUiStylesheet("tokens.css"),
        readUiStylesheet("fonts.css"),
      ]);
      expect(transcript).toContain(
        "chat-message--coach max-w-full justify-self-start text-sm leading-5",
      );
      expect(tokens).toMatch(/--font-size-sm:\s*14px;/u);
      expect(tokens).toMatch(/--line-height-sm:\s*20px;/u);
      expect(tokens).toMatch(/--f-prose:\s*var\(--f-ui\);/u);
      expect(tokens).toMatch(/--f-ui:\s*\n?\s*"Inter Variable", "Inter",/u);
      expect(tokens).toMatch(/--f-mono:\s*\n?\s*"Geist Mono Variable", "Geist Mono",/u);
      expect(tokens).toMatch(
        /body\s*\{[^}]*font-optical-sizing:\s*auto;[^}]*font-feature-settings:\s*"cv01",\s*"ss02";/su,
      );
      expect(fonts).toContain("font-family: 'Inter Variable'");
      expect(fonts).toContain("font-family: 'Geist Mono Variable'");
      expect(fonts).not.toContain("dm-sans");
    });

    it("keeps chat core on Tailwind and the Base UI-backed command menu", async () => {
      const sourceRoot = resolve(import.meta.dirname, "..", "src", "ui", "chat");
      const sources = await Promise.all(
        [
          "AthleteMessage.tsx",
          "ChatView.tsx",
          "CoachMessage.tsx",
          "Composer.tsx",
          "HistoryControls.tsx",
          "Message.ts",
          "Notice.tsx",
          "SlashPopup.tsx",
          "StreamingMessage.tsx",
          "Transcript.tsx",
        ].map((name) => readFile(resolve(sourceRoot, name), "utf8")),
      );
      const source = sources.join("\n");
      expect(source).not.toContain(".module.css");
      expect(source).not.toContain("font-mono");
      expect(source).toContain("PopoverContent");
      expect(source).toContain("@enduragent/ui");
      expect(source).toContain("chat-markdown\\\\_\\\\_table-scroll");
    });

    it("keeps chat support cards and dialogs on shared UI primitives", async () => {
      const sourceRoot = resolve(import.meta.dirname, "..", "src", "ui", "chat");
      const sources = await Promise.all(
        [
          "FirstSyncCard.tsx",
          "NewConversationDialog.tsx",
          "QueuedMessages.tsx",
          "SpendNotice.tsx",
          "TrainingContextPanel.tsx",
        ].map((name) => readFile(resolve(sourceRoot, name), "utf8")),
      );
      const source = sources.join("\n");
      expect(source).not.toContain(".module.css");
      expect(source).not.toContain("font-mono");
      expect(source).toContain("@enduragent/ui");
      expect(source).toContain("Card");
      expect(source).toContain("Dialog");
    });
  });
});
