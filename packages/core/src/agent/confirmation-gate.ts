import { msg, type Message, type CoachLanguage } from "@enduragent/i18n";
import { createPhrasebook, type Phrasebook } from "@enduragent/i18n/messages";
import { randomUUID } from "node:crypto";
import type { ToolConfirmationPort } from "@enduragent/engine";
import type { IntervalsClient } from "../intervals.js";
import {
  guardDeletableEvent,
  guardUpdatableEvent,
  toTypedError,
  type IntervalsEventRuntime,
} from "./event-guards.js";

export const GATED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "intervals_create_strength_workout",
  "intervals_create_workout",
  "intervals_delete_workout",
  "intervals_update_workout",
  "plan_save",
]);

export const PROPOSAL_TTL_MS = 10 * 60_000;

export interface PendingProposal {
  nonce: string;
  summary: string;
  summaryFor?: (book: Phrasebook) => string;
  expiresAt: number;
  run: () => Promise<unknown>;
}

export type ConfirmOutcome =
  | { status: "executed"; summary: string; result: unknown }
  | { status: "refused"; summary: string; message: string; result: unknown }
  | { status: "failed"; summary: string; message: string }
  | { status: "expired" }
  | { status: "mismatch" }
  | { status: "none" };

export function formatConfirmOutcome(outcome: ConfirmOutcome): Message {
  if (outcome.status === "executed")
    return msg("coach.confirmation.executed", { summary: outcome.summary });
  if (outcome.status === "refused")
    return msg("coach.confirmation.refused", { message: outcome.message });
  if (outcome.status === "failed")
    return msg("coach.confirmation.failed", { message: outcome.message });
  return msg("coach.confirmation.expired");
}

export class ConfirmationGate {
  private readonly proposals = new Map<string, PendingProposal>();

  constructor(private readonly now: () => number = Date.now) {}

  propose(
    chatId: string,
    summary: string,
    run: () => Promise<unknown>,
    summaryFor?: (book: Phrasebook) => string,
  ): void {
    this.proposals.set(chatId, {
      nonce: randomUUID(),
      summary,
      ...(summaryFor === undefined ? {} : { summaryFor }),
      expiresAt: this.now() + PROPOSAL_TTL_MS,
      run,
    });
  }

  private lookup(chatId: string): {
    proposal: PendingProposal | undefined;
    expired: boolean;
  } {
    const proposal = this.proposals.get(chatId);
    if (proposal === undefined) return { proposal: undefined, expired: false };
    if (proposal.expiresAt <= this.now()) {
      this.proposals.delete(chatId);
      return { proposal: undefined, expired: true };
    }
    return { proposal, expired: false };
  }

  peek(chatId: string, book?: Phrasebook): { nonce: string; summary: string } | undefined {
    const { proposal } = this.lookup(chatId);
    if (proposal === undefined) return undefined;
    return {
      nonce: proposal.nonce,
      summary:
        book === undefined ? proposal.summary : (proposal.summaryFor?.(book) ?? proposal.summary),
    };
  }

  async confirm(chatId: string, nonce: string, book?: Phrasebook): Promise<ConfirmOutcome> {
    const { proposal, expired } = this.lookup(chatId);
    if (proposal === undefined) return { status: expired ? "expired" : "none" };
    if (proposal.nonce !== nonce) return { status: "mismatch" };
    const summary =
      book === undefined ? proposal.summary : (proposal.summaryFor?.(book) ?? proposal.summary);
    this.proposals.delete(chatId);
    try {
      const result = await proposal.run();
      const error = stringField(result, "error");
      if (error !== undefined) {
        const details = stringField(result, "details");
        if (details !== undefined) {
          return { status: "refused", summary, message: details, result };
        }
        return {
          status: "failed",
          summary,
          message: stringField(result, "message") ?? error,
        };
      }
      return { status: "executed", summary, result };
    } catch (err) {
      return {
        status: "failed",
        summary,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  cancel(chatId: string, nonce: string): "canceled" | "mismatch" | "none" {
    const { proposal } = this.lookup(chatId);
    if (proposal === undefined) return "none";
    if (proposal.nonce !== nonce) return "mismatch";
    this.proposals.delete(chatId);
    return "canceled";
  }
}

export type Summarized =
  | { summary: Message | string; messageFor?: (book: Phrasebook) => Message }
  | { block: unknown };
export type ProposalSummarizer = (input: unknown, book?: Phrasebook) => Promise<Summarized>;

const english = createPhrasebook({ tag: "en", locale: "en-GB" });

function contextualSummary(
  book: Phrasebook,
  messageFor: (book: Phrasebook) => Message,
): Summarized {
  return { summary: messageFor(book), messageFor };
}

function proposalDate(date: string, book: Phrasebook): string {
  const value = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(value.getTime())) return date;
  if (book.tag === "en") {
    const year = book.format.date(value, { year: "numeric", timeZone: "UTC" });
    const month = book.format.date(value, { month: "2-digit", timeZone: "UTC" });
    const day = book.format.date(value, { day: "2-digit", timeZone: "UTC" });
    return `${year}-${month}-${day}`;
  }
  return book.format.date(value, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "UTC",
  });
}

function objectField(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  const field = objectField(value, key);
  return typeof field === "string" && field.trim() !== "" ? field : undefined;
}

export function createProposalSummarizers(opts: {
  intervals: IntervalsClient | null;
  tz: string;
}): Record<string, ProposalSummarizer> {
  return {
    intervals_create_workout: async (input, phrasebook) => {
      const book = phrasebook ?? (await english);
      if (opts.intervals === null) return { block: { error: "intervals_not_configured" } };
      const date = stringField(input, "date");
      const workout = objectField(input, "workout");
      const name = stringField(workout, "name");
      return contextualSummary(book, (book) =>
        date !== undefined && name !== undefined
          ? msg("coach.proposal.create", { name, date: proposalDate(date, book) })
          : msg("coach.proposal.createFallback"),
      );
    },
    intervals_create_strength_workout: async (input, phrasebook) => {
      const book = phrasebook ?? (await english);
      if (opts.intervals === null) return { block: { error: "intervals_not_configured" } };
      const name = stringField(input, "name");
      const date = stringField(input, "date");
      return contextualSummary(book, (book) =>
        name !== undefined && date !== undefined
          ? msg("coach.proposal.createStrength", { name, date: proposalDate(date, book) })
          : msg("coach.proposal.createStrengthFallback"),
      );
    },
    intervals_delete_workout: async (input, phrasebook) => {
      const book = phrasebook ?? (await english);
      if (opts.intervals === null) return { block: { error: "intervals_not_configured" } };
      const eventId = objectField(input, "eventId");
      if (typeof eventId !== "number") return { block: { error: "invalid_event_id" } };
      const fetched = await opts.intervals.events.get(eventId);
      if (!fetched.ok) return { block: toTypedError(fetched.error) };
      const event = fetched.value as unknown as IntervalsEventRuntime;
      const refusal = guardDeletableEvent(event, opts.tz, eventId);
      if (refusal !== undefined) return { block: refusal };
      const date = event.startDateLocal.slice(0, 10);
      return contextualSummary(book, (book) =>
        msg("coach.proposal.delete", {
          name: event.name ?? book.say("coach.proposal.unnamed"),
          date: proposalDate(date, book),
        }),
      );
    },
    intervals_update_workout: async (input, phrasebook) => {
      const book = phrasebook ?? (await english);
      if (opts.intervals === null) return { block: { error: "intervals_not_configured" } };
      const eventId = objectField(input, "eventId");
      if (typeof eventId !== "number") return { block: { error: "invalid_event_id" } };
      const changes = objectField(input, "changes");
      if (changes === null || typeof changes !== "object") {
        return { block: { error: "invalid_changes" } };
      }
      const date = stringField(changes, "date");
      const fetched = await opts.intervals.events.get(eventId);
      if (!fetched.ok) return { block: toTypedError(fetched.error) };
      const event = fetched.value as unknown as IntervalsEventRuntime;
      const refusal = guardUpdatableEvent(event, opts.tz, eventId, date);
      if (refusal !== undefined) return { block: refusal };
      return contextualSummary(book, (book) => {
        const fields: string[] = [];
        if (date !== undefined)
          fields.push(book.say("coach.proposal.date", { date: proposalDate(date, book) }));
        const name = stringField(changes, "name");
        if (name !== undefined) fields.push(book.say("coach.proposal.name", { name }));
        if (objectField(changes, "description") !== undefined)
          fields.push(book.say("coach.proposal.description"));
        const movingTime = objectField(changes, "movingTime");
        if (typeof movingTime === "number")
          fields.push(
            book.say("coach.proposal.duration", {
              count: movingTime,
              seconds: book.format.number(movingTime, { useGrouping: false }),
            }),
          );
        const trainingLoad = objectField(changes, "icuTrainingLoad");
        if (typeof trainingLoad === "number")
          fields.push(
            book.say("coach.proposal.trainingLoad", {
              load: book.format.number(trainingLoad, { useGrouping: false }),
            }),
          );
        if (objectField(changes, "workoutDoc") !== undefined)
          fields.push(book.say("coach.proposal.structure"));
        const eventDate = event.startDateLocal.slice(0, 10);
        const detail =
          fields.length === 0 ? book.say("coach.proposal.selectedFields") : fields.join(", ");
        return msg("coach.proposal.update", {
          name: event.name ?? book.say("coach.proposal.unnamed"),
          date: proposalDate(eventDate, book),
          detail,
        });
      });
    },
    plan_save: async (input) => {
      const plan = objectField(input, "plan");
      const detail = stringField(plan, "name") ?? stringField(plan, "goal");
      return {
        summary:
          detail === undefined
            ? msg("coach.proposal.savePlan")
            : msg("coach.proposal.savePlanDetail", { detail }),
      };
    },
  };
}

export function createToolConfirmationPort(opts: {
  gate: ConfirmationGate;
  language?: Pick<CoachLanguage, "phrasebookFor">;
  summarizers: Record<string, ProposalSummarizer>;
  prepareRun?: (name: string, run: () => Promise<unknown>) => () => Promise<unknown>;
  requiresConfirmation?: (input: { readonly chatId: string; readonly toolName: string }) => boolean;
}): ToolConfirmationPort {
  return {
    gatedToolNames: GATED_TOOL_NAMES,
    requiresConfirmation: opts.requiresConfirmation ?? (() => true),
    propose: async ({ chatId, toolName, toolInput, run }) => {
      const summarize = opts.summarizers[toolName];
      if (summarize === undefined) return { error: "confirmation_unavailable" };
      const book = await (opts.language?.phrasebookFor({ chatId }) ?? english);
      const summarized = await summarize(toolInput, book);
      if ("block" in summarized) return summarized.block;
      const summary =
        typeof summarized.summary === "string" ? summarized.summary : book.say(summarized.summary);
      opts.gate.propose(chatId, summary, opts.prepareRun?.(toolName, run) ?? run, (book) => {
        const message = summarized.messageFor?.(book) ?? summarized.summary;
        return typeof message === "string" ? message : book.say(message);
      });
      return { pendingConfirmation: true, summary };
    },
  };
}
