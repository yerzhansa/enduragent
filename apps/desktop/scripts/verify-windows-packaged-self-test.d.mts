export interface PackagedSecondLaunchResult {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessExitSource {
  once(event: "error", listener: (error: Error) => void): unknown;
  once(
    event: "exit",
    listener: (code: number | null, signal: string | null) => void,
  ): unknown;
}

export interface ProcessExitResult {
  readonly code: number | null;
  readonly signal: string | null;
}

export function observeProcessExit(child: ProcessExitSource): Promise<ProcessExitResult>;

export function createWindowsSecurityControlPipeName(candidate: string): string;

export interface WindowsSecurityControlPipe {
  readonly connection: Promise<PackagedShutdownInput>;
  close(): Promise<void>;
}

export function createWindowsSecurityControlPipe(
  pipeName: string,
  create?: (...args: readonly unknown[]) => unknown,
): Promise<WindowsSecurityControlPipe>;

export interface WindowsScratchRemoveOptions {
  readonly recursive: true;
  readonly force: true;
  readonly maxRetries: 10;
  readonly retryDelay: 100;
}

export function removeWindowsScratch(
  path: string,
  remove?: (path: string, options: WindowsScratchRemoveOptions) => Promise<void>,
): Promise<void>;

export function throwPackagedCompletionFailures(
  bodyFailure: unknown,
  cleanupFailures: readonly ("process" | "control-pipe" | "scratch")[],
): void;

export type SecuritySmokeShutdownStage =
  | "stdin-accepted"
  | "residency-closed"
  | "ipc-closed"
  | "telegram-power-closed"
  | "telegram-coordinator-closed"
  | "daemon-closed"
  | "exit-requested";

export const SECURITY_SMOKE_SHUTDOWN_STAGES: readonly SecuritySmokeShutdownStage[];

export interface SecuritySmokeStageObserver {
  write(chunk: string | Buffer): void;
  lastStage(): SecuritySmokeShutdownStage | "none";
  readonly failure: Promise<Error>;
  readonly terminal: Promise<"exit-requested">;
}

export function createSecuritySmokeStageObserver(): SecuritySmokeStageObserver;

export interface PrimarySecondInstanceObserver {
  write(chunk: string | Buffer): void;
  isAcknowledged(): boolean;
  readonly acknowledgment: Promise<void>;
  readonly failure: Promise<Error>;
}

export function createPrimarySecondInstanceObserver(): PrimarySecondInstanceObserver;

export interface PrimaryAcknowledgmentFailureObserver {
  write(chunk: string | Buffer): void;
  readonly failure: Promise<Error>;
}

export function createPrimaryAcknowledgmentFailureObserver(): PrimaryAcknowledgmentFailureObserver;

export function formatSafeProcessTerminal(result: ProcessExitResult): string;

export function waitForPackagedSecondLaunchEvidence(input: {
  readonly second: Promise<PackagedSecondLaunchResult>;
  readonly primaryAcknowledgment: Promise<void>;
  readonly primaryAcknowledgmentEvidenceFailure: Promise<Error>;
  readonly primaryAcknowledgmentWriteFailure: Promise<Error>;
  readonly primaryAcknowledged: () => boolean;
  readonly primaryExited: Promise<ProcessExitResult>;
  readonly deadline: number;
}): Promise<PackagedSecondLaunchResult>;

export interface PackagedShutdownInput {
  readonly destroyed: boolean;
  readonly writable: boolean;
  once(event: "error", listener: () => void): unknown;
  removeListener(event: "error", listener: () => void): unknown;
  end(chunk: string, callback: (error?: Error | null) => void): unknown;
}

export function requestPackagedShutdown(input: PackagedShutdownInput | undefined): Promise<void>;

export function waitForPackagedApplicationExit(
  running: {
    readonly child: { readonly stdin: PackagedShutdownInput | undefined };
    readonly shutdownInput?: PackagedShutdownInput;
    readonly exited: Promise<ProcessExitResult>;
    readonly stages: SecuritySmokeStageObserver;
  },
  timeoutMilliseconds?: number,
): Promise<ProcessExitResult>;

export interface PackagedSelfTestTerminal {
  readonly type: "self-test-terminal";
  readonly ok: true;
  readonly runtime: {
    readonly node: string;
    readonly electron: "44.4.3";
  };
  readonly suites: {
    readonly parity: { readonly cases: number; readonly passed: number };
    readonly differential: { readonly cases: number; readonly passed: number };
  };
}

export function validateSelfTestTerminal(value: unknown): PackagedSelfTestTerminal;

export interface PackagedReadyFrame {
  readonly url: "enduragent://app/index.html";
  readonly rpcUrl: string;
  readonly hasSingleInstanceLock: true;
  readonly visibleForSecondLaunch: true;
  readonly bridgeKeys: readonly unknown[];
  readonly noNodeGlobals: true;
  readonly rpcConnected: true;
  readonly blockedOffPort: true;
  readonly rendererSurface: "app" | "setup-gate";
  readonly credentialStatusesMetadataOnly: true;
  readonly tokenAbsentInRendererSurfaces: true;
}

export function validateReadyFrame(value: unknown): PackagedReadyFrame;

export function requireRunningPrimaryBeforeSecondLaunch(child: {
  readonly exitCode: number | null;
  readonly signalCode: string | null;
}): void;

export function validatePackagedSecondLaunch(
  result: PackagedSecondLaunchResult,
  privateValues: readonly string[],
): PackagedSecondLaunchResult;
