import { describe, expect, it } from "vitest";
import {
  startOAuthProviderFixture,
  syntheticOAuthCredential,
} from "../scripts/support/packaged-telegram/oauth-provider-fixture.js";

describe("synthetic packaged OAuth provider", () => {
  it("validates the migrated token, emits model SSE, and rejects unknown requests", async () => {
    const provider = await startOAuthProviderFixture({ verifyCallbackOwner: async () => false });
    try {
      const credential = syntheticOAuthCredential();
      const response = await fetch(`${provider.origin}/backend-api/codex/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential.access}`,
          "chatgpt-account-id": credential.accountId,
        },
        body: JSON.stringify({ stream: true }),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Synthetic packaged coach response.");
      expect((await fetch(`${provider.origin}/unexpected`)).status).toBe(400);
      expect(provider.observations.map((item) => item.kind)).toEqual([
        "model",
        "fixture-rejected-request",
      ]);
    } finally {
      await provider.close();
    }
  });

  it("rotates the refresh credential and can return invalid_grant", async () => {
    const provider = await startOAuthProviderFixture({ verifyCallbackOwner: async () => false });
    try {
      const refresh = (token: string) =>
        fetch(`${provider.origin}/oauth/token`, {
          method: "POST",
          body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token }),
        });
      const result = await refresh(syntheticOAuthCredential().refresh);
      expect(result.status).toBe(200);
      expect(await result.json()).toMatchObject({
        refresh_token: syntheticOAuthCredential(1).refresh,
      });
      provider.rejectRefresh();
      const rejected = await refresh(syntheticOAuthCredential(1).refresh);
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toEqual({ error: "invalid_grant" });
      expect(provider.observations.filter((item) => item.kind === "refresh")).toHaveLength(2);
    } finally {
      await provider.close();
    }
  });

  it("refuses to send a callback unless the listener belongs to the launched package", async () => {
    const provider = await startOAuthProviderFixture({ verifyCallbackOwner: async () => false });
    try {
      const response = await fetch(
        `${provider.origin}/authorize?state=${"a".repeat(32)}&code_challenge=${"b".repeat(43)}`,
      );
      expect(response.status).toBe(400);
      expect(provider.observations).toEqual([{ kind: "fixture-rejected-request", sequence: 0 }]);
    } finally {
      await provider.close();
    }
  });
});
