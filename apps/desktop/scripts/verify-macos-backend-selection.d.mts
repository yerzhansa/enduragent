export declare const BACKEND_SELECTION_SERVICE: "icu.enduragent.desktop";
export declare const BACKEND_SELECTION_TEAM_IDENTIFIER: "FA494ACVTF";
export declare const BACKEND_SELECTION_BACKEND: "keychain_partition_v1";
export declare const BACKEND_SELECTION_PROBE_TIMEOUT_MS: 15000;
export declare const BACKEND_SELECTION_MAX_RESPONSE_BYTES: 8192;
export declare const BACKEND_SELECTION_OUTPUT_PREFIX: "ENDURAGENT_KEYCHAIN_BINDING_PROBE ";

export interface VerifiedMacosBackendSelection {
  readonly binding: string;
  readonly service: typeof BACKEND_SELECTION_SERVICE;
  readonly backend: typeof BACKEND_SELECTION_BACKEND;
  readonly teamIdentifier: typeof BACKEND_SELECTION_TEAM_IDENTIFIER;
  readonly designatedRequirement: string;
}

export interface VerifyMacosBackendSelectionOverrides {
  readonly executeFile?: (executable: string, arguments_: readonly string[]) => Promise<unknown>;
  readonly requireBinding?: (bindingPath: string) => Promise<void>;
  readonly verifyKeychainBinding?: (application: string) => Promise<unknown>;
  readonly runApplication?: (
    executable: string,
    userData: string,
  ) => Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>;
  readonly mkdtemp?: (prefix: string) => Promise<string>;
  readonly rm?: (
    path: string,
    options: { readonly recursive: true; readonly force: true },
  ) => Promise<void>;
}

export declare function safeMacosBackendSelectionMessage(error: unknown): string | undefined;

export declare function verifyMacosBackendSelection(
  application: string,
  overrides?: VerifyMacosBackendSelectionOverrides,
): Promise<VerifiedMacosBackendSelection>;
