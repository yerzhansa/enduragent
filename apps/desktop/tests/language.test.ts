import { describe, expect, it, vi } from "vitest";
import { createPhrasebook, type Phrasebook } from "@enduragent/i18n/messages";
import { createDesktopLanguage } from "../src/main/language.js";
import { startupRefusalCopy } from "../src/main/lifecycle-messages.js";

describe("desktop language", () => {
  it("prefers the saved Italian preference and renders a dialog through the injected phrasebook", async () => {
    const italian = await createPhrasebook({ tag: "it", locale: "it-IT" });
    const injected: Phrasebook = {
      ...italian,
      say(message) {
        const key = typeof message === "string" ? message : message.key;
        if (key === "desktop.lifecycle.notConfiguredTitle") return "Enduragent non è configurato";
        if (key === "desktop.lifecycle.notConfiguredContent") return "Ripristina config.yaml.";
        throw new Error("Unexpected dialog key");
      },
    };
    const load = vi.fn<typeof createPhrasebook>(async (input) =>
      input.tag === "it" ? injected : createPhrasebook(input),
    );
    const language = await createDesktopLanguage({ preferredLanguages: ["en-US"], load });
    language.bind(async () => "it");
    await language.refresh();
    expect(language.current().tag).toBe("it");
    expect(startupRefusalCopy("not-configured", "darwin", language.current())).toEqual({
      title: "Enduragent non è configurato",
      content: "Ripristina config.yaml.",
    });
    await language.refresh();
    expect(load.mock.calls.map(([input]) => input.tag)).toEqual(["en", "it"]);
  });

  it("uses the supported OS hint when the daemon is absent, unset, or unreachable", async () => {
    const language = await createDesktopLanguage({ preferredLanguages: ["xx", "it_IT"] });
    expect(language.current().tag).toBe("it");
    language.bind(async () => null);
    await language.refresh();
    expect(language.current().tag).toBe("it");
    language.bind(async () => "en");
    await language.refresh();
    expect(language.current().tag).toBe("en");
    language.bind(async () => {
      throw new Error("offline");
    });
    await language.refresh();
    expect(language.current().tag).toBe("it");
    language.bind(undefined);
    expect(language.current().tag).toBe("it");
  });

  it("falls back to English for unsupported hints and failed catalog imports", async () => {
    const unsupported = await createDesktopLanguage({ preferredLanguages: ["xx-ZZ"] });
    expect(unsupported.current().tag).toBe("en");
    const load = vi.fn<typeof createPhrasebook>(async (input) => {
      if (input.tag === "it") throw new Error("catalog unavailable");
      return createPhrasebook(input);
    });
    const language = await createDesktopLanguage({ preferredLanguages: ["it"], load });
    expect(language.current().tag).toBe("en");
    language.bind(async () => "it");
    await language.refresh();
    expect(language.current().tag).toBe("en");
    expect(load.mock.calls.map(([input]) => input.tag)).toEqual(["it", "en"]);
  });

  it("ignores a saved preference returned after the daemon binding is lost", async () => {
    const language = await createDesktopLanguage({ preferredLanguages: ["en"] });
    let resolvePreference: (value: "it") => void = () => {
      throw new Error("Missing resolver");
    };
    const pending = new Promise<"it">((resolve) => {
      resolvePreference = resolve;
    });
    language.bind(() => pending);
    const refresh = language.refresh();
    language.bind(undefined);
    resolvePreference("it");
    await refresh;
    expect(language.current().tag).toBe("en");
  });
});
