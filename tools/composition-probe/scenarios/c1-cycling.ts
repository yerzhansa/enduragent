import type { ProbeScenario } from "../types.js";
import { C1_FORBIDDEN } from "./needle-sets.js";

const c = (id: string, userMessage: string): ProbeScenario => ({
  id,
  class: "c1-cycling",
  userMessage,
  forbiddenNeedles: C1_FORBIDDEN,
  judgeItems: ["sport-scope"],
});

export const C1_CYCLING: ProbeScenario[] = [
  c("c1-01", "My FTP is 250 W. What are my power zones for the bike?"),
  c("c1-02", "Review my last bike ride — the sweet spot session."),
  c("c1-03", "How hard should tomorrow's ride be given my current form?"),
  c("c1-04", "What's a good indoor trainer workout to build threshold on the bike?"),
  c("c1-05", "Plan me a week of cycling in the build phase."),
  c("c1-06", "My legs felt heavy on the bike today. Should I still do intervals tomorrow?"),
  c("c1-07", "Explain what sweet spot means for cycling and when I'd use it."),
  c("c1-08", "How do I structure a 3-hour endurance ride on the bike?"),
];
