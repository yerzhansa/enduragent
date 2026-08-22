import type { NotarizeOptions } from "@electron/notarize";
import type {
  VerifiedMacosBaselineApplication,
  VerifiedMacosIdentityContinuity,
  VerifiedMacosReleaseArtifacts,
  VerifyMacosReleaseApplicationContentsOptions,
} from "./verify-macos-release.mjs";

export interface ReleaseArtifactNames {
  readonly dmg: string;
  readonly zip: string;
  readonly blockmap: string;
  readonly metadata: "latest-mac.yml";
}

export interface MacosReleaseUpdaterMetadata {
  readonly provider: "generic";
  readonly url: string;
  readonly channel: "latest";
  readonly updaterCacheDirName: "@enduragentdesktop-updater";
}

export interface MacosReleaseInput {
  readonly feedUrl: string | undefined;
  readonly identity: string | undefined;
  readonly baselineApplication: string | undefined;
  readonly repositoryRoot?: string;
  readonly desktopRoot?: string;
}

export interface MacosReleaseBuilderOptions {
  readonly projectDir: string;
  readonly publish: "never";
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
      },
    ];
    readonly mac: {
      readonly target: readonly [
        { readonly target: "dmg"; readonly arch: readonly ["arm64"] },
        { readonly target: "zip"; readonly arch: readonly ["arm64"] },
      ];
      readonly identity: string;
      readonly hardenedRuntime: true;
      readonly gatekeeperAssess: false;
      readonly entitlements: "build/entitlements.mac.plist";
      readonly entitlementsInherit: "build/entitlements.mac.plist";
      readonly notarize: true;
    };
    readonly dmg: {
      readonly sign: true;
      readonly writeUpdateInfo: false;
    };
  };
}

export interface MacosReleasePlan {
  readonly version: string;
  readonly feedUrl: string;
  readonly baselineApplication: string;
  readonly artifactNames: ReleaseArtifactNames;
  readonly builderOptions: MacosReleaseBuilderOptions;
}

export type NotarizationCredentialSelection =
  | {
      readonly name: "apple-id";
      readonly options: {
        readonly appleId: string;
        readonly appleIdPassword: string;
        readonly teamId: string;
      };
    }
  | {
      readonly name: "api-key";
      readonly options: {
        readonly appleApiKey: string;
        readonly appleApiKeyId: string;
        readonly appleApiIssuer: string;
      };
    }
  | {
      readonly name: "keychain-profile";
      readonly options: {
        readonly keychainProfile: string;
        readonly keychain?: string;
      };
    };

export type MacosReleaseStage =
  | "release-plan"
  | "notarization-credentials"
  | "baseline-verification"
  | "keychain-binding-preparation"
  | "electron-builder"
  | "package-layout"
  | "keychain-binding"
  | "electron-fuses"
  | "candidate-verification"
  | "identity-continuity"
  | "backend-selection"
  | "dmg-notarization"
  | "dmg-verification"
  | "metadata-sealing"
  | "envelope-promotion";

export interface MacosReleaseDependencies {
  readonly reportStage?: (stage: MacosReleaseStage) => void;
  readonly readFile?: (path: string, encoding: "utf8") => Promise<string>;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly build?: (options: MacosReleaseBuilderOptions) => Promise<readonly string[]>;
  readonly prepareKeychainBinding?: (desktopRoot: string) => Promise<unknown>;
  readonly executeFile?: (executable: string, arguments_: readonly string[]) => Promise<unknown>;
  readonly notarize?: (options: NotarizeOptions) => Promise<void>;
  readonly sealReleaseMetadata?: (plan: MacosReleasePlan) => Promise<void>;
  readonly verifyPackageLayout?: (
    application: string,
    options: {
      readonly desktopRoot: string;
      readonly release: {
        readonly version: string;
        readonly feedUrl: string;
      };
    },
  ) => Promise<void>;
  readonly verifyBaselineApplication?: (
    baselineApplication: string,
    options: { readonly candidateVersion: string },
  ) => Promise<VerifiedMacosBaselineApplication>;
  readonly verifyKeychainBinding?: (candidateApplication: string) => Promise<unknown>;
  readonly verifyElectronFuses?: (executable: string) => Promise<unknown>;
  readonly verifyBackendSelection?: (candidateApplication: string) => Promise<unknown>;
  readonly verifyIdentityContinuity?: (
    baselineApplication: string,
    candidateApplication: string,
    options: { readonly candidateVersion: string },
  ) => Promise<VerifiedMacosIdentityContinuity>;
  readonly verifyDmg?: (dmgPath: string) => Promise<void>;
  readonly promoteReleaseEnvelope?: (
    plan: MacosReleasePlan,
    verifyEnvelope: (artifactDirectory: string) => Promise<unknown>,
  ) => Promise<string>;
  readonly verifyReleaseArtifacts?: (
    artifactDirectory: string,
    options: {
      readonly repositoryRoot: string;
      readonly readVersionFile?: (path: string, encoding: "utf8") => Promise<string>;
    },
    dependencies: {
      readonly executeFile?: (
        executable: string,
        arguments_: readonly string[],
      ) => Promise<unknown>;
    },
  ) => Promise<VerifiedMacosReleaseArtifacts>;
  readonly verifyReleaseApplicationContents?: (
    artifactDirectory: string,
    baselineApplication: string,
    options: VerifyMacosReleaseApplicationContentsOptions,
    dependencies: {
      readonly executeFile?: (
        executable: string,
        arguments_: readonly string[],
      ) => Promise<unknown>;
    },
  ) => Promise<void>;
}

export interface PromoteMacosReleaseEnvelopeDependencies {
  readonly rename?: (oldPath: string, newPath: string) => Promise<void>;
}

export const DESKTOP_UPDATER_CACHE_DIRECTORY: "@enduragentdesktop-updater";
export function safeMacosReleasePlanMessage(error: unknown): string | undefined;
export function requireNotarizationCredentials(
  environment?: Readonly<Record<string, string | undefined>>,
): NotarizationCredentialSelection;
export function requireStableSemVer(value: unknown): string;
export function requireGenericFeedUrl(value: unknown): string;
export function parseMacosReleaseUpdaterMetadata(
  value: string | Uint8Array,
): MacosReleaseUpdaterMetadata;
export function requireDeveloperIdIdentity(value: unknown): string;
export function requireMacosBaselineApplication(value: unknown): string;
export function releaseArtifactNames(version: string): ReleaseArtifactNames;
export function readDesktopVersion(options?: {
  readonly repositoryRoot?: string;
  readonly desktopRoot?: string;
  readonly readFile?: (path: string, encoding: "utf8") => Promise<string>;
}): Promise<string>;
export function createMacosReleasePlan(
  input: MacosReleaseInput,
  dependencies?: Pick<MacosReleaseDependencies, "readFile">,
): Promise<MacosReleasePlan>;
export function sealMacosReleaseMetadata(plan: MacosReleasePlan): Promise<void>;
export function macosReleaseEnvelopePath(plan: MacosReleasePlan): string;
export function promoteMacosReleaseEnvelope(
  plan: MacosReleasePlan,
  verifyEnvelope: (artifactDirectory: string) => Promise<unknown>,
  dependencies?: PromoteMacosReleaseEnvelopeDependencies,
): Promise<string>;
export function notarizeMacosDmg(
  dmgPath: string,
  credentials: NotarizationCredentialSelection,
  dependencies?: Pick<MacosReleaseDependencies, "notarize">,
): Promise<void>;
export function prepareMacosReleaseKeychainBinding(
  desktopRoot: string,
): Promise<{
  readonly built: string;
  readonly staged: string;
}>;
export function runMacosRelease(
  input: MacosReleaseInput,
  dependencies?: MacosReleaseDependencies,
): Promise<{
  readonly plan: MacosReleasePlan;
  readonly artifacts: readonly string[];
  readonly envelopePath: string;
}>;
