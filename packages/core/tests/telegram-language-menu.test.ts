import { LANGUAGE_OPTIONS } from "@enduragent/i18n";
import { describe, expect, it } from "vitest";
import { languageKeyboard, parseLanguageCallback } from "../src/channels/telegram-language-menu.js";

describe("Telegram language keyboard", () => {
  it("places Automatic and the ordered endonyms in six rows of three", () => {
    const { inline_keyboard: rows } = languageKeyboard({ value: null, origin: "unset" });
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.length === 3)).toBe(true);
    expect(rows.flat()).toEqual([
      { text: "✓ Automatic", callback_data: "lang:auto" },
      ...LANGUAGE_OPTIONS.map(({ tag, endonym }) => ({
        text: endonym,
        callback_data: `lang:${tag}`,
      })),
    ]);
  });

  it.each(LANGUAGE_OPTIONS)("marks only the saved $tag choice", ({ tag, endonym }) => {
    const buttons = languageKeyboard({ value: tag, origin: "stored" }).inline_keyboard.flat();
    expect(buttons.filter(({ text }) => text.startsWith("✓ "))).toEqual([
      { text: `✓ ${endonym}`, callback_data: `lang:${tag}` },
    ]);
  });

  it("marks Automatic after the stored preference is cleared", () => {
    expect(languageKeyboard({ value: null, origin: "stored" }).inline_keyboard[0]?.[0]).toEqual({
      text: "✓ Automatic",
      callback_data: "lang:auto",
    });
  });

  it("marks the effective environment choice", () => {
    const buttons = languageKeyboard({
      value: "fr",
      origin: "environment",
      variable: "ENDURAGENT_LANGUAGE",
    }).inline_keyboard.flat();
    expect(buttons.filter(({ text }) => text.startsWith("✓ "))).toEqual([
      { text: "✓ Français", callback_data: "lang:fr" },
    ]);
  });
});

describe("Telegram language callback parser", () => {
  it.each(LANGUAGE_OPTIONS)("parses $tag", ({ tag }) => {
    expect(parseLanguageCallback(`lang:${tag}`)).toBe(tag);
  });

  it("parses Automatic as absence", () => {
    expect(parseLanguageCallback("lang:auto")).toBeNull();
  });

  it.each([
    "",
    "cg:y:nonce",
    "lang:",
    "lang:automatic",
    "lang:ru",
    "lang:en-US",
    "lang:EN",
    "lang:en:extra",
    " lang:en",
  ])("rejects %j", (data) => {
    expect(parseLanguageCallback(data)).toBeUndefined();
  });
});
