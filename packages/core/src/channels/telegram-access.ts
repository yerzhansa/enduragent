import { say } from "../cli-copy.js";
import { msg, normalizeLocaleHint, type CoachLanguage } from "@enduragent/i18n";
import type { Phrasebook } from "@enduragent/i18n/messages";
import { createNpmCoachLanguage } from "../language-preference.js";
import type { Context, MiddlewareFn } from "grammy";
import { loadAllowedSenders, SENDER_ID_RE, type AllowedSenders } from "./allowed-senders.js";
import { escapeHtmlAttr, escapeHtmlText } from "./html-escape.js";

export type { DmPolicy } from "./allowed-senders.js";

export interface AuthDecision {
  allow: boolean;
  viaOpenPolicy?: boolean;
  pairingChallenge?: string;
}

export function buildPairingChallenge(
  senderId: string | number,
  senderName: string | undefined,
  binaryName: string,
  book: Phrasebook,
): string {
  const idStr = String(senderId);
  const safeBin = escapeHtmlAttr(binaryName);
  // Include the literal CLI command for the operator AND the "ask the bot owner"
  // fallback. Operators copy-paste from their own message to authorize themselves;
  // strangers see they cannot self-authorize.
  return [
    `<b>${escapeHtmlText(book.say(msg("telegram.pairing.private")))}</b>`,
    ``,
    `${escapeHtmlAttr(book.say(msg("telegram.pairing.identity", { service: "Telegram", name: senderName || book.say(msg("telegram.pairing.unnamed")) })))} <code>${escapeHtmlAttr(idStr)}</code>.`,
    ``,
    `<b>${escapeHtmlText(book.say(msg("telegram.pairing.owner")))}</b> ${escapeHtmlText(book.say(msg("telegram.pairing.run")))}`,
    `<pre>${safeBin} add-sender ${escapeHtmlAttr(idStr)}</pre>`,
    escapeHtmlText(book.say(msg("telegram.pairing.shell"))),
    ``,
    escapeHtmlText(book.say(msg("telegram.pairing.askOwner"))),
  ].join("\n");
}

export function evaluateAccess(ctx: Context, allowed: AllowedSenders): AuthDecision {
  if (ctx.chat?.type !== "private") return { allow: false };
  const fromId = ctx.from?.id;
  if (fromId === undefined) return { allow: false };
  if (typeof fromId !== "number") return { allow: false };

  const senderId = String(fromId);
  if (allowed.allowFrom.includes(senderId)) return { allow: true };
  if (allowed.dmPolicy === "open") return { allow: true, viaOpenPolicy: true };

  // Sender not allowlisted. Pairing mode → return challenge; allowlist → silent drop.
  if (allowed.dmPolicy === "pairing") {
    // Challenge body is constructed by the caller (createAuthMiddleware) so it can
    // pass through binaryName / senderName / HTML escaping.
    return { allow: false, pairingChallenge: senderId };
  }
  return { allow: false };
}

export interface CreateAuthMiddlewareOpts {
  dataDir: string;
  language?: CoachLanguage;
  binaryName: string;
  challengeRateLimit: Map<string, number>;
  challengeMinIntervalMs: number;
  loadAllowedSenders?: (dataDir: string) => AllowedSenders;
  pairingChallenge?: (input: {
    readonly senderId: string;
    readonly senderName: string | undefined;
    readonly phrasebook: Phrasebook;
  }) => string;
  consumePairing?: (input: {
    readonly senderId: string;
    readonly senderName: string | undefined;
    readonly messageText: string;
  }) => Promise<boolean>;
}

const RATE_LIMIT_MAX_ENTRIES = 1000;

function recordChallenge(map: Map<string, number>, senderId: string, now: number): void {
  if (map.has(senderId)) map.delete(senderId); // bump to MRU position
  map.set(senderId, now);
  while (map.size > RATE_LIMIT_MAX_ENTRIES) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

function warnOpenPolicyServe(warned: Set<string>, fromId: number | undefined): void {
  if (fromId === undefined) return;
  const senderId = String(fromId);
  if (warned.has(senderId)) return;
  warned.add(senderId);
  while (warned.size > RATE_LIMIT_MAX_ENTRIES) {
    const oldestKey = warned.keys().next().value;
    if (oldestKey === undefined) break;
    warned.delete(oldestKey);
  }
  console.error(say("telegram.security.serving", { senderId }));
}

export function createAuthMiddleware(opts: CreateAuthMiddlewareOpts): MiddlewareFn<Context> {
  const openPolicyWarned = new Set<string>();
  const language = opts.language ?? createNpmCoachLanguage(opts.dataDir);
  return async (ctx, next) => {
    // Auth decision (allowlist load, evaluateAccess, pairing-challenge reply) is
    // the only logic guarded here, and it fails CLOSED. next() runs OUTSIDE the
    // guard so a downstream handler throw propagates to bot.catch instead of
    // being mislabeled a security error and silently dropped.
    let granted = false;
    try {
      const fromId = ctx.from?.id;
      const messageText = ctx.message?.text;
      if (
        opts.consumePairing &&
        ctx.chat?.type === "private" &&
        typeof fromId === "number" &&
        SENDER_ID_RE.test(String(fromId)) &&
        typeof messageText === "string"
      ) {
        const consumed = await opts.consumePairing({
          senderId: String(fromId),
          senderName: ctx.from?.first_name,
          messageText,
        });
        if (consumed) return;
      }

      const allowed = (opts.loadAllowedSenders ?? loadAllowedSenders)(opts.dataDir);
      const decision = evaluateAccess(ctx, allowed);
      if (decision.allow) {
        if (decision.viaOpenPolicy) warnOpenPolicyServe(openPolicyWarned, ctx.from?.id);
        granted = true;
      } else if (decision.pairingChallenge) {
        // Drop. Optionally reply with pairing-challenge (rate-limited per-sender).
        const senderId = decision.pairingChallenge;
        const now = Date.now();
        const last = opts.challengeRateLimit.get(senderId) ?? 0;
        if (now - last < opts.challengeMinIntervalMs) return;
        recordChallenge(opts.challengeRateLimit, senderId, now);
        const phrasebook = await language.phrasebookFor({
          chatId: `telegram:${ctx.chat?.id}`,
          athleteText: messageText,
          ...(ctx.from?.language_code === undefined
            ? {}
            : {
                surfaceHint: {
                  language: normalizeLocaleHint(ctx.from.language_code),
                  locale: ctx.from.language_code,
                },
              }),
        });
        const html =
          opts.pairingChallenge?.({ senderId, senderName: ctx.from?.first_name, phrasebook }) ??
          buildPairingChallenge(senderId, ctx.from?.first_name, opts.binaryName, phrasebook);
        await ctx.reply(html, { parse_mode: "HTML" });
      }
    } catch (err) {
      // Fail closed: log to stderr, drop the update without calling next().
      console.error(
        say("telegram.security.middlewareError", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return;
    }
    if (granted) await next();
  };
}
