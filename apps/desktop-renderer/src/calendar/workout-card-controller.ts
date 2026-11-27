export type WorkoutCardState =
  | { readonly kind: "closed" }
  | { readonly kind: "open"; readonly planId: string; readonly workoutId: string };

export const WORKOUT_CARD_CLOSED: WorkoutCardState = Object.freeze({ kind: "closed" });

export interface WorkoutCardController {
  open(planId: string, workoutId: string): void;
  close(): void;
  askCoach(draft: string): void;
}

export function createWorkoutCardController(deps: {
  composerText(): string;
  prefillComposer(text: string): void;
  openChangeInChat(): void;
  publish(state: WorkoutCardState): void;
}): WorkoutCardController {
  let state: WorkoutCardState = WORKOUT_CARD_CLOSED;
  const publish = (next: WorkoutCardState): void => {
    state = next;
    deps.publish(next);
  };
  return {
    open(planId, workoutId) {
      if (state.kind === "open" && state.planId === planId && state.workoutId === workoutId) {
        return;
      }
      publish({ kind: "open", planId, workoutId });
    },
    close() {
      if (state.kind === "closed") return;
      publish(WORKOUT_CARD_CLOSED);
    },
    askCoach(draft) {
      if (state.kind !== "open") return;
      publish(WORKOUT_CARD_CLOSED);
      if (deps.composerText().trim().length === 0) deps.prefillComposer(draft);
      deps.openChangeInChat();
    },
  };
}
