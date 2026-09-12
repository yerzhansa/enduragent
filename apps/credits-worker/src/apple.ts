import type {
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
    }
  | {
      type: "revoke";
      notificationId: NotificationId;
      transactionId: TransactionId;
      originalTransactionId: OriginalTransactionId;
    }
  | {
      type: "consumption_request";
      notificationId: NotificationId;
      transactionId: TransactionId;
      originalTransactionId: OriginalTransactionId;
    }
  | { type: "ignored"; notificationId: NotificationId };

export type DeviceCheck = {
  query(token: DeviceCheckToken): Promise<DeviceBits>;
  update(token: DeviceCheckToken, bits: Partial<DeviceBits>): Promise<void>;
};

export class AppStoreServerClient implements AppleStore {
  constructor(private readonly env: Env) {}
  verifySignedTransaction(
    _jws: string,
    _expected: { bundleId: string; environment: AppleEnvironment },
  ): Promise<VerifiedPurchase> {
    throw new Error("not implemented");
  }
  verifyNotification(
    _signedPayload: string,
    _expected: { bundleId: string; environment: AppleEnvironment },
  ): Promise<AppleNotification> {
    throw new Error("not implemented");
  }
  getTransactionHistory(
    _originalTransactionId: OriginalTransactionId,
  ): Promise<readonly OriginalTransactionId[]> {
    throw new Error("not implemented");
  }
  reportConsumption(_input: {
    transactionId: TransactionId;
    status: ConsumptionStatus;
    delivered: boolean;
  }): Promise<void> {
    throw new Error("not implemented");
  }
}

export class DeviceCheckClient implements DeviceCheck {
  constructor(private readonly env: Env) {}
  query(_token: DeviceCheckToken): Promise<DeviceBits> {
    throw new Error("not implemented");
  }
  update(_token: DeviceCheckToken, _bits: Partial<DeviceBits>): Promise<void> {
    throw new Error("not implemented");
  }
}
