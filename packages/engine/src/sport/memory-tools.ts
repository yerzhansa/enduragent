import { tool, zodSchema } from "ai";
import { z } from "zod";
import type { MemorySectionSpec } from "../sport.js";
import type { MemoryStorePort } from "../host-ports.js";
import { isRealDateKey, parseDateKeyMs, MS_PER_DAY } from "./date-keys.js";
import { truncateUtf16Safe } from "../text-truncate.js";
import { DATE_KEY_RE } from "./date-schema.js";
import { bindToolResult } from "./bound-tool-result.js";
import {
  LEDGER_EVENT_KINDS,
  LEDGER_DATE_PATTERN,
  type LedgerEventKind,
  type LedgerEventSource,
} from "./ledger-event.js";
import type { SourceProvenance } from "../provenance.js";
import { UNKNOWN_PROVENANCE, unionProvenance } from "../provenance.js";

function bindMemoryToolResult(
  memory: MemoryStorePort,
  name: string,
  input: unknown,
  result: unknown,
  truncated?: boolean,
  additionalProvenance?: SourceProvenance,
): unknown {
  const provenance =
    memory.provenanceForToolRead?.(name, input, result, { truncated }) ?? UNKNOWN_PROVENANCE;
  return bindToolResult(result, unionProvenance(provenance, additionalProvenance));
}

function buildMemoryWriteDescription(sections: readonly MemorySectionSpec[]): string {
  const sectionList = sections.map((s) => `${s.name} (${s.hint ?? s.description})`).join("; ");
  return (
    "Write to long-term memory (replaces section content) or daily notes. " +
    `Sections: ${sectionList}.`
  );
}

export function buildMemoryWriteInputSchema(sectionNames: [string, ...string[]]) {
  return z.object({
    type: z
      .enum(["memory", "daily"])
      .describe("'memory' for long-term facts, 'daily' for today's notes"),
    section: z
      .enum(sectionNames)
      .optional()
      .describe(
        "Memory section to write to. REQUIRED when type='memory' — the write replaces the section content.",
      ),
    content: z.string().describe("The information to save"),
  });
}

export const PlanSaveInputSchema = z
  .object({
    name: z.string(),
    primaryGoal: z.string().optional(),
    totalWeeks: z.number().int().positive().optional(),
    status: z.string().optional(),
  })
  .passthrough();

export const MEMORY_READ_CHAT_DESCRIPTION =
  "Read only stored sections that Athlete Context does not show, plus today's notes and plan state.";

export function createMemoryReadTool(
  memory: MemoryStorePort,
  description: string,
  onRead?: (result: string) => void,
  bindProvenance: boolean = false,
  injectedNames?: readonly string[],
) {
  return tool({
    description,
    inputSchema: zodSchema(z.object({})),
    execute: async () => {
      if (memory.refreshPlanReadGate) await memory.refreshPlanReadGate();
      const result =
        memory.getContext(
          injectedNames === undefined ? undefined : { excludeSections: injectedNames },
        ) ||
        (injectedNames === undefined
          ? "No athlete data stored yet."
          : "Every stored section is already in your Athlete Context.");
      onRead?.(result);
      return bindProvenance ? bindMemoryToolResult(memory, "memory_read", {}, result) : result;
    },
  });
}

export function createLedgerAppendTool(
  memory: MemoryStorePort,
  source: LedgerEventSource,
  provenance?: () => SourceProvenance,
  onAppend?: () => void,
) {
  return tool({
    description:
      source === "chat"
        ? "Record a dated event the athlete just stated: decision, override, illness, experiment, outcome. Skip routine training data and anything already in Athlete Context."
        : "Record a dated athlete event (decision, override, illness, experiment, outcome) in the permanent event ledger. Entries are appended, never replaced.",
    inputSchema: zodSchema(
      z.object({
        date: z
          .string()
          .regex(LEDGER_DATE_PATTERN)
          .describe("Event date, YYYY-MM-DD, athlete-local"),
        kind: z.enum(LEDGER_EVENT_KINDS).describe("Event category"),
        text: z
          .string()
          .min(1)
          .describe("One or two sentences, with rationale or outcome when stated"),
      }),
    ),
    execute: async (input: { date: string; kind: LedgerEventKind; text: string }) => {
      const recorded = memory.appendEvent({ ...input, source }, provenance?.());
      if (!recorded) return { recorded: false, duplicate: true };
      onAppend?.();
      return { recorded: true };
    },
  });
}

const MEMORY_QUERY_MAX_RANGE_DAYS = 366;
const MEMORY_QUERY_MAX_RESULT_CHARS = 20_000;
const journalEntrySchema = z.object({
  ts: z.iso.datetime(),
  section: z.string().nullable(),
  op: z.enum(["write-section", "save-plan", "rename-sections"]),
  oldBody: z.string().nullable(),
  newBody: z.string(),
});

function historyBodySummary(body: string | null): string {
  return truncateUtf16Safe((body ?? "").trim().replace(/\s+/g, " "), 200);
}

export function createMemoryQueryTool(memory: MemoryStorePort, bindProvenance: boolean = false) {
  return tool({
    description:
      "Query dated athlete memory: daily notes, the event ledger, and section history over a date range. " +
      "Use this for any question about past notes, decisions, overrides, illness, or " +
      "experiments. Returns matching notes, events, and history grouped by date.",
    inputSchema: zodSchema(
      z.object({
        from: z.string().regex(DATE_KEY_RE).describe("Start date (inclusive), YYYY-MM-DD"),
        to: z.string().regex(DATE_KEY_RE).describe("End date (inclusive), YYYY-MM-DD"),
        query: z
          .string()
          .optional()
          .describe("Case-insensitive substring filter. Omit to return everything in the range."),
      }),
    ),
    execute: async (input: { from: string; to: string; query?: string }) => {
      const { from, to, query } = input;
      if (!isRealDateKey(from) || !isRealDateKey(to)) {
        return `Error: ${from}..${to} contains an invalid calendar date. Use real YYYY-MM-DD dates.`;
      }
      if (from > to) {
        return `Error: 'from' (${from}) is after 'to' (${to}). Swap the bounds.`;
      }
      const rangeDays = (parseDateKeyMs(to) - parseDateKeyMs(from)) / MS_PER_DAY + 1;
      if (rangeDays > MEMORY_QUERY_MAX_RANGE_DAYS) {
        return `Error: range is ${rangeDays} days; the maximum is ${MEMORY_QUERY_MAX_RANGE_DAYS}. Query a narrower range.`;
      }

      const q = query?.toLowerCase();
      const byDate = new Map<string, string[]>();

      for (const { date, text } of memory.readDailyNotesInRange(from, to)) {
        const lines = q ? text.split("\n").filter((l) => l.toLowerCase().includes(q)) : [text];
        if (lines.length > 0) byDate.set(date, lines);
      }

      for (const line of memory.readEventsRaw().split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (typeof parsed !== "object" || parsed === null || !("date" in parsed)) continue;
        const date = parsed.date;
        if (typeof date !== "string" || date < from || date > to) continue;
        if (q && !trimmed.toLowerCase().includes(q)) continue;
        const bucket = byDate.get(date) ?? [];
        bucket.push(`event: ${trimmed}`);
        byDate.set(date, bucket);
      }

      for (const line of memory.readJournalRaw().split("\n")) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const entry = journalEntrySchema.safeParse(parsed);
        if (!entry.success) continue;
        const { ts, section, op, oldBody, newBody } = entry.data;
        const date = ts.slice(0, 10);
        if (date < from || date > to) continue;
        if (q && ![section, oldBody, newBody].some((body) => body?.toLowerCase().includes(q)))
          continue;
        const bucket = byDate.get(date) ?? [];
        bucket.push(
          `history: ${historyBodySummary(section ?? op)} — was: ${historyBodySummary(oldBody)} / now: ${historyBodySummary(newBody)}`,
        );
        byDate.set(date, bucket);
      }

      const header = `Memory query ${from}..${to}` + (query ? ` matching "${query}"` : "");
      if (byDate.size === 0) {
        return `${header}: no daily notes, events, or history found.`;
      }
      const sections = [...byDate.keys()]
        .sort()
        .map((d) => `## ${d}\n${byDate.get(d)!.join("\n")}`);
      const result = [header, ...sections].join("\n\n");
      const truncated = result.length > MEMORY_QUERY_MAX_RESULT_CHARS;
      const visibleResult = truncated
        ? truncateUtf16Safe(result, MEMORY_QUERY_MAX_RESULT_CHARS) +
          "\n[truncated — narrow the date range or add a query term]"
        : result;
      return bindProvenance
        ? bindMemoryToolResult(
            memory,
            "memory_query",
            input,
            visibleResult,
            truncated,
            /(?:^|\n)history:/.test(visibleResult) ? UNKNOWN_PROVENANCE : undefined,
          )
        : visibleResult;
    },
  });
}

export function createMemoryTools(
  memory: MemoryStorePort,
  sections: readonly MemorySectionSpec[],
  opts?: { bindProvenance?: boolean; injectedSectionNames?: readonly string[] },
) {
  if (sections.length === 0) {
    throw new Error(
      "createMemoryTools requires at least one MemorySectionSpec. " +
        "Pass getEffectiveSections(sport) — Core's shared sections guarantee non-empty.",
    );
  }
  const sectionNames = sections.map((s) => s.name) as [string, ...string[]];
  const bindProvenance = opts?.bindProvenance === true;
  return {
    memory_read: createMemoryReadTool(
      memory,
      MEMORY_READ_CHAT_DESCRIPTION,
      undefined,
      bindProvenance,
      opts?.injectedSectionNames ??
        sections.filter((section) => section.inject !== false).map((section) => section.name),
    ),
    memory_query: createMemoryQueryTool(memory, bindProvenance),
    ledger_append: createLedgerAppendTool(memory, "chat"),

    memory_write: tool({
      description: buildMemoryWriteDescription(sections),
      inputSchema: zodSchema(buildMemoryWriteInputSchema(sectionNames)),
      execute: async (input: { type: "memory" | "daily"; section?: string; content: string }) => {
        if (input.type === "memory" && input.section === undefined) {
          return {
            error: "section_required",
            details:
              "type='memory' requires a section. Pick one of the listed sections, or use type='daily' for free-form notes.",
          };
        }
        if (input.type === "memory" && input.section !== undefined) {
          memory.writeSection(input.section, input.content, "chat-tool");
        } else {
          memory.appendDailyNote(input.content);
        }
        return { saved: true };
      },
    }),

    plan_save: tool({
      description:
        "Save the athlete's approved training plan. Replaces the stored plan whole — " +
        "send the full object, unchanged fields included. The host may hold the write " +
        "for athlete confirmation (pendingConfirmation).",
      inputSchema: zodSchema(
        z.object({
          plan: PlanSaveInputSchema.describe("The training plan object to save"),
        }),
      ),
      execute: async (input: { plan: Record<string, unknown> }) => {
        await memory.savePlan(input.plan, "chat-tool");
        return { saved: true };
      },
    }),

    plan_load: tool({
      description: "Load the current active training plan",
      inputSchema: zodSchema(z.object({})),
      execute: async () => {
        const message = memory.refreshPlanReadGate ? await memory.refreshPlanReadGate() : null;
        const result = message ?? memory.loadPlan() ?? { message: "No plan saved yet." };
        return bindProvenance ? bindMemoryToolResult(memory, "plan_load", {}, result) : result;
      },
    }),
  };
}
