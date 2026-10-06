import {
  assertForeignServerNamesSafe,
  buildConfigOverrideArgs,
  CODEX_MCP_SERVER_NAME,
} from "./config-overrides.js";
import {
  accountNotChatgptError,
  binaryMissingError,
  normalizeCodexAgentError,
  notSignedInError,
  probeTimeoutError,
} from "./errors.js";
import { assertVersionAtLeast, probeVersion, resolveCodexBinary } from "./executable.js";
import { startAppServer, type CodexAppServerSession } from "./session.js";
import { CODEX_SCHEMA_PIN, CODEX_VERSION_FLOOR, compareVersions } from "./version.js";
import {
  readConfigPath,
  verifyConfigOverrides,
  type CodexAccountResponse,
  type CodexChatgptAccount,
  type CodexConfigResponse,
} from "./verify.js";

export const CODEX_PROBE_TIMEOUT_MS = 25_000;
export const CODEX_PROBE_RETRY_DELAY_MS = 750;
export const CODEX_PROBE_CACHE_TTL_MS = 5 * 60_000;

const PLAN_TYPE_LABELS: Readonly<Record<string, string>> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  prolite: "Pro Lite",
  team: "Team",
  self_serve_business_usage_based: "Business",
  business: "Business",
  ent26: "Enterprise",
  enterprise_cbp_usage_based: "Enterprise",
  enterprise: "Enterprise",
  edu: "Edu",
};

export function codexPlanLabel(planType: string): string | null {
  const known = PLAN_TYPE_LABELS[planType];
  if (known !== undefined) return known;
  const normalized = planType.trim();
  if (normalized === "" || normalized.toLowerCase() === "unknown") return null;
  return normalized
    .split(/[\s_-]+/)
    .filter((word) => word !== "")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

export function codexIdentityLine(account: CodexChatgptAccount): string {
  const email = account.email;
  const who = email === null || email.trim() === "" ? "Signed in" : `Signed in as ${email}`;
  const plan = codexPlanLabel(account.planType);
  return plan === null ? `${who} - ChatGPT plan` : `${who} - ChatGPT ${plan} plan`;
}

export function modelWarningLine(model: string, availableIds: readonly string[]): string {
  const available = availableIds.length === 0 ? "none reported" : availableIds.join(", ");
  return `Codex model '${model}' is not offered by this codex install (available: ${available}); starting anyway.`;
}

export function versionDriftLine(version: string): string {
  return `Codex CLI ${version} is newer than the pinned protocol version ${CODEX_SCHEMA_PIN}; running with the tolerant reader.`;
}

export interface CodexAgentReadinessReport {
  readonly status: "ready";
  readonly binaryPath: string;
  readonly version: string;
  readonly account: CodexChatgptAccount;
  readonly identityLine: string;
  readonly foreignServers: readonly string[];
  readonly models: readonly string[];
  readonly warnings: readonly string[];
}

export interface CodexAgentReadinessRefusal {
  readonly status: "refused";
  readonly error: Error;
}

export type CodexAgentReadinessResult = CodexAgentReadinessReport | CodexAgentReadinessRefusal;

export interface EnsureCodexAgentReadyInput {
  readonly binaryPath?: string;
  readonly model: string;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly forceRefresh?: boolean;
  readonly timeoutMs?: number;
}

export interface EnsureCodexAgentReadyDeps {
  resolveBinary?: typeof resolveCodexBinary;
  probeVersion?: typeof probeVersion;
  startSession?: typeof startAppServer;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

interface ModelListResponse {
  readonly data?: readonly { readonly id?: unknown }[];
}

interface ProbeCacheSlot {
  readonly key: string;
  readonly storedAt: number;
  readonly report: CodexAgentReadinessReport;
}

let probeCacheSlot: ProbeCacheSlot | null = null;

export function invalidateCodexAgentProbeCache(): void {
  probeCacheSlot = null;
}

export function codexAgentProbeCacheKey(binaryPath: string, model: string): string {
  return `${binaryPath}\0${model}`;
}

const TIMED_OUT = Symbol("codex-agent-probe-timeout");

function refuse(error: Error): CodexAgentReadinessRefusal {
  return { status: "refused", error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function chatgptAccountFrom(response: CodexAccountResponse): CodexChatgptAccount | null {
  const account = response.account;
  if (!isRecord(account) || account.type !== "chatgpt") return null;
  const email = typeof account.email === "string" ? account.email : null;
  const planType = typeof account.planType === "string" ? account.planType : "unknown";
  return { type: "chatgpt", email, planType };
}

function accountTypeLabel(response: CodexAccountResponse): string {
  const account = response.account;
  if (!isRecord(account)) return "unknown";
  return typeof account.type === "string" ? account.type : "unknown";
}

function modelIdsFrom(response: ModelListResponse): string[] {
  const data = response.data;
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const entry of data) {
    if (isRecord(entry) && typeof entry.id === "string" && entry.id !== "") ids.push(entry.id);
  }
  return ids;
}

async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<T | typeof TIMED_OUT> {
  return await Promise.race<T | typeof TIMED_OUT>([work, sleep(timeoutMs).then(() => TIMED_OUT)]);
}

interface CensusInput {
  readonly binaryPath: string;
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly model: string;
  readonly version: string;
  readonly timeoutMs: number;
}

type CensusOutcome =
  | { readonly kind: "ok"; readonly report: CodexAgentReadinessReport }
  | { readonly kind: "refused"; readonly error: Error }
  | { readonly kind: "timeout" };

async function censusOnce(
  input: CensusInput,
  deps: EnsureCodexAgentReadyDeps,
): Promise<CensusOutcome> {
  const start = deps.startSession ?? startAppServer;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const held: { session: CodexAppServerSession | null } = { session: null };

  const work = (async (): Promise<CensusOutcome> => {
    const session = await start({
      binaryPath: input.binaryPath,
      baseEnv: input.baseEnv,
      configArgs: buildConfigOverrideArgs(),
      handshakeTimeoutMs: input.timeoutMs + 1_000,
    });
    held.session = session;
    const client = session.client;

    const [accountResponse, modelResponse] = await Promise.all([
      client.request<CodexAccountResponse>("account/read", {}),
      client.request<ModelListResponse>("model/list", {}),
    ]);
    const configResponse = await client.request<CodexConfigResponse>("config/read", {
      includeLayers: false,
    });

    const account = chatgptAccountFrom(accountResponse);
    if (account === null) {
      const absent = accountResponse.account === null || accountResponse.account === undefined;
      return {
        kind: "refused",
        error: absent
          ? notSignedInError()
          : accountNotChatgptError(accountTypeLabel(accountResponse)),
      };
    }

    const config = isRecord(configResponse.config) ? configResponse.config : {};
    const overrideFailure = verifyConfigOverrides(config);
    if (overrideFailure !== null) return { kind: "refused", error: overrideFailure };

    const serversValue = readConfigPath(config, "mcp_servers").value;
    const serverNames = isRecord(serversValue) ? Object.keys(serversValue) : [];
    assertForeignServerNamesSafe(serverNames);
    const foreignServers = serverNames.filter((name) => name !== CODEX_MCP_SERVER_NAME);

    const models = modelIdsFrom(modelResponse);
    const warnings: string[] = [];
    if (compareVersions(input.version, CODEX_SCHEMA_PIN) > 0) {
      warnings.push(versionDriftLine(input.version));
    }
    if (input.model !== "" && !models.includes(input.model)) {
      warnings.push(modelWarningLine(input.model, models));
    }

    return {
      kind: "ok",
      report: {
        status: "ready",
        binaryPath: input.binaryPath,
        version: input.version,
        account,
        identityLine: codexIdentityLine(account),
        foreignServers,
        models,
        warnings,
      },
    };
  })();

  let raced: CensusOutcome | typeof TIMED_OUT;
  try {
    raced = await withTimeout(work, input.timeoutMs, sleep);
  } catch (err) {
    await held.session?.close();
    return { kind: "refused", error: normalizeCodexAgentError(err) };
  }

  if (raced === TIMED_OUT) {
    void work.catch(() => undefined);
    await held.session?.close();
    return { kind: "timeout" };
  }
  await held.session?.close();
  return raced;
}

export async function ensureCodexAgentReady(
  input: EnsureCodexAgentReadyInput,
  deps: EnsureCodexAgentReadyDeps = {},
): Promise<CodexAgentReadinessResult> {
  const baseEnv = input.baseEnv ?? process.env;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? ((line: string) => console.warn(line));
  const timeoutMs = input.timeoutMs ?? CODEX_PROBE_TIMEOUT_MS;

  const resolveBinary = deps.resolveBinary ?? resolveCodexBinary;
  let resolved: string | null;
  try {
    resolved = await resolveBinary({
      ...(input.binaryPath === undefined ? {} : { explicitPath: input.binaryPath }),
      env: baseEnv,
    });
  } catch (err) {
    return refuse(normalizeCodexAgentError(err));
  }
  if (resolved === null || resolved === "") {
    return refuse(binaryMissingError(input.binaryPath ?? "codex"));
  }

  const key = codexAgentProbeCacheKey(resolved, input.model);
  if (input.forceRefresh === true) {
    if (probeCacheSlot?.key === key) probeCacheSlot = null;
  } else {
    const slot = probeCacheSlot;
    if (slot !== null && slot.key === key && now() - slot.storedAt < CODEX_PROBE_CACHE_TTL_MS) {
      return slot.report;
    }
  }

  const readVersion = deps.probeVersion ?? probeVersion;
  let version: string;
  try {
    version = await readVersion(resolved, { baseEnv });
    assertVersionAtLeast(version, CODEX_VERSION_FLOOR);
  } catch (err) {
    if (probeCacheSlot?.key === key) probeCacheSlot = null;
    return refuse(normalizeCodexAgentError(err));
  }

  const censusInput: CensusInput = {
    binaryPath: resolved,
    baseEnv,
    model: input.model,
    version,
    timeoutMs,
  };

  let outcome = await censusOnce(censusInput, deps);
  if (outcome.kind === "timeout") {
    await sleep(CODEX_PROBE_RETRY_DELAY_MS);
    outcome = await censusOnce(censusInput, deps);
  }

  if (outcome.kind === "timeout") {
    if (probeCacheSlot?.key === key) probeCacheSlot = null;
    return refuse(probeTimeoutError());
  }
  if (outcome.kind === "refused") {
    if (probeCacheSlot?.key === key) probeCacheSlot = null;
    return refuse(outcome.error);
  }

  for (const warning of outcome.report.warnings) log(warning);
  probeCacheSlot = { key, storedAt: now(), report: outcome.report };
  return outcome.report;
}
