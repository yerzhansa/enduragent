import { publicModelCatalogCommandError, runModelCatalogCommand } from "./model-catalog-command.js";

runModelCatalogCommand(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${publicModelCatalogCommandError(error)}\n`);
  process.exitCode = 1;
});
