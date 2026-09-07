import { z } from "zod";
import {
  PlanCloseRpcParamsSchema,
  PlanCloseResultSchema,
  PlanHistoryParamsSchema,
  PlanHistoryResultSchema,
  type PlanCalendarStatus,
  type PlanChangeEventSource,
  type PlanCloseRpcParams,
  type PlanCloseResult,
  type PlanHistoryParams,
  type PlanHistoryResult,
  ListPlansParamsSchema,
  ListPlansResultSchema,
  type ListPlansParams,
  type ListPlansResult,
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
  addCivilDays,
  createPlanChangeRepository,
  createPlanWorkoutMatchRepository,
  createPlanLifecycleRepository,
  createPlanReconciliationRepository,
  createPlanRepository,
  dateKeyFromText,
  inclusiveCivilDays,
  MIN_FULL_PLAN_DAYS,
  weekdayForDateKey,
  PlanCreationStoreError,
  type PlanCreationRepository,
  type PlanCreationSnapshot,
  type PlanSummaryRecord,
  type PlanReconciliationJobRecord,
} from "@enduragent/kernel/planning";
import type { MigratorStore, SqlStore } from "@enduragent/kernel/store";
import type { AuthoredIdentity } from "@enduragent/kernel-node/home";
import {
  encodePlanCreationAnswer,
  isPlanCreationDraftCurrent,
  pendingPlanCreationCommitment,
  resolvePlanCreationAnswer,
  projectPlanCreationCard,
  projectPlanCreationAnswerSummaries,
  resolvePlanCreationAnswerFlow,
  resolvePlanCreationDraftAnswers,
  validPlanCreationAnswer,
  validateCommitmentInterpretation,
  type PlanCreationAnswerKey,
  type PlanCreationBaselineEvidence,
} from "./plan-creation-answers.js";

import {
  projectPlanChanges,
  readPlanChangesPaused,
  projectTodayChoice,
  readClosedPlanOccupiesToday,
} from "./plan-change-operations.js";

export { projectPlanCreationCard, interpretCommitmentMessage } from "./plan-creation-answers.js";

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

export interface PlanCreationHost extends PlanCreationOperations {
  "plan.list"(request: ListPlansParams): Promise<ListPlansResult>;
  "plan.close"(request: PlanCloseRpcParams): Promise<PlanCloseResult>;
  "plan.history"(request: PlanHistoryParams): Promise<PlanHistoryResult>;
  readCard(): Promise<PlanCreationCardModel | null>;
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
  legacyPlan?: () => Promise<LegacyPlanSummary | null>;
  today?: () => string;
  todayDateKey?: () => number;
  now?: () => number;
}): PlanCreationHost {
  const plans = createPlanRepository(input.store);
  const lifecycle = createPlanLifecycleRepository(input.store, {
    newId: () => input.identity.newUlid(),
  });
  const baselineEvidence = input.baselineEvidence ?? defaultBaselineEvidence;
  const today = input.today ?? (() => new Date().toISOString().slice(0, 10));
  const todayDateKey = input.todayDateKey ?? (() => dateKeyFromText(today()));
  const now = input.now ?? Date.now;
  const calendarConnected = input.calendarConnected ?? (() => false);
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
  const project = async (snapshot: PlanCreationSnapshot): Promise<PlanCreationCardModel> => {
    const current = await persistDerivedBaseline(snapshot);
    return projectPlanCreationCard(current, { today: today() });
  };
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
    const card = projectPlanCreationCard(
      {
        ...snapshot,
        status: "in-progress",
        version,
        currentDraft: null,
        answers: snapshot.answers.filter((answer) => answer.creationVersion <= version),
      },
      { today: today() },
    );
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
  const readCard = async (): Promise<PlanCreationCardModel | null> => {
    const snapshot = await input.repository.readUnfinished();
    return snapshot === undefined ? null : project(snapshot);
  };
  const dateText = (dateKey: number): string => {
    const digits = String(dateKey).padStart(8, "0");
    return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  };
  const timestampDate = (value: number | null): string | null =>
    value === null ? null : new Date(value).toISOString().slice(0, 10);
  const summarizeCalendar = (job: PlanReconciliationJobRecord | undefined): PlanCalendarStatus => {
    const window =
      job === undefined
        ? null
        : {
            start: dateText(job.windowStartDateKey),
            end: dateText(job.windowEndDateKey),
          };
    if (job?.status === "verified") {
      return {
        status: "verified",
        window,
        currentThrough: dateText(job.windowEndDateKey),
        error: null,
      };
    }
    if (!calendarConnected()) {
      return { status: "not-connected", window, currentThrough: null, error: null };
    }
    if (job === undefined || job.status === "pending") {
      return { status: "pending", window, currentThrough: null, error: null };
    }
    if (job.status === "failed") {
      const error = job.kind === "mirror" ? "Calendar sync failed." : "Calendar cleanup failed.";
      return {
        status: "failed",
        window,
        currentThrough: null,
        error: job.failureCount >= 5 ? error : `${error} Retry available.`,
      };
    }
    return { status: "running", window, currentThrough: null, error: null };
  };
  const summarizePlan = (plan: PlanSummaryRecord) => ({
    planId: plan.planId,
    version: plan.version,
    name: plan.name,
    start: dateText(plan.startDateKey),
    end: dateText(addCivilDays(plan.startDateKey, plan.totalWeeks * 7 - 1)),
    weeks: plan.totalWeeks,
    status: plan.status,
    closeReason: plan.closeReason,
    closedAt: timestampDate(plan.closedAtMs),
    activatedAt: timestampDate(plan.activatedAtMs),
    creationId: plan.creationId,
  });
  const supportingEventCandidates = async (planId: string, sources: PlanChangeEventSource[]) => {
    if (sources.length === 0) return [];
    const revision = await input.store.get(
      "SELECT snapshot_json FROM plan_revision WHERE plan_id=? ORDER BY revision_number DESC LIMIT 1",
      [planId],
    );
    const accepted = new Set(
      revision === undefined
        ? []
        : PlanCreationDraftSchema.parse(
            JSON.parse(z.string().parse(revision.snapshot_json)),
          ).supportingEvents.flatMap((event) =>
            event.source.kind === "synced" ? [event.source.providerId] : [],
          ),
    );
    return sources
      .filter((source) => !accepted.has(source.providerId))
      .map(({ providerId, name, date, category }) => ({
        providerId,
        name,
        date,
        category,
        sourceLabel: "Intervals.icu event",
      }));
  };
  return {
    async "plan.list"(request) {
      ListPlansParamsSchema.parse(request);
      const legacy = await legacyPlan();
      const sources = calendarConnected() ? await input.eventSources.read() : [];
      return input.store.transaction(async () => {
        const transactionStore = {
          exec: (sql: string) => input.store.exec(sql),
          get: input.store.get.bind(input.store),
          all: input.store.all.bind(input.store),
          run: input.store.run.bind(input.store),
          close: () => input.store.close(),
          transaction: async <T>(run: () => Promise<T>): Promise<T> => run(),
        };
        await createPlanLifecycleRepository(transactionStore, {
          newId: () => input.identity.newUlid(),
        }).completeExpired({ todayDateKey: todayDateKey(), nowMs: now() });
        const planChanges = createPlanChangeRepository(transactionStore, {
          newId: () => input.identity.newUlid(),
          sha256: async (text) => {
            const digest = await input.crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(text),
            );
            return [...new Uint8Array(digest)]
              .map((byte) => byte.toString(16).padStart(2, "0"))
              .join("");
          },
        });
        const creation = await input.repository.readUnfinished();
        const records = await plans.listPlans();
        const reconciliation = createPlanReconciliationRepository(transactionStore);
        const jobs = new Map(
          (await reconciliation.readLatestJobsForLibrary()).map((job) => [
            `${job.planId}:${job.kind}`,
            job,
          ]),
        );
        const summaries = records.map((plan) => ({
          ...summarizePlan(plan),
          calendar: summarizeCalendar(
            jobs.get(`${plan.planId}:${plan.status === "active" ? "mirror" : "cleanup"}`),
          ),
        }));
        const active = summaries.find((plan) => plan.status === "active") ?? null;
        const choiceDateKey = todayDateKey();
        const activeRevision =
          active === null
            ? undefined
            : await transactionStore.get(
                `SELECT revision.snapshot_json FROM planning_plan plan
          JOIN plan_revision revision ON revision.plan_id=plan.plan_id AND revision.revision_number=plan.current_revision_number
          WHERE plan.plan_id=?`,
                [active.planId],
              );
        const activeDraft =
          activeRevision === undefined
            ? null
            : PlanCreationDraftSchema.safeParse(
                JSON.parse(z.string().parse(activeRevision.snapshot_json)),
              );
        const todayChoice = !activeDraft?.success
          ? null
          : projectTodayChoice(
              activeDraft.data,
              choiceDateKey,
              await readClosedPlanOccupiesToday(transactionStore, choiceDateKey),
            );
        return ListPlansResultSchema.parse({
          calendarConnected: calendarConnected(),
          legacy,
          creation:
            creation === undefined ? null : projectPlanCreationCard(creation, { today: today() }),
          active:
            active === null
              ? null
              : {
                  ...active,
                  todayChoice,
                  supportingEventCandidates: await supportingEventCandidates(
                    active.planId,
                    sources,
                  ),
                },
          changesPaused:
            active === null
              ? null
              : await readPlanChangesPaused({
                  calendarConnected: async () => calendarConnected(),
                  syncStatus: () =>
                    createPlanWorkoutMatchRepository(transactionStore).readSyncStatus(),
                  now,
                }),
          changes:
            active === null
              ? []
              : await projectPlanChanges({
                  repository: planChanges,
                  store: transactionStore,
                  planId: active.planId,
                  todayDateKey: todayDateKey(),
                }),
          closed: summaries.filter((plan) => plan.status === "closed"),
        });
      });
    },
    async "plan.close"(request) {
      const parsed = PlanCloseRpcParamsSchema.parse(request);
      const command = await stamp(parsed.commandId, await requestDigest(input.crypto, parsed));
      return PlanCloseResultSchema.parse(
        await lifecycle.close({
          command,
          planId: parsed.planId,
          expectedVersion: parsed.expectedVersion,
          closedAtMs: now(),
          todayDateKey: todayDateKey(),
          cleanupJobId: input.identity.newUlid(),
        }),
      );
    },
    async "plan.history"(request) {
      const parsed = PlanHistoryParamsSchema.parse(request);
      return input.store.transaction(async () => {
        const transactionStore = {
          exec: (sql: string) => input.store.exec(sql),
          get: input.store.get.bind(input.store),
          all: input.store.all.bind(input.store),
          run: input.store.run.bind(input.store),
          close: () => input.store.close(),
          transaction: async <T>(run: () => Promise<T>): Promise<T> => run(),
        };
        const detail = await createPlanLifecycleRepository(transactionStore, {
          newId: () => input.identity.newUlid(),
        }).readClosedDetail(parsed.planId);
        return PlanHistoryResultSchema.parse(
          detail === null
            ? null
            : {
                ...detail,
                plan: {
                  ...summarizePlan(detail.plan),
                  calendar: summarizeCalendar(
                    await createPlanReconciliationRepository(
                      transactionStore,
                    ).readLatestJobByWindow(detail.plan.planId, "cleanup"),
                  ),
                },
              },
        );
      });
    },
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
              ? await project(result.snapshot)
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
    async "plan_creation.answer"(request) {
      const parsed = PlanCreationAnswerRpcParamsSchema.parse(request);
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
          planCreation:
            answer?.kind === "commitments" && answer.commitments.kind === "interpreted"
              ? {
                  ...(await project(snapshot)),
                  pendingCommitment: {
                    text: answer.commitments.text,
                    ...validateCommitmentInterpretation(answer.commitments.text),
                  },
                }
              : await project(snapshot),
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
          planCreation: await project(result.snapshot),
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
            planCreation: projectPlanCreationCard(replayed, context),
          });
        }
        const snapshot = await input.repository.readUnfinished();
        if (snapshot === undefined || snapshot.id !== parsed.creationId) {
          return PlanCreationPreviewRpcResultSchema.parse({
            status: "rejected",
            reason: "no-unfinished-creation",
            planCreation:
              snapshot === undefined ? null : projectPlanCreationCard(snapshot, { today: today() }),
          });
        }
        if (snapshot.version !== parsed.expectedVersion) {
          return PlanCreationPreviewRpcResultSchema.parse({
            status: "rejected",
            reason: "stale-version",
            planCreation: projectPlanCreationCard(snapshot, { today: today() }),
          });
        }
        if (pendingPlanCreationCommitment(snapshot) !== null) {
          return PlanCreationPreviewRpcResultSchema.parse({
            status: "rejected",
            reason: "commitments-pending",
            explanation: "Clarify or cancel the pending commitment correction.",
            planCreation: projectPlanCreationCard(snapshot, { today: today() }),
          });
        }
        const answers = resolvePlanCreationDraftAnswers(snapshot);
        if (answers === null) {
          return PlanCreationPreviewRpcResultSchema.parse({
            status: "rejected",
            reason: "not-ready",
            planCreation: projectPlanCreationCard(snapshot, { today: today() }),
          });
        }
        const buildInput = { answers, today: today(), ftp: null } as const;
        const built = buildCreationDraft(buildInput);
        if (built.kind === "no-workouts") {
          return PlanCreationPreviewRpcResultSchema.parse({
            status: "rejected",
            reason: "no-workouts",
            explanation: built.explanation,
            planCreation: projectPlanCreationCard(snapshot, { today: buildInput.today }),
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
          planCreation: projectPlanCreationCard(result.snapshot, { today: buildInput.today }),
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
          cleanupJobId: input.identity.newUlid(),
          revisionId: input.identity.newUlid(),
          isDraftCurrent(snapshot) {
            if (pendingPlanCreationCommitment(snapshot) !== null)
              throw new PlanCreationStoreError("commitments-pending");
            return isPlanCreationDraftCurrent(snapshot);
          },
          materialize(snapshot) {
            if (
              snapshot.currentDraft === null ||
              resolvePlanCreationDraftAnswers(snapshot) === null
            )
              throw new PlanCreationStoreError("not-ready");
            if (pendingPlanCreationCommitment(snapshot) !== null)
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
              pendingPlanCreationCommitment(snapshot) !== null
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
  };
}
