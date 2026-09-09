import { expect, it, vi } from "vitest";
import type { LanguageTag } from "@enduragent/coach-contract";
import {
  createCoachLanguage,
  LANGUAGE_OPTIONS,
  type LanguagePreferenceStore,
} from "../src/index.js";
import * as detector from "../src/detect-message-language.js";

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
      const language = createCoachLanguage({ store, surface: { language: "en", locale: "fr-BE" } });
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
  const language = createCoachLanguage({ store, surface: { language: "fr", locale: undefined } });
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
