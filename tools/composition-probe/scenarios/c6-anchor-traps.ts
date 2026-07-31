import type { ProbeScenario } from "../types.js";

const c = (id: string, userMessage: string, forbiddenNeedles: RegExp[]): ProbeScenario => ({
  id,
  class: "c6-anchor-traps",
  userMessage,
  forbiddenNeedles,
  judgeItems: ["anchor-correct"],
});

export const C6_ANCHOR_TRAPS: ProbeScenario[] = [
  c("c6-01", "What's my critical speed pace for the run, in m/s?", [/\bCSS\b/, /critical swim speed/i]),
  c("c6-02", "My critical swim speed is 1:45 per 100m — what's my threshold swim pace?", [/critical speed\b/i, /\bFTP\b/]),
  c("c6-03", "What's my threshold pace for the swim leg of the tri?", [/\bFTP\b/, /\bwatts?\b/i]),
  c("c6-04", "Give me my run threshold speed — is that the same number as my critical speed?", [/\bCSS\b/, /\/100m/]),
  c("c6-05", "Convert my swim pace target into a per-100m number, not a speed in m/s.", [/\bwatts?\b/i, /\bFTP\b/]),
  c("c6-06", "Is my bike threshold the same idea as critical speed on the run?", [/critical swim speed/i]),
  c("c6-07", "What units should I read my swim critical pace in?", [/\bwatts?\b/i]),
  c("c6-08", "For the run, is critical speed a pace or a power number?", [/\bwatts?\b/i, /\bFTP\b/]),
];
