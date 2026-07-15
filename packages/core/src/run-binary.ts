import { parseArgs } from "node:util";
import { createInterface as createReadlineInterface } from "node:readline";
import { writeSync } from "node:fs";
import type { Sport } from "./sport.js";
import type { BinaryConfig } from "./binary.js";
import type { Memory } from "./memory/store.js";
import { CONFIG_DIR, envInt } from "./config.js";
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
import { getEffectiveSections } from "./memory/effective-sections.js";
import {
  formatConfirmOutcome,
  type ConfirmationGate,
} from "./agent/confirmation-gate.js";

// Shared error classifier output as the CLI's athlete-facing reply, so the CLI
// and the Telegram channel speak the same error vocabulary and never dump a raw
// error object in the reply position.
export function formatCliReply(err: unknown): string {
  return classifyAgentError(err).athleteMessage;
}

export interface RunBinaryHooks {
  /** Called once per process at startup, after Memory exists, before any chat handler is reachable. */
  onStartup?: (memory: Memory) => void | Promise<void>;
}

function usage(binary: BinaryConfig): string {
  return `Usage: ${binary.binaryName} [command]

Commands:
  setup                     Interactive wizard to create the config file
  version                   Show current version
  add-sender <userId>       Authorize a Telegram user-id to interact with the bot
  remove-sender <userId>    Revoke a previously-authorized Telegram user-id
  list-senders              Show current allowlist + known session candidates
  (none)                    Start the coaching agent (Telegram or CLI mode)

Options:
  --help                    Show this help message`;
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
// CYCLING_COACH_CAPTURE_CONFIRM_TIMEOUT_MS (default 5 min).

interface MakeReadlineConfirmOpts {
  timeoutMs: number;
  /** Inject for tests. Defaults to node:readline createInterface. */
  createInterface?: (opts: {
    input: NodeJS.ReadableStream;
    output: NodeJS.WritableStream;
  }) => {
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
  const proposal = agent.confirmations.peek("cli");
  if (proposal === undefined) return;
  await new Promise<void>((resolve) => {
    rl.question(`Confirm: ${proposal.summary}? [y/N]: `, (answer) => {
      void (async () => {
        if (!_parseConfirmAnswer(answer)) {
          agent.confirmations.cancel("cli", proposal.nonce);
          console.log("Canceled.");
          resolve();
          return;
        }
        const outcome = await agent.confirmations.confirm("cli", proposal.nonce);
        console.log(formatConfirmOutcome(outcome));
        resolve();
      })();
    });
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
    log(`  Captured operator ID for @${info.botUsername}`);
    log("==========================================================");
    log(`  User ID:      ${info.capturedId}`);
    log(`  Telegram:     @${info.senderUsername ?? "—"}`);
    log(`  Display name: ${info.senderFirstName ?? "—"}`);
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

      rl.question("Save this as the primary operator? [y/N]: ", (answer: string) => {
        clearTimeout(timer);
        finish(_parseConfirmAnswer(answer));
      });
    });
  };
}

async function runStartupCapture(
  botToken: string,
  binary: BinaryConfig,
  dataDir: string,
): Promise<void> {
  console.log(
    `\n${binary.displayName} has no allowed senders configured.\n` +
      `Send your bot the pairing code shown below, from your own Telegram account, within 60 seconds to claim ownership.\n` +
      `(Press Ctrl+C to skip — you can run \`${binary.binaryName} add-sender <id>\` later.)\n`,
  );
  const { captureAndPersistOperator } = await import("./channels/operator-capture.js");
  const captureTimeoutMs = envInt("CYCLING_COACH_SETUP_CAPTURE_TIMEOUT_MS") ?? 60_000;
  const confirmTimeoutMs = envInt("CYCLING_COACH_CAPTURE_CONFIRM_TIMEOUT_MS") ?? 300_000;
  const result = await captureAndPersistOperator({
    botToken,
    binary,
    dataDir,
    timeoutMs: captureTimeoutMs,
    confirm: makeReadlineConfirm({ timeoutMs: confirmTimeoutMs }),
  });
  if (result.status === "captured") {
    console.log(`Operator registered (id: ${result.capturedId}). Starting bot...`);
  } else {
    console.log(
      `Operator not captured (${result.status}). Bot will start in pairing mode — DM it to receive your user-ID, then run \`${binary.binaryName} add-sender <id>\`.`,
    );
  }
}

const MUTATORS: Record<
  "add-sender" | "remove-sender",
  { fn: (dir: string, id: string) => void; verb: string }
> = {
  "add-sender": { fn: addSender, verb: "Added" },
  "remove-sender": { fn: removeSender, verb: "Removed" },
};

async function runAllowlistCommand(
  command: "add-sender" | "remove-sender" | "list-senders",
  positionals: string[],
  binary: BinaryConfig,
): Promise<void> {
  const reportError = (err: unknown): never => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    return process.exit(1);
  };

  if (command === "add-sender" || command === "remove-sender") {
    const { fn, verb } = MUTATORS[command];
    const id = positionals[1];
    if (!id) {
      console.error(`Usage: ${binary.binaryName} ${command} <userId>`);
      process.exit(1);
    }
    try {
      fn(CONFIG_DIR, id);
    } catch (err) {
      reportError(err);
    }
    console.log(`${verb} sender ${id}.`);
    process.exit(0);
  }

  let result: Awaited<ReturnType<typeof listSenders>>;
  try {
    result = await listSenders(CONFIG_DIR);
  } catch (err) {
    return reportError(err);
  }
  console.log(`Policy: ${result.senders.dmPolicy}`);
  console.log(`Primary operator: ${result.senders.primaryOperator ?? "—"}`);
  console.log(`Allowed senders (${result.senders.allowFrom.length}):`);
  for (const id of result.senders.allowFrom) {
    const added = result.senders.addedAt[id];
    console.log(`  ${id}${added ? `  added ${added}` : ""}`);
  }
  console.log(`Session candidates (${result.sessionCandidates.length}):`);
  for (const c of result.sessionCandidates) {
    console.log(`  ${c.chatId}  ${c.lineCount} lines  last modified ${c.lastModified}`);
  }
  process.exit(0);
}

// Upper bound on how long a graceful shutdown waits for in-flight turns to
// drain before forcing exit. A hung turn (wedged LLM call, stuck network) must
// never wedge process exit, so the drain races a timeout.
const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;

interface BotShutdownDeps {
  stop: () => Promise<void>;
  drainPending: () => Promise<void>;
  dataDir: string;
  markCleanShutdown: (opts: { dataDir: string }) => void;
  exit: (code: number) => void;
  drainTimeoutMs?: number;
  log?: (line: string) => void;
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
  return async function shutdownBot(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log("\nShutting down — finishing in-flight messages...");
    try {
      await deps.stop();
      await Promise.race([
        deps.drainPending(),
        new Promise<void>((resolve) => setTimeout(resolve, drainTimeoutMs).unref?.()),
      ]);
      deps.markCleanShutdown({ dataDir: deps.dataDir });
    } catch (err) {
      console.error(
        `Shutdown encountered an error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      deps.exit(0);
    }
  };
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
      `Startup hook failed: ${err instanceof Error ? err.message : String(err)}. Continuing with binary startup.`,
    );
  }
}

export async function runBinary(
  sport: Sport,
  binary: BinaryConfig,
  hooks: RunBinaryHooks = {},
): Promise<void> {
  const { command, positionals } = parseCommand(binary);

  if (command === "setup") {
    const { runSetup } = await import("./setup.js");
    await runSetup(binary);
    // The OAuth callback server may leave socket or timer handles alive, so
    // exit explicitly after setup returns control to the wizard.
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
    console.error(`Unknown command: ${command}\n`);
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
      console.error(`Config error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  ensureDataDirSecure(config.dataDir);

  const { installCrashHandlers, logBootLine } = await import("./process-guard.js");
  installCrashHandlers({ dataDir: config.dataDir });
  logBootLine({ dataDir: config.dataDir });

  if (config.llm.provider !== "openai-codex" && !config.llm.apiKey) {
    console.error(
      `No LLM API key found. Run \`${binary.binaryName} setup\` to configure, or set LLM_API_KEY. Provider-specific env vars still work: ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, DEEPSEEK_API_KEY, ALIBABA_API_KEY, MINIMAX_API_KEY, MOONSHOT_API_KEY, ZAI_API_KEY, or OPENROUTER_API_KEY.`,
    );
    process.exit(1);
  }

  const bootStart = Date.now();
  const { CoachAgent } = await import("./agent/coach-agent.js");
  const agent = new CoachAgent(sport, config);

  // Init order: Memory (above) → startup hook → Reference bootstrap → Telegram.
  // Reference's internal init sequence is pinned inside `bootstrapReference`
  // per ADR-0011 (two-phase scheduler — no timer until first runSync resolves).
  await runStartupHook(agent.getMemory(), hooks.onStartup);

  // After the startup hook so the legacy-section migration has already renamed
  // profile/equipment/health → sport-prefixed names; scanning earlier would
  // warn on names the migration removes on the very next boot statement.
  warnOrphanSections(agent.getMemory(), getEffectiveSections(sport));

  const { bootstrapReference } = await import("./reference/runtime.js");
  console.log("syncing training data from intervals.icu…");
  const reference = await bootstrapReference({
    dataDir: config.dataDir,
    intervals: config.intervals,
    sport,
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

    const { createTelegramBot, notifyUpdate } = await import("./channels/telegram.js");
    const { bot, drainPending } = createTelegramBot(
      config.telegram.botToken,
      agent,
      binary,
      config.dataDir,
      reference.services,
    );
    console.log(
      `${binary.displayName} (Telegram mode) is running. Open Telegram and message your bot — Ctrl+C to stop.`,
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
    bot.start().catch(async (err) => {
      if (shuttingDown) return;
      const { reportFatal } = await import("./process-guard.js");
      reportFatal(err, { dataDir: config.dataDir });
    });

    // Register graceful-shutdown signal handlers only on the bot-run path —
    // after bot.start — so they never fire during the operator-capture readline
    // above, which owns its own SIGINT on a different emitter.
    const { markCleanShutdown } = await import("./process-guard.js");
    const shutdownBot = makeBotShutdown({
      stop: () => bot.stop(),
      drainPending,
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

    if (!process.env.CYCLING_COACH_NO_UPDATE_CHECK) {
      notifyUpdate(bot, config.dataDir, binary).catch(() => {});
      // A long-running deployment would otherwise never learn about a new
      // release until it restarts; notifyUpdate dedupes per version so the
      // re-check broadcasts at most once per release. unref() so the timer
      // never holds the process open.
      const DAY_MS = 24 * 60 * 60 * 1000;
      setInterval(() => void notifyUpdate(bot, config.dataDir, binary), DAY_MS).unref?.();
    }
  } else {
    console.log(`${binary.displayName} (CLI mode). Type your message:`);
    const { createInterface } = await import("node:readline");
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "> ",
    });

    rl.on("close", () => {
      reference.scheduler.stop();
      process.exit(0);
    });

    rl.prompt();
    rl.on("line", async (line) => {
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
        const response = await agent.chat("cli", input);
        console.log("\n" + response + "\n");
        await _promptProposalConfirm(rl, agent);
      } catch (err) {
        // Full detail (stack, provider payload) → stderr; a friendly classified
        // reply → stdout in the reply position. The raw err never lands as the
        // coach reply.
        console.error("Error detail:", err);
        console.log("\n" + formatCliReply(err) + "\n");
      }
      rl.prompt();
    });
  }
}
