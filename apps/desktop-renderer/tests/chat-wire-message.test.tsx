import { act, render, screen, waitFor } from "@testing-library/react";
import { createPhrasebook, loadCatalog } from "@enduragent/i18n/messages";
import { LanguageProvider } from "@enduragent/i18n/react";
import { beforeEach, describe, expect, it } from "vitest";
import { reduceChatState, type ChatState, type WireMessage } from "../src/chat/message-state";
import { createChatViewAdapter } from "../src/state/adapters/chat";
import { EMPTY_CHAT_SURFACE } from "../src/state/chat-slice";
import { useEnduragentStore } from "../src/state/store";
import { EMPTY_CHAT_STATE } from "../src/turn-state";
import { Notice } from "../src/ui/chat/Notice";
import { Transcript } from "../src/ui/chat/Transcript";

const english = await createPhrasebook({ tag: "en", locale: "en-GB" });
const italian = await createPhrasebook({ tag: "it", locale: "it-IT" });
const italianCatalog = await loadCatalog("it");
const stepLimit = { key: "coach.fallback.stepLimit" } satisfies WireMessage;
const wireText = english.say("coach.fallback.stepLimit");

beforeEach(() => {
  useEnduragentStore.setState({ chat: EMPTY_CHAT_SURFACE });
});

function submitted(): ChatState {
  return reduceChatState(EMPTY_CHAT_STATE, {
    type: "submit",
    requestKey: 1,
    userMessage: "Continue",
    userMessageId: "athlete-1",
    assistantMessageId: "coach-1",
    includeUser: true,
  });
}

function completed(message?: WireMessage): ChatState {
  const final = reduceChatState(submitted(), {
    type: "event",
    requestKey: 1,
    event: { type: "final-text", turnId: "turn-1", text: wireText, message },
  });
  return reduceChatState(final, { type: "complete", requestKey: 1 });
}

function publish(state: ChatState, bufferStreaming = false): void {
  createChatViewAdapter({
    bufferStreaming,
    publish: (next) => useEnduragentStore.getState().setChatSurface(next),
  }).view.render(state);
}

describe("wire message rendering", () => {
  it.each([stepLimit, { key: "coach.future.unknown" }])(
    "renders the final-text descriptor %j before the terminal response with streaming buffered",
    async (message) => {
      const state = reduceChatState(submitted(), {
        type: "event",
        requestKey: 1,
        event: { type: "final-text", turnId: "turn-1", text: wireText, message },
      });
      publish(state, true);
      render(
        <LanguageProvider tag="it" locale="it-IT" phrasebook={italian}>
          <Transcript />
        </LanguageProvider>,
      );
      const expected =
        message.key === stepLimit.key ? italian.say("coach.fallback.stepLimit") : wireText;
      expect(await screen.findByText(expected)).toBeVisible();
      expect(state.messages.at(-1)).toMatchObject({ text: wireText, message });
      expect(useEnduragentStore.getState().chat.messages.at(-1)?.text).toBe(wireText);
    },
  );

  it("renders the Italian final-text descriptor without changing stored English text", async () => {
    const state = completed(stepLimit);
    publish(state);
    render(
      <LanguageProvider tag="it" locale="it-IT" phrasebook={italian}>
        <Transcript />
      </LanguageProvider>,
    );

    const translated = italian.say("coach.fallback.stepLimit");
    expect(italianCatalog).toMatchObject({ coach: { fallback: { stepLimit: translated } } });
    expect(translated).not.toBe(wireText);
    expect(await screen.findByText(translated)).toBeVisible();
    expect(state.messages.at(-1)).toMatchObject({ text: wireText, message: stepLimit });
    expect(useEnduragentStore.getState().chat.messages.at(-1)).toMatchObject({
      text: wireText,
      message: stepLimit,
    });
  });

  it("re-renders existing descriptors when the language changes and preserves English bytes", async () => {
    publish(completed(stepLimit));
    const view = render(
      <LanguageProvider tag="it" locale="it-IT" phrasebook={italian}>
        <Transcript />
      </LanguageProvider>,
    );
    await screen.findByText(italian.say("coach.fallback.stepLimit"));
    view.rerender(
      <LanguageProvider tag="en" locale="en-GB" phrasebook={english}>
        <Transcript />
      </LanguageProvider>,
    );
    await waitFor(() => {
      expect(document.querySelector(".chat-message--coach .chat-message__text")?.textContent).toBe(
        wireText,
      );
    });
    expect(useEnduragentStore.getState().chat.messages.at(-1)?.text).toBe(wireText);
  });

  it.each([undefined, { key: "coach.future.unknown" }])(
    "keeps the wire text when its descriptor is %j",
    async (message) => {
      publish(completed(message));
      render(
        <LanguageProvider tag="it" locale="it-IT" phrasebook={italian}>
          <Transcript />
        </LanguageProvider>,
      );
      await act(async () => {});
      expect(screen.getByText(wireText)).toBeVisible();
      expect(screen.queryByText("coach.future.unknown")).toBeNull();
    },
  );

  it("renders an error descriptor and its interpolation without replacing the wire notice", async () => {
    const descriptor = { key: "coach.error.reauth", vars: { provider: "Synthetic provider" } };
    const athleteMessage = english.say("coach.error.reauth", descriptor.vars);
    const state = reduceChatState(submitted(), {
      type: "event",
      requestKey: 1,
      event: {
        type: "error",
        turnId: "turn-1",
        chatId: "desktop",
        error_class: "unknown",
        kind: "provider-auth",
        athleteMessage,
        message: descriptor,
        overflowAttempts: 0,
        timeoutAttempts: 0,
        rateLimitAttempts: 0,
        duration_ms: 0,
        compactions: 0,
      },
    });
    publish(state);
    render(
      <LanguageProvider tag="it" locale="it-IT" phrasebook={italian}>
        <Notice />
      </LanguageProvider>,
    );
    expect(
      await screen.findByText(italian.say("coach.error.reauth", descriptor.vars)),
    ).toBeVisible();
    expect(useEnduragentStore.getState().chat.notice).toBe(athleteMessage);
    expect(state.activeTurn?.error).toMatchObject({ athleteMessage, message: descriptor });
  });
});
