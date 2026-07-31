import type { ProbeScenario } from "../types.js";
import { C1_CYCLING } from "./c1-cycling.js";
import { C2_RUNNING } from "./c2-running.js";
import { C3_SWIMMING } from "./c3-swimming.js";
import { C4_CROSS_AMBIGUOUS } from "./c4-cross-ambiguous.js";
import { C5_INTEGRATED } from "./c5-integrated.js";
import { C6_ANCHOR_TRAPS } from "./c6-anchor-traps.js";
import { C7_CONTAMINATION } from "./c7-contamination.js";
import { C8_TOOL_CHOICE } from "./c8-tool-choice.js";
import { C9_DEEP_PROTOCOL } from "./c9-deep-protocol.js";

export const ALL_SCENARIOS: ProbeScenario[] = [
  ...C1_CYCLING,
  ...C2_RUNNING,
  ...C3_SWIMMING,
  ...C4_CROSS_AMBIGUOUS,
  ...C5_INTEGRATED,
  ...C6_ANCHOR_TRAPS,
  ...C7_CONTAMINATION,
  ...C8_TOOL_CHOICE,
  ...C9_DEEP_PROTOCOL,
];
