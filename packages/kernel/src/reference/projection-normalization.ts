import { canonicalJson } from "../archive/canonical.js";
import {
  ActivitySchema,
  WellnessDaySchema,
  type Activity,
  type FtpHistoryPoint,
  type WellnessDay,
} from "./schemas/inputs.js";
import { TP_DENYLIST_FIELDS } from "./trademark-policy.js";

export interface NormalizedWellnessFields {
  fitness?: number | null;
  fatigue?: number | null;
  fitnessContribution?: number | null;
  fatigueContribution?: number | null;
  weeklyFitnessChange?: number | null;
}

export interface NormalizedActivityFields {
  fitnessAtEnd?: number | null;
  fatigueAtEnd?: number | null;
}

declare const __renamedBrand: unique symbol;
export type RenamedActivityRow = Record<string, unknown> & NormalizedActivityFields
  & { readonly [__renamedBrand]: "activity" };
export type RenamedWellnessRow = Record<string, unknown> & NormalizedWellnessFields
  & { readonly [__renamedBrand]: "wellness" };
export interface RenameSummary { skippedNonNumeric: Record<string, number> }

const WELLNESS_TP_TO_PLAIN: ReadonlyArray<readonly [string, keyof NormalizedWellnessFields]> = [
  ["ctl", "fitness"], ["atl", "fatigue"], ["ctlLoad", "fitnessContribution"],
  ["atlLoad", "fatigueContribution"], ["rampRate", "weeklyFitnessChange"],
];
const ACTIVITY_TP_TO_PLAIN: ReadonlyArray<readonly [string, keyof NormalizedActivityFields]> = [
  ["icu_ctl", "fitnessAtEnd"], ["icu_atl", "fatigueAtEnd"],
];

function applyKeyRename(
  raw: Record<string, unknown>,
  mapping: ReadonlyArray<readonly [string, string]>,
  sourceKeys: ReadonlySet<string>,
  summary: RenameSummary | undefined,
): Record<string, unknown> {
  for (const [source, target] of mapping) if (source in raw && target in raw) {
    const targetValue = raw[target];
    if (targetValue !== null && targetValue !== undefined) {
      throw new Error(
        `renameTpFields: collision — input has both source '${source}' and target '${target}' with a non-null value.`
        + " The anti-corruption layer would silently overwrite real data. Update reference/sync/rename-tp-fields.ts.",
      );
    }
  }
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) if (!sourceKeys.has(key)) output[key] = value;
  for (const [source, target] of mapping) {
    if (!(source in raw)) continue;
    const value = raw[source];
    if (typeof value === "number" || value === null) output[target] = value;
    else if (value !== undefined && summary !== undefined) {
      summary.skippedNonNumeric[source] = (summary.skippedNonNumeric[source] ?? 0) + 1;
    }
  }
  return output;
}

export function renameTpFieldsOnWellnessRow(raw: Record<string, unknown>, summary?: RenameSummary): RenamedWellnessRow {
  return applyKeyRename(raw, WELLNESS_TP_TO_PLAIN, new Set(WELLNESS_TP_TO_PLAIN.map(([key]) => key)), summary) as RenamedWellnessRow;
}

export function renameTpFieldsOnActivity(raw: Record<string, unknown>, summary?: RenameSummary): RenamedActivityRow {
  return applyKeyRename(raw, ACTIVITY_TP_TO_PLAIN, new Set(ACTIVITY_TP_TO_PLAIN.map(([key]) => key)), summary) as RenamedActivityRow;
}

export function parseRenamedActivity(row: RenamedActivityRow): Activity { return ActivitySchema.parse(row); }
export function parseRenamedWellnessRow(row: RenamedWellnessRow): WellnessDay { return WellnessDaySchema.parse(row); }

export type RowRejectionReason = "shape" | "decode";

export class RowRejection extends TypeError {
  readonly reason: RowRejectionReason;
  readonly field: string | null;

  constructor(reason: RowRejectionReason, field: string | null = null) {
    super(field === null ? `row rejected: ${reason}` : `row rejected: ${reason} of ${field}`);
    this.name = "RowRejection";
    this.reason = reason;
    this.field = field;
  }
}

const SUBJECTIVE_FATIGUE_WIRE_KEY = "fatigue";
const WELLNESS_SOURCE_KEYS = new Set(WELLNESS_TP_TO_PLAIN.map(([source]) => source));
const WELLNESS_DECODED_ONLY_KEYS = [
  ...WELLNESS_TP_TO_PLAIN.map(([, target]) => target).filter((target) => target !== SUBJECTIVE_FATIGUE_WIRE_KEY),
  "subjectiveFatigue",
];

export function decodeWellnessRow(wire: unknown, summary?: RenameSummary): WellnessDay {
  if (wire === null || typeof wire !== "object" || Array.isArray(wire)) throw new RowRejection("shape");
  const row = wire as Record<string, unknown>;
  for (const key of WELLNESS_DECODED_ONLY_KEYS) if (key in row) throw new RowRejection("decode", key);
  const { [SUBJECTIVE_FATIGUE_WIRE_KEY]: subjectiveFatigue, ...rest } = row;
  const parsed = WellnessDaySchema.safeParse({
    ...applyKeyRename(rest, WELLNESS_TP_TO_PLAIN, WELLNESS_SOURCE_KEYS, summary),
    subjectiveFatigue: subjectiveFatigue ?? null,
  });
  if (!parsed.success) throw new RowRejection("decode", parsed.error.issues[0]?.path.join(".") ?? null);
  const surviving = findTpKey(parsed.data, "");
  if (surviving !== undefined) throw new RowRejection("decode", surviving.key);
  return parsed.data;
}

const DENYLIST = new Set<string>(TP_DENYLIST_FIELDS);
function findTpKey(value: unknown, path: string): { key: string; path: string } | undefined {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findTpKey(value[index], `${path}[${index}]`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (value !== null && typeof value === "object") for (const [key, child] of Object.entries(value)) {
    const childPath = path === "" ? key : `${path}.${key}`;
    if (DENYLIST.has(key)) return { key, path: childPath };
    const found = findTpKey(child, childPath);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function assertNoTpKeysRemain(value: unknown, path = ""): void {
  const found = findTpKey(value, path);
  if (found !== undefined) {
    throw new Error(`assertNoTpKeysRemain: TP-trademarked key surviving rename at ${found.path}`
      + " — update reference/sync/rename-tp-fields.ts");
  }
}

function normalizeStreamKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

export interface DuplicateStreamTypeIssue {
  readonly kind: "DuplicateType";
  readonly type: string;
  readonly count: number;
}

/**
 * The canonical channel map cannot represent duplicate descriptors without
 * choosing one and discarding the others. Raw snapshots retain every
 * descriptor; this error makes the projection fail closed with diagnostics.
 */
export class StreamNormalizationError extends TypeError {
  declare readonly issues: readonly DuplicateStreamTypeIssue[];

  constructor(issues: readonly DuplicateStreamTypeIssue[]) {
    super("duplicate stream descriptor types");
    this.name = "StreamNormalizationError";
    Object.defineProperty(this, "issues", {
      configurable: false,
      enumerable: false,
      value: Object.freeze(issues.map((issue) => Object.freeze({ ...issue }))),
      writable: false,
    });
  }
}

export function normalizeStreams(value: unknown): unknown {
  if (Array.isArray(value)) {
    const output: Record<string, unknown> = {};
    const counts = new Map<string, number>();
    for (const entry of value) if (entry !== null && typeof entry === "object"
      && typeof (entry as Record<string, unknown>).type === "string"
      && Array.isArray((entry as Record<string, unknown>).data)) {
      const type = normalizeStreamKey((entry as Record<string, unknown>).type as string);
      counts.set(type, (counts.get(type) ?? 0) + 1);
      if (!Object.hasOwn(output, type)) {
        output[type] = (entry as Record<string, unknown>).data;
      }
    }
    const issues: DuplicateStreamTypeIssue[] = [];
    for (const [type, count] of counts) {
      if (count > 1) issues.push({ kind: "DuplicateType", type, count });
    }
    if (issues.length > 0) throw new StreamNormalizationError(issues);
    return output;
  }
  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const normalized = normalizeStreamKey(key);
      if (Object.hasOwn(output, normalized) && !Object.is(output[normalized], item)) {
        throw new TypeError("stream key normalization collision");
      }
      output[normalized] = item;
    }
    return output;
  }
  return value;
}

const CYCLING_TYPES = new Set([
  "Ride", "VirtualRide", "GravelRide", "MountainBikeRide", "EBikeRide",
  "EMountainBikeRide", "TrackRide", "Cyclocross", "Handcycle",
]);

export function deriveFtpHistory(wellness: readonly WellnessDay[]): FtpHistoryPoint[] {
  const points: FtpHistoryPoint[] = [];
  let lastFtp: number | null = null;
  const sorted = [...wellness].sort((left, right) => String(left.id).localeCompare(String(right.id)));
  for (const day of sorted) {
    const sportInfo = (day as { sportInfo?: Array<Record<string, unknown>> | null }).sportInfo ?? [];
    let cyclingEftp: number | null = null;
    for (const item of sportInfo) if (typeof item.type === "string" && CYCLING_TYPES.has(item.type)
      && typeof item.eftp === "number" && Number.isFinite(item.eftp)) {
      cyclingEftp = Math.round(item.eftp);
      break;
    }
    if (cyclingEftp === null || cyclingEftp === lastFtp) continue;
    points.push({ date: String(day.id), ftp: cyclingEftp, source: "estimate" });
    lastFtp = cyclingEftp;
  }
  return points;
}

export function compareCanonicalUtf8(left: unknown, right: unknown): number {
  const a = new TextEncoder().encode(canonicalJson(left));
  const b = new TextEncoder().encode(canonicalJson(right));
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}
