import { RowRejection, type RowRejectionReason } from "@enduragent/kernel/reference/local-bundle";
import { WellnessColumnsSchema, WellnessDaySchema } from "@enduragent/kernel/reference/schemas";
import { compareBinary, isCivilDate } from "./cursor.js";
import { IntervalsHttpError } from "./http.js";
import type { DroppedActivityRowEvidence } from "./types.js";
import { BULK_SAFE_ACTIVITY_ID } from "./zip.js";

export type CaptureLane = "settings" | "activities" | "wellness" | "streams";

export type RowPhase = "fetch" | "decode" | "landing";

export type RowDropReason = RowRejectionReason | "source-restricted" | "fetch" | "unclassified";

export const DROP_ERROR_NAMES = ["Error", "TypeError", "RangeError", "SyntaxError", "ZodError"] as const;
export type DropErrorName = (typeof DROP_ERROR_NAMES)[number];

export interface RowDrop {
  readonly lane: CaptureLane;
  readonly payloadIndex: number | null;
  readonly externalId: string | null;
  readonly localDate: string | null;
  readonly phase: RowPhase;
  readonly reason: RowDropReason;
  readonly field: string | null;
  readonly errorName: DropErrorName | null;
}

export type RowOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly drop: RowDrop };

export interface RowSite {
  readonly lane: CaptureLane;
  readonly payloadIndex: number | null;
  readonly activityId?: string;
}

export interface LaneReport {
  readonly fetched: number;
  readonly landed: number;
  readonly drops: readonly RowDrop[];
  readonly unfetched: readonly RowDrop[];
}

export type CaptureReport = Readonly<Record<CaptureLane, LaneReport>>;

const SOURCE_RESTRICTED_PROVIDER = "STRAVA";
const MAX_DROP_ID_LENGTH = 64;
const WELLNESS_FIELDS: ReadonlySet<string> = new Set([
  ...Object.keys(WellnessDaySchema.shape),
  ...Object.keys(WellnessColumnsSchema.shape),
]);

function fields(payload: unknown): Readonly<Record<string, unknown>> {
  return payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown> : {};
}

export function isSourceRestrictedRow(entry: unknown): boolean {
  return fields(entry).source === SOURCE_RESTRICTED_PROVIDER;
}

export function civilDatePrefix(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const date = value.slice(0, 10);
  return isCivilDate(date) ? date : null;
}

function safeActivityId(id: unknown): string | null {
  if (typeof id === "number") return Number.isSafeInteger(id) ? String(id) : null;
  return typeof id === "string" && id.length <= MAX_DROP_ID_LENGTH && BULK_SAFE_ACTIVITY_ID.test(id) ? id : null;
}

function rowIdentity(site: RowSite, payload: unknown): Pick<RowDrop, "externalId" | "localDate"> {
  const row = fields(payload);
  if (site.lane === "streams") {
    const activityId = safeActivityId(site.activityId);
    return { externalId: activityId === null ? null : `streams:${activityId}`, localDate: null };
  }
  if (site.lane === "settings") {
    return { externalId: typeof row.id === "number" && Number.isSafeInteger(row.id) ? String(row.id) : null, localDate: null };
  }
  if (site.lane === "activities") return { externalId: safeActivityId(row.id), localDate: civilDatePrefix(row.start_date_local) };
  const date = typeof row.id === "string" && isCivilDate(row.id) ? row.id : null;
  return { externalId: date, localDate: date };
}

function dropFor(phase: RowPhase, site: RowSite, payload: unknown, error: unknown): RowDrop {
  const row = { lane: site.lane, payloadIndex: site.payloadIndex, ...rowIdentity(site, payload) };
  if (site.lane === "activities" && isSourceRestrictedRow(payload)) {
    return { ...row, phase, reason: "source-restricted", field: null, errorName: null };
  }
  if (error instanceof RowRejection) {
    const declared = site.lane === "wellness" && error.field !== null && WELLNESS_FIELDS.has(error.field);
    return { ...row, phase: error.reason === "landing" ? "landing" : "decode", reason: error.reason,
      field: declared ? error.field : null, errorName: null };
  }
  if (error instanceof IntervalsHttpError) {
    return { ...row, phase, reason: "fetch", field: `http_${error.status}`, errorName: null };
  }
  const name = error instanceof Error ? DROP_ERROR_NAMES.find((allowed) => allowed === error.name) : undefined;
  return { ...row, phase, reason: "unclassified", field: null, errorName: name ?? null };
}

export async function attempt<T>(
  phase: RowPhase,
  site: RowSite,
  payload: unknown,
  land: () => T | Promise<T>,
  endsCapture: (error: unknown) => boolean = () => false,
): Promise<RowOutcome<T>> {
  try {
    return { ok: true, value: await land() };
  } catch (error) {
    if (endsCapture(error)) throw error;
    return { ok: false, drop: dropFor(phase, site, payload, error) };
  }
}

export class LaneTally {
  private fetched = 0;
  private landed = 0;
  private readonly drops: RowDrop[] = [];
  private readonly unfetched: RowDrop[] = [];

  constructor(readonly lane: CaptureLane) {}

  take<T>(outcome: RowOutcome<T>): T | undefined {
    if (!outcome.ok) {
      this.drops.push(this.own(outcome.drop));
      this.fetched += 1;
      return undefined;
    }
    this.fetched += 1;
    this.landed += 1;
    return outcome.value;
  }

  missed(drop: RowDrop): void {
    this.unfetched.push(this.own(drop));
  }

  report(): LaneReport {
    return Object.freeze({
      fetched: this.fetched,
      landed: this.landed,
      drops: Object.freeze([...this.drops]),
      unfetched: Object.freeze([...this.unfetched]),
    });
  }

  private own(drop: RowDrop): RowDrop {
    if (drop.lane !== this.lane) throw new TypeError("row drop belongs to another lane");
    return Object.freeze({ ...drop });
  }
}

export function activityDropEvidence(report: LaneReport): DroppedActivityRowEvidence {
  const sourceRestricted = report.drops.filter((drop) => drop.reason === "source-restricted").length;
  const dated = report.drops.flatMap((drop) => drop.localDate === null ? [] : [drop.localDate]);
  return Object.freeze({
    sourceRestricted,
    other: report.drops.length - sourceRestricted,
    datedLocalDates: Object.freeze([...new Set(dated)].sort(compareBinary)),
    undatedCount: report.drops.length - dated.length,
  });
}

export type LaneHealth = "ok" | "partial" | "lost";

export function laneHealth(report: LaneReport): LaneHealth {
  if (report.drops.every((drop) => drop.reason === "source-restricted")) return "ok";
  return report.landed === 0 ? "lost" : "partial";
}

export interface LaneStanding {
  readonly health: LaneHealth;
  readonly fetched: number;
  readonly landed: number;
}

export function laneStanding(report: LaneReport): LaneStanding {
  return Object.freeze({ health: laneHealth(report), fetched: report.fetched, landed: report.landed });
}

export interface CaptureHealth {
  readonly status: "ok" | "degraded";
  readonly lanes: Readonly<Record<CaptureLane, LaneHealth>>;
}

export const CAPTURE_LANES: readonly CaptureLane[] = Object.freeze(["settings", "activities", "wellness", "streams"]);

export function captureHealth(report: CaptureReport): CaptureHealth {
  const lanes = { settings: laneHealth(report.settings), activities: laneHealth(report.activities),
    wellness: laneHealth(report.wellness), streams: laneHealth(report.streams) };
  return Object.freeze({
    status: CAPTURE_LANES.some((lane) => lanes[lane] === "lost") ? "degraded" : "ok",
    lanes: Object.freeze(lanes),
  });
}

export function formatRowDrop(drop: RowDrop): string {
  const index = drop.payloadIndex === null ? "" : `[${drop.payloadIndex}]`;
  const field = drop.field === null ? "" : ` of ${drop.field}`;
  const name = drop.errorName === null ? "" : ` (${drop.errorName})`;
  return `${drop.lane}${index} ${drop.phase}: ${drop.reason}${field}${name}`;
}
