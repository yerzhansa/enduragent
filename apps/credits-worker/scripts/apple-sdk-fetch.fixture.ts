type TestEnv = {
  APPLE_APP_STORE_P8: string;
  APPLE_APP_STORE_KEY_ID: string;
  APPLE_APP_STORE_ISSUER_ID: string;
  BUNDLE_ID: string;
};

export class AthleteSession {}

export default {
  async fetch(_request: Request, env: TestEnv): Promise<Response> {
    const originalFetch = globalThis.fetch;
    let outbound:
      | { origin: string; pathname: string; method: string; authorized: boolean }
      | undefined;
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      outbound = {
        origin: url.origin,
        pathname: url.pathname,
        method: request.method,
        authorized: request.headers.get("authorization")?.startsWith("Bearer ") === true,
      };
      return Response.json({ testNotificationToken: "synthetic-notification" });
    };
    try {
      const { AppStoreServerAPIClient, Environment } =
        await import("@apple/app-store-server-library");
      const client = new AppStoreServerAPIClient(
        env.APPLE_APP_STORE_P8,
        env.APPLE_APP_STORE_KEY_ID,
        env.APPLE_APP_STORE_ISSUER_ID,
        env.BUNDLE_ID,
        Environment.SANDBOX,
      );
      const result = await client.requestTestNotification();
      return Response.json({ outbound, testNotificationToken: result.testNotificationToken });
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
};
