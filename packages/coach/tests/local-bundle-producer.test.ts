import { describe, expect, it, vi } from "vitest";
import type { CryptoPort, FileSystemPort } from "@enduragent/kernel/ports";
import { validateReferenceCaptureManifest } from "@enduragent/kernel/reference/capture";
import type { ReferenceBundle } from "@enduragent/kernel/reference/local-bundle";
import type { Row, SqlReadStore } from "@enduragent/kernel/store";
import {
  createLocalBundleProducer,
  LocalBundleProducerError,
  type LocalBundleProducerDependencies,
} from "../src/local-bundle-producer.js";

function manifest() {
  const captureEpoch = Date.UTC(1998, 5, 10, 12);
  const snapshot = (value: string) => ({
    address: value.repeat(64),
    rel_path: `1998/06/${value.repeat(64)}.json.gz`,
  });
  return validateReferenceCaptureManifest({
    schema_version: 1,
    capture_id: "123e4567-e89b-42d3-a456-426614174000",
    source: "external-oracle",
    plan: {
      capture_epoch_ms: captureEpoch,
      frozenNow: "1998-06-10T18:00:00",
      calendar_timezone: "Asia/Almaty",
      window: { oldest: "1998-06-01", newest: "1998-06-10" },
      stream_cutoff_epoch_ms: captureEpoch - 21 * 24 * 60 * 60 * 1_000,
    },
    operation_ledger: {
      link_kind: "capture-id",
      capture_id: "123e4567-e89b-42d3-a456-426614174000",
    },
    endpoints: [
      {
        ordinal: 0,
        lane: "settings",
        endpoint: "athlete-profile",
        request: {
          oldest: null,
          newest: null,
          activity_id: null,
          stream_types: [],
          include_defaults: null,
        },
        snapshot: snapshot("1"),
      },
      {
        ordinal: 1,
        lane: "activities",
        endpoint: "activities",
        request: {
          oldest: "1998-06-01",
          newest: "1998-06-10",
          activity_id: null,
          stream_types: [],
          include_defaults: null,
        },
        snapshot: snapshot("2"),
      },
      {
        ordinal: 2,
        lane: "wellness",
        endpoint: "wellness",
        request: {
          oldest: "1998-06-01",
          newest: "1998-06-10",
          activity_id: null,
          stream_types: [],
          include_defaults: null,
        },
        snapshot: snapshot("3"),
      },
    ],
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
}

function readStore(
  close: () => Promise<void> = async () => {},
): SqlReadStore & { calls: readonly (readonly unknown[])[] } {
  const calls: (readonly unknown[])[] = [];
  return {
    calls,
    async get(): Promise<Row | undefined> {
      return undefined;
    },
    async all(_sql, params): Promise<Row[]> {
      calls.push(params ?? []);
      return [];
    },
    close,
  };
}

const emptyBundle: ReferenceBundle = {
  activities: [],
  wellness: [],
  ftpHistory: [],
  streams: {},
  athlete: { sportSettings: [] },
};
const stubFs = {} as FileSystemPort;
const stubCrypto = {} as CryptoPort;

function dependencies(
  store: SqlReadStore,
  overrides: Partial<LocalBundleProducerDependencies> = {},
): LocalBundleProducerDependencies {
  return {
    openStore: () => store,
    fileSystem: () => stubFs,
    crypto: () => stubCrypto,
    createSnapshotReader: () => ({
      async readVerifiedSnapshot() {
        return {};
      },
    }),
    decode: async () => emptyBundle,
    ...overrides,
  };
}

function recursiveStrings(value: unknown, seen = new Set<unknown>()): string {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function") ||
    seen.has(value)
  )
    return String(value);
  seen.add(value);
  let output = "";
  for (const key of Reflect.ownKeys(value)) {
    output += String(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor)
      output += recursiveStrings(descriptor.value, seen);
  }
  return output;
}

describe("local bundle producer composition", () => {
  it("passes an explicit source, narrowed reader, manifest values, filter, and closes once", async () => {
    const close = vi.fn(async () => {});
    const store = readStore(close);
    const filter = vi.fn(() => true);
    let readerKeys: string[] = [];
    let selectedKeys: string[] = [];
    const producer = createLocalBundleProducer(
      { storePath: "synthetic.sqlite", archiveRoot: "synthetic-archive", activityFilter: filter },
      dependencies(store, {
        createSnapshotReader: () => ({
          async readVerifiedSnapshot() {
            return {};
          },
        }),
        decode: async (_manifest, selected, reader, receivedFilter) => {
          readerKeys = Object.keys(reader);
          selectedKeys = Object.keys(selected);
          expect(receivedFilter).toBe(filter);
          return emptyBundle;
        },
      }),
    );
    const value = await producer.produce(manifest());
    expect(value).toEqual({
      captureId: "123e4567-e89b-42d3-a456-426614174000",
      captureClock: {
        captureEpochMs: Date.UTC(1998, 5, 10, 12),
        civilDateTime: "1998-06-10T18:00:00",
        calendarTimeZone: "Asia/Almaty",
      },
      bundle: emptyBundle,
    });
    expect(store.calls).toEqual([
      ["intervals-icu", "activities"],
      ["intervals-icu", "settings"],
      ["intervals-icu", "wellness"],
      ["intervals-icu", "streams"],
    ]);
    expect(readerKeys).toEqual(["readVerifiedSnapshot"]);
    expect(selectedKeys.sort()).toEqual(["activities", "settings", "streams", "wellness"]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("merges current curve evidence before the configured bundle projection", async () => {
    const store = readStore();
    const curveProjection = {
      powerCurves: { list: [] },
      hrCurves: { list: [] },
      sustainabilityCurves: { cycling: { power: {}, hr: {} } },
    };
    const bundleProjection = vi.fn((bundle: ReferenceBundle) => bundle);
    const projectCurves = vi.fn(async () => curveProjection);
    const producer = createLocalBundleProducer(
      { storePath: "synthetic.sqlite", archiveRoot: "synthetic-archive", bundleProjection },
      dependencies(store, { projectCurves }),
    );

    const value = await producer.produce(manifest());

    expect(projectCurves).toHaveBeenCalledWith(
      expect.objectContaining({
        store,
        frozenOn: "1998-06-10",
      }),
    );
    expect(bundleProjection).toHaveBeenCalledWith({ ...emptyBundle, ...curveProjection });
    expect(value.bundle).toEqual({ ...emptyBundle, ...curveProjection });
  });

  it("keeps the base bundle publishable when optional curve projection fails", async () => {
    const close = vi.fn(async () => {});
    const store = readStore(close);
    const producer = createLocalBundleProducer(
      { storePath: "synthetic.sqlite", archiveRoot: "synthetic-archive" },
      dependencies(store, {
        projectCurves: async () => {
          throw new Error("curve-private-sentinel");
        },
      }),
    );

    await expect(producer.produce(manifest())).resolves.toEqual({
      captureId: "123e4567-e89b-42d3-a456-426614174000",
      captureClock: {
        captureEpochMs: Date.UTC(1998, 5, 10, 12),
        civilDateTime: "1998-06-10T18:00:00",
        calendarTimeZone: "Asia/Almaty",
      },
      bundle: emptyBundle,
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("reports projection-only failure without exposing the raw error", async () => {
    const store = readStore();
    const producer = createLocalBundleProducer(
      { storePath: "synthetic.sqlite", archiveRoot: "synthetic-archive" },
      dependencies(store, {
        decode: async () => {
          throw new Error("projection-private-sentinel");
        },
      }),
    );
    const error = await producer.produce(manifest()).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(LocalBundleProducerError);
    expect(error).toMatchObject({
      code: "LOCAL_BUNDLE_PRODUCER_FAILED",
      stages: ["projection"],
      message: "local bundle projection failed",
      stack: "LocalBundleProducerError: local bundle projection failed",
    });
    expect(recursiveStrings(error)).not.toContain("projection-private-sentinel");
    expect(JSON.stringify(error)).not.toContain("projection-private-sentinel");
    expect(error).not.toHaveProperty("cause");
  });

  it("reports close-only failure", async () => {
    const store = readStore(async () => {
      throw new Error("close-private-sentinel");
    });
    const producer = createLocalBundleProducer(
      { storePath: "synthetic.sqlite", archiveRoot: "synthetic-archive" },
      dependencies(store),
    );
    await expect(producer.produce(manifest())).rejects.toMatchObject({
      stages: ["close"],
      message: "local bundle close failed",
    });
  });

  it("aggregates projection and close stages while sanitizing both failures", async () => {
    const store = readStore(async () => {
      throw new Error("close-private-sentinel");
    });
    const producer = createLocalBundleProducer(
      { storePath: "synthetic.sqlite", archiveRoot: "synthetic-archive" },
      dependencies(store, {
        decode: async () => {
          throw new Error("projection-private-sentinel");
        },
      }),
    );
    const error = await producer.produce(manifest()).catch((value: unknown) => value);
    expect(error).toMatchObject({
      stages: ["projection", "close"],
      message: "local bundle projection failed; close also failed",
      stack: "LocalBundleProducerError: local bundle projection failed; close also failed",
    });
    expect(recursiveStrings(error)).not.toMatch(
      /projection-private-sentinel|close-private-sentinel/,
    );
    expect(JSON.stringify(error)).not.toMatch(/projection-private-sentinel|close-private-sentinel/);
    expect(error).not.toHaveProperty("cause");
    expect(error).not.toHaveProperty("errors");
    expect(Object.isFrozen(error)).toBe(true);
  });
});
