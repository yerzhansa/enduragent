import type {
  CoachRpcMethodName,
  DaemonOwner,
  JsonValue,
  ProtocolVersionDirection,
} from "@enduragent/coach-contract";

export class CoachClientTransportUnavailableError extends Error {
  constructor() {
    super("WebSocket transport is unavailable");
    this.name = "CoachClientTransportUnavailableError";
  }
}

export class CoachClientProtocolError extends Error {
  constructor() {
    super("Coach client protocol error");
    this.name = "CoachClientProtocolError";
  }
}

export class CoachClientHandshakeError extends Error {
  constructor(
    message:
      | "Coach client handshake failed"
      | "Coach client connection aborted"
      | "Coach client connection timed out"
      | "Coach client connection failed"
      | "Coach client closed before opening"
      | "Coach client handshake timed out"
      | "Coach client handshake send failed" = "Coach client handshake failed",
  ) {
    super(message);
    this.name = "CoachClientHandshakeError";
  }
}

export class CoachClientVersionMismatchError extends Error {
  constructor(
    readonly clientProtocolVersion: number,
    readonly serverProtocolVersion: number,
    readonly direction: ProtocolVersionDirection,
    readonly owner: DaemonOwner,
  ) {
    super("Coach protocol version mismatch");
    this.name = "CoachClientVersionMismatchError";
  }
}

export class CoachClientBackpressureError extends Error {
  constructor() {
    super("Coach client send queue is full");
    this.name = "CoachClientBackpressureError";
  }
}

export class CoachClientCallTimeoutError extends Error {
  constructor(
    readonly method: CoachRpcMethodName,
    readonly timeoutMs: number,
  ) {
    super("Coach client call timed out");
    this.name = "CoachClientCallTimeoutError";
  }
}

export class CoachClientCallAbortedError extends Error {
  constructor(readonly method: CoachRpcMethodName) {
    super("Coach client call aborted");
    this.name = "CoachClientCallAbortedError";
  }
}

export class CoachClientDisconnectedError extends Error {
  constructor(
    readonly code: number,
    readonly reason: string,
  ) {
    super("Coach client disconnected");
    this.name = "CoachClientDisconnectedError";
  }
}

export class CoachClientCallNotAdmittedError extends CoachClientDisconnectedError {
  readonly callStatus = "not-admitted" as const;

  constructor() {
    super(1001, "");
    this.name = "CoachClientCallNotAdmittedError";
  }
}

export class CoachRpcRemoteError extends Error {
  readonly data: JsonValue | undefined;

  constructor(
    readonly code: number,
    message: string,
    data?: JsonValue,
  ) {
    super(message);
    this.name = "CoachRpcRemoteError";
    this.data = data;
  }
}
