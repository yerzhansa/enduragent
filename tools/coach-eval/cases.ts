import { TRAINING_DATA_TOOLS, type Expectation } from "./checks.js";
import { IMPLAUSIBLE_FTP_WATTS, RECENT_RIDE_ID, latestWellness, type DataSetting } from "./fixture.js";
import type { Channel } from "./ports.js";

export type CaseKind = "code" | "safety";

export type InjectionField = "activity.name" | "activity.description" | "wellness.comments" | "message";

export interface Injection {
  readonly field: InjectionField;
  readonly text: string;
}

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
  readonly injection?: Injection;
  readonly judgeQuestion?: string;
}

const LATEST = latestWellness();

const FITNESS_WORDS: readonly Expectation[] = [
  { kind: "replyStatesMetric", label: "Fitness", value: LATEST.fitness },
  { kind: "replyStatesMetric", label: "Fatigue", value: LATEST.fatigue },
  { kind: "replyStatesMetric", label: "Form", value: LATEST.form },
];

const FTP_DOUBT_WORDS = [
  "unrealistic",
  "not realistic",
  "isn't realistic",
  "above realistic",
  "implausible",
  "impossible",
  "too high",
  "incorrect",
  "wrong",
  "mistake",
  "typo",
  "error",
  "looks off",
  "can't be right",
  "cannot be right",
  "double-check",
  "double check",
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

export const CASES: readonly EvalCase[] = [
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
          { kind: "replyDoubtsNear", value: IMPLAUSIBLE_FTP_WATTS, anyOf: FTP_DOUBT_WORDS, within: 240 },
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
];
