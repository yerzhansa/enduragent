import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import type { DeviceCheck } from "./apple.js";
import { handleAthleteCommand, handleGrantCommand, type SessionPorts } from "./athlete-session.js";
import {
  asCredits,
  asUsdMillis,
  type AthleteId,
  type DeviceCheckToken,
  type DeviceGrantOwnerId,
  type GrantId,
  type IdFactory,
  type LotId,
  type ProviderMutationId,
  type Clock,
} from "./domain.js";
import { FakeAppleStore, FakeDeviceCheck, FakeOpenRouterKeys, testClock } from "./fakes.js";
import { D1Ledger } from "./ledger.js";

const athleteA = "19980613-0000-4000-8000-000000000001" as AthleteId;
const athleteB = "19980613-0000-4000-8000-000000000002" as AthleteId;
const token = "dc-1998-shared" as DeviceCheckToken;

function ids(prefix: string): IdFactory {
  let next = 1;
  return {
    lotId: () => `lot_1998_${prefix}_${next++}` as LotId,
    grantId: () => `grant_1998_${prefix}_${next++}` as GrantId,
    mutationId: () => `mutation_1998_${prefix}_${next++}` as ProviderMutationId,
    deviceGrantOwnerId: () => `device_owner_1998_${prefix}_${next++}` as DeviceGrantOwnerId,
  };
}

function ports(args: {
  deviceCheck: DeviceCheck;
  keys: FakeOpenRouterKeys;
  ids: IdFactory;
  ledger?: D1Ledger;
  clock?: Clock;
}): SessionPorts {
  return {
    ledger: args.ledger ?? new D1Ledger(env.DB),
    keys: args.keys,
    deviceCheck: args.deviceCheck,
    apple: new FakeAppleStore(),
    openRouter: { guardrailMode: "off", guardrailId: undefined, keyCountCeiling: undefined },
    clock: args.clock ?? testClock,
    ids: args.ids,
    purchasesEnabled: false,
    consumptionReporting: "unverified",
    bundleId: "icu.enduragent.app",
    environment: "sandbox",
    repeatRefundBanThreshold: 2,
  };
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.exec(`
DELETE FROM pending_provider_mutations;
DELETE FROM device_grant_gate;
DELETE FROM lots;
DELETE FROM grants;
DELETE FROM bans;
DELETE FROM athletes;
`);
});

it("different athletes racing one device authorize at most one grant", async () => {
  const base = new FakeDeviceCheck();
  let queryCount = 0;
  let releaseFirstQuery = () => {};
  let reportFirstQuery = () => {};
  const firstQuery = new Promise<void>((resolve) => {
    reportFirstQuery = resolve;
  });
  const holdFirstQuery = new Promise<void>((resolve) => {
    releaseFirstQuery = resolve;
  });
  const deviceCheck: DeviceCheck = {
    async query(value) {
      const bits = await base.query(value);
      queryCount += 1;
      if (queryCount === 1) {
        reportFirstQuery();
        await holdFirstQuery;
      }
      return bits;
    },
    update: (value, bits) => base.update(value, bits),
  };
  const keys = new FakeOpenRouterKeys();
  const secondLedger = new D1Ledger(env.DB);
  let reportSecondClaim = () => {};
  const secondClaim = new Promise<void>((resolve) => {
    reportSecondClaim = resolve;
  });
  const trySecondClaim = secondLedger.tryClaimDeviceGrant.bind(secondLedger);
  secondLedger.tryClaimDeviceGrant = async (lease) => {
    const result = await trySecondClaim(lease);
    reportSecondClaim();
    return result;
  };
  const command = {
    kind: "grant" as const,
    deviceCheckToken: token,
    starterCapUsdMillis: asUsdMillis(2000),
    starterCredits: asCredits(200),
  };

  const first = handleGrantCommand(athleteA, command, ports({ deviceCheck, keys, ids: ids("a") }));
  await firstQuery;
  const second = handleGrantCommand(
    athleteB,
    command,
    ports({ deviceCheck, keys, ids: ids("b"), ledger: secondLedger }),
  );
  const settledPromise = Promise.allSettled([first, second]);
  await secondClaim;
  releaseFirstQuery();

  const settled = await settledPromise;
  expect(keys.createdCount).toBe(1);
  expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
});

it("an expired owner cannot fund after its late DeviceCheck mark succeeds", async () => {
  const base = new FakeDeviceCheck();
  let now = new Date("1998-06-13T06:00:00.000Z");
  const clock: Clock = { now: () => now };
  let updateCount = 0;
  let reportFirstUpdate = () => {};
  let releaseFirstUpdate = () => {};
  const firstUpdate = new Promise<void>((resolve) => {
    reportFirstUpdate = resolve;
  });
  const holdFirstUpdate = new Promise<void>((resolve) => {
    releaseFirstUpdate = resolve;
  });
  const deviceCheck: DeviceCheck = {
    query: (value) => base.query(value),
    async update(value, bits) {
      updateCount += 1;
      if (updateCount === 1) {
        reportFirstUpdate();
        await holdFirstUpdate;
      }
      await base.update(value, bits);
    },
  };
  const keys = new FakeOpenRouterKeys();
  const command = {
    kind: "grant" as const,
    deviceCheckToken: token,
    starterCapUsdMillis: asUsdMillis(2000),
    starterCredits: asCredits(200),
  };

  const expiredOwner = handleGrantCommand(
    athleteA,
    command,
    ports({ deviceCheck, keys, ids: ids("expired"), clock }),
  );
  const expiredOwnerSettled = Promise.allSettled([expiredOwner]);
  await firstUpdate;
  now = new Date("1998-06-13T06:02:00.000Z");
  const replacement = await handleGrantCommand(
    athleteB,
    command,
    ports({ deviceCheck, keys, ids: ids("replacement"), clock }),
  );
  releaseFirstUpdate();

  expect(replacement.kind).toBe("grantMinted");
  await expect(expiredOwnerSettled).resolves.toMatchObject([{ status: "rejected" }]);
  expect(keys.createdCount).toBe(1);
});

it("a D1 grant fence survives a fresh ledger client without replaying funding", async () => {
  const deviceCheck = new FakeDeviceCheck();
  const keys = new FakeOpenRouterKeys();
  const create = keys.create.bind(keys);
  let loseResponse = true;
  keys.create = async (input) => {
    const created = await create(input);
    if (loseResponse) {
      loseResponse = false;
      throw new Error("synthetic lost create response");
    }
    return created;
  };
  const command = {
    kind: "grant" as const,
    deviceCheckToken: "dc-1998-durable-fence" as DeviceCheckToken,
    starterCapUsdMillis: asUsdMillis(2000),
    starterCredits: asCredits(200),
  };

  await expect(
    handleAthleteCommand(
      athleteA,
      command,
      ports({ deviceCheck, keys, ids: ids("durable-first") }),
    ),
  ).rejects.toThrow("synthetic lost create response");
  const freshLedger = new D1Ledger(env.DB);
  await expect(freshLedger.takePendingMutation(athleteA)).resolves.toMatchObject({
    recovery: "fence",
  });
  await expect(
    handleAthleteCommand(
      athleteA,
      { ...command, deviceCheckToken: "dc-1998-durable-retry" as DeviceCheckToken },
      ports({ deviceCheck, keys, ids: ids("durable-second"), ledger: freshLedger }),
    ),
  ).rejects.toThrow("unavailable");
  expect(keys.createdCount).toBe(1);
});

it("a completed D1 grant closes its provider fence after ledger finalization", async () => {
  const ledger = new D1Ledger(env.DB);
  const deviceCheck = new FakeDeviceCheck();
  const keys = new FakeOpenRouterKeys();
  const result = await handleAthleteCommand(
    athleteA,
    {
      kind: "grant",
      deviceCheckToken: "dc-1998-finalized" as DeviceCheckToken,
      starterCapUsdMillis: asUsdMillis(2000),
      starterCredits: asCredits(200),
    },
    ports({ deviceCheck, keys, ids: ids("finalized"), ledger }),
  );

  expect(result.kind).toBe("grantMinted");
  await expect(ledger.takePendingMutation(athleteA)).resolves.toBeUndefined();
  await expect(ledger.grantsFor(athleteA)).resolves.toHaveLength(1);
});
