#!/usr/bin/env node
import {
  assertCliOAuthHome,
  DesktopOwnedOAuthHomeError,
  type OAuthCredentialOwner,
} from "@enduragent/core";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  DaemonOwnerSchema,
  EXIT_AGENT_ERROR,
  EXIT_DAEMON_UNAVAILABLE,
  EXIT_NOT_CONFIGURED,
  EXIT_SUCCESS,
  EXIT_USAGE,
  EXIT_VERSION_MISMATCH,
  PROTOCOL_VERSION,
  ServerHandshakeFrameSchema,
  type AcceptedServerHandshakeFrame,
  type AthleteHomeIdentity,
  type DaemonOwner,
  type ExitCode,
  type RendererCapability,
  type ServerHandshakeFrame,
} from "@enduragent/coach-contract";
import {
  CoachCliSessionStartError,
  CoachRemoteError,
  InvalidCoachCliSessionError,
  connectCoachSelfTestClient,
  connectCoachVerbTransport,
  connectWithBoundedRetry,
  createCoachVerbRequest,
  createLocalCoachVerbTransport,
  parseCoachCliInvocation,
  resolveCoachCliSession,
  runCoachRepl,
  runCoachDaemonCommand,
  runCoachSelfTest,
  runCoachVerb,
  type CoachDaemonController,
  type CoachCliTerminal,
  type CoachCliVerbInvocation,
  type CoachRemoteFailure,
  type CoachVerbRequest,
  type CoachVerbTransport,
  type DaemonServiceSnapshot,
  type ServiceRegistrationState,
} from "@enduragent/coach-cli";
import {
  prepareAthleteHome,
  resolveAthleteHome,
  type AthleteHome,
} from "@enduragent/kernel-node/home";
import { PORT_FILE_NAME, type PeerHealthyOutcome } from "@enduragent/kernel-node/lock";
import {
  createLaunchdServiceIdentity,
  installLaunchdService,
  readLaunchdServiceStatus,
  restartLaunchdService,
  restartLaunchdServiceForUpgrade,
  resumeLaunchdService,
  resumeLaunchdServiceAfterEphemeral,
  type LaunchdServiceStatus,
} from "@enduragent/kernel-node/service";
import { StoreNewerThanAppError } from "@enduragent/kernel/store";
import {
  classifyPeerReadOnly,
  observePeerHandshake,
  openAuthenticatedDaemonControl,
  resolveSecondStarter as resolveSecondStarterProduction,
  type CompatiblePeerWaitOutcome,
  type DesignatedSuccessorInput,
  type ReadOnlyPeerClassification,
  type ResolveSecondStarterDependencies,
  type ResolveSecondStarterInput,
  type ServiceUpgradePort,
  type StarterResolution,
  type WriterReleaseWaitOutcome,
} from "./daemon/handshake.js";
import {
  acquireUpgradeFence,
  admitStartupThroughUpgradeFence,
  type MonotonicTimer,
  type UpgradeFenceHandle,
} from "./daemon/upgrade-fence.js";
import {
  withLocalCoach,
  type LocalCoachRunResult,
  type WithLocalCoachInput,
} from "./local-runner.js";
import type { ReadinessFailureStatus } from "./readiness.js";
export type { ReadinessFailureStatus } from "./readiness.js";
import { serializeBoundaryError } from "./daemon/error-boundary.js";
import { readDesktopRegistration, type DesktopRegistrationResult } from "./desktop-registration.js";
import { CoachStoreWriterError } from "./runtime.js";
import { runCoachServe } from "./serve.js";

const ENDURAGENT_APP_VERSION_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function isEnduragentAppVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && ENDURAGENT_APP_VERSION_RE.test(value);
}

export interface RunEnduragentInput {
  readonly oauthOwner?: OAuthCredentialOwner;
  readonly argv: readonly string[];
  readonly env: Record<string, string | undefined>;
  readonly terminal: CoachCliTerminal;
  readonly signal: AbortSignal;
}

export interface EnduragentDependencies {
  readonly resolveAthleteHome: (env: Record<string, string | undefined>) => AthleteHome;
  readonly prepareAthleteHome?: typeof prepareAthleteHome;
  readonly withLocalCoach: <T>(input: WithLocalCoachInput<T>) => Promise<LocalCoachRunResult<T>>;
  readonly readPackageVersion: () => Promise<string>;
  readonly connectRemoteTransport?: (
    home: AthleteHome,
    expectedPort?: number,
  ) => Promise<CoachVerbTransport>;
  readonly connectSelfTestClient?: (
    home: AthleteHome,
    expectedPort?: number,
  ) => ReturnType<typeof connectCoachSelfTestClient>;
  readonly serviceRegistrationState?: () => Promise<ServiceRegistrationState>;
  readonly startEphemeralDaemon?: (input: {
    readonly env: Record<string, string | undefined>;
    readonly home: AthleteHome;
    readonly executablePath?: string;
  }) => Promise<{
    readonly disposeAfterFailedStart: () => Promise<void>;
    readonly detachAfterHealthy: () => void;
  }>;
  readonly delay?: (ms: number) => Promise<void>;
  readonly monotonicNow?: () => number;
  readonly createFreshId?: () => string;
  readonly resolveExecutablePath?: () => Promise<string>;
  readonly createDaemonController?: (input: {
    readonly home: AthleteHome;
    readonly executablePath: string;
  }) => CoachDaemonController;
  readonly readServiceStatus?: (input: {
    readonly home: AthleteHome;
    readonly executablePath: string;
  }) => Promise<LaunchdServiceStatus>;
  readonly createLaunchdServiceIdentity?: typeof createLaunchdServiceIdentity;
  readonly resumeService?: (input: {
    readonly home: AthleteHome;
    readonly executablePath: string;
  }) => Promise<"resumed" | "not-installed">;
  readonly observeDaemonState?: (input: {
    readonly home: AthleteHome;
  }) => Promise<DaemonStateObservation>;
  readonly startEphemeralSuccessor?: (input: DesignatedSuccessorInput) => Promise<void>;
  readonly resolveSecondStarter?: (
    input: ResolveSecondStarterInput,
    dependencies: ResolveSecondStarterDependencies,
  ) => Promise<StarterResolution>;
  readonly platform?: NodeJS.Platform;
}

export type ServiceRegistrationClass = "absent" | "registered" | "unknown";

function desktopRegistrationClass(result: DesktopRegistrationResult): ServiceRegistrationClass {
  return result.registration === "present" ? "registered" : result.registration;
}

export interface AppSupervisedChildHandle {
  readonly pid: number;
  readonly exited: Promise<{
    readonly exitCode: number | null;
    readonly readinessFailure?: ReadinessFailureStatus;
  }>;
  isAlive(): boolean;
  stop(): Promise<void>;
}

export interface DesktopDaemonStartBudget {
  remainingAttempts: number;
  readonly deadline: number;
}

export class AppSupervisedDaemonStartError extends Error {
  constructor(readonly cause: "spawn-failed" | "termination-failed") {
    super(`app-supervised daemon ${cause}`);
    this.name = "AppSupervisedDaemonStartError";
  }
}

export interface StartAppSupervisedDaemonInput {
  readonly home: AthleteHome;
  readonly handoffCapability?: string;
}

export interface AuthenticatedDaemonObservation {
  readonly peer: PeerHealthyOutcome;
  readonly coordinates: {
    readonly port: number;
    readonly token: string;
  };
  readonly handshake: ServerHandshakeFrame;
}

export type DaemonStateObservation =
  | {
      readonly kind: "compatible-healthy";
      readonly peer: {
        readonly pid: number | null;
        readonly port: number;
        readonly peerVersion: string;
      };
      readonly serverProtocolVersion: number;
      readonly authenticated: AuthenticatedDaemonObservation & {
        readonly handshake: AcceptedServerHandshakeFrame;
      };
    }
  | { readonly kind: "absent" }
  | { readonly kind: "bound-unresponsive" }
  | { readonly kind: "foreign" }
  | { readonly kind: "auth-invalid" }
  | {
      readonly kind: "version-mismatch";
      readonly failure: Extract<CoachRemoteFailure, { kind: "version-mismatch" }>;
      readonly authenticated: AuthenticatedDaemonObservation;
    };

export type PeerAvailabilityClass = DaemonStateObservation["kind"];

export type ServiceAwareAutoStartDecision =
  | "attach"
  | "resume-service-then-attach"
  | "spawn-ephemeral"
  | "refuse-daemon-unavailable";

export function decideServiceAwareAutoStart(input: {
  readonly registration: ServiceRegistrationClass;
  readonly peer: PeerAvailabilityClass;
}): ServiceAwareAutoStartDecision {
  if (input.peer === "compatible-healthy") return "attach";
  if (input.registration === "registered" && input.peer === "absent") {
    return "resume-service-then-attach";
  }
  if (input.registration === "absent" && input.peer === "absent") {
    return "spawn-ephemeral";
  }
  return "refuse-daemon-unavailable";
}

async function readPackageVersion(): Promise<string> {
  const raw = await readFile(new URL("../package.json", import.meta.url), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object") {
    throw new TypeError("invalid package metadata");
  }
  const version = (parsed as { readonly version?: unknown }).version;
  if (typeof version !== "string" || version.length === 0) {
    throw new TypeError("invalid package version");
  }
  return version;
}

interface DaemonCoordinates {
  readonly port: number;
  readonly token: string;
}

async function readDaemonCoordinates(home: AthleteHome): Promise<DaemonCoordinates> {
  const [rawPort, rawToken] = await Promise.all([
    readFile(join(home.configDir, PORT_FILE_NAME), "utf8"),
    readFile(join(home.configDir, "daemon.token"), "utf8"),
  ]);
  const port = Number(rawPort.trim());
  const token = rawToken.endsWith("\n") ? rawToken.slice(0, -1) : "";
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new TypeError("invalid daemon coordinates");
  }
  return { port, token };
}

export interface ObserveDaemonStateDependencies {
  readonly classifyPeerReadOnly: typeof classifyPeerReadOnly;
  readonly observePeerHandshake: typeof observePeerHandshake;
  readonly readDaemonCoordinates: (home: AthleteHome) => Promise<DaemonCoordinates>;
}

const observeDaemonStateDependencies: ObserveDaemonStateDependencies = {
  classifyPeerReadOnly,
  observePeerHandshake,
  readDaemonCoordinates,
};

export async function observeDaemonState(
  input: { readonly home: AthleteHome },
  dependencies: ObserveDaemonStateDependencies = observeDaemonStateDependencies,
): Promise<DaemonStateObservation> {
  let classified: ReadOnlyPeerClassification;
  try {
    classified = await dependencies.classifyPeerReadOnly(input.home);
  } catch {
    return { kind: "auth-invalid" };
  }
  if (classified.status === "writer-clear") return { kind: "absent" };
  if (classified.status === "bound-unresponsive") return { kind: "bound-unresponsive" };
  if (classified.status === "foreign-port") return { kind: "foreign" };
  try {
    const coordinates = await dependencies.readDaemonCoordinates(input.home);
    if (coordinates.port !== classified.peer.port) return { kind: "auth-invalid" };
    const { token } = coordinates;
    const frame = ServerHandshakeFrameSchema.parse(
      await dependencies.observePeerHandshake({
        port: classified.peer.port,
        token,
        clientProtocolVersion: PROTOCOL_VERSION,
      }),
    );
    if (frame.clientProtocolVersion !== PROTOCOL_VERSION) {
      return { kind: "auth-invalid" };
    }
    if (
      frame.status === "accepted" &&
      frame.clientProtocolVersion === PROTOCOL_VERSION &&
      frame.serverProtocolVersion === PROTOCOL_VERSION &&
      frame.athleteHome === input.home.root
    ) {
      return {
        kind: "compatible-healthy",
        peer: {
          pid: classified.peer.pid,
          port: classified.peer.port,
          peerVersion: classified.peer.peerVersion,
        },
        serverProtocolVersion: frame.serverProtocolVersion,
        authenticated: { peer: classified.peer, coordinates, handshake: frame },
      };
    }
    if (frame.status === "version-mismatch") {
      return {
        kind: "version-mismatch",
        failure: { kind: "version-mismatch", direction: frame.direction },
        authenticated: { peer: classified.peer, coordinates, handshake: frame },
      };
    }
    return { kind: "auth-invalid" };
  } catch {
    return { kind: "auth-invalid" };
  }
}

async function resolveExecutablePath(): Promise<string> {
  const executable = process.argv[1];
  if (executable === undefined || executable.length === 0 || !isAbsolute(executable)) {
    throw new TypeError("invalid executable path");
  }
  return realpath(resolve(executable));
}

async function resolveConfiguredExecutable(dependencies: EnduragentDependencies): Promise<string> {
  const executablePath = await dependencies.resolveExecutablePath!();
  if (!isAbsolute(executablePath)) throw new TypeError("invalid executable path");
  return executablePath;
}

function serviceSnapshot(status: LaunchdServiceStatus): DaemonServiceSnapshot {
  if (status.kind === "absent") {
    return {
      kind: "absent",
      label: status.label,
      installed: false,
      loaded: false,
      running: false,
      pid: null,
    };
  }
  if (status.kind === "registered") {
    return {
      kind: "registered",
      label: status.label,
      installed: status.installed,
      loaded: status.loaded,
      running: status.running,
      pid: status.pid,
    };
  }
  return {
    kind: "unknown",
    label: status.label,
    installed: status.installed,
    loaded: null,
    running: null,
    pid: null,
  };
}

function createDaemonController(input: {
  readonly home: AthleteHome;
  readonly executablePath: string;
}): CoachDaemonController {
  const identity = createLaunchdServiceIdentity(input);
  return {
    supported: process.platform === "darwin",
    install: async () => serviceSnapshot(await installLaunchdService(identity)),
    status: async () => serviceSnapshot(await readLaunchdServiceStatus(identity)),
    restart: async () => serviceSnapshot(await restartLaunchdService(identity)),
  };
}

async function defaultReadServiceStatus(input: {
  readonly home: AthleteHome;
  readonly executablePath: string;
}): Promise<LaunchdServiceStatus> {
  return readLaunchdServiceStatus(createLaunchdServiceIdentity(input));
}

async function defaultResumeService(input: {
  readonly home: AthleteHome;
  readonly executablePath: string;
}): Promise<"resumed" | "not-installed"> {
  return resumeLaunchdService(createLaunchdServiceIdentity(input));
}

const defaultDependencies: EnduragentDependencies = Object.freeze({
  resolveAthleteHome,
  prepareAthleteHome,
  withLocalCoach,
  readPackageVersion,
  connectRemoteTransport: async (home: AthleteHome, expectedPort?: number) => {
    try {
      const { port, token } = await readDaemonCoordinates(home);
      if (expectedPort !== undefined && expectedPort !== port) {
        throw new TypeError("daemon peer changed");
      }
      return await connectCoachVerbTransport({
        url: `ws://127.0.0.1:${port}/rpc`,
        token,
        expectedAthleteHome: home.root,
      });
    } catch (error) {
      if (error instanceof CoachRemoteError) throw error;
      throw new CoachRemoteError({ kind: "unavailable" });
    }
  },
  connectSelfTestClient: async (home: AthleteHome, expectedPort?: number) => {
    try {
      const { port, token } = await readDaemonCoordinates(home);
      if (expectedPort !== undefined && expectedPort !== port) {
        throw new TypeError("daemon peer changed");
      }
      return await connectCoachSelfTestClient({
        url: `ws://127.0.0.1:${port}/rpc`,
        token,
        expectedAthleteHome: home.root,
      });
    } catch (error) {
      if (error instanceof CoachRemoteError) throw error;
      throw new CoachRemoteError({ kind: "unavailable" });
    }
  },
  serviceRegistrationState: async (): Promise<ServiceRegistrationState> => "unknown",
  startEphemeralDaemon: startEphemeralDaemonProcess,
  delay: (ms: number) => new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms)),
  monotonicNow: () => performance.now(),
  resolveExecutablePath,
  createDaemonController,
  createLaunchdServiceIdentity,
  readServiceStatus: defaultReadServiceStatus,
  resumeService: defaultResumeService,
  observeDaemonState,
  startEphemeralSuccessor: startEphemeralSuccessorProcess,
  resolveSecondStarter: resolveSecondStarterProduction,
  platform: process.platform,
});

function childEnvironment(
  env: Record<string, string | undefined>,
  home: AthleteHome,
): NodeJS.ProcessEnv {
  const combined: Record<string, string | undefined> = {
    ...process.env,
    ...env,
    ENDURAGENT_HOME: home.root,
    ENDURAGENT_DAEMON_OWNER: undefined,
    ENDURAGENT_HANDOFF_CAPABILITY: undefined,
    ENDURAGENT_STARTER_CONTEXT_FD: "3",
    FORCE_COLOR: undefined,
    CLICOLOR_FORCE: undefined,
  };
  return Object.fromEntries(
    Object.entries(combined).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function starterContextLine(successor?: DesignatedSuccessorInput): string {
  return `${JSON.stringify(
    successor === undefined
      ? { owner: "ephemeral-client-started" }
      : {
          owner: "ephemeral-client-started",
          targetProtocolVersion: successor.targetProtocolVersion,
          handoffCapability: successor.handoffCapability,
        },
  )}\n`;
}

function writeStarterContext(child: ReturnType<typeof spawn>, line: string): Promise<void> {
  const stream = child.stdio[3];
  if (stream === null || typeof (stream as { end?: unknown }).end !== "function") {
    return Promise.reject(new Error("starter context pipe unavailable"));
  }
  return new Promise((resolveWrite, rejectWrite) => {
    const writable = stream as NodeJS.WritableStream;
    const onError = (): void => rejectWrite(new Error("starter context write failed"));
    writable.once("error", onError);
    writable.end(line, "utf8", () => {
      writable.removeListener("error", onError);
      resolveWrite();
    });
  });
}

async function startEphemeralDaemonProcess(input: {
  readonly env: Record<string, string | undefined>;
  readonly home: AthleteHome;
  readonly executablePath?: string;
  readonly successor?: DesignatedSuccessorInput;
}): Promise<{
  readonly disposeAfterFailedStart: () => Promise<void>;
  readonly detachAfterHealthy: () => void;
}> {
  const executablePath = input.executablePath ?? (await resolveExecutablePath());
  let child!: ReturnType<typeof spawn>;
  try {
    child = spawn(executablePath, ["serve"], {
      detached: true,
      env: childEnvironment(input.env, input.home),
      stdio: ["ignore", "ignore", "ignore", "pipe"],
    });
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once("spawn", resolveSpawn);
      child.once("error", rejectSpawn);
    });
    await writeStarterContext(child, starterContextLine(input.successor));
  } catch {
    try {
      child?.kill("SIGTERM");
    } catch {}
    throw new CoachRemoteError({ kind: "unavailable" });
  }
  return {
    disposeAfterFailedStart: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolveExit) => {
        const finish = (): void => resolveExit();
        child.once("exit", finish);
        child.once("error", finish);
        try {
          child.kill("SIGTERM");
        } catch {
          finish();
        }
      });
    },
    detachAfterHealthy: () => child.unref(),
  };
}

async function startEphemeralSuccessorProcess(input: DesignatedSuccessorInput): Promise<void> {
  const child = await startEphemeralDaemonProcess({
    env: process.env,
    home: input.home,
    executablePath: await resolveExecutablePath(),
    successor: input,
  });
  child.detachAfterHealthy();
}

function storeNewerThanApp(error: unknown): StoreNewerThanAppError | null {
  if (!(error instanceof CoachStoreWriterError)) return null;
  if (error.code !== "writer-failed" || error.stage !== "run migrations") return null;
  return error.cause instanceof StoreNewerThanAppError ? error.cause : null;
}

const VERB_USAGE =
  "Usage: enduragent <ask|state|analyze|import|plan week|sync|wellness set> [--json|--stream-json] [--session <key>|--fresh] [--local]";

class InvalidVerbInputError extends Error {}

function explicitAskStdin(argv: readonly string[]): boolean {
  let flagsEnded = false;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!flagsEnded && token === "--") {
      flagsEnded = true;
      continue;
    }
    if (!flagsEnded && token === "--session") {
      index += 1;
      continue;
    }
    if (!flagsEnded && token.startsWith("-") && token !== "-") continue;
    return token === "-";
  }
  return false;
}

async function readStdinText(input: NodeJS.ReadableStream): Promise<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  try {
    for await (const chunk of input as AsyncIterable<unknown>) {
      if (!(chunk instanceof Uint8Array)) throw new InvalidVerbInputError();
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
  } catch {
    throw new InvalidVerbInputError();
  }
  if (text.endsWith("\n")) {
    text = text.slice(0, -1);
    if (text.endsWith("\r")) text = text.slice(0, -1);
  }
  if (text.includes("\0") || !/\S/u.test(text)) throw new InvalidVerbInputError();
  return text;
}

interface ServeStarterContext {
  readonly owner: DaemonOwner;
  readonly handoffCapability?: string;
}

function readStarterContextFd(): Promise<string> {
  return new Promise((resolveContext, rejectContext) => {
    const stream = createReadStream("/dev/null", { fd: 3, autoClose: true });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("starter context timed out")), 5_000);
    timeout.unref?.();
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      stream.removeAllListeners();
      if (error !== undefined) {
        stream.destroy();
        rejectContext(error);
        return;
      }
      try {
        const bytes = Buffer.concat(chunks);
        const newline = bytes.indexOf(0x0a);
        if (newline !== bytes.length - 1 || bytes.indexOf(0x0a, newline + 1) !== -1) {
          throw new TypeError("invalid starter context framing");
        }
        resolveContext(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, -1)));
      } catch (decodeError) {
        rejectContext(decodeError);
      }
    };
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4_096) {
        finish(new Error("starter context is too large"));
        return;
      }
      chunks.push(chunk);
    });
    stream.once("end", () => finish());
    stream.once("error", () => finish(new Error("starter context read failed")));
  });
}

async function serveStarterContext(
  env: Record<string, string | undefined>,
): Promise<ServeStarterContext> {
  const fd = env.ENDURAGENT_STARTER_CONTEXT_FD;
  const ownerValue = env.ENDURAGENT_DAEMON_OWNER;
  const launchdCapability = env.ENDURAGENT_HANDOFF_CAPABILITY;
  delete env.ENDURAGENT_STARTER_CONTEXT_FD;
  delete env.ENDURAGENT_DAEMON_OWNER;
  delete env.ENDURAGENT_HANDOFF_CAPABILITY;

  if (fd !== undefined) {
    if (fd !== "3" || ownerValue !== undefined || launchdCapability !== undefined) {
      throw new TypeError("invalid starter context source");
    }
    const parsed: unknown = JSON.parse(await readStarterContextFd());
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("invalid starter context");
    }
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const owner = DaemonOwnerSchema.parse(record.owner);
    if (owner !== "ephemeral-client-started") {
      throw new TypeError("invalid starter owner");
    }
    if (keys.length === 1 && keys[0] === "owner") {
      return { owner };
    }
    if (
      keys.length !== 3 ||
      keys[0] !== "handoffCapability" ||
      keys[1] !== "owner" ||
      keys[2] !== "targetProtocolVersion" ||
      record.targetProtocolVersion !== PROTOCOL_VERSION ||
      typeof record.handoffCapability !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(record.handoffCapability)
    ) {
      throw new TypeError("invalid designated starter context");
    }
    return {
      owner,
      handoffCapability: record.handoffCapability,
    };
  }

  if (ownerValue === undefined && launchdCapability === undefined) {
    return { owner: "unmanaged-foreground" };
  }
  const owner = DaemonOwnerSchema.parse(ownerValue);
  if (owner !== "service-managed") throw new TypeError("invalid launchd starter owner");
  if (launchdCapability !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(launchdCapability)) {
    throw new TypeError("invalid launchd handoff capability");
  }
  return launchdCapability === undefined
    ? { owner }
    : { owner, handoffCapability: launchdCapability };
}

function writeContention(
  terminal: Pick<CoachCliTerminal, "stderr">,
  error: CoachStoreWriterError,
): void {
  if (error.contention?.kind === "holder") {
    terminal.stderr.write(
      `Enduragent cannot start: another writer holds this athlete home (pid ${error.contention.pid ?? "unknown"}, port ${error.contention.port}). Stop it or wait, then retry.\n`,
    );
    return;
  }
  if (error.contention?.kind === "foreign") {
    terminal.stderr.write(
      `Enduragent cannot start: 127.0.0.1:${error.contention.port} is held by a foreign process; change or remove the port file at ${error.contention.portFile}, then retry.\n`,
    );
  }
}

function renderLocalResult(
  result: Exclude<LocalCoachRunResult<ExitCode>, { readonly status: "completed" }>,
  terminal: Pick<CoachCliTerminal, "stderr">,
): ExitCode {
  if (result.status === "not-configured") {
    terminal.stderr.write(
      `Enduragent is not configured. Provision ${result.configPath} with provider credentials, then run: enduragent\n`,
    );
    return EXIT_NOT_CONFIGURED;
  }
  if (result.status === "unreadable") {
    terminal.stderr.write(
      "Enduragent cannot read the existing configuration. Check that config.yaml is a readable file, then retry.\n",
    );
    return EXIT_AGENT_ERROR;
  }
  terminal.stderr.write(
    "Enduragent cannot use the existing configuration. Correct or replace config.yaml, then retry.\n",
  );
  return EXIT_AGENT_ERROR;
}

async function runWithOwnedTransport(
  transport: CoachVerbTransport,
  request: CoachVerbRequest,
  invocation: CoachCliVerbInvocation,
  terminal: CoachCliTerminal,
): Promise<ExitCode> {
  let exitCode: ExitCode | undefined;
  let primaryError: unknown;
  try {
    exitCode = await runCoachVerb({
      request,
      outputMode: invocation.outputMode,
      terminal,
      transport,
    });
  } catch (error) {
    primaryError = error;
  }
  try {
    await transport.close();
  } catch (error) {
    if (primaryError === undefined && exitCode === EXIT_SUCCESS) {
      terminal.stderr.write("Enduragent could not close the command transport.\n");
      return EXIT_AGENT_ERROR;
    }
    if (primaryError === undefined && exitCode === undefined) primaryError = error;
  }
  if (primaryError !== undefined) throw primaryError;
  return exitCode!;
}

function remoteConnectionFailure(
  error: CoachRemoteError,
  terminal: Pick<CoachCliTerminal, "stderr">,
): ExitCode {
  switch (error.failure.kind) {
    case "unavailable":
      terminal.stderr.write("Enduragent could not reach the local service.\n");
      return EXIT_DAEMON_UNAVAILABLE;
    case "version-mismatch":
      terminal.stderr.write("Enduragent protocol versions do not match; update this client.\n");
      return EXIT_VERSION_MISMATCH;
    case "agent":
      terminal.stderr.write("Enduragent could not complete this command.\n");
      return EXIT_AGENT_ERROR;
    case "detached":
      terminal.stderr.write(
        "Enduragent detached from the running turn; the turn may still complete.\n",
      );
      return EXIT_AGENT_ERROR;
  }
}

function sameAthleteHome(left: AthleteHome, right: AthleteHome): boolean {
  return (
    left.root === right.root &&
    left.storeDir === right.storeDir &&
    left.archiveDir === right.archiveDir &&
    left.configDir === right.configDir
  );
}

function canonicalHome(home: AthleteHome): AthleteHome {
  const root = resolve(home.root);
  const canonical = Object.freeze({
    root,
    storeDir: resolve(home.storeDir),
    archiveDir: resolve(home.archiveDir),
    configDir: resolve(home.configDir),
  });
  if (
    canonical.storeDir !== join(root, "store") ||
    canonical.archiveDir !== join(root, "archive") ||
    canonical.configDir !== join(root, "config")
  ) {
    throw new TypeError("athlete home paths are inconsistent");
  }
  return sameAthleteHome(home, canonical) ? home : canonical;
}

async function resolvePreparedAthleteHome(
  env: Record<string, string | undefined>,
  dependencies: EnduragentDependencies,
  owner: "cli" | "desktop" = "cli",
): Promise<AthleteHome> {
  const home = canonicalHome(dependencies.resolveAthleteHome(env));
  if (owner === "cli") assertCliOAuthHome(join(home.configDir, "auth-profiles.json"));
  return dependencies.prepareAthleteHome!(home);
}

function validateSuccessorInput(home: AthleteHome, input: DesignatedSuccessorInput): void {
  if (
    home.root !== input.home.root ||
    input.targetProtocolVersion !== PROTOCOL_VERSION ||
    !/^[A-Za-z0-9_-]{43}$/.test(input.handoffCapability)
  ) {
    throw new TypeError("invalid designated successor");
  }
}

export interface ServiceUpgradeBindingDependencies {
  readonly readRegistration: () => Promise<ServiceRegistrationClass>;
  readonly restartInstalled: (input: DesignatedSuccessorInput) => Promise<void>;
  readonly resumeAfterEphemeral: (input: DesignatedSuccessorInput) => Promise<void>;
  readonly startEphemeral: (input: DesignatedSuccessorInput) => Promise<void>;
}

export function createServiceUpgradePort(
  home: AthleteHome,
  dependencies: ServiceUpgradeBindingDependencies,
): ServiceUpgradePort {
  return {
    async isInstalled(inputHome) {
      if (home.root !== inputHome.root) throw new TypeError("athlete home changed");
      const registration = await dependencies.readRegistration();
      if (registration === "registered") return true;
      if (registration === "absent") return false;
      throw new Error("service status unavailable");
    },
    async restartInstalledService(input) {
      validateSuccessorInput(home, input);
      await dependencies.restartInstalled(input);
    },
    async kickstartInstalledServiceAfterEphemeral(input) {
      validateSuccessorInput(home, input);
      await dependencies.resumeAfterEphemeral(input);
    },
    async startEphemeralSuccessor(input) {
      validateSuccessorInput(home, input);
      await dependencies.startEphemeral(input);
    },
  };
}

function productionMonotonicTimer(now: () => number): MonotonicTimer {
  return {
    nowMs: now,
    schedule(delayMs, callback) {
      const timeout = setTimeout(callback, Math.max(0, delayMs));
      timeout.unref?.();
      return { cancel: () => clearTimeout(timeout) };
    },
  };
}

function timerDelay(timer: MonotonicTimer, delayMs: number): Promise<void> {
  return new Promise((resolveDelay) => {
    timer.schedule(delayMs, resolveDelay);
  });
}

async function waitForWriterRelease(input: {
  readonly home: AthleteHome;
  readonly incumbent: { readonly port: number; readonly peerVersion: string };
  readonly deadlineMs: number;
  readonly pollIntervalMs: number;
  readonly timer: MonotonicTimer;
}): Promise<WriterReleaseWaitOutcome> {
  while (input.timer.nowMs() < input.deadlineMs) {
    let classified: ReadOnlyPeerClassification;
    try {
      classified = await classifyPeerReadOnly(input.home);
    } catch {
      return { status: "observation-invalid" };
    }
    if (classified.status === "writer-clear") return { status: "released" };
    if (classified.status === "foreign-port") return { status: "observation-invalid" };
    if (
      classified.status === "peer-healthy" &&
      (classified.peer.port !== input.incumbent.port ||
        classified.peer.peerVersion !== input.incumbent.peerVersion)
    ) {
      return { status: "observation-invalid" };
    }
    await timerDelay(
      input.timer,
      Math.min(input.pollIntervalMs, input.deadlineMs - input.timer.nowMs()),
    );
  }
  return { status: "timeout" };
}

class CompatiblePeerObservationError extends Error {
  constructor(
    readonly outcome: Exclude<CompatiblePeerWaitOutcome, { status: "published" | "timeout" }>,
  ) {
    super("compatible peer observation failed");
  }
}

const observationTransport: CoachVerbTransport = {
  kind: "remote",
  request: async () => {
    throw new CoachRemoteError({ kind: "agent" });
  },
  close: async () => {},
};

async function waitForCompatiblePeer(input: {
  readonly home: AthleteHome;
  readonly protocolVersion: number;
  readonly token: string;
  readonly deadlineMs: number;
  readonly pollIntervalMs: number;
  readonly timer: MonotonicTimer;
}): Promise<CompatiblePeerWaitOutcome> {
  let published: Extract<CompatiblePeerWaitOutcome, { status: "published" }> | undefined;
  while (input.timer.nowMs() < input.deadlineMs) {
    try {
      await connectWithBoundedRetry({
        connect: async () => {
          let classified: ReadOnlyPeerClassification;
          try {
            classified = await classifyPeerReadOnly(input.home);
          } catch {
            throw new CompatiblePeerObservationError({ status: "observation-invalid" });
          }
          if (classified.status === "writer-clear" || classified.status === "bound-unresponsive") {
            throw new CoachRemoteError({ kind: "unavailable" });
          }
          if (classified.status === "foreign-port") {
            throw new CompatiblePeerObservationError({ status: "observation-invalid" });
          }
          let handshake: Awaited<ReturnType<typeof observePeerHandshake>>;
          try {
            handshake = await observePeerHandshake({
              port: classified.peer.port,
              token: input.token,
              clientProtocolVersion: input.protocolVersion,
            });
          } catch {
            throw new CompatiblePeerObservationError({ status: "observation-invalid" });
          }
          if (handshake.status === "version-mismatch") {
            throw new CompatiblePeerObservationError({ status: "incompatible", handshake });
          }
          if (
            handshake.clientProtocolVersion !== input.protocolVersion ||
            handshake.serverProtocolVersion !== input.protocolVersion ||
            handshake.athleteHome !== input.home.root
          ) {
            throw new CompatiblePeerObservationError({ status: "observation-invalid" });
          }
          published = {
            status: "published",
            peer: classified.peer,
            handshake,
          };
          return observationTransport;
        },
        delay: (delayMs) => timerDelay(input.timer, Math.max(input.pollIntervalMs, delayMs)),
        monotonicNow: input.timer.nowMs,
      });
      return published!;
    } catch (error) {
      if (error instanceof CompatiblePeerObservationError) return error.outcome;
      if (!(error instanceof CoachRemoteError) || error.failure.kind !== "unavailable") {
        return { status: "observation-invalid" };
      }
    }
  }
  return { status: "timeout" };
}

function createSecondStarterCoreDependencies(input: {
  readonly dependencies: EnduragentDependencies;
  readonly serviceUpgrade: ServiceUpgradePort;
}): ResolveSecondStarterDependencies {
  return {
    observePeerHandshake,
    openUpgradeControl: openAuthenticatedDaemonControl,
    classifyPeerReadOnly,
    acquireUpgradeFence,
    serviceUpgrade: input.serviceUpgrade,
    timer: productionMonotonicTimer(input.dependencies.monotonicNow!),
    waitForWriterRelease,
    waitForCompatiblePeer,
  };
}

export function createSecondStarterDependencies(input: {
  readonly home: AthleteHome;
  readonly executablePath: string;
  readonly dependencies: EnduragentDependencies;
}): ResolveSecondStarterDependencies {
  const platform = input.dependencies.platform!;
  const identity =
    platform === "win32"
      ? undefined
      : input.dependencies.createLaunchdServiceIdentity!({
          home: input.home,
          executablePath: input.executablePath,
        });
  const startEphemeral = input.dependencies.startEphemeralSuccessor!;
  const serviceUpgrade = createServiceUpgradePort(input.home, {
    readRegistration: async () =>
      desktopRegistrationClass(
        await readDesktopRegistration(
          {
            platform,
            home: input.home,
            executablePath: input.executablePath,
          },
          {
            readServiceStatus: input.dependencies.readServiceStatus!,
          },
        ),
      ),
    restartInstalled: async (successor) => {
      if (identity === undefined) {
        await startEphemeral(successor);
        return;
      }
      await restartLaunchdServiceForUpgrade(identity, successor);
    },
    resumeAfterEphemeral: async (successor) => {
      if (identity === undefined) {
        await startEphemeral(successor);
        return;
      }
      await resumeLaunchdServiceAfterEphemeral(identity, successor);
    },
    startEphemeral,
  });
  return createSecondStarterCoreDependencies({
    dependencies: input.dependencies,
    serviceUpgrade,
  });
}

function customServiceRegistrationState(
  dependencies: EnduragentDependencies,
): (() => Promise<ServiceRegistrationState>) | undefined {
  return dependencies.serviceRegistrationState === defaultDependencies.serviceRegistrationState
    ? undefined
    : dependencies.serviceRegistrationState;
}

export interface ResolveDesktopDaemonInput {
  readonly env: Record<string, string | undefined>;
  readonly executablePath: string;
  readonly appVersion: string;
  readonly platform?: NodeJS.Platform;
  readonly signal: AbortSignal;
  readonly startAppSupervisedDaemon: (
    input: StartAppSupervisedDaemonInput,
  ) => Promise<AppSupervisedChildHandle>;
  readonly startBudget?: DesktopDaemonStartBudget;
  readonly observationOnly?: boolean;
}

export type DesktopDaemonDependencies = Required<
  Pick<
    EnduragentDependencies,
    | "resolveAthleteHome"
    | "prepareAthleteHome"
    | "platform"
    | "createLaunchdServiceIdentity"
    | "readServiceStatus"
    | "resumeService"
    | "observeDaemonState"
    | "resolveSecondStarter"
    | "delay"
    | "monotonicNow"
  >
>;

export type DesktopDaemonResolution =
  | {
      readonly status: "connected";
      readonly url: `ws://127.0.0.1:${number}/rpc`;
      readonly token: string;
      readonly owner: DaemonOwner;
      readonly athleteHome: AthleteHomeIdentity;
      readonly rendererCapability: RendererCapability;
      readonly supervision: "attached";
      close(): Promise<void>;
    }
  | {
      readonly status: "connected";
      readonly url: `ws://127.0.0.1:${number}/rpc`;
      readonly token: string;
      readonly owner: DaemonOwner;
      readonly athleteHome: AthleteHomeIdentity;
      readonly rendererCapability: RendererCapability;
      readonly supervision: "app-supervised";
      readonly exited: AppSupervisedChildHandle["exited"];
      isAlive(): boolean;
      close(): Promise<void>;
    }
  | {
      readonly status: "refused";
      readonly exitCode: 1 | 3 | 4 | 5;
      readonly classification:
        | "configuration"
        | "contention-family"
        | "version-mismatch"
        | "never-published";
      readonly cause:
        | ReadinessFailureStatus
        | "contention"
        | "version-mismatch"
        | "never-published"
        | "unavailable"
        | "cancelled"
        | "termination-failed"
        | "restart-exhausted";
      readonly retryable: boolean;
    };

export interface DesktopDaemonInitialRefreshConnection {
  readonly url: `ws://127.0.0.1:${number}/rpc`;
  readonly token: string;
  readonly owner: DaemonOwner;
}

export async function startDesktopDaemonInitialRefresh(
  connection: DesktopDaemonInitialRefreshConnection,
  openControl: typeof openAuthenticatedDaemonControl = openAuthenticatedDaemonControl,
): Promise<{ readonly status: "accepted" }> {
  const url = new URL(connection.url);
  const port = Number(url.port);
  if (
    url.protocol !== "ws:" ||
    url.hostname !== "127.0.0.1" ||
    url.pathname !== "/rpc" ||
    url.search !== "" ||
    url.hash !== "" ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new TypeError("invalid desktop daemon connection");
  }
  const control = await openControl({
    port,
    token: connection.token,
    incumbentProtocolVersion: PROTOCOL_VERSION,
    expectedOwner: connection.owner,
  });
  try {
    return await control.startInitialRefresh();
  } finally {
    await control.close();
  }
}

const DESKTOP_DAEMON_PUBLICATION_WAIT_MS = 30_000;
const DESKTOP_EPHEMERAL_START_ATTEMPTS = 3;
const DESKTOP_EPHEMERAL_START_DEADLINE_MS = 90_000;

const desktopDaemonDependencies: DesktopDaemonDependencies = {
  resolveAthleteHome: defaultDependencies.resolveAthleteHome,
  prepareAthleteHome: defaultDependencies.prepareAthleteHome!,
  platform: defaultDependencies.platform!,
  createLaunchdServiceIdentity: defaultDependencies.createLaunchdServiceIdentity!,
  readServiceStatus: defaultDependencies.readServiceStatus!,
  resumeService: defaultDependencies.resumeService!,
  observeDaemonState: defaultDependencies.observeDaemonState!,
  resolveSecondStarter: defaultDependencies.resolveSecondStarter!,
  delay: defaultDependencies.delay!,
  monotonicNow: defaultDependencies.monotonicNow!,
};

export async function prepareDesktopAthleteHome(
  env: Record<string, string | undefined>,
  dependencies: Pick<
    DesktopDaemonDependencies,
    "resolveAthleteHome" | "prepareAthleteHome"
  > = desktopDaemonDependencies,
): Promise<AthleteHome> {
  return dependencies.prepareAthleteHome(canonicalHome(dependencies.resolveAthleteHome(env)));
}

function refusedDesktop(
  exitCode: 1 | 3 | 4 | 5,
  cause: Extract<DesktopDaemonResolution, { status: "refused" }>["cause"] = exitCode ===
  EXIT_VERSION_MISMATCH
    ? "version-mismatch"
    : "contention",
): DesktopDaemonResolution {
  const classification =
    cause === "not-configured" || cause === "unreadable" || cause === "malformed"
      ? "configuration"
      : cause === "version-mismatch"
        ? "version-mismatch"
        : cause === "never-published"
          ? "never-published"
          : "contention-family";
  return {
    status: "refused",
    exitCode,
    classification,
    cause,
    retryable:
      cause !== "not-configured" &&
      cause !== "unreadable" &&
      cause !== "malformed" &&
      cause !== "version-mismatch" &&
      cause !== "termination-failed",
  };
}

function refusedUnownedDesktop(): DesktopDaemonResolution {
  return {
    status: "refused",
    exitCode: EXIT_DAEMON_UNAVAILABLE,
    classification: "contention-family",
    cause: "contention",
    retryable: false,
  };
}

type AppChildStopOutcome =
  | { readonly status: "absent" }
  | {
      readonly status: "stopped";
      readonly result: Awaited<AppSupervisedChildHandle["exited"]>;
    }
  | { readonly status: "failed" };

async function stopAppChildAndObserve(
  child: AppSupervisedChildHandle | undefined,
): Promise<AppChildStopOutcome> {
  if (child === undefined) return { status: "absent" };
  try {
    await child.stop();
    return { status: "stopped", result: await child.exited };
  } catch {
    return { status: "failed" };
  }
}

async function stopAppChild(child: AppSupervisedChildHandle | undefined): Promise<boolean> {
  return (await stopAppChildAndObserve(child)).status !== "failed";
}

class AppChildTerminationError extends Error {}

async function requireStoppedAppChild(child: AppSupervisedChildHandle | undefined): Promise<void> {
  if (!(await stopAppChild(child))) throw new AppChildTerminationError();
}

function refusedDesktopReadiness(status: ReadinessFailureStatus): DesktopDaemonResolution {
  return refusedDesktop(
    status === "not-configured" ? EXIT_NOT_CONFIGURED : EXIT_AGENT_ERROR,
    status,
  );
}

function connectedDesktop(
  port: number,
  token: string,
  handshake: AcceptedServerHandshakeFrame,
  child?: AppSupervisedChildHandle,
): DesktopDaemonResolution {
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= stopAppChild(child).then((stopped) => {
      if (!stopped) throw new Error("app-supervised daemon termination failed");
    });
    return closePromise;
  };
  return child === undefined
    ? {
        status: "connected",
        url: `ws://127.0.0.1:${port}/rpc`,
        token,
        owner: handshake.owner,
        athleteHome: handshake.athleteHome,
        rendererCapability: handshake.rendererCapability,
        supervision: "attached",
        close,
      }
    : {
        status: "connected",
        url: `ws://127.0.0.1:${port}/rpc`,
        token,
        owner: handshake.owner,
        athleteHome: handshake.athleteHome,
        rendererCapability: handshake.rendererCapability,
        supervision: "app-supervised",
        exited: child.exited,
        isAlive: child.isAlive,
        close,
      };
}

async function refuseUnownedWindowsDesktop(
  child: AppSupervisedChildHandle | undefined,
): Promise<DesktopDaemonResolution> {
  if (!(await stopAppChild(child))) {
    return refusedDesktop(EXIT_DAEMON_UNAVAILABLE, "termination-failed");
  }
  return refusedUnownedDesktop();
}

async function connectOwnedWindowsDesktop(
  observation: Extract<DaemonStateObservation, { readonly kind: "compatible-healthy" }>,
  child: AppSupervisedChildHandle | undefined,
): Promise<DesktopDaemonResolution> {
  let owned = false;
  try {
    owned =
      child !== undefined &&
      child.isAlive() &&
      observation.peer.pid === child.pid &&
      observation.authenticated.handshake.owner === "app-supervised";
  } catch {}
  if (!owned) {
    return refuseUnownedWindowsDesktop(child);
  }
  return connectedDesktop(
    observation.authenticated.coordinates.port,
    observation.authenticated.coordinates.token,
    observation.authenticated.handshake,
    child,
  );
}

type DesktopPublicationOutcome =
  | { readonly kind: "published"; readonly observation: DaemonStateObservation }
  | {
      readonly kind: "child-exited";
      readonly result: Awaited<AppSupervisedChildHandle["exited"]>;
    }
  | { readonly kind: "cancelled" }
  | { readonly kind: "deadline"; readonly observation: DaemonStateObservation };

async function waitForDesktopDaemon(input: {
  readonly home: AthleteHome;
  readonly signal: AbortSignal;
  readonly dependencies: DesktopDaemonDependencies;
  readonly deadline: number;
  readonly child?: AppSupervisedChildHandle;
}): Promise<DesktopPublicationOutcome> {
  const startedAt = input.dependencies.monotonicNow();
  const publicationDeadline = Math.min(
    input.deadline,
    startedAt + DESKTOP_DAEMON_PUBLICATION_WAIT_MS,
  );
  let abortListener: (() => void) | undefined;
  const cancelled = new Promise<DesktopPublicationOutcome>((resolve) => {
    if (input.signal.aborted) {
      resolve({ kind: "cancelled" });
      return;
    }
    abortListener = () => resolve({ kind: "cancelled" });
    input.signal.addEventListener("abort", abortListener, { once: true });
  });
  const childExited = input.child?.exited.then<DesktopPublicationOutcome>((result) => ({
    kind: "child-exited",
    result,
  }));
  let nextDelayMs = 50;
  let lastObservation: DaemonStateObservation = { kind: "absent" };
  try {
    while (!input.signal.aborted) {
      const remainingBeforeObservation = publicationDeadline - input.dependencies.monotonicNow();
      if (remainingBeforeObservation <= 0) {
        return { kind: "deadline", observation: lastObservation };
      }
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<DesktopPublicationOutcome>((resolve) => {
        timeout = setTimeout(
          () => resolve({ kind: "deadline", observation: lastObservation }),
          remainingBeforeObservation,
        );
      });
      const observationAttempt = input.dependencies
        .observeDaemonState({ home: input.home })
        .then<DesktopPublicationOutcome>((observation) => ({ kind: "published", observation }))
        .catch<DesktopPublicationOutcome>(() => ({
          kind: "published",
          observation: { kind: "auth-invalid" },
        }));
      const outcome = await Promise.race(
        [observationAttempt, childExited, cancelled, deadline].filter(
          (value): value is Promise<DesktopPublicationOutcome> => value !== undefined,
        ),
      );
      if (timeout !== undefined) clearTimeout(timeout);
      if (outcome.kind !== "published") return outcome;
      lastObservation = outcome.observation;
      if (lastObservation.kind !== "absent" && lastObservation.kind !== "bound-unresponsive") {
        return outcome;
      }
      const remainingMs = publicationDeadline - input.dependencies.monotonicNow();
      if (remainingMs <= 0) return { kind: "deadline", observation: lastObservation };
      const waitOutcome = await Promise.race(
        [
          childExited,
          cancelled,
          input.dependencies
            .delay(Math.min(nextDelayMs, remainingMs))
            .then<DesktopPublicationOutcome>(() => ({
              kind: "published",
              observation: lastObservation,
            })),
        ].filter((value): value is Promise<DesktopPublicationOutcome> => value !== undefined),
      );
      if (waitOutcome.kind !== "published") return waitOutcome;
      nextDelayMs = Math.min(nextDelayMs * 2, 200);
    }
    return { kind: "cancelled" };
  } finally {
    if (abortListener !== undefined) input.signal.removeEventListener("abort", abortListener);
  }
}

function createDesktopSecondStarterBinding(input: {
  readonly home: AthleteHome;
  readonly executablePath: string;
  readonly registration: DesktopRegistrationResult;
  readonly previousChild?: AppSupervisedChildHandle;
  readonly dependencies: DesktopDaemonDependencies;
  readonly startAppSupervisedDaemon: ResolveDesktopDaemonInput["startAppSupervisedDaemon"];
}): {
  readonly dependencies: ResolveSecondStarterDependencies;
  takeStartedAppChild(): AppSupervisedChildHandle | undefined;
} {
  const identity =
    input.registration.source === "launchd"
      ? input.dependencies.createLaunchdServiceIdentity({
          home: input.home,
          executablePath: input.executablePath,
        })
      : undefined;
  let startedChild: AppSupervisedChildHandle | undefined;
  let taken = false;
  let retirePromise: Promise<void> | undefined;
  const retirePreviousChild = (): Promise<void> => {
    retirePromise ??= requireStoppedAppChild(input.previousChild);
    return retirePromise;
  };
  const startAppSuccessor = async (successor: DesignatedSuccessorInput): Promise<void> => {
    if (startedChild !== undefined || taken) throw new Error("app child already started");
    await retirePreviousChild();
    startedChild = await input.startAppSupervisedDaemon({
      home: successor.home,
      handoffCapability: successor.handoffCapability,
    });
  };
  const serviceUpgrade = createServiceUpgradePort(input.home, {
    readRegistration: async () => desktopRegistrationClass(input.registration),
    restartInstalled: async (successor) => {
      if (identity === undefined) {
        await startAppSuccessor(successor);
        return;
      }
      await retirePreviousChild();
      await restartLaunchdServiceForUpgrade(identity, successor);
    },
    resumeAfterEphemeral: async (successor) => {
      if (identity === undefined) {
        await startAppSuccessor(successor);
        return;
      }
      await retirePreviousChild();
      await resumeLaunchdServiceAfterEphemeral(identity, successor);
    },
    startEphemeral: startAppSuccessor,
  });
  return {
    dependencies: createSecondStarterCoreDependencies({
      dependencies: {
        ...defaultDependencies,
        monotonicNow: input.dependencies.monotonicNow,
      },
      serviceUpgrade,
    }),
    takeStartedAppChild() {
      if (taken) throw new Error("app child already taken");
      taken = true;
      const child = startedChild;
      startedChild = undefined;
      return child;
    },
  };
}

export async function resolveDesktopDaemon(
  input: ResolveDesktopDaemonInput,
  dependencies: DesktopDaemonDependencies = desktopDaemonDependencies,
): Promise<DesktopDaemonResolution> {
  if (!isAbsolute(input.executablePath) || input.appVersion.length === 0) {
    throw new TypeError("invalid desktop daemon input");
  }
  const platform = input.platform ?? dependencies.platform;
  let home: AthleteHome;
  try {
    home = await prepareDesktopAthleteHome(input.env, dependencies);
  } catch {
    return refusedDesktop(
      EXIT_DAEMON_UNAVAILABLE,
      input.signal.aborted ? "cancelled" : "unavailable",
    );
  }
  let registrationResult: DesktopRegistrationResult;
  let registration: ServiceRegistrationClass;
  try {
    registrationResult = await readDesktopRegistration(
      { platform, home, executablePath: input.executablePath },
      { readServiceStatus: dependencies.readServiceStatus },
    );
    registration = desktopRegistrationClass(registrationResult);
  } catch {
    return refusedDesktop(
      EXIT_DAEMON_UNAVAILABLE,
      input.signal.aborted ? "cancelled" : "unavailable",
    );
  }
  let observation: DaemonStateObservation;
  try {
    observation = await dependencies.observeDaemonState({ home });
  } catch {
    return refusedDesktop(
      EXIT_DAEMON_UNAVAILABLE,
      input.signal.aborted ? "cancelled" : "unavailable",
    );
  }
  if (input.observationOnly) {
    if (observation.kind === "compatible-healthy") {
      if (platform === "win32") {
        return connectOwnedWindowsDesktop(observation, undefined);
      }
      return connectedDesktop(
        observation.authenticated.coordinates.port,
        observation.authenticated.coordinates.token,
        observation.authenticated.handshake,
      );
    }
    if (observation.kind === "version-mismatch") {
      return refusedDesktop(EXIT_VERSION_MISMATCH, "version-mismatch");
    }
    return refusedDesktop(EXIT_DAEMON_UNAVAILABLE, "unavailable");
  }
  let ownedChild: AppSupervisedChildHandle | undefined;
  const startBudget =
    input.startBudget ??
    ({
      remainingAttempts: DESKTOP_EPHEMERAL_START_ATTEMPTS,
      deadline: dependencies.monotonicNow() + DESKTOP_EPHEMERAL_START_DEADLINE_MS,
    } satisfies DesktopDaemonStartBudget);
  const startsThisResolutionLimit =
    input.startBudget === undefined ? DESKTOP_EPHEMERAL_START_ATTEMPTS : 1;
  let startsThisResolution = 0;

  while (!input.signal.aborted) {
    if (observation.kind === "compatible-healthy") {
      if (platform === "win32") {
        return connectOwnedWindowsDesktop(observation, ownedChild);
      }
      return connectedDesktop(
        observation.authenticated.coordinates.port,
        observation.authenticated.coordinates.token,
        observation.authenticated.handshake,
        ownedChild,
      );
    }
    if (observation.kind === "version-mismatch") {
      if (observation.failure.direction === "client-older") {
        if (!(await stopAppChild(ownedChild))) {
          return refusedDesktop(EXIT_DAEMON_UNAVAILABLE, "termination-failed");
        }
        return refusedDesktop(EXIT_VERSION_MISMATCH, "version-mismatch");
      }
      const binding = createDesktopSecondStarterBinding({
        home,
        executablePath: input.executablePath,
        registration: registrationResult,
        ...(ownedChild === undefined ? {} : { previousChild: ownedChild }),
        dependencies,
        startAppSupervisedDaemon: input.startAppSupervisedDaemon,
      });
      let starter: StarterResolution;
      try {
        starter = await dependencies.resolveSecondStarter(
          {
            caller: "desktop",
            home,
            clientProtocolVersion: PROTOCOL_VERSION,
            clientAppVersion: input.appVersion,
            bearerToken: observation.authenticated.coordinates.token,
            peer: observation.authenticated.peer,
          },
          binding.dependencies,
        );
      } catch (error) {
        const startedChild = binding.takeStartedAppChild();
        const stoppedStarted = await stopAppChildAndObserve(startedChild);
        const stoppedOwned = await stopAppChild(ownedChild);
        if (
          error instanceof AppChildTerminationError ||
          (error instanceof AppSupervisedDaemonStartError &&
            error.cause === "termination-failed") ||
          stoppedStarted.status === "failed" ||
          !stoppedOwned
        ) {
          return refusedDesktop(EXIT_DAEMON_UNAVAILABLE, "termination-failed");
        }
        if (
          stoppedStarted.status === "stopped" &&
          stoppedStarted.result.readinessFailure !== undefined
        ) {
          return refusedDesktopReadiness(stoppedStarted.result.readinessFailure);
        }
        return refusedDesktop(EXIT_DAEMON_UNAVAILABLE, "unavailable");
      }
      const startedChild = binding.takeStartedAppChild();
      if (startedChild !== undefined) {
        if (!(await stopAppChild(ownedChild))) {
          await stopAppChild(startedChild);
          return refusedDesktop(EXIT_DAEMON_UNAVAILABLE, "termination-failed");
        }
        ownedChild = startedChild;
      } else if (ownedChild !== undefined) {
        if (!(await stopAppChild(ownedChild))) {
          return refusedDesktop(EXIT_DAEMON_UNAVAILABLE, "termination-failed");
        }
        ownedChild = undefined;
      }
      if (starter.status === "attach") {
        if (platform === "win32") {
          let attached: DaemonStateObservation;
          try {
            attached = await dependencies.observeDaemonState({ home });
          } catch {
            return refuseUnownedWindowsDesktop(ownedChild);
          }
          if (attached.kind !== "compatible-healthy" || attached.peer.port !== starter.port) {
            return refuseUnownedWindowsDesktop(ownedChild);
          }
          return connectOwnedWindowsDesktop(attached, ownedChild);
        }
        return connectedDesktop(
          starter.port,
          observation.authenticated.coordinates.token,
          starter.handshake,
          ownedChild,
        );
      }
      if (starter.status === "retry-startup") {
        if (startedChild !== undefined) {
          const stopped = await stopAppChildAndObserve(ownedChild);
          if (stopped.status === "failed") {
            return refusedDesktop(EXIT_DAEMON_UNAVAILABLE, "termination-failed");
          }
          ownedChild = undefined;
          if (stopped.status === "stopped" && stopped.result.readinessFailure !== undefined) {
            return refusedDesktopReadiness(stopped.result.readinessFailure);
          }
        }
        try {
          observation = await dependencies.observeDaemonState({ home });
        } catch {
          const stopped = await stopAppChild(ownedChild);
          return refusedDesktop(
            EXIT_DAEMON_UNAVAILABLE,
            stopped ? "unavailable" : "termination-failed",
          );
        }
        continue;
      }
      const stopped = await stopAppChildAndObserve(ownedChild);
      if (stopped.status === "failed") {
        return refusedDesktop(EXIT_DAEMON_UNAVAILABLE, "termination-failed");
      }
      ownedChild = undefined;
      if (
        startedChild !== undefined &&
        stopped.status === "stopped" &&
        stopped.result.readinessFailure !== undefined
      ) {
        return refusedDesktopReadiness(stopped.result.readinessFailure);
      }
      if (starter.status === "refuse") {
        return refusedDesktop(
          starter.exitCode,
          starter.exitCode === EXIT_VERSION_MISMATCH ? "version-mismatch" : "contention",
        );
      }
      return refusedDesktop(EXIT_DAEMON_UNAVAILABLE, "unavailable");
    }

    const decision = decideServiceAwareAutoStart({ registration, peer: observation.kind });
    if (decision === "resume-service-then-attach") {
      if (dependencies.monotonicNow() >= startBudget.deadline) {
        return refusedDesktop(EXIT_DAEMON_UNAVAILABLE, "unavailable");
      }
      let resumed: "resumed" | "not-installed";
      try {
        resumed = await dependencies.resumeService({ home, executablePath: input.executablePath });
      } catch {
        return refusedDesktop(EXIT_DAEMON_UNAVAILABLE, "unavailable");
      }
      if (resumed !== "resumed") return refusedDesktop(EXIT_DAEMON_UNAVAILABLE, "unavailable");
      const published = await waitForDesktopDaemon({
        home,
        signal: input.signal,
        dependencies,
        deadline: startBudget.deadline,
      });
      if (published.kind === "cancelled") {
        return refusedDesktop(EXIT_DAEMON_UNAVAILABLE, "cancelled");
      }
      if (published.kind !== "published") {
        return refusedDesktop(EXIT_DAEMON_UNAVAILABLE, "unavailable");
      }
      observation = published.observation;
      continue;
    }
    if (decision === "spawn-ephemeral") {
      if (
        startBudget.remainingAttempts <= 0 ||
        startsThisResolution >= startsThisResolutionLimit ||
        dependencies.monotonicNow() >= startBudget.deadline
      ) {
        if (!(await stopAppChild(ownedChild))) {
          return refusedDesktop(EXIT_DAEMON_UNAVAILABLE, "termination-failed");
        }
        ownedChild = undefined;
        return refusedDesktop(EXIT_DAEMON_UNAVAILABLE, "never-published");
      }
      if (!(await stopAppChild(ownedChild))) {
        return refusedDesktop(EXIT_DAEMON_UNAVAILABLE, "termination-failed");
      }
      ownedChild = undefined;
      startBudget.remainingAttempts -= 1;
      startsThisResolution += 1;
      try {
        ownedChild = await input.startAppSupervisedDaemon({ home });
      } catch (error) {
        return refusedDesktop(
          EXIT_DAEMON_UNAVAILABLE,
          error instanceof AppSupervisedDaemonStartError && error.cause === "termination-failed"
            ? "termination-failed"
            : "never-published",
        );
      }
      const published = await waitForDesktopDaemon({
        home,
        signal: input.signal,
        dependencies,
        deadline: startBudget.deadline,
        child: ownedChild,
      });
      if (published.kind === "published") {
        observation = published.observation;
        continue;
      }
      const stopped = await stopAppChild(ownedChild);
      ownedChild = undefined;
      if (!stopped) return refusedDesktop(EXIT_DAEMON_UNAVAILABLE, "termination-failed");
      if (published.kind === "child-exited" && published.result.readinessFailure !== undefined) {
        startBudget.remainingAttempts += 1;
        return refusedDesktopReadiness(published.result.readinessFailure);
      }
      if (published.kind === "cancelled") {
        return refusedDesktop(EXIT_DAEMON_UNAVAILABLE, "cancelled");
      }
      if (platform === "win32" && published.kind === "child-exited") {
        try {
          observation = await dependencies.observeDaemonState({ home });
        } catch {
          return refusedDesktop(EXIT_DAEMON_UNAVAILABLE, "unavailable");
        }
        continue;
      }
      observation = published.kind === "deadline" ? published.observation : { kind: "absent" };
      continue;
    }
    if (!(await stopAppChild(ownedChild))) {
      return refusedDesktop(EXIT_DAEMON_UNAVAILABLE, "termination-failed");
    }
    return refusedDesktop(
      EXIT_DAEMON_UNAVAILABLE,
      observation.kind === "foreign" ? "contention" : "unavailable",
    );
  }
  if (!(await stopAppChild(ownedChild))) {
    return refusedDesktop(EXIT_DAEMON_UNAVAILABLE, "termination-failed");
  }
  return refusedDesktop(EXIT_DAEMON_UNAVAILABLE, "cancelled");
}

async function prepareVerb(
  input: RunEnduragentInput,
  invocation: CoachCliVerbInvocation,
  dependencies: EnduragentDependencies,
): Promise<CoachVerbRequest> {
  let stdinText: string | undefined;
  if (invocation.verb.name === "ask" && invocation.verb.input.kind === "stdin") {
    if (input.terminal.isTTY && !explicitAskStdin(input.argv)) {
      throw new InvalidVerbInputError();
    }
    stdinText = await readStdinText(input.terminal.input);
  }
  const chatId =
    invocation.verb.name === "state" ||
    invocation.verb.name === "import" ||
    invocation.verb.name === "sync"
      ? undefined
      : resolveCoachCliSession(invocation.session, dependencies.createFreshId).chatId;
  return createCoachVerbRequest({
    verb: invocation.verb,
    chatId,
    stdinText,
    signal: input.signal,
    callerCwd: process.cwd(),
  });
}

async function serviceRegistrationClass(input: {
  readonly home: AthleteHome;
  readonly executablePath: string;
  readonly dependencies: EnduragentDependencies;
}): Promise<ServiceRegistrationClass> {
  return desktopRegistrationClass(
    await readDesktopRegistration(
      {
        platform: input.dependencies.platform!,
        home: input.home,
        executablePath: input.executablePath,
      },
      {
        readServiceStatus: input.dependencies.readServiceStatus!,
        serviceRegistrationState: customServiceRegistrationState(input.dependencies),
      },
    ),
  );
}

async function connectAfterEphemeralStart(input: {
  readonly home: AthleteHome;
  readonly executablePath: string;
  readonly env: Record<string, string | undefined>;
  readonly dependencies: EnduragentDependencies;
}): Promise<CoachVerbTransport> {
  const child = await input.dependencies.startEphemeralDaemon!({
    env: input.env,
    home: input.home,
    executablePath: input.executablePath,
  });
  try {
    const transport = await connectWithBoundedRetry({
      connect: () => input.dependencies.connectRemoteTransport!(input.home),
      delay: input.dependencies.delay!,
      monotonicNow: input.dependencies.monotonicNow!,
    });
    child.detachAfterHealthy();
    return transport;
  } catch (error) {
    await child.disposeAfterFailedStart();
    throw error;
  }
}

async function connectServiceAwareRemote(input: {
  readonly home: AthleteHome;
  readonly env: Record<string, string | undefined>;
  readonly dependencies: EnduragentDependencies;
}): Promise<CoachVerbTransport> {
  let initialVersionMismatch: Extract<CoachRemoteFailure, { kind: "version-mismatch" }> | undefined;
  try {
    return await input.dependencies.connectRemoteTransport!(input.home);
  } catch (error) {
    if (!(error instanceof CoachRemoteError)) throw error;
    if (error.failure.kind === "version-mismatch") {
      initialVersionMismatch = error.failure;
    } else if (error.failure.kind !== "unavailable") {
      throw error;
    }
  }

  const executablePath = await resolveConfiguredExecutable(input.dependencies);
  const registration = await serviceRegistrationClass({
    home: input.home,
    executablePath,
    dependencies: input.dependencies,
  });
  if (initialVersionMismatch !== undefined) {
    let classified: ReadOnlyPeerClassification;
    try {
      classified = await classifyPeerReadOnly(input.home);
    } catch {
      throw new CoachRemoteError(initialVersionMismatch);
    }
    if (classified.status !== "peer-healthy") {
      throw new CoachRemoteError(initialVersionMismatch);
    }
    let coordinates: DaemonCoordinates;
    try {
      coordinates = await readDaemonCoordinates(input.home);
    } catch {
      throw new CoachRemoteError({ kind: "unavailable" });
    }
    if (coordinates.port !== classified.peer.port) {
      throw new CoachRemoteError({ kind: "unavailable" });
    }
    const { token: bearerToken } = coordinates;
    const resolution = await input.dependencies.resolveSecondStarter!(
      {
        caller: "cli-auto-start",
        home: input.home,
        clientProtocolVersion: PROTOCOL_VERSION,
        clientAppVersion: await input.dependencies.readPackageVersion(),
        bearerToken,
        peer: classified.peer,
      },
      createSecondStarterDependencies({
        home: input.home,
        executablePath,
        dependencies: input.dependencies,
      }),
    );
    if (resolution.status === "attach") {
      return input.dependencies.connectRemoteTransport!(input.home, resolution.port);
    }
    if (resolution.status !== "retry-startup") {
      if (resolution.status === "refuse" && resolution.exitCode === EXIT_VERSION_MISMATCH) {
        throw new CoachRemoteError(initialVersionMismatch);
      }
      throw new CoachRemoteError({ kind: "unavailable" });
    }
  }
  const observation = await input.dependencies.observeDaemonState!({ home: input.home });
  const decision = decideServiceAwareAutoStart({
    registration,
    peer: observation.kind,
  });
  if (decision === "attach") {
    if (observation.kind !== "compatible-healthy") {
      throw new CoachRemoteError({ kind: "unavailable" });
    }
    return input.dependencies.connectRemoteTransport!(input.home, observation.peer.port);
  }
  if (decision === "resume-service-then-attach") {
    const resumed = await input.dependencies.resumeService!({
      home: input.home,
      executablePath,
    });
    if (resumed !== "resumed") throw new CoachRemoteError({ kind: "unavailable" });
    return connectWithBoundedRetry({
      connect: () => input.dependencies.connectRemoteTransport!(input.home),
      delay: input.dependencies.delay!,
      monotonicNow: input.dependencies.monotonicNow!,
    });
  }
  if (decision === "spawn-ephemeral") {
    return connectAfterEphemeralStart({
      home: input.home,
      executablePath,
      env: input.env,
      dependencies: input.dependencies,
    });
  }
  if (observation.kind === "version-mismatch") {
    throw new CoachRemoteError(observation.failure);
  }
  throw new CoachRemoteError({ kind: "unavailable" });
}

async function runPreparedVerb(
  input: RunEnduragentInput,
  invocation: CoachCliVerbInvocation,
  request: CoachVerbRequest,
  dependencies: EnduragentDependencies,
): Promise<ExitCode> {
  const home = await resolvePreparedAthleteHome(input.env, dependencies);
  const connect = (): Promise<CoachVerbTransport> => dependencies.connectRemoteTransport!(home);
  if (!invocation.local) {
    let transport: CoachVerbTransport;
    try {
      transport = await connectServiceAwareRemote({
        home,
        env: input.env,
        dependencies,
      });
    } catch (error) {
      if (error instanceof CoachRemoteError) {
        return remoteConnectionFailure(error, input.terminal);
      }
      throw error;
    }
    return runWithOwnedTransport(transport, request, invocation, input.terminal);
  }

  try {
    const result = await dependencies.withLocalCoach({
      env: input.env,
      home,
      operation: async (lifecycle) =>
        runWithOwnedTransport(
          createLocalCoachVerbTransport(lifecycle.engine, serializeBoundaryError),
          request,
          invocation,
          input.terminal,
        ),
    });
    return result.status === "completed" ? result.value : renderLocalResult(result, input.terminal);
  } catch (error) {
    if (!(error instanceof CoachStoreWriterError) || error.code !== "writer-lock-held") {
      throw error;
    }
    let transport: CoachVerbTransport;
    try {
      transport = await connect();
    } catch (remoteError) {
      if (
        remoteError instanceof CoachRemoteError &&
        remoteError.failure.kind === "version-mismatch"
      ) {
        return remoteConnectionFailure(remoteError, input.terminal);
      }
      if (remoteError instanceof CoachRemoteError && remoteError.failure.kind === "unavailable") {
        writeContention(input.terminal, error);
        return EXIT_DAEMON_UNAVAILABLE;
      }
      throw remoteError;
    }
    return runWithOwnedTransport(transport, request, invocation, input.terminal);
  }
}

async function runSelfTestInvocation(
  input: RunEnduragentInput,
  dependencies: EnduragentDependencies,
): Promise<ExitCode> {
  const home = await resolvePreparedAthleteHome(input.env, dependencies);
  try {
    const transport = await connectServiceAwareRemote({
      home,
      env: input.env,
      dependencies: {
        ...dependencies,
        connectRemoteTransport: async (selectedHome, expectedPort) => {
          const client = await dependencies.connectSelfTestClient!(selectedHome, expectedPort);
          return {
            kind: "remote",
            request: async () => {
              throw new CoachRemoteError({ kind: "agent" });
            },
            close: () => client.close(),
            selfTestClient: client,
          } as CoachVerbTransport & { readonly selfTestClient: typeof client };
        },
      },
    });
    const client = (
      transport as CoachVerbTransport & {
        readonly selfTestClient?: Awaited<ReturnType<typeof connectCoachSelfTestClient>>;
      }
    ).selfTestClient;
    if (client === undefined) throw new CoachRemoteError({ kind: "agent" });
    return runCoachSelfTest({ connect: async () => client, terminal: input.terminal });
  } catch (error) {
    return runCoachSelfTest({
      connect: async () => {
        throw error;
      },
      terminal: input.terminal,
    });
  }
}

async function runServeAsSuccessor(input: {
  readonly lifecycle: Parameters<typeof runCoachServe>[0]["lifecycle"];
  readonly home: AthleteHome;
  readonly appVersion: string;
  readonly signal: AbortSignal;
  readonly owner: DaemonOwner;
  readonly authentication: string;
  readonly fence: UpgradeFenceHandle;
  readonly timer: MonotonicTimer;
}): Promise<ExitCode> {
  const { authentication: token } = input;
  const controller = new AbortController();
  const servePromise = runCoachServe({
    lifecycle: input.lifecycle,
    appVersion: input.appVersion,
    signal: AbortSignal.any([input.signal, controller.signal]),
    owner: input.owner,
  });
  const stopped = { status: "serve-stopped" } as const;
  const published = await Promise.race([
    waitForCompatiblePeer({
      home: input.home,
      protocolVersion: PROTOCOL_VERSION,
      token,
      deadlineMs: input.timer.nowMs() + 30_000,
      pollIntervalMs: 25,
      timer: input.timer,
    }),
    servePromise.then(() => stopped),
  ]);
  if (published.status !== "published") {
    controller.abort();
    await servePromise.catch(() => {});
    await input.fence.release();
    throw new Error("designated successor did not publish");
  }
  await input.fence.release();
  return servePromise;
}

async function runServeInvocation(input: {
  readonly invocationOwner: DaemonOwner;
  readonly starterCapability?: string;
  readonly runInput: RunEnduragentInput;
  readonly home: AthleteHome;
  readonly appVersion: string;
  readonly dependencies: EnduragentDependencies;
  readonly reportReadinessFailure?: (status: ReadinessFailureStatus) => void;
}): Promise<ExitCode> {
  const admission =
    input.dependencies.withLocalCoach === defaultDependencies.withLocalCoach
      ? await admitStartupThroughUpgradeFence({
          configDir: input.home.configDir,
          ...(input.starterCapability === undefined
            ? {}
            : { handoffCapability: input.starterCapability }),
        })
      : { status: "clear" as const };
  if (admission.status === "reserved") {
    input.runInput.terminal.stderr.write(admission.message);
    return EXIT_DAEMON_UNAVAILABLE;
  }

  let successor:
    | { readonly fence: UpgradeFenceHandle; readonly authentication: string }
    | undefined;
  while (true) {
    try {
      const result = await input.dependencies.withLocalCoach({
        env: input.runInput.env,
        home: input.home,
        deferInitialRefresh: true,
        ...(input.runInput.oauthOwner === undefined
          ? {}
          : { oauthOwner: input.runInput.oauthOwner }),
        operation: async (lifecycle) =>
          successor === undefined
            ? runCoachServe({
                lifecycle,
                appVersion: input.appVersion,
                signal: input.runInput.signal,
                owner: input.invocationOwner,
              })
            : runServeAsSuccessor({
                lifecycle,
                home: input.home,
                appVersion: input.appVersion,
                signal: input.runInput.signal,
                owner: input.invocationOwner,
                authentication: successor.authentication,
                fence: successor.fence,
                timer: productionMonotonicTimer(input.dependencies.monotonicNow!),
              }),
      });
      if (result.status !== "completed" && successor !== undefined) {
        await successor.fence.release();
      }
      if (
        result.status === "not-configured" ||
        result.status === "unreadable" ||
        result.status === "malformed"
      ) {
        input.reportReadinessFailure?.(result.status);
      }
      return result.status === "completed"
        ? result.value
        : renderLocalResult(result, input.runInput.terminal);
    } catch (error) {
      if (!(error instanceof CoachStoreWriterError) || error.code !== "writer-lock-held") {
        if (successor !== undefined) await successor.fence.release().catch(() => {});
        throw error;
      }
      if (input.invocationOwner === "app-supervised" && input.dependencies.platform === "win32") {
        return EXIT_SUCCESS;
      }
      let classified: ReadOnlyPeerClassification;
      try {
        classified = await classifyPeerReadOnly(input.home);
      } catch {
        throw error;
      }
      if (classified.status !== "peer-healthy") throw error;
      const executablePath = await resolveConfiguredExecutable(input.dependencies);
      const coordinates = await readDaemonCoordinates(input.home);
      if (coordinates.port !== classified.peer.port) throw error;
      const { token: bearerToken } = coordinates;
      const resolution = await input.dependencies.resolveSecondStarter!(
        {
          caller:
            input.invocationOwner === "service-managed"
              ? "service"
              : input.invocationOwner === "app-supervised"
                ? "desktop"
                : "serve",
          home: input.home,
          clientProtocolVersion: PROTOCOL_VERSION,
          clientAppVersion: input.appVersion,
          bearerToken,
          peer: classified.peer,
        },
        createSecondStarterDependencies({
          home: input.home,
          executablePath,
          dependencies: input.dependencies,
        }),
      );
      if (resolution.status === "retry-startup") continue;
      if (resolution.status === "become-successor") {
        successor = { fence: resolution.fence, authentication: coordinates.token };
        continue;
      }
      if (resolution.status === "defer" || resolution.status === "refuse") {
        input.runInput.terminal.stderr.write(resolution.stderr);
        return resolution.exitCode;
      }
      if (resolution.status === "attach" && input.invocationOwner === "app-supervised") {
        return EXIT_SUCCESS;
      }
      throw error;
    }
  }
}

export interface RunAppSupervisedEnduragentInput {
  readonly oauthOwner?: OAuthCredentialOwner;
  readonly env: Record<string, string | undefined>;
  readonly terminal: CoachCliTerminal;
  readonly signal: AbortSignal;
  readonly appVersion: string;
  readonly handoffCapability?: string;
}

export interface AppSupervisedEnduragentResult {
  readonly exitCode: ExitCode;
  readonly readinessFailure?: ReadinessFailureStatus;
}

function renderEnduragentFailure(
  error: unknown,
  terminal: Pick<CoachCliTerminal, "stderr">,
): ExitCode {
  if (error instanceof DesktopOwnedOAuthHomeError) {
    terminal.stderr.write(`${error.message}\n`);
    return EXIT_AGENT_ERROR;
  }
  if (storeNewerThanApp(error) !== null) {
    terminal.stderr.write(
      "Enduragent cannot start: this athlete store was created by a newer app version. Update Enduragent and retry.\n",
    );
    return EXIT_VERSION_MISMATCH;
  }
  if (
    error instanceof CoachStoreWriterError &&
    error.code === "writer-lock-held" &&
    error.contention?.kind === "holder"
  ) {
    terminal.stderr.write(
      `Enduragent cannot start: another writer holds this athlete home (pid ${error.contention.pid ?? "unknown"}, port ${error.contention.port}). Stop it or wait, then retry.\n`,
    );
    return EXIT_DAEMON_UNAVAILABLE;
  }
  if (
    error instanceof CoachStoreWriterError &&
    error.code === "writer-lock-held" &&
    error.contention?.kind === "foreign"
  ) {
    terminal.stderr.write(
      `Enduragent cannot start: 127.0.0.1:${error.contention.port} is held by a foreign process; change or remove the port file at ${error.contention.portFile}, then retry.\n`,
    );
    return EXIT_DAEMON_UNAVAILABLE;
  }
  terminal.stderr.write("Enduragent could not start.\n");
  return EXIT_AGENT_ERROR;
}

export async function runAppSupervisedEnduragent(
  input: RunAppSupervisedEnduragentInput,
  dependencies?: EnduragentDependencies,
): Promise<AppSupervisedEnduragentResult> {
  if (!isEnduragentAppVersion(input.appVersion)) {
    return {
      exitCode: renderEnduragentFailure(new TypeError("invalid app version"), input.terminal),
    };
  }
  if (
    input.handoffCapability !== undefined &&
    !/^[A-Za-z0-9_-]{43}$/.test(input.handoffCapability)
  ) {
    return {
      exitCode: renderEnduragentFailure(
        new TypeError("invalid handoff capability"),
        input.terminal,
      ),
    };
  }
  const resolvedDependencies: EnduragentDependencies = {
    ...defaultDependencies,
    ...dependencies,
  };
  try {
    const home = await resolvePreparedAthleteHome(input.env, resolvedDependencies, "desktop");
    let readinessFailure: ReadinessFailureStatus | undefined;
    const exitCode = await runServeInvocation({
      invocationOwner: "app-supervised",
      ...(input.handoffCapability === undefined
        ? {}
        : { starterCapability: input.handoffCapability }),
      runInput: {
        ...(input.oauthOwner === undefined ? {} : { oauthOwner: input.oauthOwner }),
        argv: [],
        env: input.env,
        terminal: input.terminal,
        signal: input.signal,
      },
      home,
      appVersion: input.appVersion,
      dependencies: resolvedDependencies,
      reportReadinessFailure: (status) => {
        readinessFailure = status;
      },
    });
    return {
      exitCode,
      ...(readinessFailure === undefined ? {} : { readinessFailure }),
    };
  } catch (error) {
    return { exitCode: renderEnduragentFailure(error, input.terminal) };
  }
}

async function runDaemonInvocation(input: {
  readonly action: "install" | "status" | "restart";
  readonly runInput: RunEnduragentInput;
  readonly dependencies: EnduragentDependencies;
}): Promise<ExitCode> {
  if (input.dependencies.platform !== "darwin") {
    const unavailableController: CoachDaemonController = {
      supported: false,
      install: async () => {
        throw new Error("unsupported");
      },
      status: async () => {
        throw new Error("unsupported");
      },
      restart: async () => {
        throw new Error("unsupported");
      },
    };
    return runCoachDaemonCommand({
      action: input.action,
      controller: unavailableController,
      terminal: input.runInput.terminal,
    });
  }
  let controller: CoachDaemonController;
  try {
    const home = await resolvePreparedAthleteHome(input.runInput.env, input.dependencies);
    const executablePath = await resolveConfiguredExecutable(input.dependencies);
    controller = input.dependencies.createDaemonController!({ home, executablePath });
  } catch {
    input.runInput.terminal.stderr.write("Enduragent could not start.\n");
    return EXIT_AGENT_ERROR;
  }
  return runCoachDaemonCommand({
    action: input.action,
    controller,
    terminal: input.runInput.terminal,
  });
}

export async function runEnduragent(
  input: RunEnduragentInput,
  dependencies?: EnduragentDependencies,
): Promise<ExitCode> {
  const invocation = parseCoachCliInvocation(input.argv);
  if (invocation.kind === "usage" || invocation.kind === "verb-usage") {
    input.terminal.stderr.write(`${invocation.message}\n`);
    return EXIT_USAGE;
  }

  const resolvedDependencies: EnduragentDependencies = {
    ...defaultDependencies,
    ...dependencies,
  };
  try {
    if (invocation.kind === "version") {
      const version = await resolvedDependencies.readPackageVersion();
      input.terminal.stdout.write(`enduragent ${version}\n`);
      return EXIT_SUCCESS;
    }

    if (invocation.kind === "daemon") {
      return runDaemonInvocation({
        action: invocation.action,
        runInput: input,
        dependencies: resolvedDependencies,
      });
    }

    if (invocation.kind === "self-test") {
      return await runSelfTestInvocation(input, resolvedDependencies);
    }

    if (invocation.kind === "verb") {
      let request: CoachVerbRequest;
      try {
        request = await prepareVerb(input, invocation, resolvedDependencies);
      } catch (error) {
        if (
          error instanceof InvalidCoachCliSessionError ||
          error instanceof InvalidVerbInputError
        ) {
          input.terminal.stderr.write(`${VERB_USAGE}\n`);
          return EXIT_USAGE;
        }
        if (error instanceof CoachCliSessionStartError) {
          input.terminal.stderr.write("Enduragent could not start a chat session.\n");
          return EXIT_AGENT_ERROR;
        }
        throw error;
      }
      try {
        return await runPreparedVerb(input, invocation, request, resolvedDependencies);
      } catch (error) {
        if (error instanceof DesktopOwnedOAuthHomeError) throw error;
        input.terminal.stderr.write("Enduragent could not complete this command.\n");
        return EXIT_AGENT_ERROR;
      }
    }

    const appVersion =
      invocation.kind === "serve" ? await resolvedDependencies.readPackageVersion() : undefined;
    const home = await resolvePreparedAthleteHome(input.env, resolvedDependencies);
    if (invocation.kind === "serve") {
      const starter = await serveStarterContext(input.env);
      return await runServeInvocation({
        invocationOwner: starter.owner,
        ...(starter.handoffCapability === undefined
          ? {}
          : { starterCapability: starter.handoffCapability }),
        runInput: input,
        home,
        appVersion: appVersion!,
        dependencies: resolvedDependencies,
      });
    }
    const result = await resolvedDependencies.withLocalCoach({
      env: input.env,
      home,
      operation: async (lifecycle) =>
        runCoachRepl({
          engine: lifecycle.engine,
          terminal: input.terminal,
          signal: input.signal,
        }),
    });

    return result.status === "completed" ? result.value : renderLocalResult(result, input.terminal);
  } catch (error) {
    return renderEnduragentFailure(error, input.terminal);
  }
}

export async function main(): Promise<void> {
  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  const onSigterm = (): void => controller.abort();
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  try {
    process.exitCode = await runEnduragent({
      argv: process.argv.slice(2),
      env: process.env,
      terminal: {
        input: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        isTTY: process.stdin.isTTY === true,
      },
      signal: controller.signal,
    });
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

async function isDirectExecution(moduleUrl: string, argv1: string | undefined): Promise<boolean> {
  if (argv1 === undefined) return false;
  try {
    const [modulePath, invokedPath] = await Promise.all([
      realpath(fileURLToPath(moduleUrl)),
      realpath(resolve(argv1)),
    ]);
    return modulePath === invokedPath;
  } catch {
    return false;
  }
}

if (await isDirectExecution(import.meta.url, process.argv[1])) {
  await main().catch(() => {
    process.stderr.write("Enduragent could not start.\n");
    process.exitCode = EXIT_AGENT_ERROR;
  });
}
