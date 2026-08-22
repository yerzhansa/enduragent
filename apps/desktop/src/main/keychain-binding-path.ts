import { isAbsolute, join } from "node:path";

export const KEYCHAIN_BINDING_FILE_NAME = "keychain-binding.node" as const;
export const KEYCHAIN_BINDING_ASAR_DIRECTORY = "native" as const;
export const KEYCHAIN_BINDING_DEVELOPMENT_DIRECTORY = "dist/keychain-binding" as const;

export interface KeychainBindingLocation {
  readonly platform: NodeJS.Platform;
  readonly packaged: boolean;
  readonly resourcesPath: string;
  readonly applicationPath: string;
}

export function resolveKeychainBindingPath(location: KeychainBindingLocation): string | undefined {
  if (location.platform !== "darwin") return undefined;
  const root = location.packaged
    ? join(location.resourcesPath, "app.asar.unpacked", KEYCHAIN_BINDING_ASAR_DIRECTORY)
    : join(location.applicationPath, KEYCHAIN_BINDING_DEVELOPMENT_DIRECTORY);
  if (!isAbsolute(root)) return undefined;
  return join(root, KEYCHAIN_BINDING_FILE_NAME);
}
