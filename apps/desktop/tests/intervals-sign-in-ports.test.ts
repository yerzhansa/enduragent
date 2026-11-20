import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntervalsSignInError, signInWithIntervals } from "@enduragent/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { intervalsRevokePort, intervalsSignInPorts } from "../src/main/intervals-sign-in-ports.js";

const directories: string[] = [];

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "intervals-ports-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function approveWith(code: string): (url: string) => Promise<void> {
  return async (url) => {
    const authorize = new URL(url);
    const callback = new URL(authorize.searchParams.get("redirect_uri") ?? "");
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");
    await fetch(callback);
  };
}

describe("intervals sign-in ports", () => {
  const openExternal = async (): Promise<void> => undefined;

  it.each([
    { isPackaged: true, hidden: true, authorizeUrlLog: "/tmp/authorize.log" },
    { isPackaged: false, hidden: false, authorizeUrlLog: "/tmp/authorize.log" },
    { isPackaged: false, hidden: true, authorizeUrlLog: undefined },
    { isPackaged: false, hidden: true, authorizeUrlLog: "relative/authorize.log" },
  ])("uses the real browser and intervals.icu outside acceptance runs: %o", (gate) => {
    const ports = intervalsSignInPorts({
      app: { isPackaged: gate.isPackaged },
      hidden: gate.hidden,
      environment: { ENDURAGENT_ACCEPTANCE_INTERVALS_AUTHORIZE_LOG: gate.authorizeUrlLog },
      openExternal,
    });
    expect(ports.openExternal).toBe(openExternal);
    expect(ports.signIn).toBe(signInWithIntervals);
  });

  it("logs the consent page and returns a synthetic grant in an acceptance run", async () => {
    const log = join(await scratch(), "authorize.log");
    const ports = intervalsSignInPorts({
      app: { isPackaged: false },
      hidden: true,
      environment: { ENDURAGENT_ACCEPTANCE_INTERVALS_AUTHORIZE_LOG: log },
      openExternal,
    });
    await ports.openExternal("https://intervals.icu/oauth/authorize?state=fixture");
    expect(await readFile(log, "utf8")).toBe(
      "https://intervals.icu/oauth/authorize?state=fixture\n",
    );
    const grant = await ports.signIn({ openExternal: approveWith("acceptance-code") });
    expect(grant).toMatchObject({ athleteId: "101", athleteName: "Test Athlete" });
    expect(grant.credential).toBe("intervals-oauth:acceptance-token");
  });

  it.each([
    ["acceptance-rejected", "exchange-failed"],
    ["acceptance-unreachable", "unreachable"],
  ])("maps the %s code to %s", async (code, reason) => {
    const ports = intervalsSignInPorts({
      app: { isPackaged: false },
      hidden: true,
      environment: {
        ENDURAGENT_ACCEPTANCE_INTERVALS_AUTHORIZE_LOG: join(await scratch(), "authorize.log"),
      },
      openExternal,
    });
    const failure = await ports.signIn({ openExternal: approveWith(code) }).then(
      () => new Error("expected sign-in to fail"),
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(IntervalsSignInError);
    expect(failure).toMatchObject({ reason });
  });
});

describe("intervals revoke port", () => {
  const SIGNED_IN = "intervals-oauth:fixture-revoke-token";

  function stubNetwork(status = 204) {
    const fetch = vi.fn(async () => new Response(null, { status }));
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }

  it.each([
    { isPackaged: true, hidden: true, authorizeUrlLog: "/tmp/authorize.log" },
    { isPackaged: false, hidden: false, authorizeUrlLog: "/tmp/authorize.log" },
    { isPackaged: false, hidden: true, authorizeUrlLog: undefined },
    { isPackaged: false, hidden: true, authorizeUrlLog: "relative/authorize.log" },
  ])("sends the real revoke outside acceptance runs: %o", async (gate) => {
    const network = stubNetwork();
    const revoke = intervalsRevokePort({
      app: { isPackaged: gate.isPackaged },
      hidden: gate.hidden,
      environment: {
        ENDURAGENT_ACCEPTANCE_INTERVALS_AUTHORIZE_LOG: gate.authorizeUrlLog,
        ENDURAGENT_ACCEPTANCE_INTERVALS_REVOKE_RESULT: "failed",
      },
    });

    await expect(revoke(SIGNED_IN)).resolves.toBe("revoked");
    expect(network).toHaveBeenCalledOnce();
    expect(network.mock.calls[0]).toEqual([
      "https://intervals.icu/api/v1/disconnect-app",
      expect.objectContaining({
        method: "DELETE",
        headers: { authorization: "Bearer fixture-revoke-token" },
      }),
    ]);
  });

  it.each([
    [undefined, "revoked"],
    ["revoked", "revoked"],
    ["already-invalid", "already-invalid"],
    ["failed", "failed"],
  ] as const)(
    "returns the stubbed %s result in an acceptance run without the network",
    async (result, expected) => {
      const network = stubNetwork(500);
      const revoke = intervalsRevokePort({
        app: { isPackaged: false },
        hidden: true,
        environment: {
          ENDURAGENT_ACCEPTANCE_INTERVALS_AUTHORIZE_LOG: "/tmp/authorize.log",
          ENDURAGENT_ACCEPTANCE_INTERVALS_REVOKE_RESULT: result,
        },
      });

      await expect(revoke(SIGNED_IN)).resolves.toBe(expected);
      await expect(revoke("fixture-api-key")).resolves.toBe("not-signed-in");
      expect(network).not.toHaveBeenCalled();
    },
  );
});
