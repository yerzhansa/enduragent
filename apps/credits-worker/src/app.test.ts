import { describe, expect, it } from "vitest";
import { createCreditsApp, type AppPorts } from "./app.js";
import type { SessionPorts } from "./athlete-session.js";
import { type AthleteId, type DeviceCheckToken } from "./domain.js";
import type { Env as WorkerEnv } from "./env.js";
import {
  FakeAppleStore,
  FakeDeviceCheck,
  FakeOpenRouterKeys,
  MemoryLedger,
  seedLaunchPolicy,
  testClock,
  testIds,
  testRuntime,
} from "./fakes.js";
import type { RedactingLog } from "./log.js";
import { createOperator } from "./ops.js";

const athleteId = "19980613-0000-4000-8000-000000000001" as AthleteId;
const token = "dc-1998-1" as DeviceCheckToken;

function allow(): AppPorts["ipLimit"] {
  return { take: async () => "allow" };
}

function deny(): AppPorts["ipLimit"] {
  return { take: async () => "deny" };
}

function silentLog(): RedactingLog {
  return {
    info() {},
    warn() {},
  };
}

function envStub(): WorkerEnv {
  return {
    BUNDLE_ID: "icu.enduragent.app",
    APPLE_ENVIRONMENT: "sandbox",
  } as WorkerEnv;
}

function ctx(): { waitUntil(p: Promise<unknown>): void } {
  return { waitUntil() {} };
}

function sessionPorts(): SessionPorts {
  const ledger = new MemoryLedger();
  seedLaunchPolicy(ledger);
  return {
    ledger,
    keys: new FakeOpenRouterKeys(),
    deviceCheck: new FakeDeviceCheck(),
    apple: new FakeAppleStore(),
    openRouter: { guardrailMode: "off", guardrailId: undefined, keyCountCeiling: undefined },
    clock: testClock,
    ids: testIds,
    purchasesEnabled: false,
    consumptionReporting: "unverified",
    bundleId: "icu.enduragent.app",
    environment: "sandbox",
    repeatRefundBanThreshold: 2,
  };
}

function appFrom(ports: SessionPorts, overrides: Partial<AppPorts> = {}): AppPorts {
  return {
    apple: ports.apple,
    deviceCheck: ports.deviceCheck,
    keys: ports.keys,
    ledger: ports.ledger,
    runtime: testRuntime(ports),
    operator: createOperator({
      ledger: ports.ledger,
      keys: ports.keys,
      apple: ports.apple,
      deviceCheck: ports.deviceCheck,
      runtime: testRuntime(ports),
    }),
    ipLimit: allow(),
    tokenLimit: allow(),
    log: silentLog(),
    starterCapUsdMillis: 2000,
    starterCredits: 200,
    purchasesEnabled: false,
    intervalsOAuthEnabled: false,
    intervalsExchange: undefined,
    ...overrides,
  };
}

describe("app", () => {
  it("grant wire kind grantMinted", async () => {
    const ports = sessionPorts();
    const app = createCreditsApp(appFrom(ports));
    const response = await app.fetch(
      new Request("https://credits.test/grant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          athleteId,
          deviceCheckToken: token,
        }),
      }),
      envStub(),
      ctx(),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      kind: string;
      credits: number;
      key: string;
    };
    expect(body.kind).toBe("grantMinted");
    expect(body.credits).toBe(200);
    expect(body.key.startsWith("fake-or-key-")).toBe(true);
  });

  it("catalog purchasesEnabled false", async () => {
    const ports = sessionPorts();
    const app = createCreditsApp(appFrom(ports));
    const response = await app.fetch(
      new Request("https://credits.test/catalog"),
      envStub(),
      ctx(),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      purchasesEnabled: boolean;
      creditsPerUsd: number;
      packs: unknown[];
    };
    expect(body.purchasesEnabled).toBe(false);
    expect(body.creditsPerUsd).toBe(100);
    expect(body.packs).toEqual([]);
  });

  it("banned maps to 403", async () => {
    const ports = sessionPorts();
    await ports.deviceCheck.update(token, { banned: true });
    const app = createCreditsApp(appFrom(ports));
    const response = await app.fetch(
      new Request("https://credits.test/grant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          athleteId,
          deviceCheckToken: token,
        }),
      }),
      envStub(),
      ctx(),
    );
    expect(response.status).toBe(403);
  });

  it("rate limit maps to 429", async () => {
    const ports = sessionPorts();
    const app = createCreditsApp(appFrom(ports, { ipLimit: deny() }));
    const response = await app.fetch(
      new Request("https://credits.test/catalog"),
      envStub(),
      ctx(),
    );
    expect(response.status).toBe(429);
  });
});
