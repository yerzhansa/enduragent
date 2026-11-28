import {
  PlanCalendarRpcParamsSchema,
  type PlanCalendarRpcParams,
  type PlanCalendarRpcResult,
} from "@enduragent/coach-contract";
import {
  readWeekDelivery,
  saveWeekDelivery,
  weekDeliveryStep,
  type CalendarMirrorPort,
} from "@enduragent/engine/calendar";
import {
  createPlanCalendarMirrorRepository,
  createPlanReconciliationRepository,
} from "@enduragent/kernel/planning";
import type { MigratorStore, SqlStore } from "@enduragent/kernel/store";
import { createLegacyPlanRepository } from "@enduragent/kernel-node/planning";
import { todayInTZ } from "@enduragent/engine/sport";
import { changeDetail, keepChange, putBackChange } from "./plan-calendar-changes.js";
import type { PlanCalendarEditDeps } from "./plan-calendar-edit.js";
import { planDetails, saveEndChoice } from "./plan-calendar-details.js";
import { moveWorkout } from "./plan-calendar-move.js";
import { readPlanCalendar } from "./plan-calendar-read.js";
import { releaseReplacedPlans } from "./plan-calendar-replace.js";
import { createPlanCalendarReview, type RideVerdictModel } from "./plan-calendar-review.js";
import { decideRide, readRides } from "./plan-calendar-rides.js";
import { readFtp, type OneFtpDeps } from "./one-ftp.js";
import { answerFtp } from "./one-ftp-answer.js";
import { createRideFtpReader } from "./one-ftp-rides.js";
import type { IcuSportSettingsPort } from "./one-ftp-icu.js";
import { createStoredFtpTestResults, type FtpTestResultSource } from "./one-ftp-tests.js";

const SEND_AGAIN_WAIT_MS = 20_000;

export function dateKeyOfMsIn(timezone: () => string): (ms: number) => number {
  return (ms) => Number(todayInTZ(timezone(), new Date(ms)).replaceAll("-", ""));
}

async function settledWithin(settled: () => Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    settled(),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}

const NO_ICU_SETTINGS: IcuSportSettingsPort = {
  readRide: () => Promise.reject(new Error("Intervals credentials are required.")),
  writeRideFtp: () => Promise.reject(new Error("Intervals credentials are required.")),
};

export interface PlanCalendarFtpParts {
  readonly icu: IcuSportSettingsPort;
  readonly tests?: FtpTestResultSource;
  readonly athleteId: () => string | null;
}

export interface PlanCalendarOperations {
  "plan.calendar"(request: PlanCalendarRpcParams): Promise<PlanCalendarRpcResult>;
}

export function createPlanCalendarOperations(
  deps: PlanCalendarEditDeps & {
    readonly store: SqlStore & Pick<MigratorStore, "transaction">;
    readonly calendar: { readonly mirror: CalendarMirrorPort };
    readonly todayDateKey: () => number;
    readonly now: () => number;
    readonly calendarConnected: () => boolean;
    readonly dateKeyOfMs: (ms: number) => number;
    readonly changed: () => Promise<void>;
    readonly coachText?: RideVerdictModel;
    readonly logger?: { warn(event: string): void };
    readonly ftp?: PlanCalendarFtpParts;
  },
): PlanCalendarOperations {
  const mirror = createPlanCalendarMirrorRepository(deps.store);
  const review = createPlanCalendarReview(deps);
  const plans = createLegacyPlanRepository(deps.store);
  const ftp: OneFtpDeps = {
    store: deps.store,
    icu: deps.ftp?.icu ?? NO_ICU_SETTINGS,
    tests: deps.ftp?.tests ?? createStoredFtpTestResults(deps.store),
    todayDateKey: deps.todayDateKey,
    now: deps.now,
    dateKeyOfMs: deps.dateKeyOfMs,
    newId: () => deps.identity.newUlid(),
    athleteId: () => deps.ftp?.athleteId() ?? null,
  };
  const rideFtp = createRideFtpReader({
    store: deps.store,
    athleteId: ftp.athleteId,
    dateKeyOfMs: deps.dateKeyOfMs,
  });
  return {
    async "plan.calendar"(raw) {
      const request = PlanCalendarRpcParamsSchema.parse(raw);
      switch (request.action) {
        case "read":
          return readPlanCalendar(
            {
              store: deps.store,
              todayDateKey: deps.todayDateKey(),
              calendarConnected: deps.calendarConnected(),
              dateKeyOfMs: deps.dateKeyOfMs,
            },
            request,
          );
        case "rides":
          return readRides(
            {
              store: deps.store,
              identity: deps.identity,
              todayDateKey: deps.todayDateKey(),
              rideFtp,
            },
            request,
          );
        case "decide-ride": {
          const decided = await decideRide({ ...deps, rideFtp }, request);
          if (decided.status !== "ride") return decided;
          try {
            await review.matchDecided(request.activityId);
          } catch {
            deps.logger?.warn("ride_verdict_not_started");
          }
          return decided;
        }
        case "read-review":
          return review.read(request.activityId);
        case "write-verdict":
          return review.write(request);
        case "save-note":
          return review.saveNote(request);
        case "ftp":
          return readFtp(ftp);
        case "ftp-answer":
          return answerFtp(ftp, request);
        case "send-again":
          await createPlanReconciliationRepository(deps.store).reopenFailedCleanups(deps.now());
          await settledWithin(deps.changed, SEND_AGAIN_WAIT_MS);
          return { status: "sending" };
        case "read-settings":
          return { status: "settings", weekDelivery: await mirror.readWeekDeliverySetting() };
        case "move-workout":
          return moveWorkout(deps, request);
        case "plan-details":
          return planDetails(deps, request);
        case "save-end-choice":
          return saveEndChoice(deps, request);
        case "change-detail":
        case "keep-change":
        case "put-back": {
          const changeDeps = { ...deps, mirror: deps.calendar.mirror };
          if (request.action === "change-detail") return changeDetail(changeDeps, request);
          if (request.action === "keep-change") return keepChange(changeDeps, request);
          return putBackChange(changeDeps, request);
        }
        case "save-settings":
          await mirror.writeWeekDeliverySetting(request.weekDelivery, deps.now());
          void deps.changed();
          return { status: "settings", weekDelivery: request.weekDelivery };
        case "approve-weeks": {
          const approved = await deps.store.transaction(async () => {
            const active = await deps.store.get(
              "SELECT plan_id FROM planning_plan WHERE plan_id=? AND status='active'",
              [request.planId],
            );
            const plan = active === undefined ? undefined : await plans.read(request.planId);
            if (plan === undefined || plan.status !== "active") {
              return { status: "refused", reason: "no-active-plan" } as const;
            }
            const todayDateKey = deps.todayDateKey();
            const delivery = await readWeekDelivery(mirror, plan.id);
            const result = weekDeliveryStep(
              plan,
              delivery,
              request.scope.kind === "first-weeks"
                ? { type: "first-approve", todayDateKey }
                : { type: "approve-week", week: request.scope.week, todayDateKey },
            );
            if (result.kind === "refused")
              return { status: "refused", reason: result.reason } as const;
            await saveWeekDelivery(mirror, plan.id, result.state, deps.now());
            if (result.state.kind !== "approved") {
              return { status: "refused", reason: "not-approved-yet" } as const;
            }
            if (request.scope.kind === "first-weeks") {
              await releaseReplacedPlans(deps.store, {
                planId: plan.id,
                todayDateKey,
                nowMs: deps.now(),
                newId: () => deps.identity.newUlid(),
                ticked: request.ticked ?? [],
              });
            }
            await createPlanReconciliationRepository(deps.store).reopenFailedCleanups(deps.now());
            return {
              status: "approved",
              weeks:
                request.scope.kind === "first-weeks"
                  ? [...result.state.firstSetWeeks]
                  : [request.scope.week],
            } as const;
          });
          if (approved.status === "approved") void deps.changed();
          return approved;
        }
      }
    },
  };
}
