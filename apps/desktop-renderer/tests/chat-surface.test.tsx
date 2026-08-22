import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../src/app/Shell.js";
import {
  EMPTY_CHAT_SURFACE,
  type ChatActions,
  type ChatMessageView,
  type ChatSurfaceState,
} from "../src/state/chat-slice.js";
import { resetChatStream } from "../src/state/chat-stream.js";
import { CLOSED_ONBOARDING, READY_ONBOARDING } from "../src/state/onboarding-slice.js";
import { useEnduragentStore } from "../src/state/store.js";
import { SLASH_COMMANDS } from "../src/chat/commands.js";
import { ChatView } from "../src/ui/chat/ChatView.js";

function stubActions(): ChatActions {
  return {
    submit: vi.fn(),
    removeQueued: vi.fn(),
    retry: vi.fn(),
    loadEarlier: vi.fn(),
    retryHydration: vi.fn(),
    openNewConversation: vi.fn(),
    cancelNewConversation: vi.fn(),
    confirmNewConversation: vi.fn(),
    retryFirstSync: vi.fn(),
  };
}

function setChat(patch: Partial<ChatSurfaceState>): void {
  act(() => {
    useEnduragentStore.setState({ chat: { ...useEnduragentStore.getState().chat, ...patch } });
  });
}

function Harness(): ReactElement {
  return <ChatView />;
}

function composer(): HTMLTextAreaElement {
  const element = document.querySelector("textarea#message");
  if (!(element instanceof HTMLTextAreaElement)) throw new TypeError("composer missing");
  return element;
}

let actions: ChatActions;

describe("chat surface", () => {
  beforeEach(() => {
    actions = stubActions();
    useEnduragentStore.setState({
      activeView: "chat",
      runtimeReady: true,
      chat: EMPTY_CHAT_SURFACE,
      firstSync: { status: "idle" },
      chatActions: actions,
      onboarding: READY_ONBOARDING,
    });
  });

  afterEach(() => {
    useEnduragentStore.setState({
      chat: EMPTY_CHAT_SURFACE,
      firstSync: { status: "idle" },
      chatActions: null,
      onboarding: CLOSED_ONBOARDING,
    });
    resetChatStream();
  });

  describe("slash popup", () => {
    it("filters as the athlete types after a slash", async () => {
      const user = userEvent.setup();
      render(<Harness />);

      await user.click(composer());
      await user.keyboard("/");
      expect(screen.getAllByRole("option")).toHaveLength(SLASH_COMMANDS.length);

      await user.keyboard("st");
      expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
        "/startStart a fresh session",
        "/statusCheck current fitness, fatigue, and form",
      ]);

      await user.keyboard("zz");
      expect(screen.queryByRole("listbox")).toBeNull();
    });

    it("closes once the draft carries whitespace", async () => {
      const user = userEvent.setup();
      render(<Harness />);

      await user.click(composer());
      await user.keyboard("/plan");
      expect(screen.getByRole("listbox", { name: "Commands" })).toBeInTheDocument();

      await user.keyboard(" ");
      expect(screen.queryByRole("listbox")).toBeNull();
    });

    it("exposes the command list as the composer's active suggestion list", async () => {
      const user = userEvent.setup();
      render(<Harness />);
      const input = composer();

      expect(input).toHaveAttribute("role", "combobox");
      expect(input).toHaveAttribute("aria-autocomplete", "list");
      expect(input).toHaveAttribute("aria-expanded", "false");
      expect(input).not.toHaveAttribute("aria-controls");
      expect(input).not.toHaveAttribute("aria-activedescendant");

      await user.click(input);
      await user.keyboard("/st");

      const listbox = screen.getByRole("listbox", { name: "Commands" });
      const options = screen.getAllByRole("option");
      const first = options.at(0);
      const second = options.at(1);
      if (first === undefined || second === undefined) {
        throw new TypeError("command options missing");
      }
      expect(input).toHaveAttribute("aria-expanded", "true");
      expect(input).toHaveAttribute("aria-controls", listbox.id);
      expect(input).toHaveAttribute("aria-activedescendant", first.id);

      await user.keyboard("{ArrowDown}");
      expect(input).toHaveAttribute("aria-activedescendant", second.id);

      await user.keyboard("{Escape}");
      expect(input).toHaveAttribute("aria-expanded", "false");
      expect(input).not.toHaveAttribute("aria-controls");
      expect(input).not.toHaveAttribute("aria-activedescendant");
      expect(document.activeElement).toBe(input);
    });

    it("moves the selection with the arrow keys and accepts with Enter", async () => {
      const user = userEvent.setup();
      render(<Harness />);

      await user.click(composer());
      await user.keyboard("/st");
      expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");

      await user.keyboard("{ArrowDown}");
      expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");

      await user.keyboard("{ArrowUp}{ArrowUp}");
      expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");

      await user.keyboard("{Enter}");
      expect(composer()).toHaveValue("/status ");
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(actions.submit).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(composer());
    });

    it("accepts a command on click without sending it", async () => {
      const user = userEvent.setup();
      render(<Harness />);

      await user.click(composer());
      await user.keyboard("/rev");
      setChat({ status: "streaming", sendDisabled: true });
      await user.click(screen.getByRole("option", { name: /\/review/u }));

      expect(composer()).toHaveValue("/review ");
      expect(actions.submit).not.toHaveBeenCalled();
    });

    it("closes on Escape and keeps the draft", async () => {
      const user = userEvent.setup();
      render(<Harness />);

      await user.click(composer());
      await user.keyboard("/pl");
      await user.keyboard("{Escape}");

      expect(screen.queryByRole("listbox")).toBeNull();
      expect(composer()).toHaveValue("/pl");
    });
  });

  describe("composer", () => {
    it("places the medical disclaimer directly below the composer", () => {
      render(<Harness />);

      const disclaimer = screen.getByText(
        "Not medical advice, and not a substitute for a doctor or a certified coach.",
      );
      const form = composer().closest("form");

      expect(form?.nextElementSibling).toBe(disclaimer);
      expect(disclaimer.parentElement).toHaveClass("composer-wrap");
      expect(disclaimer.parentElement).toHaveClass("bg-bg");
    });

    it("focuses the enabled composer when Chat mounts after required setup", () => {
      render(<Harness />);

      expect(composer()).toBeEnabled();
      expect(composer()).toHaveFocus();
    });

    it("leaves the composer unfocused when the app mounts on another destination", () => {
      useEnduragentStore.setState({ activeView: "training" });
      render(<Harness />);

      expect(composer()).not.toHaveFocus();
    });

    it("never submits while an IME composition is in flight", async () => {
      render(<Harness />);
      const textarea = composer();
      const draft = "回復走を";
      textarea.focus();
      textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      act(() => {
        textarea.value = draft;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });

      const composing = new KeyboardEvent("keydown", {
        key: "Enter",
        isComposing: true,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        textarea.dispatchEvent(composing);
      });

      expect(composing.defaultPrevented).toBe(false);
      expect(actions.submit).not.toHaveBeenCalled();
      expect(textarea).toHaveValue(draft);
      expect(document.activeElement).toBe(textarea);

      textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      const committed = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        textarea.dispatchEvent(committed);
      });

      expect(committed.defaultPrevented).toBe(true);
      expect(actions.submit).toHaveBeenCalledWith(draft);
      expect(textarea).toHaveValue("");
    });

    it("keeps Shift+Enter as a newline and ignores blank drafts", async () => {
      const user = userEvent.setup();
      render(<Harness />);

      await user.click(composer());
      await user.keyboard("first{Shift>}{Enter}{/Shift}second");
      expect(composer()).toHaveValue("first\nsecond");
      expect(actions.submit).not.toHaveBeenCalled();

      await user.clear(composer());
      await user.keyboard("   {Enter}");
      expect(actions.submit).not.toHaveBeenCalled();

      await user.keyboard("ride{Enter}");
      expect(actions.submit).toHaveBeenCalledWith("   ride");
    });

    it("keeps sending available while a turn streams so the message can queue", async () => {
      const user = userEvent.setup();
      render(<Harness />);
      const textarea = composer();
      await user.click(textarea);
      await user.keyboard("Plan tomorrow");
      setChat({ status: "streaming", sendDisabled: false, inputDisabled: false });

      expect(textarea).toBeEnabled();
      expect(textarea).toHaveFocus();
      expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
      for (const button of screen.getAllByRole("button", { name: /command$/u })) {
        expect(button).toBeEnabled();
      }

      await user.keyboard("{Enter}");

      expect(actions.submit).toHaveBeenCalledWith("Plan tomorrow");
      expect(textarea).toHaveValue("");
      expect(textarea).toHaveFocus();
    });

    it("locks the composer and the quick actions while work is blocked", () => {
      render(<Harness />);
      setChat({ sendDisabled: true, inputDisabled: true });

      expect(composer()).toBeDisabled();
      expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
      for (const button of screen.getAllByRole("button", { name: /command$/u })) {
        expect(button).toBeDisabled();
      }
    });

    it("restores focus to a keyboard-activated quick action once the turn settles", async () => {
      render(<Harness />);
      const shortcut = screen.getByRole("button", { name: "Training status, /status command" });
      shortcut.focus();

      act(() => {
        shortcut.click();
      });
      expect(actions.submit).toHaveBeenCalledWith("/status");

      setChat({ sendDisabled: true });
      act(() => {
        (document.activeElement as HTMLElement | null)?.blur();
      });
      setChat({ sendDisabled: false });

      await waitFor(() => {
        expect(document.activeElement).toBe(shortcut);
      });
    });
  });

  describe("queued messages", () => {
    function strip(): HTMLElement | null {
      const element = document.querySelector(".chat-queue");
      return element instanceof HTMLElement ? element : null;
    }

    function texts(): readonly string[] {
      return [...document.querySelectorAll(".chat-queue__text")].map(
        (node) => node.textContent ?? "",
      );
    }

    it("stays out of the way until a message is queued", () => {
      render(<Harness />);
      expect(strip()).toBeNull();

      setChat({
        queued: [{ id: "queued-1", text: "And my long ride?", command: false }],
      });

      expect(strip()).not.toBeNull();
      expect(texts()).toEqual(["And my long ride?"]);
      expect(document.querySelectorAll(".chat-message")).toHaveLength(0);
    });

    it("hands each remove button to the controller with its own message id", async () => {
      const user = userEvent.setup();
      render(<Harness />);
      setChat({
        queued: [
          { id: "queued-1", text: "And my long ride?", command: false },
          { id: "queued-2", text: "/status", command: true },
        ],
      });

      expect(texts()).toEqual(["And my long ride?", "/status"]);
      await user.click(screen.getByRole("button", { name: "Remove queued message 2" }));
      expect(actions.removeQueued).toHaveBeenCalledWith("queued-2");

      await user.click(screen.getByRole("button", { name: "Remove queued message 1" }));
      expect(actions.removeQueued).toHaveBeenNthCalledWith(2, "queued-1");
    });

    it("marks queued commands without restoring the legacy monospace face", () => {
      render(<Harness />);
      setChat({
        queued: [
          { id: "queued-1", text: "And my long ride?", command: false },
          { id: "queued-2", text: "/status", command: true },
        ],
      });

      expect(
        [...document.querySelectorAll(".chat-queue__text")].map((node) =>
          node.classList.contains("chat-queue__command"),
        ),
      ).toEqual([false, true]);
      expect(document.querySelector(".chat-queue__command")).not.toHaveClass("font-mono");
    });

    it("locks removal while work is blocked", async () => {
      const user = userEvent.setup();
      render(<Harness />);
      setChat({
        queued: [{ id: "queued-1", text: "And my long ride?", command: false }],
        workBlocked: true,
      });

      const remove = screen.getByRole("button", { name: "Remove queued message 1" });
      expect(remove).toBeDisabled();
      await user.click(remove);
      expect(actions.removeQueued).not.toHaveBeenCalled();
    });

    it("keeps the strip inert until the chat actions are bound", () => {
      act(() => {
        useEnduragentStore.setState({ chatActions: null });
      });
      render(<Harness />);
      setChat({ queued: [{ id: "queued-1", text: "And my long ride?", command: false }] });

      const remove = screen.getByRole("button", { name: "Remove queued message 1" });
      expect(remove).toBeDisabled();
      act(() => {
        remove.click();
      });
      expect(actions.removeQueued).not.toHaveBeenCalled();
    });
  });

  describe("transcript notice and retry", () => {
    function notice(): HTMLElement {
      const element = document.querySelector(".chat-notice");
      if (!(element instanceof HTMLElement)) throw new TypeError("notice missing");
      return element;
    }

    function retry(): HTMLButtonElement {
      const element = document.querySelector(".chat-retry");
      if (!(element instanceof HTMLButtonElement)) throw new TypeError("retry bar missing");
      return element;
    }

    it("hides the notice until the coach reports progress or an error", () => {
      render(<Harness />);
      expect(notice().hidden).toBe(true);
      expect(notice().textContent).toBe("");

      setChat({ notice: "Coach is working…" });
      expect(notice().hidden).toBe(false);
      expect(notice()).toHaveTextContent("Coach is working…");

      setChat({ notice: "The coach is unreachable right now." });
      expect(notice()).toHaveTextContent("The coach is unreachable right now.");

      setChat({ notice: null });
      expect(notice().hidden).toBe(true);
    });

    it("offers the retry bar only on an interrupted turn and hands the click to the controller", async () => {
      const user = userEvent.setup();
      render(<Harness />);
      expect(retry().hidden).toBe(true);

      setChat({ interrupted: true });
      expect(retry().hidden).toBe(false);
      await user.click(retry());
      expect(actions.retry).toHaveBeenCalledTimes(1);

      setChat({ workBlocked: true });
      expect(retry()).toBeDisabled();
      await user.click(retry());
      expect(actions.retry).toHaveBeenCalledTimes(1);

      setChat({ workBlocked: false, interrupted: false });
      expect(retry().hidden).toBe(true);
    });

    it("keeps the retry bar inert until the chat actions are bound", () => {
      act(() => {
        useEnduragentStore.setState({ chatActions: null });
      });
      render(<Harness />);
      setChat({ interrupted: true });

      act(() => {
        retry().click();
      });
      expect(actions.retry).not.toHaveBeenCalled();
    });
  });

  describe("command chips", () => {
    function messages(...texts: readonly string[]): readonly ChatMessageView[] {
      return texts.map((text, index) => ({
        id: `a${index}`,
        role: "athlete" as const,
        delivery: "complete" as const,
        historical: false,
        text,
      }));
    }

    function chipped(): readonly (string | null)[] {
      return [...document.querySelectorAll(".chat-message--athlete .chat-message__text")].map(
        (node) => (node.classList.contains("chat-message__command") ? "command" : null),
      );
    }

    it("marks athlete turns that open with a known slash command", () => {
      render(<Harness />);
      setChat({
        messages: messages(
          "/status",
          "  /WORKOUT tomorrow  ",
          "/plan my week",
          "what is /status",
          "/synthetic-unknown",
          "Plan my week",
        ),
      });

      expect(chipped()).toEqual(["command", "command", "command", null, null, null]);
    });

    it("leaves the command face off coach turns", () => {
      render(<Harness />);
      setChat({
        messages: [
          {
            id: "c1",
            role: "coach",
            delivery: "complete",
            historical: false,
            text: "/status is a command you can send me.",
          },
        ],
      });

      const coach = document.querySelector(".chat-message--coach .chat-message__text");
      expect(coach?.classList.contains("chat-message__command")).toBe(false);
    });
  });

  describe("hydration controls", () => {
    it("offers load-earlier only while earlier pages remain", async () => {
      const user = userEvent.setup();
      render(<Harness />);
      const load = document.querySelector(".chat-history-load");
      const controls = document.querySelector(".chat-history-controls");
      if (!(load instanceof HTMLButtonElement) || !(controls instanceof HTMLElement)) {
        throw new TypeError("history controls missing");
      }

      expect(controls.hidden).toBe(true);
      expect(load.hidden).toBe(true);

      setChat({ hydrationHasEarlier: true, hydrationStatus: "ready" });
      expect(controls.hidden).toBe(false);
      expect(load.hidden).toBe(false);
      await user.click(load);
      expect(actions.loadEarlier).toHaveBeenCalledTimes(1);

      setChat({ hydrationStatus: "loading" });
      expect(load).toBeDisabled();

      setChat({ hydrationStatus: "ready", workBlocked: true });
      expect(load).toBeDisabled();
    });

    it("swaps to the failure copy and a retry control when history is unavailable", async () => {
      const user = userEvent.setup();
      render(<Harness />);
      setChat({ hydrationHasEarlier: true, hydrationStatus: "failed" });

      const load = document.querySelector(".chat-history-load");
      const failure = document.querySelector(".chat-history-failure");
      const retry = document.querySelector(".chat-history-retry");
      if (
        !(load instanceof HTMLButtonElement) ||
        !(failure instanceof HTMLElement) ||
        !(retry instanceof HTMLButtonElement)
      ) {
        throw new TypeError("history controls missing");
      }

      expect(load.hidden).toBe(true);
      expect(failure.hidden).toBe(false);
      expect(failure.textContent).toBe("Conversation history is temporarily unavailable.");
      expect(retry.hidden).toBe(false);

      await user.click(retry);
      expect(actions.retryHydration).toHaveBeenCalledTimes(1);
    });

    it("auto-loads earlier pages when the transcript is scrolled to the top", () => {
      render(<Harness />);
      setChat({ hydrationHasEarlier: true, hydrationStatus: "ready" });
      const conversation = document.querySelector(".conversation");
      if (!(conversation instanceof HTMLElement)) throw new TypeError("conversation missing");
      Object.defineProperty(conversation, "offsetParent", {
        configurable: true,
        value: document.body,
      });

      conversation.scrollTop = 0;
      act(() => {
        conversation.dispatchEvent(new Event("scroll"));
      });
      expect(actions.loadEarlier).toHaveBeenCalledTimes(1);

      setChat({ hydrationStatus: "loading" });
      act(() => {
        conversation.dispatchEvent(new Event("scroll"));
      });
      expect(actions.loadEarlier).toHaveBeenCalledTimes(1);
    });

    it("ignores scroll resets while the transcript is hidden", () => {
      render(<Harness />);
      setChat({ hydrationHasEarlier: true, hydrationStatus: "ready" });
      const conversation = document.querySelector(".conversation");
      if (!(conversation instanceof HTMLElement)) throw new TypeError("conversation missing");

      conversation.scrollTop = 0;
      act(() => {
        conversation.dispatchEvent(new Event("scroll"));
      });

      expect(actions.loadEarlier).not.toHaveBeenCalled();
    });
  });

  describe("new conversation dialog", () => {
    it("walks the confirm flow and hands focus back to the composer", async () => {
      const user = userEvent.setup();
      render(<Shell onReady={() => {}} />);
      expect(screen.queryByRole("dialog")).toBeNull();

      setChat({ resetPhase: "confirming" });
      const dialog = screen.getByRole("dialog");
      await waitFor(() => {
        expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
      });

      await user.click(screen.getByRole("button", { name: "Start new conversation" }));
      expect(actions.confirmNewConversation).toHaveBeenCalledTimes(1);

      setChat({ resetPhase: "resetting" });
      expect(dialog.getAttribute("aria-busy")).toBe("true");
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Start new conversation" })).toBeDisabled();

      composer().value = "leftover draft";
      setChat({ resetPhase: "idle", resetCount: 1 });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(composer()).toHaveValue("");
      expect(document.activeElement).toBe(composer());
      await waitFor(() => {
        expect(dialog).not.toBeInTheDocument();
      });
    });

    it("returns focus to the opener when the athlete cancels", async () => {
      const user = userEvent.setup();
      useEnduragentStore.setState({
        chat: { ...EMPTY_CHAT_SURFACE, newConversationUnavailable: false },
      });
      render(<Shell onReady={() => {}} />);

      setChat({ resetPhase: "confirming" });
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(actions.cancelNewConversation).toHaveBeenCalledTimes(1);

      setChat({ resetPhase: "idle" });
      await waitFor(() => {
        expect(document.activeElement).toBe(screen.getByRole("button", { name: "New chat" }));
      });
    });

    it("names the restored history in the confirmation copy", () => {
      render(<Harness />);
      setChat({ resetPhase: "confirming" });
      expect(screen.getByText(/Your visible conversation will be cleared\./u)).toBeInTheDocument();

      setChat({ hasHydratedHistory: true });
      expect(
        screen.getByText(/earlier messages restored on this Mac will be cleared/u),
      ).toBeInTheDocument();
    });
  });

  describe("first sync card", () => {
    it("shows nothing until the first sync is under way", () => {
      render(<Harness />);
      expect(document.querySelector(".first-sync")).toBeNull();

      act(() => {
        useEnduragentStore.setState({ firstSync: { status: "syncing" } });
      });
      expect(screen.getByRole("progressbar", { name: "Syncing training history" })).toBeVisible();

      act(() => {
        useEnduragentStore.setState({ firstSync: { status: "ready" } });
      });
      expect(document.querySelector(".first-sync")).toBeNull();
    });

    it("retries a recoverable sync failure and refuses one that needs a relaunch", async () => {
      const user = userEvent.setup();
      render(<Harness />);
      act(() => {
        useEnduragentStore.setState({
          firstSync: { status: "failed", kind: "operation", retryable: true },
        });
      });

      const retry = screen.getByRole("button", { name: "Retry sync" });
      await user.click(retry);
      expect(actions.retryFirstSync).toHaveBeenCalledTimes(1);
      expect(retry).toBeDisabled();

      act(() => {
        useEnduragentStore.setState({
          firstSync: { status: "failed", kind: "protocol", retryable: false },
        });
      });
      expect(screen.queryByRole("button", { name: "Retry sync" })).toBeNull();
      expect(screen.getByText("Quit and reopen Enduragent.")).toBeInTheDocument();
    });
  });

  describe("coach prose", () => {
    function message(patch: Partial<ChatMessageView> & { readonly id: string }): ChatMessageView {
      return {
        role: "coach",
        delivery: "complete",
        historical: false,
        text: "Ride steady on Tuesday.",
        ...patch,
      };
    }

    it("sets the prose face on every coach turn and leaves athlete turns on the interface face", () => {
      render(<Harness />);
      setChat({
        messages: [
          message({ id: "a1", role: "athlete", text: "Plan my week" }),
          message({ id: "c1", delivery: "streaming", text: "Ride " }),
          message({ id: "c2" }),
          message({ id: "c3", historical: true, text: "Nice work last week." }),
        ],
      });

      for (const id of ["c1", "c2", "c3"]) {
        const row = document.querySelector(`[data-message-id="${id}"]`);
        expect(row).toHaveClass("text-base", "leading-[1.6]");
      }
      const athlete = document.querySelector('[data-message-id="a1"]');
      expect(athlete).not.toHaveClass("text-base");
      expect(athlete?.classList.contains("chat-message--athlete")).toBe(true);
    });

    it("keeps the prose face on the row so streaming text never reflows when the turn settles", () => {
      render(<Harness />);
      setChat({ messages: [message({ id: "c1", delivery: "streaming", text: "Ride " })] });
      const row = document.querySelector('[data-message-id="c1"]');
      const streamingClassName = row?.className;

      setChat({ messages: [message({ id: "c1" })] });
      expect(document.querySelector('[data-message-id="c1"]')).toBe(row);
      expect(row?.className).toBe(streamingClassName);
    });

    it("declares the Inter and Geist font foundation", async () => {
      const sourceRoot = resolve(import.meta.dirname, "..", "src");
      const [transcript, tokens, fonts] = await Promise.all([
        readFile(resolve(sourceRoot, "ui/chat/Transcript.tsx"), "utf8"),
        readFile(resolve(sourceRoot, "theme/tokens.css"), "utf8"),
        readFile(resolve(sourceRoot, "theme/fonts.css"), "utf8"),
      ]);
      expect(transcript).toContain("text-base leading-[1.6]");
      expect(tokens).toMatch(/--f-prose:\s*var\(--f-ui\);/u);
      expect(tokens).toMatch(/--f-ui:\s*\n?\s*"Inter Variable", "Inter",/u);
      expect(tokens).toMatch(/--f-mono:\s*\n?\s*"Geist Mono Variable", "Geist Mono",/u);
      expect(tokens).toMatch(
        /body\s*\{[^}]*font-optical-sizing:\s*auto;[^}]*font-feature-settings:\s*"cv01",\s*"ss02";/su,
      );
      expect(fonts).toContain('@import "@fontsource-variable/inter/opsz.css";');
      expect(fonts).toContain('@import "@fontsource-variable/geist-mono/index.css";');
      expect(fonts).not.toContain("dm-sans");
    });

    it("keeps chat core on Tailwind and the Base UI-backed command menu", async () => {
      const sourceRoot = resolve(import.meta.dirname, "..", "src", "ui", "chat");
      const sources = await Promise.all(
        [
          "AthleteMessage.tsx",
          "ChatView.tsx",
          "CoachMessage.tsx",
          "Composer.tsx",
          "HistoryControls.tsx",
          "Message.ts",
          "Notice.tsx",
          "SlashPopup.tsx",
          "StreamingMessage.tsx",
          "Transcript.tsx",
        ].map((name) => readFile(resolve(sourceRoot, name), "utf8")),
      );
      const source = sources.join("\n");
      expect(source).not.toContain(".module.css");
      expect(source).not.toContain("font-mono");
      expect(source).toContain("PopoverContent");
      expect(source).toContain("components/ui/button.js");
      expect(source).toContain("chat-markdown\\\\_\\\\_table-scroll");
    });

    it("keeps chat support cards and dialogs on local UI primitives", async () => {
      const sourceRoot = resolve(import.meta.dirname, "..", "src", "ui", "chat");
      const sources = await Promise.all(
        [
          "FirstSyncCard.tsx",
          "NewConversationDialog.tsx",
          "QueuedMessages.tsx",
          "QuickActions.tsx",
          "SpendNotice.tsx",
        ].map((name) => readFile(resolve(sourceRoot, name), "utf8")),
      );
      const source = sources.join("\n");
      expect(source).not.toContain(".module.css");
      expect(source).not.toContain("font-mono");
      expect(source).toContain("components/ui/button.js");
      expect(source).toContain("components/ui/card.js");
      expect(source).toContain("components/ui/dialog.js");
    });
  });
});
