import type { ProbeScenario } from "../types.js";
import { C3_FORBIDDEN } from "./needle-sets.js";

const c = (id: string, userMessage: string): ProbeScenario => ({
  id,
  class: "c3-swimming",
  userMessage,
  forbiddenNeedles: C3_FORBIDDEN,
  judgeItems: ["sport-scope"],
});

export const C3_SWIMMING: ProbeScenario[] = [
  c("c3-01", "My critical swim pace is 1:45 per 100m. What are my swim zones?"),
  c("c3-02", "Review my swim session from this morning."),
  c("c3-03", "How should I pace a threshold swim set?"),
  c("c3-04", "Design me a swim workout to build endurance in the pool."),
  c("c3-05", "Plan a week of swimming for someone weak in the water."),
  c("c3-06", "My swim splits are drifting slower late in the set. Why?"),
  c("c3-07", "Explain how swim pace zones work off the critical swim pace."),
  c("c3-08", "What's a good main set for a 1500m open-water target?"),
];
