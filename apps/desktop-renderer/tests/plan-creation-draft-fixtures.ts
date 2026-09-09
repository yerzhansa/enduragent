import type { PlanCreationAnswerSummary, PlanCreationDraft } from "@enduragent/coach-contract";

export function planCreationDraft(
  answeredSummaries: PlanCreationAnswerSummary[] = [],
): PlanCreationDraft {
  return {
    kind: "draft",
    supportingEvents: [],
    answeredSummaries,
    goal: { kind: "fitness", outcome: "Build steady power", weeks: 4 },
    mode: "flexible",
    start: "1998-09-07",
    end: "1998-10-04",
    spanKind: "Fitness Plan",
    computedWeeks: 4,
    weeks: [1, 2, 3, 4].map((number) => ({
      number,
      start: `1998-09-${String(7 * number).padStart(2, "0")}`,
      end: number === 4 ? "1998-10-04" : `1998-09-${String(7 * number + 6).padStart(2, "0")}`,
      workouts:
        number === 2
          ? []
          : [
              {
                id: `workout-${number}`,
                name: "Endurance ride",
                kind: "endurance",
                date: null,
                minutes: 60,
                pinned: false,
                guidance: "Use comfortable perceived effort or your known heart-rate guidance",
                power: null,
              },
            ],
      notes: number === 2 ? ["Confirmed limits leave no Workouts in this week."] : [],
    })),
    notes: ["Endurance ride limited to 60 minutes by your confirmed limits."],
    guidance: "Use comfortable perceived effort or your known heart-rate guidance",
    ftp: null,
    builderId: "cycling",
    builderVersion: "1",
    inputFingerprint: "a".repeat(64),
    outputFingerprint: "b".repeat(64),
  };
}
