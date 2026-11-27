import {
  runCoachDevWriter,
  type CoachDevWriterContext,
  type CoachDevWriterFailureStage,
} from "@enduragent/kernel-node/coach-dev";
import type { AthleteHome } from "@enduragent/kernel-node/home";

export type CoachStoreWriterContext = CoachDevWriterContext;

export type CoachStoreWriterErrorCode = "writer-lock-held" | "writer-failed";

export type WriterContentionDiagnostic =
  | { readonly kind: "holder"; readonly pid: number | null; readonly port: number }
  | { readonly kind: "foreign"; readonly port: number; readonly portFile: string };

export class CoachStoreWriterError extends Error {
  readonly code: CoachStoreWriterErrorCode;
  readonly stage: CoachDevWriterFailureStage | null;
  readonly contention: WriterContentionDiagnostic | null;

  constructor(
    code: CoachStoreWriterErrorCode,
    stage: CoachDevWriterFailureStage | null,
    options?: ErrorOptions,
    contention: WriterContentionDiagnostic | null = null,
  ) {
    super(
      code === "writer-lock-held"
        ? "coach store writer is already active"
        : `coach store writer failed at ${stage}`,
      options,
    );
    this.name = "CoachStoreWriterError";
    this.code = code;
    this.stage = stage;
    this.contention = contention;
  }
}

export interface CoachRuntimeDependencies {
  readonly runWriter: typeof runCoachDevWriter;
}

const defaultDependencies: CoachRuntimeDependencies = Object.freeze({
  runWriter: runCoachDevWriter,
});

export interface CoachStoreWriterPlan<T> {
  readonly beforeStoreOpen: (home: AthleteHome) => Promise<void>;
  readonly operation: (context: CoachStoreWriterContext) => Promise<T>;
}

export async function withCoachStoreWriter<T>(
  env: Record<string, string | undefined>,
  operationOrPlan:
    | ((context: CoachStoreWriterContext) => Promise<T>)
    | CoachStoreWriterPlan<T>,
  deps?: CoachRuntimeDependencies,
): Promise<T> {
  const operation = typeof operationOrPlan === "function"
    ? operationOrPlan
    : operationOrPlan?.operation;
  if (typeof operation !== "function") {
    throw new TypeError("invalid coach writer operation");
  }
  if (typeof operationOrPlan !== "function"
    && typeof operationOrPlan?.beforeStoreOpen !== "function") {
    throw new TypeError("invalid coach writer pre-open operation");
  }

  const dependencies = deps ?? defaultDependencies;
  const result = await dependencies.runWriter({
    env,
    writerVersion: "coach-sync/1",
    ...(typeof operationOrPlan === "function"
      ? {}
      : { beforeStoreOpen: operationOrPlan.beforeStoreOpen }),
    operation,
  });

  if (result.status === "completed") return result.value;
  if (result.status === "writer-lock-held") {
    throw new CoachStoreWriterError("writer-lock-held", null, undefined, result.contention);
  }
  throw new CoachStoreWriterError("writer-failed", result.stage, result.cause === undefined ? undefined : { cause: result.cause });
}
