import {
  AthleteHomeIdentitySchema,
  COACH_RPC_METHOD_REGISTRY,
  parseCoachRpcEnvelope,
  serializeCoachRpcEnvelope,
  type AcceptedServerHandshakeFrame,
  type CoachRpcEvent,
  type CoachRpcMethodName,
  type CoachRpcNotification,
  type CoachRpcNotificationEnvelope,
  type CoachRpcRequest,
  type CoachRpcResponse,
  type ExecutePlanTransitionRpcParams,
  type ExecutePlanTransitionRpcResult,
  type JsonRpcId,
  type JsonRpcErrorResponseEnvelope,
  type JsonRpcSuccessResponseEnvelope,
  type PlanProgressEvent,
} from "@enduragent/coach-contract";
import { COACH_RPC_CALL_TIMEOUT_MS } from "./call-timeouts.js";
import {
  CoachClientBackpressureError,
  CoachClientCallAbortedError,
  CoachClientCallNotAdmittedError,
  CoachClientCallTimeoutError,
  CoachClientDisconnectedError,
  CoachClientHandshakeError,
  CoachClientProtocolError,
  CoachClientTransportUnavailableError,
  CoachRpcRemoteError,
} from "./errors.js";
import {
  performCoachClientHandshake,
  type CoachClientHandshakeBinding,
} from "./handshake-client.js";
import { resolveCoachWebSocketFactory, type CoachWebSocketFactory } from "./transport.js";

export interface ConnectCoachClientOptions {
  readonly url: string;
  readonly token: string;
  readonly expectedAthleteHome?: string;
  readonly signal?: AbortSignal;
  readonly connectTimeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  readonly highWaterMarkBytes?: number;
  readonly lowWaterMarkBytes?: number;
  readonly maxQueuedSends?: number;
  readonly webSocketFactory?: CoachWebSocketFactory;
  readonly onTerminal?: CoachClientTerminalObserver;
}

export type CoachClientTerminalEnvelope =
  | JsonRpcSuccessResponseEnvelope
  | JsonRpcErrorResponseEnvelope;

export interface CoachClientCallOptions<K extends CoachRpcMethodName> {
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: CoachRpcEvent<K>) => void;
  readonly onNotificationEnvelope?: (envelope: CoachRpcNotification<K>) => void;
  readonly onTerminalEnvelope?: (envelope: CoachClientTerminalEnvelope) => void;
}

export interface CoachClient {
  readonly handshake: AcceptedServerHandshakeFrame;
  call<K extends CoachRpcMethodName>(
    method: K,
    request: CoachRpcRequest<K>,
    options?: CoachClientCallOptions<K>,
  ): Promise<CoachRpcResponse<K>>;
  close(code?: number, reason?: string): Promise<void>;
}

export interface CoachClientConnection {
  readonly client: CoachClient;
  closeWhenIdle(): Promise<void>;
  close(code?: number, reason?: string): Promise<void>;
}

export type CoachClientTerminalCause =
  | CoachClientCallAbortedError
  | CoachClientProtocolError
  | CoachClientDisconnectedError;

export type CoachClientTerminalObserver = (
  client: CoachClient,
  cause: CoachClientTerminalCause,
) => void;

interface ValidatedOptions {
  readonly url: string;
  readonly token: string;
  readonly expectedAthleteHome: string | undefined;
  readonly signal: AbortSignal | undefined;
  readonly connectTimeoutMs: number;
  readonly handshakeTimeoutMs: number;
  readonly closeTimeoutMs: number;
  readonly highWaterMarkBytes: number;
  readonly lowWaterMarkBytes: number;
  readonly maxQueuedSends: number;
  readonly webSocketFactory: CoachWebSocketFactory | undefined;
  readonly onTerminal: CoachClientTerminalObserver | undefined;
}

interface PendingCall {
  readonly method: CoachRpcMethodName;
  readonly request: unknown;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly onEvent: ((event: unknown) => void) | undefined;
  readonly onNotificationEnvelope: ((envelope: CoachRpcNotificationEnvelope) => void) | undefined;
  readonly onTerminalEnvelope: ((envelope: CoachClientTerminalEnvelope) => void) | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: (() => void) | undefined;
  planOperationId: string | undefined;
}

interface OutboundFrame {
  readonly id: number;
  readonly text: string;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validateOptions(options: ConnectCoachClientOptions): ValidatedOptions {
  const connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 5_000;
  const closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
  const highWaterMarkBytes = options.highWaterMarkBytes ?? 1_048_576;
  const lowWaterMarkBytes = options.lowWaterMarkBytes ?? 262_144;
  const maxQueuedSends = options.maxQueuedSends ?? 128;

  if (
    typeof options.url !== "string" ||
    typeof options.token !== "string" ||
    options.token.length === 0 ||
    (options.expectedAthleteHome !== undefined &&
      !AthleteHomeIdentitySchema.safeParse(options.expectedAthleteHome).success) ||
    !positiveSafeInteger(connectTimeoutMs) ||
    !positiveSafeInteger(handshakeTimeoutMs) ||
    !positiveSafeInteger(closeTimeoutMs) ||
    !positiveSafeInteger(highWaterMarkBytes) ||
    !nonnegativeSafeInteger(lowWaterMarkBytes) ||
    !positiveSafeInteger(maxQueuedSends) ||
    lowWaterMarkBytes >= highWaterMarkBytes
  ) {
    throw new CoachClientProtocolError();
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(options.url);
  } catch {
    throw new CoachClientProtocolError();
  }
  if (
    parsedUrl.protocol !== "ws:" ||
    parsedUrl.hostname !== "127.0.0.1" ||
    parsedUrl.port === "" ||
    parsedUrl.username !== "" ||
    parsedUrl.password !== "" ||
    parsedUrl.search !== "" ||
    parsedUrl.hash !== ""
  ) {
    throw new CoachClientProtocolError();
  }

  return {
    url: options.url,
    token: options.token,
    expectedAthleteHome: options.expectedAthleteHome,
    signal: options.signal,
    connectTimeoutMs,
    handshakeTimeoutMs,
    closeTimeoutMs,
    highWaterMarkBytes,
    lowWaterMarkBytes,
    maxQueuedSends,
    webSocketFactory: options.webSocketFactory,
    onTerminal: options.onTerminal,
  };
}

function runIsolated(action: () => void): void {
  void Promise.allSettled([
    new Promise<void>((resolve) => {
      action();
      resolve();
    }),
  ]);
}

function requestSocketClose(socket: WebSocket, code?: number, reason?: string): void {
  if (socket.readyState === 2 || socket.readyState === 3) return;
  runIsolated(() => socket.close(code, reason));
}

function openCoachSocket(options: ValidatedOptions): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    let socket: WebSocket | undefined;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      options.signal?.removeEventListener("abort", onAbort);
      socket?.removeEventListener("open", onOpen);
      socket?.removeEventListener("error", onError);
      socket?.removeEventListener("close", onClose);
    };

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (socket !== undefined) requestSocketClose(socket);
      reject(error);
    };

    function onOpen(): void {
      if (settled || socket === undefined) return;
      settled = true;
      cleanup();
      resolve(socket);
    }

    function onAbort(): void {
      fail(new CoachClientHandshakeError("Coach client connection aborted"));
    }

    function onError(): void {
      fail(new CoachClientHandshakeError("Coach client connection failed"));
    }

    function onClose(): void {
      fail(new CoachClientHandshakeError("Coach client closed before opening"));
    }

    timer = setTimeout(() => {
      fail(new CoachClientHandshakeError("Coach client connection timed out"));
    }, options.connectTimeoutMs);

    try {
      const factory = resolveCoachWebSocketFactory(options.webSocketFactory);
      socket = factory(options.url);
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      if (socket.readyState === 1) onOpen();
      if (socket.readyState === 2 || socket.readyState === 3) onClose();
    } catch {
      fail(new CoachClientTransportUnavailableError());
    }
  });
}

interface CloseSettlement {
  readonly promise: Promise<void>;
  readonly settle: () => void;
}

type CloseLifecycle =
  | { readonly phase: "open" }
  | { readonly phase: "idle-requested"; readonly settlement: CloseSettlement }
  | {
      readonly phase: "closing";
      readonly settlement: CloseSettlement;
      readonly timer: ReturnType<typeof setTimeout>;
      readonly retirement: boolean;
    }
  | { readonly phase: "closed"; readonly promise: Promise<void>; readonly retirement: boolean };

class CoachClientRuntime {
  private readonly pending = new Map<JsonRpcId, PendingCall>();
  private readonly timedOut = new Set<JsonRpcId>();
  private readonly sendQueue: OutboundFrame[] = [];
  private nextId = 1;
  private idsExhausted = false;
  private sendPumpRunning = false;
  private sendWaitTimer: ReturnType<typeof setTimeout> | undefined;
  private sendWaitResolve: (() => void) | undefined;
  private terminalCause: CoachClientTerminalCause | undefined;
  private preActivationCause: CoachClientDisconnectedError | undefined;
  private handshakeBinding: CoachClientHandshakeBinding | undefined;
  private publicClient: CoachClient | undefined;
  private ready = false;
  private lifecycle: CloseLifecycle = { phase: "open" };

  constructor(
    private readonly socket: WebSocket,
    private readonly options: ValidatedOptions,
  ) {
    socket.addEventListener("close", this.onSocketClose);
    socket.addEventListener("error", this.onSocketError);
  }

  readonly handleRawFrame = (data: unknown): void => {
    if (!this.ready || this.terminalCause !== undefined) return;
    if (typeof data !== "string") {
      this.failProtocol();
      return;
    }
    let envelope: ReturnType<typeof parseCoachRpcEnvelope>;
    try {
      envelope = parseCoachRpcEnvelope(data);
    } catch {
      this.failProtocol();
      return;
    }

    if ("method" in envelope && "id" in envelope) {
      this.failProtocol();
      return;
    }
    if ("method" in envelope) {
      this.handleNotification(envelope);
      return;
    }
    if (envelope.id === null) {
      this.failProtocol();
      return;
    }
    this.handleTerminal(envelope);
  };

  activate(binding: CoachClientHandshakeBinding): CoachClientConnection {
    this.handshakeBinding = binding;
    const client: CoachClient = {
      handshake: binding.accepted,
      call: <K extends CoachRpcMethodName>(
        method: K,
        request: CoachRpcRequest<K>,
        options?: CoachClientCallOptions<K>,
      ) => this.call(method, request, options),
      close: (code?: number, reason?: string) => this.close(code, reason),
    };
    this.publicClient = client;
    this.ready = true;
    if (this.preActivationCause !== undefined) this.latchTerminal(this.preActivationCause);
    return {
      client,
      closeWhenIdle: () => this.closeWhenIdle(),
      close: (code?: number, reason?: string) => this.close(code, reason),
    };
  }

  disposeBeforeReady(): void {
    this.socket.removeEventListener("close", this.onSocketClose);
    this.socket.removeEventListener("error", this.onSocketError);
  }

  private call<K extends CoachRpcMethodName>(
    method: K,
    request: CoachRpcRequest<K>,
    options?: CoachClientCallOptions<K>,
  ): Promise<CoachRpcResponse<K>> {
    if (
      (this.lifecycle.phase === "closing" || this.lifecycle.phase === "closed") &&
      this.lifecycle.retirement
    ) {
      return Promise.reject(new CoachClientCallNotAdmittedError());
    }
    if (this.terminalCause !== undefined) {
      return Promise.reject(this.terminalCause);
    }

    let params: unknown;
    let text: string;
    const id = this.nextId;
    const signal = options?.signal;
    try {
      params = COACH_RPC_METHOD_REGISTRY[method].requestSchema.parse(request);
      text = serializeCoachRpcEnvelope({
        jsonrpc: "2.0",
        id,
        method,
        params,
      });
    } catch {
      return Promise.reject(new CoachClientProtocolError());
    }

    if (signal?.aborted) {
      return Promise.reject(new CoachClientCallAbortedError(method));
    }
    if (this.sendPumpRunning && this.sendQueue.length - 1 >= this.options.maxQueuedSends) {
      return Promise.reject(new CoachClientBackpressureError());
    }
    if (this.idsExhausted) {
      return Promise.reject(this.failProtocol());
    }

    if (id === Number.MAX_SAFE_INTEGER) {
      this.idsExhausted = true;
    } else {
      this.nextId = id + 1;
    }

    const timeoutMs = COACH_RPC_CALL_TIMEOUT_MS[method];
    const promise = new Promise<CoachRpcResponse<K>>((resolve, reject) => {
      const onAbort =
        signal === undefined
          ? undefined
          : () => this.latchTerminal(new CoachClientCallAbortedError(method));
      const pending: PendingCall = {
        method,
        request: params,
        resolve: resolve as (value: unknown) => void,
        reject,
        onEvent: options?.onEvent as ((event: unknown) => void) | undefined,
        onNotificationEnvelope: options?.onNotificationEnvelope as
          | ((envelope: CoachRpcNotificationEnvelope) => void)
          | undefined,
        onTerminalEnvelope: options?.onTerminalEnvelope,
        timer: undefined,
        signal,
        onAbort,
        planOperationId: undefined,
      };
      this.pending.set(id, pending);
      if (onAbort !== undefined) signal?.addEventListener("abort", onAbort, { once: true });
      pending.timer = setTimeout(() => {
        this.timeOut(id, pending, new CoachClientCallTimeoutError(method, timeoutMs));
      }, timeoutMs);
    });
    this.sendQueue.push({ id, text });
    this.startSendPump();
    return promise;
  }

  private startSendPump(): void {
    if (this.sendPumpRunning) return;
    this.sendPumpRunning = true;
    void this.pumpSendQueue();
  }

  private async pumpSendQueue(): Promise<void> {
    try {
      while (this.sendQueue.length > 0 && this.terminalCause === undefined) {
        if (this.socket.bufferedAmount >= this.options.highWaterMarkBytes) {
          await this.waitForLowWater();
          if (this.terminalCause !== undefined) break;
        }
        const frame = this.sendQueue[0];
        if (frame === undefined) break;
        try {
          this.socket.send(frame.text);
        } catch {
          this.failProtocol();
          break;
        }
        this.sendQueue.shift();
      }
    } finally {
      this.sendPumpRunning = false;
      if (this.sendQueue.length > 0 && this.terminalCause === undefined) {
        this.startSendPump();
      }
    }
  }

  private waitForLowWater(): Promise<void> {
    return new Promise((resolve) => {
      this.sendWaitResolve = resolve;
      const poll = (): void => {
        if (
          this.terminalCause !== undefined ||
          this.socket.bufferedAmount <= this.options.lowWaterMarkBytes
        ) {
          this.sendWaitTimer = undefined;
          this.sendWaitResolve = undefined;
          resolve();
          return;
        }
        this.sendWaitTimer = setTimeout(poll, 10);
      };
      this.sendWaitTimer = setTimeout(poll, 10);
    });
  }

  private clearSendWait(): void {
    if (this.sendWaitTimer !== undefined) clearTimeout(this.sendWaitTimer);
    this.sendWaitTimer = undefined;
    const resolve = this.sendWaitResolve;
    this.sendWaitResolve = undefined;
    resolve?.();
  }

  private handleNotification(envelope: CoachRpcNotificationEnvelope): void {
    const pending = this.pending.get(envelope.params.requestId);
    if (pending === undefined && this.timedOut.has(envelope.params.requestId)) return;
    if (pending === undefined || pending.method !== envelope.params.requestMethod) {
      this.failProtocol();
      return;
    }

    let event: unknown;
    try {
      event = COACH_RPC_METHOD_REGISTRY[pending.method].eventSchema.parse(envelope.params.event);
    } catch {
      this.failProtocol();
      return;
    }
    if (pending.method === "executePlanTransition") {
      const request = pending.request as ExecutePlanTransitionRpcParams;
      const progress = event as PlanProgressEvent;
      if (
        progress.commandId !== request.commandId ||
        progress.transitionId !== request.transitionId ||
        (pending.planOperationId !== undefined && progress.operationId !== pending.planOperationId)
      ) {
        this.failProtocol();
        return;
      }
      pending.planOperationId = progress.operationId;
    }

    const onNotificationEnvelope = pending.onNotificationEnvelope;
    const onEvent = pending.onEvent;
    runIsolated(() => onNotificationEnvelope?.(envelope));
    runIsolated(() => onEvent?.(event));
  }

  private handleTerminal(
    envelope: JsonRpcSuccessResponseEnvelope | JsonRpcErrorResponseEnvelope,
  ): void {
    const pending = this.pending.get(envelope.id);
    if (pending === undefined) {
      if (!this.timedOut.delete(envelope.id)) this.failProtocol();
      return;
    }

    if ("result" in envelope) {
      let result: unknown;
      try {
        result = COACH_RPC_METHOD_REGISTRY[pending.method].responseSchema.parse(envelope.result);
      } catch {
        this.failProtocol();
        return;
      }
      if (
        pending.method === "executePlanTransition" &&
        (result as ExecutePlanTransitionRpcResult).status === "accepted" &&
        pending.planOperationId !== undefined &&
        (result as ExecutePlanTransitionRpcResult & { readonly status: "accepted" }).operationId !==
          pending.planOperationId
      ) {
        this.failProtocol();
        return;
      }
      this.claimPending(envelope.id, pending);
      const observer = pending.onTerminalEnvelope;
      runIsolated(() => observer?.(envelope));
      pending.resolve(result);
      this.scheduleIdleClose();
      return;
    }

    const remoteError = new CoachRpcRemoteError(
      envelope.error.code,
      envelope.error.message,
      envelope.error.data,
    );
    this.claimPending(envelope.id, pending);
    const observer = pending.onTerminalEnvelope;
    runIsolated(() => observer?.(envelope));
    pending.reject(remoteError);
    this.scheduleIdleClose();
  }

  private failProtocol(): CoachClientProtocolError {
    if (this.terminalCause !== undefined) {
      return this.terminalCause instanceof CoachClientProtocolError
        ? this.terminalCause
        : new CoachClientProtocolError();
    }
    const error = new CoachClientProtocolError();
    this.latchTerminal(error, 1002);
    return error;
  }

  private claimPending(id: JsonRpcId, pending: PendingCall): void {
    this.pending.delete(id);
    this.cleanupPending(pending);
  }

  private timeOut(id: number, pending: PendingCall, error: CoachClientCallTimeoutError): void {
    if (this.pending.get(id) !== pending) return;
    this.claimPending(id, pending);
    const unsent = this.sendQueue.findIndex((frame) => frame.id === id);
    if (unsent === -1) this.timedOut.add(id);
    else this.sendQueue.splice(unsent, 1);
    pending.reject(error);
    this.scheduleIdleClose();
  }

  private cleanupPending(pending: PendingCall): void {
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    pending.timer = undefined;
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
  }

  private latchTerminal(
    error: CoachClientTerminalCause,
    closeCode?: number,
    closeReason?: string,
  ): void {
    if (this.terminalCause !== undefined) return;
    this.terminalCause = error;
    this.ready = false;
    this.clearSendWait();
    this.sendQueue.length = 0;
    this.handshakeBinding?.dispose();
    this.socket.removeEventListener("close", this.onSocketClose);
    this.socket.removeEventListener("error", this.onSocketError);
    const pending = [...this.pending.values()];
    this.pending.clear();
    this.timedOut.clear();
    for (const entry of pending) {
      this.cleanupPending(entry);
      entry.reject(error);
    }
    requestSocketClose(this.socket, closeCode, closeReason);
    const client = this.publicClient;
    if (client !== undefined) {
      runIsolated(() => this.options.onTerminal?.(client, error));
    }
    this.scheduleIdleClose();
  }

  private readonly onSocketClose = (event: CloseEvent): void => {
    if (this.terminalCause !== undefined) return;
    const error = new CoachClientDisconnectedError(event.code, event.reason);
    if (!this.ready) {
      this.preActivationCause ??= error;
      return;
    }
    this.latchTerminal(error);
  };

  private readonly onSocketError = (): void => {
    if (this.terminalCause !== undefined) return;
    const error = new CoachClientDisconnectedError(1006, "");
    if (!this.ready) {
      this.preActivationCause ??= error;
      return;
    }
    this.latchTerminal(error);
  };

  private readonly finishClose = (): void => {
    const lifecycle = this.lifecycle;
    if (lifecycle.phase === "open" || lifecycle.phase === "closed") return;
    if (lifecycle.phase === "closing") clearTimeout(lifecycle.timer);
    this.socket.removeEventListener("close", this.finishClose);
    this.lifecycle = {
      phase: "closed",
      promise: lifecycle.settlement.promise,
      retirement: lifecycle.phase === "closing" && lifecycle.retirement,
    };
    lifecycle.settlement.settle();
  };

  private openSettlement(): CloseSettlement {
    let settle!: () => void;
    const promise = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.socket.addEventListener("close", this.finishClose);
    return { promise, settle };
  }

  private beginClose(code: number, reason: string, retirement: boolean): Promise<void> {
    const lifecycle = this.lifecycle;
    if (lifecycle.phase === "closed") return lifecycle.promise;
    if (lifecycle.phase === "closing") return lifecycle.settlement.promise;
    const settlement = lifecycle.phase === "open" ? this.openSettlement() : lifecycle.settlement;
    this.lifecycle = {
      phase: "closing",
      settlement,
      timer: setTimeout(this.finishClose, this.options.closeTimeoutMs),
      retirement,
    };
    if (this.terminalCause === undefined) {
      this.latchTerminal(new CoachClientDisconnectedError(code, reason), code, reason);
    } else {
      requestSocketClose(this.socket, code, reason);
    }
    if (this.socket.readyState === 3) this.finishClose();
    return settlement.promise;
  }

  private scheduleIdleClose(): void {
    if (this.lifecycle.phase !== "idle-requested" || this.pending.size > 0) return;
    queueMicrotask(() => {
      if (this.lifecycle.phase !== "idle-requested" || this.pending.size > 0) return;
      void this.beginClose(1000, "", true);
    });
  }

  private closeWhenIdle(): Promise<void> {
    const lifecycle = this.lifecycle;
    if (lifecycle.phase === "closed") return lifecycle.promise;
    if (lifecycle.phase !== "open") return lifecycle.settlement.promise;
    const settlement = this.openSettlement();
    this.lifecycle = { phase: "idle-requested", settlement };
    if (this.socket.readyState === 3) this.finishClose();
    else this.scheduleIdleClose();
    return settlement.promise;
  }

  private close(code = 1000, reason = ""): Promise<void> {
    return this.beginClose(code, reason, false);
  }
}

export async function connectCoachClientConnection(
  options: ConnectCoachClientOptions,
): Promise<CoachClientConnection> {
  let validated: ValidatedOptions;
  try {
    validated = validateOptions(options);
  } catch {
    throw new CoachClientProtocolError();
  }
  if (validated.signal?.aborted) {
    throw new CoachClientHandshakeError("Coach client connection aborted");
  }

  const socket = await openCoachSocket(validated);
  const runtime = new CoachClientRuntime(socket, validated);
  let binding: CoachClientHandshakeBinding;
  try {
    binding = await performCoachClientHandshake({
      socket,
      token: validated.token,
      expectedAthleteHome: validated.expectedAthleteHome,
      signal: validated.signal,
      timeoutMs: validated.handshakeTimeoutMs,
      onReadyFrame: runtime.handleRawFrame,
    });
  } catch (error) {
    runtime.disposeBeforeReady();
    throw error;
  }
  return runtime.activate(binding);
}

export async function connectCoachClient(options: ConnectCoachClientOptions): Promise<CoachClient> {
  return (await connectCoachClientConnection(options)).client;
}
