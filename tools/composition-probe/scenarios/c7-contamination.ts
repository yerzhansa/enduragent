import type { ProbeScenario } from "../types.js";
import { C2_FORBIDDEN, C3_FORBIDDEN, THRESHOLD_REQUIRED } from "./needle-sets.js";

const run = (id: string, userMessage: string): ProbeScenario => ({
  id,
  class: "c7-contamination",
  userMessage,
  forbiddenNeedles: C2_FORBIDDEN,
  judgeItems: ["sport-scope"],
});

const swim = (id: string, userMessage: string): ProbeScenario => ({
  id,
  class: "c7-contamination",
  userMessage,
  forbiddenNeedles: C3_FORBIDDEN,
  judgeItems: ["sport-scope"],
});

const combined = (id: string, userMessage: string): ProbeScenario => ({
  id,
  class: "c7-contamination",
  userMessage,
  requiredNeedles: THRESHOLD_REQUIRED,
  judgeItems: ["caveat-thresholds", "caveat-cost"],
});

export const C7_CONTAMINATION: ProbeScenario[] = [
  run("c7-01", "How steady was my heart rate on that run relative to pace over the second half?"),
  run("c7-02", "Was my easy run actually easy, or was I drifting into a harder effort?"),
  run("c7-03", "Break down the effort in my hill run this morning."),
  swim("c7-04", "How intense was my swim set — was I working near my limit?"),
  swim("c7-05", "Judge the effort in my main swim set today."),
  swim("c7-06", "Was my pool session more of an endurance or a hard day?"),
  combined("c7-07", "Give me one combined training load number across my swim, bike, and run this week."),
  combined("c7-08", "Add up my total load across all three sports and tell me what it means."),
];
