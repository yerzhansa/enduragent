import { describe, expect, it } from "vitest";
import type { Sport } from "../src/sport.js";
import { getEffectiveSections } from "../src/sport/effective-sections.js";
import { CORE_SHARED_SECTIONS } from "../src/sport/shared-sections.js";

function sport(extra: Partial<Sport> = {}): Sport {
  return {
    id: "cycling",
    soul: "",
    skills: {},
    sessionClusterGapMinutes: 30,
    memorySections: [{ name: "cycling-profile", description: "Max HR" }],
    mustPreserveTokens: () => [],
    intervalsActivityTypes: [],
    athleteProfileSchema: {} as never,
    tools: () => [],
    ...extra,
  };
}

describe("a sport's wording for Core memory sections", () => {
  it("replaces only the description and hint of the Core section it names", () => {
    const effective = getEffectiveSections(
      sport({ coreSectionText: { person: { description: "Name and weight.", hint: "name" } } }),
    );
    const core = CORE_SHARED_SECTIONS.find((section) => section.name === "person");
    expect(effective.find((section) => section.name === "person")).toEqual({
      ...core,
      description: "Name and weight.",
      hint: "name",
    });
    expect(effective.filter((section) => section.name !== "person")).toEqual(
      getEffectiveSections(sport()).filter((section) => section.name !== "person"),
    );
  });

  it("keeps Core's wording for a sport that names none", () => {
    expect(getEffectiveSections(sport()).slice(0, CORE_SHARED_SECTIONS.length)).toEqual(
      CORE_SHARED_SECTIONS,
    );
  });
});
