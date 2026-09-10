import { msg } from "@enduragent/i18n";
import { say } from "./cli-copy.js";
import {
  createClaudeWorkingArea,
  ensureClaudeCliReady,
  type ClaudeWorkingAreaPort,
} from "@enduragent/engine";

import type { ClaudeCliBilling } from "./runtime-config.js";

export const CLAUDE_CLI_SIGN_IN_GUIDANCE = msg("cli.setup.runClaudeOnceInYourTerminal", {
  command: "claude",
});

export const CLAUDE_CLI_API_KEY_OPT_IN_PROMPT = msg("cli.setup.optInToAnthropicApiKey", {
  provider: "Anthropic",
  billingSetting: "llm.claude_cli.billing: api-key",
});

export const CLAUDE_CLI_API_KEY_DECLINED = msg("cli.setup.leftOnSubscriptionBillingSignIn", {
  claude: "Claude",
});

export interface ClaudeCliSetupInput {
  readonly binaryPath?: string;
  readonly configDir?: string;
  readonly billing: ClaudeCliBilling;
  readonly model: string;
}

export interface ClaudeCliSetupDeps {
  readonly ensureReady?: typeof ensureClaudeCliReady;
  readonly confirmApiKeyOptIn?: () => Promise<boolean>;
  readonly note?: (line: string) => void;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly workingArea?: ClaudeWorkingAreaPort;
  readonly forbiddenRoots?: readonly string[];
}

export type ClaudeCliSetupOutcome =
  | {
      readonly status: "ready";
      readonly billing: ClaudeCliBilling;
      readonly identityLine: string;
      readonly binaryPath: string;
      readonly version: string;
    }
  | { readonly status: "refused"; readonly message: string; readonly kind: string | null };

const API_KEY_OPT_IN_KINDS = new Set(["api-key-identity", "unrecognized-auth-source"]);

function configErrorKind(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const kind = (err as Error & { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : null;
}

function failureMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return say("cli.setup.claudeCodeCliSetupCheckFailed", {
    value1: String(err),
    cli: "Claude Code CLI",
  });
}

export async function runClaudeCliSetupStep(
  input: ClaudeCliSetupInput,
  deps: ClaudeCliSetupDeps = {},
): Promise<ClaudeCliSetupOutcome> {
  const ensureReady = deps.ensureReady ?? ensureClaudeCliReady;
  const note = deps.note ?? ((line: string) => console.log(line));
  let workingArea = deps.workingArea;

  const attempt = async (
    billing: ClaudeCliBilling,
    forceRecheck: boolean,
  ): Promise<ClaudeCliSetupOutcome> => {
    try {
      workingArea ??= createClaudeWorkingArea({
        ...(deps.baseEnv === undefined ? {} : { environment: deps.baseEnv }),
        forbiddenRoots: deps.forbiddenRoots ?? [],
        ...(input.configDir === undefined ? {} : { configDir: input.configDir }),
      });
      const readiness = await ensureReady({
        workingArea,
        ...(input.binaryPath === undefined ? {} : { binaryPath: input.binaryPath }),
        ...(input.configDir === undefined ? {} : { configDir: input.configDir }),
        billing,
        model: input.model,
        forceRecheck,
        ...(deps.baseEnv === undefined ? {} : { baseEnv: deps.baseEnv }),
      });
      return {
        status: "ready",
        billing,
        identityLine: readiness.identityLine,
        binaryPath: readiness.binaryPath,
        version: readiness.version,
      };
    } catch (err) {
      return { status: "refused", message: failureMessage(err), kind: configErrorKind(err) };
    }
  };

  const first = await attempt(input.billing, false);
  if (first.status === "ready") {
    note(first.identityLine);
    return first;
  }

  note(first.message);
  if (first.kind === "not-signed-in") {
    note(say(CLAUDE_CLI_SIGN_IN_GUIDANCE));
    return first;
  }

  if (input.billing !== "subscription" || first.kind === null) return first;
  if (!API_KEY_OPT_IN_KINDS.has(first.kind)) return first;

  const confirmOptIn = deps.confirmApiKeyOptIn ?? (async () => false);
  if (!(await confirmOptIn())) {
    note(say(CLAUDE_CLI_API_KEY_DECLINED));
    return first;
  }

  const second = await attempt("api-key", true);
  note(second.status === "ready" ? second.identityLine : second.message);
  return second;
}
