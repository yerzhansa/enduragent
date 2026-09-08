import { writeFile } from "node:fs/promises";
import { expect, test as base, type Browser, type Page } from "@playwright/test";
import {
  launchDesktopFixture,
  type DesktopFixtureScript,
  type RunningDesktopFixture,
} from "../../helpers/desktop-fixture.js";

const token = "p".repeat(43);
const turnId = "turn-playwright-chat";

interface ScriptRequest {
  readonly jsonrpc: "2.0";
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

export interface ScriptedCoach {
  waitForPrompt(expected: string): Promise<void>;
  emitText(delta: string): void;
  finish(finalText: string): void;
}

interface ScriptedTurn {
  readonly coach: ScriptedCoach;
  run(prompt: string, emitFrame: (frame: string) => void): Promise<string>;
  abort(): void;
}

interface ChatDesktop {
  readonly page: Page;
  readonly coach: ScriptedCoach;
}

interface ChatDesktopFixtures {
  readonly chatDesktop: ChatDesktop;
}

const readySetupStatus = {
  schemaVersion: 1,
  intake: {
    swim_skill_floor: null,
    continuous_distance_capable: null,
    open_water_comfort: null,
    prior_bsi: false,
    clinician_cleared: null,
    injury_status: "none",
  },
  durableTrainingData: true,
} as const;

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
      checkedAt: "1998-08-26T00:00:00.000Z",
    },
  },
  draft: null,
} as const;

function response(value: unknown): readonly string[] {
  return [JSON.stringify(value)];
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function createScriptedTurn(): ScriptedTurn {
  const prompt = deferred<string>();
  let emitFrame: ((frame: string) => void) | undefined;
  let outcome: ReturnType<typeof deferred<string>> | undefined;
  let streamedText = "";
  let settled = false;
  return {
    coach: {
      async waitForPrompt(expected) {
        const actual = await bounded(prompt.promise, 10_000, "Chat prompt did not reach Coach");
        if (actual !== expected) {
          throw new Error(`Coach received an unexpected prompt: ${JSON.stringify(actual)}`);
        }
      },
      emitText(delta) {
        if (settled || emitFrame === undefined || delta.length === 0) {
          throw new Error("Coach stream is not active");
        }
        streamedText += delta;
        emitFrame(JSON.stringify({ type: "text_delta", turnId, delta }));
      },
      finish(finalText) {
        if (settled || emitFrame === undefined || outcome === undefined) {
          throw new Error("Coach stream is not active");
        }
        if (finalText !== streamedText) {
          throw new Error("Coach final text does not match its streamed text");
        }
        settled = true;
        emitFrame(JSON.stringify({ type: "final-text", turnId, text: finalText }));
        outcome.resolve(finalText);
      },
    },
    async run(nextPrompt, nextEmitFrame) {
      if (settled || emitFrame !== undefined) throw new Error("Coach stream already started");
      emitFrame = nextEmitFrame;
      outcome = deferred<string>();
      emitFrame(JSON.stringify({ type: "turn-start", turnId, chatId: "desktop" }));
      prompt.resolve(nextPrompt);
      return await outcome.promise;
    },
    abort() {
      if (settled) return;
      settled = true;
      outcome?.reject(new Error("Coach fixture closed"));
    },
  };
}

function createScript(turn: ScriptedTurn): DesktopFixtureScript {
  let hasSession = false;
  let queueRevision = 0;
  let queueItems: QueuedMessage[] = [];
  const queueSnapshot = () => ({
    schemaVersion: 1 as const,
    revision: queueRevision,
    items: queueItems,
  });

  return {
    async onStreamRequest(value, emitFrame) {
      const request = value as ScriptRequest;
      if (request.method !== "resumeChatQueue") {
        throw new Error(`Unexpected streamed Coach request: ${request.method}`);
      }
      const queued = queueItems[0];
      if (queued === undefined || queueItems.length !== 1) {
        throw new Error("Coach stream requires one queued prompt");
      }
      hasSession = true;
      const finalText = await turn.run(queued.text, emitFrame);
      queueItems = [];
      queueRevision += 1;
      return JSON.stringify({ snapshot: queueSnapshot(), response: { text: finalText } });
    },
    onRequest(value) {
      const request = value as ScriptRequest;
      if (request.method === "getAthleteState") {
        return response({
          schemaVersion: "1",
          lastUpdated: "1998-08-26T08:00:00.000Z",
          freshness: "fresh",
          degraded: false,
          lastSynced: null,
          athleteProfile: {},
          currentStatus: {},
          derivedMetrics: {},
          recentActivities: [],
          plannedWorkouts: [],
          wellness: {},
        });
      }
      if (request.method === "getSetupStatus") return response(readySetupStatus);
      if (request.method === "getLanguagePreference") {
        return response({ value: null });
      }
      if (request.method === "setLanguagePreference") {
        return response(request.params);
      }
      if (request.method === "getUnitsPreference") {
        return response({ value: "metric", source: "default" });
      }
      if (request.method === "setUnitsPreference") {
        return response({ value: "metric", source: "cycling" });
      }
      if (request.method === "getChatQueue") return response(queueSnapshot());
      if (
        request.method === "getChatAttachmentComposer" ||
        request.method === "saveChatAttachmentDraftText" ||
        request.method === "removeChatAttachment" ||
        request.method === "retryChatAttachment" ||
        request.method === "selectChatAttachmentWorkout" ||
        request.method === "clearChatAttachmentDraft"
      ) {
        return response(emptyAttachmentComposer);
      }
      if (request.method === "enqueueChatMessage") {
        const params = request.params as {
          readonly submissionId: string;
          readonly text: string;
          readonly attachmentIds?: readonly string[];
        };
        if (!queueItems.some((item) => item.submissionId === params.submissionId)) {
          queueRevision += 1;
          queueItems.push({
            queuedMessageId: `queued-${queueRevision}`,
            messageId: `message-${queueRevision}`,
            submissionId: params.submissionId,
            attachmentIds: params.attachmentIds ?? [],
            text: params.text,
            kind: params.text.trimStart().startsWith("/") ? "slash-command" : "ordinary",
            position: queueItems.length,
            restored: false,
          });
        }
        return response(queueSnapshot());
      }
      if (request.method === "removeQueuedChatMessage") {
        const queuedMessageId = (request.params as { readonly queuedMessageId: string })
          .queuedMessageId;
        queueItems = queueItems
          .filter((item) => item.queuedMessageId !== queuedMessageId)
          .map((item, position) => ({ ...item, position }));
        queueRevision += 1;
        return response(queueSnapshot());
      }
      if (request.method === "hasSession") return response({ hasSession });
      if (request.method === "getCoachDecision") return response({ decision: null });
      if (request.method === "getTranscriptPage") {
        return response({ schemaVersion: 1, status: "page", turns: [], nextCursor: null });
      }
      if (request.method === "listArchivedConversations") {
        return response({ schemaVersion: 1, conversations: [], truncated: false });
      }
      if (request.method === "getArchivedTranscriptPage") {
        return response({ schemaVersion: 1, status: "page", turns: [], nextCursor: null });
      }
      if (request.method === "deleteArchivedConversation") {
        return response({ schemaVersion: 1, status: "not-found" });
      }
      if (request.method === "resetSession") {
        hasSession = false;
        queueItems = [];
        queueRevision += 1;
        return response({ memoryFlushed: true });
      }
      if (request.method === "sync") {
        return response({
          schemaVersion: 1,
          published: false,
          referenceSucceeded: true,
          requests: { store: 0, reference: 0, total: 0 },
          droppedActivities: {
            overall: { total: 0, visible: 0, restrictions: [], other: 0 },
            recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
          },
        });
      }
      if (request.method === "importFiles") {
        return response({
          schemaVersion: 2,
          files: { total: 1, imported: 1, quarantined: 0 },
          changes: {
            rawFilesInserted: 1,
            sourceRecordsInserted: 1,
            sourceRecordsUpdated: 0,
            relinkedSourceRecords: 0,
          },
          publication: { scope: "activities-and-streams", status: "available" },
        });
      }
      if (request.method === "saveIntake") {
        return response({ schemaVersion: 1, saved: true });
      }
      if (request.method === "configureRuntime") {
        return response({
          schemaVersion: 3,
          status: "applied",
          applied: { llm: true, intervals: true, session: true },
        });
      }
      if (request.method === "getRuntimeConfig") {
        return response({
          schemaVersion: 3,
          llm: {
            provider: "codex-agent",
            model: "synthetic-codex",
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
        });
      }
      throw new Error(`Unexpected Coach request: ${request.method}`);
    },
  };
}

function capturedLog(fixture: RunningDesktopFixture, messages: readonly string[]): string {
  const surfaces = ["location", "console", "stdout", "stderr"] as const;
  return [
    `playwright renderer\n${messages.join("\n")}`,
    ...surfaces.map((surface) => `${surface}\n${fixture.readCapturedSurface(surface)}`),
  ].join("\n\n");
}

export const test = base.extend<ChatDesktopFixtures>({
  chatDesktop: async ({ playwright }, use, testInfo) => {
    const turn = createScriptedTurn();
    let fixture: RunningDesktopFixture | undefined;
    let browser: Browser | undefined;
    let page: Page | undefined;
    const messages: string[] = [];
    try {
      fixture = await launchDesktopFixture({
        script: createScript(turn),
        token,
        width: 1180,
        height: 820,
        colorScheme: "light",
        reducedMotion: true,
        hidden: false,
        routeChatAttachmentComposer: true,
      });
      browser = await playwright.chromium.connectOverCDP(fixture.remoteDebuggingUrl);
      const context = browser.contexts()[0];
      if (context === undefined) throw new Error("Playwright did not find the Electron context");
      page = context.pages().find((candidate) => candidate.url().startsWith("enduragent://app/"));
      if (page === undefined) throw new Error("Playwright did not find the Electron renderer");
      page.on("console", (message) =>
        messages.push(`renderer ${message.type()}: ${message.text()}`),
      );
      page.on("pageerror", (error) => messages.push(`renderer error: ${error.message}`));
      await context.route(/^https?:\/\//, (route) => route.abort("blockedbyclient"));
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      const shell = page.locator("[data-shell]");
      await expect(shell).toHaveAttribute("data-onboarding", "settled", { timeout: 30_000 });
      await expect(shell).toHaveAttribute("data-shell", "app");
      await expect(page.getByRole("heading", { name: "Chat" })).toBeVisible();
      await expect(page.getByRole("combobox", { name: "Message your coach" })).toBeEnabled();
      await use({ page, coach: turn.coach });
    } finally {
      const failed = testInfo.status !== testInfo.expectedStatus;
      if (page !== undefined) {
        if (failed) {
          await page
            .screenshot({ path: testInfo.outputPath("desktop.png"), fullPage: true })
            .catch(() => {});
          await page
            .context()
            .tracing.stop({ path: testInfo.outputPath("trace.zip") })
            .catch(() => {});
        } else {
          await page
            .context()
            .tracing.stop()
            .catch(() => {});
        }
      }
      if (failed && fixture !== undefined) {
        await writeFile(testInfo.outputPath("desktop.log"), capturedLog(fixture, messages)).catch(
          () => {},
        );
      }
      turn.abort();
      await browser?.close().catch(() => {});
      await fixture?.close().catch(() => {});
    }
  },
});

export { expect };
