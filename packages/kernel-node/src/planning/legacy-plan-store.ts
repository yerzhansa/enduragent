import {
  createPlanRepository,
  legacyPlanRows,
  type PlanRepository,
  type PlanningIdentity,
} from "@enduragent/kernel/planning";
import type { MigratorStore, SqlStore } from "@enduragent/kernel/store";
import type { AuthoredIdentity } from "../store/authored-identity.js";

export interface LegacyPlanImportLogger {
  warn(message: string): void;
}

type PlanningStore = SqlStore & Pick<MigratorStore, "transaction">;

async function planningIdentity(identity: AuthoredIdentity): Promise<PlanningIdentity> {
  const deviceId = await identity.deviceId();
  return Object.freeze({
    deviceId,
    newId: () => identity.newUlid(),
    stamp: () => identity.hlcStamp(),
  });
}

export async function createLegacyPlanRowWriter(input: {
  readonly repository: PlanRepository;
  readonly identity: AuthoredIdentity;
  readonly fallbackDateKey: () => number;
  readonly now: () => number;
}): Promise<(value: unknown) => Promise<void>> {
  const identity = await planningIdentity(input.identity);
  let currentPlanId: string | undefined;
  return async (value: unknown): Promise<void> => {
    const todayDateKey = input.fallbackDateKey();
    const originId =
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof (value as { readonly id?: unknown }).id === "string"
        ? (value as { readonly id: string }).id
        : undefined;
    const existing =
      originId === undefined
        ? currentPlanId === undefined
          ? await input.repository.readLatest()
          : await input.repository.read(currentPlanId)
        : await input.repository.readByOriginId(originId);
    const rows = legacyPlanRows({
      value,
      identity,
      fallbackDateKey: todayDateKey,
      fallbackTimestampMs: input.now(),
      ...(existing === undefined ? {} : { existingPlanId: existing.id }),
    });
    if (existing === undefined) {
      await input.repository.replaceNew(rows.plan, rows.workouts, todayDateKey);
    } else {
      await input.repository.replace(rows.plan, rows.workouts);
    }
    currentPlanId = rows.plan.id;
  };
}

export function createLegacyPlanRepository(store: PlanningStore): PlanRepository {
  return createPlanRepository(store);
}
