import type { WindowsPackageEvidence } from "./verify-windows-package.mjs";

export interface WindowsPackageInput {
  readonly desktopRoot?: string;
}

export interface WindowsPackageDeterminism {
  readonly artifactName: "desktop-version-and-x64";
  readonly inventory: "exact-paths-types-platform-and-staged-bytes";
  readonly artifactBytes: "electron-builder-timestamps-excluded";
}

export interface WindowsPackageBuilderOptions {
  readonly projectDir: string;
  readonly publish: "never";
  readonly win: readonly ["nsis:x64"];
  readonly config: {
    readonly extends: string;
    readonly appId: "icu.enduragent.desktop";
    readonly productName: "Enduragent";
    readonly artifactName: string;
    readonly directories: { readonly output: "dist/windows" };
    readonly forceCodeSigning: false;
    readonly extraMetadata: { readonly version: string };
    readonly win: {
      readonly icon: "resources/app-icon.ico";
      readonly signExecutable: false;
      readonly requestedExecutionLevel: "asInvoker";
      readonly files: readonly ["resources/tray.ico"];
      readonly target: readonly [{ readonly target: "nsis"; readonly arch: readonly ["x64"] }];
    };
    readonly nsis: {
      readonly artifactName: string;
      readonly guid: "80611707-2ddf-50e5-b3ec-95f38ab4a6fa";
      readonly oneClick: true;
      readonly perMachine: false;
      readonly packElevateHelper: false;
      readonly createStartMenuShortcut: true;
      readonly createDesktopShortcut: false;
      readonly deleteAppDataOnUninstall: false;
      readonly installerLanguages: readonly ["en_US"];
      readonly language: "1033";
      readonly multiLanguageInstaller: false;
      readonly displayLanguageSelector: false;
      readonly differentialPackage: false;
      readonly buildUniversalInstaller: false;
      readonly include: "build/installer.nsh";
    };
  };
}

export interface WindowsPackagePlan {
  readonly version: string;
  readonly artifactName: string;
  readonly artifactPath: string;
  readonly applicationPath: string;
  readonly executablePath: string;
  readonly outputPath: string;
  readonly platform: "win32";
  readonly arch: "x64";
  readonly target: "nsis";
  readonly signed: false;
  readonly distribution: "private-test-only";
  readonly updateEligible: false;
  readonly determinism: WindowsPackageDeterminism;
  readonly builderOptions: WindowsPackageBuilderOptions;
}

export interface WindowsPackageDependencies {
  readonly readFile?: (path: string, encoding: "utf8") => Promise<string>;
  readonly rm?: (
    path: string,
    options: { readonly recursive: true; readonly force: true },
  ) => Promise<void>;
  readonly build?: (options: WindowsPackageBuilderOptions) => Promise<readonly string[]>;
  readonly verifyWindowsPackage?: (
    artifactPath: string,
    applicationPath: string,
    options: { readonly desktopRoot: string },
  ) => Promise<WindowsPackageEvidence>;
  readonly reportStage?: (stage: WindowsPackageStage) => void;
}

export type WindowsPackageStage =
  | "package-plan"
  | "output-cleanup"
  | "electron-builder"
  | "artifact-set"
  | "package-verification";

export const WINDOWS_PACKAGE_APP_ID: "icu.enduragent.desktop";
export const WINDOWS_PACKAGE_PRODUCT_NAME: "Enduragent";
export const WINDOWS_PACKAGE_GUID: "80611707-2ddf-50e5-b3ec-95f38ab4a6fa";
export const WINDOWS_PACKAGE_OUTPUT_DIRECTORY: "dist/windows";
export const WINDOWS_PACKAGE_PLATFORM: "win32";
export const WINDOWS_PACKAGE_ARCH: "x64";
export const WINDOWS_PACKAGE_TARGET: "nsis";
export const WINDOWS_PACKAGE_INSTALLER_LANGUAGES: readonly string[];
export const WINDOWS_PACKAGE_DETERMINISM: WindowsPackageDeterminism;

export function requireWindowsDesktopVersion(value: unknown): string;

export function readWindowsDesktopVersion(
  input?: WindowsPackageInput,
  dependencies?: Pick<WindowsPackageDependencies, "readFile">,
): Promise<string>;

export function windowsPackageArtifactName(version: string): string;

export function createWindowsPackagePlan(
  input?: WindowsPackageInput,
  dependencies?: Pick<WindowsPackageDependencies, "readFile">,
): Promise<WindowsPackagePlan>;

export function runWindowsPackage(
  input?: WindowsPackageInput,
  dependencies?: WindowsPackageDependencies,
): Promise<{
  readonly artifacts: readonly string[];
  readonly evidence: WindowsPackageEvidence;
  readonly plan: WindowsPackagePlan;
}>;
