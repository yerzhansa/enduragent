import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { createServer as createNetServer } from "node:net";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ImportReport } from "@enduragent/kernel/ingest";
import type { MigratorStore, SqlStore } from "@enduragent/kernel/store";
import { inertWriterProtocolListener, type WriteLockHandle } from "@enduragent/kernel-node/lock";

type RunCoachDev = typeof import("../src/cli/coach-dev.js").runCoachDev;
type RunCoachDevWriter = typeof import("../src/cli/coach-dev.js").runCoachDevWriter;
type Dependencies = NonNullable<Parameters<RunCoachDev>[2]>;

const USAGE = "Usage: coach-dev import --report <path>...\n";
const USAGE_ERROR = 'usage_error: expected "import --report <path>..."\n' + USAGE;
const WRITER_LOCK_STDERR =
  "writer_lock_held: Another writer is active; stop it or wait, then retry.\n";
const WRITER_LOCK_STDOUT = `${JSON.stringify(
  {
    schema_version: 1,
    error: {
      code: "writer_lock_held",
      message: "Another writer is active; stop it or wait, then retry.",
    },
  },
  null,
  2,
)}\n`;
const IMPORT_FAILED_STDOUT = `${JSON.stringify(
  {
    schema_version: 1,
    error: { code: "import_failed", message: "Import failed; see stderr." },
  },
  null,
  2,
)}\n`;
const REPORT_KEYS = [
  "schema_version",
  "ingest_version",
  "effective",
  "files",
  "inserts",
  "updates",
  "clusters",
  "threshold_near_misses",
  "overlap_watchlist",
  "confirm_queue",
  "applied_confirmations",
  "brick_groups",
  "orphaned_overlays",
] as const;
const DETERMINISTIC_KEYS = [
  "schema_version",
  "ingest_version",
  "effective",
  "clusters",
  "threshold_near_misses",
  "overlap_watchlist",
  "confirm_queue",
  "applied_confirmations",
  "brick_groups",
  "orphaned_overlays",
] as const;

const hasLoopback = await new Promise<boolean>((resolve) => {
  const server = createNetServer();
  server.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPERM") {
      process.stderr.write("SKIP_MARKER loopback-listen EPERM coach-dev-import\n");
    }
    resolve(false);
  });
  server.listen({ host: "127.0.0.1", port: 0 }, () => {
    server.close(() => resolve(true));
  });
});

const pair = {
  member_a: "member-a",
  member_b: "member-b",
  candidate_a: "candidate-a",
  candidate_b: "candidate-b",
  serial_a: 1,
  serial_b: 2,
  start_delta_s: 121,
  duration_ratio: 0.11,
  duration_ratio_failed: false,
  distance_ratio: null,
  distance_ratio_state: "untested",
  containment: false,
  distance_untested: true,
  reason: "tier3_threshold_near_miss",
} as const;

const fullReportFixture: ImportReport = {
  schema_version: 1,
  ingest_version: 4,
  effective: {
    tier3: {
      startSeconds: 120,
      durationPercent: 10,
      distancePercent: 10,
      containmentSlackSeconds: 120,
      nearMissMultiplier: 2,
    },
    transition_window_s: 900,
  },
  files: [
    {
      input_path: "/synthetic/input.fit",
      address: "a".repeat(64),
      ext: "fit",
      archive_deduped: false,
      raw_file_inserted: true,
      outcome: "imported",
      quarantine: null,
    },
  ],
  inserts: { raw_file: 1, source_record: 0 },
  updates: { source_record: 0, relinked_source_records: 0 },
  clusters: [
    {
      cluster_id: "member-a",
      workout_key: "workout-a",
      members: ["member-a", "member-b"],
      edge_tiers: ["confirmation"],
      canonical_sources: [
        {
          concern: "session.start_utc",
          candidate_id: "candidate-a",
          rank: 400,
        },
      ],
    },
  ],
  threshold_near_misses: [pair],
  overlap_watchlist: [
    {
      ...pair,
      reason: "expanded_overlap_unmerged",
      expanded_a: { start_utc: 400, end_utc: 1600 },
      expanded_b: { start_utc: 521, end_utc: 1721 },
    },
  ],
  confirm_queue: [{ ...pair, reason: "tier3_serial_confirmation_required" }],
  applied_confirmations: [
    {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      member_a: "member-a",
      member_b: "member-b",
      verdict: "merge",
      hlc_physical_ms: 1,
      hlc_counter: 0,
      device_id: "device-1",
      result: "edge_authorized",
      reason: "effective_merge_confirmation",
    },
  ],
  brick_groups: [
    {
      members: ["member-a", "member-b"],
      families: ["swimming", "cycling"],
      gap_s: 30,
      effective_transition_window_s: 900,
    },
  ],
  orphaned_overlays: [
    {
      id: "overlay-1",
      target_kind: "field_merge_override_overlay:session",
      target_key: "missing-session",
      reason: "target_missing_after_rekey",
    },
  ],
};

let runCoachDev: RunCoachDev;
let runCoachDevWriter: RunCoachDevWriter;
let acquireWriteLock: typeof import("@enduragent/kernel-node/lock").acquireWriteLock;
let resolveAthleteHome: typeof import("@enduragent/kernel-node/home").resolveAthleteHome;
let openSqliteStorage: typeof import("@enduragent/kernel-node/sqlite").openSqliteStorage;
let dumpStore: typeof import("@enduragent/kernel/store").dumpStore;
let DUMP_TABLES: typeof import("@enduragent/kernel/store").DUMP_TABLES;
let MIGRATIONS: typeof import("@enduragent/kernel/store/migrations").MIGRATIONS;
let WriteLockContentionError: typeof import("@enduragent/kernel-node/lock").WriteLockContentionError;
let LOCKFILE_NAME: typeof import("@enduragent/kernel-node/lock").LOCKFILE_NAME;
let PORT_FILE_NAME: typeof import("@enduragent/kernel-node/lock").PORT_FILE_NAME;
let runCoachSync: typeof import("../../coach/src/sync.js").runCoachSync;
let createFileImportSource: typeof import("../../sync-file-import/src/index.js").createFileImportSource;
let createNodeFileStructuralValidator: typeof import("@enduragent/kernel-node/filesystem").createNodeFileStructuralValidator;
let ensurePrivateDirectory: typeof import("@enduragent/kernel-node/filesystem").ensurePrivateDirectory;
let nodeFileSystem: typeof import("@enduragent/kernel-node/filesystem").nodeFileSystem;
let removeFileIfPresent: typeof import("@enduragent/kernel-node/filesystem").removeFileIfPresent;
let createNodeImportRuntime: typeof import("@enduragent/kernel-node/ingest").createNodeImportRuntime;
let createArchiveManager: typeof import("@enduragent/kernel-node/archive").createArchiveManager;

const tempDirs = new Set<string>();
let realHome: string | undefined;
let firstReport: ImportReport | undefined;
let firstDump: string | undefined;

beforeAll(async () => {
  const requiredDist = [
    "packages/kernel/dist/store.js",
    "packages/kernel/dist/store/migrations.js",
    "packages/kernel-node/dist/home/index.js",
    "packages/kernel-node/dist/lock/index.js",
    "packages/kernel-node/dist/sqlite.js",
    "packages/kernel-node/dist/ingest/index.js",
    "packages/kernel-node/dist/filesystem/index.js",
  ];
  try {
    await Promise.all(requiredDist.map((path) => access(path)));
  } catch {
    throw new Error("required public dist precondition missing");
  }

  const [
    homeModule,
    lockModule,
    sqliteModule,
    storeModule,
    migrationModule,
    coachModule,
    fileSourceModule,
    filesystemModule,
    ingestModule,
    archiveModule,
  ] = await Promise.all([
    import("@enduragent/kernel-node/home"),
    import("@enduragent/kernel-node/lock"),
    import("@enduragent/kernel-node/sqlite"),
    import("@enduragent/kernel/store"),
    import("@enduragent/kernel/store/migrations"),
    import("../../coach/src/sync.js"),
    import("../../sync-file-import/src/index.js"),
    import("@enduragent/kernel-node/filesystem"),
    import("@enduragent/kernel-node/ingest"),
    import("@enduragent/kernel-node/archive"),
  ]);
  resolveAthleteHome = homeModule.resolveAthleteHome;
  acquireWriteLock = lockModule.acquireWriteLock;
  WriteLockContentionError = lockModule.WriteLockContentionError;
  LOCKFILE_NAME = lockModule.LOCKFILE_NAME;
  PORT_FILE_NAME = lockModule.PORT_FILE_NAME;
  openSqliteStorage = sqliteModule.openSqliteStorage;
  dumpStore = storeModule.dumpStore;
  DUMP_TABLES = storeModule.DUMP_TABLES;
  MIGRATIONS = migrationModule.MIGRATIONS;
  runCoachSync = coachModule.runCoachSync;
  createFileImportSource = fileSourceModule.createFileImportSource;
  createNodeFileStructuralValidator = filesystemModule.createNodeFileStructuralValidator;
  ensurePrivateDirectory = filesystemModule.ensurePrivateDirectory;
  nodeFileSystem = filesystemModule.nodeFileSystem;
  removeFileIfPresent = filesystemModule.removeFileIfPresent;
  createNodeImportRuntime = ingestModule.createNodeImportRuntime;
  createArchiveManager = archiveModule.createArchiveManager;
  ({ runCoachDev, runCoachDevWriter } = await import("../src/cli/coach-dev.js"));
});

afterAll(async () => {
  for (const path of tempDirs) {
    await rm(path, { recursive: true, force: true });
  }
});

async function freshHome(prefix: string): Promise<string> {
  const path = await mkdtemp(join(await realpath(tmpdir()), prefix));
  tempDirs.add(path);
  return path;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runChild(
  home: string,
  args: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, ENDURAGENT_HOME: home };
  for (const name of Object.keys(env)) {
    if (/API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(name)) {
      delete env[name];
    }
  }
  delete env.NODE_NO_WARNINGS;
  env.NODE_OPTIONS = "--disable-warning=ExperimentalWarning";

  return new Promise((resolveResult, reject) => {
    const child = spawn(
      "pnpm",
      ["exec", "tsx", "packages/kernel-node/src/cli/coach-dev.ts", ...args],
      { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`coach-dev child terminated by ${signal}`));
        return;
      }
      resolveResult({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

type InjectedStage =
  | "resolve"
  | "prepare"
  | "windows-directory"
  | "acquire"
  | "mkdir"
  | "chmod"
  | "open"
  | "migrate"
  | "import"
  | "close"
  | "release";

interface InjectedOptions {
  readonly fail?: Partial<Record<InjectedStage, unknown>>;
  readonly home?: {
    readonly root: string;
    readonly storeDir: string;
    readonly archiveDir: string;
    readonly configDir: string;
  };
  readonly preparedHome?: {
    readonly root: string;
    readonly storeDir: string;
    readonly archiveDir: string;
    readonly configDir: string;
  };
  readonly report?: ImportReport;
}

function injected(options: InjectedOptions = {}) {
  const calls: string[] = [];
  const home =
    options.home ??
    ({
      root: "/synthetic/home",
      storeDir: "/synthetic/home/store",
      archiveDir: "/synthetic/home/archive",
      configDir: "/synthetic/home/config",
    } as const);
  const preparedHome = options.preparedHome ?? home;
  const fail = (stage: InjectedStage): void => {
    if (Object.hasOwn(options.fail ?? {}, stage)) {
      throw options.fail?.[stage];
    }
  };
  const observed: {
    prepare?: unknown;
    mkdir?: readonly [string, unknown];
    chmod?: readonly [string, number];
    open?: string;
    migrations?: unknown;
    import?: {
      readonly inputPaths: readonly string[];
      readonly archiveDir: string;
      readonly store: unknown;
    };
    lock?: unknown;
  } = {};
  const store = {
    async exec() {},
    async run() {},
    async get() {
      return undefined;
    },
    async all() {
      return [];
    },
    async close() {
      calls.push("close");
      fail("close");
    },
    async getUserVersion() {
      return 0;
    },
    async setUserVersion() {},
    async transaction<T>(fn: () => Promise<T>) {
      return fn();
    },
  } as SqlStore & MigratorStore;
  const handle: WriteLockHandle = {
    status: "acquired",
    port: 1,
    lockfilePath: "/synthetic/home/config/store-writer.lock",
    portFilePath: "/synthetic/home/config/store-writer.port",
    listener: inertWriterProtocolListener,
    async release() {
      calls.push("release");
      fail("release");
    },
  };
  const deps = {
    resolveAthleteHome() {
      calls.push("resolve");
      fail("resolve");
      return home;
    },
    async prepareAthleteHome(value: typeof home, prepareOptions?: unknown) {
      calls.push("prepare");
      expect(value).toBe(home);
      observed.prepare = prepareOptions;
      fail("prepare");
      return preparedHome;
    },
    async acquireWriteLock(value: unknown) {
      calls.push("acquire");
      observed.lock = value;
      fail("acquire");
      return handle;
    },
    async ensureWindowsPrivateDirectory(path: string) {
      calls.push("windows-directory");
      expect(path).toBe(preparedHome.storeDir);
      fail("windows-directory");
      return path;
    },
    async mkdir(path: string, mkdirOptions: unknown) {
      calls.push("mkdir");
      observed.mkdir = [path, mkdirOptions];
      fail("mkdir");
      return undefined;
    },
    async chmod(path: string, mode: number) {
      calls.push("chmod");
      observed.chmod = [path, mode];
      fail("chmod");
    },
    openSqliteStorage(path: string) {
      calls.push("open");
      observed.open = path;
      fail("open");
      return store;
    },
    async runMigrations(_store: unknown, migrations: unknown) {
      calls.push("migrate");
      observed.migrations = migrations;
      fail("migrate");
      return { fromVersion: 0, toVersion: 5, applied: [1, 2, 3, 4, 5] };
    },
    async importFilesWithReport(value: {
      readonly inputPaths: readonly string[];
      readonly archiveDir: string;
      readonly store: unknown;
    }) {
      calls.push("import");
      observed.import = value;
      fail("import");
      return options.report ?? fullReportFixture;
    },
  } as Dependencies;
  return { calls, deps, home, preparedHome, observed, store };
}

function expectUnexpected(result: Awaited<ReturnType<RunCoachDev>>, stage: string): void {
  expect(result).toEqual({
    exitCode: 1,
    stdout: IMPORT_FAILED_STDOUT,
    stderr: `import_failed: ${stage} failed\n`,
  });
}

async function expectLockFilesAbsent(home: string): Promise<void> {
  const configDir = join(home, "config");
  expect(await exists(join(configDir, LOCKFILE_NAME))).toBe(false);
  expect(await exists(join(configDir, PORT_FILE_NAME))).toBe(false);
}

describe("coach-dev import --report", () => {
  it("help forms are no-write", async () => {
    for (const argv of [["--help"], ["import", "--help"]]) {
      const scenario = injected();
      await expect(runCoachDev(argv, {}, scenario.deps)).resolves.toEqual({
        exitCode: 0,
        stdout: USAGE,
        stderr: "",
      });
      expect(scenario.calls).toEqual([]);
    }
  });

  it("usage errors are no-write", async () => {
    const cases = [
      [],
      ["import"],
      ["import", "input.fit"],
      ["import", "--report"],
      ["import", "--report", "input.fit", "--report"],
      ["export", "--report", "input.fit"],
      ["import", "--report", "-input.fit"],
      ["import", "--report", ""],
    ];
    for (const argv of cases) {
      const scenario = injected();
      await expect(runCoachDev(argv, {}, scenario.deps)).resolves.toEqual({
        exitCode: 2,
        stdout: "",
        stderr: USAGE_ERROR,
      });
      expect(scenario.calls).toEqual([]);
    }
  });

  it("prepares the physical athlete home before acquiring its writer lock", async () => {
    const lexicalRoot = "/synthetic/alias-home";
    const physicalRoot = "/synthetic/physical-home";
    const scenario = injected({
      home: {
        root: lexicalRoot,
        storeDir: join(lexicalRoot, "store"),
        archiveDir: join(lexicalRoot, "archive"),
        configDir: join(lexicalRoot, "config"),
      },
      preparedHome: {
        root: physicalRoot,
        storeDir: join(physicalRoot, "store"),
        archiveDir: join(physicalRoot, "archive"),
        configDir: join(physicalRoot, "config"),
      },
    });
    let operationHome: unknown;

    const result = await runCoachDevWriter(
      {
        env: { ENDURAGENT_HOME: lexicalRoot },
        writerVersion: "physical-home/1",
        operation: async ({ home }) => {
          operationHome = home;
          return "done";
        },
      },
      scenario.deps,
    );

    expect(result).toEqual({ status: "completed", value: "done" });
    expect(scenario.calls.slice(0, 3)).toEqual(["resolve", "prepare", "acquire"]);
    expect(scenario.observed.lock).toEqual({
      configDir: join(physicalRoot, "config"),
      athleteHome: physicalRoot,
      version: "physical-home/1",
    });
    expect(operationHome).toBe(scenario.preparedHome);
  });

  it.runIf(hasLoopback)("First real child import is non-vacuous", async () => {
    realHome = await freshHome("coach-dev-real-");
    const fixture = resolve("packages/kernel-node/tests/fixtures/ingest/triathlon-multisport.fit");
    const child = await runChild(realHome, ["import", "--report", fixture]);
    expect(child.exitCode).toBe(0);
    expect(child.stderr).toBe("");
    firstReport = JSON.parse(child.stdout) as ImportReport;
    expect(Object.keys(firstReport)).toEqual(REPORT_KEYS);
    expect(firstReport.files).toHaveLength(1);
    expect(firstReport.files[0]).toMatchObject({
      input_path: fixture,
      ext: "fit",
      archive_deduped: false,
      raw_file_inserted: true,
      outcome: "imported",
      quarantine: null,
    });
    expect(firstReport.files[0]!.address).toMatch(/^[0-9a-f]{64}$/);
    expect(firstReport.inserts).toEqual({ raw_file: 1, source_record: 0 });

    const databasePath = join(realHome, "store", "store.db");
    expect(await exists(databasePath)).toBe(true);
    const store = openSqliteStorage(databasePath);
    try {
      expect(await store.get("PRAGMA user_version")).toEqual({ user_version: 32 });
      expect(await store.get("SELECT count(*) AS c FROM raw_file")).toEqual({ c: 1 });
      expect(await store.get("SELECT count(*) AS c FROM source_record")).toEqual({ c: 0 });
      expect(
        Number((await store.get("SELECT count(*) AS c FROM workout"))?.c),
      ).toBeGreaterThanOrEqual(1);
      expect(
        Number((await store.get("SELECT count(*) AS c FROM session"))?.c),
      ).toBeGreaterThanOrEqual(1);
      firstDump = await dumpStore(store);
    } finally {
      await store.close();
    }
    await expectLockFilesAbsent(realHome);
  });

  it.runIf(hasLoopback)("Second real child import is archive-deduped", async () => {
    expect(realHome).toBeDefined();
    expect(firstReport).toBeDefined();
    expect(firstDump).toBeDefined();
    const fixture = resolve("packages/kernel-node/tests/fixtures/ingest/triathlon-multisport.fit");
    const child = await runChild(realHome!, ["import", "--report", fixture]);
    expect(child.exitCode).toBe(0);
    expect(child.stderr).toBe("");
    const second = JSON.parse(child.stdout) as ImportReport;
    expect(Object.keys(second)).toEqual(REPORT_KEYS);
    expect(second.files).toHaveLength(1);
    expect(second.files[0]).toMatchObject({
      input_path: fixture,
      address: firstReport!.files[0]!.address,
      ext: "fit",
      archive_deduped: true,
      raw_file_inserted: false,
      outcome: "imported",
      quarantine: null,
    });
    expect(second.inserts).toEqual({ raw_file: 0, source_record: 0 });
    expect(second.updates.source_record).toBe(0);
    expect(second.files.every((file) => file.raw_file_inserted === false)).toBe(true);
    for (const key of DETERMINISTIC_KEYS) {
      expect(second[key]).toEqual(firstReport![key]);
    }

    const store = openSqliteStorage(join(realHome!, "store", "store.db"));
    try {
      expect(await dumpStore(store)).toBe(firstDump);
    } finally {
      await store.close();
    }
    await expectLockFilesAbsent(realHome!);
  });

  it.runIf(hasLoopback)(
    "held-lock refuses safely",
    async () => {
      const homePath = await freshHome("coach-dev-held-");
      const home = resolveAthleteHome({ ENDURAGENT_HOME: homePath });
      const result = await acquireWriteLock({
        configDir: home.configDir,
        athleteHome: home.root,
        version: "test-parent",
      });
      expect(result.status).toBe("acquired");
      if (result.status !== "acquired") throw new Error("expected acquired lock");
      const foreignServer = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ service: "foreign", version: "test" }));
      });
      await new Promise<void>((resolveListen) => {
        foreignServer.listen({ host: "127.0.0.1", port: 0 }, resolveListen);
      });
      const foreignAddress = foreignServer.address();
      if (foreignAddress === null || typeof foreignAddress === "string") {
        throw new Error("foreign holder did not bind a TCP port");
      }
      await writeFile(join(home.configDir, PORT_FILE_NAME), `${foreignAddress.port}\n`, {
        mode: 0o600,
      });
      try {
        const child = await runChild(homePath, [
          "import",
          "--report",
          resolve("packages/kernel-node/tests/fixtures/ingest/triathlon-multisport.fit"),
        ]);
        expect(child).toEqual({
          exitCode: 3,
          stdout: WRITER_LOCK_STDOUT,
          stderr: WRITER_LOCK_STDERR,
        });
        expect(await exists(home.storeDir)).toBe(true);
        expect(await exists(join(home.storeDir, "store.db"))).toBe(false);
      } finally {
        await new Promise<void>((resolveClose, reject) => {
          foreignServer.close((error) => (error ? reject(error) : resolveClose()));
        });
        await result.release();
      }
      await expectLockFilesAbsent(homePath);
    },
    15_000,
  );

  it.runIf(hasLoopback)("healthy-peer refuses without ownership", async () => {
    const homePath = await freshHome("coach-dev-peer-");
    const home = resolveAthleteHome({ ENDURAGENT_HOME: homePath });
    await mkdir(home.configDir, { recursive: true, mode: 0o700 });
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          service: "enduragent-store-writer",
          version: "test-peer",
        }),
      );
    });
    await new Promise<void>((resolveListen) => {
      server.listen({ host: "127.0.0.1", port: 0 }, resolveListen);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("healthy peer did not bind a TCP port");
    }
    const lockPath = join(home.configDir, LOCKFILE_NAME);
    const portPath = join(home.configDir, PORT_FILE_NAME);
    const lockBytes = `${JSON.stringify(
      {
        pid: process.pid,
        port: address.port,
        version: "test-peer",
        athleteHome: home.root,
      },
      null,
      2,
    )}\n`;
    const portBytes = `${address.port}\n`;
    await writeFile(lockPath, lockBytes, { mode: 0o600 });
    await writeFile(portPath, portBytes, { mode: 0o600 });
    try {
      const child = await runChild(homePath, [
        "import",
        "--report",
        resolve("packages/kernel-node/tests/fixtures/ingest/triathlon-multisport.fit"),
      ]);
      expect(child).toEqual({
        exitCode: 3,
        stdout: WRITER_LOCK_STDOUT,
        stderr: WRITER_LOCK_STDERR,
      });
      expect(await readFile(lockPath, "utf8")).toBe(lockBytes);
      expect(await readFile(portPath, "utf8")).toBe(portBytes);
      expect(await exists(home.storeDir)).toBe(true);
      expect(await exists(join(home.storeDir, "store.db"))).toBe(false);
    } finally {
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      });
    }
  });

  it("successful injected lifecycle and full report serialization", async () => {
    const scenario = injected({ report: fullReportFixture });
    const inputPaths = ["/synthetic/z.fit", "/synthetic/a.fit"];
    const result = await runCoachDev(
      ["import", "--report", ...inputPaths],
      { ENDURAGENT_HOME: scenario.home.root },
      scenario.deps,
    );
    expect(result).toEqual({
      exitCode: 0,
      stdout: `${JSON.stringify(fullReportFixture, null, 2)}\n`,
      stderr: "",
    });
    expect(scenario.calls).toEqual([
      "resolve",
      "prepare",
      "acquire",
      "mkdir",
      "chmod",
      "open",
      "migrate",
      "import",
      "close",
      "release",
    ]);
    expect(scenario.observed.lock).toEqual({
      configDir: scenario.home.configDir,
      athleteHome: scenario.home.root,
      version: "coach-dev-import/1",
    });
    expect(scenario.observed.mkdir).toEqual([
      scenario.home.storeDir,
      { recursive: true, mode: 0o700 },
    ]);
    expect(scenario.observed.chmod).toEqual([scenario.home.storeDir, 0o700]);
    expect(scenario.observed.open).toBe(join(scenario.home.storeDir, "store.db"));
    expect(scenario.observed.migrations).toBe(MIGRATIONS);
    expect(scenario.observed.import).toEqual({
      inputPaths,
      archiveDir: scenario.home.archiveDir,
      store: scenario.store,
    });
  });

  it("shared writer lifecycle owns generic operation and cleanup", async () => {
    const successful = injected();
    const value = { result: "generic-operation-value" } as const;
    let context: unknown;
    const result = await runCoachDevWriter(
      {
        env: { ENDURAGENT_HOME: successful.home.root },
        writerVersion: "generic-operation/1",
        operation: async (received) => {
          successful.calls.push("operation");
          context = received;
          return value;
        },
      },
      successful.deps,
    );
    expect(result).toEqual({ status: "completed", value });
    expect(context).toEqual({
      home: successful.home,
      store: successful.store,
      listener: inertWriterProtocolListener,
    });
    expect(successful.observed.lock).toEqual({
      configDir: successful.home.configDir,
      athleteHome: successful.home.root,
      version: "generic-operation/1",
    });
    expect(successful.calls).toEqual([
      "resolve",
      "prepare",
      "acquire",
      "mkdir",
      "chmod",
      "open",
      "migrate",
      "operation",
      "close",
      "release",
    ]);

    const privateValues = ["private operation data", "private close data", "private release data"];
    const failed = injected({
      fail: {
        close: new Error(privateValues[1]),
        release: new Error(privateValues[2]),
      },
    });
    const failure = await runCoachDevWriter(
      {
        env: {},
        writerVersion: "generic-operation/1",
        operation: async () => {
          failed.calls.push("operation");
          throw new Error(privateValues[0]);
        },
      },
      failed.deps,
    );
    expect(failure).toEqual({ status: "failed", stage: "invoke operation" });
    expect(
      failure.status === "failed" && failure.cause instanceof Error && failure.cause.message,
    ).toBe(privateValues[0]);
    expect(failed.calls).toEqual([
      "resolve",
      "prepare",
      "acquire",
      "mkdir",
      "chmod",
      "open",
      "migrate",
      "operation",
      "close",
      "release",
    ]);
    const serialized = JSON.stringify(failure);
    for (const privateValue of privateValues) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it("uses Windows structural policy without invoking the POSIX store chmod stage", async () => {
    const scenario = injected({ fail: { chmod: new Error("must not run") } });

    const result = await runCoachDevWriter(
      {
        env: {},
        writerVersion: "windows-writer/1",
        platform: "win32",
        operation: async () => "done",
      },
      scenario.deps,
    );

    expect(result).toEqual({ status: "completed", value: "done" });
    expect(scenario.calls).toEqual([
      "resolve",
      "prepare",
      "acquire",
      "mkdir",
      "windows-directory",
      "open",
      "migrate",
      "close",
      "release",
    ]);
    expect(scenario.observed.prepare).toEqual({ platform: "win32" });
    expect(scenario.observed.lock).toEqual({
      configDir: scenario.home.configDir,
      athleteHome: scenario.home.root,
      version: "windows-writer/1",
      platform: "win32",
    });
    expect(scenario.observed.chmod).toBeUndefined();
  });

  it("fails before store open when the Windows store-directory assertion fails", async () => {
    const assertionFailure = new Error("private Windows assertion detail");
    const scenario = injected({ fail: { "windows-directory": assertionFailure } });

    const result = await runCoachDevWriter(
      {
        env: {},
        writerVersion: "windows-writer/1",
        platform: "win32",
        operation: async () => "unreachable",
      },
      scenario.deps,
    );

    expect(result).toEqual({ status: "failed", stage: "secure store directory" });
    expect(result.status === "failed" && result.cause).toBe(assertionFailure);
    expect(scenario.calls).toEqual([
      "resolve",
      "prepare",
      "acquire",
      "mkdir",
      "windows-directory",
      "release",
    ]);
  });

  it("runs the pre-open hook under the writer before store effects and releases on failure", async () => {
    const successful = injected();
    await expect(
      runCoachDevWriter(
        {
          env: {},
          writerVersion: "generic-operation/1",
          beforeStoreOpen: async (home) => {
            expect(home).toBe(successful.home);
            successful.calls.push("pre-open");
          },
          operation: async () => {
            successful.calls.push("operation");
            return "done";
          },
        },
        successful.deps,
      ),
    ).resolves.toEqual({ status: "completed", value: "done" });
    expect(successful.calls).toEqual([
      "resolve",
      "prepare",
      "acquire",
      "pre-open",
      "mkdir",
      "chmod",
      "open",
      "migrate",
      "operation",
      "close",
      "release",
    ]);

    const failure = { kind: "pre-open" };
    const failed = injected();
    const result = await runCoachDevWriter(
      {
        env: {},
        writerVersion: "generic-operation/1",
        beforeStoreOpen: async () => {
          failed.calls.push("pre-open");
          throw failure;
        },
        operation: async () => {
          failed.calls.push("operation");
          return null;
        },
      },
      failed.deps,
    );
    expect(result).toEqual({ status: "failed", stage: "run pre-open operation" });
    expect(result.status === "failed" && result.cause).toBe(failure);
    expect(failed.calls).toEqual(["resolve", "prepare", "acquire", "pre-open", "release"]);
  });

  it("requires typed diagnostics from a foreign-copy contention error", async () => {
    const foreign = new Error("write lock held by a healthy peer");
    foreign.name = "WriteLockContentionError";
    const scenario = injected({ fail: { acquire: foreign } });
    const result = await runCoachDevWriter(
      {
        env: {},
        writerVersion: "generic-operation/1",
        operation: async () => {
          scenario.calls.push("operation");
          return null;
        },
      },
      scenario.deps,
    );
    expect(result).toEqual({ status: "failed", stage: "acquire lock" });
    expect(result.status === "failed" && result.cause).toBe(foreign);
    expect(scenario.calls).toEqual(["resolve", "prepare", "acquire"]);

    const typedForeign = new Error("foreign process") as Error & {
      contention: { kind: "foreign"; port: number; portFile: string };
    };
    typedForeign.name = "WriteLockContentionError";
    typedForeign.contention = {
      kind: "foreign",
      port: 4567,
      portFile: "synthetic/config/store-writer.port",
    };
    const typedScenario = injected({ fail: { acquire: typedForeign } });
    await expect(
      runCoachDevWriter(
        {
          env: {},
          writerVersion: "generic-operation/1",
          operation: async () => null,
        },
        typedScenario.deps,
      ),
    ).resolves.toEqual({
      status: "writer-lock-held",
      contention: typedForeign.contention,
    });
  });

  it("rejects a non-error lookalike named like the contention error", async () => {
    const lookalike = { name: "WriteLockContentionError", message: "not an Error instance" };
    const scenario = injected({ fail: { acquire: lookalike } });
    const result = await runCoachDevWriter(
      {
        env: {},
        writerVersion: "generic-operation/1",
        operation: async () => null,
      },
      scenario.deps,
    );
    expect(result).toEqual({ status: "failed", stage: "acquire lock" });
    expect(result.status === "failed" && result.cause).toBe(lookalike);
  });

  it("never serializes failure causes carrying enumerable private data", async () => {
    const privateTexts = [
      "/private/athlete/home/store.db",
      "thrown-plain-object-secret",
      "thrown-string-secret",
    ];
    const fsLike = Object.assign(new Error("EACCES: permission denied"), {
      path: privateTexts[0],
      syscall: "open",
    });
    for (const thrown of [fsLike, { detail: privateTexts[1] }, privateTexts[2]]) {
      const scenario = injected();
      const failure = await runCoachDevWriter(
        {
          env: {},
          writerVersion: "generic-operation/1",
          operation: async () => {
            throw thrown;
          },
        },
        scenario.deps,
      );
      expect(failure).toEqual({ status: "failed", stage: "invoke operation" });
      expect(failure.status === "failed" && failure.cause).toBe(thrown);
      const serialized = JSON.stringify(failure);
      for (const text of privateTexts) expect(serialized).not.toContain(text);
    }
  });

  it("pre-store failure table uses safe stage diagnostics", async () => {
    const cases: readonly {
      readonly stage: InjectedStage;
      readonly diagnostic: string;
      readonly calls: readonly string[];
    }[] = [
      { stage: "resolve", diagnostic: "resolve home", calls: ["resolve"] },
      {
        stage: "prepare",
        diagnostic: "resolve home",
        calls: ["resolve", "prepare"],
      },
      {
        stage: "acquire",
        diagnostic: "acquire lock",
        calls: ["resolve", "prepare", "acquire"],
      },
      {
        stage: "mkdir",
        diagnostic: "create store directory",
        calls: ["resolve", "prepare", "acquire", "mkdir", "release"],
      },
      {
        stage: "chmod",
        diagnostic: "secure store directory",
        calls: ["resolve", "prepare", "acquire", "mkdir", "chmod", "release"],
      },
      {
        stage: "open",
        diagnostic: "open store",
        calls: ["resolve", "prepare", "acquire", "mkdir", "chmod", "open", "release"],
      },
    ];
    for (const entry of cases) {
      const scenario = injected({
        fail: { [entry.stage]: new Error(`private-${entry.stage}`) },
      });
      const result = await runCoachDev(
        ["import", "--report", "/synthetic/input.fit"],
        {},
        scenario.deps,
      );
      expectUnexpected(result, entry.diagnostic);
      expect(scenario.calls).toEqual(entry.calls);
    }
  });

  it("migration and import failures clean up", async () => {
    const cases: readonly {
      readonly stage: "migrate" | "import";
      readonly error: Error;
      readonly diagnostic: string;
      readonly calls: readonly string[];
    }[] = [
      {
        stage: "migrate",
        error: new Error("private migration failure"),
        diagnostic: "run migrations",
        calls: [
          "resolve",
          "prepare",
          "acquire",
          "mkdir",
          "chmod",
          "open",
          "migrate",
          "close",
          "release",
        ],
      },
      {
        stage: "import",
        error: new WriteLockContentionError("late private contention", 3),
        diagnostic: "import files",
        calls: [
          "resolve",
          "prepare",
          "acquire",
          "mkdir",
          "chmod",
          "open",
          "migrate",
          "import",
          "close",
          "release",
        ],
      },
    ];
    for (const entry of cases) {
      const scenario = injected({ fail: { [entry.stage]: entry.error } });
      const result = await runCoachDev(
        ["import", "--report", "/synthetic/input.fit"],
        {},
        scenario.deps,
      );
      expectUnexpected(result, entry.diagnostic);
      expect(scenario.calls).toEqual(entry.calls);
    }
  });

  it("close failure still releases", async () => {
    const scenario = injected({
      fail: { close: new Error("private close failure") },
    });
    const result = await runCoachDev(
      ["import", "--report", "/synthetic/input.fit"],
      {},
      scenario.deps,
    );
    expectUnexpected(result, "close store");
    expect(scenario.calls).toEqual([
      "resolve",
      "prepare",
      "acquire",
      "mkdir",
      "chmod",
      "open",
      "migrate",
      "import",
      "close",
      "release",
    ]);
  });

  it("release failure withholds success", async () => {
    const scenario = injected({
      fail: { release: new Error("private release failure") },
    });
    const result = await runCoachDev(
      ["import", "--report", "/synthetic/input.fit"],
      {},
      scenario.deps,
    );
    expectUnexpected(result, "release lock");
    expect(scenario.calls).toEqual([
      "resolve",
      "prepare",
      "acquire",
      "mkdir",
      "chmod",
      "open",
      "migrate",
      "import",
      "close",
      "release",
    ]);
  });

  it("Privacy/precedence never forwards dependency errors", async () => {
    const homePath = "/private/athlete-secret-home";
    const inputPath = "/private/athlete-secret-input.fit";
    const credential = "credential-secret-907";
    const scenario = injected({
      home: {
        root: homePath,
        storeDir: join(homePath, "store"),
        archiveDir: join(homePath, "archive"),
        configDir: join(homePath, "config"),
      },
      fail: {
        import: new Error(
          `${homePath} ${inputPath} ${credential} line one\r\nline two\nSOURCE_BYTES_907`,
        ),
        close: new Error("cleanup-close-secret-907"),
        release: new Error("cleanup-release-secret-907"),
      },
    });
    const result = await runCoachDev(
      ["import", "--report", inputPath],
      { API_KEY: credential },
      scenario.deps,
    );
    expect(result).toEqual({
      exitCode: 1,
      stdout: IMPORT_FAILED_STDOUT,
      stderr: "import_failed: import files failed\n",
    });
    expect(scenario.calls).toEqual([
      "resolve",
      "prepare",
      "acquire",
      "mkdir",
      "chmod",
      "open",
      "migrate",
      "import",
      "close",
      "release",
    ]);
    expect(result.stderr.match(/\n/g)).toHaveLength(1);
    const output = result.stdout + result.stderr;
    for (const privateValue of [
      homePath,
      inputPath,
      credential,
      "line one",
      "line two",
      "SOURCE_BYTES_907",
      "cleanup-close-secret-907",
      "cleanup-release-secret-907",
      "Error:",
      " at ",
    ]) {
      expect(output).not.toContain(privateValue);
    }
  });

  it("hydrates one manual or quiescent watch burst from validated bytes through one governed writer call", async () => {
    const fixtureNames = [
      "brick-cycling.fit",
      "fallback-cycling.tcx",
      "fallback-cycling.gpx",
    ] as const;
    const crypto = {
      async sha256(data: Uint8Array) {
        return new Uint8Array(createHash("sha256").update(data).digest());
      },
      async randomBytes() {
        throw new Error("unused");
      },
      async pbkdf2() {
        throw new Error("unused");
      },
      async aesGcmEncrypt() {
        throw new Error("unused");
      },
      async aesGcmDecrypt() {
        throw new Error("unused");
      },
    } as Parameters<typeof createArchiveManager>[0]["crypto"];

    for (const mode of ["manual", "watch"] as const) {
      const root = await freshHome(`coach-hydration-${mode}-`);
      const home = resolveAthleteHome({ ENDURAGENT_HOME: root });
      const inputDir = join(root, "synthetic-inputs");
      await mkdir(inputDir, { recursive: true });
      const paths: string[] = [];
      const expected = new Map<string, Uint8Array>();
      for (const name of fixtureNames) {
        const from = resolve(`packages/kernel-node/tests/fixtures/ingest/${name}`);
        const to = join(inputDir, name);
        await copyFile(from, to);
        paths.push(to);
        expected.set(to, new Uint8Array(await readFile(to)));
      }

      await ensurePrivateDirectory(home.storeDir);
      const store = openSqliteStorage(join(home.storeDir, "store.db"));
      const { runMigrations } = await import("@enduragent/kernel/store");
      await runMigrations(store, MIGRATIONS);
      const baseFs = nodeFileSystem();
      let readCalls = 0;
      const sourceFs = {
        ...baseFs,
        async readFile(path: string) {
          readCalls += 1;
          return baseFs.readFile(path);
        },
      };
      let archived = 0;
      const archive = createArchiveManager({ archiveRoot: home.archiveDir, crypto, fs: baseFs });
      const validateBase = createNodeFileStructuralValidator();
      const validated: string[] = [];
      const source = createFileImportSource(
        mode === "manual"
          ? { manualPaths: paths, watchRoots: [] }
          : { manualPaths: [], watchRoots: [inputDir] },
        {
          fs: sourceFs,
          clock: {
            setTimeout(callback, delayMs) {
              return globalThis.setTimeout(callback, delayMs);
            },
            clearTimeout(handle) {
              globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
            },
          },
          crypto,
          archive: {
            async writeArtifact(bytes, ext, instant) {
              const result = await archive.writeArtifact(bytes, ext, instant);
              archived += 1;
              return result;
            },
          },
          async validate(input) {
            await validateBase(input);
            validated.push(input.ext);
          },
        },
      );
      let writerCalls = 0;
      let writerActive = false;
      let runtimeCalls = 0;
      let importerCalls = 0;
      let readsAtImport = -1;
      const dependencies: Parameters<typeof runCoachSync>[1] = {
        async withWriter(_env, operation) {
          writerCalls += 1;
          writerActive = true;
          try {
            return await operation({ home, store, listener: inertWriterProtocolListener });
          } finally {
            writerActive = false;
          }
        },
        async importFiles() {
          throw new Error("manual path importer must not run");
        },
        fileSystem: baseFs,
        ensurePrivateDirectory,
        removeFileIfPresent,
        nowEpochMs: () => 1_000,
        createImportRuntime(options) {
          expect(writerActive).toBe(true);
          runtimeCalls += 1;
          const runtime = createNodeImportRuntime(options);
          return {
            archive: runtime.archive,
            async importBatchWithReport(batch) {
              importerCalls += 1;
              expect(archived).toBe(3);
              readsAtImport = readCalls;
              for (const file of batch.files) {
                expect(file).toMatchObject({ bytes: expected.get(file.input_path) });
              }
              await Promise.all(paths.map((path) => rm(path)));
              return runtime.importBatchWithReport(batch);
            },
            importBatchWithPreparation(batch, prepareFile, hooks) {
              return runtime.importBatchWithPreparation(batch, prepareFile, hooks);
            },
          };
        },
      };
      const controller = new AbortController();
      const report = await runCoachSync(
        {
          env: {},
          sources: [
            {
              source,
              fileHydration: {
                watermark: { source: "file-import", lane: "file-discovery", value: null },
                budget: {
                  signal: controller.signal,
                  clock: { monotonicNow: () => performance.now() },
                  deadlineMonotonicMs: performance.now() + 15_000,
                  perRequestTimeoutMs: 1_000,
                  maxRequests: 1,
                  maxArtifacts: 10,
                },
              },
            },
          ],
        },
        dependencies,
      );
      expect(report.sources[0]).toMatchObject({ status: "completed", message: null });
      expect(writerCalls).toBe(1);
      expect(runtimeCalls).toBe(1);
      expect(importerCalls).toBe(1);
      expect(readCalls).toBe(readsAtImport);
      expect(validated.sort()).toEqual(["fit", "gpx", "tcx"]);
      await store.close();
    }
  }, 30_000);

  it("file hydration failure is path-free and leaves canonical ingest state unchanged", async () => {
    const root = await freshHome("coach-hydration-failure-");
    const home = resolveAthleteHome({ ENDURAGENT_HOME: root });
    const privatePath = join(root, "synthetic-private.fit");
    await copyFile(
      resolve("packages/kernel-node/tests/fixtures/ingest/brick-cycling.fit"),
      privatePath,
    );
    await ensurePrivateDirectory(home.storeDir);
    const store = openSqliteStorage(join(home.storeDir, "store.db"));
    const { runMigrations } = await import("@enduragent/kernel/store");
    await runMigrations(store, MIGRATIONS);
    const baseFs = nodeFileSystem();
    const crypto = {
      async sha256(data: Uint8Array) {
        return new Uint8Array(createHash("sha256").update(data).digest());
      },
      async randomBytes() {
        throw new Error("unused");
      },
      async pbkdf2() {
        throw new Error("unused");
      },
      async aesGcmEncrypt() {
        throw new Error("unused");
      },
      async aesGcmDecrypt() {
        throw new Error("unused");
      },
    } as Parameters<typeof createArchiveManager>[0]["crypto"];
    const archive = createArchiveManager({ archiveRoot: home.archiveDir, crypto, fs: baseFs });
    let validationCalls = 0;
    const validate = createNodeFileStructuralValidator();
    const source = createFileImportSource(
      { manualPaths: [privatePath], watchRoots: [] },
      {
        fs: baseFs,
        clock: {
          setTimeout(callback, delayMs) {
            return globalThis.setTimeout(callback, delayMs);
          },
          clearTimeout(handle) {
            globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
          },
        },
        crypto,
        archive,
        async validate(input) {
          await validate(input);
          validationCalls += 1;
        },
      },
    );
    const counts = async () =>
      Object.fromEntries(
        await Promise.all(
          DUMP_TABLES.map(async ({ table }) => [
            table,
            Number((await store.get(`SELECT count(*) c FROM ${table}`))?.c),
          ]),
        ),
      );
    const beforeDump = await dumpStore(store);
    const beforeCounts = await counts();
    const report = await runCoachSync(
      {
        env: {},
        sources: [
          {
            source,
            fileHydration: {
              watermark: { source: "file-import", lane: "file-discovery", value: null },
              budget: {
                signal: new AbortController().signal,
                clock: { monotonicNow: () => performance.now() },
                deadlineMonotonicMs: performance.now() + 10_000,
                perRequestTimeoutMs: 1_000,
                maxRequests: 1,
                maxArtifacts: 1,
              },
            },
          },
        ],
      },
      {
        async withWriter(_env, operation) {
          return operation({ home, store, listener: inertWriterProtocolListener });
        },
        async importFiles() {
          throw new Error("unexpected manual import");
        },
        fileSystem: baseFs,
        ensurePrivateDirectory,
        removeFileIfPresent,
        nowEpochMs: () => 1_000,
        createImportRuntime() {
          return {
            async importBatchWithReport() {
              await rm(privatePath);
              throw new Error(`${privatePath}?token=synthetic-private`);
            },
          } as unknown as ReturnType<typeof createNodeImportRuntime>;
        },
      },
    );
    expect(validationCalls).toBe(1);
    expect(report.sources).toEqual([
      {
        source_id: "file-import",
        status: "failed",
        severity: "block",
        message: "source synchronization failed",
      },
    ]);
    expect(await dumpStore(store)).toBe(beforeDump);
    expect(await counts()).toEqual(beforeCounts);
    expect(await store.all("SELECT source,severity,detail FROM sync_failure")).toEqual([
      {
        source: "file-import",
        severity: "block",
        detail: "source synchronization failed",
      },
    ]);
    const publicValues = `${JSON.stringify(report)}${await readFile(join(home.root, "data", "error_state.json"), "utf8")}`;
    expect(publicValues).not.toContain(root);
    expect(publicValues).not.toContain("token=");
    expect(publicValues).not.toContain("cause");
    await store.close();
  }, 15_000);
});
