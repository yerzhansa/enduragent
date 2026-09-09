import type { ChatResponse } from "@enduragent/coach-contract";
import {
  reduceChatState as reduceTurnState,
  type ChatAction as TurnAction,
  type ChatState as TurnState,
  type ChatTranscriptMessage,
  type ActiveTurn,
  type ChatErrorView,
} from "../turn-state";

export type WireMessage = NonNullable<ChatResponse["message"]>;

export interface ChatState extends TurnState {
  readonly messages: readonly (ChatTranscriptMessage & { readonly message?: WireMessage })[];
  readonly activeTurn:
    | (ActiveTurn & {
        readonly error: (ChatErrorView & { readonly message?: WireMessage }) | null;
      })
    | null;
}

export type ChatAction =
  | TurnAction
  | (Extract<TurnAction, { readonly type: "complete" }> & Pick<ChatResponse, "message">);

export function reduceChatState(state: ChatState, action: ChatAction): ChatState {
  const next = reduceTurnState(state, action);
  if (next === state) return state;
  if (action.type === "event" && action.event.type === "error" && next.activeTurn?.error) {
    return {
      ...next,
      activeTurn: {
        ...next.activeTurn,
        error: { ...next.activeTurn.error, message: action.event.message },
      },
    };
  }
  const descriptor =
    action.type === "event" && action.event.type === "final-text"
      ? action.event.message
      : action.type === "complete" && "message" in action
        ? action.message
        : undefined;
  if (descriptor === undefined) return next;
  return {
    ...next,
    messages: next.messages.map((message) =>
      message.id === next.activeTurn?.assistantMessageId
        ? { ...message, message: descriptor }
        : message,
    ),
  };
}
