import { describe, it, expect, beforeEach } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as toYaml } from "yaml";
import { setupConfigEnvSandbox } from "./helpers/config-env-sandbox.js";

const getTempHome = setupConfigEnvSandbox("cc-sessiondefaults-");

const CONFIG = () => join(getTempHome(), ".cycling-coach", "config.yaml");

beforeEach(() => {
  delete process.env.SESSION_DAILY_RESET_HOUR;
  delete process.env.SESSION_IDLE_MINUTES;
  delete process.env.HISTORY_TOKEN_BUDGET_RATIO;
  delete process.env.COACH_TZ;
});

describe("config — session defaults", () => {
  it("resolves all four session defaults with an empty config", async () => {
    const { loadConfig } = await import("../src/config.js");
    const cfg = loadConfig();
    expect(cfg.dataSource).toBe("platform");
    expect(cfg.session.dailyResetHour).toBe(4);
    expect(cfg.session.idleMinutes).toBe(0);
    expect(cfg.session.historyTokenBudgetRatio).toBe(0.3);
    expect(cfg.session.resetArchiveRetentionDays).toBe(0);
    expect(cfg.session.timezone).toBe("");
  });

  it("resolves contextWindowTokens from the default anthropic model", async () => {
    const { loadConfig } = await import("../src/config.js");
    expect(loadConfig().llm.model).toBe("claude-sonnet-5-5");
    expect(loadConfig().contextWindowTokens).toBe(1_000_000);
  });

  it("loads Desktop's explicitly seeded blank athlete ID", async () => {
    writeFileSync(CONFIG(), toYaml({ intervals: { athlete_id: "" } }), { mode: 0o600 });
    const { loadConfig } = await import("../src/config.js");

    expect(loadConfig().intervals.athleteId).toBe("");
  });

  it("applies YAML overrides for the four session fields", async () => {
    writeFileSync(
      CONFIG(),
      toYaml({
        session: {
          dailyResetHour: 6,
          idleMinutes: 45,
          historyTokenBudgetRatio: 0.5,
          resetArchiveRetentionDays: 30,
        },
      }),
      { mode: 0o600 },
    );
    const { loadConfig } = await import("../src/config.js");
    const s = loadConfig().session;
    expect(s.dailyResetHour).toBe(6);
    expect(s.idleMinutes).toBe(45);
    expect(s.historyTokenBudgetRatio).toBe(0.5);
    expect(s.resetArchiveRetentionDays).toBe(30);
  });

  it("leaves unspecified session fields at their defaults under a partial YAML", async () => {
    writeFileSync(CONFIG(), toYaml({ session: { dailyResetHour: 9 } }), { mode: 0o600 });
    const { loadConfig } = await import("../src/config.js");
    const s = loadConfig().session;
    expect(s.dailyResetHour).toBe(9);
    expect(s.idleMinutes).toBe(0);
    expect(s.historyTokenBudgetRatio).toBe(0.3);
  });

  it("round-trips the timezone YAML key", async () => {
    writeFileSync(CONFIG(), toYaml({ session: { timezone: "Europe/Berlin" } }), {
      mode: 0o600,
    });
    const { loadConfig } = await import("../src/config.js");
    expect(loadConfig().session.timezone).toBe("Europe/Berlin");
  });

  it("reports environment ownership with the same effective parsing used by loading", async () => {
    const { sessionConfigEnvironmentOwnership } = await import("../src/config.js");

    expect(sessionConfigEnvironmentOwnership({})).toEqual({
      historyTokenBudgetRatio: false,
      idleMinutes: false,
      dailyResetHour: false,
      resetArchiveRetentionDays: false,
      timezone: false,
    });
    expect(
      sessionConfigEnvironmentOwnership({
        HISTORY_TOKEN_BUDGET_RATIO: "0.4 trailing",
        SESSION_IDLE_MINUTES: "15 minutes",
        SESSION_DAILY_RESET_HOUR: "invalid",
        SESSION_RESET_ARCHIVE_RETENTION_DAYS: "",
        COACH_TZ: "",
      }),
    ).toEqual({
      historyTokenBudgetRatio: true,
      idleMinutes: true,
      dailyResetHour: false,
      resetArchiveRetentionDays: false,
      timezone: true,
    });
  });

  it("uses only effectively parsed environment values ahead of YAML", async () => {
    writeFileSync(
      CONFIG(),
      toYaml({
        session: {
          historyTokenBudgetRatio: 0.2,
          idleMinutes: 5,
          dailyResetHour: 7,
          resetArchiveRetentionDays: 30,
          timezone: "UTC",
        },
      }),
      { mode: 0o600 },
    );
    process.env.HISTORY_TOKEN_BUDGET_RATIO = "0.4 trailing";
    process.env.SESSION_IDLE_MINUTES = "15 minutes";
    process.env.SESSION_DAILY_RESET_HOUR = "invalid";
    process.env.SESSION_RESET_ARCHIVE_RETENTION_DAYS = "";
    process.env.COACH_TZ = "Europe/Berlin";
    const { loadConfig } = await import("../src/config.js");

    expect(loadConfig().session).toEqual({
      historyTokenBudgetRatio: 0.4,
      idleMinutes: 15,
      dailyResetHour: 7,
      resetArchiveRetentionDays: 30,
      timezone: "Europe/Berlin",
    });
  });

  it("rejects invalid session values from startup YAML", async () => {
    const { loadConfig } = await import("../src/config.js");
    for (const session of [
      { historyTokenBudgetRatio: 0 },
      { idleMinutes: -1 },
      { dailyResetHour: 24 },
      { resetArchiveRetentionDays: -1 },
      { timezone: "Not/A-Timezone" },
    ]) {
      writeFileSync(CONFIG(), toYaml({ session }), { mode: 0o600 });
      expect(() => loadConfig()).toThrow();
    }
  });
});
