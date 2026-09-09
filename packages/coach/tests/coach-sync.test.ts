import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { ImportArtifact, ImportReport } from "@enduragent/kernel/ingest";
import {
  createSyncFailureRepository,
  dumpStore,
  runMigrations,
  type SourceId,
  type SourceWatermark,
  type SyncBudget,
  type SyncSource,
} from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import { importFilesWithReport, type NodeImportRuntime } from "@enduragent/kernel-node/ingest";
import {
  inertWriterProtocolListener,
  LOCKFILE_NAME,
  PORT_FILE_NAME,
} from "@enduragent/kernel-node/lock";
import {
  type CoachDevWriterFailureStage,
  type CoachDevWriterResult,
  type RunCoachDevWriterOptions,
} from "@enduragent/kernel-node/coach-dev";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import {
  CoachStoreWriterError,
  withCoachStoreWriter,
  type CoachStoreWriterContext,
  type CoachStoreWriterPlan,
} from "../src/runtime.js";
import {
  runCoachSync,
  type CoachFileBatchSource,
  type CoachSourceBinding,
  type CoachSyncDependencies,
  type RunCoachSyncOptions,
} from "../src/sync.js";

const capabilities = Object.freeze({
  activities: false,
  streams: false,
  rawFiles: false,
  wellness: false,
  plannedWorkoutPush: false,
  backfillDepth: Object.freeze({ kind: "none" as const }),
});

const hasLoopback = await new Promise<boolean>((resolve) => {
  const server = createServer();
  server.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPERM") {
      process.stderr.write("SKIP_MARKER loopback-listen EPERM coach-sync\n");
    }
    resolve(false);
  });
  server.listen({ host: "127.0.0.1", port: 0 }, () => {
    server.close(() => resolve(true));
  });
});

function syncSource(id: SourceId): SyncSource {
  return {
    id,
    capabilities,
    async *pull() {},
  };
}

function syntheticHome(root = "synthetic-root"): AthleteHome {
  return {
    root,
    storeDir: join(root, "store"),
    archiveDir: join(root, "archive"),
    configDir: join(root, "config"),
  };
}

function writerOperation<T>(
  operationOrPlan: ((context: CoachStoreWriterContext) => Promise<T>) | CoachStoreWriterPlan<T>,
): (context: CoachStoreWriterContext) => Promise<T> {
  return typeof operationOrPlan === "function" ? operationOrPlan : operationOrPlan.operation;
}

function syntheticStore(): CoachStoreWriterContext["store"] {
  return {
    async exec() {},
    async run() {},
    async get() {
      return undefined;
    },
    async all() {
      return [];
    },
    async close() {},
    async getUserVersion() {
      return 0;
    },
    async setUserVersion() {},
    async transaction<T>(operation: () => Promise<T>) {
      return operation();
    },
  };
}

function syntheticContext(root?: string): CoachStoreWriterContext {
  return {
    home: syntheticHome(root),
    store: syntheticStore(),
    listener: inertWriterProtocolListener,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const importReport = { report: "synthetic" } as unknown as ImportReport;

function syncDependencies(
  withWriter: CoachSyncDependencies["withWriter"],
  importFiles: CoachSyncDependencies["importFiles"],
  overrides: Partial<CoachSyncDependencies> = {},
): CoachSyncDependencies {
  return {
    withWriter,
    importFiles,
    fileSystem: { async writeFile() {} },
    async ensurePrivateDirectory() {},
    async removeFileIfPresent() {},
    nowEpochMs: () => 1_000,
    createImportRuntime() {
      throw new Error("unexpected import runtime construction");
    },
    ...overrides,
  };
}

async function governedHarness(overrides: Partial<CoachSyncDependencies> = {}) {
  const store = openSqliteStorage(":memory:");
  await runMigrations(store, MIGRATIONS);
  const home = syntheticHome("synthetic-governed-root");
  const projected = new Map<string, string>();
  const events: string[] = [];
  let ordinal = 1_000;
  const withWriter: CoachSyncDependencies["withWriter"] = async (_env, operation) => {
    events.push("writer");
    return operation({ home, store, listener: inertWriterProtocolListener });
  };
  const dependencies = syncDependencies(withWriter, async () => importReport, {
    fileSystem: {
      async writeFile(path, data) {
        events.push("write");
        projected.set(path, typeof data === "string" ? data : new TextDecoder().decode(data));
      },
    },
    async ensurePrivateDirectory() {
      events.push("secure-directory");
    },
    async removeFileIfPresent(path) {
      events.push("remove");
      projected.delete(path);
    },
    nowEpochMs: () => ordinal++,
    ...overrides,
  });
  return { store, home, projected, events, dependencies };
}

function fileHydrationInput(): {
  readonly watermark: SourceWatermark;
  readonly budget: SyncBudget;
} {
  return {
    watermark: { source: "file-import", lane: "file-discovery", value: null },
    budget: {
      signal: new AbortController().signal,
      clock: { monotonicNow: () => 0 },
      deadlineMonotonicMs: 10_000,
      perRequestTimeoutMs: 1_000,
      maxRequests: 1,
      maxArtifacts: 10,
    },
  };
}

function hydrationSource(
  events: readonly (
    | { readonly kind: "batch"; readonly artifacts: readonly never[] }
    | { readonly kind: "checkpoint"; readonly watermark: SourceWatermark }
  )[],
): CoachFileBatchSource {
  return {
    ...syncSource("file-import"),
    id: "file-import",
    async *pullBatches() {
      yield* events;
    },
  };
}

describe("coach sync composition", () => {
  it("runtime delegates to the exact writer version and returns the operation value", async () => {
    const context = syntheticContext();
    const value = { outcome: "exact-value" } as const;
    const observed: { options?: RunCoachDevWriterOptions<unknown>; calls: number } = {
      calls: 0,
    };
    const runWriter = async <T>(
      options: RunCoachDevWriterOptions<T>,
    ): Promise<CoachDevWriterResult<T>> => {
      observed.calls += 1;
      observed.options = options as RunCoachDevWriterOptions<unknown>;
      return { status: "completed", value: await options.operation(context) };
    };
    const operation = async (received: CoachStoreWriterContext) => {
      expect(received).toBe(context);
      return value;
    };

    await expect(
      withCoachStoreWriter({ ENDURAGENT_HOME: "synthetic-root" }, operation, { runWriter }),
    ).resolves.toBe(value);
    expect(observed.calls).toBe(1);
    expect(observed.options).toMatchObject({
      env: { ENDURAGENT_HOME: "synthetic-root" },
      writerVersion: "coach-sync/1",
      operation,
    });

    await expect(withCoachStoreWriter({}, undefined as never, { runWriter })).rejects.toThrow(
      new TypeError("invalid coach writer operation"),
    );
    expect(observed.calls).toBe(1);
  });

  it("runtime maps contention and every lifecycle failure without private error data", async () => {
    const privateValue = "private dependency data";
    const operation = async () => privateValue;
    const contention = { kind: "holder" as const, pid: 123, port: 4567 };
    const contentionWriter = async <T>(): Promise<CoachDevWriterResult<T>> => ({
      status: "writer-lock-held",
      contention,
    });
    await expect(
      withCoachStoreWriter({}, operation, { runWriter: contentionWriter }),
    ).rejects.toEqual(new CoachStoreWriterError("writer-lock-held", null, undefined, contention));

    const stages: readonly CoachDevWriterFailureStage[] = [
      "resolve home",
      "acquire lock",
      "run pre-open operation",
      "create store directory",
      "secure store directory",
      "open store",
      "run migrations",
      "invoke operation",
      "close store",
      "release lock",
    ];
    for (const stage of stages) {
      const failedWriter = async <T>(): Promise<CoachDevWriterResult<T>> => ({
        status: "failed",
        stage,
      });
      let caught: unknown;
      try {
        await withCoachStoreWriter({}, operation, { runWriter: failedWriter });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(CoachStoreWriterError);
      expect(caught).toMatchObject({
        name: "CoachStoreWriterError",
        code: "writer-failed",
        stage,
        message: `coach store writer failed at ${stage}`,
      });
      expect(JSON.stringify(caught)).not.toContain(privateValue);
    }
  });

  it("preserves the writer failure cause on the thrown error", async () => {
    const operationFailure = new Error("private operation failure detail");
    const failedWriter = async <T>(): Promise<CoachDevWriterResult<T>> => ({
      status: "failed",
      stage: "invoke operation",
      cause: operationFailure,
    });
    let caught: unknown;
    try {
      await withCoachStoreWriter({}, async () => null, { runWriter: failedWriter });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CoachStoreWriterError);
    expect((caught as CoachStoreWriterError).cause).toBe(operationFailure);
    expect(JSON.stringify(caught)).not.toContain("private operation failure detail");
  });

  it("forwards the pre-open plan and preserves the cause constructor position", async () => {
    const context = syntheticContext();
    const trace: string[] = [];
    const runWriter = async <T>(
      options: RunCoachDevWriterOptions<T>,
    ): Promise<CoachDevWriterResult<T>> => {
      await options.beforeStoreOpen?.(context.home);
      return { status: "completed", value: await options.operation(context) };
    };
    await expect(
      withCoachStoreWriter(
        {},
        {
          beforeStoreOpen: async (home) => {
            expect(home).toBe(context.home);
            trace.push("before");
          },
          operation: async (received) => {
            expect(received).toBe(context);
            trace.push("operation");
            return "done";
          },
        },
        { runWriter },
      ),
    ).resolves.toBe("done");
    expect(trace).toEqual(["before", "operation"]);
    const cause = new Error("private");
    expect(new CoachStoreWriterError("writer-failed", "open store", { cause }).cause).toBe(cause);
  });

  it("validates the complete request before acquiring the writer", async () => {
    let writerCalls = 0;
    let sourceCalls = 0;
    let importCalls = 0;
    const context = syntheticContext();
    const withWriter: typeof withCoachStoreWriter = async <T>(
      _env: Record<string, string | undefined>,
      operationOrPlan: ((value: CoachStoreWriterContext) => Promise<T>) | CoachStoreWriterPlan<T>,
    ): Promise<T> => {
      writerCalls += 1;
      return writerOperation(operationOrPlan)(context);
    };
    const importFiles: typeof importFilesWithReport = async () => {
      importCalls += 1;
      return importReport;
    };
    const validBinding: CoachSourceBinding = {
      source: syncSource("intervals-icu"),
      async run() {
        sourceCalls += 1;
      },
    };
    const dependencies = syncDependencies(withWriter, importFiles);
    const invalidCases: readonly { value: unknown; message: string }[] = [
      { value: null, message: "invalid coach sync options" },
      { value: [], message: "invalid coach sync options" },
      { value: {}, message: "invalid coach sync options" },
      { value: { env: null, sources: [] }, message: "invalid coach sync options" },
      { value: { env: [], sources: [] }, message: "invalid coach sync options" },
      { value: { env: {}, sources: {} }, message: "invalid coach sync options" },
      { value: { env: {}, sources: [null] }, message: "invalid coach source binding" },
      {
        value: { env: {}, sources: [{ source: null, run() {} }] },
        message: "invalid coach source binding",
      },
      {
        value: { env: {}, sources: [{ source: { id: "other" }, run() {} }] },
        message: "invalid coach source binding",
      },
      {
        value: { env: {}, sources: [{ source: syncSource("file-import"), run: null }] },
        message: "invalid coach source binding",
      },
      {
        value: {
          env: {},
          sources: [{ source: hydrationSource([]), run() {}, fileHydration: fileHydrationInput() }],
        },
        message: "invalid coach source binding",
      },
      {
        value: {
          env: {},
          sources: [{ source: syncSource("intervals-icu"), fileHydration: fileHydrationInput() }],
        },
        message: "invalid coach source binding",
      },
      {
        value: {
          env: {},
          sources: [
            {
              source: hydrationSource([]),
              fileHydration: {
                ...fileHydrationInput(),
                watermark: { source: "file-import", lane: "activities", value: null },
              },
            },
          ],
        },
        message: "invalid coach source binding",
      },
      {
        value: { env: {}, sources: [validBinding, { source: null, run() {} }] },
        message: "invalid coach source binding",
      },
      {
        value: { env: {}, sources: [validBinding, validBinding] },
        message: "duplicate coach sync source",
      },
      {
        value: { env: {}, sources: [], importPaths: "input.fit" },
        message: "invalid coach import paths",
      },
      { value: { env: {}, sources: [], importPaths: [""] }, message: "invalid coach import paths" },
      { value: { env: {}, sources: [], importPaths: [1] }, message: "invalid coach import paths" },
      {
        value: { env: {}, sources: [], importPaths: ["input.fit", "input.fit"] },
        message: "invalid coach import paths",
      },
    ];

    for (const { value, message } of invalidCases) {
      await expect(runCoachSync(value as RunCoachSyncOptions, dependencies)).rejects.toThrow(
        new TypeError(message),
      );
    }
    expect(writerCalls).toBe(0);
    expect(sourceCalls).toBe(0);
    expect(importCalls).toBe(0);
  });

  it("runs sources sequentially and continues with a safe failure", async () => {
    const context = syntheticContext();
    const order: string[] = [];
    let running = 0;
    let maximumRunning = 0;
    const withWriter: typeof withCoachStoreWriter = async <T>(
      _env: Record<string, string | undefined>,
      operationOrPlan: ((value: CoachStoreWriterContext) => Promise<T>) | CoachStoreWriterPlan<T>,
    ): Promise<T> => writerOperation(operationOrPlan)(context);
    const importFiles: typeof importFilesWithReport = async () => importReport;
    const binding = (id: SourceId, shouldFail: boolean): CoachSourceBinding => ({
      source: syncSource(id),
      async run(received) {
        expect(Object.isFrozen(received)).toBe(true);
        running += 1;
        maximumRunning = Math.max(maximumRunning, running);
        order.push(`start:${id}`);
        await Promise.resolve();
        order.push(`end:${id}`);
        running -= 1;
        if (shouldFail) throw new Error("private source failure");
      },
    });

    const report = await runCoachSync(
      {
        env: {},
        sources: [binding("intervals-icu", true), binding("file-import", false)],
      },
      syncDependencies(withWriter, importFiles),
    );
    expect(order).toEqual([
      "start:intervals-icu",
      "end:intervals-icu",
      "start:file-import",
      "end:file-import",
    ]);
    expect(maximumRunning).toBe(1);
    expect(report).toEqual({
      schema_version: 2,
      sources: [
        {
          source_id: "intervals-icu",
          status: "failed",
          severity: "block",
          message: "source synchronization failed",
        },
        { source_id: "file-import", status: "completed", severity: null, message: null },
      ],
      import_report: null,
    });
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.sources)).toBe(true);
    expect(report.sources.every(Object.isFrozen)).toBe(true);
    expect(JSON.stringify(report)).not.toContain("private source failure");
  });

  it("imports one nonempty path batch exactly once after sources", async () => {
    const context = syntheticContext();
    const order: string[] = [];
    const originalPaths = ["z.fit", "a.fit"];
    let observedImport: Parameters<typeof importFilesWithReport>[0] | undefined;
    let importCalls = 0;
    const withWriter: typeof withCoachStoreWriter = async <T>(
      _env: Record<string, string | undefined>,
      operationOrPlan: ((value: CoachStoreWriterContext) => Promise<T>) | CoachStoreWriterPlan<T>,
    ): Promise<T> => writerOperation(operationOrPlan)(context);
    const importFiles: typeof importFilesWithReport = async (options) => {
      importCalls += 1;
      order.push("import");
      observedImport = options;
      return importReport;
    };
    const report = await runCoachSync(
      {
        env: {},
        sources: [
          {
            source: syncSource("intervals-icu"),
            async run() {
              order.push("source");
            },
          },
        ],
        importPaths: originalPaths,
      },
      syncDependencies(withWriter, importFiles),
    );

    expect(order).toEqual(["source", "import"]);
    expect(importCalls).toBe(1);
    expect(observedImport).toEqual({
      inputPaths: originalPaths,
      archiveDir: context.home.archiveDir,
      store: context.store,
    });
    expect(observedImport?.inputPaths).not.toBe(originalPaths);
    expect(Object.isFrozen(observedImport?.inputPaths)).toBe(true);
    expect(observedImport?.store).toBe(context.store);
    expect(report.import_report).toBe(importReport);
    expect(Object.isFrozen(importReport)).toBe(false);
  });

  it("skips file import for an empty path list", async () => {
    const context = syntheticContext();
    let importCalls = 0;
    const withWriter: typeof withCoachStoreWriter = async <T>(
      _env: Record<string, string | undefined>,
      operationOrPlan: ((value: CoachStoreWriterContext) => Promise<T>) | CoachStoreWriterPlan<T>,
    ): Promise<T> => writerOperation(operationOrPlan)(context);
    const importFiles: typeof importFilesWithReport = async () => {
      importCalls += 1;
      return importReport;
    };
    const dependencies = syncDependencies(withWriter, importFiles);

    await expect(
      runCoachSync({ env: {}, sources: [], importPaths: [] }, dependencies),
    ).resolves.toMatchObject({ import_report: null });
    await expect(runCoachSync({ env: {}, sources: [] }, dependencies)).resolves.toMatchObject({
      import_report: null,
    });
    expect(importCalls).toBe(0);
  });

  it.runIf(hasLoopback)(
    "real writer lifecycle migrates closes and releases an isolated store",
    async () => {
      const root = await mkdtemp(join(await realpath(tmpdir()), "coach-runtime-"));
      const home = syntheticHome(root);
      try {
        const value = await withCoachStoreWriter(
          { ENDURAGENT_HOME: root },
          async ({ home: receivedHome, store }) => {
            expect(receivedHome).toEqual(home);
            return store.get("PRAGMA user_version");
          },
        );
        expect(value).toEqual({ user_version: 32 });
        expect(await pathExists(join(home.storeDir, "store.db"))).toBe(true);
        expect(await pathExists(join(home.configDir, LOCKFILE_NAME))).toBe(false);
        expect(await pathExists(join(home.configDir, PORT_FILE_NAME))).toBe(false);

        const reopened = openSqliteStorage(join(home.storeDir, "store.db"));
        try {
          await expect(reopened.get("PRAGMA user_version")).resolves.toEqual({
            user_version: 32,
          });
        } finally {
          await reopened.close();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(hasLoopback)("isolates concurrent writers for two athlete homes", async () => {
    const temporaryRoot = await realpath(tmpdir());
    const leftRoot = await mkdtemp(join(temporaryRoot, "coach-left-"));
    const rightRoot = await mkdtemp(join(temporaryRoot, "coach-right-"));
    const leftHome = syntheticHome(leftRoot);
    const rightHome = syntheticHome(rightRoot);
    const seenHomes: string[] = [];
    const binding = (home: AthleteHome, marker: string): CoachSourceBinding => ({
      source: syncSource("intervals-icu"),
      async run(context) {
        expect(context.home).toEqual(home);
        seenHomes.push(context.home.root);
        await context.store.run(
          "INSERT INTO source_watermark (source,lane,watermark) VALUES (?,?,?)",
          ["intervals-icu", "activities", marker],
        );
      },
    });
    try {
      const [leftReport, rightReport] = await Promise.all([
        runCoachSync({
          env: { ENDURAGENT_HOME: leftRoot },
          sources: [binding(leftHome, "left-marker")],
        }),
        runCoachSync({
          env: { ENDURAGENT_HOME: rightRoot },
          sources: [binding(rightHome, "right-marker")],
        }),
      ]);
      expect(leftReport.sources).toEqual([
        { source_id: "intervals-icu", status: "completed", severity: null, message: null },
      ]);
      expect(rightReport.sources).toEqual([
        { source_id: "intervals-icu", status: "completed", severity: null, message: null },
      ]);
      expect(leftReport.import_report).toBeNull();
      expect(rightReport.import_report).toBeNull();
      expect(new Set(seenHomes)).toEqual(new Set([leftRoot, rightRoot]));

      const leftStore = openSqliteStorage(join(leftHome.storeDir, "store.db"));
      const rightStore = openSqliteStorage(join(rightHome.storeDir, "store.db"));
      try {
        await expect(leftStore.all("SELECT watermark FROM source_watermark")).resolves.toEqual([
          { watermark: "left-marker" },
        ]);
        await expect(rightStore.all("SELECT watermark FROM source_watermark")).resolves.toEqual([
          { watermark: "right-marker" },
        ]);
      } finally {
        await leftStore.close();
        await rightStore.close();
      }

      let releaseHold!: () => void;
      let markEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        markEntered = resolve;
      });
      const hold = new Promise<void>((resolve) => {
        releaseHold = resolve;
      });
      const first = runCoachSync({
        env: { ENDURAGENT_HOME: leftRoot },
        sources: [
          {
            source: syncSource("file-import"),
            async run() {
              markEntered();
              await hold;
            },
          },
        ],
      });
      await entered;
      await expect(
        runCoachSync({ env: { ENDURAGENT_HOME: leftRoot }, sources: [] }),
      ).rejects.toMatchObject({
        name: "CoachStoreWriterError",
        code: "writer-lock-held",
        stage: null,
      });
      releaseHold();
      await expect(first).resolves.toMatchObject({ schema_version: 2 });
      expect(await pathExists(join(leftHome.configDir, LOCKFILE_NAME))).toBe(false);
      expect(await pathExists(join(leftHome.configDir, PORT_FILE_NAME))).toBe(false);
      expect(await pathExists(join(rightHome.configDir, LOCKFILE_NAME))).toBe(false);
      expect(await pathExists(join(rightHome.configDir, PORT_FILE_NAME))).toBe(false);
    } finally {
      await rm(leftRoot, { recursive: true, force: true });
      await rm(rightRoot, { recursive: true, force: true });
    }
  });

  it("projects persisted failures before a source run and returns the schema 2 public shape", async () => {
    const harness = await governedHarness();
    try {
      const repository = createSyncFailureRepository(harness.store);
      await repository.upsert({
        source: "intervals-icu",
        severity: "warn",
        detail: "source temporarily unavailable",
        logical_ordinal: 1_000,
      });
      const target = join(harness.home.root, "data", "error_state.json");
      const source = syncSource("intervals-icu");
      const report = await runCoachSync(
        {
          env: {},
          sources: [
            {
              source,
              async run(context) {
                expect(Object.isFrozen(context)).toBe(true);
                expect(context).toEqual({
                  home: harness.home,
                  store: harness.store,
                  listener: inertWriterProtocolListener,
                  source,
                });
                expect(Object.keys(context)).toEqual(["home", "store", "listener", "source"]);
                expect(JSON.parse(harness.projected.get(target)!)).toMatchObject({
                  detail: "intervals-icu: source temporarily unavailable",
                  mitigation: "warn_only",
                });
              },
            },
          ],
        },
        harness.dependencies,
      );
      expect(report).toEqual({
        schema_version: 2,
        sources: [
          {
            source_id: "intervals-icu",
            status: "completed",
            severity: null,
            message: null,
          },
        ],
        import_report: null,
      });
      expect(harness.projected.has(target)).toBe(false);
      expect(await repository.readAll()).toEqual([]);
    } finally {
      await harness.store.close();
    }
  });

  it("clears only the successful source while block remains ahead of warn", async () => {
    const harness = await governedHarness();
    try {
      const repository = createSyncFailureRepository(harness.store);
      await repository.upsert({
        source: "intervals-icu",
        severity: "warn",
        detail: "source temporarily unavailable",
        logical_ordinal: 2_000,
      });
      await repository.upsert({
        source: "file-import",
        severity: "block",
        detail: "source data failed validation",
        logical_ordinal: 1_000,
      });
      const target = join(harness.home.root, "data", "error_state.json");
      await runCoachSync(
        {
          env: {},
          sources: [
            {
              source: syncSource("intervals-icu"),
              async run() {
                expect(JSON.parse(harness.projected.get(target)!)).toMatchObject({
                  detail: "file-import: source data failed validation",
                  mitigation: "block_coaching",
                });
              },
            },
          ],
        },
        harness.dependencies,
      );
      expect((await repository.readAll()).map((row) => row.source)).toEqual(["file-import"]);
      expect(JSON.parse(harness.projected.get(target)!)).toMatchObject({
        detail: "file-import: source data failed validation",
        mitigation: "block_coaching",
      });
    } finally {
      await harness.store.close();
    }
  });

  it("maps every classifier code and uses the fixed no-classifier fallback", async () => {
    const harness = await governedHarness();
    try {
      const mappings = [
        ["authorization", "source authorization failed"],
        ["unavailable", "source temporarily unavailable"],
        ["invalid-data", "source data failed validation"],
        ["budget-exhausted", "source synchronization budget exhausted"],
      ] as const;
      for (const [code, detail] of mappings) {
        const report = await runCoachSync(
          {
            env: {},
            sources: [
              {
                source: syncSource("intervals-icu"),
                async run() {
                  throw new Error("synthetic private failure");
                },
                classifyFailure: () => ({ severity: "warn", code }),
              },
            ],
          },
          harness.dependencies,
        );
        expect(report.sources[0]).toMatchObject({ severity: "warn", message: detail });
      }
      const fallback = await runCoachSync(
        {
          env: {},
          sources: [
            {
              source: syncSource("file-import"),
              async run() {
                throw new Error("synthetic private fallback");
              },
            },
          ],
        },
        harness.dependencies,
      );
      expect(fallback.sources[0]).toMatchObject({
        severity: "block",
        message: "source synchronization failed",
      });
    } finally {
      await harness.store.close();
    }
  });

  it("contains classifier throws and adversarial descriptors without stringifying private values", async () => {
    const harness = await governedHarness();
    const fragments = [
      "/synthetic/private.fit",
      "https://invalid.test/?token=value",
      "Bearer synthetic-secret",
      '{"athlete":"synthetic-private"}',
    ];
    let stringified = 0;
    let accessorReads = 0;
    const privateThrown = {
      toString() {
        stringified += 1;
        return fragments[0];
      },
    };
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(accessor, {
      severity: {
        enumerable: true,
        get: () => {
          accessorReads += 1;
          return "block";
        },
      },
      code: { enumerable: true, value: "authorization" },
    });
    const nonEnumerable = { severity: "block" } as Record<string, unknown>;
    Object.defineProperty(nonEnumerable, "code", { enumerable: false, value: "authorization" });
    const symbol = Symbol("private");
    const classifiers = [
      () => {
        throw privateThrown;
      },
      () => ({ severity: "block", code: "authorization", detail: fragments[0] }),
      () => ({ severity: "block", code: fragments[1] }),
      () => ({ severity: "block", code: "authorization", token: fragments[2] }),
      () => ({ severity: "block", code: "authorization", athlete: { value: fragments[3] } }),
      () => accessor,
      () => ({ severity: "block", code: "authorization", [symbol]: fragments[0] }),
      () => nonEnumerable,
    ];
    try {
      for (const classifier of classifiers) {
        const report = await runCoachSync(
          {
            env: {},
            sources: [
              {
                source: syncSource("intervals-icu"),
                async run() {
                  throw privateThrown;
                },
                classifyFailure: classifier as never,
              },
            ],
          },
          harness.dependencies,
        );
        expect(report.sources[0]).toMatchObject({
          severity: "block",
          message: "source failure classification failed",
        });
        for (const fragment of fragments) expect(JSON.stringify(report)).not.toContain(fragment);
      }
      expect(stringified).toBe(0);
      expect(accessorReads).toBe(0);
    } finally {
      await harness.store.close();
    }
  });

  it("stops immediately when durable failure persistence fails", async () => {
    const store = syntheticStore();
    store.run = async (sql) => {
      if (sql.startsWith("INSERT INTO sync_failure")) throw new Error("persistence unavailable");
    };
    let laterCalls = 0;
    const withWriter: CoachSyncDependencies["withWriter"] = async (_env, operation) =>
      operation({
        home: syntheticHome(),
        store,
        listener: inertWriterProtocolListener,
      });
    await expect(
      runCoachSync(
        {
          env: {},
          sources: [
            {
              source: syncSource("intervals-icu"),
              async run() {
                throw new Error("source failed");
              },
            },
            {
              source: syncSource("file-import"),
              async run() {
                laterCalls += 1;
              },
            },
          ],
        },
        syncDependencies(withWriter, async () => importReport),
      ),
    ).rejects.toThrow("persistence unavailable");
    expect(laterCalls).toBe(0);
  });

  it("propagates projection failure while preserving the committed SQLite row", async () => {
    const harness = await governedHarness({
      fileSystem: {
        async writeFile() {
          throw new Error("projection unavailable");
        },
      },
    });
    try {
      await expect(
        runCoachSync(
          {
            env: {},
            sources: [
              {
                source: syncSource("intervals-icu"),
                async run() {
                  throw new Error("source failed");
                },
              },
            ],
          },
          harness.dependencies,
        ),
      ).rejects.toThrow("projection unavailable");
      expect(await createSyncFailureRepository(harness.store).readAll()).toEqual([
        {
          source: "intervals-icu",
          severity: "block",
          detail: "source synchronization failed",
          logical_ordinal: 1_000,
        },
      ]);
    } finally {
      await harness.store.close();
    }
  });

  it("constructs one hydration runtime inside the writer and imports validated bytes once", async () => {
    const bytes = Uint8Array.of(1, 2, 3);
    const artifact = {
      kind: "raw-file",
      source: "file-import",
      lane: "file-discovery",
      externalId: null,
      archiveInstant: { epochSeconds: 1_000 },
      archive: { address: "a".repeat(64), relPath: "synthetic.fit", deduped: false },
      file: { input_path: "/synthetic/pre-2015.fit", bytes, ext: "fit" } satisfies ImportArtifact,
    } as const;
    const checkpoint = { kind: "checkpoint" as const, watermark: fileHydrationInput().watermark };
    const importBatchWithReport = vi.fn<NodeImportRuntime["importBatchWithReport"]>(
      async () => importReport,
    );
    const runtime = { importBatchWithReport } as unknown as NodeImportRuntime;
    let writerActive = false;
    let runtimeCalls = 0;
    const harness = await governedHarness();
    const originalWriter = harness.dependencies.withWriter;
    const dependencies: CoachSyncDependencies = {
      ...harness.dependencies,
      async withWriter(env, operation) {
        return originalWriter(env, async (context) => {
          writerActive = true;
          try {
            return await operation(context);
          } finally {
            writerActive = false;
          }
        });
      },
      createImportRuntime() {
        expect(writerActive).toBe(true);
        runtimeCalls += 1;
        return runtime;
      },
    };
    try {
      const noOp = await runCoachSync(
        {
          env: {},
          sources: [
            {
              source: hydrationSource([checkpoint]),
              fileHydration: fileHydrationInput(),
            },
          ],
        },
        dependencies,
      );
      expect(noOp.sources[0]?.status).toBe("completed");
      expect(importBatchWithReport).not.toHaveBeenCalled();
      expect(runtimeCalls).toBe(1);

      const imported = await runCoachSync(
        {
          env: {},
          sources: [
            {
              source: hydrationSource([
                { kind: "batch", artifacts: [artifact] as never },
                checkpoint,
              ]),
              fileHydration: fileHydrationInput(),
            },
          ],
        },
        dependencies,
      );
      expect(imported.sources[0]?.status).toBe("completed");
      expect(runtimeCalls).toBe(2);
      expect(importBatchWithReport).toHaveBeenCalledTimes(1);
      const batch = importBatchWithReport.mock.calls[0]![0];
      expect(batch.platform_records).toEqual([]);
      expect(batch.files).toHaveLength(1);
      expect(batch.files[0]).toMatchObject({ bytes });
      expect(batch.files[0]!.input_path).toBe(artifact.file.input_path);
    } finally {
      await harness.store.close();
    }
  });

  it("contains hydration failure and still runs the explicit manual import after all outcomes", async () => {
    let manualCalls = 0;
    const harness = await governedHarness({
      importFiles: async () => {
        manualCalls += 1;
        return importReport;
      },
      createImportRuntime: () =>
        ({
          async importBatchWithReport() {
            throw new Error("/synthetic/private-source.fit?token=value");
          },
        }) as unknown as NodeImportRuntime,
    });
    try {
      const before = await dumpStore(harness.store);
      const checkpoint = { kind: "checkpoint" as const, watermark: fileHydrationInput().watermark };
      const report = await runCoachSync(
        {
          env: {},
          sources: [
            {
              source: hydrationSource([{ kind: "batch", artifacts: [] }, checkpoint]),
              fileHydration: fileHydrationInput(),
            },
          ],
          importPaths: ["/synthetic/manual.fit"],
        },
        harness.dependencies,
      );
      expect(report.sources).toEqual([
        {
          source_id: "file-import",
          status: "failed",
          severity: "block",
          message: "source synchronization failed",
        },
      ]);
      expect(report.import_report).toBe(importReport);
      expect(manualCalls).toBe(1);
      expect(JSON.stringify(report)).not.toContain("private-source");
      expect(await dumpStore(harness.store)).toBe(before);
      expect(await createSyncFailureRepository(harness.store).readAll()).toHaveLength(1);
    } finally {
      await harness.store.close();
    }
  });
});
