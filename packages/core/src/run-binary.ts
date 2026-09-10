import { messageFromWire } from "@enduragent/i18n/messages";
import { AsyncLocalStorage } from "node:async_hooks";
import { msg, type CoachLanguage, type Message } from "@enduragent/i18n";
import { say, cliPhrasebook, withCliPhrasebook } from "./cli-copy.js";
import { createNpmCoachLanguage } from "./language-preference.js";
import { serializeError } from "./logging/serialize-error.js";
import { parseArgs } from "node:util";
import { createInterface as createReadlineInterface } from "node:readline";
import { writeSync } from "node:fs";
import type { Sport } from "./sport.js";
import { type BinaryConfig, binaryEnvVar } from "./binary.js";
import type { Memory } from "./memory/store.js";
import { CONFIG_DIR, envInt, readConfigYaml, type Config } from "./config.js";
import { isKeylessProvider } from "./runtime-config.js";
import type { AthleteDataReader, PlatformCalendarMutations } from "./athlete-data.js";
import type { ReferenceRuntime } from "./reference/runtime.js";
import { appendUsageLine } from "./usage-ledger.js";
import {
  addSender,
  removeSender,
  listSenders,
  loadAllowedSenders,
  ensureDataDirSecure,
} from "./channels/allowed-senders.js";
import { classifyAgentError } from "./agent/error-classify.js";
import { warnOrphanSections } from "./memory/orphan-sections.js";
import { getEffectiveSections } from "./sport.js";
import { formatConfirmOutcome, type ConfirmationGate } from "./agent/confirmation-gate.js";

// Shared error classifier output as the CLI's athlete-facing reply, so the CLI
// and the Telegram channel speak the same error vocabulary and never dump a raw
// error object in the reply position.
export function formatCliReply(err: unknown): string {
  return say(classifyAgentError(err, cliPhrasebook().format).athleteMessage);
}

export interface PreparedCoachComposition {
  athleteData?: AthleteDataReader;
  calendarMutations?: PlatformCalendarMutations;
  reference?: ReferenceRuntime;
  close?: () => Promise<void>;
}

export interface RunBinaryHooks {
  prepare?: (input: { config: Config; sport: Sport }) => Promise<PreparedCoachComposition>;
  /** Called once per process at startup, after Memory exists, before any chat handler is reachable. */
  onStartup?: (memory: Memory) => void | Promise<void>;
}

function usage(binary: BinaryConfig): string {
  return say("cli.startup.usageCommandCommandsSetupInteractiveWizard", {
    binaryName: binary.binaryName,
    telegram: "Telegram",
    setup: "setup",
    version: "version",
    addSender: "add-sender <userId>",
    removeSender: "remove-sender <userId>",
    listSenders: "list-senders",
    help: "--help",
  });
}

function parseCommand(binary: BinaryConfig): { command: string | null; positionals: string[] } {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { help: { type: "boolean" } },
    strict: false,
  });
  if (values.help) {
    console.log(usage(binary));
    process.exit(0);
  }
  return { command: positionals[0] ?? null, positionals };
}

// Readline-based confirmation for startup capture: renders a multi-line prompt
// to make the bot username visually prominent, parses with decline-on-ambiguous
// semantics, declines cleanly on SIGINT, and times out after
// <BINARY>_CAPTURE_CONFIRM_TIMEOUT_MS (default 5 min).

interface MakeReadlineConfirmOpts {
  timeoutMs: number;
  /** Inject for tests. Defaults to node:readline createInterface. */
  createInterface?: (opts: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream }) => {
    question(prompt: string, cb: (answer: string) => void): void;
    on(event: "SIGINT", cb: () => void): unknown;
    close(): void;
  };
  /** Inject for tests. */
  log?: (line: string) => void;
}

export function _parseConfirmAnswer(input: string): boolean {
  const trimmed = input.trim().toLowerCase();
  // Anything except an explicit y/yes (including bare Enter) → decline, no re-prompt.
  return trimmed === "y" || trimmed === "yes";
}

export async function _promptProposalConfirm(
  rl: { question(prompt: string, cb: (answer: string) => void): void },
  agent: { confirmations: Pick<ConfirmationGate, "peek" | "confirm" | "cancel"> },
): Promise<void> {
  const proposal = agent.confirmations.peek("cli", cliPhrasebook());
  if (proposal === undefined) return;
  await new Promise<void>((resolve) => {
    rl.question(
      say("cli.startup.confirmYN", { summary: proposal.summary, answers: "y/N" }),
      AsyncLocalStorage.bind((answer: string) => {
        void (async () => {
          if (!_parseConfirmAnswer(answer)) {
            agent.confirmations.cancel("cli", proposal.nonce);
            console.log(say("cli.startup.canceled"));
            resolve();
            return;
          }
          const outcome = await agent.confirmations.confirm("cli", proposal.nonce, cliPhrasebook());
          console.log(say(formatConfirmOutcome(outcome)));
          resolve();
        })();
      }),
    );
  });
}

export function makeReadlineConfirm(
  opts: MakeReadlineConfirmOpts,
): (info: {
  capturedId: string;
  senderUsername: string | undefined;
  senderFirstName: string | undefined;
  botUsername: string;
  binaryName: string;
}) => Promise<boolean> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const create = opts.createInterface ?? createReadlineInterface;

  return async (info) => {
    log("");
    log("==========================================================");
    log(say("cli.startup.capturedOperatorIdFor", { botUsername: info.botUsername }));
    log("==========================================================");
    log(say("cli.startup.userId", { capturedId: info.capturedId }));
    log(say("cli.startup.telegram", { value1: info.senderUsername ?? "—", telegram: "Telegram" }));
    log(say("cli.startup.displayName", { value1: info.senderFirstName ?? "—" }));
    log("==========================================================");
    log("");

    const rl = create({ input: process.stdin, output: process.stdout });

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        try {
          rl.close();
        } catch {
          /* ignore */
        }
        resolve(value);
      };

      const timer = setTimeout(() => finish(false), opts.timeoutMs);

      rl.on("SIGINT", () => {
        clearTimeout(timer);
        finish(false);
      });

      rl.question(
        say("cli.startup.saveThisAsThePrimaryOperator", { answers: "y/N" }),
        (answer: string) => {
          clearTimeout(timer);
          finish(_parseConfirmAnswer(answer));
        },
      );
    });
  };
}

async function runStartupCapture(
  botToken: string,
  binary: BinaryConfig,
  dataDir: string,
): Promise<void> {
  console.log(
    say("cli.startup.hasNoAllowedSendersConfigured", { displayName: binary.displayName }) +
      say("cli.startup.sendYourBotThePairingCode", {
        telegram: "Telegram",
        seconds: cliPhrasebook().format.number(60, { useGrouping: false }),
      }) +
      say("cli.startup.pressCtrlCToSkipYou", {
        binaryName: binary.binaryName,
        addSenderCommand: `${binary.binaryName} add-sender <id>`,
        interruptKey: "Ctrl+C",
      }),
  );
  const { captureAndPersistOperator } = await import("./channels/operator-capture.js");
  const captureTimeoutMs =
    envInt(binaryEnvVar(binary.binaryName, "SETUP_CAPTURE_TIMEOUT_MS")) ?? 60_000;
  const confirmTimeoutMs =
    envInt(binaryEnvVar(binary.binaryName, "CAPTURE_CONFIRM_TIMEOUT_MS")) ?? 300_000;
  const result = await captureAndPersistOperator({
    botToken,
    binary,
    dataDir,
    phrasebook: cliPhrasebook(),
    timeoutMs: captureTimeoutMs,
    confirm: makeReadlineConfirm({ timeoutMs: confirmTimeoutMs }),
  });
  if (result.status === "captured") {
    console.log(
      say("cli.startup.operatorRegisteredIdStartingBot", { capturedId: String(result.capturedId) }),
    );
  } else {
    console.log(
      say("cli.startup.operatorNotCapturedBotWillStart", {
        status: result.status,
        binaryName: binary.binaryName,
        addSenderCommand: `${binary.binaryName} add-sender <id>`,
      }),
    );
  }
}

const MUTATORS: Record<"add-sender" | "remove-sender", { fn: (dir: string, id: string) => void }> =
  {
    "add-sender": { fn: addSender },
    "remove-sender": { fn: removeSender },
  };

async function runAllowlistCommand(
  command: "add-sender" | "remove-sender" | "list-senders",
  positionals: string[],
  binary: BinaryConfig,
): Promise<void> {
  const reportError = (err: unknown): never => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(say("cli.startup.error", { msg: msg }));
    return process.exit(1);
  };

  if (command === "add-sender" || command === "remove-sender") {
    const { fn } = MUTATORS[command];
    const id = positionals[1];
    if (!id) {
      console.error(
        say("cli.startup.usageUserid", { binaryName: binary.binaryName, command: command }),
      );
      process.exit(1);
    }
    try {
      fn(CONFIG_DIR, id);
    } catch (err) {
      reportError(err);
    }
    console.log(
      say(
        command === "add-sender"
          ? msg("cli.startup.senderAdded", { id })
          : msg("cli.startup.senderRemoved", { id }),
      ),
    );
    process.exit(0);
  }

  let result: Awaited<ReturnType<typeof listSenders>>;
  try {
    result = await listSenders(CONFIG_DIR);
  } catch (err) {
    return reportError(err);
  }
  console.log(say("cli.startup.policy", { dmPolicy: result.senders.dmPolicy }));
  console.log(
    say("cli.startup.primaryOperator", { value1: result.senders.primaryOperator ?? "—" }),
  );
  console.log(
    say("cli.startup.allowedSenders", {
      count: result.senders.allowFrom.length,
      formattedCount: cliPhrasebook().format.number(result.senders.allowFrom.length, {
        useGrouping: false,
      }),
    }),
  );
  for (const id of result.senders.allowFrom) {
    const added = result.senders.addedAt[id];
    console.log(
      say("cli.startup.text", {
        id: id,
        value1: added ? say("cli.startup.senderAddedAt", { added }) : "",
      }),
    );
  }
  console.log(
    say("cli.startup.sessionCandidates", {
      count: result.sessionCandidates.length,
      formattedCount: cliPhrasebook().format.number(result.sessionCandidates.length, {
        useGrouping: false,
      }),
    }),
  );
  for (const c of result.sessionCandidates) {
    console.log(
      say("cli.startup.linesLastModified", {
        chatId: c.chatId,
        count: c.lineCount,
        formattedCount: cliPhrasebook().format.number(c.lineCount, { useGrouping: false }),
        lastModified: c.lastModified,
      }),
    );
  }
  process.exit(0);
}

// Upper bound on how long a graceful shutdown waits for in-flight turns to
// drain before forcing exit. A hung turn (wedged LLM call, stuck network) must
// never wedge process exit, so the drain races a timeout.
const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;

interface BotShutdownDeps {
  stop: () => Promise<void>;
  drainPending?: () => Promise<void>;
  captureDrain?: () => { wait(): Promise<void> };
  dataDir: string;
  markCleanShutdown: (opts: { dataDir: string }) => void;
  exit: (code: number) => void;
  drainTimeoutMs?: number;
  log?: (line: string) => void;
  stopTimer?: () => void | Promise<void>;
  closeReference?: () => void | Promise<void>;
  closePrepared?: () => Promise<void>;
}

// Builds the SIGTERM/SIGINT handler that brings the bot down cleanly: halt new
// updates, let in-flight turns finish (bounded), clear the run breadcrumb so the
// next boot is not mislabeled unclean, then exit. The returned closure owns a
// re-entry latch so a second signal (operator mashing Ctrl+C) cannot run the
// teardown twice. The body is wrapped so any throw still reaches the exit call —
// a stuck shutdown must never leave the process hanging.
export function makeBotShutdown(deps: BotShutdownDeps): () => Promise<void> {
  // Default to a synchronous fd-1 write, not console.log: when stdout is a pipe
  // (Docker/systemd) console.log is async-buffered, and the immediate
  // process.exit(0) below drops the buffered banner. writeSync cannot be lost.
  const log = deps.log ?? ((line: string) => writeSync(1, `${line}\n`));
  const drainTimeoutMs = deps.drainTimeoutMs ?? SHUTDOWN_DRAIN_TIMEOUT_MS;
  let shuttingDown = false;
  return AsyncLocalStorage.bind(async function shutdownBot(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log(say("cli.startup.shuttingDownFinishingInFlightMessages"));
    try {
      await deps.stop();
      const snapshot = deps.captureDrain?.();
      const drain = snapshot === undefined ? deps.drainPending : () => snapshot.wait();
      if (drain === undefined)
        throw new TypeError(
          say("cli.startup.telegramShutdownDrainIsUnavailable", { telegram: "Telegram" }),
        );
      await Promise.race([
        drain(),
        new Promise<void>((resolve) => setTimeout(resolve, drainTimeoutMs).unref?.()),
      ]);
      await deps.stopTimer?.();
      await deps.closeReference?.();
      await deps.closePrepared?.();
      deps.markCleanShutdown({ dataDir: deps.dataDir });
    } catch (err) {
      console.error(
        say("cli.startup.shutdownEncounteredAnError", {
          value1: JSON.stringify(serializeError(err)),
        }),
      );
    } finally {
      deps.exit(0);
    }
  });
}

export async function runStartupHook(
  memory: Memory,
  hook?: RunBinaryHooks["onStartup"],
): Promise<void> {
  if (!hook) return;
  try {
    await hook(memory);
  } catch (err) {
    console.warn(
      say("cli.startup.startupHookFailedContinuingWithBinary", {
        value1: JSON.stringify(serializeError(err)),
      }),
    );
  }
}

export async function runBinary(
  sport: Sport,
  binary: BinaryConfig,
  hooks: RunBinaryHooks = {},
): Promise<void> {
  const previous = readConfigYaml();
  const dataDir = typeof previous.data_dir === "string" ? previous.data_dir : CONFIG_DIR;
  const language = createNpmCoachLanguage(dataDir);
  const phrasebook = await language.phrasebookFor({});
  await withCliPhrasebook(phrasebook, () => runBinaryWithLanguage(sport, binary, hooks, language));
}

async function runBinaryWithLanguage(
  sport: Sport,
  binary: BinaryConfig,
  hooks: RunBinaryHooks,
  coachLanguage: CoachLanguage,
): Promise<void> {
  const { command, positionals } = parseCommand(binary);

  if (command === "setup") {
    const { runSetup } = await import("./setup.js");
    await runSetup(binary);
    // pi-ai's OAuth callback server may leave socket/timer handles alive;
    // exit explicitly so the wizard returns the shell.
    process.exit(0);
  }

  if (command === "version") {
    const { getCurrentVersion } = await import("./updater.js");
    console.log(`${binary.binaryName} v${getCurrentVersion(binary.binaryName)}`);
    return;
  }

  if (command === "add-sender" || command === "remove-sender" || command === "list-senders") {
    await runAllowlistCommand(command, positionals, binary);
    return;
  }

  if (command) {
    console.error(say("cli.startup.unknownCommand", { command: command }));
    console.log(usage(binary));
    process.exit(1);
  }

  const { loadConfig, resolveConfigSecrets } = await import("./config.js");
  const { SecretResolutionError } = await import("./secrets/types.js");

  let config;
  try {
    config = await resolveConfigSecrets(loadConfig());
  } catch (err) {
    if (err instanceof SecretResolutionError) {
      console.error(say("cli.startup.configError", { message: err.message }));
      process.exit(1);
    }
    throw err;
  }

  ensureDataDirSecure(config.dataDir);

  const { installCrashHandlers, logBootLine } = await import("./process-guard.js");
  installCrashHandlers({ dataDir: config.dataDir });
  logBootLine({ dataDir: config.dataDir });

  if (!isKeylessProvider(config.llm.provider) && !config.llm.apiKey) {
    console.error(
      say("cli.startup.noLlmApiKeyFoundRun", {
        binaryName: binary.binaryName,
        setupCommand: `${binary.binaryName} setup`,
        apiKeyVariable: "LLM_API_KEY",
        anthropicVariable: "ANTHROPIC_API_KEY",
        openaiVariable: "OPENAI_API_KEY",
        googleVariable: "GOOGLE_GENERATIVE_AI_API_KEY",
        deepseekVariable: "DEEPSEEK_API_KEY",
        alibabaVariable: "ALIBABA_API_KEY",
        minimaxVariable: "MINIMAX_API_KEY",
        moonshotVariable: "MOONSHOT_API_KEY",
        zaiVariable: "ZAI_API_KEY",
        openrouterVariable: "OPENROUTER_API_KEY",
      }),
    );
    process.exit(1);
  }

  if (config.llm.provider === "codex-agent") {
    const { runCodexAgentStartupGate } = await import("./codex-agent-startup.js");
    await runCodexAgentStartupGate({ settings: config.llm.codexAgent, model: config.llm.model });
  }

  const bootStart = Date.now();
  const prepared = (await hooks.prepare?.({ config, sport })) ?? {};
  const { createCoachEngine } = await import("./agent/coach-engine.js");
  const engine = createCoachEngine(sport, config, {
    language: coachLanguage,
    athleteData: prepared.athleteData,
    calendarMutations: prepared.calendarMutations,
  });

  // Init order: Memory (above) → startup hook → Reference bootstrap → Telegram.
  // Reference's internal init sequence is pinned inside `bootstrapReference`
  // per ADR-0011 (two-phase scheduler — no timer until first runSync resolves).
  await runStartupHook(engine.getMemory(), hooks.onStartup);

  // After the startup hook so the legacy-section migration has already renamed
  // profile/equipment/health → sport-prefixed names; scanning earlier would
  // warn on names the migration removes on the very next boot statement.
  warnOrphanSections(engine.getMemory(), getEffectiveSections(sport));

  const { bootstrapReference } = await import("./reference/runtime.js");
  console.log(
    say("cli.startup.syncingTrainingDataFromIntervalsIcu", { platform: "intervals.icu" }),
  );
  const reference =
    prepared.reference ??
    (await bootstrapReference({
      dataDir: config.dataDir,
      intervals: config.intervals,
      readCalendarTimeZone: () => config.session.timezone,
      sport,
    }));
  let runtimeClosed = false;
  const closeRuntime = AsyncLocalStorage.bind(async (): Promise<void> => {
    if (runtimeClosed) return;
    runtimeClosed = true;
    reference.scheduler.stop();
    try {
      await Promise.race([
        engine.settle(),
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_TIMEOUT_MS).unref?.()),
      ]);
    } catch (err) {
      console.error(say("cli.startup.memoryFlushDidNotFinishBefore"), err);
    }
    await prepared.close?.();
  });

  appendUsageLine(config.dataDir, {
    ts: Date.now(),
    kind: "boot",
    provider: config.llm.provider,
    model: config.llm.model,
    durationMs: Date.now() - bootStart,
  });

  if (config.telegram.botToken) {
    // Interactive startup capture: when no allowlist is set up yet AND we have
    // a TTY AND a token, run the same one-message claim flow the setup wizard
    // uses. Non-TTY paths (Docker, systemd, fly.io) skip the prompt and fall
    // back to pairing-mode + pairing-challenge CLI.
    const allowed = loadAllowedSenders(config.dataDir);
    const needsCapture =
      allowed.dmPolicy === "pairing" &&
      allowed.allowFrom.length === 0 &&
      Boolean(config.telegram.botToken) &&
      process.stdin.isTTY === true;
    if (needsCapture) {
      await runStartupCapture(config.telegram.botToken, binary, config.dataDir);
    }

    const { createTelegramBot } = await import("./channels/telegram.js");
    const { createNpmTelegramHost, notifyNpmTelegramUpdate } =
      await import("./channels/npm-telegram-host.js");
    const { startNpmTelegramPolling } = await import("./channels/npm-telegram-polling.js");
    const telegram = createTelegramBot({
      token: config.telegram.botToken,
      webhookPolicy: "delete-before-polling",
      engine,
      host: createNpmTelegramHost({
        language: coachLanguage,
        binary,
        confirmations: engine.confirmations,
        dataDir: config.dataDir,
        reference: reference.services,
      }),
      dataDir: config.dataDir,
    });
    console.log(
      say("cli.startup.telegramModeIsRunningOpenTelegram", {
        displayName: binary.displayName,
        telegram: "Telegram",
        interruptKey: "Ctrl+C",
      }),
    );
    // When a signal lands in the startup / first-long-poll window, our own
    // bot.stop() aborts the in-flight getUpdates; grammy surfaces that as a
    // rejected start-promise (abort / 409 Conflict). That rejection is the
    // EXPECTED consequence of a graceful shutdown, not a crash — suppress it so
    // it cannot race reportFatal()'s markUnclean+exit(1) ahead of the shutdown
    // handler's clean exit(0). A genuine startup failure (bad token, pre-signal
    // crash) leaves shuttingDown false and still fatals.
    let shuttingDown = false;
    // Normal startup does NOT drop pending updates: a message sent while the bot
    // was down must still be delivered on restart. The durable update-offset
    // guard inside createTelegramBot dedupes anything the previous run already
    // handled. (Operator-capture startup keeps drop_pending_updates on purpose.)
    startNpmTelegramPolling({
      start: () => telegram.start(),
      isShutdownLatched: () => shuttingDown,
      reportFatal: async (error) => {
        const { reportFatal } = await import("./process-guard.js");
        reportFatal(error, { dataDir: config.dataDir });
      },
    });

    // Register graceful-shutdown signal handlers only on the bot-run path —
    // after bot.start — so they never fire during the operator-capture readline
    // above, which owns its own SIGINT on a different emitter.
    const { markCleanShutdown } = await import("./process-guard.js");
    const shutdownBot = makeBotShutdown({
      stop: () => telegram.stop(),
      captureDrain: () => telegram.captureDrain(),
      closePrepared: closeRuntime,
      dataDir: config.dataDir,
      markCleanShutdown,
      exit: (code) => process.exit(code),
    });
    const onSignal = function onSignal(): void {
      shuttingDown = true;
      void shutdownBot();
    };
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);

    if (!process.env[binaryEnvVar(binary.binaryName, "NO_UPDATE_CHECK")]) {
      notifyNpmTelegramUpdate(telegram, config.dataDir, binary, coachLanguage).catch(() => {});
      // A long-running deployment would otherwise never learn about a new
      // release until it restarts; notifyUpdate dedupes per version so the
      // re-check broadcasts at most once per release. unref() so the timer
      // never holds the process open.
      const DAY_MS = 24 * 60 * 60 * 1000;
      setInterval(
        () => void notifyNpmTelegramUpdate(telegram, config.dataDir, binary, coachLanguage),
        DAY_MS,
      ).unref?.();
    }
  } else {
    console.log(say("cli.startup.cliModeTypeYourMessage", { displayName: binary.displayName }));
    const { createInterface } = await import("node:readline");
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "> ",
    });

    rl.on("close", () => {
      void closeRuntime().finally(() => process.exit(0));
    });

    rl.prompt();
    rl.on(
      "line",
      AsyncLocalStorage.bind(async (line: string) => {
        const input = line.trim();
        if (!input) {
          rl.prompt();
          return;
        }
        if (input === "/quit" || input === "/exit") {
          rl.close();
          return;
        }

        try {
          const { language, source: languageSource } = await coachLanguage.resolveFor({
            athleteText: input,
          });
          let fixedMessage: Promise<Message | undefined> | undefined;
          const response = await engine.chat(
            {
              chatId: "cli",
              message: input,
              turn: { language, languageSource },
            },
            (event) => {
              if (event.type === "final-text") {
                fixedMessage =
                  event.message === undefined ? undefined : messageFromWire(event.message);
              }
            },
          );
          const message = await fixedMessage;
          console.log("\n" + (message === undefined ? response.text : say(message)) + "\n");
          await _promptProposalConfirm(rl, engine);
        } catch (err) {
          // Full detail (stack, provider payload) → stderr; a friendly classified
          // reply → stdout in the reply position. The raw err never lands as the
          // coach reply.
          console.error(say("cli.startup.errorDetail"), err);
          console.log("\n" + formatCliReply(err) + "\n");
        }
        rl.prompt();
      }),
    );
  }
}
