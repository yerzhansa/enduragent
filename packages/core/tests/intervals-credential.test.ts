import { describe, expect, it } from "vitest";
import {
  decodeIntervalsCredential,
  encodeIntervalsOAuthCredential,
  intervalsAuthorizationHeader,
  intervalsClientAuth,
} from "../src/intervals-credential.js";

const basicUser = ["API", "KEY"].join("_");

describe("intervals credential encoding", () => {
  it("treats a plain value as an API key", () => {
    expect(decodeIntervalsCredential("plain-key")).toEqual({
      kind: "api-key",
      apiKey: "plain-key",
    });
    expect(intervalsAuthorizationHeader("plain-key")).toBe(
      `Basic ${btoa(`${basicUser}:plain-key`)}`,
    );
    expect(intervalsClientAuth("plain-key")).toEqual({ apiKey: "plain-key" });
  });

  it("round-trips an OAuth access token as a bearer credential", () => {
    const stored = encodeIntervalsOAuthCredential("fixture-token");
    expect(stored).not.toBe("fixture-token");
    expect(decodeIntervalsCredential(stored)).toEqual({
      kind: "oauth",
      accessToken: "fixture-token",
    });
    expect(intervalsAuthorizationHeader(stored)).toBe("Bearer fixture-token");
    expect(intervalsClientAuth(stored)).toEqual({ bearerToken: "fixture-token" });
  });

  it("refuses an empty or padded access token", () => {
    expect(() => encodeIntervalsOAuthCredential("")).toThrow("access token is required");
    expect(() => encodeIntervalsOAuthCredential(" token")).toThrow("access token is required");
  });

  it("keeps a bare prefix as an API key rather than an empty bearer token", () => {
    const bare = encodeIntervalsOAuthCredential("x").slice(0, -1);
    expect(decodeIntervalsCredential(bare)).toEqual({ kind: "api-key", apiKey: bare });
  });
});
