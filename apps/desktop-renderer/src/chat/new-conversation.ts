import type { ChatQueueSnapshot, TranscriptPageEntry } from "@enduragent/coach-contract";
import type { DesktopCoachClient } from "../coach-client";
import { DESKTOP_CHAT_ID, type ChatState, type ChatTranscriptMessage } from "../turn-state";
import {
  TRANSCRIPT_HYDRATION_PAGE_LIMIT,
  type TranscriptHydrationSnapshot,
  type TranscriptPage,
  type TranscriptTurn,
} from "./hydration";

export interface NewConversationEvidence {
  readonly keys: ReadonlySet<string>;
  readonly historyLoaded: boolean;
  readonly queuedIds: ReadonlySet<string>;
  readonly draftWrites: number;
}

export type NewConversationReading =
  | {
      readonly outcome: "landed";
      readonly page: Extract<TranscriptPage, { readonly status: "page" }>;
      readonly queue: ChatQueueSnapshot;
    }
  | { readonly outcome: "not-started" }
  | { readonly outcome: "unknown" };

const turnKey = (turnId: string): string => `turn:${turnId}`;
const decisionKey = (decisionId: string): string => `decision:${decisionId}`;

function entryKeys(entry: TranscriptPageEntry): readonly string[] {
  return [
    ...("turnId" in entry ? [turnKey(entry.turnId)] : []),
    ...("decisionId" in entry ? [decisionKey(entry.decisionId)] : []),
    ...(entry.kind === "decision-requested" ? [decisionKey(entry.decision.decisionId)] : []),
  ];
}

function transcriptKeys(source: {
  readonly turns: readonly TranscriptTurn[];
  readonly entries?: readonly TranscriptPageEntry[];
}): readonly string[] {
  return [
    ...source.turns.map((turn) => turnKey(turn.turnId)),
    ...(source.entries ?? []).flatMap(entryKeys),
  ];
}

const messageKeys = (messages: readonly ChatTranscriptMessage[]): readonly string[] =>
  messages.flatMap((message) => [
    ...(message.turnId === undefined ? [] : [turnKey(message.turnId)]),
    ...(message.decisionId === undefined ? [] : [decisionKey(message.decisionId)]),
  ]);

export function newConversationEvidence(
  hydration: TranscriptHydrationSnapshot,
  state: Pick<ChatState, "messages" | "queued">,
  openDecisionId: string | undefined,
  draftWrites: number,
): NewConversationEvidence {
  return {
    keys: new Set([
      ...transcriptKeys(hydration),
      ...messageKeys(state.messages),
      ...(openDecisionId === undefined ? [] : [decisionKey(openDecisionId)]),
    ]),
    historyLoaded: hydration.status === "ready",
    queuedIds: new Set(state.queued.map((message) => message.id)),
    draftWrites,
  };
}

export function newConversationOutcome(
  before: NewConversationEvidence,
  page: Extract<TranscriptPage, { readonly status: "page" }>,
  queue: ChatQueueSnapshot,
  sentKeys: ReadonlySet<string>,
): NewConversationReading["outcome"] {
  const pageKeys = transcriptKeys(page);
  if (
    pageKeys.some((key) => before.keys.has(key)) ||
    (!before.historyLoaded && pageKeys.some((key) => !sentKeys.has(key))) ||
    queue.items.some((item) => before.queuedIds.has(item.queuedMessageId))
  ) {
    return "not-started";
  }
  return page.nextCursor === null ? "landed" : "unknown";
}

export async function readResetOutcome(
  client: DesktopCoachClient,
  readTranscriptPage: (request: {
    readonly cursor: string | null;
    readonly limit: number;
  }) => Promise<TranscriptPage>,
  before: NewConversationEvidence,
  liveMessages: () => readonly ChatTranscriptMessage[],
): Promise<NewConversationReading> {
  await client.call("hasSession", { chatId: DESKTOP_CHAT_ID });
  const page = await readTranscriptPage({ cursor: null, limit: TRANSCRIPT_HYDRATION_PAGE_LIMIT });
  const queue = await client.call("getChatQueue", { chatId: DESKTOP_CHAT_ID });
  if (page.status !== "page") return { outcome: "unknown" };
  const sentKeys = new Set(messageKeys(liveMessages()).filter((key) => !before.keys.has(key)));
  const outcome = newConversationOutcome(before, page, queue, sentKeys);
  return outcome === "landed" ? { outcome, page, queue } : { outcome };
}
