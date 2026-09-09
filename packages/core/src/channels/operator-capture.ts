import { msg } from "@enduragent/i18n";
import type { Phrasebook } from "@enduragent/i18n/messages";
import { createNpmCoachLanguage } from "../language-preference.js";
import { randomBytes } from "node:crypto";
import { Bot } from "grammy";
import type { BinaryConfig } from "../binary.js";
import {
  defaultPairingState,
  saveAllowedSenders,
  LockfileContentionError,
  SENDER_ID_RE,
} from "./allowed-senders.js";

export type CaptureStatus =
  | "captured"
  | "declined"
  | "timeout"
  | "getme-failed"
  | "lockfile-contention"
  | "write-failed";

export interface CaptureResult {
  status: CaptureStatus;
  capturedId?: string;
  botUsername?: string;
  reason?: string;
}

export interface ConfirmInfo {
  capturedId: string;
  senderUsername: string | undefined;
  senderFirstName: string | undefined;
  botUsername: string;
  binaryName: string;
}

export interface CaptureOpts {
  phrasebook?: Phrasebook;
  botToken: string;
  binary: BinaryConfig;
  dataDir: string;
  timeoutMs?: number;
  confirm: (info: ConfirmInfo) => Promise<boolean>;
  log?: (line: string) => void;
}

interface CapturedFrom {
  id: number;
  username?: string;
  first_name?: string;
}

export async function captureAndPersistOperator(opts: CaptureOpts): Promise<CaptureResult> {
  const book = opts.phrasebook ?? (await createNpmCoachLanguage(opts.dataDir).phrasebookFor({}));
  const log = opts.log ?? ((s: string) => console.log(s));
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const bot = new Bot(opts.botToken);

  // Validate the token via getMe BEFORE opening any capture window — typo'd
  // tokens fail fast with a clear error instead of silently 401-looping.
  let me: { is_bot: boolean; username?: string };
  try {
    me = await bot.api.getMe();
  } catch (err) {
    return {
      status: "getme-failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  if (!me.is_bot || !me.username) {
    return {
      status: "getme-failed",
      reason: book.say(msg("telegram.capture.invalidBot", { service: "Telegram" })),
    };
  }
  const botUsername = me.username;
  const pairingCode = randomBytes(3).toString("hex").toUpperCase();
  log(book.say(msg("telegram.capture.code", { username: `@${botUsername}`, code: pairingCode })));
  log(book.say(msg("telegram.capture.sendCode")));

  let capturedFrom: CapturedFrom | undefined;

  bot.use(async (ctx) => {
    if (ctx.chat?.type !== "private") return;
    if (typeof ctx.from?.id !== "number") return;
    const id = String(ctx.from.id);
    if (!SENDER_ID_RE.test(id)) return;
    if (ctx.message?.text?.trim() !== pairingCode) return;
    capturedFrom = {
      id: ctx.from.id,
      username: ctx.from.username,
      first_name: ctx.from.first_name,
    };
    // Stop polling so bot.start() resolves and the race completes.
    void bot.stop();
  });

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    bot.start({ drop_pending_updates: true }),
    new Promise<void>((res) => {
      timeoutHandle = setTimeout(() => {
        void bot.stop();
        res();
      }, timeoutMs);
    }),
  ]);
  if (timeoutHandle) clearTimeout(timeoutHandle);

  if (!capturedFrom) return { status: "timeout", botUsername };

  const capturedId = String(capturedFrom.id);

  const ok = await opts.confirm({
    capturedId,
    senderUsername: capturedFrom.username,
    senderFirstName: capturedFrom.first_name,
    botUsername,
    binaryName: opts.binary.binaryName,
  });
  if (!ok) return { status: "declined", botUsername, capturedId };

  const nowIso = new Date().toISOString();
  try {
    saveAllowedSenders(opts.dataDir, (current) => {
      const base = current ?? defaultPairingState();
      const merged = base.allowFrom.includes(capturedId)
        ? base.allowFrom
        : [...base.allowFrom, capturedId];
      return {
        ...base,
        dmPolicy: "allowlist",
        allowFrom: merged,
        primaryOperator: capturedId,
        addedAt: { ...base.addedAt, [capturedId]: nowIso },
        capturedAt: nowIso,
      };
    });
    return { status: "captured", capturedId, botUsername };
  } catch (err) {
    // Map every save error to a non-fatal CaptureResult; helper never throws,
    // so callers can surface a warning and continue starting the bot.
    if (err instanceof LockfileContentionError) {
      return {
        status: "lockfile-contention",
        botUsername,
        capturedId,
        reason: err.message,
      };
    }
    return {
      status: "write-failed",
      botUsername,
      capturedId,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
