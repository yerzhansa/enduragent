import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import type { ProbeToolSet } from "./types.js";

export type ToolCallRecorder = (call: { toolName: string; input: unknown }) => void;

interface MockToolSpec {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  makeResult: (input: any) => unknown;
}

const SPORT_ENUM = z.enum(["cycling", "running", "swimming", "multisport"]);
const SPORT3_ENUM = z.enum(["cycling", "running", "swimming"]);

const KNOWN_SKILLS: Array<{ sport: string; topic: string }> = [
  { sport: "cycling", topic: "taper" },
  { sport: "cycling", topic: "fueling" },
  { sport: "running", topic: "return-to-run" },
  { sport: "running", topic: "fueling" },
  { sport: "swimming", topic: "drills" },
  { sport: "swimming", topic: "css-test" },
  { sport: "multisport", topic: "brick" },
];

function skillPath(sport: string, topic: string): string {
  return fileURLToPath(new URL(`./mock/skills/${sport}-${topic}.md`, import.meta.url));
}

function readSkill(sport: string, topic: string): unknown {
  const known = KNOWN_SKILLS.some((s) => s.sport === sport && s.topic === topic);
  const path = skillPath(sport, topic);
  if (!known || !existsSync(path)) {
    return { error: "unknown_topic", available: KNOWN_SKILLS };
  }
  return { sport, topic, content: readFileSync(path, "utf-8").trimEnd() };
}

const SYNTHETIC_ACTIVITIES = [
  { id: 90101, type: "Ride", date: "1998-07-05", name: "Sweet spot 3x12", movingTimeMin: 78, load: 82 },
  { id: 90102, type: "Run", date: "1998-07-04", name: "Easy endurance", movingTimeMin: 46, load: 38 },
  { id: 90103, type: "Swim", date: "1998-07-03", name: "Technique + threshold", movingTimeMin: 40, load: 30 },
  { id: 90104, type: "Ride", date: "1998-07-02", name: "Endurance Z2", movingTimeMin: 120, load: 95 },
  { id: 90105, type: "Run", date: "1998-07-01", name: "Strides + tempo", movingTimeMin: 52, load: 48 },
];

const METRIC_EXPLAIN_MAP: Record<string, unknown> = {
  form: {
    inputs: "Fitness minus Fatigue",
    computation: "Form = Fitness (long-term load average) - Fatigue (short-term load average)",
    citation: "Banister/Morton fitness-fatigue impulse-response model",
  },
  fitness: {
    inputs: "exponentially weighted long-term Load average",
    computation: "Fitness updates each day toward recent Load with a long time constant",
    citation: "Banister/Morton fitness-fatigue impulse-response model",
  },
  load: {
    inputs: "duration and intensity relative to the sport threshold anchor",
    computation: "Load scales session duration by relative intensity against the sport anchor",
    citation: "external-oracle training-load formulation",
  },
};

const MOCK_TOOLS: MockToolSpec[] = [
  {
    name: "memory_read",
    description: "Read the athlete's long-term memory document of durable facts. Call when you need standing facts about the athlete (goals, equipment, preferences) that do not change day to day.",
    inputSchema: z.object({}),
    makeResult: () => ({
      facts: [
        "Prefers morning sessions; strongest on the bike, weakest in the water.",
        "Targeting a sub-2:30 Olympic-distance triathlon.",
      ],
    }),
  },
  {
    name: "memory_query",
    description: "Query dated coaching notes and the event ledger over a date range. Call FIRST for any question about the past ('what did we note', 'when did I', 'how did that go') before claiming a note does not exist.",
    inputSchema: z.object({ from: z.string(), to: z.string() }),
    makeResult: (input) => ({
      echo: input,
      notes: [
        "1998-04-18: left knee flared after downhill running; backed off run volume.",
        "1998-05-20: reset critical swim pace to 1:45 /100m after a pool test.",
      ],
    }),
  },
  {
    name: "memory_write",
    description: "Persist a durable athlete fact to long-term memory. Call when the athlete shares a fact worth remembering across sessions (FTP, weight, schedule, goal, injury).",
    inputSchema: z.object({ content: z.string() }),
    makeResult: () => ({ ok: true }),
  },
  {
    name: "ledger_append",
    description: "Append a dated coaching decision or event to the athlete's ledger. Call when a decision is made that should be recallable later by date.",
    inputSchema: z.object({ entry: z.string() }),
    makeResult: () => ({ ok: true }),
  },
  {
    name: "plan_save",
    description: "Save the current multi-week training plan document. Call after building or revising a plan the athlete has agreed to.",
    inputSchema: z.object({ plan: z.string() }),
    makeResult: () => ({ ok: true }),
  },
  {
    name: "plan_load",
    description: "Load the athlete's current saved training plan. Call when the athlete asks about their plan or you need the current plan context.",
    inputSchema: z.object({}),
    makeResult: () => ({
      plan: "Build phase, week 3 of 6. Focus: bike sweet spot, run threshold, swim technique. One brick per week.",
    }),
  },
  {
    name: "activities_list",
    description: "List recent activities across all sports, newest first. Call to see what the athlete has actually done, for example when reviewing a session or checking recent training.",
    inputSchema: z.object({ days: z.number().optional() }),
    makeResult: (input) => ({ echo: input, activities: SYNTHETIC_ACTIVITIES }),
  },
  {
    name: "activity_detail",
    description: "Fetch one activity's per-interval detail by id. Call after activities_list when you need the splits of a specific structured session.",
    inputSchema: z.object({ activityId: z.number() }),
    makeResult: (input) => ({
      id: input.activityId,
      type: "Ride",
      date: "1998-07-05",
      intervals: [
        { rep: 1, minutes: 12, avgPowerW: 238, zone: "sweet spot" },
        { rep: 2, minutes: 12, avgPowerW: 240, zone: "sweet spot" },
        { rep: 3, minutes: 12, avgPowerW: 235, zone: "sweet spot" },
      ],
    }),
  },
  {
    name: "activity_streams",
    description: "Fetch downsampled time-series streams (watts, heartrate, pace, cadence) for one activity. Call only for a deep review that needs pacing curves or decoupling.",
    inputSchema: z.object({ activityId: z.number(), streams: z.array(z.string()) }),
    makeResult: (input) => ({
      id: input.activityId,
      points: 24,
      streams: Object.fromEntries(
        (input.streams as string[]).map((s) => [s, Array.from({ length: 24 }, (_, i) => i + 1)]),
      ),
    }),
  },
  {
    name: "athlete_state",
    description: "Read the athlete's current anchors, zones, and per-discipline monitoring numbers (7d/28d Load, Fitness, Fatigue, Form). Call when a recommendation depends on current fitness/fatigue/form or on the zone anchors.",
    inputSchema: z.object({}),
    makeResult: () => ({
      anchors: { cyclingFtpW: 250, runningCriticalSpeedMps: 3.55, swimCssPer100m: "1:45" },
      cycling: { load7d: 320, load28d: 1180, fitness: 62, fatigue: 71, form: -9 },
      running: { load7d: 145, load28d: 540, fitness: 34, fatigue: 40, form: -6 },
      swimming: { load7d: 60, load28d: 210, fitness: 15, fatigue: 12, form: 3 },
    }),
  },
  {
    name: "adherence_report",
    description: "Summarise planned-versus-completed sessions over a recent window. Call when the athlete asks how well they stuck to the plan or you need adherence context.",
    inputSchema: z.object({ days: z.number().optional() }),
    makeResult: (input) => ({
      echo: input,
      planned: 9,
      completed: 7,
      missed: ["1998-07-06 swim threshold", "1998-07-05 easy run"],
    }),
  },
  {
    name: "metric_explain",
    description: "Explain how a monitoring metric is computed, with its inputs and the cited basis. Call when the athlete asks what a number means or how it is calculated (for example Form, Fitness, or Load).",
    inputSchema: z.object({ metricKey: z.string() }),
    makeResult: (input) => METRIC_EXPLAIN_MAP[String(input.metricKey).toLowerCase()] ?? {
      error: "unknown_metric",
      available: Object.keys(METRIC_EXPLAIN_MAP),
    },
  },
  {
    name: "skill_read",
    description: "Read a deep-protocol skill file for a sport and topic. Call whenever a question needs specific numbers not in the prompt: taper percentages, fueling grams, drill catalogs, test protocols, return-to-run ladders, or brick structure.",
    inputSchema: z.object({ sport: SPORT_ENUM, topic: z.string() }),
    makeResult: (input) => readSkill(String(input.sport), String(input.topic)),
  },
  {
    name: "calculate_zones",
    description: "Compute the training zone table for a sport from its anchor value (FTP watts for cycling, critical speed m/s for running, critical swim pace for swimming). Call when the athlete asks for their zones.",
    inputSchema: z.object({ sport: SPORT3_ENUM, anchorValue: z.number() }),
    makeResult: (input) => ({
      sport: input.sport,
      anchorValue: input.anchorValue,
      zones: [
        { name: "easy", range: "recovery to endurance" },
        { name: "moderate", range: "tempo to sweet spot" },
        { name: "threshold", range: "at the anchor" },
        { name: "hard", range: "above the anchor" },
      ],
    }),
  },
  {
    name: "push_planned_workout",
    description: "Push a single planned workout document to the athlete's calendar on a date. Call to schedule one already-designed workout.",
    inputSchema: z.object({ target: z.enum(["calendar"]), doc: z.string(), date: z.string() }),
    makeResult: () => ({ ok: true, id: 90201 }),
  },
  {
    name: "build_plan_skeleton",
    description: "Build a phased multi-week plan skeleton toward a goal. Call when the athlete wants a new training plan outline before individual workouts are written.",
    inputSchema: z.object({ weeks: z.number(), goal: z.string() }),
    makeResult: (input) => ({
      weeks: input.weeks,
      goal: input.goal,
      phases: ["base", "build", "peak", "taper"],
    }),
  },
  {
    name: "assess_feasibility",
    description: "Assess whether a proposed plan is realistic given the athlete's current state. Call before committing to an ambitious plan to check for injury or overreach risk.",
    inputSchema: z.object({ plan: z.string() }),
    makeResult: () => ({
      feasible: true,
      notes: ["Weekly Load ramp under 8% is sustainable.", "Recovery week scheduled every fourth week."],
    }),
  },
  {
    name: "get_sample_week",
    description: "Return a sample training week for a given phase. Call when the athlete wants to see what a typical week looks like in a phase.",
    inputSchema: z.object({ phase: z.string() }),
    makeResult: (input) => ({
      phase: input.phase,
      week: ["Mon rest", "Tue bike sweet spot", "Wed swim technique", "Thu run threshold", "Fri easy", "Sat long bike", "Sun brick"],
    }),
  },
  {
    name: "intervals_create_workout",
    description: "Create a structured cycling or running workout on the calendar from a workout document. Call to schedule a bike or run session you have designed.",
    inputSchema: z.object({ doc: z.string(), date: z.string() }),
    makeResult: () => ({ ok: true, id: 90202 }),
  },
  {
    name: "create_swim_workout",
    description: "Create a structured swim workout on the calendar from a swim workout document (pace-per-100m targets). Call to schedule a pool session.",
    inputSchema: z.object({ doc: z.string(), date: z.string() }),
    makeResult: () => ({ ok: true, id: 90203 }),
  },
  {
    name: "create_brick_workout",
    description: "Create a brick (back-to-back multi-discipline) workout on the calendar from ordered segments. Call to schedule a bike-to-run or swim-to-bike brick.",
    inputSchema: z.object({ segments: z.array(z.string()), date: z.string() }),
    makeResult: () => ({ ok: true, id: 90204 }),
  },
  {
    name: "reconcile_multisport_taper",
    description: "Build one event-anchored taper that coordinates all disciplines toward a race date. Call when the athlete wants a taper for a multisport event across bike, run, and swim.",
    inputSchema: z.object({ raceDate: z.string(), disciplines: z.array(z.string()) }),
    makeResult: (input) => ({
      raceDate: input.raceDate,
      disciplines: input.disciplines,
      taper: [
        { daysOut: 8, note: "cut volume to 70%, hold light intensity across all three" },
        { daysOut: 3, note: "short primers each discipline" },
        { daysOut: 1, note: "easy shakeout only" },
      ],
    }),
  },
  {
    name: "intervals_delete_workout",
    description: "Delete a planned calendar workout by event id. Call when the athlete asks to remove or cancel a scheduled session.",
    inputSchema: z.object({ eventId: z.number() }),
    makeResult: () => ({ ok: true }),
  },
  {
    name: "intervals_list_events",
    description: "List upcoming planned calendar events over a window. Call when the athlete asks what is scheduled or you need the upcoming calendar.",
    inputSchema: z.object({ days: z.number().optional() }),
    makeResult: (input) => ({
      echo: input,
      events: [
        { id: 90301, date: "1998-07-07", title: "Swim threshold" },
        { id: 90302, date: "1998-07-08", title: "Bike VO2 5x4" },
        { id: 90303, date: "1998-07-09", title: "Easy run" },
      ],
    }),
  },
  {
    name: "intervals_fetch_streams",
    description: "Transitional escape hatch for raw activity streams by id. Prefer activity_streams; call this only when a legacy stream fetch is explicitly needed.",
    inputSchema: z.object({ activityId: z.number(), streams: z.array(z.string()) }),
    makeResult: (input) => ({
      id: input.activityId,
      points: 24,
      streams: Object.fromEntries(
        (input.streams as string[]).map((s) => [s, Array.from({ length: 24 }, (_, i) => i + 1)]),
      ),
    }),
  },
];

export { MOCK_TOOLS };

export const MOCK_TOOL_NAMES: string[] = MOCK_TOOLS.map((t) => t.name);

export function buildToolSet(recorder: ToolCallRecorder): ProbeToolSet {
  const set: Record<string, { description: string; inputSchema: z.ZodType; execute: (input: unknown) => unknown }> = {};
  for (const spec of MOCK_TOOLS) {
    set[spec.name] = {
      description: spec.description,
      inputSchema: spec.inputSchema,
      execute: (input: unknown) => {
        recorder({ toolName: spec.name, input });
        return spec.makeResult(input);
      },
    };
  }
  return set as unknown as ProbeToolSet;
}

export function toAnthropicToolsJson(): Array<{ name: string; description: string; input_schema: unknown }> {
  return MOCK_TOOLS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    input_schema: z.toJSONSchema(spec.inputSchema),
  }));
}
