import { shownWorkoutGuidance } from "@enduragent/coach-contract";
import type { Phrasebook } from "@enduragent/i18n/messages";

export function workoutSummary(
  phrasebook: Pick<Phrasebook, "say" | "format">,
  workout: { readonly name: string; readonly minutes: number; readonly guidance: string },
): string {
  const minutes = phrasebook.format.number(workout.minutes, { useGrouping: false });
  const guidance = shownWorkoutGuidance(workout.guidance);
  return guidance === null
    ? phrasebook.say("chat.planCreation.workoutSummaryNoGuidance", { name: workout.name, minutes })
    : phrasebook.say("chat.planCreation.workoutSummary", { name: workout.name, minutes, guidance });
}
