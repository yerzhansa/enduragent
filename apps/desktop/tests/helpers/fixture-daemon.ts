import { acquireWriteLock } from "@enduragent/kernel-node/lock";
import { resolveAthleteHome } from "@enduragent/kernel-node/home";
import { ConfirmationGate } from "@enduragent/core";
import { runDaemon } from "../../src/utility/run-daemon.js";
import { createBridgeScript, parseFixtureConnection } from "./fixture-bridge.js";
import { createScriptedCoach } from "./scripted-coach.js";

const connection = parseFixtureConnection(process.env.ENDURAGENT_FIXTURE_BRIDGE);
delete process.env.ENDURAGENT_FIXTURE_BRIDGE;
const coach = createScriptedCoach({ ...connection, script: createBridgeScript(connection) });

await runDaemon({
  resolveAthleteHome,
  readPackageVersion: async () => "0.0.1",
  async withLocalCoach(input) {
    const lock = await acquireWriteLock({
      configDir: input.home.configDir,
      athleteHome: input.home.root,
      version: "0.0.1",
    });
    if (lock.status !== "acquired") throw new Error("fixture writer lock was not acquired");
    try {
      const value = await input.operation({
        home: input.home,
        engine: coach.engine,
        operations: coach.operations,
        spendMeter: {
          getSpendSummary: () => coach.spend.getSpendSummary({}),
          setDailySpendCap: (dailyCapUsd) => coach.spend.setDailySpendCap({ dailyCapUsd }),
        },
        confirmations: new ConfirmationGate(),
        listener: lock.listener,
        startInitialRefresh: async () => {},
        close: async () => {},
      });
      return { status: "completed", value };
    } finally {
      await lock.release();
    }
  },
});
