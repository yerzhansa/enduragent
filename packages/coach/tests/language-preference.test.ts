import { describe, expect, it, vi } from "vitest";
import { createCoachLanguage } from "@enduragent/i18n";
import {
  asLanguagePreferenceStore,
  createLanguagePreferenceService,
} from "../src/language-preference.js";

function fixture(language: string | null = null) {
  let saved = language;
  const set = vi.fn(async (value: string | null) => {
    saved = value;
  });
  const service = createLanguagePreferenceService(
    { read: async () => ({ language: saved }), set },
    {
      now: () => 300,
      randomBytes: () => new Uint8Array(10),
    },
  );
  return { service, set };
}

describe("language preference service", () => {
  it("mints a validated stamp with the injected clock", async () => {
    const { service, set } = fixture();
    await expect(service.set("it")).resolves.toEqual({ value: "it" });
    expect(set).toHaveBeenCalledWith("it", {
      id: "000000009C0000000000000000",
      deviceId: "desktop:000000009C0000000000000000",
      now: 300,
    });
    await expect(service.get()).resolves.toEqual({ value: "it" });
    await expect(service.set(null)).resolves.toEqual({ value: null });
  });

  it("maps unsupported stored strings to unset", async () => {
    const { service } = fixture("xx");
    await expect(service.get()).resolves.toEqual({ value: null });
    await expect(asLanguagePreferenceStore(service).read()).resolves.toEqual({
      value: null,
      origin: "unset",
    });
  });

  it("revalidates writes before mutation", async () => {
    const { service, set } = fixture();
    await expect(service.set("xx" as never)).rejects.toThrow();
    expect(set).not.toHaveBeenCalled();
  });

  it("lets the shared language resolver observe preference changes and clearing", async () => {
    const { service } = fixture();
    const language = createCoachLanguage({
      store: asLanguagePreferenceStore(service),
      surface: { language: "fr", locale: "fr-BE" },
    });
    await expect(language.resolveFor({ athleteText: "ok" })).resolves.toEqual({
      language: "fr",
      source: "surface",
      locale: "fr-BE",
    });
    await expect(language.set("it")).resolves.toEqual({ value: "it", origin: "stored" });
    await expect(language.resolveFor({ athleteText: "Hello" })).resolves.toEqual({
      language: "it",
      source: "preference",
      locale: "fr-BE",
    });
    await expect(language.set(null)).resolves.toEqual({ value: null, origin: "unset" });
  });
});
