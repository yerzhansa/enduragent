import { act, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatView, ChatViewControls } from "../src/chat/controller";
import { mergeHydratedMessages } from "../src/chat/hydration";
import { createChatViewAdapter } from "../src/state/adapters/chat";
import { EMPTY_CHAT_SURFACE, type ChatSurfaceState } from "../src/state/chat-slice";
import { createChatScrollAnchor, resetChatStream } from "../src/state/chat-stream";
import { READY_ONBOARDING } from "../src/state/onboarding-slice";
import { useEnduragentStore } from "../src/state/store";
import {
  CHAT_WORKING_COPY,
  EMPTY_CHAT_STATE,
  reduceChatState,
  type ChatState,
} from "../src/turn-state";
import { ChatView as ChatSurface } from "../src/ui/chat/ChatView";

const TURN_ID = "turn-1";

function controls(patch: Partial<ChatViewControls> = {}): ChatViewControls {
  return {
    newConversationDisabled: true,
    workBlocked: false,
    hydration: { status: "ready", hasEarlier: false, revision: 1, change: "none" },
    ...patch,
  };
}

function submitted(message = "How is my form?"): ChatState {
  return reduceChatState(EMPTY_CHAT_STATE, {
    type: "submit",
    requestKey: 1,
    userMessage: message,
    userMessageId: "m1",
    assistantMessageId: "m2",
    includeUser: true,
  });
}

function delta(state: ChatState, text: string): { state: ChatState; controls: ChatViewControls } {
  const previousTextLength = state.activeTurn?.draft.length ?? 0;
  return {
    state: reduceChatState(state, {
      type: "event",
      requestKey: 1,
      event: { type: "text_delta", turnId: TURN_ID, delta: text },
    }),
    controls: controls({
      appendDelta: {
        messageId: "m2",
        previousTextLength,
        nextTextLength: previousTextLength + text.length,
        delta: text,
      },
    }),
  };
}

describe("chat view adapter", () => {
  afterEach(() => {
    resetChatStream();
  });

  it("satisfies the chat view port and projects controller state into a surface", () => {
    const published: ChatSurfaceState[] = [];
    const adapter = createChatViewAdapter({ publish: (next) => published.push(next) });
    const view: ChatView = adapter.view;

    view.render(
      submitted(),
      controls({
        newConversationDisabled: false,
        workBlocked: true,
        hydration: { status: "loading", hasEarlier: true, revision: 3, change: "prepend" },
      }),
    );

    expect(published).toHaveLength(1);
    expect(published[0]).toEqual({
      messages: [
        {
          id: "m1",
          role: "athlete",
          delivery: "complete",
          historical: false,
          text: "How is my form?",
        },
      ],
      queued: [],
      retryRequired: null,
      decision: null,
      decisionPhase: "idle",
      decisionAnswerLabel: null,
      decisionError: null,
      decisionLoadError: null,
      queueMutationError: null,
      attachments: null,
      attachmentAdmissions: [],
      attachmentBusy: false,
      attachmentError: null,
      planningRequests: [],
      planningRequestsLoaded: false,
      planningRequestBusyId: null,
      planningRequestError: null,
      planningRequestFocusId: null,
      planCreation: null,
      planCreationLoaded: false,
      planCreationBusy: false,
      planCreationError: null,
      timeline: [
        {
          kind: "message",
          message: {
            id: "m1",
            role: "athlete",
            delivery: "complete",
            historical: false,
            text: "How is my form?",
          },
        },
      ],
      status: "streaming",
      notice: null,
      coachProgress: CHAT_WORKING_COPY,
      interrupted: false,
      workBlocked: true,
      sendDisabled: true,
      inputDisabled: true,
      newConversationUnavailable: false,
      resetPhase: "idle",
      resetCount: 0,
      announcement: null,
      hasHydratedHistory: false,
      hydrationStatus: "loading",
      hydrationHasEarlier: true,
      hydrationRevision: 3,
      hydrationChange: "prepend",
    });
  });

  it("blocks normal Chat work and projects a completed decision consequence", () => {
    const published: ChatSurfaceState[] = [];
    const adapter = createChatViewAdapter({ publish: (next) => published.push(next) });
    const decision = {
      decisionId: "decision-1",
      chatId: "desktop",
      messageId: "message-1",
      question: "Choose tomorrow’s priority.",
      status: "unanswered" as const,
      options: [
        {
          id: "recovery",
          label: "Prioritize recovery",
          description: "Choose an easy day.",
          recommended: true,
          consequence: "Tomorrow becomes a recovery day.",
        },
        {
          id: "tempo",
          label: "Keep tempo",
          description: "Keep the planned workout.",
          recommended: false,
          consequence: "Tomorrow keeps tempo.",
        },
      ],
    };

    adapter.view.render(
      EMPTY_CHAT_STATE,
      controls({
        decision: { value: decision, phase: "idle", answerLabel: null, error: null },
      }),
    );
    expect(published.at(-1)).toMatchObject({ sendDisabled: true, inputDisabled: false });

    adapter.view.render(
      EMPTY_CHAT_STATE,
      controls({
        decision: {
          value: {
            ...decision,
            status: "answered",
            answer: { kind: "option", optionId: "recovery" },
            consequence: "Tomorrow becomes a recovery day.",
            continuation: {
              continuationId: "continuation-1",
              status: "completed",
              turnId: "turn-1",
              coachText: "We’ll keep tomorrow easy.",
            },
          },
          phase: "idle",
          answerLabel: "Prioritize recovery",
          error: null,
        },
      }),
    );
    expect(published.at(-1)?.timeline).toContainEqual({
      kind: "choice",
      choice: {
        id: "decision-1",
        label: "Prioritize recovery",
        consequence: "Tomorrow becomes a recovery day.",
        skipped: false,
        historical: false,
      },
    });
  });

  it("blocks Send while the persisted decision state is loading", () => {
    const published: ChatSurfaceState[] = [];
    const adapter = createChatViewAdapter({ publish: (next) => published.push(next) });

    adapter.view.render(EMPTY_CHAT_STATE, controls({ decisionLoading: true }));

    expect(published.at(-1)).toMatchObject({
      sendDisabled: true,
      inputDisabled: false,
      newConversationUnavailable: true,
    });
  });

  it("projects a Plan Creation conversation item and blocks only Send for an open question", () => {
    const published: ChatSurfaceState[] = [];
    const adapter = createChatViewAdapter({ publish: (next) => published.push(next) });
    const model = {
      creationId: "01J00000000000000000000000",
      version: 1,
      status: "in-progress" as const,
      answeredSummaries: [],
      openQuestion: { kind: "goal-question" as const, prompt: "Goal?", candidates: [] },
    };
    adapter.view.render(
      EMPTY_CHAT_STATE,
      controls({
        planCreation: { value: model, loaded: true, busy: false, error: null },
      }),
    );
    expect(published.at(-1)).toMatchObject({
      planCreation: model,
      planCreationLoaded: true,
      sendDisabled: true,
      inputDisabled: false,
      timeline: [{ kind: "plan-creation", model }],
    });
    adapter.view.render(
      EMPTY_CHAT_STATE,
      controls({
        planCreation: {
          value: { ...model, version: 2, openQuestion: null },
          loaded: true,
          busy: false,
          error: null,
        },
      }),
    );
    expect(published.at(-1)).toMatchObject({ sendDisabled: false, inputDisabled: false });
  });

  it("suppresses interrupted recovery while a Plan Creation question is open", () => {
    const published: ChatSurfaceState[] = [];
    const adapter = createChatViewAdapter({ publish: (next) => published.push(next) });
    let stopped = submitted();
    stopped = reduceChatState(stopped, {
      type: "event",
      requestKey: 1,
      event: {
        type: "interrupted",
        turnId: "turn-stopped",
        chatId: "desktop",
        text: "Partial response",
      },
    });

    adapter.view.render(
      stopped,
      controls({
        planCreation: {
          value: {
            creationId: "01J00000000000000000000000",
            version: 1,
            status: "in-progress",
            answeredSummaries: [],
            openQuestion: { kind: "goal-question", prompt: "Goal?", candidates: [] },
          },
          loaded: true,
          busy: false,
          error: null,
        },
      }),
    );

    expect(published.at(-1)).toMatchObject({ status: "interrupted", interrupted: false });
  });

  it("keeps v2 decision consequences between the athlete request and Coach continuation", () => {
    const published: ChatSurfaceState[] = [];
    const adapter = createChatViewAdapter({ publish: (next) => published.push(next) });
    const decision = {
      decisionId: "decision-1",
      chatId: "desktop",
      messageId: "message-1",
      question: "Choose tomorrow’s priority.",
      status: "unanswered" as const,
      options: [
        {
          id: "recovery",
          label: "Prioritize recovery",
          description: "Choose an easy day.",
          recommended: true,
          consequence: "Tomorrow becomes a recovery day.",
        },
        {
          id: "tempo",
          label: "Keep tempo",
          description: "Keep the planned workout.",
          recommended: false,
          consequence: "Tomorrow keeps tempo.",
        },
      ],
    };
    const entries = [
      {
        kind: "decision-requested" as const,
        recordedAt: "2001-01-01T00:00:00.000Z",
        athleteText: "What should I do tomorrow?",
        decision,
      },
      {
        kind: "decision-answered" as const,
        recordedAt: "2001-01-01T00:01:00.000Z",
        decisionId: "decision-1",
        answer: { kind: "option" as const, optionId: "recovery" },
        consequence: "Tomorrow becomes a recovery day.",
        continuationId: "continuation-1",
      },
      {
        kind: "decision-continuation-completed" as const,
        recordedAt: "2001-01-01T00:02:00.000Z",
        completedAt: "2001-01-01T00:02:00.000Z",
        decisionId: "decision-1",
        continuationId: "continuation-1",
        turnId: "turn-1",
        coachText: "We’ll keep tomorrow easy.",
      },
    ];

    adapter.view.render(
      EMPTY_CHAT_STATE,
      controls({
        hydration: { status: "ready", hasEarlier: false, revision: 1, change: "initial", entries },
      }),
    );

    expect(published.at(-1)?.timeline.map((item) => item.kind)).toEqual([
      "message",
      "choice",
      "message",
    ]);
  });

  it("preserves an attachment-only athlete row once across retry attempts", () => {
    const attachments = [
      {
        attachmentId: "attachment-retry",
        displayName: "recovery-ride.fit",
        kind: "activity" as const,
        extension: "fit" as const,
      },
    ];
    const entries = [
      {
        kind: "turn" as const,
        turnId: "turn-retry",
        completedAt: "1998-08-24T08:05:00.000Z",
        athleteText: "",
        coachText: "Interrupted response.",
        delivery: "interrupted" as const,
        attachments,
      },
      {
        kind: "turn" as const,
        turnId: "turn-retry",
        completedAt: "1998-08-24T08:06:00.000Z",
        athleteText: "",
        coachText: "Recovered response.",
      },
    ];
    expect(mergeHydratedMessages([], [], entries)).toEqual([
      {
        id: "history:athlete:turn-retry",
        turnId: "turn-retry",
        role: "athlete",
        text: "",
        delivery: "complete",
        historical: true,
        attachments,
      },
      {
        id: "history:coach:turn-retry",
        turnId: "turn-retry",
        role: "coach",
        text: "Interrupted response.",
        delivery: "interrupted",
        historical: true,
      },
      {
        id: "history:coach:turn-retry:attempt:2",
        turnId: "turn-retry",
        role: "coach",
        text: "Recovered response.",
        delivery: "complete",
        historical: true,
      },
    ]);

    const published: ChatSurfaceState[] = [];
    const adapter = createChatViewAdapter({ publish: (next) => published.push(next) });
    adapter.view.render(
      EMPTY_CHAT_STATE,
      controls({
        hydration: {
          status: "ready",
          hasEarlier: false,
          revision: 1,
          change: "initial",
          entries,
        },
      }),
    );

    expect(published.at(-1)?.timeline).toEqual([
      {
        kind: "message",
        message: {
          id: "history:athlete:turn-retry",
          turnId: "turn-retry",
          role: "athlete",
          text: "",
          delivery: "complete",
          historical: true,
          attachments,
        },
      },
      {
        kind: "message",
        message: {
          id: "history:coach:turn-retry",
          turnId: "turn-retry",
          role: "coach",
          text: "Interrupted response.",
          delivery: "interrupted",
          historical: true,
        },
      },
      {
        kind: "message",
        message: {
          id: "history:coach:turn-retry:attempt:2",
          turnId: "turn-retry",
          role: "coach",
          text: "Recovered response.",
          delivery: "complete",
          historical: true,
        },
      },
    ]);
  });

  it("keeps a stopped decision continuation visibly pending during failed hydration", () => {
    const published: ChatSurfaceState[] = [];
    const adapter = createChatViewAdapter({ publish: (next) => published.push(next) });
    const decision = {
      decisionId: "decision-stopped",
      chatId: "desktop",
      messageId: "message-stopped",
      question: "Choose tomorrow’s priority.",
      status: "unanswered" as const,
      options: [
        {
          id: "recovery",
          label: "Prioritize recovery",
          description: "Choose an easy day.",
          recommended: true,
          consequence: "Tomorrow becomes a recovery day.",
        },
        {
          id: "tempo",
          label: "Keep tempo",
          description: "Keep the planned workout.",
          recommended: false,
          consequence: "Tomorrow keeps tempo.",
        },
      ],
    };

    adapter.view.render(
      EMPTY_CHAT_STATE,
      controls({
        hydration: {
          status: "ready",
          hasEarlier: false,
          revision: 1,
          change: "initial",
          entries: [
            {
              kind: "decision-requested",
              recordedAt: "1998-08-24T08:00:00.000Z",
              athleteText: "What should I do tomorrow?",
              decision,
            },
            {
              kind: "decision-answered",
              recordedAt: "1998-08-24T08:01:00.000Z",
              decisionId: decision.decisionId,
              answer: { kind: "option", optionId: "recovery" },
              consequence: "Tomorrow becomes a recovery day.",
              continuationId: "continuation-stopped",
            },
            {
              kind: "turn",
              turnId: "turn-stopped",
              completedAt: "1998-08-24T08:02:00.000Z",
              athleteText: "",
              coachText: "Keep tomorrow easy while",
              delivery: "interrupted",
            },
          ],
        },
        decisionLoadError: "Reconnect to restore the saved choice.",
      }),
    );

    expect(published.at(-1)?.timeline).toEqual([
      {
        kind: "message",
        message: {
          id: "history:decision-athlete:decision-stopped",
          role: "athlete",
          delivery: "complete",
          historical: true,
          text: "What should I do tomorrow?",
        },
      },
      {
        kind: "message",
        message: {
          id: "history:coach:turn-stopped",
          turnId: "turn-stopped",
          role: "coach",
          delivery: "interrupted",
          historical: true,
          text: "Keep tomorrow easy while",
        },
      },
    ]);
    expect(published.at(-1)).toMatchObject({ sendDisabled: true, inputDisabled: false });
  });

  it("places a saved choice immediately before its completed continuation", () => {
    const published: ChatSurfaceState[] = [];
    const adapter = createChatViewAdapter({ publish: (next) => published.push(next) });
    const decision = {
      decisionId: "decision-stopped",
      chatId: "desktop",
      messageId: "message-stopped",
      question: "Choose tomorrow’s priority.",
      status: "unanswered" as const,
      options: [
        {
          id: "recovery",
          label: "Prioritize recovery",
          description: "Choose an easy day.",
          recommended: true,
          consequence: "Tomorrow becomes a recovery day.",
        },
      ],
    };

    adapter.view.render(
      EMPTY_CHAT_STATE,
      controls({
        hydration: {
          status: "ready",
          hasEarlier: false,
          revision: 1,
          change: "initial",
          entries: [
            {
              kind: "decision-requested",
              recordedAt: "1998-08-24T08:00:00.000Z",
              athleteText: "What should I do tomorrow?",
              decision,
            },
            {
              kind: "decision-answered",
              recordedAt: "1998-08-24T08:01:00.000Z",
              decisionId: decision.decisionId,
              answer: { kind: "option", optionId: "recovery" },
              consequence: "Tomorrow becomes a recovery day.",
              continuationId: "continuation-stopped",
            },
            {
              kind: "turn",
              turnId: "turn-stopped",
              completedAt: "1998-08-24T08:02:00.000Z",
              athleteText: "",
              coachText: "Keep tomorrow easy while",
              delivery: "interrupted",
            },
            {
              kind: "decision-continuation-completed",
              recordedAt: "1998-08-24T08:03:00.000Z",
              completedAt: "1998-08-24T08:03:00.000Z",
              decisionId: decision.decisionId,
              continuationId: "continuation-stopped",
              turnId: "turn-resumed",
              coachText: "Keep tomorrow easy, then reassess.",
            },
          ],
        },
      }),
    );

    expect(
      published.at(-1)?.timeline.map((item) => {
        if (item.kind === "choice") return "choice";
        if (item.kind === "planning-request") return "planning-request";
        if (item.kind === "plan-creation") return "plan-creation";
        return item.message.role === "athlete" ? "athlete" : item.message.delivery;
      }),
    ).toEqual(["athlete", "interrupted", "choice", "complete"]);
  });

  it("suppresses generic interrupted recovery while a decision continuation is pending", () => {
    const published: ChatSurfaceState[] = [];
    const adapter = createChatViewAdapter({ publish: (next) => published.push(next) });
    let stopped = reduceChatState(EMPTY_CHAT_STATE, {
      type: "submit",
      requestKey: 1,
      userMessage: "",
      userMessageId: "unused-athlete",
      assistantMessageId: "decision-continuation",
      includeUser: false,
    });
    stopped = reduceChatState(stopped, {
      type: "event",
      requestKey: 1,
      event: {
        type: "interrupted",
        turnId: "turn-stopped",
        chatId: "desktop",
        text: "Keep tomorrow easy while",
      },
    });

    adapter.view.render(
      stopped,
      controls({
        decision: {
          value: {
            decisionId: "decision-stopped",
            chatId: "desktop",
            messageId: "message-stopped",
            question: "Choose tomorrow’s priority.",
            status: "answered",
            options: [],
            answer: { kind: "custom", text: "Protect recovery" },
            consequence: "Protect recovery.",
            continuation: {
              continuationId: "continuation-stopped",
              status: "pending",
            },
          },
          phase: "recovering",
          answerLabel: "Protect recovery",
          error: "Response stopped. Your partial response is preserved.",
        },
      }),
    );

    expect(published.at(-1)).toMatchObject({
      status: "interrupted",
      interrupted: false,
      notice: null,
      sendDisabled: true,
    });
  });

  it("deduplicates a live decision when its persisted entries hydrate later", () => {
    const published: ChatSurfaceState[] = [];
    const adapter = createChatViewAdapter({ publish: (next) => published.push(next) });
    const decision = {
      decisionId: "decision-1",
      chatId: "desktop",
      messageId: "message-1",
      question: "Choose tomorrow’s priority.",
      status: "unanswered" as const,
      options: [
        {
          id: "recovery",
          label: "Prioritize recovery",
          description: "Choose an easy day.",
          recommended: true,
          consequence: "Tomorrow becomes a recovery day.",
        },
        {
          id: "tempo",
          label: "Keep tempo",
          description: "Keep the planned workout.",
          recommended: false,
          consequence: "Tomorrow keeps tempo.",
        },
      ],
    };
    const completedDecision = {
      ...decision,
      status: "answered" as const,
      answer: { kind: "option" as const, optionId: "recovery" },
      consequence: "Tomorrow becomes a recovery day.",
      continuation: {
        continuationId: "continuation-1",
        status: "completed" as const,
        turnId: "turn-2",
        coachText: "We’ll keep tomorrow easy.",
      },
    };
    let live = submitted("What should I do tomorrow?");
    live = reduceChatState(live, {
      type: "bind-decision",
      requestKey: 1,
      decisionId: "decision-1",
    });
    live = reduceChatState(live, { type: "bind-turn", requestKey: 1, turnId: "turn-2" });
    live = reduceChatState(live, {
      type: "event",
      requestKey: 1,
      event: { type: "final-text", turnId: "turn-2", text: "We’ll keep tomorrow easy." },
    });
    live = reduceChatState(live, { type: "complete", requestKey: 1 });

    adapter.view.render(
      live,
      controls({
        hydration: {
          status: "ready",
          hasEarlier: false,
          revision: 2,
          change: "initial",
          entries: [
            {
              kind: "decision-requested",
              recordedAt: "2001-01-01T00:00:00.000Z",
              athleteText: "What should I do tomorrow?",
              decision,
            },
            {
              kind: "decision-answered",
              recordedAt: "2001-01-01T00:01:00.000Z",
              decisionId: "decision-1",
              answer: { kind: "option", optionId: "recovery" },
              consequence: "Tomorrow becomes a recovery day.",
              continuationId: "continuation-1",
            },
            {
              kind: "decision-continuation-completed",
              recordedAt: "2001-01-01T00:02:00.000Z",
              completedAt: "2001-01-01T00:02:00.000Z",
              decisionId: "decision-1",
              continuationId: "continuation-1",
              turnId: "turn-2",
              coachText: "We’ll keep tomorrow easy.",
            },
          ],
        },
        decision: {
          value: completedDecision,
          phase: "idle",
          answerLabel: "Prioritize recovery",
          error: null,
        },
      }),
    );

    expect(published.at(-1)?.timeline.map((item) => item.kind)).toEqual([
      "message",
      "choice",
      "message",
    ]);
  });

  it("derives the controls the port leaves optional", () => {
    const published: ChatSurfaceState[] = [];
    const adapter = createChatViewAdapter({ publish: (next) => published.push(next) });

    adapter.view.render(submitted());

    expect(published[0]).toMatchObject({
      workBlocked: false,
      newConversationUnavailable: true,
      sendDisabled: false,
      inputDisabled: false,
      hydrationStatus: "idle",
      hydrationHasEarlier: false,
      hydrationRevision: 0,
      hydrationChange: "none",
    });
  });

  it("fully blocks input while a session reset is being confirmed", () => {
    const published: ChatSurfaceState[] = [];
    const adapter = createChatViewAdapter({ publish: (next) => published.push(next) });

    adapter.view.render({
      ...EMPTY_CHAT_STATE,
      session: { ...EMPTY_CHAT_STATE.session, resetPhase: "confirming" },
    });

    expect(published[0]).toMatchObject({
      workBlocked: true,
      sendDisabled: true,
      inputDisabled: true,
    });
  });

  it("prefers the turn error copy over generic progress", () => {
    const published: ChatSurfaceState[] = [];
    const adapter = createChatViewAdapter({ publish: (next) => published.push(next) });
    const state = reduceChatState(submitted(), {
      type: "event",
      requestKey: 1,
      event: {
        type: "error",
        turnId: TURN_ID,
        chatId: "desktop",
        error_class: "unknown",
        kind: "provider-down",
        athleteMessage: "The coach is unreachable right now.",
        overflowAttempts: 0,
        timeoutAttempts: 0,
        rateLimitAttempts: 0,
        duration_ms: 12,
        compactions: 0,
      },
    });

    adapter.view.render(state, controls());

    expect(published.at(-1)?.notice).toBe("The coach is unreachable right now.");
  });

  it("carries hydrated history through the port and flags it for the reset copy", () => {
    const published: ChatSurfaceState[] = [];
    const adapter = createChatViewAdapter({ publish: (next) => published.push(next) });
    const live = submitted();

    adapter.view.render(
      {
        ...live,
        messages: mergeHydratedMessages(
          [
            {
              turnId: "persisted-1",
              completedAt: "2001-01-01T00:00:00.000Z",
              athleteText: "Persisted athlete",
              coachText: "Persisted coach",
            },
          ],
          live.messages,
        ),
      },
      controls(),
    );

    const surface = published.at(-1);
    expect(surface?.hasHydratedHistory).toBe(true);
    expect(surface?.messages.map((message) => [message.id, message.historical])).toEqual([
      ["history:athlete:persisted-1", true],
      ["history:coach:persisted-1", true],
      ["m1", false],
    ]);
  });

  it("projects persisted attachment references on a relaunched historical message", () => {
    const published: ChatSurfaceState[] = [];
    const adapter = createChatViewAdapter({ publish: (next) => published.push(next) });
    const attachments = [
      {
        attachmentId: "attachment-1",
        displayName: "training-notes.txt",
        kind: "document" as const,
        extension: "txt" as const,
      },
    ];

    adapter.view.render(
      EMPTY_CHAT_STATE,
      controls({
        hydration: {
          status: "ready",
          hasEarlier: false,
          revision: 1,
          change: "initial",
          entries: [
            {
              kind: "turn",
              turnId: "persisted-attachment",
              completedAt: "2001-01-01T00:00:00.000Z",
              athleteText: "Review this file",
              coachText: "Reviewed",
              attachments,
            },
          ],
        },
      }),
    );

    expect(published.at(-1)?.timeline[0]).toMatchObject({
      kind: "message",
      message: { role: "athlete", historical: true, attachments },
    });
  });

  it("projects one historical athlete row and every Coach retry attempt", () => {
    const published: ChatSurfaceState[] = [];
    const adapter = createChatViewAdapter({ publish: (next) => published.push(next) });
    const interrupted = {
      kind: "turn" as const,
      turnId: "persisted-retry",
      completedAt: "2001-01-01T00:00:00.000Z",
      athleteText: "First",
      coachText: "Partial",
      delivery: "interrupted" as const,
    };

    adapter.view.render(
      EMPTY_CHAT_STATE,
      controls({
        hydration: {
          status: "ready",
          hasEarlier: false,
          revision: 1,
          change: "initial",
          entries: [
            interrupted,
            {
              kind: "turn",
              turnId: "persisted-retry",
              completedAt: "2001-01-01T00:01:00.000Z",
              athleteText: "First",
              coachText: "Recovered",
            },
          ],
        },
      }),
    );

    expect(
      published.at(-1)?.timeline.map((item) =>
        item.kind === "message"
          ? {
              id: item.message.id,
              role: item.message.role,
              text: item.message.text,
              delivery: item.message.delivery,
            }
          : { kind: item.kind },
      ),
    ).toEqual([
      {
        id: "history:athlete:persisted-retry",
        role: "athlete",
        text: "First",
        delivery: "complete",
      },
      {
        id: "history:coach:persisted-retry",
        role: "coach",
        text: "Partial",
        delivery: "interrupted",
      },
      {
        id: "history:coach:persisted-retry:attempt:2",
        role: "coach",
        text: "Recovered",
        delivery: "complete",
      },
    ]);
  });

  it("keeps sending available while a turn streams and exposes the queue for the strip", () => {
    const published: ChatSurfaceState[] = [];
    const adapter = createChatViewAdapter({ publish: (next) => published.push(next) });
    let state = submitted("Plan my week");
    state = reduceChatState(state, { type: "enqueue", id: "queued-1", text: "And my long ride?" });
    state = reduceChatState(state, { type: "enqueue", id: "queued-2", text: "/status" });

    adapter.view.render(state, controls());

    expect(published.at(-1)).toMatchObject({
      status: "streaming",
      sendDisabled: false,
      inputDisabled: false,
      queued: [
        { id: "queued-1", text: "And my long ride?", command: false },
        { id: "queued-2", text: "/status", command: true },
      ],
    });
  });

  it("republishes only when the queue itself changes", () => {
    const published: ChatSurfaceState[] = [];
    const adapter = createChatViewAdapter({ publish: (next) => published.push(next) });
    const streaming = submitted("Plan my week");
    const withQueue = reduceChatState(streaming, {
      type: "enqueue",
      id: "queued-1",
      text: "And my long ride?",
    });

    adapter.view.render(withQueue, controls());
    adapter.view.render(
      { ...withQueue, queued: [{ id: "queued-1", text: "And my long ride?", command: false }] },
      controls(),
    );
    expect(published).toHaveLength(1);

    adapter.view.render(reduceChatState(withQueue, { type: "dequeue-group" }), controls());
    expect(published).toHaveLength(2);
    expect(published.at(-1)?.queued).toEqual([]);
  });

  it("rejects a transcript that repeats a message id", () => {
    const adapter = createChatViewAdapter({ publish: () => {} });
    const message = {
      id: "m1",
      role: "athlete",
      text: "one",
      delivery: "complete",
    } as const;

    expect(() =>
      adapter.view.render({ ...EMPTY_CHAT_STATE, messages: [message, message] }),
    ).toThrow(TypeError);
  });
});

describe("chat scroll anchor", () => {
  function host(scrollHeight: number, clientHeight: number, scrollTop: number): HTMLElement {
    const element = document.createElement("div");
    let height = scrollHeight;
    let viewportHeight = clientHeight;
    Object.defineProperty(element, "scrollHeight", { get: () => height, configurable: true });
    Object.defineProperty(element, "clientHeight", {
      get: () => viewportHeight,
      configurable: true,
    });
    element.scrollTop = scrollTop;
    Object.defineProperty(element, "grow", {
      value: (next: number) => {
        height = next;
      },
    });
    Object.defineProperty(element, "resize", {
      value: (next: number) => {
        viewportHeight = next;
      },
    });
    return element;
  }

  function grow(element: HTMLElement, next: number): void {
    (element as HTMLElement & { grow: (value: number) => void }).grow(next);
  }

  function resize(element: HTMLElement, next: number): void {
    (element as HTMLElement & { resize: (value: number) => void }).resize(next);
  }

  it("follows the newest message when the athlete is already at the bottom", () => {
    const anchor = createChatScrollAnchor();
    const element = host(1000, 400, 600);
    anchor.attach(element);

    anchor.capture();
    grow(element, 1200);
    anchor.apply({ hydrationChanged: false, hydrationChange: "none" });

    expect(element.scrollTop).toBe(1200);
  });

  it("leaves the viewport alone when the athlete has scrolled up", () => {
    const anchor = createChatScrollAnchor();
    const element = host(1000, 400, 100);
    anchor.attach(element);

    anchor.capture();
    grow(element, 1200);
    anchor.apply({ hydrationChanged: false, hydrationChange: "none" });

    expect(element.scrollTop).toBe(100);
  });

  it("preserves the reading position while a connected host is hidden", () => {
    const anchor = createChatScrollAnchor();
    const element = host(1200, 400, 500);
    document.body.append(element);
    anchor.attach(element);
    anchor.reanchor();
    element.scrollTop = 500;

    grow(element, 0);
    resize(element, 0);
    anchor.capture();
    anchor.apply({ hydrationChanged: false, hydrationChange: "none" });

    expect(element.scrollTop).toBe(500);

    grow(element, 1400);
    resize(element, 400);
    anchor.reanchor();

    expect(element.scrollTop).toBe(500);
    element.remove();
  });

  it("jumps to the newest message on the initial hydration", () => {
    const anchor = createChatScrollAnchor();
    const element = host(1000, 400, 0);
    anchor.attach(element);

    anchor.capture();
    grow(element, 2000);
    anchor.apply({ hydrationChanged: true, hydrationChange: "initial" });

    expect(element.scrollTop).toBe(2000);
  });

  it("reanchors a hidden initial hydration after the host becomes visible", () => {
    const anchor = createChatScrollAnchor();
    const element = host(400, 400, 0);
    document.body.append(element);
    anchor.attach(element);
    anchor.reanchor();

    grow(element, 0);
    resize(element, 0);
    element.scrollTop = 0;

    anchor.capture();
    anchor.apply({ hydrationChanged: true, hydrationChange: "initial" });
    grow(element, 2000);
    resize(element, 400);
    anchor.reanchor();

    expect(element.scrollTop).toBe(2000);

    element.scrollTop = 600;
    anchor.reanchor();

    expect(element.scrollTop).toBe(600);
    element.remove();
  });

  it("does not reanchor a visible initial hydration", () => {
    const anchor = createChatScrollAnchor();
    const element = host(1000, 400, 0);
    anchor.attach(element);

    anchor.capture();
    anchor.apply({ hydrationChanged: true, hydrationChange: "initial" });
    element.scrollTop = 300;
    grow(element, 2000);
    anchor.reanchor();

    expect(element.scrollTop).toBe(300);
  });

  it("holds the anchor row in place when the layout above it shifts", () => {
    const anchor = createChatScrollAnchor();
    const element = host(1000, 400, 100);
    document.body.append(element);
    const row = document.createElement("article");
    row.className = "chat-message";
    element.append(row);
    let rowTop = 300;
    row.getBoundingClientRect = () =>
      ({ top: rowTop, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0 }) as DOMRect;
    anchor.attach(element);

    anchor.capture();
    rowTop = 520;
    grow(element, 1400);
    anchor.apply({ hydrationChanged: true, hydrationChange: "prepend" });

    expect(element.scrollTop).toBe(320);
    element.remove();
  });

  it("preserves the reading position when earlier messages are prepended", () => {
    const anchor = createChatScrollAnchor();
    const element = host(1000, 400, 120);
    anchor.attach(element);

    anchor.capture();
    grow(element, 1700);
    anchor.apply({ hydrationChanged: true, hydrationChange: "prepend" });

    expect(element.scrollTop).toBe(820);
  });
});

const renders = { transcript: 0 };

function Probe(): null {
  useEnduragentStore((state) => state.chat.messages);
  renders.transcript += 1;
  return null;
}

function Harness(): ReactElement {
  return (
    <>
      <ChatSurface />
      <Probe />
    </>
  );
}

function coachText(): string {
  return document.querySelector(".chat-message--coach .chat-message__text")?.textContent ?? "";
}

describe("streaming fast path", () => {
  beforeEach(() => {
    renders.transcript = 0;
    useEnduragentStore.setState({
      activeView: "chat",
      chat: EMPTY_CHAT_SURFACE,
      firstSync: { status: "idle" },
      chatActions: null,
      onboarding: READY_ONBOARDING,
    });
  });

  afterEach(() => {
    useEnduragentStore.setState({ chat: EMPTY_CHAT_SURFACE });
    resetChatStream();
  });

  it("appends deltas into the transcript without re-rendering the message list", () => {
    const adapter = createChatViewAdapter({
      publish: (next) => useEnduragentStore.getState().setChatSurface(next),
    });
    const send = (state: ChatState, next?: ChatViewControls): void => {
      act(() => {
        adapter.view.render(state, next);
      });
    };

    render(<Harness />);
    const mounted = renders.transcript;

    let state = submitted("Plan my week");
    send(state, controls());
    expect(renders.transcript).toBe(mounted + 1);
    expect(document.querySelectorAll(".chat-message")).toHaveLength(1);

    const first = delta(state, "Ride ");
    state = first.state;
    send(state, first.controls);
    const afterFirstDelta = renders.transcript;
    expect(afterFirstDelta).toBe(mounted + 2);
    expect(document.querySelectorAll(".chat-message")).toHaveLength(2);
    const textNode = document.querySelector(".chat-message--coach .chat-message__text");

    for (const chunk of ["steady ", "on ", "Tuesday."]) {
      const step = delta(state, chunk);
      state = step.state;
      send(state, step.controls);
    }

    expect(renders.transcript).toBe(afterFirstDelta);
    expect(coachText()).toBe("Ride steady on Tuesday.");
    expect(document.querySelector(".chat-message--coach .chat-message__text")).toBe(textNode);
    expect(document.querySelectorAll(".chat-message")).toHaveLength(2);

    state = reduceChatState(state, {
      type: "event",
      requestKey: 1,
      event: { type: "final-text", turnId: TURN_ID, text: "Ride **steady** on Tuesday." },
    });
    send(state, controls());
    expect(renders.transcript).toBe(afterFirstDelta);
    expect(coachText()).toBe("Ride **steady** on Tuesday.");

    state = reduceChatState(state, { type: "complete", requestKey: 1 });
    send(state, controls({ newConversationDisabled: false }));
    expect(renders.transcript).toBe(afterFirstDelta + 1);
    expect(document.querySelector(".chat-message--coach strong")?.textContent).toBe("steady");
    expect(document.querySelector(".chat-message--coach")?.hasAttribute("aria-busy")).toBe(false);
  });

  it("keeps the coach row and its streaming target across the whole turn", () => {
    const adapter = createChatViewAdapter({
      publish: (next) => useEnduragentStore.getState().setChatSurface(next),
    });
    const send = (state: ChatState, next?: ChatViewControls): void => {
      act(() => {
        adapter.view.render(state, next);
      });
    };

    render(<Harness />);
    let state = submitted("Plan my week");
    send(state, controls());
    const first = delta(state, "Easy spin.");
    state = first.state;
    send(state, first.controls);

    const row = document.querySelector(".chat-message--coach");
    expect(row?.getAttribute("aria-busy")).toBe("true");

    state = reduceChatState(state, {
      type: "event",
      requestKey: 1,
      event: { type: "final-text", turnId: TURN_ID, text: "Easy spin." },
    });
    send(state, controls());
    state = reduceChatState(state, { type: "complete", requestKey: 1 });
    send(state, controls({ newConversationDisabled: false }));

    expect(document.querySelector(".chat-message--coach")).toBe(row);
    expect(coachText()).toBe("Easy spin.");
  });
});

describe("follow-latest anchoring", () => {
  const ROW_HEIGHT = 400;
  const VIEWPORT = 200;

  function conversation(): HTMLElement {
    const element = document.querySelector('main[aria-label="Coaching conversation"]');
    if (!(element instanceof HTMLElement)) throw new TypeError("conversation missing");
    let scrollTop = 0;
    Object.defineProperty(element, "clientHeight", { configurable: true, get: () => VIEWPORT });
    Object.defineProperty(element, "scrollHeight", {
      configurable: true,
      get: () => VIEWPORT + element.querySelectorAll(".chat-message").length * ROW_HEIGHT,
    });
    Object.defineProperty(element, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (next: number) => {
        scrollTop = next;
      },
    });
    return element;
  }

  function changedKeys(left: ChatSurfaceState, right: ChatSurfaceState): string[] {
    return Object.keys(right).filter(
      (key) => left[key as keyof ChatSurfaceState] !== right[key as keyof ChatSurfaceState],
    );
  }

  beforeEach(() => {
    useEnduragentStore.setState({
      activeView: "chat",
      chat: EMPTY_CHAT_SURFACE,
      firstSync: { status: "idle" },
      chatActions: null,
    });
  });

  afterEach(() => {
    useEnduragentStore.setState({ chat: EMPTY_CHAT_SURFACE });
    resetChatStream();
  });

  it("scrolls to the newest row on a publish that only changes the transcript", () => {
    const published: ChatSurfaceState[] = [];
    const adapter = createChatViewAdapter({
      publish: (next) => {
        published.push(next);
        useEnduragentStore.getState().setChatSurface(next);
      },
    });
    const send = (state: ChatState, next?: ChatViewControls): void => {
      act(() => {
        adapter.view.render(state, next);
      });
    };

    render(<ChatSurface />);
    const host = conversation();

    let state = submitted("Plan my week");
    send(state, controls());
    expect(document.querySelectorAll(".chat-message")).toHaveLength(1);
    expect(host.scrollTop).toBe(VIEWPORT + ROW_HEIGHT);

    const first = delta(state, "Ride ");
    state = first.state;
    send(state, first.controls);

    expect(published).toHaveLength(2);
    expect(changedKeys(published[0], published[1])).toEqual([
      "messages",
      "timeline",
      "coachProgress",
    ]);
    expect(published[1].status).toBe("streaming");
    expect(document.querySelectorAll(".chat-message")).toHaveLength(2);
    expect(host.scrollTop).toBe(VIEWPORT + 2 * ROW_HEIGHT);
  });

  it("jumps to the newest message when history hydrates under a scrolled-up transcript", () => {
    const adapter = createChatViewAdapter({
      publish: (next) => useEnduragentStore.getState().setChatSurface(next),
    });
    const send = (state: ChatState, next?: ChatViewControls): void => {
      act(() => {
        adapter.view.render(state, next);
      });
    };

    render(<ChatSurface />);
    const host = conversation();
    const live = submitted("Plan my week");
    send(live, controls());

    host.scrollTop = 0;
    send(
      {
        ...live,
        messages: mergeHydratedMessages(
          [
            {
              turnId: "persisted-1",
              completedAt: "2001-01-01T00:00:00.000Z",
              athleteText: "Persisted athlete",
              coachText: "Persisted coach",
            },
          ],
          live.messages,
        ),
      },
      controls({
        hydration: { status: "ready", hasEarlier: false, revision: 2, change: "initial" },
      }),
    );

    expect(document.querySelectorAll(".chat-message")).toHaveLength(3);
    expect(host.scrollTop).toBe(VIEWPORT + 3 * ROW_HEIGHT);
  });
});
