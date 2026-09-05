import { describe, expect, it } from "vitest";
import {
  createOAuthAcceptanceBrowser,
  createOAuthAcceptanceFetch,
  requireOAuthAcceptanceIdentity,
  requireOAuthAcceptanceOrigin,
} from "../scripts/support/packaged-telegram/oauth-fetch-route.js";

const origin = "http://127.0.0.1:32145";
const environment = {
  ENDURAGENT_ACCEPTANCE_HIDDEN: "1",
  ENDURAGENT_DISPOSABLE_SAFE_STORAGE_CONTEXT: "1",
  ENDURAGENT_ACCEPTANCE_CREDENTIAL_BACKEND: "file",
};
const manifest = {
  name: "enduragent-desktop-telegram-acceptance",
  productName: "Enduragent Telegram Acceptance",
  enduragentDesktopTelegramAcceptance: true,
};

describe("packaged OAuth acceptance transport boundary", () => {
  it.each([
    undefined,
    "https://127.0.0.1:1234",
    "http://localhost:1234",
    "http://127.0.0.2:1234",
    "http://example.com:1234",
    "http://127.0.0.1:0",
    "http://127.0.0.1:1234/path",
    "http://user@127.0.0.1:1234",
    "http://127.0.0.1:1234?x=1",
    "http://127.0.0.1:1234#x",
  ])("rejects noncanonical loopback origins: %s", (value) => {
    expect(() => requireOAuthAcceptanceOrigin(value)).toThrow();
  });

  it("requires the complete disposable acceptance identity", () => {
    expect(() => requireOAuthAcceptanceIdentity(environment, manifest)).not.toThrow();
    for (const key of Object.keys(environment)) {
      expect(() =>
        requireOAuthAcceptanceIdentity({ ...environment, [key]: undefined }, manifest),
      ).toThrow();
    }
    for (const key of Object.keys(manifest)) {
      expect(() =>
        requireOAuthAcceptanceIdentity(environment, { ...manifest, [key]: undefined }),
      ).toThrow();
    }
    expect(() =>
      requireOAuthAcceptanceIdentity(environment, { ...manifest, name: "@enduragent/desktop" }),
    ).toThrow();
  });

  it("routes only the expected endpoint for each process and disables redirects", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const original: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response("ok");
    };
    const main = createOAuthAcceptanceFetch(original, origin, "main");
    const utility = createOAuthAcceptanceFetch(original, origin, "utility");
    const signal = new AbortController().signal;
    await main("https://auth.openai.com/oauth/token", {
      method: "POST",
      body: "synthetic",
      signal,
    });
    await utility("https://chatgpt.com/backend-api/codex/responses", { method: "POST" });
    expect(calls).toEqual([
      {
        url: `${origin}/oauth/token`,
        init: { method: "POST", body: "synthetic", signal, redirect: "error" },
      },
      { url: `${origin}/backend-api/codex/responses`, init: { method: "POST", redirect: "error" } },
    ]);
    for (const url of [
      "https://example.com",
      "https://auth.openai.com/oauth/token?unexpected=1",
      "https://chatgpt.com/backend-api/codex/responses",
    ]) {
      await expect(main(url)).rejects.toThrow();
    }
    await expect(utility("https://auth.openai.com/oauth/token")).rejects.toThrow();
    await expect(main(new Request("https://auth.openai.com/oauth/token"))).rejects.toThrow();
    expect(calls).toHaveLength(2);
  });

  it("preserves the production state and PKCE challenge while refusing unrelated browser links", async () => {
    const calls: string[] = [];
    const browser = createOAuthAcceptanceBrowser(async (input) => {
      calls.push(String(input));
      return new Response("ok");
    }, origin);
    const query = new URLSearchParams({
      redirect_uri: "http://localhost:1455/auth/callback",
      response_type: "code",
      code_challenge_method: "S256",
      code_challenge: "a".repeat(43),
      state: "b".repeat(32),
    });
    await browser(`https://auth.openai.com/oauth/authorize?${query}`);
    expect(calls).toEqual([`${origin}/authorize?${query}`]);
    query.set("redirect_uri", "https://example.com");
    await expect(browser(`https://auth.openai.com/oauth/authorize?${query}`)).rejects.toThrow();
    await expect(browser("https://example.com")).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});
