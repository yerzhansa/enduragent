import {
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
} from "@opentelemetry/api";
import type { Tool, ToolSet } from "ai";
import type { UsageLedgerLine } from "../host-ports.js";
import { getTurnContext } from "./turn-context.js";

export const ENGINE_TRACER_NAME = "@enduragent/engine";
export const TURN_SPAN_NAME = "coach.turn";
export const MODEL_CALL_SPAN_NAME = "llm.generate";
export const TOOL_CALL_SPAN_NAME = "tool.call";

type SpanEnding = Pick<UsageLedgerLine, "outcome" | "errorClass">;

interface OpenTurnSpan {
  readonly span: Span;
  readonly context: Context;
  failedChatCalls: number;
}

export interface ModelCallSpan {
  end(line: UsageLedgerLine | undefined): void;
}

const openTurnSpans = new Map<string, OpenTurnSpan>();

function tracer() {
  return trace.getTracer(ENGINE_TRACER_NAME);
}

function openTurn(turnId: string | undefined): OpenTurnSpan | undefined {
  return turnId === undefined ? undefined : openTurnSpans.get(turnId);
}

function finish(span: Span, ending: SpanEnding, attributes: Attributes = {}): void {
  span.setAttributes({
    ...attributes,
    "enduragent.outcome": ending.outcome,
    "error.type": ending.outcome === "error" ? ending.errorClass : undefined,
  });
  if (ending.outcome === "error") span.setStatus({ code: SpanStatusCode.ERROR });
  span.end();
}

export function beginTurnSpan(turnId: string): void {
  endTurnSpan(turnId, { outcome: "error" });
  const span = tracer().startSpan(
    TURN_SPAN_NAME,
    { attributes: { "enduragent.turn.id": turnId } },
    ROOT_CONTEXT,
  );
  openTurnSpans.set(turnId, {
    span,
    context: trace.setSpan(ROOT_CONTEXT, span),
    failedChatCalls: 0,
  });
}

export function endTurnSpan(turnId: string, ending: SpanEnding): void {
  const turn = openTurnSpans.get(turnId);
  if (turn === undefined) return;
  openTurnSpans.delete(turnId);
  finish(turn.span, ending);
}

export function startModelCallSpan(turnId: string | undefined): ModelCallSpan {
  const turn = openTurn(turnId);
  const attempt = turn === undefined ? undefined : turn.failedChatCalls + 1;
  const span = tracer().startSpan(MODEL_CALL_SPAN_NAME, {}, turn?.context ?? ROOT_CONTEXT);
  return {
    end(line) {
      if (line === undefined) return;
      if (turn !== undefined && line.caller === "chat" && line.outcome === "error") {
        turn.failedChatCalls += 1;
      }
      finish(span, line, {
        "gen_ai.provider.name": line.provider,
        "gen_ai.request.model": line.model,
        "gen_ai.usage.input_tokens": line.inputTokens,
        "gen_ai.usage.output_tokens": line.outputTokens,
        "enduragent.llm.caller": line.caller,
        "enduragent.llm.attempt": attempt,
        "enduragent.cost_usd": line.cost?.total,
        "enduragent.duration_ms": line.durationMs,
      });
    },
  };
}

function traceToolCall(name: string, tool: Tool): Tool {
  const execute = tool.execute;
  if (typeof execute !== "function") return tool;
  return {
    ...tool,
    execute: async (input: unknown, options: unknown) => {
      const parent = openTurn(getTurnContext(options)?.turnId)?.context ?? ROOT_CONTEXT;
      const span = tracer().startSpan(
        TOOL_CALL_SPAN_NAME,
        { attributes: { "gen_ai.tool.name": name } },
        parent,
      );
      const started = performance.now();
      const close = (outcome: "ok" | "error"): void =>
        finish(
          span,
          { outcome },
          { "enduragent.duration_ms": Math.round(performance.now() - started) },
        );
      try {
        const result = await (execute as (i: unknown, o: unknown) => unknown)(input, options);
        close("ok");
        return result;
      } catch (error) {
        close("error");
        throw error;
      }
    },
  } as Tool;
}

export function traceToolSet(tools: ToolSet): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => [name, traceToolCall(name, tool)]),
  ) as ToolSet;
}
