import { createServer } from "node:net";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AnswerCoachDecisionRpcParams,
  CoachDecisionReadModel,
  CoachEngine,
  ResumeCoachDecisionRpcParams,
  StopChatRequest,
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
  createCoachEngine,
  type EngineHostPorts,
  type ModelTransportRequest,
} from "@enduragent/engine";
import type { GenerateResult, Sport } from "@enduragent/engine/sport";
import { afterEach, describe, expect, it } from "vitest";
import {
  launchDesktopFixture,
  visibleQaCheckpoint,
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

const token = "d".repeat(43);
const chatId = "desktop";
const decisionId = "decision-continuation-recovery";
const decisionMessageId = "message-decision-continuation-recovery";
const decisionRequestTurnId = "turn-decision-continuation-request";
const decisionToolCallId = "tool-decision-continuation-request";
const continuationId = "continuation-decision-recovery";
const interruptedTurnId = "turn-decision-interrupted";
const resumedTurnId = "turn-decision-resumed";
const athleteText = "Which workout priority should guide tomorrow?";
const question = "What should guide tomorrow’s workout?";
const choiceLabel = "Protect recovery";
const choiceConsequence = "Tomorrow stays controlled for recovery.";
const partialText = "Keep tomorrow controlled while your legs";
const completedText = "Keep tomorrow controlled, then reassess after the recovery ride.";
const loadFailureCopy = "We couldn’t check for a saved Coach question. Reconnect and try again.";
const attachmentErrorCopy = "We couldn’t update that attachment. Your message draft is preserved.";
const fixtures: RunningDesktopFixture[] = [];
const backends: DecisionContinuationBackend[] = [];
const scratchPaths: string[] = [];

const emptyAttachmentComposer = {
  schemaVersion: 1,
  capabilities: {
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
  },
  draft: null,
} as const;

interface ScriptRequest {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params: Record<string, unknown>;
}

function response(value: unknown): readonly string[] {
  return [JSON.stringify(value)];
}

function generated(text: string): GenerateResult {
  return {
    text,
    toolCalls: [],
    finishReason: "stop",
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
    },
  };
}

const decisionSport = {
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

class DecisionContinuationBackend {
  readonly calls: ScriptRequest[] = [];
  readonly script: DesktopFixtureScript;
  decisionLoadFailures = 0;
  providerCalls = 0;
  private conversation: ConversationStorePort | undefined;
  private engine: CoachEngine | undefined;
  private failNextDecisionLoad = false;
  private instant = Date.UTC(1998, 7, 24, 8);
  private idSequence = 0;

  constructor(private readonly conversationDir: string) {
    const base = createPlanQaFixtureScript("PL-S004");
    this.script = {
      onRequest: async (value) => {
        const request = value as ScriptRequest;
        this.calls.push(request);
        if (request.method === "getCoachDecision") {
          if (this.failNextDecisionLoad) {
            this.failNextDecisionLoad = false;
            this.decisionLoadFailures += 1;
            throw new Error("synthetic decision hydration failure");
          }
          return response(
            await this.requireEngine().getCoachDecision({
              chatId: String(request.params.chatId),
            }),
          );
        }
        if (request.method === "stopChat") {
          const stopChat = this.requireEngine().stopChat;
          if (stopChat === undefined) throw new TypeError("stopChat is unavailable");
          return response(
            await stopChat({
              chatId: String(request.params.chatId),
              turnId: String(request.params.turnId),
            }),
          );
        }
        if (request.method === "getChatQueue") {
          return response(this.requireConversation().getChatQueue(chatId));
        }
        if (request.method === "getChatAttachmentComposer") {
          return response(emptyAttachmentComposer);
        }
        if (request.method === "hasSession") {
          return response(await this.requireEngine().hasSession({ chatId }));
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
        if (request.method === "resumePlanningRequests") return response({ deliveries: [] });
        if (request.method === "listPlanningRequests") {
          return response({ deliveries: [], planCreation: null });
        }
        return base.onRequest(value);
      },
      onStreamRequest: async (value, emitFrame) => {
        const request = value as ScriptRequest;
        this.calls.push(request);
        if (request.method === "answerCoachDecision") {
          const result = await this.requireEngine().answerCoachDecision(
            request.params as unknown as AnswerCoachDecisionRpcParams,
            (event) => emitFrame(JSON.stringify(event)),
          );
          return JSON.stringify(result);
        }
        if (request.method === "resumeCoachDecision") {
          const result = await this.requireEngine().resumeCoachDecision(
            request.params as unknown as ResumeCoachDecisionRpcParams,
            (event) => emitFrame(JSON.stringify(event)),
          );
          return JSON.stringify(result);
        }
        throw new TypeError(`unexpected live fixture method ${request.method}`);
      },
    };
  }

  async open(): Promise<void> {
    await mkdir(this.conversationDir, { recursive: true, mode: 0o700 });
    const conversation = createConversationStore(this.conversationDir);
    this.conversation = conversation;
    const ports: EngineHostPorts = {
      config: {
        dataSource: "platform",
        llm: {
          provider: "openai-codex",
          model: "fixture",
          apiKey: "",
          authProfile: "openai-codex",
        },
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
      transcriptWriter: conversation,
      coachDecisions: conversation,
      secrets: { resolve: async () => "" },
      platform: {
        legacyClient: null,
        athleteData: undefined,
        calendarMutations: createMissingPlatformCalendarMutations(),
      },
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
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
      now: () => ++this.instant,
      randomId: () => this.nextId(),
      modelTransportDecorator: () => ({
        generate: (request) => this.generate(request),
      }),
    };
    this.engine = createCoachEngine({ sport: decisionSport, ports });
  }

  seedDecision(): CoachDecisionReadModel {
    return this.requireConversation().appendDecisionRequested({
      turnId: decisionRequestTurnId,
      toolCallId: decisionToolCallId,
      athleteText,
      requestedAt: "1998-08-24T08:00:00.000Z",
      decision: {
        status: "unanswered",
        decisionId,
        chatId,
        messageId: decisionMessageId,
        question,
        options: [
          {
            id: "recovery",
            label: choiceLabel,
            description: "Keep the next session controlled.",
            recommended: true,
            consequence: choiceConsequence,
          },
          {
            id: "tempo",
            label: "Keep tempo",
            description: "Retain the planned tempo work.",
            recommended: false,
            consequence: "Tomorrow keeps the planned tempo work.",
          },
        ],
      },
    });
  }

  async reopen(failDecisionLoad: boolean): Promise<void> {
    this.conversation = undefined;
    this.engine = undefined;
    await this.open();
    this.failNextDecisionLoad = failDecisionLoad;
  }

  close(): void {
    this.conversation = undefined;
    this.engine = undefined;
  }

  snapshot() {
    return {
      decision: this.requireConversation().getDecision(chatId),
      transcript: this.requireConversation().readCurrentConversationPage(chatId, {
        cursor: null,
        limit: 25,
      }),
    };
  }

  private async generate(request: ModelTransportRequest): Promise<GenerateResult> {
    this.providerCalls += 1;
    if (this.providerCalls === 1) {
      request.options.onTextDelta?.(partialText);
      await new Promise<void>((_resolve, reject) => {
        const signal = request.options.signal;
        const rejectAbort = (): void => reject(signal?.reason ?? new Error("aborted"));
        if (signal?.aborted === true) rejectAbort();
        else signal?.addEventListener("abort", rejectAbort, { once: true });
      });
      throw new TypeError("interrupted provider call did not abort");
    }
    if (this.providerCalls !== 2) throw new TypeError("unexpected decision continuation call");
    request.options.onTextDelta?.(completedText);
    return generated(completedText);
  }

  private nextId(): string {
    const ids = [continuationId, interruptedTurnId, resumedTurnId];
    const id = ids[this.idSequence++];
    if (id === undefined) throw new TypeError("unexpected engine identifier request");
    return id;
  }

  private requireConversation(): ConversationStorePort {
    if (this.conversation === undefined) throw new TypeError("conversation store is closed");
    return this.conversation;
  }

  private requireEngine(): CoachEngine {
    if (this.engine === undefined) throw new TypeError("coach engine is closed");
    return this.engine;
  }
}

async function captureEvidence(fixture: RunningDesktopFixture, name: string): Promise<void> {
  const directory = process.env.DEC_02_EVIDENCE_DIR;
  if (directory === undefined) return;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await fixture.screenshot(join(directory, `${name}.png`));
}

async function checkpoint(fixture: RunningDesktopFixture, name: string): Promise<void> {
  await captureEvidence(fixture, name);
  await visibleQaCheckpoint(name);
}

async function readDecisionPrompt(fixture: RunningDesktopFixture) {
  return fixture.evaluate<{
    readonly questionCount: number;
    readonly recommendedCount: number;
    readonly sendDisabled: boolean;
    readonly inputDisabled: boolean;
  }>(`
    const question = ${JSON.stringify(question)};
    const choice = ${JSON.stringify(choiceLabel)};
    const deadline = Date.now() + 10000;
    let panel;
    while (Date.now() < deadline) {
      panel = [...document.querySelectorAll(".composer-projections section")].find(
        (element) => element.textContent?.includes(question),
      );
      if (panel instanceof HTMLElement) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!(panel instanceof HTMLElement)) throw new Error("decision prompt missing");
    const send = document.querySelector('button[aria-label="Send message"]');
    const input = document.querySelector("textarea#message");
    if (!(send instanceof HTMLButtonElement)) throw new Error("send action missing");
    if (!(input instanceof HTMLTextAreaElement)) throw new Error("chat input missing");
    const recommended = [...panel.querySelectorAll("button")].filter(
      (button) => button.textContent?.includes(choice) && button.textContent?.includes("Recommended"),
    );
    return {
      questionCount: [...document.querySelectorAll(".composer-projections section")].filter(
        (element) => element.textContent?.includes(question),
      ).length,
      recommendedCount: recommended.length,
      sendDisabled: send.disabled,
      inputDisabled: input.disabled,
    };
  `);
}

async function chooseAndReadPartial(fixture: RunningDesktopFixture) {
  return fixture.evaluate<{
    readonly partialCount: number;
    readonly stopCount: number;
    readonly status: string | null;
    readonly choiceCount: number;
  }>(`
    const choice = ${JSON.stringify(choiceLabel)};
    const partial = ${JSON.stringify(partialText)};
    const option = [...document.querySelectorAll(".composer-projections button")].find(
      (button) => button.textContent?.includes(choice),
    );
    if (!(option instanceof HTMLButtonElement)) throw new Error("recommended option missing");
    option.click();
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const coachRows = [...document.querySelectorAll(".chat-message--coach")];
      const stop = document.querySelector('button[aria-label="Stop responding"]');
      if (
        coachRows.some((row) => row.textContent?.includes(partial)) &&
        stop instanceof HTMLButtonElement
      ) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return {
      partialCount: [...document.querySelectorAll(".chat-message--coach")].filter(
        (row) => row.textContent?.includes(partial),
      ).length,
      stopCount: document.querySelectorAll('button[aria-label="Stop responding"]').length,
      status: document.querySelector(".conversation")?.getAttribute("data-chat-status") ?? null,
      choiceCount: document.querySelectorAll('[aria-label="Choice consequence"]').length,
    };
  `);
}

async function stopAndReadInterrupted(fixture: RunningDesktopFixture) {
  return fixture.evaluate<{
    readonly stoppedCopyCount: number;
    readonly status: string | null;
    readonly partialDelivery: string | null;
    readonly athleteCount: number;
    readonly blankAthleteCount: number;
    readonly choiceCount: number;
    readonly genericRetryCount: number;
    readonly decisionRetryCount: number;
    readonly prematureReopenCopyCount: number;
    readonly busyRecoveryCount: number;
    readonly attachmentErrorCount: number;
  }>(`
    const partial = ${JSON.stringify(partialText)};
    const stoppedCopy = "Response stopped. Your partial response is preserved.";
    const attachmentError = ${JSON.stringify(attachmentErrorCopy)};
    const stop = document.querySelector('button[aria-label="Stop responding"]');
    if (!(stop instanceof HTMLButtonElement)) throw new Error("stop action missing");
    stop.click();
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const status = document.querySelector(".conversation")?.getAttribute("data-chat-status");
      const alert = [...document.querySelectorAll('[role="alert"]')].find(
        (element) => element.textContent?.includes(stoppedCopy),
      );
      const buttons = [...document.querySelectorAll("button")];
      const decisionRetry = buttons.find(
        (button) => !button.hidden && button.textContent?.trim() === "Try again",
      );
      const genericRetry = buttons.find(
        (button) => !button.hidden && button.textContent?.trim() === "Retry message",
      );
      if (
        status === "interrupted" &&
        alert instanceof HTMLElement &&
        decisionRetry instanceof HTMLButtonElement &&
        genericRetry === undefined
      ) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const partialRow = [...document.querySelectorAll(".chat-message--coach")].find(
      (row) => row.textContent?.includes(partial),
    );
    const athleteRows = [...document.querySelectorAll(".chat-message--athlete")];
    const buttons = [...document.querySelectorAll("button")];
    const recoverySections = [...document.querySelectorAll(".composer-projections section")].filter(
      (section) => section.textContent?.includes(${JSON.stringify(choiceLabel)}),
    );
    return {
      stoppedCopyCount: [...document.querySelectorAll('[role="alert"]')].filter(
        (element) => element.textContent?.includes(stoppedCopy),
      ).length,
      status: document.querySelector(".conversation")?.getAttribute("data-chat-status") ?? null,
      partialDelivery: partialRow?.getAttribute("data-delivery") ?? null,
      athleteCount: athleteRows.length,
      blankAthleteCount: athleteRows.filter(
        (row) => !row.querySelector(".chat-message__text")?.textContent?.trim(),
      ).length,
      choiceCount: document.querySelectorAll('[aria-label="Choice consequence"]').length,
      genericRetryCount: buttons.filter(
        (button) => !button.hidden && button.textContent?.trim() === "Retry message",
      ).length,
      decisionRetryCount: buttons.filter(
        (button) => !button.hidden && button.textContent?.trim() === "Try again",
      ).length,
      prematureReopenCopyCount: recoverySections.filter((section) =>
        section.textContent?.includes("was saved before Enduragent reopened"),
      ).length,
      busyRecoveryCount: recoverySections.filter(
        (section) => section.getAttribute("aria-busy") === "true",
      ).length,
      attachmentErrorCount: [...document.querySelectorAll('[role="alert"]')].filter(
        (element) => element.textContent?.includes(attachmentError),
      ).length,
    };
  `);
}

async function readLoadFailure(fixture: RunningDesktopFixture) {
  return fixture.evaluate<{
    readonly reconnectCount: number;
    readonly loadFailureCount: number;
    readonly sendDisabled: boolean;
    readonly inputDisabled: boolean;
    readonly choiceCount: number;
    readonly athleteCount: number;
    readonly blankAthleteCount: number;
    readonly partialCount: number;
    readonly partialDelivery: string | null;
    readonly newChatDisabled: boolean;
    readonly attachmentErrorCount: number;
  }>(`
    const failure = ${JSON.stringify(loadFailureCopy)};
    const partial = ${JSON.stringify(partialText)};
    const attachmentError = ${JSON.stringify(attachmentErrorCopy)};
    const deadline = Date.now() + 10000;
    let reconnect;
    let partialRow;
    while (Date.now() < deadline) {
      reconnect = [...document.querySelectorAll(".composer-projections button")].find(
        (button) => button.textContent?.trim() === "Reconnect",
      );
      partialRow = [...document.querySelectorAll(".chat-message--coach")].find(
        (row) => row.textContent?.includes(partial),
      );
      if (reconnect instanceof HTMLButtonElement && partialRow instanceof HTMLElement) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!(reconnect instanceof HTMLButtonElement)) throw new Error("Reconnect action missing");
    if (!(partialRow instanceof HTMLElement)) throw new Error("interrupted response missing");
    const send = document.querySelector('button[aria-label="Send message"]');
    const input = document.querySelector("textarea#message");
    const newChat = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "New chat",
    );
    if (!(send instanceof HTMLButtonElement)) throw new Error("send action missing");
    if (!(input instanceof HTMLTextAreaElement)) throw new Error("chat input missing");
    if (!(newChat instanceof HTMLButtonElement)) throw new Error("New chat action missing");
    const athleteRows = [...document.querySelectorAll(".chat-message--athlete")];
    return {
      reconnectCount: [...document.querySelectorAll(".composer-projections button")].filter(
        (button) => button.textContent?.trim() === "Reconnect",
      ).length,
      loadFailureCount: [...document.querySelectorAll('[role="alert"]')].filter(
        (element) => element.textContent?.includes(failure),
      ).length,
      sendDisabled: send.disabled,
      inputDisabled: input.disabled,
      choiceCount: document.querySelectorAll('[aria-label="Choice consequence"]').length,
      athleteCount: athleteRows.length,
      blankAthleteCount: athleteRows.filter(
        (row) => !row.querySelector(".chat-message__text")?.textContent?.trim(),
      ).length,
      partialCount: [...document.querySelectorAll(".chat-message--coach")].filter(
        (row) => row.textContent?.includes(partial),
      ).length,
      partialDelivery: partialRow.getAttribute("data-delivery"),
      newChatDisabled: newChat.disabled,
      attachmentErrorCount: [...document.querySelectorAll('[role="alert"]')].filter(
        (element) => element.textContent?.includes(attachmentError),
      ).length,
    };
  `);
}

async function reconnectAndReadCompleted(fixture: RunningDesktopFixture) {
  return fixture.evaluate<{
    readonly partialCount: number;
    readonly completedCount: number;
    readonly partialDelivery: string | null;
    readonly completedDelivery: string | null;
    readonly athleteCount: number;
    readonly blankAthleteCount: number;
    readonly choiceCount: number;
    readonly consequenceCount: number;
    readonly sendDisabled: boolean;
    readonly reconnectCount: number;
    readonly timelineOrder: readonly string[];
    readonly attachmentErrorCount: number;
  }>(`
    const partial = ${JSON.stringify(partialText)};
    const completed = ${JSON.stringify(completedText)};
    const consequence = ${JSON.stringify(choiceConsequence)};
    const attachmentError = ${JSON.stringify(attachmentErrorCopy)};
    const reconnect = [...document.querySelectorAll(".composer-projections button")].find(
      (button) => button.textContent?.trim() === "Reconnect",
    );
    if (!(reconnect instanceof HTMLButtonElement)) throw new Error("Reconnect action missing");
    reconnect.click();
    const deadline = Date.now() + 10000;
    let completedRow;
    while (Date.now() < deadline) {
      completedRow = [...document.querySelectorAll(".chat-message--coach")].find(
        (row) => row.textContent?.includes(completed),
      );
      const choice = document.querySelector('[aria-label="Choice consequence"]');
      const send = document.querySelector('button[aria-label="Send message"]');
      if (
        completedRow instanceof HTMLElement &&
        choice instanceof HTMLElement &&
        send instanceof HTMLButtonElement &&
        !send.disabled
      ) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!(completedRow instanceof HTMLElement)) throw new Error("resumed response missing");
    const partialRow = [...document.querySelectorAll(".chat-message--coach")].find(
      (row) => row.textContent?.includes(partial),
    );
    if (!(partialRow instanceof HTMLElement)) throw new Error("interrupted response missing");
    const send = document.querySelector('button[aria-label="Send message"]');
    if (!(send instanceof HTMLButtonElement)) throw new Error("send action missing");
    const athleteRows = [...document.querySelectorAll(".chat-message--athlete")];
    const timelineOrder = [...document.querySelectorAll(".chat-messages article")].map((row) => {
      if (row.getAttribute("aria-label") === "Choice consequence") return "choice";
      if (row.classList.contains("chat-message--athlete")) return "athlete";
      if (row.textContent?.includes(partial)) return "partial";
      if (row.textContent?.includes(completed)) return "completed";
      return "other";
    });
    return {
      partialCount: [...document.querySelectorAll(".chat-message--coach")].filter(
        (row) => row.textContent?.includes(partial),
      ).length,
      completedCount: [...document.querySelectorAll(".chat-message--coach")].filter(
        (row) => row.textContent?.includes(completed),
      ).length,
      partialDelivery: partialRow.getAttribute("data-delivery"),
      completedDelivery: completedRow.getAttribute("data-delivery"),
      athleteCount: athleteRows.length,
      blankAthleteCount: athleteRows.filter(
        (row) => !row.querySelector(".chat-message__text")?.textContent?.trim(),
      ).length,
      choiceCount: document.querySelectorAll('[aria-label="Choice consequence"]').length,
      consequenceCount: [...document.querySelectorAll('[aria-label="Choice consequence"]')].filter(
        (row) => row.textContent?.includes(consequence),
      ).length,
      sendDisabled: send.disabled,
      reconnectCount: [...document.querySelectorAll(".composer-projections button")].filter(
        (button) => button.textContent?.trim() === "Reconnect",
      ).length,
      timelineOrder,
      attachmentErrorCount: [...document.querySelectorAll('[role="alert"]')].filter(
        (element) => element.textContent?.includes(attachmentError),
      ).length,
    };
  `);
}

async function readCompleted(fixture: RunningDesktopFixture) {
  return fixture.evaluate<{
    readonly partialCount: number;
    readonly completedCount: number;
    readonly partialDelivery: string | null;
    readonly completedDelivery: string | null;
    readonly athleteCount: number;
    readonly blankAthleteCount: number;
    readonly choiceCount: number;
    readonly consequenceCount: number;
    readonly sendDisabled: boolean;
    readonly reconnectCount: number;
    readonly timelineOrder: readonly string[];
    readonly attachmentErrorCount: number;
  }>(`
    const partial = ${JSON.stringify(partialText)};
    const completed = ${JSON.stringify(completedText)};
    const consequence = ${JSON.stringify(choiceConsequence)};
    const attachmentError = ${JSON.stringify(attachmentErrorCopy)};
    const deadline = Date.now() + 10000;
    let partialRow;
    let completedRow;
    while (Date.now() < deadline) {
      const rows = [...document.querySelectorAll(".chat-message--coach")];
      partialRow = rows.find((row) => row.textContent?.includes(partial));
      completedRow = rows.find((row) => row.textContent?.includes(completed));
      const choice = document.querySelector('[aria-label="Choice consequence"]');
      if (
        partialRow instanceof HTMLElement &&
        completedRow instanceof HTMLElement &&
        choice instanceof HTMLElement
      ) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!(partialRow instanceof HTMLElement)) throw new Error("interrupted response missing");
    if (!(completedRow instanceof HTMLElement)) throw new Error("completed response missing");
    const send = document.querySelector('button[aria-label="Send message"]');
    if (!(send instanceof HTMLButtonElement)) throw new Error("send action missing");
    const athleteRows = [...document.querySelectorAll(".chat-message--athlete")];
    const timelineOrder = [...document.querySelectorAll(".chat-messages article")].map((row) => {
      if (row.getAttribute("aria-label") === "Choice consequence") return "choice";
      if (row.classList.contains("chat-message--athlete")) return "athlete";
      if (row.textContent?.includes(partial)) return "partial";
      if (row.textContent?.includes(completed)) return "completed";
      return "other";
    });
    return {
      partialCount: [...document.querySelectorAll(".chat-message--coach")].filter(
        (row) => row.textContent?.includes(partial),
      ).length,
      completedCount: [...document.querySelectorAll(".chat-message--coach")].filter(
        (row) => row.textContent?.includes(completed),
      ).length,
      partialDelivery: partialRow.getAttribute("data-delivery"),
      completedDelivery: completedRow.getAttribute("data-delivery"),
      athleteCount: athleteRows.length,
      blankAthleteCount: athleteRows.filter(
        (row) => !row.querySelector(".chat-message__text")?.textContent?.trim(),
      ).length,
      choiceCount: document.querySelectorAll('[aria-label="Choice consequence"]').length,
      consequenceCount: [...document.querySelectorAll('[aria-label="Choice consequence"]')].filter(
        (row) => row.textContent?.includes(consequence),
      ).length,
      sendDisabled: send.disabled,
      reconnectCount: [...document.querySelectorAll(".composer-projections button")].filter(
        (button) => button.textContent?.trim() === "Reconnect",
      ).length,
      timelineOrder,
      attachmentErrorCount: [...document.querySelectorAll('[role="alert"]')].filter(
        (element) => element.textContent?.includes(attachmentError),
      ).length,
    };
  `);
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  for (const backend of backends.splice(0)) backend.close();
  await Promise.all(
    scratchPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

describe.skipIf(process.platform !== "darwin" || !hasLoopback)(
  "Chat decision continuation relaunch",
  () => {
    it(
      "stops, restores, reconnects, and completes one durable decision continuation",
      async () => {
        const scratch = await mkdtemp(
          join(await realpath(tmpdir()), "chat-decision-continuation-"),
        );
        scratchPaths.push(scratch);
        const backend = new DecisionContinuationBackend(join(scratch, "conversation"));
        backends.push(backend);
        await backend.open();
        expect(backend.seedDecision()).toMatchObject({
          status: "unanswered",
          decisionId,
          messageId: decisionMessageId,
        });

        const fixture = await launchDesktopFixture({
          script: backend.script,
          token,
          width: 1180,
          height: 820,
          colorScheme: "light",
          reducedMotion: true,
          hidden: process.env.DEC_02_VISIBLE === "1" ? false : true,
          routeChatAttachmentComposer: true,
        });
        fixtures.push(fixture);

        expect(await readDecisionPrompt(fixture)).toEqual({
          questionCount: 1,
          recommendedCount: 1,
          sendDisabled: true,
          inputDisabled: false,
        });
        expect(await chooseAndReadPartial(fixture)).toEqual({
          partialCount: 1,
          stopCount: 1,
          status: "streaming",
          choiceCount: 0,
        });
        expect(backend.snapshot().decision).toMatchObject({
          status: "answered",
          decisionId,
          answer: { kind: "option", optionId: "recovery" },
          consequence: choiceConsequence,
          continuation: { status: "pending", continuationId },
        });

        expect(await stopAndReadInterrupted(fixture)).toEqual({
          stoppedCopyCount: 1,
          status: "interrupted",
          partialDelivery: "interrupted",
          athleteCount: 1,
          blankAthleteCount: 0,
          choiceCount: 0,
          genericRetryCount: 0,
          decisionRetryCount: 1,
          prematureReopenCopyCount: 0,
          busyRecoveryCount: 0,
          attachmentErrorCount: 0,
        });
        await checkpoint(fixture, "dec-02-stopped-continuation");
        const interrupted = backend.snapshot();
        expect(interrupted.decision).toMatchObject({
          status: "answered",
          decisionId,
          continuation: { status: "pending", continuationId },
        });
        expect(interrupted.transcript).toMatchObject({
          schemaVersion: 2,
          status: "page",
          entries: [
            {
              kind: "decision-requested",
              athleteText,
              decision: { decisionId, messageId: decisionMessageId },
            },
            {
              kind: "decision-answered",
              decisionId,
              continuationId,
              answer: { kind: "option", optionId: "recovery" },
            },
            {
              kind: "turn",
              turnId: interruptedTurnId,
              athleteText: "",
              coachText: partialText,
              delivery: "interrupted",
            },
          ],
        });
        expect(backend.providerCalls).toBe(1);

        await fixture.relaunch(() => backend.reopen(true));
        const failedLoad = await readLoadFailure(fixture);
        await checkpoint(fixture, "dec-02-reconnect-required");
        expect(failedLoad).toEqual({
          reconnectCount: 1,
          loadFailureCount: 1,
          sendDisabled: true,
          inputDisabled: false,
          choiceCount: 0,
          athleteCount: 1,
          blankAthleteCount: 0,
          partialCount: 1,
          partialDelivery: "interrupted",
          newChatDisabled: true,
          attachmentErrorCount: 0,
        });
        expect(backend.decisionLoadFailures).toBe(1);
        expect(backend.providerCalls).toBe(1);
        expect(backend.calls.filter(({ method }) => method === "resumeCoachDecision")).toHaveLength(
          0,
        );

        const completedSurface = await reconnectAndReadCompleted(fixture);
        await checkpoint(fixture, "dec-02-resumed-continuation");
        expect(completedSurface).toEqual({
          partialCount: 1,
          completedCount: 1,
          partialDelivery: "interrupted",
          completedDelivery: "complete",
          athleteCount: 1,
          blankAthleteCount: 0,
          choiceCount: 1,
          consequenceCount: 1,
          sendDisabled: false,
          reconnectCount: 0,
          timelineOrder: ["athlete", "partial", "choice", "completed"],
          attachmentErrorCount: 0,
        });
        const completed = backend.snapshot();
        expect(completed.decision).toMatchObject({
          status: "answered",
          decisionId,
          continuation: {
            status: "completed",
            continuationId,
            turnId: resumedTurnId,
            coachText: completedText,
          },
        });
        expect(completed.transcript).toMatchObject({
          schemaVersion: 2,
          status: "page",
          entries: [
            { kind: "decision-requested", decision: { decisionId } },
            { kind: "decision-answered", decisionId, continuationId },
            { kind: "turn", turnId: interruptedTurnId, delivery: "interrupted" },
            {
              kind: "decision-continuation-completed",
              decisionId,
              continuationId,
              turnId: resumedTurnId,
              coachText: completedText,
            },
          ],
        });
        expect(backend.providerCalls).toBe(2);

        await fixture.relaunch(() => backend.reopen(false));
        const cleanRelaunch = await readCompleted(fixture);
        await checkpoint(fixture, "dec-02-clean-relaunch");
        expect(cleanRelaunch).toEqual(completedSurface);
        expect(backend.snapshot().decision).toEqual(completed.decision);
        expect(backend.providerCalls).toBe(2);
        expect(backend.decisionLoadFailures).toBe(1);

        const answerCalls = backend.calls.filter(({ method }) => method === "answerCoachDecision");
        const stopCalls = backend.calls.filter(({ method }) => method === "stopChat");
        const resumeCalls = backend.calls.filter(({ method }) => method === "resumeCoachDecision");
        const decisionReads = backend.calls.filter(({ method }) => method === "getCoachDecision");
        expect(answerCalls).toHaveLength(1);
        expect(answerCalls[0]?.params).toEqual({
          chatId,
          decisionId,
          answer: { kind: "option", optionId: "recovery" },
        } satisfies AnswerCoachDecisionRpcParams);
        expect(stopCalls).toHaveLength(1);
        expect(stopCalls[0]?.params).toEqual({
          chatId,
          turnId: interruptedTurnId,
        } satisfies StopChatRequest);
        expect(resumeCalls).toHaveLength(1);
        expect(resumeCalls[0]?.params).toEqual({
          chatId,
          decisionId,
        } satisfies ResumeCoachDecisionRpcParams);
        expect(decisionReads).toHaveLength(4);
        expect(decisionReads.every(({ params }) => params.chatId === chatId)).toBe(true);

        expect(await fixture.close()).toEqual({ livePids: [], listenerCount: 0 });
        fixtures.splice(fixtures.indexOf(fixture), 1);
      },
      process.env.DEC_02_VISIBLE === "1" ? 600_000 : 150_000,
    );
  },
);
