import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { JUDGE_MODEL_ID } from "./constants.js";
import { ALL_SCENARIOS } from "./scenarios/index.js";
import type { JudgeVerdict, TranscriptLine } from "./types.js";

const judgeVerdictSchema = z.object({
  mixing: z.object({
    flag: z.boolean(),
    evidence: z.string().nullable(),
    sportsInvolved: z.array(z.string()),
  }),
  items: z.record(z.string(), z.object({ pass: z.boolean(), note: z.string() })),
});

export class JudgeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgeParseError";
  }
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fence ? fence[1].trim() : trimmed;
}

export function parseJudgeVerdict(text: string): JudgeVerdict {
  const body = stripJsonFence(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new JudgeParseError("judge reply is not valid JSON");
  }
  const result = judgeVerdictSchema.safeParse(parsed);
  if (!result.success) {
    throw new JudgeParseError("judge reply does not match the verdict shape");
  }
  return result.data;
}

export function computeFlagged(line: TranscriptLine): boolean {
  if (line.needleHits.length > 0) return true;
  if (line.judge?.mixing.flag) return true;
  if (line.judge && Object.values(line.judge.items).some((it) => !it.pass)) return true;
  return false;
}

function rubricPath(): string {
  return fileURLToPath(new URL("./rubric.md", import.meta.url));
}

export async function runJudgePass(transcriptFile: string, apiKey: string): Promise<number> {
  const raw = readFileSync(transcriptFile, "utf-8").split("\n").filter((l) => l.trim().length > 0);
  const lines: TranscriptLine[] = raw.map((l) => JSON.parse(l) as TranscriptLine);

  if (lines.some((l) => l.error)) {
    console.error("judge: transcript carries an errored line; re-run --phase=run for this model first.");
    return 2;
  }

  const rubric = readFileSync(rubricPath(), "utf-8");
  const { LLM } = await import("../../packages/core/src/llm.js");
  const llm = new LLM({
    llm: { provider: "anthropic", model: JUDGE_MODEL_ID, apiKey, baseUrl: undefined },
    dataDir: mkdtempSync(join(tmpdir(), "probe-judge-")),
  } as unknown as import("../../packages/core/src/config.js").Config);

  const judgeItemsById = new Map(ALL_SCENARIOS.map((s) => [s.id, s.judgeItems ?? []]));

  let unparseable = 0;
  for (const line of lines) {
    const prompt = JSON.stringify({
      scenarioClass: line.class,
      judgeItems: judgeItemsById.get(line.scenarioId) ?? [],
      userMessage: line.userMessage,
      assistantText: line.assistantText,
      toolCallNames: line.toolCalls.map((t) => t.toolName),
    });
    let verdict: JudgeVerdict | undefined;
    for (let attempt = 0; attempt < 2 && !verdict; attempt++) {
      const res = await llm.generate({ system: rubric, prompt, maxOutputTokens: 1024, caller: "chat" });
      try {
        verdict = parseJudgeVerdict(res.text);
      } catch {
        verdict = undefined;
      }
    }
    if (!verdict) {
      unparseable += 1;
      continue;
    }
    line.judge = verdict;
    line.flagged = computeFlagged(line);
  }

  if (unparseable / lines.length > 0.05) {
    console.error(`judge: ${unparseable}/${lines.length} turns unparseable after retry — halting the judge phase.`);
    return 2;
  }

  writeFileSync(transcriptFile, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
  return 0;
}
