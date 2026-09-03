import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatQueueSnapshot } from "@enduragent/coach-contract";
import { createConversationStore, type ConversationStorePort } from "@enduragent/core";
import { afterEach, describe, expect, it } from "vitest";
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

const token = "q".repeat(43);
const chatId = "desktop";
const retryQueuedMessageId = "queued-retry-recovery";
const retryMessageId = "message-retry-recovery";
const retrySubmissionId = "submission-retry-recovery";
const retryText = "Recheck the recovery ride before Tuesday.";
const removableQueuedMessageId = "queued-remove-recovery";
const removableMessageId = "message-remove-recovery";
const removableSubmissionId = "submission-remove-recovery";
const removableText = "Remove this saved pacing note.";
const ordinaryQueuedMessageId = "queued-ordinary-recovery";
const ordinaryMessageId = "message-ordinary-recovery";
const ordinarySubmissionId = "submission-ordinary-recovery";
const ordinaryText = "Explain the pacing change after recovery.";
const commandQueuedMessageId = "queued-command-recovery";
const commandMessageId = "message-command-recovery";
const commandSubmissionId = "submission-command-recovery";
const commandText = "/review";
const recoveryClaimId = "claim-retry-recovery";
const interruptedTurnId = "turn-interrupted-recovery";
const ordinaryTurnId = "turn-ordinary-recovery";
const commandTurnId = "turn-command-recovery";
const interruptedText = "The recovery ride stayed controlled until";
const retriedText = "The recovery ride stayed controlled throughout.";
const ordinaryReply = "Keep the next pacing change gradual.";
const commandReply = "The queued review is complete.";
const removeFailureCopy = "We couldn’t remove that saved message. Try again.";
const visibleQaTimeoutMs = 600_000;
const fixtures: RunningDesktopFixture[] = [];
const backends: QueueRecoveryBackend[] = [];
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

function completedQueueResponse(
  turnId: string,
  text: string,
  snapshot: ChatQueueSnapshot,
): readonly string[] {
  return [
    JSON.stringify({ type: "turn-start", turnId, chatId }),
    JSON.stringify({ type: "final-text", turnId, text }),
    JSON.stringify({ snapshot, response: { text } }),
  ];
}

async function visibleQaCheckpoint(name: string): Promise<void> {
  const gateDirectory = process.env.ENDURAGENT_VISIBLE_QA_GATE_DIR;
  if (gateDirectory === undefined) return;
  if (!/^[a-z0-9-]+$/u.test(name)) throw new TypeError("invalid visible QA checkpoint name");
  await mkdir(gateDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(gateDirectory, `${name}.ready`), "ready\n", { mode: 0o600 });
  const releasePath = join(gateDirectory, `${name}.release`);
  const deadline = Date.now() + visibleQaTimeoutMs;
  while (!existsSync(releasePath)) {
    if (Date.now() >= deadline) throw new Error(`visible QA checkpoint timed out: ${name}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
}

async function captureEvidence(fixture: RunningDesktopFixture, name: string): Promise<void> {
  const directory = process.env.QUE_03_EVIDENCE_DIR;
  if (directory === undefined) return;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await fixture.screenshot(join(directory, `${name}.png`));
}

class QueueRecoveryBackend {
  readonly calls: ScriptRequest[] = [];
  readonly script: DesktopFixtureScript;
  private conversation: ConversationStorePort | undefined;
  private failRemovalRead = false;
  private removalAttempts = 0;

  constructor(private readonly conversationDir: string) {
    const base = createPlanQaFixtureScript("PL-S004");
    this.script = {
      onRequest: async (value) => {
        const request = value as ScriptRequest;
        this.calls.push(request);
        if (request.method === "getChatQueue") {
          return response(this.requireConversation().getChatQueue(chatId));
        }
        if (request.method === "getCoachDecision") return response({ decision: null });
        if (request.method === "getChatAttachmentComposer") {
          return response(emptyAttachmentComposer);
        }
        if (request.method === "resumePlanningRequests") return response({ deliveries: [] });
        if (request.method === "listPlanningRequests") {
          return response({ deliveries: [], planCreation: null });
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
        if (request.method === "removeQueuedChatMessage") {
          const queuedMessageId = String(request.params.queuedMessageId);
          this.removalAttempts += 1;
          if (this.removalAttempts === 1) this.failRemovalRead = true;
          try {
            return response(
              this.requireConversation().removeQueuedChatMessage(chatId, queuedMessageId),
            );
          } finally {
            this.failRemovalRead = false;
          }
        }
        if (request.method === "retryQueuedTurn") {
          const claimId = String(request.params.claimId);
          if (claimId !== recoveryClaimId) throw new TypeError("unexpected recovery claim");
          const conversation = this.requireConversation();
          conversation.retryChatQueueClaim(chatId, claimId, interruptedTurnId);
          conversation.appendCompletedTurn({
            chatId,
            turnId: interruptedTurnId,
            completedAt: "1998-08-24T08:05:00.000Z",
            athleteText: retryText,
            coachText: retriedText,
          });
          return completedQueueResponse(
            interruptedTurnId,
            retriedText,
            conversation.completeChatQueueClaim(chatId, claimId),
          );
        }
        if (request.method === "resumeChatQueue") {
          const conversation = this.requireConversation();
          const before = conversation.getChatQueue(chatId);
          const head = before.items[0];
          if (
            head?.queuedMessageId !== ordinaryQueuedMessageId ||
            before.items[1]?.queuedMessageId !== commandQueuedMessageId
          ) {
            throw new TypeError("unexpected ordinary queue head");
          }
          const claimId = "claim-ordinary-recovery";
          conversation.claimChatQueue(chatId, claimId, ordinaryTurnId, [ordinaryQueuedMessageId]);
          conversation.appendCompletedTurn({
            chatId,
            turnId: ordinaryTurnId,
            completedAt: "1998-08-24T08:10:00.000Z",
            athleteText: ordinaryText,
            coachText: ordinaryReply,
          });
          return completedQueueResponse(
            ordinaryTurnId,
            ordinaryReply,
            conversation.completeChatQueueClaim(chatId, claimId),
          );
        }
        if (request.method === "runQueuedCommand") {
          const queuedMessageId = String(request.params.queuedMessageId);
          if (queuedMessageId !== commandQueuedMessageId) {
            throw new TypeError("unexpected queued command");
          }
          const conversation = this.requireConversation();
          const claimId = "claim-command-recovery";
          conversation.claimChatQueue(chatId, claimId, commandTurnId, [commandQueuedMessageId]);
          conversation.appendCompletedTurn({
            chatId,
            turnId: commandTurnId,
            completedAt: "1998-08-24T08:15:00.000Z",
            athleteText: commandText,
            coachText: commandReply,
          });
          return completedQueueResponse(
            commandTurnId,
            commandReply,
            conversation.completeChatQueueClaim(chatId, claimId),
          );
        }
        return base.onRequest(value);
      },
    };
  }

  async open(): Promise<void> {
    await mkdir(this.conversationDir, { recursive: true, mode: 0o700 });
    this.conversation = createConversationStore(this.conversationDir, 0, {
      chatQueueHooks: {
        afterFileRead: () => {
          if (!this.failRemovalRead) return;
          this.failRemovalRead = false;
          throw new Error("synthetic durable queue removal failure");
        },
      },
    });
  }

  establishRecovery(): ChatQueueSnapshot {
    const conversation = this.requireConversation();
    conversation.enqueueChatMessage(
      chatId,
      retrySubmissionId,
      retryText,
      retryQueuedMessageId,
      retryMessageId,
    );
    conversation.enqueueChatMessage(
      chatId,
      removableSubmissionId,
      removableText,
      removableQueuedMessageId,
      removableMessageId,
    );
    conversation.enqueueChatMessage(
      chatId,
      ordinarySubmissionId,
      ordinaryText,
      ordinaryQueuedMessageId,
      ordinaryMessageId,
    );
    conversation.enqueueChatMessage(
      chatId,
      commandSubmissionId,
      commandText,
      commandQueuedMessageId,
      commandMessageId,
    );
    conversation.claimChatQueue(chatId, recoveryClaimId, interruptedTurnId, [retryQueuedMessageId]);
    const snapshot = conversation.requireChatQueueRetry(chatId, recoveryClaimId);
    if (conversation.appendInterruptedTurn === undefined) {
      throw new TypeError("Interrupted transcript persistence is unavailable");
    }
    conversation.appendInterruptedTurn({
      chatId,
      turnId: interruptedTurnId,
      completedAt: "1998-08-24T08:00:00.000Z",
      athleteText: retryText,
      coachText: interruptedText,
    });
    return snapshot;
  }

  async reopen(): Promise<void> {
    this.conversation = undefined;
    await this.open();
  }

  close(): void {
    this.conversation = undefined;
  }

  snapshot(): ChatQueueSnapshot {
    return this.requireConversation().getChatQueue(chatId);
  }

  removalAttemptCount(): number {
    return this.removalAttempts;
  }

  private requireConversation(): ConversationStorePort {
    if (this.conversation === undefined) throw new TypeError("Conversation store is closed");
    return this.conversation;
  }
}

async function readQueueSurface(fixture: RunningDesktopFixture) {
  return fixture.evaluate<{
    readonly queueTexts: readonly string[];
    readonly retryVisible: boolean;
    readonly retryEnabled: boolean;
    readonly runVisible: boolean;
    readonly runEnabled: boolean;
    readonly removeEnabled: readonly boolean[];
    readonly error: string;
    readonly retryAthleteCount: number;
    readonly retryCoachCount: number;
    readonly ordinaryAthleteCount: number;
    readonly ordinaryCoachCount: number;
    readonly commandAthleteCount: number;
    readonly commandCoachCount: number;
  }>(`
    const expected = ${JSON.stringify([retryText, removableText, ordinaryText, commandText])};
    const deadline = Date.now() + 10000;
    let queue;
    while (Date.now() < deadline) {
      queue = document.querySelector("section.chat-queue");
      const texts = [...(queue?.querySelectorAll(".chat-queue__text") ?? [])].map(
        (node) => node.textContent?.trim() ?? "",
      );
      const transcript = [...document.querySelectorAll(".chat-message")];
      if (
        JSON.stringify(texts) === JSON.stringify(expected) &&
        transcript.some((message) => message.textContent?.includes(${JSON.stringify(retryText)})) &&
        transcript.some((message) => message.textContent?.includes(${JSON.stringify(interruptedText)}))
      ) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const messages = [...document.querySelectorAll(".chat-message")];
    const count = (text) => messages.filter((message) => message.textContent?.includes(text)).length;
    const retry = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Retry interrupted message",
    );
    const run = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Run command",
    );
    return {
      queueTexts: [...(queue?.querySelectorAll(".chat-queue__text") ?? [])].map(
        (node) => node.textContent?.trim() ?? "",
      ),
      retryVisible: retry instanceof HTMLButtonElement,
      retryEnabled: retry instanceof HTMLButtonElement && !retry.disabled,
      runVisible: run instanceof HTMLButtonElement,
      runEnabled: run instanceof HTMLButtonElement && !run.disabled,
      removeEnabled: [...(queue?.querySelectorAll(".chat-queue__remove") ?? [])].map(
        (button) => button instanceof HTMLButtonElement && !button.disabled,
      ),
      error: queue?.querySelector('[role="status"].text-danger')?.textContent?.trim() ?? "",
      retryAthleteCount: count(${JSON.stringify(retryText)}),
      retryCoachCount: count(${JSON.stringify(interruptedText)}),
      ordinaryAthleteCount: count(${JSON.stringify(ordinaryText)}),
      ordinaryCoachCount: count(${JSON.stringify(ordinaryReply)}),
      commandAthleteCount: count(${JSON.stringify(commandText)}),
      commandCoachCount: count(${JSON.stringify(commandReply)}),
    };
  `);
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  backends.splice(0).forEach((backend) => backend.close());
  await Promise.all(
    scratchPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

describe.skipIf(process.platform !== "darwin" || !hasLoopback)(
  "Chat durable queue relaunch",
  () => {
    it(
      "restores actionable queue recovery and drains only through explicit barriers",
      async () => {
        const scratch = await mkdtemp(join(await realpath(tmpdir()), "chat-queue-relaunch-"));
        scratchPaths.push(scratch);
        const backend = new QueueRecoveryBackend(join(scratch, "conversation"));
        backends.push(backend);
        await backend.open();

        const fixture = await launchDesktopFixture({
          script: backend.script,
          token,
          width: 1180,
          height: 820,
          colorScheme: "light",
          reducedMotion: true,
          routeChatAttachmentComposer: true,
          hidden: process.env.QUE_03_VISIBLE === "1" ? false : true,
        });
        fixtures.push(fixture);

        expect(
          await fixture.evaluate(`
          const deadline = Date.now() + 5000;
          while (document.querySelector(".chat-surface") === null && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          return {
            queue: document.querySelector("section.chat-queue") !== null,
            messages: document.querySelectorAll(".chat-message").length,
          };
        `),
        ).toEqual({ queue: false, messages: 0 });
        expect(backend.calls.filter((call) => call.method === "resumeChatQueue")).toEqual([]);

        let seeded!: ChatQueueSnapshot;
        await fixture.relaunch(async () => {
          seeded = backend.establishRecovery();
          await backend.reopen();
        });
        expect(seeded).toMatchObject({
          revision: 6,
          items: [
            {
              queuedMessageId: retryQueuedMessageId,
              messageId: retryMessageId,
              submissionId: retrySubmissionId,
              restored: false,
            },
            {
              queuedMessageId: removableQueuedMessageId,
              messageId: removableMessageId,
              submissionId: removableSubmissionId,
              restored: false,
            },
            {
              queuedMessageId: ordinaryQueuedMessageId,
              messageId: ordinaryMessageId,
              submissionId: ordinarySubmissionId,
              restored: false,
            },
            {
              queuedMessageId: commandQueuedMessageId,
              messageId: commandMessageId,
              submissionId: commandSubmissionId,
              restored: false,
            },
          ],
          retryRequired: {
            claimId: recoveryClaimId,
            queuedMessageIds: [retryQueuedMessageId],
            turnId: interruptedTurnId,
            status: "retry-required",
          },
        });

        const restored = await readQueueSurface(fixture);
        expect(restored).toEqual({
          queueTexts: [retryText, removableText, ordinaryText, commandText],
          retryVisible: true,
          retryEnabled: true,
          runVisible: true,
          runEnabled: false,
          removeEnabled: [false, true, true, true],
          error: "",
          retryAthleteCount: 1,
          retryCoachCount: 1,
          ordinaryAthleteCount: 0,
          ordinaryCoachCount: 0,
          commandAthleteCount: 0,
          commandCoachCount: 0,
        });
        const beforeRemovalFailure = backend.snapshot();
        expect(beforeRemovalFailure).toMatchObject({
          revision: 6,
          items: [
            {
              queuedMessageId: retryQueuedMessageId,
              messageId: retryMessageId,
              submissionId: retrySubmissionId,
              restored: true,
            },
            {
              queuedMessageId: removableQueuedMessageId,
              messageId: removableMessageId,
              submissionId: removableSubmissionId,
              restored: true,
            },
            {
              queuedMessageId: ordinaryQueuedMessageId,
              messageId: ordinaryMessageId,
              submissionId: ordinarySubmissionId,
              restored: true,
            },
            {
              queuedMessageId: commandQueuedMessageId,
              messageId: commandMessageId,
              submissionId: commandSubmissionId,
              restored: true,
            },
          ],
          retryRequired: { claimId: recoveryClaimId, queuedMessageIds: [retryQueuedMessageId] },
        });
        expect(backend.calls.filter((call) => call.method === "resumeChatQueue")).toEqual([]);
        await captureEvidence(fixture, "que-03-restored-recovery");
        await visibleQaCheckpoint("que-03-restored-recovery");

        await fixture.evaluate<void>(`
        const remove = document.querySelector('button[aria-label="Remove queued message 2"]');
        if (!(remove instanceof HTMLButtonElement) || remove.disabled) {
          throw new Error("Removable queued message is unavailable");
        }
        remove.focus();
        remove.click();
      `);
        const failedRemoval = await fixture.evaluate<{
          readonly texts: readonly string[];
          readonly copy: string;
          readonly rawFailureMissing: boolean;
          readonly removeEnabled: boolean;
          readonly removeFocused: boolean;
          readonly retryEnabled: boolean;
          readonly runEnabled: boolean;
        }>(`
        const expectedCopy = ${JSON.stringify(removeFailureCopy)};
        const deadline = Date.now() + 5000;
        let copy = "";
        while (Date.now() < deadline) {
          copy = document.querySelector("section.chat-queue .text-danger")?.textContent?.trim() ?? "";
          if (copy === expectedCopy) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const remove = document.querySelector('button[aria-label="Remove queued message 2"]');
        const retry = [...document.querySelectorAll("button")].find(
          (button) => button.textContent?.trim() === "Retry interrupted message",
        );
        const run = [...document.querySelectorAll("button")].find(
          (button) => button.textContent?.trim() === "Run command",
        );
        return {
          texts: [...document.querySelectorAll(".chat-queue__text")].map(
            (node) => node.textContent?.trim() ?? "",
          ),
          copy,
          rawFailureMissing: !document.body.textContent?.includes(
            "synthetic durable queue removal failure",
          ),
          removeEnabled: remove instanceof HTMLButtonElement && !remove.disabled,
          removeFocused: document.activeElement === remove,
          retryEnabled: retry instanceof HTMLButtonElement && !retry.disabled,
          runEnabled: run instanceof HTMLButtonElement && !run.disabled,
        };
      `);
        expect(failedRemoval).toEqual({
          texts: [retryText, removableText, ordinaryText, commandText],
          copy: removeFailureCopy,
          rawFailureMissing: true,
          removeEnabled: true,
          removeFocused: true,
          retryEnabled: true,
          runEnabled: false,
        });
        expect(backend.removalAttemptCount()).toBe(1);
        expect(backend.snapshot()).toEqual(beforeRemovalFailure);
        await captureEvidence(fixture, "que-03-removal-failed");
        await visibleQaCheckpoint("que-03-removal-failed");

        const removed = await fixture.evaluate<{
          readonly texts: readonly string[];
          readonly error: string;
          readonly retryEnabled: boolean;
          readonly runEnabled: boolean;
        }>(`
        const remove = document.querySelector('button[aria-label="Remove queued message 2"]');
        if (!(remove instanceof HTMLButtonElement) || remove.disabled) {
          throw new Error("Removal retry is unavailable");
        }
        remove.click();
        const deadline = Date.now() + 5000;
        while (
          [...document.querySelectorAll(".chat-queue__text")].some(
            (node) => node.textContent?.trim() === ${JSON.stringify(removableText)},
          ) &&
          Date.now() < deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const retry = [...document.querySelectorAll("button")].find(
          (button) => button.textContent?.trim() === "Retry interrupted message",
        );
        const run = [...document.querySelectorAll("button")].find(
          (button) => button.textContent?.trim() === "Run command",
        );
        return {
          texts: [...document.querySelectorAll(".chat-queue__text")].map(
            (node) => node.textContent?.trim() ?? "",
          ),
          error: document.querySelector("section.chat-queue .text-danger")?.textContent?.trim() ?? "",
          retryEnabled: retry instanceof HTMLButtonElement && !retry.disabled,
          runEnabled: run instanceof HTMLButtonElement && !run.disabled,
        };
      `);
        expect(removed).toEqual({
          texts: [retryText, ordinaryText, commandText],
          error: "",
          retryEnabled: true,
          runEnabled: false,
        });
        expect(backend.removalAttemptCount()).toBe(2);
        expect(backend.snapshot()).toMatchObject({
          revision: 7,
          items: [
            { queuedMessageId: retryQueuedMessageId, messageId: retryMessageId },
            { queuedMessageId: ordinaryQueuedMessageId, messageId: ordinaryMessageId },
            { queuedMessageId: commandQueuedMessageId, messageId: commandMessageId },
          ],
          retryRequired: {
            claimId: recoveryClaimId,
            queuedMessageIds: [retryQueuedMessageId],
            turnId: interruptedTurnId,
          },
        });

        await fixture.evaluate<void>(`
        const retry = [...document.querySelectorAll("button")].find(
          (button) => button.textContent?.trim() === "Retry interrupted message",
        );
        if (!(retry instanceof HTMLButtonElement) || retry.disabled) {
          throw new Error("Queue recovery is unavailable");
        }
        retry.click();
        const deadline = Date.now() + 10000;
        while (
          !(
            document.querySelectorAll(".chat-queue__text").length === 1 &&
            document.querySelector(".chat-queue__text")?.textContent?.trim() ===
              ${JSON.stringify(commandText)} &&
            [...document.querySelectorAll("button")].some(
              (button) => button.textContent?.trim() === "Run command" && !button.disabled,
            ) &&
            [...document.querySelectorAll(".chat-message")].some(
              (message) => message.textContent?.includes(${JSON.stringify(ordinaryReply)}),
            ) &&
            document.querySelector(".conversation")?.getAttribute("data-chat-status") === "idle"
          ) &&
          Date.now() < deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      `);
        const commandWaiting = await fixture.evaluate<{
          readonly queueTexts: readonly string[];
          readonly runEnabled: boolean;
          readonly retryCount: number;
          readonly retryAthleteCount: number;
          readonly retryCoachCount: number;
          readonly removableAthleteCount: number;
          readonly ordinaryAthleteCount: number;
          readonly ordinaryCoachCount: number;
          readonly commandAthleteCount: number;
          readonly commandCoachCount: number;
        }>(`
        const messages = [...document.querySelectorAll(".chat-message")];
        const count = (text) => messages.filter((message) => message.textContent?.includes(text)).length;
        const run = [...document.querySelectorAll("button")].find(
          (button) => button.textContent?.trim() === "Run command",
        );
        return {
          queueTexts: [...document.querySelectorAll(".chat-queue__text")].map(
            (node) => node.textContent?.trim() ?? "",
          ),
          runEnabled: run instanceof HTMLButtonElement && !run.disabled,
          retryCount: [...document.querySelectorAll("button")].filter(
            (button) => button.textContent?.trim() === "Retry interrupted message",
          ).length,
          retryAthleteCount: count(${JSON.stringify(retryText)}),
          retryCoachCount: count(${JSON.stringify(retriedText)}),
          removableAthleteCount: count(${JSON.stringify(removableText)}),
          ordinaryAthleteCount: count(${JSON.stringify(ordinaryText)}),
          ordinaryCoachCount: count(${JSON.stringify(ordinaryReply)}),
          commandAthleteCount: count(${JSON.stringify(commandText)}),
          commandCoachCount: count(${JSON.stringify(commandReply)}),
        };
      `);
        expect(commandWaiting).toEqual({
          queueTexts: [commandText],
          runEnabled: true,
          retryCount: 0,
          retryAthleteCount: 1,
          retryCoachCount: 1,
          removableAthleteCount: 0,
          ordinaryAthleteCount: 1,
          ordinaryCoachCount: 1,
          commandAthleteCount: 0,
          commandCoachCount: 0,
        });
        expect(backend.snapshot()).toMatchObject({
          revision: 11,
          items: [
            {
              queuedMessageId: commandQueuedMessageId,
              messageId: commandMessageId,
              restored: true,
            },
          ],
        });
        expect(backend.snapshot().retryRequired).toBeUndefined();
        expect(backend.calls.filter((call) => call.method === "retryQueuedTurn")).toEqual([
          {
            jsonrpc: "2.0",
            method: "retryQueuedTurn",
            params: { chatId, claimId: recoveryClaimId },
          },
        ]);
        expect(backend.calls.filter((call) => call.method === "resumeChatQueue")).toEqual([
          { jsonrpc: "2.0", method: "resumeChatQueue", params: { chatId } },
        ]);
        expect(backend.calls.filter((call) => call.method === "runQueuedCommand")).toEqual([]);
        expect(
          backend.calls
            .filter((call) =>
              ["retryQueuedTurn", "resumeChatQueue", "runQueuedCommand"].includes(call.method),
            )
            .map((call) => call.method),
        ).toEqual(["retryQueuedTurn", "resumeChatQueue"]);
        await captureEvidence(fixture, "que-03-command-waiting");
        await visibleQaCheckpoint("que-03-command-waiting");

        await fixture.evaluate<void>(`
        const run = [...document.querySelectorAll("button")].find(
          (button) => button.textContent?.trim() === "Run command",
        );
        if (
          !(run instanceof HTMLButtonElement) ||
          run.disabled ||
          document.querySelector(".conversation")?.getAttribute("data-chat-status") !== "idle"
        ) {
          throw new Error("Restored command is unavailable");
        }
        run.click();
        const deadline = Date.now() + 5000;
        while (document.querySelector("section.chat-queue") !== null && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      `);
        expect(backend.snapshot()).toEqual({ schemaVersion: 1, revision: 13, items: [] });
        expect(backend.calls.filter((call) => call.method === "runQueuedCommand")).toEqual([
          {
            jsonrpc: "2.0",
            method: "runQueuedCommand",
            params: { chatId, queuedMessageId: commandQueuedMessageId },
          },
        ]);
        expect(backend.calls.filter((call) => call.method === "removeQueuedChatMessage")).toEqual([
          {
            jsonrpc: "2.0",
            method: "removeQueuedChatMessage",
            params: { chatId, queuedMessageId: removableQueuedMessageId },
          },
          {
            jsonrpc: "2.0",
            method: "removeQueuedChatMessage",
            params: { chatId, queuedMessageId: removableQueuedMessageId },
          },
        ]);
        expect(
          await fixture.evaluate(`
          const messages = [...document.querySelectorAll(".chat-message")];
          const count = (text) => messages.filter((message) => message.textContent?.includes(text)).length;
          return {
            queueMissing: document.querySelector("section.chat-queue") === null,
            idle: document.querySelector(".conversation")?.getAttribute("data-chat-status") === "idle",
            retryAthleteCount: count(${JSON.stringify(retryText)}),
            retryCoachCount: count(${JSON.stringify(retriedText)}),
            removableAthleteCount: count(${JSON.stringify(removableText)}),
            ordinaryAthleteCount: count(${JSON.stringify(ordinaryText)}),
            ordinaryCoachCount: count(${JSON.stringify(ordinaryReply)}),
            commandAthleteCount: count(${JSON.stringify(commandText)}),
            commandCoachCount: count(${JSON.stringify(commandReply)}),
          };
        `),
        ).toEqual({
          queueMissing: true,
          idle: true,
          retryAthleteCount: 1,
          retryCoachCount: 1,
          removableAthleteCount: 0,
          ordinaryAthleteCount: 1,
          ordinaryCoachCount: 1,
          commandAthleteCount: 1,
          commandCoachCount: 1,
        });
        expect(
          backend.calls
            .filter((call) =>
              ["retryQueuedTurn", "resumeChatQueue", "runQueuedCommand"].includes(call.method),
            )
            .map((call) => call.method),
        ).toEqual(["retryQueuedTurn", "resumeChatQueue", "runQueuedCommand"]);
        await captureEvidence(fixture, "que-03-complete");
        await visibleQaCheckpoint("que-03-complete");

        const completedSnapshot = backend.snapshot();
        const completedExecutionCalls = backend.calls.filter((call) =>
          ["retryQueuedTurn", "resumeChatQueue", "runQueuedCommand"].includes(call.method),
        );
        await fixture.relaunch(() => backend.reopen());
        const terminalRelaunch = await fixture.evaluate<{
          readonly queueMissing: boolean;
          readonly idle: boolean;
          readonly athleteTexts: readonly string[];
          readonly retryAthleteCount: number;
          readonly retryCoachCount: number;
          readonly ordinaryAthleteCount: number;
          readonly ordinaryCoachCount: number;
          readonly commandAthleteCount: number;
          readonly commandCoachCount: number;
        }>(`
        const deadline = Date.now() + 10000;
        while (
          !(
            document.querySelector(".conversation")?.getAttribute("data-chat-status") === "idle" &&
            [...document.querySelectorAll(".chat-message")].some(
              (message) => message.textContent?.includes(${JSON.stringify(commandReply)}),
            )
          ) &&
          Date.now() < deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const messages = [...document.querySelectorAll(".chat-message")];
        const count = (text) => messages.filter((message) => message.textContent?.includes(text)).length;
        return {
          queueMissing: document.querySelector("section.chat-queue") === null,
          idle: document.querySelector(".conversation")?.getAttribute("data-chat-status") === "idle",
          athleteTexts: [...document.querySelectorAll(".chat-message--athlete .chat-message__text")].map(
            (message) => message.textContent?.trim() ?? "",
          ),
          retryAthleteCount: count(${JSON.stringify(retryText)}),
          retryCoachCount: count(${JSON.stringify(retriedText)}),
          ordinaryAthleteCount: count(${JSON.stringify(ordinaryText)}),
          ordinaryCoachCount: count(${JSON.stringify(ordinaryReply)}),
          commandAthleteCount: count(${JSON.stringify(commandText)}),
          commandCoachCount: count(${JSON.stringify(commandReply)}),
        };
      `);
        expect(terminalRelaunch).toEqual({
          queueMissing: true,
          idle: true,
          athleteTexts: [retryText, ordinaryText, commandText],
          retryAthleteCount: 1,
          retryCoachCount: 1,
          ordinaryAthleteCount: 1,
          ordinaryCoachCount: 1,
          commandAthleteCount: 1,
          commandCoachCount: 1,
        });
        expect(backend.snapshot()).toEqual(completedSnapshot);
        expect(
          backend.calls.filter((call) =>
            ["retryQueuedTurn", "resumeChatQueue", "runQueuedCommand"].includes(call.method),
          ),
        ).toEqual(completedExecutionCalls);
        await captureEvidence(fixture, "que-03-terminal-relaunch");
        await visibleQaCheckpoint("que-03-terminal-relaunch");

        expect(await fixture.close()).toEqual({ livePids: [], listenerCount: 0 });
        fixtures.splice(fixtures.indexOf(fixture), 1);
      },
      process.env.QUE_03_VISIBLE === "1" ? visibleQaTimeoutMs : 120_000,
    );
  },
);
