import { createPhrasebook } from "@enduragent/i18n/messages";
import type { CatalogKey, Message } from "@enduragent/i18n";
import { describe, expect, it, vi } from "vitest";
import { tool, zodSchema } from "ai";
import type { Tool } from "ai";
import { z } from "zod";
import type { IntervalsClient } from "intervals-icu-api";
import {
  ConfirmationGate,
  GATED_TOOL_NAMES,
  PROPOSAL_TTL_MS,
  createProposalSummarizers as createProposalMessages,
  createToolConfirmationPort,
  formatConfirmOutcome as confirmOutcomeMessage,
} from "../src/agent/confirmation-gate.js";

import type { ProposalSummarizer } from "../src/agent/confirmation-gate.js";
import { READ_ONLY_TOOL_NAMES } from "../../engine/src/agent/read-memoizer.js";
import { gateMutatingTool } from "../../engine/src/agent/coach-agent.js";
import { createTurnContext } from "../../engine/src/agent/turn-context.js";
import { createPureCoreIntervalsTools } from "../src/sport.js";
import { createPlatformCalendarMutations } from "../src/athlete-data.js";
import { COACH_EVENT_TAG } from "../src/agent/event-provenance.js";

const book = await createPhrasebook({ tag: "en", locale: "en-GB" });

function formatConfirmOutcome(outcome: Parameters<typeof confirmOutcomeMessage>[0]): string {
  return book.say(confirmOutcomeMessage(outcome));
}

function createProposalSummarizers(
  input: Parameters<typeof createProposalMessages>[0],
): Record<string, (input: unknown) => Promise<{ summary: string } | { block: unknown }>> {
  return Object.fromEntries(
    Object.entries(createProposalMessages(input)).map(([key, summarize]) => [
      key,
      async (value: unknown) => {
        const result = await summarize(value, book);
        return "summary" in result
          ? {
              summary:
                typeof result.summary === "string" ? result.summary : book.say(result.summary),
            }
          : result;
      },
    ]),
  );
}

function fakeTool(execute: (input: unknown) => unknown): Tool {
  return tool({ inputSchema: zodSchema(z.object({}).passthrough()), execute });
}

function turnOptions(chatId: string): unknown {
  return {
    experimental_context: createTurnContext({
      resolvedCs: null,
      chatId,
      language: { language: "en", source: "default", locale: "en-GB" },
    }),
  };
}

function port(gate: ConfirmationGate, summarizers: Record<string, ProposalSummarizer>) {
  return createToolConfirmationPort({ gate, summarizers });
}

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 42,
    name: "Fetched truth",
    category: "WORKOUT",
    startDateLocal: "2999-01-02T00:00:00",
    tags: [COACH_EVENT_TAG],
    ...overrides,
  };
}

function fakeIntervals(initial = event()): {
  client: IntervalsClient;
  setEvent: (next: Record<string, unknown>) => void;
  gets: ReturnType<typeof vi.fn>;
  updates: ReturnType<typeof vi.fn>;
  deletes: ReturnType<typeof vi.fn>;
} {
  let current = initial;
  const gets = vi.fn(async () => ({ ok: true, value: current }));
  const updates = vi.fn(async () => ({ ok: true, value: current }));
  const deletes = vi.fn(async () => ({ ok: true, value: undefined }));
  return {
    client: {
      events: { get: gets, update: updates, delete: deletes },
    } as unknown as IntervalsClient,
    setEvent: (next) => {
      current = next;
    },
    gets,
    updates,
    deletes,
  };
}

describe("ConfirmationGate", () => {
  it.each([
    [{ error: "NotFound", message: "Workout no longer exists." }, "Workout no longer exists."],
    [{ error: "platform_credentials_required" }, "platform_credentials_required"],
  ])("reports a returned failure without claiming success", async (result, message) => {
    const gate = new ConfirmationGate();
    gate.propose("chat", "Update workout", async () => result);
    const proposal = gate.peek("chat")!;
    const outcome = await gate.confirm("chat", proposal.nonce);
    expect(outcome).toEqual({ status: "failed", summary: "Update workout", message });
    expect(formatConfirmOutcome(outcome)).not.toContain("Done");
    expect(await gate.confirm("chat", proposal.nonce)).toEqual({ status: "none" });
  });

  it("stores, replaces, confirms once, and rejects mismatches", async () => {
    const gate = new ConfirmationGate();
    const firstRun = vi.fn(async () => "first");
    gate.propose("chat", "first summary", firstRun);
    const first = gate.peek("chat")!;
    expect(first.summary).toBe("first summary");

    const secondRun = vi.fn(async () => ({ ok: true }));
    gate.propose("chat", "second summary", secondRun);
    const second = gate.peek("chat")!;
    expect(second.nonce).not.toBe(first.nonce);
    expect(await gate.confirm("chat", first.nonce)).toEqual({ status: "mismatch" });
    expect(firstRun).not.toHaveBeenCalled();
    expect(await gate.confirm("chat", second.nonce)).toEqual({
      status: "executed",
      summary: "second summary",
      result: { ok: true },
    });
    expect(secondRun).toHaveBeenCalledTimes(1);
    expect(await gate.confirm("chat", second.nonce)).toEqual({ status: "none" });
  });

  it("expires lazily at the TTL", async () => {
    let now = 100;
    const gate = new ConfirmationGate(() => now);
    gate.propose("chat", "summary", async () => true);
    const nonce = gate.peek("chat")!.nonce;
    now += PROPOSAL_TTL_MS;
    expect(gate.peek("chat")).toBeUndefined();
    expect(await gate.confirm("chat", nonce)).toEqual({ status: "none" });
  });

  it("reports expired when confirm performs the lazy prune", async () => {
    let now = 0;
    const gate = new ConfirmationGate(() => now);
    gate.propose("chat", "summary", async () => true);
    const nonce = gate.peek("chat")!.nonce;
    now = PROPOSAL_TTL_MS;
    expect(await gate.confirm("chat", nonce)).toEqual({ status: "expired" });
  });

  it("consumes before awaiting and consumes failed runs", async () => {
    const gate = new ConfirmationGate();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    gate.propose("chat", "held", async () => {
      await held;
      return "done";
    });
    const nonce = gate.peek("chat")!.nonce;
    const first = gate.confirm("chat", nonce);
    expect(await gate.confirm("chat", nonce)).toEqual({ status: "none" });
    release();
    await expect(first).resolves.toMatchObject({ status: "executed", result: "done" });

    gate.propose("chat", "fails", async () => {
      throw new Error("server refused");
    });
    const failedNonce = gate.peek("chat")!.nonce;
    expect(await gate.confirm("chat", failedNonce)).toEqual({
      status: "failed",
      summary: "fails",
      message: "server refused",
    });
    expect(await gate.confirm("chat", failedNonce)).toEqual({ status: "none" });
  });

  it("cancels only the matching proposal", () => {
    const gate = new ConfirmationGate();
    expect(gate.cancel("chat", "x")).toBe("none");
    gate.propose("chat", "summary", async () => true);
    const nonce = gate.peek("chat")!.nonce;
    expect(gate.cancel("chat", "wrong")).toBe("mismatch");
    expect(gate.peek("chat")).toBeDefined();
    expect(gate.cancel("chat", nonce)).toBe("canceled");
    expect(gate.cancel("chat", nonce)).toBe("none");
  });
});

describe("gateMutatingTool", () => {
  it("passes non-gated tools through by reference", () => {
    const inner = fakeTool(async () => true);
    expect(gateMutatingTool("memory_write", inner, port(new ConfirmationGate(), {}))).toBe(inner);
  });

  it("passes every tool through when the host declares no confirmation port", () => {
    const inner = fakeTool(async () => true);
    expect(gateMutatingTool("plan_save", inner, undefined)).toBe(inner);
  });

  it("proposes without executing and returns only the model-safe shape", async () => {
    const execute = vi.fn(async () => ({ saved: true }));
    const gate = new ConfirmationGate();
    const wrapped = gateMutatingTool(
      "plan_save",
      fakeTool(execute),
      port(gate, { plan_save: async () => ({ summary: "Save plan" }) }),
    );
    const result = (await wrapped.execute!({}, turnOptions("chat") as never)) as Record<
      string,
      unknown
    >;
    expect(result).toEqual({ pendingConfirmation: true, summary: "Save plan" });
    expect(Object.keys(result)).toEqual(["pendingConfirmation", "summary"]);
    expect(execute).not.toHaveBeenCalled();
    const proposal = gate.peek("chat")!;
    expect(await gate.confirm("chat", proposal.nonce)).toMatchObject({ status: "executed" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("executes directly when trusted ingress policy does not require confirmation", async () => {
    const result = { saved: true };
    const execute = vi.fn(async () => result);
    const gate = new ConfirmationGate();
    const confirmations = createToolConfirmationPort({
      gate,
      summarizers: { plan_save: async () => ({ summary: "Save plan" }) },
      requiresConfirmation: ({ chatId }) => chatId.startsWith("telegram:"),
    });
    const wrapped = gateMutatingTool("plan_save", fakeTool(execute), confirmations);

    await expect(wrapped.execute!({}, turnOptions("desktop") as never)).resolves.toBe(result);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(gate.peek("desktop")).toBeUndefined();
  });

  it("fails closed without chat context and passes blocks through verbatim", async () => {
    const execute = vi.fn();
    const gate = new ConfirmationGate();
    const summarizers: Record<string, ProposalSummarizer> = {
      plan_save: async () => ({ summary: "Save" }),
    };
    const unavailable = gateMutatingTool("plan_save", fakeTool(execute), port(gate, summarizers));
    expect(await unavailable.execute!({}, {} as never)).toEqual({
      error: "confirmation_unavailable",
    });
    expect(await unavailable.execute!({}, turnOptions("") as never)).toEqual({
      error: "confirmation_unavailable",
    });

    const missingSummarizer = gateMutatingTool("plan_save", fakeTool(execute), port(gate, {}));
    expect(await missingSummarizer.execute!({}, turnOptions("chat") as never)).toEqual({
      error: "confirmation_unavailable",
    });

    const block = { error: "past_workout_protected", details: "past" };
    const blocked = gateMutatingTool(
      "intervals_delete_workout",
      fakeTool(execute),
      port(gate, { intervals_delete_workout: async () => ({ block }) }),
    );
    expect(await blocked.execute!({}, turnOptions("chat") as never)).toBe(block);
    expect(gate.peek("chat")).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("proposal summarizers and guard reuse", () => {
  it("uses create input truth, falls back safely, and summarizes plans", async () => {
    const { client } = fakeIntervals();
    const summarizers = createProposalSummarizers({ intervals: client, tz: "UTC" });
    await expect(
      summarizers.intervals_create_workout!({
        date: "2030-04-05",
        workout: { name: "Tempo build" },
      }),
    ).resolves.toEqual({ summary: 'Create workout "Tempo build" on 2030-04-05' });
    await expect(summarizers.intervals_create_workout!({})).resolves.toEqual({
      summary: "Create a workout",
    });
    await expect(
      summarizers.intervals_create_strength_workout!({
        date: "2030-04-06",
        name: "Lower body 45min",
      }),
    ).resolves.toEqual({
      summary: 'Create strength workout "Lower body 45min" on 2030-04-06',
    });
    await expect(summarizers.intervals_create_strength_workout!({})).resolves.toEqual({
      summary: "Create a strength workout",
    });
    await expect(summarizers.plan_save!({ plan: {} })).resolves.toEqual({
      summary: "Save the training plan — replaces the current saved plan",
    });
    await expect(summarizers.plan_save!({ plan: { name: "Base block" } })).resolves.toEqual({
      summary: "Save the training plan — replaces the current saved plan — Base block",
    });
  });

  it("host-fetches delete truth and mirrors all refusals in guard order", async () => {
    const fake = fakeIntervals();
    const summarize = createProposalSummarizers({
      intervals: fake.client,
      tz: "UTC",
    }).intervals_delete_workout!;
    await expect(summarize({ eventId: 42, narrative: "delete something else" })).resolves.toEqual({
      summary: 'Delete workout "Fetched truth" on 2999-01-02',
    });

    fake.setEvent(event({ category: "RACE_A", startDateLocal: "2000-01-01T00:00:00" }));
    await expect(summarize({ eventId: 42 })).resolves.toMatchObject({
      block: { error: "not_a_workout" },
    });
    fake.setEvent(event({ category: "NOTE", startDateLocal: "2000-01-01T00:00:00" }));
    await expect(summarize({ eventId: 42 })).resolves.toMatchObject({
      block: { error: "not_a_workout" },
    });
    fake.setEvent(event({ tags: [] }));
    await expect(summarize({ eventId: 42 })).resolves.toMatchObject({
      block: { error: "not_coach_created" },
    });
    fake.setEvent(event({ startDateLocal: "2000-01-01T00:00:00" }));
    await expect(summarize({ eventId: 42 })).resolves.toMatchObject({
      block: { error: "past_workout_protected" },
    });
  });

  it("host-fetches update truth and summarizes only the requested changes", async () => {
    const fake = fakeIntervals();
    const summarize = createProposalSummarizers({
      intervals: fake.client,
      tz: "UTC",
    }).intervals_update_workout!;
    await expect(
      summarize({
        eventId: 42,
        changes: {
          date: "2999-01-04",
          name: "Tempo build",
          description: "Structured workout",
          movingTime: 4_500,
          icuTrainingLoad: 78,
          workoutDoc: { steps: [] },
        },
      }),
    ).resolves.toEqual({
      summary:
        'Update workout "Fetched truth" on 2999-01-02 — date to 2999-01-04, name to "Tempo build", description, duration to 4500 seconds, training load to 78, workout structure',
    });

    fake.setEvent(event({ tags: [] }));
    await expect(summarize({ eventId: 42, changes: { name: "Blocked" } })).resolves.toMatchObject({
      block: { error: "not_coach_created" },
    });
    expect(fake.updates).not.toHaveBeenCalled();
  });

  it("passes fetch failures through as typed blocks", async () => {
    const client = {
      events: {
        get: vi.fn(async () => ({
          ok: false,
          error: { kind: "NotFound", status: 404, message: "missing" },
        })),
      },
    } as unknown as IntervalsClient;
    const summarize = createProposalSummarizers({
      intervals: client,
      tz: "UTC",
    }).intervals_delete_workout!;
    await expect(summarize({ eventId: 1 })).resolves.toEqual({
      block: { error: "NotFound", status: 404, message: "missing" },
    });
  });

  it("re-fetches and re-guards when a confirmed delete runs", async () => {
    const fake = fakeIntervals();
    const raw = createPureCoreIntervalsTools(
      fake.client,
      "UTC",
      undefined,
      createPlatformCalendarMutations(fake.client),
    ).intervals_delete_workout!;
    const gate = new ConfirmationGate();
    const wrapped = gateMutatingTool(
      "intervals_delete_workout",
      raw,
      port(gate, createProposalSummarizers({ intervals: fake.client, tz: "UTC" })),
    );
    await wrapped.execute!({ eventId: 42 }, turnOptions("chat") as never);
    const proposal = gate.peek("chat")!;
    fake.setEvent(event({ category: "NOTE" }));
    const outcome = await gate.confirm("chat", proposal.nonce);
    expect(outcome).toMatchObject({
      status: "refused",
      result: { error: "not_a_workout" },
    });
    expect(formatConfirmOutcome(outcome)).toContain("Nothing was changed");
    expect(formatConfirmOutcome(outcome)).not.toContain("Done");
    expect(await gate.confirm("chat", proposal.nonce)).toEqual({ status: "none" });
    expect(fake.gets).toHaveBeenCalledTimes(2);
    expect(fake.deletes).not.toHaveBeenCalled();
  });

  it("re-fetches and re-guards when a confirmed update runs", async () => {
    const fake = fakeIntervals();
    const raw = createPureCoreIntervalsTools(
      fake.client,
      "UTC",
      undefined,
      createPlatformCalendarMutations(fake.client),
    ).intervals_update_workout!;
    const gate = new ConfirmationGate();
    const wrapped = gateMutatingTool(
      "intervals_update_workout",
      raw,
      port(gate, createProposalSummarizers({ intervals: fake.client, tz: "UTC" })),
    );
    await wrapped.execute!(
      { eventId: 42, changes: { name: "Tempo build" } },
      turnOptions("chat") as never,
    );
    const proposal = gate.peek("chat")!;
    fake.setEvent(event({ category: "NOTE" }));
    const outcome = await gate.confirm("chat", proposal.nonce);
    expect(outcome).toMatchObject({
      status: "refused",
      result: { error: "not_a_workout" },
    });
    expect(formatConfirmOutcome(outcome)).toContain("Nothing was changed");
    expect(formatConfirmOutcome(outcome)).not.toContain("Done");
    expect(await gate.confirm("chat", proposal.nonce)).toEqual({ status: "none" });
    expect(fake.gets).toHaveBeenCalledTimes(2);
    expect(fake.updates).not.toHaveBeenCalled();
  });

  it("keeps gate and read allowlists exact and disjoint", () => {
    expect([...GATED_TOOL_NAMES].sort()).toEqual([
      "intervals_create_strength_workout",
      "intervals_create_workout",
      "intervals_delete_workout",
      "intervals_update_workout",
      "plan_save",
    ]);
    expect([...READ_ONLY_TOOL_NAMES].filter((name) => GATED_TOOL_NAMES.has(name))).toEqual([]);
  });
});

it("returns descriptors for confirmation outcomes and built-in proposals", async () => {
  expect(confirmOutcomeMessage({ status: "expired" })).toEqual({
    key: "coach.confirmation.expired",
  });
  const messages = createProposalMessages({ intervals: null, tz: "UTC" });
  expect(await messages.plan_save!({ plan: {} }, book)).toEqual({
    summary: { key: "coach.proposal.savePlan" },
  });
});

it("renders a stored proposal in the incoming phrasebook without fetching its truth again", async () => {
  const fake = fakeIntervals();
  const gate = new ConfirmationGate();
  const confirmations = createToolConfirmationPort({
    gate,
    summarizers: createProposalMessages({ intervals: fake.client, tz: "UTC" }),
  });
  await confirmations.propose({
    chatId: "chat",
    toolName: "intervals_update_workout",
    toolInput: { eventId: 42, changes: { name: "Tempo" } },
    run: async () => true,
  });
  const say: typeof book.say = (message: Message | CatalogKey, vars?: Message["vars"]) =>
    `IT:${typeof message === "string" ? book.say(message, vars) : book.say(message)}`;
  const incomingBook = { ...book, say };
  const pending = gate.peek("chat", incomingBook)!;
  expect(pending.summary).toBe(
    'IT:Update workout "Fetched truth" on 2999-01-02 — IT:name to "Tempo"',
  );
  const outcome = await gate.confirm("chat", pending.nonce, incomingBook);
  expect(outcome).toMatchObject({ status: "executed", summary: pending.summary });
  expect(fake.gets).toHaveBeenCalledTimes(1);
});
