export const TELEGRAM_SECURE_STORAGE_STAGES = [
  "namespace",
  "encryption-availability",
  "profile-atomic-write",
  "desired-state-write",
  "daemon-apply",
] as const;

export const TELEGRAM_SECURE_STORAGE_REASONS = [
  "encryption-unavailable",
  "unsafe-backend",
  "storage-failed",
  "storage-uncertain",
  "control-unavailable",
  "control-uncertain",
] as const;

export type TelegramSecureStorageStage = (typeof TELEGRAM_SECURE_STORAGE_STAGES)[number];
export type TelegramSecureStorageReason = (typeof TELEGRAM_SECURE_STORAGE_REASONS)[number];

export interface TelegramSecureStorageFailure {
  readonly stage: TelegramSecureStorageStage;
  readonly reason: TelegramSecureStorageReason;
}

export type TelegramSecureStorageObserver = (
  failure: TelegramSecureStorageFailure,
) => void | Promise<void>;

export function emitTelegramSecureStorageFailure(
  observer: TelegramSecureStorageObserver | undefined,
  failure: TelegramSecureStorageFailure,
): void {
  if (observer === undefined) return;
  try {
    const result = observer(failure);
    if (result !== undefined) void Promise.resolve(result).catch(() => undefined);
  } catch {}
}

export function createTelegramSecureStorageDiagnostics(
  write: (message: string) => unknown = (message) => process.stderr.write(message),
): TelegramSecureStorageObserver {
  return ({ stage, reason }) => {
    write(`desktop-telegram-secure-storage-failure ${stage} ${reason}\n`);
  };
}
