export const TELEGRAM_ACCEPTANCE_APP_ID: "icu.enduragent.desktop.telegram-acceptance";
export const TELEGRAM_ACCEPTANCE_PACKAGE_NAME: "enduragent-desktop-telegram-acceptance";
export const TELEGRAM_ACCEPTANCE_PRODUCT_NAME: "Enduragent Telegram Acceptance";
export const TELEGRAM_ACCEPTANCE_MARKER: "enduragentDesktopTelegramAcceptance";
export const TELEGRAM_ACCEPTANCE_ENTITLEMENTS: Readonly<{
  readonly "com.apple.security.cs.allow-jit": true;
}>;

export function configureTelegramAcceptanceSigningEnvironment(
  environment: Record<string, string | undefined>,
): void;
export function createTelegramAcceptanceBuilderConfiguration(
  canonical: Record<string, unknown>,
): Record<string, unknown>;
export function verifyTelegramAcceptanceSignature(description: unknown): string;
export function verifyTelegramAcceptanceNestedSignature(description: unknown): void;
export function verifyTelegramAcceptanceInfoPlist(value: unknown): void;
export function verifyTelegramAcceptanceEntitlements(value: unknown): void;
export function verifyTelegramAcceptanceNestedEntitlements(value: unknown): void;
export function verifyTelegramAcceptanceNestedListing(description: unknown): Readonly<{
  executable: string;
  nested: readonly string[];
}>;
export function selectTelegramAcceptanceNestedTarget(
  applicationRoot: unknown,
  candidates: unknown,
): string;
export function verifyTelegramAcceptanceDesignatedRequirement(
  value: unknown,
  expectedCdHash: unknown,
): void;
export function verifyTelegramAcceptanceManifest(value: unknown, expectedVersion: unknown): void;
export function verifyTelegramAcceptanceWorkspaceRuntime(
  rootManifest: unknown,
  archiveEntries: unknown,
  readManifest: unknown,
): Readonly<{
  packages: readonly string[];
  exportTargets: readonly string[];
}>;
export function verifyTelegramAcceptanceMainEntry(
  value: unknown,
  readRoute?: (path: string) => string,
): string;

export function verifyOAuthAcceptanceRoute(value: unknown): void;
