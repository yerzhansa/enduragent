import {
  LANGUAGE_OPTIONS,
  msg,
  type LanguageTag,
  type StoredLanguagePreference,
} from "@enduragent/i18n";
import type { Phrasebook } from "@enduragent/i18n/messages";
import type { InlineKeyboardMarkup } from "grammy/types";

export function languageKeyboard(
  state: StoredLanguagePreference,
  phrasebook: Phrasebook,
): InlineKeyboardMarkup {
  const choices = [
    {
      text: phrasebook.say(msg("telegram.language.automatic")),
      callback_data: "lang:auto",
      value: null,
    },
    ...LANGUAGE_OPTIONS.map(({ tag, endonym }) => ({
      text: endonym,
      callback_data: `lang:${tag}`,
      value: tag,
    })),
  ];
  const buttons = choices.map(({ text, callback_data, value }) => ({
    text: value === state.value ? `✓ ${text}` : text,
    callback_data,
  }));
  const inline_keyboard: InlineKeyboardMarkup["inline_keyboard"] = [];
  for (let index = 0; index < buttons.length; index += 3) {
    inline_keyboard.push(buttons.slice(index, index + 3));
  }
  return { inline_keyboard };
}

export function parseLanguageCallback(data: string): LanguageTag | null | undefined {
  if (data === "lang:auto") return null;
  return LANGUAGE_OPTIONS.find(({ tag }) => data === `lang:${tag}`)?.tag;
}
