import type { ProbeScenario } from "../types.js";

const c = (
  id: string,
  userMessage: string,
  skillTarget: { sport: string; topic: string },
): ProbeScenario => ({
  id,
  class: "c9-deep-protocol",
  userMessage,
  skillTarget,
  judgeItems: ["used-skill-content"],
});

export const C9_DEEP_PROTOCOL: ProbeScenario[] = [
  c("c9-01", "Give me the exact day-by-day taper percentages for my 40k time trial.", { sport: "cycling", topic: "taper" }),
  c("c9-02", "Exactly how many grams of carbohydrate per hour should I take on a 3-hour race ride, and what blend?", { sport: "cycling", topic: "fueling" }),
  c("c9-03", "Walk me through the exact walk-run steps to get back to running after a niggle.", { sport: "running", topic: "return-to-run" }),
  c("c9-04", "Give me the precise drill set to clean up my freestyle catch.", { sport: "swimming", topic: "drills" }),
  c("c9-05", "What's the exact pool test protocol to set my critical swim pace?", { sport: "swimming", topic: "css-test" }),
  c("c9-06", "Give me the exact structure of a race-specific brick session.", { sport: "multisport", topic: "brick" }),
];
