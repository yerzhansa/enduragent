import { STRONG_DOUBT_PHRASES, TRAINING_DATA_TOOLS, WEAK_DOUBT_PHRASES, type Expectation } from "./checks.js";
import { FTP_WATTS, IMPLAUSIBLE_FTP_WATTS, RECENT_RIDE_ID, STALE_DAYS, latestWellness, type DataSetting } from "./fixture.js";
import { TOMORROW_WORKOUT_ID, WEEKLY_LOAD, type Injection } from "./fixture-intervals.js";
import type { Channel } from "./ports.js";
import { SAFETY_CASES } from "./safety-cases.js";

export type CaseKind = "code" | "safety";

export const RUNS_PER_KIND: Readonly<Record<CaseKind, number>> = { code: 1, safety: 3 };

export interface CaseTurn {
  readonly message: string;
  readonly expect: readonly Expectation[];
}

export interface EvalCase {
  readonly id: string;
  readonly kind: CaseKind;
  readonly channel: Channel;
  readonly data: DataSetting;
  readonly turns: readonly CaseTurn[];
  readonly expectAcrossTurns?: readonly Expectation[];
  readonly injection?: Injection;
  readonly judgeQuestion?: string;
}

const LATEST = latestWellness();

const GOAL_WORDS = ["gran fondo", "granfondo", "fondo", "160 km", "160-km", "160km"];

const ASKS_WHICH = [
  "which one",
  "which ride",
  "which session",
  "which activity",
  "which of",
  "which would you",
  "which do you",
  "which you",
];

const INFERENCE_WORDS = [
  "infer",
  "inferred",
  "inferring",
  "inference",
  "appear to be",
  "appears to be",
  "looks like one",
  "looks like the same",
  "look like one",
  "look like the same",
  "look like parts",
  "likely one",
  "likely the same",
  "likely part of",
  "probably one",
  "probably the same",
  "probably part of",
  "assume",
  "assuming",
  "assumed",
  "seem to be",
  "seems to be",
];

const STALE_AGE_WORDS = [`${STALE_DAYS} days`, `${STALE_DAYS}-day`, "ten days", "ten-day"];

const FITNESS_WORDS: readonly Expectation[] = [
  { kind: "replyStatesMetric", label: "Fitness", value: LATEST.fitness },
  { kind: "replyStatesMetric", label: "Fatigue", value: LATEST.fatigue },
  { kind: "replyStatesMetric", label: "Form", value: LATEST.form },
];

const WARM_UP = ["warm-up", "warm up", "warmup", "warming up"];
const COOL_DOWN = ["cool-down", "cool down", "cooldown", "cooling down", "warm-down", "warm down"];

const READ_FAILURE_WORDS = [
  "unavailable",
  "not available",
  "isn't available",
  "couldn't",
  "could not",
  "can't",
  "cannot",
  "unable",
  "failed",
  "no access",
  "don't have",
  "do not have",
];

const RIDE_ID = [RECENT_RIDE_ID];

export const CODE_CASES: readonly EvalCase[] = [
  {
    id: "status",
    kind: "code",
    channel: "desktop",
    data: "connected",
    turns: [{ message: "What's my current status?", expect: FITNESS_WORDS }],
  },
  {
    id: "status-with-form-question",
    kind: "code",
    channel: "desktop",
    data: "connected",
    turns: [{ message: "What's my status, and how is my Form this week?", expect: FITNESS_WORDS }],
  },
  {
    id: "workout-45-minutes-indoors",
    kind: "code",
    channel: "desktop",
    data: "connected",
    turns: [
      {
        message: "Design me a 45-minute workout I can do indoors today.",
        expect: [
          { kind: "replyMentions", anyOf: WARM_UP },
          { kind: "replyMentions", anyOf: COOL_DOWN },
        ],
      },
    ],
  },
  {
    id: "zones-from-ftp",
    kind: "code",
    channel: "desktop",
    data: "connected",
    turns: [
      {
        message: "What are my power zones for an FTP of 250 W?",
        expect: [{ kind: "calledWith", tool: "calculate_zones", argument: "ftpWatts", oneOf: [250] }],
      },
    ],
  },
  {
    id: "not-connected",
    kind: "code",
    channel: "desktop",
    data: "not-connected",
    turns: [
      {
        message: "What's my current status?",
        expect: [
          { kind: "notOffered", tools: TRAINING_DATA_TOOLS },
          { kind: "notCalled", tools: TRAINING_DATA_TOOLS },
          { kind: "replyQuotesNoMetricNumbers" },
        ],
      },
    ],
  },
  {
    id: "reads-failing",
    kind: "code",
    channel: "desktop",
    data: "reads-failing",
    turns: [
      {
        message: "What workout should I do today?",
        expect: [
          { kind: "replyMentions", anyOf: READ_FAILURE_WORDS },
          { kind: "replyQuotesNoMetricNumbers" },
        ],
      },
    ],
  },
  {
    id: "ftp-not-usable",
    kind: "code",
    channel: "desktop",
    data: "implausible-ftp",
    turns: [
      {
        message: "Give me a threshold workout with watt targets for today.",
        expect: [
          {
            kind: "notCalledWith",
            tool: "calculate_zones",
            argument: "ftpWatts",
            oneOf: [IMPLAUSIBLE_FTP_WATTS],
          },
          { kind: "replyWattTargetsAtMost", max: 600, statedFtp: IMPLAUSIBLE_FTP_WATTS },
          {
            kind: "replyDoubtsNear",
            value: IMPLAUSIBLE_FTP_WATTS,
            nearby: STRONG_DOUBT_PHRASES,
            sameSentence: WEAK_DOUBT_PHRASES,
            within: 240,
          },
        ],
      },
    ],
  },
  {
    id: "review-brief",
    kind: "code",
    channel: "desktop",
    data: "connected",
    turns: [
      {
        message: "Give me a brief review of my ride yesterday.",
        expect: [
          { kind: "called", tool: "intervals_fetch_activities" },
          { kind: "notCalled", tools: ["intervals_fetch_activity", "intervals_fetch_streams"] },
        ],
      },
    ],
  },
  {
    id: "review-default",
    kind: "code",
    channel: "desktop",
    data: "connected",
    turns: [
      {
        message: "Review my ride from yesterday.",
        expect: [
          { kind: "calledWith", tool: "intervals_fetch_activity", argument: "activityId", oneOf: RIDE_ID },
          { kind: "notCalled", tools: ["intervals_fetch_streams"] },
        ],
      },
    ],
  },
  {
    id: "review-deep",
    kind: "code",
    channel: "desktop",
    data: "connected",
    turns: [
      {
        message: "Give me a deep review of my ride from yesterday.",
        expect: [
          { kind: "calledWith", tool: "intervals_fetch_activity", argument: "activityId", oneOf: RIDE_ID },
          { kind: "calledWith", tool: "intervals_fetch_streams", argument: "activityId", oneOf: RIDE_ID },
        ],
      },
    ],
  },
  {
    id: "unrealistic-target",
    kind: "code",
    channel: "desktop",
    data: "connected",
    turns: [
      {
        message:
          "I'm an intermediate rider. Is it realistic to raise my FTP to 400 W in the next 8 weeks?",
        expect: [{ kind: "called", tool: "assess_feasibility" }],
      },
    ],
  },
  {
    id: "telegram-add-workout",
    kind: "code",
    channel: "telegram",
    data: "connected",
    turns: [
      {
        message:
          "Add a 60-minute endurance ride at 65% of my FTP to my calendar for tomorrow.",
        expect: [
          { kind: "writeAttempted", tool: "intervals_create_workout" },
          { kind: "proposalPending", tool: "intervals_create_workout" },
          { kind: "noWriteExecuted", target: "calendar" },
        ],
      },
    ],
  },
  {
    id: "goal-change",
    kind: "code",
    channel: "desktop",
    data: "connected",
    turns: [
      {
        message: "My goal has changed: I'm now training for a 160 km gran fondo 12 weeks from now.",
        expect: [{ kind: "writeAttempted", tool: "memory_write" }],
      },
      {
        message: "What should my key workout be this week?",
        expect: [{ kind: "replyMentions", anyOf: GOAL_WORDS }],
      },
    ],
  },
  {
    id: "threshold-45-minutes",
    kind: "code",
    channel: "desktop",
    data: "connected",
    turns: [
      {
        message: "Give me a 45-minute threshold session for today with power targets.",
        expect: [
          { kind: "replyHasTargetNear", ftp: FTP_WATTS, minPercent: 90, maxPercent: 105 },
          { kind: "replyMentions", anyOf: WARM_UP },
        ],
      },
    ],
  },
  {
    id: "review-two-rides-one-day",
    kind: "code",
    channel: "desktop",
    data: "same-day-rides",
    turns: [
      {
        message: "Review my ride from yesterday.",
        expect: [
          { kind: "called", tool: "intervals_fetch_activities" },
          { kind: "notCalled", tools: ["intervals_fetch_activity", "intervals_fetch_streams"] },
          { kind: "replyMentions", anyOf: ASKS_WHICH },
        ],
      },
    ],
  },
  {
    id: "review-close-rides",
    kind: "code",
    channel: "cli",
    data: "intervals-close-rides",
    turns: [
      {
        message: "Review my ride from yesterday.",
        expect: [
          { kind: "called", tool: "intervals_fetch_activities" },
          { kind: "notCalled", tools: ["intervals_fetch_streams"] },
          { kind: "replyMentions", anyOf: INFERENCE_WORDS },
        ],
      },
    ],
  },
  {
    id: "stale-data",
    kind: "code",
    channel: "desktop",
    data: "stale-data",
    turns: [
      {
        message: "What's my current status?",
        expect: [{ kind: "replyMentions", anyOf: STALE_AGE_WORDS }],
      },
    ],
  },
  {
    id: "weekly-load",
    kind: "code",
    channel: "cli",
    data: "intervals",
    turns: [
      {
        message: "What was my total Load over the last 7 days, including today?",
        expect: [
          { kind: "called", tool: "intervals_fetch_activities" },
          { kind: "replyContainsNumber", value: WEEKLY_LOAD },
        ],
      },
    ],
  },
  {
    id: "plan-request",
    kind: "code",
    channel: "desktop",
    data: "connected",
    turns: [
      {
        message:
          "I'm an intermediate rider with about 8 hours a week to train. My 160 km gran fondo is 12 weeks " +
          "from today. Can you sketch out a training plan for it?",
        expect: [
          { kind: "called", tool: "build_plan_skeleton" },
          { kind: "notCalled", tools: ["plan_save"] },
        ],
      },
    ],
  },
  {
    id: "telegram-delete-workout",
    kind: "code",
    channel: "telegram",
    data: "intervals",
    turns: [
      {
        message: "Please delete tomorrow's workout from my calendar.",
        expect: [{ kind: "noWriteExecuted", target: "calendar" }],
      },
      {
        message: "Yes, delete it.",
        expect: [{ kind: "noWriteExecuted", target: "calendar" }],
      },
    ],
    expectAcrossTurns: [
      { kind: "calledWith", tool: "intervals_delete_workout", argument: "eventId", oneOf: [TOMORROW_WORKOUT_ID] },
      { kind: "proposalPending", tool: "intervals_delete_workout" },
      { kind: "noWriteExecuted", target: "calendar" },
    ],
  },
];

export const CASES: readonly EvalCase[] = [...CODE_CASES, ...SAFETY_CASES];
