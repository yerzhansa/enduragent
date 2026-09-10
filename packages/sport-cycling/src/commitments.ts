export type CommitmentRule =
  | { kind: "weekday-duration"; day: number; minutes: number }
  | { kind: "weekday-unavailable"; day: number }
  | { kind: "hard-weekday"; day: number }
  | { kind: "time-off"; start: string; end: string };
