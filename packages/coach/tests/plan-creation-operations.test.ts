import { createCyclingPlanFtpAdapter } from "@enduragent/sport-cycling";
import type { LegacyPlanSummary } from "@enduragent/coach-contract";
import { createHash } from "node:crypto";
import { canonicalJson } from "@enduragent/kernel/archive";
import { describe, expect, it, vi, onTestFinished } from "vitest";
import {
  PlanCreationCardModelSchema,
  type PlanCreationAnswerInput,
  type PlanCreationAnswerRpcResult,
  type PlanCreationCardModel,
} from "@enduragent/coach-contract";
import {
  createPlanCreationRepository,
  createPlanReconciliationRepository,
  createPlanRepository,
  PlanCreationStoreError,
  type PlanCreationAnswerRecord,
  type PlanCreationRepository,
  type PlanCreationSnapshot,
} from "@enduragent/kernel/planning";
import {
  createPlanCreationOperations,
  expectedPlanCreationAnswerKind,
  projectPlanCreationCard,
  type BaselineEvidenceSource,
} from "../src/plan-creation-operations.js";
import { runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { createPlanChangeOperations } from "../src/plan-change-operations.js";
import { createPlanningReadService } from "../src/planning-read-service.js";
import {
  readPlanCreationAnswers,
  resolvePlanCreationDraftAnswers,
} from "../src/plan-creation-answers.js";

const unusedStore = () => {
  const store = openSqliteStorage(":memory:");
  onTestFinished(() => store.close());
  void store.exec(
    "CREATE TABLE planning_command (command_name TEXT, command_id TEXT, request_digest TEXT, status TEXT, result_json TEXT, created_at_ms INTEGER,aggregate_refs_json TEXT,error_code TEXT,error_json TEXT,version INTEGER,updated_at_ms INTEGER,device_id TEXT,hlc_physical_ms INTEGER,hlc_counter INTEGER)",
  );
  return store;
};

const id = (value: string) => `${"0".repeat(26 - value.length)}${value}`;
const today = "1998-09-02";
const eventCandidate = {
  candidateId: id("2"),
  name: "Tour",
  date: "1998-10-18",
  sourceLabel: "Calendar",
};
const candidateSource = { name: "Tour", date: "1998-10-18", sourceLabel: "Calendar" };
const eventGoal: PlanCreationAnswerInput = {
  kind: "goal",
  goal: { kind: "event-candidate", candidateId: eventCandidate.candidateId },
};
const fitnessGoal: PlanCreationAnswerInput = {
  kind: "goal",
  goal: { kind: "fitness" },
};
const eventSuccess: PlanCreationAnswerInput = {
  kind: "success",
  success: { kind: "event-finish", choice: "finish-fast" },
};
const fitnessSuccess: PlanCreationAnswerInput = {
  kind: "success",
  success: { kind: "fitness-choice", choice: "climb-stronger" },
};
const startTiming: PlanCreationAnswerInput = {
  kind: "start-timing",
  timing: { kind: "as-soon-as-possible" },
};
const fixedMode: PlanCreationAnswerInput = { kind: "schedule-mode", mode: "fixed" };
const flexibleMode: PlanCreationAnswerInput = { kind: "schedule-mode", mode: "flexible" };
const fixedAvailability: PlanCreationAnswerInput = {
  kind: "availability",
  mode: "fixed",
  weeklyHoursLimit: 8,
  longestWorkoutHours: 3,
  usableWeekdays: [6, 2, 4],
};
const flexibleAvailability: PlanCreationAnswerInput = {
  kind: "availability",
  mode: "flexible",
  weeklyHoursLimit: 8,
  longestWorkoutHours: 3,
};
const noCommitments: PlanCreationAnswerInput = {
  kind: "commitments",
  commitments: { kind: "none" },
};
const regularBaseline: PlanCreationAnswerInput = { kind: "baseline", baseline: "regular" };
const noRestriction: PlanCreationAnswerInput = {
  kind: "restriction",
  restriction: { kind: "none" },
};

const stored = (
  sequence: number,
  value: PlanCreationAnswerInput,
  source: { readonly kind: "athlete" } | { readonly kind: "derived"; readonly label: string } = {
    kind: "athlete",
  },
): PlanCreationAnswerRecord => ({
  id: id(`${sequence + 20}`),
  sequence,
  creationVersion: sequence + 1,
  answerKey: value.kind,
  valueJson: JSON.stringify({ answer: value, source }),
  confirmedAtMs: 883_612_800_000 + sequence,
});

const snapshot = (answers: readonly PlanCreationAnswerRecord[] = []): PlanCreationSnapshot => ({
  id: id("1"),
  status: "in-progress",
  currentDraft: null,
  version: answers.length + 1,
  seed: { schemaVersion: 1, eventCandidates: [eventCandidate] },
  createdAtMs: 883_612_800_000,
  updatedAtMs: 883_612_800_000 + answers.length,
  answers,
});

interface Harness {
  readonly host: ReturnType<typeof createPlanCreationOperations>;
  readonly recordAnswer: ReturnType<typeof vi.fn<PlanCreationRepository["recordAnswer"]>>;
  current(): PlanCreationSnapshot;
  submit(
    answer: PlanCreationAnswerInput,
    options?: { readonly commandId?: string; readonly expectedVersion?: number },
  ): Promise<PlanCreationAnswerRpcResult>;
}

function harness(
  initial: PlanCreationSnapshot = snapshot(),
  baselineEvidence: BaselineEvidenceSource = { read: async () => undefined },
): Harness {
  let current = initial;
  let identitySequence = 100;
  let commandSequence = 0;
  const commands = new Map<string, string>();
  const recordAnswer = vi.fn<PlanCreationRepository["recordAnswer"]>(async (input) => {
    const priorDigest = commands.get(input.command.commandId);
    if (priorDigest !== undefined) {
      if (priorDigest !== input.command.requestDigest) {
        throw new PlanCreationStoreError("command-conflict");
      }
      return { outcome: "replayed", snapshot: current };
    }
    if (current.id !== input.creationId) throw new PlanCreationStoreError("missing-creation");
    if (current.version !== input.expectedVersion)
      throw new PlanCreationStoreError("stale-version");
    const sequence = current.answers.length + 1;
    current = {
      ...current,
      version: current.version + 1,
      updatedAtMs: current.updatedAtMs + 1,
      answers: [
        ...current.answers,
        {
          id: input.answerId,
          sequence,
          creationVersion: current.version + 1,
          answerKey: input.answerKey,
          valueJson: input.valueJson,
          confirmedAtMs: input.command.nowMs,
        },
      ],
    };
    commands.set(input.command.commandId, input.command.requestDigest);
    return { outcome: "recorded", snapshot: current };
  });
  const repository: PlanCreationRepository = {
    activate: async () => {
      throw new Error("unused");
    },
    replayDraft: async () => undefined,
    recordDraft: async () => {
      throw new Error("unused");
    },
    readUnfinished: async () => current,
    start: async () => ({ outcome: "resumed", snapshot: current }),
    recordAnswer,
    discard: async () => {
      throw new Error("unused");
    },
  };
  const host = createPlanCreationOperations({
    store: unusedStore(),
    repository,
    identity: {
      deviceId: async () => "test-device",
      newUlid: () => id(`${++identitySequence}`),
      hlcStamp: () => ({ physicalMs: 883_612_800_000 + identitySequence, counter: 0 }),
    },
    crypto: globalThis.crypto,
    eventCandidates: { read: async () => [candidateSource] },
    eventSources: { read: async () => [] },
    baselineEvidence,
    today: () => today,
  });
  return {
    host,
    recordAnswer,
    current: () => current,
    submit: (answer, options = {}) =>
      host["plan_creation.answer"]({
        commandId: options.commandId ?? `command-${++commandSequence}`,
        creationId: current.id,
        expectedVersion: options.expectedVersion ?? current.version,
        answer,
      }),
  };
}

const answered = async (
  pending: Promise<PlanCreationAnswerRpcResult>,
): Promise<PlanCreationCardModel> => {
  const result = await pending;
  if (result.status !== "answered") throw new Error(`Expected answered, got ${result.reason}`);
  return result.planCreation;
};

const questionKind = (result: PlanCreationCardModel): string | null =>
  result.openQuestion?.kind ?? null;

describe("Plan Creation operations", () => {
  it("asks every Event Goal question in flow order and becomes ready", async () => {
    const test = harness();
    expect(projectPlanCreationCard(test.current(), { today }).openQuestion).toMatchObject({
      kind: "goal-question",
      step: { current: 1, total: 9 },
      authoredOption: { detail: "Answer in your own words." },
    });
    const answers = [
      eventGoal,
      fixedMode,
      fixedAvailability,
      startTiming,
      noCommitments,
      regularBaseline,
      eventSuccess,
      noRestriction,
    ];
    const expectedQuestions = [
      "schedule-mode-question",
      "availability-question",
      "start-timing-question",
      "commitments-question",
      "baseline-question",
      "success-question",
      "restriction-question",
      null,
    ];
    for (const [index, answer] of answers.entries()) {
      const model = await answered(test.submit(answer));
      expect(questionKind(model)).toBe(expectedQuestions[index]);
      expect(model.readiness).toBe(index === answers.length - 1 ? "ready" : "incomplete");
      if (index === 0) expect(model.openQuestion?.step.total).toBe(8);
    }
    expect(test.current().answers.map((row) => row.answerKey)).not.toContain("plan-length");
    expect(await test.host.readCard()).toMatchObject({
      readiness: "ready",
      openQuestion: null,
      answeredSummaries: [
        { answerKey: "goal" },
        { answerKey: "schedule-mode" },
        {
          answerKey: "availability",
          detail: "Up to 8 h a week, longest Workout 3 h, Tue Thu Sat",
        },
        { answerKey: "start-timing" },
        { answerKey: "commitments" },
        { answerKey: "baseline" },
        { answerKey: "success" },
        { answerKey: "restriction", detail: "No training restrictions" },
      ],
    });
  });

  it("accepts every Training Restriction shape and projects its optional end date", async () => {
    const priorAnswers = [
      eventGoal,
      fixedMode,
      fixedAvailability,
      startTiming,
      noCommitments,
      regularBaseline,
      eventSuccess,
    ];
    const cases: readonly [PlanCreationAnswerInput, string][] = [
      [noRestriction, "No training restrictions"],
      [{ kind: "restriction", restriction: { kind: "no-training" } }, "No training"],
      [
        {
          kind: "restriction",
          restriction: { kind: "no-training", endDate: "1998-09-14" },
        },
        "No training until 1998-09-14",
      ],
      [{ kind: "restriction", restriction: { kind: "no-hard-training" } }, "No hard training"],
      [
        {
          kind: "restriction",
          restriction: { kind: "no-hard-training", endDate: "1998-09-14" },
        },
        "No hard training until 1998-09-14",
      ],
      [
        { kind: "restriction", restriction: { kind: "max-duration", hours: 1.5 } },
        "Maximum Workout duration 1.5 h",
      ],
      [
        {
          kind: "restriction",
          restriction: { kind: "max-duration", hours: 1.5, endDate: "1998-09-14" },
        },
        "Maximum Workout duration 1.5 h until 1998-09-14",
      ],
    ];
    for (const [answer, detail] of cases) {
      const test = harness(snapshot(priorAnswers.map((value, index) => stored(index + 1, value))));
      const model = await answered(test.submit(answer));
      expect(model).toMatchObject({
        readiness: "ready",
        openQuestion: null,
        answeredSummaries: expect.arrayContaining([
          expect.objectContaining({ answerKey: "restriction", detail, answer }),
        ]),
      });
    }
  });

  it("asks every Fitness Goal question in flow order and discloses the flexible pool", async () => {
    const evidence = vi.fn(async () => ({
      baseline: "regular" as const,
      label: "synced training history",
    }));
    const test = harness(snapshot(), { read: evidence });
    const answers = [
      fitnessGoal,
      { kind: "plan-length", weeks: 12 } as const,
      flexibleMode,
      flexibleAvailability,
      startTiming,
      noCommitments,
      fitnessSuccess,
      noRestriction,
    ];
    const expectedQuestions = [
      "plan-length-question",
      "schedule-mode-question",
      "availability-question",
      "start-timing-question",
      "commitments-question",
      "success-question",
      "restriction-question",
      null,
    ];
    for (const [index, answer] of answers.entries()) {
      const model = await answered(test.submit(answer));
      expect(questionKind(model)).toBe(expectedQuestions[index]);
      if (model.openQuestion?.kind === "availability-question") {
        expect(model.openQuestion).toMatchObject({
          mode: "flexible",
          derivedPoolNote: expect.stringContaining("3 Workouts up to 6 h"),
          weeklyHoursOptions: [
            { detail: "Up to about six hours of riding a week." },
            { detail: "Up to about eight hours of riding a week." },
            { detail: "About nine hours or more of riding a week." },
          ],
        });
      }
    }
    expect(evidence).toHaveBeenCalledOnce();
    expect(
      JSON.parse(
        test.current().answers.find((answer) => answer.answerKey === "baseline")?.valueJson ??
          "null",
      ),
    ).toEqual({
      answer: regularBaseline,
      source: { kind: "derived", label: "synced training history" },
    });
    expect(await test.host.readCard()).toMatchObject({
      readiness: "ready",
      answeredSummaries: [
        { answerKey: "goal" },
        { answerKey: "plan-length", detail: "12 weeks" },
        { answerKey: "schedule-mode", detail: "Flexible Schedule" },
        {
          answerKey: "availability",
          detail: "Up to 8 h a week, longest Workout 3 h, 4 Workouts in the flexible pool",
        },
        { answerKey: "start-timing" },
        { answerKey: "commitments" },
        { answerKey: "baseline" },
        { answerKey: "success" },
        { answerKey: "restriction" },
      ],
    });
  });

  it("accepts Edit for a valid earlier key, appends, and projects only its latest row", async () => {
    const test = harness();
    await answered(test.submit(fitnessGoal));
    await answered(test.submit({ kind: "plan-length", weeks: 8 }));
    const edited = await answered(test.submit({ kind: "plan-length", weeks: 16 }));
    expect(test.current().answers.map((row) => row.answerKey)).toEqual([
      "goal",
      "plan-length",
      "plan-length",
    ]);
    expect(test.current().answers.at(-1)).toMatchObject({ sequence: 3, creationVersion: 4 });
    expect(
      edited.answeredSummaries.filter((summary) => summary.answerKey === "plan-length"),
    ).toMatchObject([{ answerKey: "plan-length", title: "Plan length", detail: "16 weeks" }]);
    expect(questionKind(edited)).toBe("schedule-mode-question");
  });

  it("invalidates success and Plan length only when the goal kind changes", async () => {
    const test = harness();
    for (const answer of [
      fitnessGoal,
      { kind: "plan-length", weeks: 12 } as const,
      fixedMode,
      fixedAvailability,
      startTiming,
      noCommitments,
      regularBaseline,
      fitnessSuccess,
    ]) {
      await answered(test.submit(answer));
    }
    const sameKind = await answered(
      test.submit({ kind: "goal", goal: { kind: "fitness", outcome: "Build endurance" } }),
    );
    expect(sameKind.answeredSummaries.map((summary) => summary.answerKey)).toEqual([
      "goal",
      "plan-length",
      "schedule-mode",
      "availability",
      "start-timing",
      "commitments",
      "baseline",
      "success",
    ]);
    expect(questionKind(sameKind)).toBe("restriction-question");

    const changedKind = await answered(
      test.submit({
        kind: "goal",
        goal: { kind: "event-manual", name: "Autumn ride", date: "1998-11-08" },
      }),
    );
    expect(changedKind.answeredSummaries.map((summary) => summary.answerKey)).toEqual([
      "goal",
      "schedule-mode",
      "availability",
      "start-timing",
      "commitments",
      "baseline",
    ]);
    expect(questionKind(changedKind)).toBe("success-question");
    const reconfirmed = await answered(test.submit(eventSuccess));
    expect(reconfirmed.answeredSummaries.map((summary) => summary.answerKey)).toEqual([
      "goal",
      "schedule-mode",
      "availability",
      "start-timing",
      "commitments",
      "baseline",
      "success",
    ]);
    expect(questionKind(reconfirmed)).toBe("restriction-question");
    const changedEventKind = await answered(test.submit(eventGoal));
    expect(changedEventKind.answeredSummaries.map((summary) => summary.answerKey)).toEqual([
      "goal",
      "schedule-mode",
      "availability",
      "start-timing",
      "commitments",
      "baseline",
      "success",
    ]);
    expect(questionKind(changedEventKind)).toBe("restriction-question");
  });

  it("re-asks availability across a Schedule mode flip away and back", async () => {
    const test = harness();
    for (const value of [
      fitnessGoal,
      { kind: "plan-length", weeks: 8 } as const,
      flexibleMode,
      flexibleAvailability,
    ]) {
      await answered(test.submit(value));
    }
    const changed = await answered(test.submit(fixedMode));
    expect(questionKind(changed)).toBe("availability-question");
    expect(changed.openQuestion).toMatchObject({ mode: "fixed" });
    expect(changed.answeredSummaries.map((summary) => summary.answerKey)).not.toContain(
      "availability",
    );
    await expect(test.submit(flexibleAvailability)).resolves.toMatchObject({
      status: "rejected",
      reason: "invalid-answer",
      planCreation: { openQuestion: { kind: "availability-question", mode: "fixed" } },
    });
    expect(test.current().answers).toHaveLength(5);
    await answered(test.submit(fixedAvailability));
    expect(questionKind(await answered(test.submit(flexibleMode)))).toBe("availability-question");
    const flippedBack = await answered(test.submit(fixedMode));
    expect(questionKind(flippedBack)).toBe("availability-question");
    expect(flippedBack.answeredSummaries.map((summary) => summary.answerKey)).not.toContain(
      "availability",
    );
  });

  it("rejects Event Goal Plan length and other out-of-order keys", async () => {
    const test = harness();
    await expect(test.submit(fitnessSuccess)).resolves.toMatchObject({
      status: "rejected",
      reason: "answer-not-expected",
    });
    await answered(test.submit(eventGoal));
    await expect(test.submit({ kind: "plan-length", weeks: 8 })).resolves.toMatchObject({
      status: "rejected",
      reason: "answer-not-expected",
      planCreation: { openQuestion: { kind: "schedule-mode-question" } },
    });
    for (const answer of [
      fixedMode,
      fixedAvailability,
      startTiming,
      noCommitments,
      regularBaseline,
    ]) {
      await answered(test.submit(answer));
    }
    await expect(test.submit(fitnessSuccess)).resolves.toMatchObject({
      status: "rejected",
      reason: "invalid-answer",
      planCreation: { openQuestion: { kind: "success-question" } },
    });
    expect(test.current().answers).toHaveLength(6);
  });

  it("rejects an earliest start before the host civil date", async () => {
    const test = harness();
    await answered(test.submit(eventGoal));
    await answered(test.submit(fixedMode));
    await answered(test.submit(fixedAvailability));
    await expect(
      test.submit({ kind: "start-timing", timing: { kind: "earliest", date: "1998-09-01" } }),
    ).resolves.toMatchObject({
      status: "rejected",
      reason: "invalid-answer",
      planCreation: {
        version: 4,
        openQuestion: { kind: "start-timing-question", earliestAllowed: today },
      },
    });
    expect(test.recordAnswer).toHaveBeenCalledTimes(3);
  });

  it("rejects a Training Restriction end date before the host civil date", async () => {
    const priorAnswers = [
      eventGoal,
      fixedMode,
      fixedAvailability,
      startTiming,
      noCommitments,
      regularBaseline,
      eventSuccess,
    ];
    const test = harness(snapshot(priorAnswers.map((answer, index) => stored(index + 1, answer))));

    await expect(
      test.submit({
        kind: "restriction",
        restriction: { kind: "no-hard-training", endDate: "1998-09-01" },
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      reason: "invalid-answer",
      planCreation: { version: 8, openQuestion: { kind: "restriction-question" } },
    });
    expect(test.recordAnswer).not.toHaveBeenCalled();
  });

  it("replays an identical answer result without appending another row", async () => {
    const test = harness();
    const request = {
      commandId: "replay",
      creationId: test.current().id,
      expectedVersion: 1,
      answer: fitnessGoal,
    };
    const first = await test.host["plan_creation.answer"](request);
    const replay = await test.host["plan_creation.answer"](request);
    expect(replay).toEqual(first);
    expect(test.current().answers).toHaveLength(1);
    expect(test.recordAnswer).toHaveBeenCalledTimes(2);
    await expect(
      test.host["plan_creation.answer"]({
        ...request,
        answer: { kind: "goal", goal: { kind: "fitness", outcome: "Build endurance" } },
      }),
    ).resolves.toMatchObject({ status: "rejected", reason: "command-conflict" });
    expect(test.current().answers).toHaveLength(1);
  });

  it("round-trips sourced answers and reads legacy raw answers as athlete-sourced", async () => {
    const test = harness();
    await answered(test.submit(fitnessGoal));
    const persisted = test.recordAnswer.mock.calls[0]?.[0].valueJson;
    expect(JSON.parse(persisted ?? "null")).toEqual({
      answer: fitnessGoal,
      source: { kind: "athlete" },
    });
    expect(projectPlanCreationCard(test.current(), { today })).toMatchObject({
      answeredSummaries: [
        { answerKey: "goal", detail: "Build fitness for a fixed number of weeks." },
      ],
    });
    const legacy = snapshot([
      {
        ...stored(1, fitnessGoal),
        valueJson: JSON.stringify(fitnessGoal),
      },
    ]);
    expect(projectPlanCreationCard(legacy, { today })).toMatchObject({
      answeredSummaries: [{ answerKey: "goal", answer: fitnessGoal }],
    });
    expect(readPlanCreationAnswers(legacy)[0]?.source).toEqual({ kind: "athlete" });
  });

  it.each([
    [6, 3],
    [8, 4],
    [8.5, 5],
  ])("derives a %s-hour flexible week as a %s-Workout pool", (weeklyHoursLimit, poolSize) => {
    const answers: PlanCreationAnswerInput[] = [
      fitnessGoal,
      { kind: "plan-length", weeks: 8 },
      flexibleMode,
      {
        kind: "availability",
        mode: "flexible",
        weeklyHoursLimit,
        longestWorkoutHours: 2,
      },
    ];
    const projected = projectPlanCreationCard(
      snapshot(answers.map((value, index) => stored(index + 1, value))),
      {
        today,
      },
    );
    expect(projected.answeredSummaries.at(-1)?.detail).toContain(
      `${poolSize} Workouts in the flexible pool`,
    );
  });

  it("maps start outcomes, invalid event candidates, stale versions, and command conflicts", async () => {
    let current: PlanCreationSnapshot | undefined;
    let call = 0;
    const outcomes = ["created", "resumed", "replayed"] as const;
    const start = vi.fn<PlanCreationRepository["start"]>(async (input) => {
      if (input.command.commandId === "conflict") {
        throw new PlanCreationStoreError("command-conflict");
      }
      current ??= snapshot();
      return { outcome: outcomes[call++] ?? "replayed", snapshot: current };
    });
    let sequence = 8;
    const host = createPlanCreationOperations({
      store: unusedStore(),
      repository: {
        activate: async () => {
          throw new Error("unused");
        },
        replayDraft: async () => undefined,
        recordDraft: async () => {
          throw new Error("unused");
        },
        readUnfinished: async () => current,
        start,
        recordAnswer: async () => {
          throw new PlanCreationStoreError("stale-version");
        },
        discard: async () => {
          throw new Error("unused");
        },
      },
      identity: {
        deviceId: async () => "test-device",
        newUlid: () => id(`${++sequence}`),
        hlcStamp: () => ({ physicalMs: 883_612_800_000, counter: 0 }),
      },
      crypto: globalThis.crypto,
      eventCandidates: { read: async () => [candidateSource] },
      eventSources: { read: async () => [] },
      today: () => today,
    });
    await expect(host["plan_creation.start"]({ commandId: "one" })).resolves.toMatchObject({
      outcome: "created",
    });
    await expect(host["plan_creation.start"]({ commandId: "two" })).resolves.toMatchObject({
      outcome: "resumed",
    });
    await expect(host["plan_creation.start"]({ commandId: "three" })).resolves.toMatchObject({
      outcome: "resumed",
    });
    await expect(host["plan_creation.start"]({ commandId: "conflict" })).resolves.toEqual({
      status: "rejected",
      reason: "command-conflict",
    });
    expect(start.mock.calls[0]?.[0].seed.eventCandidates).toEqual([
      { candidateId: id("9"), ...candidateSource },
    ]);
    await expect(
      host["plan_creation.answer"]({
        commandId: "candidate",
        creationId: id("1"),
        expectedVersion: 1,
        answer: { kind: "goal", goal: { kind: "event-candidate", candidateId: id("7") } },
      }),
    ).resolves.toMatchObject({ reason: "invalid-answer" });
    await expect(
      host["plan_creation.answer"]({
        commandId: "stale",
        creationId: id("1"),
        expectedVersion: 2,
        answer: fitnessGoal,
      }),
    ).resolves.toMatchObject({ reason: "stale-version" });
  });

  it("projects only valid latest answers in flow order", () => {
    const answers = [
      stored(1, fitnessGoal),
      stored(2, { kind: "plan-length", weeks: 8 }),
      stored(3, flexibleMode),
      stored(4, flexibleAvailability),
      stored(5, startTiming),
      stored(6, fitnessSuccess),
      stored(7, fixedMode),
    ];
    const current = snapshot(answers);
    expect(expectedPlanCreationAnswerKind(current)).toBe("availability");
    expect(projectPlanCreationCard(current, { today })).toMatchObject({
      readiness: "incomplete",
      answeredSummaries: [
        { answerKey: "goal" },
        { answerKey: "plan-length" },
        { answerKey: "schedule-mode", detail: "Fixed Schedule" },
        { answerKey: "start-timing" },
        { answerKey: "success", detail: "Climb stronger" },
      ],
      openQuestion: { kind: "availability-question", mode: "fixed" },
    });
    expect(
      PlanCreationCardModelSchema.parse(projectPlanCreationCard(current, { today })),
    ).toBeTruthy();
  });

  it("maps every discard outcome and projects the current Card on rejection", async () => {
    let current: PlanCreationSnapshot | undefined = snapshot();
    let discardError: PlanCreationStoreError | Error | undefined;
    const readUnfinished = vi.fn(async () => current);
    const discard = vi.fn<PlanCreationRepository["discard"]>(async () => {
      if (discardError !== undefined) throw discardError;
      current = undefined;
      return { outcome: "discarded" };
    });
    const host = createPlanCreationOperations({
      store: unusedStore(),
      repository: {
        activate: async () => {
          throw new Error("unused");
        },
        replayDraft: async () => undefined,
        recordDraft: async () => {
          throw new Error("unused");
        },
        readUnfinished,
        start: async () => {
          throw new Error("unused");
        },
        recordAnswer: async () => {
          throw new Error("unused");
        },
        discard,
      },
      identity: {
        deviceId: async () => "test-device",
        newUlid: () => id("9"),
        hlcStamp: () => ({ physicalMs: 883_612_800_000, counter: 0 }),
      },
      crypto: globalThis.crypto,
      eventCandidates: { read: async () => [] },
      eventSources: { read: async () => [] },
      today: () => today,
    });
    const request = { commandId: "discard", creationId: id("1"), expectedVersion: 1 };

    await expect(host["plan_creation.discard"](request)).resolves.toEqual({
      status: "discarded",
    });
    expect(readUnfinished).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledWith({
      command: {
        commandId: "discard",
        requestDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
        nowMs: 883_612_800_000,
        deviceId: "test-device",
        hlcPhysicalMs: 883_612_800_000,
        hlcCounter: 0,
      },
      creationId: id("1"),
      expectedVersion: 1,
    });
    await expect(host.readCard()).resolves.toBeNull();

    readUnfinished.mockClear();
    await expect(host["plan_creation.discard"](request)).resolves.toEqual({
      status: "discarded",
    });
    expect(readUnfinished).not.toHaveBeenCalled();

    current = snapshot([stored(1, fitnessGoal)]);
    discardError = new PlanCreationStoreError("stale-version");
    await expect(host["plan_creation.discard"](request)).resolves.toMatchObject({
      status: "rejected",
      reason: "stale-version",
      planCreation: { creationId: id("1"), version: 2 },
    });

    discardError = new PlanCreationStoreError("command-conflict");
    await expect(host["plan_creation.discard"](request)).resolves.toMatchObject({
      status: "rejected",
      reason: "command-conflict",
      planCreation: { creationId: id("1"), version: 2 },
    });

    discardError = new PlanCreationStoreError("no-unfinished-creation");
    current = { ...snapshot(), id: id("7") };
    await expect(host["plan_creation.discard"](request)).resolves.toMatchObject({
      status: "rejected",
      reason: "no-unfinished-creation",
      planCreation: { creationId: id("7"), version: 1 },
    });

    current = undefined;
    await expect(host["plan_creation.discard"](request)).resolves.toEqual({
      status: "rejected",
      reason: "no-unfinished-creation",
      planCreation: null,
    });

    discardError = new Error("unexpected");
    await expect(host["plan_creation.discard"](request)).rejects.toThrow("unexpected");
  });
});

async function previewHarness(legacyPlan?: () => Promise<LegacyPlanSummary | null>) {
  let currentToday = today;
  let connected = false;
  const store = openSqliteStorage(":memory:");
  onTestFinished(() => store.close());
  await runMigrations(store, MIGRATIONS);
  const repository = createPlanCreationRepository(store);
  let sequence = 100;
  const host = createPlanCreationOperations({
    store,
    repository,
    identity: {
      deviceId: async () => "preview-test-device",
      newUlid: () => id(`${++sequence}`),
      hlcStamp: () => ({ physicalMs: 883_612_800_000, counter: 0 }),
    },
    crypto: globalThis.crypto,
    eventCandidates: { read: async () => [candidateSource] },
    eventSources: { read: async () => [] },
    calendarConnected: () => connected,
    legacyPlan,
    today: () => currentToday,
    todayDateKey: () => Number(currentToday.replaceAll("-", "")),
    now: () => Date.parse(`${currentToday}T12:00:00Z`),
  });
  const started = await host["plan_creation.start"]({ commandId: "start" });
  if (started.status !== "started") throw new Error("Expected creation");
  let card = started.planCreation;
  const answer = async (value: PlanCreationAnswerInput) => {
    card = await answered(
      host["plan_creation.answer"]({
        commandId: `answer-${++sequence}`,
        creationId: card.creationId,
        expectedVersion: card.version,
        answer: value,
      }),
    );
    return card;
  };
  const ready = async (mode: "fixed" | "flexible" = "flexible") => {
    for (const value of [
      fitnessGoal,
      { kind: "plan-length", weeks: 4 } as const,
      mode === "fixed" ? fixedMode : flexibleMode,
      mode === "fixed" ? fixedAvailability : flexibleAvailability,
      startTiming,
      noCommitments,
      regularBaseline,
      fitnessSuccess,
      noRestriction,
    ])
      await answer(value);
    return card;
  };
  return {
    store,
    repository,
    host,
    started,
    ready,
    answer,
    card: () => card,
    setCardVersion: (version: number) => {
      card = { ...card, version };
    },
    setConnected: (value: boolean) => {
      connected = value;
    },
    setToday: (value: string) => {
      currentToday = value;
    },
    advanceDay: () => {
      currentToday = "1998-09-03";
    },
  };
}

describe("Plan Creation command replay", () => {
  it("projects start and answer results from their recorded versions", async () => {
    const test = await previewHarness();
    await test.host["plan_creation.discard"]({
      commandId: "discard-initial",
      creationId: test.card().creationId,
      expectedVersion: 1,
    });
    const startRequest = { commandId: "recorded-start" };
    const command = (request: { commandId: string }) => ({
      commandId: request.commandId,
      requestDigest: createHash("sha256").update(canonicalJson(request)).digest("hex"),
      nowMs: 883_612_800_000,
      deviceId: "preview-test-device",
      hlcPhysicalMs: 883_612_800_000,
      hlcCounter: 0,
    });
    const started = await test.repository.start({
      command: command(startRequest),
      creationId: id("800"),
      seed: { schemaVersion: 1, eventCandidates: [] },
    });
    const originalStart = {
      status: "started",
      outcome: "created",
      planCreation: projectPlanCreationCard(started.snapshot, { today }),
    };
    const answerRequest = {
      commandId: "recorded-answer",
      creationId: started.snapshot.id,
      expectedVersion: 1,
      answer: fitnessGoal,
    };
    const result = await test.repository.recordAnswer({
      command: command(answerRequest),
      creationId: started.snapshot.id,
      expectedVersion: 1,
      answerId: id("801"),
      answerKey: "goal",
      valueJson: canonicalJson({ answer: fitnessGoal, source: { kind: "athlete" } }),
    });
    const originalAnswer = {
      status: "answered",
      planCreation: projectPlanCreationCard(result.snapshot, { today }),
    };
    await test.host["plan_creation.discard"]({
      commandId: "discard-recorded",
      creationId: started.snapshot.id,
      expectedVersion: 2,
    });
    const next = await test.host["plan_creation.start"]({ commandId: "next" });
    await expect(test.host["plan_creation.start"](startRequest)).resolves.toEqual(originalStart);
    await expect(test.host["plan_creation.answer"](answerRequest)).resolves.toEqual(originalAnswer);
    expect(next).toMatchObject({ status: "started" });
    expect(await test.host.readCard()).not.toMatchObject({ creationId: started.snapshot.id });
  });

  it("replays the draft and status that existed at the command version", async () => {
    const test = await previewHarness();
    const ready = await test.ready();
    const beforePreviewRequest = { commandId: "resume-before-preview" };
    const beforePreview = await test.host["plan_creation.start"](beforePreviewRequest);
    const preview = await test.host["plan_creation.preview"]({
      commandId: "preview",
      creationId: ready.creationId,
      expectedVersion: ready.version,
    });
    if (preview.status !== "previewed") throw new Error("Expected preview");
    await expect(test.host["plan_creation.start"](beforePreviewRequest)).resolves.toEqual(
      beforePreview,
    );
    const reviewStartRequest = { commandId: "resume-review" };
    const reviewStart = await test.host["plan_creation.start"](reviewStartRequest);
    const answerRequest = {
      commandId: "edit-length",
      creationId: ready.creationId,
      expectedVersion: preview.planCreation.version,
      answer: { kind: "plan-length", weeks: 8 } as const,
    };
    const originalAnswer = await test.host["plan_creation.answer"](answerRequest);
    if (originalAnswer.status !== "answered") throw new Error("Expected answer");
    expect(originalAnswer.planCreation).toMatchObject({ status: "review", draftStale: true });
    const rebuilt = await test.host["plan_creation.preview"]({
      commandId: "rebuild",
      creationId: ready.creationId,
      expectedVersion: originalAnswer.planCreation.version,
    });
    if (rebuilt.status !== "previewed") throw new Error("Expected rebuilt preview");
    await expect(test.host["plan_creation.answer"](answerRequest)).resolves.toEqual(originalAnswer);
    await test.host["plan_creation.discard"]({
      commandId: "discard-review",
      creationId: ready.creationId,
      expectedVersion: rebuilt.planCreation.version,
    });
    await test.host["plan_creation.start"]({ commandId: "start-next" });
    await expect(test.host["plan_creation.start"](beforePreviewRequest)).resolves.toEqual(
      beforePreview,
    );
    await expect(test.host["plan_creation.start"](reviewStartRequest)).resolves.toEqual(
      reviewStart,
    );
    await expect(test.host["plan_creation.answer"](answerRequest)).resolves.toEqual(originalAnswer);
  });

  it.each(["discarded", "activated"] as const)(
    "returns the original start and answer after %s and another start",
    async (terminal) => {
      const test = await previewHarness();
      await test.answer(fitnessGoal);
      const resumed = await test.host["plan_creation.start"]({ commandId: "resume" });
      const request = {
        commandId: "original-answer",
        creationId: test.card().creationId,
        expectedVersion: test.card().version,
        answer: { kind: "plan-length", weeks: 4 } as const,
      };
      const originalAnswer = await test.host["plan_creation.answer"](request);
      expect(originalAnswer.status).toBe("answered");
      const current = await test.repository.readUnfinished();
      if (current === undefined) throw new Error("Expected creation");
      test.setCardVersion(current.version);
      const ready = await test.ready();
      await expect(test.host["plan_creation.answer"](request)).resolves.toEqual(originalAnswer);
      if (terminal === "discarded") {
        await test.host["plan_creation.discard"]({
          commandId: "discard",
          creationId: ready.creationId,
          expectedVersion: ready.version,
        });
      } else {
        const preview = await test.host["plan_creation.preview"]({
          commandId: "preview",
          creationId: ready.creationId,
          expectedVersion: ready.version,
        });
        if (preview.status !== "previewed") throw new Error("Expected preview");
        await test.host["plan_creation.activate"]({
          commandId: "activate",
          creationId: ready.creationId,
          expectedVersion: preview.planCreation.version,
          incumbent: null,
        });
      }
      test.advanceDay();
      await expect(test.host["plan_creation.answer"](request)).resolves.toEqual(originalAnswer);
      const next = await test.host["plan_creation.start"]({ commandId: "next" });
      if (next.status !== "started") throw new Error("Expected next creation");
      const before = await test.store.all("SELECT * FROM plan_creation");
      const readUnfinished = vi.spyOn(test.repository, "readUnfinished");
      const unavailable = () => {
        throw new Error("Replay must use the recorded result");
      };
      const restarted = createPlanCreationOperations({
        store: test.store,
        repository: test.repository,
        identity: {
          newUlid: () => id("999"),
          deviceId: async () => "preview-test-device",
          hlcStamp: () => ({ physicalMs: 883_612_800_000, counter: 0 }),
        },
        crypto: globalThis.crypto,
        eventCandidates: { read: unavailable },
        eventSources: { read: async () => [] },
        baselineEvidence: { read: unavailable },
        today: () => today,
      });
      await expect(restarted["plan_creation.start"]({ commandId: "start" })).resolves.toEqual(
        test.started,
      );
      await expect(restarted["plan_creation.answer"](request)).resolves.toEqual(originalAnswer);
      await expect(test.host["plan_creation.start"]({ commandId: "start" })).resolves.toEqual(
        test.started,
      );
      await expect(test.host["plan_creation.start"]({ commandId: "resume" })).resolves.toEqual(
        resumed,
      );
      await expect(test.host["plan_creation.answer"](request)).resolves.toEqual(originalAnswer);
      await expect(
        test.host["plan_creation.answer"]({ ...request, creationId: next.planCreation.creationId }),
      ).resolves.toMatchObject({
        status: "rejected",
        reason: "command-conflict",
        planCreation: null,
      });
      expect(readUnfinished).not.toHaveBeenCalled();
      expect(await test.repository.readUnfinished()).toMatchObject({
        id: next.planCreation.creationId,
      });
      expect(await test.store.all("SELECT * FROM plan_creation")).toEqual(before);
    },
  );
});

describe("Plan Creation preview", () => {
  it("stores a complete Draft, replays its result, and rebuilds stale review answers", async () => {
    const test = await previewHarness();
    const card = await test.ready();
    const request = {
      commandId: "preview",
      creationId: card.creationId,
      expectedVersion: card.version,
    };
    const first = await test.host["plan_creation.preview"](request);
    expect(first).toMatchObject({
      status: "previewed",
      planCreation: {
        status: "review",
        version: card.version + 1,
        draftStale: false,
        draft: { mode: "flexible", weeks: expect.any(Array), ftp: null },
      },
    });
    if (first.status !== "previewed" || first.planCreation.draft === null)
      throw new Error("Expected Draft");
    const draft = first.planCreation.draft;
    expect(draft.answeredSummaries).toEqual(card.answeredSummaries);
    expect(draft.answeredSummaries).toEqual(first.planCreation.answeredSummaries);
    const { inputFingerprint, outputFingerprint, ...output } = draft;
    expect(outputFingerprint).toBe(
      createHash("sha256").update(canonicalJson(output)).digest("hex"),
    );
    const snapshot = await test.repository.readUnfinished();
    expect(snapshot?.currentDraft?.outputSnapshotJson).toBe(canonicalJson(draft));
    expect(snapshot?.currentDraft?.activationFingerprint).toBe(outputFingerprint);
    expect(inputFingerprint).toBe(
      createHash("sha256")
        .update(snapshot?.currentDraft?.inputSnapshotJson ?? "")
        .digest("hex"),
    );
    expect(snapshot?.currentDraft?.inputFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    const before = await test.store.all("SELECT * FROM plan_creation_draft_revision");
    const edited = await answered(
      test.host["plan_creation.answer"]({
        commandId: "edit",
        creationId: card.creationId,
        expectedVersion: card.version + 1,
        answer: { kind: "plan-length", weeks: 8 },
      }),
    );
    expect(edited).toMatchObject({ status: "review", draftStale: true });
    expect(
      edited.answeredSummaries.find((summary) => summary.answerKey === "plan-length")?.answer,
    ).toEqual({ kind: "plan-length", weeks: 8 });
    expect(
      edited.draft?.answeredSummaries.find((summary) => summary.answerKey === "plan-length")
        ?.answer,
    ).toEqual({ kind: "plan-length", weeks: 4 });
    expect(edited.draft).toEqual(draft);
    test.advanceDay();
    const reloaded = await test.host.readCard();
    expect(reloaded?.draft).toEqual(draft);
    expect(reloaded?.draftStale).toBe(true);
    expect(await test.host["plan_creation.preview"](request)).toEqual(first);
    expect(await test.store.all("SELECT * FROM plan_creation_draft_revision")).toEqual(before);
    await expect(
      test.host["plan_creation.preview"]({ ...request, expectedVersion: edited.version }),
    ).resolves.toMatchObject({ status: "rejected", reason: "command-conflict" });
    const rebuilt = await test.host["plan_creation.preview"]({
      ...request,
      commandId: "rebuild",
      expectedVersion: edited.version,
    });
    expect(rebuilt).toMatchObject({ status: "previewed", planCreation: { draftStale: false } });
    const stored = await test.repository.readUnfinished();
    expect(stored?.currentDraft).toMatchObject({ revisionNumber: 2, parentRevisionNumber: 1 });
    expect(await test.host.readCard()).toEqual(
      rebuilt.status === "previewed" ? rebuilt.planCreation : null,
    );
    expect(await test.store.all("SELECT * FROM plan")).toEqual([]);
    expect(await test.store.all("SELECT * FROM plan_conversation")).toEqual([]);
  });

  it("rejects incomplete, stale, and missing creations without storing a revision", async () => {
    const test = await previewHarness();
    const card = test.card();
    const request = {
      commandId: "preview",
      creationId: card.creationId,
      expectedVersion: card.version,
    };
    await expect(test.host["plan_creation.preview"](request)).resolves.toMatchObject({
      reason: "not-ready",
    });
    await expect(
      test.host["plan_creation.preview"]({ ...request, expectedVersion: 10 }),
    ).resolves.toMatchObject({ reason: "stale-version" });
    await expect(
      test.host["plan_creation.preview"]({ ...request, creationId: id("999") }),
    ).resolves.toMatchObject({ reason: "no-unfinished-creation" });
    await test.host["plan_creation.discard"]({ ...request, commandId: "discard" });
    await expect(test.host["plan_creation.preview"](request)).resolves.toMatchObject({
      reason: "no-unfinished-creation",
      planCreation: null,
    });
    expect(await test.store.all("SELECT * FROM plan_creation_draft_revision")).toEqual([]);
  });

  it("preserves the prior complete Draft when no Workouts fit", async () => {
    const test = await previewHarness();
    const card = await test.ready();
    const request = {
      commandId: "preview",
      creationId: card.creationId,
      expectedVersion: card.version,
    };
    await test.host["plan_creation.preview"](request);
    const before = await test.store.all("SELECT * FROM plan_creation_draft_revision");
    const edited = await answered(
      test.host["plan_creation.answer"]({
        commandId: "restrict",
        creationId: card.creationId,
        expectedVersion: card.version + 1,
        answer: { kind: "restriction", restriction: { kind: "no-training" } },
      }),
    );
    await expect(
      test.host["plan_creation.preview"]({
        ...request,
        commandId: "empty",
        expectedVersion: edited.version,
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      reason: "no-workouts",
      explanation: expect.stringContaining("No Workouts"),
      planCreation: { draftStale: true },
    });
    expect(await test.store.all("SELECT * FROM plan_creation_draft_revision")).toEqual(before);
    expect((await test.repository.readUnfinished())?.version).toBe(edited.version);
  });

  it("replays a successful preview after discard without reviving the creation", async () => {
    const test = await previewHarness();
    const card = await test.ready();
    const request = {
      commandId: "preview",
      creationId: card.creationId,
      expectedVersion: card.version,
    };
    const first = await test.host["plan_creation.preview"](request);
    await test.host["plan_creation.discard"]({
      ...request,
      commandId: "discard",
      expectedVersion: card.version + 1,
    });
    test.advanceDay();
    await expect(test.host["plan_creation.preview"](request)).resolves.toEqual(first);
    await expect(test.host.readCard()).resolves.toBeNull();
  });
});

describe("Plan Creation activation", () => {
  const review = async (mode: "fixed" | "flexible" = "fixed") => {
    const test = await previewHarness();
    const card = await test.ready(mode);
    const result = await test.host["plan_creation.preview"]({
      commandId: "preview",
      creationId: card.creationId,
      expectedVersion: card.version,
    });
    if (result.status !== "previewed" || result.planCreation.draft === null)
      throw new Error("Expected current Draft");
    return {
      ...test,
      draft: result.planCreation.draft,
      request: {
        commandId: "activate",
        incumbent: null,
        creationId: card.creationId,
        expectedVersion: result.planCreation.version,
      },
    };
  };

  it("reads the injected legacy summary before opening the list transaction", async () => {
    const legacy = {
      name: "8-Week Plan",
      goal: "Gran Fondo",
      weeks: 8,
      sourceStatus: "draft",
      createdAt: "1998-07-04",
      targetDate: "1998-08-30",
      readOnly: true,
      source: "current-plan.json",
    } satisfies LegacyPlanSummary;
    let resolveLegacy: (value: LegacyPlanSummary | null) => void = () => {};
    const pending = new Promise<LegacyPlanSummary | null>((resolve) => {
      resolveLegacy = resolve;
    });
    const legacyPlan = vi.fn(() => pending);
    const test = await previewHarness(legacyPlan);
    const transaction = vi.spyOn(test.store, "transaction");
    const reading = test.host["plan.list"]({});
    expect(legacyPlan).toHaveBeenCalledTimes(1);
    expect(transaction).not.toHaveBeenCalled();
    resolveLegacy(legacy);
    expect((await reading).legacy).toEqual(legacy);
    expect(transaction).toHaveBeenCalledTimes(1);
    legacyPlan.mockResolvedValueOnce(null);
    expect((await test.host["plan.list"]({})).legacy).toBeNull();
    expect(legacyPlan).toHaveBeenCalledTimes(2);
  });

  it("reads the current calendar connection with an empty library", async () => {
    const test = await previewHarness();
    const card = test.card();
    await test.host["plan_creation.discard"]({
      commandId: "discard",
      creationId: card.creationId,
      expectedVersion: card.version,
    });
    await expect(test.host["plan.list"]({})).resolves.toMatchObject({
      calendarConnected: false,
      legacy: null,
      creation: null,
      active: null,
      closed: [],
    });
    test.setConnected(true);
    await expect(test.host["plan.list"]({})).resolves.toMatchObject({
      calendarConnected: true,
      legacy: null,
      creation: null,
      active: null,
      closed: [],
    });
    test.setConnected(false);
    expect((await test.host["plan.list"]({})).calendarConnected).toBe(false);
  });

  it("keeps library database reads constant as closed Plans are added", async () => {
    const test = await review();
    const activated = await test.host["plan_creation.activate"](test.request);
    const all = vi.spyOn(test.store, "all");
    const get = vi.spyOn(test.store, "get");
    const initial = await test.host["plan.list"]({});
    expect(initial.active?.planId).toBe(activated.planId);
    expect(initial.closed).toEqual([]);
    const initialQueries = all.mock.calls.length + get.mock.calls.length;
    expect(initialQueries).toBeGreaterThan(0);
    const reconciliation = createPlanReconciliationRepository(test.store);
    for (const number of [800, 801, 802]) {
      const planId = id(String(number));
      await test.store.run(
        `INSERT INTO plan (
          id,origin_id,name,primary_goal,start_date_key,target_date_key,status,kind,total_weeks,
          week_start_day,structure_json,created_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter
        ) SELECT ?,origin_id,name,primary_goal,start_date_key,target_date_key,'ended',kind,total_weeks,
          week_start_day,structure_json,created_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter
          FROM plan WHERE id=?`,
        [planId, activated.planId],
      );
      await test.store.run(
        `INSERT INTO planning_plan (
          plan_id,status,version,current_revision_number,activated_at_ms,closed_at_ms,
          close_reason,close_actor,updated_at_ms,device_id,hlc_physical_ms,hlc_counter
        ) SELECT ?,'closed',2,current_revision_number,activated_at_ms,updated_at_ms,
          'stopped',device_id,updated_at_ms,device_id,hlc_physical_ms,hlc_counter
          FROM planning_plan WHERE plan_id=?`,
        [planId, activated.planId],
      );
      await reconciliation.createOrGetJob({
        id: id(String(number + 100)),
        planId,
        kind: "cleanup",
        windowStartDateKey: 19980902,
        windowEndDateKey: 19980929,
        createdAtMs: 904_737_600_000,
      });
    }
    all.mockClear();
    get.mockClear();
    const expanded = await test.host["plan.list"]({});
    expect(expanded.active).toEqual(initial.active);
    expect(expanded.closed).toHaveLength(3);
    expect(expanded.closed.map((plan) => plan.calendar.window)).toEqual([
      { start: "1998-09-02", end: "1998-09-29" },
      { start: "1998-09-02", end: "1998-09-29" },
      { start: "1998-09-02", end: "1998-09-29" },
    ]);
    expect(all.mock.calls.length + get.mock.calls.length).toBe(initialQueries);
  });

  it("projects pending, running, failed and verified mirror work across connection changes", async () => {
    const test = await review();
    const activated = await test.host["plan_creation.activate"](test.request);
    const repository = createPlanReconciliationRepository(test.store);
    const job = await repository.readLatestJobByWindow(activated.planId, "mirror");
    if (job === undefined) throw new Error("Expected mirror job");
    const calendar = {
      status: "not-connected",
      window: { start: today, end: "1998-09-08" },
      currentThrough: null,
      error: null,
    };
    const read = async () => (await test.host["plan.list"]({})).active?.calendar;
    expect(await read()).toEqual(calendar);
    test.setConnected(true);
    expect(await read()).toEqual({ ...calendar, status: "pending" });
    await repository.beginAttempt(job.id, job.updatedAtMs + 1);
    expect(await read()).toEqual({ ...calendar, status: "running" });
    await repository.failJob(job.id, "calendar-list-failed", job.updatedAtMs + 2);
    expect(await read()).toEqual({
      ...calendar,
      status: "failed",
      error: "Calendar sync failed. Retry available.",
    });
    test.setConnected(false);
    expect(await read()).toEqual(calendar);
    test.setConnected(true);
    await repository.beginAttempt(job.id, job.updatedAtMs + 3);
    expect(await read()).toEqual({ ...calendar, status: "running" });
    await repository.verifyJob(job.id, job.updatedAtMs + 4);
    expect(await read()).toEqual({ ...calendar, status: "verified", currentThrough: "1998-09-08" });
    test.setConnected(false);
    expect(await read()).toEqual({ ...calendar, status: "verified", currentThrough: "1998-09-08" });
    expect((await test.host["plan.list"]({})).calendarConnected).toBe(false);
    await test.store.run("DELETE FROM plan_reconciliation_job WHERE id = ?", [job.id]);
    expect(await read()).toEqual({ ...calendar, window: null });
    test.setConnected(true);
    expect(await read()).toEqual({ ...calendar, status: "pending", window: null });
  });

  it("projects the cleanup job for a closed Plan and preserves history cleanup", async () => {
    const test = await review();
    test.setConnected(true);
    const activated = await test.host["plan_creation.activate"](test.request);
    await test.host["plan.close"]({
      commandId: "close-calendar",
      planId: activated.planId,
      expectedVersion: 1,
    });
    const repository = createPlanReconciliationRepository(test.store);
    const job = await repository.readLatestJobByWindow(activated.planId, "cleanup");
    if (job === undefined) throw new Error("Expected cleanup job");
    const calendar = {
      status: "pending",
      window: { start: "1998-09-03", end: test.draft.end },
      currentThrough: null,
      error: null,
    };
    expect((await test.host["plan.list"]({})).closed[0]?.calendar).toEqual(calendar);
    await repository.beginAttempt(job.id, job.updatedAtMs + 1);
    await repository.failJob(job.id, "calendar-list-failed", job.updatedAtMs + 2);
    const failed = {
      ...calendar,
      status: "failed",
      error: "Calendar cleanup failed. Retry available.",
    };
    expect((await test.host["plan.list"]({})).closed[0]?.calendar).toEqual(failed);
    expect(await test.host["plan.history"]({ planId: activated.planId })).toMatchObject({
      plan: { calendar: failed },
      cleanup: "failed",
    });
  });

  it.each(["mirror", "cleanup"] as const)(
    "offers retry only below the failure budget for %s work in the library",
    async (kind) => {
      const test = await review();
      test.setConnected(true);
      const activated = await test.host["plan_creation.activate"](test.request);
      if (kind === "cleanup") {
        await test.host["plan.close"]({
          commandId: "close-calendar",
          planId: activated.planId,
          expectedVersion: 1,
        });
      }
      const repository = createPlanReconciliationRepository(test.store);
      const job = await repository.readLatestJobByWindow(activated.planId, kind);
      if (job === undefined) throw new Error("Expected calendar job");
      const error = kind === "mirror" ? "Calendar sync failed." : "Calendar cleanup failed.";
      for (let failureCount = 1; failureCount <= 6; failureCount += 1) {
        await repository.beginAttempt(job.id, job.updatedAtMs + failureCount * 2 - 1);
        await repository.failJob(
          job.id,
          "calendar-list-failed",
          job.updatedAtMs + failureCount * 2,
        );
        const library = await test.host["plan.list"]({});
        const calendar = kind === "mirror" ? library.active?.calendar : library.closed[0]?.calendar;
        expect(calendar).toMatchObject({
          status: "failed",
          error: failureCount >= 5 ? error : `${error} Retry available.`,
        });
      }
    },
  );

  it("reads history cleanup and calendar from one snapshot during verification", async () => {
    const test = await review();
    test.setConnected(true);
    const activated = await test.host["plan_creation.activate"](test.request);
    await test.host["plan.close"]({
      commandId: "close-calendar-snapshot",
      planId: activated.planId,
      expectedVersion: 1,
    });
    const repository = createPlanReconciliationRepository(test.store);
    const job = await repository.readLatestJobByWindow(activated.planId, "cleanup");
    if (job === undefined) throw new Error("Expected cleanup job");
    await repository.beginAttempt(job.id, job.updatedAtMs + 1);
    await repository.failJob(job.id, "calendar-list-failed", job.updatedAtMs + 2);
    const transaction = vi.spyOn(test.store, "transaction");
    const get = test.store.get.bind(test.store);
    let signalEntered = () => {};
    let releaseRead = () => {};
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const reader = vi.spyOn(test.store, "get").mockImplementation(async (sql, params) => {
      const row = await get(sql, params);
      if (sql.includes("AS cleanup_status")) {
        signalEntered();
        await released;
      }
      return row;
    });
    const history = test.host["plan.history"]({ planId: activated.planId });
    await entered;
    expect(transaction).toHaveBeenCalledTimes(1);
    let verified = false;
    const verification = test.store.transaction(async () => {
      await test.store.run(
        "UPDATE plan_reconciliation_job SET status='verified',last_error_code=NULL,completed_at_ms=?,updated_at_ms=? WHERE id=?",
        [job.updatedAtMs + 3, job.updatedAtMs + 3, job.id],
      );
      verified = true;
    });
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(verified).toBe(false);
    releaseRead();
    await expect(history).resolves.toMatchObject({
      cleanup: "failed",
      plan: { calendar: { status: "failed", currentThrough: null } },
    });
    await verification;
    reader.mockRestore();
    transaction.mockClear();
    await expect(test.host["plan.history"]({ planId: activated.planId })).resolves.toMatchObject({
      cleanup: "complete",
      plan: { calendar: { status: "verified", currentThrough: test.draft.end } },
    });
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("shows pending again after a second Change in the verified window", async () => {
    const test = await review();
    test.setConnected(true);
    const activated = await test.host["plan_creation.activate"](test.request);
    let sequence = 1000;
    const changes = createPlanChangeOperations({
      eventSources: { read: async () => [] },
      ftp: createCyclingPlanFtpAdapter({
        readManual: async () => null,
        readIntervalsFtp: async () => null,
        readIntervalsEftp: async () => null,
        saveManual: async () => {},
        refreshIntervals: async () => {},
      }),
      logger: { warn: () => {} },
      calendarConnected: async () => true,
      store: test.store,
      identity: {
        deviceId: async () => "calendar-change-test-device",
        newUlid: () => id(String(++sequence)),
        hlcStamp: () => ({ physicalMs: 904_694_400_000, counter: sequence }),
      },
      crypto: globalThis.crypto,
      todayDateKey: () => 19980902,
      now: () => 904_694_400_000,
    });
    const repository = createPlanReconciliationRepository(test.store);
    for (const [index, minutes] of [60, 30].entries()) {
      const plan = (await test.host["plan.list"]({})).active;
      if (plan === null) throw new Error("Expected active Plan");
      const preview = await changes["plan_change.preview"]({
        commandId: `preview-calendar-${index}`,
        planId: activated.planId,
        expectedVersion: plan.version,
        intent: { kind: "longest-workout", minutes },
      });
      if (preview.status !== "previewed") throw new Error(`Expected preview: ${preview.reason}`);
      const result = await changes["plan_change.apply"]({
        commandId: `apply-calendar-${index}`,
        planId: activated.planId,
        changeId: preview.change.changeId,
        expectedVersion: plan.version,
        decision: "apply",
      });
      expect(result.status).toBe("applied");
      expect((await test.host["plan.list"]({})).active?.calendar).toEqual({
        status: "pending",
        window: { start: today, end: "1998-09-08" },
        currentThrough: null,
        error: null,
      });
      const job = await repository.readLatestJobByWindow(activated.planId, "mirror");
      if (job === undefined) throw new Error("Expected mirror job");
      await repository.beginAttempt(job.id, job.updatedAtMs);
      await repository.verifyJob(job.id, job.updatedAtMs);
      expect((await test.host["plan.list"]({})).active?.calendar.status).toBe("verified");
    }
  });

  it("reads one snapshot while replacing the active Plan", async () => {
    const test = await review();
    const incumbentId = id("800");
    await createPlanRepository(test.store).replace(
      {
        id: incumbentId,
        originId: null,
        name: "Earlier Plan",
        primaryGoal: "Build fitness",
        startDateKey: 19971222,
        targetDateKey: 19980118,
        status: "active",
        kind: "short_race_preparation",
        totalWeeks: 4,
        weekStartDay: 1,
        structureJson: "{}",
        createdAtMs: 882_748_800_000,
        updatedAtMs: 882_748_800_000,
        deviceId: "test-device",
        hlcPhysicalMs: 882_748_800_000,
        hlcCounter: 0,
      },
      [],
    );
    await test.store.run(
      `INSERT INTO planning_plan
(plan_id,status,version,current_revision_number,activated_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter)
VALUES (?,'active',1,1,882748800000,882748800000,'test-device',882748800000,0)`,
      [incumbentId],
    );
    const transaction = vi.spyOn(test.store, "transaction");
    const readUnfinished = test.repository.readUnfinished.bind(test.repository);
    let signalEntered = () => {};
    let releaseRead = () => {};
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const reader = vi.spyOn(test.repository, "readUnfinished").mockImplementationOnce(async () => {
      const creation = await readUnfinished();
      signalEntered();
      await released;
      return creation;
    });
    test.setToday("1998-01-01");
    const before = test.host["plan.list"]({});
    await entered;
    expect(transaction).toHaveBeenCalledTimes(1);
    const activation = test.host["plan_creation.activate"]({
      ...test.request,
      incumbent: { planId: incumbentId, version: 1 },
    });
    await vi.waitFor(() => expect(transaction).toHaveBeenCalledTimes(2));
    releaseRead();
    await expect(before).resolves.toMatchObject({
      creation: { creationId: test.request.creationId, status: "review" },
      active: { planId: incumbentId, start: "1997-12-22", end: "1998-01-18", creationId: null },
      closed: [],
      changes: [],
    });
    const activated = await activation;
    reader.mockRestore();
    transaction.mockClear();
    const after = await test.host["plan.list"]({});
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(after).toEqual({
      calendarConnected: false,
      legacy: null,
      creation: null,
      changes: [],
      changesPaused: null,
      active: {
        todayChoice: null,
        supportingEventCandidates: [],
        planId: activated.planId,
        version: 1,
        name: "Improve fitness",
        start: test.draft.start,
        end: test.draft.end,
        weeks: 4,
        status: "active",
        closeReason: null,
        closedAt: null,
        activatedAt: "1998-01-01",
        creationId: test.request.creationId,
        calendar: {
          status: "not-connected",
          window: { start: "1998-01-01", end: "1998-01-07" },
          currentThrough: null,
          error: null,
        },
      },
      closed: [
        {
          planId: incumbentId,
          version: 2,
          name: "Earlier Plan",
          start: "1997-12-22",
          end: "1998-01-18",
          weeks: 4,
          status: "closed",
          closeReason: "stopped",
          closedAt: "1998-01-01",
          activatedAt: "1997-12-22",
          creationId: null,
          calendar: {
            status: "not-connected",
            window: { start: "1998-01-02", end: "1998-01-18" },
            currentThrough: null,
            error: null,
          },
        },
      ],
    });
  });

  it("exposes the active version for closure and rejects a stale version", async () => {
    const test = await review();
    const activated = await test.host["plan_creation.activate"](test.request);
    const { active } = await test.host["plan.list"]({});
    expect(active).toMatchObject({ planId: activated.planId, version: 1 });
    if (active === null) throw new Error("Expected an active Plan");

    await expect(
      test.host["plan.close"]({
        commandId: "stop-stale",
        planId: active.planId,
        expectedVersion: active.version + 1,
      }),
    ).resolves.toEqual({ status: "rejected", reason: "stale-version" });
    await expect(
      test.host["plan.close"]({
        commandId: "stop-current",
        planId: active.planId,
        expectedVersion: active.version,
      }),
    ).resolves.toMatchObject({ status: "closed", planId: active.planId });
    await expect(test.host["plan.list"]({})).resolves.toMatchObject({
      active: null,
      closed: [{ planId: active.planId, version: active.version + 1 }],
    });
  });

  it("closes offline, replays the command, and reads the final snapshot", async () => {
    const test = await review("flexible");
    const activated = await test.host["plan_creation.activate"](test.request);
    await expect(test.host["plan.history"]({ planId: activated.planId })).resolves.toBeNull();
    const request = { commandId: "stop", planId: activated.planId, expectedVersion: 1 };
    const result = await test.host["plan.close"](request);
    expect(result).toMatchObject({ status: "closed", planId: activated.planId });
    await expect(test.host["plan.close"](request)).resolves.toEqual(result);
    await expect(test.host["plan.close"]({ ...request, expectedVersion: 2 })).resolves.toEqual({
      status: "rejected",
      reason: "command-conflict",
    });
    const detail = await test.host["plan.history"]({ planId: activated.planId });
    expect(detail).toMatchObject({
      plan: { planId: activated.planId, status: "closed", closeReason: "stopped" },
      closeActor: "athlete",
      revision: { revisionNumber: 1, snapshot: test.draft },
      cleanup: "pending",
    });
    expect(detail?.revision.snapshot.weeks.flatMap((week) => week.workouts)).toEqual(
      expect.arrayContaining([expect.objectContaining({ date: null })]),
    );
    await expect(test.host["plan.list"]({})).resolves.toMatchObject({
      active: null,
      closed: [detail?.plan],
    });
    await expect(test.host["plan.history"]({ planId: id("999") })).resolves.toBeNull();
  });

  it("returns closure rejection reasons without changing an active Plan", async () => {
    const test = await review();
    const activated = await test.host["plan_creation.activate"](test.request);
    await expect(
      test.host["plan.close"]({ commandId: "stale", planId: activated.planId, expectedVersion: 2 }),
    ).resolves.toEqual({ status: "rejected", reason: "stale-version" });
    await expect(
      test.host["plan.close"]({ commandId: "missing", planId: id("999"), expectedVersion: 1 }),
    ).resolves.toEqual({ status: "rejected", reason: "no-active-plan" });
    expect((await test.host["plan.list"]({})).active?.planId).toBe(activated.planId);
  });

  it("completes an expired Plan before listing and retains final history", async () => {
    const test = await review();
    const activated = await test.host["plan_creation.activate"](test.request);
    test.setToday(test.draft.end);
    expect((await test.host["plan.list"]({})).active?.planId).toBe(activated.planId);
    test.setToday("1998-10-01");
    await expect(test.host["plan.list"]({})).resolves.toMatchObject({
      active: null,
      closed: [{ planId: activated.planId, closeReason: "completed" }],
    });
    await expect(test.host["plan.history"]({ planId: activated.planId })).resolves.toMatchObject({
      closeActor: "system:plan-completion",
      cleanup: "pending",
      revision: { snapshot: test.draft },
    });
    expect(
      await test.store.all("SELECT * FROM planning_command WHERE command_name = 'plan.close'"),
    ).toEqual([]);
  });

  it("activates dated Workouts, removes the Chat card, and exposes the Plan to readers", async () => {
    const test = await review();
    const result = await test.host["plan_creation.activate"](test.request);
    expect(result).toEqual({
      creationId: test.request.creationId,
      planId: expect.any(String),
      closedPlanId: null,
      activatedAt: today,
    });
    await expect(test.host.readCard()).resolves.toBeNull();
    await expect(test.repository.readUnfinished()).resolves.toBeUndefined();
    const plans = createPlanRepository(test.store);
    await expect(plans.readLatest()).resolves.toMatchObject({
      id: result.planId,
      name: "Improve fitness",
      primaryGoal: "Climb stronger",
      status: "active",
      startDateKey: Number(test.draft.start.replaceAll("-", "")),
      targetDateKey: Number(test.draft.end.replaceAll("-", "")),
    });
    const draftWorkouts = test.draft.weeks.flatMap((week) => week.workouts);
    const workouts = await plans.readWorkouts(result.planId);
    expect(workouts).toHaveLength(draftWorkouts.length);
    expect(workouts.map((workout) => JSON.parse(workout.structureJson))).toEqual(draftWorkouts);
    const model = await createPlanningReadService({
      store: test.store,
      timezone: "UTC",
      now: () => Date.parse(`${test.draft.start}T12:00:00Z`),
    }).getPlanningReadModel({});
    expect(model).toMatchObject({
      status: "ready",
      plan: { id: result.planId, currentWeek: 1, totalWeeks: 4, phase: null },
    });
    if (model.status !== "ready") throw new Error("Expected active Plan");
    expect(model.plan.workouts.map((workout) => workout.name)).toEqual(
      test.draft.weeks[0]?.workouts.map((workout) => workout.name),
    );
  });

  it("activates a Base Plan within its window and retains the later Event Goal in its snapshot", async () => {
    const test = await previewHarness();
    for (const answer of [
      { kind: "goal", goal: { kind: "event-manual", name: "Spring Tour", date: "1999-05-16" } },
      fixedMode,
      fixedAvailability,
      startTiming,
      noCommitments,
      regularBaseline,
      eventSuccess,
      noRestriction,
    ] satisfies readonly PlanCreationAnswerInput[])
      await test.answer(answer);
    const card = test.card();
    const reviewed = await test.host["plan_creation.preview"]({
      commandId: "preview",
      creationId: card.creationId,
      expectedVersion: card.version,
    });
    if (reviewed.status !== "previewed" || reviewed.planCreation.draft === null)
      throw new Error("Expected Base Plan Draft");
    const draft = reviewed.planCreation.draft;
    expect(draft).toMatchObject({
      spanKind: "Base Plan",
      goal: { name: "Spring Tour", date: "1999-05-16" },
    });
    expect(draft.weeks).toHaveLength(12);
    const activated = await test.host["plan_creation.activate"]({
      commandId: "activate",
      incumbent: null,
      creationId: card.creationId,
      expectedVersion: reviewed.planCreation.version,
    });
    await expect(createPlanRepository(test.store).readLatest()).resolves.toMatchObject({
      id: activated.planId,
      name: "Spring Tour",
      targetDateKey: Number(draft.end.replaceAll("-", "")),
      kind: "full_plan",
      totalWeeks: 12,
    });
    expect(Number(draft.end.replaceAll("-", ""))).toBeLessThan(19990516);
    expect(
      await test.store.all("SELECT snapshot_json FROM plan_revision WHERE plan_id = ?", [
        activated.planId,
      ]),
    ).toEqual([{ snapshot_json: canonicalJson(draft) }]);
  });

  it("keeps undated flexible Workouts in the revision snapshot", async () => {
    const test = await review("flexible");
    const result = await test.host["plan_creation.activate"](test.request);
    expect(test.draft.weeks.flatMap((week) => week.workouts).length).toBeGreaterThan(0);
    expect(await test.store.all("SELECT * FROM plan_workout")).toEqual([]);
    expect(
      await test.store.all("SELECT snapshot_json FROM plan_revision WHERE plan_id = ?", [
        result.planId,
      ]),
    ).toEqual([{ snapshot_json: canonicalJson(test.draft) }]);
    await expect(test.host.readCard()).resolves.toBeNull();
  });

  it("replays the original Plan and host date and rejects changed command input", async () => {
    const test = await review();
    const first = await test.host["plan_creation.activate"](test.request);
    const plans = await test.store.all("SELECT * FROM plan");
    const workouts = await test.store.all("SELECT * FROM plan_workout");
    test.advanceDay();
    await expect(test.host["plan_creation.activate"](test.request)).resolves.toEqual(first);
    await expect(
      test.host["plan_creation.activate"]({
        ...test.request,
        expectedVersion: test.request.expectedVersion + 1,
      }),
    ).rejects.toMatchObject({ code: "command-conflict" });
    expect(await test.store.all("SELECT * FROM plan")).toEqual(plans);
    expect(await test.store.all("SELECT * FROM plan_workout")).toEqual(workouts);
    await expect(test.host.readCard()).resolves.toBeNull();
  });

  it.each([undefined, false])(
    "blocks unacknowledged commitments (%s) without writes and activates the same Draft after acknowledgement",
    async (acknowledged) => {
      const test = await review();
      const active = await test.host["plan_creation.activate"](test.request);
      const started = await test.host["plan_creation.start"]({ commandId: "replacement" });
      if (started.status !== "started") throw new Error("Expected replacement creation");
      let card = started.planCreation;
      const text = "Strength training on Wednesdays";
      for (const answer of [
        fitnessGoal,
        { kind: "plan-length", weeks: 4 },
        fixedMode,
        fixedAvailability,
        startTiming,
        {
          kind: "commitments",
          commitments: {
            kind: "authored",
            text,
            ...(acknowledged === undefined ? {} : { acknowledged }),
          },
        },
        regularBaseline,
        fitnessSuccess,
        noRestriction,
      ] satisfies PlanCreationAnswerInput[]) {
        card = await answered(
          test.host["plan_creation.answer"]({
            commandId: `replacement-${answer.kind}`,
            creationId: card.creationId,
            expectedVersion: card.version,
            answer,
          }),
        );
      }
      expect(card.commitmentsAcknowledgement).toEqual({ text });
      const previewRequest = {
        commandId: "replacement-preview",
        creationId: card.creationId,
        expectedVersion: card.version,
      };
      const previewed = await test.host["plan_creation.preview"](previewRequest);
      if (previewed.status !== "previewed" || previewed.planCreation.draft === null)
        throw new Error("Expected Draft with pending commitments");
      card = previewed.planCreation;
      expect(card.draft?.notes).toContain(
        "Your written commitments are recorded for review and have not been applied to Workouts.",
      );
      const before = await test.repository.readUnfinished();
      if (before === undefined) throw new Error("Expected creation");
      const builderAnswers = resolvePlanCreationDraftAnswers(before);
      expect(builderAnswers?.commitments).toEqual({ kind: "authored", text });
      const incumbent = { planId: active.planId, version: 1 };
      const request = {
        commandId: "replacement-activate",
        incumbent,
        creationId: card.creationId,
        expectedVersion: card.version,
      };
      const activeBefore = await test.store.all("SELECT * FROM planning_plan");
      const plansBefore = await test.store.all("SELECT * FROM plan");
      const writes = vi.spyOn(test.store, "run");
      await expect(test.host["plan_creation.activate"](request)).rejects.toMatchObject({
        code: "commitments-unacknowledged",
      });
      expect(writes).not.toHaveBeenCalled();
      writes.mockRestore();
      expect(await test.store.all("SELECT * FROM planning_plan")).toEqual(activeBefore);
      expect(await test.store.all("SELECT * FROM plan")).toEqual(plansBefore);
      expect(await test.repository.readUnfinished()).toEqual(before);
      const acknowledgementRequest = {
        commandId: "acknowledge",
        creationId: card.creationId,
        expectedVersion: card.version,
        answer: {
          kind: "commitments",
          commitments: { kind: "authored", text, acknowledged: true },
        },
      } as const;
      const confirmed = await answered(test.host["plan_creation.answer"](acknowledgementRequest));
      expect(confirmed).toMatchObject({
        draftStale: false,
        commitmentsAcknowledgement: null,
        draft: card.draft,
      });
      expect(
        confirmed.answeredSummaries.find((summary) => summary.answerKey === "commitments")?.detail,
      ).toBe(text);
      const after = await test.repository.readUnfinished();
      if (after === undefined) throw new Error("Expected acknowledged creation");
      expect(resolvePlanCreationDraftAnswers(after)).toEqual(builderAnswers);
      expect(
        createHash("sha256")
          .update(
            canonicalJson({ answers: resolvePlanCreationDraftAnswers(after), today, ftp: null }),
          )
          .digest("hex"),
      ).toBe(before.currentDraft?.inputFingerprint);
      expect(after.currentDraft).toEqual(before.currentDraft);
      await expect(test.host.readCard()).resolves.toEqual(confirmed);
      await expect(test.host["plan_creation.answer"](acknowledgementRequest)).resolves.toEqual({
        status: "answered",
        planCreation: confirmed,
      });
      await expect(test.host["plan_creation.preview"](previewRequest)).resolves.toEqual(previewed);
      const result = await test.host["plan_creation.activate"]({
        ...request,
        expectedVersion: confirmed.version,
      });
      expect(result.closedPlanId).toBe(active.planId);
      await expect(
        test.host["plan_creation.activate"]({ ...request, expectedVersion: confirmed.version }),
      ).resolves.toEqual(result);
      await expect(test.host["plan_creation.answer"](acknowledgementRequest)).resolves.toEqual({
        status: "answered",
        planCreation: confirmed,
      });
    },
  );

  it("keeps a built Draft and its input fingerprint current after acknowledging the same text", async () => {
    const test = await previewHarness();
    await test.ready();
    const text = "Strength training on Wednesdays";
    const pending = await test.answer({
      kind: "commitments",
      commitments: { kind: "authored", text },
    });
    const previewed = await test.host["plan_creation.preview"]({
      commandId: "preview",
      creationId: pending.creationId,
      expectedVersion: pending.version,
    });
    if (previewed.status !== "previewed") throw new Error("Expected Draft");
    const request = {
      commandId: "acknowledge",
      creationId: pending.creationId,
      expectedVersion: previewed.planCreation.version,
      answer: { kind: "commitments", commitments: { kind: "authored", text, acknowledged: true } },
    } as const;
    const card = await answered(test.host["plan_creation.answer"](request));
    expect(card).toMatchObject({
      draftStale: false,
      commitmentsAcknowledgement: null,
      draft: previewed.planCreation.draft,
    });
    const snapshot = await test.repository.readUnfinished();
    if (snapshot === undefined) throw new Error("Expected creation");
    const answers = resolvePlanCreationDraftAnswers(snapshot);
    expect(answers?.commitments).toEqual({ kind: "authored", text });
    expect(
      createHash("sha256")
        .update(canonicalJson({ answers, today, ftp: null }))
        .digest("hex"),
    ).toBe(card.draft?.inputFingerprint);
    await expect(test.host["plan_creation.answer"](request)).resolves.toEqual({
      status: "answered",
      planCreation: card,
    });
    await expect(test.host.readCard()).resolves.toEqual(card);
    const changed = await answered(
      test.host["plan_creation.answer"]({
        ...request,
        commandId: "change-text",
        expectedVersion: card.version,
        answer: {
          kind: "commitments",
          commitments: {
            kind: "authored",
            text: "Strength training on Fridays",
            acknowledged: true,
          },
        },
      }),
    );
    expect(changed.draftStale).toBe(true);
    await expect(test.host["plan_creation.answer"](request)).resolves.toEqual({
      status: "answered",
      planCreation: card,
    });
  });

  it("projects acknowledgement changes without changing the commitments summary", async () => {
    const test = await previewHarness();
    expect((await test.ready()).commitmentsAcknowledgement).toBeNull();
    const text = "Strength training on Wednesdays";
    for (const acknowledged of [false, true, false]) {
      const card = await test.answer({
        kind: "commitments",
        commitments: { kind: "authored", text, acknowledged },
      });
      expect(card.commitmentsAcknowledgement).toEqual(acknowledged ? null : { text });
      expect(
        card.answeredSummaries.find((summary) => summary.answerKey === "commitments")?.detail,
      ).toBe(text);
    }
    expect((await test.answer(noCommitments)).commitmentsAcknowledgement).toBeNull();
  });

  it("keeps changed commitment text stale even when it is acknowledged", async () => {
    const test = await review();
    const card = await answered(
      test.host["plan_creation.answer"]({
        commandId: "changed-commitments",
        creationId: test.request.creationId,
        expectedVersion: test.request.expectedVersion,
        answer: {
          kind: "commitments",
          commitments: { kind: "authored", text: "No riding on Wednesdays", acknowledged: true },
        },
      }),
    );
    expect(card).toMatchObject({ draftStale: true, commitmentsAcknowledgement: null });
    await expect(
      test.host["plan_creation.activate"]({ ...test.request, expectedVersion: card.version }),
    ).rejects.toMatchObject({ code: "not-ready" });
  });

  it("rejects missing Drafts and stale versions without creating a Plan", async () => {
    const test = await previewHarness();
    const card = await test.ready();
    const request = {
      commandId: "activate",
      incumbent: null,
      creationId: card.creationId,
      expectedVersion: card.version,
    };
    await expect(test.host["plan_creation.activate"](request)).rejects.toMatchObject({
      code: "not-ready",
      message: "Build a current complete Draft and resolve pending answers before activation.",
    });
    await expect(
      test.host["plan_creation.activate"]({ ...request, expectedVersion: card.version - 1 }),
    ).rejects.toMatchObject({
      code: "version-conflict",
    });
    expect(await test.store.all("SELECT * FROM plan")).toEqual([]);
    await expect(test.host.readCard()).resolves.toEqual(card);
  });

  it("rejects an edited Draft and preserves its current card", async () => {
    const test = await review();
    const edited = await answered(
      test.host["plan_creation.answer"]({
        creationId: test.request.creationId,
        expectedVersion: test.request.expectedVersion,
        commandId: "edit",
        answer: { kind: "plan-length", weeks: 8 },
      }),
    );
    await expect(
      test.host["plan_creation.activate"]({ ...test.request, expectedVersion: edited.version }),
    ).rejects.toMatchObject({
      code: "not-ready",
      message: "Build a current complete Draft and resolve pending answers before activation.",
    });
    expect(await test.store.all("SELECT * FROM plan")).toEqual([]);
    await expect(test.host.readCard()).resolves.toEqual(edited);
  });
});
