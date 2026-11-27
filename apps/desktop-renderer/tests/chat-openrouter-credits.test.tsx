import type { TurnEvent } from "@enduragent/coach-contract";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createPhrasebook } from "@enduragent/i18n/messages";
import { LanguageProvider } from "@enduragent/i18n/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reduceChatState, type ChatState } from "../src/chat/message-state";
import { createChatViewAdapter } from "../src/state/adapters/chat";
import { EMPTY_CHAT_SURFACE, type ChatActions } from "../src/state/chat-slice";
import { useEnduragentStore } from "../src/state/store";
import { EMPTY_CHAT_STATE } from "../src/turn-state";
import { Notice } from "../src/ui/chat/Notice";
import { Transcript } from "../src/ui/chat/Transcript";

const english = await createPhrasebook({ tag: "en", locale: "en-GB" });
const italian = await createPhrasebook({ tag: "it", locale: "it-IT" });
const descriptor = { key: "coach.error.openRouterCredits", vars: { openrouter: "OpenRouter" } };
const creditsCopy = english.say("coach.error.openRouterCredits", descriptor.vars);

let actions: Pick<ChatActions, "openOpenRouterCredits" | "retry">;

beforeEach(() => {
  actions = { openOpenRouterCredits: vi.fn(), retry: vi.fn() };
  useEnduragentStore.setState({
    chat: EMPTY_CHAT_SURFACE,
    chatActions: actions as ChatActions,
  });
});

function failed(kind: Extract<TurnEvent, { type: "error" }>["kind"]): ChatState {
  const submitted = reduceChatState(EMPTY_CHAT_STATE, {
    type: "submit",
    requestKey: 1,
    occurredAtMs: 0,
    userMessage: "How hard should today's ride be?",
    userMessageId: "athlete-1",
    assistantMessageId: "coach-1",
    includeUser: true,
  });
  return reduceChatState(submitted, {
    type: "event",
    requestKey: 1,
    event: {
      type: "error",
      turnId: "turn-1",
      chatId: "desktop",
      error_class: "unknown",
      kind,
      athleteMessage:
        kind === "openrouter-credits" ? creditsCopy : english.say("coach.error.providerDown"),
      message: kind === "openrouter-credits" ? descriptor : { key: "coach.error.providerDown" },
      overflowAttempts: 0,
      timeoutAttempts: 0,
      rateLimitAttempts: 0,
      duration_ms: 0,
      compactions: 0,
    },
  });
}

function publish(state: ChatState): void {
  createChatViewAdapter({
    bufferStreaming: false,
    publish: (next) => useEnduragentStore.getState().setChatSurface(next),
  }).view.render(state);
}

function renderIn(element: React.ReactElement, tag: "en" | "it" = "en") {
  return render(
    <LanguageProvider
      tag={tag}
      locale={tag === "en" ? "en-GB" : "it-IT"}
      phrasebook={tag === "en" ? english : italian}
    >
      {element}
    </LanguageProvider>,
  );
}

describe("OpenRouter credits error in Chat", () => {
  it("shows the credits message and Add credits under the kept message", async () => {
    publish({ ...failed("openrouter-credits"), status: "interrupted" });
    renderIn(<Transcript />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(creditsCopy);
    expect(screen.getAllByText(creditsCopy)).toHaveLength(1);
    expect(screen.getByText("How hard should today's ride be?")).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry message" })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "Add credits" }));
    expect(actions.openOpenRouterCredits).toHaveBeenCalledTimes(1);
    expect(actions.openOpenRouterCredits).toHaveBeenCalledWith();
    expect(actions.retry).not.toHaveBeenCalled();
    expect(useEnduragentStore.getState().chat.messages).toContainEqual(
      expect.objectContaining({ id: "athlete-1", retry: true, addCredits: true }),
    );
  });

  it("renders the credits message in the rider's language", async () => {
    publish({ ...failed("openrouter-credits"), status: "interrupted" });
    renderIn(<Transcript />, "it");

    const translated = italian.say("coach.error.openRouterCredits", descriptor.vars);
    expect(translated).not.toBe(creditsCopy);
    expect(await screen.findByText(translated)).toBeVisible();
    expect(
      screen.getByRole("button", { name: italian.say("chat.notice.addCredits") }),
    ).toBeVisible();
  });

  it("offers Add credits in the notice while the failed turn is still settling", async () => {
    publish(failed("openrouter-credits"));
    renderIn(<Notice />);

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent(creditsCopy);
    await userEvent.click(within(notice).getByRole("button", { name: "Add credits" }));
    expect(actions.openOpenRouterCredits).toHaveBeenCalledTimes(1);
  });

  it("keeps other provider failures without Add credits", async () => {
    publish({ ...failed("provider-down"), status: "interrupted" });
    const view = renderIn(<Transcript />);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Add credits" })).toBeNull();
    expect(view.container.querySelector(".chat-credits-notice")).toBeNull();
    view.unmount();

    publish(failed("provider-down"));
    renderIn(<Notice />);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Add credits" })).toBeNull();
    expect(useEnduragentStore.getState().chat.noticeAddCredits).toBe(false);
  });
});
