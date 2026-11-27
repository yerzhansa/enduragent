import type { PlanRecord } from "@enduragent/kernel/planning";

const PHASE_NAME_LIMIT = 128;

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shown(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > PHASE_NAME_LIMIT ? `${trimmed.slice(0, PHASE_NAME_LIMIT - 1)}…` : trimmed;
}

export function phaseForWeek(plan: PlanRecord, weekIndex: number | null): string | null {
  if (weekIndex === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(plan.structureJson);
  } catch {
    return null;
  }
  if (!record(parsed) || !Array.isArray(parsed.phases)) return null;
  let throughWeek = 0;
  for (const candidate of parsed.phases) {
    if (!record(candidate)) continue;
    const duration = candidate.durationWeeks;
    if (!Number.isSafeInteger(duration) || Number(duration) < 1) continue;
    throughWeek += Number(duration);
    if (weekIndex > throughWeek) continue;
    const name = typeof candidate.name === "string" ? shown(candidate.name) : null;
    if (name !== null) return name;
    return typeof candidate.focus === "string" ? shown(candidate.focus.replaceAll("_", " ")) : null;
  }
  return null;
}
