import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCoachLanguage, type StoredLanguagePreference } from "@enduragent/i18n";
import { createPhrasebook } from "@enduragent/i18n/messages";
import { selectSetupLanguage } from "../src/setup.js";

const prompts = vi.hoisted(() => ({ select: vi.fn(), cancel: vi.fn() }));

vi.mock("@clack/prompts", () => ({
  ...prompts,
  intro: vi.fn(),
  outro: vi.fn(),
  text: vi.fn(),
  password: vi.fn(),
  confirm: vi.fn(),
  isCancel: (value: unknown) => typeof value === "symbol",
  log: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

function languageDoor(initial: StoredLanguagePreference = { value: null, origin: "unset" }) {
  let saved = initial;
  const write = vi.fn(async (value: StoredLanguagePreference["value"]) => {
    saved = { value, origin: "stored" };
    return saved;
  });
  return {
    write,
    language: createCoachLanguage({
      store: { read: async () => saved, write },
      surface: { language: undefined, locale: undefined },
      phrasebooks: createPhrasebook,
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prompts.select.mockResolvedValue("it");
});

describe("setup language choice", () => {
  it("offers the 17 endonyms for an unsupported OS language and saves the choice", async () => {
    const { language, write } = languageDoor();
    await selectSetupLanguage(language, { language: undefined, locale: "kk-KZ" });

    expect(prompts.select).toHaveBeenCalledWith({
      message: "Choose your language",
      options: language.options.map(({ tag, endonym }) => ({ value: tag, label: endonym })),
      initialValue: "en",
    });
    expect(language.options).toHaveLength(17);
    expect(write).toHaveBeenCalledExactlyOnceWith("it");
    expect((await language.current()).value).toBe("it");
  });

  it("skips a supported OS language and saves nothing", async () => {
    const { language, write } = languageDoor();
    await selectSetupLanguage(language, { language: "it", locale: "it-IT" });
    expect(prompts.select).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it.each<StoredLanguagePreference>([
    { value: "it", origin: "stored" },
    { value: null, origin: "stored" },
    { value: "it", origin: "environment", variable: "ENDURAGENT_LANGUAGE" },
  ])("keeps a saved or pinned preference: $origin $value", async (preference) => {
    const { language, write } = languageDoor(preference);
    await selectSetupLanguage(language, { language: undefined, locale: "kk-KZ" });
    expect(prompts.select).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});
