import type { AppStoreServerAPIClient, SignedDataVerifier } from "@apple/app-store-server-library";
import { Buffer } from "node:buffer";
import { sign } from "node:crypto";
import { DomainError, athleteIdFromUuid } from "./domain.js";
import roots from "./certificates/apple-roots.json" with { type: "json" };
import type {
  AthleteId,
  AppleEnvironment,
  DeviceBits,
  DeviceCheckToken,
  NotificationId,
  OriginalTransactionId,
  TransactionId,
  VerifiedPurchase,
  ConsumptionStatus,
} from "./domain.js";
import type { Env } from "./env.js";

export type AppleStore = {
  verifySignedTransaction(
    jws: string,
    expected: {
      bundleId: string;
      environment: AppleEnvironment;
    },
  ): Promise<VerifiedPurchase>;

  verifyNotification(
    signedPayload: string,
    expected: {
      bundleId: string;
      environment: AppleEnvironment;
    },
  ): Promise<AppleNotification>;

  getTransactionHistory(
    originalTransactionId: OriginalTransactionId,
  ): Promise<readonly OriginalTransactionId[]>;

  reportConsumption(input: {
    transactionId: TransactionId;
    status: ConsumptionStatus;
    delivered: boolean;
  }): Promise<void>;
};

export type AppleNotification =
  | {
      type: "refund";
      notificationId: NotificationId;
      transactionId: TransactionId;
      originalTransactionId: OriginalTransactionId;
      athleteId: AthleteId;
    }
  | {
      type: "revoke";
      notificationId: NotificationId;
      transactionId: TransactionId;
      originalTransactionId: OriginalTransactionId;
      athleteId: AthleteId;
    }
  | {
      type: "consumption_request";
      notificationId: NotificationId;
      transactionId: TransactionId;
      originalTransactionId: OriginalTransactionId;
      athleteId: AthleteId;
    }
  | { type: "ignored"; notificationId: NotificationId };

export type DeviceCheck = {
  query(token: DeviceCheckToken): Promise<DeviceBits>;
  update(token: DeviceCheckToken, bits: Partial<DeviceBits>): Promise<void>;
};

type AppleClients = {
  verifier: SignedDataVerifier;
  api?: Pick<AppStoreServerAPIClient, "getTransactionHistory">;
};

function loadAppleSdk() {
  return import("@apple/app-store-server-library");
}

async function appleError(error: unknown): Promise<DomainError> {
  if (error instanceof DomainError) return error;
  const { VerificationException, VerificationStatus } = await loadAppleSdk();
  if (error instanceof VerificationException) {
    if (error.status === VerificationStatus.RETRYABLE_VERIFICATION_FAILURE)
      return new DomainError("unavailable");
    if (error.status === VerificationStatus.INVALID_APP_IDENTIFIER)
      return new DomainError("not_our_bundle");
    if (error.status === VerificationStatus.INVALID_ENVIRONMENT)
      return new DomainError("wrong_environment");
    return new DomainError("identity_mismatch");
  }
  return new DomainError("unavailable");
}

export class AppStoreServerClient implements AppleStore {
  constructor(
    private readonly env: Env,
    private readonly clients?: AppleClients,
  ) {}

  private async verifier(expected: {
    bundleId: string;
    environment: AppleEnvironment;
  }): Promise<SignedDataVerifier> {
    if (expected.bundleId !== this.env.BUNDLE_ID) throw new DomainError("not_our_bundle");
    if (expected.environment !== this.env.APPLE_ENVIRONMENT)
      throw new DomainError("wrong_environment");
    if (this.clients) return this.clients.verifier;
    if (this.env.APPLE_ENVIRONMENT !== "sandbox") throw new DomainError("unavailable");
    const { Environment, SignedDataVerifier } = await loadAppleSdk();
    return new SignedDataVerifier(
      [Buffer.from(roots.G2, "base64"), Buffer.from(roots.G3, "base64")],
      true,
      Environment.SANDBOX,
      this.env.BUNDLE_ID,
    );
  }

  private async api(): Promise<Pick<AppStoreServerAPIClient, "getTransactionHistory">> {
    if (this.clients?.api) return this.clients.api;
    if (this.env.APPLE_ENVIRONMENT !== "sandbox") throw new DomainError("unavailable");
    const { AppStoreServerAPIClient, Environment } = await loadAppleSdk();
    return new AppStoreServerAPIClient(
      this.env.APPLE_APP_STORE_P8,
      this.env.APPLE_APP_STORE_KEY_ID,
      this.env.APPLE_APP_STORE_ISSUER_ID,
      this.env.BUNDLE_ID,
      Environment.SANDBOX,
    );
  }

  async verifySignedTransaction(
    jws: string,
    expected: { bundleId: string; environment: AppleEnvironment },
  ): Promise<VerifiedPurchase> {
    try {
      const verifier = await this.verifier(expected);
      const payload = await verifier.verifyAndDecodeTransaction(jws);
      if (payload.bundleId !== expected.bundleId) throw new DomainError("not_our_bundle");
      if (payload.environment !== (expected.environment === "sandbox" ? "Sandbox" : "Production"))
        throw new DomainError("wrong_environment");
      if (
        !payload.transactionId ||
        !payload.originalTransactionId ||
        typeof payload.appAccountToken !== "string"
      )
        throw new DomainError("identity_mismatch");
      if (
        typeof payload.productId !== "string" ||
        !/^[A-Za-z0-9._-]{1,255}$/.test(payload.productId)
      )
        throw new DomainError("unknown_pack");
      if (
        !Number.isSafeInteger(payload.price) ||
        (payload.price ?? -1) < 0 ||
        typeof payload.currency !== "string" ||
        !/^[A-Z]{3}$/.test(payload.currency)
      )
        throw new DomainError("identity_mismatch");
      return {
        transactionId: payload.transactionId as TransactionId,
        originalTransactionId: payload.originalTransactionId as OriginalTransactionId,
        productId: payload.productId as VerifiedPurchase["productId"],
        bundleId: expected.bundleId,
        environment: expected.environment,
        athleteId: athleteIdFromUuid(payload.appAccountToken),
        priceMillis: payload.price ?? 0,
        currency: payload.currency,
      };
    } catch (error) {
      throw await appleError(error);
    }
  }

  async verifyNotification(
    signedPayload: string,
    expected: { bundleId: string; environment: AppleEnvironment },
  ): Promise<AppleNotification> {
    try {
      const verifier = await this.verifier(expected);
      const notification = await verifier.verifyAndDecodeNotification(signedPayload);
      if (!notification.notificationUUID) throw new DomainError("identity_mismatch");
      const notificationId = notification.notificationUUID as NotificationId;
      const type =
        notification.notificationType === "REFUND"
          ? "refund"
          : notification.notificationType === "REVOKE"
            ? "revoke"
            : notification.notificationType === "CONSUMPTION_REQUEST"
              ? "consumption_request"
              : "ignored";
      if (type === "ignored") return { type, notificationId };
      if (!notification.data?.signedTransactionInfo) throw new DomainError("identity_mismatch");
      const purchase = await this.verifySignedTransaction(
        notification.data.signedTransactionInfo,
        expected,
      );
      return {
        type,
        notificationId,
        transactionId: purchase.transactionId,
        originalTransactionId: purchase.originalTransactionId,
        athleteId: purchase.athleteId,
      };
    } catch (error) {
      throw await appleError(error);
    }
  }

  async getTransactionHistory(
    originalTransactionId: OriginalTransactionId,
  ): Promise<readonly OriginalTransactionId[]> {
    try {
      const api = await this.api();
      const { GetTransactionHistoryVersion } = await loadAppleSdk();
      const originals = new Set<OriginalTransactionId>();
      const revisions = new Set<string>();
      let revision: string | null = null;
      for (;;) {
        const page = await api.getTransactionHistory(
          originalTransactionId,
          revision,
          {},
          GetTransactionHistoryVersion.V2,
        );
        if (!Array.isArray(page.signedTransactions) || typeof page.hasMore !== "boolean")
          throw new DomainError("unavailable");
        for (const jws of page.signedTransactions) {
          const transaction = await this.verifySignedTransaction(jws, {
            bundleId: this.env.BUNDLE_ID,
            environment: this.env.APPLE_ENVIRONMENT,
          });
          originals.add(transaction.originalTransactionId);
        }
        if (!page.hasMore) return [...originals];
        if (!page.revision || revisions.has(page.revision)) throw new DomainError("unavailable");
        revisions.add(page.revision);
        revision = page.revision;
      }
    } catch (error) {
      throw await appleError(error);
    }
  }

  async reportConsumption(input: Parameters<AppleStore["reportConsumption"]>[0]): Promise<void> {
    if (input.status === "undeclared" || this.env.CONSUMPTION_REPORTING !== "enabled") return;
    throw new DomainError("unavailable");
  }
}

export class DeviceCheckClient implements DeviceCheck {
  constructor(private readonly env: Env) {}

  private async request(
    token: DeviceCheckToken,
    operation: "query_two_bits" | "update_two_bits",
    bits?: DeviceBits,
  ): Promise<Response> {
    try {
      if (
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(token) ||
        token.length === 0
      )
        throw new DomainError("identity_mismatch");
      if (this.env.APPLE_ENVIRONMENT !== "sandbox") throw new DomainError("unavailable");
      const issued = Math.floor(Date.now() / 1000);
      const header = Buffer.from(
        JSON.stringify({ alg: "ES256", kid: this.env.APPLE_DEVICECHECK_KEY_ID, typ: "JWT" }),
      ).toString("base64url");
      const payload = Buffer.from(
        JSON.stringify({ iss: this.env.APPLE_DEVICECHECK_TEAM_ID, iat: issued }),
      ).toString("base64url");
      const data = `${header}.${payload}`;
      const signature = sign("sha256", Buffer.from(data), {
        key: this.env.APPLE_DEVICECHECK_P8,
        dsaEncoding: "ieee-p1363",
      }).toString("base64url");
      const response = await fetch(
        `https://api.development.devicecheck.apple.com/v1/${operation}`,
        {
          method: "POST",
          redirect: "error",
          headers: {
            authorization: `Bearer ${data}.${signature}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            device_token: token,
            transaction_id: crypto.randomUUID(),
            timestamp: Date.now(),
            ...(bits?.grantClaimed ? { bit0: true } : {}),
            ...(bits?.banned ? { bit1: true } : {}),
          }),
        },
      );
      if (!response.ok) throw new DomainError("unavailable");
      return response;
    } catch (error) {
      throw await appleError(error);
    }
  }

  async query(token: DeviceCheckToken): Promise<DeviceBits> {
    const response = await this.request(token, "query_two_bits");
    const text = await response.text();
    if (text === "Failed to find bit state") return { grantClaimed: false, banned: false };
    try {
      const value: unknown = JSON.parse(text);
      if (
        !value ||
        typeof value !== "object" ||
        !("bit0" in value) ||
        !("bit1" in value) ||
        typeof value.bit0 !== "boolean" ||
        typeof value.bit1 !== "boolean"
      )
        throw new DomainError("unavailable");
      return { grantClaimed: value.bit0, banned: value.bit1 };
    } catch {
      throw new DomainError("unavailable");
    }
  }
  async update(token: DeviceCheckToken, bits: Partial<DeviceBits>): Promise<void> {
    const existing = await this.query(token);
    await this.request(token, "update_two_bits", {
      grantClaimed: existing.grantClaimed || bits.grantClaimed === true,
      banned: existing.banned || bits.banned === true,
    });
  }
}
