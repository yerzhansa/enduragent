import type {
  PlanCalendarFtpBasis,
  PlanCalendarFtpOutcome,
  PlanCalendarFtpProposal,
  PlanCalendarFtpRead,
} from "@enduragent/coach-contract";
import {
  ftpChangePercent,
  ftpDriftEvidence,
  ftpDriftRun,
  ftpHistory,
  ftpProposalStep,
  plannedTestEvidence,
  type FtpEstimateSample,
  type FtpEvidence,
  type FtpHistory,
  type FtpProposal,
  type FtpTestResult,
} from "@enduragent/engine/calendar";
import { addCivilDays } from "@enduragent/kernel/planning";
import type { MigratorStore, SqlStore } from "@enduragent/kernel/store";
import type { IcuSportSettingsPort } from "./one-ftp-icu.js";
import {
  countWorkoutsOnIntervals,
  readAcceptedFtp,
  readFtpEstimates,
  readFtpOwner,
  readFtpRecord,
  readIcuFtpVersions,
  saveFtpRecord,
  type FtpProposalRecord,
} from "./one-ftp-store.js";
import type { FtpTestResultSource } from "./one-ftp-tests.js";

export const FTP_CHART_DAYS = 180;

const locks = new WeakMap<object, Promise<"settled">>();

export async function serially<T>(store: object, run: () => Promise<T>): Promise<T> {
  const before = locks.get(store) ?? Promise.resolve("settled" as const);
  const result = before.then(run);
  locks.set(
    store,
    result.then(
      () => "settled" as const,
      () => "settled" as const,
    ),
  );
  return result;
}

export interface OneFtpDeps {
  readonly store: SqlStore & Pick<MigratorStore, "transaction">;
  readonly icu: IcuSportSettingsPort;
  readonly tests: FtpTestResultSource;
  readonly todayDateKey: () => number;
  readonly now: () => number;
  readonly dateKeyOfMs: (ms: number) => number;
  readonly newId: () => string;
  readonly athleteId: () => string | null;
}

export interface OneFtp {
  readonly history: FtpHistory;
  readonly hasSettings: boolean;
}

function knownAthlete(athleteId: string | null): string | null {
  return athleteId === null || athleteId.length === 0 || athleteId === "0" ? null : athleteId;
}

export async function ftpOwner(store: SqlStore, configured: string | null): Promise<string | null> {
  return readFtpOwner(store, knownAthlete(configured));
}

export async function readOneFtpState(store: SqlStore, athleteId: string | null): Promise<OneFtp> {
  const owner = await ftpOwner(store, athleteId);
  if (owner === null) return { history: ftpHistory([], []), hasSettings: false };
  const versions = await readIcuFtpVersions(store, owner);
  return {
    history: ftpHistory(versions, await readAcceptedFtp(store, owner)),
    hasSettings: versions.length > 0,
  };
}

export async function readOneFtp(store: SqlStore, athleteId: string | null): Promise<FtpHistory> {
  return (await readOneFtpState(store, athleteId)).history;
}

interface Snapshot extends OneFtp {
  readonly estimates: readonly FtpEstimateSample[];
  readonly today: number;
}

async function snapshot(deps: OneFtpDeps): Promise<Snapshot> {
  const today = deps.todayDateKey();
  return {
    ...(await readOneFtpState(deps.store, deps.athleteId())),
    estimates: await readFtpEstimates(deps.store, {
      startDateKey: addCivilDays(today, -(FTP_CHART_DAYS - 1)),
      endDateKey: today,
    }),
    today,
  };
}

export function settled(
  record: FtpProposalRecord,
  proposal: FtpProposal,
  today: number,
  changes: Partial<Pick<FtpProposalRecord, "usedIcuWatts" | "icuChangedAtMs">> = {},
): FtpProposalRecord {
  const open = proposal.kind === "shown" || proposal.kind === "confirming";
  const confirming = proposal.kind === "confirming";
  return {
    athleteId: record.athleteId,
    proposal,
    shownOnDateKey: open ? (record.shownOnDateKey ?? today) : null,
    usedIcuWatts: confirming
      ? changes.usedIcuWatts === undefined
        ? record.usedIcuWatts
        : changes.usedIcuWatts
      : null,
    icuChangedAtMs: confirming
      ? changes.icuChangedAtMs === undefined
        ? record.icuChangedAtMs
        : changes.icuChangedAtMs
      : null,
  };
}

function driftOf(deps: OneFtpDeps, state: Snapshot) {
  const current = state.history.current;
  return current === null
    ? null
    : {
        ftpWatts: current.watts,
        ftpSetDateKey: deps.dateKeyOfMs(current.setAtMs),
        samples: state.estimates,
        todayDateKey: state.today,
      };
}

function evidenceOf(
  deps: OneFtpDeps,
  state: Snapshot,
  results: readonly FtpTestResult[],
): { readonly test: FtpEvidence; readonly drift: FtpEvidence } {
  const none: FtpEvidence = { kind: "none" };
  if (!state.hasSettings) return { test: none, drift: none };
  const current = state.history.current;
  const differs = (evidence: FtpEvidence): FtpEvidence =>
    evidence.kind !== "none" && evidence.watts === current?.watts ? none : evidence;
  const input = driftOf(deps, state);
  return {
    test: differs(plannedTestEvidence(results, { atMs: current?.setAtMs ?? null })),
    drift: input === null ? none : differs(ftpDriftEvidence(input)),
  };
}

function checkedRecord(
  deps: OneFtpDeps,
  record: FtpProposalRecord,
  state: Snapshot,
  results: readonly FtpTestResult[],
): FtpProposalRecord {
  const step = (evidence: FtpEvidence): FtpProposal =>
    ftpProposalStep(record.proposal, {
      type: "checked",
      evidence,
      icuFtpWatts: state.history.current?.watts ?? null,
      todayDateKey: state.today,
    }).proposal;
  const evidence = evidenceOf(deps, state, results);
  const fromTest = step(evidence.test);
  const proposal =
    fromTest.kind === "quiet" && evidence.drift.kind !== "none" ? step(evidence.drift) : fromTest;
  return settled(record, proposal, state.today);
}

export async function check(deps: OneFtpDeps): Promise<void> {
  const results = await deps.tests.read();
  await deps.store.transaction(async () => {
    const owner = await ftpOwner(deps.store, deps.athleteId());
    if (owner === null) return;
    const record = await readFtpRecord(deps.store, owner);
    const next = checkedRecord(deps, record, await snapshot(deps), results);
    if (JSON.stringify(next) !== JSON.stringify(record)) {
      await saveFtpRecord(deps.store, next, deps.now());
    }
  });
}

export async function checkFtp(deps: OneFtpDeps): Promise<void> {
  await serially(deps.store, () => check(deps));
}

function basisOf(
  deps: OneFtpDeps,
  proposal: Extract<FtpProposal, { kind: "shown" | "confirming" }>,
  state: Snapshot,
  results: readonly FtpTestResult[],
): PlanCalendarFtpBasis {
  const basis = proposal.basis;
  if (basis.kind === "planned-test") {
    const best = results.find((result) => result.activityId === basis.activityId);
    return {
      kind: "planned-test",
      testDateKey: basis.dateKey,
      bestWatts: best === undefined ? null : Math.round(best.twentyMinuteWatts),
    };
  }
  const input = driftOf(deps, state);
  const run = input === null ? null : ftpDriftRun(input);
  const current = state.history.current?.watts ?? null;
  return {
    kind: "drift",
    direction: run?.direction ?? (current !== null && proposal.watts < current ? "below" : "above"),
    sinceDateKey: run?.sinceDateKey ?? null,
    lowWatts: run?.lowWatts ?? null,
    highWatts: run?.highWatts ?? null,
    lowestWatts: run?.lowestRecentWatts ?? null,
  };
}

async function proposalOf(
  deps: OneFtpDeps,
  record: FtpProposalRecord,
  state: Snapshot,
  results: readonly FtpTestResult[],
): Promise<PlanCalendarFtpProposal> {
  const proposal = record.proposal;
  if (proposal.kind === "quiet" || proposal.kind === "writing") return { kind: "none" };
  const shared = {
    watts: proposal.watts,
    basis: basisOf(deps, proposal, state, results),
    shownOnDateKey: record.shownOnDateKey ?? state.today,
  };
  if (proposal.kind === "shown") {
    return {
      kind: "shown",
      ...shared,
      percent: ftpChangePercent(state.history.current?.watts ?? null, proposal.watts),
    };
  }
  return {
    kind: "confirming",
    ...shared,
    percent: ftpChangePercent(proposal.icuWattsShown, proposal.watts),
    icuWatts: proposal.icuWattsShown,
    changedSinceUse: proposal.icuWattsShown !== record.usedIcuWatts,
    icuChangedAtMs: record.icuChangedAtMs,
    workoutsOnIntervals: await countWorkoutsOnIntervals(deps.store, state.today),
  };
}

function chartOf(deps: OneFtpDeps, state: Snapshot): PlanCalendarFtpRead["chart"] {
  const startDateKey = addCivilDays(state.today, -(FTP_CHART_DAYS - 1));
  const steps: PlanCalendarFtpRead["chart"]["steps"][number][] = [];
  for (const point of state.history.points) {
    const dateKey = point.source === "first-sync" ? startDateKey : deps.dateKeyOfMs(point.setAtMs);
    if (dateKey > state.today) continue;
    const step = {
      dateKey: Math.max(dateKey, startDateKey),
      watts: point.watts,
      source: point.source,
    };
    if (steps.at(-1)?.dateKey === step.dateKey) steps[steps.length - 1] = step;
    else if (dateKey <= startDateKey) steps.splice(0, steps.length, step);
    else steps.push(step);
  }
  return { startDateKey, endDateKey: state.today, steps: steps.slice(-500) };
}

export async function readModel(
  deps: OneFtpDeps,
  outcome: PlanCalendarFtpOutcome,
): Promise<PlanCalendarFtpRead> {
  const results = await deps.tests.read();
  const state = await snapshot(deps);
  const record = await readFtpRecord(deps.store, await ftpOwner(deps.store, deps.athleteId()));
  const line = (entry: FtpHistory["ride"][number]) => ({
    watts: entry.watts,
    dateKey: deps.dateKeyOfMs(entry.setAtMs),
    source: entry.source,
  });
  return {
    status: "ftp",
    todayDateKey: state.today,
    current: state.history.current === null ? null : line(state.history.current),
    history: state.history.ride.slice(-500).map(line),
    estimates: state.estimates.slice(-400).map((sample) => ({
      dateKey: sample.dateKey,
      watts: sample.estimatedFtpWatts,
    })),
    chart: chartOf(deps, state),
    proposal: await proposalOf(deps, record, state, results),
    outcome,
  };
}

export async function readFtp(deps: OneFtpDeps): Promise<PlanCalendarFtpRead> {
  return serially(deps.store, async () => {
    await check(deps);
    return readModel(deps, "none");
  });
}
