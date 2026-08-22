import { createRequire } from "node:module";

export const KEYCHAIN_BINDING_OPERATIONS = [
  "probe",
  "read-key",
  "create-key",
  "delete-key",
] as const;

export const KEYCHAIN_BINDING_ERROR_CODES = [
  "not-team-signed",
  "item-not-found",
  "keychain-locked",
  "duplicate-item",
  "unreadable-item",
  "uninspectable-item",
  "unknown",
] as const;

export type KeychainBindingOperation = (typeof KEYCHAIN_BINDING_OPERATIONS)[number];
export type KeychainBindingErrorCode = (typeof KEYCHAIN_BINDING_ERROR_CODES)[number];

export const KEYCHAIN_CREDENTIAL_SERVICE = "icu.enduragent.desktop" as const;
export const KEYCHAIN_CREDENTIAL_SERVICE_DEV = "icu.enduragent.desktop.dev" as const;
export const KEYCHAIN_CREDENTIAL_ACCOUNT = "credential-encryption-key-v1" as const;
export const KEYCHAIN_TEAM_IDENTIFIER = "FA494ACVTF" as const;
export const KEYCHAIN_KEY_BYTES = 32;

export interface KeychainBindingRequest {
  readonly op: KeychainBindingOperation;
  readonly service: string;
}

export type KeychainBindingResponse =
  | {
      readonly ok: true;
      readonly op: "probe";
      readonly teamIdentifier: string;
    }
  | {
      readonly ok: true;
      readonly op: "read-key" | "create-key";
      readonly key: Buffer;
    }
  | {
      readonly ok: true;
      readonly op: "delete-key";
      readonly deleted: boolean;
    }
  | {
      readonly ok: false;
      readonly code: KeychainBindingErrorCode;
    };

export interface KeychainBindingTransport {
  send(request: KeychainBindingRequest): Promise<KeychainBindingResponse>;
}

interface NativeKeychainBinding {
  probe(): unknown;
  readKey(service: string): unknown;
  createKey(service: string): unknown;
  deleteKey(service: string): unknown;
}

export type KeychainBindingLoader = (bindingPath: string) => unknown;

export interface KeychainBindingTransportOptions {
  readonly bindingPath: string;
  readonly loadBinding?: KeychainBindingLoader;
}

const UNKNOWN_RESPONSE: KeychainBindingResponse = Object.freeze({ ok: false, code: "unknown" });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrorCode(value: unknown): value is KeychainBindingErrorCode {
  return (
    typeof value === "string" && (KEYCHAIN_BINDING_ERROR_CODES as readonly string[]).includes(value)
  );
}

function nativeBinding(value: unknown): NativeKeychainBinding | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.probe !== "function" ||
    typeof value.readKey !== "function" ||
    typeof value.createKey !== "function" ||
    typeof value.deleteKey !== "function"
  ) {
    return undefined;
  }
  return value as unknown as NativeKeychainBinding;
}

export function parseKeychainBindingResponse(
  operation: KeychainBindingOperation,
  value: unknown,
): KeychainBindingResponse {
  if (!isRecord(value)) return UNKNOWN_RESPONSE;
  if (value.ok === false) {
    return isErrorCode(value.code) ? { ok: false, code: value.code } : UNKNOWN_RESPONSE;
  }
  if (value.ok !== true) return UNKNOWN_RESPONSE;
  if (operation === "probe") {
    return value.teamIdentifier === KEYCHAIN_TEAM_IDENTIFIER
      ? { ok: true, op: "probe", teamIdentifier: value.teamIdentifier }
      : UNKNOWN_RESPONSE;
  }
  if (operation === "read-key" || operation === "create-key") {
    return Buffer.isBuffer(value.key) && value.key.length === KEYCHAIN_KEY_BYTES
      ? { ok: true, op: operation, key: Buffer.from(value.key) }
      : UNKNOWN_RESPONSE;
  }
  return typeof value.deleted === "boolean"
    ? { ok: true, op: "delete-key", deleted: value.deleted }
    : UNKNOWN_RESPONSE;
}

export function createKeychainBindingTransport(
  options: KeychainBindingTransportOptions,
): KeychainBindingTransport {
  let binding: NativeKeychainBinding | undefined;
  try {
    const load =
      options.loadBinding ??
      ((bindingPath: string): unknown => createRequire(import.meta.url)(bindingPath));
    binding = nativeBinding(load(options.bindingPath));
  } catch {}
  return {
    async send(request: KeychainBindingRequest): Promise<KeychainBindingResponse> {
      if (binding === undefined) return UNKNOWN_RESPONSE;
      try {
        const response =
          request.op === "probe"
            ? binding.probe()
            : request.op === "read-key"
              ? binding.readKey(request.service)
              : request.op === "create-key"
                ? binding.createKey(request.service)
                : binding.deleteKey(request.service);
        return parseKeychainBindingResponse(request.op, response);
      } catch {
        return UNKNOWN_RESPONSE;
      }
    },
  };
}
