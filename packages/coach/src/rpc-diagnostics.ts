import { AsyncLocalStorage } from "node:async_hooks";
import { createSubsystemLogger, type SubsystemLogger } from "@enduragent/core";
import { COACH_RPC_METHOD_REGISTRY, type CoachRpcMethodName } from "@enduragent/coach-contract";

interface RpcCall {
  readonly method: CoachRpcMethodName;
  running: boolean;
}

const rpcCall = new AsyncLocalStorage<RpcCall>();

export async function withRpcMethod<T>(
  method: CoachRpcMethodName,
  work: () => Promise<T>,
): Promise<T> {
  const call: RpcCall = { method, running: true };
  try {
    return await rpcCall.run(call, work);
  } finally {
    call.running = false;
  }
}

export function currentRpcMethod(): CoachRpcMethodName | undefined {
  const call = rpcCall.getStore();
  return call?.running === true ? call.method : undefined;
}

export type RpcCallScope = <T>(work: () => T) => T;

export function captureRpcCall(): RpcCallScope {
  const call = rpcCall.getStore();
  return (work) => (call === undefined ? rpcCall.exit(work) : rpcCall.run(call, work));
}

function knownMethod(name: string): CoachRpcMethodName | null {
  return Object.prototype.hasOwnProperty.call(COACH_RPC_METHOD_REGISTRY, name)
    ? (name as CoachRpcMethodName)
    : null;
}

export interface RpcConnectionLog {
  closed(code: number, reason: string, running: number): void;
}

export function createRpcConnectionLog(athleteHome: string): RpcConnectionLog {
  let logger: SubsystemLogger | undefined;
  return {
    closed(code, reason, running) {
      if (running === 0) return;
      logger ??= createSubsystemLogger("rpc", athleteHome);
      logger.warn("rpc_connection_closed_with_calls_running", undefined, {
        code,
        abortedCall: knownMethod(reason),
        running,
      });
    },
  };
}
