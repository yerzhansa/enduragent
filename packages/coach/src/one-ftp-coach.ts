import { Memory } from "@enduragent/core";
import {
  bindToolResult,
  boundToolResultProvenance,
  unwrapBoundToolResult,
} from "@enduragent/engine";
import {
  createMemoryTools,
  getEffectiveSections,
  type MemorySectionSpec,
  type MemorySnapshot,
  type PreserveTokens,
  type Sport,
} from "@enduragent/engine/sport";
import { cyclingSport } from "@enduragent/sport-cycling";

const SAVE_DETAILS = "personal details (FTP, weight,";
const SHOWN_FTP = "FTP (see intervals.icu)";
const NUMBER = String.raw`\d{2,3}(?:\.\d+)?(?!\d)`;
const UNIT = String.raw`(?:\s*(?:W|watts)\b)`;
const FTP_VALUE = new RegExp(
  String.raw`\bFTP\b\s*(?:[:=]\s*)?(?:(?:is|was|of|now|set to)\s+)*${NUMBER}${UNIT}?|\b${NUMBER}${UNIT}\s+FTP\b`,
  "giu",
);
const SHOWN_FTP_PATTERN = /FTP \(see intervals\.icu\)/gu;
const TARGETS = new Set(["goals", "Current Plan"]);
const GOAL_HISTORY = /^history: goals\b/u;

export const ONE_FTP_COACH_SKILL = [
  "The athlete's FTP is the one in intervals.icu; the app keeps no FTP of its own.",
  "When the athlete asks to change their FTP, say it lives in intervals.icu: they set it there, and the app reads it at the next sync.",
  "If they want the coach's proposed number, point them to FTP history on Activity review, where Use sets it in intervals.icu after a confirm.",
  "Never save an FTP to memory, and never offer a Plan change for FTP.",
].join("\n");

const DESKTOP_SECTIONS: Readonly<Record<string, Partial<MemorySectionSpec>>> = {
  "cycling-profile": {
    description:
      "Max HR, resting HR, W/kg ratio, experience level. " +
      "Body data lives in `person`; this is cycling-specific physiology.",
    hint: "max/resting HR, W/kg, experience level",
    factExample: "- Max HR 188 bpm (athlete, 2026-06-08)",
  },
  "cycling-history": {
    description:
      "Cycling-specific injuries (knee, lower back, fit issues), " +
      "recovery patterns from rides, ride-related sleep/HRV trends. " +
      "Chronic conditions belong in `medical-history`, not here.",
    hint: "cycling injuries, ride recovery patterns",
  },
};

export function redactFtpValue(text: string): string {
  return text.replace(FTP_VALUE, SHOWN_FTP);
}

export function redactStoredFtp(context: string): string {
  let section: string | null = null;
  return context
    .split("\n")
    .map((line) => {
      const heading = /^## (.+)$/u.exec(line);
      if (heading !== null) section = heading[1] ?? null;
      return heading !== null || (section !== null && TARGETS.has(section))
        ? line
        : redactFtpValue(line);
    })
    .join("\n");
}

function redactQueryResult(result: unknown): unknown {
  const value = unwrapBoundToolResult(result);
  if (typeof value !== "string") return result;
  const redacted = value
    .split("\n")
    .map((line) => (GOAL_HISTORY.test(line) ? line : redactFtpValue(line)))
    .join("\n");
  const provenance = boundToolResultProvenance(result);
  return provenance === undefined ? redacted : bindToolResult(redacted, provenance);
}

export class OneFtpMemory extends Memory {
  private readingStoredContext = false;

  override getContext(opts?: { excludeSections?: readonly string[] }): string {
    const context = super.getContext(opts);
    return this.readingStoredContext ? context : redactStoredFtp(context);
  }

  override getContextWithProvenance(opts?: {
    excludeSections?: readonly string[];
    maxChars?: number;
  }): ReturnType<Memory["getContextWithProvenance"]> {
    this.readingStoredContext = true;
    try {
      return super.getContextWithProvenance(opts);
    } finally {
      this.readingStoredContext = false;
    }
  }

  override writeSection(...args: Parameters<Memory["writeSection"]>): void {
    const [section, content, ...rest] = args;
    const stored = [...(this.readSection(section) ?? "").matchAll(FTP_VALUE)].map(
      (match) => match[0],
    );
    let next = 0;
    super.writeSection(
      section,
      content.replace(SHOWN_FTP_PATTERN, (shown) => stored[next++] ?? shown),
      ...rest,
    );
  }
}

function withoutFtpTokens(tokens: PreserveTokens): PreserveTokens {
  const kept = ("tokens" in tokens ? tokens.tokens : tokens).filter(
    (token) => !/^FTP \d+W$/u.test(token),
  );
  return "tokens" in tokens ? { ...tokens, tokens: kept } : kept;
}

export function withOneFtpCoachRules<T extends Sport>(sport: T): T {
  const memorySections = sport.memorySections.map((section) => ({
    ...section,
    ...DESKTOP_SECTIONS[section.name],
  }));
  const desktop: T = {
    ...sport,
    soul: sport.soul.replace(SAVE_DETAILS, "personal details (weight,"),
    skills: { ...sport.skills, "one-ftp": ONE_FTP_COACH_SKILL },
    memorySections,
    coreSectionText: {
      person: {
        description:
          "Name, weight (kg), age, available training days per week. " +
          "The athlete's FTP lives in intervals.icu; never save it.",
        hint: "name, weight, age, available training days",
      },
    },
    mustPreserveTokens: (memory: MemorySnapshot) =>
      withoutFtpTokens(
        typeof sport.mustPreserveTokens === "function"
          ? sport.mustPreserveTokens(memory)
          : sport.mustPreserveTokens,
      ),
    tools: (deps) => {
      const memoryTools = createMemoryTools(deps.memory, getEffectiveSections(desktop), {
        bindProvenance: deps.bindMemoryToolProvenance,
      });
      const write = memoryTools.memory_write;
      const query = memoryTools.memory_query;
      const redactedQuery = {
        ...query,
        execute: async (...input: Parameters<NonNullable<typeof query.execute>>) =>
          redactQueryResult(await query.execute?.(...input)),
      };
      return sport.tools(deps).map((tool) => {
        if (tool.name === "memory_write")
          return { ...tool, description: write.description ?? "", tool: write };
        if (tool.name === "memory_query") return { ...tool, tool: redactedQuery };
        return tool;
      });
    },
  };
  return desktop;
}

export const oneFtpCyclingSport = withOneFtpCoachRules(cyclingSport);
