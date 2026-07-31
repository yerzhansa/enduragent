import type { ProbeScenario } from "../types.js";

const c = (id: string, userMessage: string): ProbeScenario => ({
  id,
  class: "c5-integrated",
  userMessage,
  judgeItems: ["integrated-coherent"],
});

export const C5_INTEGRATED: ProbeScenario[] = [
  c("c5-01", "Review my brick from Saturday — 90 min bike into a 25 min run."),
  c("c5-02", "Synthesize my triathlon training load this week across swim, bike, and run."),
  c("c5-03", "Plan my race week for the Olympic-distance tri, touching all three disciplines."),
  c("c5-04", "I raced the bike leg hard yesterday and my run today felt awful. Is that interference or just fatigue?"),
  c("c5-05", "How do I sequence a hard swim, a bike interval day, and a long run across one week without digging a hole?"),
  c("c5-06", "Given my current fatigue across all three sports, what should this week look like?"),
];
