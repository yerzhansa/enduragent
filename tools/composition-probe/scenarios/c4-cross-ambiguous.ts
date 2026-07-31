import type { ProbeScenario } from "../types.js";

const cross = (id: string, userMessage: string): ProbeScenario => ({
  id,
  class: "c4-cross-ambiguous",
  userMessage,
  judgeItems: ["correct-attribution"],
});

const ambiguous = (id: string, userMessage: string): ProbeScenario => ({
  id,
  class: "c4-cross-ambiguous",
  userMessage,
  judgeItems: ["handles-ambiguity"],
});

export const C4_CROSS_AMBIGUOUS: ProbeScenario[] = [
  cross("c4-01", "Is my run fitness ahead of my bike fitness right now?"),
  cross("c4-02", "I'm fresher on the bike than in the pool — how do I read that across sports?"),
  cross("c4-03", "Compare where I stand on the bike versus running as I build toward the triathlon."),
  cross("c4-04", "My swimming feels behind my cycling. How should I weight my week between them?"),
  ambiguous("c4-05", "Should I train hard tomorrow?"),
  ambiguous("c4-06", "I've got 45 minutes free this evening — what should I do?"),
  ambiguous("c4-07", "I'm feeling good today. What's the best session to make it count?"),
  ambiguous("c4-08", "How much recovery do I need after yesterday?"),
];
