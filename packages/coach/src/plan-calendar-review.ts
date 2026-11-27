import type {
  PlanCalendarRide,
  PlanCalendarRideReview,
  PlanCalendarRpcResult,
  PlanCalendarVerdict,
  PlanCalendarVerdictExpected,
  PlanCalendarVerdictMarker,
} from "@enduragent/coach-contract";
import {
  COACH_TEXT_DEADLINE_MS,
  COACH_TEXT_NOT_WRITTEN,
  coachTextMarker,
  coachTextStep,
  type CoachText,
  type CoachTextBasis,
  type CoachTextEvent,
  type CoachTextFacts,
  type CoachTextMatch,
  type CoachTextWriterPort,
} from "@enduragent/engine/calendar";
import {
  createActivityReviewRepository,
  type ActivityReviewAttempt,
  type ActivityReviewRecord,
  type ActivityReviewTrigger,
} from "@enduragent/kernel/planning";
import type { MigratorStore, SqlStore } from "@enduragent/kernel/store";
import { isoOf } from "./plan-calendar-read.js";
import { readRideInPlan, type RideInPlan } from "./plan-calendar-rides.js";

export const VERDICT_LEASE_MS = COACH_TEXT_DEADLINE_MS + 30_000;

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

function empty(activityId: string): ActivityReviewRecord {
  return { activityId, verdict: { state: "not-written" }, replies: 0, note: null };
}

function textOf(record: ActivityReviewRecord): CoachText {
  const verdict = record.verdict;
  switch (verdict.state) {
    case "not-written":
      return COACH_TEXT_NOT_WRITTEN;
    case "writing":
      return { kind: "writing", startedFor: verdict.for };
    case "failed":
      return { kind: "failed", startedFor: verdict.for };
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

function markerOf(record: ActivityReviewRecord, read: RideInPlan): PlanCalendarVerdictMarker {
  const marker = coachTextMarker(textOf(record), basisOf(read.ride));
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

function verdictView(record: ActivityReviewRecord, read: RideInPlan): PlanCalendarVerdict {
  const verdict = record.verdict;
  if (verdict.state !== "kept") return { state: verdict.state };
  return {
    state: "kept",
    text: verdict.text,
    writtenAtMs: verdict.writtenAtMs,
    trigger: verdict.trigger,
    usedPlan: verdict.usedPlan,
    usedNote: verdict.usedNote,
    marker: markerOf(record, read),
  };
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
    matched:
      ride.match.kind === "confirmed"
        ? {
            kind: "workout",
            workout: {
              date: isoOf(ride.match.dateKey),
              name: ride.match.name,
              durationS: ride.match.durationS,
            },
            outcome: ride.match.outcome,
          }
        : week === null
          ? { kind: "no-plan" }
          : { kind: "extra" },
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

  const failWriting = async (record: ActivityReviewRecord): Promise<ActivityReviewRecord> => {
    const verdict = record.verdict;
    const step = coachTextStep(textOf(record), { type: "writing-abandoned" });
    if (verdict.state !== "writing" || step.text.kind !== "failed") return record;
    const failed: ActivityReviewRecord = { ...record, verdict: { ...verdict, state: "failed" } };
    await reviews.save(failed, deps.now());
    return failed;
  };

  const settled = async (activityId: string): Promise<ActivityReviewRecord> => {
    const record = (await reviews.read(activityId)) ?? empty(activityId);
    const verdict = record.verdict;
    if (verdict.state !== "writing" || deps.now() - verdict.startedAtMs < VERDICT_LEASE_MS) {
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
      const attempt: ActivityReviewAttempt = verdict;
      const now = Math.max(deps.now(), attempt.startedAtMs);
      await reviews.save(
        {
          ...record,
          verdict:
            step.text.kind === "kept" && text !== null
              ? { ...attempt, state: "kept", text, writtenAtMs: now }
              : { ...attempt, state: "failed" },
        },
        now,
      );
    });
  };

  const run = async (job: Job, model: RideVerdictModel): Promise<void> => {
    let text: string | null;
    try {
      text = await model.writeCoachText(job.facts, new AbortController().signal);
    } catch {
      text = null;
    }
    await finish(job, text);
  };

  const start = (job: Job | null): void => {
    const model = deps.coachText;
    if (job === null || model === undefined) return;
    run(job, model).catch(() => deps.logger?.warn("ride_verdict_not_saved"));
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
          usedPlan: facts.matched.kind !== "no-plan",
          usedNote: note !== null,
          startedAtMs: deps.now(),
        },
        replies: record.replies + 1,
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
