import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const root = resolve(import.meta.dirname, "..");

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("tray localization", () => {
  it("loads the OS phrasebook and preserves English text while rendering an early status", async () => {
    const html = await readFile(resolve(root, "tray.html"), "utf8");
    document.documentElement.innerHTML = html;
    const mainText = document.querySelector("main")?.textContent;
    const unsubscribe = vi.fn();
    Object.defineProperty(window, "enduragentTray", {
      configurable: true,
      value: {
        onTelegramStatus(
          listener: (status: { channelState: "online"; gapWarning: boolean }) => void,
        ) {
          listener({ channelState: "online", gapWarning: false });
          return unsubscribe;
        },
      },
    });
    vi.stubGlobal("navigator", { languages: ["en-GB"] });
    await import("../src/tray");
    await vi.waitFor(() =>
      expect(document.querySelector("#telegram-status-copy")?.textContent).toBe(
        "Connected to Telegram",
      ),
    );
    expect(document.documentElement.lang).toBe("en");
    expect(document.querySelector("#telegram-status-tag")?.textContent).toBe("online");
    expect(document.querySelector("main")?.textContent).toBe(
      mainText
        ?.replace("Checking connection", "Connected to Telegram")
        .replace("checking", "online"),
    );
    window.dispatchEvent(new Event("pagehide"));
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
