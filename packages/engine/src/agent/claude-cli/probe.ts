import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, win32 } from "node:path";

import {
  query as sdkQuery,
  type AccountInfo,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import {
  expandTilde,
  readEnvironmentValue,
  type ClaudeCliBilling,
  type ClaudeCliRuntime,
} from "./env.js";
import {
  apiKeyIdentityError,
  apiKeyUnapprovedError,
  binaryMissingError,
  ClaudeCliConfigError,
  notSignedInError,
  probeTimeoutError,
  unrecognizedAuthSourceError,
} from "./errors.js";
import {
  assertVersionAtLeast,
  probeVersion,
  resolveClaudeBinary,
  CLAUDE_CLI_VERSION_FLOOR,
} from "./executable.js";
import {
  buildQueryOptions,
  preflightWindowsMcpConfigTransform,
  type WindowsMcpConfigFileSystemDeps,
} from "./session.js";
import type { ClaudeWorkingAreaPort } from "./working-area.js";

export const ACCOUNT_PROBE_TIMEOUT_MS = 25_000;
export const ACCOUNT_PROBE_RETRY_DELAY_MS = 750;
export const ACCOUNT_PROBE_MODEL = "haiku";
export const ACCOUNT_PROBE_CACHE_TTL_MS = 5 * 60_000;

export const API_KEY_BILLING_IDENTITY_LINE =
  "Using Anthropic API key billing - usage is charged to your API account.";

export type ClaudeAccountClass =
  | "subscription"
  | "api-key-token"
  | "not-signed-in"
  | "unrecognized";

export type ClaudeAccountProbeFailure = "timeout" | "no-account";

export interface ClaudeAccountProbeResult {
  readonly verified: boolean;
  readonly accountClass: ClaudeAccountClass;
  readonly reason?: ClaudeAccountProbeFailure;
  readonly email?: string;
  readonly plan?: string;
  readonly rawAuthSource?: string;
}

const API_KEY_TOKEN_SOURCES = new Set(["apikey", "anthropicapikey", "anthropicauthtoken"]);

const API_KEY_API_PROVIDERS = new Set(["bedrock", "vertex", "foundry"]);

const SIGNED_OUT_TOKEN_SOURCE = "none";

function normalizeAuthToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function planLabel(subscriptionType: string): string {
  const withoutBrand = subscriptionType.replace(/^claude\s+/i, "").trim();
  const source = withoutBrand === "" ? subscriptionType.trim() : withoutBrand;
  return source
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

export function classifyAccountInfo(account: AccountInfo | null | undefined): {
  readonly accountClass: ClaudeAccountClass;
  readonly email?: string;
  readonly plan?: string;
  readonly rawAuthSource?: string;
} {
  if (account === null || account === undefined || typeof account !== "object") {
    return { accountClass: "unrecognized", rawAuthSource: "missing account" };
  }

  const tokenSource = nonEmptyString(account.tokenSource);
  const apiProvider = nonEmptyString(account.apiProvider);
  const subscriptionType = nonEmptyString(account.subscriptionType);
  const email = nonEmptyString(account.email);
  const rawAuthSource = tokenSource ?? apiProvider ?? "unknown";

  if (tokenSource !== undefined && API_KEY_TOKEN_SOURCES.has(normalizeAuthToken(tokenSource))) {
    return { accountClass: "api-key-token", email, rawAuthSource };
  }
  if (apiProvider !== undefined && API_KEY_API_PROVIDERS.has(normalizeAuthToken(apiProvider))) {
    return { accountClass: "api-key-token", email, rawAuthSource };
  }
  if (subscriptionType !== undefined && apiProvider === "firstParty") {
    return { accountClass: "subscription", email, plan: planLabel(subscriptionType) };
  }
  if (tokenSource !== undefined && normalizeAuthToken(tokenSource) === SIGNED_OUT_TOKEN_SOURCE) {
    return { accountClass: "not-signed-in", rawAuthSource };
  }
  return { accountClass: "unrecognized", email, rawAuthSource };
}

export interface ReadFallbackEmailDeps {
  readFile?: (path: string) => Promise<string>;
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export async function readFallbackEmail(
  configDir: string | undefined,
  deps: ReadFallbackEmailDeps = {},
): Promise<string | undefined> {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const read = deps.readFile ?? ((path: string) => readFile(path, "utf8"));
  const home =
    deps.home ??
    (platform === "win32" ? readEnvironmentValue(env, "USERPROFILE", platform) : undefined) ??
    homedir();
  const configured =
    configDir !== undefined && configDir !== ""
      ? platform === "win32"
        ? expandTilde(configDir, { platform, env, home })
        : configDir
      : home;
  const path =
    platform === "win32"
      ? win32.join(configured, ".claude.json")
      : join(configured, ".claude.json");
  let raw: string;
  try {
    raw = await read(path);
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const oauthAccount = (parsed as Record<string, unknown>).oauthAccount;
    if (typeof oauthAccount !== "object" || oauthAccount === null) return undefined;
    return nonEmptyString((oauthAccount as Record<string, unknown>).emailAddress);
  } catch {
    return undefined;
  }
}

function pendingPrompt(signal: AbortSignal): AsyncIterable<SDKUserMessage> {
  const next = async (): Promise<IteratorResult<SDKUserMessage>> => {
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return { done: true, value: undefined };
  };
  return { [Symbol.asyncIterator]: () => ({ next }) };
}

const TIMED_OUT = Symbol("claude-cli-account-probe-timeout");

function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<T | typeof TIMED_OUT> {
  const expiry: Promise<typeof TIMED_OUT> = sleep(timeoutMs).then(() => TIMED_OUT);
  return Promise.race<T | typeof TIMED_OUT>([work, expiry]);
}

export interface ProbeClaudeAccountInput {
  runtime: ClaudeCliRuntime;
  workingArea: ClaudeWorkingAreaPort;
  purpose: "account" | "account-recheck";
  baseEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  model?: string;
  timeoutMs?: number;
}

export interface ProbeClaudeAccountDeps {
  query?: typeof sdkQuery;
  sleep?: (ms: number) => Promise<void>;
  readFallbackEmail?: typeof readFallbackEmail;
  windowsMcpConfigFileSystem?: WindowsMcpConfigFileSystemDeps;
}

async function accountFromQuery(active: Query): Promise<AccountInfo | null> {
  let account: AccountInfo | null = null;
  try {
    const initialization = await active.initializationResult();
    account = initialization.account ?? null;
  } catch {
    account = null;
  }
  try {
    const direct = await active.accountInfo();
    if (direct !== null && direct !== undefined) account = direct;
  } catch {
    return account;
  }
  return account;
}

async function probeOnce(
  input: ProbeClaudeAccountInput,
  deps: ProbeClaudeAccountDeps,
  sleep: (ms: number) => Promise<void>,
  purpose: "account" | "account-recheck" | "retry",
): Promise<AccountInfo | null | typeof TIMED_OUT> {
  const run = deps.query ?? sdkQuery;
  const abortController = new AbortController();
  let active: Query | null = null;
  try {
    const binding = await input.workingArea.prepareForLaunch(purpose);
    const options = buildQueryOptions({
      runtime: input.runtime,
      baseEnv: input.baseEnv ?? process.env,
      platform: input.platform ?? process.platform,
      ...(input.home === undefined ? {} : { home: input.home }),
      model: input.model ?? ACCOUNT_PROBE_MODEL,
      allowedTools: [],
      mcpServers: {},
      persistSession: false,
      abortController,
      stderr: () => {},
      cwd: binding.cwd,
      assertWorkingArea: binding.assertCurrent,
      ...(deps.windowsMcpConfigFileSystem === undefined
        ? {}
        : { windowsMcpConfigFileSystem: deps.windowsMcpConfigFileSystem }),
    });
    binding.assertCurrent();
    active = run({ prompt: pendingPrompt(abortController.signal), options });
    return await withTimeout(
      accountFromQuery(active),
      input.timeoutMs ?? ACCOUNT_PROBE_TIMEOUT_MS,
      sleep,
    );
  } catch (error) {
    if (error instanceof ClaudeCliConfigError) throw error;
    return null;
  } finally {
    abortController.abort();
    if (active !== null) {
      try {
        await active.return(undefined);
      } catch {}
    }
  }
}

export async function probeClaudeAccount(
  input: ProbeClaudeAccountInput,
  deps: ProbeClaudeAccountDeps = {},
): Promise<ClaudeAccountProbeResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let account = await probeOnce(input, deps, sleep, input.purpose);
  if (account === TIMED_OUT) {
    await sleep(ACCOUNT_PROBE_RETRY_DELAY_MS);
    account = await probeOnce(input, deps, sleep, "retry");
  }
  if (account === TIMED_OUT) {
    return { verified: false, accountClass: "unrecognized", reason: "timeout" };
  }

  const classified = classifyAccountInfo(account);
  if (classified.accountClass === "not-signed-in") {
    return {
      verified: false,
      accountClass: "not-signed-in",
      reason: "no-account",
      ...(classified.rawAuthSource === undefined
        ? {}
        : { rawAuthSource: classified.rawAuthSource }),
    };
  }
  if (classified.accountClass === "unrecognized") {
    const isAbsent = account === null || account === undefined;
    return {
      verified: false,
      accountClass: "unrecognized",
      ...(isAbsent ? { reason: "no-account" as const } : {}),
      ...(classified.rawAuthSource === undefined
        ? {}
        : { rawAuthSource: classified.rawAuthSource }),
    };
  }

  const readEmail = deps.readFallbackEmail ?? readFallbackEmail;
  const email =
    classified.email ??
    (await readEmail(input.runtime.configDir, {
      platform: input.platform ?? process.platform,
      env: input.baseEnv ?? process.env,
      ...(input.home === undefined ? {} : { home: input.home }),
    }));

  return {
    verified: true,
    accountClass: classified.accountClass,
    ...(email === undefined ? {} : { email }),
    ...(classified.plan === undefined ? {} : { plan: classified.plan }),
    ...(classified.rawAuthSource === undefined ? {} : { rawAuthSource: classified.rawAuthSource }),
  };
}

export function claudeAccountProbeCacheKey(input: ProbeClaudeAccountInput): string {
  const configDir = input.runtime.configDir ?? "";
  return `${input.runtime.binaryPath}\0${configDir}\0${input.workingArea.cacheKey}`;
}

interface ProbeCacheSlot {
  key: string;
  storedAt: number;
  result: ClaudeAccountProbeResult;
}

let probeCacheSlot: ProbeCacheSlot | null = null;

export function invalidateClaudeAccountProbeCache(): void {
  probeCacheSlot = null;
}

export interface CachedProbeDeps extends ProbeClaudeAccountDeps {
  now?: () => number;
}

export async function probeClaudeAccountCached(
  input: ProbeClaudeAccountInput,
  deps: CachedProbeDeps = {},
): Promise<ClaudeAccountProbeResult> {
  const now = deps.now ?? (() => Date.now());
  const key = claudeAccountProbeCacheKey(input);
  const slot = probeCacheSlot;
  if (slot !== null && slot.key === key && now() - slot.storedAt < ACCOUNT_PROBE_CACHE_TTL_MS) {
    return slot.result;
  }
  const result = await probeClaudeAccount(input, deps);
  probeCacheSlot = { key, storedAt: now(), result };
  return result;
}

export async function recheckClaudeAccount(
  input: ProbeClaudeAccountInput,
  deps: CachedProbeDeps = {},
): Promise<ClaudeAccountProbeResult> {
  invalidateClaudeAccountProbeCache();
  return await probeClaudeAccountCached(input, deps);
}

export function claudeIdentityLine(result: ClaudeAccountProbeResult): string {
  if (result.accountClass === "api-key-token") return API_KEY_BILLING_IDENTITY_LINE;
  const { email, plan } = result;
  if (plan === undefined) return email === undefined ? "Signed in" : `Signed in as ${email}`;
  return email === undefined
    ? `Signed in - Claude ${plan} subscription`
    : `Signed in as ${email} - Claude ${plan} subscription`;
}

export function refusalForProbe(
  result: ClaudeAccountProbeResult,
  billing: ClaudeCliBilling,
): ClaudeCliConfigError | null {
  if (result.reason === "timeout") return probeTimeoutError();
  if (!result.verified) {
    if (result.accountClass === "unrecognized" && result.reason !== "no-account") {
      return unrecognizedAuthSourceError(result.rawAuthSource ?? "unknown");
    }
    return notSignedInError();
  }
  if (billing === "api-key") {
    return result.accountClass === "api-key-token" ? null : apiKeyUnapprovedError();
  }
  return result.accountClass === "subscription" ? null : apiKeyIdentityError();
}

export interface ClaudeCliReadiness {
  readonly binaryPath: string;
  readonly version: string;
  readonly identityLine: string;
  readonly accountClass: ClaudeAccountClass;
  readonly email?: string;
  readonly plan?: string;
}

export interface EnsureClaudeCliReadyInput {
  workingArea: ClaudeWorkingAreaPort;
  binaryPath?: string;
  configDir?: string;
  billing?: ClaudeCliBilling;
  baseEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  model?: string;
  timeoutMs?: number;
  forceRecheck?: boolean;
}

export interface EnsureClaudeCliReadyDeps extends CachedProbeDeps {
  resolveBinary?: typeof resolveClaudeBinary;
  probeVersion?: typeof probeVersion;
  probeAccount?: typeof probeClaudeAccount;
  preflightMcpConfigTransform?: typeof preflightWindowsMcpConfigTransform;
}

export async function ensureClaudeCliReady(
  input: EnsureClaudeCliReadyInput,
  deps: EnsureClaudeCliReadyDeps = {},
): Promise<ClaudeCliReadiness> {
  const platform = input.platform ?? process.platform;
  const billing = input.billing ?? "subscription";
  const baseEnv = input.baseEnv ?? process.env;
  const resolveBinary = deps.resolveBinary ?? resolveClaudeBinary;
  const readVersion = deps.probeVersion ?? probeVersion;
  const preflightMcpConfig = deps.preflightMcpConfigTransform ?? preflightWindowsMcpConfigTransform;
  const probeAccount =
    deps.probeAccount ??
    (input.forceRecheck === true ? recheckClaudeAccount : probeClaudeAccountCached);

  const resolved = await resolveBinary({
    ...(input.binaryPath === undefined ? {} : { explicitPath: input.binaryPath }),
    env: baseEnv,
    platform,
    ...(input.home === undefined ? {} : { home: input.home }),
  });
  if (resolved === null) throw binaryMissingError(input.binaryPath ?? "claude", platform);

  const runtime: ClaudeCliRuntime = {
    binaryPath: resolved,
    billing,
    ...(input.configDir === undefined ? {} : { configDir: input.configDir }),
  };

  const version = await readVersion(resolved, {
    workingArea: input.workingArea,
    runtime,
    baseEnv,
    platform,
    ...(input.home === undefined ? {} : { home: input.home }),
  });
  assertVersionAtLeast(version, CLAUDE_CLI_VERSION_FLOOR, platform);

  if (platform === "win32" && win32.extname(resolved).toLowerCase() === ".cmd") {
    const binding = await input.workingArea.prepareForLaunch(
      input.forceRecheck === true ? "account-recheck" : "account",
    );
    const preflightOptions = buildQueryOptions({
      runtime,
      baseEnv,
      platform,
      ...(input.home === undefined ? {} : { home: input.home }),
      model: input.model ?? ACCOUNT_PROBE_MODEL,
      allowedTools: [],
      mcpServers: {},
      persistSession: false,
      cwd: binding.cwd,
      assertWorkingArea: binding.assertCurrent,
      ...(deps.windowsMcpConfigFileSystem === undefined
        ? {}
        : { windowsMcpConfigFileSystem: deps.windowsMcpConfigFileSystem }),
    });
    preflightMcpConfig({
      binaryPath: resolved,
      env: preflightOptions.env,
      platform,
      ...(deps.windowsMcpConfigFileSystem === undefined
        ? {}
        : { fileSystem: deps.windowsMcpConfigFileSystem }),
    });
  }

  const result = await probeAccount(
    {
      runtime,
      workingArea: input.workingArea,
      purpose: input.forceRecheck === true ? "account-recheck" : "account",
      baseEnv,
      platform,
      ...(input.home === undefined ? {} : { home: input.home }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    },
    deps,
  );

  const refusal = refusalForProbe(result, billing);
  if (refusal !== null) throw refusal;

  return {
    binaryPath: resolved,
    version,
    identityLine: claudeIdentityLine(result),
    accountClass: result.accountClass,
    ...(result.email === undefined ? {} : { email: result.email }),
    ...(result.plan === undefined ? {} : { plan: result.plan }),
  };
}
