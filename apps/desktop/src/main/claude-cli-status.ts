import { readFile } from "node:fs/promises";
import {
  ClaudeCliConfigError,
  claudeCliPatchFrom,
  createClaudeWorkingArea,
  ensureClaudeCliReady,
  invalidateClaudeAccountProbeCache,
  type ClaudeCliBilling,
  type ClaudeCliReadiness,
  type ClaudeWorkingAreaPort,
  type EnsureClaudeCliReadyDeps,
} from "@enduragent/core";
import type { ConfigureRuntimeRpcParams, ModelCatalogSnapshot } from "@enduragent/coach-contract";
import { parse } from "yaml";
import {
  isClaudeCliLaneEligible,
  parseClaudeCliLlmSelection,
  runtimeConfigurationForSelection,
  type OnboardingLlmSelection,
  type OnboardingLlmSelectionResult,
} from "./llm-selection.js";

export const CLAUDE_CLI_STATUS_STATES = [
  "ready",
  "ready-api-key",
  "absent-binary",
  "not-logged-in",
  "api-key-token",
  "disabled",
  "working-area-unavailable",
] as const;

export const CLAUDE_CLI_STATUS_DEADLINE_MS = 72_000;

export type ClaudeCliStatusState = (typeof CLAUDE_CLI_STATUS_STATES)[number];

export interface ClaudeCliStatus {
  readonly state: ClaudeCliStatusState;
  readonly email?: string;
  readonly plan?: string;
  readonly version?: string;
}

export interface ClaudeCliSettings {
  readonly enabled: boolean;
  readonly binaryPath?: string;
  readonly configDir?: string;
  readonly billing: ClaudeCliBilling;
}

export interface ClaudeCliStatusController {
  status(): Promise<ClaudeCliStatus>;
  recheck(): Promise<ClaudeCliStatus>;
  invalidateProbeCache(): void;
  activate(
    selection: OnboardingLlmSelection,
    catalogSnapshot: ModelCatalogSnapshot,
  ): Promise<OnboardingLlmSelectionResult>;
}

export type ClaudeCliStatusDependencies = Pick<
  EnsureClaudeCliReadyDeps,
  | "resolveBinary"
  | "probeVersion"
  | "probeAccount"
  | "preflightMcpConfigTransform"
  | "windowsMcpConfigFileSystem"
> & {
  readonly ensureReady?: typeof ensureClaudeCliReady;
  readonly invalidateProbeCache?: () => void;
};

export interface CreateClaudeCliStatusOptions {
  readonly settings: () => ClaudeCliSettings | Promise<ClaudeCliSettings>;
  readonly environment?: () => Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly applyRuntimeConfig: (request: ConfigureRuntimeRpcParams) => Promise<void>;
  readonly workingArea?: ClaudeWorkingAreaPort;
  readonly forbiddenRoots?: readonly string[];
  readonly dependencies?: ClaudeCliStatusDependencies;
}

export interface ReadClaudeCliSettingsInput {
  readonly configPath: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly readConfigFile?: (path: string) => Promise<string>;
  readonly parseConfigFile?: (source: string) => unknown;
}

const CONFIG_FILE_LIMIT = 256 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function claudeCliYamlBlock(document: unknown): unknown {
  if (!isRecord(document) || !isRecord(document.llm)) return undefined;
  return document.llm.claude_cli;
}

export async function readClaudeCliSettings(
  input: ReadClaudeCliSettingsInput,
): Promise<ClaudeCliSettings> {
  const environment = input.environment ?? process.env;
  const read = input.readConfigFile ?? ((path: string) => readFile(path, "utf8"));
  const parseDocument = input.parseConfigFile ?? ((source: string) => parse(source) as unknown);
  let block: unknown;
  try {
    const source = await read(input.configPath);
    if (source.length <= CONFIG_FILE_LIMIT) block = claudeCliYamlBlock(parseDocument(source));
  } catch {
    block = undefined;
  }
  const patch = claudeCliPatchFrom(block, environment);
  const binaryPath = typeof patch.binaryPath === "string" ? patch.binaryPath : undefined;
  const configDir = typeof patch.configDir === "string" ? patch.configDir : undefined;
  return {
    enabled: patch.enabled !== false,
    ...(binaryPath === undefined ? {} : { binaryPath }),
    ...(configDir === undefined ? {} : { configDir }),
    billing: patch.billing === "api-key" ? "api-key" : "subscription",
  };
}

function statusForReadiness(readiness: ClaudeCliReadiness): ClaudeCliStatus {
  return {
    state: readiness.accountClass === "api-key-token" ? "ready-api-key" : "ready",
    ...(readiness.email === undefined ? {} : { email: readiness.email }),
    ...(readiness.plan === undefined ? {} : { plan: readiness.plan }),
    version: readiness.version,
  };
}

function stateForFailure(error: unknown): ClaudeCliStatusState {
  if (!(error instanceof ClaudeCliConfigError)) return "not-logged-in";
  switch (error.kind) {
    case "binary-missing":
    case "version-below-floor":
    case "unsupported-windows-executable":
    case "unsafe-windows-command-shim":
    case "windows-mcp-config-write":
    case "windows-mcp-config-cleanup":
      return "absent-binary";
    case "working-area-unavailable":
      return "working-area-unavailable";
    case "api-key-identity":
    case "api-key-unapproved":
    case "unrecognized-auth-source":
      return "api-key-token";
    default:
      return "not-logged-in";
  }
}

export function createClaudeCliStatus(
  options: CreateClaudeCliStatusOptions,
): ClaudeCliStatusController {
  const ensureReady = options.dependencies?.ensureReady ?? ensureClaudeCliReady;
  const invalidate =
    options.dependencies?.invalidateProbeCache ?? invalidateClaudeAccountProbeCache;
  const environment = options.environment ?? (() => process.env);
  const platform = options.platform ?? process.platform;
  const currentWorkingArea = (
    baseEnv: NodeJS.ProcessEnv,
    configDir: string | undefined,
  ): ClaudeWorkingAreaPort =>
    options.workingArea ??
    createClaudeWorkingArea({
      platform,
      environment: baseEnv,
      forbiddenRoots: options.forbiddenRoots ?? [],
      ...(configDir === undefined ? {} : { configDir }),
    });
  const probeDependencies: EnsureClaudeCliReadyDeps = {
    ...(options.dependencies?.resolveBinary === undefined
      ? {}
      : { resolveBinary: options.dependencies.resolveBinary }),
    ...(options.dependencies?.probeVersion === undefined
      ? {}
      : { probeVersion: options.dependencies.probeVersion }),
    ...(options.dependencies?.probeAccount === undefined
      ? {}
      : { probeAccount: options.dependencies.probeAccount }),
    ...(options.dependencies?.preflightMcpConfigTransform === undefined
      ? {}
      : { preflightMcpConfigTransform: options.dependencies.preflightMcpConfigTransform }),
    ...(options.dependencies?.windowsMcpConfigFileSystem === undefined
      ? {}
      : { windowsMcpConfigFileSystem: options.dependencies.windowsMcpConfigFileSystem }),
  };
  interface ReadSlot {
    readonly generation: number;
    readonly task: Promise<ClaudeCliStatus>;
  }

  let readGeneration = 0;
  let recheckGeneration = 0;
  let activeRead: ReadSlot | undefined;
  let queuedRecheck: ReadSlot | undefined;
  let latestReadyStatus: ClaudeCliStatus | null = null;

  const read = async (forceRecheck: boolean): Promise<ClaudeCliStatus> => {
    let settings: ClaudeCliSettings;
    try {
      settings = await options.settings();
    } catch {
      latestReadyStatus = null;
      return { state: "not-logged-in" };
    }
    const baseEnv = { ...environment() };
    if (!isClaudeCliLaneEligible({ environment: baseEnv, enabled: settings.enabled })) {
      latestReadyStatus = null;
      return { state: "disabled" };
    }
    try {
      const status = statusForReadiness(
        await ensureReady(
          {
            workingArea: currentWorkingArea(baseEnv, settings.configDir),
            ...(settings.binaryPath === undefined ? {} : { binaryPath: settings.binaryPath }),
            ...(settings.configDir === undefined ? {} : { configDir: settings.configDir }),
            billing: settings.billing,
            baseEnv,
            platform,
            ...(forceRecheck ? { forceRecheck: true } : {}),
          },
          probeDependencies,
        ),
      );
      latestReadyStatus = status;
      return status;
    } catch (error) {
      latestReadyStatus = null;
      return { state: stateForFailure(error) };
    }
  };

  const startRead = (forceRecheck: boolean): Promise<ClaudeCliStatus> => {
    const generation = ++readGeneration;
    const rawTask = read(forceRecheck);
    let timedOut = false;
    const task = new Promise<ClaudeCliStatus>((resolve, reject) => {
      const timeout = setTimeout(() => {
        timedOut = true;
        reject(new DOMException("Claude CLI status read timed out", "TimeoutError"));
      }, CLAUDE_CLI_STATUS_DEADLINE_MS);
      timeout.unref?.();
      const settleLate = (): void => {
        invalidate();
        latestReadyStatus = null;
      };
      void rawTask.then(
        (status) => {
          if (timedOut) {
            settleLate();
            return;
          }
          clearTimeout(timeout);
          resolve(status);
        },
        (error: unknown) => {
          if (timedOut) {
            settleLate();
            return;
          }
          clearTimeout(timeout);
          resolve({ state: stateForFailure(error) });
        },
      );
    });
    activeRead = { generation, task };
    const clear = (): void => {
      if (activeRead?.generation === generation && activeRead.task === task) {
        activeRead = undefined;
      }
    };
    void task.then(clear, clear);
    return task;
  };
  const status = (): Promise<ClaudeCliStatus> =>
    activeRead?.task ?? queuedRecheck?.task ?? startRead(false);

  return {
    status,
    recheck() {
      if (queuedRecheck !== undefined) return queuedRecheck.task;
      const previous = activeRead;
      const generation = ++recheckGeneration;
      const task = (async () => {
        if (previous !== undefined) {
          await previous.task.then(undefined, (error: unknown) => {
            if (!(error instanceof DOMException) || error.name !== "TimeoutError") throw error;
          });
        }
        invalidate();
        latestReadyStatus = null;
        return await startRead(true);
      })();
      queuedRecheck = { generation, task };
      const clear = (): void => {
        if (queuedRecheck?.generation === generation && queuedRecheck.task === task) {
          queuedRecheck = undefined;
        }
      };
      void task.then(clear, clear);
      return task;
    },
    invalidateProbeCache: () => {
      invalidate();
      latestReadyStatus = null;
    },
    async activate(input, catalogSnapshot) {
      let selection: ReturnType<typeof parseClaudeCliLlmSelection>;
      try {
        selection = parseClaudeCliLlmSelection(input);
      } catch {
        return { status: "refused", reason: "invalid-input" };
      }
      const current = latestReadyStatus ?? (await status());
      if (current.state === "disabled") {
        return { status: "refused", reason: "runtime-unavailable" };
      }
      if (current.state !== "ready" && current.state !== "ready-api-key") {
        return { status: "refused", reason: "credential-required" };
      }
      try {
        await options.applyRuntimeConfig(
          runtimeConfigurationForSelection(selection, undefined, catalogSnapshot),
        );
      } catch {
        return { status: "refused", reason: "runtime-unavailable" };
      }
      return { status: "configured", runtimeReady: true };
    },
  };
}
