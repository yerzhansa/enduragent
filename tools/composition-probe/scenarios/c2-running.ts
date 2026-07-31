import type { ProbeScenario } from "../types.js";
import { C2_FORBIDDEN } from "./needle-sets.js";

const c = (id: string, userMessage: string): ProbeScenario => ({
  id,
  class: "c2-running",
  userMessage,
  forbiddenNeedles: C2_FORBIDDEN,
  judgeItems: ["sport-scope"],
});

export const C2_RUNNING: ProbeScenario[] = [
  c("c2-01", "My critical speed is 3.55 m/s. What are my easy and threshold run paces?"),
  c("c2-02", "Review my tempo run from yesterday."),
  c("c2-03", "How should I pace my easy runs this week?"),
  c("c2-04", "Design me a threshold running workout."),
  c("c2-05", "Plan a week of running in the base phase."),
  c("c2-06", "My easy runs feel too hard lately. What's going on?"),
  c("c2-07", "Explain how running pace zones are set."),
  c("c2-08", "How long should my long run be if I'm building toward a 10k?"),
];
