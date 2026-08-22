import type { Stats } from "node:fs";

export { contained } from "./package-plan.mjs";

export const KEYCHAIN_BINDING_ASAR_PATH: "native/keychain-binding.node";
export const KEYCHAIN_BINDING_ASAR_UNPACK_PATTERN: "dist/self-test-asar/native/keychain-binding.node";
export const KEYCHAIN_BINDING_FUSE_CONFIGURATION: Readonly<{
  readonly runAsNode: false;
  readonly enableNodeOptionsEnvironmentVariable: false;
  readonly enableNodeCliInspectArguments: false;
  readonly enableEmbeddedAsarIntegrityValidation: true;
  readonly onlyLoadAppFromAsar: true;
}>;

export interface BuilderAuthority {
  readonly asarSourceRoot: string;
  readonly externalSourceRoot: string;
}

export interface BuilderInventoryAuthorityOptions {
  readonly validateEnvelopeAuthority?: (
    configuration: Readonly<Record<string, unknown>>,
  ) => boolean;
  readonly hasEnvelopeExtraFiles?: (configuration: Readonly<Record<string, unknown>>) => boolean;
}

export interface PackageDirectoryEntry {
  readonly type: "directory";
}

export interface PackageFileEntry {
  readonly type: "file";
  readonly bytes: Buffer;
}

export type PackageTreeEntry = PackageDirectoryEntry | PackageFileEntry;

export interface AsarDirectoryEntry {
  readonly type: "directory";
  readonly unpacked: boolean;
}

export interface AsarFileEntry {
  readonly type: "file";
  readonly unpacked: boolean;
  readonly bytes?: Buffer;
}

export type AsarTreeEntry = AsarDirectoryEntry | AsarFileEntry;

export interface AsarLabels {
  readonly archiveLabel: string;
  readonly entryLabelRoot: string;
}

export interface UnpackedTreeLabels {
  readonly root: string;
  readonly entries: string;
}

export interface ManifestValidationOptions {
  readonly macos?: boolean;
  readonly development?: boolean;
  readonly developmentPackageName?: string;
  readonly release?: {
    readonly version: string;
  };
}

export interface MachoExecutableIdentity {
  readonly cpuType: number;
  readonly cpuSubtype: number;
  readonly fileType: number;
  readonly uuid: string;
  readonly contentSha256: string;
}

export interface StagedTreeComparisonOptions {
  readonly signedExecutables?: readonly string[];
}

export class PackageLayoutError extends Error {}

export function fail(message: string, path?: string): never;

export function exactObject(value: unknown): value is Record<string, unknown>;

export function safeLstat(path: string, label: string): Promise<Stats>;

export function safeReadFile(path: string, label: string): Promise<Buffer>;

export function safeReadDirectory(path: string, label: string): Promise<string[]>;

export function assertRegularFile(stat: Stats, label: string): void;

export function assertDirectory(stat: Stats, label: string): void;

export function validateRelativePath(path: string, label: string): string;

export function forbiddenPathReason(path: string): string | undefined;

export function inspectPath(path: string, label: string): void;

export function inspectContents(bytes: Buffer, label: string): void;

export function outputChild(
  desktopRoot: string,
  outputRoot: string,
  source: string,
  label: string,
): string;

export function readBuilderConfiguration(desktopRoot: string): Promise<unknown>;

export function validateBuilderInventoryAuthority(
  config: unknown,
  desktopRoot: string,
  options?: BuilderInventoryAuthorityOptions,
): BuilderAuthority;

export function collectTree(
  root: string,
  labelRoot: string,
  scan: boolean,
): Promise<Map<string, PackageTreeEntry>>;

export function collectAsar(archivePath: string, options: AsarLabels): Map<string, AsarTreeEntry>;

export function validateUnpackedTree(
  unpackedRoot: string,
  asar: ReadonlyMap<string, AsarTreeEntry>,
  present: boolean,
  labels: UnpackedTreeLabels,
): Promise<void>;

export function machoExecutableIdentity(bytes: Buffer, label: string): MachoExecutableIdentity;
export function machoBundleIdentity(bytes: Buffer, label: string): MachoExecutableIdentity;

export function compareStagedTree(
  expected: ReadonlyMap<string, PackageTreeEntry>,
  actual: ReadonlyMap<string, PackageTreeEntry>,
  actualRoot: string,
  options?: StagedTreeComparisonOptions,
): void;

export function compareAsarStaging(
  expected: ReadonlyMap<string, PackageTreeEntry>,
  asar: ReadonlyMap<string, AsarTreeEntry>,
): void;

export function parseManifest(bytes: Buffer, label: string): Record<string, unknown>;

export function validateManifest(
  asar: ReadonlyMap<string, AsarTreeEntry>,
  sourceBytes: Buffer,
  options?: ManifestValidationOptions,
): void;

export function validateRequiredAsarFiles(
  asar: ReadonlyMap<string, AsarTreeEntry>,
  sourceManifest: Buffer,
  options?: ManifestValidationOptions,
): void;

export function assertNoReservedResourceNames(
  tree: ReadonlyMap<string, PackageTreeEntry>,
  reservedNames: ReadonlySet<string>,
  label: string,
): Set<string>;

export function assertExactResourceNames(
  names: readonly string[],
  expected: ReadonlySet<string>,
  label: string,
): void;
