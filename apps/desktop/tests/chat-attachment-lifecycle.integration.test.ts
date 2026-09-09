import { createServer } from "node:net";
import { copyFile, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHAT_ATTACHMENT_LIMITS,
  type AttachmentCapabilitiesReadModel,
  type ChatAttachmentReference,
  type CoachEngine,
  type TurnEvent,
} from "@enduragent/coach-contract";
import {
  Memory,
  classifyFailure,
  createConversationStore,
  createMissingPlatformCalendarMutations,
  extractRetryAfterMs,
  type ConversationStorePort,
} from "@enduragent/core";
import {
  createAttachmentCapabilityResolver,
  createCoachEngine,
  transportForProvider,
  type ChatAttachmentTurnPort,
  type EngineHostPorts,
  type ModelTransportRequest,
} from "@enduragent/engine";
import type { GenerateResult, Sport } from "@enduragent/engine/sport";
import {
  createChatAttachmentRepository,
  runMigrations,
  type ChatAttachmentRepository,
  type MigratorStore,
  type SqlStore,
} from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import {
  createManagedActivityReader,
  createManagedChatAttachmentStore,
  createManagedDocumentReader,
  createManagedMediaReader,
} from "@enduragent/kernel-node/chat-attachments";
import { createNodeImportRuntime } from "@enduragent/kernel-node/ingest";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { createManagedWorkoutReader } from "@enduragent/sport-cycling/workout-import";
import { afterEach, describe, expect, it } from "vitest";
import {
  createActivityAttachmentOperations,
  type ActivityAttachmentOperations,
} from "../../../packages/coach/src/activity-attachment-operations.js";
import {
  createAttachmentComposerOperations,
  type AttachmentComposerOperations,
} from "../../../packages/coach/src/attachment-composer-operations.js";
import {
  createManagedChatAttachmentOperations,
  type ManagedChatAttachmentOperations,
} from "../../../packages/coach/src/attachment-operations.js";
import { createDocumentMediaAttachmentOperations } from "../../../packages/coach/src/document-media-attachment-operations.js";
import {
  createWorkoutAttachmentOperations,
  type WorkoutAttachmentOperations,
} from "../../../packages/coach/src/workout-attachment-operations.js";
import {
  launchDesktopFixture,
  type DesktopFixtureScript,
  type RunningDesktopFixture,
} from "./helpers/desktop-fixture.js";
import { createPlanQaFixtureScript } from "./helpers/plan-qa-live.js";

const hasLoopback = await new Promise<boolean>((resolveAvailability) => {
  const server = createServer();
  server.once("error", () => resolveAvailability(false));
  server.listen({ host: "127.0.0.1", port: 0 }, () => {
    server.close(() => resolveAvailability(true));
  });
});

const token = "a".repeat(43);
const chatId = "desktop";
const activityName = "fallback-cycling.tcx";
const imageName = "Synthetic recovery image.png";
const imageDraftText = "Keep this recovery image for the next conversation.";
const partialText = "I imported the synthetic ride and started reviewing";
const completedText = "The synthetic ride is stored once in Training and ready for review.";
const incompatibleModel = "synthetic-text-only";
const activityFixturePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/kernel-node/tests/fixtures/ingest/fallback-cycling.tcx",
);
const imageFixturePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../resources/app-icon.png",
);
const fixtures: RunningDesktopFixture[] = [];
const backends: AttachmentLifecycleBackend[] = [];
const scratchPaths: string[] = [];
const configuredQaEvidenceDir = process.env.ENDURAGENT_VISIBLE_QA_EVIDENCE_DIR?.trim();
const qaEvidenceDir =
  configuredQaEvidenceDir === undefined || configuredQaEvidenceDir.length === 0
    ? undefined
    : resolve(configuredQaEvidenceDir);

interface ScriptRequest {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params: Record<string, unknown>;
}

function response(value: unknown): readonly string[] {
  return [JSON.stringify(value)];
}

function generated(text: string): GenerateResult {
  const usage = {
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
  };
  return { text, toolCalls: [], finishReason: "stop", usage, totalUsage: usage, steps: 1 };
}

const lifecycleSport = {
  id: "cycling",
  soul: "",
  skills: {},
  sessionClusterGapMinutes: 30,
  memorySections: [],
  mustPreserveTokens: [],
  intervalsActivityTypes: [],
  athleteProfileSchema: {},
  tools: () => [],
} as unknown as Sport;

const workoutLimits = {
  candidates: CHAT_ATTACHMENT_LIMITS.workoutCandidates,
  segmentsPerWorkout: CHAT_ATTACHMENT_LIMITS.workoutSegments,
  durationSeconds: CHAT_ATTACHMENT_LIMITS.workoutDurationSeconds,
  diagnostics: CHAT_ATTACHMENT_LIMITS.workoutDiagnostics,
  diagnosticChars: CHAT_ATTACHMENT_LIMITS.workoutDiagnosticChars,
  titleChars: CHAT_ATTACHMENT_LIMITS.workoutTitleChars,
  purposeChars: CHAT_ATTACHMENT_LIMITS.workoutPurposeChars,
} as const;

class AttachmentLifecycleBackend {
  readonly calls: ScriptRequest[] = [];
  readonly script: DesktopFixtureScript;
  coachCalls = 0;
  flushCalls = 0;
  clearCalls = 0;
  private store: (SqlStore & MigratorStore) | undefined;
  private conversation: ConversationStorePort | undefined;
  private repository: ChatAttachmentRepository | undefined;
  private attachments: ManagedChatAttachmentOperations | undefined;
  private activities: ActivityAttachmentOperations | undefined;
  private workouts: WorkoutAttachmentOperations | undefined;
  private composer: AttachmentComposerOperations | undefined;
  private chatAttachments: ChatAttachmentTurnPort | undefined;
  private capabilities: (() => Promise<AttachmentCapabilitiesReadModel>) | undefined;
  private engine: CoachEngine | undefined;
  private activeModel = "gpt-5.6-sol";
  private runtimeProvider: "codex-agent" | "openai" = "codex-agent";
  private failNextClear = false;
  private instant = Date.UTC(1998, 7, 24, 8);
  private engineIdSequence = 0;
  private attachmentIdSequence = 0;
  private lastEngineId: string | undefined;
  private activityAttachmentId: string | undefined;

  constructor(
    private readonly databasePath: string,
    private readonly conversationDir: string,
    private readonly archiveDir: string,
  ) {
    const base = createPlanQaFixtureScript("PL-S004");
    this.script = {
      onRequest: async (value) => {
        const request = value as ScriptRequest;
        this.calls.push(request);
        if (request.method === "enqueueChatMessage") {
          const operation = this.requireEngine().enqueueChatMessage;
          if (operation === undefined) throw new TypeError("queue admission is unavailable");
          return response(
            await operation({
              chatId: String(request.params.chatId),
              submissionId: String(request.params.submissionId),
              text: String(request.params.text),
              ...(Array.isArray(request.params.attachmentIds)
                ? { attachmentIds: request.params.attachmentIds.map(String) }
                : {}),
            }),
          );
        }
        if (request.method === "getChatQueue") {
          const operation = this.requireEngine().getChatQueue;
          if (operation === undefined) throw new TypeError("queue read is unavailable");
          return response(await operation({ chatId: String(request.params.chatId) }));
        }
        if (request.method === "removeQueuedChatMessage") {
          const operation = this.requireEngine().removeQueuedChatMessage;
          if (operation === undefined) throw new TypeError("queue removal is unavailable");
          return response(
            await operation({
              chatId: String(request.params.chatId),
              queuedMessageId: String(request.params.queuedMessageId),
            }),
          );
        }
        if (request.method === "resumeChatQueue") {
          const operation = this.requireEngine().resumeChatQueue;
          if (operation === undefined) throw new TypeError("queue resume is unavailable");
          return this.turnFrames((onEvent) =>
            operation({ chatId: String(request.params.chatId) }, onEvent),
          );
        }
        if (request.method === "retryQueuedTurn") {
          const operation = this.requireEngine().retryQueuedTurn;
          if (operation === undefined) throw new TypeError("queue retry is unavailable");
          return this.turnFrames((onEvent) =>
            operation(
              {
                chatId: String(request.params.chatId),
                claimId: String(request.params.claimId),
              },
              onEvent,
            ),
          );
        }
        if (request.method === "stopChat") {
          const operation = this.requireEngine().stopChat;
          if (operation === undefined) throw new TypeError("chat stop is unavailable");
          return response(
            await operation({
              chatId: String(request.params.chatId),
              turnId: String(request.params.turnId),
            }),
          );
        }
        if (request.method === "hasSession") {
          return response(await this.requireEngine().hasSession({ chatId }));
        }
        if (request.method === "resetSession") {
          return response(
            await this.requireEngine().resetSession({ chatId: String(request.params.chatId) }),
          );
        }
        if (request.method === "getCoachDecision") {
          return response(
            await this.requireEngine().getCoachDecision({
              chatId: String(request.params.chatId),
            }),
          );
        }
        if (request.method === "getTranscriptPage") {
          const cursor = request.params.cursor;
          const limit = request.params.limit;
          if ((cursor !== null && typeof cursor !== "string") || typeof limit !== "number") {
            throw new TypeError("invalid transcript page request");
          }
          return response(
            this.requireConversation().readCurrentConversationPage(chatId, { cursor, limit }),
          );
        }
        if (request.method === "getChatAttachmentComposer") {
          return response(await this.requireComposer().read(String(request.params.chatId)));
        }
        if (request.method === "saveChatAttachmentDraftText") {
          return response(
            await this.requireComposer().saveText(
              String(request.params.chatId),
              String(request.params.text),
            ),
          );
        }
        if (request.method === "removeChatAttachment") {
          return response(
            await this.requireComposer().remove(
              String(request.params.chatId),
              String(request.params.attachmentId),
            ),
          );
        }
        if (request.method === "retryChatAttachment") {
          return response(
            await this.requireComposer().retry(
              String(request.params.chatId),
              String(request.params.attachmentId),
            ),
          );
        }
        if (request.method === "selectChatAttachmentWorkout") {
          return response(
            await this.requireComposer().selectWorkout(
              String(request.params.chatId),
              String(request.params.attachmentId),
              String(request.params.workoutId),
            ),
          );
        }
        if (request.method === "clearChatAttachmentDraft") {
          this.clearCalls += 1;
          if (this.failNextClear) {
            this.failNextClear = false;
            throw new Error("synthetic draft clear uncertainty");
          }
          return response(await this.requireComposer().clear(String(request.params.chatId)));
        }
        if (request.method === "configureRuntime") {
          const llm = request.params.llm;
          if (llm === null || typeof llm !== "object" || Array.isArray(llm)) {
            throw new TypeError("invalid runtime update");
          }
          const model = (llm as Record<string, unknown>).model;
          if (typeof model === "string") this.activeModel = model;
          this.engine = this.buildEngine();
          return response({
            schemaVersion: 3,
            status: "applied",
            applied: { llm: true, intervals: false, session: false },
          });
        }
        if (request.method === "getRuntimeConfig") return response(this.runtimeConfig());
        return base.onRequest(value);
      },
    };
  }

  async open(): Promise<void> {
    await mkdir(this.archiveDir, { recursive: true, mode: 0o700 });
    await mkdir(this.conversationDir, { recursive: true, mode: 0o700 });
    const store = openSqliteStorage(this.databasePath);
    await runMigrations(store, MIGRATIONS);
    this.store = store;
    const conversation = createConversationStore(this.conversationDir);
    this.conversation = conversation;
    const repository = createChatAttachmentRepository(store);
    this.repository = repository;
    const objects = createManagedChatAttachmentStore({
      archiveDir: this.archiveDir,
      kindByteLimits: {
        document: CHAT_ATTACHMENT_LIMITS.documentBytes,
        activity: CHAT_ATTACHMENT_LIMITS.activityBytes,
        workout: CHAT_ATTACHMENT_LIMITS.workoutBytes,
        image: CHAT_ATTACHMENT_LIMITS.imageBytes,
      },
      now: () => this.now(),
    });
    const activities = createActivityAttachmentOperations({
      repository,
      reader: createManagedActivityReader({
        objects,
        limits: {
          activityBytes: CHAT_ATTACHMENT_LIMITS.activityBytes,
          parserMs: CHAT_ATTACHMENT_LIMITS.parserMs,
          parserOldGenerationMiB: CHAT_ATTACHMENT_LIMITS.parserOldGenerationMiB,
          sessions: 256,
        },
      }),
      importer: createNodeImportRuntime({ archiveDir: this.archiveDir, store }),
      store,
      runExclusive: (work) => work(),
      now: () => this.now(),
    });
    this.activities = activities;
    const workouts = createWorkoutAttachmentOperations({
      repository,
      reader: createManagedWorkoutReader({
        objects,
        limits: {
          ...workoutLimits,
          workoutBytes: CHAT_ATTACHMENT_LIMITS.workoutBytes,
          parserMs: CHAT_ATTACHMENT_LIMITS.parserMs,
          parserOldGenerationMiB: CHAT_ATTACHMENT_LIMITS.parserOldGenerationMiB,
        },
      }),
      limits: workoutLimits,
      runExclusive: (work) => work(),
      now: () => this.now(),
    });
    this.workouts = workouts;
    const documentMedia = createDocumentMediaAttachmentOperations({
      repository,
      documents: createManagedDocumentReader({
        objects,
        limits: {
          documentBytes: CHAT_ATTACHMENT_LIMITS.documentBytes,
          extractedTextChars: CHAT_ATTACHMENT_LIMITS.extractedTextChars,
          pdfPages: CHAT_ATTACHMENT_LIMITS.pdfPages,
          pdfVisualPages: CHAT_ATTACHMENT_LIMITS.pdfVisualPages,
          pdfUsefulTextCharsPerPage: CHAT_ATTACHMENT_LIMITS.pdfUsefulTextCharsPerPage,
          docxEntries: CHAT_ATTACHMENT_LIMITS.docxEntries,
          docxExpandedBytes: CHAT_ATTACHMENT_LIMITS.docxExpandedBytes,
          docxCompressionRatio: CHAT_ATTACHMENT_LIMITS.docxCompressionRatio,
          csvRows: CHAT_ATTACHMENT_LIMITS.csvRows,
          csvColumns: CHAT_ATTACHMENT_LIMITS.csvColumns,
          csvRecordChars: CHAT_ATTACHMENT_LIMITS.csvRecordChars,
          parserMs: CHAT_ATTACHMENT_LIMITS.parserMs,
          parserOldGenerationMiB: CHAT_ATTACHMENT_LIMITS.parserOldGenerationMiB,
        },
      }),
      media: createManagedMediaReader({
        objects,
        limits: {
          imageBytes: CHAT_ATTACHMENT_LIMITS.imageBytes,
          imageDimension: CHAT_ATTACHMENT_LIMITS.imageDimension,
          imagePixels: CHAT_ATTACHMENT_LIMITS.imagePixels,
          documentBytes: CHAT_ATTACHMENT_LIMITS.documentBytes,
          pdfPages: CHAT_ATTACHMENT_LIMITS.pdfPages,
          pdfVisualPages: CHAT_ATTACHMENT_LIMITS.pdfVisualPages,
          pdfVisualPixels: CHAT_ATTACHMENT_LIMITS.pdfVisualPixels,
          pdfPageDimension: CHAT_ATTACHMENT_LIMITS.pdfPageDimension,
          parserMs: CHAT_ATTACHMENT_LIMITS.parserMs,
          parserOldGenerationMiB: CHAT_ATTACHMENT_LIMITS.parserOldGenerationMiB,
        },
      }),
      runExclusive: (work) => work(),
      now: () => this.now(),
    });
    const attachments = createManagedChatAttachmentOperations({
      repository,
      objects,
      runExclusive: (work) => work(),
      now: () => this.now(),
      randomId: () => `synthetic-attachment-${++this.attachmentIdSequence}`,
      onAdmitted: async (admitted) => {
        await documentMedia.preprocessAdmitted(admitted);
        await activities.preprocessAdmitted(admitted);
        await workouts.preprocessAdmitted(admitted);
      },
    });
    this.attachments = attachments;
    await attachments.reconcile();
    const capabilityResolver = createAttachmentCapabilityResolver({
      openRouterCache: { read: async () => undefined, write: async () => {} },
      metadataMaxAgeMs: CHAT_ATTACHMENT_LIMITS.capabilityMetadataMaxAgeMs,
      now: () => this.now(),
    });
    const capabilities = () =>
      capabilityResolver.resolve({
        provider: "openai",
        model: this.activeModel,
        transport: transportForProvider("openai"),
        apiKey: "fixture",
      });
    this.capabilities = capabilities;
    this.composer = createAttachmentComposerOperations({
      repository,
      attachments,
      activities,
      workouts,
      capabilities,
    });
    const chatAttachments: ChatAttachmentTurnPort = {
      acceptQueuedMessage: async (request) => {
        await repository.linkMessage({
          conversationId: request.chatId,
          messageId: request.messageId,
          attachmentIds: request.attachmentIds,
          createdAtMs: this.now(),
        });
      },
      prepareQueuedTurn: async (request) => {
        const activity = await activities.turnPort.prepareQueuedTurn(request);
        const document = await documentMedia.prepareLinkedTurn(request);
        const workout = await workouts.prepareLinkedTurn(request);
        const attachmentContext = [document.attachmentContext, workout.attachmentContext]
          .filter((value): value is string => value !== undefined)
          .join("\n");
        const untrustedAttachmentText = [
          document.untrustedAttachmentText,
          workout.untrustedAttachmentText,
        ]
          .filter((value): value is string => value !== undefined)
          .join("\n");
        const references: ChatAttachmentReference[] = [];
        for (const message of request.messages) {
          for (const attachment of await repository.listMessageAttachments(message.messageId)) {
            references.push({
              attachmentId: attachment.id,
              displayName: attachment.display_name,
              kind: attachment.kind,
              extension: attachment.extension as ChatAttachmentReference["extension"],
            });
          }
        }
        return {
          ...activity,
          attachments: references,
          nativeMedia: document.nativeMedia,
          ...(attachmentContext.length === 0 ? {} : { attachmentContext }),
          ...(untrustedAttachmentText.length === 0 ? {} : { untrustedAttachmentText }),
        };
      },
      completeQueuedTurn: async (request) => {
        await activities.turnPort.completeQueuedTurn(request);
        await documentMedia.completeLinkedTurn(request);
        await workouts.completeLinkedTurn(request);
      },
    };
    this.chatAttachments = chatAttachments;
    this.engine = this.buildEngine();
  }

  async seedActivityDraft(): Promise<void> {
    const admission = await this.requireAttachments().admit({
      chatId,
      selectionId: "synthetic-activity-selection",
      source: "picker",
      candidate: { kind: "native-path", sourcePath: activityFixturePath },
    });
    if (admission.status !== "accepted") throw new TypeError("activity admission failed");
    this.activityAttachmentId = admission.attachmentId;
  }

  async seedImageDraft(): Promise<void> {
    const sourcePath = join(dirname(this.databasePath), imageName);
    await copyFile(imageFixturePath, sourcePath);
    const admission = await this.requireAttachments().admit({
      chatId,
      selectionId: "synthetic-image-selection",
      source: "picker",
      candidate: { kind: "native-path", sourcePath },
    });
    if (admission.status !== "accepted") throw new TypeError("image admission failed");
    await this.requireAttachments().saveDraftText(chatId, imageDraftText);
  }

  failDraftClearOnce(): void {
    this.failNextClear = true;
  }

  exposeProviderSettings(): void {
    this.runtimeProvider = "openai";
  }

  restoreKeylessStartup(): void {
    this.runtimeProvider = "codex-agent";
  }

  async reopen(): Promise<void> {
    await this.closeStore();
    await this.open();
  }

  async close(): Promise<void> {
    await this.closeStore();
  }

  async snapshot() {
    const store = this.requireStore();
    const training = await store.get(
      "SELECT COUNT(*) AS count, MIN(sport) AS sport, MIN(local_date_key) AS local_date_key FROM session",
    );
    const activity =
      this.activityAttachmentId === undefined
        ? undefined
        : await this.requireRepository().readAttachment(this.activityAttachmentId);
    const draft = (await this.requireComposer().read(chatId)).draft;
    const transcript = this.requireConversation().readCurrentConversationPage(chatId, {
      cursor: null,
      limit: 25,
    });
    const transcriptTurns =
      "entries" in transcript
        ? transcript.entries.filter((entry) => entry.kind === "turn")
        : transcript.turns;
    const queueOperation = this.requireEngine().getChatQueue;
    if (queueOperation === undefined) throw new TypeError("queue read is unavailable");
    const queue = await queueOperation({ chatId });
    return {
      training: {
        count: Number(training?.count ?? 0),
        sport:
          training?.sport === null || training?.sport === undefined ? null : String(training.sport),
        localDateKey: Number(training?.local_date_key ?? 0),
      },
      activityStatus: activity?.status ?? null,
      draft:
        draft === null
          ? null
          : {
              text: draft.text,
              attachments: draft.attachments.map((attachment) => ({
                name: attachment.displayName,
                status: attachment.status,
              })),
            },
      transcript: transcriptTurns.map((entry) => ({
        coachText: entry.coachText,
        delivery: entry.delivery ?? "complete",
        attachments: entry.attachments?.map((attachment) => attachment.displayName) ?? [],
      })),
      queue: { count: queue.items.length, retryRequired: queue.retryRequired !== undefined },
      coachCalls: this.coachCalls,
      flushCalls: this.flushCalls,
      clearCalls: this.clearCalls,
      activeModel: this.activeModel,
    };
  }

  private buildEngine(): CoachEngine {
    const conversation = this.requireConversation();
    const capabilities = this.requireCapabilities();
    const ports: EngineHostPorts = {
      language: {
        resolveFor: async () => ({ language: "en", source: "default", locale: "en-GB" }),
      },
      config: {
        dataSource: "platform",
        llm: { provider: "openai", model: this.activeModel, apiKey: "fixture" },
        session: {
          historyTokenBudgetRatio: 0.3,
          idleMinutes: 0,
          dailyResetHour: 4,
          resetArchiveRetentionDays: 0,
          timezone: "UTC",
        },
        contextWindowTokens: 272_000,
        compactContextWindowTokens: 272_000,
      },
      memory: new Memory(this.conversationDir, "UTC"),
      chatStore: conversation,
      chatAttachments: this.requireChatAttachments(),
      attachmentCapabilities: { resolve: () => capabilities() },
      transcriptWriter: conversation,
      coachDecisions: conversation,
      secrets: { resolve: async () => "" },
      platform: {
        legacyClient: null,
        athleteData: undefined,
        calendarMutations: createMissingPlatformCalendarMutations(),
      },
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      usage: { append: () => {} },
      stateReader: {
        getAthleteState: async () => {
          throw new TypeError("athlete state is unavailable in this fixture");
        },
      },
      readReferenceState: () => ({ errorState: null, latest: null }),
      getAccessToken: async () => "token",
      classifyFailure,
      extractRetryAfterMs,
      now: () => this.now(),
      randomId: () => {
        const id = `synthetic-engine-${++this.engineIdSequence}`;
        this.lastEngineId = id;
        return id;
      },
      modelTransportDecorator: () => ({ generate: (request) => this.generate(request) }),
    };
    return createCoachEngine({ sport: lifecycleSport, ports });
  }

  private async generate(request: ModelTransportRequest): Promise<GenerateResult> {
    if (request.options.caller === "flush") {
      this.flushCalls += 1;
      return generated("Synthetic memory flush complete.");
    }
    if (request.options.caller !== "chat") return generated("Synthetic maintenance complete.");
    this.coachCalls += 1;
    if (this.coachCalls === 1) {
      request.options.onTextDelta?.(partialText);
      const turnId = this.lastEngineId;
      const stop = this.requireEngine().stopChat;
      if (turnId === undefined || stop === undefined) throw new TypeError("active turn is missing");
      const result = await stop({ chatId, turnId });
      if (!result.stopped) throw new TypeError("active turn did not stop");
      request.options.signal?.throwIfAborted();
      throw new TypeError("synthetic interrupted turn remained active");
    }
    if (this.coachCalls !== 2) throw new TypeError("unexpected Coach invocation");
    request.options.onTextDelta?.(completedText);
    return generated(completedText);
  }

  private async turnFrames(
    run: (onEvent: (event: TurnEvent) => void) => Promise<unknown>,
  ): Promise<readonly string[]> {
    const events: TurnEvent[] = [];
    const result = await run((event) => events.push(event));
    return [...events.map((event) => JSON.stringify(event)), JSON.stringify(result)];
  }

  private runtimeConfig() {
    return {
      schemaVersion: 3,
      llm: {
        provider: this.runtimeProvider,
        model: this.activeModel,
        credential_configured: true,
      },
      intervals: {
        athlete_id: "0",
        credential_configured: true,
        managedByEnvironment: { athleteId: false },
      },
      session: {
        historyTokenBudgetRatio: 0.3,
        idleMinutes: 0,
        dailyResetHour: 4,
        resetArchiveRetentionDays: 0,
        timezone: "UTC",
        managedByEnvironment: {
          historyTokenBudgetRatio: false,
          idleMinutes: false,
          dailyResetHour: false,
          resetArchiveRetentionDays: false,
          timezone: false,
        },
      },
    } as const;
  }

  private now(): number {
    return ++this.instant;
  }

  private requireStore(): SqlStore & MigratorStore {
    if (this.store === undefined) throw new TypeError("store is closed");
    return this.store;
  }

  private requireConversation(): ConversationStorePort {
    if (this.conversation === undefined) throw new TypeError("conversation store is closed");
    return this.conversation;
  }

  private requireRepository(): ChatAttachmentRepository {
    if (this.repository === undefined) throw new TypeError("attachment repository is closed");
    return this.repository;
  }

  private requireAttachments(): ManagedChatAttachmentOperations {
    if (this.attachments === undefined) throw new TypeError("attachment operations are closed");
    return this.attachments;
  }

  private requireComposer(): AttachmentComposerOperations {
    if (this.composer === undefined) throw new TypeError("attachment composer is closed");
    return this.composer;
  }

  private requireCapabilities(): () => Promise<AttachmentCapabilitiesReadModel> {
    if (this.capabilities === undefined) throw new TypeError("capability resolver is closed");
    return this.capabilities;
  }

  private requireChatAttachments(): ChatAttachmentTurnPort {
    if (this.chatAttachments === undefined) throw new TypeError("attachment turn port is closed");
    return this.chatAttachments;
  }

  private requireEngine(): CoachEngine {
    if (this.engine === undefined) throw new TypeError("coach engine is closed");
    return this.engine;
  }

  private async closeStore(): Promise<void> {
    const store = this.store;
    this.store = undefined;
    this.conversation = undefined;
    this.repository = undefined;
    this.attachments = undefined;
    this.activities = undefined;
    this.workouts = undefined;
    this.composer = undefined;
    this.chatAttachments = undefined;
    this.capabilities = undefined;
    this.engine = undefined;
    if (store !== undefined) await store.close();
  }
}

async function waitForActivityDraft(fixture: RunningDesktopFixture) {
  return fixture.evaluate<{
    readonly draft: string;
    readonly attachmentCount: number;
    readonly sendDisabled: boolean;
  }>(`
    const name = ${JSON.stringify(activityName)};
    const deadline = Date.now() + 10000;
    let attachment;
    let composer;
    let send;
    while (Date.now() < deadline) {
      attachment = document.querySelector('section[aria-label="' + name + ' attachment"]');
      composer = document.querySelector("textarea#message");
      send = document.querySelector('button[aria-label="Send message"]');
      if (
        attachment instanceof HTMLElement &&
        composer instanceof HTMLTextAreaElement &&
        send instanceof HTMLButtonElement
      ) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!(attachment instanceof HTMLElement)) throw new Error("activity attachment missing");
    if (!(composer instanceof HTMLTextAreaElement)) throw new Error("composer missing");
    if (!(send instanceof HTMLButtonElement)) throw new Error("send action missing");
    return {
      draft: composer.value,
      attachmentCount: document.querySelectorAll(
        'section[aria-label="' + name + ' attachment"]',
      ).length,
      sendDisabled: send.disabled,
    };
  `);
}

async function captureQaEvidence(fixture: RunningDesktopFixture, name: string): Promise<void> {
  if (qaEvidenceDir === undefined) return;
  await fixture.setViewport(1180, 820);
  await fixture.screenshot(join(qaEvidenceDir, `${name}.png`));
}

async function sendAndWaitForInterruption(fixture: RunningDesktopFixture) {
  return fixture.evaluate<{
    readonly retryCount: number;
    readonly athleteAttachmentCount: number;
    readonly partialCount: number;
  }>(`
    const name = ${JSON.stringify(activityName)};
    const partial = ${JSON.stringify(partialText)};
    const send = document.querySelector('button[aria-label="Send message"]');
    if (!(send instanceof HTMLButtonElement)) throw new Error("send action missing");
    send.click();
    const deadline = Date.now() + 20000;
    let retry;
    while (Date.now() < deadline) {
      retry = [...document.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Retry interrupted message",
      );
      const athleteReady = [...document.querySelectorAll("article.chat-message--athlete")].some(
        (row) => row.textContent?.includes(name),
      );
      const partialReady = [...document.querySelectorAll("article.chat-message--coach")].some(
        (row) => row.textContent?.includes(partial),
      );
      if (retry instanceof HTMLButtonElement && athleteReady && partialReady) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!(retry instanceof HTMLButtonElement)) throw new Error("durable retry action missing");
    const athleteRows = [...document.querySelectorAll("article.chat-message--athlete")].filter(
      (row) => row.textContent?.includes(name),
    );
    const coachRows = [...document.querySelectorAll("article.chat-message--coach")].filter(
      (row) => row.textContent?.includes(partial),
    );
    return {
      retryCount: [...document.querySelectorAll("button")].filter(
        (button) => button.textContent?.trim() === "Retry interrupted message",
      ).length,
      athleteAttachmentCount: athleteRows.length,
      partialCount: coachRows.length,
    };
  `);
}

async function readRetrySurface(fixture: RunningDesktopFixture) {
  return fixture.evaluate<{
    readonly retryCount: number;
    readonly athleteAttachmentCount: number;
    readonly partialCount: number;
  }>(`
    const name = ${JSON.stringify(activityName)};
    const partial = ${JSON.stringify(partialText)};
    const deadline = Date.now() + 10000;
    let retry;
    while (Date.now() < deadline) {
      retry = [...document.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Retry interrupted message",
      );
      const athleteReady = [...document.querySelectorAll("article.chat-message--athlete")].some(
        (row) => row.textContent?.includes(name),
      );
      const partialReady = [...document.querySelectorAll("article.chat-message--coach")].some(
        (row) => row.textContent?.includes(partial),
      );
      if (retry instanceof HTMLButtonElement && athleteReady && partialReady) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!(retry instanceof HTMLButtonElement)) throw new Error("restored retry action missing");
    return {
      retryCount: [...document.querySelectorAll("button")].filter(
        (button) => button.textContent?.trim() === "Retry interrupted message",
      ).length,
      athleteAttachmentCount: [...document.querySelectorAll("article.chat-message--athlete")].filter(
        (row) => row.textContent?.includes(name),
      ).length,
      partialCount: [...document.querySelectorAll("article.chat-message--coach")].filter(
        (row) => row.textContent?.includes(partial),
      ).length,
    };
  `);
}

async function retryAndReadCompleted(fixture: RunningDesktopFixture) {
  return fixture.evaluate<{
    readonly retryCount: number;
    readonly athleteAttachmentCount: number;
    readonly completedCount: number;
  }>(`
    const name = ${JSON.stringify(activityName)};
    const completed = ${JSON.stringify(completedText)};
    const retry = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Retry interrupted message",
    );
    if (!(retry instanceof HTMLButtonElement)) throw new Error("retry action missing");
    retry.click();
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const completedRows = [...document.querySelectorAll("article.chat-message--coach")].filter(
        (row) => row.textContent?.includes(completed),
      );
      const retryCount = [...document.querySelectorAll("button")].filter(
        (button) => button.textContent?.trim() === "Retry interrupted message",
      ).length;
      if (completedRows.length === 1 && retryCount === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return {
      retryCount: [...document.querySelectorAll("button")].filter(
        (button) => button.textContent?.trim() === "Retry interrupted message",
      ).length,
      athleteAttachmentCount: [...document.querySelectorAll("article.chat-message--athlete")].filter(
        (row) => row.textContent?.includes(name),
      ).length,
      completedCount: [...document.querySelectorAll("article.chat-message--coach")].filter(
        (row) => row.textContent?.includes(completed),
      ).length,
    };
  `);
}

async function readCompletedSurface(fixture: RunningDesktopFixture) {
  return fixture.evaluate<{
    readonly athleteAttachmentCount: number;
    readonly partialCount: number;
    readonly completedCount: number;
  }>(`
    const name = ${JSON.stringify(activityName)};
    const partial = ${JSON.stringify(partialText)};
    const completed = ${JSON.stringify(completedText)};
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (
        [...document.querySelectorAll("article.chat-message--coach")].some(
          (row) => row.textContent?.includes(completed),
        )
      ) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return {
      athleteAttachmentCount: [...document.querySelectorAll("article.chat-message--athlete")].filter(
        (row) => row.textContent?.includes(name),
      ).length,
      partialCount: [...document.querySelectorAll("article.chat-message--coach")].filter(
        (row) => row.textContent?.includes(partial),
      ).length,
      completedCount: [...document.querySelectorAll("article.chat-message--coach")].filter(
        (row) => row.textContent?.includes(completed),
      ).length,
    };
  `);
}

async function readImageDraft(fixture: RunningDesktopFixture) {
  return fixture.evaluate<{
    readonly draft: string;
    readonly imageCount: number;
    readonly ready: boolean;
    readonly activityTranscriptCount: number;
  }>(`
    const imageName = ${JSON.stringify(imageName)};
    const activityName = ${JSON.stringify(activityName)};
    const draftText = ${JSON.stringify(imageDraftText)};
    const deadline = Date.now() + 10000;
    let attachment;
    let composer;
    while (Date.now() < deadline) {
      attachment = document.querySelector('section[aria-label="' + imageName + ' attachment"]');
      composer = document.querySelector("textarea#message");
      if (
        attachment instanceof HTMLElement &&
        composer instanceof HTMLTextAreaElement &&
        composer.value === draftText &&
        [...document.querySelectorAll("article.chat-message--athlete")].some(
          (row) => row.textContent?.includes(activityName),
        )
      ) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!(attachment instanceof HTMLElement)) throw new Error("image attachment missing");
    if (!(composer instanceof HTMLTextAreaElement)) throw new Error("composer missing");
    return {
      draft: composer.value,
      imageCount: document.querySelectorAll(
        'section[aria-label="' + imageName + ' attachment"]',
      ).length,
      ready: attachment.textContent?.includes("Image input available") === true,
      activityTranscriptCount: [...document.querySelectorAll("article.chat-message--athlete")].filter(
        (row) => row.textContent?.includes(activityName),
      ).length,
    };
  `);
}

async function switchModelAndReadBlockedDraft(fixture: RunningDesktopFixture) {
  return fixture.evaluate<{
    readonly blocked: boolean;
    readonly settingsActionCount: number;
    readonly draft: string;
  }>(`
    const imageName = ${JSON.stringify(imageName)};
    const model = ${JSON.stringify(incompatibleModel)};
    const nav = (label) => [...document.querySelectorAll('nav[aria-label="Main navigation"] button')]
      .find((button) => button.textContent?.includes(label));
    const settings = nav("Settings");
    if (!(settings instanceof HTMLButtonElement)) throw new Error("Settings navigation missing");
    settings.click();
    const settingsDeadline = Date.now() + 10000;
    while (document.querySelector("#coach-model") === null && Date.now() < settingsDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const trigger = document.querySelector("#coach-model");
    if (!(trigger instanceof HTMLButtonElement)) throw new Error("model control missing");
    trigger.click();
    const optionDeadline = Date.now() + 10000;
    let option;
    while (option === undefined && Date.now() < optionDeadline) {
      option = [...document.querySelectorAll('[role="option"]')].find(
        (entry) => entry.textContent?.trim() === "Other model…",
      );
      if (option === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!(option instanceof HTMLElement)) throw new Error("custom model option missing");
    option.click();
    const customDeadline = Date.now() + 10000;
    while (document.querySelector("#coach-custom-model") === null && Date.now() < customDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const custom = document.querySelector("#coach-custom-model");
    if (!(custom instanceof HTMLInputElement)) throw new Error("custom model input missing");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(custom, model);
    custom.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const save = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Save coach route",
    );
    if (!(save instanceof HTMLButtonElement) || save.disabled) {
      throw new Error("save coach route action unavailable");
    }
    save.click();
    const savedDeadline = Date.now() + 10000;
    while (
      !document.body.textContent?.includes("Coach settings saved.") &&
      Date.now() < savedDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!document.body.textContent?.includes("Coach settings saved.")) {
      throw new Error("coach route did not save");
    }
    const chat = nav("Chat");
    if (!(chat instanceof HTMLButtonElement)) throw new Error("Chat navigation missing");
    chat.click();
    const blockedDeadline = Date.now() + 10000;
    let attachment;
    while (Date.now() < blockedDeadline) {
      attachment = document.querySelector('section[aria-label="' + imageName + ' attachment"]');
      if (
        attachment instanceof HTMLElement &&
        attachment.textContent?.includes("This model can’t view this file")
      ) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!(attachment instanceof HTMLElement)) throw new Error("blocked image attachment missing");
    const composer = document.querySelector("textarea#message");
    if (!(composer instanceof HTMLTextAreaElement)) throw new Error("composer missing");
    return {
      blocked: attachment.textContent?.includes("This model can’t view this file") === true,
      settingsActionCount: [...attachment.querySelectorAll("button")].filter(
        (button) => button.textContent?.trim() === "Open Settings",
      ).length,
      draft: composer.value,
    };
  `);
}

async function resetAndReadUncertain(fixture: RunningDesktopFixture) {
  return fixture.evaluate<{
    readonly uncertaintyVisible: boolean;
    readonly activityTranscriptCount: number;
    readonly imageCount: number;
    readonly draft: string;
    readonly newChatAriaDisabled: string | null;
  }>(`
    const activityName = ${JSON.stringify(activityName)};
    const imageName = ${JSON.stringify(imageName)};
    const uncertainty = "We couldn’t confirm whether the new conversation started. Your visible conversation is preserved.";
    const actionDeadline = Date.now() + 10000;
    let newChat;
    while (Date.now() < actionDeadline) {
      newChat = [...document.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "New chat",
      );
      if (
        newChat instanceof HTMLButtonElement &&
        !newChat.disabled &&
        newChat.getAttribute("aria-disabled") !== "true"
      ) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (
      !(newChat instanceof HTMLButtonElement) ||
      newChat.disabled ||
      newChat.getAttribute("aria-disabled") === "true"
    ) throw new Error("New chat action unavailable");
    newChat.click();
    const dialogDeadline = Date.now() + 10000;
    let confirm;
    while (Date.now() < dialogDeadline) {
      confirm = [...document.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Start new conversation",
      );
      if (confirm instanceof HTMLButtonElement) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!(confirm instanceof HTMLButtonElement)) throw new Error("reset confirmation missing");
    confirm.click();
    const resetDeadline = Date.now() + 20000;
    while (!document.body.textContent?.includes(uncertainty) && Date.now() < resetDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const composer = document.querySelector("textarea#message");
    const currentNewChat = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "New chat",
    );
    if (!(composer instanceof HTMLTextAreaElement)) throw new Error("composer missing");
    if (!(currentNewChat instanceof HTMLButtonElement)) throw new Error("New chat action missing");
    return {
      uncertaintyVisible: document.body.textContent?.includes(uncertainty) === true,
      activityTranscriptCount: [...document.querySelectorAll("article.chat-message--athlete")].filter(
        (row) => row.textContent?.includes(activityName),
      ).length,
      imageCount: document.querySelectorAll(
        'section[aria-label="' + imageName + ' attachment"]',
      ).length,
      draft: composer.value,
      newChatAriaDisabled: currentNewChat.getAttribute("aria-disabled"),
    };
  `);
}

async function readDraftAfterUncertainRelaunch(fixture: RunningDesktopFixture) {
  return fixture.evaluate<{
    readonly activityTranscriptCount: number;
    readonly imageCount: number;
    readonly draft: string;
  }>(`
    const activityName = ${JSON.stringify(activityName)};
    const imageName = ${JSON.stringify(imageName)};
    const draftText = ${JSON.stringify(imageDraftText)};
    const deadline = Date.now() + 10000;
    let composer;
    while (Date.now() < deadline) {
      composer = document.querySelector("textarea#message");
      if (composer instanceof HTMLTextAreaElement && composer.value === draftText) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!(composer instanceof HTMLTextAreaElement)) throw new Error("composer missing");
    return {
      activityTranscriptCount: [...document.querySelectorAll("article.chat-message--athlete")].filter(
        (row) => row.textContent?.includes(activityName),
      ).length,
      imageCount: document.querySelectorAll(
        'section[aria-label="' + imageName + ' attachment"]',
      ).length,
      draft: composer.value,
    };
  `);
}

async function confirmResetSuccess(fixture: RunningDesktopFixture) {
  return fixture.evaluate<{
    readonly successVisible: boolean;
    readonly imageCount: number;
    readonly draft: string;
  }>(`
    const imageName = ${JSON.stringify(imageName)};
    const success = "New conversation started.";
    const actionDeadline = Date.now() + 10000;
    let newChat;
    while (Date.now() < actionDeadline) {
      newChat = [...document.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "New chat",
      );
      if (
        newChat instanceof HTMLButtonElement &&
        !newChat.disabled &&
        newChat.getAttribute("aria-disabled") !== "true"
      ) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (
      !(newChat instanceof HTMLButtonElement) ||
      newChat.disabled ||
      newChat.getAttribute("aria-disabled") === "true"
    ) throw new Error("New chat action unavailable");
    newChat.click();
    const dialogDeadline = Date.now() + 10000;
    let confirm;
    while (Date.now() < dialogDeadline) {
      confirm = [...document.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Start new conversation",
      );
      if (confirm instanceof HTMLButtonElement) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!(confirm instanceof HTMLButtonElement)) throw new Error("reset confirmation missing");
    confirm.click();
    const resetDeadline = Date.now() + 20000;
    while (Date.now() < resetDeadline) {
      const composer = document.querySelector("textarea#message");
      const image = document.querySelector('section[aria-label="' + imageName + ' attachment"]');
      if (
        composer instanceof HTMLTextAreaElement &&
        composer.value === "" &&
        image === null &&
        document.body.textContent?.includes(success)
      ) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const composer = document.querySelector("textarea#message");
    if (!(composer instanceof HTMLTextAreaElement)) throw new Error("composer missing");
    return {
      successVisible: document.body.textContent?.includes(success) === true,
      imageCount: document.querySelectorAll(
        'section[aria-label="' + imageName + ' attachment"]',
      ).length,
      draft: composer.value,
    };
  `);
}

afterEach(async () => {
  const failures: unknown[] = [];
  for (const results of [
    await Promise.allSettled(fixtures.splice(0).map(async (fixture) => fixture.close())),
    await Promise.allSettled(backends.splice(0).map(async (backend) => backend.close())),
    await Promise.allSettled(
      scratchPaths
        .splice(0)
        .map(async (path) =>
          rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
        ),
    ),
  ]) {
    for (const result of results) {
      if (result.status === "rejected") failures.push(result.reason);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "desktop fixture cleanup failed");
});

describe.skipIf(process.platform !== "darwin" || !hasLoopback)(
  "Chat attachment production lifecycle",
  () => {
    it("preserves one canonical import, retry summaries, incompatible drafts, and reset certainty", async () => {
      if (qaEvidenceDir !== undefined) {
        await mkdir(qaEvidenceDir, { recursive: true, mode: 0o700 });
        if ((await readdir(qaEvidenceDir)).length > 0) {
          throw new Error("visible QA evidence directory must be empty");
        }
      }
      const scratch = await mkdtemp(join(await realpath(tmpdir()), "chat-attachment-lifecycle-"));
      scratchPaths.push(scratch);
      const backend = new AttachmentLifecycleBackend(
        join(scratch, "training.sqlite"),
        join(scratch, "conversation"),
        join(scratch, "attachments"),
      );
      backends.push(backend);
      await backend.open();
      await backend.seedActivityDraft();

      expect(await backend.snapshot()).toMatchObject({
        training: { count: 0, sport: null, localDateKey: 0 },
        activityStatus: "ready",
        draft: { text: "", attachments: [{ name: activityName, status: "ready" }] },
        queue: { count: 0, retryRequired: false },
        coachCalls: 0,
      });

      const fixture = await launchDesktopFixture({
        script: backend.script,
        token,
        width: 1180,
        height: 820,
        colorScheme: "light",
        reducedMotion: true,
        hidden: qaEvidenceDir === undefined,
        routeChatAttachmentComposer: true,
      });
      fixtures.push(fixture);

      expect(await waitForActivityDraft(fixture)).toEqual({
        draft: "",
        attachmentCount: 1,
        sendDisabled: false,
      });
      expect((await backend.snapshot()).training.count).toBe(0);
      await captureQaEvidence(fixture, "01-pre-send-activity-draft");

      expect(await sendAndWaitForInterruption(fixture)).toEqual({
        retryCount: 1,
        athleteAttachmentCount: 1,
        partialCount: 1,
      });
      expect(await backend.snapshot()).toMatchObject({
        training: { count: 1, sport: "cycling", localDateKey: 19980704 },
        activityStatus: "imported",
        draft: null,
        transcript: [
          { coachText: partialText, delivery: "interrupted", attachments: [activityName] },
        ],
        queue: { count: 1, retryRequired: true },
        coachCalls: 1,
      });

      await fixture.relaunch(() => backend.reopen());
      expect(await readRetrySurface(fixture)).toEqual({
        retryCount: 1,
        athleteAttachmentCount: 1,
        partialCount: 1,
      });
      await captureQaEvidence(fixture, "02-restored-retry-required");
      expect(await retryAndReadCompleted(fixture)).toEqual({
        retryCount: 0,
        athleteAttachmentCount: 1,
        completedCount: 1,
      });
      expect(await backend.snapshot()).toMatchObject({
        training: { count: 1, sport: "cycling", localDateKey: 19980704 },
        activityStatus: "sent",
        queue: { count: 0, retryRequired: false },
        coachCalls: 2,
      });
      await captureQaEvidence(fixture, "03-completed-live");

      await fixture.relaunch(() => backend.reopen());
      expect(await readCompletedSurface(fixture)).toEqual({
        athleteAttachmentCount: 1,
        partialCount: 1,
        completedCount: 1,
      });
      expect((await backend.snapshot()).coachCalls).toBe(2);
      await captureQaEvidence(fixture, "04-completed-clean-relaunch");

      await backend.seedImageDraft();
      expect(await backend.snapshot()).toMatchObject({
        draft: {
          text: imageDraftText,
          attachments: [{ name: imageName, status: "ready" }],
        },
      });
      await fixture.relaunch(() => backend.reopen());
      expect(await readImageDraft(fixture)).toEqual({
        draft: imageDraftText,
        imageCount: 1,
        ready: true,
        activityTranscriptCount: 1,
      });
      await captureQaEvidence(fixture, "05-restored-image-draft");

      backend.exposeProviderSettings();
      expect(await switchModelAndReadBlockedDraft(fixture)).toEqual({
        blocked: true,
        settingsActionCount: 1,
        draft: imageDraftText,
      });
      expect(await backend.snapshot()).toMatchObject({
        activeModel: incompatibleModel,
        draft: {
          text: imageDraftText,
          attachments: [{ name: imageName, status: "blocked" }],
        },
        training: { count: 1, sport: "cycling", localDateKey: 19980704 },
      });
      await captureQaEvidence(fixture, "06-incompatible-model-blocked");

      backend.failDraftClearOnce();
      expect(await resetAndReadUncertain(fixture)).toEqual({
        uncertaintyVisible: true,
        activityTranscriptCount: 1,
        imageCount: 1,
        draft: imageDraftText,
        newChatAriaDisabled: "true",
      });
      expect(await backend.snapshot()).toMatchObject({
        draft: {
          text: imageDraftText,
          attachments: [{ name: imageName, status: "blocked" }],
        },
        transcript: [],
        training: { count: 1, sport: "cycling", localDateKey: 19980704 },
        activityStatus: "sent",
        clearCalls: 1,
      });
      await captureQaEvidence(fixture, "07-reset-uncertainty-preserved");

      backend.restoreKeylessStartup();
      await fixture.relaunch(() => backend.reopen());
      expect(await readDraftAfterUncertainRelaunch(fixture)).toEqual({
        activityTranscriptCount: 0,
        imageCount: 1,
        draft: imageDraftText,
      });
      await captureQaEvidence(fixture, "08-post-uncertainty-relaunch");
      expect(await confirmResetSuccess(fixture)).toEqual({
        successVisible: true,
        imageCount: 0,
        draft: "",
      });
      expect(await backend.snapshot()).toMatchObject({
        training: { count: 1, sport: "cycling", localDateKey: 19980704 },
        activityStatus: "sent",
        draft: null,
        transcript: [],
        queue: { count: 0, retryRequired: false },
        coachCalls: 2,
        clearCalls: 2,
      });
      await captureQaEvidence(fixture, "09-reset-success-cleared");

      expect(await fixture.close()).toEqual({ livePids: [], listenerCount: 0 });
      fixtures.splice(fixtures.indexOf(fixture), 1);
    }, 120_000);
  },
);
