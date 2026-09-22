import { runBinary, reportFatal, getCoachHome } from "@enduragent/core";
import { cyclingSport } from "@enduragent/sport-cycling";
import { migrateCyclingLegacySections } from "@enduragent/sport-cycling/migrate";
import { cyclingBinary } from "./binary.js";

try {
  await runBinary(cyclingSport, cyclingBinary, {
    workoutChangeSets: "aggregate-v1",
    onStartup: (memory) => migrateCyclingLegacySections(memory),
  });
} catch (err) {
  reportFatal(err, { dataDir: getCoachHome(cyclingBinary.binaryName) });
}
