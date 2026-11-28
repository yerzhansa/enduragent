import { describe, expect, it } from "vitest";
import { createPhrasebook } from "@enduragent/i18n/messages";
import { workoutSummary } from "../src/ui/plan/workout-summary";

const english = await createPhrasebook({ tag: "en", locale: "en-GB" });
const guidance = "Use comfortable perceived effort or your known heart-rate guidance";

describe("workoutSummary", () => {
  it("keeps the guidance on a workout without content", () => {
    expect(workoutSummary(english, { name: "Endurance ride", minutes: 60, guidance })).toBe(
      `Endurance ride · 60 min · ${guidance}`,
    );
  });

  it("leaves the guidance off a workout that has content, wherever it is shown", () => {
    expect(
      workoutSummary(english, {
        name: "Endurance ride",
        minutes: 60,
        guidance,
        content: { version: 1 },
      }),
    ).toBe("Endurance ride · 60 min");
  });
});
