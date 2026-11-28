import { coachFtp, type FtpEvidence, type FtpProposalBasis } from "./ftp-proposal.js";

export const FTP_TEST_FACTOR = 0.95;
export const FTP_ECHO_WINDOW_MS = 15 * 60 * 1_000;
export const FTP_TEST_SECONDS = 20 * 60;
export const SAMPLE_SECONDS = 1;

export interface IcuFtpVersion {
  readonly updatedMs: number;
  readonly ftpWatts: number | null;
  readonly indoorFtpWatts: number | null;
}

export interface AcceptedFtp {
  readonly watts: number;
  readonly setAtMs: number;
  readonly basis: FtpProposalBasis["kind"];
  readonly icuUpdatedMs: number | null;
}

export type FtpLineSource = "first-sync" | "intervals" | "coach-test" | "coach-estimate";

export interface FtpPoint {
  readonly watts: number | null;
  readonly setAtMs: number;
  readonly source: FtpLineSource;
}

export interface FtpLine extends FtpPoint {
  readonly watts: number;
}

export interface FtpHistory {
  readonly points: readonly FtpPoint[];
  readonly ride: readonly FtpLine[];
  readonly current: FtpLine | null;
  readonly indoor: readonly FtpPoint[];
}

export interface FtpTestResult {
  readonly activityId: string;
  readonly dateKey: number;
  readonly startMs: number;
  readonly twentyMinuteWatts: number;
}

export type RideFtp =
  | { readonly kind: "unknown" }
  | {
      readonly kind: "known";
      readonly watts: number;
      readonly use: "outdoor" | "indoor";
      readonly line: FtpLine | null;
      readonly outdoorWatts: number | null;
    };

interface Sorted extends FtpPoint {
  readonly order: number;
}

function acceptedSource(basis: AcceptedFtp["basis"]): FtpLineSource {
  return basis === "planned-test" ? "coach-test" : "coach-estimate";
}

function echoesAccepted(version: IcuFtpVersion, accepted: readonly AcceptedFtp[]): boolean {
  return accepted.some(
    (entry) =>
      entry.watts === version.ftpWatts &&
      (entry.icuUpdatedMs === null
        ? Math.abs(version.updatedMs - entry.setAtMs) <= FTP_ECHO_WINDOW_MS
        : version.updatedMs === entry.icuUpdatedMs),
  );
}

function collapsed(points: readonly Sorted[]): FtpPoint[] {
  const kept: FtpPoint[] = [];
  for (const point of points) {
    const previous = kept.at(-1);
    if (previous !== undefined && previous.watts === point.watts) continue;
    if (previous === undefined && point.watts === null) continue;
    kept.push({ watts: point.watts, setAtMs: point.setAtMs, source: point.source });
  }
  return kept;
}

function known(point: FtpPoint | null): FtpLine | null {
  return point === null || point.watts === null ? null : { ...point, watts: point.watts };
}

export function ftpHistory(
  versions: readonly IcuFtpVersion[],
  accepted: readonly AcceptedFtp[],
): FtpHistory {
  const sortedVersions = [...versions].sort((left, right) => left.updatedMs - right.updatedMs);
  const firstVersion = sortedVersions[0];
  const sourceOf = (version: IcuFtpVersion): FtpLineSource =>
    version === firstVersion ? "first-sync" : "intervals";
  const sorted: Sorted[] = [
    ...accepted.map((entry) => ({
      watts: entry.watts,
      setAtMs: entry.setAtMs,
      source: acceptedSource(entry.basis),
      order: 0,
    })),
    ...sortedVersions
      .filter((version) => !echoesAccepted(version, accepted))
      .map((version) => ({
        watts: version.ftpWatts,
        setAtMs: version.updatedMs,
        source: sourceOf(version),
        order: 1,
      })),
  ].sort((left, right) => left.setAtMs - right.setAtMs || left.order - right.order);
  const points = collapsed(sorted);
  const indoor = collapsed(
    sortedVersions.map((version) => ({
      watts: version.indoorFtpWatts,
      setAtMs: version.updatedMs,
      source: sourceOf(version),
      order: 1,
    })),
  );
  return {
    points,
    ride: points.flatMap((point) => known(point) ?? []),
    current: known(points.at(-1) ?? null),
    indoor,
  };
}

export function ftpAt(points: readonly FtpPoint[], atMs: number): FtpPoint | null {
  let found: FtpPoint | null = null;
  for (const point of points) if (point.setAtMs <= atMs) found = point;
  return found;
}

export function rideFtpAt(
  history: FtpHistory,
  ride: {
    readonly startMs: number;
    readonly indoor: boolean;
    readonly appliedWatts: number | null;
  },
): RideFtp {
  const outdoor = known(ftpAt(history.points, ride.startMs));
  const indoor = known(ftpAt(history.indoor, ride.startMs));
  const outdoorWatts = outdoor?.watts ?? null;
  const chosen = coachFtp(
    { ftpWatts: outdoorWatts, indoorFtpWatts: indoor?.watts ?? null, estimatedFtpWatts: null },
    ride.indoor ? "indoor" : "outdoor",
  );
  const use = chosen.kind === "set" ? chosen.use : "outdoor";
  const line = use === "indoor" ? indoor : outdoor;
  if (ride.appliedWatts !== null) {
    const appliedUse =
      use === "indoor" && indoor?.watts !== ride.appliedWatts && outdoorWatts === ride.appliedWatts
        ? "outdoor"
        : use;
    const appliedLine = appliedUse === "indoor" ? indoor : outdoor;
    return {
      kind: "known",
      watts: ride.appliedWatts,
      use: appliedUse,
      line: appliedLine !== null && appliedLine.watts === ride.appliedWatts ? appliedLine : null,
      outdoorWatts,
    };
  }
  if (chosen.kind !== "set" || line === null) return { kind: "unknown" };
  return { kind: "known", watts: chosen.watts, use: chosen.use, line, outdoorWatts };
}

export function isFtpTestWorkoutName(name: string): boolean {
  return /\bftp[- ]test\b|\b20[- ]?min(?:ute)?s?[- ](?:ftp[- ])?test\b/iu.test(name);
}

export function plannedTestEvidence(
  results: readonly FtpTestResult[],
  after: { readonly atMs: number | null } = { atMs: null },
): FtpEvidence {
  const latest = [...results]
    .filter(
      (result) =>
        Number.isFinite(result.twentyMinuteWatts) &&
        result.twentyMinuteWatts > 0 &&
        (after.atMs === null || result.startMs > after.atMs),
    )
    .sort(
      (left, right) =>
        left.startMs - right.startMs || left.activityId.localeCompare(right.activityId),
    )
    .at(-1);
  if (latest === undefined) return { kind: "none" };
  return {
    kind: "planned-test",
    watts: Math.round(latest.twentyMinuteWatts * FTP_TEST_FACTOR),
    activityId: latest.activityId,
    dateKey: latest.dateKey,
  };
}

export function ftpChangePercent(fromWatts: number | null, toWatts: number): number | null {
  if (fromWatts === null || fromWatts <= 0) return null;
  return Math.round(((toWatts - fromWatts) / fromWatts) * 100);
}

export function bestAveragePower(
  times: readonly (number | null)[],
  powers: readonly (number | null)[],
  seconds: number = FTP_TEST_SECONDS,
): number | null {
  const samples: { readonly at: number; readonly watts: number }[] = [];
  for (const [index, at] of times.entries()) {
    const watts = powers[index];
    if (typeof at === "number" && Number.isFinite(at)) {
      samples.push({ at, watts: typeof watts === "number" && Number.isFinite(watts) ? watts : 0 });
    }
  }
  const work = (from: { readonly at: number; readonly watts: number }, to: number): number =>
    from.watts * Math.min(to - from.at, SAMPLE_SECONDS);
  let best: number | null = null;
  let start = 0;
  let energy = 0;
  for (let end = 1; end < samples.length; end += 1) {
    const previous = samples[end - 1];
    const current = samples[end];
    if (previous === undefined || current === undefined) continue;
    energy += work(previous, current.at);
    for (;;) {
      const first = samples[start];
      const second = samples[start + 1];
      if (first === undefined || second === undefined || current.at - second.at < seconds) break;
      energy -= work(first, second.at);
      start += 1;
    }
    const first = samples[start];
    if (first !== undefined && current.at - first.at >= seconds) {
      const average = energy / (current.at - first.at);
      best = best === null ? average : Math.max(best, average);
    }
  }
  return best;
}
