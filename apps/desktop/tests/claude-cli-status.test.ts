import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeCliConfigError,
  ClaudeWorkingAreaError,
  type ClaudeAccountProbeResult,
  type ClaudeCliReadiness,
  type ClaudeWorkingAreaPort,
} from "@enduragent/core";
import {
  CLAUDE_CLI_STATUS_DEADLINE_MS,
  createClaudeCliStatus,
  readClaudeCliSettings,
  type ClaudeCliSettings,
  type ClaudeCliStatusDependencies,
} from "../src/main/claude-cli-status.js";
import {
  DESKTOP_CLAUDE_CLI_RECHECK_CHANNEL,
  DESKTOP_CLAUDE_CLI_STATUS_CHANNEL,
} from "../src/main/onboarding-ipc.js";
import { BUNDLED_MODEL_CATALOG } from "../../../packages/core/src/model-catalog-seed.js";

const BINARY = "/opt/homebrew/bin/claude";
type EnsureReady = NonNullable<ClaudeCliStatusDependencies["ensureReady"]>;

function fixedWorkingArea(cwd: string): ClaudeWorkingAreaPort {
  return {
    cacheKey: cwd,
    async prepareForLaunch() {
      return { cwd, assertCurrent() {} };
    },
  };
}

function settings(overrides: Partial<ClaudeCliSettings> = {}): ClaudeCliSettings {
  return { enabled: true, billing: "subscription", ...overrides };
}

function subscriptionProbe(): ClaudeAccountProbeResult {
  return {
    verified: true,
    accountClass: "subscription",
    email: "athlete@synthetic.test",
    plan: "Max",
  };
}

function subscriptionReadiness(): ClaudeCliReadiness {
  return {
    binaryPath: BINARY,
    version: "2.9.0",
    identityLine: "Signed in as athlete@synthetic.test - Claude Max subscription",
    accountClass: "subscription",
    email: "athlete@synthetic.test",
    plan: "Max",
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function harness(input: {
  readonly settings?: ClaudeCliSettings;
  readonly probe?: ClaudeAccountProbeResult;
  readonly binary?: string | null;
  readonly version?: string;
  readonly environment?: Record<string, string | undefined>;
  readonly platform?: NodeJS.Platform;
  readonly preflightMcpConfigTransform?: () => void;
  readonly applyRuntimeConfig?: (request: unknown) => Promise<void>;
  readonly probeAccount?: NonNullable<ClaudeCliStatusDependencies["probeAccount"]>;
  readonly ensureReady?: EnsureReady;
}) {
  const resolveBinary = vi.fn(async () => (input.binary === undefined ? BINARY : input.binary));
  const probeVersion = vi.fn(async () => input.version ?? "2.9.0");
  const probeAccount = vi.fn(
    input.probeAccount ?? (async () => input.probe ?? subscriptionProbe()),
  );
  const preflightMcpConfigTransform = vi.fn(input.preflightMcpConfigTransform ?? (() => {}));
  const invalidateProbeCache = vi.fn();
  const applyRuntimeConfig = vi.fn(input.applyRuntimeConfig ?? (async () => {}));
  const ensureReady = input.ensureReady === undefined ? undefined : vi.fn(input.ensureReady);
  const dependencies: ClaudeCliStatusDependencies = {
    resolveBinary,
    probeVersion,
    probeAccount,
    preflightMcpConfigTransform,
    invalidateProbeCache,
    ...(ensureReady === undefined ? {} : { ensureReady }),
  };
  const readSettings = vi.fn(async () => input.settings ?? settings());
  const controller = createClaudeCliStatus({
    settings: readSettings,
    environment: () => input.environment ?? {},
    ...(input.platform === undefined ? {} : { platform: input.platform }),
    applyRuntimeConfig,
    workingArea: fixedWorkingArea("/private/tmp/enduragent-claude-status-test"),
    dependencies,
  });
  return {
    controller,
    resolveBinary,
    probeVersion,
    probeAccount,
    preflightMcpConfigTransform,
    invalidateProbeCache,
    applyRuntimeConfig,
    readSettings,
    ensureReady,
  };
}

describe("desktop claude-cli status controller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports a verified subscription identity as ready", async () => {
    const subject = harness({});

    await expect(subject.controller.status()).resolves.toEqual({
      state: "ready",
      email: "athlete@synthetic.test",
      plan: "Max",
      version: "2.9.0",
    });
  });

  it("reports probe-confirmed api-key billing as ready-api-key", async () => {
    const subject = harness({
      settings: settings({ billing: "api-key" }),
      probe: { verified: true, accountClass: "api-key-token" },
    });

    await expect(subject.controller.status()).resolves.toEqual({
      state: "ready-api-key",
      version: "2.9.0",
    });
  });

  it.each([
    [
      "an api-key identity in subscription mode",
      { verified: true, accountClass: "api-key-token" } as ClaudeAccountProbeResult,
      "subscription" as const,
      "api-key-token",
    ],
    [
      "an unrecognized auth source",
      {
        verified: false,
        accountClass: "unrecognized",
        rawAuthSource: "synthetic-source",
      } as ClaudeAccountProbeResult,
      "subscription" as const,
      "api-key-token",
    ],
    [
      "an unapproved api key",
      { verified: true, accountClass: "subscription", plan: "Max" } as ClaudeAccountProbeResult,
      "api-key" as const,
      "api-key-token",
    ],
    [
      "a signed-out CLI",
      {
        verified: false,
        accountClass: "not-signed-in",
        reason: "no-account",
      } as ClaudeAccountProbeResult,
      "subscription" as const,
      "not-logged-in",
    ],
    [
      "a probe timeout",
      {
        verified: false,
        accountClass: "unrecognized",
        reason: "timeout",
      } as ClaudeAccountProbeResult,
      "subscription" as const,
      "not-logged-in",
    ],
  ])("refuses %s", async (_case, probe, billing, state) => {
    const subject = harness({ probe, settings: settings({ billing }) });

    await expect(subject.controller.status()).resolves.toEqual({ state });
  });

  it("reports a missing binary as absent-binary", async () => {
    const subject = harness({ binary: null });

    await expect(subject.controller.status()).resolves.toEqual({ state: "absent-binary" });
    expect(subject.probeVersion).not.toHaveBeenCalled();
  });

  it("reports a below-floor CLI version as absent-binary", async () => {
    const subject = harness({ version: "1.0.0" });

    await expect(subject.controller.status()).resolves.toEqual({ state: "absent-binary" });
    expect(subject.probeAccount).not.toHaveBeenCalled();
  });

  it("reports a private working-area failure without exposing its path", async () => {
    const controller = createClaudeCliStatus({
      settings: () => settings(),
      environment: () => ({}),
      applyRuntimeConfig: async () => {},
      workingArea: {
        cacheKey: "private-test-key",
        async prepareForLaunch() {
          throw new ClaudeWorkingAreaError("permission-check", "permissions");
        },
      },
      dependencies: {
        resolveBinary: async () => BINARY,
      },
    });

    await expect(controller.status()).resolves.toEqual({ state: "working-area-unavailable" });
  });

  it("refuses before probing when the configured Claude directory overlaps the working area", async () => {
    const probeAccount = vi.fn(async () => subscriptionProbe());
    const workspace = "/private/tmp/synthetic-home/.cache/enduragent/claude/workspace";
    const controller = createClaudeCliStatus({
      settings: () => settings({ configDir: workspace }),
      environment: () => ({
        HOME: "/private/tmp/synthetic-home",
        XDG_CACHE_HOME: "/private/tmp/synthetic-home/.cache",
      }),
      platform: "linux",
      applyRuntimeConfig: async () => {},
      dependencies: {
        resolveBinary: async () => BINARY,
        probeAccount,
      },
    });

    await expect(controller.status()).resolves.toEqual({ state: "working-area-unavailable" });
    expect(probeAccount).not.toHaveBeenCalled();
  });

  it("runs Windows readiness against the desktop environment and resolved .cmd shim", async () => {
    const environment = {
      Path: "C:\\Windows\\System32",
      userprofile: "C:\\Users\\Rider",
      appdata: "C:\\Users\\Rider\\AppData\\Roaming",
      SystemRoot: "C:\\Windows",
    };
    const shim = "C:\\Users\\Rider\\AppData\\Roaming\\npm\\claude.cmd";
    const subject = harness({
      platform: "win32",
      environment,
      binary: shim,
      version: "2.1.220",
    });

    await expect(subject.controller.status()).resolves.toMatchObject({
      state: "ready",
      version: "2.1.220",
    });
    expect(subject.resolveBinary).toHaveBeenCalledWith(
      expect.objectContaining({ env: environment, platform: "win32" }),
    );
    expect(subject.probeVersion).toHaveBeenCalledWith(
      shim,
      expect.objectContaining({ baseEnv: environment, platform: "win32" }),
    );
    expect(subject.probeAccount).toHaveBeenCalledWith(
      expect.objectContaining({ baseEnv: environment, platform: "win32" }),
      expect.any(Object),
    );
    expect(subject.preflightMcpConfigTransform).toHaveBeenCalledOnce();
  });

  it("does not report ready when the Windows .cmd MCP transform preflight fails", async () => {
    const subject = harness({
      platform: "win32",
      environment: {
        Path: "C:\\Windows\\System32",
        userprofile: "C:\\Users\\Rider",
        SystemRoot: "C:\\Windows",
      },
      binary: "C:\\Users\\Rider\\AppData\\Roaming\\npm\\claude.cmd",
      version: "2.1.220",
      preflightMcpConfigTransform: () => {
        throw new ClaudeCliConfigError("windows-mcp-config-write", "synthetic transform refusal");
      },
    });

    await expect(subject.controller.status()).resolves.toEqual({ state: "absent-binary" });
    expect(subject.preflightMcpConfigTransform).toHaveBeenCalledOnce();
    expect(subject.probeAccount).not.toHaveBeenCalled();
  });

  it.each([
    ["the environment kill switch", { ENDURAGENT_CLAUDE_CLI_DISABLED: "TRUE" }, settings()],
    ["the configuration flag", {}, settings({ enabled: false })],
  ])("reports %s as disabled without probing", async (_case, environment, current) => {
    const subject = harness({ environment, settings: current });

    await expect(subject.controller.status()).resolves.toEqual({ state: "disabled" });
    expect(subject.resolveBinary).not.toHaveBeenCalled();
    expect(subject.probeAccount).not.toHaveBeenCalled();
  });

  it("re-evaluates eligibility on every status poll", async () => {
    const environment: Record<string, string | undefined> = {};
    const controller = createClaudeCliStatus({
      settings: () => settings(),
      environment: () => environment,
      applyRuntimeConfig: async () => {},
      workingArea: fixedWorkingArea("/private/tmp/enduragent-claude-status-test"),
      dependencies: {
        resolveBinary: async () => BINARY,
        probeVersion: async () => "2.9.0",
        probeAccount: async () => subscriptionProbe(),
      },
    });

    await expect(controller.status()).resolves.toMatchObject({ state: "ready" });
    environment.ENDURAGENT_CLAUDE_CLI_DISABLED = "1";
    await expect(controller.status()).resolves.toEqual({ state: "disabled" });
    delete environment.ENDURAGENT_CLAUDE_CLI_DISABLED;
    await expect(controller.status()).resolves.toMatchObject({ state: "ready" });
  });

  it("busts the probe cache on recheck but not on a plain status read", async () => {
    const subject = harness({});

    await subject.controller.status();
    expect(subject.invalidateProbeCache).not.toHaveBeenCalled();

    await expect(subject.controller.recheck()).resolves.toMatchObject({ state: "ready" });
    expect(subject.invalidateProbeCache).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent status reads onto one account probe", async () => {
    let settle!: (result: ClaudeAccountProbeResult) => void;
    const probe = new Promise<ClaudeAccountProbeResult>((resolve) => {
      settle = resolve;
    });
    const subject = harness({ probeAccount: async () => probe });

    const first = subject.controller.status();
    const second = subject.controller.status();

    await vi.waitFor(() => expect(subject.probeAccount).toHaveBeenCalledOnce());
    expect(subject.resolveBinary).toHaveBeenCalledOnce();
    settle(subscriptionProbe());

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ state: "ready" }),
      expect.objectContaining({ state: "ready" }),
    ]);
  });

  it("rejects at the 72-second main deadline before the 75-second renderer deadline and starts a fresh status read", async () => {
    vi.useFakeTimers();
    const firstReadiness = deferred<ClaudeCliReadiness>();
    const ensureReady = vi
      .fn<EnsureReady>()
      .mockImplementationOnce(() => firstReadiness.promise)
      .mockResolvedValueOnce(subscriptionReadiness());
    const subject = harness({ ensureReady });

    const firstStatus = subject.controller.status();
    const firstRejection = expect(firstStatus).rejects.toMatchObject({ name: "TimeoutError" });
    expect(CLAUDE_CLI_STATUS_DEADLINE_MS).toBeLessThan(75_000);

    await vi.advanceTimersByTimeAsync(CLAUDE_CLI_STATUS_DEADLINE_MS);
    await firstRejection;
    await expect(subject.controller.status()).resolves.toMatchObject({ state: "ready" });
    expect(ensureReady).toHaveBeenCalledTimes(2);

    firstReadiness.resolve(subscriptionReadiness());
    await Promise.resolve();
    await Promise.resolve();
    expect(subject.invalidateProbeCache).toHaveBeenCalledOnce();
  });

  it("keeps an immediate status on the active 72-second generation when Retry is queued", async () => {
    vi.useFakeTimers();
    const firstReadiness = deferred<ClaudeCliReadiness>();
    const ensureReady = vi
      .fn<EnsureReady>()
      .mockImplementationOnce(() => firstReadiness.promise)
      .mockResolvedValueOnce(subscriptionReadiness());
    const subject = harness({ ensureReady });

    const activeStatus = subject.controller.status();
    const activeRejection = expect(activeStatus).rejects.toMatchObject({ name: "TimeoutError" });
    const recheck = subject.controller.recheck();
    const immediateStatus = subject.controller.status();
    const immediateRejection = expect(immediateStatus).rejects.toMatchObject({
      name: "TimeoutError",
    });

    expect(immediateStatus).toBe(activeStatus);
    await vi.advanceTimersByTimeAsync(CLAUDE_CLI_STATUS_DEADLINE_MS);
    await activeRejection;
    await immediateRejection;
    await expect(recheck).resolves.toMatchObject({ state: "ready" });
    expect(ensureReady).toHaveBeenCalledTimes(2);
    expect(subject.invalidateProbeCache).toHaveBeenCalledOnce();
  });

  it("keeps a forced recheck active when the timed-out raw generation rejects late", async () => {
    vi.useFakeTimers();
    const firstReadiness = deferred<ClaudeCliReadiness>();
    const secondReadiness = deferred<ClaudeCliReadiness>();
    const ensureReady = vi
      .fn<EnsureReady>()
      .mockImplementationOnce(() => firstReadiness.promise)
      .mockImplementationOnce((input) => {
        expect(input?.forceRecheck).toBe(true);
        return secondReadiness.promise;
      });
    const subject = harness({ ensureReady });

    const firstStatus = subject.controller.status();
    const firstRejection = expect(firstStatus).rejects.toMatchObject({ name: "TimeoutError" });
    const recheck = subject.controller.recheck();
    expect(subject.controller.recheck()).toBe(recheck);

    await vi.advanceTimersByTimeAsync(CLAUDE_CLI_STATUS_DEADLINE_MS);
    await firstRejection;
    expect(ensureReady).toHaveBeenCalledTimes(2);
    expect(subject.invalidateProbeCache).toHaveBeenCalledOnce();

    const joinedStatus = subject.controller.status();
    expect(joinedStatus).not.toBe(recheck);
    firstReadiness.reject(new Error("late synthetic rejection"));
    await Promise.resolve();
    await Promise.resolve();
    expect(subject.invalidateProbeCache).toHaveBeenCalledTimes(2);
    expect(subject.controller.status()).toBe(joinedStatus);
    expect(ensureReady).toHaveBeenCalledTimes(2);

    secondReadiness.resolve(subscriptionReadiness());
    await expect(Promise.all([recheck, joinedStatus])).resolves.toEqual([
      expect.objectContaining({ state: "ready" }),
      expect.objectContaining({ state: "ready" }),
    ]);
  });

  it("joins activation to an active status probe", async () => {
    let settle!: (result: ClaudeAccountProbeResult) => void;
    const probe = new Promise<ClaudeAccountProbeResult>((resolve) => {
      settle = resolve;
    });
    const subject = harness({ probeAccount: async () => probe });

    const status = subject.controller.status();
    const activation = subject.controller.activate(
      {
        catalogRevision: BUNDLED_MODEL_CATALOG.revision,
        provider: "claude-cli",
        model: "sonnet",
        endpoint: { mode: "automatic" },
      },
      BUNDLED_MODEL_CATALOG,
    );

    await vi.waitFor(() => expect(subject.probeAccount).toHaveBeenCalledOnce());
    settle(subscriptionProbe());

    await expect(status).resolves.toMatchObject({ state: "ready" });
    await expect(activation).resolves.toEqual({ status: "configured", runtimeReady: true });
    expect(subject.probeAccount).toHaveBeenCalledOnce();
    expect(subject.applyRuntimeConfig).toHaveBeenCalledOnce();
  });

  it("serializes and coalesces rechecks behind an active status read", async () => {
    let settleFirst!: (result: ClaudeAccountProbeResult) => void;
    let settleSecond!: (result: ClaudeAccountProbeResult) => void;
    const firstProbe = new Promise<ClaudeAccountProbeResult>((resolve) => {
      settleFirst = resolve;
    });
    const secondProbe = new Promise<ClaudeAccountProbeResult>((resolve) => {
      settleSecond = resolve;
    });
    const subject = harness({
      probeAccount: vi
        .fn()
        .mockImplementationOnce(async () => firstProbe)
        .mockImplementationOnce(async () => secondProbe),
    });

    const status = subject.controller.status();
    const firstRecheck = subject.controller.recheck();
    const secondRecheck = subject.controller.recheck();

    await vi.waitFor(() => expect(subject.probeAccount).toHaveBeenCalledOnce());
    expect(subject.invalidateProbeCache).not.toHaveBeenCalled();
    settleFirst(subscriptionProbe());
    await expect(status).resolves.toMatchObject({ state: "ready" });

    await vi.waitFor(() => expect(subject.probeAccount).toHaveBeenCalledTimes(2));
    expect(subject.invalidateProbeCache).toHaveBeenCalledOnce();
    settleSecond(subscriptionProbe());

    await expect(Promise.all([firstRecheck, secondRecheck])).resolves.toEqual([
      expect.objectContaining({ state: "ready" }),
      expect.objectContaining({ state: "ready" }),
    ]);
    expect(subject.probeAccount).toHaveBeenCalledTimes(2);
  });

  it("joins a queued recheck when status is requested during its handoff", async () => {
    let settleFirst!: (result: ClaudeAccountProbeResult) => void;
    let settleSecond!: (result: ClaudeAccountProbeResult) => void;
    const firstProbe = new Promise<ClaudeAccountProbeResult>((resolve) => {
      settleFirst = resolve;
    });
    const secondProbe = new Promise<ClaudeAccountProbeResult>((resolve) => {
      settleSecond = resolve;
    });
    const subject = harness({
      probeAccount: vi
        .fn()
        .mockImplementationOnce(async () => firstProbe)
        .mockImplementation(async () => secondProbe),
    });

    const firstStatus = subject.controller.status();
    const statusDuringHandoff = firstStatus.then(() => subject.controller.status());
    const recheck = subject.controller.recheck();

    await vi.waitFor(() => expect(subject.probeAccount).toHaveBeenCalledOnce());
    settleFirst(subscriptionProbe());
    await expect(firstStatus).resolves.toMatchObject({ state: "ready" });

    await vi.waitFor(() => expect(subject.probeAccount).toHaveBeenCalledTimes(2));
    settleSecond(subscriptionProbe());

    await expect(Promise.all([statusDuringHandoff, recheck])).resolves.toEqual([
      expect.objectContaining({ state: "ready" }),
      expect.objectContaining({ state: "ready" }),
    ]);
    expect(subject.invalidateProbeCache).toHaveBeenCalledOnce();
    expect(subject.probeAccount).toHaveBeenCalledTimes(2);
  });

  it("busts the probe cache when the settings credentials surface opens", () => {
    const subject = harness({});

    subject.controller.invalidateProbeCache();

    expect(subject.invalidateProbeCache).toHaveBeenCalledOnce();
  });

  it("activates a claude-cli selection once the lane is ready", async () => {
    const subject = harness({});

    await expect(
      subject.controller.activate(
        {
          catalogRevision: BUNDLED_MODEL_CATALOG.revision,
          provider: "claude-cli",
          model: "sonnet",
          endpoint: { mode: "automatic" },
        },
        BUNDLED_MODEL_CATALOG,
      ),
    ).resolves.toEqual({ status: "configured", runtimeReady: true });
    expect(subject.applyRuntimeConfig).toHaveBeenCalledWith({
      llm: {
        provider: "claude-cli",
        model: "sonnet",
        catalog_snapshot: BUNDLED_MODEL_CATALOG,
      },
    });
  });

  it("reuses the verified status when activation immediately follows selection", async () => {
    const subject = harness({});
    const selection = {
      catalogRevision: BUNDLED_MODEL_CATALOG.revision,
      provider: "claude-cli" as const,
      model: "sonnet",
      endpoint: { mode: "automatic" as const },
    };

    await expect(subject.controller.status()).resolves.toMatchObject({ state: "ready" });
    await expect(subject.controller.activate(selection, BUNDLED_MODEL_CATALOG)).resolves.toEqual({
      status: "configured",
      runtimeReady: true,
    });

    expect(subject.probeVersion).toHaveBeenCalledOnce();
    expect(subject.probeAccount).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "a foreign provider",
      {
        catalogRevision: BUNDLED_MODEL_CATALOG.revision,
        provider: "anthropic",
        model: "sonnet",
        endpoint: { mode: "automatic" },
      },
      "invalid-input",
    ],
    [
      "a custom endpoint",
      {
        catalogRevision: BUNDLED_MODEL_CATALOG.revision,
        provider: "claude-cli",
        model: "sonnet",
        endpoint: { mode: "custom", value: "http://127.0.0.1:1234" },
      },
      "invalid-input",
    ],
  ])("refuses activation for %s", async (_case, selection, reason) => {
    const subject = harness({});

    await expect(
      subject.controller.activate(selection as never, BUNDLED_MODEL_CATALOG),
    ).resolves.toEqual({
      status: "refused",
      reason,
    });
    expect(subject.applyRuntimeConfig).not.toHaveBeenCalled();
  });

  it("refuses activation while the lane is not signed in", async () => {
    const subject = harness({
      probe: { verified: false, accountClass: "not-signed-in", reason: "no-account" },
    });

    await expect(
      subject.controller.activate(
        {
          catalogRevision: BUNDLED_MODEL_CATALOG.revision,
          provider: "claude-cli",
          model: "sonnet",
          endpoint: { mode: "automatic" },
        },
        BUNDLED_MODEL_CATALOG,
      ),
    ).resolves.toEqual({ status: "refused", reason: "credential-required" });
    expect(subject.applyRuntimeConfig).not.toHaveBeenCalled();
  });

  it("refuses activation while the lane is disabled", async () => {
    const subject = harness({ settings: settings({ enabled: false }) });

    await expect(
      subject.controller.activate(
        {
          catalogRevision: BUNDLED_MODEL_CATALOG.revision,
          provider: "claude-cli",
          model: "sonnet",
          endpoint: { mode: "automatic" },
        },
        BUNDLED_MODEL_CATALOG,
      ),
    ).resolves.toEqual({ status: "refused", reason: "runtime-unavailable" });
  });

  it("refuses activation when the runtime rejects the selection", async () => {
    const subject = harness({
      applyRuntimeConfig: async () => {
        throw new TypeError();
      },
    });

    await expect(
      subject.controller.activate(
        {
          catalogRevision: BUNDLED_MODEL_CATALOG.revision,
          provider: "claude-cli",
          model: "sonnet",
          endpoint: { mode: "automatic" },
        },
        BUNDLED_MODEL_CATALOG,
      ),
    ).resolves.toEqual({ status: "refused", reason: "runtime-unavailable" });
  });
});

describe("desktop claude-cli settings reader", () => {
  it("reads the yaml block and applies the environment overrides", async () => {
    await expect(
      readClaudeCliSettings({
        configPath: "/synthetic/config.yaml",
        environment: { CLAUDE_CLI_PATH: "/synthetic/bin/claude" },
        readConfigFile: async () =>
          [
            "llm:",
            "  provider: claude-cli",
            "  claude_cli:",
            "    enabled: true",
            "    binary_path: /ignored/claude",
            "    config_dir: /synthetic/claude-config",
            "    billing: api-key",
          ].join("\n"),
      }),
    ).resolves.toEqual({
      enabled: true,
      binaryPath: "/synthetic/bin/claude",
      configDir: "/synthetic/claude-config",
      billing: "api-key",
    });
  });

  it("disables the lane when the environment kill switch is set", async () => {
    await expect(
      readClaudeCliSettings({
        configPath: "/synthetic/config.yaml",
        environment: { ENDURAGENT_CLAUDE_CLI_DISABLED: "1" },
        readConfigFile: async () => "llm:\n  claude_cli:\n    enabled: true\n",
      }),
    ).resolves.toEqual({ enabled: false, billing: "subscription" });
  });

  it("falls back to defaults when the configuration file is unreadable", async () => {
    await expect(
      readClaudeCliSettings({
        configPath: "/synthetic/missing.yaml",
        environment: {},
        readConfigFile: async () => {
          throw new Error("ENOENT");
        },
      }),
    ).resolves.toEqual({ enabled: true, billing: "subscription" });
  });
});

describe("desktop claude-cli channels", () => {
  it("pins the onboarding channel names", () => {
    expect(DESKTOP_CLAUDE_CLI_STATUS_CHANNEL).toBe("enduragent:onboarding:claude-cli-status");
    expect(DESKTOP_CLAUDE_CLI_RECHECK_CHANNEL).toBe("enduragent:onboarding:claude-cli-recheck");
  });
});
