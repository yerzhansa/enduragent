import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { CoachEngine } from "@enduragent/coach-contract";
import type { CoachAgent } from "../src/agent/coach-agent.js";
import type { LocalCoachEngine } from "../src/agent/coach-engine.js";

describe("createCoachEngine delegates verbatim to CoachAgent", () => {
  afterEach(() => {
    vi.doUnmock("../src/agent/coach-agent.js");
    vi.resetModules();
  });

  async function setup() {
    const chatResponse = { text: "canned-reply" };
    const chat = vi.fn(async () => chatResponse);
    const hasSessionResponse = { hasSession: true };
    const hasSession = vi.fn(async () => hasSessionResponse);
    const resetSession = vi.fn(async () => ({ memoryFlushed: false }));
    const athleteState = { sentinel: "athlete-state" };
    const getAthleteState = vi.fn(async () => athleteState);
    const memorySentinel = { sentinel: "memory" };
    const confirmationsSentinel = { sentinel: "confirmations" };
    const ctorArgs: unknown[][] = [];
    const instances: unknown[] = [];
    vi.doMock("../src/agent/coach-agent.js", () => ({
      CoachAgent: class {
        chat = chat;
        hasSession = hasSession;
        resetSession = resetSession;
        getAthleteState = getAthleteState;
        getMemory = () => memorySentinel;
        confirmations = confirmationsSentinel;
        constructor(...args: unknown[]) {
          ctorArgs.push(args);
          instances.push(this);
        }
      },
    }));
    const { createCoachEngine } = await import("../src/agent/coach-engine.js");
    return {
      createCoachEngine,
      chat,
      chatResponse,
      hasSession,
      hasSessionResponse,
      resetSession,
      getAthleteState,
      athleteState,
      memorySentinel,
      confirmationsSentinel,
      ctorArgs,
      instances,
    };
  }

  it("constructs exactly one CoachAgent with verbatim args", async () => {
    const { createCoachEngine, ctorArgs, instances } = await setup();
    const sportSentinel = { sentinel: "sport" } as never;
    const configSentinel = { sentinel: "config" } as never;
    const depsSentinel = { catalog: { sentinel: "catalog" } } as never;
    const engine = createCoachEngine(sportSentinel, configSentinel, depsSentinel);
    expect(ctorArgs).toHaveLength(1);
    expect(ctorArgs[0]).toHaveLength(3);
    expect(ctorArgs[0]![0]).toBe(sportSentinel);
    expect(ctorArgs[0]![1]).toBe(configSentinel);
    expect(ctorArgs[0]![2]).toBe(depsSentinel);
    expect(engine).toBe(instances[0]);
  });

  it("chat forwards the canonical request, event callback, and response", async () => {
    const { createCoachEngine, chat, chatResponse } = await setup();
    const engine = createCoachEngine({} as never, {} as never, { catalog: {} as never });
    const request = { chatId: "chat-1", message: "hello", turn: { resolvedCs: null } };
    const onEvent = vi.fn();
    const result = await engine.chat(request, onEvent);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledWith(request, onEvent);
    expect(result).toBe(chatResponse);
  });

  it("chat with the event callback omitted forwards undefined", async () => {
    const { createCoachEngine, chat } = await setup();
    const engine = createCoachEngine({} as never, {} as never, { catalog: {} as never });
    const request = { chatId: "chat-1", message: "hello" };
    await engine.chat(request);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledWith(request);
  });

  it("hasSession forwards and returns the delegate's exact response", async () => {
    const { createCoachEngine, hasSession, hasSessionResponse } = await setup();
    const engine = createCoachEngine({} as never, {} as never, { catalog: {} as never });
    const request = { chatId: "chat-2" };
    await expect(engine.hasSession(request)).resolves.toBe(hasSessionResponse);
    expect(hasSession).toHaveBeenCalledTimes(1);
    expect(hasSession).toHaveBeenCalledWith(request);
  });

  it("resetSession forwards and returns the delegate's exact object", async () => {
    const { createCoachEngine, resetSession } = await setup();
    const engine = createCoachEngine({} as never, {} as never, { catalog: {} as never });
    const request = { chatId: "chat-3" };
    const result = await engine.resetSession(request);
    expect(resetSession).toHaveBeenCalledTimes(1);
    expect(resetSession).toHaveBeenCalledWith(request);
    const delegateResult = await resetSession.mock.results[0]!.value;
    expect(result).toBe(delegateResult);
  });

  it("getAthleteState returns the delegate's exact response", async () => {
    const { createCoachEngine, getAthleteState, athleteState } = await setup();
    const engine = createCoachEngine({} as never, {} as never, { catalog: {} as never });
    await expect(engine.getAthleteState()).resolves.toBe(athleteState);
    expect(getAthleteState).toHaveBeenCalledTimes(1);
  });

  it("getMemory returns the delegate's Memory instance", async () => {
    const { createCoachEngine, memorySentinel } = await setup();
    const engine = createCoachEngine({} as never, {} as never, { catalog: {} as never });
    expect(engine.getMemory()).toBe(memorySentinel);
  });

  it("exposes the delegate's confirmation gate", async () => {
    const { createCoachEngine, confirmationsSentinel } = await setup();
    const engine = createCoachEngine({} as never, {} as never, { catalog: {} as never });
    expect(engine.confirmations).toBe(confirmationsSentinel);
  });

  it("CoachAgent and LocalCoachEngine implement the canonical contract (compile-time)", () => {
    expectTypeOf<CoachAgent["chat"]>().toEqualTypeOf<CoachEngine["chat"]>();
    expectTypeOf<CoachAgent["hasSession"]>().toEqualTypeOf<CoachEngine["hasSession"]>();
    expectTypeOf<CoachAgent["resetSession"]>().toEqualTypeOf<CoachEngine["resetSession"]>();
    expectTypeOf<CoachAgent["getAthleteState"]>().toEqualTypeOf<CoachEngine["getAthleteState"]>();
    const agentToEngine = (agent: CoachAgent): CoachEngine => agent;
    const localToEngine = (engine: LocalCoachEngine): CoachEngine => engine;
    expect(typeof agentToEngine).toBe("function");
    expect(typeof localToEngine).toBe("function");
  });
});
