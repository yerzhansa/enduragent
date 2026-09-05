import { describe, expect, it } from "vitest";
import {
  createUtilityOAuthClient,
  isOAuthRequest,
  isOAuthResponse,
  type OAuthRequest,
} from "../src/utility/oauth-protocol.js";

describe("private utility OAuth channel", () => {
  it("correlates status and access responses without returning refresh credentials", async () => {
    const sent: OAuthRequest[] = [];
    const client = createUtilityOAuthClient({
      send: (request) => sent.push(request),
      signal: new AbortController().signal,
    });
    const status = client.owner.hasProfile("custom");
    const token = client.owner.getAccessToken("custom", undefined, "synthetic-rejected");
    expect(sent).toMatchObject([
      { operation: "status", profile: "custom" },
      { operation: "token", rejectedAccessToken: "synthetic-rejected" },
    ]);
    client.receive({
      type: "oauth-response",
      id: sent[1]!.id,
      status: "ok",
      value: "synthetic-access",
    });
    client.receive({ type: "oauth-response", id: sent[0]!.id, status: "ok", value: true });
    await expect(token).resolves.toBe("synthetic-access");
    await expect(status).resolves.toBe(true);
    client.close();
  });

  it("preserves safe refresh failure classification", async () => {
    let request: OAuthRequest | undefined;
    const client = createUtilityOAuthClient({
      send: (value) => {
        request = value;
      },
      signal: new AbortController().signal,
    });
    const pending = client.owner.getAccessToken("openai-codex");
    client.receive({ type: "oauth-response", id: request!.id, status: "failed", reason: "reauth" });
    await expect(pending).rejects.toMatchObject({
      message: "OAuth token refresh failed",
      refreshFailureReason: "reauth",
      cause: undefined,
    });
    client.close();
  });

  it("rejects pending access when the utility is closed", async () => {
    const client = createUtilityOAuthClient({
      send: () => {},
      signal: new AbortController().signal,
    });
    const pending = client.owner.getAccessToken("openai-codex");
    client.close();
    await expect(pending).rejects.toThrow("OAuth token refresh failed");
  });

  it("rejects token-bearing malformed responses and invalid requests", () => {
    expect(
      isOAuthResponse({
        type: "oauth-response",
        id: 1,
        status: "ok",
        value: { refresh: "synthetic" },
      }),
    ).toBe(false);
    expect(
      isOAuthRequest({
        type: "oauth-request",
        id: 1,
        operation: "export-refresh",
        profile: "openai-codex",
      }),
    ).toBe(false);
    expect(
      isOAuthRequest({
        type: "oauth-request",
        id: 1,
        operation: "delete",
        profile: "openai-codex",
        rejectedAccessToken: "synthetic",
      }),
    ).toBe(false);
  });
});
