import { resolve } from "node:path";
import { defineConfig, mergeConfig } from "electron-vite";
import { createDesktopViteConfig } from "./electron.vite.config.js";

const desktopRoot = import.meta.dirname;

const base = createDesktopViteConfig({
  outputRoot: resolve(desktopRoot, "dist/telegram-acceptance-build/out"),
  daemonUtilityEntry: resolve(desktopRoot, "scripts/support/packaged-telegram/daemon-utility.ts"),
});

export default defineConfig(
  mergeConfig(base, {
    main: {
      build: {
        rollupOptions: {
          input: {
            index: resolve(desktopRoot, "scripts/support/packaged-telegram/main-entry.ts"),
          },
          output: {
            chunkFileNames: "[name]-[hash].js",
            minifyInternalExports: false,
            manualChunks: {
              "oauth-acceptance-route": [
                resolve(desktopRoot, "scripts/support/packaged-telegram/oauth-fetch-route.ts"),
              ],
            },
          },
        },
      },
    },
  }),
);
