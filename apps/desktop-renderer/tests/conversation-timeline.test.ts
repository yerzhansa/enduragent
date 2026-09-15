import { describe, expect, it } from "vitest";
import {
  compensateScrollTop,
  conversationUlidTime,
  destinationScrollTop,
  orderConversationRows,
  pendingNavigations,
  sourceActionIsAbove,
  type ConversationProjection,
} from "../src/ui/chat/conversation-timeline";

const draft = { kind: "plan-creation", id: "creation-a" } satisfies ConversationProjection;
const change = { kind: "plan-change", id: "change-b" } satisfies ConversationProjection;
const progress = { kind: "coach-progress" } satisfies ConversationProjection;

function ordered(input: {
  readonly durable: readonly (readonly [key: string, occurredAtMs?: number])[];
  readonly projections: readonly {
    readonly projection: ConversationProjection;
    readonly value: string;
    readonly occurredAtMs: number | null;
  }[];
}): readonly string[] {
  return orderConversationRows({
    durable: input.durable.map(([key, occurredAtMs]) => ({ key, value: key, occurredAtMs })),
    projections: input.projections,
  }).map((row) => row.value);
}

describe("conversation row order", () => {
  it("reads the creation instant out of a ULID", () => {
    expect(conversationUlidTime("00000000010000000000000000")).toBe(1);
    expect(conversationUlidTime("invalid")).toBeNull();
  });

  it("places a timed card after the last row recorded at or before its instant", () => {
    expect(
      ordered({
        durable: [["message-a", 0], ["message-b", 2]],
        projections: [{ projection: draft, value: "draft", occurredAtMs: 1 }],
      }),
    ).toEqual(["message-a", "draft", "message-b"]);
    expect(
      ordered({
        durable: [["message-a", 0], ["message-b", 2]],
        projections: [{ projection: draft, value: "draft", occurredAtMs: 2 }],
      }),
    ).toEqual(["message-a", "message-b", "draft"]);
  });

  it("keeps cards recorded at the same instant in the order they were given", () => {
    expect(
      ordered({
        durable: [["message-a", 0], ["message-b", 2]],
        projections: [
          { projection: draft, value: "draft", occurredAtMs: 1 },
          { projection: change, value: "change", occurredAtMs: 1 },
        ],
      }),
    ).toEqual(["message-a", "draft", "change", "message-b"]);
  });

  it("lets an untimed row inherit the instant of the row before it", () => {
    expect(
      ordered({
        durable: [["message-a", 0], ["discard"], ["message-b", 2]],
        projections: [{ projection: draft, value: "draft", occurredAtMs: 1 }],
      }),
    ).toEqual(["message-a", "discard", "draft", "message-b"]);
  });

  it("never reorders rows whose instants run backwards", () => {
    expect(
      ordered({
        durable: [["message-a", 5], ["message-b", 2]],
        projections: [{ projection: draft, value: "draft", occurredAtMs: 3 }],
      }),
    ).toEqual(["draft", "message-a", "message-b"]);
    expect(
      ordered({
        durable: [["message-a", 5], ["message-b", 2]],
        projections: [{ projection: draft, value: "draft", occurredAtMs: 6 }],
      }),
    ).toEqual(["message-a", "message-b", "draft"]);
  });

  it("keeps live prompts at the current edge after every timed card", () => {
    expect(
      ordered({
        durable: [["message-a", 0]],
        projections: [
          { projection: progress, value: "progress", occurredAtMs: null },
          { projection: draft, value: "draft", occurredAtMs: 9 },
        ],
      }),
    ).toEqual(["message-a", "draft", "progress"]);
  });

  it("drops a projection whose key already exists as a row", () => {
    expect(
      ordered({
        durable: [["plan-creation:creation-a", 0]],
        projections: [{ projection: draft, value: "duplicate", occurredAtMs: null }],
      }),
    ).toEqual(["plan-creation:creation-a"]);
  });
});

describe("pending navigation", () => {
  it("includes only unresolved Draft, Plan Change, and Coach choice states", () => {
    expect(
      pendingNavigations({
        planCreation: { creationId: "creation-a", hasDraft: true },
        planChanges: [
          { changeId: "change-a", status: "pending" },
          { changeId: "change-b", status: "cancelled" },
          { changeId: "change-c", status: "superseded" },
          { changeId: "change-d", status: "applied" },
        ],
        decision: { decisionId: "decision-a", status: "unanswered" },
      }).map((item) => item.key),
    ).toEqual(["plan-creation:creation-a", "plan-change:change-a", "coach-decision:decision-a"]);

    expect(
      pendingNavigations({
        planCreation: { creationId: "creation-a", hasDraft: false },
        planChanges: [{ changeId: "change-a", status: "stale" }],
        decision: { decisionId: "decision-a", status: "answered" },
      }),
    ).toEqual([]);
  });

  it("appears only after the source row crosses above the conversation top", () => {
    expect(sourceActionIsAbove(99, 100)).toBe(true);
    expect(sourceActionIsAbove(100, 100)).toBe(true);
    expect(sourceActionIsAbove(101, 100)).toBe(false);
    expect(sourceActionIsAbove(700, 100)).toBe(false);
  });

  it("preserves visual position and places a destination eight pixels below the top", () => {
    expect(compensateScrollTop(240, 52, 92)).toBe(280);
    expect(compensateScrollTop(20, 92, 52)).toBe(0);
    expect(
      destinationScrollTop({
        scrollTop: 500,
        cardTop: 340,
        conversationTop: 92,
      }),
    ).toBe(740);
  });
});
