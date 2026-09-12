import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          OPENROUTER_MANAGEMENT_KEY: "test-openrouter-management",
          APPLE_APP_STORE_P8: "test-app-store-p8",
          APPLE_APP_STORE_KEY_ID: "test-app-store-key",
          APPLE_APP_STORE_ISSUER_ID: "test-app-store-issuer",
          APPLE_DEVICECHECK_P8: "test-devicecheck-p8",
          APPLE_DEVICECHECK_KEY_ID: "test-devicecheck-key",
          APPLE_DEVICECHECK_TEAM_ID: "test-devicecheck-team",
          INTERVALS_OAUTH_CLIENT_SECRET: "test-intervals-secret",
          OPERATOR_TOKEN: "test-operator-token",
        },
      },
    }),
  ],
  test: {
    include: ["src/**/*.test.ts"],
  },
});
