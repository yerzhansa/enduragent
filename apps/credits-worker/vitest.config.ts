import ocspFixtures from "./scripts/proof-fixtures.json" with { type: "json" };
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        outboundService: async (request) => {
          const url = new URL(request.url);
          if (url.origin === "http://ocsp.apple.com" && request.method === "POST") {
            const variant = url.pathname.replace("/synthetic-", "");
            if (variant === "intermediate")
              return new Response(Buffer.from(ocspFixtures.ocsp.good[1]!, "hex"));
            if (Object.hasOwn(ocspFixtures.ocsp, variant)) {
              return new Response(
                Buffer.from(
                  ocspFixtures.ocsp[variant as keyof typeof ocspFixtures.ocsp][0]!,
                  "hex",
                ),
              );
            }
          }
          if (
            url.origin === "https://api.storekit-sandbox.apple.com" &&
            url.pathname === "/inApps/v1/notifications/test" &&
            request.method === "POST" &&
            request.headers.get("authorization")?.startsWith("Bearer ")
          ) {
            return Response.json({ testNotificationToken: "synthetic-notification" });
          }
          return new Response("Unexpected test request", { status: 502 });
        },
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
