export interface WindowsStoreIdentity {
  readonly identityName: string;
  readonly publisher: string;
  readonly publisherDisplayName: string;
}

export interface WindowsStorePackageInput {
  readonly desktopRoot?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export interface WindowsStorePackageBuilderOptions {
  readonly projectDir: string;
  readonly publish: "never";
  readonly win: readonly ["appx:x64"];
  readonly config: {
    readonly extends: string;
    readonly appId: "icu.enduragent.desktop";
    readonly productName: "Enduragent";
    readonly artifactName: string;
    readonly directories: { readonly output: "dist/windows-store" };
    readonly forceCodeSigning: false;
    readonly extraMetadata: { readonly version: string; readonly enduragentDesktopRelease: true };
    readonly win: {
      readonly icon: "resources/app-icon.ico";
      readonly signExecutable: false;
      readonly requestedExecutionLevel: "asInvoker";
      readonly files: readonly ["resources/tray.ico"];
      readonly target: readonly [{ readonly target: "appx"; readonly arch: readonly ["x64"] }];
    };
    readonly appx: {
      readonly artifactName: string;
      readonly applicationId: "Enduragent";
      readonly identityName: string;
      readonly publisher: string;
      readonly publisherDisplayName: string;
      readonly displayName: "Enduragent";
      readonly languages: readonly string[];
      readonly backgroundColor: "transparent";
      readonly showNameOnTiles: false;
      readonly addAutoLaunchExtension: false;
      readonly capabilities: readonly ["runFullTrust"];
      readonly electronUpdaterAware: false;
      readonly setBuildNumber: false;
      readonly minVersion: "10.0.19041.0";
      readonly maxVersionTested: "10.0.26100.0";
    };
  };
}

export interface WindowsStorePackagePlan {
  readonly applicationPath: string;
  readonly executablePath: string;
  readonly outputPath: string;
  readonly version: string;
  readonly identity: WindowsStoreIdentity;
  readonly artifactName: string;
  readonly artifactPath: string;
  readonly platform: "win32";
  readonly arch: "x64";
  readonly target: "appx";
  readonly signed: false;
  readonly distribution: "microsoft-store-submission";
  readonly updateEligible: false;
  readonly builderOptions: WindowsStorePackageBuilderOptions;
}

export interface WindowsStorePackageDependencies {
  readonly readFile?: (path: string, encoding: "utf8") => Promise<string>;
  readonly rm?: (path: string, options: { recursive: true; force: true }) => Promise<void>;
  readonly build?: (options: WindowsStorePackageBuilderOptions) => Promise<string[]>;
  readonly stat?: (path: string) => Promise<{ isFile(): boolean; readonly size: number }>;
  readonly reportStage?: (stage: string) => void;
}

export const WINDOWS_STORE_PACKAGE_OUTPUT_DIRECTORY: "dist/windows-store";
export const WINDOWS_STORE_PACKAGE_PLATFORM: "win32";
export const WINDOWS_STORE_PACKAGE_ARCH: "x64";
export const WINDOWS_STORE_PACKAGE_TARGET: "appx";
export const WINDOWS_STORE_PACKAGE_APPLICATION_ID: "Enduragent";
export const WINDOWS_STORE_PACKAGE_LANGUAGES: readonly ["en-US"];
export const WINDOWS_STORE_PACKAGE_MIN_VERSION: "10.0.19041.0";
export const WINDOWS_STORE_PACKAGE_MAX_VERSION_TESTED: "10.0.26100.0";
export const WINDOWS_STORE_IDENTITY_ENVIRONMENT: {
  readonly identityName: "ENDURAGENT_STORE_IDENTITY_NAME";
  readonly publisher: "ENDURAGENT_STORE_PUBLISHER";
  readonly publisherDisplayName: "ENDURAGENT_STORE_PUBLISHER_DISPLAY_NAME";
};
export function safeWindowsStorePackageMessage(error: unknown): string | undefined;
export function readWindowsStoreIdentity(
  environment?: Readonly<Record<string, string | undefined>>,
): WindowsStoreIdentity;
export function windowsStorePackageArtifactName(version: string): string;
export function createWindowsStorePackagePlan(
  input?: WindowsStorePackageInput,
  dependencies?: Pick<WindowsStorePackageDependencies, "readFile">,
): Promise<WindowsStorePackagePlan>;
export function runWindowsStorePackage(
  input?: WindowsStorePackageInput,
  dependencies?: WindowsStorePackageDependencies,
): Promise<{ readonly artifacts: readonly string[]; readonly plan: WindowsStorePackagePlan }>;
