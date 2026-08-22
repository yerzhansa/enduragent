import type { Stats } from "node:fs";
import type { ReleaseArtifactNames } from "./macos-release-plan.mjs";

export interface VerifiedMacosReleaseArtifacts {
  readonly version: string;
  readonly names: ReleaseArtifactNames;
  readonly paths: {
    readonly dmg: string;
    readonly zip: string;
    readonly blockmap: string;
    readonly metadata: string;
  };
  readonly sizes: {
    readonly dmg: number;
    readonly zip: number;
    readonly blockmap: number;
  };
  readonly dmgSha512: string;
  readonly zipSha512: string;
}

export interface VerifyMacosReleaseOptions {
  readonly repositoryRoot?: string;
  readonly readVersionFile?: (path: string, encoding: "utf8") => Promise<string>;
}

export interface VerifyMacosReleaseDependencies {
  readonly executeFile?: (executable: string, arguments_: readonly string[]) => Promise<unknown>;
  readonly lstat?: (path: string) => Promise<Stats>;
  readonly mkdtemp?: (prefix: string) => Promise<string>;
  readonly readFile?: (path: string) => Promise<Buffer>;
  readonly readdir?: (path: string) => Promise<string[]>;
  readonly rm?: (
    path: string,
    options: { readonly recursive: true; readonly force: true },
  ) => Promise<void>;
  readonly tmpdir?: () => string;
  readonly buildBlockMap?: (
    inputPath: string,
    compression: "gzip",
    outputPath: string,
  ) => Promise<unknown>;
  readonly verifySignature?: (artifacts: VerifiedMacosReleaseArtifacts) => Promise<void>;
  readonly verifyNotarization?: (artifacts: VerifiedMacosReleaseArtifacts) => Promise<void>;
}

export interface VerifyMacosIdentityContinuityOptions {
  readonly candidateVersion: string;
}

export interface VerifyMacosIdentityContinuityDependencies {
  readonly executeFile?: (executable: string, arguments_: readonly string[]) => Promise<unknown>;
  readonly extractAsarFile?: (archivePath: string, filename: string) => Buffer | Promise<Buffer>;
  readonly lstat?: (path: string) => Promise<Stats>;
  readonly mkdtemp?: (prefix: string) => Promise<string>;
  readonly realpath?: (path: string) => Promise<string>;
  readonly rm?: (
    path: string,
    options: { readonly recursive: true; readonly force: true },
  ) => Promise<void>;
  readonly statAsarFile?: (archivePath: string, filename: string, followLinks: false) => unknown;
  readonly tmpdir?: () => string;
  readonly uncacheAsar?: (archivePath: string) => boolean;
}

export interface VerifiedMacosIdentityContinuity {
  readonly baselineVersion: string;
  readonly candidateVersion: string;
  readonly teamIdentifier: string;
  readonly candidateCodeIdentity: MacosCodeIdentity;
}

export interface VerifiedMacosBaselineApplication {
  readonly baselineVersion: string;
  readonly teamIdentifier: string;
}

export interface MacosCodeIdentity {
  readonly codeDirectory: string;
  readonly codeDirectorySha256: string;
  readonly cdHash: string;
}

export interface VerifiedMacosReleaseApplication {
  readonly version: string;
  readonly enduragentDesktopRelease: true;
  readonly feedUrl: string;
  readonly bundleIdentifier: "icu.enduragent.desktop";
  readonly teamIdentifier: "FA494ACVTF";
  readonly designatedRequirementSha256: string;
  readonly codeDirectorySha256: string;
  readonly cdHash: string;
}

export interface InspectMacosReleaseApplicationDependencies extends VerifyMacosIdentityContinuityDependencies {
  readonly readFile?: (path: string) => Promise<Buffer>;
}

export interface VerifyMacosReleaseApplicationContentsOptions {
  readonly candidateVersion: string;
  readonly looseCandidateCodeIdentity: MacosCodeIdentity;
}

export interface VerifyMacosReleaseApplicationContentsDependencies extends VerifyMacosIdentityContinuityDependencies {
  readonly mkdir?: (path: string, options: { readonly mode: 0o700 }) => Promise<unknown>;
  readonly readFile?: (path: string) => Promise<Buffer>;
  readonly readlink?: (path: string) => Promise<string>;
  readonly readdir?: (path: string) => Promise<string[]>;
  readonly rmdir?: (path: string) => Promise<void>;
  readonly writeFile?: (
    path: string,
    data: string,
    options: { readonly flag: "wx"; readonly mode: 0o600 },
  ) => Promise<unknown>;
  readonly verifyIdentityContinuity?: typeof verifyMacosIdentityContinuity;
}

export interface VerifyMacosReleaseEnvelopeDependencies
  extends VerifyMacosReleaseDependencies, VerifyMacosReleaseApplicationContentsDependencies {
  readonly verifyReleaseArtifacts?: typeof verifyMacosReleaseArtifacts;
  readonly verifyReleaseApplicationContents?: typeof verifyMacosReleaseApplicationContents;
}

export interface VerifiedMacosReleaseEnvelope {
  readonly artifacts: VerifiedMacosReleaseArtifacts;
  readonly identityContinuity: VerifiedMacosIdentityContinuity;
}

export function safeMacosReleaseVerificationMessage(error: unknown): string | undefined;

export interface VerifiedMacosKeychainBinding {
  readonly binding: string;
  readonly identifier: string;
  readonly teamIdentifier: string;
  readonly designatedRequirement: string;
  readonly imageIdentity: import("./package-inventory.mjs").MachoExecutableIdentity;
}

export function verifyMacosKeychainBinding(
  application: string,
  dependencies?: Pick<VerifyMacosReleaseDependencies, "executeFile"> & {
    readonly inspectBindingImage?: (
      binding: string,
    ) => Promise<import("./package-inventory.mjs").MachoExecutableIdentity>;
  },
): Promise<VerifiedMacosKeychainBinding>;
export function verifyMacosApplication(
  application: string,
  dependencies?: Pick<VerifyMacosReleaseDependencies, "executeFile">,
): Promise<void>;
export function verifyMacosDmg(
  dmgPath: string,
  dependencies?: Pick<VerifyMacosReleaseDependencies, "executeFile">,
): Promise<void>;
export function verifyMacosIdentityContinuity(
  baselineApplication: string,
  candidateApplication: string,
  options: VerifyMacosIdentityContinuityOptions,
  dependencies?: VerifyMacosIdentityContinuityDependencies,
): Promise<VerifiedMacosIdentityContinuity>;
export function verifyMacosBaselineApplication(
  baselineApplication: string,
  options: VerifyMacosIdentityContinuityOptions,
  dependencies?: VerifyMacosIdentityContinuityDependencies,
): Promise<VerifiedMacosBaselineApplication>;
export function inspectMacosReleaseApplication(
  application: string,
  dependencies?: InspectMacosReleaseApplicationDependencies,
): Promise<VerifiedMacosReleaseApplication>;
export function verifyMacosReleaseApplicationContents(
  artifactDirectory: string,
  baselineApplication: string,
  options: VerifyMacosReleaseApplicationContentsOptions,
  dependencies?: VerifyMacosReleaseApplicationContentsDependencies,
): Promise<void>;
export function verifyMacosReleaseArtifacts(
  artifactDirectory: string,
  options?: VerifyMacosReleaseOptions,
  dependencies?: VerifyMacosReleaseDependencies,
): Promise<VerifiedMacosReleaseArtifacts>;
export function verifyMacosReleaseEnvelope(
  artifactDirectory: string,
  baselineApplication: string,
  looseCandidateApplication: string,
  options?: VerifyMacosReleaseOptions,
  dependencies?: VerifyMacosReleaseEnvelopeDependencies,
): Promise<VerifiedMacosReleaseEnvelope>;
