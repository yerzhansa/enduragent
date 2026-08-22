export const KEYCHAIN_BINDING_FILE: "keychain-binding.node";
export const KEYCHAIN_BINDING_BUILD_DIRECTORY: "dist/keychain-binding";
export const KEYCHAIN_BINDING_SOURCE: "native/keychain-binding/keychain-binding.mm";
export const KEYCHAIN_BINDING_PARTITION_DESCRIPTION_SOURCE: "native/keychain-binding/partition-description.mm";
export const KEYCHAIN_BINDING_MINIMUM_MACOS: "12.0";
export const KEYCHAIN_BINDING_NAPI_VERSION: "9";
export const KEYCHAIN_BINDING_COMPILE_TIMEOUT_MS: 300000;

export function keychainBindingBuildPath(desktopRoot?: string): string;
export function nodeApiIncludeDirectory(): Promise<string>;
export function keychainBindingCompilerAvailable(): boolean;
export function buildKeychainBinding(desktopRoot?: string): Promise<string | undefined>;
export function copyKeychainBindingToAsarStaging(
  desktopRoot: string,
  asarRoot: string,
): Promise<string | undefined>;
