import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlanRepository, type PlanSummaryRecord } from "@enduragent/kernel/planning";
import { runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "../src/sqlite/index.js";

const id = (value: string) => value.padStart(26, "0");
const activatedAtMs = 883_612_800_000;

describe("Plan library repository", () => {
  let store: SqlStore & MigratorStore;

  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
  });

  afterEach(async () => store.close());

  async function seed(input: {
    key: string;
    closeReason?: Exclude<PlanSummaryRecord["closeReason"], null>;
    closedAtMs?: number;
    revisionKind?: "activation" | "migration";
  }): Promise<PlanSummaryRecord> {
    const planId = id(input.key);
    const closeReason = input.closeReason ?? null;
    const closedAtMs = input.closedAtMs ?? null;
    const status = closeReason === null ? "active" : "closed";
    await createPlanRepository(store).replace(
      {
        id: planId,
        originId: null,
        name: `Endurance Plan ${input.key}`,
        primaryGoal: "Build endurance",
        startDateKey: 19980101,
        targetDateKey: null,
        status: status === "active" ? "active" : "ended",
        kind: "full_plan",
        totalWeeks: 12,
        weekStartDay: 4,
        structureJson: "{}",
        createdAtMs: activatedAtMs,
        updatedAtMs: closedAtMs ?? activatedAtMs,
        deviceId: "test-device",
        hlcPhysicalMs: activatedAtMs,
        hlcCounter: 0,
      },
      [],
    );
    await store.run(
      `INSERT INTO planning_plan (plan_id,status,version,current_revision_number,
       activated_at_ms,closed_at_ms,close_reason,close_actor,updated_at_ms,
       device_id,hlc_physical_ms,hlc_counter) VALUES (?,?,1,1,?,?,?,?,?,'test-device',?,0)`,
      [
        planId,
        status,
        activatedAtMs,
        closedAtMs,
        closeReason,
        closeReason === "completed"
          ? "system:plan-completion"
          : closeReason === "stopped"
            ? "athlete"
            : null,
        closedAtMs ?? activatedAtMs,
        activatedAtMs,
      ],
    );
    const creationId = input.revisionKind === "activation" ? id(`C${input.key}`) : null;
    if (input.revisionKind !== undefined) {
      await store.run(
        `INSERT INTO plan_revision (id,plan_id,revision_number,parent_revision_number,
         source_kind,source_id,snapshot_json,fingerprint,created_at_ms,
         device_id,hlc_physical_ms,hlc_counter) VALUES (?,?,1,NULL,?,?,'{}',?,?,'test-device',?,0)`,
        [
          id(`R${input.key}`),
          planId,
          input.revisionKind,
          creationId,
          "f".repeat(64),
          activatedAtMs,
          activatedAtMs,
        ],
      );
    }
    return {
      planId,
      name: `Endurance Plan ${input.key}`,
      startDateKey: 19980101,
      totalWeeks: 12,
      status,
      closeReason,
      closedAtMs,
      activatedAtMs,
      version: 1,
      creationId,
    };
  }

  it("returns no summaries when no Plans exist", async () => {
    await expect(createPlanRepository(store).listPlans()).resolves.toEqual([]);
  });

  it("reads one active Plan with its activation creation lineage", async () => {
    const active = await seed({ key: "1", revisionKind: "activation" });
    await expect(createPlanRepository(store).listPlans()).resolves.toEqual([active]);
  });

  it("orders closed Plans by closure date with stable ties and preserves missing activation lineage", async () => {
    const oldest = await seed({
      key: "3",
      closeReason: "legacy-unclassified",
      closedAtMs: activatedAtMs + 86_400_000,
      revisionKind: "migration",
    });
    const stopped = await seed({
      key: "2",
      closeReason: "stopped",
      closedAtMs: activatedAtMs + 172_800_000,
      revisionKind: "activation",
    });
    const completed = await seed({
      key: "1",
      closeReason: "completed",
      closedAtMs: activatedAtMs + 172_800_000,
    });
    const repository = createPlanRepository(store);
    await expect(repository.listPlans()).resolves.toEqual([completed, stopped, oldest]);
    const active = await seed({ key: "4" });
    const queries = vi.spyOn(store, "all");
    const individualReads = vi.spyOn(store, "get");
    await expect(repository.listPlans()).resolves.toEqual([active, completed, stopped, oldest]);
    expect(queries).toHaveBeenCalledTimes(1);
    expect(individualReads).not.toHaveBeenCalled();
  });
});
