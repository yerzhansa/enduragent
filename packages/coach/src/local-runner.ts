import type {
  CoachEngine,
  CoachOperations,
  PlanCreationOperations,
  PlanningReadOperations,
  PlanningRequestOperations,
} from "@enduragent/coach-contract";
import type { ConfirmationGate } from "@enduragent/core";
import { prepareAthleteHome, type AthleteHome } from "@enduragent/kernel-node/home";
import type { WriterProtocolListener } from "@enduragent/kernel-node/lock";
import { createLocalCoachComposition, type LocalCoachComposition } from "./composition.js";
import type { SpendMeterService } from "./spend-meter.js";
import { checkHomeReadiness, type ReadinessFailure } from "./readiness.js";
import { withCoachStoreWriter } from "./runtime.js";

export interface LocalCoachLifecycle {
  readonly home: AthleteHome;
  readonly engine: CoachEngine;
  readonly operations: CoachOperations &
    PlanningReadOperations &
    PlanningRequestOperations &
    PlanCreationOperations;
  readonly spendMeter: SpendMeterService;
  readonly confirmations: Pick<ConfirmationGate, "peek" | "confirm" | "cancel">;
  readonly listener: WriterProtocolListener;
  startInitialRefresh(): Promise<void>;
  close(): Promise<void>;
}

export type LocalCoachRunResult<T> =
  | { readonly status: "completed"; readonly value: T }
  | ReadinessFailure;

export interface WithLocalCoachInput<T> {
  readonly env: Record<string, string | undefined>;
  readonly home: AthleteHome;
  readonly deferInitialRefresh?: boolean;
  readonly operation: (lifecycle: LocalCoachLifecycle) => Promise<T>;
}

type WriterValue<T> =
  | { readonly kind: "readiness-failure"; readonly result: ReadinessFailure }
  | { readonly kind: "fulfilled"; readonly value: T }
  | { readonly kind: "rejected"; readonly error: unknown };

function sameHome(left: AthleteHome, right: AthleteHome): boolean {
  return (
    left.root === right.root &&
    left.storeDir === right.storeDir &&
    left.archiveDir === right.archiveDir &&
    left.configDir === right.configDir
  );
}

export async function withLocalCoach<T>(
  input: WithLocalCoachInput<T>,
): Promise<LocalCoachRunResult<T>> {
  if (typeof input.operation !== "function") {
    throw new TypeError("invalid local coach operation");
  }
  const selectedHome = await prepareAthleteHome(input.home);
  const writerEnv = { ...input.env, ENDURAGENT_HOME: selectedHome.root };
  let operationOutcome: Extract<WriterValue<T>, { kind: "rejected" }> | undefined;
  let writerValue: WriterValue<T>;
  try {
    writerValue = await withCoachStoreWriter(writerEnv, {
      beforeStoreOpen: async (resolvedHome) => {
        if (!sameHome(resolvedHome, selectedHome)) {
          throw new TypeError("Writer home does not match the selected athlete home.");
        }
      },
      operation: async (context): Promise<WriterValue<T>> => {
        const readiness = await checkHomeReadiness(context.home);
        if (readiness.status !== "ready") {
          return {
            kind: "readiness-failure",
            result: readiness,
          };
        }
        const compositionConfig =
          readiness.config.dataDir === selectedHome.root
            ? readiness.config
            : { ...readiness.config, dataDir: selectedHome.root };
        let lifecycle: LocalCoachComposition | undefined;
        let lifecycleCloseOutcome: { kind: "succeeded" } | { kind: "failed"; error: unknown } = {
          kind: "succeeded",
        };
        let outcome: WriterValue<T>;
        try {
          lifecycle = await createLocalCoachComposition({
            env: writerEnv,
            home: selectedHome,
            context,
            config: compositionConfig,
            engineConfig: readiness.engineConfig,
            ...(input.deferInitialRefresh === undefined
              ? {}
              : { deferInitialRefresh: input.deferInitialRefresh }),
          });
          const publishedLifecycle = lifecycle;
          try {
            outcome = {
              kind: "fulfilled",
              value: await input.operation({
                home: selectedHome,
                engine: publishedLifecycle.engine,
                operations: publishedLifecycle.operations,
                spendMeter: publishedLifecycle.spendMeter,
                confirmations: publishedLifecycle.confirmations,
                listener: context.listener,
                startInitialRefresh: () => publishedLifecycle.startInitialRefresh(),
                close: () => publishedLifecycle.close(),
              }),
            };
          } catch (error) {
            operationOutcome = { kind: "rejected", error };
            outcome = operationOutcome;
          }
        } finally {
          if (lifecycle !== undefined) {
            try {
              await lifecycle.close();
            } catch (error) {
              lifecycleCloseOutcome = { kind: "failed", error };
            }
          }
        }
        if (lifecycleCloseOutcome.kind === "failed" && operationOutcome === undefined) {
          throw lifecycleCloseOutcome.error;
        }
        return outcome!;
      },
    });
  } catch (error) {
    if (operationOutcome !== undefined) throw operationOutcome.error;
    throw error;
  }
  if (writerValue.kind === "rejected") throw writerValue.error;
  if (writerValue.kind === "readiness-failure") return writerValue.result;
  return { status: "completed", value: writerValue.value };
}
