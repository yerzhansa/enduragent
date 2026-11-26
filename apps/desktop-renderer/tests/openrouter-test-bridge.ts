import { vi } from "vitest";
import type { OpenRouterSignInBridge, OpenRouterSignInProgress } from "../src/onboarding/bridge";

type Mocked<Bridge> = {
  readonly [Method in keyof Bridge]: Bridge[Method] extends (...args: never[]) => unknown
    ? ReturnType<typeof vi.fn<Bridge[Method]>>
    : never;
};

export type OpenRouterTestBridge = Mocked<OpenRouterSignInBridge> & {
  emitOpenRouterProgress(progress: OpenRouterSignInProgress): void;
};

export function openRouterTestBridge(): OpenRouterTestBridge {
  const listeners = new Set<(progress: OpenRouterSignInProgress) => void>();
  return {
    openRouterSignIn: vi.fn<OpenRouterSignInBridge["openRouterSignIn"]>(
      async ({ operationId }) => ({
        status: "connected",
        operationId,
        credit: "paid",
      }),
    ),
    startOpenRouterCodeSignIn: vi.fn<OpenRouterSignInBridge["startOpenRouterCodeSignIn"]>(
      async ({ operationId }) => ({ status: "awaiting-code", operationId }),
    ),
    useCopiedOpenRouterCode: vi.fn<OpenRouterSignInBridge["useCopiedOpenRouterCode"]>(
      async (operationId) => ({ status: "connected", operationId, credit: "paid" }),
    ),
    cancelOpenRouterSignIn: vi.fn<OpenRouterSignInBridge["cancelOpenRouterSignIn"]>(
      async () => true,
    ),
    reopenOpenRouterSignIn: vi.fn<OpenRouterSignInBridge["reopenOpenRouterSignIn"]>(
      async () => true,
    ),
    openRouterCreditStatus: vi.fn<OpenRouterSignInBridge["openRouterCreditStatus"]>(
      async () => "paid",
    ),
    openOpenRouterPage: vi.fn<OpenRouterSignInBridge["openOpenRouterPage"]>(async () => true),
    onOpenRouterSignInProgress: vi.fn<OpenRouterSignInBridge["onOpenRouterSignInProgress"]>(
      (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    ),
    emitOpenRouterProgress(progress) {
      for (const listener of listeners) listener(progress);
    },
  };
}
