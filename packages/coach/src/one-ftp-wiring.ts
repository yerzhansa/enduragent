import type { IntervalsClient } from "intervals-icu-api";
import { checkFtp, type OneFtpDeps } from "./one-ftp.js";
import { createIcuSportSettingsPort } from "./one-ftp-icu.js";
import { createStoredFtpTestResults } from "./one-ftp-tests.js";
import type { PlanCalendarFtpParts } from "./plan-calendar-operations.js";

export interface OneFtpWiringInput {
  readonly store: OneFtpDeps["store"];
  readonly readClient: () => IntervalsClient | null;
  readonly todayDateKey: () => number;
  readonly now: () => number;
  readonly dateKeyOfMs: (ms: number) => number;
  readonly identity: { readonly newUlid: () => string };
  readonly logger: { warn(event: string, error?: unknown): void };
  readonly closing: () => boolean;
  readonly athleteId: () => string | null;
}

export interface OneFtpWiring {
  readonly parts: PlanCalendarFtpParts;
  afterSync<Args extends unknown[], Result>(
    operation: (...args: Args) => Promise<Result>,
  ): (...args: Args) => Promise<Result>;
}

export function createOneFtpWiring(input: OneFtpWiringInput): OneFtpWiring {
  const deps: OneFtpDeps = {
    store: input.store,
    icu: createIcuSportSettingsPort(input.readClient),
    tests: createStoredFtpTestResults(input.store),
    todayDateKey: input.todayDateKey,
    now: input.now,
    dateKeyOfMs: input.dateKeyOfMs,
    newId: () => input.identity.newUlid(),
    athleteId: input.athleteId,
  };
  return {
    parts: { icu: deps.icu, tests: deps.tests, athleteId: input.athleteId },
    afterSync(operation) {
      return async (...args) => {
        const result = await operation(...args);
        if (!input.closing()) {
          void checkFtp(deps).catch((error: unknown) => {
            input.logger.warn("ftp_check_failed", error);
          });
        }
        return result;
      };
    },
  };
}
