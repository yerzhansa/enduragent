import { AsyncLocalStorage } from "node:async_hooks";
import { createSubsystemLogger } from "@enduragent/core";
import { COACH_RPC_METHOD_REGISTRY, type CoachRpcMethodName } from "@enduragent/coach-contract";

const rpcMethod = new AsyncLocalStorage<CoachRpcMethodName>();

export function withRpcMethod<T>(method: CoachRpcMethodName, work: () => T): T {
  return rpcMethod.run(method, work);
}

export function currentRpcMethod(): CoachRpcMethodName | undefined {
  return rpcMethod.getStore();
}

function knownMethod(name: string): CoachRpcMethodName | null {
  return Object.prototype.hasOwnProperty.call(COACH_RPC_METHOD_REGISTRY, name)
    ? (name as CoachRpcMethodName)
    : null;
}

export function reportClosedRpcConnection(
  athleteHome: string,
  code: number,
  reason: string,
  running: number,
): void {
  if (running === 0) return;
  createSubsystemLogger("rpc", athleteHome).warn(
    "rpc_connection_closed_with_calls_running",
    undefined,
    {
      code,
      abortedCall: knownMethod(reason),
      running,
    },
  );
}
