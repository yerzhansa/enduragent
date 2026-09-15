import { describe, expect, it } from "vitest";
import {
  chronologicalConversationPredecessor,
  compensateScrollTop,
  conversationUlidTime,
  createConversationInsertionLedger,
  destinationScrollTop,
  forgetConversationProjection,
  orderConversationRows,
  pendingNavigations,
  recoverConversationPredecessor,
  resetConversationInsertionLedger,
  sourceActionIsAbove,
  type ConversationProjection,
} from "../src/ui/chat/conversation-timeline";

const firstProjection = {
  kind: "plan-creation",
  id: "creation-a",
} satisfies ConversationProjection;
const secondProjection = {
  kind: "coach-decision",
  id: "decision-b",
} satisfies ConversationProjection;

function orderedValues(input: {
  readonly durable: readonly string[];
  readonly projections: readonly {
    readonly projection: ConversationProjection;
    readonly value: string;
    readonly afterKey?: string | null;
  }[];
  readonly ledger: ReturnType<typeof createConversationInsertionLedger>;
  readonly rememberNewPlacements?: boolean;
}): readonly string[] {
  return orderConversationRows({
    durable: input.durable.map((value) => ({ key: value, value })),
    projections: input.projections,
    ledger: input.ledger,
    rememberNewPlacements: input.rememberNewPlacements ?? true,
  }).map((row) => row.value);
}

describe("conversation insertion ledger", () => {
  it("recovers a persisted projection predecessor from its ULID time", () => {
    expect(conversationUlidTime("00000000010000000000000000")).toBe(1);
    expect(conversationUlidTime("invalid")).toBeNull();
    expect(
      chronologicalConversationPredecessor(
        [
          { key: "message-a", value: "message-a", occurredAtMs: 0 },
          { key: "message-b", value: "message-b", occurredAtMs: 2 },
        ],
        1,
      ),
    ).toBe("message-a");
    expect(
      chronologicalConversationPredecessor(
        [
          { key: "message-a", value: "message-a", occurredAtMs: 0 },
          { key: "live-message", value: "live-message" },
        ],
        1,
      ),
    ).toBeUndefined();
    expect(
      recoverConversationPredecessor(
        [
          { key: "message-a", value: "message-a", occurredAtMs: 0 },
          { key: "message-b", value: "message-b", occurredAtMs: 2 },
        ],
        1,
        "message-b",
      ),
    ).toBe("message-a");
    expect(
      recoverConversationPredecessor(
        [
          { key: "message-a", value: "message-a", occurredAtMs: 0 },
          { key: "live-message", value: "live-message" },
        ],
        1,
        "live-message",
      ),
    ).toBe("live-message");
  });

  it("keeps later durable rows below projections already shown", () => {
    const ledger = createConversationInsertionLedger(0);
    expect(
      orderedValues({
        durable: ["message-a"],
        projections: [{ projection: firstProjection, value: "draft" }],
        ledger,
      }),
    ).toEqual(["message-a", "draft"]);

    expect(
      orderedValues({
        durable: ["message-a", "message-b"],
        projections: [{ projection: firstProjection, value: "updated draft" }],
        ledger,
      }),
    ).toEqual(["message-a", "updated draft", "message-b"]);
  });

  it("uses a projection's transcript predecessor when it first appears", () => {
    const ledger = createConversationInsertionLedger(0);
    expect(
      orderConversationRows({
        durable: [
          { key: "message-a", value: "message-a" },
          { key: "message-b", value: "message-b" },
        ],
        projections: [{ projection: firstProjection, value: "draft", afterKey: "message-a" }],
        ledger,
        rememberNewPlacements: true,
      }).map((row) => row.value),
    ).toEqual(["message-a", "draft", "message-b"]);
  });

  it("preserves projection order when cards share one transcript predecessor", () => {
    const ledger = createConversationInsertionLedger(0);
    expect(
      orderedValues({
        durable: ["message-a", "message-b"],
        projections: [
          { projection: firstProjection, value: "draft", afterKey: "message-a" },
          { projection: secondProjection, value: "choice", afterKey: "message-a" },
        ],
        ledger,
      }),
    ).toEqual(["message-a", "draft", "choice", "message-b"]);
  });

  it("anchors new projections at the current edge without duplicating an identity", () => {
    const ledger = createConversationInsertionLedger(0);
    orderedValues({
      durable: ["message-a"],
      projections: [{ projection: firstProjection, value: "draft" }],
      ledger,
    });

    expect(
      orderedValues({
        durable: ["message-a", "message-b"],
        projections: [
          { projection: firstProjection, value: "draft" },
          { projection: secondProjection, value: "choice" },
          { projection: secondProjection, value: "duplicate" },
        ],
        ledger,
      }),
    ).toEqual(["message-a", "draft", "message-b", "choice"]);
  });

  it("restores a reentered projection to its original insertion point", () => {
    const ledger = createConversationInsertionLedger(0);
    orderedValues({
      durable: ["message-a"],
      projections: [{ projection: firstProjection, value: "draft" }],
      ledger,
    });
    expect(
      orderedValues({
        durable: ["message-a", "message-b"],
        projections: [],
        ledger,
      }),
    ).toEqual(["message-a", "message-b"]);
    expect(
      orderedValues({
        durable: ["message-a", "message-b"],
        projections: [{ projection: firstProjection, value: "draft returned" }],
        ledger,
      }),
    ).toEqual(["message-a", "draft returned", "message-b"]);
  });

  it("places surviving projections before the first row after reset", () => {
    const previous = createConversationInsertionLedger(0);
    orderedValues({
      durable: ["old-message"],
      projections: [{ projection: firstProjection, value: "draft" }],
      ledger: previous,
    });
    const reset = resetConversationInsertionLedger({
      previous,
      resetCount: 1,
      projections: [firstProjection],
    });
    expect(
      orderedValues({
        durable: ["new-message"],
        projections: [{ projection: firstProjection, value: "surviving draft" }],
        ledger: reset,
      }),
    ).toEqual(["surviving draft", "new-message"]);
  });

  it("places a later availability failure at the current edge after recovery", () => {
    const ledger = createConversationInsertionLedger(0);
    const availability = { kind: "coach-decision-availability" } satisfies ConversationProjection;
    orderedValues({
      durable: ["message-a"],
      projections: [{ projection: availability, value: "first failure" }],
      ledger,
    });
    forgetConversationProjection(ledger, availability);
    expect(
      orderedValues({
        durable: ["message-a", "message-b"],
        projections: [{ projection: availability, value: "later failure" }],
        ledger,
      }),
    ).toEqual(["message-a", "message-b", "later failure"]);
  });

  it("waits for initial hydration before remembering a current-edge placement", () => {
    const ledger = createConversationInsertionLedger(0);
    expect(
      orderedValues({
        durable: [],
        projections: [{ projection: firstProjection, value: "draft" }],
        ledger,
        rememberNewPlacements: false,
      }),
    ).toEqual(["draft"]);
    expect(ledger.placements.size).toBe(0);

    expect(
      orderedValues({
        durable: ["message-a"],
        projections: [{ projection: firstProjection, value: "hydrated draft" }],
        ledger,
        rememberNewPlacements: true,
      }),
    ).toEqual(["message-a", "hydrated draft"]);
    expect(
      orderedValues({
        durable: ["message-a", "message-b"],
        projections: [{ projection: firstProjection, value: "stable draft" }],
        ledger,
      }),
    ).toEqual(["message-a", "stable draft", "message-b"]);
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
