import { app, shell } from "electron";
import { installOAuthAcceptanceRoute } from "./oauth-fetch-route.js";
import { runTelegramAcceptanceBootstrap } from "./process-safety.js";
import { consumeAcceptanceStartupMarker } from "./startup-mode.js";

await runTelegramAcceptanceBootstrap({
  input: process.stdin,
  beforeImport: () => {
    installOAuthAcceptanceRoute("main", shell);
    consumeAcceptanceStartupMarker(process.env, app);
  },
  importProduction: () => import("../../../src/main/index.js"),
  quit: () => app.quit(),
  report: (diagnostic) => process.stderr.write(`${diagnostic}\n`),
  exit: (code) => {
    process.exitCode = code;
    app.exit(code);
  },
});
