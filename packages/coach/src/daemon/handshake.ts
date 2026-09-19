import { readFile } from "node:fs/promises";
import { get } from "node:http";
import { createConnection } from "node:net";
import { join } from "node:path";
import {
  ClientHandshakeFrameSchema,
  EXIT_DAEMON_UNAVAILABLE,
  EXIT_SUCCESS,
  EXIT_VERSION_MISMATCH,
  JsonRpcResponseEnvelopeSchema,
  Protocol11AcceptedServerHandshakeFrameSchema,
  ServerHandshakeFrameSchema,
  compareProtocolVersions,
  type AcceptedServerHandshakeFrame,
  type DaemonOwner,
  type Protocol11AcceptedServerHandshakeFrame,
  type ServerHandshakeFrame,
  type VersionMismatchServerHandshakeFrame,
} from "@enduragent/coach-contract";
import {
  LOCKFILE_NAME,
  PORT_FILE_NAME,
  classifyHealthzResponse,
  readLockfile,
  type PeerHealthyOutcome,
} from "@enduragent/kernel-node/lock";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import { HANDOFF_RESERVED_MESSAGE, acquireUpgradeFence } from "./upgrade-fence.js";
import type { MonotonicTimer, UpgradeFenceHandle } from "./upgrade-fence.js";

export { HANDOFF_RESERVED_MESSAGE } from "./upgrade-fence.js";
export type { MonotonicTimer, ScheduledMonotonicTimer } from "./upgrade-fence.js";

export const UPGRADE_CONTROL_TIMEOUT_MS = 5_000 as const;
export const UPGRADE_WRITER_RELEASE_TIMEOUT_MS = 30_000 as const;
export const UPGRADE_SUCCESSOR_PUBLISH_TIMEOUT_MS = 30_000 as const;
export const UPGRADE_OBSERVATION_INTERVAL_MS = 25 as const;

export type SecondStarterCaller = "serve" | "service" | "cli-auto-start" | "desktop" | "local";

export type StarterResolution =
  | {
      readonly status: "attach";
      readonly port: number;
      readonly handshake: AcceptedServerHandshakeFrame;
    }
  | {
      readonly status: "defer";
      readonly exitCode: 0;
      readonly stdout: "";
      readonly stderr: string;
    }
  | {
      readonly status: "become-successor";
      readonly fence: UpgradeFenceHandle;
      readonly handoffCapability: string;
    }
  | {
      readonly status: "retry-startup";
    }
  | {
      readonly status: "refuse";
      readonly exitCode: 3 | 5;
      readonly stdout: "";
      readonly stderr: string;
    };

export interface ServiceUpgradePort {
  isInstalled(home: AthleteHome): Promise<boolean>;
  restartInstalledService(input: DesignatedSuccessorInput): Promise<void>;
  kickstartInstalledServiceAfterEphemeral(input: DesignatedSuccessorInput): Promise<void>;
  startEphemeralSuccessor(input: DesignatedSuccessorInput): Promise<void>;
}

export interface DesignatedSuccessorInput {
  readonly home: AthleteHome;
  readonly targetProtocolVersion: number;
  readonly handoffCapability: string;
}

export interface ResolveSecondStarterInput {
  readonly caller: SecondStarterCaller;
  readonly home: AthleteHome;
  readonly clientProtocolVersion: number;
  readonly clientAppVersion: string;
  readonly bearerToken: string;
  readonly peer: PeerHealthyOutcome;
}

export type ReadOnlyPeerClassification =
  | { readonly status: "peer-healthy"; readonly peer: PeerHealthyOutcome }
  | { readonly status: "writer-clear" }
  | {
      readonly status: "bound-unresponsive";
      readonly stdout: "";
      readonly stderr: string;
    }
  | {
      readonly status: "foreign-port";
      readonly stdout: "";
      readonly stderr: string;
    };

export type WriterReleaseWaitOutcome =
  | { readonly status: "released" }
  | { readonly status: "timeout" }
  | { readonly status: "observation-invalid" };

export type CompatiblePeerWaitOutcome =
  | {
      readonly status: "published";
      readonly peer: PeerHealthyOutcome;
      readonly handshake: AcceptedServerHandshakeFrame;
    }
  | { readonly status: "crashed" }
  | {
      readonly status: "incompatible";
      readonly handshake: VersionMismatchServerHandshakeFrame;
    }
  | { readonly status: "timeout" }
  | { readonly status: "observation-invalid" };

export interface AuthenticatedDaemonControl {
  readonly port: number;
  readonly accepted: AcceptedServerHandshakeFrame | Protocol11AcceptedServerHandshakeFrame;
  reserveUpgrade(input: {
    readonly targetProtocolVersion: number;
    readonly handoffCapability: string;
  }): Promise<{ readonly status: "reserved" }>;
  shutdownForUpgrade(input: {
    readonly targetProtocolVersion: number;
    readonly handoffCapability: string;
  }): Promise<{ readonly status: "accepted" }>;
  startInitialRefresh(): Promise<{ readonly status: "accepted" }>;
  close(): Promise<void>;
}

export interface OpenAuthenticatedDaemonControlInput {
  readonly port: number;
  readonly token: string;
  readonly incumbentProtocolVersion: number;
  readonly expectedOwner: DaemonOwner;
  readonly timeoutMs?: number;
}

export interface ResolveSecondStarterDependencies {
  readonly observePeerHandshake: typeof observePeerHandshake;
  readonly openUpgradeControl: typeof openAuthenticatedDaemonControl;
  readonly classifyPeerReadOnly: typeof classifyPeerReadOnly;
  readonly acquireUpgradeFence: typeof acquireUpgradeFence;
  readonly serviceUpgrade: ServiceUpgradePort;
  readonly timer: MonotonicTimer;
  readonly waitForWriterRelease: (input: {
    readonly home: AthleteHome;
    readonly incumbent: PeerHealthyOutcome;
    readonly deadlineMs: number;
    readonly pollIntervalMs: number;
    readonly timer: MonotonicTimer;
  }) => Promise<WriterReleaseWaitOutcome>;
  readonly waitForCompatiblePeer: (input: {
    readonly home: AthleteHome;
    readonly protocolVersion: number;
    readonly token: string;
    readonly deadlineMs: number;
    readonly pollIntervalMs: number;
    readonly timer: MonotonicTimer;
  }) => Promise<CompatiblePeerWaitOutcome>;
}

export const alreadyServingNotice = (port: number): string =>
  `Enduragent is already serving this athlete home at 127.0.0.1:${port}.\n`;

export const lowerClientMessage = (
  clientProtocolVersion: number,
  daemonProtocolVersion: number,
): string =>
  `Enduragent cannot connect: daemon protocol ${daemonProtocolVersion} is newer than client protocol ${clientProtocolVersion}. Update enduragent.\n`;

export const UNMANAGED_UPGRADE_MESSAGE =
  "A foreground daemon is running; stop it before upgrading.\n";

export const UNTRUSTED_PEER_MESSAGE =
  "Enduragent cannot start: the existing daemon could not be authenticated and validated; stop it or wait, then retry.\n";

export const UPGRADE_BUSY_MESSAGE =
  "Enduragent could not complete the daemon upgrade; the current daemon is still busy. Retry after the active turn completes.\n";

export const UPGRADE_SUCCESSOR_FAILED_MESSAGE =
  "Enduragent could not complete the daemon upgrade because the designated successor did not publish a compatible service. Retry.\n";

const OBSERVATION_TIMEOUT_MS = 1_000;

function refusal(exitCode: 3 | 5, stderr: string): StarterResolution {
  return { status: "refuse", exitCode, stdout: "", stderr };
}

function holderMessage(pid: number | null, port: number): string {
  return `Enduragent cannot start: another writer holds this athlete home (pid ${pid ?? "unknown"}, port ${port}). Stop it or wait, then retry.\n`;
}

function foreignMessage(port: number, portFile: string): string {
  return `Enduragent cannot start: 127.0.0.1:${port} is held by a foreign process; change or remove the port file at ${portFile}, then retry.\n`;
}

async function readPublishedPort(path: string): Promise<number | null> {
  try {
    const raw = await readFile(path, "utf8");
    const port = Number(raw.trim());
    return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
  } catch {
    return null;
  }
}

function portBound(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (bound: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(bound);
    };
    socket.setTimeout(OBSERVATION_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(true));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      finish(error.code !== "ECONNREFUSED");
    });
  });
}

function probeHealth(port: number): Promise<ReturnType<typeof classifyHealthzResponse>> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: ReturnType<typeof classifyHealthzResponse>): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = get(
      { host: "127.0.0.1", port, path: "/healthz", timeout: OBSERVATION_TIMEOUT_MS },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          finish(
            classifyHealthzResponse(
              response.statusCode ?? 0,
              Buffer.concat(chunks).toString("utf8"),
            ),
          );
        });
        response.on("error", () => finish({ kind: "unresponsive" }));
      },
    );
    request.once("timeout", () => {
      request.destroy();
      finish({ kind: "unresponsive" });
    });
    request.once("error", () => finish({ kind: "unresponsive" }));
  });
}

export async function classifyPeerReadOnly(home: AthleteHome): Promise<ReadOnlyPeerClassification> {
  const lockfilePath = join(home.configDir, LOCKFILE_NAME);
  const portFilePath = join(home.configDir, PORT_FILE_NAME);
  const body = readLockfile(lockfilePath);
  const publishedPort = await readPublishedPort(portFilePath);
  if (publishedPort !== null && (await portBound(publishedPort))) {
    if (body?.port === publishedPort) {
      return {
        status: "bound-unresponsive",
        stdout: "",
        stderr: holderMessage(body.pid, publishedPort),
      };
    }
    const verdict = await probeHealth(publishedPort);
    if (verdict.kind === "healthy") {
      return {
        status: "peer-healthy",
        peer: {
          status: "peer-healthy",
          pid: body?.pid ?? null,
          port: publishedPort,
          peerVersion: verdict.version,
        },
      };
    }
    if (verdict.kind === "foreign") {
      return {
        status: "foreign-port",
        stdout: "",
        stderr: foreignMessage(publishedPort, portFilePath),
      };
    }
    return {
      status: "bound-unresponsive",
      stdout: "",
      stderr: holderMessage(body?.pid ?? null, publishedPort),
    };
  }
  if (body !== null && (await portBound(body.port))) {
    return {
      status: "bound-unresponsive",
      stdout: "",
      stderr: holderMessage(body.pid, body.port),
    };
  }
  return { status: "writer-clear" };
}

interface OpenHandshakeResult<
  TFrame extends ServerHandshakeFrame | Protocol11AcceptedServerHandshakeFrame,
> {
  readonly socket: WebSocket;
  readonly frame: TFrame;
}

interface OpenHandshakeInput {
  readonly port: number;
  readonly token: string;
  readonly clientProtocolVersion: number;
  readonly timeoutMs: number;
  readonly acceptProtocol11Frame?: boolean;
}

function openHandshake(
  input: OpenHandshakeInput & { readonly acceptProtocol11Frame: true },
): Promise<OpenHandshakeResult<ServerHandshakeFrame | Protocol11AcceptedServerHandshakeFrame>>;
function openHandshake(
  input: OpenHandshakeInput & { readonly acceptProtocol11Frame?: false },
): Promise<OpenHandshakeResult<ServerHandshakeFrame>>;
function openHandshake(
  input: OpenHandshakeInput,
): Promise<OpenHandshakeResult<ServerHandshakeFrame | Protocol11AcceptedServerHandshakeFrame>> {
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) {
    return Promise.reject(new Error("daemon handshake failed"));
  }
  let firstFrame: ReturnType<typeof ClientHandshakeFrameSchema.parse>;
  try {
    firstFrame = ClientHandshakeFrameSchema.parse({
      type: "handshake",
      token: input.token,
      clientProtocolVersion: input.clientProtocolVersion,
    });
  } catch {
    return Promise.reject(new Error("daemon handshake failed"));
  }
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${input.port}/rpc`);
    let settled = false;
    const timer = setTimeout(() => finish(new Error("daemon handshake failed")), input.timeoutMs);
    timer.unref?.();
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };
    const finish = (
      error?: Error,
      frame?: ServerHandshakeFrame | Protocol11AcceptedServerHandshakeFrame,
    ): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error !== undefined) {
        try {
          socket.close();
        } catch {}
        reject(error);
      } else {
        resolve({ socket, frame: frame! });
      }
    };
    const onOpen = (): void => {
      try {
        socket.send(JSON.stringify(firstFrame));
      } catch {
        finish(new Error("daemon handshake failed"));
      }
    };
    const onMessage = (event: Event): void => {
      const data = (event as Event & { readonly data?: unknown }).data;
      if (typeof data !== "string") {
        finish(new Error("daemon handshake failed"));
        return;
      }
      try {
        const value: unknown = JSON.parse(data);
        const current = ServerHandshakeFrameSchema.safeParse(value);
        const legacy = input.acceptProtocol11Frame
          ? Protocol11AcceptedServerHandshakeFrameSchema.safeParse(value)
          : undefined;
        const frame = current.success
          ? current.data
          : legacy?.success === true
            ? legacy.data
            : undefined;
        if (frame === undefined) throw new Error("invalid frame");
        if (frame.clientProtocolVersion !== input.clientProtocolVersion) {
          throw new Error("invalid echo");
        }
        finish(undefined, frame);
      } catch {
        finish(new Error("daemon handshake failed"));
      }
    };
    const onError = (): void => finish(new Error("daemon handshake failed"));
    const onClose = (): void => finish(new Error("daemon handshake failed"));
    socket.addEventListener("open", onOpen);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
  });
}

export async function observePeerHandshake(input: {
  readonly port: number;
  readonly token: string;
  readonly clientProtocolVersion: number;
}): Promise<ServerHandshakeFrame> {
  const opened = await openHandshake({ ...input, timeoutMs: UPGRADE_CONTROL_TIMEOUT_MS });
  try {
    return opened.frame;
  } finally {
    opened.socket.close();
  }
}

function rpcError(code: number, message: string): Error & { readonly code: number } {
  const error = new Error(message) as Error & { code: number };
  error.code = code;
  return error;
}

export async function openAuthenticatedDaemonControl(
  input: OpenAuthenticatedDaemonControlInput,
): Promise<AuthenticatedDaemonControl> {
  const timeoutMs = input.timeoutMs ?? UPGRADE_CONTROL_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("invalid daemon control timeout");
  }
  const handshakeInput = {
    port: input.port,
    token: input.token,
    clientProtocolVersion: input.incumbentProtocolVersion,
    timeoutMs,
  };
  const opened =
    input.incumbentProtocolVersion === 11
      ? await openHandshake({ ...handshakeInput, acceptProtocol11Frame: true })
      : await openHandshake(handshakeInput);
  if (
    opened.frame.status !== "accepted" ||
    opened.frame.clientProtocolVersion !== input.incumbentProtocolVersion ||
    opened.frame.serverProtocolVersion !== input.incumbentProtocolVersion ||
    opened.frame.owner !== input.expectedOwner
  ) {
    opened.socket.close();
    throw new Error("daemon control authentication failed");
  }
  const socket = opened.socket;
  let sequence = 0;
  let closed = false;
  const pending = new Map<
    number,
    {
      readonly expectedStatus: "reserved" | "accepted";
      readonly resolve: (value: { readonly status: "reserved" | "accepted" }) => void;
      readonly reject: (error: unknown) => void;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  >();
  const rejectPending = (): void => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("daemon control connection closed"));
    }
    pending.clear();
  };
  const onMessage = (event: Event): void => {
    const data = (event as Event & { readonly data?: unknown }).data;
    if (typeof data !== "string") {
      socket.close();
      return;
    }
    let parsed: ReturnType<typeof JsonRpcResponseEnvelopeSchema.parse>;
    try {
      parsed = JsonRpcResponseEnvelopeSchema.parse(JSON.parse(data));
    } catch {
      socket.close();
      return;
    }
    if (parsed.id === null || typeof parsed.id !== "number") return;
    const request = pending.get(parsed.id);
    if (request === undefined) return;
    pending.delete(parsed.id);
    clearTimeout(request.timer);
    if ("error" in parsed) {
      request.reject(rpcError(parsed.error.code, parsed.error.message));
      return;
    }
    const result = parsed.result;
    if (
      result === null ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      Object.keys(result).length !== 1 ||
      (result as { readonly status?: unknown }).status !== request.expectedStatus
    ) {
      request.reject(new Error("invalid daemon control response"));
      return;
    }
    request.resolve({ status: request.expectedStatus });
  };
  const removeControlListeners = (): void => {
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("error", onTerminal);
    socket.removeEventListener("close", onTerminal);
  };
  function onTerminal(): void {
    closed = true;
    removeControlListeners();
    rejectPending();
  }
  socket.addEventListener("message", onMessage);
  socket.addEventListener("error", onTerminal);
  socket.addEventListener("close", onTerminal);

  const call = (
    method:
      | "daemon.reserveUpgrade"
      | "daemon.shutdownForUpgrade"
      | "daemon.startInitialRefresh",
    params: unknown,
    expectedStatus: "reserved" | "accepted",
  ): Promise<{ readonly status: "reserved" | "accepted" }> => {
    if (closed || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("daemon control connection closed"));
    }
    sequence += 1;
    const id = sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          pending.delete(id);
          reject(new Error("daemon control request timed out"));
          socket.close();
        },
        method === "daemon.shutdownForUpgrade" ? UPGRADE_WRITER_RELEASE_TIMEOUT_MS : timeoutMs,
      );
      timer.unref?.();
      pending.set(id, { expectedStatus, resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch {
        pending.delete(id);
        clearTimeout(timer);
        reject(new Error("daemon control request failed"));
      }
    });
  };

  return {
    port: input.port,
    accepted: opened.frame,
    async reserveUpgrade(params) {
      const result = await call("daemon.reserveUpgrade", params, "reserved");
      return { status: result.status as "reserved" };
    },
    async shutdownForUpgrade(params) {
      const result = await call("daemon.shutdownForUpgrade", params, "accepted");
      return { status: result.status as "accepted" };
    },
    async startInitialRefresh() {
      const result = await call("daemon.startInitialRefresh", {}, "accepted");
      return { status: result.status as "accepted" };
    },
    async close() {
      if (closed) return;
      closed = true;
      rejectPending();
      removeControlListeners();
      socket.close();
    },
  };
}

function samePeer(left: PeerHealthyOutcome, right: PeerHealthyOutcome): boolean {
  return left.port === right.port && left.peerVersion === right.peerVersion;
}

function sameHandshake(left: ServerHandshakeFrame, right: ServerHandshakeFrame): boolean {
  return (
    left.status === right.status &&
    left.clientProtocolVersion === right.clientProtocolVersion &&
    left.serverProtocolVersion === right.serverProtocolVersion &&
    left.owner === right.owner &&
    (left.status === "accepted"
      ? right.status === "accepted" &&
        left.athleteHome === right.athleteHome &&
        left.rendererCapability === right.rendererCapability
      : right.status === "version-mismatch" && left.direction === right.direction)
  );
}

function compatibleResolution(
  caller: SecondStarterCaller,
  peer: PeerHealthyOutcome,
  handshake: AcceptedServerHandshakeFrame,
): StarterResolution {
  return caller === "serve" || caller === "service"
    ? {
        status: "defer",
        exitCode: EXIT_SUCCESS,
        stdout: "",
        stderr: alreadyServingNotice(peer.port),
      }
    : { status: "attach", port: peer.port, handshake };
}

function errorCode(error: unknown): number | undefined {
  return typeof error === "object" &&
    error !== null &&
    typeof (error as { readonly code?: unknown }).code === "number"
    ? (error as { readonly code: number }).code
    : undefined;
}

export async function resolveSecondStarter(
  input: ResolveSecondStarterInput,
  dependencies: ResolveSecondStarterDependencies,
): Promise<StarterResolution> {
  if (input.clientAppVersion.length === 0)
    return refusal(EXIT_DAEMON_UNAVAILABLE, UNTRUSTED_PEER_MESSAGE);

  const resolvePeer = async (
    peer: PeerHealthyOutcome,
    reclassificationAvailable: boolean,
  ): Promise<StarterResolution> => {
    let observed: ServerHandshakeFrame;
    try {
      observed = ServerHandshakeFrameSchema.parse(
        await dependencies.observePeerHandshake({
          port: peer.port,
          token: input.bearerToken,
          clientProtocolVersion: input.clientProtocolVersion,
        }),
      );
    } catch {
      return refusal(EXIT_DAEMON_UNAVAILABLE, UNTRUSTED_PEER_MESSAGE);
    }
    if (observed.clientProtocolVersion !== input.clientProtocolVersion) {
      return refusal(EXIT_DAEMON_UNAVAILABLE, UNTRUSTED_PEER_MESSAGE);
    }
    let comparison: ReturnType<typeof compareProtocolVersions>;
    try {
      comparison = compareProtocolVersions(
        input.clientProtocolVersion,
        observed.serverProtocolVersion,
      );
    } catch {
      return refusal(EXIT_DAEMON_UNAVAILABLE, UNTRUSTED_PEER_MESSAGE);
    }
    if (comparison === "client-older") {
      if (observed.status !== "version-mismatch" || observed.direction !== "client-older") {
        return refusal(EXIT_DAEMON_UNAVAILABLE, UNTRUSTED_PEER_MESSAGE);
      }
      return refusal(
        EXIT_VERSION_MISMATCH,
        lowerClientMessage(input.clientProtocolVersion, observed.serverProtocolVersion),
      );
    }
    if (comparison === "equal") {
      if (observed.status !== "accepted" || observed.athleteHome !== input.home.root) {
        return refusal(EXIT_DAEMON_UNAVAILABLE, UNTRUSTED_PEER_MESSAGE);
      }
      return compatibleResolution(input.caller, peer, observed);
    }
    if (observed.status !== "version-mismatch" || observed.direction !== "client-newer") {
      return refusal(EXIT_DAEMON_UNAVAILABLE, UNTRUSTED_PEER_MESSAGE);
    }
    if (observed.owner === "unmanaged-foreground") {
      return refusal(EXIT_DAEMON_UNAVAILABLE, UNMANAGED_UPGRADE_MESSAGE);
    }

    let acquired: Awaited<ReturnType<typeof acquireUpgradeFence>>;
    try {
      acquired = await dependencies.acquireUpgradeFence({ configDir: input.home.configDir });
    } catch {
      return refusal(EXIT_DAEMON_UNAVAILABLE, UNTRUSTED_PEER_MESSAGE);
    }
    if (acquired.status === "reserved") {
      return refusal(EXIT_DAEMON_UNAVAILABLE, HANDOFF_RESERVED_MESSAGE);
    }
    const fence = acquired.handle;
    const handoffCapability = fence.handoffCapability;

    const reclassify = async (): Promise<StarterResolution> => {
      await fence.release();
      if (!reclassificationAvailable) {
        return refusal(EXIT_DAEMON_UNAVAILABLE, UNTRUSTED_PEER_MESSAGE);
      }
      let fresh: ReadOnlyPeerClassification;
      try {
        fresh = await dependencies.classifyPeerReadOnly(input.home);
      } catch {
        return refusal(EXIT_DAEMON_UNAVAILABLE, UNTRUSTED_PEER_MESSAGE);
      }
      if (fresh.status === "writer-clear") return { status: "retry-startup" };
      if (fresh.status === "bound-unresponsive" || fresh.status === "foreign-port") {
        return refusal(EXIT_DAEMON_UNAVAILABLE, fresh.stderr);
      }
      return resolvePeer(fresh.peer, false);
    };

    let immediate: ReadOnlyPeerClassification;
    let repeated: ServerHandshakeFrame;
    try {
      immediate = await dependencies.classifyPeerReadOnly(input.home);
      if (immediate.status !== "peer-healthy" || !samePeer(immediate.peer, peer)) {
        return reclassify();
      }
      repeated = ServerHandshakeFrameSchema.parse(
        await dependencies.observePeerHandshake({
          port: immediate.peer.port,
          token: input.bearerToken,
          clientProtocolVersion: input.clientProtocolVersion,
        }),
      );
    } catch {
      return reclassify();
    }
    if (!sameHandshake(observed, repeated)) return reclassify();

    let control: AuthenticatedDaemonControl;
    try {
      control = await dependencies.openUpgradeControl({
        port: peer.port,
        token: input.bearerToken,
        incumbentProtocolVersion: observed.serverProtocolVersion,
        expectedOwner: observed.owner,
      });
    } catch {
      await fence.release();
      return refusal(EXIT_DAEMON_UNAVAILABLE, UNTRUSTED_PEER_MESSAGE);
    }
    const successorInput: DesignatedSuccessorInput = {
      home: input.home,
      targetProtocolVersion: input.clientProtocolVersion,
      handoffCapability,
    };
    try {
      await control.reserveUpgrade({
        targetProtocolVersion: input.clientProtocolVersion,
        handoffCapability,
      });
      await control.shutdownForUpgrade({
        targetProtocolVersion: input.clientProtocolVersion,
        handoffCapability,
      });
    } catch (error) {
      await control.close().catch(() => {});
      await fence.release();
      if (errorCode(error) === -32_003) {
        return refusal(EXIT_DAEMON_UNAVAILABLE, HANDOFF_RESERVED_MESSAGE);
      }
      if (errorCode(error) === -32_004) {
        return refusal(EXIT_DAEMON_UNAVAILABLE, UPGRADE_BUSY_MESSAGE);
      }
      return refusal(EXIT_DAEMON_UNAVAILABLE, UNTRUSTED_PEER_MESSAGE);
    }
    await control.close().catch(() => {});

    let releaseOutcome: WriterReleaseWaitOutcome;
    try {
      releaseOutcome = await dependencies.waitForWriterRelease({
        home: input.home,
        incumbent: peer,
        deadlineMs: dependencies.timer.nowMs() + UPGRADE_WRITER_RELEASE_TIMEOUT_MS,
        pollIntervalMs: UPGRADE_OBSERVATION_INTERVAL_MS,
        timer: dependencies.timer,
      });
    } catch {
      releaseOutcome = { status: "observation-invalid" };
    }
    if (releaseOutcome.status !== "released") {
      await fence.release();
      return refusal(
        EXIT_DAEMON_UNAVAILABLE,
        releaseOutcome.status === "timeout" ? UPGRADE_BUSY_MESSAGE : UNTRUSTED_PEER_MESSAGE,
      );
    }

    let supervisorServiceInstalled: boolean | undefined;
    if (observed.owner === "ephemeral-client-started" || observed.owner === "app-supervised") {
      try {
        supervisorServiceInstalled = await dependencies.serviceUpgrade.isInstalled(input.home);
      } catch {
        await fence.release();
        return refusal(EXIT_DAEMON_UNAVAILABLE, UPGRADE_SUCCESSOR_FAILED_MESSAGE);
      }
      if (
        observed.owner === "ephemeral-client-started" &&
        !supervisorServiceInstalled &&
        (input.caller === "serve" || input.caller === "service")
      ) {
        return { status: "become-successor", fence, handoffCapability };
      }
    }

    try {
      if (observed.owner === "service-managed") {
        await dependencies.serviceUpgrade.restartInstalledService(successorInput);
      } else if (observed.owner === "app-supervised" && supervisorServiceInstalled === true) {
        await dependencies.serviceUpgrade.restartInstalledService(successorInput);
      } else if (
        observed.owner === "ephemeral-client-started" &&
        supervisorServiceInstalled === true
      ) {
        await dependencies.serviceUpgrade.kickstartInstalledServiceAfterEphemeral(successorInput);
      } else {
        await dependencies.serviceUpgrade.startEphemeralSuccessor(successorInput);
      }
    } catch {
      await fence.release();
      return refusal(EXIT_DAEMON_UNAVAILABLE, UPGRADE_SUCCESSOR_FAILED_MESSAGE);
    }

    let published: CompatiblePeerWaitOutcome;
    try {
      published = await dependencies.waitForCompatiblePeer({
        home: input.home,
        protocolVersion: input.clientProtocolVersion,
        token: input.bearerToken,
        deadlineMs: dependencies.timer.nowMs() + UPGRADE_SUCCESSOR_PUBLISH_TIMEOUT_MS,
        pollIntervalMs: UPGRADE_OBSERVATION_INTERVAL_MS,
        timer: dependencies.timer,
      });
    } catch {
      published = { status: "observation-invalid" };
    }
    const publishedHandshake =
      published.status === "published"
        ? ServerHandshakeFrameSchema.safeParse(published.handshake)
        : undefined;
    if (
      published.status !== "published" ||
      publishedHandshake?.success !== true ||
      publishedHandshake.data.status !== "accepted" ||
      publishedHandshake.data.clientProtocolVersion !== input.clientProtocolVersion ||
      publishedHandshake.data.serverProtocolVersion !== input.clientProtocolVersion ||
      publishedHandshake.data.athleteHome !== input.home.root
    ) {
      await fence.release();
      return refusal(EXIT_DAEMON_UNAVAILABLE, UPGRADE_SUCCESSOR_FAILED_MESSAGE);
    }
    await fence.release();
    return compatibleResolution(input.caller, published.peer, publishedHandshake.data);
  };

  return resolvePeer(input.peer, true);
}
