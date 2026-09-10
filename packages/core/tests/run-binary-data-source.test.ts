import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCoachEngine } from "../src/agent/coach-engine.js";
import { baseAgentConfig } from "../../engine/tests/helpers/base-agent-config.js";

const sport = {
  id: "cycling",
  soul: "",
  skills: {},
  sessionClusterGapMinutes: 30,
  memorySections: [],
  mustPreserveTokens: [],
  intervalsActivityTypes: [],
  athleteProfileSchema: {},
  tools: () => [],
} as never;

describe("runBinary data-source composition", () => {
  it("prepares after security checks and before engine construction", () => {
    const source = readFileSync(join(__dirname, "..", "src", "run-binary.ts"), "utf8");
    const security = source.indexOf("ensureDataDirSecure(config.dataDir)");
    const prepare = source.indexOf("hooks.prepare?.({ config, sport })");
    const engine = source.indexOf("createCoachEngine(sport, config");
    expect(security).toBeGreaterThan(-1);
    expect(prepare).toBeGreaterThan(security);
    expect(engine).toBeGreaterThan(prepare);
  });

  it("fails store mode before engine startup when no reader was prepared", () => {
    const config = { ...baseAgentConfig("unused"), dataSource: "store" as const };
    expect(() => createCoachEngine(sport, config)).toThrow(
      "Store data source requires an athlete data reader.",
    );
  });
});
