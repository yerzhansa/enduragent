import {
  publicModelCatalogReleasePinError,
  runModelCatalogReleasePinCommand,
} from "./model-catalog-release-pin-command.js";

runModelCatalogReleasePinCommand(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${publicModelCatalogReleasePinError(error)}\n`);
  process.exitCode = 1;
});
