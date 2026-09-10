import type { ModelTransportDecorator, ModelTransportRequest } from "@enduragent/engine";
import type { GenerateResult } from "@enduragent/engine/sport";

import { canonicalJson, stableSerialize } from "./canonical.js";
import { jsonDiff, textDiff } from "./diff.js";
import { assembledHash, sha256_16 } from "./hash.js";
import type {
  FailureWithDiff,
  PendingHashMismatch,
  RecordedCall,
  RecordedRequest,
  RecordedTextDeltaEvent,
  RecordedToolExecution,
  S8aRecording,
} from "./types.js";
import type { ToolExecutionOutcome } from "./write-capture.js";

export interface ToolLike {
  execute?: (input: unknown, options: unknown) => unknown;
  [key: string]: unknown;
}

export interface GenerateOptsLike {
  system?: string;
  messages?: unknown[];
  prompt?: string;
  tools?: Record<string, ToolLike>;
  maxSteps?: number;
  maxOutputTokens?: number;
  cacheKey?: string;
  caller?: "chat" | "flush" | "compact" | "sync-triage" | "dream" | "intent-translation";
  context?: unknown;
  onTextDelta?: (delta: string) => void;
  [key: string]: unknown;
}

export interface GenerateResultLike {
  text: string;
  toolCalls: unknown[];
  finishReason: string;
  usage: unknown;
  totalUsage?: unknown;
  steps?: number;
  cost?: unknown;
  [key: string]: unknown;
}

export type TurnRef = { chatId: string; turnIndex: number } | null;

/** Thrown into agent code when the recording has no entry for a live generate
 *  call; the runner catches it at the turn boundary. */
export class S8aDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "S8aDriftError";
  }
}

// ---------------------------------------------------------------------------
// Record engine
// ---------------------------------------------------------------------------

export interface RecordHandle {
  calls: RecordedCall[];
  modelTransportDecorator: ModelTransportDecorator;
  setCurrentTurn(turn: TurnRef): void;
  setCurrentCheck(id: string | undefined): void;
  restore(): void;
}

export function patchForRecord(): RecordHandle {
  const calls: RecordedCall[] = [];
  let currentTurn: TurnRef = null;
  let currentCheck: string | undefined;
  let ordinal = 0;

  const modelTransportDecorator: ModelTransportDecorator = (next) => ({
    generate: async (request) => {
      const opts = request.options as GenerateOptsLike;
      assertSupportedCaller(opts.caller);
      const callOrdinal = ordinal++;
      const executions: RecordedToolExecution[] = [];
      const events: RecordedTextDeltaEvent[] = [];
      let seq = 0;

      // Wrap a COPY of each tool so the agent's own tool objects are never
      // mutated (opts.tools is the agent's long-lived tool set).
      let tools = opts.tools;
      if (tools !== undefined) {
        const wrapped: Record<string, ToolLike> = {};
        for (const [name, tool] of Object.entries(tools)) {
          const inner = tool.execute;
          if (typeof inner !== "function") {
            wrapped[name] = tool;
            continue;
          }
          wrapped[name] = {
            ...tool,
            execute: async (input: unknown, options: unknown) => {
              const result = await inner.call(tool, input, options);
              executions.push({
                seq: seq++,
                toolName: name,
                input: structuredClone(input),
                resultCanonical: stableSerialize(JSON.parse(JSON.stringify(result ?? null))),
              });
              return result;
            },
          };
        }
        tools = wrapped;
      }

      const originalOnTextDelta = request.options.onTextDelta;
      const wrappedOnTextDelta = (delta: string): void => {
        events.push({ type: "text_delta", delta });
        try {
          originalOnTextDelta?.(delta);
        } catch {}
      };
      const result = await next.generate({
        ...request,
        options: {
          ...request.options,
          tools: tools as ModelTransportRequest["options"]["tools"],
          onTextDelta: wrappedOnTextDelta,
        },
      });
      const recordedEvents = opts.caller === "chat" || opts.caller === undefined ? events : null;
      assertRecordedTextDeltaEvents(recordedEvents);
      calls.push({
        ordinal: callOrdinal,
        caller: opts.caller ?? "chat",
        turn: currentTurn,
        ...(currentCheck === undefined ? {} : { checkId: currentCheck }),
        request: buildRecordedRequest(opts),
        toolExecutions: executions,
        result: {
          text: result.text,
          toolCalls: JSON.parse(JSON.stringify(result.toolCalls ?? [])),
          finishReason: result.finishReason,
          usage: JSON.parse(JSON.stringify(result.usage ?? null)),
          totalUsage: JSON.parse(JSON.stringify(result.totalUsage ?? null)),
          steps: result.steps ?? 0,
          ...(result.cost !== undefined ? { cost: JSON.parse(JSON.stringify(result.cost)) } : {}),
        },
        events: recordedEvents,
      });
      return result;
    },
  });

  return {
    calls,
    modelTransportDecorator,
    setCurrentCheck: (id) => {
      currentCheck = id;
    },
    setCurrentTurn: (turn) => {
      currentTurn = turn;
    },
    restore: () => undefined,
  };
}

function buildRecordedRequest(opts: GenerateOptsLike): RecordedRequest {
  if (opts.caller === "intent-translation") {
    if (typeof opts.deadlineMs !== "number" || opts.deadlineMs <= 0 || opts.deadlineMs > 30_000) {
      throw new S8aDriftError("intent-translation deadline must be within 30 seconds");
    }
    const system = opts.system ?? "";
    return {
      shape: "intent-translation",
      caller: "intent-translation",
      system,
      systemSha256_16: sha256_16(system),
      input:
        opts.prompt !== undefined
          ? { shape: "prompt", prompt: opts.prompt }
          : { shape: "messages", messages: structuredClone(opts.messages ?? []) },
      toolNames: Object.keys(opts.tools ?? {}).sort(),
      maxSteps: opts.maxSteps ?? null,
      maxOutputTokens: opts.maxOutputTokens ?? null,
      cacheKey: opts.cacheKey ?? null,
      deadlineMs: opts.deadlineMs,
    };
  }
  if (opts.prompt !== undefined) {
    return {
      shape: "prompt",
      caller: "compact",
      prompt: opts.prompt,
      promptSha256_16: sha256_16(opts.prompt),
      maxOutputTokens: opts.maxOutputTokens ?? null,
      toolNames: [],
      maxSteps: null,
      cacheKey: null,
    };
  }
  const system = opts.system ?? "";
  const messages = opts.messages ?? [];
  return {
    shape: "messages",
    caller: (opts.caller ?? "chat") as "chat" | "flush",
    system,
    systemSha256_16: sha256_16(system),
    assembledHash: assembledHash(system, messages),
    messages: structuredClone(messages),
    toolNames: Object.keys(opts.tools ?? {}).sort(),
    maxSteps: opts.maxSteps ?? null,
    cacheKey: opts.cacheKey ?? null,
  };
}

// ---------------------------------------------------------------------------
// Replay engine
// ---------------------------------------------------------------------------

export interface ReplayState {
  cursor: number;
  failures: FailureWithDiff[];
  pendings: PendingHashMismatch[];
  toolOutcomes: ToolExecutionOutcome[];
}

export interface ReplayHandle {
  state: ReplayState;
  modelTransportDecorator: ModelTransportDecorator;
  setCurrentTurn(turn: TurnRef): void;
  setCurrentCheck(id: string | undefined): void;
  /** Leftover-cursor A6 check — call after all turns completed. */
  finalize(): void;
  restore(): void;
}

export function patchForReplay(recording: S8aRecording, scenarioId: string): ReplayHandle {
  const state: ReplayState = { cursor: 0, failures: [], pendings: [], toolOutcomes: [] };
  let currentTurn: TurnRef = null;
  let currentCheck: string | undefined;

  const fail = (
    assertId: FailureWithDiff["assertId"],
    detail: string,
    diffFile?: string,
    diffContent?: string,
  ) => {
    state.failures.push({ assertId, scenario: scenarioId, detail, diffFile, diffContent });
  };

  const modelTransportDecorator: ModelTransportDecorator = () => ({
    generate: async (request) => {
      const opts = request.options as GenerateOptsLike;
      assertSupportedCaller(opts.caller);
      const entry = recording.calls[state.cursor];
      const ordinal = state.cursor;
      state.cursor++;

      if (entry === undefined) {
        const counts = callerCounts(recording.calls);
        fail(
          "A6",
          `extra generate call at ordinal ${ordinal} with caller=${opts.caller ?? "chat"}`,
          "budget.diff",
          `expected ${recording.calls.length} generate calls (${counts}), got at least ${ordinal + 1}; first unexpected at ordinal ${ordinal} caller=${opts.caller ?? "chat"}`,
        );
        throw new S8aDriftError(`no recorded entry for generate call at ordinal ${ordinal}`);
      }

      if (entry.checkId !== currentCheck)
        fail("A3", `ordinal ${ordinal}: answer-check attribution mismatch`);
      assertRequest(entry, opts, ordinal, currentTurn, state, fail);
      await executeRecordedTools(entry, opts, ordinal, state, fail);

      assertRecordedTextDeltaEvents(entry.events);
      for (const event of entry.events ?? []) {
        try {
          request.options.onTextDelta?.(event.delta);
        } catch {}
      }

      return entry.result as unknown as GenerateResult;
    },
  });

  return {
    state,
    modelTransportDecorator,
    setCurrentCheck: (id) => {
      currentCheck = id;
    },
    setCurrentTurn: (turn) => {
      currentTurn = turn;
    },
    finalize: () => {
      if (state.cursor < recording.calls.length) {
        const counts = callerCounts(recording.calls);
        const next = recording.calls[state.cursor];
        fail(
          "A6",
          `missing generate call: expected ${recording.calls.length} (${counts}), got ${state.cursor}`,
          "budget.diff",
          `expected ${recording.calls.length} generate calls (${counts}), got ${state.cursor}; first missing at ordinal ${next.ordinal} caller=${next.caller}`,
        );
      }
    },
    restore: () => undefined,
  };
}

function assertSupportedCaller(
  caller: GenerateOptsLike["caller"],
): asserts caller is "chat" | "flush" | "compact" | "intent-translation" | undefined {
  if (caller === "sync-triage" || caller === "dream") {
    throw new S8aDriftError(`unsupported Tier-R caller: ${caller}`);
  }
}

function assertRecordedTextDeltaEvents(
  events: unknown,
): asserts events is RecordedTextDeltaEvent[] | null {
  if (events === null) return;
  if (!Array.isArray(events)) {
    throw new S8aDriftError("recorded events must be null or a text_delta array");
  }
  for (const event of events) {
    if (
      typeof event !== "object" ||
      event === null ||
      Object.keys(event).length !== 2 ||
      (event as { type?: unknown }).type !== "text_delta" ||
      typeof (event as { delta?: unknown }).delta !== "string"
    ) {
      throw new S8aDriftError("recorded events contain a malformed text_delta entry");
    }
  }
}

function callerCounts(calls: RecordedCall[]): string {
  const count = (c: string) => calls.filter((x) => x.caller === c).length;
  return `chat=${count("chat")}, flush=${count("flush")}, compact=${count("compact")}, intent-translation=${count("intent-translation")}`;
}

function assertRequest(
  entry: RecordedCall,
  opts: GenerateOptsLike,
  ordinal: number,
  currentTurn: TurnRef,
  state: ReplayState,
  fail: (a: FailureWithDiff["assertId"], d: string, f?: string, c?: string) => void,
): void {
  const req = entry.request;
  const liveCaller = opts.caller ?? "chat";
  const liveShape =
    opts.caller === "intent-translation"
      ? "intent-translation"
      : opts.prompt !== undefined
        ? "prompt"
        : "messages";

  if (liveCaller !== req.caller) {
    fail(
      "A3",
      `ordinal ${ordinal}: caller mismatch — expected ${req.caller}, got ${liveCaller}`,
      "messages.diff",
      `caller mismatch at ordinal ${ordinal}: expected ${req.caller} got ${liveCaller}`,
    );
    return;
  }
  if (liveShape !== req.shape) {
    fail(
      "A3",
      `ordinal ${ordinal}: request shape mismatch — expected ${req.shape}, got ${liveShape}`,
      "messages.diff",
      `request shape mismatch at ordinal ${ordinal}: expected ${req.shape} got ${liveShape}`,
    );
    return;
  }

  if (req.shape === "intent-translation") {
    const live = buildRecordedRequest(opts);
    if (live.shape !== "intent-translation") return;
    const { deadlineMs: recordedDeadline, ...recordedExact } = req;
    const { deadlineMs: liveDeadline, ...liveExact } = live;
    if (
      recordedDeadline <= 0 ||
      recordedDeadline > 30_000 ||
      liveDeadline <= 0 ||
      liveDeadline > 30_000
    )
      fail("A6", `ordinal ${ordinal}: answer-check deadline exceeded`);
    if (canonicalJson(recordedExact) !== canonicalJson(liveExact))
      fail(
        "A3",
        `ordinal ${ordinal}: answer-check request differs from recording`,
        "messages.diff",
        jsonDiff("recorded request", recordedExact, "live request", liveExact),
      );
    return;
  }
  if (req.shape === "prompt") {
    const prompt = opts.prompt ?? "";
    if (prompt !== req.prompt) {
      fail(
        "A3",
        `ordinal ${ordinal}: compact prompt string mismatch (no supersession path for compact calls)`,
        "system-prompt.diff",
        textDiff("recorded prompt", req.prompt, "live prompt", prompt),
      );
    }
    if ((opts.maxOutputTokens ?? null) !== req.maxOutputTokens) {
      fail(
        "A3",
        `ordinal ${ordinal}: maxOutputTokens mismatch — expected ${req.maxOutputTokens}, got ${opts.maxOutputTokens ?? null}`,
        "messages.diff",
        `maxOutputTokens mismatch at ordinal ${ordinal}: expected ${req.maxOutputTokens} got ${opts.maxOutputTokens ?? null}`,
      );
    }
    if (sha256_16(prompt) !== req.promptSha256_16) {
      fail(
        "A1",
        `ordinal ${ordinal}: prompt hash mismatch (compact — ruled inline, no supersession path)`,
        "system-prompt.diff",
        textDiff("recorded prompt", req.prompt, "live prompt", prompt),
      );
    }
    return;
  }

  const liveSystem = opts.system ?? "";
  const liveMessages = opts.messages ?? [];

  const liveMessagesCanonical = canonicalJson(liveMessages);
  const recMessagesCanonical = canonicalJson(req.messages);
  if (liveMessagesCanonical !== recMessagesCanonical) {
    const liveArr = liveMessages as Array<{ role?: unknown }>;
    const recArr = req.messages as Array<{ role?: unknown }>;
    const roles = (arr: Array<{ role?: unknown }>) =>
      `[${arr.map((m) => String(m?.role)).join(",")}]`;
    let firstDivergent = 0;
    const maxLen = Math.max(liveArr.length, recArr.length);
    for (let i = 0; i < maxLen; i++) {
      if (canonicalJson(liveArr[i] ?? null) !== canonicalJson(recArr[i] ?? null)) {
        firstDivergent = i;
        break;
      }
    }
    fail(
      "A3",
      `ordinal ${ordinal}: message array mismatch (first divergent message index ${firstDivergent})`,
      "messages.diff",
      `expected ${roles(recArr)} got ${roles(liveArr)}\n` +
        jsonDiff(
          `recorded message[${firstDivergent}]`,
          recArr[firstDivergent] ?? null,
          `live message[${firstDivergent}]`,
          liveArr[firstDivergent] ?? null,
        ),
    );
  }

  const liveToolNames = Object.keys(opts.tools ?? {}).sort();
  if (JSON.stringify(liveToolNames) !== JSON.stringify(req.toolNames)) {
    fail(
      "A3",
      `ordinal ${ordinal}: tool-name set mismatch`,
      "messages.diff",
      `expected tools ${JSON.stringify(req.toolNames)} got ${JSON.stringify(liveToolNames)}`,
    );
  }
  if ((opts.maxSteps ?? null) !== req.maxSteps) {
    fail(
      "A3",
      `ordinal ${ordinal}: maxSteps mismatch — expected ${req.maxSteps}, got ${opts.maxSteps ?? null}`,
      "messages.diff",
      `maxSteps mismatch at ordinal ${ordinal}: expected ${req.maxSteps} got ${opts.maxSteps ?? null}`,
    );
  }
  if ((opts.cacheKey ?? null) !== req.cacheKey) {
    fail(
      "A3",
      `ordinal ${ordinal}: cacheKey mismatch — expected ${req.cacheKey}, got ${opts.cacheKey ?? null}`,
      "messages.diff",
      `cacheKey mismatch at ordinal ${ordinal}: expected ${req.cacheKey} got ${opts.cacheKey ?? null}`,
    );
  }

  const systemMismatch = liveSystem !== req.system;
  const liveSystemHash = sha256_16(liveSystem);
  const liveAssembledHash = assembledHash(liveSystem, liveMessages);
  const hashMismatch =
    liveSystemHash !== req.systemSha256_16 || liveAssembledHash !== req.assembledHash;

  if (systemMismatch || hashMismatch) {
    const detail = systemMismatch
      ? `ordinal ${ordinal}: system prompt differs from recording`
      : `ordinal ${ordinal}: assembled-prompt hash mismatch (live ${liveSystemHash}/${liveAssembledHash} vs recorded ${req.systemSha256_16}/${req.assembledHash})`;
    if (req.caller === "chat") {
      // The supersession lookup needs the live session-line templateHash, which
      // does not exist yet at call time — record PENDING, resolve post-turn.
      state.pendings.push({
        ordinal,
        assertId: systemMismatch ? "A3" : "A1",
        turn: currentTurn,
        recordedTemplateHash: req.templateHash,
        detail,
        recordedText: req.system,
        liveText: liveSystem,
      });
    } else {
      fail(
        systemMismatch ? "A3" : "A1",
        `${detail} (flush — ruled inline, no supersession path)`,
        "system-prompt.diff",
        textDiff("recorded system", req.system, "live system", liveSystem),
      );
    }
  }
}

async function executeRecordedTools(
  entry: RecordedCall,
  opts: GenerateOptsLike,
  ordinal: number,
  state: ReplayState,
  fail: (a: FailureWithDiff["assertId"], d: string, f?: string, c?: string) => void,
): Promise<void> {
  for (let k = 0; k < entry.toolExecutions.length; k++) {
    const exec = entry.toolExecutions[k];
    const tool = opts.tools?.[exec.toolName];
    if (tool === undefined || typeof tool.execute !== "function") {
      state.toolOutcomes.push({
        toolName: exec.toolName,
        recordedResult: exec.resultCanonical,
        liveResult: undefined,
        liveExecuted: false,
      });
      fail(
        "A2",
        `ordinal ${ordinal} seq ${exec.seq}: recorded tool ${exec.toolName} not present in live tool set`,
        "tool-calls.diff",
        `first divergent seq ${exec.seq}: expected tool ${exec.toolName}, tool absent from live set`,
      );
      continue;
    }
    let liveResult: unknown;
    try {
      liveResult = await tool.execute(exec.input, {
        toolCallId: `s8a-replay-${ordinal}-${k}`,
        messages: [],
        experimental_context: opts.context,
      });
    } catch (err) {
      state.toolOutcomes.push({
        toolName: exec.toolName,
        recordedResult: exec.resultCanonical,
        liveResult: undefined,
        liveExecuted: false,
      });
      fail(
        "A2",
        `ordinal ${ordinal} seq ${exec.seq}: live execution of ${exec.toolName} threw: ${err instanceof Error ? err.message : String(err)}`,
        "tool-calls.diff",
        `first divergent seq ${exec.seq}: tool ${exec.toolName} threw during live execution\n${String(err)}`,
      );
      continue;
    }
    state.toolOutcomes.push({
      toolName: exec.toolName,
      recordedResult: exec.resultCanonical,
      liveResult,
      liveExecuted: true,
    });
    const liveCanonical = canonicalJson(JSON.parse(JSON.stringify(liveResult ?? null)));
    const recCanonical = canonicalJson(exec.resultCanonical);
    if (liveCanonical !== recCanonical) {
      fail(
        "A2",
        `ordinal ${ordinal} seq ${exec.seq}: tool ${exec.toolName} result differs from recording`,
        "tool-calls.diff",
        `first divergent seq ${exec.seq}: tool ${exec.toolName}\n` +
          jsonDiff("recorded input", exec.input, "live input", exec.input) +
          "\n" +
          textDiff("recorded result", recCanonical, "live result", liveCanonical),
      );
    }
  }
}
