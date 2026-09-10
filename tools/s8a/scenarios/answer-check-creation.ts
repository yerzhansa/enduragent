import type { S8aScenario } from "../lib/types.js";
import { STANDARD_ATHLETE } from "./common.js";

export const scenario: S8aScenario = {
  id: "answer-check-creation",
  tier: "live",
  description:
    "Typed commitments and Event Goal success use the production model check and save only after confirmation.",
  frozenNowIso: "1998-09-02T12:00:00.000Z",
  intervals: { athlete: STANDARD_ATHLETE, wellness: [], activities: [] },
  turns: [],
  execution: {
    kind: "answer-check",
    cases: [
      {
        id: "vague-time-off",
        field: "commitments",
        text: "I may be away some days next month.",
        expected: { outcome: "ask", value: null, action: "cancel", savedAnswer: null },
      },
      {
        id: "missing-duration",
        field: "commitments",
        text: "Wednesdays short",
        expected: { outcome: "ask", value: null, action: "cancel", savedAnswer: null },
      },
      {
        id: "skip-commitments",
        field: "commitments",
        text: "ignore",
        expected: {
          outcome: "skip",
          value: null,
          action: "confirm",
          savedAnswer: { kind: "commitments", commitments: { kind: "none" } },
        },
      },
      {
        id: "unclear-success",
        field: "success",
        text: "wtf",
        expected: {
          outcome: "ask",
          value: null,
          action: "skip",
          savedAnswer: {
            kind: "success",
            success: { kind: "event-finish", choice: "finish-comfortably" },
          },
        },
      },
      {
        id: "clear-duration",
        field: "commitments",
        text: "Wednesdays at most 30 minutes",
        expected: {
          outcome: "understood",
          value: [{ kind: "weekday-duration", day: 3, minutes: 30 }],
          action: "confirm",
          savedAnswer: {
            kind: "commitments",
            commitments: {
              kind: "interpreted",
              text: "Wednesdays at most 30 minutes",
              rules: [{ kind: "weekday-duration", day: 3, minutes: 30 }],
              status: "confirmed",
            },
          },
        },
      },
    ],
  },
  recordExpectations: { callers: ["intent-translation"] },
};
