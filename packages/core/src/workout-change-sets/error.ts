import type { Notice } from "./record.js";

export type WorkoutProblemReason = Extract<Notice, { kind: "blocked" }>["reason"];

export class WorkoutChangeError extends Error {
  constructor(
    readonly reason: WorkoutProblemReason,
    message: string,
  ) {
    super(message);
    this.name = "WorkoutChangeError";
  }
}
