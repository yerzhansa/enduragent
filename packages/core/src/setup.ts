import { AsyncLocalStorage } from "node:async_hooks";
import {
  msg,
  type Message,
  type CoachLanguage,
  type SurfaceHint,
  type LanguageTag,
} from "@enduragent/i18n";
import { readEnvironmentSurfaceHint } from "@enduragent/i18n/node";
import { createNpmCoachLanguage } from "./language-preference.js";
import { say, cliPhrasebook, withCliPhrasebook } from "./cli-copy.js";
import {
  intro,
  outro,
  select,
  text,
  password,
  confirm,
  isCancel,
  cancel,
  log,
} from "@clack/prompts";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, chmodSync } from "node:fs";
import { stringify as toYaml } from "yaml";
import { type BinaryConfig, binaryEnvVar } from "./binary.js";
import { CONFIG_DIR, CONFIG_FILE, envInt, readConfigYaml } from "./config.js";
import { LLM_MODEL_CATALOGUE, isKeylessProvider } from "./runtime-config.js";
import { captureAndPersistOperator } from "./channels/operator-capture.js";
import { loadAllowedSenders } from "./channels/allowed-senders.js";
import { runCodexLogin } from "./auth/openai-codex-login.js";
import { loadProfile, saveProfile, type OAuthCredential } from "./auth/profiles.js";
import { isSecretRef, type SecretRef } from "./secrets/types.js";
import {
  detectBackends,
  type BackendAvailability,
  type OpState,
} from "./secrets/backends/detect.js";
import {
  OpVaultAmbiguousError,
  SecretTooLargeError,
  opItemCreate,
  opItemDelete,
  opItemGet,
  opItemUpdate,
  opSecretRef,
  opVaultList,
} from "./secrets/backends/op.js";
import {
  KeychainUnsafeValueError,
  keychainItemDelete,
  keychainItemExists,
  keychainItemUpsert,
  keychainLoginPath,
  keychainSecretRef,
} from "./secrets/backends/keychain.js";

// ============================================================================
// TYPES
// ============================================================================

function modelHintMessage(hint: string): Message | undefined {
  switch (hint) {
    case "recommended":
      return msg("cli.setup.modelHints.recommended");
    case "fast & cheap":
      return msg("cli.setup.modelHints.fastAndCheap");
    case "most capable":
      return msg("cli.setup.modelHints.mostCapable");
    case "balanced":
      return msg("cli.setup.modelHints.balanced");
    case "cheapest":
      return msg("cli.setup.modelHints.cheapest");
    case "experimental":
      return msg("cli.setup.modelHints.experimental");
    case "faster":
      return msg("cli.setup.modelHints.faster");
    case "fast":
      return msg("cli.setup.modelHints.fast");
    case "cheaper":
      return msg("cli.setup.modelHints.cheaper");
    case "one key, many models":
      return msg("cli.setup.modelHints.manyModels");
    case "cheap":
      return msg("cli.setup.modelHints.cheap");
    default:
      return undefined;
  }
}

function setupOption(input: { value: string; label: string; hint?: string }): {
  value: string;
  label: string;
  hint?: string;
} {
  let label = input.label;
  if (input.value === "openai-codex") {
    label = say("cli.setup.codexProvider", { provider: "OpenAI Codex", subscription: "ChatGPT" });
  } else if (input.value === "claude-cli") {
    label = say("cli.setup.claudeProvider", { provider: "Claude", cli: "Claude Code CLI" });
  } else {
    const via = /^(.*) \(via (.*)\)$/.exec(label);
    if (via !== null) label = say("cli.setup.modelVia", { model: via[1], provider: via[2] });
  }
  const hint = input.hint === undefined ? undefined : modelHintMessage(input.hint);
  return { value: input.value, label, ...(hint === undefined ? {} : { hint: say(hint) }) };
}

const API_KEY_LABELS: Record<string, Message> = {
  anthropic: msg("cli.setup.apiKey", { provider: "Anthropic" }),
  openai: msg("cli.setup.apiKey", { provider: "OpenAI" }),
  google: msg("cli.setup.apiKey", { provider: "Google AI" }),
  deepseek: msg("cli.setup.apiKey", { provider: "DeepSeek" }),
  qwen: msg("cli.setup.apiKey", { provider: "Alibaba (Model Studio)" }),
  minimax: msg("cli.setup.apiKey", { provider: "MiniMax" }),
  kimi: msg("cli.setup.apiKey", { provider: "Moonshot" }),
  zai: msg("cli.setup.apiKey", { provider: "Z.AI" }),
  openrouter: msg("cli.setup.apiKey", { provider: "OpenRouter" }),
};

const CUSTOM_MODEL_SENTINEL = "__custom__";
const BACKEND_PLAIN = "plain";
const BACKEND_OP = "op";
const BACKEND_KEYCHAIN = "keychain";
const BACKEND_OP_SIGNIN = "op-signin";

export type BackendChoice = "plain" | "op" | "keychain";

type SecretFieldPath = "llm.api_key" | "intervals.api_key" | "telegram.bot_token";

export type CreatedEntry = {
  backend: "op" | "keychain";
  field: SecretFieldPath;
  title: string;
  vaultName?: string;
  keychainPath?: string;
  opAbsPath?: string;
  preExistedBeforeWizard: boolean;
};

export type WizardCtx = {
  createdThisRun: CreatedEntry[];
};

const FIELD_KEYCHAIN_ACCOUNT: Record<SecretFieldPath, string> = {
  "llm.api_key": "llm_api_key",
  "intervals.api_key": "intervals_api_key",
  "telegram.bot_token": "telegram_bot_token",
};

// ============================================================================
// PURE HELPERS (exported with leading underscore for direct testability)
// ============================================================================

export function _detectPrevBackend(value: unknown): BackendChoice | "unknown" {
  if (typeof value === "string") return "plain";
  if (isSecretRef(value)) {
    if (value.source === "env") return "unknown";
    const cmd = value.command;
    if (cmd === "op" || cmd.endsWith("/op")) return "op";
    if (cmd === "/usr/bin/security" || cmd.endsWith("/security")) return "keychain";
    return "unknown";
  }
  return "plain";
}

export function _processSecretInput(raw: string, field: string): string {
  const cleaned = raw.trim();
  if (cleaned !== raw) {
    log.info(say("cli.setup.trimmedWhitespaceFromPasted", { field: field }));
  }
  const bytes = Buffer.byteLength(cleaned, "utf-8");
  if (bytes > 65_536) {
    throw new SecretTooLargeError(bytes);
  }
  return cleaned;
}

export function _formatOrphanCleanup(ctx: WizardCtx, binary: BinaryConfig): string {
  const orphans = ctx.createdThisRun.filter((e) => !e.preExistedBeforeWizard);
  if (orphans.length === 0) return "";
  const lines: string[] = ["", say("cli.setup.wizardOrphanedBackendItemsCreatedThis")];
  for (const o of orphans) {
    if (o.backend === "op") {
      lines.push(`  op item delete "${o.title}" --vault "${o.vaultName ?? ""}"`);
    } else if (o.backend === "keychain") {
      lines.push(
        `  security delete-generic-password -s ${binary.keychainPrefix} -a "${o.title}" "${o.keychainPath ?? ""}"`,
      );
    }
  }
  return lines.join("\n") + "\n";
}

export function _printOrphanCleanup(ctx: WizardCtx, binary: BinaryConfig): void {
  const msg = _formatOrphanCleanup(ctx, binary);
  if (msg.length > 0) {
    process.stderr.write(msg);
  }
}

export function _createSignalHandler(
  ctx: WizardCtx,
  signal: "SIGINT" | "SIGTERM",
  binary: BinaryConfig,
): () => void {
  return AsyncLocalStorage.bind(() => {
    _printOrphanCleanup(ctx, binary);
    const code = signal === "SIGINT" ? 130 : 143;
    process.exit(code);
  });
}

export function _assertTTY(binary: BinaryConfig): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      say("cli.setup.setupRequiresAnInteractiveTtySee", {
        binaryName: binary.binaryName,
        setupCommand: `${binary.binaryName} setup`,
      }),
    );
    process.exit(2);
  }
}

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

function handleCancel(value: unknown, ctx: WizardCtx, binary: BinaryConfig): void {
  if (isCancel(value)) {
    _printOrphanCleanup(ctx, binary);
    cancel(say("cli.setup.setupCancelled"));
    process.exit(0);
  }
}

function getString(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur && typeof cur === "object" && k in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[k];
    } else {
      return undefined;
    }
  }
  return typeof cur === "string" ? cur : undefined;
}

function readFieldValue(obj: Record<string, unknown>, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur && typeof cur === "object" && k in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[k];
    } else {
      return undefined;
    }
  }
  return cur;
}

async function runOpSignin(opPath: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const child = spawn(opPath, ["signin"], { stdio: "inherit", shell: false });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

// ============================================================================
// WIZARD FLOW
// ============================================================================

export async function selectSetupLanguage(
  language: CoachLanguage,
  surface: SurfaceHint,
): Promise<void> {
  const current = await language.current();
  if (current.origin !== "unset" || surface.language !== undefined) return;
  const selected = await select<LanguageTag>({
    message: say("cli.language.choose"),
    options: language.options.map(({ tag, endonym }) => ({ value: tag, label: endonym })),
    initialValue: surface.language ?? "en",
  });
  if (typeof selected === "symbol") {
    cancel(say("cli.setup.setupCancelled"));
    process.exit(0);
  }
  await language.set(selected);
}

export async function runSetup(binary: BinaryConfig): Promise<void> {
  const previous = readConfigYaml();
  const dataDir = typeof previous.data_dir === "string" ? previous.data_dir : CONFIG_DIR;
  const language = createNpmCoachLanguage(dataDir);
  const phrasebook = await language.phrasebookFor({});
  await withCliPhrasebook(phrasebook, async () => {
    _assertTTY(binary);
    await selectSetupLanguage(language, readEnvironmentSurfaceHint(process.env));
    await withCliPhrasebook(await language.phrasebookFor({}), () => runSetupWizard(binary));
  });
}

async function runSetupWizard(binary: BinaryConfig): Promise<void> {
  const ctx: WizardCtx = { createdThisRun: [] };
  const sigintHandler = _createSignalHandler(ctx, "SIGINT", binary);
  const sigtermHandler = _createSignalHandler(ctx, "SIGTERM", binary);
  process.once("SIGINT", sigintHandler);
  process.once("SIGTERM", sigtermHandler);

  try {
    await _runWizardCore(ctx, binary);
  } catch (err) {
    await _guardedCleanup(ctx, binary);
    cancel(
      say("cli.setup.setupFailed", { value1: err instanceof Error ? err.message : String(err) }),
    );
    process.exit(1);
  } finally {
    process.removeListener("SIGINT", sigintHandler);
    process.removeListener("SIGTERM", sigtermHandler);
  }
}

interface LlmPromptOutcome {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string | undefined;
  readonly claudeCliBlock: Record<string, unknown> | undefined;
  readonly freshCodexCreds: OAuthCredential | null;
}

async function _runLlmPrompts(
  ctx: WizardCtx,
  binary: BinaryConfig,
  previous: Record<string, unknown>,
  prevProvider: string | undefined,
  prevModel: string | undefined,
): Promise<LlmPromptOutcome> {
  // Provider
  const providerResp = await select({
    message: say("cli.setup.provider"),
    options: LLM_MODEL_CATALOGUE.map(({ provider, label, hint }) =>
      setupOption({ value: provider, label, ...(hint === undefined ? {} : { hint }) }),
    ),
    initialValue: prevProvider ?? "anthropic",
  });
  handleCancel(providerResp, ctx, binary);
  const provider = providerResp as string;
  const catalogue = LLM_MODEL_CATALOGUE.find((entry) => entry.provider === provider);

  // Model
  const sameProvider = provider === prevProvider;
  const knownModel = catalogue?.models.some((candidate) => candidate.value === prevModel);
  const initialModel =
    sameProvider && prevModel
      ? knownModel
        ? prevModel
        : CUSTOM_MODEL_SENTINEL
      : catalogue?.defaultModel;
  const modelResp = await select({
    message: say("cli.setup.model"),
    options: [
      ...(catalogue?.models.map(setupOption) ?? []),
      { value: CUSTOM_MODEL_SENTINEL, label: say("cli.setup.otherTypeModelName") },
    ],
    initialValue: initialModel,
  });
  handleCancel(modelResp, ctx, binary);
  let model = modelResp as string;

  if (model === CUSTOM_MODEL_SENTINEL) {
    const custom = await text({
      message: say("cli.setup.modelName"),
      defaultValue: sameProvider ? prevModel : undefined,
      placeholder: sameProvider ? prevModel : undefined,
      validate: (v) =>
        !v && !(sameProvider && prevModel) ? say("cli.setup.modelNameIsRequired") : undefined,
    });
    handleCancel(custom, ctx, binary);
    model = (typeof custom === "string" && custom) || prevModel || "";
  }

  // Base URL — only for OpenAI-compatible / direct providers that declare a
  // default. The built-in providers have no default endpoint, so their prompt
  // order is unchanged.
  let baseUrl: string | undefined;
  const defaultBaseUrl = catalogue?.defaultBaseUrl;
  if (defaultBaseUrl) {
    const prevBaseUrl = getString(previous, "llm", "base_url");
    const baseUrlResp = await text({
      message: say("cli.setup.baseUrlEnterForDefault"),
      defaultValue: prevBaseUrl ?? defaultBaseUrl,
      placeholder: defaultBaseUrl,
    });
    handleCancel(baseUrlResp, ctx, binary);
    baseUrl = (typeof baseUrlResp === "string" && baseUrlResp) || defaultBaseUrl;
  }

  // Codex OAuth — reuse existing profile unless the operator asks to re-login
  let freshCodexCreds: OAuthCredential | null = null;
  if (provider === "openai-codex") {
    const existing = loadProfile("openai-codex");
    let doLogin = true;
    if (existing) {
      const reuse = await confirm({
        message: say("cli.setup.existingCodexOauthProfileFoundRe", { codex: "Codex" }),
        initialValue: false,
      });
      handleCancel(reuse, ctx, binary);
      doLogin = Boolean(reuse);
    }
    if (doLogin) {
      log.info(say("cli.setup.startingOauthSignInChatgptPlus", { subscription: "ChatGPT Plus" }));
      try {
        freshCodexCreds = await runCodexLogin();
        log.success(
          say("cli.setup.openaiCodexOauthComplete", { provider: "OpenAI", codex: "Codex" }),
        );
      } catch (err) {
        cancel(
          say("cli.setup.oauthSignInFailed", {
            value1: err instanceof Error ? err.message : String(err),
          }),
        );
        process.exit(1);
      }
    }
  }

  let claudeCliBlock: Record<string, unknown> | undefined;
  if (provider === "claude-cli") {
    const prevBlock = readFieldValue(previous, "llm", "claude_cli");
    const prevClaudeCli = (
      prevBlock !== null && typeof prevBlock === "object" ? prevBlock : {}
    ) as Record<string, unknown>;
    const prevBinaryPath =
      provider === prevProvider && typeof prevClaudeCli.binary_path === "string"
        ? prevClaudeCli.binary_path
        : undefined;
    const prevConfigDir =
      provider === prevProvider && typeof prevClaudeCli.config_dir === "string"
        ? prevClaudeCli.config_dir
        : undefined;
    const prevBilling =
      provider === prevProvider && prevClaudeCli.billing === "api-key" ? "api-key" : "subscription";

    const { runClaudeCliSetupStep, CLAUDE_CLI_API_KEY_OPT_IN_PROMPT } =
      await import("./claude-cli-setup.js");
    const outcome = await runClaudeCliSetupStep(
      {
        ...(prevBinaryPath === undefined ? {} : { binaryPath: prevBinaryPath }),
        ...(prevConfigDir === undefined ? {} : { configDir: prevConfigDir }),
        billing: prevBilling,
        model,
      },
      {
        forbiddenRoots: [CONFIG_DIR],
        note: (line) => log.info(line),
        confirmApiKeyOptIn: async () => {
          const answer = await confirm({
            message: say(CLAUDE_CLI_API_KEY_OPT_IN_PROMPT),
            initialValue: false,
          });
          handleCancel(answer, ctx, binary);
          return Boolean(answer);
        },
      },
    );
    if (outcome.status === "refused") {
      cancel(outcome.message);
      process.exit(1);
    }
    claudeCliBlock = {
      enabled: true,
      binary_path: outcome.binaryPath,
      ...(prevConfigDir === undefined ? {} : { config_dir: prevConfigDir }),
      billing: outcome.billing,
    };
  }

  return { provider, model, baseUrl, claudeCliBlock, freshCodexCreds };
}

async function _runWizardCore(ctx: WizardCtx, binary: BinaryConfig): Promise<void> {
  intro(say("cli.setup.setup", { displayName: binary.displayName }));

  const previous = readConfigYaml();
  const prevProvider = getString(previous, "llm", "provider");
  const prevModel = getString(previous, "llm", "model");
  const prevLlmKey = readFieldValue(previous, "llm", "api_key");
  const prevIntervalsKey = readFieldValue(previous, "intervals", "api_key");
  const prevIntervalsId = getString(previous, "intervals", "athlete_id");
  const prevTelegramToken = readFieldValue(previous, "telegram", "bot_token");

  let keepLlmBlock = false;
  if (
    prevProvider !== undefined &&
    !LLM_MODEL_CATALOGUE.some((entry) => entry.provider === prevProvider)
  ) {
    log.warn(say("cli.setup.yourCurrentProviderIsNotOffered", { prevProvider: prevProvider }));
    const replaceProvider = await confirm({
      message: say("cli.setup.replaceWithAProviderFromThis", { prevProvider: prevProvider }),
      initialValue: false,
    });
    handleCancel(replaceProvider, ctx, binary);
    keepLlmBlock = !replaceProvider;
    if (keepLlmBlock) {
      log.info(say("cli.setup.keepingTheRestOfSetupContinues", { prevProvider: prevProvider }));
    }
  }

  const llm = keepLlmBlock
    ? null
    : await _runLlmPrompts(ctx, binary, previous, prevProvider, prevModel);
  const freshCodexCreds = llm?.freshCodexCreds ?? null;

  // Detect backends + pick secret backend (D12 + D9)
  let backend = await _pickBackend(ctx, binary);

  // Cache vault (D10 multi-vault fallback caches the chosen vault for the run)
  let chosenVault: string | undefined;
  let opAbsPath: string | undefined;
  let keychainPath: string | undefined;

  // Each secret gets processed: collect user input, branch on backend choice
  // vs previous backend, potentially apply D13 migration prompt, and write to
  // the chosen backend. The merged config is mutated in place.
  const merged: Record<string, unknown> = { ...previous };
  if (llm !== null) {
    const llmConfig: Record<string, unknown> = { provider: llm.provider, model: llm.model };
    if (llm.provider === "openai-codex") {
      llmConfig.auth_profile = "openai-codex";
    }
    if (llm.claudeCliBlock !== undefined) {
      llmConfig.claude_cli = llm.claudeCliBlock;
    }
    if (llm.baseUrl !== undefined) {
      llmConfig.base_url = llm.baseUrl;
    }

    if (!isKeylessProvider(llm.provider)) {
      const hasPrev = llm.provider === prevProvider && isNonEmptySecret(prevLlmKey);
      const result = await _collectAndWriteSecret(
        ctx,
        {
          field: "llm.api_key",
          label: say(API_KEY_LABELS[llm.provider]),
          required: !hasPrev,
          prevValue: llm.provider === prevProvider ? prevLlmKey : undefined,
          backend,
          chosenVaultRef: { current: chosenVault },
          opAbsPathRef: { current: opAbsPath },
          keychainPathRef: { current: keychainPath },
        },
        binary,
      );
      chosenVault = result.chosenVault;
      opAbsPath = result.opAbsPath;
      keychainPath = result.keychainPath;
      backend = result.backend;
      if (result.yamlValue !== undefined) {
        llmConfig.api_key = result.yamlValue;
      }
    }
    merged.llm = llmConfig;
  }

  // intervals.api_key (optional)
  let intervalsAthleteId = prevIntervalsId ?? "";
  {
    const hasPrev = isNonEmptySecret(prevIntervalsKey);
    const result = await _collectAndWriteSecret(
      ctx,
      {
        field: "intervals.api_key",
        label: say("cli.setup.intervalsIcuApiKey", { platform: "intervals.icu" }),
        required: false,
        prevValue: prevIntervalsKey,
        backend,
        chosenVaultRef: { current: chosenVault },
        opAbsPathRef: { current: opAbsPath },
        keychainPathRef: { current: keychainPath },
      },
      binary,
    );
    chosenVault = result.chosenVault;
    opAbsPath = result.opAbsPath;
    keychainPath = result.keychainPath;
    backend = result.backend;
    if (result.yamlValue !== undefined) {
      // Ask for athlete ID when the user typed a new key (reuse prev athlete id on keep).
      if (result.providedNewValue) {
        const athleteId = await text({
          message: say("cli.setup.intervalsIcuAthleteId", { platform: "intervals.icu" }),
          defaultValue: prevIntervalsId ?? "0",
          placeholder: prevIntervalsId ?? "0",
        });
        handleCancel(athleteId, ctx, binary);
        intervalsAthleteId = (typeof athleteId === "string" && athleteId) || prevIntervalsId || "0";
      } else if (hasPrev) {
        intervalsAthleteId = prevIntervalsId ?? "0";
      }
      merged.intervals = {
        api_key: result.yamlValue,
        athlete_id: intervalsAthleteId || "0",
      };
    } else if (prevIntervalsId) {
      // User skipped the api_key prompt but a prior athlete_id exists (common
      // when api_key comes from INTERVALS_API_KEY env var and only athlete_id
      // is in YAML). Preserve it — don't silently wipe the section.
      merged.intervals = { athlete_id: prevIntervalsId };
    } else {
      delete merged.intervals;
    }
  }

  // telegram.bot_token (optional)
  {
    const result = await _collectAndWriteSecret(
      ctx,
      {
        field: "telegram.bot_token",
        label: say("cli.setup.telegramBotToken", { telegram: "Telegram" }),
        required: false,
        prevValue: prevTelegramToken,
        backend,
        chosenVaultRef: { current: chosenVault },
        opAbsPathRef: { current: opAbsPath },
        keychainPathRef: { current: keychainPath },
      },
      binary,
    );
    chosenVault = result.chosenVault;
    opAbsPath = result.opAbsPath;
    keychainPath = result.keychainPath;
    backend = result.backend;
    if (result.yamlValue !== undefined) {
      merged.telegram = { bot_token: result.yamlValue };
    } else {
      delete merged.telegram;
    }
  }

  // Confirm before writing when a prior config exists.
  if (existsSync(CONFIG_FILE)) {
    const ok = await confirm({
      message: say("cli.setup.update", { CONFIG_FILE: CONFIG_FILE }),
      initialValue: true,
    });
    handleCancel(ok, ctx, binary);
    if (!ok) {
      log.info(say("cli.setup.noChangesWritten"));
      return;
    }
  }

  const originalBytes = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE) : null;

  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_FILE, toYaml(merged), { mode: 0o600 });
  // Ensure perms on existing files created before this write
  chmodSync(CONFIG_FILE, 0o600);

  if (freshCodexCreds) {
    try {
      saveProfile("openai-codex", freshCodexCreds);
    } catch (err) {
      if (originalBytes) {
        writeFileSync(CONFIG_FILE, originalBytes, { mode: 0o600 });
        chmodSync(CONFIG_FILE, 0o600);
      } else {
        try {
          unlinkSync(CONFIG_FILE);
        } catch {
          /* best-effort */
        }
      }
      cancel(
        say("cli.setup.failedToSaveOauthProfile", {
          value1: err instanceof Error ? err.message : String(err),
        }),
      );
      process.exit(1);
    }
  }

  // Operator capture runs AFTER config.yaml is committed: cancelling at the
  // confirm-write prompt above leaves no orphan allowed-senders.json. Only fires
  // for plain-string tokens — SecretRef tokens (1Password / keychain) defer to
  // the CLI `add-sender` path. Capture is opportunistic; any failure logs and
  // continues without aborting the wizard.
  const tgToken = (merged.telegram as { bot_token?: unknown } | undefined)?.bot_token;
  if (typeof tgToken === "string" && tgToken.length > 0) {
    await runOperatorCaptureStep(tgToken, binary, ctx);
  }

  outro(
    say("cli.setup.configWrittenToRunToStart", {
      CONFIG_FILE: CONFIG_FILE,
      binaryName: binary.binaryName,
    }),
  );
}

async function runOperatorCaptureStep(
  botToken: string,
  binary: BinaryConfig,
  ctx: WizardCtx,
): Promise<void> {
  const existing = loadAllowedSenders(CONFIG_DIR);
  const hasAllowlist = existing.allowFrom.length > 0;
  if (hasAllowlist) {
    const reCapture = await confirm({
      message: say("cli.setup.operatorAlreadyConfiguredIdAllowfromHas", {
        operator: existing.primaryOperator ?? "—",
        count: existing.allowFrom.length,
        formattedCount: cliPhrasebook().format.number(existing.allowFrom.length, {
          useGrouping: false,
        }),
      }),
      initialValue: false,
    });
    handleCancel(reCapture, ctx, binary);
    if (!reCapture) {
      log.info(say("cli.setup.skippingOperatorCaptureExistingAllowlistPreserved"));
      return;
    }
  }

  log.info(
    say("cli.setup.setupWillRegisterYourTelegramAccount", {
      telegram: "Telegram",
      seconds: cliPhrasebook().format.number(60, { useGrouping: false }),
    }),
  );
  const timeoutMs = envInt(binaryEnvVar(binary.binaryName, "SETUP_CAPTURE_TIMEOUT_MS")) ?? 60_000;
  const result = await captureAndPersistOperator({
    botToken,
    binary,
    dataDir: CONFIG_DIR,
    phrasebook: cliPhrasebook(),
    timeoutMs,
    confirm: async (info) => {
      const ok = await confirm({
        message: say("cli.setup.capturedOperatorIdTelegramNameFor", {
          capturedId: info.capturedId,
          value1: info.senderUsername ?? "—",
          value2: info.senderFirstName ?? "—",
          botUsername: info.botUsername,
          telegram: "Telegram",
        }),
        initialValue: false,
      });
      handleCancel(ok, ctx, binary);
      return Boolean(ok);
    },
    log: (line) => log.info(line),
  });

  switch (result.status) {
    case "captured":
      log.success(say("cli.setup.operatorRegisteredId", { capturedId: String(result.capturedId) }));
      return;
    case "declined":
      log.warn(
        say("cli.setup.captureDiscardedRunAddSenderId", {
          binaryName: binary.binaryName,
          addSenderCommand: `${binary.binaryName} add-sender <id>`,
        }),
      );
      return;
    case "timeout":
      log.warn(
        say("cli.setup.noPairingCodeReceivedWithinThe", {
          binaryName: binary.binaryName,
          telegram: "Telegram",
          addSenderCommand: `${binary.binaryName} add-sender <id>`,
        }),
      );
      return;
    case "getme-failed":
      log.warn(
        say("cli.setup.botTokenDidNotResolveTo", {
          value1: result.reason ?? say("cli.setup.unknownError"),
          binaryName: binary.binaryName,
          telegram: "Telegram",
          setupCommand: `${binary.binaryName} setup`,
        }),
      );
      return;
    case "lockfile-contention":
      log.warn(
        say("cli.setup.allowlistLockfileIsHeldByAnother", {
          binaryName: binary.binaryName,
          addSenderCommand: `${binary.binaryName} add-sender <id>`,
        }),
      );
      return;
    case "write-failed":
      log.warn(
        say("cli.setup.failedToPersistAllowlistRunAdd", {
          value1: result.reason ?? say("cli.setup.unknownError"),
          binaryName: binary.binaryName,
          addSenderCommand: `${binary.binaryName} add-sender <id>`,
        }),
      );
      return;
  }
}

function isNonEmptySecret(value: unknown): boolean {
  if (typeof value === "string") return value.length > 0;
  if (isSecretRef(value)) return true;
  return false;
}

async function _pickBackend(ctx: WizardCtx, binary: BinaryConfig): Promise<BackendChoice> {
  while (true) {
    const avail: BackendAvailability = await detectBackends();
    const options: { value: string; label: string; hint?: string }[] = [];
    if (avail.keychain.available) {
      options.push({ value: BACKEND_KEYCHAIN, label: "macOS Keychain" });
    }
    if (avail.op.state === "ready") {
      options.push({
        value: BACKEND_OP,
        label: say("cli.setup.passwordCliSignedInAs", {
          signedInAs: avail.op.signedInAs,
          passwordManager: "1Password",
        }),
      });
    } else if (avail.op.state === "needs-signin") {
      options.push({
        value: BACKEND_OP_SIGNIN,
        label: say("cli.setup.passwordCliSignInFirst", { passwordManager: "1Password" }),
      });
    } else {
      log.info(
        say("cli.setup.passwordBackendNotOffered", {
          value1: describeOpState(avail.op),
          passwordManager: "1Password",
        }),
      );
    }
    options.push({
      value: BACKEND_PLAIN,
      label: say("cli.setup.plainConfigYaml", { configFile: "config.yaml" }),
      hint: say("cli.setup.storedUnencryptedOnDiskMode", { permissions: "600" }),
    });

    // op-signin is never the default: a bare Enter must not spawn an
    // interactive `op signin` on headless installs.
    const initialValue = avail.keychain.available
      ? BACKEND_KEYCHAIN
      : avail.op.state === "ready"
        ? BACKEND_OP
        : BACKEND_PLAIN;

    const picked = await select({
      message: say("cli.setup.whereToStoreSecrets"),
      options,
      initialValue,
    });
    handleCancel(picked, ctx, binary);

    if (picked === BACKEND_PLAIN) return "plain";
    if (picked === BACKEND_KEYCHAIN) return "keychain";
    if (picked === BACKEND_OP) return "op";
    if (picked === BACKEND_OP_SIGNIN) {
      if (avail.op.state !== "needs-signin") {
        continue; // state changed underneath; re-detect
      }
      const opPath = avail.op.absolutePath;
      log.info(say("cli.setup.runningOpSigninCompleteThePrompt", { signInCommand: "op signin" }));
      const ok = await runOpSignin(opPath);
      if (!ok) {
        log.error(
          say("cli.setup.opSigninDidNotCompleteSuccessfully", { signInCommand: "op signin" }),
        );
        continue;
      }
      const reDetected = await detectBackends();
      if (reDetected.op.state === "ready") {
        return "op";
      }
      log.info(
        say("cli.setup.passwordStillUnavailablePickAnotherBackend", {
          value1: describeOpState(reDetected.op),
          passwordManager: "1Password",
        }),
      );
      continue;
    }
    // Unreachable but keeps TS happy.
    return "plain";
  }
}

const OP_DESKTOP_APP_HINT_RE = /desktop app|update the 1Password app|1password\.app/i;
const OP_LOCKED_HINT_RE = /biometric|touch id|locked/i;

function describeOpState(state: OpState): string {
  if (state.state === "ready") return say("cli.setup.signedInAs", { signedInAs: state.signedInAs });
  if (state.state === "needs-signin") return say("cli.setup.needsSignIn");
  if (state.reason === "not-on-path") return say("cli.setup.notInstalled");
  if (state.reason === "no-account") return say("cli.setup.noAccountConfigured");
  const detail = state.detail ?? say("cli.setup.unknown");
  if (OP_DESKTOP_APP_HINT_RE.test(detail)) {
    return say("cli.setup.passwordDesktopAppIntegrationUnavailableQuit", {
      passwordManager: "1Password",
    });
  }
  if (OP_LOCKED_HINT_RE.test(detail)) {
    return say("cli.setup.passwordIsLockedUnlockTheDesktop", { passwordManager: "1Password" });
  }
  return say("cli.setup.opCliError", { detail: detail });
}

// ============================================================================
// SECRET INTAKE + WRITE
// ============================================================================

type CollectArgs = {
  field: SecretFieldPath;
  label: string;
  required: boolean;
  prevValue: unknown;
  backend: BackendChoice;
  chosenVaultRef: { current: string | undefined };
  opAbsPathRef: { current: string | undefined };
  keychainPathRef: { current: string | undefined };
};

type CollectResult = {
  yamlValue: string | SecretRef | undefined;
  providedNewValue: boolean;
  chosenVault: string | undefined;
  opAbsPath: string | undefined;
  keychainPath: string | undefined;
  backend: BackendChoice;
};

async function _collectAndWriteSecret(
  ctx: WizardCtx,
  args: CollectArgs,
  binary: BinaryConfig,
): Promise<CollectResult> {
  const { field, label, required, prevValue } = args;
  let backend = args.backend;
  const hasPrev = isNonEmptySecret(prevValue);
  const prevBackend = _detectPrevBackend(prevValue);

  const promptLabel = hasPrev
    ? say("cli.setup.enterToKeepExisting", { label: label })
    : required
      ? label
      : say("cli.setup.enterToSkip", { label: label });

  const entered = await password({
    message: promptLabel,
    validate: () => undefined,
  });
  handleCancel(entered, ctx, binary);
  const raw = typeof entered === "string" ? entered : "";

  if (raw.length === 0) {
    // Enter-keep / Enter-skip branch.
    if (!hasPrev) {
      if (required) {
        cancel(say("cli.setup.isRequired", { label: label }));
        process.exit(1);
      }
      return {
        yamlValue: undefined,
        providedNewValue: false,
        chosenVault: args.chosenVaultRef.current,
        opAbsPath: args.opAbsPathRef.current,
        keychainPath: args.keychainPathRef.current,
        backend,
      };
    }

    // hasPrev === true. If backend matches prev, keep as-is.
    if (prevBackend === "unknown" || prevBackend === backend) {
      return {
        yamlValue: prevValue as string | SecretRef,
        providedNewValue: false,
        chosenVault: args.chosenVaultRef.current,
        opAbsPath: args.opAbsPathRef.current,
        keychainPath: args.keychainPathRef.current,
        backend,
      };
    }

    // D13 cross-backend keep-vs-paste prompt.
    const action = await select({
      message: say("cli.setup.switchBackendFromTo", {
        label: label,
        prevBackend: prevBackend,
        backend: backend,
      }),
      options: [
        { value: "paste", label: say("cli.setup.pasteANewValueToMigrate", { backend: backend }) },
        {
          value: "keep",
          label: say("cli.setup.keepInYamlUnchanged", { prevBackend: prevBackend }),
        },
      ],
      initialValue: "keep",
    });
    handleCancel(action, ctx, binary);
    if (action === "keep") {
      return {
        yamlValue: prevValue as string | SecretRef,
        providedNewValue: false,
        chosenVault: args.chosenVaultRef.current,
        opAbsPath: args.opAbsPathRef.current,
        keychainPath: args.keychainPathRef.current,
        backend,
      };
    }

    // Paste: re-prompt with a required value.
    const second = await password({
      message: say("cli.setup.pasteNewValue", { label: label }),
      validate: (v) =>
        !v ? say("cli.setup.isRequiredWhenMigrating", { label: label }) : undefined,
    });
    handleCancel(second, ctx, binary);
    const cleanedSecond = _processSecretInput(typeof second === "string" ? second : "", field);
    if (cleanedSecond.length === 0) {
      cancel(say("cli.setup.isRequiredWhenMigrating", { label: label }));
      process.exit(1);
    }
    return await _writeToBackend(ctx, args, backend, cleanedSecond, binary);
  }

  // Non-empty input: trim + size cap, then write to chosen backend.
  const cleaned = _processSecretInput(raw, field);
  if (cleaned.length === 0) {
    if (required) {
      cancel(say("cli.setup.isRequired", { label: label }));
      process.exit(1);
    }
    if (hasPrev) {
      return {
        yamlValue: prevValue as string | SecretRef,
        providedNewValue: false,
        chosenVault: args.chosenVaultRef.current,
        opAbsPath: args.opAbsPathRef.current,
        keychainPath: args.keychainPathRef.current,
        backend,
      };
    }
    return {
      yamlValue: undefined,
      providedNewValue: false,
      chosenVault: args.chosenVaultRef.current,
      opAbsPath: args.opAbsPathRef.current,
      keychainPath: args.keychainPathRef.current,
      backend,
    };
  }

  return await _writeToBackend(ctx, args, backend, cleaned, binary);
}

async function _writeToBackend(
  ctx: WizardCtx,
  args: CollectArgs,
  backend: BackendChoice,
  value: string,
  binary: BinaryConfig,
): Promise<CollectResult> {
  const { field } = args;
  if (backend === "plain") {
    return {
      yamlValue: value,
      providedNewValue: true,
      chosenVault: args.chosenVaultRef.current,
      opAbsPath: args.opAbsPathRef.current,
      keychainPath: args.keychainPathRef.current,
      backend,
    };
  }

  if (backend === "op") {
    const opAbsPath = args.opAbsPathRef.current ?? (await discoverOpAbsPath());
    const title = `${binary.keychainPrefix} · ${FIELD_KEYCHAIN_ACCOUNT[field]}`;
    const preExistingVault = await preCheckOpExistence(
      opAbsPath,
      title,
      args.chosenVaultRef.current,
    );
    const preExistedBeforeWizard = preExistingVault !== null;

    let resolvedVault: string;

    if (preExistingVault !== null) {
      // Prompt Update / Keep / Cancel (D10 re-run flow)
      const action = await select({
        message: say("cli.setup.passwordItemAlreadyExistsInVault", {
          title: title,
          preExistingVault: preExistingVault,
          passwordManager: "1Password",
        }),
        options: [
          { value: "update", label: say("cli.setup.updateWithNewValue") },
          { value: "keep", label: say("cli.setup.keepExistingNoWrite") },
          { value: "cancel", label: say("cli.setup.cancelSetup") },
        ],
        initialValue: "update",
      });
      handleCancel(action, ctx, binary);
      if (action === "cancel") {
        // Mirror the SIGINT/clack-cancel paths: print manual cleanup for any
        // items already created earlier in this run.
        _printOrphanCleanup(ctx, binary);
        process.exit(0);
      }
      if (action === "keep") {
        resolvedVault = preExistingVault;
        ctx.createdThisRun.push({
          backend: "op",
          field,
          title,
          vaultName: resolvedVault,
          opAbsPath,
          preExistedBeforeWizard: true,
        });
        return {
          yamlValue: opSecretRef(title, opAbsPath, resolvedVault),
          providedNewValue: false,
          chosenVault: resolvedVault,
          opAbsPath,
          keychainPath: args.keychainPathRef.current,
          backend,
        };
      }
      await opItemUpdate(opAbsPath, title, value, preExistingVault);
      resolvedVault = preExistingVault;
      log.success(
        say("cli.setup.updatedInPasswordVault", {
          field: field,
          resolvedVault: resolvedVault,
          passwordManager: "1Password",
        }),
      );
    } else {
      resolvedVault = await createOpItem(
        ctx,
        opAbsPath,
        title,
        value,
        args.chosenVaultRef.current,
        binary,
      );
      log.success(
        say("cli.setup.storedInPasswordVault", {
          field: field,
          resolvedVault: resolvedVault,
          passwordManager: "1Password",
        }),
      );
    }

    ctx.createdThisRun.push({
      backend: "op",
      field,
      title,
      vaultName: resolvedVault,
      opAbsPath,
      preExistedBeforeWizard,
    });
    return {
      yamlValue: opSecretRef(title, opAbsPath, resolvedVault),
      providedNewValue: true,
      chosenVault: resolvedVault,
      opAbsPath,
      keychainPath: args.keychainPathRef.current,
      backend,
    };
  }

  // keychain
  const keychainPath = args.keychainPathRef.current ?? (await keychainLoginPath());
  const account = FIELD_KEYCHAIN_ACCOUNT[field];
  const preExisted = await keychainItemExists(account, keychainPath).catch(() => false);
  try {
    await keychainItemUpsert(account, value, keychainPath);
  } catch (err) {
    if (err instanceof KeychainUnsafeValueError) {
      cancel(err.message);
      process.exit(1);
    }
    throw err;
  }
  log.success(
    say(
      preExisted
        ? msg("cli.setup.updatedInKeychain", {
            field,
            keychainPrefix: binary.keychainPrefix,
            account,
            keychain: "macOS Keychain",
            configFile: "config.yaml",
            securityCommand: "/usr/bin/security",
          })
        : msg("cli.setup.storedInKeychain", {
            field: field,
            keychainPrefix: binary.keychainPrefix,
            account: account,
            keychain: "macOS Keychain",
            configFile: "config.yaml",
            securityCommand: "/usr/bin/security",
          }),
    ),
  );
  ctx.createdThisRun.push({
    backend: "keychain",
    field,
    title: account,
    keychainPath,
    preExistedBeforeWizard: preExisted,
  });
  return {
    yamlValue: keychainSecretRef(account, keychainPath),
    providedNewValue: true,
    chosenVault: args.chosenVaultRef.current,
    opAbsPath: args.opAbsPathRef.current,
    keychainPath,
    backend,
  };
}

async function preCheckOpExistence(
  opAbsPath: string,
  title: string,
  knownVault: string | undefined,
): Promise<string | null> {
  // Let opItemGet throws propagate. The NOT_AN_ITEM_RE branch inside opItemGet
  // is the only genuine not-exists signal; everything else (timeout, auth
  // failure, non-JSON stdout) is a real error that would otherwise silently
  // become "item doesn't exist" and cause a duplicate item to be created.
  const res = await opItemGet(opAbsPath, title, knownVault);
  return res.exists ? res.vaultName : null;
}

async function createOpItem(
  ctx: WizardCtx,
  opAbsPath: string,
  title: string,
  value: string,
  cachedVault: string | undefined,
  binary: BinaryConfig,
): Promise<string> {
  try {
    const out = await opItemCreate(opAbsPath, title, value, cachedVault);
    return out.vaultName;
  } catch (err) {
    if (err instanceof OpVaultAmbiguousError) {
      const vaults = await opVaultList(opAbsPath);
      const picked = await select({
        message: say("cli.setup.multiplePasswordVaultsPickOne", { passwordManager: "1Password" }),
        options: vaults.map((v) => ({ value: v.name, label: v.name })),
      });
      handleCancel(picked, ctx, binary);
      const chosen = picked as string;
      const retry = await opItemCreate(opAbsPath, title, value, chosen);
      return retry.vaultName;
    }
    throw err;
  }
}

async function discoverOpAbsPath(): Promise<string> {
  // Re-run detection to get the absolute op path; detectBackends caches
  // nothing, but this runs once per new-value secret write at most.
  const avail = await detectBackends();
  if (avail.op.state === "ready") return avail.op.absolutePath;
  if (avail.op.state === "needs-signin") return avail.op.absolutePath;
  throw new Error(
    say("cli.setup.passwordBackendBecameUnavailableMidWizard", {
      value1: describeOpState(avail.op),
      passwordManager: "1Password",
    }),
  );
}

// ============================================================================
// GUARDED CLEANUP (D11)
// ============================================================================

export async function _guardedCleanup(ctx: WizardCtx, binary: BinaryConfig): Promise<void> {
  const orphans = ctx.createdThisRun.filter((e) => !e.preExistedBeforeWizard);
  if (orphans.length === 0) return;

  log.error(
    say("cli.setup.wizardFailedAfterCreatingNewBackend", {
      count: orphans.length,
      formattedCount: cliPhrasebook().format.number(orphans.length, { useGrouping: false }),
      configFile: "config.yaml",
    }),
  );

  const doCleanup = await confirm({
    message: say("cli.setup.deleteTheOrphanItemSNow", {
      count: orphans.length,
      formattedCount: cliPhrasebook().format.number(orphans.length, { useGrouping: false }),
    }),
    initialValue: false,
  });
  if (isCancel(doCleanup) || !doCleanup) {
    _printOrphanCleanup(ctx, binary);
    return;
  }

  for (const o of orphans) {
    try {
      if (o.backend === "op" && o.opAbsPath && o.vaultName) {
        await opItemDelete(o.opAbsPath, o.title, o.vaultName);
        log.info(
          say("cli.setup.deletedPasswordItem", { title: o.title, passwordManager: "1Password" }),
        );
      } else if (o.backend === "keychain" && o.keychainPath) {
        await keychainItemDelete(o.title, o.keychainPath);
        log.info(say("cli.setup.deletedKeychainItem", { title: o.title }));
      }
    } catch (err) {
      log.error(
        say("cli.setup.failedToDeleteItem", {
          backend: o.backend,
          title: o.title,
          value1: err instanceof Error ? err.message : String(err),
        }),
      );
      // Continue best-effort — don't stop on the first failure.
    }
  }
}
