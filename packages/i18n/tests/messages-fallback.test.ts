import { describe, expect, it, vi } from "vitest";
import { createPhrasebook } from "../src/messages.js";

vi.mock("../catalogs/it.json", () => ({ default: { common: { cancel: "Annulla" } } }));

it("falls back to the English catalog when a translated key is absent", async () => {
  const book = await createPhrasebook({ tag: "it", locale: "it-IT" });
  expect(book.say("common.cancel")).toBe("Annulla");
  expect(book.say("common.save")).toBe("Save");
  expect(book.say("settings.language.automaticDetail", { operatingSystem: "macOS" })).toBe(
    "Automatic follows your macOS language. The coach replies in the language you write in.",
  );
});

describe("catalog chunk failure", () => {
  it("degrades a language whose catalog chunk cannot load to English", async () => {
    vi.resetModules();
    vi.doMock("../catalogs/it.json", () => {
      throw new Error("chunk unavailable");
    });
    const { createPhrasebook } = await import("../src/messages.js");
    const italian = await createPhrasebook({ tag: "it", locale: "it-IT" });
    expect(italian.say("common.cancel")).toBe("Cancel");
    vi.doUnmock("../catalogs/it.json");
  });
});
