export type WindowsReleaseMode = "genesis" | "steady";

export interface WindowsReleaseArtifactNames {
  readonly installer: string;
  readonly blockmap: string;
  readonly metadata: "latest.yml";
}

export interface WindowsReleaseUpdaterMetadata {
  readonly provider: "generic";
  readonly url: string;
  readonly channel: "latest";
  readonly useMultipleRangeRequest: false;
  readonly updaterCacheDirName: "@enduragentdesktop-updater";
  readonly publisherName?: string;
}

export interface WindowsReleaseInput {
  readonly version: string;
  readonly commit: string;
  readonly feedUrl: string;
  readonly mode: WindowsReleaseMode;
  readonly baselineVersion?: string;
  readonly repositoryRoot?: string;
  readonly desktopRoot?: string;
  readonly publisherDn?: string;
}

export interface WindowsReleaseBuilderOptions {
  readonly projectDir: string;
  readonly publish: "never";
  readonly win: readonly ["nsis:x64"];
  readonly config: {
    readonly extends: string;
    readonly artifactName: string;
    readonly forceCodeSigning: true;
    readonly extraMetadata: {
      readonly version: string;
      readonly enduragentDesktopRelease: true;
    };
    readonly publish: readonly [
      {
        readonly provider: "generic";
        readonly url: string;
        readonly channel: "latest";
        readonly useMultipleRangeRequest: false;
      },
    ];
    readonly win: {
      readonly signtoolOptions: { readonly publisherName: readonly [string] };
      readonly signExecutable: true;
      readonly verifyUpdateCodeSignature: true;
      readonly legalTrademarks: string;
      readonly target: readonly [{ readonly target: "nsis"; readonly arch: readonly ["x64"] }];
    };
    readonly nsis: {
      readonly artifactName: string;
      readonly differentialPackage: true;
    };
  };
}

export interface WindowsReleasePlan {
  readonly version: string;
  readonly commit: string;
  readonly tag: string;
  readonly platform: "win32";
  readonly arch: "x64";
  readonly mode: WindowsReleaseMode;
  readonly baselineVersion: string | null;
  readonly feedUrl: string;
  readonly publisherDn: string;
  readonly publisherDnIsPlaceholder: boolean;
  readonly artifactNames: WindowsReleaseArtifactNames;
  readonly assetNames: readonly string[];
  readonly updaterMetadata: WindowsReleaseUpdaterMetadata;
  readonly updaterMetadataSha256: string;
  readonly authenticode: "pending-w19";
  readonly builderOptions: WindowsReleaseBuilderOptions;
}

export const WINDOWS_RELEASE_ARCH: "x64";
export const WINDOWS_RELEASE_PLATFORM: "win32";
export const WINDOWS_RELEASE_METADATA_NAME: "latest.yml";
export const WINDOWS_AUTHENTICODE_PENDING: "pending-w19";
export const WINDOWS_PUBLISHER_DN_PLACEHOLDER: "CN=ENDURAGENT PUBLISHER DN PLACEHOLDER, O=PLACEHOLDER";
export const WINDOWS_RELEASE_PROVENANCE_PREFIX: "enduragent-release-commit:";
export const WINDOWS_UPDATER_PUBLISHER_PREFIX: "enduragent-updater-publisher-sha256:";
export const WINDOWS_UPDATER_METADATA_PREFIX: "enduragent-updater-metadata-sha256:";
export interface WindowsReleaseProvenance {
  readonly commit: string;
  readonly publisherSha256: string;
  readonly updaterMetadataSha256: string;
}
export function windowsUpdaterPublisherDigest(publisherDn: string): string;
export function serializeWindowsReleaseUpdaterMetadata(
  feedUrl: string,
  publisherDn: string,
): Buffer;
export function windowsUpdaterMetadataDigest(bytes: string | Uint8Array): string;
export function windowsReleaseProvenance(
  commit: string,
  publisherDn: string,
  updaterMetadataSha256: string,
): string;
export function parseWindowsReleaseProvenance(value: unknown): WindowsReleaseProvenance | null;
export function safeWindowsReleasePlanMessage(error: unknown): string | undefined;
export function requireReleaseCommit(value: unknown): string;
export function windowsReleaseArtifactNames(version: string): WindowsReleaseArtifactNames;
export function windowsReleaseAssetNames(version: string): readonly string[];
export function assertKnownWindowsReleaseAssets(
  names: readonly string[],
  version: string,
): readonly string[];
export function parseWindowsReleaseUpdaterMetadata(
  bytes: string | Uint8Array,
  options?: { readonly expectedPublisherName?: string },
): WindowsReleaseUpdaterMetadata;
export function readWindowsReleaseVersion(
  options?: { readonly repositoryRoot?: string; readonly desktopRoot?: string },
  dependencies?: {
    readonly readFile?: (path: string, encoding: "utf8") => Promise<string>;
  },
): Promise<string>;
export function createWindowsReleasePlan(input: WindowsReleaseInput): WindowsReleasePlan;
