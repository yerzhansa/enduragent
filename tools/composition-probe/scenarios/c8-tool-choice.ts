import type { ProbeScenario } from "../types.js";

const c = (id: string, userMessage: string, expectedTools: string[]): ProbeScenario => ({
  id,
  class: "c8-tool-choice",
  userMessage,
  expectedTools,
});

export const C8_TOOL_CHOICE: ProbeScenario[] = [
  c("c8-01", "What did we decide about my knee last month?", ["memory_query"]),
  c("c8-02", "Show my last week of sessions.", ["activities_list"]),
  c("c8-03", "Explain how my Form number is computed.", ["metric_explain", "athlete_state"]),
  c("c8-04", "Delete tomorrow's workout.", ["intervals_delete_workout"]),
  c("c8-05", "Schedule this swim for Friday.", ["create_swim_workout"]),
  c("c8-06", "Build my tri taper toward race day.", ["reconcile_multisport_taper"]),
  c("c8-07", "What's my current fitness, fatigue, and form right now?", ["athlete_state"]),
  c("c8-08", "What's on my calendar this week?", ["intervals_list_events"]),
  c("c8-09", "Give me the exact grams per hour to fuel my long ride.", ["skill_read"]),
  c("c8-10", "What's a good mindset to hold on race morning?", ["<none>"]),
];
