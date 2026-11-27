import type {
  PlanCalendarEarlierVerdict,
  PlanCalendarRide,
  PlanCalendarRideReview,
  PlanCalendarRpcResult,
  PlanCalendarVerdict,
  PlanCalendarVerdictExpected,
  PlanCalendarVerdictMarker,
} from "@enduragent/coach-contract";
import {
  COACH_TEXT_NOT_WRITTEN,
  coachTextMarker,
  coachTextStep,
  type CoachText,
  type CoachTextBasis,
  type CoachTextEvent,
  type CoachTextMatch,
} from "@enduragent/engine/calendar";
import {
  COACH_TEXT_DEADLINE_MS,
  type CoachTextFacts,
  type CoachTextMatched,
  type CoachTextWriterPort,
} from "@enduragent/engine/coach-text-writer";
import {
  createActivityReviewRepository,
  type ActivityReviewEarlier,
  type ActivityReviewMatch,
  type ActivityReviewRecord,
  type ActivityReviewTrigger,
} from "@enduragent/kernel/planning";
import type { MigratorStore, SqlStore } from "@enduragent/kernel/store";
import { isoOf } from "./plan-calendar-read.js";
import { readRideInPlan, type RideInPlan } from "./plan-calendar-rides.js";

export const VERDICT_JOB_MS = COACH_TEXT_DEADLINE_MS + 15_000;
export const VERDICT_LEASE_MS = VERDICT_JOB_MS + 15_000;

export interface RideVerdictModel extends CoachTextWriterPort {
  available(): boolean;
}

export interface PlanCalendarReviewDeps {
  readonly store: SqlStore & Pick<MigratorStore, "transaction">;
  readonly todayDateKey: () => number;
  readonly now: () => number;
  readonly coachText?: RideVerdictModel;
  readonly logger?: { warn(event: string): void };
}

type Refusal = Extract<PlanCalendarRpcResult, { status: "refused" }>;
type Blocked = PlanCalendarRideReview["blocked"];

interface Job {
  readonly activityId: string;
  readonly replies: number;
  readonly facts: CoachTextFacts;
}

const REFUSED: Refusal = Object.freeze({ status: "refused", reason: "review-changed" });

const LIVE_JOBS = new WeakMap<object, Map<string, number>>();

function liveJobsOf(store: object): Map<string, number> {
  const known = LIVE_JOBS.get(store);
  if (known !== undefined) return known;
  const jobs = new Map<string, number>();
  LIVE_JOBS.set(store, jobs);
  return jobs;
}

function empty(activityId: string): ActivityReviewRecord {
  return { activityId, verdict: { state: "not-written" }, replies: 0, earlier: null, note: null };
}

function textOf(record: ActivityReviewRecord): CoachText {
  const verdict = record.verdict;
  switch (verdict.state) {
    case "not-written":
      return COACH_TEXT_NOT_WRITTEN;
    case "writing":
      return { kind: "writing", startedFor: verdict.for };
    case "failed":
      return { kind: "failed", startedFor: verdict.for, failedBy: verdict.failedBy };
    case "kept":
      return { kind: "kept", writtenFor: verdict.for };
  }
}

function basisOf(ride: PlanCalendarRide): CoachTextBasis {
  switch (ride.match.kind) {
    case "suggested":
      return { kind: "waiting-for-match" };
    case "confirmed":
      return {
        kind: "decided",
        match: { kind: "workout", planWorkoutId: ride.match.planWorkoutId },
      };
    case "none":
      return { kind: "decided", match: { kind: "no-workout" } };
  }
}

export function hasFileData(ride: PlanCalendarRide): boolean {
  return (
    ride.durationS !== null &&
    ride.durationS > 0 &&
    (ride.averagePowerW !== null || ride.averageHeartRateBpm !== null)
  );
}

function blockedOf(read: RideInPlan, model: RideVerdictModel | undefined): Blocked {
  if (!hasFileData(read.ride)) return "no-file";
  if (model?.available() !== true) return "no-model";
  return read.ride.match.kind === "suggested" ? "waiting-for-match" : "none";
}

function markerOf(writtenFor: ActivityReviewMatch, read: RideInPlan): PlanCalendarVerdictMarker {
  const marker = coachTextMarker({ kind: "kept", writtenFor }, basisOf(read.ride));
  if (marker.kind === "current") return marker;
  switch (read.ride.match.kind) {
    case "confirmed":
      return { kind: "matched-to", name: read.ride.match.name };
    case "none":
      return { kind: "matched-extra" };
    case "suggested":
      return { kind: "match-pending" };
  }
}

function earlierView(
  earlier: ActivityReviewEarlier | null,
  read: RideInPlan,
): PlanCalendarEarlierVerdict | null {
  if (earlier === null) return null;
  return {
    text: earlier.text,
    writtenAtMs: earlier.writtenAtMs,
    trigger: earlier.trigger,
    usedPlan: earlier.usedPlan,
    usedNote: earlier.usedNote,
    marker: markerOf(earlier.for, read),
    replies: earlier.replies,
  };
}

function verdictView(record: ActivityReviewRecord, read: RideInPlan): PlanCalendarVerdict {
  const verdict = record.verdict;
  switch (verdict.state) {
    case "not-written":
    case "writing":
      return { state: verdict.state };
    case "failed":
      return {
        state: "failed",
        failedBy: verdict.failedBy,
        earlier: earlierView(record.earlier, read),
      };
    case "kept":
      return {
        state: "kept",
        text: verdict.text,
        writtenAtMs: verdict.writtenAtMs,
        trigger: verdict.trigger,
        usedPlan: verdict.usedPlan,
        usedNote: verdict.usedNote,
        marker: markerOf(verdict.for, read),
      };
  }
}

function earlierOf(record: ActivityReviewRecord): ActivityReviewEarlier | null {
  const verdict = record.verdict;
  if (verdict.state !== "kept") return record.earlier;
  return {
    text: verdict.text,
    writtenAtMs: verdict.writtenAtMs,
    for: verdict.for,
    trigger: verdict.trigger,
    usedPlan: verdict.usedPlan,
    usedNote: verdict.usedNote,
    replies: record.replies,
  };
}

function matchedOf(read: RideInPlan, hasWeek: boolean): CoachTextMatched {
  const match = read.ride.match;
  if (match.kind === "confirmed") {
    return {
      kind: "workout",
      workout: { date: isoOf(match.dateKey), name: match.name, durationS: match.durationS },
      outcome: match.outcome,
    };
  }
  if (hasWeek) return { kind: "extra" };
  return read.planned ? { kind: "outside-plan" } : { kind: "no-plan" };
}

function reviewView(
  record: ActivityReviewRecord,
  read: RideInPlan,
  model: RideVerdictModel | undefined,
): PlanCalendarRpcResult {
  return {
    status: "review",
    review: {
      activityId: record.activityId,
      verdict: verdictView(record, read),
      replies: record.replies,
      blocked: blockedOf(read, model),
      note: record.note,
    },
  };
}

function factsOf(read: RideInPlan, note: string | null): CoachTextFacts {
  const ride = read.ride;
  const week =
    read.week === null
      ? null
      : {
          trainingWeek: read.week.index,
          workouts: read.week.workouts.map((workout) => ({
            date: isoOf(workout.dateKey),
            name: workout.name,
            durationS: workout.durationS,
          })),
        };
  return {
    ride: {
      date: isoOf(ride.dateKey),
      kind: ride.kind,
      name: ride.name,
      durationS: ride.durationS,
      distanceM: ride.distanceM,
      load: ride.load,
      averagePowerW: ride.averagePowerW,
      averageHeartRateBpm: ride.averageHeartRateBpm,
      perceivedExertion: ride.perceivedExertion,
    },
    matched: matchedOf(read, week !== null),
    week,
    note,
  };
}

function sameExpected(
  record: ActivityReviewRecord,
  expected: PlanCalendarVerdictExpected,
): boolean {
  return record.verdict.state === expected.state && record.replies === expected.replies;
}

export function createPlanCalendarReview(deps: PlanCalendarReviewDeps) {
  const reviews = createActivityReviewRepository(deps.store);
  const live = liveJobsOf(deps.store);

  const failWriting = async (record: ActivityReviewRecord): Promise<ActivityReviewRecord> => {
    const verdict = record.verdict;
    const step = coachTextStep(textOf(record), { type: "writing-abandoned" });
    if (verdict.state !== "writing" || step.text.kind !== "failed") return record;
    const failed: ActivityReviewRecord = {
      ...record,
      verdict: { ...verdict, state: "failed", failedBy: step.text.failedBy },
    };
    await reviews.save(failed, deps.now());
    return failed;
  };

  const settled = async (activityId: string): Promise<ActivityReviewRecord> => {
    const record = (await reviews.read(activityId)) ?? empty(activityId);
    const verdict = record.verdict;
    if (
      verdict.state !== "writing" ||
      deps.now() - verdict.startedAtMs < VERDICT_LEASE_MS ||
      live.get(activityId) === record.replies
    ) {
      return record;
    }
    return failWriting(record);
  };

  const finish = async (job: Job, text: string | null): Promise<void> => {
    await deps.store.transaction(async () => {
      const record = await reviews.read(job.activityId);
      const verdict = record?.verdict;
      if (record === undefined || verdict?.state !== "writing" || record.replies !== job.replies) {
        return;
      }
      const event: CoachTextEvent =
        text === null ? { type: "writing-failed" } : { type: "writing-finished" };
      const step = coachTextStep(textOf(record), event);
      const now = Math.max(deps.now(), verdict.startedAtMs);
      await reviews.save(
        step.text.kind === "kept" && text !== null
          ? {
              ...record,
              verdict: { ...verdict, state: "kept", text, writtenAtMs: now },
              earlier: null,
            }
          : {
              ...record,
              verdict: {
                ...verdict,
                state: "failed",
                failedBy: step.text.kind === "failed" ? step.text.failedBy : "model",
              },
            },
        now,
      );
    });
  };

  const run = async (job: Job, model: RideVerdictModel): Promise<void> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, VERDICT_JOB_MS);
    });
    let text: string | null;
    try {
      text = await Promise.race([model.writeCoachText(job.facts, controller.signal), expired]);
    } catch {
      text = null;
    } finally {
      clearTimeout(timer);
    }
    await finish(job, text);
  };

  const start = (job: Job | null): void => {
    const model = deps.coachText;
    if (job === null || model === undefined) return;
    live.set(job.activityId, job.replies);
    run(job, model)
      .catch(() => deps.logger?.warn("ride_verdict_not_saved"))
      .finally(() => {
        if (live.get(job.activityId) === job.replies) live.delete(job.activityId);
      });
  };

  const step = async (
    activityId: string,
    event: (basis: CoachTextBasis) => CoachTextEvent,
    trigger: ActivityReviewTrigger,
    expected: PlanCalendarVerdictExpected | null,
  ): Promise<PlanCalendarRpcResult> => {
    let job: Job | null = null;
    const result = await deps.store.transaction(async (): Promise<PlanCalendarRpcResult> => {
      const read = await readRideInPlan(deps.store, deps.todayDateKey(), activityId);
      if (read === undefined) return REFUSED;
      const record = await settled(activityId);
      if (expected !== null && !sameExpected(record, expected)) return REFUSED;
      const blocked = blockedOf(read, deps.coachText);
      if (blocked === "no-file" || blocked === "no-model") {
        return reviewView(record, read, deps.coachText);
      }
      const stepped = coachTextStep(textOf(record), event(basisOf(read.ride)));
      if (stepped.effect.kind !== "write") return reviewView(record, read, deps.coachText);
      const writtenFor: CoachTextMatch = stepped.effect.for;
      const note = trigger === "asked" ? (record.note?.text ?? null) : null;
      const facts = factsOf(read, note);
      const writing: ActivityReviewRecord = {
        ...record,
        verdict: {
          state: "writing",
          for: writtenFor,
          trigger,
          usedPlan: facts.matched.kind === "workout" || facts.matched.kind === "extra",
          usedNote: note !== null,
          startedAtMs: deps.now(),
        },
        replies: record.replies + 1,
        earlier: earlierOf(record),
      };
      await reviews.save(writing, deps.now());
      job = { activityId, replies: writing.replies, facts };
      return reviewView(writing, read, deps.coachText);
    });
    start(job);
    return result;
  };

  return {
    async read(activityId: string): Promise<PlanCalendarRpcResult> {
      return deps.store.transaction(async () => {
        const read = await readRideInPlan(deps.store, deps.todayDateKey(), activityId);
        if (read === undefined) return REFUSED;
        return reviewView(await settled(activityId), read, deps.coachText);
      });
    },
    write(request: {
      readonly activityId: string;
      readonly event: "opens" | "asks-again";
      readonly expected: PlanCalendarVerdictExpected;
    }): Promise<PlanCalendarRpcResult> {
      return step(
        request.activityId,
        (basis) =>
          request.event === "opens"
            ? { type: "athlete-opens", basis }
            : { type: "athlete-asks-again", basis },
        request.event === "opens" ? "opened" : "asked",
        request.expected,
      );
    },
    matchDecided(activityId: string): Promise<PlanCalendarRpcResult> {
      return step(
        activityId,
        (basis) => ({ type: "match-decided", basis, page: "open" }),
        "matched",
        null,
      );
    },
    async saveNote(request: {
      readonly activityId: string;
      readonly note: string;
    }): Promise<PlanCalendarRpcResult> {
      return deps.store.transaction(async () => {
        const read = await readRideInPlan(deps.store, deps.todayDateKey(), request.activityId);
        if (read === undefined) return REFUSED;
        const record = await settled(request.activityId);
        const text = request.note.trim();
        const saved: ActivityReviewRecord = {
          ...record,
          note: text.length === 0 ? null : { text, savedAtMs: deps.now() },
        };
        await reviews.save(saved, deps.now());
        return reviewView(saved, read, deps.coachText);
      });
    },
  };
}
