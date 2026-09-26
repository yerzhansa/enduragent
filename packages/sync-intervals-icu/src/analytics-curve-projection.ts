import {
  AthleteHeartRateCurveSetSchema,
  AthletePowerCurveSetSchema,
  decode,
} from "intervals-icu-api";
import type {
  ReferenceBundle,
  VerifiedSnapshotReader,
} from "@enduragent/kernel/reference/local-bundle";
import { ANALYTICS_CURVE_PARTS, type AnalyticsCurveState } from "@enduragent/kernel/store";

const MAX_PROJECTED_AXIS_LENGTH = 65_536;
const ACTIVITY_TYPES = Object.freeze(["Ride", "VirtualRide"] as const);

type CurrentAnalyticsCurves = NonNullable<AnalyticsCurveState["current"]>;
type ActivityType = (typeof ACTIVITY_TYPES)[number];
type CurveFamily = "power" | "heart-rate";
type CurveProjection = Required<
  Pick<ReferenceBundle, "powerCurves" | "hrCurves" | "sustainabilityCurves">
>;

interface NormalizedCurve {
  readonly id: string;
  readonly secs: readonly number[];
  readonly values: readonly (number | null)[];
  readonly activityIds: readonly (string | null)[];
  readonly startIndexes: readonly (number | null)[];
  readonly activities: Readonly<Record<string, NormalizedCurveActivity>>;
}

interface NormalizedCurveActivity {
  readonly [key: string]: unknown;
  readonly id: string | number;
  readonly start_date_local: string;
  readonly name?: string | null;
  readonly type?: string | null;
  readonly device_watts?: boolean | null;
  readonly icu_ignore_power?: boolean | null;
  readonly power_meter?: string | null;
  readonly device_name?: string | null;
  readonly missing_timestamps?: boolean | null;
  readonly missing_power_samples?: boolean | null;
}

export class AnalyticsCurveProjectionError extends Error {
  readonly code = "ANALYTICS_CURVE_PROJECTION_FAILED";

  constructor() {
    super("analytics curve evidence could not be projected");
    this.name = "AnalyticsCurveProjectionError";
    this.stack = `${this.name}: ${this.message}`;
    Object.freeze(this);
  }
}

function fail(): never {
  throw new AnalyticsCurveProjectionError();
}

function partKey(family: CurveFamily, activityType: ActivityType): string {
  return `${family}:${activityType}`;
}

function normalizeCurve(
  id: string,
  secs: readonly number[],
  values: readonly (number | null)[],
  activityIds: readonly string[] | null | undefined = undefined,
  startIndexes: readonly (number | null)[] | null | undefined = undefined,
  activities: Readonly<Record<string, NormalizedCurveActivity>> = Object.freeze({}),
): NormalizedCurve {
  if (
    secs.length !== values.length ||
    secs.length > MAX_PROJECTED_AXIS_LENGTH ||
    (activityIds !== undefined && activityIds !== null && activityIds.length !== secs.length) ||
    (startIndexes !== undefined && startIndexes !== null && startIndexes.length !== secs.length)
  )
    fail();
  const projectedSecs: number[] = [];
  const projectedValues: (number | null)[] = [];
  const projectedActivityIds: (string | null)[] = [];
  const projectedStartIndexes: (number | null)[] = [];
  let previous = 0;
  for (let index = 0; index < secs.length; index += 1) {
    const seconds = secs[index];
    const value = values[index];
    const activityId = activityIds?.[index] ?? null;
    const startIndex = startIndexes?.[index] ?? null;
    if (
      !Number.isSafeInteger(seconds) ||
      seconds <= previous ||
      (value !== null && (!Number.isFinite(value) || value < 0)) ||
      (activityId !== null && activityId.length === 0) ||
      (startIndex !== null && (!Number.isSafeInteger(startIndex) || startIndex < 0))
    )
      fail();
    projectedSecs.push(seconds);
    projectedValues.push(value);
    projectedActivityIds.push(activityId);
    projectedStartIndexes.push(startIndex);
    previous = seconds;
  }
  return Object.freeze({
    id,
    secs: Object.freeze(projectedSecs),
    values: Object.freeze(projectedValues),
    activityIds: Object.freeze(projectedActivityIds),
    startIndexes: Object.freeze(projectedStartIndexes),
    activities,
  });
}

function optionalText(value: unknown): string | null | undefined {
  return value === undefined ? undefined : typeof value === "string" ? value : null;
}

function optionalBoolean(value: unknown): boolean | null | undefined {
  return value === undefined ? undefined : typeof value === "boolean" ? value : null;
}

function normalizeActivities(
  source: ReadonlyMap<string, Record<string, unknown>>,
): Readonly<Record<string, NormalizedCurveActivity>> {
  const activities: Record<string, NormalizedCurveActivity> = {};
  for (const [key, activity] of source) {
    const id = activity.id;
    const startDateLocal = activity.startDateLocal;
    if (
      (typeof id !== "string" && typeof id !== "number") ||
      typeof startDateLocal !== "string" ||
      startDateLocal.length === 0
    )
      fail();
    activities[key] = Object.freeze({
      id,
      start_date_local: startDateLocal,
      name: optionalText(activity.name),
      type: optionalText(activity.type),
      device_watts: optionalBoolean(activity.deviceWatts),
      icu_ignore_power: optionalBoolean(activity.icuIgnorePower),
      power_meter: optionalText(activity.powerMeter),
      device_name: optionalText(activity.deviceName),
      missing_timestamps: optionalBoolean(activity.missingTimestamps),
      missing_power_samples: optionalBoolean(activity.missingPowerSamples),
    });
  }
  return Object.freeze(activities);
}

function optionalStringArray(value: unknown): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) fail();
  return value;
}

function optionalIndexArray(value: unknown): readonly (number | null)[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((item) => item !== null && (!Number.isSafeInteger(item) || (item as number) < 0))
  )
    fail();
  return value as readonly (number | null)[];
}

function selectPowerCurves(
  payload: unknown,
  selectors: ReadonlySet<string>,
): readonly NormalizedCurve[] {
  const decoded = decode(AthletePowerCurveSetSchema, payload);
  if (!decoded.ok) fail();
  const activities = normalizeActivities(decoded.value.activities);
  const seen = new Set<string>();
  const selected: NormalizedCurve[] = [];
  for (const curve of decoded.value.list) {
    if (typeof curve.id !== "string" || !selectors.has(curve.id)) continue;
    if (seen.has(curve.id)) fail();
    seen.add(curve.id);
    selected.push(
      normalizeCurve(
        curve.id,
        curve.secs,
        curve.values,
        optionalStringArray(curve.activity_id),
        optionalIndexArray(curve.start_index),
        activities,
      ),
    );
  }
  return Object.freeze(selected);
}

function selectHeartRateCurves(
  payload: unknown,
  selectors: ReadonlySet<string>,
): readonly NormalizedCurve[] {
  const decoded = decode(AthleteHeartRateCurveSetSchema, payload);
  if (!decoded.ok) fail();
  const seen = new Set<string>();
  const selected: NormalizedCurve[] = [];
  for (const curve of decoded.value.list) {
    if (typeof curve.id !== "string" || !selectors.has(curve.id)) continue;
    if (seen.has(curve.id)) fail();
    seen.add(curve.id);
    selected.push(normalizeCurve(curve.id, curve.secs, curve.values));
  }
  return Object.freeze(selected);
}

function curveById(curves: readonly NormalizedCurve[], id: string): NormalizedCurve | undefined {
  return curves.find((curve) => curve.id === id);
}

function aggregateCurves(
  curvesByType: Readonly<Record<ActivityType, readonly NormalizedCurve[]>>,
  selectors: readonly string[],
): readonly NormalizedCurve[] {
  const aggregated: NormalizedCurve[] = [];
  for (const id of selectors) {
    const bySecond = new Map<
      number,
      { value: number | null; activityId: string | null; startIndex: number | null }
    >();
    const activities: Record<string, NormalizedCurveActivity> = {};
    for (const activityType of ACTIVITY_TYPES) {
      const curve = curveById(curvesByType[activityType], id);
      if (curve === undefined) continue;
      Object.assign(activities, curve.activities);
      for (let index = 0; index < curve.secs.length; index += 1) {
        const seconds = curve.secs[index]!;
        const value = curve.values[index] ?? null;
        const previous = bySecond.get(seconds)?.value;
        if (previous === undefined || previous === null || (value !== null && value > previous)) {
          bySecond.set(seconds, {
            value,
            activityId: curve.activityIds[index] ?? null,
            startIndex: curve.startIndexes[index] ?? null,
          });
        }
      }
    }
    if (bySecond.size === 0) continue;
    const secs = [...bySecond.keys()].sort((left, right) => left - right);
    aggregated.push(
      Object.freeze({
        id,
        secs: Object.freeze(secs),
        values: Object.freeze(secs.map((seconds) => bySecond.get(seconds)?.value ?? null)),
        activityIds: Object.freeze(
          secs.map((seconds) => bySecond.get(seconds)?.activityId ?? null),
        ),
        startIndexes: Object.freeze(
          secs.map((seconds) => bySecond.get(seconds)?.startIndex ?? null),
        ),
        activities: Object.freeze(activities),
      }),
    );
  }
  return Object.freeze(aggregated);
}

function powerEnvelope(
  curves: readonly NormalizedCurve[],
): NonNullable<ReferenceBundle["powerCurves"]> {
  const list = curves.map((curve) => {
    const secs = [...curve.secs];
    const watts = [...curve.values];
    const activity_ids = [...curve.activityIds];
    const start_indexes = [...curve.startIndexes];
    const entry = { id: curve.id, secs, watts, activity_ids, start_indexes };
    Object.freeze(secs);
    Object.freeze(watts);
    Object.freeze(activity_ids);
    Object.freeze(start_indexes);
    return Object.freeze(entry);
  });
  Object.freeze(list);
  const activities: Record<string, NormalizedCurveActivity> = {};
  for (const curve of curves) {
    for (const activityId of curve.activityIds) {
      if (activityId !== null && curve.activities[activityId] !== undefined) {
        activities[activityId] = curve.activities[activityId];
      }
    }
  }
  return Object.freeze({ list, activities: Object.freeze(activities) });
}

function heartRateEnvelope(
  curves: readonly NormalizedCurve[],
): NonNullable<ReferenceBundle["hrCurves"]> {
  const list = curves.map((curve) => {
    const secs = [...curve.secs];
    const values = [...curve.values];
    const entry = { id: curve.id, secs, values };
    Object.freeze(secs);
    Object.freeze(values);
    return Object.freeze(entry);
  });
  Object.freeze(list);
  return Object.freeze({ list });
}

async function projectCurrentAnalyticsCurves(
  current: CurrentAnalyticsCurves,
  snapshots: VerifiedSnapshotReader,
): Promise<CurveProjection> {
  if (typeof snapshots?.readVerifiedSnapshot !== "function") fail();
  const evidenceByPart = new Map<string, CurrentAnalyticsCurves["evidence"][number]>();
  for (const evidence of current.evidence) {
    const key = partKey(evidence.curveFamily, evidence.activityType);
    if (evidenceByPart.has(key)) fail();
    evidenceByPart.set(key, evidence);
  }
  if (evidenceByPart.size !== ANALYTICS_CURVE_PARTS.length) fail();

  const windows = current.generation.windows;
  const selectors = Object.freeze([
    `r.${windows.current.start}.${windows.current.end}`,
    `r.${windows.previous.start}.${windows.previous.end}`,
    `r.${windows.sustainability.start}.${windows.sustainability.end}`,
  ]);
  const selectorSet = new Set(selectors);
  const projected = new Map<string, readonly NormalizedCurve[]>();

  for (const part of ANALYTICS_CURVE_PARTS) {
    const evidence = evidenceByPart.get(partKey(part.curveFamily, part.activityType));
    if (evidence === undefined) fail();
    const payload = await snapshots.readVerifiedSnapshot({
      address: evidence.archiveAddress,
      rel_path: evidence.archiveRelPath,
    });
    projected.set(
      partKey(part.curveFamily, part.activityType),
      part.curveFamily === "power"
        ? selectPowerCurves(payload, selectorSet)
        : selectHeartRateCurves(payload, selectorSet),
    );
  }

  const curves = (family: CurveFamily, activityType: ActivityType): readonly NormalizedCurve[] =>
    projected.get(partKey(family, activityType)) ?? fail();
  const powerByType = Object.freeze({
    Ride: curves("power", "Ride"),
    VirtualRide: curves("power", "VirtualRide"),
  });
  const heartRateByType = Object.freeze({
    Ride: curves("heart-rate", "Ride"),
    VirtualRide: curves("heart-rate", "VirtualRide"),
  });
  const sustainabilityId = selectors[2]!;

  return Object.freeze({
    powerCurves: powerEnvelope(aggregateCurves(powerByType, selectors)),
    hrCurves: heartRateEnvelope(aggregateCurves(heartRateByType, selectors)),
    sustainabilityCurves: Object.freeze({
      cycling: Object.freeze({
        power: Object.freeze({
          Ride: powerEnvelope(
            curveById(powerByType.Ride, sustainabilityId)
              ? [curveById(powerByType.Ride, sustainabilityId)!]
              : [],
          ),
          VirtualRide: powerEnvelope(
            curveById(powerByType.VirtualRide, sustainabilityId)
              ? [curveById(powerByType.VirtualRide, sustainabilityId)!]
              : [],
          ),
        }),
        hr: Object.freeze({
          Ride: heartRateEnvelope(
            curveById(heartRateByType.Ride, sustainabilityId)
              ? [curveById(heartRateByType.Ride, sustainabilityId)!]
              : [],
          ),
          VirtualRide: heartRateEnvelope(
            curveById(heartRateByType.VirtualRide, sustainabilityId)
              ? [curveById(heartRateByType.VirtualRide, sustainabilityId)!]
              : [],
          ),
        }),
      }),
    }),
  });
}

export async function projectAnalyticsCurveEvidence(
  current: CurrentAnalyticsCurves,
  snapshots: VerifiedSnapshotReader,
): Promise<CurveProjection> {
  try {
    return await projectCurrentAnalyticsCurves(current, snapshots);
  } catch {
    throw new AnalyticsCurveProjectionError();
  }
}
