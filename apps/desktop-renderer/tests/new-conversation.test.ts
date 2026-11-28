import { describe, expect, it } from "vitest";
import type {
  ChatQueueSnapshot,
  CoachDecisionReadModel,
  TranscriptPageEntry,
} from "@enduragent/coach-contract";
import type { TranscriptHydrationSnapshot, TranscriptPage } from "../src/chat/hydration";
import { newConversationEvidence, newConversationOutcome } from "../src/chat/new-conversation";
import { EMPTY_CHAT_STATE } from "../src/turn-state";

type Page = Extract<TranscriptPage, { readonly status: "page" }>;

const oldTurn = {
  turnId: "turn-old",
  completedAt: "1998-08-25T08:00:00.000Z",
  athleteText: "Earlier question",
  coachText: "Earlier answer",
};
const decisionRequested = {
  kind: "decision-requested",
  recordedAt: "1998-08-25T08:00:00.000Z",
  athleteText: "Should I ride long on Saturday?",
  decision: { decisionId: "decision-old", status: "unanswered" } as CoachDecisionReadModel,
} as TranscriptPageEntry;
const emptyQueue: ChatQueueSnapshot = { schemaVersion: 1, revision: 0, items: [] };

function hydration(
  status: TranscriptHydrationSnapshot["status"],
  turns: TranscriptHydrationSnapshot["turns"] = [],
  entries: readonly TranscriptPageEntry[] = [],
): TranscriptHydrationSnapshot {
  return { turns, entries, nextCursor: null, status, revision: 1, change: "initial" };
}

function page(
  turns: Page["turns"],
  entries: readonly TranscriptPageEntry[] = [],
  nextCursor: string | null = null,
): Page {
  return { schemaVersion: 2, status: "page", turns, entries, nextCursor };
}

const noneSent = new Set<string>();

describe("new conversation outcome", () => {
  it("reads turns that are still stored as a reset that never started", () => {
    const before = newConversationEvidence(
      hydration("ready", [oldTurn]),
      EMPTY_CHAT_STATE,
      undefined,
      0,
    );
    expect(newConversationOutcome(before, page([oldTurn]), emptyQueue, noneSent)).toBe(
      "not-started",
    );
    expect(newConversationOutcome(before, page([]), emptyQueue, noneSent)).toBe("landed");
  });

  it("reads a stored coach question with no turn as a reset that never started", () => {
    const shown = newConversationEvidence(
      hydration("ready", [], [decisionRequested]),
      EMPTY_CHAT_STATE,
      undefined,
      0,
    );
    const open = newConversationEvidence(hydration("failed"), EMPTY_CHAT_STATE, "decision-old", 0);
    const stored = page([], [decisionRequested]);

    expect(newConversationOutcome(shown, stored, emptyQueue, noneSent)).toBe("not-started");
    expect(newConversationOutcome(open, stored, emptyQueue, noneSent)).toBe("not-started");
  });

  it("reads unseen stored turns as not started when history never loaded", () => {
    const before = newConversationEvidence(hydration("failed"), EMPTY_CHAT_STATE, undefined, 0);
    expect(newConversationOutcome(before, page([oldTurn]), emptyQueue, noneSent)).toBe(
      "not-started",
    );
    expect(
      newConversationOutcome(before, page([oldTurn]), emptyQueue, new Set(["turn:turn-old"])),
    ).toBe("landed");
  });

  it("reads saved messages that are still queued as a reset that never started", () => {
    const before = newConversationEvidence(
      hydration("ready"),
      {
        ...EMPTY_CHAT_STATE,
        queued: [{ id: "queued-1", text: "Later", command: false }],
      },
      undefined,
      0,
    );
    const queue: ChatQueueSnapshot = {
      schemaVersion: 1,
      revision: 1,
      items: [
        {
          queuedMessageId: "queued-1",
          messageId: "message-1",
          submissionId: "submission-1",
          text: "Later",
          kind: "ordinary",
          attachmentIds: [],
          position: 0,
          restored: false,
        },
      ],
    };
    expect(newConversationOutcome(before, page([]), queue, noneSent)).toBe("not-started");
  });

  it("stays unknown when the newest page no longer reaches what was showing", () => {
    const before = newConversationEvidence(
      hydration("ready", [oldTurn]),
      EMPTY_CHAT_STATE,
      undefined,
      0,
    );
    const newer = { ...oldTurn, turnId: "turn-newer" };
    expect(
      newConversationOutcome(
        before,
        page([newer], [], "older"),
        emptyQueue,
        new Set(["turn:turn-newer"]),
      ),
    ).toBe("unknown");
  });
});
