import { createServer } from "node:net";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHAT_ATTACHMENT_LIMITS,
  type AttachmentCapabilitiesReadModel,
  type CreatePlanningRequestPayload,
  type PlanningRequestOperations,
} from "@enduragent/coach-contract";
import { createConversationStore, type ConversationStorePort } from "@enduragent/core";
import {
  createPlanningRequestRepository,
  type PlanningRequestRepository,
} from "@enduragent/kernel/planning";
import {
  createChatAttachmentRepository,
  createChatPlanOutboxRepository,
  runMigrations,
  type ChatAttachmentRepository,
  type ChatPlanOutboxRepository,
  type MigratorStore,
  type SqlStore,
} from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { createManagedChatAttachmentStore } from "@enduragent/kernel-node/chat-attachments";
import { createNodeCrypto } from "@enduragent/kernel-node/ingest";
import type { AuthoredIdentity } from "@enduragent/kernel-node/home";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { createManagedWorkoutReader } from "@enduragent/sport-cycling/workout-import";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAttachmentComposerOperations,
  type AttachmentComposerOperations,
} from "../../../packages/coach/src/attachment-composer-operations.js";
import {
  createManagedChatAttachmentOperations,
  type ManagedChatAttachmentOperations,
} from "../../../packages/coach/src/attachment-operations.js";
import { createPlanningRequestDeliveryService } from "../../../packages/coach/src/planning-request-delivery.js";
import {
  createWorkoutAttachmentOperations,
  type WorkoutAttachmentOperations,
} from "../../../packages/coach/src/workout-attachment-operations.js";
import {
  launchDesktopFixture,
  type DesktopFixtureScript,
  type RunningDesktopFixture,
  visibleQaCheckpoint,
} from "./helpers/desktop-fixture.js";
import { createPlanQaFixtureScript } from "./helpers/plan-qa-live.js";

const hasLoopback = await new Promise<boolean>((resolveAvailability) => {
  const server = createServer();
  server.once("error", () => resolveAvailability(false));
  server.listen({ host: "127.0.0.1", port: 0 }, () => {
    server.close(() => resolveAvailability(true));
  });
});

const token = "r".repeat(43);
const chatId = "desktop";
const decisionId = "decision-recovery";
const queuedMessageId = "queued-recovery";
const queuedMessageText = "Also preserve my easy Friday ride.";
const requestId = "request-recovery";
const attachmentDraftText = "Compare this workout with my current week.";
const decisionQuestion = "Which priority should guide the next workout?";
const recoveredAthleteText = "Keep the first recovery message.";
const recoveredPartialText = "Partial recovery guidance.";
const recoveredCoachText = "Recovered recovery guidance.";
const laterAthleteText = "Later one\n\nLater two";
const laterCoachText = "Later reply.";
const historyAthleteText = "How should I pace the recovery block?";
const historyCoachText = "Keep the opening rides conversational and controlled.";
const interruptedAthleteText = "Compare the last two recovery rides.";
const interruptedCoachText = "The first ride stayed controlled, while the second";
const resetUncertaintyCopy =
  "We couldn’t confirm whether the new conversation started. Your visible conversation is preserved.";
const fixtures: RunningDesktopFixture[] = [];
const backends: RecoveryBackend[] = [];
const scratchPaths: string[] = [];

const capabilities: AttachmentCapabilitiesReadModel = {
  schemaVersion: 1,
  active: { provider: "codex-agent", model: "fixture", transport: "codex-agent" },
  documents: { enabled: true, extensions: ["pdf", "txt", "csv", "docx"] },
  completedActivities: { enabled: true, extensions: ["fit", "tcx", "gpx"] },
  plannedWorkouts: { enabled: true, extensions: ["zwo", "erg", "mrc"] },
  images: {
    enabled: false,
    mediaTypes: [],
    reason: "transport_incompatible",
    source: "transport_blocked",
    checkedAt: "1998-08-22T08:00:00.000Z",
  },
};

const workoutLimits = {
  candidates: CHAT_ATTACHMENT_LIMITS.workoutCandidates,
  segmentsPerWorkout: CHAT_ATTACHMENT_LIMITS.workoutSegments,
  durationSeconds: CHAT_ATTACHMENT_LIMITS.workoutDurationSeconds,
  diagnostics: CHAT_ATTACHMENT_LIMITS.workoutDiagnostics,
  diagnosticChars: CHAT_ATTACHMENT_LIMITS.workoutDiagnosticChars,
  titleChars: CHAT_ATTACHMENT_LIMITS.workoutTitleChars,
  purposeChars: CHAT_ATTACHMENT_LIMITS.workoutPurposeChars,
} as const;

const workout = `<workout_file>
  <name>Recovery tempo</name>
  <description>Controlled aerobic pressure</description>
  <sportType>bike</sportType>
  <workout>
    <Warmup Duration="300" PowerLow="0.5" PowerHigh="0.7" />
    <SteadyState Duration="1200" Power="0.8" />
    <Cooldown Duration="300" PowerLow="0.6" PowerHigh="0.4" />
  </workout>
</workout_file>`;

interface ScriptRequest {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params: Record<string, unknown>;
}

function response(value: unknown): readonly string[] {
  return [JSON.stringify(value)];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function planningPayload(): CreatePlanningRequestPayload {
  return {
    requestId,
    kind: "plan_change",
    intent: "Review the saved recovery workout in Plan.",
    source: { chatId, messageId: "message-plan-recovery" },
    sourceSnapshot: {
      capturedAt: "1998-08-24T08:00:00.000Z",
      attachment: null,
      selectedWorkout: null,
    },
    requestedDate: "1998-08-26",
  };
}

class RecoveryBackend {
  readonly calls: ScriptRequest[] = [];
  readonly script: DesktopFixtureScript;
  private store: (SqlStore & MigratorStore) | undefined;
  private conversation: ConversationStorePort | undefined;
  private attachmentRepository: ChatAttachmentRepository | undefined;
  private attachmentOperations: ManagedChatAttachmentOperations | undefined;
  private workoutOperations: WorkoutAttachmentOperations | undefined;
  private attachmentComposer: AttachmentComposerOperations | undefined;
  private outbox: ChatPlanOutboxRepository | undefined;
  private requests: PlanningRequestRepository | undefined;
  private planning: PlanningRequestOperations | undefined;
  private instant = Date.UTC(1998, 7, 24, 8);
  private idSequence = 0;
  private attachmentId: string | undefined;
  private workoutId: string | undefined;
  private resetControl:
    | {
        readonly entered: ReturnType<typeof deferred<void>>;
        readonly outcome: ReturnType<typeof deferred<readonly string[]>>;
        requestEntered: boolean;
        settled: boolean;
      }
    | undefined;

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
        if (request.method === "getChatQueue") {
          return response(this.requireConversation().getChatQueue(chatId));
        }
        if (request.method === "getTranscriptPage") {
          return response(
            this.requireConversation().readCurrentConversationPage(chatId, {
              cursor: request.params.cursor === null ? null : String(request.params.cursor),
              limit: Number(request.params.limit),
            }),
          );
        }
        if (request.method === "getCoachDecision") {
          return response({ decision: this.requireConversation().getDecision(chatId) });
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
          return response(await this.requireAttachmentComposer().read(chatId));
        }
        if (request.method === "resetSession") {
          const control = this.resetControl;
          if (control === undefined) throw new TypeError("reset control is not armed");
          control.requestEntered = true;
          control.entered.resolve(undefined);
          return control.outcome.promise;
        }
        if (request.method === "resumePlanningRequests") {
          return response(await this.requirePlanning().resumePlanningRequests?.({}));
        }
        if (request.method === "listPlanningRequests") {
          return response(await this.requirePlanning().listPlanningRequests?.({ chatId }));
        }
        if (request.method === "getPlanningRequest") {
          return response(
            await this.requirePlanning().getPlanningRequest?.({
              requestId: String(request.params.requestId),
            }),
          );
        }
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
    this.conversation = createConversationStore(this.conversationDir);
    this.attachmentRepository = createChatAttachmentRepository(store);
    const objects = createManagedChatAttachmentStore({
      archiveDir: this.archiveDir,
      kindByteLimits: {
        document: CHAT_ATTACHMENT_LIMITS.documentBytes,
        activity: CHAT_ATTACHMENT_LIMITS.activityBytes,
        workout: CHAT_ATTACHMENT_LIMITS.workoutBytes,
        image: CHAT_ATTACHMENT_LIMITS.imageBytes,
      },
    });
    this.workoutOperations = createWorkoutAttachmentOperations({
      repository: this.attachmentRepository,
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
    this.attachmentOperations = createManagedChatAttachmentOperations({
      repository: this.attachmentRepository,
      objects,
      runExclusive: (work) => work(),
      now: () => this.now(),
      randomId: () => `recovery-id-${++this.idSequence}`,
      onAdmitted: this.workoutOperations.preprocessAdmitted,
    });
    this.attachmentComposer = createAttachmentComposerOperations({
      repository: this.attachmentRepository,
      attachments: this.attachmentOperations,
      activities: {
        readPreview: async () => {
          throw new TypeError("activity preview is unavailable in this fixture");
        },
      },
      workouts: this.workoutOperations,
      capabilities: async () => capabilities,
    });
    const crypto = createNodeCrypto();
    this.outbox = createChatPlanOutboxRepository(store, crypto);
    this.requests = createPlanningRequestRepository(store, crypto);
    this.planning = createPlanningRequestDeliveryService({
      outbox: this.outbox,
      requests: this.requests,
      identity: this.identity(),
      readPlanCreationCard: async () => null,
      resolveTarget: async () => "active_plan",
    });
  }

  async establishDurableState(): Promise<void> {
    const sourcePath = join(this.conversationDir, "recovery-tempo.zwo");
    await writeFile(sourcePath, workout, { mode: 0o600 });
    const admission = await this.requireAttachmentOperations().admit({
      chatId,
      selectionId: "selection-recovery",
      source: "picker",
      candidate: { kind: "native-path", sourcePath },
    });
    if (admission.status !== "accepted") throw new TypeError("workout admission failed");
    this.attachmentId = admission.attachmentId;
    const set = await this.requireWorkoutOperations().readWorkoutSet(admission.attachmentId);
    const selected = set.workouts[0];
    if (selected === undefined) throw new TypeError("parsed workout is missing");
    this.workoutId = selected.workoutId;
    await this.requireWorkoutOperations().selectWorkout({
      conversationId: chatId,
      attachmentId: admission.attachmentId,
      workoutId: selected.workoutId,
    });
    await this.requireAttachmentOperations().saveDraftText(chatId, attachmentDraftText);

    const conversation = this.requireConversation();
    conversation.enqueueChatMessage(
      chatId,
      "submission-recovery",
      queuedMessageText,
      queuedMessageId,
      "message-queue-recovery",
    );
    if (conversation.appendInterruptedTurn === undefined) {
      throw new TypeError("interrupted transcript persistence is unavailable");
    }
    conversation.appendInterruptedTurn({
      chatId,
      turnId: "turn-chat-recovery",
      completedAt: "1998-08-24T07:57:00.000Z",
      athleteText: recoveredAthleteText,
      coachText: recoveredPartialText,
    });
    conversation.appendCompletedTurn({
      chatId,
      turnId: "turn-chat-recovery",
      completedAt: "1998-08-24T07:58:00.000Z",
      athleteText: recoveredAthleteText,
      coachText: recoveredCoachText,
    });
    conversation.appendCompletedTurn({
      chatId,
      turnId: "turn-chat-later",
      completedAt: "1998-08-24T07:59:00.000Z",
      athleteText: laterAthleteText,
      coachText: laterCoachText,
    });
    conversation.appendDecisionRequested({
      turnId: "turn-decision-recovery",
      toolCallId: "tool-decision-recovery",
      athleteText: "Help me choose the next workout priority.",
      requestedAt: "1998-08-24T08:00:00.000Z",
      decision: {
        status: "unanswered",
        decisionId,
        chatId,
        messageId: "message-decision-recovery",
        question: decisionQuestion,
        options: [
          {
            id: "recover",
            label: "Protect recovery",
            description: "Keep the next session controlled.",
            recommended: true,
            consequence: "The next workout stays controlled.",
          },
          {
            id: "progress",
            label: "Progress intensity",
            description: "Add more work if recovery supports it.",
            recommended: false,
            consequence: "The next workout adds intensity.",
          },
        ],
      },
    });

    const plan = await this.requirePlanning().createPlanningRequest?.({
      payload: planningPayload(),
    });
    if (plan?.status !== "accepted" || plan.delivery.state !== "delivered") {
      throw new TypeError("Planning request delivery failed");
    }
  }

  async establishNavigationState(): Promise<void> {
    const conversation = this.requireConversation();
    conversation.appendCompletedTurn({
      chatId,
      turnId: "turn-history-recovery",
      completedAt: "1998-08-24T07:55:00.000Z",
      athleteText: historyAthleteText,
      coachText: historyCoachText,
    });
    if (conversation.appendInterruptedTurn === undefined) {
      throw new TypeError("interrupted transcript persistence is unavailable");
    }
    conversation.appendInterruptedTurn({
      chatId,
      turnId: "turn-interrupted-recovery",
      completedAt: "1998-08-24T07:58:00.000Z",
      athleteText: interruptedAthleteText,
      coachText: interruptedCoachText,
    });
    await this.establishDurableState();
  }

  pauseReset(): { readonly entered: Promise<void>; fail(error: Error): void } {
    if (this.resetControl !== undefined) throw new TypeError("reset control is already armed");
    const entered = deferred<void>();
    const outcome = deferred<readonly string[]>();
    this.resetControl = { entered, outcome, requestEntered: false, settled: false };
    return {
      entered: entered.promise,
      fail: (error) => this.failReset(error),
    };
  }

  abortPendingReset(): void {
    if (this.resetControl?.requestEntered === true) {
      this.failReset(new Error("reset fixture closed"));
    }
  }

  async reopen(): Promise<void> {
    await this.closeStore();
    await this.open();
  }

  async close(): Promise<void> {
    await this.closeStore();
  }

  async snapshot() {
    const attachment = await this.requireAttachmentComposer().read(chatId);
    const planningRequest = await this.requireRequests().read(requestId);
    const outbox = await this.requireOutbox().read(requestId);
    return {
      queue: this.requireConversation().getChatQueue(chatId),
      decision: this.requireConversation().getDecision(chatId),
      transcript: this.requireConversation().readCurrentConversation(chatId),
      attachment,
      planningRequest,
      outbox,
      attachmentId: this.attachmentId,
      workoutId: this.workoutId,
    };
  }

  private identity(): AuthoredIdentity {
    return {
      deviceId: async () => "device-recovery",
      newUlid: () => "01J60HFQ7T0000000000000002",
      hlcStamp: () => ({ physicalMs: this.now(), counter: 0 }),
    };
  }

  private now(): number {
    return ++this.instant;
  }

  private failReset(error: Error): void {
    const control = this.resetControl;
    if (control === undefined || control.settled) return;
    control.settled = true;
    control.outcome.reject(error);
  }

  private requireConversation(): ConversationStorePort {
    if (this.conversation === undefined) throw new TypeError("Conversation store is closed");
    return this.conversation;
  }

  private requireAttachmentOperations(): ManagedChatAttachmentOperations {
    if (this.attachmentOperations === undefined) {
      throw new TypeError("Attachment operations are closed");
    }
    return this.attachmentOperations;
  }

  private requireWorkoutOperations(): WorkoutAttachmentOperations {
    if (this.workoutOperations === undefined) {
      throw new TypeError("Workout operations are closed");
    }
    return this.workoutOperations;
  }

  private requireAttachmentComposer(): AttachmentComposerOperations {
    if (this.attachmentComposer === undefined) {
      throw new TypeError("Attachment composer is closed");
    }
    return this.attachmentComposer;
  }

  private requireOutbox(): ChatPlanOutboxRepository {
    if (this.outbox === undefined) throw new TypeError("Planning outbox is closed");
    return this.outbox;
  }

  private requireRequests(): PlanningRequestRepository {
    if (this.requests === undefined) throw new TypeError("Planning requests are closed");
    return this.requests;
  }

  private requirePlanning(): PlanningRequestOperations {
    if (this.planning === undefined) throw new TypeError("Planning operations are closed");
    return this.planning;
  }

  private async closeStore(): Promise<void> {
    const store = this.store;
    this.store = undefined;
    this.conversation = undefined;
    this.attachmentRepository = undefined;
    this.attachmentOperations = undefined;
    this.workoutOperations = undefined;
    this.attachmentComposer = undefined;
    this.outbox = undefined;
    this.requests = undefined;
    this.planning = undefined;
    if (store !== undefined) await store.close();
  }
}

async function readRecoverySurface(fixture: RunningDesktopFixture) {
  return fixture.evaluate<{
    readonly questionCount: number;
    readonly attachmentCount: number;
    readonly selectedWorkoutCount: number;
    readonly queueCount: number;
    readonly planRequestCount: number;
    readonly planAction: string;
    readonly draft: string;
    readonly sendDisabled: boolean;
    readonly inputDisabled: boolean;
    readonly projectionOrder: readonly string[];
    readonly recoveryTranscript: readonly {
      readonly role: "athlete" | "coach";
      readonly text: string;
      readonly delivery: string | null;
    }[];
  }>(`
    const question = ${JSON.stringify(decisionQuestion)};
    const queueText = ${JSON.stringify(queuedMessageText)};
    const draftText = ${JSON.stringify(attachmentDraftText)};
    const requestId = ${JSON.stringify(requestId)};
    const recoveryTexts = new Set(${JSON.stringify([
      recoveredAthleteText,
      recoveredPartialText,
      recoveredCoachText,
      laterAthleteText,
      laterCoachText,
    ])});
    const expectedRecoveryTexts = ${JSON.stringify([
      recoveredAthleteText,
      recoveredPartialText,
      recoveredCoachText,
      laterAthleteText,
      laterCoachText,
    ])};
    const deadline = Date.now() + 10000;
    let decision;
    let attachment;
    let queue;
    let plan;
    let composer;
    while (Date.now() < deadline) {
      decision = [...document.querySelectorAll(".composer-projections section")].find(
        (element) => element.textContent?.includes(question),
      );
      attachment = document.querySelector('section[aria-label="recovery-tempo.zwo attachment"]');
      queue = document.querySelector("section.chat-queue");
      plan = document.querySelector('[data-planning-request-id="' + requestId + '"]');
      composer = document.querySelector("#message");
      const recoveryTranscript = [...document.querySelectorAll("article.chat-message")]
        .map((element) => element.querySelector(".chat-message__text")?.textContent?.trim() ?? "")
        .filter((text) => recoveryTexts.has(text));
      if (
        decision instanceof HTMLElement &&
        attachment instanceof HTMLElement &&
        queue instanceof HTMLElement &&
        queue.textContent?.includes(queueText) &&
        plan instanceof HTMLElement &&
        composer instanceof HTMLTextAreaElement &&
        composer.value === draftText &&
        JSON.stringify(recoveryTranscript) === JSON.stringify(expectedRecoveryTexts)
      ) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!(decision instanceof HTMLElement)) throw new Error("Recovered decision missing");
    if (!(attachment instanceof HTMLElement)) throw new Error("Recovered attachment missing");
    if (!(queue instanceof HTMLElement)) throw new Error("Recovered queue missing");
    if (!(plan instanceof HTMLElement)) throw new Error("Recovered Plan request missing");
    if (!(composer instanceof HTMLTextAreaElement)) throw new Error("Recovered composer missing");
    const send = document.querySelector('button[aria-label="Send message"]');
    if (!(send instanceof HTMLButtonElement)) throw new Error("Send action missing");
    const projections = document.querySelector(".composer-projections");
    if (!(projections instanceof HTMLElement)) throw new Error("Composer projections missing");
    const projectionOrder = [...projections.querySelectorAll("section")]
      .filter(
        (element) =>
          element === decision || element === attachment || element === queue,
      )
      .map((element) =>
        element === decision ? "decision" : element === attachment ? "attachment" : "queue",
      );
    const recoveryTranscript = [...document.querySelectorAll("article.chat-message")]
      .flatMap((element) => {
        const text = element.querySelector(".chat-message__text")?.textContent?.trim() ?? "";
        if (!recoveryTexts.has(text)) return [];
        return [{
          role: element.classList.contains("chat-message--athlete") ? "athlete" : "coach",
          text,
          delivery: element.getAttribute("data-delivery"),
        }];
      });
    return {
      questionCount: [...document.querySelectorAll(".composer-projections section")].filter(
        (element) => element.textContent?.includes(question),
      ).length,
      attachmentCount: document.querySelectorAll(
        'section[aria-label="recovery-tempo.zwo attachment"]',
      ).length,
      selectedWorkoutCount: attachment.querySelectorAll('button[aria-pressed="true"]').length,
      queueCount: [...queue.querySelectorAll(".chat-queue__item")].filter(
        (element) => element.textContent?.includes(queueText),
      ).length,
      planRequestCount: document.querySelectorAll(
        '[data-planning-request-id="' + requestId + '"]',
      ).length,
      planAction: plan.querySelector("button")?.textContent?.trim() ?? "",
      draft: composer.value,
      sendDisabled: send.disabled,
      inputDisabled: composer.disabled,
      projectionOrder,
      recoveryTranscript,
    };
  `);
}

async function readNavigationResetSurface(fixture: RunningDesktopFixture) {
  const recovery = await readRecoverySurface(fixture);
  const navigation = await fixture.evaluate<{
    readonly historyAthleteCount: number;
    readonly historyCoachCount: number;
    readonly interruptedAthleteCount: number;
    readonly interruptedCoachCount: number;
    readonly dialogOpen: boolean;
    readonly dialogBusy: boolean;
    readonly newChatDisabled: boolean;
    readonly newChatAriaDisabled: boolean;
    readonly announcement: string;
  }>(`
    const messages = [...document.querySelectorAll(".chat-message")];
    const opener = document.querySelector(".new-conversation-button");
    const dialog = document.querySelector(".new-conversation-dialog");
    if (!(opener instanceof HTMLButtonElement)) throw new Error("New chat action missing");
    return {
      historyAthleteCount: messages.filter((message) =>
        message.textContent?.includes(${JSON.stringify(historyAthleteText)}),
      ).length,
      historyCoachCount: messages.filter((message) =>
        message.textContent?.includes(${JSON.stringify(historyCoachText)}),
      ).length,
      interruptedAthleteCount: messages.filter((message) =>
        message.textContent?.includes(${JSON.stringify(interruptedAthleteText)}),
      ).length,
      interruptedCoachCount: messages.filter((message) =>
        message.textContent?.includes(${JSON.stringify(interruptedCoachText)}),
      ).length,
      dialogOpen: dialog?.hasAttribute("data-open") === true,
      dialogBusy: dialog?.getAttribute("aria-busy") === "true",
      newChatDisabled: opener.disabled,
      newChatAriaDisabled: opener.getAttribute("aria-disabled") === "true",
      announcement: document.querySelector(".new-conversation-status")?.textContent?.trim() ?? "",
    };
  `);
  return { ...recovery, ...navigation };
}

afterEach(async () => {
  for (const backend of backends) backend.abortPendingReset();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  await Promise.all(backends.splice(0).map((backend) => backend.close()));
  await Promise.all(
    scratchPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

describe.skipIf(process.platform !== "darwin" || !hasLoopback)(
  "Chat durable recovery relaunch",
  () => {
    it("restores queue, decision, attachment draft, and Plan request once in blocking order", async () => {
      const scratch = await mkdtemp(join(await realpath(tmpdir()), "chat-recovery-"));
      scratchPaths.push(scratch);
      const backend = new RecoveryBackend(
        join(scratch, "recovery.sqlite"),
        join(scratch, "conversation"),
        join(scratch, "attachments"),
      );
      backends.push(backend);
      await backend.open();

      const fixture = await launchDesktopFixture({
        script: backend.script,
        token,
        width: 1180,
        height: 820,
        colorScheme: "light",
        reducedMotion: true,
        hidden: process.env.REC_01_VISIBLE === "1" ? false : true,
        routeChatAttachmentComposer: true,
      });
      fixtures.push(fixture);

      expect(
        await fixture.evaluate(`
          const deadline = Date.now() + 5000;
          while (document.querySelector(".chat-surface") === null && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          return {
            projections: document.querySelectorAll(".composer-projections section").length,
            planningRequests: document.querySelectorAll("[data-planning-request-id]").length,
            draft: document.querySelector("#message")?.value ?? null,
          };
        `),
      ).toEqual({ projections: 0, planningRequests: 0, draft: "" });

      await backend.establishDurableState();
      const persisted = await backend.snapshot();
      expect(persisted).toMatchObject({
        queue: {
          items: [
            {
              queuedMessageId,
              messageId: "message-queue-recovery",
              restored: false,
            },
          ],
        },
        decision: { decisionId, status: "unanswered" },
        attachment: {
          draft: {
            chatId,
            text: attachmentDraftText,
            attachments: [
              {
                attachmentId: persisted.attachmentId,
                preview: { selectedWorkoutId: persisted.workoutId },
              },
            ],
          },
        },
        planningRequest: { request: { requestId, revision: 1, lifecycle: "open" } },
        outbox: { state: "delivered", attemptCount: 1 },
      });

      await fixture.relaunch(() => backend.reopen());
      const firstSurface = await readRecoverySurface(fixture);
      expect(firstSurface).toEqual({
        questionCount: 1,
        attachmentCount: 1,
        selectedWorkoutCount: 1,
        queueCount: 1,
        planRequestCount: 1,
        planAction: "Continue in Plan",
        draft: attachmentDraftText,
        sendDisabled: true,
        inputDisabled: false,
        projectionOrder: ["decision", "attachment", "queue"],
        recoveryTranscript: [
          { role: "athlete", text: recoveredAthleteText, delivery: "complete" },
          { role: "coach", text: recoveredPartialText, delivery: "interrupted" },
          { role: "coach", text: recoveredCoachText, delivery: "complete" },
          { role: "athlete", text: laterAthleteText, delivery: "complete" },
          { role: "coach", text: laterCoachText, delivery: "complete" },
        ],
      });
      const firstRecovery = await backend.snapshot();
      expect(firstRecovery).toMatchObject({
        queue: {
          items: [
            {
              queuedMessageId,
              messageId: "message-queue-recovery",
              restored: true,
            },
          ],
        },
        decision: { decisionId, status: "unanswered" },
        attachment: {
          draft: {
            text: attachmentDraftText,
            attachments: [
              {
                attachmentId: persisted.attachmentId,
                preview: { selectedWorkoutId: persisted.workoutId },
              },
            ],
          },
        },
        planningRequest: { request: { requestId, revision: 1, lifecycle: "open" } },
        outbox: { state: "delivered", attemptCount: 1 },
      });

      await fixture.relaunch(() => backend.reopen());
      expect(await readRecoverySurface(fixture)).toEqual(firstSurface);
      expect(await backend.snapshot()).toMatchObject({
        queue: { items: [{ queuedMessageId, restored: true }] },
        decision: { decisionId, status: "unanswered" },
        attachment: {
          draft: {
            text: attachmentDraftText,
            attachments: [
              {
                attachmentId: persisted.attachmentId,
                preview: { selectedWorkoutId: persisted.workoutId },
              },
            ],
          },
        },
        planningRequest: { request: { requestId, revision: 1, lifecycle: "open" } },
        outbox: { state: "delivered", attemptCount: 1 },
      });

      expect(await fixture.close()).toEqual({ livePids: [], listenerCount: 0 });
      fixtures.splice(fixtures.indexOf(fixture), 1);
    }, 120_000);

    it("preserves the complete conversation after one paused ambiguous reset", async () => {
      const scratch = await mkdtemp(join(await realpath(tmpdir()), "chat-reset-uncertain-"));
      scratchPaths.push(scratch);
      const backend = new RecoveryBackend(
        join(scratch, "reset.sqlite"),
        join(scratch, "conversation"),
        join(scratch, "attachments"),
      );
      backends.push(backend);
      await backend.open();
      await backend.establishNavigationState();
      const reset = backend.pauseReset();

      const fixture = await launchDesktopFixture({
        script: backend.script,
        token,
        width: 1180,
        height: 820,
        colorScheme: "light",
        reducedMotion: true,
        hidden: process.env.NAV_03_VISIBLE === "1" ? false : true,
        routeChatAttachmentComposer: true,
      });
      fixtures.push(fixture);

      const initial = await readNavigationResetSurface(fixture);
      expect(initial).toMatchObject({
        questionCount: 1,
        attachmentCount: 1,
        selectedWorkoutCount: 1,
        queueCount: 1,
        planRequestCount: 1,
        draft: attachmentDraftText,
        historyAthleteCount: 1,
        historyCoachCount: 1,
        interruptedAthleteCount: 1,
        interruptedCoachCount: 1,
        dialogOpen: false,
        newChatDisabled: false,
        newChatAriaDisabled: false,
        announcement: "",
      });
      const storedBefore = await backend.snapshot();

      const confirmed = fixture.evaluate<void>(`
        const opener = document.querySelector(".new-conversation-button");
        if (!(opener instanceof HTMLButtonElement) || opener.disabled) {
          throw new Error("New chat is unavailable");
        }
        opener.click();
        const dialogDeadline = Date.now() + 5000;
        let dialog = document.querySelector(".new-conversation-dialog");
        while (dialog === null && Date.now() < dialogDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          dialog = document.querySelector(".new-conversation-dialog");
        }
        const confirm = dialog?.querySelector(".new-conversation-dialog__confirm");
        if (!(confirm instanceof HTMLButtonElement)) throw new Error("Reset confirmation missing");
        confirm.click();
        confirm.click();
        const pendingDeadline = Date.now() + 5000;
        while (
          document.querySelector(".new-conversation-dialog")?.getAttribute("aria-busy") !== "true" &&
          Date.now() < pendingDeadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        if (document.querySelector(".new-conversation-dialog")?.getAttribute("aria-busy") !== "true") {
          throw new Error("Reset confirmation did not become busy");
        }
      `);
      await Promise.all([confirmed, reset.entered]);

      expect(backend.calls.filter((call) => call.method === "resetSession")).toEqual([
        { jsonrpc: "2.0", method: "resetSession", params: { chatId } },
      ]);
      expect(await readNavigationResetSurface(fixture)).toMatchObject({
        questionCount: 1,
        attachmentCount: 1,
        selectedWorkoutCount: 1,
        queueCount: 1,
        planRequestCount: 1,
        draft: attachmentDraftText,
        historyAthleteCount: 1,
        historyCoachCount: 1,
        interruptedAthleteCount: 1,
        interruptedCoachCount: 1,
        dialogOpen: true,
        dialogBusy: true,
        newChatDisabled: true,
        announcement: "",
      });
      const evidenceDirectory = process.env.NAV_03_EVIDENCE_DIR;
      if (evidenceDirectory !== undefined) {
        await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
        await fixture.screenshot(join(evidenceDirectory, "nav-03-reset-pending.png"));
      }
      await visibleQaCheckpoint("nav-03-reset-pending");

      reset.fail(new Error("private ambiguous reset detail"));
      await fixture.evaluate<void>(`
        const expected = ${JSON.stringify(resetUncertaintyCopy)};
        const deadline = Date.now() + 5000;
        while (
          (document.querySelector(".new-conversation-status")?.textContent?.trim() !== expected ||
            document.querySelector(".new-conversation-dialog[data-open]") !== null) &&
          Date.now() < deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        if (document.querySelector(".new-conversation-status")?.textContent?.trim() !== expected) {
          throw new Error("Reset uncertainty did not render");
        }
        if (document.querySelector(".new-conversation-dialog[data-open]") !== null) {
          throw new Error("Reset confirmation did not close");
        }
      `);

      expect(await readNavigationResetSurface(fixture)).toMatchObject({
        questionCount: 1,
        attachmentCount: 1,
        selectedWorkoutCount: 1,
        queueCount: 1,
        planRequestCount: 1,
        draft: attachmentDraftText,
        historyAthleteCount: 1,
        historyCoachCount: 1,
        interruptedAthleteCount: 1,
        interruptedCoachCount: 1,
        dialogOpen: false,
        dialogBusy: false,
        newChatDisabled: false,
        newChatAriaDisabled: true,
        announcement: resetUncertaintyCopy,
      });
      expect(await backend.snapshot()).toEqual(storedBefore);
      if (evidenceDirectory !== undefined) {
        await fixture.screenshot(join(evidenceDirectory, "nav-03-reset-uncertain.png"));
      }
      await visibleQaCheckpoint("nav-03-reset-uncertain");

      expect(
        await fixture.evaluate(`
          const opener = document.querySelector(".new-conversation-button");
          if (!(opener instanceof HTMLButtonElement)) throw new Error("New chat action missing");
          opener.click();
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return document.querySelector(".new-conversation-dialog[data-open]") === null;
        `),
      ).toBe(true);
      expect(backend.calls.filter((call) => call.method === "resetSession")).toHaveLength(1);
      expect(await backend.snapshot()).toEqual(storedBefore);

      expect(await fixture.close()).toEqual({ livePids: [], listenerCount: 0 });
      fixtures.splice(fixtures.indexOf(fixture), 1);
    }, 150_000);
  },
);
