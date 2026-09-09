import { describe, expect, it } from "vitest";
import {
  COACH_RPC_METHOD_NAMES,
  COACH_RPC_METHOD_REGISTRY,
  CoachRpcRequestEnvelopeSchema,
  PLAN_CREATION_ANSWER_KEYS,
  PlanCreationActivateRpcParamsSchema,
  PlanCreationActivateRpcResultSchema,
  PlanCreationAnswerInputSchema,
  PlanCreationAnswerSchema,
  PlanCreationCommitmentRuleSchema,
  PlanCreationAnswerRpcParamsSchema,
  PlanCreationAnswerRpcResultSchema,
  PlanCreationAnswerSummarySchema,
  PlanCreationCardModelSchema,
  PlanCreationDiscardRpcParamsSchema,
  PlanCreationDiscardRpcResultSchema,
  PlanCreationOpenQuestionSchema,
  PlanCreationDraftSchema,
  PlanCreationPreviewRpcParamsSchema,
  PlanCreationPreviewRpcResultSchema,
  ListPlanningRequestsRpcResultSchema,
  PlanCreationInterpretCommitmentsRpcParamsSchema,
  PlanCreationInterpretCommitmentsRpcResultSchema,
  PlanCreationStartRpcParamsSchema,
  PlanCreationStartRpcResultSchema,
  NoRpcEventSchema,
} from "../src/index.js";

const creationId = "01J00000000000000000000000";
const step = { current: 1, total: 9 } as const;
const authoredOption = {
  label: "Something else",
  detail: "Answer in your own words.",
  editorLabel: "Write your answer.",
  placeholder: "Type an answer",
} as const;
const goalQuestion = {
  kind: "goal-question" as const,
  step,
  prompt: "Goal?",
  candidates: [],
  eventNotListedOption: {
    label: "Event not listed",
    detail: "Tell me the event name and its exact date.",
    placeholder: "Event name",
    nameLabel: "Event name",
    dateLabel: "Event date",
  },
  fitnessOption: {
    label: "Improve without an event",
    detail: "Build fitness for a fixed number of weeks.",
  },
};
const card = {
  creationId,
  version: 1,
  status: "in-progress" as const,
  draft: null,
  draftStale: false,
  calendarWindow: null,
  pendingCommitment: null,
  readiness: "incomplete" as const,
  answeredSummaries: [],
  openQuestion: goalQuestion,
};
const answers = [
  { kind: "goal", goal: { kind: "event-candidate", candidateId: creationId } },
  { kind: "goal", goal: { kind: "event-manual", name: "Tour", date: "1998-10-18" } },
  { kind: "goal", goal: { kind: "fitness", outcome: "Build power" } },
  { kind: "goal", goal: { kind: "fitness" } },
  { kind: "success", success: { kind: "fitness-choice", choice: "climb-stronger" } },
  { kind: "success", success: { kind: "event-finish", choice: "finish-fast" } },
  { kind: "success", success: { kind: "authored", text: "Ride well" } },
] as const;

const newAnswers = [
  { kind: "plan-length", weeks: 12 },
  { kind: "start-timing", timing: { kind: "as-soon-as-possible" } },
  { kind: "start-timing", timing: { kind: "earliest", date: "1998-09-07" } },
  { kind: "schedule-mode", mode: "fixed" },
  { kind: "schedule-mode", mode: "flexible" },
  {
    kind: "availability",
    mode: "fixed",
    weeklyHoursLimit: 8,
    longestWorkoutHours: 3,
    usableWeekdays: [1, 3, 5, 7],
  },
  {
    kind: "availability",
    mode: "flexible",
    weeklyHoursLimit: 40.25,
    longestWorkoutHours: 12.25,
  },
  { kind: "commitments", commitments: { kind: "none" } },
  {
    kind: "commitments",
    commitments: { kind: "interpreted", text: "Wednesdays 45 minutes" },
  },
  { kind: "baseline", baseline: "regular" },
  { kind: "baseline", baseline: "occasional" },
  { kind: "baseline", baseline: "starting-again" },
  { kind: "restriction", restriction: { kind: "none" } },
  {
    kind: "restriction",
    restriction: { kind: "no-training", endDate: "1998-09-14" },
  },
  { kind: "restriction", restriction: { kind: "no-hard-training" } },
  {
    kind: "restriction",
    restriction: { kind: "max-duration", hours: 1.5, endDate: "1998-09-21" },
  },
] as const;

const rejectedNewAnswers = [
  ["plan-length", { kind: "plan-length", weeks: 6 }],
  ["start-timing", { kind: "start-timing", timing: { kind: "earliest", date: "1998-02-31" } }],
  ["schedule-mode", { kind: "schedule-mode", mode: "variable" }],
  [
    "availability",
    {
      kind: "availability",
      mode: "flexible",
      weeklyHoursLimit: 0,
      longestWorkoutHours: 2,
    },
  ],
  ["commitments", { kind: "commitments", commitments: { kind: "authored", text: "" } }],
  ["baseline", { kind: "baseline", baseline: "unknown" }],
  [
    "restriction",
    {
      kind: "restriction",
      restriction: { kind: "no-training", text: "Persistent knee pain" },
    },
  ],
] as const;

const newQuestions = [
  {
    kind: "plan-length-question",
    step,
    prompt: "How long should this Plan be?",
    options: [
      { weeks: 4, label: "4 weeks" },
      { weeks: 8, label: "8 weeks" },
      { weeks: 12, label: "12 weeks" },
      { weeks: 16, label: "16 weeks" },
    ],
  },
  {
    kind: "start-timing-question",
    step,
    prompt: "When can this Plan start?",
    earliestAllowed: "1998-09-03",
    options: [
      {
        timing: "as-soon-as-possible",
        label: "As soon as possible",
        detail: "Start at the earliest suitable week.",
      },
      { timing: "earliest", label: "From a date", detail: "Set an earliest date." },
    ],
    dateLabel: "Earliest start date",
  },
  {
    kind: "schedule-mode-question",
    step,
    prompt: "How should Workouts fit your week?",
    options: [
      { mode: "fixed", label: "Fixed", detail: "Put each Workout on a usable day." },
      {
        mode: "flexible",
        label: "Flexible",
        detail: "Choose from an ordered weekly pool.",
      },
    ],
  },
  {
    kind: "availability-question",
    step,
    prompt: "How much time is available?",
    mode: "flexible",
    weeklyHoursOptions: [
      { id: "hours-6", weeklyHoursLimit: 6, label: "5–6 hours" },
      { id: "hours-8", weeklyHoursLimit: 8, label: "7–8 hours" },
      { id: "hours-10", weeklyHoursLimit: 10, label: "9–10 hours" },
    ],
    longestWorkoutLabel: "Longest ride in hours",
    weekdayOptions: [
      { weekday: 1, label: "Mon" },
      { weekday: 2, label: "Tue" },
      { weekday: 3, label: "Wed" },
      { weekday: 4, label: "Thu" },
      { weekday: 5, label: "Fri" },
      { weekday: 6, label: "Sat" },
      { weekday: 7, label: "Sun" },
    ],
    derivedPoolNote: "This weekly limit creates a pool of four Workouts.",
  },
  {
    kind: "commitments-question",
    step,
    prompt: "Any fixed commitments or other training?",
    noneOption: { label: "No fixed commitments" },
    authoredOption: { ...authoredOption, label: "Add commitments or time off" },
  },
  {
    kind: "baseline-question",
    step,
    prompt: "What has training looked like recently?",
    options: [
      { baseline: "regular", label: "Regular", detail: "Training has been consistent." },
      {
        baseline: "occasional",
        label: "Occasional",
        detail: "Training has happened some weeks.",
      },
      {
        baseline: "starting-again",
        label: "Starting again",
        detail: "Training has paused for a while.",
      },
    ],
  },
  {
    kind: "restriction-question",
    step,
    prompt: "Is any Training Restriction active?",
    options: [
      { kind: "none", label: "None" },
      { kind: "no-training", label: "No training", detail: "No Workouts." },
      { kind: "no-hard-training", label: "No hard training", detail: "No intensity." },
      { kind: "max-duration", label: "Maximum duration", detail: "Set a limit." },
    ],
  },
] as const;

const invalidNewQuestions = [
  [
    "goal",
    {
      ...goalQuestion,
      authoredOption: { ...authoredOption, label: "Add commitments or time off" },
      extra: true,
    },
  ],
  [
    "plan-length",
    {
      ...newQuestions[0],
      options: [newQuestions[0].options[0], ...newQuestions[0].options.slice(0, 3)],
    },
  ],
  ["start-timing", { ...newQuestions[1], earliestAllowed: "1998-02-31" }],
  [
    "schedule-mode",
    {
      ...newQuestions[2],
      options: [newQuestions[2].options[0], newQuestions[2].options[0]],
    },
  ],
  ["availability", { ...newQuestions[3], mode: "variable" }],
  [
    "commitments",
    { ...newQuestions[4], authoredOption: { ...newQuestions[4].authoredOption, placeholder: "" } },
  ],
  [
    "baseline",
    {
      ...newQuestions[5],
      options: [newQuestions[5].options[0], newQuestions[5].options[0], newQuestions[5].options[1]],
    },
  ],
  [
    "restriction",
    {
      ...newQuestions[6],
      options: [
        newQuestions[6].options[0],
        newQuestions[6].options[0],
        newQuestions[6].options[1],
        newQuestions[6].options[2],
      ],
    },
  ],
] as const;

const summaryFixtures = [
  {
    answerKey: "goal",
    title: "Main Goal",
    detail: "Build power",
    source: { kind: "athlete" },
    question: card.openQuestion,
    answer: answers[2],
  },
  {
    answerKey: "success",
    title: "Success",
    detail: "Ride well",
    source: { kind: "athlete" },
    question: {
      kind: "success-question",
      step: { current: 2, total: 9 },
      prompt: "Success?",
      input: {
        kind: "fitness-choice",
        options: [
          { choice: "train-consistently", label: "Train consistently", detail: "Repeat weeks." },
          { choice: "climb-stronger", label: "Climb stronger", detail: "Climb steadily." },
          {
            choice: "ride-farther",
            label: "Ride farther comfortably",
            detail: "Build endurance.",
          },
        ],
        authored: {
          label: "Something else",
          detail: "Answer in your own words.",
          editorLabel: "Write your answer.",
        },
        placeholder: "Type an answer",
      },
    },
    answer: answers[6],
  },
  {
    answerKey: "plan-length",
    title: "Plan length",
    detail: "12 weeks",
    source: { kind: "athlete" },
    question: newQuestions[0],
    answer: newAnswers[0],
  },
  {
    answerKey: "start-timing",
    title: "Start timing",
    detail: "As soon as possible",
    source: { kind: "athlete" },
    question: newQuestions[1],
    answer: newAnswers[1],
  },
  {
    answerKey: "schedule-mode",
    title: "Schedule mode",
    detail: "Fixed Schedule",
    source: { kind: "athlete" },
    question: newQuestions[2],
    answer: newAnswers[3],
  },
  {
    answerKey: "availability",
    title: "Availability",
    detail: "8 h",
    source: { kind: "athlete" },
    question: newQuestions[3],
    answer: newAnswers[6],
  },
  {
    answerKey: "commitments",
    title: "Commitments",
    detail: "No fixed commitments",
    source: { kind: "athlete" },
    question: newQuestions[4],
    answer: newAnswers[7],
  },
  {
    answerKey: "baseline",
    title: "Recent training",
    detail: "Regular",
    source: { kind: "derived", label: "recent training" },
    question: newQuestions[5],
    answer: newAnswers[9],
  },
  {
    answerKey: "restriction",
    title: "Training Restriction",
    detail: "None",
    source: { kind: "athlete" },
    question: newQuestions[6],
    answer: newAnswers[12],
  },
] as const;

describe("Plan Creation contract", () => {
  it("accepts every essential answer kind and nested variant", () => {
    newAnswers.forEach((answer) =>
      expect(PlanCreationAnswerInputSchema.parse(answer)).toEqual(answer),
    );
  });

  it.each(rejectedNewAnswers)("rejects an invalid %s answer", (_kind, answer) => {
    expect(PlanCreationAnswerInputSchema.safeParse(answer).success).toBe(false);
  });

  it("rejects invalid availability limits and duplicate fixed weekdays", () => {
    for (const answer of [
      {
        kind: "availability",
        mode: "fixed",
        weeklyHoursLimit: 8,
        longestWorkoutHours: 2,
        usableWeekdays: [1, 3, 3, 6],
      },
      {
        kind: "availability",
        mode: "fixed",
        weeklyHoursLimit: 3,
        longestWorkoutHours: 3.5,
        usableWeekdays: [2, 4, 6],
      },
      {
        kind: "availability",
        mode: "flexible",
        weeklyHoursLimit: 4,
        longestWorkoutHours: 4.5,
      },
    ]) {
      expect(PlanCreationAnswerInputSchema.safeParse(answer).success).toBe(false);
    }
  });

  it("bounds weekly and longest-Workout hours", () => {
    expect(
      PlanCreationAnswerInputSchema.safeParse({
        kind: "availability",
        mode: "flexible",
        weeklyHoursLimit: 168,
        longestWorkoutHours: 24,
      }).success,
    ).toBe(true);
    expect(
      PlanCreationAnswerInputSchema.safeParse({
        kind: "restriction",
        restriction: { kind: "max-duration", hours: 24 },
      }).success,
    ).toBe(true);
    for (const answer of [
      {
        kind: "availability",
        mode: "flexible",
        weeklyHoursLimit: 168.1,
        longestWorkoutHours: 24,
      },
      {
        kind: "availability",
        mode: "flexible",
        weeklyHoursLimit: 168,
        longestWorkoutHours: 24.1,
      },
      {
        kind: "restriction",
        restriction: { kind: "max-duration", hours: 24.1 },
      },
    ]) {
      expect(PlanCreationAnswerInputSchema.safeParse(answer).success).toBe(false);
    }
  });

  it("keeps Training Restriction input free of athlete-authored medical text", () => {
    const answer = PlanCreationAnswerInputSchema.parse({
      kind: "restriction",
      restriction: { kind: "no-training" },
    });
    expect(answer.kind).toBe("restriction");
    if (answer.kind !== "restriction") throw new TypeError("Expected a restriction answer");
    expect(
      Object.entries(answer.restriction)
        .filter(([, value]) => typeof value === "string")
        .map(([key]) => key),
    ).toEqual(["kind"]);
    expect(
      PlanCreationAnswerInputSchema.safeParse({
        kind: "restriction",
        restriction: { kind: "max-duration", hours: 1, details: "Treat knee pain" },
      }).success,
    ).toBe(false);
  });

  it("allows an optional end date only on operational Training Restrictions", () => {
    for (const restriction of [
      { kind: "no-training" },
      { kind: "no-training", endDate: "1998-09-14" },
      { kind: "no-hard-training" },
      { kind: "no-hard-training", endDate: "1998-09-14" },
      { kind: "max-duration", hours: 1.5 },
      { kind: "max-duration", hours: 1.5, endDate: "1998-09-14" },
    ]) {
      expect(
        PlanCreationAnswerInputSchema.safeParse({ kind: "restriction", restriction }).success,
      ).toBe(true);
    }
    expect(
      PlanCreationAnswerInputSchema.safeParse({
        kind: "restriction",
        restriction: { kind: "none", endDate: "1998-09-14" },
      }).success,
    ).toBe(false);
  });

  it("accepts every essential open question kind", () => {
    newQuestions.forEach((question) =>
      expect(PlanCreationOpenQuestionSchema.parse(question)).toEqual(question),
    );
  });

  it("accepts a saved goal question that still carries the retired authored fields", () => {
    const saved = {
      ...goalQuestion,
      eventNotListedOption: {
        ...goalQuestion.eventNotListedOption,
        editorLabel: "Name the event.",
      },
      authoredOption,
    };
    expect(PlanCreationOpenQuestionSchema.parse(saved)).toEqual(saved);
  });

  it.each(invalidNewQuestions)("rejects an invalid %s question", (_kind, question) => {
    expect(PlanCreationOpenQuestionSchema.safeParse(question).success).toBe(false);
  });

  it("accepts the nine answer summary keys in flow order", () => {
    expect(PLAN_CREATION_ANSWER_KEYS).toEqual([
      "goal",
      "plan-length",
      "schedule-mode",
      "availability",
      "start-timing",
      "commitments",
      "baseline",
      "success",
      "restriction",
    ]);
    summaryFixtures.forEach((summary) =>
      expect(PlanCreationAnswerSummarySchema.parse(summary)).toEqual(summary),
    );
  });

  it("accepts text interpretation and confirmation actions without trusting submitted rules", () => {
    for (const answer of [
      { kind: "commitments", commitments: { kind: "interpreted", text: "Wed 45 min" } },
      { kind: "commitments-interpret", text: "Wed 45 min" },
      { kind: "commitments-confirm" },
      { kind: "commitments-cancel" },
    ])
      expect(PlanCreationAnswerInputSchema.parse(answer)).toEqual(answer);
    for (const commitments of [
      { kind: "authored", text: "Wed 45 min" },
      { kind: "authored", text: "Wed 45 min", acknowledged: true },
      { kind: "interpreted", text: "Wed 45 min", rules: [], status: "confirmed" },
      { kind: "none", acknowledged: true },
    ])
      expect(
        PlanCreationAnswerInputSchema.safeParse({ kind: "commitments", commitments }).success,
      ).toBe(false);
  });

  it("reads legacy authored answers as unresolved without applying their text", () => {
    for (const acknowledged of [undefined, false, true]) {
      const normalized = PlanCreationAnswerSchema.parse({
        kind: "commitments",
        commitments: { kind: "authored", text: "  Wed 45 min  ", acknowledged },
      });
      expect(normalized).toEqual({
        kind: "commitments",
        commitments: { kind: "interpreted", text: "  Wed 45 min  ", rules: [], status: "clarify" },
      });
      expect(PlanCreationAnswerSchema.parse(normalized)).toEqual(normalized);
      expect(
        PlanCreationCardModelSchema.parse({
          ...card,
          pendingCommitment: { text: "  Wed 45 min  ", rules: [], status: "clarify", unparsed: [] },
        }).pendingCommitment?.text,
      ).toBe("  Wed 45 min  ");
    }
  });

  it("requires normalized stored commitments and strict valid rules", () => {
    const rules = [{ kind: "weekday-duration", day: 3, minutes: 45 }];
    for (const status of ["confirmed", "clarify"]) {
      const answer = {
        kind: "commitments",
        commitments: { kind: "interpreted", text: "Wed 45 min", rules, status },
      };
      expect(PlanCreationAnswerSchema.parse(answer)).toEqual(answer);
    }
    for (const rule of [
      { kind: "weekday-duration", day: 0, minutes: 45 },
      { kind: "weekday-duration", day: 3, minutes: 0 },
      { kind: "weekday-duration", day: 3, minutes: 1441 },
      { kind: "weekday-unavailable", day: 8 },
      { kind: "hard-weekday", day: 3, extra: true },
      { kind: "time-off", start: "1998-02-30", end: "1998-03-01" },
      { kind: "time-off", start: "1998-03-02", end: "1998-03-01" },
    ])
      expect(PlanCreationCommitmentRuleSchema.safeParse(rule).success).toBe(false);
    expect(PlanCreationAnswerSchema.safeParse({ kind: "commitments-confirm" }).success).toBe(false);
  });

  it("requires the nullable strict pending commitment projection", () => {
    const pending = {
      text: "Wed 45 min",
      rules: [{ kind: "weekday-duration", day: 3, minutes: 45 }],
      status: "confirm",
      unparsed: [],
    };
    expect(
      PlanCreationCardModelSchema.parse({ ...card, pendingCommitment: pending }).pendingCommitment,
    ).toEqual(pending);
    expect(PlanCreationCardModelSchema.parse(card).pendingCommitment).toBeNull();
    const { pendingCommitment: _pending, ...missing } = card;
    expect(PlanCreationCardModelSchema.safeParse(missing).success).toBe(false);
    for (const invalid of [
      { ...pending, rules: [] },
      { ...pending, unparsed: ["sometimes"] },
      { ...pending, acknowledged: false },
    ]) {
      expect(
        PlanCreationCardModelSchema.safeParse({ ...card, pendingCommitment: invalid }).success,
      ).toBe(false);
    }
    expect(
      PlanCreationCardModelSchema.safeParse({ ...card, commitmentsAcknowledgement: null }).success,
    ).toBe(false);
  });

  it("requires consistent Card readiness and open-question states", () => {
    expect(PlanCreationCardModelSchema.parse(card).readiness).toBe("incomplete");
    expect(
      PlanCreationCardModelSchema.parse({ ...card, readiness: "ready", openQuestion: null })
        .readiness,
    ).toBe("ready");
    expect(PlanCreationCardModelSchema.safeParse({ ...card, readiness: "ready" }).success).toBe(
      false,
    );
    expect(PlanCreationCardModelSchema.safeParse({ ...card, openQuestion: null }).success).toBe(
      false,
    );
    const withoutReadiness: Record<string, unknown> = { ...card };
    delete withoutReadiness.readiness;
    expect(PlanCreationCardModelSchema.safeParse(withoutReadiness).success).toBe(false);
  });

  it("requires a strict nullable calendar window with civil dates", () => {
    const calendarWindow = { startDate: "1998-09-01", endDate: "1998-09-07" };
    expect(PlanCreationCardModelSchema.parse({ ...card, calendarWindow }).calendarWindow).toEqual(
      calendarWindow,
    );
    expect(PlanCreationCardModelSchema.parse(card).calendarWindow).toBeNull();
    const missing: Record<string, unknown> = { ...card };
    delete missing.calendarWindow;
    expect(PlanCreationCardModelSchema.safeParse(missing).success).toBe(false);
    for (const invalid of [
      { startDate: "1998-09-01" },
      { ...calendarWindow, startDate: "1998-09-01T00:00:00Z" },
      { ...calendarWindow, endDate: "1998-02-30" },
      { ...calendarWindow, timezone: "UTC" },
    ]) {
      expect(
        PlanCreationCardModelSchema.safeParse({ ...card, calendarWindow: invalid }).success,
      ).toBe(false);
    }
  });

  it("closes every answer and host-owned Card variant", () => {
    answers.forEach((answer) =>
      expect(PlanCreationAnswerInputSchema.parse(answer)).toEqual(answer),
    );
    expect(PlanCreationCardModelSchema.parse(card)).toEqual(card);
    expect(
      PlanCreationCardModelSchema.parse({
        ...card,
        version: 2,
        answeredSummaries: [{ ...summaryFixtures[0], detail: "x".repeat(2_000) }],
        openQuestion: {
          ...summaryFixtures[1].question,
        },
      }),
    ).toMatchObject({ version: 2, openQuestion: { input: { kind: "fitness-choice" } } });
    expect(
      PlanCreationCardModelSchema.parse({
        ...card,
        openQuestion: {
          kind: "success-question",
          step: { current: 2, total: 8 },
          prompt: "Success?",
          input: {
            kind: "event-finish",
            options: [
              {
                choice: "finish-comfortably",
                label: "Finish comfortably",
                detail: "Enjoy the finish.",
              },
              { choice: "finish-fast", label: "Finish fast", detail: "Finish strongly." },
              {
                choice: "race-for-result",
                label: "Race for a result",
                detail: "Race strongly.",
              },
            ],
            authored: authoredOption,
          },
        },
      }),
    ).toMatchObject({ openQuestion: { input: { kind: "event-finish" } } });
    expect(() =>
      PlanCreationCardModelSchema.parse({
        ...card,
        answeredSummaries: [{ ...summaryFixtures[0], detail: "x".repeat(2_001) }],
      }),
    ).toThrow();
  });

  it("rejects renderer-authored fields and malformed command boundaries", () => {
    expect(() =>
      PlanCreationAnswerInputSchema.parse({ ...answers[0], name: "Untrusted" }),
    ).toThrow();
    expect(() =>
      PlanCreationAnswerInputSchema.parse({
        kind: "goal",
        goal: { kind: "event-manual", name: "Tour", date: "2026-2-3" },
      }),
    ).toThrow();
    expect(
      PlanCreationAnswerInputSchema.parse({
        kind: "goal",
        goal: { kind: "event-manual", name: "Tour", date: "2026-02-28" },
      }),
    ).toMatchObject({ goal: { date: "2026-02-28" } });
    expect(() =>
      PlanCreationAnswerInputSchema.parse({
        kind: "goal",
        goal: { kind: "event-manual", name: "Tour", date: "2026-02-31" },
      }),
    ).toThrow();
    expect(() => PlanCreationCardModelSchema.parse({ ...card, version: 0 })).toThrow();
    expect(() =>
      PlanCreationStartRpcParamsSchema.parse({ commandId: "start", extra: true }),
    ).toThrow();
    expect(() =>
      PlanCreationAnswerRpcParamsSchema.parse({
        commandId: "answer",
        creationId,
        expectedVersion: 1,
        answer: answers[2],
        extra: true,
      }),
    ).toThrow();
    expect(
      PlanCreationDiscardRpcParamsSchema.parse({
        commandId: "discard",
        creationId,
        expectedVersion: 1,
      }),
    ).toEqual({ commandId: "discard", creationId, expectedVersion: 1 });
    expect(() =>
      PlanCreationDiscardRpcParamsSchema.parse({
        commandId: "discard",
        creationId,
        expectedVersion: 1,
        extra: true,
      }),
    ).toThrow();
    expect(() =>
      PlanCreationDiscardRpcParamsSchema.parse({
        commandId: "discard",
        creationId,
        expectedVersion: 0,
      }),
    ).toThrow();
  });

  it("accepts every terminal result and only the four registered operations", () => {
    expect(
      PlanCreationStartRpcResultSchema.parse({
        status: "started",
        outcome: "created",
        planCreation: card,
      }),
    ).toMatchObject({ outcome: "created" });
    expect(
      PlanCreationStartRpcResultSchema.parse({ status: "rejected", reason: "command-conflict" }),
    ).toMatchObject({ status: "rejected" });
    for (const reason of [
      "stale-version",
      "command-conflict",
      "no-unfinished-creation",
      "answer-not-expected",
      "invalid-answer",
    ] as const) {
      expect(
        PlanCreationAnswerRpcResultSchema.parse({ status: "rejected", reason, planCreation: null }),
      ).toEqual({ status: "rejected", reason, planCreation: null });
    }
    expect(PlanCreationDiscardRpcResultSchema.parse({ status: "discarded" })).toEqual({
      status: "discarded",
    });
    for (const reason of ["stale-version", "command-conflict", "no-unfinished-creation"] as const) {
      expect(
        PlanCreationDiscardRpcResultSchema.parse({
          status: "rejected",
          reason,
          planCreation: reason === "stale-version" ? card : null,
        }),
      ).toMatchObject({ status: "rejected", reason });
    }
    expect(() =>
      PlanCreationDiscardRpcResultSchema.parse({ status: "discarded", planCreation: null }),
    ).toThrow();
    expect(() =>
      PlanCreationDiscardRpcResultSchema.parse({
        status: "rejected",
        reason: "invalid-answer",
        planCreation: null,
      }),
    ).toThrow();
    expect(COACH_RPC_METHOD_NAMES.filter((name) => name.startsWith("plan_creation."))).toEqual([
      "plan_creation.interpretCommitments",
      "plan_creation.start",
      "plan_creation.answer",
      "plan_creation.preview",
      "plan_creation.discard",
      "plan_creation.activate",
    ]);
  });

  it("validates activation identity, command boundaries, and civil dates", () => {
    const request = { commandId: "activate", creationId, expectedVersion: 2, incumbent: null };
    expect(PlanCreationActivateRpcParamsSchema.parse(request)).toEqual(request);
    for (const extra of [
      { expectedVersion: 0 },
      { commandId: "" },
      { creationId: "invalid" },
      { activatedAt: "1998-09-07" },
      { planId: creationId },
    ]) {
      expect(PlanCreationActivateRpcParamsSchema.safeParse({ ...request, ...extra }).success).toBe(
        false,
      );
    }
    expect(
      PlanCreationActivateRpcParamsSchema.parse({
        ...request,
        incumbent: { planId: creationId, version: 2 },
      }).incumbent,
    ).toEqual({ planId: creationId, version: 2 });
    for (const incumbent of [
      undefined,
      {},
      { planId: creationId, version: 0 },
      { planId: creationId, version: 1, extra: true },
      { planId: "invalid", version: 1 },
    ]) {
      expect(PlanCreationActivateRpcParamsSchema.safeParse({ ...request, incumbent }).success).toBe(
        false,
      );
    }
    const result = {
      creationId,
      planId: "01J00000000000000000000001",
      closedPlanId: null,
      activatedAt: "1998-09-07",
    };
    expect(PlanCreationActivateRpcResultSchema.parse(result)).toEqual(result);
    expect(
      PlanCreationActivateRpcResultSchema.parse({ ...result, closedPlanId: creationId }),
    ).toEqual({ ...result, closedPlanId: creationId });
    for (const extra of [
      { activatedAt: "1998-02-30" },
      { activatedAt: "1998-09-07T00:00:00Z" },
      { planId: "invalid" },
      { closedPlanId: "invalid" },
      { status: "activated" },
    ]) {
      expect(PlanCreationActivateRpcResultSchema.safeParse({ ...result, ...extra }).success).toBe(
        false,
      );
    }
    expect(COACH_RPC_METHOD_REGISTRY["plan_creation.activate"]).toEqual({
      wireName: "plan_creation.activate",
      requestSchema: PlanCreationActivateRpcParamsSchema,
      responseSchema: PlanCreationActivateRpcResultSchema,
      eventSchema: NoRpcEventSchema,
    });
  });

  it("validates read-only commitment interpretation requests and rules", () => {
    for (const text of ["x", "x".repeat(2_000)]) {
      expect(PlanCreationInterpretCommitmentsRpcParamsSchema.parse({ text })).toEqual({ text });
    }
    for (const params of [
      {},
      { text: "" },
      { text: "x".repeat(2_001) },
      { text: 3 },
      { text: "Wed 45 min", commandId: "interpret" },
    ]) {
      expect(PlanCreationInterpretCommitmentsRpcParamsSchema.safeParse(params).success).toBe(false);
    }
    const rules = [
      { kind: "weekday-duration", day: 3, minutes: 45 },
      { kind: "weekday-unavailable", day: 6 },
      { kind: "hard-weekday", day: 2 },
      { kind: "time-off", start: "1998-09-02", end: "1998-09-04" },
    ];
    for (const result of [
      { rules, unparsed: [], status: "confirm" },
      { rules, unparsed: ["busy sometimes"], status: "clarify" },
      { rules: [], unparsed: ["How easy should I ride?"], status: "clarify" },
    ]) {
      expect(PlanCreationInterpretCommitmentsRpcResultSchema.parse(result)).toEqual(result);
    }
    for (const result of [
      {
        rules: [{ kind: "weekday-duration", day: 8, minutes: 45 }],
        unparsed: [],
        status: "confirm",
      },
      {
        rules: [{ kind: "weekday-duration", day: 3, minutes: 0 }],
        unparsed: [],
        status: "confirm",
      },
      {
        rules: [{ kind: "time-off", start: "1998-09-04", end: "1998-09-02" }],
        unparsed: [],
        status: "confirm",
      },
      { rules, unparsed: [1], status: "clarify" },
      { rules, unparsed: [], status: "confirmed" },
      { rules, unparsed: [], status: "confirm", commandId: "interpret" },
    ]) {
      expect(PlanCreationInterpretCommitmentsRpcResultSchema.safeParse(result).success).toBe(false);
    }
    expect(COACH_RPC_METHOD_REGISTRY["plan_creation.interpretCommitments"]).toEqual({
      wireName: "plan_creation.interpretCommitments",
      requestSchema: PlanCreationInterpretCommitmentsRpcParamsSchema,
      responseSchema: PlanCreationInterpretCommitmentsRpcResultSchema,
      eventSchema: NoRpcEventSchema,
    });
  });

  it("registers strict Plan Creation envelopes without events", () => {
    const requests = [
      { method: "plan_creation.interpretCommitments", params: { text: "Wed 45 min" } },
      { method: "plan_creation.start", params: { commandId: "start" } },
      {
        method: "plan_creation.answer",
        params: { commandId: "answer", creationId, expectedVersion: 1, answer: answers[2] },
      },
      {
        method: "plan_creation.preview",
        params: { commandId: "preview", creationId, expectedVersion: 1 },
      },
      {
        method: "plan_creation.discard",
        params: { commandId: "discard", creationId, expectedVersion: 1 },
      },
      {
        method: "plan_creation.activate",
        params: { commandId: "activate", creationId, expectedVersion: 1, incumbent: null },
      },
    ] as const;
    requests.forEach((request, id) =>
      expect(CoachRpcRequestEnvelopeSchema.parse({ jsonrpc: "2.0", id, ...request }).method).toBe(
        request.method,
      ),
    );
    for (const method of [
      "plan_creation.interpretCommitments",
      "plan_creation.start",
      "plan_creation.answer",
      "plan_creation.preview",
      "plan_creation.discard",
      "plan_creation.activate",
    ] as const) {
      expect(COACH_RPC_METHOD_REGISTRY[method].eventSchema.safeParse({}).success).toBe(false);
    }
    expect(COACH_RPC_METHOD_REGISTRY["plan_creation.discard"]).toEqual({
      wireName: "plan_creation.discard",
      requestSchema: PlanCreationDiscardRpcParamsSchema,
      responseSchema: PlanCreationDiscardRpcResultSchema,
      eventSchema: NoRpcEventSchema,
    });
  });
});

const draft = {
  kind: "draft",
  answeredSummaries: [
    {
      answerKey: "goal",
      title: "Main Goal",
      detail: "Build fitness",
      source: { kind: "athlete" },
      question: goalQuestion,
      answer: { kind: "goal", goal: { kind: "fitness" } },
    },
  ],
  goal: { kind: "fitness", weeks: 4 },
  mode: "flexible",
  start: "1998-09-02",
  end: "1998-09-29",
  spanKind: "Fitness Plan",
  computedWeeks: 4,
  weeks: [
    {
      number: 1,
      start: "1998-09-02",
      end: "1998-09-08",
      notes: [],
      workouts: [
        {
          id: "w1-template-1",
          name: "Controlled effort",
          kind: "hard",
          date: null,
          minutes: 45,
          pinned: false,
          power: null,
          guidance: "Use comfortable perceived effort or your known heart-rate guidance",
        },
      ],
    },
  ],
  notes: [],
  guidance: "Use comfortable perceived effort or your known heart-rate guidance",
  ftp: null,
  supportingEvents: [],
  builderId: "cycling-creation-draft",
  builderVersion: "1",
  inputFingerprint: "a".repeat(64),
  outputFingerprint: "b".repeat(64),
};

describe("Plan Creation Draft contract", () => {
  it("defaults Supporting Events for existing revisions and creations", () => {
    const { supportingEvents, ...previousDraft } = draft;
    expect(supportingEvents).toEqual([]);
    expect(PlanCreationDraftSchema.parse(previousDraft)).toEqual(draft);
    expect(PlanCreationDraftSchema.parse(previousDraft).weeks[0]?.workouts[0]).not.toHaveProperty(
      "supportingEventId",
    );
  });

  it("round-trips a review Draft through preview and planning request hydration", () => {
    const review = { ...card, status: "review", readiness: "ready", openQuestion: null, draft };
    const result = { status: "previewed", planCreation: review };
    expect(PlanCreationPreviewRpcResultSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(
      result,
    );
    expect(
      ListPlanningRequestsRpcResultSchema.parse({ deliveries: [], planCreation: review })
        .planCreation,
    ).toEqual(review);
    expect(PlanCreationCardModelSchema.parse({ ...review, draftStale: true }).draftStale).toBe(
      true,
    );
  });

  it("requires valid answer summaries and limits them to sixteen", () => {
    expect(PlanCreationDraftSchema.parse(draft).answeredSummaries).toEqual(draft.answeredSummaries);
    expect(
      PlanCreationDraftSchema.safeParse({ ...draft, answeredSummaries: undefined }).success,
    ).toBe(false);
    expect(PlanCreationDraftSchema.safeParse({ ...draft, answeredSummaries: [] }).success).toBe(
      true,
    );
    expect(
      PlanCreationDraftSchema.safeParse({
        ...draft,
        answeredSummaries: Array(16).fill(draft.answeredSummaries[0]),
      }).success,
    ).toBe(true);
    expect(
      PlanCreationDraftSchema.safeParse({
        ...draft,
        answeredSummaries: Array(17).fill(draft.answeredSummaries[0]),
      }).success,
    ).toBe(false);
    expect(
      PlanCreationDraftSchema.safeParse({
        ...draft,
        answeredSummaries: [{ ...draft.answeredSummaries[0], answerKey: "baseline" }],
      }).success,
    ).toBe(false);
  });

  it("requires a stored Draft for review and valid fingerprints and dates", () => {
    expect(PlanCreationCardModelSchema.safeParse({ ...card, status: "review" }).success).toBe(
      false,
    );
    expect(PlanCreationCardModelSchema.safeParse({ ...card, draftStale: true }).success).toBe(
      false,
    );
    expect(
      PlanCreationDraftSchema.safeParse({ ...draft, inputFingerprint: "not-a-hash" }).success,
    ).toBe(false);
    expect(PlanCreationDraftSchema.safeParse({ ...draft, start: "1998-02-30" }).success).toBe(
      false,
    );
    expect(PlanCreationDraftSchema.safeParse({ ...draft, ftp: 250 }).success).toBe(true);
  });

  it("rejects forged preview fields and preserves every rejection reason", () => {
    const request = { commandId: "preview", creationId, expectedVersion: 1 };
    expect(PlanCreationPreviewRpcParamsSchema.parse(request)).toEqual(request);
    for (const extra of [{ draft }, { readiness: "ready" }, { expectedVersion: 0 }])
      expect(PlanCreationPreviewRpcParamsSchema.safeParse({ ...request, ...extra }).success).toBe(
        false,
      );
    for (const reason of [
      "not-ready",
      "stale-version",
      "command-conflict",
      "no-unfinished-creation",
    ])
      expect(
        PlanCreationPreviewRpcResultSchema.parse({
          status: "rejected",
          reason,
          planCreation: null,
        }),
      ).toEqual({ status: "rejected", reason, planCreation: null });
    const pendingCommitment = {
      status: "rejected",
      reason: "commitments-pending",
      explanation: "Clarify or cancel the pending commitment correction.",
      planCreation: null,
    };
    expect(PlanCreationPreviewRpcResultSchema.parse(pendingCommitment)).toEqual(pendingCommitment);
    expect(
      PlanCreationPreviewRpcResultSchema.safeParse({ ...pendingCommitment, explanation: undefined })
        .success,
    ).toBe(false);
    const noWorkouts = {
      status: "rejected",
      reason: "no-workouts",
      planCreation: null,
      explanation: "No Workouts fit under the confirmed limits.",
    };
    expect(PlanCreationPreviewRpcResultSchema.parse(noWorkouts)).toEqual(noWorkouts);
    expect(
      PlanCreationPreviewRpcResultSchema.safeParse({ ...noWorkouts, explanation: "" }).success,
    ).toBe(false);
  });
});
