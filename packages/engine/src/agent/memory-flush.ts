import { tool, zodSchema, stepCountIs } from "ai";
import type { ModelMessage } from "ai";
import { z } from "zod";
import type { MemorySectionSpec } from "../sport.js";
import type { MemoryStorePort } from "../host-ports.js";
import { createLedgerAppendTool } from "../sport/memory-tools.js";
import type { LLM } from "../llm.js";
import type { GenerateResult } from "../sport.js";
import type { TurnBudget } from "./turn-budget.js";
import { warnOrphanSections } from "../sport/orphan-sections.js";
import {
  EMPTY_PROVENANCE,
  provenanceOfMessages,
  unionProvenance,
  type SourceProvenance,
} from "../provenance.js";
import { todayInTZ } from "../sport/user-time.js";
import { wrapAthleteContextFence } from "./prompt-fence.js";
import { ATHLETE_CONTEXT_MAX_CHARS } from "./system-prompt.js";

// ============================================================================
// CONSTANTS
// ============================================================================

export const SOFT_THRESHOLD_RATIO = 0.8;

export const FLUSH_COOLDOWN_MESSAGES = 5;

export function shouldRunMemoryFlush(params: {
  estimatedTokens: number;
  tokenBudget: number;
  lastFlushMessageCount: number;
  currentMessageCount: number;
}): boolean {
  if (params.currentMessageCount - params.lastFlushMessageCount < FLUSH_COOLDOWN_MESSAGES) {
    return false;
  }
  return params.estimatedTokens > params.tokenBudget * SOFT_THRESHOLD_RATIO;
}

export const FLUSH_ZERO_WRITE_MIN_MESSAGES = 4;
export const FLUSH_SHRINK_MIN_CHARS = 200;
export const FLUSH_SHRINK_RATIO = 0.7;

// Prompt-layer target size for always-injected sections, used only by the flush
// budget nudge (below) and the render-time cap math — it emits no event and
// gates no write. This is a DIFFERENT number and layer from the store-level
// `SECTION_SOFT_WARN_CHARS` (4000) in store.ts: that 4000 is a store-hygiene
// backstop that warns on EVERY section write; this 1500 is the target size for
// the small always-injected sections so the injected Athlete Context stays lean.
export const MEMORY_SECTION_BUDGET_CHARS = 1500;

export interface MemoryFlushOutcome {
  writes: number;
  ledgerAppends: number;
  finishReason: GenerateResult["finishReason"];
  usage: GenerateResult["usage"];
  shrunkSections: Array<{ section: string; beforeChars: number; afterChars: number }>;
}

// ============================================================================
// PROMPTS
// ============================================================================

const MEMORY_FLUSH_SYSTEM_PROMPT = `You are reviewing a conversation to extract and save important athlete
information before it is summarized. Use the memory_write tool to save
details into the appropriate section. Each section is fully replaced on
write, so include ALL current facts for that section, not just new ones.
Use the ledger_append tool to record dated events (decisions, overrides,
illness, experiment outcomes); ledger entries are appended, never replaced.`;

function renderCurrentMemory(memory: MemoryStorePort): string {
  const current = memory.getContextWithProvenance?.() ?? { text: memory.getContext() };
  const text = current.text || "No athlete data stored yet.";
  return wrapAthleteContextFence({ text, maxChars: ATHLETE_CONTEXT_MAX_CHARS });
}

function buildFlushUserPrompt(
  sections: readonly MemorySectionSpec[],
  currentMemory: string,
  today: string,
): string {
  const sectionList = sections.map((s) => `- "${s.name}": ${s.description}`).join("\n");
  return `Review the new conversation messages above and save athlete details to
structured memory sections. The current memory is shown below; write each
section that has new or updated information.

Write to these sections using memory_write:
${sectionList}

For each section you write, include ALL current facts for that section
(both from memory and from the conversation). This fully replaces the
section content — omitted facts will be lost.

Dating discipline for durable facts:
- Append "(<source>, <YYYY-MM-DD>)" to each material fact — who stated it
  (athlete, coach, intervals.icu) and the date it was last confirmed.
  Example: "- FTP 252W (athlete, 2026-06-08)".
- When carrying an unchanged fact forward, keep its existing source and date;
  re-date a fact only when this conversation re-confirmed it.
- If a fact's date is more than 6 months before today, keep the fact and
  append "(re-confirm)" so it can be verified with the athlete.
- Never write "_updated:" lines yourself; the system stamps each section's
  update date automatically.

Keep each section under ~${MEMORY_SECTION_BUDGET_CHARS} characters. When a
section would grow past that, do NOT let it balloon: move the dated or episodic
detail (specific workouts, day-by-day observations, one-off events) out to the
event ledger (ledger_append), and keep only the current durable facts in the
section itself. Nothing is dropped — ledger entries stay reachable through
memory_query.

Today is ${today}.

Also record dated events in the permanent event ledger using ledger_append:
- decisions made with the athlete, with the rationale
- times the athlete overrode, declined, or changed a recommendation
- illness, injury, or pain mentions (acute ones count — they need no memory section)
- experiment outcomes (what was tried, what happened)
Date each event (YYYY-MM-DD) with the day it happened, which may be earlier
than today. Record only events from this conversation; never re-record
events that earlier reviews already saved.

Only write sections that have new or changed information.

Current memory:

${currentMemory}`;
}

// ============================================================================
// APPEND-ONLY MEMORY WRITE TOOL
// ============================================================================

function createFlushMemoryWriteTool(
  memory: MemoryStorePort,
  sections: readonly MemorySectionSpec[],
  provenanceFor: (section: string) => SourceProvenance,
  onWrite: () => void,
) {
  const sectionNames = sections.map((s) => s.name) as [string, ...string[]];
  return tool({
    description: "Write to a memory section (replaces entire section content)",
    inputSchema: zodSchema(
      z.object({
        section: z.enum(sectionNames).describe("Which section to write"),
        content: z.string().describe("Complete section content — include ALL facts for this section"),
      }),
    ),
    execute: async (input: { section: string; content: string }) => {
      memory.writeSection(input.section, input.content, "flush", provenanceFor(input.section));
      onWrite();
      return { saved: true };
    },
  });
}

// ============================================================================
// CHRONIC-KEYWORD CONVERGENCE SCAN
// ============================================================================

// Substring matches against `cycling-history` body after each flush. Fires a
// structured warn if chronic content (which belongs in `medical-history`) is
// still parked in cycling-history — observability for the section-migration
// "convergence over 1-3 flushes" assumption from ADR-0003. Substring matching
// is intentional (catches plurals like "medications" via "medication"); expand
// the list as we observe real data.
export const CHRONIC_KEYWORDS = [
  "hypertension",
  "diabetes",
  "asthma",
  "chronic",
  "lisinopril",
  "metformin",
  "statins",
  "long-term",
  "medication",
] as const;

function scanForStuckChronic(memory: MemoryStorePort): void {
  const cyclingHistory = memory.readSection("cycling-history");
  if (!cyclingHistory) return;
  const lower = cyclingHistory.toLowerCase();
  const matches = CHRONIC_KEYWORDS.filter((k) => lower.includes(k));
  if (matches.length === 0) return;
  // Log only the count — the matched keywords are the athlete's actual
  // conditions/medications and must not land in logs.
  console.warn(
    JSON.stringify({
      event: "chronic_facts_stuck_in_cycling_history",
      matchCount: matches.length,
      hint: "Run another memory_flush; if persists, manually move to medical-history",
    }),
  );
}

// ============================================================================
// MEMORY FLUSH
// ============================================================================

export async function runMemoryFlush(params: {
  llm: LLM;
  messages: ModelMessage[];
  memory: MemoryStorePort;
  memorySections: readonly MemorySectionSpec[];
  tz?: string;
  budget?: Pick<TurnBudget, "chargeGenerateCall">;
}): Promise<MemoryFlushOutcome> {
  if (params.memorySections.length === 0) {
    throw new Error(
      "runMemoryFlush requires at least one memory section. " +
        "Pass getEffectiveSections(sport) — Core's shared sections guarantee non-empty.",
    );
  }
  let writes = 0;
  let ledgerAppends = 0;
  const currentMemory = renderCurrentMemory(params.memory);
  const conversationProvenance = provenanceOfMessages(params.messages);
  const beforeChars = new Map(
    params.memorySections.map((s) => [s.name, (params.memory.readSection(s.name) ?? "").length]),
  );
  const flushTools = {
    memory_write: createFlushMemoryWriteTool(
      params.memory,
      params.memorySections,
      (section) =>
        unionProvenance(
          conversationProvenance,
          params.memory.provenanceForSection?.(section) ?? EMPTY_PROVENANCE,
        ),
      () => {
        writes++;
      },
    ),
    ledger_append: createLedgerAppendTool(
      params.memory,
      "flush",
      () => conversationProvenance,
      () => {
        ledgerAppends++;
      },
    ),
  };

  params.budget?.chargeGenerateCall();
  const result = await params.llm.generate({
    system: MEMORY_FLUSH_SYSTEM_PROMPT,
    messages: [
      ...params.messages,
      {
        role: "user" as const,
        content: buildFlushUserPrompt(
          params.memorySections,
          currentMemory,
          todayInTZ(params.tz ?? "UTC"),
        ),
      },
    ],
    tools: flushTools,
    stopWhen: stepCountIs(5),
    maxSteps: 5,
    caller: "flush",
  });

  params.memory.reload();
  scanForStuckChronic(params.memory);
  warnOrphanSections(params.memory, params.memorySections);

  const shrunkSections: MemoryFlushOutcome["shrunkSections"] = [];
  for (const spec of params.memorySections) {
    const before = beforeChars.get(spec.name) ?? 0;
    const after = (params.memory.readSection(spec.name) ?? "").length;
    if (before >= FLUSH_SHRINK_MIN_CHARS && after < before * FLUSH_SHRINK_RATIO) {
      shrunkSections.push({ section: spec.name, beforeChars: before, afterChars: after });
      // Char counts only — section bodies are athlete data and must not land in logs.
      console.warn(
        JSON.stringify({
          event: "memory_flush_section_shrunk",
          section: spec.name,
          beforeChars: before,
          afterChars: after,
        }),
      );
    }
  }

  if (
    writes === 0 &&
    ledgerAppends === 0 &&
    params.messages.length >= FLUSH_ZERO_WRITE_MIN_MESSAGES
  ) {
    console.warn(
      JSON.stringify({
        event: "memory_flush_zero_writes",
        messageCount: params.messages.length,
        finishReason: result.finishReason,
        outputTokens: result.usage.outputTokens ?? null,
      }),
    );
  }

  return {
    writes,
    ledgerAppends,
    finishReason: result.finishReason,
    usage: result.usage,
    shrunkSections,
  };
}
