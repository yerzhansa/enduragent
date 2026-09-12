import { describe, expect, it } from "vitest";
import {
  CHAT_RESPONSE_STOPPED_COPY,
  CHAT_WORKING_COPY,
  DESKTOP_CHAT_ID,
  EMPTY_CHAT_STATE,
  hasClearableConversation,
  nextDrainGroup,
  reduceChatState,
  type ChatState,
} from "../src/turn-state";

function started(requestKey = 1): ChatState {
  return reduceChatState(EMPTY_CHAT_STATE, {
    type: "submit",
    requestKey,
    userMessage: "How should I train?",
    userMessageId: "message-1",
    assistantMessageId: "message-2",
    includeUser: true,
  });
}

function queued(state: ChatState, ...texts: readonly string[]): ChatState {
  return texts.reduce(
    (next, text, index) =>
      reduceChatState(next, { type: "enqueue", id: `queued-${index + 1}`, text }),
    state,
  );
}

describe("desktop turn state", () => {
  it("keeps an active durable claim hidden across newer queue snapshots", () => {
    const item = (id: string, position: number) => ({
      queuedMessageId: id,
      messageId: `message-${id}`,
      submissionId: `submission-${id}`,
      text: id,
      kind: "ordinary" as const,
      attachmentIds: [],
      position,
      restored: false,
    });
    let state = reduceChatState(EMPTY_CHAT_STATE, {
      type: "queue-snapshot",
      snapshot: { schemaVersion: 1, revision: 1, items: [item("head", 0)] },
    });
    state = reduceChatState(state, { type: "queue-claimed", ids: ["head"] });
    state = reduceChatState(state, {
      type: "queue-snapshot",
      snapshot: { schemaVersion: 1, revision: 2, items: [item("head", 0), item("later", 1)] },
    });
    expect(state.queued.map(({ id }) => id)).toEqual(["later"]);
    expect(state.activeQueueClaimIds).toEqual(["head"]);

    state = reduceChatState(state, {
      type: "queue-snapshot",
      snapshot: {
        schemaVersion: 1,
        revision: 3,
        items: [item("head", 0), item("later", 1)],
        retryRequired: {
          claimId: "claim-1",
          queuedMessageIds: ["head"],
          turnId: "turn-1",
          status: "retry-required",
        },
      },
    });
    expect(state.queued.map(({ id }) => id)).toEqual(["head", "later"]);
    expect(state.activeQueueClaimIds).toEqual([]);
  });

  it("ignores an equal queue revision after successful reset", () => {
    const snapshot = {
      schemaVersion: 1 as const,
      revision: 2,
      items: [
        {
          queuedMessageId: "queued-1",
          messageId: "message-1",
          submissionId: "submission-1",
          text: "Later",
          kind: "ordinary" as const,
          attachmentIds: [],
          position: 0,
          restored: false,
        },
      ],
    };
    const queuedState = reduceChatState(EMPTY_CHAT_STATE, { type: "queue-snapshot", snapshot });
    const resetting = {
      ...queuedState,
      session: {
        ...queuedState.session,
        presence: "present" as const,
        resetPhase: "resetting" as const,
      },
    };
    const reset = reduceChatState(resetting, {
      type: "reset-succeeded",
      announcement: "Done",
    });
    expect(reduceChatState(reset, { type: "queue-snapshot", snapshot }).queued).toEqual([]);
  });
  it("owns the one desktop conversation identity", () => {
    expect(DESKTOP_CHAT_ID).toBe("desktop");
  });

  it("starts with one generic working state and clears it on the first substantive text", () => {
    let state = started();
    expect(state.progress).toBe(CHAT_WORKING_COPY);
    expect(state.messages).toMatchObject([
      { id: "message-1", role: "athlete", text: "How should I train?" },
      { id: "message-2", role: "coach", text: "", delivery: "streaming" },
    ]);

    state = reduceChatState(state, {
      type: "event",
      requestKey: 1,
      event: { type: "text_delta", turnId: "turn-1", delta: " \n" },
    });
    expect(state.progress).toBe(CHAT_WORKING_COPY);
    expect(state.activeTurn?.draft).toBe(" \n");
    expect(state.messages.at(-1)?.text).toBe("");

    state = reduceChatState(state, {
      type: "event",
      requestKey: 1,
      event: { type: "text_delta", turnId: "turn-1", delta: "Ride easy." },
    });
    expect(state.progress).toBeNull();
    expect(state.messages.at(-1)?.text).toBe(" \nRide easy.");
  });

  it("clears generic progress on final text but keeps replacement tool progress", () => {
    const finalOnly = reduceChatState(started(), {
      type: "event",
      requestKey: 1,
      event: { type: "final-text", turnId: "turn-1", text: "Ride easy." },
    });
    expect(finalOnly.progress).toBeNull();

    let state = started();
    state = reduceChatState(state, {
      type: "event",
      requestKey: 1,
      event: { type: "tool-start", turnId: "turn-1", toolName: "training_data" },
    });
    expect(state.progress).toBe("Checking your training data…");

    state = reduceChatState(state, {
      type: "event",
      requestKey: 1,
      event: { type: "final-text", turnId: "turn-1", text: "Ride easy." },
    });
    expect(state.progress).toBe("Checking your training data…");
  });

  it("binds a typed Plan reference to the active coach message", () => {
    const state = reduceChatState(started(), {
      type: "event",
      requestKey: 1,
      event: {
        type: "plan-reference",
        turnId: "turn-1",
        selection: { kind: "current_week", planId: "plan-1", weekNumber: 1 },
      },
    });
    expect(state.messages.at(-1)?.planReference).toEqual({
      kind: "current_week",
      planId: "plan-1",
      weekNumber: 1,
    });
  });

  it.each(["", " \n\t"])(
    "does not complete or expose a whitespace-only final text %j",
    (finalText) => {
      const absent = reduceChatState(EMPTY_CHAT_STATE, {
        type: "session-probe",
        hasSession: false,
      });
      let state = reduceChatState(absent, {
        type: "submit",
        requestKey: 1,
        userMessage: "How should I train?",
        userMessageId: "message-1",
        assistantMessageId: "message-2",
        includeUser: true,
      });
      state = reduceChatState(state, {
        type: "event",
        requestKey: 1,
        event: { type: "final-text", turnId: "turn-1", text: finalText },
      });

      expect(state.activeTurn?.finalText).toBe(finalText);
      expect(state.messages.at(-1)?.text).toBe("");
      expect(reduceChatState(state, { type: "complete", requestKey: 1 })).toBe(state);
      expect(state.session.presence).toBe("absent");
    },
  );

  it("streams ordered deltas and replaces them with canonical final text", () => {
    let state = started();
    state = reduceChatState(state, {
      type: "event",
      requestKey: 1,
      event: { type: "text_delta", turnId: "turn-1", delta: "Hel" },
    });
    state = reduceChatState(state, {
      type: "event",
      requestKey: 1,
      event: { type: "text_delta", turnId: "turn-1", delta: "lo" },
    });
    state = reduceChatState(state, {
      type: "event",
      requestKey: 1,
      event: { type: "final-text", turnId: "turn-1", text: "Hello." },
    });
    state = reduceChatState(state, { type: "complete", requestKey: 1 });
    expect(state.messages.at(-1)).toMatchObject({ text: "Hello.", delivery: "complete" });
    expect(state.session.presence).toBe("present");
  });

  it("accepts optional start and retains safe contract error fields", () => {
    let state = started();
    state = reduceChatState(state, {
      type: "event",
      requestKey: 1,
      event: { type: "turn-start", turnId: "turn-1", chatId: "desktop" },
    });
    state = reduceChatState(state, {
      type: "event",
      requestKey: 1,
      event: {
        type: "error",
        turnId: "turn-1",
        chatId: "desktop",
        error_class: "unknown",
        kind: "provider-down",
        athleteMessage: "Please try later.",
        overflowAttempts: 0,
        timeoutAttempts: 0,
        rateLimitAttempts: 0,
        duration_ms: 1,
        compactions: 0,
      },
    });
    expect(state.activeTurn?.error).toEqual({
      kind: "provider-down",
      athleteMessage: "Please try later.",
    });
  });

  it("binds both live row identities to the durable turn without changing row keys", () => {
    const state = started();

    const bound = reduceChatState(state, {
      type: "bind-turn",
      requestKey: 1,
      turnId: "turn-1",
    });

    expect(bound.messages).toMatchObject([
      { id: "message-1", turnId: "turn-1", role: "athlete" },
      { id: "message-2", turnId: "turn-1", role: "coach" },
    ]);
    expect(bound.activeTurn?.turnId).toBe("turn-1");
  });

  it("clears a contract error only for a matching interrupted retry", () => {
    let state = reduceChatState(started(), {
      type: "event",
      requestKey: 1,
      event: {
        type: "error",
        turnId: "turn-1",
        chatId: "desktop",
        error_class: "unknown",
        kind: "provider-down",
        athleteMessage: "Please try later.",
        overflowAttempts: 0,
        timeoutAttempts: 0,
        rateLimitAttempts: 0,
        duration_ms: 1,
        compactions: 0,
      },
    });
    expect(reduceChatState(state, { type: "retry-pending", requestKey: 1 })).toBe(state);

    state = reduceChatState(state, {
      type: "interrupt",
      requestKey: 1,
      copy: "Connection interrupted. Your partial response is preserved.",
    });
    expect(state.activeTurn?.error?.athleteMessage).toBe("Please try later.");
    expect(reduceChatState(state, { type: "retry-pending", requestKey: 2 })).toBe(state);

    const retrying = reduceChatState(state, { type: "retry-pending", requestKey: 1 });
    expect(retrying.progress).toBe(CHAT_WORKING_COPY);
    expect(retrying.activeTurn?.error).toBeNull();
  });

  it("ignores stale local request keys and preserves interrupted drafts", () => {
    let state = started(4);
    state = reduceChatState(state, {
      type: "event",
      requestKey: 4,
      event: { type: "text_delta", turnId: "turn-4", delta: "Partial" },
    });
    const stale = reduceChatState(state, {
      type: "event",
      requestKey: 3,
      event: { type: "text_delta", turnId: "turn-3", delta: " hidden" },
    });
    expect(stale).toBe(state);
    const interrupted = reduceChatState(state, {
      type: "interrupt",
      requestKey: 4,
      copy: "Connection interrupted. Your partial response is preserved.",
    });
    expect(interrupted.messages.at(-1)).toMatchObject({
      text: "Partial",
      delivery: "interrupted",
    });
  });

  it("marks a scoped Stop as interrupted with the canonical partial text", () => {
    const state = reduceChatState(started(), {
      type: "event",
      requestKey: 1,
      event: {
        type: "interrupted",
        turnId: "turn-1",
        chatId: DESKTOP_CHAT_ID,
        text: "Canonical partial",
      },
    });

    expect(state).toMatchObject({
      status: "interrupted",
      progress: CHAT_RESPONSE_STOPPED_COPY,
    });
    expect(state.messages.at(-1)).toMatchObject({
      text: "Canonical partial",
      delivery: "interrupted",
    });
  });

  it("records probe presence without letting a stale absence erase proven server presence", () => {
    const present = reduceChatState(EMPTY_CHAT_STATE, {
      type: "session-probe",
      hasSession: true,
    });
    expect(present.session.presence).toBe("present");

    const absent = reduceChatState(EMPTY_CHAT_STATE, {
      type: "session-probe",
      hasSession: false,
    });
    expect(absent.session.presence).toBe("absent");

    let completed = started();
    completed = reduceChatState(completed, {
      type: "event",
      requestKey: 1,
      event: { type: "final-text", turnId: "turn-1", text: "Done" },
    });
    completed = reduceChatState(completed, { type: "complete", requestKey: 1 });
    const fenced = reduceChatState(completed, { type: "session-probe", hasSession: false });
    expect(fenced).toBe(completed);
    expect(fenced.session.presence).toBe("present");
  });

  it("keeps server absence separate from visible local content that can be cleared", () => {
    const absent = reduceChatState(EMPTY_CHAT_STATE, {
      type: "session-probe",
      hasSession: false,
    });
    const placeholder: ChatState = {
      ...absent,
      messages: [
        {
          id: "message-1",
          role: "coach",
          text: "",
          delivery: "interrupted",
        },
      ],
    };

    expect(hasClearableConversation(placeholder)).toBe(false);
    expect(reduceChatState(placeholder, { type: "open-new-conversation" })).toBe(placeholder);

    let visible = reduceChatState(absent, {
      type: "submit",
      requestKey: 1,
      userMessage: "Keep this visible",
      userMessageId: "message-2",
      assistantMessageId: "message-3",
      includeUser: true,
    });
    visible = reduceChatState(visible, { type: "fail", requestKey: 1, copy: "Failed" });

    expect(visible.session.presence).toBe("absent");
    expect(hasClearableConversation(visible)).toBe(true);
    const confirming = reduceChatState(visible, { type: "open-new-conversation" });
    expect(confirming.session).toMatchObject({
      presence: "absent",
      resetPhase: "confirming",
    });
  });

  it("promotes presence only for an exact successful completion", () => {
    const absent = reduceChatState(EMPTY_CHAT_STATE, {
      type: "session-probe",
      hasSession: false,
    });
    let state = reduceChatState(absent, {
      type: "submit",
      requestKey: 4,
      userMessage: "How should I train?",
      userMessageId: "message-1",
      assistantMessageId: "message-2",
      includeUser: true,
    });

    expect(reduceChatState(state, { type: "complete", requestKey: 4 })).toBe(state);
    state = reduceChatState(state, {
      type: "event",
      requestKey: 4,
      event: { type: "final-text", turnId: "turn-4", text: "Train easy." },
    });
    expect(reduceChatState(state, { type: "complete", requestKey: 3 })).toBe(state);
    expect(state.session.presence).toBe("absent");

    const completed = reduceChatState(state, { type: "complete", requestKey: 4 });
    expect(completed.session.presence).toBe("present");
  });

  it("opens and cancels confirmation without changing conversation content", () => {
    const local = reduceChatState(started(), {
      type: "interrupt",
      requestKey: 1,
      copy: "Interrupted",
    });
    const confirming = reduceChatState(local, { type: "open-new-conversation" });
    expect(confirming.session.resetPhase).toBe("confirming");
    expect(confirming.messages).toBe(local.messages);
    expect(confirming.activeTurn).toBe(local.activeTurn);

    const cancelled = reduceChatState(confirming, { type: "cancel-new-conversation" });
    expect(cancelled.session.resetPhase).toBe("idle");
    expect(cancelled.messages).toBe(local.messages);
    expect(cancelled.activeTurn).toBe(local.activeTurn);
  });

  it.each([
    "New conversation started.",
    "New conversation started. Some recent details may not have been saved to coach memory.",
  ])("clears the turn after a successful reset announced as %s", (announcement) => {
    let state = started();
    state = reduceChatState(state, {
      type: "event",
      requestKey: 1,
      event: { type: "text_delta", turnId: "turn-1", delta: "Partial" },
    });
    state = reduceChatState(state, {
      type: "interrupt",
      requestKey: 1,
      copy: "Interrupted",
    });
    state = reduceChatState(state, { type: "open-new-conversation" });
    state = reduceChatState(state, { type: "begin-reset" });
    state = reduceChatState(state, { type: "reset-succeeded", announcement });

    expect(state).toEqual({
      status: "idle",
      messages: [],
      activeTurn: null,
      progress: null,
      queued: [],
      session: {
        presence: "absent",
        resetPhase: "idle",
        resetCount: 1,
        announcement,
      },
    });
  });

  it("preserves the exact turn on an uncertain reset failure", () => {
    const local = reduceChatState(started(), {
      type: "interrupt",
      requestKey: 1,
      copy: "Interrupted",
    });
    let resetting = reduceChatState(local, { type: "open-new-conversation" });
    resetting = reduceChatState(resetting, { type: "begin-reset" });
    const failed = reduceChatState(resetting, {
      type: "reset-failed",
      announcement: "Uncertain",
    });

    expect(failed.status).toBe(local.status);
    expect(failed.messages).toBe(local.messages);
    expect(failed.activeTurn).toBe(local.activeTurn);
    expect(failed.progress).toBe(local.progress);
    expect(failed.session).toMatchObject({
      presence: "unknown",
      resetPhase: "uncertain",
      announcement: "Uncertain",
    });
  });

  it("clears a reset announcement only when the next submit is accepted", () => {
    const announced = {
      ...EMPTY_CHAT_STATE,
      session: {
        presence: "absent" as const,
        resetPhase: "idle" as const,
        resetCount: 3,
        announcement: "New conversation started.",
      },
    };
    const submitted = reduceChatState(announced, {
      type: "submit",
      requestKey: 4,
      userMessage: "What should I ride today?",
      userMessageId: "message-4",
      assistantMessageId: "message-5",
      includeUser: true,
    });

    expect(submitted.session).toEqual({
      presence: "absent",
      resetPhase: "idle",
      resetCount: 3,
      announcement: null,
    });

    const rejected = reduceChatState(
      {
        ...submitted,
        session: { ...submitted.session, announcement: "Keep this announcement." },
      },
      {
        type: "submit",
        requestKey: 5,
        userMessage: "Do not accept this yet.",
        userMessageId: "message-6",
        assistantMessageId: "message-7",
        includeUser: true,
      },
    );
    expect(rejected.session.announcement).toBe("Keep this announcement.");
  });

  it("sets a host announcement without starting a turn", () => {
    const announced = reduceChatState(EMPTY_CHAT_STATE, {
      type: "announce",
      announcement: "Thanks — we received your note.",
    });
    expect(announced.status).toBe("idle");
    expect(announced.messages).toEqual([]);
    expect(announced.session.announcement).toBe("Thanks — we received your note.");
    expect(reduceChatState(announced, { type: "announce", announcement: "Thanks — we received your note." })).toBe(
      announced,
    );
  });

  it("ignores old turn events after reset success", () => {
    let state = started(7);
    state = reduceChatState(state, {
      type: "interrupt",
      requestKey: 7,
      copy: "Interrupted",
    });
    state = reduceChatState(state, { type: "open-new-conversation" });
    state = reduceChatState(state, { type: "begin-reset" });
    state = reduceChatState(state, {
      type: "reset-succeeded",
      announcement: "New conversation started.",
    });
    const stale = reduceChatState(state, {
      type: "event",
      requestKey: 7,
      event: { type: "text_delta", turnId: "turn-7", delta: "stale" },
    });

    expect(stale).toBe(state);
    expect(stale.messages).toEqual([]);
  });
});

describe("desktop message queue", () => {
  it("queues a message typed while the turn streams without touching the transcript", () => {
    const streaming = started();
    const state = queued(streaming, "And my long ride?");

    expect(state.status).toBe("streaming");
    expect(state.messages).toBe(streaming.messages);
    expect(state.activeTurn).toBe(streaming.activeTurn);
    expect(state.progress).toBe(streaming.progress);
    expect(state.queued).toEqual([{ id: "queued-1", text: "And my long ride?", command: false }]);
  });

  it("marks a known slash command and leaves unknown slashes as free text", () => {
    const state = queued(started(), "/plan", "  /WORKOUT tomorrow ", "/synthetic-unknown");

    expect(state.queued.map((message) => message.command)).toEqual([true, true, false]);
  });

  it("refuses a blank enqueue and a repeated identifier", () => {
    const state = queued(started(), "Keep this");

    expect(reduceChatState(state, { type: "enqueue", id: "queued-9", text: " \n" })).toBe(state);
    expect(reduceChatState(state, { type: "enqueue", id: "queued-1", text: "Other" })).toBe(state);
  });

  it("removes exactly one queued message by identifier", () => {
    const state = queued(started(), "first", "second", "third");

    const removed = reduceChatState(state, { type: "remove-queued", id: "queued-2" });
    expect(removed.queued.map((message) => message.text)).toEqual(["first", "third"]);
    expect(reduceChatState(removed, { type: "remove-queued", id: "queued-2" })).toBe(removed);
  });

  it("coalesces consecutive free text and gives each command its own drain group", () => {
    let state = queued(started(), "one", "two", "/plan", "three", "four", "/status");

    expect(nextDrainGroup(state)).toEqual({ size: 2, text: "one\n\ntwo", attachmentIds: [] });
    state = reduceChatState(state, { type: "dequeue-group" });
    expect(nextDrainGroup(state)).toEqual({ size: 1, text: "/plan", attachmentIds: [] });
    state = reduceChatState(state, { type: "dequeue-group" });
    expect(nextDrainGroup(state)).toEqual({ size: 2, text: "three\n\nfour", attachmentIds: [] });
    state = reduceChatState(state, { type: "dequeue-group" });
    expect(nextDrainGroup(state)).toEqual({ size: 1, text: "/status", attachmentIds: [] });
    state = reduceChatState(state, { type: "dequeue-group" });

    expect(state.queued).toEqual([]);
    expect(nextDrainGroup(state)).toBeNull();
    expect(reduceChatState(state, { type: "dequeue-group" })).toBe(state);
  });

  it("keeps the queue intact through a completed turn so the drain can pop it", () => {
    let state = queued(started(), "Next question");
    state = reduceChatState(state, {
      type: "event",
      requestKey: 1,
      event: { type: "final-text", turnId: "turn-1", text: "Ride easy." },
    });
    const completed = reduceChatState(state, { type: "complete", requestKey: 1 });

    expect(completed.status).toBe("idle");
    expect(completed.queued).toBe(state.queued);
    expect(nextDrainGroup(completed)).toEqual({
      size: 1,
      text: "Next question",
      attachmentIds: [],
    });
  });

  it.each([
    { action: "interrupt", status: "interrupted" },
    { action: "fail", status: "idle" },
  ] as const)("holds the queue when a turn ends as $action", ({ action, status }) => {
    const state = queued(started(), "Still waiting");

    const held = reduceChatState(state, { type: action, requestKey: 1, copy: "Something broke" });

    expect(held.status).toBe(status);
    expect(held.queued).toBe(state.queued);
  });

  it("opens a queue-only conversation without changing queued messages", () => {
    const state = queued(
      reduceChatState(EMPTY_CHAT_STATE, { type: "session-probe", hasSession: false }),
      "Queued",
    );

    expect(hasClearableConversation(state)).toBe(true);
    const confirming = reduceChatState(state, { type: "open-new-conversation" });
    expect(confirming.session.resetPhase).toBe("confirming");
    expect(confirming.queued).toBe(state.queued);
  });

  it("clears the queue when a reset succeeds", () => {
    const resetting: ChatState = {
      ...queued(started(), "Dropped by the reset"),
      session: { ...EMPTY_CHAT_STATE.session, resetPhase: "resetting" },
    };

    const state = reduceChatState(resetting, {
      type: "reset-succeeded",
      announcement: "New conversation started.",
    });

    expect(state.queued).toEqual([]);
  });
});
