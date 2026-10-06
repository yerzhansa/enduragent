import {
  PROTOCOL_VERSION,
  ServerHandshakeFrameSchema,
  createClientHandshakeFrame,
  type AcceptedServerHandshakeFrame,
} from "@enduragent/coach-contract";
import {
  CoachClientHandshakeError,
  CoachClientProtocolError,
  CoachClientVersionMismatchError,
} from "./errors.js";

export interface PerformCoachClientHandshakeInput {
  readonly socket: WebSocket;
  readonly token: string;
  readonly expectedAthleteHome?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly onReadyFrame: (data: unknown) => void;
}

export interface CoachClientHandshakeBinding {
  readonly accepted: AcceptedServerHandshakeFrame;
  dispose(): void;
}

export function performCoachClientHandshake(
  input: PerformCoachClientHandshakeInput,
): Promise<CoachClientHandshakeBinding> {
  return new Promise((resolve, reject) => {
    let accepted = false;
    let settled = false;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      input.socket.removeEventListener("message", onMessage);
      input.socket.removeEventListener("close", onClose);
      input.socket.removeEventListener("error", onError);
      input.signal?.removeEventListener("abort", onAbort);
    };

    const requestHandshakeClose = (code = 1002): void => {
      if (input.socket.readyState !== 1) return;
      try {
        input.socket.close(code);
      } catch {}
    };

    const fail = (error: Error, closeCode = 1002): void => {
      if (settled) return;
      settled = true;
      dispose();
      requestHandshakeClose(closeCode);
      reject(error);
    };

    function onAbort(): void {
      fail(new CoachClientHandshakeError("Coach client connection aborted"), 1000);
    }

    function onMessage(event: MessageEvent): void {
      if (accepted) {
        input.onReadyFrame(event.data);
        return;
      }
      if (typeof event.data !== "string") {
        fail(new CoachClientProtocolError());
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(event.data);
      } catch {
        fail(new CoachClientProtocolError());
        return;
      }
      const parsed = ServerHandshakeFrameSchema.safeParse(value);
      if (!parsed.success) {
        fail(new CoachClientProtocolError());
        return;
      }
      const frame = parsed.data;
      if (frame.clientProtocolVersion !== PROTOCOL_VERSION) {
        fail(new CoachClientProtocolError());
        return;
      }
      if (frame.status === "version-mismatch") {
        settled = true;
        dispose();
        requestHandshakeClose();
        reject(
          new CoachClientVersionMismatchError(
            frame.clientProtocolVersion,
            frame.serverProtocolVersion,
            frame.direction,
            frame.owner,
          ),
        );
        return;
      }
      if (frame.serverProtocolVersion !== PROTOCOL_VERSION) {
        fail(new CoachClientProtocolError());
        return;
      }
      if (
        input.expectedAthleteHome !== undefined &&
        frame.athleteHome !== input.expectedAthleteHome
      ) {
        fail(new CoachClientProtocolError());
        return;
      }
      accepted = true;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      input.signal?.removeEventListener("abort", onAbort);
      resolve({ accepted: frame, dispose });
    }

    function onClose(): void {
      if (!accepted) fail(new CoachClientHandshakeError());
    }

    function onError(): void {
      if (!accepted) fail(new CoachClientHandshakeError());
    }

    input.socket.addEventListener("message", onMessage);
    input.socket.addEventListener("close", onClose);
    input.socket.addEventListener("error", onError);
    input.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      fail(new CoachClientHandshakeError("Coach client handshake timed out"));
    }, input.timeoutMs);

    try {
      if (input.signal?.aborted) {
        onAbort();
        return;
      }
      input.socket.send(JSON.stringify(createClientHandshakeFrame(input.token)));
    } catch {
      fail(new CoachClientHandshakeError("Coach client handshake send failed"));
    }
  });
}
