import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runMacosRelease, safeMacosReleasePlanMessage } from "./macos-release-plan.mjs";
import { safeMacosReleaseVerificationMessage } from "./verify-macos-release.mjs";

let activeStage = "initialization";

async function main() {
  if (process.argv.length !== 2) throw new TypeError("arguments are not supported");
  const result = await runMacosRelease(
    {
      feedUrl: process.env.ENDURAGENT_DESKTOP_UPDATE_URL,
      identity: process.env.ENDURAGENT_DEVELOPER_ID_IDENTITY,
      baselineApplication: process.env.ENDURAGENT_MACOS_BASELINE_APP,
    },
    {
      reportStage(stage) {
        activeStage = stage;
      },
    },
  );
  process.stdout.write(`macOS release envelope: ${result.envelopePath}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    const detail = safeMacosReleaseVerificationMessage(error) ?? safeMacosReleasePlanMessage(error);
    const suffix = detail === undefined ? "" : `: ${detail}`;
    process.stderr.write(`macOS release build failed at ${activeStage}${suffix}\n`, () =>
      process.exit(1),
    );
  }
}
