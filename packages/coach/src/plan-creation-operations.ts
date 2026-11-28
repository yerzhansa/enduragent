import type { IntentTranslationPort } from "@enduragent/engine";
import { createPlanCreationChecks } from "./plan-creation-checks.js";
import { projectCreationCard } from "./plan-creation-card.js";
import {
  createPlanLibraryOperations,
  type PlanLibraryOperations,
} from "./plan-library-operations.js";
import { z } from "zod";
import {
  type PlanChangeEventSource,
  type LegacyPlanSummary,
  PlanCreationActivateRpcParamsSchema,
  PlanCreationActivateRpcResultSchema,
  PlanCreationAnswerRpcParamsSchema,
  PlanCreationAnswerRpcResultSchema,
  PlanCreationDiscardRpcParamsSchema,
  PlanCreationDiscardRpcResultSchema,
  PlanCreationDraftSchema,
  PlanCreationPreviewRpcParamsSchema,
  PlanCreationPreviewRpcResultSchema,
  PlanCreationStartRpcParamsSchema,
  PlanCreationStartRpcResultSchema,
  type PlanCreationCardModel,
  type PlanCreationOperations,
} from "@enduragent/coach-contract";
import { buildCreationDraft } from "@enduragent/sport-cycling";
import { canonicalJson } from "@enduragent/kernel/archive";
import {
  dateKeyFromText,
  inclusiveCivilDays,
  MIN_FULL_PLAN_DAYS,
  weekdayForDateKey,
  PlanCreationStoreError,
  type PlanCreationRepository,
  type PlanCreationSnapshot,
} from "@enduragent/kernel/planning";
import type { MigratorStore, SqlStore } from "@enduragent/kernel/store";
import type { AuthoredIdentity } from "@enduragent/kernel-node/home";
import {
  encodePlanCreationAnswer,
  isPlanCreationDraftCurrent,
  pendingPlanCreationCommitment,
  pendingPlanCreationCheck,
  resolvePlanCreationAnswer,
  projectPlanCreationAnswerSummaries,
  resolvePlanCreationAnswerFlow,
  resolvePlanCreationDraftAnswers,
  validPlanCreationAnswer,
  type PlanCreationAnswerKey,
  type PlanCreationBaselineEvidence,
} from "./plan-creation-answers.js";

export { projectPlanCreationCard } from "./plan-creation-answers.js";

export interface GoalEventCandidateSource {
  read(): Promise<readonly { name: string; date: string; sourceLabel: string }[]>;
}

export interface BaselineEvidenceSource {
  read(): Promise<PlanCreationBaselineEvidence | undefined>;
}

export function expectedPlanCreationAnswerKind(
  snapshot: PlanCreationSnapshot,
): PlanCreationAnswerKey | null {
  return resolvePlanCreationAnswerFlow(snapshot).next;
}

export interface PlanCreationHost extends PlanCreationOperations, PlanLibraryOperations {
  readCard(): Promise<PlanCreationCardModel | null>;
  ready(): Promise<void>;
}

async function requestDigest(crypto: Crypto, request: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(request)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const PreviewInputDateSchema = z.object({ today: z.iso.date() });

const defaultBaselineEvidence: BaselineEvidenceSource = { read: async () => undefined };

export function createPlanCreationOperations(input: {
  store: SqlStore & Pick<MigratorStore, "transaction">;
  repository: PlanCreationRepository;
  identity: AuthoredIdentity;
  crypto: Crypto;
  eventCandidates: GoalEventCandidateSource;
  eventSources: { read(): Promise<PlanChangeEventSource[]> };
  baselineEvidence?: BaselineEvidenceSource;
  calendarConnected?: () => boolean;
  ftp?: { readonly athleteId: () => string | null };
  intervalsConfigured?: () => boolean;
  legacyPlan?: () => Promise<LegacyPlanSummary | null>;
  translator?: IntentTranslationPort;
  language?: (text: string) => Promise<string>;
  today?: () => string;
  todayDateKey?: () => number;
  timezone?: () => string;
  now?: () => number;
}): PlanCreationHost {
  const baselineEvidence = input.baselineEvidence ?? defaultBaselineEvidence;
  const today = input.today ?? (() => new Date().toISOString().slice(0, 10));
  const todayDateKey = input.todayDateKey ?? (() => dateKeyFromText(today()));
  const timezone = input.timezone ?? (() => "UTC");
  const now = input.now ?? Date.now;
  const calendarConnected = input.calendarConnected ?? (() => false);
  const intervalsConfigured = input.intervalsConfigured ?? calendarConnected;
  const legacyPlan = input.legacyPlan ?? (async () => null);
  const stamp = async (commandId: string, digest: string) => {
    const clock = input.identity.hlcStamp();
    return {
      commandId,
      requestDigest: digest,
      nowMs: clock.physicalMs,
      deviceId: await input.identity.deviceId(),
      hlcPhysicalMs: clock.physicalMs,
      hlcCounter: clock.counter,
    };
  };
  const persistDerivedBaseline = async (
    snapshot: PlanCreationSnapshot,
  ): Promise<PlanCreationSnapshot> => {
    if (expectedPlanCreationAnswerKind(snapshot) !== "baseline") return snapshot;
    let evidence: PlanCreationBaselineEvidence | undefined;
    try {
      evidence = await baselineEvidence.read();
    } catch {
      return snapshot;
    }
    const label = evidence?.label.trim().slice(0, 128) ?? "";
    if (evidence === undefined || label.length === 0) return snapshot;
    const answer = { kind: "baseline", baseline: evidence.baseline } as const;
    const source = { kind: "derived", label } as const;
    const request = {
      creationId: snapshot.id,
      expectedVersion: snapshot.version,
      answer,
      source,
    };
    const digest = await requestDigest(input.crypto, request);
    try {
      const result = await input.repository.recordAnswer({
        command: await stamp(`plan-creation-derived-baseline:${digest}`, digest),
        creationId: snapshot.id,
        expectedVersion: snapshot.version,
        answerId: input.identity.newUlid(),
        answerKey: "baseline",
        valueJson: encodePlanCreationAnswer(answer, source),
      });
      return result.snapshot;
    } catch (error) {
      if (
        error instanceof PlanCreationStoreError &&
        ["stale-version", "command-conflict", "missing-creation"].includes(error.code)
      ) {
        return (await input.repository.readUnfinished()) ?? snapshot;
      }
      throw error;
    }
  };
  const project = (snapshot: PlanCreationSnapshot, questionToday = today()) =>
    projectCreationCard(snapshot, {
      store: input.store,
      today: questionToday,
      todayDateKey: todayDateKey(),
      calendarConnected: calendarConnected(),
      ftp: input.ftp === undefined ? null : { athleteId: input.ftp.athleteId() },
    });
  const replayRow = async (
    name: "plan_creation.start" | "plan_creation.answer",
    commandId: string,
    digest: string,
  ) => {
    const row = await input.store.get(
      "SELECT request_digest,status,result_json FROM planning_command WHERE command_name=? AND command_id=?",
      [name, commandId],
    );
    if (row === undefined) return undefined;
    if (row.request_digest !== digest) throw new PlanCreationStoreError("command-conflict");
    if (row.status !== "succeeded" || typeof row.result_json !== "string")
      throw new PlanCreationStoreError("corrupt-record");
    return z
      .object({
        creationId: z.string(),
        outcome: z.enum(["created", "resumed"]).optional(),
        version: z.number().int().positive().optional(),
      })
      .parse(JSON.parse(row.result_json));
  };
  const projectRecorded = async (snapshot: PlanCreationSnapshot, version: number) => {
    const draftRow = await input.store.get(
      "SELECT output_snapshot_json,input_version FROM plan_creation_draft_revision WHERE creation_id=? AND input_version+1<=? ORDER BY revision_number DESC LIMIT 1",
      [snapshot.id, version],
    );
    const recordedDraft =
      draftRow === undefined
        ? null
        : z
            .object({
              output_snapshot_json: z.string(),
              input_version: z.number().int().positive(),
            })
            .parse(draftRow);
    const card = await project({
      ...snapshot,
      status: "in-progress",
      version,
      currentDraft: null,
      pendingCheckJson: null,
      answers: snapshot.answers.filter((answer) => answer.creationVersion <= version),
    });
    return recordedDraft === null
      ? card
      : {
          ...card,
          status: "review" as const,
          draft: PlanCreationDraftSchema.parse(JSON.parse(recordedDraft.output_snapshot_json)),
          draftStale: !isPlanCreationDraftCurrent(
            {
              ...snapshot,
              version,
              answers: snapshot.answers.filter((answer) => answer.creationVersion <= version),
            },
            recordedDraft.input_version,
          ),
        };
  };
  const checks = createPlanCreationChecks({
    store: input.store,
    newId: () => input.identity.newUlid(),
    stamp,
    digest: (value) => requestDigest(input.crypto, value),
    project,
    translator: input.translator ?? { translateIntent: async () => null },
    language: input.language ?? (async () => "en"),
    today,
  });
  const readCard = async (): Promise<PlanCreationCardModel | null> => {
    await checks.ready();
    const snapshot = await input.repository.readUnfinished();
    return snapshot === undefined ? null : project(snapshot);
  };
  return {
    ...createPlanLibraryOperations({
      store: input.store,
      repository: input.repository,
      identity: input.identity,
      crypto: input.crypto,
      eventSources: input.eventSources,
      calendarConnected,
      intervalsConfigured,
      legacyPlan,
      todayDateKey,
      timezone,
      now,
      stamp,
      digest: (value) => requestDigest(input.crypto, value),
      project,
      ready: checks.ready,
    }),
    async "plan_creation.start"(request) {
      const parsed = PlanCreationStartRpcParamsSchema.parse(request);
      const digest = await requestDigest(input.crypto, parsed);
      try {
        const replay = await replayRow("plan_creation.start", parsed.commandId, digest);
        const current = replay === undefined ? await input.repository.readUnfinished() : undefined;
        const candidates =
          current === undefined && replay === undefined
            ? (await input.eventCandidates.read()).slice(0, 10).map((candidate) => ({
                candidateId: input.identity.newUlid(),
                ...candidate,
              }))
            : [];
        const result = await input.repository.start({
          command: await stamp(parsed.commandId, digest),
          creationId: current?.id ?? input.identity.newUlid(),
          seed: { schemaVersion: 1, eventCandidates: candidates },
        });
        const response = PlanCreationStartRpcResultSchema.parse({
          status: "started",
          outcome: replay?.outcome ?? (result.outcome === "created" ? "created" : "resumed"),
          planCreation:
            replay === undefined
              ? await project(await persistDerivedBaseline(result.snapshot))
              : await projectRecorded(result.snapshot, replay.version ?? result.snapshot.version),
        });
        return response;
      } catch (error) {
        if (error instanceof PlanCreationStoreError && error.code === "command-conflict") {
          return PlanCreationStartRpcResultSchema.parse({
            status: "rejected",
            reason: "command-conflict",
          });
        }
        throw error;
      }
    },
    async "plan_creation.answer"(request, onEvent) {
      const parsed = PlanCreationAnswerRpcParamsSchema.parse(request);
      const checked = await checks.handle(parsed, onEvent);
      if (checked !== null) return checked;
      if (parsed.answer.kind === "check-submit" || parsed.answer.kind === "check-action")
        return { status: "rejected", reason: "invalid-answer", planCreation: await readCard() };
      const digest = await requestDigest(input.crypto, parsed);
      try {
        const replay = await replayRow("plan_creation.answer", parsed.commandId, digest);
        if (replay !== undefined) {
          const result = await input.repository.recordAnswer({
            command: await stamp(parsed.commandId, digest),
            creationId: parsed.creationId,
            expectedVersion: parsed.expectedVersion,
            answerId: input.identity.newUlid(),
            answerKey: parsed.answer.kind,
            valueJson: canonicalJson({ answer: parsed.answer, source: { kind: "athlete" } }),
          });
          const response = PlanCreationAnswerRpcResultSchema.parse({
            status: "answered",
            planCreation: await projectRecorded(
              result.snapshot,
              replay.version ?? result.snapshot.version,
            ),
          });
          return response;
        }
      } catch (error) {
        if (error instanceof PlanCreationStoreError && error.code === "command-conflict")
          return PlanCreationAnswerRpcResultSchema.parse({
            status: "rejected",
            reason: "command-conflict",
            planCreation: null,
          });
        throw error;
      }
      const snapshot = await input.repository.readUnfinished();
      if (snapshot === undefined || snapshot.id !== parsed.creationId) {
        return PlanCreationAnswerRpcResultSchema.parse({
          status: "rejected",
          reason: "no-unfinished-creation",
          planCreation: snapshot === undefined ? null : await project(snapshot),
        });
      }
      const answer = resolvePlanCreationAnswer(snapshot, parsed.answer);
      const flow = resolvePlanCreationAnswerFlow(snapshot);
      const answerKey =
        parsed.answer.kind === "commitments-confirm" ||
        parsed.answer.kind === "commitments-cancel" ||
        parsed.answer.kind === "commitments-interpret"
          ? "commitments"
          : parsed.answer.kind;
      if (
        snapshot.version === parsed.expectedVersion &&
        flow.next !== answerKey &&
        !flow.valid.has(answerKey)
      ) {
        return PlanCreationAnswerRpcResultSchema.parse({
          status: "rejected",
          reason: "answer-not-expected",
          planCreation: await project(snapshot),
        });
      }
      if (
        snapshot.version === parsed.expectedVersion &&
        (answer === null || !validPlanCreationAnswer(snapshot, flow, answer, today()))
      ) {
        return PlanCreationAnswerRpcResultSchema.parse({
          status: "rejected",
          reason: "invalid-answer",
          planCreation: await project(snapshot),
        });
      }
      const stampValue = await stamp(parsed.commandId, digest);
      const answerId = input.identity.newUlid();
      const record = () =>
        input.repository.recordAnswer({
          command: stampValue,
          creationId: parsed.creationId,
          expectedVersion: parsed.expectedVersion,
          answerId,
          answerKey,
          valueJson:
            answer === null
              ? canonicalJson({ answer: parsed.answer, source: { kind: "athlete" } })
              : encodePlanCreationAnswer(answer, { kind: "athlete" }),
        });
      try {
        const result = await record();
        const response = PlanCreationAnswerRpcResultSchema.parse({
          status: "answered",
          planCreation: await project(await persistDerivedBaseline(result.snapshot)),
        });
        return response;
      } catch (error) {
        if (
          error instanceof PlanCreationStoreError &&
          ["stale-version", "command-conflict", "missing-creation"].includes(error.code)
        ) {
          return PlanCreationAnswerRpcResultSchema.parse({
            status: "rejected",
            reason: error.code === "missing-creation" ? "no-unfinished-creation" : error.code,
            planCreation: await readCard(),
          });
        }
        throw error;
      }
    },
    async "plan_creation.preview"(request) {
      const parsed = PlanCreationPreviewRpcParamsSchema.parse(request);
      const command = await stamp(parsed.commandId, await requestDigest(input.crypto, parsed));
      try {
        const replayed = await input.repository.replayDraft(command);
        if (replayed !== undefined) {
          if (replayed.currentDraft === null) throw new PlanCreationStoreError("corrupt-record");
          const context = PreviewInputDateSchema.parse(
            JSON.parse(replayed.currentDraft.inputSnapshotJson),
          );
          return PlanCreationPreviewRpcResultSchema.parse({
            status: "previewed",
            planCreation: await project(replayed, context.today),
          });
        }
        const snapshot = await input.repository.readUnfinished();
        if (snapshot === undefined || snapshot.id !== parsed.creationId) {
          return PlanCreationPreviewRpcResultSchema.parse({
            status: "rejected",
            reason: "no-unfinished-creation",
            planCreation: snapshot === undefined ? null : await project(snapshot),
          });
        }
        if (snapshot.version !== parsed.expectedVersion) {
          return PlanCreationPreviewRpcResultSchema.parse({
            status: "rejected",
            reason: "stale-version",
            planCreation: await project(snapshot),
          });
        }
        if (
          pendingPlanCreationCommitment(snapshot) !== null ||
          pendingPlanCreationCheck(snapshot) !== null
        ) {
          return PlanCreationPreviewRpcResultSchema.parse({
            status: "rejected",
            reason: "commitments-pending",
            explanation: "Clarify or cancel the pending commitment correction.",
            planCreation: await project(snapshot),
          });
        }
        const answers = resolvePlanCreationDraftAnswers(snapshot);
        if (answers === null) {
          return PlanCreationPreviewRpcResultSchema.parse({
            status: "rejected",
            reason: "not-ready",
            planCreation: await project(snapshot),
          });
        }
        const buildInput = { answers, today: today(), ftp: null } as const;
        const built = buildCreationDraft(buildInput);
        if (built.kind === "no-workouts") {
          return PlanCreationPreviewRpcResultSchema.parse({
            status: "rejected",
            reason: "no-workouts",
            explanation: built.explanation,
            planCreation: await project(snapshot, buildInput.today),
          });
        }
        const { inputFingerprint, outputFingerprint: _builderOutputFingerprint, ...output } = built;
        const draftOutput = {
          ...output,
          supportingEvents: [],
          answeredSummaries: projectPlanCreationAnswerSummaries(
            snapshot,
            resolvePlanCreationAnswerFlow(snapshot),
            { today: buildInput.today },
          ),
        };
        const draft = PlanCreationDraftSchema.parse({
          ...draftOutput,
          inputFingerprint,
          outputFingerprint: await requestDigest(input.crypto, draftOutput),
        });
        const result = await input.repository.recordDraft({
          command,
          creationId: parsed.creationId,
          expectedVersion: parsed.expectedVersion,
          draftId: input.identity.newUlid(),
          inputSnapshotJson: canonicalJson(buildInput),
          inputFingerprint: draft.inputFingerprint,
          outputSnapshotJson: canonicalJson(draft),
          builderId: draft.builderId,
          builderVersion: draft.builderVersion,
          activationFingerprint: draft.outputFingerprint,
        });
        return PlanCreationPreviewRpcResultSchema.parse({
          status: "previewed",
          planCreation: await project(result.snapshot, buildInput.today),
        });
      } catch (error) {
        if (
          error instanceof PlanCreationStoreError &&
          [
            "stale-version",
            "command-conflict",
            "missing-creation",
            "no-unfinished-creation",
          ].includes(error.code)
        ) {
          return PlanCreationPreviewRpcResultSchema.parse({
            status: "rejected",
            reason: error.code === "missing-creation" ? "no-unfinished-creation" : error.code,
            planCreation: await readCard(),
          });
        }
        throw error;
      }
    },
    async "plan_creation.activate"(request) {
      const parsed = PlanCreationActivateRpcParamsSchema.parse(request);
      const command = await stamp(parsed.commandId, await requestDigest(input.crypto, parsed));
      const result = await input.repository
        .activate({
          command,
          incumbent: parsed.incumbent,
          creationId: parsed.creationId,
          expectedVersion: parsed.expectedVersion,
          activatedAt: today(),
          todayDateKey: todayDateKey(),
          mirrorJobId: input.identity.newUlid(),
          revisionId: input.identity.newUlid(),
          isDraftCurrent(snapshot) {
            if (
              pendingPlanCreationCommitment(snapshot) !== null ||
              pendingPlanCreationCheck(snapshot) !== null
            )
              throw new PlanCreationStoreError("commitments-pending");
            return isPlanCreationDraftCurrent(snapshot);
          },
          materialize(snapshot) {
            if (
              snapshot.currentDraft === null ||
              resolvePlanCreationDraftAnswers(snapshot) === null
            )
              throw new PlanCreationStoreError("not-ready");
            if (
              pendingPlanCreationCommitment(snapshot) !== null ||
              pendingPlanCreationCheck(snapshot) !== null
            )
              throw new PlanCreationStoreError("commitments-pending");
            const draft = PlanCreationDraftSchema.parse(
              JSON.parse(snapshot.currentDraft.outputSnapshotJson),
            );
            const planId = input.identity.newUlid();
            const startDateKey = dateKeyFromText(draft.start);
            const targetDateKey = dateKeyFromText(draft.end);
            const name = draft.goal.kind === "event" ? draft.goal.name : "Improve fitness";
            const primaryGoal =
              draft.answeredSummaries.find((answer) => answer.answerKey === "success")?.detail ??
              name;
            const totalWeeks = draft.weeks.length;
            const kind =
              inclusiveCivilDays(startDateKey, targetDateKey) >= MIN_FULL_PLAN_DAYS
                ? "full_plan"
                : "short_race_preparation";
            const authored = {
              deviceId: command.deviceId,
              hlcPhysicalMs: command.hlcPhysicalMs,
              hlcCounter: command.hlcCounter,
            };
            return {
              plan: {
                id: planId,
                originId: null,
                name,
                primaryGoal,
                startDateKey,
                targetDateKey,
                status: "active",
                kind,
                totalWeeks,
                weekStartDay: weekdayForDateKey(startDateKey),
                structureJson: canonicalJson({
                  source: "plan-creation",
                  creationId: snapshot.id,
                  draftRevisionNumber: snapshot.currentDraft.revisionNumber,
                  spanKind: draft.spanKind,
                  mode: draft.mode,
                }),
                createdAtMs: command.nowMs,
                updatedAtMs: command.nowMs,
                ...authored,
              },
              workouts: draft.weeks.flatMap((week) =>
                week.workouts.flatMap((workout) =>
                  workout.date === null
                    ? []
                    : [
                        {
                          id: input.identity.newUlid(),
                          planId,
                          dateKey: dateKeyFromText(workout.date),
                          sport: "Ride",
                          name: workout.name,
                          durationS: Math.round(workout.minutes * 60),
                          structureJson: canonicalJson(workout),
                          origin: "coach" as const,
                          ...authored,
                        },
                      ],
                ),
              ),
            };
          },
        })
        .catch(async (error: unknown) => {
          if (error instanceof PlanCreationStoreError && error.code === "not-ready") {
            const snapshot = await input.repository.readUnfinished();
            if (
              snapshot?.id === parsed.creationId &&
              snapshot.version === parsed.expectedVersion &&
              (pendingPlanCreationCommitment(snapshot) !== null ||
                pendingPlanCreationCheck(snapshot) !== null)
            )
              throw new PlanCreationStoreError("commitments-pending");
          }
          throw error;
        });
      return PlanCreationActivateRpcResultSchema.parse(result);
    },
    async "plan_creation.discard"(request) {
      const parsed = PlanCreationDiscardRpcParamsSchema.parse(request);
      try {
        await input.repository.discard({
          command: await stamp(parsed.commandId, await requestDigest(input.crypto, parsed)),
          creationId: parsed.creationId,
          expectedVersion: parsed.expectedVersion,
        });
        return PlanCreationDiscardRpcResultSchema.parse({ status: "discarded" });
      } catch (error) {
        if (
          error instanceof PlanCreationStoreError &&
          ["stale-version", "command-conflict", "no-unfinished-creation"].includes(error.code)
        ) {
          return PlanCreationDiscardRpcResultSchema.parse({
            status: "rejected",
            reason: error.code,
            planCreation: await readCard(),
          });
        }
        throw error;
      }
    },
    readCard,
    ready: checks.ready,
  };
}
