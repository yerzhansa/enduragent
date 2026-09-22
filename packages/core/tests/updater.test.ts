import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  __resetVersionCheckStateForTesting,
  buildCheckUrl,
  buildSelfUpdateCommand,
  buildVersionPingUrl,
  checkForUpdate,
  checkForUpdateWithDailyTelemetry,
  getCurrentVersion,
  getInstanceId,
  readBinaryPackageJson,
  isManagedDeploy,
  isStableCalVer,
  isUpdateAvailable,
} from "../src/updater.js";

// Regression: the original `data.version !== current` returned true for ANY
// inequality, including the case where the running bot is ahead of npm — a
// Railway deploy from `main` hits this every restart while the publish
// pipeline lags behind. Users got "Update available: 2026.5.3 → 2026.5.1"
// which is a downgrade dressed as an upgrade.
describe("isUpdateAvailable", () => {
  it("returns true when latest > current (real upgrade)", () => {
    expect(isUpdateAvailable("2026.5.3", "2026.5.1")).toBe(true);
  });

  it("returns false when latest < current (the Railway-ahead-of-npm case)", () => {
    expect(isUpdateAvailable("2026.5.1", "2026.5.3")).toBe(false);
  });

  it("returns false when latest === current", () => {
    expect(isUpdateAvailable("2026.5.3", "2026.5.3")).toBe(false);
  });

  it('returns false when current is "unknown" (no throw)', () => {
    expect(isUpdateAvailable("2026.5.3", "unknown")).toBe(false);
  });

  it("returns false when latest is malformed (no throw)", () => {
    expect(isUpdateAvailable("not-a-version", "2026.5.3")).toBe(false);
  });

  it("respects semver patch ordering (10 > 9, not lex)", () => {
    expect(isUpdateAvailable("2026.5.10", "2026.5.9")).toBe(true);
    expect(isUpdateAvailable("2026.5.9", "2026.5.10")).toBe(false);
  });

  it("orders stable successors within the same month", () => {
    expect(isUpdateAvailable("2026.7.3", "2026.7.2")).toBe(true);
    expect(isUpdateAvailable("2026.7.2", "2026.7.3")).toBe(false);
  });

  it("orders installed historical suffix releases for compatibility", () => {
    expect(isUpdateAvailable("2026.5.3-1", "2026.5.3-0")).toBe(true);
    expect(isUpdateAvailable("2026.5.3-1", "2026.5.3")).toBe(true);
    expect(isUpdateAvailable("2026.5.3-2", "2026.5.3-1")).toBe(true);
    expect(isUpdateAvailable("2026.5.3", "2026.5.3-1")).toBe(false);
  });

  it("recognizes the stable successor to an installed historical suffix release", () => {
    expect(isUpdateAvailable("2026.6.26", "2026.6.25-1")).toBe(true);
    expect(isUpdateAvailable("2026.6.25-1", "2026.6.26")).toBe(false);
  });

  it.each([
    ["2026.0.1", "2026.1.1"],
    ["2026.13.1", "2026.12.1"],
    ["2026.7.9007199254740992", "2026.7.1"],
    ["999.7.1", "2026.7.1"],
    ["10000.7.1", "2026.7.1"],
    ["0000.7.1", "2026.7.1"],
  ])("rejects invalid or unsafe latest/current CalVer %s / %s", (latest, current) => {
    expect(isUpdateAvailable(latest, current)).toBe(false);
    expect(isUpdateAvailable(current, latest)).toBe(false);
  });
});

describe("isStableCalVer", () => {
  it.each(["2026.1.0", "2026.12.9007199254740991"])("accepts stable CalVer %s", (version) => {
    expect(isStableCalVer(version)).toBe(true);
  });

  it.each([
    "2026.0.1",
    "2026.13.1",
    "2026.7.9007199254740992",
    "999.7.1",
    "10000.7.1",
    "0000.7.1",
    "2026.07.1",
    "2026.7.01",
    "2026.7.1-1",
    `2026.7.${"1".repeat(33)}`,
  ])("rejects non-stable CalVer %s", (version) => {
    expect(isStableCalVer(version)).toBe(false);
  });
});

describe("buildSelfUpdateCommand", () => {
  it("pins the exact version, disables lifecycle scripts, and pins the registry", () => {
    const cmd = buildSelfUpdateCommand("cycling-coach", "2026.5.3");
    expect(cmd).toContain("cycling-coach@2026.5.3");
    expect(cmd).toContain("--ignore-scripts");
    expect(cmd).toContain("--registry=https://registry.npmjs.org");
    expect(cmd).not.toContain("@latest");
  });

  it("falls back to the latest dist-tag when no version is given", () => {
    const cmd = buildSelfUpdateCommand("cycling-coach");
    expect(cmd).toContain("cycling-coach@latest");
    expect(cmd).toContain("--ignore-scripts");
    expect(cmd).toContain("--registry=https://registry.npmjs.org");
  });

  it("accepts an installed historical CalVer suffix", () => {
    expect(buildSelfUpdateCommand("cycling-coach", "2026.5.3-1")).toContain(
      "cycling-coach@2026.5.3-1",
    );
  });

  it("falls back to latest when the version contains shell metacharacters", () => {
    const cmd = buildSelfUpdateCommand("cycling-coach", "1.0.0; touch /tmp/pwned");
    expect(cmd).toContain("cycling-coach@latest");
    expect(cmd).not.toContain(";");
  });
});

describe("isManagedDeploy", () => {
  it("treats 1 and true as managed deploy signals", () => {
    expect(isManagedDeploy("cycling-coach", { CYCLING_COACH_MANAGED_DEPLOY: "1" })).toBe(true);
    expect(isManagedDeploy("cycling-coach", { CYCLING_COACH_MANAGED_DEPLOY: "true" })).toBe(true);
    expect(isManagedDeploy("cycling-coach", { CYCLING_COACH_MANAGED_DEPLOY: " TRUE " })).toBe(true);
  });

  it("treats absent or non-true values as unmanaged installs", () => {
    expect(isManagedDeploy("cycling-coach", {})).toBe(false);
    expect(isManagedDeploy("cycling-coach", { CYCLING_COACH_MANAGED_DEPLOY: "0" })).toBe(false);
    expect(isManagedDeploy("cycling-coach", { CYCLING_COACH_MANAGED_DEPLOY: "false" })).toBe(false);
  });

  it("reads the per-binary env name, not a hardcoded prefix", () => {
    expect(isManagedDeploy("running-coach", { RUNNING_COACH_MANAGED_DEPLOY: "1" })).toBe(true);
    // A different binary's prefix must not leak across — the leakage is fixed, not aliased.
    expect(isManagedDeploy("running-coach", { CYCLING_COACH_MANAGED_DEPLOY: "1" })).toBe(false);
  });
});

describe("buildVersionPingUrl", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "cc-updater-url-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("builds the ping URL with exactly bin, version, channel, instance when a dataDir is given (production)", () => {
    vi.stubEnv("NODE_ENV", "production");
    const url = new URL(buildVersionPingUrl("cycling-coach", dataDir));
    expect(`${url.origin}${url.pathname}`).toBe("https://ping.enduragent.icu/v1/check");
    expect([...url.searchParams.keys()].sort()).toEqual(["bin", "channel", "instance", "version"]);
    expect(url.searchParams.get("bin")).toBe("cycling-coach");
    expect(url.searchParams.get("version")).toBe(getCurrentVersion("cycling-coach"));
    expect(url.searchParams.get("channel")).toBe("npm");
    expect(url.searchParams.get("instance")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("omits the instance param when no dataDir is given (production)", () => {
    vi.stubEnv("NODE_ENV", "production");
    const url = new URL(buildVersionPingUrl("cycling-coach"));
    expect(url.searchParams.has("instance")).toBe(false);
    expect([...url.searchParams.keys()].sort()).toEqual(["bin", "channel", "version"]);
  });

  it("channel is docker under CYCLING_COACH_MANAGED_DEPLOY=1 (production)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CYCLING_COACH_MANAGED_DEPLOY", "1");
    expect(new URL(buildVersionPingUrl("cycling-coach")).searchParams.get("channel")).toBe(
      "docker",
    );
  });

  it.each(["development", "test"])(
    "keeps the buildCheckUrl compatibility API npm-only in %s",
    (nodeEnv) => {
      vi.stubEnv("NODE_ENV", nodeEnv);
      expect(buildCheckUrl("cycling-coach", dataDir)).toBe(
        "https://registry.npmjs.org/cycling-coach/latest",
      );
    },
  );
});

describe("getInstanceId", () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "cc-instance-id-"));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("returns the same UUID across calls, creating the dir if missing", () => {
    const dir = join(base, "not-yet-created");
    expect(existsSync(dir)).toBe(false);
    const first = getInstanceId(dir);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(existsSync(join(dir, "instance-id"))).toBe(true);
    expect(getInstanceId(dir)).toBe(first);
  });

  it("returns a fresh valid UUID without throwing when the dir is unwritable", () => {
    const filePath = join(base, "a-file");
    writeFileSync(filePath, "x");
    // A path whose parent is a regular file cannot be created → mkdirSync throws.
    const unwritable = join(filePath, "nested");
    let id = "";
    expect(() => {
      id = getInstanceId(unwritable);
    }).not.toThrow();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("checkForUpdate", () => {
  afterEach(() => {
    __resetVersionCheckStateForTesting();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  // The CYCLING_COACH_NO_UPDATE_CHECK opt-out gates only the automatic
  // startup notification (run-binary call site); operator-initiated
  // /update and /whatsnew must always be able to query the registry.
  it("queries the registry even when CYCLING_COACH_NO_UPDATE_CHECK is set", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: "2026.5.3" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("CYCLING_COACH_NO_UPDATE_CHECK", "1");
    try {
      const info = await checkForUpdate("cycling-coach");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(info?.latest).toBe("2026.5.3");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("queries npm without telemetry in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: string) => {
      urls.push(input);
      return { ok: true, json: async () => ({ version: "2026.5.10" }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const info = await checkForUpdate("cycling-coach");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(urls).toEqual(["https://registry.npmjs.org/cycling-coach/latest"]);
    expect(info?.latest).toBe("2026.5.10");
  });

  it("keeps the optional dataDir argument npm-only for compatibility", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        urls.push(input);
        return { ok: true, json: async () => ({ version: "2026.5.10" }) };
      }),
    );

    await checkForUpdate("cycling-coach", "/unused/compatibility/path");
    expect(urls).toEqual(["https://registry.npmjs.org/cycling-coach/latest"]);
  });

  it("shares one in-progress npm request", async () => {
    let resolveFetch:
      | ((value: { ok: boolean; json: () => Promise<{ version: string }> }) => void)
      | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<{ ok: boolean; json: () => Promise<{ version: string }> }>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = checkForUpdate("cycling-coach");
    const second = checkForUpdate("cycling-coach");
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFetch?.({
      ok: true,
      json: async () => ({ version: "2026.5.10" }),
    });
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ latest: "2026.5.10" }),
      expect.objectContaining({ latest: "2026.5.10" }),
    ]);
  });

  it("reuses successful results for five minutes and refreshes at expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("1998-08-29T04:00:00.000Z"));
    const versions = ["2026.5.10", "2026.5.11"];
    const fetchMock = vi.fn(async () => {
      const version = versions.shift();
      return { ok: true, json: async () => ({ version }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(checkForUpdate("cycling-coach")).resolves.toMatchObject({
      latest: "2026.5.10",
    });
    vi.advanceTimersByTime(5 * 60 * 1000 - 1);
    await expect(checkForUpdate("cycling-coach")).resolves.toMatchObject({
      latest: "2026.5.10",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    await expect(checkForUpdate("cycling-coach")).resolves.toMatchObject({
      latest: "2026.5.11",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes after a wall-clock rollback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("1998-08-29T04:00:00.000Z"));
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: "2026.5.10" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await checkForUpdate("cycling-coach");
    vi.setSystemTime(new Date("1998-08-29T03:00:00.000Z"));
    await checkForUpdate("cycling-coach");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache failed checks", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("offline");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(checkForUpdate("cycling-coach")).resolves.toBeNull();
    await expect(checkForUpdate("cycling-coach")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("checkForUpdateWithDailyTelemetry", () => {
  let base: string;
  let dataDir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "cc-version-ping-"));
    dataDir = join(base, "data");
    vi.stubEnv("NODE_ENV", "production");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("1998-08-29T04:00:00.000Z"));
  });

  afterEach(() => {
    __resetVersionCheckStateForTesting();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    rmSync(base, { recursive: true, force: true });
  });

  it("persists lastPingAt before contacting the telemetry endpoint", async () => {
    const statePath = join(dataDir, "last-version-ping-at");
    const fetchMock = vi.fn(async (input: string) => {
      expect(input).toContain("ping.enduragent.icu");
      expect(readFileSync(statePath, "utf-8")).toBe("1998-08-29T04:00:00.000Z\n");
      return { ok: true, json: async () => ({ version: "2026.5.10" }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(checkForUpdateWithDailyTelemetry("cycling-coach", dataDir)).resolves.toMatchObject(
      { latest: "2026.5.10" },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(existsSync(join(dataDir, "instance-id"))).toBe(true);
  });

  it("suppresses telemetry across restarts until the exact 24-hour boundary", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: string) => {
      urls.push(input);
      return { ok: true, json: async () => ({ version: "2026.5.10" }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    await checkForUpdateWithDailyTelemetry("cycling-coach", dataDir);
    __resetVersionCheckStateForTesting();
    vi.setSystemTime(new Date("1998-08-30T03:59:59.999Z"));
    await checkForUpdateWithDailyTelemetry("cycling-coach", dataDir);
    __resetVersionCheckStateForTesting();
    vi.setSystemTime(new Date("1998-08-30T04:00:00.000Z"));
    await checkForUpdateWithDailyTelemetry("cycling-coach", dataDir);

    expect(urls.map((url) => new URL(url).hostname)).toEqual([
      "ping.enduragent.icu",
      "registry.npmjs.org",
      "ping.enduragent.icu",
    ]);
  });

  it("keeps a failed ping suppressed and falls back to npm", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: string) => {
      urls.push(input);
      if (input.includes("ping.enduragent.icu")) throw new Error("endpoint down");
      return { ok: true, json: async () => ({ version: "2026.5.10" }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(checkForUpdateWithDailyTelemetry("cycling-coach", dataDir)).resolves.toMatchObject(
      { latest: "2026.5.10" },
    );
    __resetVersionCheckStateForTesting();
    vi.advanceTimersByTime(60 * 60 * 1000);
    await checkForUpdateWithDailyTelemetry("cycling-coach", dataDir);

    expect(urls.filter((url) => url.includes("ping.enduragent.icu"))).toHaveLength(1);
    expect(urls.filter((url) => url.includes("registry.npmjs.org"))).toHaveLength(2);
  });

  it("keeps a rate-limited ping suppressed and falls back to npm", async () => {
    const statePath = join(dataDir, "last-version-ping-at");
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: string) => {
      urls.push(input);
      if (input.includes("ping.enduragent.icu")) return { ok: false };
      return { ok: true, json: async () => ({ version: "2026.5.10" }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(checkForUpdateWithDailyTelemetry("cycling-coach", dataDir)).resolves.toMatchObject(
      { latest: "2026.5.10" },
    );
    expect(readFileSync(statePath, "utf-8")).toBe("1998-08-29T04:00:00.000Z\n");

    __resetVersionCheckStateForTesting();
    vi.advanceTimersByTime(60 * 60 * 1000);
    await expect(checkForUpdateWithDailyTelemetry("cycling-coach", dataDir)).resolves.toMatchObject(
      { latest: "2026.5.10" },
    );

    expect(urls.map((url) => new URL(url).hostname)).toEqual([
      "ping.enduragent.icu",
      "registry.npmjs.org",
      "registry.npmjs.org",
    ]);
    expect(readFileSync(statePath, "utf-8")).toBe("1998-08-29T04:00:00.000Z\n");
  });

  it("fails closed to npm when lastPingAt cannot be persisted", async () => {
    const blocker = join(base, "blocker");
    writeFileSync(blocker, "x");
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: string) => {
      urls.push(input);
      return { ok: true, json: async () => ({ version: "2026.5.10" }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      checkForUpdateWithDailyTelemetry("cycling-coach", join(blocker, "data")),
    ).resolves.toMatchObject({ latest: "2026.5.10" });
    expect(urls).toEqual(["https://registry.npmjs.org/cycling-coach/latest"]);
  });

  it("replaces malformed state before pinging", async () => {
    mkdirSync(dataDir, { recursive: true });
    const statePath = join(dataDir, "last-version-ping-at");
    writeFileSync(statePath, "not-json");
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: string) => {
      urls.push(input);
      expect(readFileSync(statePath, "utf-8")).toBe("1998-08-29T04:00:00.000Z\n");
      return { ok: true, json: async () => ({ version: "2026.5.10" }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    await checkForUpdateWithDailyTelemetry("cycling-coach", dataDir);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(urls[0] ?? "").hostname).toBe("ping.enduragent.icu");
  });

  it("treats a future lastPingAt as not due", async () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "last-version-ping-at"), "1998-08-30T04:00:00.000Z\n");
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: string) => {
      urls.push(input);
      return { ok: true, json: async () => ({ version: "2026.5.10" }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    await checkForUpdateWithDailyTelemetry("cycling-coach", dataDir);
    expect(urls).toEqual(["https://registry.npmjs.org/cycling-coach/latest"]);
  });

  it("shares one telemetry request between concurrent daily checks", async () => {
    let resolveFetch:
      | ((value: { ok: boolean; json: () => Promise<{ version: string }> }) => void)
      | undefined;
    const fetchMock = vi.fn(
      (_input: string) =>
        new Promise<{ ok: boolean; json: () => Promise<{ version: string }> }>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = checkForUpdateWithDailyTelemetry("cycling-coach", dataDir);
    const second = checkForUpdateWithDailyTelemetry("cycling-coach", dataDir);
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("ping.enduragent.icu");
    resolveFetch?.({
      ok: true,
      json: async () => ({ version: "2026.5.10" }),
    });
    const expected = {
      current: getCurrentVersion("cycling-coach"),
      latest: "2026.5.10",
      updateAvailable: isUpdateAvailable("2026.5.10", getCurrentVersion("cycling-coach")),
    };
    await expect(Promise.all([first, second])).resolves.toEqual([expected, expected]);
  });

  it("queues due telemetry behind an active npm check", async () => {
    let resolveNpm:
      | ((value: { ok: boolean; json: () => Promise<{ version: string }> }) => void)
      | undefined;
    const urls: string[] = [];
    const fetchMock = vi.fn((input: string) => {
      urls.push(input);
      if (input.includes("registry.npmjs.org")) {
        return new Promise<{ ok: boolean; json: () => Promise<{ version: string }> }>((resolve) => {
          resolveNpm = resolve;
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ version: "2026.5.11" }),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const manual = checkForUpdate("cycling-coach");
    await Promise.resolve();
    const daily = checkForUpdateWithDailyTelemetry("cycling-coach", dataDir);
    const joined = checkForUpdate("cycling-coach");
    await Promise.resolve();
    expect(urls).toEqual(["https://registry.npmjs.org/cycling-coach/latest"]);

    resolveNpm?.({
      ok: true,
      json: async () => ({ version: "2026.5.10" }),
    });
    await expect(manual).resolves.toMatchObject({ latest: "2026.5.10" });
    await expect(Promise.all([daily, joined])).resolves.toEqual([
      expect.objectContaining({ latest: "2026.5.11" }),
      expect.objectContaining({ latest: "2026.5.11" }),
    ]);
    expect(urls.map((url) => new URL(url).hostname)).toEqual([
      "registry.npmjs.org",
      "ping.enduragent.icu",
    ]);
  });

  it.each(["development", "test"])("skips telemetry and persistence in %s", async (nodeEnv) => {
    vi.stubEnv("NODE_ENV", nodeEnv);
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: string) => {
      urls.push(input);
      return { ok: true, json: async () => ({ version: "2026.5.10" }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    await checkForUpdateWithDailyTelemetry("cycling-coach", dataDir);
    expect(urls).toEqual(["https://registry.npmjs.org/cycling-coach/latest"]);
    expect(existsSync(join(dataDir, "last-version-ping-at"))).toBe(false);
  });
});

describe("readBinaryPackageJson", () => {
  it("reads the package beside the running bundle ahead of a parent install", () => {
    const root = mkdtempSync(join(tmpdir(), "enduragent-version-lookup-"));
    try {
      const staleDir = join(root, "node_modules", "fixture-coach");
      const bundleDir = join(root, "app", "dist");
      mkdirSync(staleDir, { recursive: true });
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(
        join(staleDir, "package.json"),
        JSON.stringify({ name: "fixture-coach", version: "1998.1.1" }),
      );
      writeFileSync(
        join(root, "app", "package.json"),
        JSON.stringify({ name: "fixture-coach", version: "1998.1.2" }),
      );
      const bundle = join(bundleDir, "index.js");
      writeFileSync(bundle, "");
      expect(readBinaryPackageJson("fixture-coach", pathToFileURL(bundle).href)?.version).toBe(
        "1998.1.2",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a parent install when the neighboring package has a different name", () => {
    const root = mkdtempSync(join(tmpdir(), "enduragent-version-lookup-"));
    try {
      const staleDir = join(root, "node_modules", "fixture-coach");
      const bundleDir = join(root, "app", "dist");
      mkdirSync(staleDir, { recursive: true });
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(
        join(staleDir, "package.json"),
        JSON.stringify({ name: "fixture-coach", version: "1998.1.1" }),
      );
      writeFileSync(
        join(root, "app", "package.json"),
        JSON.stringify({ name: "other-coach", version: "1998.1.2" }),
      );
      const bundle = join(bundleDir, "index.js");
      writeFileSync(bundle, "");
      expect(readBinaryPackageJson("fixture-coach", pathToFileURL(bundle).href)?.version).toBe(
        "1998.1.1",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
