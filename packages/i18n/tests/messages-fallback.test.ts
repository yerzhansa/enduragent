import { expect, it, vi } from "vitest";
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
