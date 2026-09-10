import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, type ArchiveWriteResult } from "@enduragent/kernel/archive";
import { buildPlatformPresentation } from "@enduragent/kernel/ingest";
import {
  REFERENCE_CAPTURE_STREAM_TYPES,
  selectReferenceCaptureStreamIds,
  serializeReferenceCaptureManifest,
  validateReferenceCaptureManifest,
  validateReferenceCapturePlan,
  type RecordRef,
  type ReferenceCaptureManifest,
  type SnapshotRef,
} from "@enduragent/kernel/reference/capture";
import { METRIC_REGISTRY } from "@enduragent/kernel/reference/registry";
import { compareReferenceCapture } from "@enduragent/kernel/reference/capture-once";
import {
  assertNoTpKeysRemain,
  buildFixtureShape,
  normalizeStreams,
  parseRenamedActivity,
  parseRenamedWellnessRow,
  projectCyclingReferenceBundle,
  renameTpFieldsOnActivity,
  renameTpFieldsOnWellnessRow,
  type ReferenceBundle,
} from "@enduragent/kernel/reference/local-bundle";
import { H, createIntervalsSourceRepository, runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { createArchiveManager } from "@enduragent/kernel-node/archive";
import { nodeFileSystem } from "@enduragent/kernel-node/filesystem";
import { createNodeCrypto } from "@enduragent/kernel-node/ingest";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import {
  mapActivityLanding,
  mapSettingsLanding,
  mapWellnessLanding,
  normalizeStreamLanding,
} from "@enduragent/sync-intervals-icu";
import { createLocalBundleProducer } from "../src/local-bundle-producer.js";
import {
  persistReferenceCaptureConclusion,
  runReferenceCaptureCommand,
  validateReferenceCaptureConclusion,
  type ReferenceCaptureConclusionV1,
} from "../src/reference-capture-command.js";
import { afterEach, describe, expect, it } from "vitest";

interface SyntheticSeed {
  readonly schema_version: 1;
  readonly capture_id: "00000000-0000-4000-8000-000000000001";
  readonly frozen_now: "1998-06-04T12:00:00";
  readonly athlete: Readonly<Record<string, unknown>>;
  readonly activities: readonly Readonly<Record<string, unknown>>[];
  readonly wellness: readonly Readonly<Record<string, unknown>>[];
  readonly settings_revisions: readonly Readonly<Record<string, unknown>>[];
  readonly streams: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

interface SyntheticCapture {
  readonly root: string;
  readonly inputPath: string;
  readonly manifestPath: string;
  readonly archiveRoot: string;
  readonly conclusionPath: string;
  readonly manifest: ReferenceCaptureManifest;
  readonly memberPaths: readonly string[];
}

const fixturePath = new URL("./fixtures/reference-capture/complete-cycling.json", import.meta.url);
const createdRoots: string[] = [];

function row(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("synthetic row is invalid");
  return value as Readonly<Record<string, unknown>>;
}

async function seed(overrides: Partial<SyntheticSeed> = {}): Promise<SyntheticSeed> {
  const parsed = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
  if (
    Object.keys(parsed).sort().join(",") !==
      "activities,athlete,capture_id,frozen_now,schema_version,settings_revisions,streams,wellness" ||
    parsed.schema_version !== 1 ||
    parsed.capture_id !== "00000000-0000-4000-8000-000000000001" ||
    parsed.frozen_now !== "1998-06-04T12:00:00" ||
    parsed.athlete === null ||
    typeof parsed.athlete !== "object" ||
    !Array.isArray(parsed.activities) ||
    !Array.isArray(parsed.wellness) ||
    !Array.isArray(parsed.settings_revisions) ||
    parsed.streams === null ||
    typeof parsed.streams !== "object" ||
    Array.isArray(parsed.streams)
  ) {
    throw new TypeError("synthetic seed is invalid");
  }
  const base = parsed as unknown as SyntheticSeed;
  return structuredClone({ ...base, ...overrides });
}

function epoch(value: unknown): number {
  const milliseconds = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds % 1_000 !== 0) return 0;
  return milliseconds / 1_000;
}

function snapshot(result: ArchiveWriteResult): SnapshotRef {
  return { address: result.address, rel_path: result.relPath };
}

function artifact(
  record: { externalId: string; archive: ArchiveWriteResult },
  lane: "activities" | "settings" | "wellness" | "streams",
  archiveEpochSeconds: number,
) {
  return {
    source: "intervals-icu" as const,
    lane,
    externalId: record.externalId,
    artifactKind: "snapshot" as const,
    archiveAddress: record.archive.address,
    archiveRelPath: record.archive.relPath,
    archiveEpochSeconds,
  };
}

async function createSyntheticCapture(value: SyntheticSeed): Promise<SyntheticCapture> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "reference-capture-gate-test-"));
  createdRoots.push(root);
  await chmod(root, 0o700);
  const archiveRoot = join(root, "archive"),
    sourceStorePath = join(root, "source.db");
  await mkdir(archiveRoot, { mode: 0o700 });
  const crypto = createNodeCrypto();
  const archive = createArchiveManager({ archiveRoot, crypto, fs: nodeFileSystem() });
  const captureEpoch = Date.parse(`${value.frozen_now}Z`);
  const plan = validateReferenceCapturePlan({
    capture_epoch_ms: captureEpoch,
    frozenNow: value.frozen_now,
    window: { oldest: "1998-03-12", newest: "1998-06-04" },
    stream_cutoff_epoch_ms: captureEpoch - 21 * 86_400_000,
  });
  const activityIds = value.activities.map((activity) => String(activity.id));
  const streamActivityIds = selectReferenceCaptureStreamIds(value.activities, plan);
  const profile = { ...value.athlete, sportSettings: value.settings_revisions };
  const endpointPayloads: unknown[] = [
    profile,
    value.activities,
    value.wellness,
    ...streamActivityIds.map((id) => value.streams[id]),
  ];
  const endpointEpochs = [
    Date.parse("1998-06-04T00:00:00Z") / 1_000,
    Date.parse("1998-03-12T00:00:00Z") / 1_000,
    Date.parse("1998-03-12T00:00:00Z") / 1_000,
    ...streamActivityIds.map((id) =>
      epoch(value.activities.find((activity) => String(activity.id) === id)!.start_date),
    ),
  ];
  const endpointWrites: ArchiveWriteResult[] = [];
  for (let index = 0; index < endpointPayloads.length; index += 1) {
    endpointWrites.push(
      await archive.writeSnapshot(endpointPayloads[index], {
        epochSeconds: endpointEpochs[index]!,
      }),
    );
  }

  const settings = [] as {
    raw: Readonly<Record<string, unknown>>;
    externalId: string;
    archive: ArchiveWriteResult;
    epoch: number;
  }[];
  for (const raw of value.settings_revisions) {
    const mapped = await mapSettingsLanding(raw),
      written = await archive.writeSnapshot(raw, { epochSeconds: mapped.archiveEpochSeconds });
    settings.push({
      raw,
      externalId: mapped.sourceRecordExternalId,
      archive: written,
      epoch: mapped.archiveEpochSeconds,
    });
  }
  const activities = [] as {
    raw: Readonly<Record<string, unknown>>;
    externalId: string;
    archive: ArchiveWriteResult;
    epoch: number;
  }[];
  for (const raw of value.activities) {
    const written = await archive.writeSnapshot(raw, { epochSeconds: epoch(raw.start_date) });
    activities.push({
      raw,
      externalId: String(raw.id),
      archive: written,
      epoch: epoch(raw.start_date),
    });
  }
  const wellness = [] as {
    raw: Readonly<Record<string, unknown>>;
    externalId: string;
    archive: ArchiveWriteResult;
    epoch: number;
  }[];
  for (const raw of value.wellness) {
    const rowEpoch = epoch(`${String(raw.id)}T00:00:00Z`),
      written = await archive.writeSnapshot(raw, { epochSeconds: rowEpoch });
    wellness.push({ raw, externalId: String(raw.id), archive: written, epoch: rowEpoch });
  }
  const streams = [] as {
    raw: Readonly<Record<string, unknown>>;
    externalId: string;
    archive: ArchiveWriteResult;
    epoch: number;
  }[];
  for (const id of streamActivityIds) {
    const raw = value.streams[id]!,
      rowEpoch = epoch(value.activities.find((activity) => String(activity.id) === id)!.start_date);
    const written = await archive.writeSnapshot(raw, { epochSeconds: rowEpoch });
    streams.push({ raw, externalId: `streams:${id}`, archive: written, epoch: rowEpoch });
  }

  const store = openSqliteStorage(sourceStorePath);
  const records = {
    settings: [] as RecordRef[],
    activities: [] as RecordRef[],
    wellness: [] as RecordRef[],
    streams: [] as RecordRef[],
  };
  try {
    await runMigrations(store, MIGRATIONS);
    const repository = createIntervalsSourceRepository(store, (fields) =>
      H(crypto, ...(fields as [string | number, ...(string | number)[]])),
    );
    await store.transaction(async () => {
      for (let index = 0; index < activities.length; index += 1) {
        const item = activities[index]!,
          normalized = parseRenamedActivity(renameTpFieldsOnActivity(structuredClone(item.raw)));
        assertNoTpKeysRemain(normalized);
        const platform = await mapActivityLanding({
          normalized,
          archiveInstant: { epochSeconds: item.epoch },
          archive: item.archive,
        });
        const artifactEvidence = await repository.recordArtifact(
          artifact(item, "activities", item.epoch),
        );
        const presentation = await buildPlatformPresentation(platform, (fields) =>
          H(crypto, ...(fields as [string | number, ...(string | number)[]])),
        );
        await repository.applyActivityRevision({
          sourceRow: presentation.row,
          artifactKey: artifactEvidence.artifactKey,
        });
      }
      for (let index = 0; index < settings.length; index += 1) {
        const item = settings[index]!,
          mapped = await mapSettingsLanding(item.raw);
        const artifactEvidence = await repository.recordArtifact(
          artifact(item, "settings", item.epoch),
        );
        await repository.recordGenericLanding({
          externalId: mapped.sourceRecordExternalId,
          artifactKey: artifactEvidence.artifactKey,
          archiveAddress: item.archive.address,
          endpoint: "settings",
          normalizedPayloadJson: mapped.normalizedPayloadJson,
        });
      }
      for (const item of wellness) {
        const normalized = parseRenamedWellnessRow(
          renameTpFieldsOnWellnessRow(structuredClone(item.raw)),
        );
        assertNoTpKeysRemain(normalized);
        const artifactEvidence = await repository.recordArtifact(
          artifact(item, "wellness", item.epoch),
        );
        await repository.upsertWellness(await mapWellnessLanding(normalized));
        records.wellness.push({
          ordinal: records.wellness.length,
          endpoint_ordinal: 2,
          payload_index: records.wellness.length,
          external_id: item.externalId,
          snapshot: snapshot(item.archive),
          store_evidence: { artifact_key: artifactEvidence.artifactKey, current_revision: null },
        });
      }
      for (const item of streams) {
        const landing = normalizeStreamLanding(row(normalizeStreams(item.raw)));
        const artifactEvidence = await repository.recordArtifact(
          artifact(item, "streams", item.epoch),
        );
        await repository.recordGenericLanding({
          externalId: item.externalId,
          artifactKey: artifactEvidence.artifactKey,
          archiveAddress: item.archive.address,
          endpoint: "streams",
          normalizedPayloadJson: canonicalJson(landing),
        });
      }
    });
    for (let index = 0; index < settings.length; index += 1) {
      const item = settings[index]!,
        evidence = await repository.readCurrentCaptureEvidence("settings", item.externalId);
      records.settings.push({
        ordinal: index,
        endpoint_ordinal: 0,
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
    for (let index = 0; index < activities.length; index += 1) {
      const item = activities[index]!,
        evidence = await repository.readCurrentCaptureEvidence("activities", item.externalId);
      records.activities.push({
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
    for (let index = 0; index < streams.length; index += 1) {
      const item = streams[index]!,
        evidence = await repository.readCurrentCaptureEvidence("streams", item.externalId);
      records.streams.push({
        ordinal: index,
        endpoint_ordinal: 3 + index,
        payload_index: null,
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
  } finally {
    await store.close();
  }

  const endpoints = endpointWrites.map((written, ordinal) =>
    ordinal === 0
      ? {
          ordinal,
          lane: "settings" as const,
          endpoint: "athlete-profile" as const,
          request: {
            oldest: null,
            newest: null,
            activity_id: null,
            stream_types: [],
            include_defaults: null,
          },
          snapshot: snapshot(written),
        }
      : ordinal === 1
        ? {
            ordinal,
            lane: "activities" as const,
            endpoint: "activities" as const,
            request: {
              oldest: plan.window.oldest,
              newest: plan.window.newest,
              activity_id: null,
              stream_types: [],
              include_defaults: null,
            },
            snapshot: snapshot(written),
          }
        : ordinal === 2
          ? {
              ordinal,
              lane: "wellness" as const,
              endpoint: "wellness" as const,
              request: {
                oldest: plan.window.oldest,
                newest: plan.window.newest,
                activity_id: null,
                stream_types: [],
                include_defaults: null,
              },
              snapshot: snapshot(written),
            }
          : {
              ordinal,
              lane: "streams" as const,
              endpoint: "activity-streams" as const,
              request: {
                oldest: null,
                newest: null,
                activity_id: streamActivityIds[ordinal - 3]!,
                stream_types: [...REFERENCE_CAPTURE_STREAM_TYPES],
                include_defaults: false as const,
              },
              snapshot: snapshot(written),
            },
  );
  const manifest = validateReferenceCaptureManifest({
    schema_version: 1,
    capture_id: value.capture_id,
    source: "external-oracle",
    plan,
    operation_ledger: { link_kind: "capture-id", capture_id: value.capture_id },
    endpoints,
    records,
    selected_stream_ids: streamActivityIds,
    captured_stream_ids: streamActivityIds,
    deterministic_order: {
      endpoint_ordinals: endpoints.map((endpoint) => endpoint.ordinal),
      settings: records.settings.map((record) => record.external_id),
      activities: activityIds,
      wellness: records.wellness.map((record) => record.external_id),
      streams: streamActivityIds,
    },
  });
  const manifestPath = join(root, "manifest.json"),
    inputPath = join(root, "input.json"),
    conclusionPath = join(root, "conclusion.json");
  await writeFile(manifestPath, serializeReferenceCaptureManifest(manifest), { mode: 0o600 });
  await writeFile(
    inputPath,
    `${canonicalJson({ schema_version: 1, manifest_path: manifestPath, archive_root: archiveRoot })}\n`,
    { mode: 0o600 },
  );
  await chmod(archiveRoot, 0o700);
  const memberPaths = [
    ...new Set([
      ...manifest.endpoints.map((endpoint) => endpoint.snapshot.rel_path),
      ...Object.values(manifest.records)
        .flat()
        .map((record) => record.snapshot.rel_path),
    ]),
  ].map((path) => join(archiveRoot, path));
  return { root, inputPath, manifestPath, archiveRoot, conclusionPath, manifest, memberPaths };
}

function args(capture: SyntheticCapture, conclusion = capture.conclusionPath): string[] {
  return ["--capture-input", capture.inputPath, "--conclusion", conclusion];
}

afterEach(async () => {
  while (createdRoots.length > 0) await rm(createdRoots.pop()!, { recursive: true, force: true });
});

describe.sequential("capture-once Reference layer gate", () => {
  it("preserves manifest order and rejects asymmetric evidence drift", async () => {
    const base = await seed();
    const ride = { ...base.activities[0], id: "b", type: "Ride", icu_training_load: 72 };
    const run = { ...base.activities[1], id: "a", type: "Run", icu_training_load: 72 };
    const capture = await createSyntheticCapture(
      await seed({
        activities: [ride, run],
        streams: { b: base.streams["ride-zeta"]!, a: base.streams["ride-alpha"]! },
      }),
    );
    const result = await runReferenceCaptureCommand(args(capture));
    expect(result.exitCode, result.line).toBe(0);
    expect(result.conclusion!.direct_family_counts).toMatchObject({ activities: 1, streams: 1 });
    expect(result.conclusion!.projected_family_counts).toMatchObject({ activities: 1, streams: 1 });

    const commandSource = await readFile(
      new URL("../src/reference-capture-command.ts", import.meta.url),
      "utf8",
    );
    expect(commandSource).toMatch(/const bundleProjection = projectCyclingReferenceBundle/);
    expect(commandSource).toMatch(/bundleProjection\(await payloadSet\.directBundle\(reader\)\)/);
    expect(commandSource).toMatch(
      /createLocalBundleProducer\(\{ \.\.\.destination, bundleProjection \}\)/,
    );
    expect(projectCyclingReferenceBundle.name).toBe("projectCyclingReferenceBundle");

    const activity = (id: string, type: string) => ({
      id,
      type,
      start_date_local: "1998-06-03T08:00:00",
      moving_time: 3_600,
      elapsed_time: 3_660,
      icu_training_load: 72,
    });
    const fixture = (
      activities: readonly ReturnType<typeof activity>[],
      eftp: number | null | undefined = undefined,
    ) =>
      buildFixtureShape({
        activities,
        wellness: [],
        ftpHistory: [],
        ...(eftp === undefined ? {} : { eftp }),
      });
    const frozenNow = "1998-06-04T12:00:00";
    const rideFixture = fixture([activity("b", "Ride")]),
      runFixture = fixture([activity("b", "Run")]);
    for (const [direct, projected] of [
      [rideFixture, runFixture],
      [runFixture, rideFixture],
    ] as const) {
      const comparison = compareReferenceCapture({ direct, projected, frozenNow });
      expect(comparison.fixtureBytesEqual).toBe(false);
      expect(comparison.fixtureMismatchFamilies).toEqual(["activities"]);
    }
    const nullEftp = fixture([activity("b", "Ride")], null),
      omittedEftp = fixture([activity("b", "Ride")]);
    for (const [direct, projected] of [
      [nullEftp, omittedEftp],
      [omittedEftp, nullEftp],
    ] as const) {
      const comparison = compareReferenceCapture({ direct, projected, frozenNow });
      expect(comparison.fixtureBytesEqual).toBe(false);
      expect(comparison.fixtureMismatchFamilies).toEqual(["eftp"]);
    }
    const reverseOrder = fixture([activity("b", "Ride"), activity("a", "VirtualRide")]);
    const forwardOrder = fixture([activity("a", "VirtualRide"), activity("b", "Ride")]);
    expect(
      compareReferenceCapture({ direct: reverseOrder, projected: forwardOrder, frozenNow }),
    ).toMatchObject({ fixtureBytesEqual: false, fixtureMismatchFamilies: ["activities"] });
    expect(
      compareReferenceCapture({ direct: reverseOrder, projected: reverseOrder, frozenNow }),
    ).toMatchObject({ fixtureBytesEqual: true, fixtureMismatchFamilies: [] });
  });

  it("passes a complete synthetic capture without network or input writes", async () => {
    const capture = await createSyntheticCapture(await seed());
    const fs = nodeFileSystem();
    let inputWrites = 0;
    const inputFileSystem = {
      ...fs,
      async writeFile(): Promise<void> {
        inputWrites += 1;
        throw new TypeError("input write forbidden");
      },
      async rename(): Promise<void> {
        inputWrites += 1;
        throw new TypeError("input write forbidden");
      },
      async mkdir(): Promise<void> {
        inputWrites += 1;
        throw new TypeError("input write forbidden");
      },
    };
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new TypeError("network forbidden");
    };
    let produced: ReferenceBundle | undefined;
    try {
      const result = await runReferenceCaptureCommand(args(capture), {
        inputFileSystem,
        async produceLocalBundle(destination, manifest) {
          const result = await createLocalBundleProducer(destination).produce(manifest);
          produced = result.bundle;
          return result;
        },
      });
      expect(result.exitCode, result.line).toBe(0);
      expect(typeof compareReferenceCapture).toBe("function");
      expect(result.stream).toBe("stdout");
      expect(result.line).toMatch(
        /^REFERENCE_CAPTURE PASS fixture_equal=true metric_maps_complete=true metrics_equal=true registry_keys=\d+ metric_exceptions=0 fixture_mismatches=0 metric_mismatches=0$/,
      );
      expect(inputWrites).toBe(0);
      expect(produced!.activities.map((activity) => String(activity.id))).toEqual([
        "ride-zeta",
        "ride-alpha",
      ]);
      expect(Object.keys(produced!.streams!)).toEqual(["ride-zeta", "ride-alpha"]);
      expect(produced!.athlete!.sportSettings).toHaveLength(1);
      expect(produced!.athlete!.sportSettings[0]!.ftp).toBe(245);
      const sealed = await stat(capture.conclusionPath);
      expect(sealed.mode & 0o777).toBe(0o444);
      expect(sealed.nlink).toBe(1);
      expect(result.conclusion!.head_sha).toBe(
        execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      );
      const cliConclusion = join(capture.root, "cli-conclusion.json");
      const cli = spawnSync(
        process.execPath,
        [
          "packages/coach/dist/reference-capture-command.js",
          "--capture-input",
          capture.inputPath,
          "--conclusion",
          cliConclusion,
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      expect(cli.status, cli.stderr).toBe(0);
      expect(cli.stderr).toBe("");
      expect(cli.stdout.trim()).toMatch(
        /^REFERENCE_CAPTURE PASS fixture_equal=true metric_maps_complete=true metrics_equal=true registry_keys=\d+ metric_exceptions=0 fixture_mismatches=0 metric_mismatches=0$/,
      );
      expect(cli.stdout.trim().split("\n")).toHaveLength(1);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("reports a complete-fixture stream mismatch", async () => {
    const capture = await createSyntheticCapture(await seed());
    const result = await runReferenceCaptureCommand(args(capture), {
      async produceLocalBundle(destination, manifest) {
        const produced = await createLocalBundleProducer(destination).produce(manifest),
          bundle = produced.bundle;
        const streams = { ...bundle.streams };
        delete streams[manifest.captured_stream_ids[0]!];
        return { ...produced, bundle: { ...bundle, streams } };
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.line).toContain("fixture_mismatches=streams");
    expect(result.conclusion).toMatchObject({ verdict: "MISMATCH", fixture_bytes_equal: false });
  });

  it("redacts an adversarial registry exception to its key", async () => {
    const capture = await createSyntheticCapture(await seed());
    const key = Object.keys(METRIC_REGISTRY)[0]!,
      original = METRIC_REGISTRY[key]!;
    METRIC_REGISTRY[key] = {
      compute() {
        throw new Error("ride-zeta private payload");
      },
    };
    try {
      const result = await runReferenceCaptureCommand(args(capture));
      expect(result.exitCode).toBe(1);
      expect(result.line).not.toContain("private payload");
      expect(result.conclusion!.direct_metric_exception_keys).toEqual([key]);
      expect(result.conclusion!.projected_metric_exception_keys).toEqual([key]);
    } finally {
      METRIC_REGISTRY[key] = original;
    }
  });

  it("rejects swapped and corrupt compressed members before decode", async () => {
    for (const kind of ["swap", "corrupt"] as const) {
      const capture = await createSyntheticCapture(await seed());
      if (kind === "swap") {
        const first = await readFile(capture.memberPaths[0]!),
          second = await readFile(capture.memberPaths[1]!);
        await writeFile(capture.memberPaths[0]!, second);
        await writeFile(capture.memberPaths[1]!, first);
      } else await writeFile(capture.memberPaths[0]!, new Uint8Array([1, 2, 3]));
      const result = await runReferenceCaptureCommand(args(capture));
      expect(result).toMatchObject({
        exitCode: 2,
        line: "REFERENCE_CAPTURE ENVIRONMENT code=ARCHIVE_MEMBER",
      });
      await rm(capture.root, { recursive: true, force: true });
      createdRoots.splice(createdRoots.indexOf(capture.root), 1);
    }
  });

  it("rejects an invalid manifest without creating scratch", async () => {
    const capture = await createSyntheticCapture(await seed());
    const invalid = { ...capture.manifest, endpoints: capture.manifest.endpoints.slice(1) };
    await writeFile(capture.manifestPath, `${canonicalJson(invalid)}\n`, { mode: 0o600 });
    const result = await runReferenceCaptureCommand(args(capture));
    expect(result.line).toBe("REFERENCE_CAPTURE ENVIRONMENT code=MANIFEST_SCHEMA");
  });

  it("aggregates a selection-only mismatch without changing comparator booleans", async () => {
    const capture = await createSyntheticCapture(await seed());
    const result = await runReferenceCaptureCommand(args(capture), {
      async verifySelection() {
        return true;
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.conclusion).toMatchObject({
      verdict: "MISMATCH",
      fixture_bytes_equal: true,
      metric_maps_complete: true,
      metric_bytes_equal: true,
      fixture_mismatch_families: ["selection"],
      fixture_mismatch_count: 1,
    });
  });

  it("applies greatest-update and equal-instant canonical-byte setting selection", async () => {
    const base = await seed();
    const cases = [
      [
        {
          ...base.settings_revisions[0],
          updated: "1998-06-01T12:00:00+02:00",
          ftp: null,
          indoor_ftp: null,
          lthr: null,
          marker: "offset-plus",
        },
        {
          ...base.settings_revisions[1],
          updated: "1998-06-01T10:00:00Z",
          ftp: null,
          indoor_ftp: null,
          lthr: null,
          marker: "offset-z",
        },
      ],
      [
        {
          ...base.settings_revisions[0],
          updated: "1998-06-01T12:00:00+02:00",
          ftp: null,
          indoor_ftp: null,
          lthr: null,
          marker: "tie-a",
        },
        {
          ...base.settings_revisions[1],
          updated: "1998-06-01T10:00:00Z",
          ftp: null,
          indoor_ftp: null,
          lthr: null,
          marker: "tie-z",
        },
      ],
    ];
    for (const settings of cases) {
      const expected = [...settings]
        .sort((left, right) =>
          Buffer.compare(Buffer.from(canonicalJson(left)), Buffer.from(canonicalJson(right))),
        )
        .at(-1)!.marker;
      const capture = await createSyntheticCapture(await seed({ settings_revisions: settings }));
      let bundle: ReferenceBundle | undefined;
      const result = await runReferenceCaptureCommand(args(capture), {
        async produceLocalBundle(destination, manifest) {
          const produced = await createLocalBundleProducer(destination).produce(manifest);
          bundle = produced.bundle;
          return produced;
        },
      });
      expect(result.exitCode, result.line).toBe(0);
      expect((bundle!.athlete!.sportSettings[0] as Record<string, unknown>).marker).toBe(expected);
      await rm(capture.root, { recursive: true, force: true });
      createdRoots.splice(createdRoots.indexOf(capture.root), 1);
    }
  });

  it("passes for a fractional-instant-only setting set", async () => {
    const base = await seed();
    const settings = base.settings_revisions.map((setting, index) => ({
      ...setting,
      updated: `1998-06-01T10:00:0${index}.125Z`,
    }));
    const capture = await createSyntheticCapture(await seed({ settings_revisions: settings }));
    const result = await runReferenceCaptureCommand(args(capture));
    expect(result.exitCode, result.line).toBe(0);
    expect(result.line).toMatch(
      /^REFERENCE_CAPTURE PASS fixture_equal=true metric_maps_complete=true metrics_equal=true registry_keys=\d+ metric_exceptions=0 fixture_mismatches=0 metric_mismatches=0$/,
    );
  });

  it("lets cleanup failure replace successful diagnostics", async () => {
    const capture = await createSyntheticCapture(await seed());
    const result = await runReferenceCaptureCommand(args(capture), {
      async removeScratch() {
        throw new Error("denied");
      },
    });
    expect(result).toMatchObject({
      exitCode: 2,
      line: "REFERENCE_CAPTURE ENVIRONMENT code=CLEANUP_FAILED",
    });
    expect(result.conclusion).toMatchObject({
      verdict: "ENVIRONMENT",
      environment_code: "CLEANUP_FAILED",
      fixture_bytes_equal: null,
      registry_key_count: null,
      direct_family_counts: {},
    });
  });

  it("seals immutable conclusions and preserves post-link candidates", async () => {
    const capture = await createSyntheticCapture(await seed());
    const success = await runReferenceCaptureCommand(args(capture));
    const record = success.conclusion!;
    const before = join(capture.root, "before.json");
    await expect(
      persistReferenceCaptureConclusion(before, record, {
        beforeLink() {
          throw new Error("before");
        },
      }),
    ).rejects.toThrow();
    await expect(stat(before)).rejects.toMatchObject({ code: "ENOENT" });
    const after = join(capture.root, "after.json");
    await expect(
      persistReferenceCaptureConclusion(after, record, {
        afterLink() {
          throw new Error("after");
        },
      }),
    ).rejects.toThrow();
    const candidate = await stat(after);
    expect(candidate.mode & 0o777).toBe(0o444);
    expect(candidate.nlink).toBe(1);
    await expect(
      persistReferenceCaptureConclusion(capture.conclusionPath, record),
    ).rejects.toThrow();
    const noClobber = await runReferenceCaptureCommand(args(capture));
    expect(noClobber.line).toBe("REFERENCE_CAPTURE ENVIRONMENT code=CONCLUSION_PATH");
    const writeFailurePath = join(capture.root, "write-failure.json");
    const writeFailure = await runReferenceCaptureCommand(args(capture, writeFailurePath), {
      async persistConclusion() {
        throw new Error("write denied");
      },
    });
    expect(writeFailure.line).toBe("REFERENCE_CAPTURE ENVIRONMENT code=CONCLUSION_WRITE");
    await expect(stat(writeFailurePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses the same validator before emit and after reload", async () => {
    const capture = await createSyntheticCapture(await seed());
    const result = await runReferenceCaptureCommand(args(capture));
    const record = result.conclusion!;
    expect(() =>
      validateReferenceCaptureConclusion({ ...record, fixture_mismatch_count: 1 }),
    ).toThrow();
    expect(() =>
      validateReferenceCaptureConclusion({ ...record, direct_metric_exception_keys: ["acwr"] }),
    ).toThrow();
    const reloaded = JSON.parse(
      await readFile(capture.conclusionPath, "utf8"),
    ) as ReferenceCaptureConclusionV1;
    expect(validateReferenceCaptureConclusion(reloaded)).toEqual(record);
  });
});
