import { describe, expect, it, vi } from "vitest";
import type { PlanCreationRepository, PlanCreationSnapshot } from "@enduragent/kernel/planning";
import { PlanCreationStoreError } from "@enduragent/kernel/planning";
import { PlanCreationCardModelSchema } from "@enduragent/coach-contract";
import {
  createPlanCreationOperations,
  expectedPlanCreationAnswerKind,
  projectPlanCreationCard,
} from "../src/plan-creation-operations.js";

const id = (value: string) => `${"0".repeat(26 - value.length)}${value}`;
const eventCandidate = {
  candidateId: id("2"),
  name: "Tour",
  date: "1998-10-18",
  sourceLabel: "Calendar",
};
const candidateSource = { name: "Tour", date: "1998-10-18", sourceLabel: "Calendar" };
const answer = (sequence: number, answerKey: "goal" | "success", value: unknown) => ({
  id: id(`${sequence + 2}`),
  sequence,
  creationVersion: sequence + 1,
  answerKey,
  valueJson: JSON.stringify(value),
  confirmedAtMs: 883_612_800_000 + sequence,
});
const eventGoal = answer(1, "goal", {
  kind: "goal",
  goal: { kind: "event-candidate", candidateId: eventCandidate.candidateId },
});
const fitnessGoal = answer(1, "goal", {
  kind: "goal",
  goal: { kind: "fitness", outcome: "Build power" },
});
const eventSuccess = answer(2, "success", {
  kind: "success",
  success: { kind: "event-finish", choice: "finish-fast" },
});
const snapshot = (answers: PlanCreationSnapshot["answers"] = []): PlanCreationSnapshot => ({
  id: id("1"),
  status: "in-progress",
  version: answers.length + 1,
  seed: { schemaVersion: 1, eventCandidates: [eventCandidate] },
  createdAtMs: 883_612_800_000,
  updatedAtMs: 883_612_800_000,
  answers,
});

function operations(repository: PlanCreationRepository, candidates = [candidateSource]) {
  let sequence = 8;
  return createPlanCreationOperations({
    repository,
    identity: {
      deviceId: async () => "test-device",
      newUlid: () => id(`${++sequence}`),
      hlcStamp: () => ({ physicalMs: 883_612_800_000, counter: 0 }),
    },
    crypto: globalThis.crypto,
    eventCandidates: { read: async () => candidates },
  });
}

describe("Plan Creation operations", () => {
  it("owns flow policy and projects both host-authored Card paths", () => {
    expect(
      [snapshot(), snapshot([eventGoal]), snapshot([eventGoal, eventSuccess])].map(
        expectedPlanCreationAnswerKind,
      ),
    ).toEqual(["goal", "success", null]);
    expect(projectPlanCreationCard(snapshot([eventGoal]))).toMatchObject({
      answeredSummaries: [{ title: "Goal", detail: "Tour · 1998-10-18 · Calendar" }],
      openQuestion: { kind: "success-question", input: { kind: "event-finish" } },
    });
    expect(projectPlanCreationCard(snapshot([fitnessGoal]))).toMatchObject({
      answeredSummaries: [{ title: "Goal", detail: "Build power" }],
      openQuestion: { kind: "success-question", input: { kind: "authored" } },
    });
    expect(projectPlanCreationCard(snapshot([eventGoal, eventSuccess]))).toMatchObject({
      answeredSummaries: [{ title: "Goal" }, { title: "Success", detail: "Finish fast" }],
      openQuestion: null,
    });
  });

  it("round trips the longest accepted Fitness Goal through the Card contract", () => {
    const outcome = "x".repeat(2_000);
    const projected = projectPlanCreationCard(
      snapshot([
        answer(1, "goal", {
          kind: "goal",
          goal: { kind: "fitness", outcome },
        }),
      ]),
    );

    expect(PlanCreationCardModelSchema.parse(projected).answeredSummaries[0]?.detail).toBe(outcome);
  });

  it("seeds a create and maps created, resumed, replayed, and conflict starts", async () => {
    let current: PlanCreationSnapshot | undefined;
    const outcomes = ["created", "resumed", "replayed"] as const;
    let call = 0;
    const start = vi.fn<PlanCreationRepository["start"]>(async (input) => {
      if (input.command.commandId === "conflict")
        throw new PlanCreationStoreError("command-conflict");
      current ??= snapshot();
      return { outcome: outcomes[call++] ?? "replayed", snapshot: current };
    });
    const host = operations({
      readUnfinished: async () => current,
      start,
      recordAnswer: async () => {
        throw new Error("unused");
      },
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
  });

  it("maps every answer rejection, lets ledger replay beat stale flow, and derives the drain gate", async () => {
    let current: PlanCreationSnapshot | undefined;
    let recordError: PlanCreationStoreError | undefined;
    const recordAnswer = vi.fn<PlanCreationRepository["recordAnswer"]>(async () => {
      if (recordError !== undefined) throw recordError;
      if (current === undefined) throw new PlanCreationStoreError("missing-creation");
      return { outcome: "replayed", snapshot: current };
    });
    const host = operations({
      readUnfinished: async () => current,
      start: async () => {
        throw new Error("unused");
      },
      recordAnswer,
    });
    const submit = (
      commandId: string,
      expectedVersion: number,
      value: Parameters<(typeof host)["plan_creation.answer"]>[0]["answer"],
    ) =>
      host["plan_creation.answer"]({
        commandId,
        creationId: id("1"),
        expectedVersion,
        answer: value,
      });
    const goal = {
      kind: "goal" as const,
      goal: { kind: "fitness" as const, outcome: "Build power" },
    };
    await expect(submit("missing", 1, goal)).resolves.toMatchObject({
      reason: "no-unfinished-creation",
    });
    current = snapshot();
    expect(await host.hasOpenQuestion()).toBe(true);
    await expect(
      submit("wrong", 1, { kind: "success", success: { kind: "authored", text: "Ride well" } }),
    ).resolves.toMatchObject({ reason: "answer-not-expected" });
    await expect(
      submit("candidate", 1, {
        kind: "goal",
        goal: { kind: "event-candidate", candidateId: id("7") },
      }),
    ).resolves.toMatchObject({ reason: "invalid-answer" });
    recordError = new PlanCreationStoreError("stale-version");
    await expect(submit("stale", 1, goal)).resolves.toMatchObject({ reason: "stale-version" });
    recordError = new PlanCreationStoreError("command-conflict");
    await expect(submit("conflict", 1, goal)).resolves.toMatchObject({
      reason: "command-conflict",
    });
    recordError = undefined;
    current = snapshot([fitnessGoal]);
    await expect(
      submit("mode", 2, {
        kind: "success",
        success: { kind: "event-finish", choice: "finish-fast" },
      }),
    ).resolves.toMatchObject({ reason: "invalid-answer" });
    await expect(submit("replay", 1, goal)).resolves.toMatchObject({
      status: "answered",
      planCreation: { version: 2 },
    });
    current = { ...snapshot([eventGoal]), seed: null };
    expect(await host.hasOpenQuestion()).toBe(true);
    current = { ...snapshot(), status: "review" };
    expect(await host.hasOpenQuestion()).toBe(false);
    current = snapshot([eventGoal, eventSuccess]);
    expect(await host.hasOpenQuestion()).toBe(false);
  });
});
