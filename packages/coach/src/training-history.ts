import {
  FreshnessSchema,
  IsoInstantSchema,
  TrainingHistoryProjectionSchema,
  type CivilDateWindow,
  type CompletedActivityWeek,
  type DurationMetricValue,
  type Freshness,
  type RidingTimeTrend,
  type TrainingHistoryCoverage,
  type TrainingHistoryProjection,
  type TrainingHistoryRide,
  type WeekCoverage,
} from "@enduragent/coach-contract";
import { addCivilDays, mondayOfWeek, todayInTZ } from "@enduragent/engine/sport";
import {
  TrainingCoverageError,
  TrainingHistoryReadError,
  type CoverageCommitRow,
  type RecordedFact,
  type TrainingCoverageReader,
  type TrainingHistoryFactRow,
  type TrainingHistoryReader,
} from "@enduragent/kernel/store";
import { utcCivilDateFromEpochSeconds } from "./civil-date.js";

const MAX_VISIBLE_RIDES = 50;

interface WeekSlot {
  readonly window: CivilDateWindow;
  readonly rows: TrainingHistoryFactRow[];
}

interface ExpectedWindows {
  readonly anchor: CivilDateWindow;
  readonly previous: CivilDateWindow;
  readonly trend: readonly CivilDateWindow[];
  readonly slots: ReadonlyMap<string, WeekSlot>;
  readonly readWindow: CivilDateWindow;
}

interface CoverageSpan {
  readonly start: string;
  readonly end: string;
}

type FoldedCoverage =
  | { readonly kind: "none" }
  | {
      readonly kind: "covered";
      readonly start: string | null;
      readonly through: string | null;
      readonly observedThrough: string | null;
      readonly committedAt: string | null;
      readonly reason: "source-degraded" | "coverage-timezone-changed" | null;
      readonly datedLocalDates: ReadonlySet<string>;
      readonly undatedWindows: readonly CoverageSpan[];
    };

export interface TrainingHistorySource {
  readTrainingHistory(input: {
    readonly asOf: string;
    readonly asOfEpochSeconds: number;
    readonly calendarTimeZone: string;
    readonly freshness: Freshness;
    readonly sourceRestricted: boolean;
  }): Promise<TrainingHistoryProjection>;
}

function unavailable(
  reason: "coverage-unavailable" | "temporary-failure" | "invalid-data",
): TrainingHistoryProjection {
  return TrainingHistoryProjectionSchema.parse({ kind: "unavailable", reason });
}

function instantFromEpochSeconds(value: number): string {
  return new Date(value * 1_000).toISOString();
}

function effectiveCommit(row: CoverageCommitRow): CoverageCommitRow | null {
  const committedDate = todayInTZ(
    row.calendarTimeZone,
    new Date(row.committedEpochSeconds * 1_000),
  );
  const elapsedThrough = addCivilDays(committedDate, -1);
  const coveredNewest =
    row.coveredNewest < elapsedThrough ? row.coveredNewest : elapsedThrough;
  return coveredNewest < row.coveredOldest ? null : { ...row, coveredNewest };
}

function mergeSpans(values: readonly CoverageSpan[]): CoverageSpan[] {
  const sorted = [...values].sort(
    (left, right) => left.start.localeCompare(right.start) || left.end.localeCompare(right.end),
  );
  const result: CoverageSpan[] = [];
  for (const span of sorted) {
    const previous = result.at(-1);
    if (previous === undefined || span.start > addCivilDays(previous.end, 1)) {
      result.push(span);
      continue;
    }
    result[result.length - 1] = {
      start: previous.start,
      end: previous.end > span.end ? previous.end : span.end,
    };
  }
  return result;
}

function subtractOwned(span: CoverageSpan, owned: readonly CoverageSpan[]): CoverageSpan[] {
  let remaining = [span];
  for (const claimed of owned) {
    const next: CoverageSpan[] = [];
    for (const candidate of remaining) {
      if (claimed.end < candidate.start || claimed.start > candidate.end) {
        next.push(candidate);
        continue;
      }
      if (claimed.start > candidate.start) {
        next.push({ start: candidate.start, end: addCivilDays(claimed.start, -1) });
      }
      if (claimed.end < candidate.end) {
        next.push({ start: addCivilDays(claimed.end, 1), end: candidate.end });
      }
    }
    remaining = next;
  }
  return remaining;
}

function intersects(left: CoverageSpan, right: CoverageSpan): boolean {
  return left.start <= right.end && left.end >= right.start;
}

function foldCoverage(
  commits: readonly CoverageCommitRow[],
  calendarTimeZone: string,
  sourceRestricted: boolean,
): FoldedCoverage {
  const effective = commits.flatMap((commit) => {
    const row = effectiveCommit(commit);
    return row === null ? [] : [row];
  });
  const latestOverall = effective.at(-1);
  if (latestOverall === undefined) {
    return sourceRestricted
      ? {
          kind: "covered",
          start: null,
          through: null,
          observedThrough: null,
          committedAt: null,
          reason: "source-degraded",
          datedLocalDates: new Set<string>(),
          undatedWindows: Object.freeze([]),
        }
      : { kind: "none" };
  }
  const matching = effective.filter((commit) => commit.calendarTimeZone === calendarTimeZone);
  let owned: CoverageSpan[] = [];
  const datedLocalDates = new Set<string>();
  const undatedWindows: CoverageSpan[] = [];
  for (let index = matching.length - 1; index >= 0; index -= 1) {
    const row = matching[index]!;
    const pieces = subtractOwned(
      { start: row.coveredOldest, end: row.coveredNewest },
      owned,
    );
    for (const date of row.gaps.datedLocalDates) {
      if (pieces.some((piece) => date >= piece.start && date <= piece.end)) {
        datedLocalDates.add(date);
      }
    }
    if (row.gaps.undatedCount > 0) undatedWindows.push(...pieces);
    owned = mergeSpans([...owned, ...pieces]);
  }
  const latestSpan = owned.at(-1);
  return {
    kind: "covered",
    start: latestSpan?.start ?? null,
    through: latestSpan?.end ?? null,
    observedThrough: latestOverall.coveredNewest,
    committedAt: instantFromEpochSeconds(latestOverall.committedEpochSeconds),
    reason:
      latestOverall.calendarTimeZone !== calendarTimeZone
        ? "coverage-timezone-changed"
        : sourceRestricted
          ? "source-degraded"
          : null,
    datedLocalDates,
    undatedWindows: Object.freeze(undatedWindows),
  };
}

function weekWindow(date: string): CivilDateWindow {
  const start = mondayOfWeek(date);
  return { start, end: addCivilDays(start, 6) };
}

function expectedWindows(
  anchorDate: string,
  today: string,
  displayMode: "current" | "last-recorded",
): ExpectedWindows {
  const anchor = weekWindow(anchorDate);
  const previous = weekWindow(addCivilDays(anchor.start, -1));
  const anchorOpen = today >= anchor.start && today <= anchor.end;
  const newestTrendStart = displayMode === "current" && !anchorOpen ? anchor.start : previous.start;
  const trend = Array.from({ length: 6 }, (_, index) => {
    const start = addCivilDays(newestTrendStart, (index - 5) * 7);
    return { start, end: addCivilDays(start, 6) };
  });
  const windows = [anchor, previous, ...trend];
  const slots = new Map<string, WeekSlot>();
  for (const window of windows) {
    if (!slots.has(window.start)) slots.set(window.start, { window, rows: [] });
  }
  const starts = windows.map((window) => window.start).sort();
  const ends = windows.map((window) => window.end).sort();
  const readStart = starts.at(0);
  const readEnd = ends.at(-1);
  if (readStart === undefined || readEnd === undefined) {
    throw new TypeError("expected training history windows are empty");
  }
  return {
    anchor,
    previous,
    trend,
    slots,
    readWindow: { start: readStart, end: readEnd },
  };
}

function safeCoverageAnchor(coverage: FoldedCoverage): string | null {
  if (coverage.kind === "none" || coverage.reason === "coverage-timezone-changed") return null;
  return coverage.through;
}

function scanCutoffDate(
  rows: readonly TrainingHistoryFactRow[],
  scanTruncated: boolean,
): string | null {
  if (!scanTruncated) return null;
  const oldestReturned = rows.at(-1);
  if (oldestReturned === undefined) throw new TypeError("truncated scan has no rows");
  return addCivilDays(utcCivilDateFromEpochSeconds(oldestReturned.startEpochSeconds), 1);
}

function projectionCoverage(
  coverage: FoldedCoverage,
  sparseRideDate: string | null,
): TrainingHistoryCoverage | null {
  if (coverage.kind === "none") {
    if (sparseRideDate === null) return null;
    return {
      kind: "sparse",
      latestKnownRideDate: sparseRideDate,
      latestImportAt: null,
    };
  }
  const hasGaps =
    coverage.datedLocalDates.size > 0 || coverage.undatedWindows.length > 0;
  if (
    coverage.reason === null &&
    !hasGaps &&
    coverage.start !== null &&
    coverage.through !== null &&
    coverage.committedAt !== null
  ) {
    return {
      kind: "contiguous",
      start: coverage.start,
      through: coverage.through,
      committedAt: coverage.committedAt,
    };
  }
  return {
    kind: "incomplete",
    provenStart: coverage.start,
    provenThrough: coverage.through,
    observedThrough: coverage.observedThrough,
    committedAt: coverage.committedAt,
    reason:
      coverage.reason ??
      (coverage.undatedWindows.length > 0
        ? "undated-dropped-rows"
        : "source-degraded"),
  };
}

function assignRows(windows: ExpectedWindows, rows: readonly TrainingHistoryFactRow[]): void {
  for (const row of rows) {
    const slot = windows.slots.get(mondayOfWeek(row.localDate));
    if (slot !== undefined) slot.rows.push(row);
  }
  for (const slot of windows.slots.values()) {
    slot.rows.sort(
      (left, right) =>
        right.startEpochSeconds - left.startEpochSeconds || left.id.localeCompare(right.id),
    );
  }
}

function recordedCoreFact(value: number | null): RecordedFact<number> {
  return value === null ? { kind: "absent" } : { kind: "recorded", value };
}

function aggregateMetric(
  facts: readonly RecordedFact<number>[],
  coverageComplete: boolean,
): DurationMetricValue {
  if (facts.length === 0) {
    return coverageComplete
      ? { kind: "computed", value: 0 }
      : { kind: "unavailable", reason: "incomplete-coverage" };
  }
  const recorded = facts.filter(
    (fact): fact is Extract<RecordedFact<number>, { readonly kind: "recorded" }> =>
      fact.kind === "recorded",
  );
  const value = recorded.reduce((sum, fact) => sum + fact.value, 0);
  if (!coverageComplete) {
    return recorded.length === 0
      ? { kind: "unavailable", reason: "incomplete-coverage" }
      : { kind: "partial", value, reason: "incomplete-coverage" };
  }
  if (recorded.length === facts.length) return { kind: "computed", value };
  if (recorded.length > 0) {
    return {
      kind: "partial",
      value,
      reason: "missing-recorded-value",
      knownRideMissingValueCount: facts.length - recorded.length,
    };
  }
  return facts.some((fact) => fact.kind === "rejected")
    ? { kind: "unavailable", reason: "invalid-recorded-value" }
    : { kind: "unavailable", reason: "no-recorded-value" };
}

function ridingTime(row: TrainingHistoryFactRow): {
  readonly seconds: number | null;
  readonly basis: "moving" | "elapsed" | null;
} {
  if (row.movingSeconds !== null) return { seconds: row.movingSeconds, basis: "moving" };
  if (row.elapsedSeconds !== null) return { seconds: row.elapsedSeconds, basis: "elapsed" };
  return { seconds: null, basis: null };
}

function recordedValue(fact: RecordedFact<number>): number | null {
  return fact.kind === "recorded" ? fact.value : null;
}

function projectRide(row: TrainingHistoryFactRow): TrainingHistoryRide {
  const riding = ridingTime(row);
  return {
    id: row.id,
    title: row.title,
    subSport: row.subSport,
    startEpochSeconds: row.startEpochSeconds,
    timezoneOffsetSeconds: row.timezoneOffsetSeconds,
    localDate: row.localDate,
    ridingSeconds: riding.seconds,
    ridingTimeBasis: riding.basis,
    elapsedSeconds: row.elapsedSeconds,
    distanceMeters: row.distanceMeters,
    load: recordedValue(row.load),
    averagePowerWatts: recordedValue(row.averagePowerWatts),
    averageHeartRateBpm: recordedValue(row.averageHeartRateBpm),
    perceivedExertion: recordedValue(row.perceivedExertion),
    energyKilojoules: recordedValue(row.energyKilojoules),
  };
}

function longestRecordedRideCallout(input: {
  readonly selectedWeek: CivilDateWindow;
  readonly rows: readonly TrainingHistoryFactRow[];
  readonly returnedRides: readonly TrainingHistoryRide[];
  readonly foldedCoverage: FoldedCoverage;
  readonly scanTruncated: boolean;
  readonly displayMode: "current" | "last-recorded";
}): CompletedActivityWeek["callout"] {
  if (input.displayMode === "last-recorded" || input.scanTruncated) {
    return null;
  }
  if (input.foldedCoverage.kind === "none" || input.foldedCoverage.through === null) {
    return null;
  }
  const end =
    input.foldedCoverage.through < input.selectedWeek.end
      ? input.foldedCoverage.through
      : input.selectedWeek.end;
  const window = { start: addCivilDays(end, -27), end };
  if (!coverageForWindow(input.foldedCoverage, window)) return null;
  const rows = input.rows.filter(
    (row) => row.localDate >= window.start && row.localDate <= window.end,
  );
  if (rows.length < 4 || rows.length > 1_000) return null;
  let longest: { readonly row: TrainingHistoryFactRow; readonly durationSeconds: number } | null =
    null;
  let tied = false;
  for (const row of rows) {
    const durationSeconds = ridingTime(row).seconds;
    if (durationSeconds === null) return null;
    if (longest === null || durationSeconds > longest.durationSeconds) {
      longest = { row, durationSeconds };
      tied = false;
    } else if (durationSeconds === longest.durationSeconds) {
      tied = true;
    }
  }
  if (
    longest === null ||
    tied ||
    longest.row.localDate < input.selectedWeek.start ||
    longest.row.localDate > input.selectedWeek.end
  ) {
    return null;
  }
  const returnedRide = input.returnedRides.find((ride) => ride.id === longest.row.id);
  if (returnedRide?.ridingSeconds !== longest.durationSeconds) return null;
  return {
    kind: "longest-ride-28d",
    rideId: longest.row.id,
    durationSeconds: longest.durationSeconds,
    window,
    comparisonRideCount: rows.length,
  };
}

function calendarState(
  window: CivilDateWindow,
  today: string,
): CompletedActivityWeek["calendarState"] {
  return today >= window.start && today <= window.end ? "open" : "closed";
}

function recordedThrough(coverage: TrainingHistoryCoverage): string | null {
  if (coverage.kind === "contiguous") return coverage.through;
  if (coverage.kind === "incomplete") {
    return coverage.provenThrough ?? coverage.observedThrough;
  }
  return coverage.latestKnownRideDate;
}

function coverageForWindow(
  coverage: FoldedCoverage,
  window: CoverageSpan,
): boolean {
  if (
    coverage.kind === "none" ||
    coverage.reason !== null ||
    coverage.start === null ||
    coverage.through === null ||
    coverage.start > window.start ||
    coverage.through < window.end
  ) {
    return false;
  }
  for (const date of coverage.datedLocalDates) {
    if (date >= window.start && date <= window.end) return false;
  }
  return !coverage.undatedWindows.some((gap) => intersects(gap, window));
}

function weekCoverage(input: {
  readonly window: CivilDateWindow;
  readonly today: string;
  readonly coverage: TrainingHistoryCoverage;
  readonly foldedCoverage: FoldedCoverage;
  readonly scanCutoffDate: string | null;
  readonly currentAnchor: boolean;
}): WeekCoverage {
  const through = recordedThrough(input.coverage);
  if (input.scanCutoffDate !== null && input.window.start <= input.scanCutoffDate) {
    return { kind: "incomplete", recordedThrough: through, reason: "scan-limit" };
  }
  if (input.coverage.kind === "sparse") {
    return { kind: "incomplete", recordedThrough: through, reason: "sparse-imports" };
  }
  const open = calendarState(input.window, input.today) === "open";
  const requiredThrough =
    open && input.today < input.window.end ? input.today : input.window.end;
  const covered = coverageForWindow(input.foldedCoverage, {
    start: input.window.start,
    end: requiredThrough,
  });
  if (covered) return { kind: "complete" };
  const reason =
    input.coverage.kind === "incomplete" &&
    input.coverage.reason === "coverage-timezone-changed"
      ? "coverage-timezone-changed"
      : input.coverage.kind === "incomplete" &&
          (input.coverage.reason === "source-degraded" ||
            input.coverage.reason === "undated-dropped-rows")
        ? "source-degraded"
        : input.currentAnchor && through !== null && through < input.window.start
          ? "coverage-lag"
          : "backfill-incomplete";
  return {
    kind: "incomplete",
    recordedThrough: through,
    reason,
  };
}

function rideCountMetric(
  count: number,
  complete: boolean,
): CompletedActivityWeek["totals"]["rideCount"] {
  if (complete) return { kind: "computed", value: count };
  return count === 0
    ? { kind: "unavailable", reason: "incomplete-coverage" }
    : { kind: "partial", value: count, reason: "incomplete-coverage" };
}

function trend(input: {
  readonly windows: ExpectedWindows;
  readonly today: string;
  readonly coverage: TrainingHistoryCoverage;
  readonly foldedCoverage: FoldedCoverage;
  readonly scanCutoffDate: string | null;
}): RidingTimeTrend {
  const buckets = input.windows.trend.map((window) => {
    const slot = input.windows.slots.get(window.start);
    if (slot === undefined) throw new TypeError("trend window is missing");
    const coverage = weekCoverage({
      window,
      today: input.today,
      coverage: input.coverage,
      foldedCoverage: input.foldedCoverage,
      scanCutoffDate: input.scanCutoffDate,
      currentAnchor: false,
    });
    return { slot, coverage };
  });
  const incomplete = buckets.filter((bucket) => bucket.coverage.kind === "incomplete");
  if (
    incomplete.some(
      (bucket) =>
        bucket.coverage.kind === "incomplete" &&
        (bucket.coverage.reason === "source-degraded" ||
          bucket.coverage.reason === "coverage-timezone-changed" ||
          bucket.coverage.reason === "sparse-imports" ||
          bucket.coverage.reason === "scan-limit" ||
          bucket.coverage.reason === "invalid-core-record"),
    )
  ) {
    return { kind: "unavailable", reason: "incomplete-source" };
  }
  if (incomplete.length > 0) return { kind: "unavailable", reason: "limited-history" };
  if (buckets.some(({ slot }) => slot.rows.some((row) => ridingTime(row).seconds === null))) {
    return { kind: "unavailable", reason: "missing-duration" };
  }
  return {
    kind: "computed",
    buckets: buckets.map(({ slot }) => ({
      window: slot.window,
      rideCount: slot.rows.length,
      ridingSeconds: slot.rows.reduce((sum, row) => sum + (ridingTime(row).seconds ?? 0), 0),
    })),
  };
}

function completedWeek(input: {
  readonly id: "anchor" | "previous";
  readonly window: CivilDateWindow;
  readonly windows: ExpectedWindows;
  readonly today: string;
  readonly coverage: TrainingHistoryCoverage;
  readonly foldedCoverage: FoldedCoverage;
  readonly scanCutoffDate: string | null;
  readonly trend: RidingTimeTrend;
}): CompletedActivityWeek {
  const slot = input.windows.slots.get(input.window.start);
  if (slot === undefined) throw new TypeError("completed week is missing");
  const coverage = weekCoverage({
    window: input.window,
    today: input.today,
    coverage: input.coverage,
    foldedCoverage: input.foldedCoverage,
    scanCutoffDate: input.scanCutoffDate,
    currentAnchor: input.id === "anchor",
  });
  const complete = coverage.kind === "complete";
  const items = slot.rows.slice(0, MAX_VISIBLE_RIDES).map(projectRide);
  const scanLimited = input.scanCutoffDate !== null && input.window.start <= input.scanCutoffDate;
  const truncated = !complete || scanLimited || slot.rows.length > items.length;
  return {
    id: input.id,
    window: input.window,
    calendarState: calendarState(input.window, input.today),
    coverage,
    totals: {
      rideCount: rideCountMetric(slot.rows.length, complete),
      ridingSeconds: aggregateMetric(
        slot.rows.map((row) => recordedCoreFact(ridingTime(row).seconds)),
        complete,
      ),
      distanceMeters: aggregateMetric(
        slot.rows.map((row) => recordedCoreFact(row.distanceMeters)),
        complete,
      ),
      load: aggregateMetric(
        slot.rows.map((row) => row.load),
        complete,
      ),
    },
    rides: {
      count: !complete
        ? { kind: "at-least", value: slot.rows.length }
        : { kind: "exact", value: slot.rows.length },
      items,
      truncated,
    },
    trend: input.trend,
    callout: null,
  };
}

function invalidInput(input: Parameters<TrainingHistorySource["readTrainingHistory"]>[0]): boolean {
  if (!IsoInstantSchema.safeParse(input.asOf).success) return true;
  if (!FreshnessSchema.safeParse(input.freshness).success) return true;
  if (!Number.isSafeInteger(input.asOfEpochSeconds) || input.asOfEpochSeconds < 0) return true;
  return !Number.isFinite(new Date(input.asOfEpochSeconds * 1_000).getTime());
}

function dependencyFailure(error: unknown): TrainingHistoryProjection {
  return unavailable(
    error instanceof TrainingHistoryReadError || error instanceof TrainingCoverageError
      ? "invalid-data"
      : "temporary-failure",
  );
}

export function createTrainingHistorySource(dependencies: {
  readonly facts: TrainingHistoryReader;
  readonly coverage: TrainingCoverageReader;
}): TrainingHistorySource {
  if (
    dependencies === null ||
    typeof dependencies !== "object" ||
    dependencies.facts === null ||
    typeof dependencies.facts !== "object" ||
    typeof dependencies.facts.readLatestRideDate !== "function" ||
    typeof dependencies.facts.readWindow !== "function" ||
    dependencies.coverage === null ||
    typeof dependencies.coverage !== "object" ||
    typeof dependencies.coverage.listCommits !== "function"
  ) {
    throw new TypeError("training history dependencies are invalid");
  }
  return Object.freeze({
    async readTrainingHistory(
      input: Parameters<TrainingHistorySource["readTrainingHistory"]>[0],
    ): Promise<TrainingHistoryProjection> {
      if (input === null || typeof input !== "object" || invalidInput(input)) {
        return unavailable("invalid-data");
      }
      let today: string;
      try {
        today = todayInTZ(input.calendarTimeZone, new Date(input.asOfEpochSeconds * 1_000));
      } catch {
        return unavailable("invalid-data");
      }
      let commits: readonly CoverageCommitRow[];
      try {
        commits = await dependencies.coverage.listCommits({
          source: "intervals-icu",
          lane: "activities",
        });
      } catch (error) {
        return dependencyFailure(error);
      }
      let folded: FoldedCoverage;
      try {
        folded = foldCoverage(commits, input.calendarTimeZone, input.sourceRestricted);
      } catch {
        return unavailable("invalid-data");
      }
      const currentAnchor = mondayOfWeek(today);
      const retainedAnchor = safeCoverageAnchor(folded);
      const lastRecorded = input.freshness !== "fresh" && input.freshness !== "flag";
      const discoverSparseHistory =
        folded.kind === "none" || (lastRecorded && retainedAnchor === null);
      const provisionalAnchor = lastRecorded ? (retainedAnchor ?? today) : currentAnchor;
      const provisionalDisplayMode = lastRecorded ? "last-recorded" : "current";
      let windows = expectedWindows(provisionalAnchor, today, provisionalDisplayMode);
      let sparseRideDate: string | null = null;
      if (discoverSparseHistory) {
        try {
          sparseRideDate = await dependencies.facts.readLatestRideDate({
            through: windows.readWindow.end,
          });
        } catch (error) {
          return dependencyFailure(error);
        }
      }
      if (lastRecorded && retainedAnchor === null && sparseRideDate === null) {
        return unavailable("coverage-unavailable");
      }
      const coverage = projectionCoverage(folded, sparseRideDate);
      if (coverage === null) return unavailable("coverage-unavailable");
      let anchorDate = provisionalAnchor;
      let displayMode: "current" | "last-recorded" = provisionalDisplayMode;
      if (coverage.kind === "sparse") {
        anchorDate = coverage.latestKnownRideDate;
        displayMode = "last-recorded";
      } else if (lastRecorded) {
        anchorDate = retainedAnchor ?? sparseRideDate ?? provisionalAnchor;
      }
      if (mondayOfWeek(anchorDate) !== windows.anchor.start) {
        windows = expectedWindows(anchorDate, today, displayMode);
      }
      let facts: Awaited<ReturnType<TrainingHistoryReader["readWindow"]>>;
      try {
        facts = await dependencies.facts.readWindow(windows.readWindow);
      } catch (error) {
        return dependencyFailure(error);
      }
      if (facts.scanTruncated && facts.rows.length === 0) return unavailable("invalid-data");
      try {
        assignRows(windows, facts.rows);
        const scanCutoff = scanCutoffDate(facts.rows, facts.scanTruncated);
        const ridingTrend = trend({
          windows,
          today,
          coverage,
          foldedCoverage: folded,
          scanCutoffDate: scanCutoff,
        });
        const anchorWeekWithoutCallout = completedWeek({
          id: "anchor",
          window: windows.anchor,
          windows,
          today,
          coverage,
          foldedCoverage: folded,
          scanCutoffDate: scanCutoff,
          trend: ridingTrend,
        });
        const anchorWeek: CompletedActivityWeek = {
          ...anchorWeekWithoutCallout,
          callout: longestRecordedRideCallout({
            selectedWeek: windows.anchor,
            rows: facts.rows,
            returnedRides: anchorWeekWithoutCallout.rides.items,
            foldedCoverage: folded,
            scanTruncated: facts.scanTruncated,
            displayMode,
          }),
        };
        const projection: TrainingHistoryProjection = {
          kind: "computed",
          asOf: input.asOf,
          calendarTimeZone: input.calendarTimeZone,
          displayMode,
          coverage,
          anchorWeek,
          previousWeek: completedWeek({
            id: "previous",
            window: windows.previous,
            windows,
            today,
            coverage,
            foldedCoverage: folded,
            scanCutoffDate: scanCutoff,
            trend: ridingTrend,
          }),
        };
        return TrainingHistoryProjectionSchema.parse(projection);
      } catch (error) {
        if (error instanceof TypeError) throw error;
        return unavailable("invalid-data");
      }
    },
  });
}
