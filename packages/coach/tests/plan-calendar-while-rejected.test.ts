import * as calendarDrain from "../src/plan-calendar-drain.js";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_DROPPED_ACTIVITIES,
  type CoachEngine,
  type PlanCreationAnswerInput,
} from "@enduragent/coach-contract";
import {
  bundledAcceptedCatalog,
  recordIntervalsCredentialResponse,
  type Config,
} from "@enduragent/core";
import {
  LATEST_SCHEMA_VERSION,
  SCHEDULER_SCHEMA_VERSION,
} from "@enduragent/kernel/reference/schemas";
import { createPhysicalRequestLedger, runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import { inertWriterProtocolListener } from "@enduragent/kernel-node/lock";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import {
  createLocalCoachComposition,
  type LocalCoachComposition,
  type LocalStoreRuntime,
} from "../src/composition.js";
import type { CoachStoreWriterContext } from "../src/runtime.js";

const roots: string[] = [];
const stores: CoachStoreWriterContext["store"][] = [];
const lifecycles: LocalCoachComposition[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const lifecycle of lifecycles.splice(0)) await lifecycle.close().catch(() => undefined);
  for (const store of stores.splice(0)) await store.close().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function freshHome(plannedWorkouts: readonly unknown[]): Promise<AthleteHome> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "plan-calendar-rejected-"));
  roots.push(root);
  const home = {
    root,
    storeDir: join(root, "store"),
    archiveDir: join(root, "archive"),
    configDir: join(root, "config"),
  };
  await mkdir(join(root, "data"), { recursive: true });
  await mkdir(home.configDir, { recursive: true });
  await writeFile(
    join(root, "data", "latest.json"),
    JSON.stringify({
      metadata: {
        schema_version: LATEST_SCHEMA_VERSION,
        last_updated: "1998-09-01T00:00:00.000Z",
        freshness: "fresh",
      },
      athlete_profile: {},
      current_status: {},
      derived_metrics: {},
      recent_activities: [],
      planned_workouts: plannedWorkouts,
      wellness_data: {},
    }),
  );
  await writeFile(
    join(root, "data", ".scheduler.json"),
    JSON.stringify({
      schema_version: SCHEDULER_SCHEMA_VERSION,
      last_sync_at: "1998-09-01T00:00:00.000Z",
      next_sync_at: "1998-09-01T06:00:00.000Z",
    }),
  );
  return home;
}

function runtime(): LocalStoreRuntime {
  const ledger = createPhysicalRequestLedger({ storeLimit: 64, legacyLimit: 15, totalLimit: 79 });
  const window = async () => ({
    published: true,
    counts: ledger.snapshot(),
    legacySucceeded: true,
    droppedActivities: EMPTY_DROPPED_ACTIVITIES,
  });
  let admission = Promise.resolve();
  const runExclusive: LocalStoreRuntime["runExclusive"] = (work) => {
    const run = () => work(new AbortController().signal);
    const task = admission.then(run, run);
    admission = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  };
  return {
    athleteData: {} as never,
    currentDroppedActivities: () => EMPTY_DROPPED_ACTIVITIES,
    attemptLedgerForRun: () => ledger,
    runWindow: window,
    async runWindowAfter(work) {
      await work(new AbortController().signal, globalThis.fetch);
      return window();
    },
    runExclusive,
    runOutsideWindow: runExclusive,
    async runActivityWrite(work) {
      return { value: await runExclusive(work), activityReadAvailable: true };
    },
    startScheduler() {},
    async close() {},
  };
}

function backend(): CoachEngine {
  return {
    chat: async () => ({ text: "ok" }),
    getCoachDecision: async () => ({ decision: null }),
    answerCoachDecision: async () => {
      throw new Error("not implemented");
    },
    skipCoachDecision: async () => {
      throw new Error("not implemented");
    },
    resumeCoachDecision: async () => {
      throw new Error("not implemented");
    },
    resetSession: async () => ({ memoryFlushed: true }),
    hasSession: async () => ({ hasSession: false }),
    getAthleteState: async () => ({}) as never,
  };
}

async function planCalendarFixture(
  credentials: { refused: string; accepted: string },
  seed: { plannedWorkouts?: readonly unknown[]; lastSuccessfulSyncAtMs?: number } = {},
) {
  const requests: { credential: string; method: string; path: string }[] = [];
  const events: Record<string, unknown>[] = [];
  const credentialOf = (authorization: string): string =>
    [credentials.refused, credentials.accepted].find(
      (credential) =>
        authorization === `Bearer ${credential.replace(/^intervals-oauth:/u, "")}` ||
        authorization === `Basic ${btoa(`API_KEY:${credential}`)}`,
    ) ?? "unknown";
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname !== "intervals.icu") throw new Error("unexpected request");
    const credential = credentialOf(request.headers.get("authorization") ?? "");
    requests.push({ credential, method: request.method, path: url.pathname });
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (credential !== credentials.accepted) return json(401, { status: 401 });
    if (!url.pathname.endsWith("/events")) return json(404, {});
    if (request.method === "POST") {
      const event = { ...((await request.json()) as object), id: events.length + 1 };
      events.push(event);
      return json(200, event);
    }
    const oldest = url.searchParams.get("oldest") ?? "";
    const newest = url.searchParams.get("newest") ?? "";
    return json(
      200,
      events.filter((event) => {
        const date = String(event.start_date_local ?? event.startDateLocal).slice(0, 10);
        return date >= oldest && date <= newest;
      }),
    );
  });
  const home = await freshHome(seed.plannedWorkouts ?? []);
  await mkdir(home.storeDir, { recursive: true });
  const store = openSqliteStorage(join(home.storeDir, "store.db"));
  stores.push(store);
  await runMigrations(store, MIGRATIONS);
  if (seed.lastSuccessfulSyncAtMs !== undefined) {
    await store.run(
      `INSERT INTO source_artifact (artifact_key,source,lane,external_id,artifact_kind,archive_address,archive_rel_path,archive_epoch_s)
      VALUES ('sync-1', 'intervals-icu', 'activities', 'synthetic-sync', 'snapshot', ?, 'synthetic/sync.json', ?)`,
      ["a".repeat(64), seed.lastSuccessfulSyncAtMs / 1000],
    );
  }
  const drains = vi.spyOn(calendarDrain, "createPlanCalendarDrain");
  const config: Config = {
    dataSource: "store",
    llm: { provider: "anthropic", model: "synthetic", apiKey: "" },
    intervals: { apiKey: "", athleteId: "synthetic" },
    telegram: { botToken: "" },
    session: {
      historyTokenBudgetRatio: 0.3,
      idleMinutes: 0,
      dailyResetHour: 4,
      resetArchiveRetentionDays: 0,
      timezone: "UTC",
    },
    contextWindowTokens: 1000,
    dataDir: home.root,
  };
  const catalog = bundledAcceptedCatalog();
  const lifecycle = await createLocalCoachComposition(
    {
      env: { ENDURAGENT_HOME: home.root },
      home,
      context: { home, store, listener: inertWriterProtocolListener },
      config,
      catalog,
      readCatalog: () => catalog,
    },
    {
      bootstrap: async () => ({
        scheduler: { stop() {} },
        async runScheduledOnce() {
          return { kind: "skipped", reason: "cooldown" } as never;
        },
      }),
      createRuntime: () => runtime(),
      createBackend: () => backend(),
      assertRuntimeAthleteOwner: async () => {},
      now: () => Date.UTC(1998, 8, 2, 12),
    },
  );
  lifecycles.push(lifecycle);
  const [created] = drains.mock.results;
  if (created?.type !== "return") throw new Error("Expected the plan calendar drain.");
  const list = lifecycle.operations["plan.list"];
  if (list === undefined) throw new Error("Expected plan.list");
  const started = await lifecycle.operations["plan_creation.start"]({ commandId: "start" });
  if (started.status !== "started") throw new Error("Expected Plan Creation");
  let card = started.planCreation;
  const answers: PlanCreationAnswerInput[] = [
    { kind: "goal", goal: { kind: "fitness" } },
    { kind: "plan-length", weeks: 4 },
    { kind: "schedule-mode", mode: "fixed" },
    {
      kind: "availability",
      mode: "fixed",
      weeklyHoursLimit: 8,
      longestWorkoutHours: 3,
      usableWeekdays: [1, 2, 3, 4, 5, 6, 7],
    },
    { kind: "start-timing", timing: { kind: "as-soon-as-possible" } },
    { kind: "commitments", commitments: { kind: "none" } },
    { kind: "baseline", baseline: "regular" },
    { kind: "success", success: { kind: "fitness-choice", choice: "climb-stronger" } },
    { kind: "restriction", restriction: { kind: "none" } },
  ];
  for (const [index, answer] of answers.entries()) {
    const result = await lifecycle.operations["plan_creation.answer"]({
      commandId: `answer-${index}`,
      creationId: card.creationId,
      expectedVersion: card.version,
      answer,
    });
    if (result.status !== "answered") throw new Error("Expected answer");
    card = result.planCreation;
  }
  const draft = await lifecycle.operations["plan_creation.preview"]({
    commandId: "draft",
    creationId: card.creationId,
    expectedVersion: card.version,
  });
  if (draft.status !== "previewed") throw new Error("Expected Draft");
  const activated = await lifecycle.operations["plan_creation.activate"]({
    commandId: "activate",
    creationId: card.creationId,
    expectedVersion: draft.planCreation.version,
    incumbent: null,
  });
  if (activated.planId === null) throw new Error("Expected active Plan");
  return {
    planId: activated.planId,
    operations: lifecycle.operations,
    requests,
    pushesWith: (credential: string) =>
      requests.filter((request) => request.credential === credential && request.method === "POST"),
    apply: (apiKey: string) =>
      lifecycle.operations.configureRuntime({ intervals: { api_key: apiKey } }),
    async listPlans() {
      const result = await list({});
      await created.value.idle();
      return result;
    },
  };
}

describe("Plan calendar while the intervals.icu sign-in is rejected", () => {
  it("shows the calendar as not connected and sends nothing to intervals.icu", async () => {
    const refused = "intervals-oauth:fixture-calendar-known-rejected";
    const accepted = "intervals-oauth:fixture-calendar-new-sign-in";
    recordIntervalsCredentialResponse(refused, 401);
    const fixture = await planCalendarFixture({ refused, accepted });
    await expect(fixture.apply(refused)).resolves.toMatchObject({ status: "applied" });

    const plans = [];
    for (let poll = 0; poll < 3; poll += 1) plans.push(await fixture.listPlans());

    expect(fixture.requests).toEqual([]);
    expect(plans.map((plan) => plan.active?.calendar.status)).toEqual([
      "not-connected",
      "not-connected",
      "not-connected",
    ]);
  });

  it("pushes the plan to the calendar right after a new sign-in", async () => {
    const refused = "intervals-oauth:fixture-calendar-rejected-before-new";
    const accepted = "intervals-oauth:fixture-calendar-new-sign-in-2";
    recordIntervalsCredentialResponse(refused, 401);
    const fixture = await planCalendarFixture({ refused, accepted });
    await expect(fixture.apply(refused)).resolves.toMatchObject({ status: "applied" });
    await fixture.listPlans();

    await expect(fixture.apply(accepted)).resolves.toMatchObject({ status: "applied" });

    await vi.waitFor(() => expect(fixture.pushesWith(accepted).length).toBeGreaterThan(0));
  });

  it("pushes the plan on the next plan list after a new sign-in", async () => {
    const refused = "intervals-oauth:fixture-calendar-rejected-control";
    const accepted = "intervals-oauth:fixture-calendar-new-sign-in-control";
    recordIntervalsCredentialResponse(refused, 401);
    const fixture = await planCalendarFixture({ refused, accepted });
    await fixture.apply(refused);
    await fixture.listPlans();
    await fixture.apply(accepted);
    await fixture.listPlans();

    expect(fixture.pushesWith(accepted).length).toBeGreaterThan(0);
  });

  it("still pauses Plan Changes when the last sync is older than 24 hours", async () => {
    const refused = "intervals-oauth:fixture-calendar-rejected-stale-sync";
    const accepted = "intervals-oauth:fixture-calendar-new-sign-in-stale-sync";
    recordIntervalsCredentialResponse(refused, 401);
    const lastSuccessfulSyncAtMs = Date.UTC(1998, 7, 31, 7);
    const fixture = await planCalendarFixture({ refused, accepted }, { lastSuccessfulSyncAtMs });
    await expect(fixture.apply(refused)).resolves.toMatchObject({ status: "applied" });

    const preview = await fixture.operations["plan_change.preview"]({
      commandId: "stale-preview",
      planId: fixture.planId,
      expectedVersion: 1,
      intent: { kind: "longest-workout", minutes: 20 },
    });

    expect(preview).toEqual({ status: "rejected", reason: "sync-stale" });
    expect((await fixture.listPlans()).changesPaused).toEqual({
      reason: "sync-stale",
      lastSuccessfulSyncAtMs,
    });
  });

  it("keeps race candidates from the last sync while the sign-in is rejected", async () => {
    const refused = "intervals-oauth:fixture-calendar-rejected-race";
    const accepted = "intervals-oauth:fixture-calendar-new-sign-in-race";
    recordIntervalsCredentialResponse(refused, 401);
    const race = {
      id: 17,
      name: "Autumn ride",
      start_date_local: "1998-09-20T09:00:00",
      category: "RACE_B",
    };
    const fixture = await planCalendarFixture({ refused, accepted }, { plannedWorkouts: [race] });
    await expect(fixture.apply(refused)).resolves.toMatchObject({ status: "applied" });

    expect((await fixture.listPlans()).active?.supportingEventCandidates).toEqual([
      {
        providerId: "17",
        name: "Autumn ride",
        date: "1998-09-20",
        category: "RACE_B",
        sourceLabel: "Intervals.icu event",
      },
    ]);
  });

  it("applies a race change previewed before the sign-in was rejected", async () => {
    const refused = "intervals-oauth:fixture-calendar-unused-race-apply";
    const accepted = "intervals-oauth:fixture-calendar-rejected-after-preview";
    const race = {
      id: 17,
      name: "Autumn ride",
      start_date_local: "1998-09-20T09:00:00",
      category: "RACE_B",
    };
    const fixture = await planCalendarFixture({ refused, accepted }, { plannedWorkouts: [race] });
    await expect(fixture.apply(accepted)).resolves.toMatchObject({ status: "applied" });
    const preview = await fixture.operations["plan_change.preview"]({
      commandId: "race-preview",
      planId: fixture.planId,
      expectedVersion: 1,
      intent: {
        kind: "supporting-event",
        operation: "add",
        name: "Autumn ride",
        date: "1998-09-20",
        role: "Training",
        providerId: "17",
      },
    });
    if (preview.status !== "previewed") throw new Error(`preview ${preview.status}`);
    recordIntervalsCredentialResponse(accepted, 401);

    await expect(
      fixture.operations["plan_change.apply"]({
        commandId: "race-apply",
        planId: fixture.planId,
        expectedVersion: 1,
        changeId: preview.change.changeId,
        decision: "apply",
      }),
    ).resolves.toMatchObject({ status: "applied" });
  });
});
