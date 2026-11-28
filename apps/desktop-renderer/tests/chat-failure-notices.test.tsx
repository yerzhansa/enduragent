import type { TurnEvent } from "@enduragent/coach-contract";
import { act, render, screen } from "@testing-library/react";
import { msg, type Message } from "@enduragent/i18n";
import { createPhrasebook } from "@enduragent/i18n/messages";
import { LanguageProvider } from "@enduragent/i18n/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reduceChatState, type ChatState } from "../src/chat/message-state";
import { createChatViewAdapter } from "../src/state/adapters/chat";
import { EMPTY_CHAT_SURFACE, type ChatActions } from "../src/state/chat-slice";
import { useEnduragentStore } from "../src/state/store";
import { EMPTY_CHAT_STATE } from "../src/turn-state";
import { Transcript } from "../src/ui/chat/Transcript";

type ErrorKind = Extract<TurnEvent, { type: "error" }>["kind"];

const english = await createPhrasebook({ tag: "en", locale: "en-GB" });
const italian = await createPhrasebook({ tag: "it", locale: "it-IT" });
const prompt = "How hard should today's ride be?";

const CASES = [
  {
    kind: "subscription-signed-out",
    message: msg("coach.error.reauthSetup", { provider: "Claude Code" }),
  },
  {
    kind: "provider-credits",
    message: msg("coach.error.providerCredits", { provider: "DeepSeek" }),
  },
  {
    kind: "model-unavailable",
    message: msg("coach.error.modelUnavailable", { provider: "DeepSeek" }),
  },
] as const;

beforeEach(() => {
  useEnduragentStore.setState({
    chat: EMPTY_CHAT_SURFACE,
    chatActions: { openOpenRouterCredits: vi.fn(), retry: vi.fn() } as unknown as ChatActions,
  });
});

function interrupted(kind: ErrorKind, message: Message): ChatState {
  const submitted = reduceChatState(EMPTY_CHAT_STATE, {
    type: "submit",
    requestKey: 1,
    occurredAtMs: 0,
    userMessage: prompt,
    userMessageId: "athlete-1",
    assistantMessageId: "coach-1",
    includeUser: true,
  });
  const failed = reduceChatState(submitted, {
    type: "event",
    requestKey: 1,
    event: {
      type: "error",
      turnId: "turn-1",
      chatId: "desktop",
      error_class: "unknown",
      kind,
      athleteMessage: english.say(message),
      message,
      overflowAttempts: 0,
      timeoutAttempts: 0,
      rateLimitAttempts: 0,
      duration_ms: 0,
      compactions: 0,
    },
  });
  return { ...failed, status: "interrupted" };
}

function showFailure(kind: ErrorKind, message: Message, tag: "en" | "it" = "en") {
  createChatViewAdapter({
    bufferStreaming: false,
    publish: (next) => useEnduragentStore.getState().setChatSurface(next),
  }).view.render(interrupted(kind, message));
  return render(
    <LanguageProvider
      tag={tag}
      locale={tag === "en" ? "en-GB" : "it-IT"}
      phrasebook={tag === "en" ? english : italian}
    >
      <Transcript />
    </LanguageProvider>,
  );
}

describe("Chat failure notices", () => {
  it.each(CASES)("shows the $kind notice under the kept message", async ({ kind, message }) => {
    const view = showFailure(kind, message);
    const copy = english.say(message);

    const notice = view.container.querySelector(".chat-error-notice");
    expect(notice, `the ${kind} failure shows no notice under the message`).not.toBeNull();
    expect(await screen.findByRole("alert")).toHaveTextContent(copy);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByText(prompt)).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry message" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Add credits" })).toBeNull();
    expect(useEnduragentStore.getState().chat.noticeAddCredits).toBe(false);
  });

  it("says what went wrong in the rider's language", async () => {
    const message = CASES[2].message;
    const view = showFailure("model-unavailable", message, "it");

    const translated = italian.say(message);
    expect(translated).not.toBe(english.say(message));
    const shownText = await screen.findByText(translated);
    expect(view.container.querySelector(".chat-error-notice")).toContainElement(shownText);
  });

  it("keeps a rejected API key on the quiet failure line", async () => {
    const view = showFailure("provider-auth", msg("coach.error.providerCredentials"));
    await act(async () => {});

    expect(view.container.querySelector(".chat-error-notice")).toBeNull();
    expect(screen.getByRole("alert")).toHaveClass("sr-only");
    expect(screen.getByRole("button", { name: "Retry message" })).toBeEnabled();
  });
});
