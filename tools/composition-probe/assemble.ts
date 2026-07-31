import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  ATHLETE_CONTEXT_FENCE_CLOSE,
  ATHLETE_CONTEXT_FENCE_OPEN,
  SYSTEM_PROMPT_CACHE_BOUNDARY,
  staticRuleBlocks,
} from "../../packages/core/src/agent/system-prompt.js";

const TOOL_NAME_SUBSTITUTIONS: Array<[string, string]> = [
  ["intervals_fetch_activities", "activities_list"],
  ["intervals_fetch_activity", "activity_detail"],
];

function mockPath(rel: string): string {
  return fileURLToPath(new URL(`./mock/${rel}`, import.meta.url));
}

function readMock(rel: string): string {
  return readFileSync(mockPath(rel), "utf-8").trimEnd();
}

function substituteToolNames(block: string): string {
  let out = block;
  for (const [from, to] of TOOL_NAME_SUBSTITUTIONS) {
    out = out.split(from).join(to);
  }
  return out;
}

const DEEP_PROTOCOL_LIBRARY = `# Deep Protocol Library

Detailed protocols are NOT in this prompt. Taper ladders, fueling tables, drill
catalogs, test protocols, return-to-run ladders, and brick session structure all
live behind the skill_read tool. Before answering a question that needs specific
numbers, call skill_read(sport, topic) with one of these pairs:

- skill_read(sport: "cycling", topic: "taper")
- skill_read(sport: "cycling", topic: "fueling")
- skill_read(sport: "running", topic: "return-to-run")
- skill_read(sport: "running", topic: "fueling")
- skill_read(sport: "swimming", topic: "drills")
- skill_read(sport: "swimming", topic: "css-test")
- skill_read(sport: "multisport", topic: "brick")`;

export function buildMockPrompt(): { block1: string; block2: string; fullSystem: string } {
  const soul = readMock("soul.md");
  const cycling = readMock("core-cycling.md");
  const running = readMock("core-running.md");
  const swimming = readMock("core-swimming.md");
  const athlete = readMock("athlete-context.md");

  const sportCores = ["# Sport Cores", cycling, running, swimming].join("\n\n");
  const ruleBlocks = staticRuleBlocks(30).map(substituteToolNames);

  const block1 = [soul, sportCores, DEEP_PROTOCOL_LIBRARY, ...ruleBlocks].join("\n\n");

  const markerText = SYSTEM_PROMPT_CACHE_BOUNDARY.replace(/^\n\n---\n\n/, "");
  const athleteBlock =
    "# Athlete Context\n\n" +
    ATHLETE_CONTEXT_FENCE_OPEN +
    "\n" +
    athlete +
    "\n" +
    ATHLETE_CONTEXT_FENCE_CLOSE;
  const dateBlock = "# Current Date & Time\n\nTime zone: UTC";

  const block2 = [markerText, athleteBlock, dateBlock].join("\n\n");
  const fullSystem = block1 + "\n\n" + block2;

  return { block1, block2, fullSystem };
}
