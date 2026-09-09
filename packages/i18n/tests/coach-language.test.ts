import { expect, it, vi } from "vitest";
import type { LanguageTag } from "@enduragent/coach-contract";
import {
  createCoachLanguage,
  LANGUAGE_OPTIONS,
  type LanguagePreferenceStore,
} from "../src/index.js";
import * as detector from "../src/detect-message-language.js";
import { createPhrasebook } from "../src/messages.js";

it("skips message detection for stored and environment preferences", async () => {
  const detection = vi.spyOn(detector, "detectMessageLanguage");
  try {
    for (const origin of ["stored", "environment"] as const) {
      const store: LanguagePreferenceStore = {
        async read() {
          return { value: "it", origin };
        },
        async write(value) {
          return { value, origin };
        },
      };
      const language = createCoachLanguage({
        store,
        surface: { language: "en", locale: "fr-BE" },
        phrasebooks: createPhrasebook,
      });
      expect(
        await language.resolveFor({ athleteText: "今日は自転車の練習について相談したいです" }),
      ).toEqual({ language: "it", source: "preference", locale: "fr-BE" });
      expect(language.options).toBe(LANGUAGE_OPTIONS);
    }
    expect(detection).not.toHaveBeenCalled();
  } finally {
    detection.mockRestore();
  }
});

it("caches phrasebooks by resolved language and locale while re-reading preferences", async () => {
  let value: LanguageTag | null = null;
  const phrasebooks = vi.fn(createPhrasebook);
  const language = createCoachLanguage({
    store: {
      async read() {
        return { value, origin: "stored" };
      },
      async write(next) {
        value = next;
        return { value, origin: "stored" };
      },
    },
    surface: { language: "en", locale: "en-GB" },
    phrasebooks,
  });
  const request = {
    chatId: "synthetic-chat",
    athleteText: "/review",
    surfaceHint: { language: "it" as const, locale: "it-IT" },
  };
  const [first, concurrent] = await Promise.all([
    language.phrasebookFor(request),
    language.phrasebookFor(request),
  ]);
  expect(first).toBe(concurrent);
  expect(first.say("common.cancel")).toBe("Annulla");
  expect(phrasebooks).toHaveBeenCalledTimes(1);
  await language.set("ja");
  const japanese = await language.phrasebookFor(request);
  expect(japanese.say("common.cancel")).toBe("キャンセル");
  expect(japanese.locale).toBe("it-IT");
  expect(phrasebooks).toHaveBeenCalledTimes(2);
  await language.set(null);
  expect(await language.phrasebookFor(request)).toBe(first);
  await language.phrasebookFor({ ...request, surfaceHint: { language: "it", locale: "fr-BE" } });
  expect(phrasebooks).toHaveBeenCalledTimes(3);
  const detected = await language.phrasebookFor({
    ...request,
    athleteText: "오늘 자전거 훈련을 어떻게 해야 할까요",
  });
  expect(detected.tag).toBe("ko");
});

it("retries failed phrasebook loads", async () => {
  const phrasebooks = vi
    .fn(createPhrasebook)
    .mockRejectedValueOnce(new Error("catalog unavailable"));
  const language = createCoachLanguage({
    store: {
      async read() {
        return { value: null, origin: "unset" };
      },
      async write(value) {
        return { value, origin: "stored" };
      },
    },
    surface: { language: "en", locale: "en-GB" },
    phrasebooks,
  });
  await expect(language.phrasebookFor({})).rejects.toThrow("catalog unavailable");
  expect((await language.phrasebookFor({})).tag).toBe("en");
  expect(phrasebooks).toHaveBeenCalledTimes(2);
});

it("reads fresh preferences for current state and each turn, including Automatic", async () => {
  let value: LanguageTag | null = null;
  const store: LanguagePreferenceStore = {
    async read() {
      return { value, origin: "stored" };
    },
    async write(next) {
      value = next;
      return { value, origin: "stored" };
    },
  };
  const language = createCoachLanguage({
    store,
    surface: { language: "fr", locale: undefined },
    phrasebooks: createPhrasebook,
  });
  expect(
    await language.resolveFor({ athleteText: "오늘 자전거 훈련을 어떻게 해야 할까요" }),
  ).toEqual({ language: "ko", source: "message", locale: "ko-KR" });
  expect(await language.current()).toEqual({
    value: null,
    origin: "stored",
    resolved: { language: "fr", source: "surface", locale: "fr-FR" },
  });
  expect(await language.set("de")).toEqual({ value: "de", origin: "stored" });
  expect((await language.resolveFor({})).language).toBe("de");
  await language.set(null);
  expect(await language.resolveFor({ athleteText: "/review" })).toEqual({
    language: "fr",
    source: "surface",
    locale: "fr-FR",
  });
});
