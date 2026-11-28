import { shownWorkoutGuidance } from "@enduragent/coach-contract";
import type { Phrasebook } from "@enduragent/i18n/messages";

export function workoutSummary(
  phrasebook: Pick<Phrasebook, "say" | "format">,
  workout: {
    readonly name: string;
    readonly minutes: number;
    readonly guidance: string;
    readonly content?: unknown;
  },
): string {
  const minutes = phrasebook.format.number(workout.minutes, { useGrouping: false });
  const guidance = workout.content === undefined ? shownWorkoutGuidance(workout.guidance) : null;
  return guidance === null
    ? phrasebook.say("chat.planCreation.workoutSummaryNoGuidance", { name: workout.name, minutes })
    : phrasebook.say("chat.planCreation.workoutSummary", { name: workout.name, minutes, guidance });
}
