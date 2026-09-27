import { EXIT_SUCCESS, type DaemonOwner, type ExitCode } from "@enduragent/coach-contract";
import { createDaemonHealthState, createHealthzRequestHandler } from "./daemon/healthz-server.js";
import { createCoachRpcServer, ensureDaemonToken } from "./daemon/rpc-server.js";
import { createInvocationCoordinator } from "./daemon/invocation-coordinator.js";
import { createDesktopTelegramController } from "./desktop-telegram-controller.js";
import { createDesktopTelegramRuntimeFactory } from "./desktop-telegram-runtime.js";
import type { LocalCoachLifecycle } from "./local-runner.js";
import { createPackagedSelfTestOperation } from "./packaged-self-test.js";

export interface RunCoachServeInput {
  readonly lifecycle: LocalCoachLifecycle;
  readonly appVersion: string;
  readonly signal: AbortSignal;
  readonly owner?: DaemonOwner;
}

export interface CoachServeDependencies {
  readonly ensureToken: typeof ensureDaemonToken;
  readonly createRpcServer: typeof createCoachRpcServer;
  readonly createHealthzHandler: typeof createHealthzRequestHandler;
  readonly createHealthState: typeof createDaemonHealthState;
  readonly createInvocations: typeof createInvocationCoordinator;
  readonly createTelegramController: typeof createDesktopTelegramController;
  readonly createTelegramRuntimeFactory: typeof createDesktopTelegramRuntimeFactory;
}

const defaultDependencies: CoachServeDependencies = {
  ensureToken: ensureDaemonToken,
  createRpcServer: createCoachRpcServer,
  createHealthzHandler: createHealthzRequestHandler,
  createHealthState: createDaemonHealthState,
  createInvocations: createInvocationCoordinator,
  createTelegramController: createDesktopTelegramController,
  createTelegramRuntimeFactory: createDesktopTelegramRuntimeFactory,
};

export async function runCoachServe(
  input: RunCoachServeInput,
  dependencies: CoachServeDependencies = defaultDependencies,
): Promise<ExitCode> {
  if (input.signal.aborted) return EXIT_SUCCESS;
  let aborted = false;
  let resolveAbort!: () => void;
  const abortPromise = new Promise<void>((resolve) => {
    resolveAbort = resolve;
  });
  const latchAbort = (): void => {
    if (aborted) return;
    aborted = true;
    resolveAbort();
  };
  input.signal.addEventListener("abort", latchAbort, { once: true });
  if (input.signal.aborted) latchAbort();
  try {
    if (aborted) return EXIT_SUCCESS;
    const token = await dependencies.ensureToken(input.lifecycle.home.configDir);
    if (aborted) return EXIT_SUCCESS;
    const spendMeter = input.lifecycle.spendMeter;
    const healthState = dependencies.createHealthState();
    const invocations = dependencies.createInvocations();
    const telegram = dependencies.createTelegramController({
      dataDir: input.lifecycle.home.root,
      createRuntime: dependencies.createTelegramRuntimeFactory({
        lifecycle: input.lifecycle,
        invocations,
        appVersion: input.appVersion,
      }),
    });
    const owner = input.owner ?? "unmanaged-foreground";
    const scheduleInitialRefresh = (): void => {
      void input.lifecycle.startInitialRefresh().then(
        () => undefined,
        () => undefined,
      );
    };
    const rpc = dependencies.createRpcServer({
      engine: input.lifecycle.engine,
      operations: input.lifecycle.operations,
      spend: {
        getSpendSummary: () => spendMeter.getSpendSummary(),
        setDailySpendCap: ({ dailyCapUsd }) => spendMeter.setDailySpendCap(dailyCapUsd),
      },
      selfTestOperations: { selfTest: createPackagedSelfTestOperation() },
      telegram,
      token: token.value,
      owner,
      athleteHome: input.lifecycle.home.root,
      healthState,
      invocations,
      beforeInvocationDrain: async () => {
        await telegram.stopPolling();
        await telegram.drainPending();
      },
      afterInvocationDrainRefusal: async () => {
        await telegram.resumePolling();
      },
      scheduleInitialRefresh,
    });
    let quiescePromise: Promise<void> | undefined;
    const quiesce = (): Promise<void> => {
      quiescePromise ??= (async () => {
        const errors: unknown[] = [];
        let fence: ReturnType<typeof invocations.closeAdmission> | undefined;
        try {
          fence = invocations.closeAdmission();
        } catch (error) {
          errors.push(error);
        }
        try {
          fence?.seal();
        } catch (error) {
          errors.push(error);
        }
        try {
          healthState.setHealthy(false);
        } catch (error) {
          errors.push(error);
        }
        try {
          await telegram.stopPolling();
        } catch (error) {
          errors.push(error);
        }
        try {
          await telegram.drainPending();
        } catch (error) {
          errors.push(error);
        }
        try {
          await fence?.drain();
        } catch (error) {
          errors.push(error);
        }
        if (errors.length > 0) throw errors[0];
      })();
      return quiescePromise;
    };
    if (aborted) {
      const cleanupErrors: unknown[] = [];
      try {
        await quiesce();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await rpc.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await telegram.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) throw cleanupErrors[0];
      return EXIT_SUCCESS;
    }
    let binding: Awaited<ReturnType<LocalCoachLifecycle["listener"]["bind"]>>;
    try {
      binding = await input.lifecycle.listener.bind({
        request: dependencies.createHealthzHandler({
          appVersion: input.appVersion,
          state: healthState,
        }),
        upgrade: rpc.handleUpgrade,
      });
    } catch (error) {
      const cleanupErrors: unknown[] = [error];
      try {
        await quiesce();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        await rpc.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        await telegram.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      throw cleanupErrors.length === 1 ? error : new AggregateError(cleanupErrors);
    }
    if (!aborted && owner !== "app-supervised") {
      scheduleInitialRefresh();
    }
    if (!aborted) await Promise.race([abortPromise, rpc.shutdownRequested]);
    const cleanupErrors: unknown[] = [];
    try {
      await quiesce();
    } catch (error) {
      cleanupErrors.push(error);
    }
    let bindingClose: Promise<void> | undefined;
    try {
      bindingClose = binding.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await rpc.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (bindingClose !== undefined) {
      try {
        await bindingClose;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await telegram.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) throw cleanupErrors[0];
    return EXIT_SUCCESS;
  } finally {
    input.signal.removeEventListener("abort", latchAbort);
  }
}
