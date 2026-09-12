import { AppStoreServerClient, DeviceCheckClient } from "./apple.js";
import type { AppleStore, DeviceCheck } from "./apple.js";
import type {
  AthleteCommand,
  AthleteId,
  AthleteKey,
  AthleteResult,
  Clock,
  ConsumptionReporting,
  Credits,
  DomainError,
  GrantId,
  GrantResult,
  IdFactory,
  KeyHash,
  LotId,
  ProviderMutationId,
  TransactionId,
  UsdMillis,
} from "./domain.js";
import {
  asCredits,
  asUsdMillis,
  athleteIdFromUuid,
  DomainError as DomainErr,
  reportedConsumption,
  spendUsdMillisFromRemaining,
  usageTowardLot,
  consumptionForTransaction,
} from "./domain.js";
import type { DurableObjectState, Env } from "./env.js";
import { D1Ledger } from "./ledger.js";
import type { Ledger, ProviderMutation, PurchaseRecord } from "./ledger.js";
import type { OpenRouterConfig, OpenRouterKeys } from "./openrouter.js";
import { OpenRouterManagementClient } from "./openrouter.js";

export type SessionPorts = {
  ledger: Ledger;
  keys: OpenRouterKeys;
  deviceCheck: DeviceCheck;
  apple: AppleStore;
  openRouter: OpenRouterConfig;
  clock: Clock;
  ids: IdFactory;
  purchasesEnabled: boolean;
  consumptionReporting: ConsumptionReporting;
  bundleId: string;
  environment: "sandbox" | "production";
  repeatRefundBanThreshold: number;
};

function nowIso(ports: SessionPorts): string {
  return ports.clock.now().toISOString();
}

function plusMillis(a: UsdMillis, b: UsdMillis): UsdMillis {
  return asUsdMillis((a as number) + (b as number));
}

function minusMillis(a: UsdMillis, b: UsdMillis): UsdMillis {
  return asUsdMillis(Math.max(0, (a as number) - (b as number)));
}

function creditsFromRemaining(remaining: UsdMillis, creditsPerUsd: number): Credits {
  return asCredits(Math.round((remaining / 1000) * creditsPerUsd));
}

async function grantedMillis(ledger: Ledger, athleteId: AthleteId): Promise<UsdMillis> {
  const lots = await ledger.lotsOldestFirst(athleteId);
  return asUsdMillis(lots.reduce((sum, lot) => sum + (lot.originalCapUsdMillis as number), 0));
}

async function refundedMillis(ledger: Ledger, athleteId: AthleteId): Promise<UsdMillis> {
  const purchases = await ledger.purchasesFor(athleteId);
  return asUsdMillis(
    purchases.reduce((sum, row) => sum + (row.refundedAt ? (row.capUsdMillis as number) : 0), 0),
  );
}

async function applyProviderCall(
  mutation: ProviderMutation,
  ports: SessionPorts,
): Promise<ProviderMutationResult> {
  switch (mutation.kind) {
    case "createKey": {
      const created = await ports.keys.create({
        name: mutation.name,
        limitUsdMillis: mutation.limitUsdMillis,
        guardrailMode: ports.openRouter.guardrailMode,
        guardrailId: ports.openRouter.guardrailId,
      });
      return { kind: "createKey", key: created.key, hash: created.hash };
    }
    case "setLimit":
      await ports.keys.setLimit(mutation.hash, mutation.limitUsdMillis);
      return { kind: "setLimit" };
    case "setDisabled":
      await ports.keys.setDisabled(mutation.hash, mutation.disabled);
      return { kind: "setDisabled" };
    case "deleteKey":
      await ports.keys.delete(mutation.hash);
      return { kind: "deleteKey" };
    default: {
      const _exhaustive: never = mutation;
      return _exhaustive;
    }
  }
}

export async function handleAthleteCommand(
  athleteId: AthleteId,
  command: AthleteCommand,
  ports: SessionPorts,
): Promise<AthleteResult> {
  await finishPendingProviderMutation(athleteId, ports);
  switch (command.kind) {
    case "grant":
      return handleGrantCommand(athleteId, command, ports);
    case "claim":
      return handleClaimCommand(athleteId, command, ports);
    case "recover":
      return handleRecoverCommand(athleteId, command, ports);
    case "refund":
      return handleRefundCommand(athleteId, command, ports);
    case "revoke":
      return handleRevokeCommand(athleteId, command, ports);
    case "consumptionRequest":
      return handleConsumptionCommand(athleteId, command, ports);
    case "ban":
      return handleBanCommand(athleteId, command, ports);
    default: {
      const _exhaustive: never = command;
      return _exhaustive;
    }
  }
}

export async function finishPendingProviderMutation(
  athleteId: AthleteId,
  ports: SessionPorts,
): Promise<void> {
  for (;;) {
    const pending = await ports.ledger.takePendingMutation(athleteId);
    if (!pending) return;
    if (pending.mutation.kind === "createKey") {
      const existing = await ports.ledger.athlete(athleteId);
      if (existing) {
        await ports.ledger.markPendingMutationDone(pending.mutationId, nowIso(ports));
        continue;
      }
    }
    await applyProviderCall(pending.mutation, ports);
    await ports.ledger.markPendingMutationDone(pending.mutationId, nowIso(ports));
  }
}

export type ProviderMutationResult =
  | { kind: "createKey"; key: AthleteKey; hash: KeyHash }
  | { kind: "setLimit" }
  | { kind: "setDisabled" }
  | { kind: "deleteKey" };

export async function executeProviderMutation(
  athleteId: AthleteId,
  mutationId: ProviderMutationId,
  mutation: ProviderMutation,
  ports: SessionPorts,
): Promise<ProviderMutationResult> {
  await ports.ledger.putPendingMutation({
    mutationId,
    athleteId,
    mutation,
    startedAt: nowIso(ports),
    completedAt: undefined,
  });
  const result = await applyProviderCall(mutation, ports);
  await ports.ledger.markPendingMutationDone(mutationId, nowIso(ports));
  return result;
}

async function raiseLimit(
  athleteId: AthleteId,
  hash: KeyHash,
  delta: UsdMillis,
  ports: SessionPorts,
): Promise<void> {
  const view = await ports.keys.get(hash);
  await executeProviderMutation(
    athleteId,
    ports.ids.mutationId(),
    { kind: "setLimit", hash, limitUsdMillis: plusMillis(view.limitUsdMillis, delta) },
    ports,
  );
}

async function lowerLimit(
  athleteId: AthleteId,
  hash: KeyHash,
  delta: UsdMillis,
  ports: SessionPorts,
): Promise<void> {
  const view = await ports.keys.get(hash);
  await executeProviderMutation(
    athleteId,
    ports.ids.mutationId(),
    { kind: "setLimit", hash, limitUsdMillis: minusMillis(view.limitUsdMillis, delta) },
    ports,
  );
}

async function mintKey(
  athleteId: AthleteId,
  limitUsdMillis: UsdMillis,
  ports: SessionPorts,
): Promise<{ key: AthleteKey; hash: KeyHash }> {
  const created = await executeProviderMutation(
    athleteId,
    ports.ids.mutationId(),
    { kind: "createKey", name: athleteId, limitUsdMillis },
    ports,
  );
  if (created.kind !== "createKey") throw new DomainErr("unavailable");
  return { key: created.key, hash: created.hash };
}

async function insertGrantLot(
  athleteId: AthleteId,
  capUsdMillis: UsdMillis,
  credits: Credits,
  ports: SessionPorts,
): Promise<void> {
  const grantedAt = nowIso(ports);
  await ports.ledger.insertGrant({
    grantId: ports.ids.grantId(),
    athleteId,
    capUsdMillis,
    credits,
    grantedAt,
  });
  await ports.ledger.insertLot({
    lotId: ports.ids.lotId(),
    athleteId,
    source: "grant",
    transactionId: undefined,
    originalCapUsdMillis: capUsdMillis,
    createdAt: grantedAt,
  });
}

export async function handleGrantCommand(
  athleteId: AthleteId,
  command: Extract<AthleteCommand, { kind: "grant" }>,
  ports: SessionPorts,
): Promise<GrantResult> {
  const bits = await ports.deviceCheck.query(command.deviceCheckToken);
  if (bits.banned) throw new DomainErr("banned");
  const banned = await ports.ledger.ban(athleteId);
  if (banned) throw new DomainErr("banned");
  if (bits.grantClaimed) return { kind: "grantAlreadyGranted" };

  const athlete = await ports.ledger.athlete(athleteId);
  if (!athlete) {
    const minted = await mintKey(athleteId, command.starterCapUsdMillis, ports);
    await ports.ledger.insertAthlete({
      athleteId,
      keyHash: minted.hash,
      keyGeneration: 1,
      disabled: false,
      refundsAfterUse: 0,
      createdAt: nowIso(ports),
    });
    await insertGrantLot(athleteId, command.starterCapUsdMillis, command.starterCredits, ports);
    await ports.deviceCheck.update(command.deviceCheckToken, { grantClaimed: true });
    return { kind: "grantMinted", key: minted.key, credits: command.starterCredits };
  }

  await raiseLimit(athleteId, athlete.keyHash, command.starterCapUsdMillis, ports);
  await insertGrantLot(athleteId, command.starterCapUsdMillis, command.starterCredits, ports);
  await ports.deviceCheck.update(command.deviceCheckToken, { grantClaimed: true });
  return { kind: "grantToppedUp", added: command.starterCredits };
}

async function refuseIfBanned(
  athleteId: AthleteId,
  originalTransactionId: PurchaseRecord["originalTransactionId"] | undefined,
  ports: SessionPorts,
): Promise<void> {
  if (await ports.ledger.ban(athleteId)) throw new DomainErr("banned");
  if (originalTransactionId && (await ports.ledger.isOriginalBanned(originalTransactionId))) {
    throw new DomainErr("banned");
  }
}

async function applyRefundMoney(
  athleteId: AthleteId,
  purchase: PurchaseRecord,
  ports: SessionPorts,
): Promise<void> {
  const athlete = await ports.ledger.athlete(athleteId);
  if (athlete && !athlete.disabled) {
    const lots = await ports.ledger.lotsOldestFirst(athleteId);
    let remaining = asUsdMillis(0);
    const view = await ports.keys.get(athlete.keyHash);
    remaining = view.remainingUsdMillis;
    const spend = spendUsdMillisFromRemaining({
      grantedUsdMillis: await grantedMillis(ports.ledger, athleteId),
      refundedUsdMillis: await refundedMillis(ports.ledger, athleteId),
      remainingUsdMillis: remaining,
    });
    const usage = usageTowardLot(lots, spend, purchase.transactionId);
    await lowerLimit(athleteId, athlete.keyHash, purchase.capUsdMillis, ports);
    await ports.ledger.markPurchaseRefunded(purchase.transactionId, nowIso(ports));
    if (usage !== undefined && (usage as number) > 0) {
      const next = { ...athlete, refundsAfterUse: athlete.refundsAfterUse + 1 };
      await ports.ledger.updateAthlete(next);
      if (next.refundsAfterUse >= ports.repeatRefundBanThreshold) {
        await handleBanCommand(
          athleteId,
          { kind: "ban", reason: "repeat_refund_after_use" },
          ports,
        );
      }
    }
    return;
  }
  await ports.ledger.markPurchaseRefunded(purchase.transactionId, nowIso(ports));
}

async function drainPendingRefund(
  athleteId: AthleteId,
  transactionId: TransactionId,
  ports: SessionPorts,
): Promise<void> {
  const pending = await ports.ledger.takePendingRefund(transactionId);
  if (!pending) return;
  const purchase = await ports.ledger.purchase(transactionId);
  if (!purchase) return;
  await applyRefundMoney(athleteId, purchase, ports);
}

async function handleClaimCommand(
  athleteId: AthleteId,
  command: Extract<AthleteCommand, { kind: "claim" }>,
  ports: SessionPorts,
): Promise<AthleteResult> {
  const purchase = command.purchase;
  if (purchase.athleteId !== athleteId) throw new DomainErr("identity_mismatch");
  await refuseIfBanned(athleteId, purchase.originalTransactionId, ports);
  const policy = await ports.ledger.currentPolicy();
  const pack = await ports.ledger.pack(purchase.productId, policy.version);
  if (!pack) throw new DomainErr("unknown_pack");

  const claimedAt = nowIso(ports);
  const inserted = await ports.ledger.insertPurchase({
    transactionId: purchase.transactionId,
    originalTransactionId: purchase.originalTransactionId,
    athleteId,
    productId: purchase.productId,
    environment: purchase.environment,
    capUsdMillis: pack.capUsdMillis,
    credits: pack.credits,
    policyVersion: policy.version,
    claimedAt,
    refundedAt: undefined,
  });
  if (inserted === "duplicate") return { kind: "claimAlreadyClaimed" };

  await ports.ledger.linkOriginalTransaction({
    originalTransactionId: purchase.originalTransactionId,
    athleteId,
  });

  const athlete = await ports.ledger.athlete(athleteId);
  let result: AthleteResult;
  if (!athlete) {
    const minted = await mintKey(athleteId, pack.capUsdMillis, ports);
    await ports.ledger.insertAthlete({
      athleteId,
      keyHash: minted.hash,
      keyGeneration: 1,
      disabled: false,
      refundsAfterUse: 0,
      createdAt: claimedAt,
    });
    result = { kind: "claimMinted", key: minted.key, creditsAdded: pack.credits };
  } else {
    await raiseLimit(athleteId, athlete.keyHash, pack.capUsdMillis, ports);
    result = { kind: "claimToppedUp", creditsAdded: pack.credits };
  }

  await ports.ledger.insertLot({
    lotId: ports.ids.lotId(),
    athleteId,
    source: "purchase",
    transactionId: purchase.transactionId,
    originalCapUsdMillis: pack.capUsdMillis,
    createdAt: claimedAt,
  });
  await drainPendingRefund(athleteId, purchase.transactionId, ports);
  return result;
}

async function handleRecoverCommand(
  athleteId: AthleteId,
  command: Extract<AthleteCommand, { kind: "recover" }>,
  ports: SessionPorts,
): Promise<AthleteResult> {
  const purchase = command.purchase;
  await refuseIfBanned(athleteId, purchase.originalTransactionId, ports);
  const known = await ports.ledger.purchase(purchase.transactionId);
  const linked = await ports.ledger.athleteByOriginalTransaction(purchase.originalTransactionId);
  if (!known || !linked) throw new DomainErr("no_purchase_to_recover");
  if (linked.athleteId !== athleteId) throw new DomainErr("identity_mismatch");

  const view = await ports.keys.get(linked.keyHash);
  const minted = await mintKey(athleteId, view.remainingUsdMillis, ports);
  await executeProviderMutation(
    athleteId,
    ports.ids.mutationId(),
    { kind: "setDisabled", hash: linked.keyHash, disabled: true },
    ports,
  );
  await ports.ledger.updateAthlete({
    ...linked,
    keyHash: minted.hash,
    keyGeneration: linked.keyGeneration + 1,
  });
  await executeProviderMutation(
    athleteId,
    ports.ids.mutationId(),
    { kind: "deleteKey", hash: linked.keyHash },
    ports,
  );
  const policy = await ports.ledger.currentPolicy();
  return {
    kind: "recovered",
    athleteId,
    key: minted.key,
    credits: creditsFromRemaining(view.remainingUsdMillis, policy.creditsPerUsd),
  };
}

async function handleRefundCommand(
  athleteId: AthleteId,
  command: Extract<AthleteCommand, { kind: "refund" }>,
  ports: SessionPorts,
): Promise<AthleteResult> {
  const purchase = await ports.ledger.purchase(command.transactionId);
  if (!purchase) {
    const inserted = await ports.ledger.insertNotification({
      notificationId: command.notificationId,
      type: "refund",
      transactionId: command.transactionId,
      processedAt: nowIso(ports),
      outcome: "pending_purchase",
    });
    if (inserted === "duplicate") return { kind: "refundDuplicate" };
    await ports.ledger.insertPendingRefund(command.transactionId, command.notificationId);
    return { kind: "refundPendingPurchase" };
  }
  const inserted = await ports.ledger.insertNotification({
    notificationId: command.notificationId,
    type: "refund",
    transactionId: command.transactionId,
    processedAt: nowIso(ports),
    outcome: "applied",
  });
  if (inserted === "duplicate") return { kind: "refundDuplicate" };
  if (purchase.refundedAt) {
    return { kind: "refundApplied", capRemoved: asUsdMillis(0) };
  }
  await applyRefundMoney(athleteId, purchase, ports);
  return { kind: "refundApplied", capRemoved: purchase.capUsdMillis };
}

async function handleRevokeCommand(
  athleteId: AthleteId,
  command: Extract<AthleteCommand, { kind: "revoke" }>,
  ports: SessionPorts,
): Promise<AthleteResult> {
  const purchase = await ports.ledger.purchase(command.transactionId);
  if (!purchase) {
    const inserted = await ports.ledger.insertNotification({
      notificationId: command.notificationId,
      type: "revoke",
      transactionId: command.transactionId,
      processedAt: nowIso(ports),
      outcome: "pending_purchase",
    });
    if (inserted === "duplicate") return { kind: "refundDuplicate" };
    await ports.ledger.insertPendingRefund(command.transactionId, command.notificationId);
    return { kind: "refundPendingPurchase" };
  }
  const inserted = await ports.ledger.insertNotification({
    notificationId: command.notificationId,
    type: "revoke",
    transactionId: command.transactionId,
    processedAt: nowIso(ports),
    outcome: "applied",
  });
  if (inserted === "duplicate") return { kind: "refundDuplicate" };
  if (!purchase.refundedAt) {
    await applyRefundMoney(athleteId, purchase, ports);
  }
  return { kind: "revoked" };
}

async function handleConsumptionCommand(
  athleteId: AthleteId,
  command: Extract<AthleteCommand, { kind: "consumptionRequest" }>,
  ports: SessionPorts,
): Promise<AthleteResult> {
  const inserted = await ports.ledger.insertNotification({
    notificationId: command.notificationId,
    type: "consumption_request",
    transactionId: command.transactionId,
    processedAt: nowIso(ports),
    outcome: "reported",
  });
  let openRouterReachable = true;
  let remaining = asUsdMillis(0);
  try {
    const athlete = await ports.ledger.athlete(athleteId);
    if (!athlete) {
      openRouterReachable = false;
    } else {
      const view = await ports.keys.get(athlete.keyHash);
      remaining = view.remainingUsdMillis;
    }
  } catch {
    openRouterReachable = false;
  }
  const lots = await ports.ledger.lotsOldestFirst(athleteId);
  const spend = spendUsdMillisFromRemaining({
    grantedUsdMillis: await grantedMillis(ports.ledger, athleteId),
    refundedUsdMillis: await refundedMillis(ports.ledger, athleteId),
    remainingUsdMillis: remaining,
  });
  const status = consumptionForTransaction(lots, spend, command.transactionId);
  const reported = reportedConsumption({
    reporting: ports.consumptionReporting,
    openRouterReachable,
    status,
  });
  if (inserted !== "duplicate") {
    await ports.apple.reportConsumption({
      transactionId: command.transactionId,
      status: reported,
      delivered: true,
    });
  }
  return { kind: "consumptionReported", status: reported };
}

async function handleBanCommand(
  athleteId: AthleteId,
  command: Extract<AthleteCommand, { kind: "ban" }>,
  ports: SessionPorts,
): Promise<AthleteResult> {
  const athlete = await ports.ledger.athlete(athleteId);
  if (athlete && !athlete.disabled) {
    await executeProviderMutation(
      athleteId,
      ports.ids.mutationId(),
      { kind: "setDisabled", hash: athlete.keyHash, disabled: true },
      ports,
    );
    await ports.ledger.updateAthlete({ ...athlete, disabled: true });
  }
  await ports.ledger.insertBan({
    athleteId,
    reason: command.reason,
    bannedAt: nowIso(ports),
  });
  const originals = await ports.ledger.linkedOriginals(athleteId);
  const history: PurchaseRecord["originalTransactionId"][] = [];
  for (const original of originals) {
    const ids = await ports.apple.getTransactionHistory(original);
    history.push(...ids);
  }
  if (history.length > 0) {
    await ports.ledger.banOriginals(history, athleteId);
  }
  return { kind: "banned" };
}

export type AthleteRuntime = {
  run(athleteId: AthleteId, command: AthleteCommand): Promise<AthleteResult>;
};

export function directRuntime(ports: SessionPorts): AthleteRuntime {
  const tails = new Map<string, Promise<unknown>>();
  return {
    async run(athleteId, command) {
      const prev = tails.get(athleteId) ?? Promise.resolve();
      let release: (value: unknown) => void = () => {};
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      tails.set(athleteId, prev.then(() => gate));
      try {
        await prev.catch(() => undefined);
        return await handleAthleteCommand(athleteId, command, ports);
      } finally {
        release(undefined);
      }
    },
  };
}

export async function encodeCommand(command: AthleteCommand): Promise<Request> {
  return new Request("https://athlete.session/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command),
  });
}

export async function decodeResult(response: Response): Promise<AthleteResult> {
  const body: unknown = await response.json();
  if (!response.ok) {
    if (
      body !== null &&
      typeof body === "object" &&
      "code" in body &&
      typeof (body as { code: unknown }).code === "string"
    ) {
      throw new DomainErr((body as { code: DomainErr["code"] }).code);
    }
    throw new DomainErr("unavailable");
  }
  return body as AthleteResult;
}

function sessionPortsFromEnv(env: Env): SessionPorts {
  return {
    ledger: new D1Ledger(env.DB),
    keys: new OpenRouterManagementClient(env.OPENROUTER_MANAGEMENT_KEY, {
      guardrailMode: env.GUARDRAIL_MODE,
      guardrailId: env.OPENROUTER_GUARDRAIL_ID,
      keyCountCeiling: env.KEY_COUNT_CEILING ? Number(env.KEY_COUNT_CEILING) : undefined,
    }),
    deviceCheck: new DeviceCheckClient(env),
    apple: new AppStoreServerClient(env),
    openRouter: {
      guardrailMode: env.GUARDRAIL_MODE,
      guardrailId: env.OPENROUTER_GUARDRAIL_ID,
      keyCountCeiling: env.KEY_COUNT_CEILING ? Number(env.KEY_COUNT_CEILING) : undefined,
    },
    clock: { now: () => new Date() },
    ids: {
      lotId: () => crypto.randomUUID() as LotId,
      grantId: () => crypto.randomUUID() as GrantId,
      mutationId: () => crypto.randomUUID() as ProviderMutationId,
    },
    purchasesEnabled: env.PURCHASES_ENABLED === "true",
    consumptionReporting: env.CONSUMPTION_REPORTING,
    bundleId: env.BUNDLE_ID,
    environment: env.APPLE_ENVIRONMENT,
    repeatRefundBanThreshold: Number(env.REPEAT_REFUND_BAN_THRESHOLD),
  };
}

export class AthleteSession {
  ports: SessionPorts | undefined;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    void this.ctx;
    const athleteId = athleteIdFromUuid(new URL(request.url).pathname.split("/").pop() ?? "");
    const command = (await request.json()) as AthleteCommand;
    const ports = this.ports ?? sessionPortsFromEnv(this.env);
    try {
      const result = await handleAthleteCommand(athleteId, command, ports);
      return Response.json(result);
    } catch (error) {
      if (error instanceof DomainErr) {
        const status =
          error.code === "banned" ? 403 : error.code === "rate_limited" ? 429 : error.code === "unavailable" ? 503 : 400;
        return Response.json({ code: error.code }, { status });
      }
      throw error;
    }
  }
}

export function rethrowDomain(error: unknown): never {
  if (error instanceof DomainErr) throw error;
  throw error;
}

export type { DomainError };
