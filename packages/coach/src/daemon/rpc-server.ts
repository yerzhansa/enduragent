import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  WindowsPrivatePathPolicyError,
  assertWindowsPrivateDirectoryStable,
  assertWindowsPrivateFileBinding,
  assertWindowsPrivateFileMetadata,
  assertWindowsPrivatePathRead,
  bindWindowsPrivateDirectory,
  classifyWindowsPrivatePathFailure,
  sameWindowsPrivatePathIdentity,
  windowsPrivatePathIdentity,
  type WindowsPrivateDirectoryBinding,
} from "@enduragent/core";
import {
  ClientHandshakeFrameSchema,
  COACH_RPC_METHOD_REGISTRY,
  AthleteHomeIdentitySchema,
  CoachOperationProgressNotificationEnvelopeSchema,
  CoachPlanProgressNotificationEnvelopeSchema,
  CoachRpcRequestEnvelopeSchema,
  CoachTurnEventNotificationEnvelopeSchema,
  JsonRpcErrorResponseEnvelopeSchema,
  JsonRpcIdSchema,
  JsonRpcProtocolErrorResponseEnvelopeSchema,
  JsonRpcRequestEnvelopeSchema,
  JsonRpcSuccessResponseEnvelopeSchema,
  PROTOCOL_VERSION,
  RendererCapabilitySchema,
  compareProtocolVersions,
  createAcceptedServerHandshakeFrame,
  createVersionMismatchServerHandshakeFrame,
  serializeCoachRpcEnvelope,
  type CoachEngine,
  type CoachOperations,
  type PlanningReadOperations,
  type PlanCreationOperations,
  type PlanningRequestOperations,
  type CoachRpcMethodName,
  type CoachSelfTestOperations,
  type DaemonOwner,
  type GetSpendSummaryRpcParams,
  type JsonRpcId,
  type PlanningOperations,
  type SetDailySpendCapRpcParams,
  type SpendSummary,
} from "@enduragent/coach-contract";
import { unavailableChatAttachmentAdmission } from "../attachment-operations.js";
import type { WriterProtocolHandlers } from "@enduragent/kernel-node/lock";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import type { DaemonHealthState } from "./healthz-server.js";
import { DetachedSessionRequestError } from "./session-queue.js";
import {
  DaemonAdmissionClosedError,
  createInvocationCoordinator,
  type AdmissionFence,
  type InvocationCoordinator,
} from "./invocation-coordinator.js";
import { HANDOFF_CAPABILITY_BYTES, type MonotonicTimer } from "./upgrade-fence.js";
import { serializeBoundaryError } from "./error-boundary.js";
import type { DesktopTelegramController } from "../desktop-telegram-controller.js";

const AUTH_TIMEOUT_MS = 1_000;
const MAX_DAEMON_TOKEN_FILE_BYTES = 44;
const MAX_PAYLOAD_BYTES = 1_048_576;
const MAX_FRAGMENTS_PER_MESSAGE = 64;
const MAX_BUFFERED_CHUNKS_PER_MESSAGE = 256;
const AUTH_FAILURE_REASON = "authentication failed";
const FORBIDDEN_RESPONSE =
  "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
const BAD_REQUEST_RESPONSE =
  "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
const NOT_FOUND_RESPONSE =
  "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
const UNAVAILABLE_RESPONSE =
  "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

export const UPGRADE_DRAIN_TIMEOUT_MS = 30_000 as const;

export type UpgradeDrainOutcome = { readonly status: "accepted" } | { readonly status: "timeout" };

export interface UpgradeReservation {
  readonly connectionId: string;
  readonly targetProtocolVersion: number;
  readonly handoffCapabilityBytes: Buffer;
  readonly state: "reserved" | "shutdown-consumed";
}

export interface DaemonToken {
  readonly path: string;
  readonly value: string;
}

export interface DaemonTokenDependencies {
  readonly openFile?: typeof open;
  readonly randomBytes?: typeof randomBytes;
  readonly platform?: NodeJS.Platform;
}

function validToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

async function readExistingWindowsToken(
  path: string,
  directory: WindowsPrivateDirectoryBinding,
  openFile: typeof open,
): Promise<DaemonToken> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw classifyWindowsPrivatePathFailure("entry-check", error);
  }
  assertWindowsPrivateFileMetadata(metadata);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let result: DaemonToken | undefined;
  let failure: WindowsPrivatePathPolicyError | undefined;
  try {
    handle = await openFile(path, constants.O_RDONLY);
    const openedMetadata = await handle.stat();
    assertWindowsPrivateFileMetadata(openedMetadata);
    if (
      !sameWindowsPrivatePathIdentity(
        windowsPrivatePathIdentity(metadata),
        windowsPrivatePathIdentity(openedMetadata),
      )
    ) {
      throw new WindowsPrivatePathPolicyError("binding-check", "corruption");
    }
    assertWindowsPrivateFileBinding(directory, path, windowsPrivatePathIdentity(openedMetadata));
    const bytes = Buffer.allocUnsafe(MAX_DAEMON_TOKEN_FILE_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const afterRead = await handle.stat();
    assertWindowsPrivateFileMetadata(afterRead);
    const current = assertWindowsPrivateFileBinding(
      directory,
      path,
      windowsPrivatePathIdentity(afterRead),
    );
    const raw = bytes.subarray(0, offset).toString("utf8");
    const value = raw.endsWith("\n") ? raw.slice(0, -1) : "";
    const contentValid =
      offset === MAX_DAEMON_TOKEN_FILE_BYTES && validToken(value) && raw === `${value}\n`;
    assertWindowsPrivatePathRead({
      bounded: offset <= MAX_DAEMON_TOKEN_FILE_BYTES,
      identityStable:
        sameWindowsPrivatePathIdentity(
          windowsPrivatePathIdentity(openedMetadata),
          windowsPrivatePathIdentity(afterRead),
        ) &&
        openedMetadata.size === afterRead.size &&
        openedMetadata.size === current.size &&
        openedMetadata.mtimeMs === afterRead.mtimeMs &&
        openedMetadata.mtimeMs === current.mtimeMs &&
        openedMetadata.ctimeMs === afterRead.ctimeMs &&
        openedMetadata.ctimeMs === current.ctimeMs,
      contentValid,
      authenticatedHomeBinding: true,
    });
    result = { path, value };
  } catch (error) {
    failure = classifyWindowsPrivatePathFailure("read-check", error);
  }
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch (error) {
      failure ??= classifyWindowsPrivatePathFailure("read-check", error);
    }
  }
  if (failure !== undefined) throw failure;
  if (result === undefined) {
    throw new WindowsPrivatePathPolicyError("read-check", "io-failure");
  }
  return result;
}

async function readExistingToken(path: string): Promise<DaemonToken> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600) {
    throw new Error("daemon token file is invalid");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw: string;
  try {
    const openedMetadata = await handle.stat();
    if (
      !openedMetadata.isFile() ||
      (openedMetadata.mode & 0o777) !== 0o600 ||
      openedMetadata.dev !== metadata.dev ||
      openedMetadata.ino !== metadata.ino
    ) {
      throw new Error("daemon token file is invalid");
    }
    raw = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  const value = raw.endsWith("\n") ? raw.slice(0, -1) : "";
  if (!validToken(value) || raw !== `${value}\n`) {
    throw new Error("daemon token file is invalid");
  }
  return { path, value };
}

async function ensureWindowsDaemonToken(
  configDir: string,
  dependencies: DaemonTokenDependencies,
): Promise<DaemonToken> {
  const path = join(configDir, "daemon.token");
  const openFile = dependencies.openFile ?? open;
  const directory = bindWindowsPrivateDirectory(dirname(configDir), configDir);
  try {
    return await readExistingWindowsToken(path, directory, openFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const value = (dependencies.randomBytes ?? randomBytes)(32).toString("base64url");
  if (!validToken(value)) throw new Error("daemon token generation failed");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let stage: "content-write" | "file-flush" = "content-write";
  let failure: WindowsPrivatePathPolicyError | undefined;
  try {
    assertWindowsPrivateDirectoryStable(directory);
    handle = await openFile(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    const created = await handle.stat();
    assertWindowsPrivateFileMetadata(created);
    assertWindowsPrivateFileBinding(directory, path, windowsPrivatePathIdentity(created));
    await handle.writeFile(`${value}\n`, "utf8");
    stage = "file-flush";
    await handle.sync();
    const synced = await handle.stat();
    assertWindowsPrivateFileMetadata(synced);
    assertWindowsPrivateFileBinding(directory, path, windowsPrivatePathIdentity(synced));
    await handle.close();
    handle = undefined;
  } catch (error) {
    if (handle === undefined && (error as NodeJS.ErrnoException).code === "EEXIST") {
      return readExistingWindowsToken(path, directory, openFile);
    }
    failure = classifyWindowsPrivatePathFailure(stage, error);
  }
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch (error) {
      failure ??= classifyWindowsPrivatePathFailure(stage, error);
    }
  }
  if (failure !== undefined) throw failure;
  const persisted = await readExistingWindowsToken(path, directory, openFile);
  if (persisted.value !== value) {
    throw new WindowsPrivatePathPolicyError("read-check", "corruption");
  }
  return persisted;
}

export async function ensureDaemonToken(
  configDir: string,
  dependencies: DaemonTokenDependencies = {},
): Promise<DaemonToken> {
  if ((dependencies.platform ?? process.platform) === "win32") {
    return ensureWindowsDaemonToken(configDir, dependencies);
  }
  const path = join(configDir, "daemon.token");
  try {
    return await readExistingToken(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const value = (dependencies.randomBytes ?? randomBytes)(32).toString("base64url");
  if (!validToken(value)) throw new Error("daemon token generation failed");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(`${value}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return readExistingToken(path);
    }
    throw error;
  } finally {
    await handle?.close();
  }
  return { path, value };
}

export interface CoachRpcServerInput {
  readonly engine: CoachEngine;
  readonly operations: CoachOperations &
    PlanningReadOperations &
    PlanningRequestOperations &
    PlanCreationOperations &
    PlanningOperations;
  readonly spend: SpendRpcHandlers;
  readonly selfTestOperations: CoachSelfTestOperations;
  readonly telegram: DesktopTelegramController;
  readonly token: string;
  readonly owner: DaemonOwner;
  readonly athleteHome: string;
  readonly rendererCapabilityRandomBytes?: (size: number) => Buffer;
  readonly healthState?: DaemonHealthState;
  readonly timer?: MonotonicTimer;
  readonly invocations?: InvocationCoordinator;
  readonly beforeInvocationDrain?: () => Promise<void>;
  readonly afterInvocationDrainRefusal?: () => Promise<void>;
  readonly scheduleInitialRefresh?: () => void;
}

export interface SpendRpcHandlers {
  readonly getSpendSummary: (params: GetSpendSummaryRpcParams) => Promise<SpendSummary>;
  readonly setDailySpendCap: (params: SetDailySpendCapRpcParams) => Promise<SpendSummary>;
}

export interface CoachRpcServer {
  readonly handleUpgrade: WriterProtocolHandlers["upgrade"];
  readonly shutdownRequested: Promise<void>;
  close(): Promise<void>;
}

interface ClientState {
  readonly ws: WebSocket;
  readonly activeIds: Set<string>;
  readonly requestTasks: Set<Promise<void>>;
  readonly pendingSendResolvers: Set<() => void>;
  readonly detachedPromise: Promise<void>;
  readonly resolveDetached: () => void;
  readonly closedPromise: Promise<void>;
  readonly resolveClosed: () => void;
  readonly detachController: AbortController;
  readonly connectionId: string;
  sendTail: Promise<void>;
  authTimer: ReturnType<typeof setTimeout> | undefined;
  authenticated: boolean;
  authority: "privileged" | "renderer" | undefined;
  detached: boolean;
  closed: boolean;
}

function createClientState(ws: WebSocket, connectionId: string): ClientState {
  let resolveDetached!: () => void;
  let resolveClosed!: () => void;
  const detachedPromise = new Promise<void>((resolve) => {
    resolveDetached = resolve;
  });
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  return {
    ws,
    activeIds: new Set(),
    requestTasks: new Set(),
    pendingSendResolvers: new Set(),
    detachedPromise,
    resolveDetached,
    closedPromise,
    resolveClosed,
    detachController: new AbortController(),
    connectionId,
    sendTail: Promise.resolve(),
    authTimer: undefined,
    authenticated: false,
    authority: undefined,
    detached: false,
    closed: false,
  };
}

function clearAuthTimer(state: ClientState): void {
  if (state.authTimer === undefined) return;
  clearTimeout(state.authTimer);
  state.authTimer = undefined;
}

function detach(state: ClientState, closeCode?: number, reason?: string): void {
  if (!state.detached) {
    state.detached = true;
    state.detachController.abort();
    state.resolveDetached();
    for (const resolve of state.pendingSendResolvers) resolve();
    state.pendingSendResolvers.clear();
  }
  if (closeCode !== undefined && state.ws.readyState === WebSocket.OPEN) {
    try {
      state.ws.close(closeCode, reason);
    } catch {
      state.ws.terminate();
    }
  }
}

function enqueueSerialized(state: ClientState, serialized: string): Promise<void> {
  const step = state.sendTail.then(async () => {
    if (state.detached) return;
    if (state.ws.bufferedAmount + Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_BYTES) {
      detach(state, 1013, "backpressure");
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        state.pendingSendResolvers.delete(finish);
        resolve();
      };
      state.pendingSendResolvers.add(finish);
      void state.detachedPromise.then(finish);
      try {
        state.ws.send(serialized, (error) => {
          if (error != null) detach(state, 1013, "backpressure");
          finish();
        });
      } catch {
        detach(state, 1013, "backpressure");
        finish();
      }
    });
  });
  state.sendTail = step.catch(() => {});
  return state.sendTail;
}

function protocolError(code: -32700 | -32600, message: string): string {
  return serializeCoachRpcEnvelope(
    JsonRpcProtocolErrorResponseEnvelopeSchema.parse({
      jsonrpc: "2.0",
      id: null,
      error: { code, message },
    }),
  );
}

function ordinaryError(id: JsonRpcId, code: number, message: string): string {
  return serializeCoachRpcEnvelope(
    JsonRpcErrorResponseEnvelopeSchema.parse({
      jsonrpc: "2.0",
      id,
      error: { code, message },
    }),
  );
}

function internalError(id: JsonRpcId, error: unknown): string {
  return serializeCoachRpcEnvelope(
    JsonRpcErrorResponseEnvelopeSchema.parse({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message: "Internal error",
        data: serializeBoundaryError(error),
      },
    }),
  );
}

function ordinarySuccess(id: JsonRpcId, result: unknown): string {
  return serializeCoachRpcEnvelope(
    JsonRpcSuccessResponseEnvelopeSchema.parse({ jsonrpc: "2.0", id, result }),
  );
}

function recoveredId(value: unknown): JsonRpcId | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(value, "id")) return undefined;
  const parsed = JsonRpcIdSchema.safeParse((value as { readonly id?: unknown }).id);
  return parsed.success ? parsed.data : undefined;
}

function methodExists(method: string): method is CoachRpcMethodName {
  return Object.prototype.hasOwnProperty.call(COACH_RPC_METHOD_REGISTRY, method);
}

function idKey(id: JsonRpcId): string {
  return `${typeof id}:${JSON.stringify(id)}`;
}

function rawText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function sameToken(received: string, expected: string): boolean {
  const left = Buffer.from(received, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

const RENDERER_RPC_METHODS = new Set<CoachRpcMethodName>([
  "chat",
  "stopChat",
  "getChatAttachmentComposer",
  "saveChatAttachmentDraftText",
  "removeChatAttachment",
  "retryChatAttachment",
  "selectChatAttachmentWorkout",
  "clearChatAttachmentDraft",
  "enqueueChatMessage",
  "getChatQueue",
  "removeQueuedChatMessage",
  "resumeChatQueue",
  "runQueuedCommand",
  "retryQueuedTurn",
  "getCoachDecision",
  "answerCoachDecision",
  "skipCoachDecision",
  "resumeCoachDecision",
  "resetSession",
  "hasSession",
  "getTranscriptPage",
  "listArchivedConversations",
  "deleteArchivedConversation",
  "getArchivedTranscriptPage",
  "getAthleteState",
  "getPlanningReadModel",
  "getActivityAnalysis",
  "importFiles",
  "sync",
  "getSetupStatus",
  "saveIntake",
  "configureRuntime",
  "getRuntimeConfig",
  "getUnitsPreference",
  "setUnitsPreference",
  "getSpendSummary",
  "setDailySpendCap",
  "selfTest",
  "getPlanState",
  "executePlanTransition",
  "createPlanningRequest",
  "createWorkoutPlanningRequest",
  "getPlanningRequest",
  "retryPlanningRequest",
  "resumePlanningRequests",
  "listPlanningRequests",
  "plan_creation.start",
  "plan_creation.answer",
]);

const PLAN_CHAT_RENDERER_METHODS = new Set<CoachRpcMethodName>([
  "stopChat",
  "enqueueChatMessage",
  "getChatQueue",
  "removeQueuedChatMessage",
  "resumeChatQueue",
  "runQueuedCommand",
  "retryQueuedTurn",
]);

function rendererChatIdAllowed(method: CoachRpcMethodName, chatId: string): boolean {
  if (chatId === "desktop") return true;
  return PLAN_CHAT_RENDERER_METHODS.has(method) && /^plan:[0-9A-HJKMNP-TV-Z]{26}$/u.test(chatId);
}

function generateRendererCapability(
  privilegedToken: string,
  generateBytes: (size: number) => Buffer,
): string {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const capability = generateBytes(32).toString("base64url");
    if (
      RendererCapabilitySchema.safeParse(capability).success &&
      !sameToken(capability, privilegedToken)
    ) {
      return capability;
    }
  }
  throw new Error("renderer capability generation failed");
}

function rendererRuntimePatchAllowed(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const params = value as Record<string, unknown>;
  if (Object.keys(params).some((key) => key !== "intervals" && key !== "session")) return false;
  if (params.intervals !== undefined) {
    if (
      params.intervals === null ||
      typeof params.intervals !== "object" ||
      Array.isArray(params.intervals) ||
      Object.keys(params.intervals).some((key) => key !== "athlete_id")
    ) {
      return false;
    }
  }
  if (params.session !== undefined) {
    if (
      params.session === null ||
      typeof params.session !== "object" ||
      Array.isArray(params.session)
    ) {
      return false;
    }
    const allowedSessionFields = new Set([
      "historyTokenBudgetRatio",
      "idleMinutes",
      "dailyResetHour",
      "resetArchiveRetentionDays",
      "timezone",
    ]);
    if (Object.keys(params.session).some((key) => !allowedSessionFields.has(key))) return false;
  }
  return true;
}

function productionTimer(): MonotonicTimer {
  return {
    nowMs: () => performance.now(),
    schedule(delayMs, callback) {
      const handle = setTimeout(callback, Math.max(0, delayMs));
      handle.unref?.();
      return { cancel: () => clearTimeout(handle) };
    },
  };
}

function canonicalCapability(value: unknown): Buffer | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== HANDOFF_CAPABILITY_BYTES || decoded.toString("base64url") !== value) {
    return undefined;
  }
  return decoded;
}

function controlParams(value: unknown):
  | {
      readonly targetProtocolVersion: number;
      readonly handoffCapability: string;
    }
  | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "handoffCapability" ||
    keys[1] !== "targetProtocolVersion" ||
    !Number.isSafeInteger(record.targetProtocolVersion) ||
    (record.targetProtocolVersion as number) < 0 ||
    typeof record.handoffCapability !== "string"
  ) {
    return undefined;
  }
  return {
    targetProtocolVersion: record.targetProtocolVersion as number,
    handoffCapability: record.handoffCapability,
  };
}

function emptyControlParams(value: unknown): value is Record<string, never> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

function refuseUpgrade(
  socket: Parameters<WriterProtocolHandlers["upgrade"]>[1],
  response: string,
): void {
  socket.once("error", () => socket.destroy());
  socket.write(response, "ascii", () => socket.destroy());
}

export function createCoachRpcServer(input: CoachRpcServerInput): CoachRpcServer {
  const athleteHome = AthleteHomeIdentitySchema.parse(input.athleteHome);
  const rendererCapability = generateRendererCapability(
    input.token,
    input.rendererCapabilityRandomBytes ?? randomBytes,
  );
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
    maxFragments: MAX_FRAGMENTS_PER_MESSAGE,
    maxBufferedChunks: MAX_BUFFERED_CHUNKS_PER_MESSAGE,
  });
  const clients = new Set<ClientState>();
  const invocations = input.invocations ?? createInvocationCoordinator();
  const timer = input.timer ?? productionTimer();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let reservation: UpgradeReservation | undefined;
  let connectionSequence = 0;
  let resolveShutdownRequested!: () => void;
  const shutdownRequested = new Promise<void>((resolve) => {
    resolveShutdownRequested = resolve;
  });

  const clearReservation = (): void => {
    reservation?.handoffCapabilityBytes.fill(0);
    reservation = undefined;
  };

  const restoreAfterDrainRefusal = (fence: AdmissionFence): boolean => {
    if (!fence.reopen()) return false;
    input.healthState?.setHealthy(true);
    void Promise.resolve()
      .then(() => input.afterInvocationDrainRefusal?.())
      .catch(() => {});
    return true;
  };

  const awaitDrain = (
    drainTask: Promise<void>,
    deadlineMs: number,
    state: ClientState,
  ): Promise<UpgradeDrainOutcome | { readonly status: "connection-closed" }> => {
    return new Promise((resolve) => {
      let settled = false;
      const deadline = timer.schedule(Math.max(0, deadlineMs - timer.nowMs()), () => {
        if (settled) return;
        settled = true;
        deadline.cancel();
        resolve({ status: "timeout" });
      });
      void drainTask.then(
        () => {
          if (settled) return;
          settled = true;
          deadline.cancel();
          resolve({ status: "accepted" });
        },
        () => {
          if (settled) return;
          settled = true;
          deadline.cancel();
          resolve({ status: "timeout" });
        },
      );
      void state.detachedPromise.then(() => {
        if (settled) return;
        settled = true;
        deadline.cancel();
        resolve({ status: "connection-closed" });
      });
    });
  };

  const handleRequest = (state: ClientState, data: RawData, isBinary: boolean): void => {
    if (closing) {
      detach(state, 1001);
      return;
    }
    if (isBinary) {
      void enqueueSerialized(state, protocolError(-32600, "Invalid Request"));
      return;
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawText(data));
    } catch {
      void enqueueSerialized(state, protocolError(-32700, "Parse error"));
      return;
    }
    const generic = JsonRpcRequestEnvelopeSchema.safeParse(parsedJson);
    if (!generic.success) {
      const id = recoveredId(parsedJson);
      void enqueueSerialized(
        state,
        id === undefined
          ? protocolError(-32600, "Invalid Request")
          : ordinaryError(id, -32600, "Invalid Request"),
      );
      return;
    }
    if (
      generic.data.method === "daemon.reserveUpgrade" ||
      generic.data.method === "daemon.shutdownForUpgrade" ||
      generic.data.method === "daemon.startInitialRefresh"
    ) {
      if (state.authority !== "privileged") {
        void enqueueSerialized(state, ordinaryError(generic.data.id, -32601, "Method not found"));
        return;
      }
      if (generic.data.method === "daemon.startInitialRefresh") {
        if (!emptyControlParams(generic.data.params)) {
          void enqueueSerialized(state, ordinaryError(generic.data.id, -32602, "Invalid params"));
          return;
        }
        try {
          if (input.scheduleInitialRefresh === undefined) {
            throw new Error("initial refresh scheduling unavailable");
          }
          input.scheduleInitialRefresh();
        } catch (error) {
          void enqueueSerialized(state, internalError(generic.data.id, error));
          return;
        }
        void enqueueSerialized(state, ordinarySuccess(generic.data.id, { status: "accepted" }));
        return;
      }
      const params = controlParams(generic.data.params);
      if (params === undefined) {
        void enqueueSerialized(state, ordinaryError(generic.data.id, -32602, "Invalid params"));
        return;
      }
      if (generic.data.method === "daemon.reserveUpgrade") {
        const capability = canonicalCapability(params.handoffCapability);
        if (
          reservation !== undefined ||
          capability === undefined ||
          params.targetProtocolVersion <= PROTOCOL_VERSION ||
          input.owner === "unmanaged-foreground"
        ) {
          void enqueueSerialized(
            state,
            ordinaryError(generic.data.id, -32_003, "handoff-reservation-refused"),
          );
          return;
        }
        reservation = {
          connectionId: state.connectionId,
          targetProtocolVersion: params.targetProtocolVersion,
          handoffCapabilityBytes: Buffer.from(capability),
          state: "reserved",
        };
        capability.fill(0);
        void enqueueSerialized(state, ordinarySuccess(generic.data.id, { status: "reserved" }));
        return;
      }
      const capability = canonicalCapability(params.handoffCapability);
      const activeReservation = reservation;
      if (
        capability === undefined ||
        activeReservation === undefined ||
        activeReservation.state !== "reserved" ||
        activeReservation.connectionId !== state.connectionId ||
        activeReservation.targetProtocolVersion !== params.targetProtocolVersion ||
        capability.length !== activeReservation.handoffCapabilityBytes.length ||
        !timingSafeEqual(capability, activeReservation.handoffCapabilityBytes)
      ) {
        capability?.fill(0);
        void enqueueSerialized(
          state,
          ordinaryError(generic.data.id, -32_003, "handoff-reservation-refused"),
        );
        return;
      }
      capability.fill(0);
      reservation = { ...activeReservation, state: "shutdown-consumed" };
      const fence = invocations.closeAdmission();
      input.healthState?.setHealthy(false);
      const task = (async () => {
        const drainTask = Promise.resolve().then(async () => {
          await input.beforeInvocationDrain?.();
          await fence.drain();
        });
        const outcome = await awaitDrain(
          drainTask,
          timer.nowMs() + UPGRADE_DRAIN_TIMEOUT_MS,
          state,
        );
        if (outcome.status !== "accepted") {
          restoreAfterDrainRefusal(fence);
          clearReservation();
          if (outcome.status === "timeout") {
            await enqueueSerialized(
              state,
              ordinaryError(generic.data.id, -32_004, "upgrade-drain-timeout"),
            );
          }
          return;
        }
        await enqueueSerialized(state, ordinarySuccess(generic.data.id, { status: "accepted" }));
        if (state.detached) {
          restoreAfterDrainRefusal(fence);
          clearReservation();
          return;
        }
        fence.seal();
        clearReservation();
        resolveShutdownRequested();
      })();
      state.requestTasks.add(task);
      void task.finally(() => state.requestTasks.delete(task)).catch(() => {});
      return;
    }
    if (!methodExists(generic.data.method)) {
      void enqueueSerialized(state, ordinaryError(generic.data.id, -32601, "Method not found"));
      return;
    }
    if (state.authority === "renderer" && !RENDERER_RPC_METHODS.has(generic.data.method)) {
      void enqueueSerialized(state, ordinaryError(generic.data.id, -32601, "Method not found"));
      return;
    }
    const registry = COACH_RPC_METHOD_REGISTRY[generic.data.method];
    const specialized = CoachRpcRequestEnvelopeSchema.safeParse(generic.data);
    const params = registry.requestSchema.safeParse(generic.data.params);
    if (!specialized.success || !params.success) {
      void enqueueSerialized(state, ordinaryError(generic.data.id, -32602, "Invalid params"));
      return;
    }
    if (
      generic.data.method === "chat" ||
      generic.data.method === "stopChat" ||
      generic.data.method === "admitChatAttachment" ||
      generic.data.method === "admitPastedChatAttachment" ||
      generic.data.method === "getChatAttachmentComposer" ||
      generic.data.method === "saveChatAttachmentDraftText" ||
      generic.data.method === "removeChatAttachment" ||
      generic.data.method === "retryChatAttachment" ||
      generic.data.method === "selectChatAttachmentWorkout" ||
      generic.data.method === "clearChatAttachmentDraft" ||
      generic.data.method === "enqueueChatMessage" ||
      generic.data.method === "getChatQueue" ||
      generic.data.method === "removeQueuedChatMessage" ||
      generic.data.method === "resumeChatQueue" ||
      generic.data.method === "runQueuedCommand" ||
      generic.data.method === "retryQueuedTurn" ||
      generic.data.method === "getCoachDecision" ||
      generic.data.method === "answerCoachDecision" ||
      generic.data.method === "skipCoachDecision" ||
      generic.data.method === "resumeCoachDecision" ||
      generic.data.method === "resetSession" ||
      generic.data.method === "hasSession"
    ) {
      const chatId = (params.data as { readonly chatId: string }).chatId;
      if (
        chatId.startsWith("telegram:") ||
        ((generic.data.method === "admitChatAttachment" ||
          generic.data.method === "admitPastedChatAttachment") &&
          chatId !== "desktop") ||
        (state.authority === "renderer" && !rendererChatIdAllowed(generic.data.method, chatId))
      ) {
        void enqueueSerialized(state, ordinaryError(generic.data.id, -32602, "Invalid params"));
        return;
      }
    }
    if (
      state.authority === "renderer" &&
      generic.data.method === "configureRuntime" &&
      !rendererRuntimePatchAllowed(params.data)
    ) {
      void enqueueSerialized(state, ordinaryError(generic.data.id, -32602, "Invalid params"));
      return;
    }
    const requestIdKey = idKey(generic.data.id);
    if (state.activeIds.has(requestIdKey)) {
      detach(state, 1008);
      return;
    }
    state.activeIds.add(requestIdKey);
    const runRequest = async (): Promise<void> => {
      let invocationFailure: { readonly error: unknown } | undefined;
      let eventFailure: { readonly error: unknown } | undefined;
      let deliveryDetached = false;
      let result: unknown;
      try {
        switch (registry.wireName) {
          case "chat":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.chat.requestSchema.parse(
                generic.data.params,
              );
              result = await input.engine.chat(request, (event) => {
                if (eventFailure !== undefined) return;
                try {
                  const parsedEvent = COACH_RPC_METHOD_REGISTRY.chat.eventSchema.parse(event);
                  const notification = CoachTurnEventNotificationEnvelopeSchema.parse({
                    jsonrpc: "2.0",
                    method: "coach.turnEvent",
                    params: {
                      requestId: generic.data.id,
                      requestMethod: "chat",
                      turnId: parsedEvent.turnId,
                      event: parsedEvent,
                    },
                  });
                  void enqueueSerialized(state, serializeCoachRpcEnvelope(notification));
                } catch (error) {
                  eventFailure = { error };
                }
              });
            } catch (error) {
              if (error instanceof DetachedSessionRequestError) deliveryDetached = true;
              else invocationFailure = { error };
            }
            break;
          case "stopChat":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.stopChat.requestSchema.parse(
                generic.data.params,
              );
              result =
                input.engine.stopChat === undefined
                  ? { stopped: false }
                  : await input.engine.stopChat(request);
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "admitChatAttachment":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.admitChatAttachment.requestSchema.parse(
                generic.data.params,
              );
              result =
                input.operations.admitChatAttachment === undefined
                  ? unavailableChatAttachmentAdmission(request)
                  : await input.operations.admitChatAttachment(request);
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "admitPastedChatAttachment":
            try {
              const request =
                COACH_RPC_METHOD_REGISTRY.admitPastedChatAttachment.requestSchema.parse(
                  generic.data.params,
                );
              result =
                input.operations.admitPastedChatAttachment === undefined
                  ? {
                      selectionId: request.selectionId,
                      displayName: request.displayName,
                      status: "storage_failed",
                      failureCode: "admission_unavailable",
                      retryable: false,
                    }
                  : await input.operations.admitPastedChatAttachment(request);
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "getChatAttachmentComposer":
            try {
              if (input.operations.getChatAttachmentComposer === undefined) {
                throw new Error("chat attachment composer unavailable");
              }
              result = await input.operations.getChatAttachmentComposer(
                COACH_RPC_METHOD_REGISTRY.getChatAttachmentComposer.requestSchema.parse(
                  generic.data.params,
                ),
              );
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "saveChatAttachmentDraftText":
            try {
              if (input.operations.saveChatAttachmentDraftText === undefined) {
                throw new Error("chat attachment draft unavailable");
              }
              result = await input.operations.saveChatAttachmentDraftText(
                COACH_RPC_METHOD_REGISTRY.saveChatAttachmentDraftText.requestSchema.parse(
                  generic.data.params,
                ),
              );
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "removeChatAttachment":
            try {
              if (input.operations.removeChatAttachment === undefined) {
                throw new Error("chat attachment removal unavailable");
              }
              result = await input.operations.removeChatAttachment(
                COACH_RPC_METHOD_REGISTRY.removeChatAttachment.requestSchema.parse(
                  generic.data.params,
                ),
              );
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "retryChatAttachment":
            try {
              if (input.operations.retryChatAttachment === undefined) {
                throw new Error("chat attachment retry unavailable");
              }
              result = await input.operations.retryChatAttachment(
                COACH_RPC_METHOD_REGISTRY.retryChatAttachment.requestSchema.parse(
                  generic.data.params,
                ),
              );
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "selectChatAttachmentWorkout":
            try {
              if (input.operations.selectChatAttachmentWorkout === undefined) {
                throw new Error("chat attachment workout selection unavailable");
              }
              result = await input.operations.selectChatAttachmentWorkout(
                COACH_RPC_METHOD_REGISTRY.selectChatAttachmentWorkout.requestSchema.parse(
                  generic.data.params,
                ),
              );
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "clearChatAttachmentDraft":
            try {
              if (input.operations.clearChatAttachmentDraft === undefined) {
                throw new Error("chat attachment draft cleanup unavailable");
              }
              result = await input.operations.clearChatAttachmentDraft(
                COACH_RPC_METHOD_REGISTRY.clearChatAttachmentDraft.requestSchema.parse(
                  generic.data.params,
                ),
              );
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "enqueueChatMessage":
            try {
              result = await input.engine.enqueueChatMessage!(
                COACH_RPC_METHOD_REGISTRY.enqueueChatMessage.requestSchema.parse(
                  generic.data.params,
                ),
              );
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "getChatQueue":
            try {
              result = await input.engine.getChatQueue!(
                COACH_RPC_METHOD_REGISTRY.getChatQueue.requestSchema.parse(generic.data.params),
              );
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "removeQueuedChatMessage":
            try {
              result = await input.engine.removeQueuedChatMessage!(
                COACH_RPC_METHOD_REGISTRY.removeQueuedChatMessage.requestSchema.parse(
                  generic.data.params,
                ),
              );
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "resumeChatQueue":
          case "runQueuedCommand":
          case "retryQueuedTurn":
            try {
              const method = registry.wireName;
              const request = COACH_RPC_METHOD_REGISTRY[method].requestSchema.parse(
                generic.data.params,
              ) as never;
              result = await input.engine[method]!(request, (event) => {
                if (eventFailure !== undefined) return;
                try {
                  const parsedEvent = COACH_RPC_METHOD_REGISTRY[method].eventSchema.parse(event);
                  const notification = CoachTurnEventNotificationEnvelopeSchema.parse({
                    jsonrpc: "2.0",
                    method: "coach.turnEvent",
                    params: {
                      requestId: generic.data.id,
                      requestMethod: method,
                      turnId: parsedEvent.turnId,
                      event: parsedEvent,
                    },
                  });
                  void enqueueSerialized(state, serializeCoachRpcEnvelope(notification));
                } catch (error) {
                  eventFailure = { error };
                }
              });
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "resetSession":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.resetSession.requestSchema.parse(
                generic.data.params,
              );
              result = await input.engine.resetSession(request);
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "hasSession":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.hasSession.requestSchema.parse(
                generic.data.params,
              );
              result = await input.engine.hasSession(request);
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "getCoachDecision":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.getCoachDecision.requestSchema.parse(
                generic.data.params,
              );
              result = await input.engine.getCoachDecision(request);
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "answerCoachDecision":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.answerCoachDecision.requestSchema.parse(
                generic.data.params,
              );
              result = await input.engine.answerCoachDecision(request, (event) => {
                if (eventFailure !== undefined) return;
                try {
                  const parsedEvent =
                    COACH_RPC_METHOD_REGISTRY.answerCoachDecision.eventSchema.parse(event);
                  const notification = CoachTurnEventNotificationEnvelopeSchema.parse({
                    jsonrpc: "2.0",
                    method: "coach.turnEvent",
                    params: {
                      requestId: generic.data.id,
                      requestMethod: "answerCoachDecision",
                      turnId: parsedEvent.turnId,
                      event: parsedEvent,
                    },
                  });
                  void enqueueSerialized(state, serializeCoachRpcEnvelope(notification));
                } catch (error) {
                  eventFailure = { error };
                }
              });
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "skipCoachDecision":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.skipCoachDecision.requestSchema.parse(
                generic.data.params,
              );
              result = await input.engine.skipCoachDecision(request);
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "resumeCoachDecision":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.resumeCoachDecision.requestSchema.parse(
                generic.data.params,
              );
              result = await input.engine.resumeCoachDecision(request, (event) => {
                if (eventFailure !== undefined) return;
                try {
                  const parsedEvent =
                    COACH_RPC_METHOD_REGISTRY.resumeCoachDecision.eventSchema.parse(event);
                  const notification = CoachTurnEventNotificationEnvelopeSchema.parse({
                    jsonrpc: "2.0",
                    method: "coach.turnEvent",
                    params: {
                      requestId: generic.data.id,
                      requestMethod: "resumeCoachDecision",
                      turnId: parsedEvent.turnId,
                      event: parsedEvent,
                    },
                  });
                  void enqueueSerialized(state, serializeCoachRpcEnvelope(notification));
                } catch (error) {
                  eventFailure = { error };
                }
              });
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "getTranscriptPage":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.getTranscriptPage.requestSchema.parse(
                generic.data.params,
              );
              result = await input.operations.getTranscriptPage(request);
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "listArchivedConversations":
            try {
              const request =
                COACH_RPC_METHOD_REGISTRY.listArchivedConversations.requestSchema.parse(
                  generic.data.params,
                );
              result = await input.operations.listArchivedConversations(request);
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "deleteArchivedConversation":
            try {
              const request =
                COACH_RPC_METHOD_REGISTRY.deleteArchivedConversation.requestSchema.parse(
                  generic.data.params,
                );
              result = await input.operations.deleteArchivedConversation(request);
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "getArchivedTranscriptPage":
            try {
              const request =
                COACH_RPC_METHOD_REGISTRY.getArchivedTranscriptPage.requestSchema.parse(
                  generic.data.params,
                );
              result = await input.operations.getArchivedTranscriptPage(request);
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "getAthleteState":
            try {
              COACH_RPC_METHOD_REGISTRY.getAthleteState.requestSchema.parse(generic.data.params);
              result = await input.engine.getAthleteState();
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "getPlanningReadModel":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.getPlanningReadModel.requestSchema.parse(
                generic.data.params,
              );
              if (input.operations.getPlanningReadModel === undefined) {
                throw new TypeError("Planning read operation is unavailable.");
              }
              result = await input.operations.getPlanningReadModel(request);
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "getActivityAnalysis":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.getActivityAnalysis.requestSchema.parse(
                generic.data.params,
              );
              if (input.operations.getActivityAnalysis === undefined) {
                throw new TypeError("Activity analysis operation is unavailable.");
              }
              result = await input.operations.getActivityAnalysis(
                request,
                state.detachController.signal,
              );
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "exportTrainingFile":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.exportTrainingFile.requestSchema.parse(
                generic.data.params,
              );
              if (input.operations.exportTrainingFile === undefined) {
                throw new TypeError("Training export operation is unavailable.");
              }
              result = await input.operations.exportTrainingFile(
                request,
                state.detachController.signal,
              );
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "importFiles":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.importFiles.requestSchema.parse(
                generic.data.params,
              );
              result = await input.operations.importFiles(request, (event) => {
                if (eventFailure !== undefined) return;
                try {
                  const parsedEvent =
                    COACH_RPC_METHOD_REGISTRY.importFiles.eventSchema.parse(event);
                  const notification = CoachOperationProgressNotificationEnvelopeSchema.parse({
                    jsonrpc: "2.0",
                    method: "coach.operationProgress",
                    params: {
                      requestId: generic.data.id,
                      requestMethod: "importFiles",
                      event: parsedEvent,
                    },
                  });
                  void enqueueSerialized(state, serializeCoachRpcEnvelope(notification));
                } catch (error) {
                  eventFailure = { error };
                }
              });
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "sync":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.sync.requestSchema.parse(
                generic.data.params,
              );
              result = await input.operations.sync(request, (event) => {
                if (eventFailure !== undefined) return;
                try {
                  const parsedEvent = COACH_RPC_METHOD_REGISTRY.sync.eventSchema.parse(event);
                  const notification = CoachOperationProgressNotificationEnvelopeSchema.parse({
                    jsonrpc: "2.0",
                    method: "coach.operationProgress",
                    params: {
                      requestId: generic.data.id,
                      requestMethod: "sync",
                      event: parsedEvent,
                    },
                  });
                  void enqueueSerialized(state, serializeCoachRpcEnvelope(notification));
                } catch (error) {
                  eventFailure = { error };
                }
              });
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "saveIntake":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.saveIntake.requestSchema.parse(
                generic.data.params,
              );
              result = await input.operations.saveIntake(request);
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "getSetupStatus":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.getSetupStatus.requestSchema.parse(
                generic.data.params,
              );
              if (input.operations.getSetupStatus === undefined) {
                throw new TypeError("Setup status read is unavailable.");
              }
              result = await input.operations.getSetupStatus(request);
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "configureRuntime":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.configureRuntime.requestSchema.parse(
                generic.data.params,
              );
              result = await input.operations.configureRuntime(
                request,
                state.detachController.signal,
              );
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "verify_intervals_credential":
            try {
              const request =
                COACH_RPC_METHOD_REGISTRY.verify_intervals_credential.requestSchema.parse(
                  generic.data.params,
                );
              if (input.operations.verify_intervals_credential === undefined) {
                throw new TypeError("Intervals credential verification is unavailable.");
              }
              result = await input.operations.verify_intervals_credential(
                request,
                state.detachController.signal,
              );
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "getRuntimeConfig":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.getRuntimeConfig.requestSchema.parse(
                generic.data.params,
              );
              result = await input.operations.getRuntimeConfig(request);
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "getUnitsPreference":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.getUnitsPreference.requestSchema.parse(
                generic.data.params,
              );
              if (input.operations.getUnitsPreference === undefined) {
                throw new TypeError("Units preference operation is unavailable.");
              }
              result = await input.operations.getUnitsPreference(request);
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "setUnitsPreference":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.setUnitsPreference.requestSchema.parse(
                generic.data.params,
              );
              if (input.operations.setUnitsPreference === undefined) {
                throw new TypeError("Units preference operation is unavailable.");
              }
              result = await input.operations.setUnitsPreference(request);
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "configureTelegram":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.configureTelegram.requestSchema.parse(
                generic.data.params,
              );
              result = await input.telegram.configure(request.token);
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "enableTelegram":
            try {
              COACH_RPC_METHOD_REGISTRY.enableTelegram.requestSchema.parse(generic.data.params);
              result = await input.telegram.enable();
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "disableTelegram":
            try {
              COACH_RPC_METHOD_REGISTRY.disableTelegram.requestSchema.parse(generic.data.params);
              result = await input.telegram.disable();
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "suspendTelegramPolling":
            try {
              COACH_RPC_METHOD_REGISTRY.suspendTelegramPolling.requestSchema.parse(
                generic.data.params,
              );
              result = await input.telegram.stopPolling();
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "resumeTelegramPolling":
            try {
              COACH_RPC_METHOD_REGISTRY.resumeTelegramPolling.requestSchema.parse(
                generic.data.params,
              );
              result = await input.telegram.resumePolling();
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "drainTelegram":
            try {
              COACH_RPC_METHOD_REGISTRY.drainTelegram.requestSchema.parse(generic.data.params);
              result = await input.telegram.drainPending();
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "replaceTelegram":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.replaceTelegram.requestSchema.parse(
                generic.data.params,
              );
              result = await input.telegram.replace(request.token);
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "getTelegramStatus":
            try {
              COACH_RPC_METHOD_REGISTRY.getTelegramStatus.requestSchema.parse(generic.data.params);
              result = input.telegram.getStatus();
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "reconcileTelegram":
            try {
              COACH_RPC_METHOD_REGISTRY.reconcileTelegram.requestSchema.parse(generic.data.params);
              result = await input.telegram.reconcile();
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "inspectTelegramCredential":
            try {
              const request =
                COACH_RPC_METHOD_REGISTRY.inspectTelegramCredential.requestSchema.parse(
                  generic.data.params,
                );
              result = await input.telegram.inspectTelegramCredential(request.token);
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "deleteTelegramWebhook":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.deleteTelegramWebhook.requestSchema.parse(
                generic.data.params,
              );
              result = await input.telegram.deleteTelegramWebhook(request.token);
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "forgetTelegramCredential":
            try {
              COACH_RPC_METHOD_REGISTRY.forgetTelegramCredential.requestSchema.parse(
                generic.data.params,
              );
              result = await input.telegram.forgetTelegramCredential();
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "resetTelegramAccess":
            try {
              COACH_RPC_METHOD_REGISTRY.resetTelegramAccess.requestSchema.parse(
                generic.data.params,
              );
              result = await input.telegram.resetTelegramAccess();
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "beginTelegramPairing":
            try {
              COACH_RPC_METHOD_REGISTRY.beginTelegramPairing.requestSchema.parse(
                generic.data.params,
              );
              result = await input.telegram.beginTelegramPairing();
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "cancelTelegramPairing":
            try {
              COACH_RPC_METHOD_REGISTRY.cancelTelegramPairing.requestSchema.parse(
                generic.data.params,
              );
              result = await input.telegram.cancelTelegramPairing();
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "listTelegramAllowedSenders":
            try {
              COACH_RPC_METHOD_REGISTRY.listTelegramAllowedSenders.requestSchema.parse(
                generic.data.params,
              );
              result = await input.telegram.listTelegramAllowedSenders();
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "addTelegramAllowedSender":
            try {
              const request =
                COACH_RPC_METHOD_REGISTRY.addTelegramAllowedSender.requestSchema.parse(
                  generic.data.params,
                );
              result = await input.telegram.addTelegramAllowedSender(request.senderId);
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "removeTelegramAllowedSender":
            try {
              const request =
                COACH_RPC_METHOD_REGISTRY.removeTelegramAllowedSender.requestSchema.parse(
                  generic.data.params,
                );
              result = await input.telegram.removeTelegramAllowedSender(request.senderId);
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "getSpendSummary":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.getSpendSummary.requestSchema.parse(
                generic.data.params,
              );
              result = await input.spend.getSpendSummary(request);
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "setDailySpendCap":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.setDailySpendCap.requestSchema.parse(
                generic.data.params,
              );
              result = await input.spend.setDailySpendCap(request);
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "selfTest":
            try {
              COACH_RPC_METHOD_REGISTRY.selfTest.requestSchema.parse(generic.data.params);
              result = await input.selfTestOperations.selfTest((event) => {
                if (eventFailure !== undefined) return;
                try {
                  const parsedEvent = COACH_RPC_METHOD_REGISTRY.selfTest.eventSchema.parse(event);
                  const notification = CoachOperationProgressNotificationEnvelopeSchema.parse({
                    jsonrpc: "2.0",
                    method: "coach.operationProgress",
                    params: {
                      requestId: generic.data.id,
                      requestMethod: "selfTest",
                      event: parsedEvent,
                    },
                  });
                  void enqueueSerialized(state, serializeCoachRpcEnvelope(notification));
                } catch (error) {
                  eventFailure = { error };
                }
              });
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "createPlanningRequest":
            try {
              if (input.operations.createPlanningRequest === undefined) {
                throw new TypeError("Planning request creation is unavailable.");
              }
              result = await input.operations.createPlanningRequest(
                COACH_RPC_METHOD_REGISTRY.createPlanningRequest.requestSchema.parse(
                  generic.data.params,
                ),
              );
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "createWorkoutPlanningRequest":
            try {
              if (input.operations.createWorkoutPlanningRequest === undefined) {
                throw new TypeError("Workout Planning request creation is unavailable.");
              }
              result = await input.operations.createWorkoutPlanningRequest(
                COACH_RPC_METHOD_REGISTRY.createWorkoutPlanningRequest.requestSchema.parse(
                  generic.data.params,
                ),
              );
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "getPlanningRequest":
            try {
              if (input.operations.getPlanningRequest === undefined) {
                throw new TypeError("Planning request read is unavailable.");
              }
              result = await input.operations.getPlanningRequest(
                COACH_RPC_METHOD_REGISTRY.getPlanningRequest.requestSchema.parse(
                  generic.data.params,
                ),
              );
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "retryPlanningRequest":
            try {
              if (input.operations.retryPlanningRequest === undefined) {
                throw new TypeError("Planning request retry is unavailable.");
              }
              result = await input.operations.retryPlanningRequest(
                COACH_RPC_METHOD_REGISTRY.retryPlanningRequest.requestSchema.parse(
                  generic.data.params,
                ),
              );
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "resumePlanningRequests":
            try {
              if (input.operations.resumePlanningRequests === undefined) {
                throw new TypeError("Planning request recovery is unavailable.");
              }
              result = await input.operations.resumePlanningRequests(
                COACH_RPC_METHOD_REGISTRY.resumePlanningRequests.requestSchema.parse(
                  generic.data.params,
                ),
              );
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "listPlanningRequests":
            try {
              if (input.operations.listPlanningRequests === undefined) {
                throw new TypeError("Planning request list is unavailable.");
              }
              result = await input.operations.listPlanningRequests(
                COACH_RPC_METHOD_REGISTRY.listPlanningRequests.requestSchema.parse(
                  generic.data.params,
                ),
              );
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "plan_creation.start":
            try {
              result = await input.operations["plan_creation.start"](
                COACH_RPC_METHOD_REGISTRY["plan_creation.start"].requestSchema.parse(
                  generic.data.params,
                ),
              );
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "plan_creation.answer":
            try {
              result = await input.operations["plan_creation.answer"](
                COACH_RPC_METHOD_REGISTRY["plan_creation.answer"].requestSchema.parse(
                  generic.data.params,
                ),
              );
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "getPlanState":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.getPlanState.requestSchema.parse(
                generic.data.params,
              );
              result = input.operations.getPlanState
                ? await input.operations.getPlanState(request)
                : { status: "unsupported-capability", capability: "planning" };
            } catch (error) {
              invocationFailure = { error };
            }
            break;
          case "executePlanTransition":
            try {
              const request = COACH_RPC_METHOD_REGISTRY.executePlanTransition.requestSchema.parse(
                generic.data.params,
              );
              let operationId: string | undefined;
              let progressOpen = true;
              if (input.operations.executePlanTransition) {
                let operationResult: unknown;
                try {
                  operationResult = await input.operations.executePlanTransition(
                    request,
                    (event) => {
                      if (!progressOpen || eventFailure !== undefined) return;
                      try {
                        const parsedEvent =
                          COACH_RPC_METHOD_REGISTRY.executePlanTransition.eventSchema.parse(event);
                        if (
                          parsedEvent.commandId !== request.commandId ||
                          parsedEvent.transitionId !== request.transitionId ||
                          (operationId !== undefined && parsedEvent.operationId !== operationId)
                        ) {
                          throw new Error("Planning progress correlation mismatch");
                        }
                        operationId = parsedEvent.operationId;
                        const notification = CoachPlanProgressNotificationEnvelopeSchema.parse({
                          jsonrpc: "2.0",
                          method: "coach.planProgress",
                          params: {
                            requestId: generic.data.id,
                            requestMethod: "executePlanTransition",
                            event: parsedEvent,
                          },
                        });
                        void enqueueSerialized(state, serializeCoachRpcEnvelope(notification));
                      } catch (error) {
                        eventFailure = { error };
                      }
                    },
                  );
                } finally {
                  progressOpen = false;
                }
                const parsedResult =
                  COACH_RPC_METHOD_REGISTRY.executePlanTransition.responseSchema.parse(
                    operationResult,
                  );
                if (
                  parsedResult.status === "accepted" &&
                  operationId !== undefined &&
                  parsedResult.operationId !== operationId
                ) {
                  throw new Error("Planning result correlation mismatch");
                }
                result = parsedResult;
              } else {
                progressOpen = false;
                result = { status: "unsupported-capability", capability: "planning" };
              }
            } catch (error) {
              invocationFailure = { error };
            }
            break;
        }
        if (deliveryDetached || state.detached) return;
        let terminal: string;
        const failure = invocationFailure ?? eventFailure;
        if (failure !== undefined) {
          terminal = internalError(generic.data.id, failure.error);
        } else {
          const response = registry.responseSchema.safeParse(result);
          if (!response.success) {
            terminal = internalError(generic.data.id, response.error);
          } else {
            try {
              terminal = serializeCoachRpcEnvelope(
                JsonRpcSuccessResponseEnvelopeSchema.parse({
                  jsonrpc: "2.0",
                  id: generic.data.id,
                  result: response.data,
                }),
              );
            } catch (error) {
              terminal = internalError(generic.data.id, error);
            }
          }
        }
        await enqueueSerialized(state, terminal);
      } finally {
        state.activeIds.delete(requestIdKey);
      }
    };
    const invocationKey =
      registry.wireName === "chat" ||
      registry.wireName === "getCoachDecision" ||
      registry.wireName === "answerCoachDecision" ||
      registry.wireName === "skipCoachDecision" ||
      registry.wireName === "resumeCoachDecision" ||
      registry.wireName === "resetSession" ||
      registry.wireName === "hasSession"
        ? (params.data as { readonly chatId: string }).chatId
        : undefined;
    let task: Promise<void>;
    try {
      task = invocations.invoke(
        { key: invocationKey, signal: state.detachController.signal },
        runRequest,
      );
    } catch (error) {
      state.activeIds.delete(requestIdKey);
      void enqueueSerialized(
        state,
        error instanceof DaemonAdmissionClosedError
          ? ordinaryError(generic.data.id, -32_005, "daemon-upgrading")
          : internalError(generic.data.id, error),
      );
      return;
    }
    state.requestTasks.add(task);
    void task
      .finally(() => {
        state.requestTasks.delete(task);
      })
      .catch(() => {});
  };

  const acceptClient = (ws: WebSocket): void => {
    connectionSequence += 1;
    const state = createClientState(ws, `connection-${connectionSequence}`);
    clients.add(state);
    ws.on("close", () => {
      clearAuthTimer(state);
      detach(state);
      if (reservation?.connectionId === state.connectionId && reservation.state === "reserved") {
        clearReservation();
      }
      state.closed = true;
      state.resolveClosed();
      void Promise.all(state.requestTasks)
        .catch(() => {})
        .then(() => state.sendTail)
        .finally(() => clients.delete(state));
    });
    ws.on("error", () => {
      clearAuthTimer(state);
      detach(state);
      if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    });
    state.authTimer = setTimeout(() => {
      state.authTimer = undefined;
      detach(state, 1008, AUTH_FAILURE_REASON);
    }, AUTH_TIMEOUT_MS);
    state.authTimer.unref?.();
    ws.once("message", (data, isBinary) => {
      clearAuthTimer(state);
      if (isBinary) {
        detach(state, 1008, AUTH_FAILURE_REASON);
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(rawText(data));
      } catch {
        detach(state, 1008, AUTH_FAILURE_REASON);
        return;
      }
      const handshake = ClientHandshakeFrameSchema.safeParse(value);
      const authority = !handshake.success
        ? undefined
        : sameToken(handshake.data.token, input.token)
          ? "privileged"
          : sameToken(handshake.data.token, rendererCapability)
            ? "renderer"
            : undefined;
      if (!handshake.success || authority === undefined) {
        detach(state, 1008, AUTH_FAILURE_REASON);
        return;
      }
      const comparison = compareProtocolVersions(
        handshake.data.clientProtocolVersion,
        PROTOCOL_VERSION,
      );
      if (comparison !== "equal") {
        const frame = createVersionMismatchServerHandshakeFrame(
          input.owner,
          handshake.data.clientProtocolVersion,
        );
        void enqueueSerialized(state, JSON.stringify(frame)).then(() => {
          clearAuthTimer(state);
          detach(state, 1002);
        });
        return;
      }
      state.authenticated = true;
      state.authority = authority;
      const frame = createAcceptedServerHandshakeFrame(
        input.owner,
        handshake.data.clientProtocolVersion,
        { athleteHome, rendererCapability },
      );
      void enqueueSerialized(state, JSON.stringify(frame));
      ws.on("message", (requestData, requestIsBinary) => {
        handleRequest(state, requestData, requestIsBinary);
      });
    });
  };

  const handleUpgrade: WriterProtocolHandlers["upgrade"] = (request, socket, head) => {
    if (
      Object.prototype.hasOwnProperty.call(request.headers, "origin") &&
      request.headers.origin !== "enduragent://app"
    ) {
      refuseUpgrade(socket, FORBIDDEN_RESPONSE);
      return;
    }
    const rawTarget = request.url ?? "";
    let target: URL;
    try {
      target = new URL(rawTarget, "http://127.0.0.1");
      if (!rawTarget.startsWith("/") || target.origin !== "http://127.0.0.1") {
        throw new TypeError("invalid relative URL");
      }
    } catch {
      refuseUpgrade(socket, BAD_REQUEST_RESPONSE);
      return;
    }
    if (target.pathname !== "/rpc") {
      refuseUpgrade(socket, NOT_FOUND_RESPONSE);
      return;
    }
    if (rawTarget.includes("?")) {
      refuseUpgrade(socket, BAD_REQUEST_RESPONSE);
      return;
    }
    if (closing) {
      refuseUpgrade(socket, UNAVAILABLE_RESPONSE);
      return;
    }
    wss.handleUpgrade(request, socket, head, acceptClient);
  };

  return {
    handleUpgrade,
    shutdownRequested,
    close() {
      closePromise ??= (async () => {
        closing = true;
        const fence = invocations.closeAdmission();
        fence.seal();
        input.healthState?.setHealthy(false);
        await input.beforeInvocationDrain?.();
        await fence.drain();
        for (const state of clients) {
          clearAuthTimer(state);
          if (!state.authenticated) {
            detach(state);
            state.ws.terminate();
          }
        }
        while ([...clients].some((state) => state.requestTasks.size !== 0)) {
          await Promise.all([...clients].flatMap((state) => [...state.requestTasks]));
        }
        await Promise.all([...clients].map((state) => state.sendTail));
        const authenticated = [...clients].filter((state) => state.authenticated);
        for (const state of authenticated) {
          if (state.ws.readyState === WebSocket.OPEN) state.ws.close(1001);
          detach(state);
        }
        await Promise.all(authenticated.map((state) => state.closedPromise));
        await new Promise<void>((resolve, reject) => {
          wss.close((error) => {
            if (error === undefined) resolve();
            else reject(error);
          });
        });
        clearReservation();
        clients.clear();
      })();
      return closePromise;
    },
  };
}
