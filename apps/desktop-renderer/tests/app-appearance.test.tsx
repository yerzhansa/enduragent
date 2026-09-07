import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App";
import { EMPTY_CHAT_SURFACE } from "../src/state/chat-slice";
import { resetChatStream } from "../src/state/chat-stream";
import { READY_ONBOARDING } from "../src/state/onboarding-slice";
import { useEnduragentStore } from "../src/state/store";
import { paletteCustomProperties, type ResolvedTheme } from "@enduragent/ui";
import { paletteById } from "@enduragent/ui";
import { matchMediaListenerCount, setPrefersDark } from "./matchmedia";

const PALETTE_ID = "patrol";

function stamped(theme: ResolvedTheme): string {
  const value = paletteCustomProperties(paletteById(PALETTE_ID), theme).get("--bg");
  if (value === undefined) throw new TypeError("palette background missing");
  return value;
}

function background(): string {
  return document.documentElement.style.getPropertyValue("--bg");
}

beforeEach(() => {
  useEnduragentStore.setState({
    activeView: "chat",
    runtimeReady: true,
    chat: EMPTY_CHAT_SURFACE,
    chatActions: null,
    onboarding: READY_ONBOARDING,
    paletteId: PALETTE_ID,
    appearance: "system",
  });
});

afterEach(() => {
  useEnduragentStore.setState({
    activeView: "chat",
    chat: EMPTY_CHAT_SURFACE,
    chatActions: null,
    appearance: "system",
  });
  resetChatStream();
});

describe("app appearance", () => {
  it("re-stamps the palette when the operating system flips scheme under System", () => {
    const onReady = vi.fn();
    render(<App onReady={onReady} />);
    act(() => {
      useEnduragentStore.getState().setAppearance("system");
    });

    expect(screen.getByLabelText("Coaching conversation")).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(background()).toBe(stamped("light"));
    expect(useEnduragentStore.getState().theme).toBe("light");

    act(() => {
      setPrefersDark(true);
    });

    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(background()).toBe(stamped("dark"));
    expect(useEnduragentStore.getState().theme).toBe("dark");

    act(() => {
      setPrefersDark(false);
    });

    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(background()).toBe(stamped("light"));
  });

  it("stops listening to the operating system once the athlete pins an appearance", () => {
    render(<App onReady={vi.fn()} />);
    act(() => {
      useEnduragentStore.getState().setAppearance("system");
    });
    expect(matchMediaListenerCount()).toBe(1);

    act(() => {
      useEnduragentStore.getState().setAppearance("light");
    });
    expect(matchMediaListenerCount()).toBe(0);

    act(() => {
      setPrefersDark(true);
    });
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(background()).toBe(stamped("light"));
  });

  it("drops the operating-system listener when the app unmounts", () => {
    const view = render(<App onReady={vi.fn()} />);
    expect(matchMediaListenerCount()).toBe(1);

    view.unmount();
    expect(matchMediaListenerCount()).toBe(0);
  });
});
