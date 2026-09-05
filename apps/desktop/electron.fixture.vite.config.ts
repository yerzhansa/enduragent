import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import { createDesktopViteConfig } from "./electron.vite.config.js";

const outputRoot = process.env.ENDURAGENT_FIXTURE_BUILD_ROOT;
if (outputRoot === undefined) throw new Error("fixture build output directory is required");

export default defineConfig(
  createDesktopViteConfig({
    outputRoot: resolve(outputRoot, "out"),
    daemonUtilityEntry: resolve(import.meta.dirname, "tests/helpers/fixture-daemon.ts"),
  }),
);
