import {
  bootstrapReference,
  getCoachHome,
  reportFatal,
  runBinary,
  type BinaryConfig,
  type PreparedCoachComposition,
  type Config,
  type Sport,
} from "@enduragent/core";
import { resolveAthleteHome, type AthleteHome } from "@enduragent/kernel-node/home";
import { cyclingSport } from "@enduragent/sport-cycling";
import { migrateCyclingLegacySections } from "@enduragent/sport-cycling/migrate";
import { createStoreRuntime, type StoreRuntime, type StoreRuntimeDependencies } from "./store-runtime.js";

const cyclingBinary: BinaryConfig = Object.freeze({
  binaryName: "cycling-coach",
  displayName: "Cycling Coach",
  dataSubdir: "cycling",
  keychainPrefix: "cycling-coach",
  homeEnvVar: "CYCLING_COACH_HOME",
});

export interface LocalBotDependencies {
  readonly env?: Record<string, string | undefined>;
  readonly resolveHome?: (env: Record<string, string | undefined>) => AthleteHome;
  readonly bootstrap?: typeof bootstrapReference;
  readonly createRuntime?: (input: ConstructorParameters<typeof StoreRuntime>[0]) => StoreRuntime;
  readonly runtimeDependencies?: StoreRuntimeDependencies;
}

export async function prepareStoreCoachComposition(
  input: { config: Config; sport: Sport },
  dependencies: LocalBotDependencies = {},
): Promise<PreparedCoachComposition> {
  if (input.config.dataSource === "platform") return {};
  const env = dependencies.env ?? process.env;
  const home = (dependencies.resolveHome ?? resolveAthleteHome)(env);
  let runtime: StoreRuntime | undefined;
  const reference = await (dependencies.bootstrap ?? bootstrapReference)({
    dataDir: input.config.dataDir,
    intervals: input.config.intervals,
    readCalendarTimeZone: () => input.config.session.timezone,
    sport: input.sport,
    startScheduler: false,
    attemptLedgerForRun: () => {
      if (runtime === undefined) throw new Error("Store runtime has not started its paired window.");
      return runtime.attemptLedgerForRun();
    },
  });
  runtime = (dependencies.createRuntime ?? ((options) => createStoreRuntime(options)))({
    env,
    config: input.config,
    home,
    reference,
    dependencies: dependencies.runtimeDependencies,
  });
  await runtime.runWindow();
  runtime.startScheduler();
  return Object.freeze({
    athleteData: runtime.athleteData,
    reference,
    close: () => runtime!.close(),
  });
}

async function main(): Promise<void> {
  try {
    await runBinary(cyclingSport, cyclingBinary, {
      prepare: (input) => prepareStoreCoachComposition(input),
      onStartup: (memory) => migrateCyclingLegacySections(memory),
    });
  } catch (error) {
    reportFatal(error, { dataDir: getCoachHome(cyclingBinary.binaryName) });
  }
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], "file:").href) {
  await main();
}
