import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { chmod, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "@enduragent/kernel/archive";
import { readSelectedGenericRows, readSelectedSourceRows } from "@enduragent/kernel/ingest";
import {
  REFERENCE_CAPTURE_STREAM_TYPES,
  validateReferenceCaptureManifest,
  validateReferenceCapturePlan,
  type RecordRef,
} from "@enduragent/kernel/reference/capture";
import {
  projectCyclingReferenceBundle,
  type ReferenceBundle,
} from "@enduragent/kernel/reference/local-bundle";
import { ActivitySchema } from "@enduragent/kernel/reference/schemas";
import {
  H,
  createCanonicalActivityReader,
  createIntervalsSourceRepository,
  dumpStore,
  runMigrations,
  type SourceArtifact,
} from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import {
  createNodeCrypto,
  createNodeImportRuntime,
  importFilesWithReport,
} from "@enduragent/kernel-node/ingest";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import {
  mapActivityLanding,
  normalizeStreamLanding,
  type IntervalsIcuArtifact,
  type IntervalsIcuSource,
} from "@enduragent/sync-intervals-icu";
import { runActivityAuditPages, runBackfillPages } from "../src/backfill.js";
import { createLocalBundleProducer } from "../src/local-bundle-producer.js";

const complete = (lane: "activities" | "bulk-fit") => ({
  kind: "checkpoint" as const,
  watermark: {
    source: "intervals-icu" as const,
    lane,
    value: JSON.stringify({
      v: 1,
      cycle: 0,
      window_start: "2010-01-01",
      window_end: "2010-12-31",
      last_key: null,
      complete: true,
    }),
  },
});
const clock = { now: () => 1_300_000_000_000, monotonicNow: () => 1_000 };

describe("dual-presentation audit", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function fresh(name: string) {
    const root = mkdtempSync(join(tmpdir(), `${name}-`));
    roots.push(root);
    const store = openSqliteStorage(join(root, "store.db"));
    await runMigrations(store, MIGRATIONS);
    return { store, node: createNodeImportRuntime({ archiveDir: join(root, "archive"), store }) };
  }

  it("projects only normalized cycling tokens at the single seam", () => {
    const tokens = [
      "VirtualSki",
      "Ride",
      "Transition",
      "NordicSki",
      "Walk",
      "VirtualRide",
      "Hike",
      "Run",
      "MountainBikeRide",
      "VirtualRun",
      "TrailRun",
      "Swim",
      "GravelRide",
      "Rowing",
      "WeightTraining",
      "EBikeRide",
      "Yoga",
      "Workout",
      "EMountainBikeRide",
      "TrackRide",
      "Cyclocross",
      "Handcycle",
      "ride",
      "",
      "UnmappedSport",
    ];
    const activities = tokens.map((type, index) =>
      ActivitySchema.parse({
        id: type === "Ride" ? 42 : `activity-${index}`,
        start_date_local: `1998-01-${String(index + 1).padStart(2, "0")}T08:00:00`,
        type,
        moving_time: 60,
        elapsed_time: 61,
      }),
    );
    const wellness = [
      {
        id: "1998-01-02",
        weight: null,
        restingHR: null,
        hrv: null,
        sleepSecs: null,
        sleepQuality: null,
        sportInfo: [
          { type: "Run", eftp: 300 },
          { type: "Ride", eftp: 245 },
        ],
      },
    ];
    const ftpHistory = [{ date: "1998-01-02", ftp: 245, source: "estimate" as const }];
    const athlete = { sportSettings: [{ types: ["Ride"], ftp: 250 }] };
    const ftpHistoryIndoor = { "1998-01-02": 240 },
      ftpHistoryOutdoor = { "1998-01-02": 250 };
    const powerCurves = { list: [] },
      hrCurves = { list: [] };
    const sustainabilityCurves = {
      cycling: { power: { Ride: { list: [] } }, hr: { Ride: { list: [] } } },
    };
    const streams = {
      "activity-7": { watts: [107] },
      "42": { watts: [242] },
      "042": { watts: [42] },
      "activity-5": { watts: [105] },
      "orphan-z": { watts: [999] },
      "activity-8": { watts: [108] },
      "activity-12": { watts: [112] },
      "activity-15": { watts: [115] },
    };
    const bundle: ReferenceBundle = {
      activities,
      wellness,
      ftpHistory,
      streams,
      powerCurves,
      hrCurves,
      sustainabilityCurves,
      athlete,
      currentFtpIndoor: null,
      currentFtpOutdoor: 250,
      ftpHistoryIndoor,
      ftpHistoryOutdoor,
      eftp: null,
    };

    const projected = projectCyclingReferenceBundle(bundle);
    expect(projected.activities.map((activity) => activity.type)).toEqual([
      "Ride",
      "VirtualRide",
      "MountainBikeRide",
      "GravelRide",
      "EBikeRide",
    ]);
    expect(projected.activities.map((activity) => activity.id)).toEqual([
      42,
      "activity-5",
      "activity-8",
      "activity-12",
      "activity-15",
    ]);
    expect(Object.keys(projected.streams!)).toEqual([
      "42",
      "activity-5",
      "activity-8",
      "activity-12",
      "activity-15",
    ]);
    expect(projected.streams!["42"]).toBe(streams["42"]);
    expect(projected.streams).not.toHaveProperty("042");
    expect(projected.wellness).toBe(wellness);
    expect(projected.ftpHistory).toBe(ftpHistory);
    expect(projected.athlete).toBe(athlete);
    expect(projected.ftpHistoryIndoor).toBe(ftpHistoryIndoor);
    expect(projected.ftpHistoryOutdoor).toBe(ftpHistoryOutdoor);
    expect(projected.powerCurves).toBe(powerCurves);
    expect(projected.hrCurves).toBe(hrCurves);
    expect(projected.sustainabilityCurves).toBe(sustainabilityCurves);
    expect(projected).toMatchObject({ currentFtpIndoor: null, currentFtpOutdoor: 250, eftp: null });
    expect(Object.hasOwn(projected, "currentFtpIndoor")).toBe(true);
    expect(Object.hasOwn(projected, "eftp")).toBe(true);

    const omitted = projectCyclingReferenceBundle({ activities, wellness, ftpHistory });
    expect(omitted).not.toHaveProperty("streams");
    const presentEmpty = projectCyclingReferenceBundle({
      activities: activities.filter((activity) => activity.type === "Run"),
      wellness,
      ftpHistory,
      streams: { "activity-7": streams["activity-7"] },
    });
    expect(presentEmpty).toHaveProperty("streams", {});
    for (const candidate of [
      {
        id: "null-type",
        start_date_local: "1998-01-01T08:00:00",
        type: null,
        moving_time: 60,
        elapsed_time: 61,
      },
      {
        id: "absent-type",
        start_date_local: "1998-01-01T08:00:00",
        moving_time: 60,
        elapsed_time: 61,
      },
    ] satisfies unknown[]) {
      const parsed = ActivitySchema.safeParse(candidate);
      expect(parsed.success).toBe(false);
      if (!parsed.success)
        expect(parsed.error.issues.some((issue) => issue.path.join(".") === "type")).toBe(true);
    }
  });

  it("keeps only source-lane cycling evidence after a triathlon FIT import", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "cycling-source-floor-"));
    roots.push(root);
    await chmod(root, 0o700);
    const storePath = join(root, "store.db"),
      archiveDir = join(root, "archive");
    const store = openSqliteStorage(storePath);
    const crypto = createNodeCrypto();
    const node = createNodeImportRuntime({ archiveDir, store });
    const snapshot = (value: { readonly address: string; readonly relPath: string }) => ({
      address: value.address,
      rel_path: value.relPath,
    });
    const plan = validateReferenceCapturePlan({
      capture_epoch_ms: Date.parse("2010-06-04T12:00:00Z"),
      frozenNow: "2010-06-04T12:00:00",
      window: { oldest: "2010-03-12", newest: "2010-06-04" },
      stream_cutoff_epoch_ms: Date.parse("2010-05-14T12:00:00Z"),
    });
    try {
      await runMigrations(store, MIGRATIONS);
      const repository = createIntervalsSourceRepository(store, (fields) =>
        H(crypto, ...(fields as [string | number, ...(string | number)[]])),
      );
      const rawActivities = [
        {
          id: "synthetic-run-a",
          type: "Run",
          start_date: "2010-05-01T08:00:00Z",
          start_date_local: "2010-05-01T08:00:00",
          moving_time: 1_800,
          elapsed_time: 1_860,
          distance: 5_000,
        },
        {
          id: "synthetic-cycle-z",
          type: "Ride",
          start_date: "2010-05-02T08:00:00Z",
          start_date_local: "2010-05-02T08:00:00",
          moving_time: 3_600,
          elapsed_time: 3_660,
          distance: 40_000,
        },
        {
          id: "synthetic-swim-m",
          type: "Swim",
          start_date: "2010-05-03T08:00:00Z",
          start_date_local: "2010-05-03T08:00:00",
          moving_time: 1_200,
          elapsed_time: 1_260,
          distance: 1_000,
        },
      ];
      const activityItems = [] as {
        readonly raw: Readonly<Record<string, unknown>>;
        readonly externalId: string;
        readonly epochSeconds: number;
        readonly archive: Awaited<ReturnType<typeof node.archive.writeSnapshot>>;
        readonly platform: Awaited<ReturnType<typeof mapActivityLanding>>;
      }[];
      for (const raw of rawActivities) {
        const epochSeconds = Date.parse(raw.start_date) / 1_000;
        const archive = await node.archive.writeSnapshot(raw, { epochSeconds });
        activityItems.push({
          raw,
          externalId: raw.id,
          epochSeconds,
          archive,
          platform: await mapActivityLanding({
            normalized: raw,
            archiveInstant: { epochSeconds },
            archive,
          }),
        });
      }
      const source = {
        id: "intervals-icu",
        capabilities: {
          activities: true,
          streams: true,
          rawFiles: true,
          wellness: true,
          plannedWorkoutPush: false,
          backfillDepth: { kind: "full-history" },
        },
        pull(watermark) {
          return (async function* (): AsyncIterable<IntervalsIcuArtifact> {
            if (watermark.lane !== "activities") throw new TypeError("unexpected source lane");
            for (const item of activityItems) {
              yield {
                kind: "snapshot",
                source: "intervals-icu",
                lane: "activities",
                externalId: item.externalId,
                archiveInstant: { epochSeconds: item.epochSeconds },
                archive: item.archive,
                payload: item.raw,
                landing: { kind: "activity", platform: item.platform },
              };
            }
            yield complete("activities");
          })();
        },
      } as IntervalsIcuSource;
      expect(
        (
          await runActivityAuditPages({
            store,
            node,
            source,
            clock,
            historyOldestDate: "1998-01-01",
            historyNewestDate: "1998-12-31",
            calendarTimeZone: "UTC",
            cycleId: () => "synthetic-cycle-a",
          })
        ).artifacts,
      ).toBe(3);
      expect(
        await store.get(
          `SELECT authority_kind, authority_id, calendar_timezone, covered_oldest_date_key,
  covered_newest_date_key, gap_state
FROM training_history_coverage_commit`,
        ),
      ).toEqual({
        authority_kind: "activity-backfill",
        authority_id: "synthetic-cycle-a",
        calendar_timezone: "UTC",
        covered_oldest_date_key: 19980101,
        covered_newest_date_key: 19981231,
        gap_state: "none",
      });
      expect(
        await store.get(
          `SELECT authority_id, page_ordinal, dropped_source_restricted, dropped_other, terminal
FROM training_history_backfill_checkpoint`,
        ),
      ).toEqual({
        authority_id: "synthetic-cycle-a",
        page_ordinal: 0,
        dropped_source_restricted: 0,
        dropped_other: 0,
        terminal: 1,
      });

      const streamItems = [] as {
        readonly activityId: string;
        readonly raw: Readonly<Record<string, unknown>>;
        readonly archive: Awaited<ReturnType<typeof node.archive.writeSnapshot>>;
      }[];
      for (let index = 0; index < activityItems.length; index += 1) {
        const activityId = activityItems[index]!.externalId;
        const raw = { time: [0, 60], watts: [100 + index, 110 + index] };
        const archive = await node.archive.writeSnapshot(raw, {
          epochSeconds: activityItems[index]!.epochSeconds,
        });
        const externalId = `streams:${activityId}`;
        const artifact = await repository.recordArtifact({
          source: "intervals-icu",
          lane: "streams",
          externalId,
          artifactKind: "snapshot",
          archiveAddress: archive.address,
          archiveRelPath: archive.relPath,
          archiveEpochSeconds: activityItems[index]!.epochSeconds,
        });
        await repository.recordGenericLanding({
          externalId,
          artifactKey: artifact.artifactKey,
          archiveAddress: archive.address,
          endpoint: "streams",
          normalizedPayloadJson: canonicalJson(normalizeStreamLanding(raw)),
        });
        streamItems.push({ activityId, raw, archive });
      }

      const wellness = {
        id: "2010-06-03",
        weight: null,
        restingHR: null,
        hrv: null,
        sleepSecs: null,
        sleepQuality: null,
        sportInfo: [
          { type: "Run", eftp: 300 },
          { type: "Ride", eftp: 245.4 },
        ],
      };
      const wellnessArchive = await node.archive.writeSnapshot(wellness, {
        epochSeconds: Date.parse("2010-06-03T00:00:00Z") / 1_000,
      });
      const wellnessArtifact = await repository.recordArtifact({
        source: "intervals-icu",
        lane: "wellness",
        externalId: wellness.id,
        artifactKind: "snapshot",
        archiveAddress: wellnessArchive.address,
        archiveRelPath: wellnessArchive.relPath,
        archiveEpochSeconds: Date.parse("2010-06-03T00:00:00Z") / 1_000,
      });
      const profileEndpoint = await node.archive.writeSnapshot(
        { sportSettings: [] },
        { epochSeconds: plan.capture_epoch_ms / 1_000 },
      );
      const activitiesEndpoint = await node.archive.writeSnapshot(rawActivities, {
        epochSeconds: plan.capture_epoch_ms / 1_000,
      });
      const wellnessEndpoint = await node.archive.writeSnapshot([wellness], {
        epochSeconds: plan.capture_epoch_ms / 1_000,
      });

      const activityRecords: RecordRef[] = [];
      for (let index = 0; index < activityItems.length; index += 1) {
        const item = activityItems[index]!;
        const evidence = await repository.readCurrentCaptureEvidence("activities", item.externalId);
        activityRecords.push({
          ordinal: index,
          endpoint_ordinal: 1,
          payload_index: index,
          external_id: item.externalId,
          snapshot: snapshot(item.archive),
          store_evidence: {
            artifact_key: evidence.artifactKey,
            current_revision: {
              source_record_id: evidence.sourceRecordId,
              revision_id: evidence.revisionId,
            },
          },
        });
      }
      const streamRecords: RecordRef[] = [];
      for (let index = 0; index < streamItems.length; index += 1) {
        const item = streamItems[index]!,
          externalId = `streams:${item.activityId}`;
        const evidence = await repository.readCurrentCaptureEvidence("streams", externalId);
        streamRecords.push({
          ordinal: index,
          endpoint_ordinal: index + 3,
          payload_index: null,
          external_id: externalId,
          snapshot: snapshot(item.archive),
          store_evidence: {
            artifact_key: evidence.artifactKey,
            current_revision: {
              source_record_id: evidence.sourceRecordId,
              revision_id: evidence.revisionId,
            },
          },
        });
      }
      const activityIds = rawActivities.map((activity) => activity.id);
      const endpoints = [
        {
          ordinal: 0,
          lane: "settings" as const,
          endpoint: "athlete-profile" as const,
          request: {
            oldest: null,
            newest: null,
            activity_id: null,
            stream_types: [],
            include_defaults: null,
          },
          snapshot: snapshot(profileEndpoint),
        },
        {
          ordinal: 1,
          lane: "activities" as const,
          endpoint: "activities" as const,
          request: {
            oldest: plan.window.oldest,
            newest: plan.window.newest,
            activity_id: null,
            stream_types: [],
            include_defaults: null,
          },
          snapshot: snapshot(activitiesEndpoint),
        },
        {
          ordinal: 2,
          lane: "wellness" as const,
          endpoint: "wellness" as const,
          request: {
            oldest: plan.window.oldest,
            newest: plan.window.newest,
            activity_id: null,
            stream_types: [],
            include_defaults: null,
          },
          snapshot: snapshot(wellnessEndpoint),
        },
        ...streamItems.map((item, index) => ({
          ordinal: index + 3,
          lane: "streams" as const,
          endpoint: "activity-streams" as const,
          request: {
            oldest: null,
            newest: null,
            activity_id: item.activityId,
            stream_types: [...REFERENCE_CAPTURE_STREAM_TYPES],
            include_defaults: false as const,
          },
          snapshot: snapshot(item.archive),
        })),
      ];
      const manifest = validateReferenceCaptureManifest({
        schema_version: 1,
        capture_id: "00000000-0000-4000-8000-000000000010",
        source: "external-oracle",
        plan,
        operation_ledger: {
          link_kind: "capture-id",
          capture_id: "00000000-0000-4000-8000-000000000010",
        },
        endpoints,
        records: {
          settings: [],
          activities: activityRecords,
          wellness: [
            {
              ordinal: 0,
              endpoint_ordinal: 2,
              payload_index: 0,
              external_id: wellness.id,
              snapshot: snapshot(wellnessArchive),
              store_evidence: {
                artifact_key: wellnessArtifact.artifactKey,
                current_revision: null,
              },
            },
          ],
          streams: streamRecords,
        },
        selected_stream_ids: activityIds,
        captured_stream_ids: activityIds,
        deterministic_order: {
          endpoint_ordinals: endpoints.map((endpoint) => endpoint.ordinal),
          settings: [],
          activities: activityIds,
          wellness: [wellness.id],
          streams: activityIds,
        },
      });

      expect(
        await readSelectedSourceRows(store, { source: "intervals-icu", lane: "activities" }),
      ).toHaveLength(3);
      expect(
        await readSelectedGenericRows(store, { source: "intervals-icu", lane: "streams" }),
      ).toHaveLength(3);
      expect(await store.get("SELECT count(*) AS n FROM source_record")).toEqual({ n: 6 });
      expect(await store.get("SELECT count(*) AS n FROM source_record_revision")).toEqual({ n: 6 });
      expect(await store.get("SELECT count(*) AS n FROM source_record_current")).toEqual({ n: 6 });
      const selectors = await store.all(
        "SELECT source_record_id, revision_id FROM source_record_current ORDER BY source_record_id",
      );

      const fixturePath = resolve(
        import.meta.dirname,
        "../../kernel-node/tests/fixtures/ingest/triathlon-multisport.fit",
      );
      const fitImportReport = await importFilesWithReport({
        inputPaths: [fixturePath],
        archiveDir,
        store,
      });
      expect(fitImportReport.inserts).toEqual({ raw_file: 1, source_record: 0 });
      expect(await store.get("SELECT count(*) AS n FROM raw_file")).toEqual({ n: 1 });
      expect(await store.get("SELECT count(*) AS n FROM source_record")).toEqual({ n: 6 });
      expect(await store.get("SELECT count(*) AS n FROM source_record_revision")).toEqual({ n: 6 });
      expect(await store.get("SELECT count(*) AS n FROM source_record_current")).toEqual({ n: 6 });
      expect(
        await store.all(
          "SELECT source_record_id, revision_id FROM source_record_current ORDER BY source_record_id",
        ),
      ).toEqual(selectors);
      expect(
        await store.all(
          "SELECT sport, is_transition FROM session WHERE start_utc < 1000000000 ORDER BY start_utc",
        ),
      ).toEqual([
        { sport: "swimming", is_transition: 0 },
        { sport: "transition", is_transition: 1 },
        { sport: "cycling", is_transition: 0 },
        { sport: "transition", is_transition: 1 },
        { sport: "running", is_transition: 0 },
      ]);
      expect(
        Number(
          (
            await store.get(`SELECT count(*) AS n FROM stream AS st
JOIN session AS s ON s.session_key = st.session_key WHERE s.start_utc < 1000000000`)
          )?.n,
        ),
      ).toBeGreaterThan(0);

      const produced = await createLocalBundleProducer({
        storePath,
        archiveRoot: archiveDir,
        bundleProjection: projectCyclingReferenceBundle,
      }).produce(manifest);
      expect(produced.bundle.activities.map((activity) => activity.id)).toEqual([
        "synthetic-cycle-z",
      ]);
      expect(produced.bundle.streams).toEqual({
        "synthetic-cycle-z": { time: [0, 60], watts: [101, 111] },
      });
      expect(Object.keys(produced.bundle.streams!)).toEqual(["synthetic-cycle-z"]);
      expect(produced.bundle.wellness).toEqual([wellness]);
      expect(produced.bundle.ftpHistory).toEqual([
        { date: "2010-06-03", ftp: 245, source: "estimate" },
      ]);

      const fitOnlyRoot = await mkdtemp(join(await realpath(tmpdir()), "cycling-fit-only-floor-"));
      roots.push(fitOnlyRoot);
      await chmod(fitOnlyRoot, 0o700);
      const fitOnlyStorePath = join(fitOnlyRoot, "store.db"),
        fitOnlyArchive = join(fitOnlyRoot, "archive");
      const fitOnlyStore = openSqliteStorage(fitOnlyStorePath);
      try {
        await runMigrations(fitOnlyStore, MIGRATIONS);
        await importFilesWithReport({
          inputPaths: [fixturePath],
          archiveDir: fitOnlyArchive,
          store: fitOnlyStore,
        });
        const fitOnlyNode = createNodeImportRuntime({
          archiveDir: fitOnlyArchive,
          store: fitOnlyStore,
        });
        const emptyProfile = await fitOnlyNode.archive.writeSnapshot(
          { sportSettings: [] },
          { epochSeconds: plan.capture_epoch_ms / 1_000 },
        );
        const emptyActivities = await fitOnlyNode.archive.writeSnapshot([], {
          epochSeconds: plan.capture_epoch_ms / 1_000,
        });
        const emptyWellness = await fitOnlyNode.archive.writeSnapshot([], {
          epochSeconds: plan.capture_epoch_ms / 1_000,
        });
        const emptyEndpoints = [
          {
            ordinal: 0,
            lane: "settings" as const,
            endpoint: "athlete-profile" as const,
            request: {
              oldest: null,
              newest: null,
              activity_id: null,
              stream_types: [],
              include_defaults: null,
            },
            snapshot: snapshot(emptyProfile),
          },
          {
            ordinal: 1,
            lane: "activities" as const,
            endpoint: "activities" as const,
            request: {
              oldest: plan.window.oldest,
              newest: plan.window.newest,
              activity_id: null,
              stream_types: [],
              include_defaults: null,
            },
            snapshot: snapshot(emptyActivities),
          },
          {
            ordinal: 2,
            lane: "wellness" as const,
            endpoint: "wellness" as const,
            request: {
              oldest: plan.window.oldest,
              newest: plan.window.newest,
              activity_id: null,
              stream_types: [],
              include_defaults: null,
            },
            snapshot: snapshot(emptyWellness),
          },
        ];
        const emptyManifest = validateReferenceCaptureManifest({
          schema_version: 1,
          capture_id: "00000000-0000-4000-8000-000000000011",
          source: "external-oracle",
          plan,
          operation_ledger: {
            link_kind: "capture-id",
            capture_id: "00000000-0000-4000-8000-000000000011",
          },
          endpoints: emptyEndpoints,
          records: { settings: [], activities: [], wellness: [], streams: [] },
          selected_stream_ids: [],
          captured_stream_ids: [],
          deterministic_order: {
            endpoint_ordinals: [0, 1, 2],
            settings: [],
            activities: [],
            wellness: [],
            streams: [],
          },
        });
        const fitOnly = await createLocalBundleProducer({
          storePath: fitOnlyStorePath,
          archiveRoot: fitOnlyArchive,
          bundleProjection: projectCyclingReferenceBundle,
        }).produce(emptyManifest);
        expect(fitOnly.bundle.activities).toEqual([]);
        expect(fitOnly.bundle.streams).toEqual({});
      } finally {
        await fitOnlyStore.close();
      }
    } finally {
      await store.close();
    }
  });

  it("persists API activity, merges original FIT, and surfaces stable rerun near misses", async () => {
    const probe = await fresh("dual-probe"),
      target = await fresh("dual-target");
    const bytes = new Uint8Array(
      readFileSync(
        resolve(import.meta.dirname, "../../kernel-node/tests/fixtures/ingest/brick-cycling.fit"),
      ),
    );
    try {
      await probe.node.importBatchWithReport({
        files: [{ input_path: "probe.fit", bytes, ext: "fit" }],
        platform_records: [],
      });
      const session = await probe.store.get(
        "SELECT sport,start_utc,elapsed_s,distance_m FROM session",
      );
      const raw = await probe.store.get("SELECT file_id_serial FROM raw_file");
      expect(raw?.file_id_serial).not.toBeNull();
      expect(session).toBeDefined();
      const start = Number(session!.start_utc),
        elapsed = Number(session!.elapsed_s);
      const activity = {
        id: "synthetic-activity",
        start_date: new Date(start * 1_000).toISOString(),
        start_date_local: "2010-01-01T00:00:00",
        type: session!.sport === "running" ? "Run" : "Ride",
        moving_time: elapsed,
        elapsed_time: elapsed,
        distance: session!.distance_m,
      };
      const archiveInstant = { epochSeconds: start };
      const snapshot = await target.node.archive.writeSnapshot(activity, archiveInstant);
      const platform = await mapActivityLanding({
        normalized: activity,
        archiveInstant,
        archive: snapshot,
      });
      const fitArchive = await target.node.archive.writeArtifact(bytes, "fit", archiveInstant);
      const activityArtifact = {
        kind: "snapshot",
        source: "intervals-icu",
        lane: "activities",
        externalId: "synthetic-activity",
        archiveInstant,
        archive: snapshot,
        payload: activity,
        landing: { kind: "activity", platform },
      } as const;
      const fitArtifact = {
        kind: "raw-file",
        source: "intervals-icu",
        lane: "bulk-fit",
        externalId: "synthetic-fit",
        archiveInstant,
        archive: fitArchive,
        container: null,
        file: { input_path: "synthetic.fit", bytes, ext: "fit" },
      } as const;
      let bulkPulls = 0;
      const source = {
        id: "intervals-icu",
        capabilities: {
          activities: true,
          streams: true,
          rawFiles: true,
          wellness: true,
          plannedWorkoutPush: false,
          backfillDepth: { kind: "full-history" },
        },
        pull(watermark) {
          return (async function* (): AsyncIterable<SourceArtifact> {
            if (watermark.lane === "activities") {
              yield activityArtifact;
              yield complete("activities");
              return;
            }
            if (bulkPulls++ === 0) yield fitArtifact;
            yield complete("bulk-fit");
          })();
        },
      } as IntervalsIcuSource;

      const activities = await runActivityAuditPages({
        store: target.store,
        node: target.node,
        source,
        clock,
        historyOldestDate: "1998-01-01",
        historyNewestDate: "1998-12-31",
        calendarTimeZone: "UTC",
        cycleId: () => "synthetic-cycle-b",
      });
      const fit = await runBackfillPages({ store: target.store, node: target.node, source, clock });
      expect(activities.artifacts).toBe(1);
      expect(fit.artifacts).toBe(1);
      expect(
        await target.store.get("SELECT count(*) AS n FROM source_artifact WHERE lane='activities'"),
      ).toEqual({ n: 1 });
      expect(await target.store.get("SELECT count(*) AS n FROM workout")).toEqual({ n: 1 });
      expect(await target.store.get("SELECT count(*) AS n FROM session")).toEqual({ n: 1 });
      const selected = await target.store.get(
        "SELECT local_date_key FROM session ORDER BY session_key LIMIT 1",
      );
      const compactDate = String(selected!.local_date_key).padStart(8, "0");
      const localDate = `${compactDate.slice(0, 4)}-${compactDate.slice(4, 6)}-${compactDate.slice(6)}`;
      const canonical = await createCanonicalActivityReader(target.store).listActivities({
        start: localDate,
        end: localDate,
        limit: 200,
      });
      expect(canonical.activities).toHaveLength(1);
      expect(canonical.nextCursor).toBeNull();
      const before = await dumpStore(target.store);
      const rerun = await target.node.importBatchWithReport({
        files: [{ input_path: "archive:synthetic.fit", bytes, ext: "fit" }],
        platform_records: [],
      });
      const after = await dumpStore(target.store);
      expect(rerun.inserts).toEqual({ raw_file: 0, source_record: 0 });
      expect(after).toBe(before);
      expect(Array.isArray(rerun.threshold_near_misses)).toBe(true);
    } finally {
      await probe.store.close();
      await target.store.close();
    }
  });
});
