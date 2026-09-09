import { telegramReleaseMessage } from "./telegram-copy.js";
import { languageKeyboard, parseLanguageCallback } from "./telegram-language-menu.js";
import { Bot, GrammyError, InputFile } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import type { CoachEngine } from "@enduragent/coach-contract";
import { describeLanguage, msg, normalizeLocaleHint, type Message } from "@enduragent/i18n";
import { messageFromWire, type Phrasebook } from "@enduragent/i18n/messages";
import {
  registerTelegramCommandMenus,
  registerTelegramChatCommandMenu,
} from "./telegram-command-menu.js";
import { classifyAgentError } from "../agent/error-classify.js";
import { TelegramUpdateOffsetStore } from "./telegram-update-offsets.js";
import { escapeHtmlText } from "./html-escape.js";
import { sendSnapshotOutput } from "../reference/sync/send-snapshot.js";
import { createSubsystemLogger } from "../logging/index.js";
import { truncateUtf16Safe } from "../text-truncate.js";
import { formatConfirmOutcome } from "../agent/confirmation-gate.js";
import {
  TelegramWorkLedger,
  type TelegramWorkLedgerSnapshot,
  type TelegramWorkScope,
} from "./telegram-work-ledger.js";
import type { TelegramHostCapabilities, TelegramInvocationReservation } from "./telegram-host.js";

// Debounce window for coalescing rapid free-form message fragments from one
// chat into a single turn. Each new fragment resets the window; the buffered
// turn fires this long after the LAST fragment.
export const CHAT_COALESCE_MS = 1_500;

// Process-local resend cache bounds. The cache holds full generated answers
// (athlete content) so it is size- and time-bounded and never logged.
const RESEND_TTL_MS = 30 * 60_000;
const RESEND_MAX_ENTRIES = 1000;
// The bare word an athlete types to re-emit the last answer. Shared by the
// matcher and the delivery-failure hint so the two can never drift apart.
const RESEND_KEYWORD = "resend";

// Shown when generation succeeded but Telegram couldn't deliver the answer.
// Used by both the runTurn delivery catch and the resend-dispatch catch so the
// two delivery-failure paths can never drift apart.
const DELIVERY_FAILURE_HINT = msg("telegram.error.delivery", {
  keyword: RESEND_KEYWORD,
  service: "Telegram",
});

// Neutral apology for synchronous handler/ack failures surfaced through
// bot.catch — those are Telegram transport errors, not LLM/tool errors, so they
// must not be dressed in provider-specific vocabulary.
const GENERIC_TRANSPORT_APOLOGY = msg("telegram.error.transport");

// Shown when /update can't durably record the self-update marker. Without that
// marker a restart could re-trigger /update in a loop, so we decline to stop and
// tell the athlete to retry rather than risk the loop.
const SELF_UPDATE_MARKER_FAILURE = msg("telegram.update.prepareFailed", { command: "/update" });

// How often to re-emit Telegram's native "typing" indicator while a turn is in
// flight. Telegram auto-clears the indicator ~5s after each sendChatAction, so we
// refresh faster than that to keep it continuous without flicker.
export const TYPING_HEARTBEAT_MS = 4_000;

// Pulse Telegram's native "typing" indicator on an interval so a long turn never
// leaves the athlete staring at silence (a turn can now run up to ~10 min). Fires
// once immediately, then every intervalMs. Each pulse is best-effort: a rejected
// (or throwing) pulse is routed to onError and can never affect the turn or its
// reply. The interval is unref'd so a pending pulse cannot hold the process open
// during shutdown / an /update drain. The stop result settles with the final pulse.
export function startTypingHeartbeat(
  pulse: () => Promise<unknown>,
  intervalMs: number,
  onError: (err: unknown) => void,
): () => Promise<void> {
  // Skip a beat while the previous pulse is still unsettled: under a Telegram
  // flood a pulse can be parked inside the API retry layer, and firing a fresh
  // one every interval regardless would pile parked pulses up and roughly double
  // request volume against an already-throttled API. The flag is cleared in a
  // finally so a rejected pulse cannot wedge the guard permanently.
  let inFlight: Promise<void> | undefined;
  const beat = () => {
    if (inFlight !== undefined) return;
    const task = Promise.resolve()
      .then(pulse)
      .catch((error) => {
        try {
          onError(error);
        } catch {}
      })
      .then(() => undefined)
      .finally(() => {
        if (inFlight === task) inFlight = undefined;
      });
    inFlight = task;
  };
  beat();
  const timer = setInterval(beat, intervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    return inFlight ?? Promise.resolve();
  };
}

// ============================================================================
// TELEGRAM BOT
// ============================================================================

const buildWelcomeMessage = (updateDescription: string): Message =>
  msg("telegram.welcome", {
    product: "Cycling Coach",
    service: "intervals.icu",
    plan: "/plan",
    workout: "/workout",
    status: "/status",
    review: "/review",
    sync: "/sync",
    version: "/version",
    whatsnew: "/whatsnew",
    update: "/update",
    updateDescription,
  });

const RESET_CAVEAT_NOTE = msg("telegram.session.resetCaveat");

const SNAPSHOT_HELP = msg("telegram.snapshot.help", {
  raw: "/snapshot raw [section]",
  help: "/snapshot help",
  command: "/snapshot",
  rawCommand: "/snapshot raw",
  file: "latest.json",
});

// Module-private factory: every Bot in this module is constructed here, with the
// root ledger wrapper first and authentication as the first functional gate.
// Future maintainers cannot add a functional handler ahead of authentication
// without modifying this function, where the security model is enforced.
function createSecuredBot(opts: {
  token: string;
  access: TelegramHostCapabilities["access"];
  webhookPolicy: TelegramWebhookPolicy;
  ledger: TelegramWorkLedger;
  onPollingSuccess?: () => void;
  onPollingFailure?: () => void;
}): { readonly bot: Bot; readonly prepareStart: () => void } {
  const bot = new Bot(opts.token);
  let suppressImplicitWebhookDeletion = false;

  // Bounded API-level retry restricted to a Telegram 429 carrying a `retry_after`
  // (the one failure class where the original send provably did NOT land).
  // rethrowInternalServerErrors / rethrowHttpErrors disable this plugin's default
  // 5xx and network retries, which would risk a duplicate send on an ambiguous
  // failure whose original request may already have been delivered server-side.
  // Deliberately a separate retry policy from the shared primitive in
  // concurrency/retry.ts: this is a grammY API-transformer seam handling
  // bot-transport 429s, not an LLM/tool retry.
  // The only calls that can block grammY's sequential update loop are the
  // synchronous command acks, so maxDelaySeconds is a small bound: a 429 whose
  // retry_after exceeds it must fail fast rather than freeze every chat. The
  // fire-and-forget delivery path and the resend cache are the backstops.
  bot.api.config.use(
    autoRetry({
      maxRetryAttempts: 1,
      maxDelaySeconds: 5,
      rethrowInternalServerErrors: true,
      rethrowHttpErrors: true,
    }),
  );

  if (opts.webhookPolicy === "preserve") {
    // Long-poll startup normally removes a configured webhook. Skipping only
    // that startup call leaves ownership intact so getUpdates can surface the
    // conflict instead of silently taking the bot away from its current host.
    bot.api.config.use((previous, method, payload, signal) => {
      if (suppressImplicitWebhookDeletion && method === "deleteWebhook") {
        suppressImplicitWebhookDeletion = false;
        return Promise.resolve({ ok: true, result: true }) as ReturnType<typeof previous>;
      }
      return previous(method, payload, signal);
    });
  }

  if (opts.onPollingSuccess !== undefined || opts.onPollingFailure !== undefined) {
    bot.api.config.use(async (previous, method, payload, signal) => {
      if (method !== "getUpdates") return previous(method, payload, signal);
      try {
        const result = await previous(method, payload, signal);
        opts.onPollingSuccess?.();
        return result;
      } catch (error) {
        opts.onPollingFailure?.();
        throw error;
      }
    });
  }

  bot.api.config.use((previous, method, payload, signal) =>
    opts.ledger.track(() => previous(method, payload, signal)),
  );

  bot.use((_ctx, next) => opts.ledger.trackUpdate(() => Promise.resolve().then(next)));
  bot.use(opts.access.middleware);

  return {
    bot,
    prepareStart: () => {
      suppressImplicitWebhookDeletion = opts.webhookPolicy === "preserve";
    },
  };
}

export type TelegramWebhookPolicy = "delete-before-polling" | "preserve";

export interface TelegramDrainSnapshot {
  wait(): Promise<void>;
}

export interface TelegramChannelRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  captureDrain(): TelegramDrainSnapshot;
  drainPending(): Promise<void>;
  sendMessage(chatId: string | number, text: string): Promise<unknown>;
}

export interface CreateTelegramChannelInput {
  readonly token: string;
  readonly webhookPolicy: TelegramWebhookPolicy;
  readonly engine: CoachEngine;
  readonly host: TelegramHostCapabilities;
  readonly dataDir: string;
  readonly onStart?: () => void;
  readonly onPollingSuccess?: () => void;
  readonly onPollingFailure?: () => void;
}

export function createTelegramBot(input: CreateTelegramChannelInput): TelegramChannelRuntime {
  const ledger = new TelegramWorkLedger();
  const { bot, prepareStart } = createSecuredBot({
    token: input.token,
    access: input.host.access,
    webhookPolicy: input.webhookPolicy,
    ledger,
    onPollingSuccess: input.onPollingSuccess,
    onPollingFailure: input.onPollingFailure,
  });
  const { engine, host } = input;
  const { dataDir } = input;
  const phrasebookForContext = (ctx: {
    chat?: { id: number };
    message?: { text?: string };
    from?: { language_code?: string };
  }): Promise<Phrasebook> =>
    host.language.phrasebookFor({
      chatId: ctx.chat === undefined ? undefined : `telegram:${ctx.chat.id}`,
      athleteText: ctx.message?.text,
      ...(ctx.from?.language_code === undefined
        ? {}
        : {
            surfaceHint: {
              language: normalizeLocaleHint(ctx.from.language_code),
              locale: ctx.from.language_code,
            },
          }),
    });
  const releaseText = (book: Phrasebook, value: string | Message): string => {
    const message = telegramReleaseMessage(value);
    return typeof message === "string" ? message : book.say(message);
  };
  const registerChatMenu = (chatId: number, book: Phrasebook, automatic: boolean): Promise<void> =>
    registerTelegramChatCommandMenu({
      api: bot.api,
      dataDir,
      token: input.token,
      chatId,
      book,
      automatic,
      syncEnabled: host.operations !== undefined,
      updateDescription: telegramReleaseMessage(host.release.updateDescription),
    }).catch((error) => log.error("set_chat_commands_failed", error, {}));
  const welcomeFor = (book: Phrasebook): string =>
    book.say(buildWelcomeMessage(releaseText(book, host.release.updateDescription)));
  const log = createSubsystemLogger("telegram", dataDir);
  const greeted = new Set<number>();
  const greetingChecks = new Map<number, Promise<void>>();
  const reserveInvocation = (chatId: string): TelegramInvocationReservation =>
    host.invocations?.reserve(chatId) ?? {
      run: (operation) => operation(),
      cancel: () => undefined,
    };
  const acknowledgeBeforeInvocation = async (
    reservation: TelegramInvocationReservation,
    acknowledge: () => Promise<unknown>,
  ): Promise<void> => {
    try {
      await acknowledge();
    } catch (error) {
      reservation.cancel();
      throw error;
    }
  };

  // Durable update-offset store. Normal polling processes pending updates (so a
  // message sent while the bot was down still arrives); the guard below dedupes
  // anything a previous run already dispatched or acknowledged before a crash /
  // self-update restart.
  const offsets = new TelegramUpdateOffsetStore(dataDir, input.token);

  // Process-local per-chat cache of the last generated answer, so an athlete can
  // ask for it again after a Telegram delivery failure without re-running the LLM
  // turn. Bounded + TTL'd; contents (athlete text) are never logged.
  const resendCache = new Map<string, { answer: string; expires: number }>();
  const writeResend = (chatId: string, answer: string): void => {
    const now = Date.now();
    for (const [key, entry] of resendCache) {
      if (entry.expires <= now) resendCache.delete(key);
    }
    resendCache.delete(chatId); // bump to MRU position (no-op if absent)
    resendCache.set(chatId, { answer, expires: now + RESEND_TTL_MS });
    while (resendCache.size > RESEND_MAX_ENTRIES) {
      const oldest = resendCache.keys().next().value;
      if (oldest === undefined) break;
      resendCache.delete(oldest);
    }
  };
  const readResend = (chatId: string): string | undefined => {
    const entry = resendCache.get(chatId);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) {
      resendCache.delete(chatId);
      return undefined;
    }
    return entry.answer;
  };

  // Fire-and-forget turn dispatch. Telegram handlers spawn the LLM turn on a
  // tracked task and return immediately so grammY's sequential update loop is
  // never blocked by a long turn. The task owns its user-facing error reply; the
  // outer catch here is the last-resort net so a throw inside the reply path can
  // never escape as an unhandled rejection. Async host preflight must finish in
  // arrival order before each operation enters the engine's per-session lock;
  // this sequencer advances after invocation, not after the turn completes.
  const engineStartTails = new Map<string, Promise<void>>();
  const enqueueEngineStart = <T>(
    chatId: string,
    begin: () => { readonly result: Promise<T> } | Promise<{ readonly result: Promise<T> }>,
  ): Promise<T> => {
    const predecessor = engineStartTails.get(chatId);
    let started: Promise<{ readonly result: Promise<T> }>;
    if (predecessor === undefined) {
      try {
        started = Promise.resolve(begin());
      } catch (error) {
        started = Promise.reject(error);
      }
    } else {
      started = predecessor.then(begin);
    }
    const tail = started.then(
      () => undefined,
      () => undefined,
    );
    engineStartTails.set(chatId, tail);
    void tail.then(() => {
      if (engineStartTails.get(chatId) === tail) engineStartTails.delete(chatId);
    });
    return started.then(({ result }) => result);
  };
  const dispatch = (work: () => Promise<void>): void => {
    void ledger.track(async () => {
      try {
        await work();
      } catch (err) {
        log.error("dispatch_failed", err, {});
      }
    });
  };
  // Per-chat buffer of free-form fragments awaiting the coalesce window. Each
  // entry rebinds the latest fragment's reply context so the flushed turn
  // answers on a live ctx, and threads to the last fragment's message id.
  interface ChatBuffer {
    fragments: string[];
    athleteText: string;
    scope: TelegramWorkScope;
    reservation: TelegramInvocationReservation;
    reply: (text: string, options?: Record<string, unknown>) => Promise<unknown>;
    replyWithChatAction: (action: "typing") => Promise<unknown>;
    replyToMessageId?: number;
    phrasebook: Phrasebook;
    from?: { language_code?: string };
    timer: ReturnType<typeof setTimeout>;
  }
  const chatBuffers = new Map<number, ChatBuffer>();

  const reserveMessageInvocation = (chatId: number): TelegramInvocationReservation => {
    const buffered = chatBuffers.get(chatId)?.reservation;
    if (buffered !== undefined) return buffered;
    return reserveInvocation(`telegram:${chatId}`);
  };

  // Flush buffered fragments synchronously so the captured generation owns the
  // dispatched turn instead of waiting on the debounce timer.
  const flushSnapshotBuffers = (snapshot: TelegramWorkLedgerSnapshot): void => {
    for (const [chatId, buffer] of chatBuffers) {
      if (snapshot.includes(buffer.scope)) flushBufferedChat(chatId);
    }
  };

  const waitForSnapshot = async (snapshot: TelegramWorkLedgerSnapshot): Promise<void> => {
    while (true) {
      flushSnapshotBuffers(snapshot);
      await snapshot.wait();
      const hasCapturedBuffer = [...chatBuffers.values()].some((buffer) =>
        snapshot.includes(buffer.scope),
      );
      if (!hasCapturedBuffer) {
        snapshot.release();
        return;
      }
    }
  };

  const captureDrain = (): TelegramDrainSnapshot => {
    const snapshot = ledger.captureSealedGenerations();
    flushSnapshotBuffers(snapshot);
    return { wait: () => waitForSnapshot(snapshot) };
  };

  const stopPolling = (): Promise<void> =>
    ledger.stopCurrentGeneration(async () => {
      try {
        await bot.stop();
      } catch (error) {
        if (bot.isRunning()) throw error;
      }
    });

  const drainPending = async (): Promise<void> => {
    while (true) {
      const snapshot = ledger.captureAllGenerations();
      flushSnapshotBuffers(snapshot);
      await waitForSnapshot(snapshot);
      if (chatBuffers.size === 0) return;
    }
  };

  void ledger
    .track(() =>
      registerTelegramCommandMenus({
        api: bot.api,
        dataDir,
        token: input.token,
        syncEnabled: host.operations !== undefined,
        updateDescription: telegramReleaseMessage(host.release.updateDescription),
      }),
    )
    .catch((err) => log.error("set_commands_failed", err, {}));

  // Shared turn skeleton: every chat-bearing handler captures its deps/message
  // synchronously, then hands the LLM turn here to run on the fire-and-forget
  // task. Generation and delivery are split into separate try blocks so a
  // post-generation Telegram delivery failure is never shown generation copy and
  // vice versa. The only per-handler differences (genericReply text, log command
  // name, reply-to id) are passed in rather than re-templated.
  function runTurn(opts: {
    ctx: {
      from?: { language_code?: string };
      reply: (text: string, options?: Record<string, unknown>) => Promise<unknown>;
      replyWithChatAction: (action: "typing") => Promise<unknown>;
    };
    command: string;
    chatId: string;
    message: string;
    athleteText?: string;
    genericReply: Message;
    phrasebook: Phrasebook;
    reservation: TelegramInvocationReservation;
    greetingChatId?: number;
    replyToMessageId?: number;
  }): void {
    dispatch(async () => {
      const phrasebook = opts.phrasebook;
      const stopHeartbeat = startTypingHeartbeat(
        () => opts.ctx.replyWithChatAction("typing"),
        TYPING_HEARTBEAT_MS,
        () => log.debug("typing_heartbeat_failed", { command: opts.command, chatId: opts.chatId }),
      );
      let response: string;
      try {
        response = await opts.reservation.run(async () => {
          if (opts.greetingChatId !== undefined) {
            await ensureGreeting(
              { chat: { id: opts.greetingChatId }, reply: opts.ctx.reply },
              phrasebook,
            );
          }
          let fixedMessage: { key: string; vars?: Record<string, string | number> } | undefined;
          const request = { chatId: opts.chatId, message: opts.message };
          const chatResponse = await enqueueEngineStart(opts.chatId, async () => {
            const turn = await host.operations?.resolveTurnContext();
            const { language, source: languageSource } = await host.language.resolveFor({
              chatId: opts.chatId,
              athleteText: opts.athleteText ?? opts.message,
              ...(opts.ctx.from?.language_code === undefined
                ? {}
                : {
                    surfaceHint: {
                      language: normalizeLocaleHint(opts.ctx.from.language_code),
                      locale: opts.ctx.from.language_code,
                    },
                  }),
            });
            return {
              result: engine.chat(
                { ...request, turn: { ...turn, language, languageSource } },
                (event) => {
                  if (event.type === "final-text") fixedMessage = event.message;
                },
              ),
            };
          });
          const wireMessage = chatResponse.message ?? fixedMessage;
          const message =
            wireMessage === undefined ? undefined : await messageFromWire(wireMessage);
          return message === undefined ? chatResponse.text : phrasebook.say(message);
        });
      } catch (err) {
        log.error("command_failed", err, { command: opts.command, chatId: opts.chatId });
        const { kind, athleteMessage } = classifyAgentError(err, phrasebook.format);
        await opts.ctx.reply(
          phrasebook.say(kind === "unknown" ? opts.genericReply : athleteMessage),
        );
        return;
      } finally {
        await stopHeartbeat();
      }
      writeResend(opts.chatId, response);
      try {
        await sendLongMessage(opts.ctx, response, opts.replyToMessageId);
        const proposal = await host.confirmations.peek({ chatId: opts.chatId, phrasebook });
        if (proposal !== undefined) {
          await opts.ctx.reply(proposal.summary, {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: phrasebook.say(msg("telegram.confirmation.confirm")),
                    callback_data: `cg:y:${proposal.nonce}`,
                  },
                  {
                    text: phrasebook.say(msg("telegram.confirmation.cancel")),
                    callback_data: `cg:n:${proposal.nonce}`,
                  },
                ],
              ],
            },
          });
        }
      } catch (err) {
        log.error("delivery_failed", err, { command: opts.command, chatId: opts.chatId });
        await opts.ctx.reply(phrasebook.say(DELIVERY_FAILURE_HINT));
      }
    });
  }

  // Idempotent read-and-delete: no await between lookup and delete, so a
  // concurrent flush (command middleware vs. drain vs. timer) can never
  // double-dispatch the same buffered turn. Deps are resolved here, at flush
  // time, so the coalesced turn sees fresh environment state.
  function flushBufferedChat(chatId: number): void {
    const buf = chatBuffers.get(chatId);
    if (buf === undefined) return;
    chatBuffers.delete(chatId);
    clearTimeout(buf.timer);
    runTurn({
      ctx: { reply: buf.reply, replyWithChatAction: buf.replyWithChatAction, from: buf.from },
      phrasebook: buf.phrasebook,
      command: "chat",
      chatId: `telegram:${chatId}`,
      message: buf.fragments.join("\n"),
      athleteText: buf.athleteText,
      genericReply: msg("telegram.error.transport"),
      reservation: buf.reservation,
      greetingChatId: host.invocations === undefined ? undefined : chatId,
      replyToMessageId: buf.replyToMessageId,
    });
  }

  async function ensureGreeting(
    ctx: {
      chat: { id: number };
      reply: (text: string, options?: Record<string, unknown>) => Promise<unknown>;
    },
    phrasebook: Phrasebook,
  ): Promise<void> {
    if (greeted.has(ctx.chat.id)) return;
    let check = greetingChecks.get(ctx.chat.id);
    if (check === undefined) {
      const chatId = `telegram:${ctx.chat.id}`;
      check = (async () => {
        const { hasSession } = await engine.hasSession({ chatId });
        if (!hasSession) await ctx.reply(welcomeFor(phrasebook));
        greeted.add(ctx.chat.id);
      })();
      greetingChecks.set(ctx.chat.id, check);
      const cleanup = () => {
        if (greetingChecks.get(ctx.chat.id) === check) greetingChecks.delete(ctx.chat.id);
      };
      void check.then(cleanup, cleanup);
    }
    await check;
  }

  function bufferChatMessage(
    ctx: {
      chat: { id: number };
      from?: { language_code?: string };
      message: { text: string; message_id?: number };
      reply: (text: string, options?: Record<string, unknown>) => Promise<unknown>;
      replyWithChatAction: (action: "typing") => Promise<unknown>;
    },
    reservation: TelegramInvocationReservation,
    phrasebook: Phrasebook,
  ): void {
    const text = ctx.message.text;
    const chatId = ctx.chat.id;
    const invocationChatId = `telegram:${chatId}`;
    if (text.startsWith("/")) {
      // Unregistered-command fallthrough: never buffered. The turn runs
      // immediately so a command can never be coalesced into free-form text.
      runTurn({
        ctx,
        phrasebook,
        command: "chat",
        chatId: invocationChatId,
        message: text,
        genericReply: msg("telegram.error.transport"),
        reservation,
        greetingChatId: host.invocations === undefined ? undefined : chatId,
        replyToMessageId: ctx.message.message_id,
      });
      return;
    }
    const existing = chatBuffers.get(chatId);
    if (existing !== undefined) clearTimeout(existing.timer);
    const fragments = existing?.fragments ?? [];
    fragments.push(text);
    const timer = setTimeout(() => flushBufferedChat(chatId), CHAT_COALESCE_MS);
    timer.unref?.();
    chatBuffers.set(chatId, {
      fragments,
      phrasebook,
      from: ctx.from,
      athleteText: text,
      scope: existing?.scope ?? ledger.currentScope(),
      reservation: existing?.reservation ?? reservation,
      reply: (t, o) => ctx.reply(t, o),
      replyWithChatAction: (a) => ctx.replyWithChatAction(a),
      replyToMessageId: ctx.message.message_id,
      timer,
    });
  }

  // Flush middleware: any slash update flushes this chat's buffered text ahead
  // of the command handler, so the buffered turn enqueues on the FIFO session
  // lock before the command runs. Registered after auth (createSecuredBot) and
  // before every bot.command below — do not move it below a command.
  bot.use(async (ctx, next) => {
    if (ctx.chat !== undefined && ctx.message?.text?.startsWith("/") === true) {
      flushBufferedChat(ctx.chat.id);
    }
    await next();
  });

  // Update-offset dedupe guard. Runs after the flush middleware and before every
  // handler: an update already dispatched — or acknowledged before a crash /
  // self-update restart — is skipped so its work never re-runs.
  bot.use(async (ctx, next) => {
    const updateId = ctx.update?.update_id;
    if (typeof updateId === "number" && !offsets.shouldDispatch(updateId)) return;
    await next();
  });

  // ── Commands ────────────────────────────────────────────────────────────

  bot.command("language", async (ctx) => {
    const phrasebook = await phrasebookForContext(ctx);
    const current = await host.language.current();
    await registerChatMenu(ctx.chat.id, phrasebook, current.value === null);
    const message =
      current.origin === "environment"
        ? phrasebook.say(
            msg("telegram.language.environment", {
              variable: "ENDURAGENT_LANGUAGE",
              language: describeLanguage(current.resolved.language).endonym,
            }),
          )
        : phrasebook.say(msg("telegram.language.choose"));
    await ctx.reply(message, {
      reply_markup: languageKeyboard(current, phrasebook),
    });
  });

  bot.command("start", async (ctx) => {
    const phrasebook = await phrasebookForContext(ctx);
    greeted.add(ctx.chat.id);
    let memoryFlushed = true;
    const chatId = `telegram:${ctx.chat.id}`;
    const reservation = reserveInvocation(chatId);
    try {
      ({ memoryFlushed } = await reservation.run(() =>
        enqueueEngineStart(chatId, () => ({
          result: engine.resetSession({ chatId }),
        })),
      ));
      resendCache.delete(chatId);
    } catch (err) {
      log.error("command_failed", err, { command: "start", chatId });
      await ctx.reply(phrasebook.say(msg("telegram.session.resetFailed", { command: "/start" })));
      return;
    }
    const welcomeMessage = welcomeFor(phrasebook);
    await ctx.reply(
      memoryFlushed ? welcomeMessage : `${welcomeMessage}\n\n${phrasebook.say(RESET_CAVEAT_NOTE)}`,
    );
  });

  bot.command("plan", async (ctx) => {
    const phrasebook = await phrasebookForContext(ctx);
    const chatId = `telegram:${ctx.chat.id}`;
    const reservation = reserveInvocation(chatId);
    await acknowledgeBeforeInvocation(reservation, () =>
      ctx.reply(phrasebook.say(msg("telegram.plan.working"))),
    );
    runTurn({
      ctx,
      phrasebook,
      command: "plan",
      chatId,
      message: "/plan",
      genericReply: msg("telegram.plan.failed"),
      reservation,
      replyToMessageId: ctx.message?.message_id,
    });
  });

  bot.command("workout", async (ctx) => {
    const phrasebook = await phrasebookForContext(ctx);
    const chatId = `telegram:${ctx.chat.id}`;
    const reservation = reserveInvocation(chatId);
    await acknowledgeBeforeInvocation(reservation, () =>
      ctx.reply(phrasebook.say(msg("telegram.workout.working"))),
    );
    runTurn({
      ctx,
      phrasebook,
      command: "workout",
      chatId,
      message: "/workout",
      genericReply: msg("telegram.error.transport"),
      reservation,
      replyToMessageId: ctx.message?.message_id,
    });
  });

  bot.command("status", async (ctx) => {
    const phrasebook = await phrasebookForContext(ctx);
    const chatId = `telegram:${ctx.chat.id}`;
    const reservation = reserveInvocation(chatId);
    await acknowledgeBeforeInvocation(reservation, () =>
      ctx.reply(phrasebook.say(msg("telegram.status.working"))),
    );
    runTurn({
      ctx,
      phrasebook,
      command: "status",
      chatId,
      message: "/status",
      genericReply: msg("telegram.error.transport"),
      reservation,
      replyToMessageId: ctx.message?.message_id,
    });
  });

  if (host.operations !== undefined) {
    bot.command("sync", async (ctx) => {
      const phrasebook = await phrasebookForContext(ctx);
      const chatId = `telegram:${ctx.chat.id}`;
      const reservation = reserveInvocation(chatId);
      await acknowledgeBeforeInvocation(reservation, () =>
        ctx.reply(phrasebook.say(msg("telegram.sync.working", { service: "intervals.icu" }))),
      );
      try {
        const result = await reservation.run(() => host.operations!.sync({ chatId, phrasebook }));
        await ctx.reply(result.text);
      } catch (err) {
        log.error("command_failed", err, { command: "sync", chatId });
        await ctx.reply(phrasebook.say(msg("telegram.sync.failed")));
      }
    });
  }

  if (host.diagnostics !== undefined) {
    bot.command("snapshot", async (ctx) => {
      const phrasebook = await phrasebookForContext(ctx);
      const args = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
      const sub = args[0]?.toLowerCase() ?? "help";

      if (sub === "help") {
        await ctx.reply(phrasebook.say(SNAPSHOT_HELP));
        return;
      }

      if (sub === "raw") {
        const senderId = ctx.from?.id;
        if (
          typeof senderId !== "number" ||
          !(await host.authorization.isPrimaryOperator({ senderId: String(senderId) }))
        ) {
          await ctx.reply(phrasebook.say(msg("telegram.snapshot.operatorOnly")));
          return;
        }
        const section = args[1];
        const output = await host.diagnostics!.rawSnapshot(
          section === undefined ? { phrasebook } : { section, phrasebook },
        );
        try {
          await sendSnapshotOutput(output, {
            book: phrasebook,
            reply: (text) => sendLongMessage(ctx, text) as Promise<unknown>,
            replyHtml: (html) => ctx.reply(html, { parse_mode: "HTML" }) as Promise<unknown>,
            sendDocument: (buffer, filename, caption) =>
              ctx.replyWithDocument(
                new InputFile(buffer, filename),
                caption === undefined ? undefined : { caption },
              ) as Promise<unknown>,
          });
        } catch (err) {
          log.error("command_failed", err, {
            command: "snapshot",
            chatId: `telegram:${ctx.chat.id}`,
          });
          await ctx.reply(phrasebook.say(msg("telegram.snapshot.failed")));
        }
        return;
      }

      await ctx.reply(phrasebook.say(SNAPSHOT_HELP));
    });
  }

  bot.command("review", async (ctx) => {
    const phrasebook = await phrasebookForContext(ctx);
    const args = (ctx.match ?? "").trim();
    const chatId = `telegram:${ctx.chat.id}`;
    const reservation = reserveInvocation(chatId);
    await acknowledgeBeforeInvocation(reservation, () =>
      ctx.reply(
        args
          ? phrasebook.say(msg("telegram.review.workingWithArgs", { args }))
          : phrasebook.say(msg("telegram.review.working")),
      ),
    );
    const message = args ? `/review ${args}` : "/review";
    runTurn({
      ctx,
      phrasebook,
      command: "review",
      chatId,
      message,
      genericReply: msg("telegram.review.failed"),
      reservation,
      replyToMessageId: ctx.message?.message_id,
    });
  });

  bot.command("version", async (ctx) => {
    await phrasebookForContext(ctx);
    await ctx.reply(await host.release.version());
  });

  bot.command("whatsnew", async (ctx) => {
    const phrasebook = await phrasebookForContext(ctx);
    await ctx.reply(phrasebook.say(msg("telegram.release.working")));
    try {
      const result = await host.release.whatsNew(phrasebook);
      if (result.kind === "unavailable") {
        await ctx.reply(releaseText(phrasebook, host.release.whatsNewUnavailableText));
        return;
      }
      await sendLongMessage(ctx, result.text);
    } catch (err) {
      log.error("command_failed", err, { command: "whatsnew", chatId: `telegram:${ctx.chat.id}` });
      await ctx.reply(phrasebook.say(msg("telegram.release.failed")));
    }
  });

  bot.command("update", async (ctx) => {
    const phrasebook = await phrasebookForContext(ctx);
    const release = host.release;
    if (release.updatePolicy !== "npm-self-update") {
      await ctx.reply(releaseText(phrasebook, await release.updateNotice()));
      return;
    }

    await ctx.reply(phrasebook.say(msg("telegram.update.checking")));
    let latest: string | undefined;
    try {
      const info = await release.check();
      if (!info) {
        await ctx.reply(phrasebook.say(msg("telegram.update.checkFailed")));
        return;
      }
      if (!info.updateAvailable) {
        await ctx.reply(phrasebook.say(msg("telegram.update.latest", { version: info.current })));
        return;
      }
      latest = info.latest;
      // Persist a durable self-update marker BEFORE stopping. It records the
      // /update's own update id as dispatched so the restart doesn't re-trigger
      // /update. If the marker can't be written we must NOT stop — a
      // restart could otherwise loop on /update — so surface a safe retry copy.
      try {
        offsets.recordSelfUpdate({
          updateId: typeof ctx.update?.update_id === "number" ? ctx.update.update_id : null,
          chatId: ctx.chat.id,
          ts: new Date().toISOString(),
          targetVersion: info.latest,
        });
      } catch {
        log.error("self_update_marker_failed", undefined, {
          chatId: `telegram:${ctx.chat.id}`,
        });
        await ctx.reply(phrasebook.say(SELF_UPDATE_MARKER_FAILURE));
        return;
      }
      await ctx.reply(
        phrasebook.say(
          msg("telegram.update.installing", {
            current: info.current,
            latest: info.latest,
            command: release.binaryName,
          }),
        ),
      );
      // Stop polling first so Telegram commits the /update offset — otherwise
      // Telegram re-sends /update on next startup and we loop forever — then let
      // every generation-owned task finish so installer handoff cannot overlap
      // the runtime it replaces.
      void stopPolling()
        .then(() => captureDrain().wait())
        .then(() => release.install(info.latest))
        .catch(() => {
          log.error("self_update_failed", undefined, {
            chatId: `telegram:${ctx.chat.id}`,
          });
        });
    } catch (err) {
      log.error("command_failed", err, { command: "update", chatId: `telegram:${ctx.chat.id}` });
      await ctx.reply(
        phrasebook.say(
          msg("telegram.update.failed", {
            command: `npm install -g ${release.binaryName}@${latest ?? "latest"} --ignore-scripts`,
          }),
        ),
      );
    }
  });

  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("lang:")) {
      await next();
      return;
    }
    const value = parseLanguageCallback(data);
    if (value === undefined) {
      await ctx.answerCallbackQuery();
      return;
    }
    const state = await host.language.set(value);
    const selectedBook = await phrasebookForContext(ctx);
    if (ctx.chat !== undefined)
      await registerChatMenu(ctx.chat.id, selectedBook, state.value === null);
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: languageKeyboard(state, selectedBook) });
    } catch (error) {
      if (
        !(error instanceof GrammyError) ||
        !error.description.includes("message is not modified")
      ) {
        throw error;
      }
    } finally {
      await ctx.answerCallbackQuery(
        state.origin === "environment"
          ? {
              text: selectedBook.say(
                msg("telegram.language.environmentWins", { variable: "ENDURAGENT_LANGUAGE" }),
              ),
            }
          : {},
      );
    }
  });

  bot.on("callback_query:data", async (ctx) => {
    const phrasebook = await phrasebookForContext(ctx);
    const match = /^cg:(y|n):(.+)$/.exec(ctx.callbackQuery.data);
    if (match === null || ctx.chat === undefined) {
      await ctx.answerCallbackQuery();
      return;
    }
    const chatId = `telegram:${ctx.chat.id}`;
    const reservation = reserveInvocation(chatId);
    await acknowledgeBeforeInvocation(reservation, () => ctx.answerCallbackQuery());
    try {
      await ctx.editMessageReplyMarkup();
    } catch {
      // Best-effort keyboard cleanup must not block resolution.
    }
    const choice = match[1];
    const nonce = match[2] ?? "";
    dispatch(async () => {
      const reply = await reservation.run(async () => {
        if (choice === "n") {
          const outcome = await host.confirmations.cancel({ chatId, nonce });
          return outcome === "canceled"
            ? phrasebook.say(msg("telegram.confirmation.canceled"))
            : phrasebook.say(msg("telegram.confirmation.expired"));
        }
        const outcome = await host.confirmations.confirm({ chatId, nonce, phrasebook });
        return phrasebook.say(formatConfirmOutcome(outcome));
      });
      await ctx.reply(reply);
    });
  });

  // ── Free-form chat ──────────────────────────────────────────────────────

  bot.on("message:text", async (ctx) => {
    const phrasebook = await phrasebookForContext(ctx);
    const chatId = `telegram:${ctx.chat.id}`;
    const text = ctx.message.text;

    // Resend the last cached answer without re-running the LLM turn. Short-circuit
    // BEFORE any greeting/dispatch so it never reaches agent.chat.
    if (text.trim().toLowerCase() === RESEND_KEYWORD) {
      const cached = readResend(chatId);
      if (cached !== undefined) {
        // Route through dispatch so re-emitting a long multi-chunk answer runs on
        // the fire-and-forget task instead of blocking the sequential update loop,
        // and a delivery failure gets the same hint runTurn uses rather than
        // escaping to bot.catch as generic classified copy.
        dispatch(async () => {
          try {
            await sendLongMessage(ctx, cached);
          } catch (err) {
            log.error("delivery_failed", err, { command: "resend", chatId });
            await ctx.reply(phrasebook.say(DELIVERY_FAILURE_HINT));
          }
        });
      } else await ctx.reply(phrasebook.say(msg("telegram.resend.missing")));
      return;
    }

    const reservation = reserveMessageInvocation(ctx.chat.id);
    if (host.invocations === undefined) await ensureGreeting(ctx, phrasebook);
    // One best-effort typing action per fragment so the athlete sees activity
    // during the debounce window; only the LLM turn is debounced, never the
    // signal. Fire-and-forget: a failure can never reach the handler's failure
    // path (the full typing heartbeat starts at flush inside runTurn).
    void Promise.resolve()
      .then(() => ctx.replyWithChatAction("typing"))
      .catch(() => log.debug("typing_action_failed", { command: "chat", chatId }));
    bufferChatMessage(ctx, reservation, phrasebook);
  });

  bot.catch(async (botError) => {
    // Real surface: synchronous handler/ack reply failures NOT on a dispatched
    // turn (dispatched-turn errors are already swallowed by the dispatch wrapper).
    // The classified-reply attempt is itself guarded so a reply throw cannot
    // re-enter bot.catch or escape as an unhandled rejection.
    log.error("bot_catch", botError.error, {});
    const c = botError.ctx;
    try {
      if (c?.chat) await c.reply((await phrasebookForContext(c)).say(GENERIC_TRANSPORT_APOLOGY));
    } catch (replyErr) {
      log.error("bot_catch_reply_failed", replyErr, {});
    }
  });

  return {
    start: () => {
      prepareStart();
      return ledger.startGeneration(() =>
        input.onStart === undefined ? bot.start() : bot.start({ onStart: input.onStart }),
      );
    },
    stop: stopPolling,
    captureDrain,
    drainPending,
    sendMessage: (chatId, text) => ledger.trackDirectSend(() => bot.api.sendMessage(chatId, text)),
  };
}

// ============================================================================
// MARKDOWN → TELEGRAM HTML
// ============================================================================

export function markdownToTelegramHtml(md: string): string {
  // Telegram has no table primitive. Extract tables first so the bullet-point
  // regex below doesn't mangle their leading `|`, then restore as <pre> blocks.
  const { text: noTables, tables } = extractTables(md);

  // Extract fenced code blocks from the RAW (table-stripped) markdown BEFORE
  // escaping, exactly as extractTables does. This preserves the fence body
  // byte-for-byte through the regex passes (no header/bold/italic/bullet
  // transform reaches inside) and restores it as an escaped <pre> at the end,
  // keeping the escape-first security property intact.
  const { text, fences } = extractFences(noTables);

  // Escape the raw source BEFORE any markdown conversion so the only real tags
  // in the output are the ones this converter emits. Literal HTML in the LLM
  // output (which can echo attacker-influenced intervals.icu text) must render
  // as text, never as markup. Table cells are escaped inside renderTableAsPre;
  // fence bodies are escaped on restore below.
  let html = escapeHtmlText(text);

  // Headers: ### Title → <b>Title</b>
  html = html.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // Bold: **text** → <b>text</b>
  html = html.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // Italic: *text* or _text_ → <i>text</i>. A space (or another `*`) adjacent to
  // either delimiter disqualifies the match, so interval math like
  // `do 3 * 8 reps then 2 * 20min` keeps its literal `*` and emits no <i>.
  html = html.replace(/(?<![\w*])\*(?![\s*])([^*\n]+?)(?<![\s*])\*(?![\w*])/g, "<i>$1</i>");
  html = html.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, "<i>$1</i>");

  // Links: [text](http(s)://url) → <a href="url">text</a>. Runs on the
  // post-escape html string, so the link text is already escaped; the url is
  // captured from this same (escaped) string and only attribute-quote-escaped —
  // re-running escapeHtmlText would double-escape an already-escaped `&` in a
  // multi-param query string. http/https only; other schemes stay literal. The
  // URL allows one level of balanced parens so Wikipedia-style URLs like
  // `…/Foo_(bar)` keep their closing paren instead of truncating at it.
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)/g,
    (_, label: string, url: string) => `<a href="${escapeHtmlAttrPreEscaped(url)}">${label}</a>`,
  );

  // Inline code: `text` → <code>text</code>
  html = html.replace(/`([^`]+?)`/g, "<code>$1</code>");

  // Strikethrough: ~~text~~ → <s>text</s>
  html = html.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Bullet points: - item → • item
  html = html.replace(/^[-*]\s+/gm, "• ");

  html = html.replace(/\[\[__TBL_(\d+)__\]\]/g, (_, idx) => tables[Number(idx)] ?? "");
  return html.replace(
    /\[\[__FENCE_(\d+)__\]\]/g,
    (_, idx) => `<pre>${escapeHtmlText(fences[Number(idx)] ?? "")}</pre>`,
  );
}

// Quote/apostrophe-escape a URL that has ALREADY passed through escapeHtmlText
// (so `&`/`<`/`>` are entities). Only `"` and `'` remain to neutralize for an
// attribute context; escapeHtmlAttr would re-escape the entities' `&`.
function escapeHtmlAttrPreEscaped(s: string): string {
  return s.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const FENCE_RE = /```[^\n]*\n?([\s\S]*?)```/g;

// Mirror extractTables: walk the RAW markdown, replace each fenced code block
// with an inert placeholder (no `* _ ` # -` or leading `[-*]`, so no regex
// between extraction and restore touches it), and collect the raw fence body
// for escaped-<pre> restore at the end of markdownToTelegramHtml.
function extractFences(md: string): { text: string; fences: string[] } {
  const fences: string[] = [];
  const text = md.replace(FENCE_RE, (_, body: string) => {
    const idx = fences.length;
    fences.push(body);
    return `[[__FENCE_${idx}__]]`;
  });
  return { text, fences };
}

const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;

function isTableRow(line: string | undefined): boolean {
  if (!line) return false;
  const t = line.trim();
  return t.startsWith("|") && t.endsWith("|") && t.length > 1;
}

function parseTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((s) => s.trim());
}

function extractTables(md: string): { text: string; tables: string[] } {
  const lines = md.split("\n");
  const tables: string[] = [];
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const next = lines[i + 1];
    if (isTableRow(lines[i]) && next !== undefined && TABLE_SEPARATOR_RE.test(next)) {
      const header = parseTableRow(lines[i]);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && isTableRow(lines[j])) {
        rows.push(parseTableRow(lines[j]));
        j++;
      }
      out.push(`[[__TBL_${tables.length}__]]`);
      tables.push(renderTableAsPre(header, rows));
      i = j;
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return { text: out.join("\n"), tables };
}

function renderTableAsPre(header: string[], rows: string[][]): string {
  const cols = Math.max(header.length, ...rows.map((r) => r.length));
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    let w = (header[c] ?? "").length;
    for (const r of rows) w = Math.max(w, (r[c] ?? "").length);
    widths.push(w);
  }
  const fmt = (r: string[]) =>
    Array.from({ length: cols }, (_, c) => (r[c] ?? "").padEnd(widths[c]))
      .join("  ")
      .trimEnd();
  const text = [fmt(header), ...rows.map(fmt)].map(escapeHtmlText).join("\n");
  return `<pre>${text}</pre>`;
}

// ============================================================================
// SEND WITH CHUNKING
// ============================================================================

const TELEGRAM_MAX_LENGTH = 4096;
const PRE_OPEN = "<pre>";
const PRE_CLOSE = "</pre>";
const PRE_OVERHEAD = PRE_OPEN.length + PRE_CLOSE.length;

type RenderUnit = { kind: "line"; text: string } | { kind: "pre"; text: string };

// Group multi-line <pre> blocks so the chunker treats each as one indivisible unit
// (Telegram rejects chunks with unmatched <pre>/</pre>).
function tokenizeHtml(html: string): RenderUnit[] {
  const units: RenderUnit[] = [];
  const lines = html.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const openIdx = line.indexOf(PRE_OPEN);
    const closeOnSame = openIdx >= 0 ? line.indexOf(PRE_CLOSE, openIdx) : -1;
    if (openIdx >= 0 && closeOnSame < 0) {
      let j = i + 1;
      while (j < lines.length && !lines[j].includes(PRE_CLOSE)) j++;
      if (j < lines.length) {
        units.push({ kind: "pre", text: lines.slice(i, j + 1).join("\n") });
        i = j + 1;
        continue;
      }
      // Unclosed <pre> — fall through and treat each line individually.
    }
    units.push({ kind: "line", text: line });
    i++;
  }
  return units;
}

// Split a <pre> block whose own length exceeds maxLen into multiple wrapped <pre> chunks
// so each chunk Telegram receives has a matching open/close tag.
function splitPreBlock(block: string, maxLen: number): string[] {
  const inner = block.replace(/^<pre>/, "").replace(/<\/pre>$/, "");
  const out: string[] = [];
  let current = "";
  for (const row of inner.split("\n")) {
    const candidate = current ? `${current}\n${row}` : row;
    if (candidate.length + PRE_OVERHEAD <= maxLen) {
      current = candidate;
      continue;
    }
    if (current) {
      out.push(`${PRE_OPEN}${current}${PRE_CLOSE}`);
      current = row;
      if (current.length + PRE_OVERHEAD <= maxLen) continue;
    }
    // Single row alone exceeds the budget — hard-split, wrap each piece.
    const sliceMax = Math.max(1, maxLen - PRE_OVERHEAD);
    let k = 0;
    while (k < row.length) {
      const piece = truncateUtf16Safe(row.slice(k), sliceMax);
      out.push(`${PRE_OPEN}${piece}${PRE_CLOSE}`);
      k += piece.length;
    }
    current = "";
  }
  if (current) out.push(`${PRE_OPEN}${current}${PRE_CLOSE}`);
  return out;
}

export function chunkHtml(html: string, maxLen: number = TELEGRAM_MAX_LENGTH): string[] {
  if (html.length <= maxLen) return [html];

  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current) {
      chunks.push(current);
      current = "";
    }
  };

  for (const unit of tokenizeHtml(html)) {
    const text = unit.text;
    const joinCost = current ? 1 : 0;

    if (current.length + text.length + joinCost <= maxLen) {
      current += (current ? "\n" : "") + text;
      continue;
    }

    flush();

    if (text.length <= maxLen) {
      current = text;
      continue;
    }

    if (unit.kind === "pre") {
      chunks.push(...splitPreBlock(text, maxLen));
    } else {
      chunks.push(...hardSplit(text, maxLen));
    }
  }

  flush();
  return chunks;
}

// Hard-split a single oversized line at a boundary that never bisects an HTML
// tag (`<…>`), an entity (`&…;`), or a UTF-16 surrogate pair, and never lands
// BETWEEN a converter tag's open and its close (which would leave a chunk with
// an unbalanced `<b>`/`<a>`/… — Telegram rejects it and forces the plain-text
// fallback). Scans back from the fixed offset to the last such safe cut; if none
// exists below maxLen the line is pathological (e.g. one >maxLen tag) and we fall
// back to the raw slice for that one piece to guarantee forward progress.
// (`<pre>` blocks never reach here; they are split by splitPreBlock.)
function hardSplit(text: string, maxLen: number): string[] {
  const out: string[] = [];
  let start = 0;
  while (text.length - start > maxLen) {
    let cut = start + maxLen;
    while (cut > start && !isSafeCut(text, start, cut)) cut--;
    if (cut === start) {
      // Pathological: no safe boundary below maxLen. Take the raw slice, but
      // still refuse to bisect a surrogate pair.
      cut = start + maxLen;
      const prev = text.charCodeAt(cut - 1);
      if (prev >= 0xd800 && prev <= 0xdbff && cut - 1 > start) cut--;
    }
    out.push(text.slice(start, cut));
    start = cut;
  }
  out.push(text.slice(start));
  return out;
}

const INLINE_TAG_RE = /<(\/?)(b|i|s|u|code|a)\b[^>]*>/g;

// True when cutting at `i` would leave an inline converter tag opened within
// [start, i) still unclosed at `i` — i.e. the cut falls between an open tag and
// its matching close, which yields an unbalanced chunk.
function cutSplitsOpenTag(text: string, start: number, i: number): boolean {
  const stack: string[] = [];
  for (const m of text.slice(start, i).matchAll(INLINE_TAG_RE)) {
    if (m[1] === "/") {
      const k = stack.lastIndexOf(m[2]);
      if (k >= 0) stack.splice(k, 1);
    } else {
      stack.push(m[2]);
    }
  }
  return stack.length > 0;
}

// A cut at index `i` (split into [start..i) and [i..]) is safe when it does not
// land inside an open `<…>` tag, inside an unterminated `&…;` entity, between the
// two halves of a surrogate pair, or between a converter tag's open and close.
function isSafeCut(text: string, start: number, i: number): boolean {
  const prev = text.charCodeAt(i - 1);
  if (prev >= 0xd800 && prev <= 0xdbff) return false; // high surrogate before cut

  // Inside a tag if the nearest unescaped `<`/`>` scanning back is a `<`.
  const lt = text.lastIndexOf("<", i - 1);
  const gt = text.lastIndexOf(">", i - 1);
  if (lt > gt) return false;

  // Inside an entity if the nearest `&` scanning back has no terminating `;`
  // before the cut and is close enough to still be an open entity run.
  const amp = text.lastIndexOf("&", i - 1);
  if (amp >= 0) {
    const semi = text.indexOf(";", amp);
    if (semi < 0 || semi >= i) {
      // No `;` yet; only treat as an open entity if the run so far is entity-ish
      // (no whitespace/`<`/`&`), otherwise a bare `&` is just literal text.
      const run = text.slice(amp + 1, i);
      if (/^[a-zA-Z0-9#]*$/.test(run)) return false;
    }
  }

  if (cutSplitsOpenTag(text, start, i)) return false;
  return true;
}

function isTelegramParseError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("can't parse entities");
}

export async function sendLongMessage(
  ctx: { reply: (text: string, options?: Record<string, unknown>) => Promise<unknown> },
  text: string,
  replyToMessageId?: number,
): Promise<void> {
  const html = markdownToTelegramHtml(text);
  // Thread the FIRST delivered chunk to the inbound message; later chunks stay
  // unthreaded. allow_sending_without_reply keeps the send working even if the
  // inbound message was deleted (otherwise reply-to-deleted is a new failure).
  let pendingThread =
    replyToMessageId !== undefined
      ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } }
      : undefined;
  for (const chunk of chunkHtml(html)) {
    // Telegram rejects an empty message (400: message text is empty), and an
    // empty chunk carries nothing for the athlete anyway — skip it so ctx.reply
    // is never called with empty/whitespace-only text.
    if (chunk.trim() === "") continue;
    const thread = pendingThread;
    try {
      await ctx.reply(chunk, { parse_mode: "HTML", ...thread });
      pendingThread = undefined;
    } catch (err) {
      if (!isTelegramParseError(err)) throw err;
      // Log the message only — a grammY error object carries the request
      // payload, i.e. the athlete's reply text, which must stay out of logs.
      console.error(
        "Telegram rejected HTML chunk; resending as plain text:",
        err instanceof Error ? err.message : String(err),
      );
      // Resend human-readable source, not the rejected HTML. Strip the converter
      // tags and invert the (trivially invertible) HTML escape so the athlete
      // sees clean text — never tag soup or double-escaped entities.
      const plain = htmlChunkToPlainText(chunk);
      if (plain.trim() === "") continue;
      await ctx.reply(plain, thread);
      pendingThread = undefined;
    }
  }
}

// Turn a rejected HTML chunk back into readable plain text for the no-parse-mode
// fallback: drop the converter tags this module emits, then invert escapeHtmlText
// (`&lt;`→`<`, `&gt;`→`>`, and `&amp;`→`&` LAST so `&amp;lt;` round-trips to
// `&lt;`). The output carries no tags and no double-escaped entities.
function htmlChunkToPlainText(chunk: string): string {
  return chunk
    .replace(/<\/?(?:b|i|s|u|pre|code)>/g, "")
    .replace(/<a href="[^"]*">/g, "")
    .replace(/<\/a>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
