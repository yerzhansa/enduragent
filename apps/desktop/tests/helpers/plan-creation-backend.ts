import { ScriptedAnswerChecker } from "./answer-check-translator.js";
import {
  ListPlansParamsSchema,
  PlanCloseRpcParamsSchema,
  PlanHistoryParamsSchema,
  PlanCreationDraftSchema,
  PlanChangePreviewRpcParamsSchema,
  PlanChangeApplyRpcParamsSchema,
  type SupportingEvent,
  type PlanChangeApplyRpcParams,
  type PlanChangeApplyResult,
  type PlanChangePreviewRpcParams,
  type PlanCreationAnswerInput,
  PlanCreationActivateRpcParamsSchema,
  PlanCreationPreviewRpcParamsSchema,
  type CoachEngine,
  type LegacyPlanSummary,
  type PlanningOperations,
  type PlanCreationCardModel,
} from "@enduragent/coach-contract";
import {
  createPlanCreationRepository,
  type PlanCreationRepository,
} from "@enduragent/kernel/planning";
import type { PlanMirrorCalendarPort } from "@enduragent/engine";
import { createCyclingPlanFtpAdapter } from "@enduragent/sport-cycling";
import {
  createPlanCalendarDrain,
  type PlanCalendarDrain,
} from "../../../../packages/coach/src/plan-calendar-drain.js";
import { runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { inertWriterProtocolListener } from "@enduragent/kernel-node/lock";
import { createPlanningOperations } from "../../../../packages/coach/src/planning-operations.js";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import {
  createPlanCreationOperations,
  type PlanCreationHost,
} from "../../../../packages/coach/src/plan-creation-operations.js";
import { createPlanChangeOperations } from "../../../../packages/coach/src/plan-change-operations.js";
import { createPlanChangeEventSourceReader } from "../../../../packages/coach/src/plan-change-event-source-reader.js";
import type { DesktopFixtureScript } from "./desktop-fixture.js";
import { createPlanQaFixtureScript } from "./plan-qa-live.js";
import {
  createPlanInspectionFixtureScript,
  PLAN_INSPECTION_TURNS,
} from "./plan-inspection-live.js";

const emptyAttachmentComposer = {
  schemaVersion: 1,
  capabilities: {
    schemaVersion: 1,
    active: { provider: "test", model: "text-only", transport: "test" },
    documents: { enabled: true, extensions: ["pdf", "txt", "csv", "docx"] },
    completedActivities: { enabled: true, extensions: ["fit", "tcx", "gpx"] },
    plannedWorkouts: { enabled: true, extensions: ["zwo", "erg", "mrc"] },
    images: {
      enabled: false,
      mediaTypes: [],
      reason: "model_incompatible",
      source: "maintained_catalogue",
      checkedAt: "1998-09-02T00:00:00.000Z",
    },
  },
  draft: null,
} as const;

interface ScriptRequest {
  readonly method: string;
  readonly params: unknown;
}

interface QueuedMessage {
  readonly queuedMessageId: string;
  readonly messageId: string;
  readonly submissionId: string;
  readonly attachmentIds: readonly string[];
  readonly text: string;
  readonly kind: "ordinary" | "slash-command";
  readonly position: number;
  readonly restored: false;
}

interface TranscriptTurn {
  readonly turnId: string;
  readonly completedAt: string;
  readonly athleteText: string;
  readonly coachText: string;
}

const ordinaryCoachReply = "Keep the effort conversational and finish feeling fresh.";
const completedAt = "1998-09-02T00:00:00.000Z";
const fixtureId = (value: string) => `${"0".repeat(26 - value.length)}${value}`;
const activePlanId = fixtureId("A");
const closedPlanId = fixtureId("B");
const pastChats = [
  {
    boundaryRef: "a".repeat(64),
    boundaryAt: "1998-08-01T00:00:00.000Z",
    reason: "explicit-reset" as const,
    turnCount: 2,
  },
];

export interface StoredPlanCreationAnswerRow {
  readonly sequence: number;
  readonly creation_version: number;
  readonly answer_key: string;
  readonly scope: string;
  readonly value_json: string;
}

const unavailableEngineOperation = async (): Promise<never> => {
  throw new TypeError("Plan inspection does not run Coach operations");
};
const inspectionEngine: CoachEngine = {
  chat: unavailableEngineOperation,
  getCoachDecision: unavailableEngineOperation,
  answerCoachDecision: unavailableEngineOperation,
  skipCoachDecision: unavailableEngineOperation,
  resumeCoachDecision: unavailableEngineOperation,
  resetSession: unavailableEngineOperation,
  hasSession: unavailableEngineOperation,
  getAthleteState: unavailableEngineOperation,
};

const response = (value: unknown): readonly string[] => [JSON.stringify(value)];

export class PlanCreationBackend {
  readonly script: DesktopFixtureScript;
  readonly creationRequests: ScriptRequest[] = [];
  readonly checker = new ScriptedAnswerChecker(() => this.civilDate);
  readonly closeRequests: ScriptRequest[] = [];
  readonly changeApplyResponses: {
    readonly params: PlanChangeApplyRpcParams;
    readonly result: PlanChangeApplyResult;
  }[] = [];
  readonly planListRequests: ScriptRequest[] = [];
  private store: (SqlStore & MigratorStore) | undefined;
  private repository: PlanCreationRepository | undefined;
  private host: PlanCreationHost | undefined;
  private changes: ReturnType<typeof createPlanChangeOperations> | undefined;
  private planning: PlanningOperations | undefined;
  private calendarDrain: PlanCalendarDrain | undefined;
  planStateReadFails = false;
  planListReadFails = false;
  private sequence = 0;
  private instant = 883_612_800_000;
  private civilDate = "1998-01-01";
  private closeFails = false;
  private queueRevision = 0;
  private queue: QueuedMessage[] = [];
  private transcript: TranscriptTurn[] = [];
  private syncedEventCandidate = {
    id: 17,
    name: "Local supporting ride",
    start_date_local: "1998-01-10T09:00:00",
    category: "RACE_B",
  };

  setSyncedEventCandidate(candidate: Partial<typeof this.syncedEventCandidate>): void {
    this.syncedEventCandidate = { ...this.syncedEventCandidate, ...candidate };
  }

  async readSyncedEventCandidates() {
    return createPlanChangeEventSourceReader({
      calendarConnected: () => this.options.calendarConnected ?? Boolean(this.options.calendar),
      readLatest: () => ({ planned_workouts: [this.syncedEventCandidate] }),
    }).read();
  }

  constructor(
    private readonly databasePath: string,
    coexistence = false,
    readStoredPlans = false,
    private readonly options: {
      readonly calendar?: PlanMirrorCalendarPort;
      readonly calendarConnected?: boolean;
      readonly legacy?: LegacyPlanSummary | null;
    } = {},
  ) {
    const base = coexistence ? createPlanInspectionFixtureScript() : createPlanQaFixtureScript();
    this.script = {
      onStreamRequest: async (value, emitFrame) => {
        const request = value as ScriptRequest;
        if (request.method === "plan_creation.answer") {
          this.creationRequests.push(request);
          return JSON.stringify(
            await this.requireHost()["plan_creation.answer"](
              request.params as Parameters<PlanCreationHost["plan_creation.answer"]>[0],
              (event) => emitFrame(JSON.stringify({ event })),
            ),
          );
        }
        if (request.method === "plan_change.preview") {
          this.creationRequests.push(request);
          if (this.changes === undefined)
            throw new TypeError("Plan Change operations are unavailable");
          return JSON.stringify(
            await this.changes["plan_change.preview"](
              PlanChangePreviewRpcParamsSchema.parse(request.params),
              (event) => emitFrame(JSON.stringify({ event })),
            ),
          );
        }
        if (base.onStreamRequest !== undefined) return base.onStreamRequest(value, emitFrame);
        const frames = await this.script.onRequest(value);
        for (const frame of frames.slice(0, -1)) emitFrame(frame);
        return frames.at(-1) ?? "null";
      },
      onRequest: async (value) => {
        const request = value as ScriptRequest;
        if (request.method.startsWith("plan_creation.")) this.creationRequests.push(request);
        if (request.method.startsWith("plan_change.")) this.creationRequests.push(request);
        if (coexistence && request.method === "listArchivedConversations") {
          return response({
            schemaVersion: 1,
            conversations: [
              {
                boundaryRef: "b".repeat(64),
                boundaryAt: "1998-08-25T08:00:00.000Z",
                reason: "explicit-reset",
                turnCount: 2,
              },
            ],
            truncated: false,
          });
        }
        if (coexistence && request.method === "getArchivedTranscriptPage") {
          return response({
            schemaVersion: 1,
            status: "page",
            turns: PLAN_INSPECTION_TURNS,
            nextCursor: null,
          });
        }
        if (coexistence && request.method === "getRuntimeConfig") {
          const frames = await base.onRequest(value);
          const config = JSON.parse(frames[0] ?? "null");
          return response({
            ...config,
            intervals: {
              ...config.intervals,
              credential_configured:
                this.options.calendarConnected ?? Boolean(this.options.calendar),
            },
          });
        }
        if (
          request.method === "getChatAttachmentComposer" ||
          (!coexistence && request.method === "saveChatAttachmentDraftText") ||
          request.method === "removeChatAttachment" ||
          request.method === "retryChatAttachment" ||
          request.method === "selectChatAttachmentWorkout" ||
          request.method === "clearChatAttachmentDraft"
        ) {
          return response(emptyAttachmentComposer);
        }
        if (!coexistence && request.method === "getChatQueue")
          return response(this.queueSnapshot());
        if (!coexistence && request.method === "enqueueChatMessage")
          return response(this.enqueue(request.params));
        if (!coexistence && request.method === "resumeChatQueue") return this.runScriptedCoach();
        if (!coexistence && request.method === "getTranscriptPage") {
          return response({
            schemaVersion: 1,
            status: "page",
            turns: this.transcript,
            nextCursor: null,
          });
        }
        if (request.method === "listArchivedConversations") {
          return response({ schemaVersion: 1, conversations: pastChats, truncated: false });
        }
        if (request.method === "resumePlanningRequests") return response({ deliveries: [] });
        if (request.method === "listPlanningRequests") {
          return response({ deliveries: [], planCreation: await this.requireHost().readCard() });
        }
        if (
          this.planStateReadFails &&
          (request.method === "getPlanState" || request.method === "getPlanningReadModel")
        ) {
          return response({
            status: "failed",
            error: {
              code: "unavailable",
              message: "Activation could not be saved locally. Your previous Plan is unchanged.",
              retryable: true,
            },
          });
        }
        if (readStoredPlans && request.method === "getPlanState") {
          return response(await this.planState());
        }
        if (request.method === "plan.list") {
          this.planListRequests.push(request);
          if (this.planListReadFails) throw new Error("Synthetic Plan library read failure");
          return response(
            await this.requireHost()["plan.list"](ListPlansParamsSchema.parse(request.params)),
          );
        }
        if (request.method === "plan.close") {
          this.closeRequests.push(request);
          const fail = this.closeFails;
          this.closeFails = false;
          if (fail) {
            await this.requireStore()
              .run(`CREATE TEMP TRIGGER reject_close BEFORE INSERT ON planning_command
WHEN NEW.command_name='plan.close'
BEGIN SELECT RAISE(ABORT, 'Synthetic close ledger failure'); END`);
          }
          try {
            return response(
              await this.requireHost()["plan.close"](
                PlanCloseRpcParamsSchema.parse(request.params),
              ),
            );
          } finally {
            if (fail) await this.requireStore().run("DROP TRIGGER reject_close");
          }
        }
        if (request.method === "plan.history") {
          return response(
            await this.requireHost()["plan.history"](PlanHistoryParamsSchema.parse(request.params)),
          );
        }
        if (request.method === "plan_change.preview") {
          if (!this.changes) throw new TypeError("Plan Change operations are unavailable");
          return response(
            await this.changes["plan_change.preview"](
              PlanChangePreviewRpcParamsSchema.parse(request.params),
            ),
          );
        }
        if (request.method === "plan_change.apply") {
          if (!this.changes) throw new TypeError("Plan Change operations are unavailable");
          const params = PlanChangeApplyRpcParamsSchema.parse(request.params);
          const result = await this.changes["plan_change.apply"](params);
          this.changeApplyResponses.push({ params, result });
          return response(result);
        }
        if (request.method === "plan_creation.activate") {
          return response(
            await this.requireHost()["plan_creation.activate"](
              PlanCreationActivateRpcParamsSchema.parse(request.params),
            ),
          );
        }
        if (request.method === "plan_creation.start") {
          return response(
            await this.requireHost()["plan_creation.start"](
              request.params as Parameters<PlanCreationHost["plan_creation.start"]>[0],
            ),
          );
        }
        if (request.method === "plan_creation.answer") {
          return response(
            await this.requireHost()["plan_creation.answer"](
              request.params as Parameters<PlanCreationHost["plan_creation.answer"]>[0],
            ),
          );
        }
        if (request.method === "plan_creation.preview") {
          return response(
            await this.requireHost()["plan_creation.preview"](
              PlanCreationPreviewRpcParamsSchema.parse(request.params),
            ),
          );
        }
        if (request.method === "plan_creation.discard") {
          return response(
            await this.requireHost()["plan_creation.discard"](
              request.params as Parameters<PlanCreationHost["plan_creation.discard"]>[0],
            ),
          );
        }
        return base.onRequest(value);
      },
    };
  }

  async open(): Promise<void> {
    this.store = openSqliteStorage(this.databasePath);
    await runMigrations(this.store, MIGRATIONS);
    this.repository = createPlanCreationRepository(this.store);
    const identity = {
      deviceId: async () => "fixture-device",
      newUlid: () => `${++this.sequence}`.padStart(26, "0"),
      hlcStamp: () => ({ physicalMs: this.instant++, counter: 0 }),
    };
    this.planning = createPlanningOperations(
      {
        context: {
          store: this.store,
          home: {
            root: "/synthetic/athlete",
            storeDir: "/synthetic/athlete/store",
            archiveDir: "/synthetic/athlete/archive",
            configDir: "/synthetic/athlete/config",
          },
          listener: inertWriterProtocolListener,
        },
        identity,
        engine: inspectionEngine,
      },
      { todayDateKey: () => Number(this.civilDate.replaceAll("-", "")) },
    );
    const calendarConnected = () =>
      this.options.calendarConnected ?? Boolean(this.options.calendar);
    const readFtpAnchor = async (confidence: "manual" | "platform") => {
      const row = await this.requireStore().get(
        "SELECT value, valid_from FROM anchor_history WHERE sport = 'cycling' AND anchor_type = 'ftp' AND confidence = ? AND source = ? ORDER BY valid_from DESC, id DESC LIMIT 1",
        [confidence, confidence === "manual" ? "athlete" : "intervals-icu"],
      );
      return typeof row?.value === "number" && typeof row.valid_from === "number"
        ? { watts: row.value, refreshedAtMs: row.valid_from * 1_000 }
        : null;
    };
    const ftp = createCyclingPlanFtpAdapter({
      readManual: () => readFtpAnchor("manual"),
      readIntervalsFtp: () => readFtpAnchor("platform"),
      readIntervalsEftp: async () => null,
      saveManual: async (watts) => {
        const stamp = identity.hlcStamp();
        await this.requireStore().run(
          "INSERT INTO anchor_history (id, sport, anchor_type, value, unit, valid_from, source, confidence, note, provenance, device_id, hlc_physical_ms, hlc_counter) VALUES (?, 'cycling', 'ftp', ?, 'W', ?, 'athlete', 'manual', NULL, 'manual', 'fixture-device', ?, 0)",
          [identity.newUlid(), watts, Math.floor(stamp.physicalMs / 1_000), stamp.physicalMs],
        );
      },
      refreshIntervals: async () => {},
    });
    this.changes = createPlanChangeOperations({
      translator: this.checker,
      ftp,
      eventSources: { read: () => this.readSyncedEventCandidates() },
      logger: { warn: () => {} },
      store: this.store,
      identity,
      crypto: globalThis.crypto,
      todayDateKey: () =>
        this.options.calendar === undefined ? 19980101 : Number(this.civilDate.replaceAll("-", "")),
      now: () => this.instant,
      calendarConnected: async () => calendarConnected(),
    });
    this.host = createPlanCreationOperations({
      translator: this.checker,
      store: this.store,
      repository: this.repository,
      identity,
      crypto: globalThis.crypto,
      eventCandidates: { read: async () => [] },
      eventSources: { read: () => this.readSyncedEventCandidates() },
      legacyPlan: async () => this.options.legacy ?? null,
      calendarConnected,
      today: () => this.civilDate,
      todayDateKey: () => Number(this.civilDate.replaceAll("-", "")),
      now: () => this.instant,
    });
    await this.changes.ready();
    await this.host.ready();
    if (this.options.calendar !== undefined) {
      const drain = createPlanCalendarDrain({
        store: this.store,
        calendar: this.options.calendar,
        calendarConnected,
        identity,
        todayDateKey: () => Number(this.civilDate.replaceAll("-", "")),
        now: () => this.instant,
        logger: { warn: () => {} },
      });
      this.calendarDrain = drain;
      const host = this.host;
      this.host = {
        ...host,
        "plan_creation.activate": async (input) => {
          const result = await host["plan_creation.activate"](input);
          void drain.kick();
          return result;
        },
        "plan.close": async (input) => {
          const result = await host["plan.close"](input);
          void drain.kick();
          return result;
        },
        "plan.list": async (input) => {
          const result = await host["plan.list"](input);
          void drain.kick();
          return result;
        },
      };
      const changes = this.changes;
      this.changes = {
        ...changes,
        "plan_change.apply": async (input) => {
          const result = await changes["plan_change.apply"](input);
          void drain.kick();
          return result;
        },
      };
    }
  }

  async calendarIdle(): Promise<void> {
    await this.calendarDrain?.idle();
  }

  setCivilDate(date: string): void {
    this.civilDate = date;
    this.instant = Date.parse(`${date}T00:00:00.000Z`);
  }

  setSyncClock(nowMs: number): void {
    this.instant = nowMs;
  }

  async recordSuccessfulSync(atMs = this.instant): Promise<void> {
    const epochSeconds = Math.floor(atMs / 1_000);
    await this.requireStore().run(
      `INSERT INTO source_artifact (
        artifact_key, source, lane, external_id, artifact_kind,
        archive_address, archive_rel_path, archive_epoch_s
      ) VALUES (?, 'intervals-icu', 'activities', 'synthetic-sync', 'snapshot', ?, ?, ?)
      ON CONFLICT DO NOTHING`,
      [
        `synthetic-sync-${epochSeconds}`,
        "a".repeat(64),
        `synthetic/activities/${epochSeconds}.json`,
        epochSeconds,
      ],
    );
  }

  failNextClose(): void {
    this.closeFails = true;
  }

  async bumpActivePlanVersion(): Promise<void> {
    await this.requireStore().run("UPDATE planning_plan SET version=version+1 WHERE plan_id=?", [
      activePlanId,
    ]);
  }

  async reopen(): Promise<void> {
    await this.close();
    await this.open();
    void this.calendarDrain?.kick({ reclaimRunning: true });
  }

  async crash(): Promise<void> {
    void this.calendarDrain?.idle().catch(() => {});
    this.calendarDrain = undefined;
    await this.store?.close();
    this.store = undefined;
    this.repository = undefined;
    this.host = undefined;
    this.changes = undefined;
    this.planning = undefined;
  }

  async close(): Promise<void> {
    await this.calendarIdle();
    this.calendarDrain = undefined;
    await this.store?.close();
    this.store = undefined;
    this.repository = undefined;
    this.host = undefined;
    this.changes = undefined;
    this.planning = undefined;
  }

  async card(): Promise<PlanCreationCardModel | null> {
    return this.requireHost().readCard();
  }

  async planState() {
    if (this.planning?.getPlanState === undefined)
      throw new TypeError("Plan inspection is unavailable");
    return this.planning.getPlanState({});
  }

  async library() {
    return this.requireHost()["plan.list"]({});
  }

  async seedTrainingCreation(
    commitments: Extract<PlanCreationAnswerInput, { kind: "commitments" }>["commitments"] = {
      kind: "none",
    },
    goal: Extract<PlanCreationAnswerInput, { kind: "goal" }>["goal"] = { kind: "fitness" },
    mode: Extract<PlanCreationAnswerInput, { kind: "schedule-mode" }>["mode"] = "fixed",
  ): Promise<PlanCreationCardModel> {
    const host = this.requireHost();
    if (goal.kind === "event-manual")
      this.checker.results.set(goal.name, {
        outcome: "understood",
        title: "Did I read this right?",
        body: "Confirm this event before I use it in your plan.",
        value: { name: goal.name, date: goal.date },
      });
    const started = await host["plan_creation.start"]({ commandId: "seed-training-start" });
    if (started.status !== "started") throw new TypeError("Training seed was not started");
    let card = started.planCreation;
    const answers: PlanCreationAnswerInput[] = [
      { kind: "goal", goal },
      ...(goal.kind === "fitness"
        ? [{ kind: "plan-length", weeks: 4 } satisfies PlanCreationAnswerInput]
        : []),
      { kind: "schedule-mode", mode },
      mode === "fixed"
        ? {
            kind: "availability",
            mode,
            weeklyHoursLimit: 6,
            longestWorkoutHours: 2,
            usableWeekdays: [1, 3, 6],
          }
        : {
            kind: "availability",
            mode,
            weeklyHoursLimit: 6,
            longestWorkoutHours: 2,
          },
      { kind: "start-timing", timing: { kind: "as-soon-as-possible" } },
      {
        kind: "commitments",
        commitments,
      },
      { kind: "baseline", baseline: "regular" },
      { kind: "success", success: { kind: "authored", text: "Ride four steady hours" } },
      { kind: "restriction", restriction: { kind: "none" } },
    ];
    for (const [index, answer] of answers.entries()) {
      const answered = await host["plan_creation.answer"]({
        commandId: `seed-training-answer-${index}`,
        creationId: card.creationId,
        expectedVersion: card.version,
        answer,
      });
      if (answered.status !== "answered") throw new TypeError("Training seed answer was rejected");
      card = answered.planCreation;
      if (
        card.pendingCheck?.state === "ready" &&
        card.pendingCheck.result.outcome === "understood"
      ) {
        const confirmed = await host["plan_creation.answer"]({
          commandId: `seed-training-confirm-${index}`,
          creationId: card.creationId,
          expectedVersion: card.version,
          answer: { kind: "check-action", checkId: card.pendingCheck.checkId, action: "confirm" },
        });
        if (confirmed.status !== "answered")
          throw new TypeError("Training seed confirmation was rejected");
        card = confirmed.planCreation;
      }
    }
    return card;
  }

  async seedLegacyCommitments(text: string): Promise<void> {
    const card = await this.requireHost().readCard();
    if (card === null || this.repository === undefined)
      throw new TypeError("Creation is unavailable");
    const stamp = this.instant++;
    await this.repository.recordAnswer({
      command: {
        commandId: `legacy-commitments-${++this.sequence}`,
        requestDigest: "a".repeat(64),
        nowMs: stamp,
        deviceId: "fixture-device",
        hlcPhysicalMs: stamp,
        hlcCounter: 0,
      },
      creationId: card.creationId,
      expectedVersion: card.version,
      answerId: `${++this.sequence}`.padStart(26, "0"),
      answerKey: "commitments",
      valueJson: JSON.stringify({
        answer: {
          kind: "commitments",
          commitments: { kind: "interpreted", text, rules: [], status: "clarify" },
        },
        source: { kind: "athlete" },
      }),
    });
  }

  async seedActiveTraining(
    options: {
      readonly goal?: "fitness" | "event";
      readonly mode?: Extract<PlanCreationAnswerInput, { kind: "schedule-mode" }>["mode"];
    } = {},
  ) {
    const host = this.requireHost();
    await this.requireStore().run(
      "INSERT INTO anchor_history (id, sport, anchor_type, value, unit, valid_from, source, confidence, note, provenance, device_id, hlc_physical_ms, hlc_counter) VALUES (?, 'cycling', 'ftp', 210, 'W', 883612800, 'intervals-icu', 'platform', NULL, 'sync', 'fixture-device', 883612800000, 0)",
      [fixtureId("FTP")],
    );
    const card = await this.seedTrainingCreation(
      { kind: "none" },
      options.goal === "event"
        ? {
            kind: "event-manual",
            name: "Local cycling event",
            date: new Date(Date.parse(`${this.civilDate}T00:00:00.000Z`) + 6 * 86_400_000)
              .toISOString()
              .slice(0, 10),
          }
        : { kind: "fitness" },
      options.mode,
    );
    const previewed = await host["plan_creation.preview"]({
      commandId: "seed-training-preview",
      creationId: card.creationId,
      expectedVersion: card.version,
    });
    if (previewed.status !== "previewed" || previewed.planCreation.draft === null)
      throw new TypeError("Training seed Draft is unavailable");
    const activated = await host["plan_creation.activate"]({
      commandId: "seed-training-activate",
      incumbent: null,
      creationId: card.creationId,
      expectedVersion: previewed.planCreation.version,
    });
    return { planId: activated.planId, draft: previewed.planCreation.draft };
  }

  async seedActiveTrainingWithManualEvent(
    event: { name?: string; date?: string; role?: SupportingEvent["role"] } = {},
  ) {
    const active = await this.seedActiveTraining();
    if (active.planId === null) throw new TypeError("Training Plan was not activated");
    const date =
      event.date ??
      active.draft.weeks.flatMap((week) => week.workouts).find((workout) => workout.date !== null)
        ?.date;
    if (date === null || date === undefined) throw new TypeError("Training seed has no event date");
    const preview = await this.previewChange({
      commandId: "seed-manual-event-preview",
      planId: active.planId,
      expectedVersion: 1,
      intent: {
        kind: "supporting-event",
        operation: "add",
        name: event.name ?? "Local supporting ride",
        date,
        role: event.role ?? "Training",
      },
    });
    if (preview.status !== "previewed")
      throw new TypeError(
        `Event seed was rejected: ${preview.status === "rejected" ? preview.reason : preview.status}`,
      );
    const applied = await this.applyChange({
      commandId: "seed-manual-event-apply",
      planId: active.planId,
      changeId: preview.change.changeId,
      expectedVersion: 1,
      decision: "apply",
    });
    if (applied.status !== "applied") throw new TypeError("Event seed was not applied");
    const revision = await this.requireStore().get(
      "SELECT snapshot_json FROM plan_revision WHERE plan_id=? ORDER BY revision_number DESC LIMIT 1",
      [active.planId],
    );
    if (typeof revision?.snapshot_json !== "string")
      throw new TypeError("Event revision is unavailable");
    return {
      planId: active.planId,
      draft: PlanCreationDraftSchema.parse(JSON.parse(revision.snapshot_json)),
    };
  }

  async previewChange(params: PlanChangePreviewRpcParams) {
    if (!this.changes) throw new TypeError("Plan Change operations are unavailable");
    return this.changes["plan_change.preview"](params);
  }

  async applyChange(params: PlanChangeApplyRpcParams) {
    if (!this.changes) throw new TypeError("Plan Change operations are unavailable");
    return this.changes["plan_change.apply"](params);
  }

  async seedLibrary(presence: {
    readonly creation: boolean;
    readonly active: boolean;
    readonly closed: boolean;
  }): Promise<void> {
    const store = this.requireStore();
    const insertPlan = async (plan: {
      readonly id: string;
      readonly name: string;
      readonly start: number;
      readonly end: number;
      readonly weekStartDay: number;
      readonly closedAt: number | null;
      readonly reason: "stopped" | "completed" | "legacy-unclassified" | null;
    }) => {
      const updatedAt = plan.closedAt ?? 883_612_800_000;
      await store.run(
        `INSERT INTO plan (
id,origin_id,name,primary_goal,start_date_key,target_date_key,status,kind,total_weeks,
week_start_day,structure_json,created_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter
) VALUES (?,NULL,?,'Improve fitness',?,?,?,'short_race_preparation',4,?,'{}',850000000000,?,'fixture-device',?,0)`,
        [
          plan.id,
          plan.name,
          plan.start,
          plan.end,
          plan.closedAt === null ? "active" : "ended",
          plan.weekStartDay,
          updatedAt,
          updatedAt,
        ],
      );
      await store.run(
        `INSERT INTO planning_plan (
plan_id,status,version,current_revision_number,activated_at_ms,closed_at_ms,close_reason,close_actor,
updated_at_ms,device_id,hlc_physical_ms,hlc_counter
) VALUES (?,?,1,1,850000000000,?,?,?,?,'fixture-device',?,0)`,
        [
          plan.id,
          plan.closedAt === null ? "active" : "closed",
          plan.closedAt,
          plan.reason,
          plan.reason === "completed"
            ? "system:plan-completion"
            : plan.reason === "stopped"
              ? "athlete"
              : null,
          updatedAt,
          updatedAt,
        ],
      );
      const dateText = (key: number) => String(key).replace(/^(\d{4})(\d{2})(\d{2})$/u, "$1-$2-$3");
      const start = dateText(plan.start);
      const end = dateText(plan.end);
      const day = (offset: number) =>
        new Date(Date.parse(`${start}T00:00:00.000Z`) + offset * 86_400_000)
          .toISOString()
          .slice(0, 10);
      const snapshot = PlanCreationDraftSchema.parse({
        kind: "draft",
        answeredSummaries: [],
        goal: { kind: "fitness", weeks: 4 },
        mode: "fixed",
        start,
        end,
        spanKind: "Fitness Plan",
        computedWeeks: 4,
        weeks: Array.from({ length: 4 }, (_, index) => ({
          number: index + 1,
          start: day(index * 7),
          end: day(index * 7 + 6),
          workouts: [
            {
              id: `${plan.id}-ride-${index + 1}`,
              name: "Endurance ride",
              kind: "endurance",
              date: day(index * 7),
              minutes: 45,
              pinned: false,
              guidance: "Keep the effort conversational.",
              power: null,
            },
          ],
          notes: [],
        })),
        notes: [],
        guidance: "Build endurance steadily.",
        ftp: null,
        builderId: "fixture",
        builderVersion: "1",
        inputFingerprint: "a".repeat(64),
        outputFingerprint: "b".repeat(64),
      });
      await store.run(
        `INSERT INTO plan_revision (
id,plan_id,revision_number,parent_revision_number,source_kind,source_id,snapshot_json,
fingerprint,created_at_ms,device_id,hlc_physical_ms,hlc_counter
) VALUES (?,?,1,NULL,'migration',NULL,?,?,?,'fixture-device',?,0)`,
        [
          fixtureId(`R${plan.id.slice(-1)}`),
          plan.id,
          JSON.stringify(snapshot),
          snapshot.outputFingerprint,
          updatedAt,
          updatedAt,
        ],
      );
    };
    if (presence.active) {
      await insertPlan({
        id: activePlanId,
        name: "Active endurance Plan",
        start: 19980101,
        end: 19980128,
        weekStartDay: 4,
        closedAt: null,
        reason: null,
      });
    }
    if (presence.closed) {
      for (const plan of [
        {
          id: closedPlanId,
          name: "Closed base Plan",
          start: 19971001,
          end: 19971028,
          weekStartDay: 3,
          closedAt: 879_292_800_000,
          reason: "stopped",
        },
        {
          id: fixtureId("F"),
          name: "Earlier fitness Plan",
          start: 19970801,
          end: 19970828,
          weekStartDay: 5,
          closedAt: 873_158_400_000,
          reason: "legacy-unclassified",
        },
        {
          id: fixtureId("G"),
          name: "Recent endurance Plan",
          start: 19971101,
          end: 19971128,
          weekStartDay: 6,
          closedAt: 881_971_200_000,
          reason: "completed",
        },
      ] as const)
        await insertPlan(plan);
    }
    if (presence.creation) {
      const started = await this.requireHost()["plan_creation.start"]({
        commandId: "seed-library-creation",
      });
      if (started.status !== "started") throw new TypeError("Plan Creation seed was rejected");
      const answered = await this.requireHost()["plan_creation.answer"]({
        commandId: "seed-library-goal",
        creationId: started.planCreation.creationId,
        expectedVersion: started.planCreation.version,
        answer: { kind: "goal", goal: { kind: "fitness" } },
      });
      if (answered.status !== "answered")
        throw new TypeError("Plan Creation goal seed was rejected");
    }
  }

  async physicalWorkouts(planId: string) {
    const rows = await this.requireStore().all(
      "SELECT id,date_key,structure_json FROM plan_workout WHERE plan_id=? ORDER BY id",
      [planId],
    );
    return rows.map((row) => ({
      id: String(row.id),
      dateKey: row.date_key === null ? null : Number(row.date_key),
      structureJson: String(row.structure_json),
    }));
  }

  async inspectActivation() {
    const store = this.requireStore();
    return {
      plans: await store.all("SELECT * FROM plan ORDER BY id"),
      planningPlans: await store.all("SELECT * FROM planning_plan ORDER BY plan_id"),
      revisions: await store.all("SELECT * FROM plan_revision ORDER BY plan_id,revision_number"),
      creations: await store.all("SELECT * FROM plan_creation ORDER BY id"),
      jobs: await store.all("SELECT * FROM plan_reconciliation_job ORDER BY id"),
      changes: await store.all("SELECT * FROM plan_change ORDER BY id"),
      workouts: await store.all("SELECT * FROM plan_workout ORDER BY id"),
      commands: await store.all(
        "SELECT * FROM planning_command WHERE command_name IN ('plan_creation.activate','plan.close','plan_change.preview','plan_change.apply') ORDER BY created_at_ms,command_id",
      ),
    };
  }

  async setActivationFailure(enabled: boolean): Promise<void> {
    const store = this.requireStore();
    if (enabled) {
      await store.run(`CREATE TRIGGER reject_activation BEFORE INSERT ON planning_command
WHEN NEW.command_name='plan_creation.activate'
BEGIN SELECT RAISE(ABORT, 'Activation could not be saved locally. Your previous Plan is unchanged.'); END`);
    } else {
      await store.run("drop trigger if exists reject_activation");
    }
  }

  async answers(): Promise<readonly StoredPlanCreationAnswerRow[]> {
    return (await this.requireStore().all(
      "SELECT sequence,creation_version,answer_key,scope,value_json FROM plan_creation_answer ORDER BY sequence",
    )) as unknown as readonly StoredPlanCreationAnswerRow[];
  }

  async inspect() {
    const store = this.requireStore();
    return {
      creation: await store.get("SELECT status,version FROM plan_creation"),
      answers: await store.all(
        "SELECT sequence,creation_version,answer_key FROM plan_creation_answer ORDER BY sequence",
      ),
      commands: await store.all(
        "SELECT command_name,status FROM planning_command WHERE command_name IN ('plan_creation.start','plan_creation.answer') ORDER BY created_at_ms,command_id",
      ),
    };
  }

  async inspectDrafts() {
    const store = this.requireStore();
    return {
      creations: await store.all(
        "SELECT id,status,version,current_draft_revision_number FROM plan_creation ORDER BY created_at_ms,id",
      ),
      revisions: await store.all(
        "SELECT * FROM plan_creation_draft_revision ORDER BY creation_id,revision_number",
      ),
      commands: await store.all(
        "SELECT * FROM planning_command WHERE command_name='plan_creation.preview' ORDER BY created_at_ms,command_id",
      ),
    };
  }

  async inspectDiscard() {
    const store = this.requireStore();
    const creations = await store.all(
      "SELECT id,status,version,terminal_at_ms FROM plan_creation ORDER BY created_at_ms,id",
    );
    const answers = await store.all(
      "SELECT id,creation_id,sequence,creation_version,answer_key,value_json FROM plan_creation_answer ORDER BY creation_id,sequence,id",
    );
    return {
      commands: await store.all("SELECT * FROM planning_command ORDER BY command_name,command_id"),
      creations: creations.map((row) => ({
        id: String(row.id),
        status: String(row.status),
        version: Number(row.version),
        terminalAtMs: row.terminal_at_ms === null ? null : Number(row.terminal_at_ms),
      })),
      answers: answers.map((row) => ({
        id: String(row.id),
        creationId: String(row.creation_id),
        sequence: Number(row.sequence),
        creationVersion: Number(row.creation_version),
        answerKey: String(row.answer_key),
        valueJson: String(row.value_json),
      })),
    };
  }

  async seedUnrelatedPlans(): Promise<void> {
    const store = this.requireStore();
    const existing = await store.get("SELECT count(*) count FROM planning_plan");
    if (existing?.count === 2) return;
    if (existing?.count !== 0) throw new TypeError("Unrelated Plan fixture is incomplete");
    await store.run(
      `INSERT INTO plan (
id,origin_id,name,primary_goal,start_date_key,target_date_key,status,kind,total_weeks,
week_start_day,structure_json,created_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter
) VALUES (?,NULL,?,?,19980803,19981025,'active','full_plan',12,1,'{}',?,?,?,?,0)`,
      [
        activePlanId,
        "Active endurance Plan",
        "Complete an autumn endurance event",
        883_000_000_000,
        883_200_000_000,
        "fixture-device",
        883_200_000_000,
      ],
    );
    await store.run(
      `INSERT INTO planning_plan (
plan_id,status,version,current_revision_number,activated_at_ms,closed_at_ms,close_reason,close_actor,
updated_at_ms,device_id,hlc_physical_ms,hlc_counter
) VALUES (?,'active',1,1,883000000000,NULL,NULL,NULL,883200000000,'fixture-device',883200000000,0)`,
      [activePlanId],
    );
    await store.run(
      `INSERT INTO plan (
id,origin_id,name,primary_goal,start_date_key,target_date_key,status,kind,total_weeks,
week_start_day,structure_json,created_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter
) VALUES (?,NULL,?,?,19980406,19980628,'ended','full_plan',12,1,'{}',?,?,?,?,0)`,
      [
        closedPlanId,
        "Closed base Plan",
        "Build aerobic durability",
        875_000_000_000,
        882_000_000_000,
        "fixture-device",
        882_000_000_000,
      ],
    );
    await store.run(
      `INSERT INTO planning_plan (
plan_id,status,version,current_revision_number,activated_at_ms,closed_at_ms,close_reason,close_actor,
updated_at_ms,device_id,hlc_physical_ms,hlc_counter
) VALUES (?,'closed',2,1,875000000000,882000000000,'stopped','athlete',882000000000,'fixture-device',882000000000,0)`,
      [closedPlanId],
    );
    await store.run(`INSERT INTO planned_workout (id,date_key,sport,structure_json,provenance,device_id,hlc_physical_ms,hlc_counter)
VALUES ('0000000000000000000000000C',19980714,'cycling','{"durationMinutes":45}','manual','fixture-device',883200000000,0)`);
    await store.run(`INSERT INTO athlete_preference (id,preference_key,value_json,status,version,created_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter)
VALUES ('0000000000000000000000000D','weekly-hours','8','active',1,883200000000,883200000000,'fixture-device',883200000000,0)`);
    await store.run(`INSERT INTO training_restriction (id,kind,status,version,start_date_key,end_date_key,confirmed_at_ms,created_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter)
VALUES ('0000000000000000000000000E','no-hard-training','active',1,19980713,19980720,883200000000,883200000000,883200000000,'fixture-device',883200000000,0)`);
  }

  async inspectUnrelated() {
    const store = this.requireStore();
    return {
      plans: await store.all("SELECT * FROM plan ORDER BY id"),
      schedule: await store.all("SELECT * FROM planned_workout ORDER BY id"),
      preferences: await store.all("SELECT * FROM athlete_preference ORDER BY id"),
      restrictions: await store.all("SELECT * FROM training_restriction ORDER BY id"),
      activePlans: await store.all(
        "SELECT * FROM planning_plan WHERE status='active' ORDER BY plan_id",
      ),
      closedPlans: await store.all(
        "SELECT * FROM planning_plan WHERE status='closed' ORDER BY plan_id",
      ),
    };
  }

  private queueSnapshot() {
    return { schemaVersion: 1 as const, revision: this.queueRevision, items: this.queue };
  }

  private enqueue(value: unknown) {
    const params = value as {
      readonly submissionId: string;
      readonly text: string;
      readonly attachmentIds?: readonly string[];
    };
    if (!this.queue.some((item) => item.submissionId === params.submissionId)) {
      this.queueRevision += 1;
      this.queue.push({
        queuedMessageId: `queued-${this.queueRevision}`,
        messageId: `message-${this.queueRevision}`,
        submissionId: params.submissionId,
        attachmentIds: params.attachmentIds ?? [],
        text: params.text,
        kind: params.text.trimStart().startsWith("/") ? "slash-command" : "ordinary",
        position: this.queue.length,
        restored: false,
      });
    }
    return this.queueSnapshot();
  }

  private runScriptedCoach(): readonly string[] {
    const queued = this.queue[0];
    if (queued === undefined || this.queue.length !== 1 || queued.kind !== "ordinary") {
      throw new TypeError("Scripted Coach requires one ordinary queued message");
    }
    const turnId = `ordinary-turn-${this.transcript.length + 1}`;
    this.transcript.push({
      turnId,
      completedAt,
      athleteText: queued.text,
      coachText: ordinaryCoachReply,
    });
    this.queue = [];
    this.queueRevision += 1;
    return [
      JSON.stringify({ type: "turn-start", turnId, chatId: "desktop" }),
      JSON.stringify({ type: "text_delta", turnId, delta: ordinaryCoachReply }),
      JSON.stringify({ type: "final-text", turnId, text: ordinaryCoachReply }),
      JSON.stringify({ snapshot: this.queueSnapshot(), response: { text: ordinaryCoachReply } }),
    ];
  }

  private requireStore(): SqlStore & MigratorStore {
    if (this.store === undefined) throw new TypeError("Plan Creation store is closed");
    return this.store;
  }

  private requireHost(): PlanCreationHost {
    if (this.host === undefined) throw new TypeError("Plan Creation host is closed");
    return this.host;
  }
}
