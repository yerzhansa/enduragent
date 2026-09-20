import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoachAgent } from "../src/agent/coach-agent.js";
import { TURN_WALL_CLOCK_MS } from "../src/agent/turn-budget.js";
import { buildCoachMcpToolDefinitions } from "../src/agent/codex-agent/mcp-endpoint.js";
import type { EngineHostPorts } from "../src/host-ports.js";
import type { GenerateOptions, GenerateResult, Sport } from "../src/sport.js";
import type { Preparation, WorkoutPreparationPort } from "../src/workout-change-sets.js";
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
    run?: (options: GenerateOptions) => Promise<void>;
    finishReason?: GenerateResult["finishReason"];
    hostOptIn?: boolean;
    sportOptIn?: boolean;
    confirmations?: EngineHostPorts["toolConfirmations"];
    replacedTools?: readonly string[];
    now?: EngineHostPorts["now"];
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
    tools: () =>
      [...(input.replacedTools ?? directNames), "plan_save"].map((name) => ({
        name,
        description: name,
        inputSchema,
        tool: tool({ inputSchema, execute: mutate }),
      })),
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
  let names: readonly string[] = [];
  const ports: EngineHostPorts = {
    ...baseAgentConfig(root),
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.hostOptIn === false ? {} : { workoutPreparation: { prepare, settleTurn } }),
    toolConfirmations: input.confirmations,
    onToolsAssembled: (value) => {
      names = value;
    },
    modelTransportDecorator: () => ({
      generate: async (request) => {
        captured = request.options;
        if (request.options.caller === "chat") await input.run?.(request.options);
        return {
          text: "Review prepared.",
          toolCalls: [],
          finishReason: input.finishReason ?? "stop",
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
  return { agent, prepare, settleTurn, mutate, names, captured: () => captured };
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
  it("uses the sport's replacement contract instead of calendar-provider tool names", () => {
    const value = fixture({ replacedTools: ["prepare_custom_calendar_entry"] });
    expect(value.names).toEqual(["plan_save", "prepare_workout_changes"]);
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
    expect(value.names).toEqual(["plan_save", "prepare_workout_changes"]);
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

  it("preserves pending work when an unrelated tool has invalid input", async () => {
    const value = fixture({
      run: async (options) => {
        const definitions = buildCoachMcpToolDefinitions({
          tools: options.tools ?? {},
          ctx: options.context,
        });
        const definition = definitions.find((entry) => entry.name === "plan_save");
        expect((await definition?.execute({ fail: "invalid" }))?.isError).toBe(true);
      },
    });
    await value.agent.chat("chat-1", "Save plan");
    expect(value.prepare).not.toHaveBeenCalled();
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
    await expect(value.agent.chat("chat-1", "Prepare")).resolves.toBe("Review prepared.");
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
    await turn;
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
