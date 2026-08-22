export interface DevelopmentPackageInput {
  readonly desktopRoot?: string;
}

export interface DevelopmentPackageBuilderOptions {
  readonly projectDir: string;
  readonly publish: "never";
  readonly config: {
    readonly extends: string;
    readonly appId: "icu.enduragent.desktop.development";
    readonly productName: "Enduragent Development";
    readonly directories: {
      readonly output: "dist/development";
    };
    readonly forceCodeSigning: false;
    readonly extraMetadata: {
      readonly name: "enduragent-desktop-development";
      readonly enduragentDesktopDevelopment: true;
    };
    readonly mac: {
      readonly identity: "-";
      readonly hardenedRuntime: false;
      readonly target: readonly [{ readonly target: "dir"; readonly arch: readonly ["arm64"] }];
    };
  };
}

export interface DevelopmentPackagePlan {
  readonly applicationPath: string;
  readonly executablePath: string;
  readonly outputPath: string;
  readonly builderOptions: DevelopmentPackageBuilderOptions;
}

export interface DevelopmentPackageDependencies {
  readonly rm?: (
    path: string,
    options: { readonly recursive: true; readonly force: true },
  ) => Promise<void>;
  readonly build?: (options: DevelopmentPackageBuilderOptions) => Promise<readonly string[]>;
  readonly verifyPackageLayout?: (
    application: string,
    options: { readonly desktopRoot: string; readonly development: true },
  ) => Promise<void>;
}

export const DEVELOPMENT_APP_ID: "icu.enduragent.desktop.development";
export const DEVELOPMENT_PRODUCT_NAME: "Enduragent Development";
export const DEVELOPMENT_PACKAGE_NAME: "enduragent-desktop-development";
export const DEVELOPMENT_OUTPUT_DIRECTORY: "dist/development";

export function createDevelopmentPackagePlan(
  input?: DevelopmentPackageInput,
): DevelopmentPackagePlan;

export function runDevelopmentPackage(
  input?: DevelopmentPackageInput,
  dependencies?: DevelopmentPackageDependencies,
): Promise<{
  readonly artifacts: readonly string[];
  readonly plan: DevelopmentPackagePlan;
}>;
