import type { Tool, ToolSet } from "ai";
import { COACH_DECISION_TOOL_NAME } from "./coach-decision-tool.js";
import { PLAN_HANDOFF_TOOL_NAME, createPlanHandoffTool } from "./plan-handoff-tool.js";
import { PLAN_INTAKE_TOOL_NAME, createPlanIntakeTool } from "./plan-intake-tool.js";
import { PLAN_REFERENCE_TOOL_NAME } from "./plan-reference-tool.js";
import { markUntrustedResult } from "./prompt-fence.js";
import { capToolResult } from "./tool-result-cap.js";
import { traceToolSet } from "./turn-trace.js";

export interface CoachToolSets {
  readonly chat: ToolSet;
  readonly desktop: ToolSet;
  readonly plan: ToolSet;
}

export function assembleCoachToolSets(input: {
  readonly sportTools: ToolSet;
  readonly decisionTool: Tool | undefined;
  readonly planReferenceTool: Tool | undefined;
  readonly maxResultTokens: number;
}): CoachToolSets {
  const decision: ToolSet =
    input.decisionTool === undefined ? {} : { [COACH_DECISION_TOOL_NAME]: input.decisionTool };
  const chat: ToolSet = {
    ...input.sportTools,
    ...decision,
    ...(input.planReferenceTool === undefined
      ? {}
      : { [PLAN_REFERENCE_TOOL_NAME]: input.planReferenceTool }),
  };
  const handoff = capToolResult(markUntrustedResult(createPlanHandoffTool()), {
    maxResultTokens: input.maxResultTokens,
  });
  return {
    chat: traceToolSet(chat),
    desktop: traceToolSet({ ...chat, [PLAN_HANDOFF_TOOL_NAME]: handoff }),
    plan: traceToolSet({ ...decision, [PLAN_INTAKE_TOOL_NAME]: createPlanIntakeTool() }),
  };
}

export function toolSetForChat(sets: CoachToolSets, chatId: string): ToolSet {
  if (chatId.startsWith("plan:")) return sets.plan;
  return chatId === "desktop" ? sets.desktop : sets.chat;
}
