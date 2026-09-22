import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoachAgent } from "../src/agent/coach-agent.js";
import { TURN_WALL_CLOCK_MS } from "../src/agent/turn-budget.js";
import { getTurnContext } from "../src/agent/turn-context.js";
import { buildCoachMcpToolDefinitions } from "../src/agent/codex-agent/mcp-endpoint.js";
import type { EngineHostPorts } from "../src/host-ports.js";
import type { GenerateOptions, GenerateResult, Sport } from "../src/sport.js";
import type { TurnEvent } from "@enduragent/coach-contract";
import type {
  PendingWorkoutSet,
  Preparation,
  WorkoutPreparationPort,
} from "../src/workout-change-sets.js";
import { baseAgentConfig } from "./helpers/base-agent-config.js";

const roots: string[] = [];
const directNames = [
  "intervals_create_workout",
  "intervals_create_strength_workout",
  "intervals_update_workout",
  "intervals_delete_workout",
];
const proposal: Preparation = { kind: "complete", changes: [{ kind: "delete", eventId: 101 }] };
const inputSchema = z.object({ fail: z.boolean().optional(), incomplete: z.boolean().optional() });

function fixture(
  input: {
    run?: (options: GenerateOptions, call: number) => Promise<void>;
    responses?: readonly string[];
    respond?: (options: GenerateOptions, call: number) => string | Promise<string>;
    streamText?: boolean;
    finishReason?: GenerateResult["finishReason"];
    finishReasons?: readonly GenerateResult["finishReason"][];
    hostOptIn?: boolean;
    sportOptIn?: boolean;
    confirmations?: EngineHostPorts["toolConfirmations"];
    replacedTools?: readonly string[];
    unrelatedTool?: () => unknown | Promise<unknown>;
    now?: EngineHostPorts["now"];
    pending?: PendingWorkoutSet;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "workout-host-"));
  roots.push(root);
  mkdirSync(join(root, "memory"));
  const prepare = vi.fn<WorkoutPreparationPort["prepare"]>(async () => ({
    kind: "prepared",
    changeCount: 1,
  }));
  const settleTurn = vi.fn<WorkoutPreparationPort["settleTurn"]>(async () => undefined);
  const readPending = vi.fn<WorkoutPreparationPort["readPending"]>(
    async () => input.pending ?? { kind: "none" },
  );
  const mutate = vi.fn(async () => ({ created: true }));
  const sport: Sport = {
    id: "cycling",
    soul: "",
    skills: {},
    sessionClusterGapMinutes: 30,
    memorySections: [],
    mustPreserveTokens: [],
    intervalsActivityTypes: ["Ride"],
    athleteProfileSchema: z.object({}),
    tools: () => [
      ...(input.unrelatedTool === undefined
        ? []
        : [
            {
              name: "training_metrics_read",
              description: "training_metrics_read",
              inputSchema,
              tool: tool({ inputSchema, execute: input.unrelatedTool }),
            },
          ]),
      ...[...(input.replacedTools ?? directNames), "plan_save"].map((name) => ({
        name,
        description: name,
        inputSchema,
        tool: tool({
          inputSchema,
          execute: async () => {
            const result = await mutate();
            return name === "plan_save" ? { saved: true } : result;
          },
        }),
      })),
    ],
    ...(input.sportOptIn === false
      ? {}
      : {
          workoutPreparation: {
            version: "aggregate-v1",
            replacesTools: input.replacedTools ?? directNames,
            createTool: (submit) => ({
              name: "prepare_workout_changes",
              description: "Prepare",
              inputSchema,
              tool: tool({
                inputSchema,
                execute: async (args, options) => {
                  if (args.fail) throw new Error("Invalid entire proposal");
                  return submit(
                    args.incomplete ? { kind: "incomplete", reason: "Missing workouts" } : proposal,
                    options,
                  );
                },
              }),
            }),
          },
        }),
  };
  let captured: GenerateOptions | undefined;
  const chatCalls: GenerateOptions[] = [];
  let names: readonly string[] = [];
  const base = baseAgentConfig(root);
  const ports: EngineHostPorts = {
    ...base,
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.hostOptIn === false
      ? {}
      : { workoutPreparation: { prepare, settleTurn, readPending } }),
    toolConfirmations: input.confirmations,
    onToolsAssembled: (value) => {
      names = value;
    },
    modelTransportDecorator: () => ({
      generate: async (request) => {
        if (request.options.caller === "chat") {
          chatCalls.push(request.options);
          if (request.options.tools !== undefined) {
            captured = request.options;
            await input.run?.(request.options, chatCalls.length);
          }
        }
        const responseText =
          (await input.respond?.(request.options, chatCalls.length)) ??
          input.responses?.[chatCalls.length - 1] ??
          (request.options.tools === undefined ? "no_preparation_required" : "Review prepared.");
        if (input.streamText === true) request.options.onTextDelta?.(responseText);
        return {
          text: responseText,
          toolCalls: [],
          finishReason: input.finishReasons?.[chatCalls.length - 1] ?? input.finishReason ?? "stop",
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
            outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
          },
          steps: 1,
        };
      },
    }),
  };
  const agent = new CoachAgent(sport, ports);
  return {
    agent,
    prepare,
    settleTurn,
    readPending,
    mutate,
    names,
    chatCalls,
    chatStore: base.chatStore,
    captured: () => captured,
  };
}

async function call(
  options: GenerateOptions,
  args: unknown = {},
  name = "prepare_workout_changes",
) {
  const execute = options.tools?.[name]?.execute;
  if (execute === undefined) throw new Error(`Missing tool ${name}`);
  return execute(args, {
    toolCallId: "test-call",
    messages: [],
    experimental_context: options.context,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("workout preparation at the Engine host boundary", () => {
  it("checks and retries once when the reply claims an unsubmitted review", async () => {
    const value = fixture({
      responses: [
        "Your workout review is prepared.",
        "requires_preparation",
        "Your corrected workout review is prepared.",
      ],
      run: async (options, callNumber) => {
        if (callNumber === 3) await call(options);
      },
    });

    await expect(value.agent.chat("chat-1", "Add an easy ride tomorrow")).resolves.toBe(
      "Your corrected workout review is prepared.",
    );
    expect(value.chatCalls).toHaveLength(3);
    expect(value.prepare).toHaveBeenCalledTimes(1);
    expect(value.settleTurn).toHaveBeenCalledWith(expect.objectContaining({ outcome: "commit" }));
  });

  it("returns and persists an honest failure when the corrective reply still submits nothing", async () => {
    const events: TurnEvent[] = [];
    const value = fixture({
      responses: [
        "Your workout review is ready.",
        "requires_preparation",
        "Your workout review is definitely ready.",
      ],
      streamText: true,
    });

    await expect(
      value.agent.chat("chat-1", "Add an easy ride tomorrow", undefined, (event) =>
        events.push(event),
      ),
    ).resolves.toBe("I couldn't prepare this workout review. No changes were applied.");

    expect(value.chatCalls).toHaveLength(3);
    expect(value.prepare).not.toHaveBeenCalled();
    const delivered = events.flatMap((event) => {
      if (event.type === "text_delta") return [event.delta];
      return event.type === "final-text" ? [event.text] : [];
    });
    expect(delivered).toEqual([
      "I couldn't prepare this workout review. No changes were applied.",
      "I couldn't prepare this workout review. No changes were applied.",
    ]);
    const stored = JSON.stringify(value.chatStore.load("chat-1").messages);
    expect(stored).toContain("I couldn't prepare this workout review");
    expect(stored).not.toContain("review is ready");
    expect(stored).not.toContain("definitely ready");
  });

  it("reports saved information separately when workout verification fails after a plan save", async () => {
    const value = fixture({
      responses: ["Your workout review is ready.", "requires_preparation"],
      run: async (options, callNumber) => {
        if (callNumber === 1) await call(options, {}, "plan_save");
      },
    });

    await expect(value.agent.chat("chat-1", "Save my plan and add an easy ride")).resolves.toBe(
      "I saved your information, but I couldn't prepare the workout review.",
    );
    expect(value.chatCalls).toHaveLength(2);
    expect(value.chatCalls[1]?.tools).toBeUndefined();
    expect(value.mutate).toHaveBeenCalledTimes(1);
    expect(value.prepare).not.toHaveBeenCalled();
    const stored = JSON.stringify(value.chatStore.load("chat-1").messages);
    expect(stored).toContain("I saved your information");
    expect(stored).not.toContain("workout review is ready");
  });

  it.each([
    {
      failure: "malformed assessment output",
      responses: ["Your workout review is ready.", "maybe"] as const,
    },
    {
      failure: "an assessment provider error",
      respond: (_options: GenerateOptions, callNumber: number) => {
        if (callNumber === 2) throw new Error("assessment unavailable");
        return "Your workout review is ready.";
      },
    },
  ])("discloses a saved write when verification fails after $failure", async ({ responses, respond }) => {
    const value = fixture({
      responses,
      respond,
      run: async (options, callNumber) => {
        if (callNumber === 1) await call(options, {}, "plan_save");
      },
    });

    await expect(value.agent.chat("chat-1", "Save my plan and add an easy ride")).resolves.toBe(
      "I saved your information, but couldn't verify my response. Please try again.",
    );
    expect(value.chatCalls).toHaveLength(2);
    expect(value.mutate).toHaveBeenCalledTimes(1);
    expect(value.prepare).not.toHaveBeenCalled();
    expect(value.settleTurn).toHaveBeenCalledWith(expect.objectContaining({ outcome: "abandon" }));
    const stored = JSON.stringify(value.chatStore.load("chat-1").messages);
    expect(stored).toContain("I saved your information, but couldn't verify my response");
    expect(stored).not.toContain("workout review is ready");
    expect(stored).not.toContain("couldn't prepare the workout review");
  });

  it.each(["length", "tool-calls"] satisfies GenerateResult["finishReason"][])(
    "uses tool-free summary recovery for empty %s advice",
    async (finishReason) => {
      const value = fixture({
        responses: [
          "",
          "no_preparation_required",
          "Keep the ride conversational and finish with easy spinning.",
          "no_preparation_required",
        ],
        finishReasons: [finishReason, "stop", "stop", "stop"],
      });

      await expect(value.agent.chat("chat-1", "How should I pace this ride?")).resolves.toBe(
        "Keep the ride conversational and finish with easy spinning.",
      );
      expect(value.chatCalls).toHaveLength(4);
      expect(value.chatCalls[1]?.tools).toBeUndefined();
      expect(value.chatCalls[2]?.tools).toBeUndefined();
      expect(value.chatCalls[3]?.tools).toBeUndefined();
      expect(value.chatCalls[2]?.messages?.at(-1)).toEqual({
        role: "user",
        content:
          "Answer the athlete's latest request directly. Do not recap earlier conversation, infer pending approvals, or claim that you took any action. No tools are available for this response.",
      });
      expect(value.prepare).not.toHaveBeenCalled();
    },
  );

  it("uses the generic protocol failure when recovered advice cannot be verified", async () => {
    const recoveredAdvice = "Keep the ride conversational and finish with easy spinning.";
    const value = fixture({
      responses: ["", "no_preparation_required", recoveredAdvice, "maybe"],
      finishReasons: ["tool-calls", "stop", "stop", "stop"],
    });

    await expect(value.agent.chat("chat-1", "How should I pace this ride?")).resolves.toBe(
      "The coaching response could not be verified. Please try again.",
    );
    expect(value.chatCalls).toHaveLength(4);
    expect(value.prepare).not.toHaveBeenCalled();
    expect(value.mutate).not.toHaveBeenCalled();
    expect(value.settleTurn).toHaveBeenCalledWith(expect.objectContaining({ outcome: "abandon" }));
    expect(JSON.stringify(value.chatStore.load("chat-1").messages)).not.toContain(recoveredAdvice);
  });

  it("does not persist an unverified workout claim from tool-free summary recovery", async () => {
    const value = fixture({
      responses: [
        "",
        "no_preparation_required",
        "Your workout review is ready.",
        "requires_preparation",
        "Your workout review is definitely ready.",
      ],
      finishReasons: ["tool-calls", "stop", "stop", "stop", "stop"],
    });

    await expect(value.agent.chat("chat-1", "Help me decide what to do tomorrow")).resolves.toBe(
      "I couldn't prepare this workout review. No changes were applied.",
    );
    expect(value.chatCalls).toHaveLength(5);
    expect(value.prepare).not.toHaveBeenCalled();
    const stored = JSON.stringify(value.chatStore.load("chat-1").messages);
    expect(stored).not.toContain("workout review is ready");
    expect(stored).not.toContain("definitely ready");
  });

  it.each(["length", "tool-calls"] satisfies GenerateResult["finishReason"][])(
    "keeps partial advice from a %s finish without workout failure copy",
    async (finishReason) => {
      const reply = "Keep the effort conversational and steady.";
      const value = fixture({
        responses: [reply, "no_preparation_required"],
        finishReasons: [finishReason, "stop"],
      });

      await expect(value.agent.chat("chat-1", "How hard should this ride feel?")).resolves.toBe(
        reply,
      );
      expect(value.chatCalls).toHaveLength(2);
      expect(value.chatCalls[1]?.tools).toBeUndefined();
      expect(value.prepare).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      athlete: "How hard should my endurance rides feel?",
      reply: "Keep them conversational and steady.",
    },
    {
      athlete: "Move my workout.",
      reply: "Which day should I move it to?",
    },
  ])(
    "accepts advice or clarification without a corrective generation",
    async ({ athlete, reply }) => {
      const value = fixture({ responses: [reply, "no_preparation_required"] });

      await expect(value.agent.chat("chat-1", athlete)).resolves.toBe(reply);
      expect(value.chatCalls).toHaveLength(2);
      expect(value.chatCalls[1]?.tools).toBeUndefined();
      expect(value.prepare).not.toHaveBeenCalled();
    },
  );

  it("skips assessment after the first generation receives a prepared receipt", async () => {
    const value = fixture({
      responses: ["Your workout review is ready."],
      run: async (options) => {
        await call(options);
      },
    });

    await expect(value.agent.chat("chat-1", "Add an easy ride tomorrow")).resolves.toBe(
      "Your workout review is ready.",
    );
    expect(value.chatCalls).toHaveLength(1);
    expect(value.prepare).toHaveBeenCalledTimes(1);
  });

  it("uses the generic protocol failure when assessment output is malformed", async () => {
    const value = fixture({ responses: ["Your workout review is ready.", "maybe"] });

    await expect(value.agent.chat("chat-1", "Add an easy ride tomorrow")).resolves.toBe(
      "The coaching response could not be verified. Please try again.",
    );
    expect(value.chatCalls).toHaveLength(2);
    expect(value.prepare).not.toHaveBeenCalled();
  });

  it("does not leak the draft when assessment is canceled", async () => {
    const events: TurnEvent[] = [];
    let value: ReturnType<typeof fixture>;
    value = fixture({
      streamText: true,
      respond: (_options, callNumber) => {
        if (callNumber === 1) return "Your workout review is ready.";
        value.agent.stopChat("chat-1", "cancel-assessment");
        const error = new Error("canceled");
        error.name = "AbortError";
        throw error;
      },
    });

    await expect(
      value.agent.chat(
        "chat-1",
        "Add an easy ride tomorrow",
        undefined,
        (event) => events.push(event),
        undefined,
        "cancel-assessment",
      ),
    ).resolves.toBe("");
    expect(value.chatCalls).toHaveLength(2);
    expect(events).toContainEqual({
      type: "interrupted",
      turnId: "cancel-assessment",
      chatId: "chat-1",
      text: "",
    });
    expect(JSON.stringify(value.chatStore.load("chat-1").messages)).not.toContain(
      "review is ready",
    );
  });

  it("reads canonical pending state with trusted chat identity without consuming preparation allowance", async () => {
    const pending: PendingWorkoutSet = {
      kind: "pending",
      reference: { setId: "pending-set", revision: 4 },
      completedCount: 0,
      changes: [
        {
          id: "pending-item",
          change: { kind: "delete", eventId: 101 },
          reviewed: {
            eventId: 101,
            date: "1998-09-10",
            name: "Thursday ride",
            durationSeconds: 600,
            description: "Easy",
            trainingLoad: 8,
            structure: null,
          },
        },
      ],
    };
    const value = fixture({
      pending,
      run: async (options) => {
        const result = await call(options, {}, "get_pending_workout_changes");
        expect(JSON.stringify(result)).toContain("Thursday ride");
        expect(JSON.stringify(result)).toContain("pending-item");
        expect(
          getTurnContext({ experimental_context: options.context })?.turnWrites.writesCommitted,
        ).toBe(0);
        await call(options);
      },
    });
    await value.agent.chat(
      "trusted-chat",
      "Revise Thursday",
      undefined,
      undefined,
      undefined,
      "trusted-turn",
    );
    expect(value.readPending).toHaveBeenCalledExactlyOnceWith({ chatId: "trusted-chat" });
    expect(value.prepare).toHaveBeenCalledTimes(1);
    expect(value.settleTurn).toHaveBeenCalledWith({
      chatId: "trusted-chat",
      turnId: "trusted-turn",
      outcome: "commit",
    });
    expect(value.mutate).not.toHaveBeenCalled();
  });
  it("omits oversized canonical reads entirely without changing pending work", async () => {
    const value = fixture({
      pending: {
        kind: "pending",
        reference: { setId: "pending-set", revision: 1 },
        completedCount: 0,
        changes: [
          {
            id: "oversized-item",
            change: {
              kind: "add",
              sport: "cycling",
              date: "1998-09-10",
              name: "Thursday ride",
              durationSeconds: 600,
              description: "Long workout instruction. ".repeat(30_000),
              effort: "50% FTP",
              structure: null,
              trainingLoad: 8,
            },
          },
        ],
      },
      run: async (options) => {
        const result = await call(options, {}, "get_pending_workout_changes");
        expect(result).toMatchObject({ truncated: true });
        expect(JSON.stringify(result)).not.toContain("oversized-item");
      },
    });
    await value.agent.chat("trusted-chat", "Revise Thursday");
    expect(value.prepare).not.toHaveBeenCalled();
    expect(value.mutate).not.toHaveBeenCalled();
    expect(value.captured()?.system).toContain("never reconstruct it from conversation history");
  });
  it("refuses canonical reads without an active trusted turn", async () => {
    const value = fixture();
    await value.agent.chat("trusted-chat", "Hello");
    const options = value.captured();
    if (!options) throw new Error("Missing options");
    const result = await call(options, {}, "get_pending_workout_changes");
    expect(JSON.stringify(result)).toContain("unavailable");
    expect(value.readPending).not.toHaveBeenCalled();
    expect(value.prepare).not.toHaveBeenCalled();
  });
  it("uses the sport's replacement contract instead of calendar-provider tool names", () => {
    const value = fixture({ replacedTools: ["prepare_custom_calendar_entry"] });
    expect(value.names).toEqual([
      "plan_save",
      "prepare_workout_changes",
      "get_pending_workout_changes",
    ]);
  });
  it.each([{ hostOptIn: false }, { sportOptIn: false }])(
    "keeps legacy tools without both opt-ins: %j",
    async (optIn) => {
      const value = fixture(optIn);
      expect(value.names).toEqual([...directNames, "plan_save"]);
      await value.agent.chat("chat-1", "Hello");
      expect(value.settleTurn).not.toHaveBeenCalled();
      expect(value.captured()?.system).not.toContain("# Workout Set Review");
    },
  );

  it("registers one preparation tool, preserves Plan, and binds trusted IDs", async () => {
    const value = fixture({
      run: async (options) => {
        await call(options, { chatId: "attacker", turnId: "attacker" });
      },
    });
    expect(value.names).toEqual([
      "plan_save",
      "prepare_workout_changes",
      "get_pending_workout_changes",
    ]);
    await value.agent.chat(
      "trusted-chat",
      "Prepare my week",
      undefined,
      undefined,
      undefined,
      "trusted-turn",
    );
    expect(value.prepare).toHaveBeenCalledExactlyOnceWith({
      chatId: "trusted-chat",
      turnId: "trusted-turn",
      preparation: proposal,
    });
    expect(value.settleTurn).toHaveBeenCalledExactlyOnceWith({
      chatId: "trusted-chat",
      turnId: "trusted-turn",
      outcome: "commit",
    });
    expect(value.mutate).not.toHaveBeenCalled();
    expect(value.captured()?.system).toContain("# Workout Set Review");
    expect(value.captured()?.system).not.toContain("Propose at most one mutation");
    expect(value.captured()?.system).not.toContain("create the workouts a few at a time");
  });

  it("keeps deferred Plan confirmation executable after the workout turn settles", async () => {
    let confirm: (() => Promise<unknown>) | undefined;
    const value = fixture({
      confirmations: {
        gatedToolNames: new Set(["plan_save"]),
        requiresConfirmation: () => true,
        propose: async (input) => {
          confirm = input.run;
          return { pendingConfirmation: true, summary: "Plan pending" };
        },
      },
      run: async (options) => {
        await call(options, {}, "plan_save");
      },
    });
    await value.agent.chat("chat-1", "Save plan");
    expect(value.mutate).not.toHaveBeenCalled();
    expect(confirm).toBeDefined();
    await confirm?.();
    expect(value.mutate).toHaveBeenCalledTimes(1);
  });

  it("abandons a staged proposal on athlete interruption", async () => {
    const value = fixture({
      run: async (options) => {
        await call(options);
        expect(value.agent.stopChat("chat-1", "abort-turn")).toBe(true);
      },
    });
    await value.agent.chat("chat-1", "Prepare", undefined, undefined, undefined, "abort-turn");
    expect(value.settleTurn).toHaveBeenCalledWith(expect.objectContaining({ outcome: "abandon" }));
  });

  it("abandons a duplicate aggregate submission without preparing the second", async () => {
    const value = fixture({
      run: async (options) => {
        await call(options);
        await call(options);
      },
    });
    await value.agent.chat("chat-1", "Prepare");
    expect(value.prepare).toHaveBeenCalledTimes(1);
    expect(value.settleTurn).toHaveBeenCalledWith(expect.objectContaining({ outcome: "abandon" }));
  });

  it("abandons when conversion throws before the port is reached", async () => {
    const value = fixture({
      run: async (options) => {
        await expect(call(options, { fail: true })).rejects.toThrow("Invalid entire proposal");
      },
    });
    await value.agent.chat("chat-1", "Prepare");
    expect(value.prepare).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        preparation: {
          kind: "incomplete",
          reason: "The complete workout proposal could not be prepared.",
        },
      }),
    );
    expect(value.settleTurn).toHaveBeenCalledWith(expect.objectContaining({ outcome: "abandon" }));
  });

  it("records incomplete preparation when schema validation prevents the first submission", async () => {
    const value = fixture({
      run: async (options) => {
        const definitions = buildCoachMcpToolDefinitions({
          tools: options.tools ?? {},
          ctx: options.context,
        });
        const definition = definitions.find((entry) => entry.name === "prepare_workout_changes");
        expect((await definition?.execute({ fail: "invalid" }))?.isError).toBe(true);
      },
    });
    await value.agent.chat("chat-1", "Prepare");
    expect(value.prepare).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        preparation: {
          kind: "incomplete",
          reason: "The complete workout proposal could not be prepared.",
        },
      }),
    );
    expect(value.settleTurn).toHaveBeenCalledWith(expect.objectContaining({ outcome: "abandon" }));
  });

  it.each([
    {
      failure: "returns an error",
      execute: async () => ({ error: "Metrics unavailable" }),
    },
    {
      failure: "rejects",
      execute: async () => {
        throw new Error("Metrics unavailable");
      },
    },
  ])("keeps ordinary advice when an unrelated wrapped tool $failure", async ({ execute }) => {
    const advice = "I couldn't load those metrics, so keep today's ride easy.";
    const value = fixture({
      unrelatedTool: execute,
      responses: [advice, "no_preparation_required"],
      run: async (options) => {
        await Promise.resolve(call(options, {}, "training_metrics_read")).catch(() => undefined);
      },
    });

    await expect(value.agent.chat("chat-1", "How hard should I ride today?")).resolves.toBe(advice);
    expect(value.prepare).not.toHaveBeenCalled();
    expect(value.settleTurn).toHaveBeenCalledWith(expect.objectContaining({ outcome: "abandon" }));
  });

  it("keeps ordinary advice when the SDK marks an unrelated tool failed", async () => {
    const advice = "I couldn't save that note, but keep today's ride easy.";
    const value = fixture({
      responses: [advice, "no_preparation_required"],
      run: async (options) => {
        const definitions = buildCoachMcpToolDefinitions({
          tools: options.tools ?? {},
          ctx: options.context,
        });
        const definition = definitions.find((entry) => entry.name === "plan_save");
        expect((await definition?.execute({ fail: "invalid" }))?.isError).toBe(true);
      },
    });

    await expect(value.agent.chat("chat-1", "Save plan")).resolves.toBe(advice);
    expect(value.prepare).not.toHaveBeenCalled();
    expect(value.settleTurn).toHaveBeenCalledWith(expect.objectContaining({ outcome: "abandon" }));
  });

  it("rejects a prepared claim after an unrelated wrapped tool fails", async () => {
    const value = fixture({
      unrelatedTool: async () => ({ error: "Metrics unavailable" }),
      responses: ["Your workout review is ready."],
      run: async (options) => {
        await call(options);
        await call(options, {}, "training_metrics_read");
      },
    });

    await expect(value.agent.chat("chat-1", "Prepare my workout")).resolves.toBe(
      "I couldn't prepare this workout review. No changes were applied.",
    );
    expect(value.prepare).toHaveBeenCalledTimes(1);
    expect(value.settleTurn).toHaveBeenCalledWith(expect.objectContaining({ outcome: "abandon" }));
  });

  it("rejects a prepared claim when the SDK marks an unrelated tool failed", async () => {
    const value = fixture({
      responses: ["Your workout review is ready."],
      run: async (options) => {
        await call(options);
        const definitions = buildCoachMcpToolDefinitions({
          tools: options.tools ?? {},
          ctx: options.context,
        });
        const definition = definitions.find((entry) => entry.name === "plan_save");
        expect((await definition?.execute({ fail: "invalid" }))?.isError).toBe(true);
      },
    });

    await expect(value.agent.chat("chat-1", "Prepare my workout")).resolves.toBe(
      "I couldn't prepare this workout review. No changes were applied.",
    );
    expect(value.prepare).toHaveBeenCalledTimes(1);
    expect(value.settleTurn).toHaveBeenCalledWith(expect.objectContaining({ outcome: "abandon" }));
  });

  it("abandons a staged set when schema validation fails before execute", async () => {
    const value = fixture({
      run: async (options) => {
        await call(options);
        const definitions = buildCoachMcpToolDefinitions({
          tools: options.tools ?? {},
          ctx: options.context,
        });
        const definition = definitions.find((entry) => entry.name === "prepare_workout_changes");
        expect(definition).toBeDefined();
        const result = await definition?.execute({ fail: "invalid" });
        expect(result?.isError).toBe(true);
      },
    });
    await value.agent.chat("chat-1", "Prepare");
    expect(value.prepare).toHaveBeenCalledTimes(1);
    expect(value.settleTurn).toHaveBeenCalledWith(expect.objectContaining({ outcome: "abandon" }));
  });

  it("abandons an explicitly incomplete proposal", async () => {
    const value = fixture({
      run: async (options) => {
        await call(options, { incomplete: true });
      },
    });
    await value.agent.chat("chat-1", "Prepare");
    expect(value.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ preparation: { kind: "incomplete", reason: "Missing workouts" } }),
    );
    expect(value.settleTurn).toHaveBeenCalledWith(expect.objectContaining({ outcome: "abandon" }));
  });

  it("settles a refused incomplete revision without issuing a second preparation", async () => {
    const value = fixture({
      run: async (options) => {
        const result = await call(options, { incomplete: true });
        expect(JSON.stringify(result)).toContain("previous proposal is unchanged");
      },
    });
    value.prepare.mockResolvedValueOnce({
      kind: "refused",
      message: "The previous proposal is unchanged.",
    });
    await value.agent.chat("chat-1", "Revise Thursday");
    expect(value.prepare).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        preparation: { kind: "incomplete", reason: "Missing workouts" },
      }),
    );
    expect(value.settleTurn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: "abandon" }),
    );
    expect(value.mutate).not.toHaveBeenCalled();
  });

  it.each(["length", "tool-calls"] satisfies GenerateResult["finishReason"][])(
    "abandons a staged proposal on %s exhaustion",
    async (finishReason) => {
      const value = fixture({
        finishReason,
        run: async (options) => {
          await call(options);
        },
      });
      await value.agent.chat("chat-1", "Prepare");
      expect(value.settleTurn).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "abandon" }),
      );
    },
  );

  it("abandons a staged proposal when generation fails", async () => {
    const value = fixture({
      run: async (options) => {
        await call(options);
        throw new Error("Invalid request");
      },
    });
    await expect(value.agent.chat("chat-1", "Prepare")).rejects.toThrow("Invalid request");
    expect(value.settleTurn).toHaveBeenCalledWith(expect.objectContaining({ outcome: "abandon" }));
  });

  it("waits for pending calls and abandons a late converter failure", async () => {
    let finish: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const value = fixture({
      run: async (options) => {
        value.prepare.mockImplementationOnce(async () => {
          await pending;
          throw new Error("Late failure");
        });
        void Promise.resolve(call(options)).catch(() => undefined);
      },
    });
    const turn = value.agent.chat("chat-1", "Prepare");
    await vi.waitFor(() => expect(value.prepare).toHaveBeenCalledTimes(1));
    expect(value.settleTurn).not.toHaveBeenCalled();
    finish?.();
    await turn;
    expect(value.settleTurn).toHaveBeenCalledWith(expect.objectContaining({ outcome: "abandon" }));
  });

  it("checks cancellation after all pending preparation calls settle", async () => {
    let finish: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const value = fixture({
      run: async (options) => {
        value.prepare.mockImplementationOnce(async () => {
          await pending;
          return { kind: "prepared", changeCount: 1 };
        });
        void Promise.resolve(call(options)).catch(() => undefined);
      },
    });
    const turn = value.agent.chat(
      "chat-1",
      "Prepare",
      undefined,
      undefined,
      undefined,
      "late-abort",
    );
    await vi.waitFor(() => expect(value.prepare).toHaveBeenCalledTimes(1));
    expect(value.agent.stopChat("chat-1", "late-abort")).toBe(true);
    finish?.();
    await turn;
    expect(value.settleTurn).toHaveBeenCalledWith(expect.objectContaining({ outcome: "abandon" }));
  });

  it("keeps a staged proposal abandoned when a failed attempt later retries successfully", async () => {
    let attempts = 0;
    const value = fixture({
      run: async (options) => {
        if (++attempts === 1) {
          await call(options);
          throw new Error("Request timed out");
        }
      },
    });
    await expect(value.agent.chat("chat-1", "Prepare")).resolves.toBe(
      "I couldn't prepare this workout review. No changes were applied.",
    );
    expect(attempts).toBe(2);
    expect(value.prepare).toHaveBeenCalledTimes(1);
    expect(value.settleTurn).toHaveBeenCalledWith(expect.objectContaining({ outcome: "abandon" }));
  });

  it("checks the deadline after all pending preparation calls settle", async () => {
    let now = 0;
    let finish: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const value = fixture({
      now: () => now,
      run: async (options) => {
        value.prepare.mockImplementationOnce(async () => {
          await pending;
          return { kind: "prepared", changeCount: 1 };
        });
        void Promise.resolve(call(options)).catch(() => undefined);
      },
    });
    const turn = value.agent.chat("chat-1", "Prepare");
    await vi.waitFor(() => expect(value.prepare).toHaveBeenCalledTimes(1));
    expect(value.settleTurn).not.toHaveBeenCalled();
    now = TURN_WALL_CLOCK_MS;
    finish?.();
    await expect(turn).rejects.toMatchObject({ kind: "wall_clock" });
    expect(value.settleTurn).toHaveBeenCalledWith(expect.objectContaining({ outcome: "abandon" }));
  });

  it("rejects a tool invocation after its owning turn has settled", async () => {
    const value = fixture();
    await value.agent.chat("chat-1", "Hello");
    const options = value.captured();
    expect(options).toBeDefined();
    if (options !== undefined) await call(options);
    expect(value.prepare).not.toHaveBeenCalled();
  });
});
