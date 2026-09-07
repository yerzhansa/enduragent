import { expect } from "@playwright/test";
import {
  launchDesktopFixture,
  type DesktopFixtureScript,
  type RunningDesktopFixture,
} from "../../helpers/desktop-fixture.js";

const FIXTURE_TOKEN = "u".repeat(43);
const FIXTURE_INTERVALS_KEY = "synthetic-intervals-key-for-application-state";
const FIXTURE_APPROVAL = "a".repeat(64);

interface ScriptRequest {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params: unknown;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function response(value: unknown): readonly string[] {
  return [JSON.stringify(value)];
}

async function evaluateWhen<T>(
  fixture: RunningDesktopFixture,
  expression: string,
  description: string,
): Promise<T> {
  return fixture.evaluate<T>(`
    const deadline = performance.now() + 10_000;
    while (performance.now() < deadline) {
      const value = (${expression});
      if (value !== undefined && value !== null && value !== false) return value;
      await new Promise(requestAnimationFrame);
    }
    throw new Error(${JSON.stringify(`Timed out waiting for ${description}`)});
  `);
}

async function clickSelector(
  fixture: RunningDesktopFixture,
  selector: string,
  description: string,
): Promise<void> {
  await evaluateWhen<boolean>(
    fixture,
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLButtonElement) || element.disabled) return false;
      element.click();
      return true;
    })()`,
    description,
  );
}

async function clickExactText(
  fixture: RunningDesktopFixture,
  selector: string,
  text: string,
): Promise<void> {
  await evaluateWhen<boolean>(
    fixture,
    `(() => {
      const element = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(
        (candidate) => (candidate.textContent ?? "").replace(/\\s+/gu, " ").trim() === ${JSON.stringify(text)},
      );
      if (!(element instanceof HTMLElement)) return false;
      if (element instanceof HTMLButtonElement && element.disabled) return false;
      element.click();
      return true;
    })()`,
    text,
  );
}

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

const athleteState = {
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
} as const;

class ApplicationStateBackend {
  readonly syncStarted = deferred<void>();
  readonly calls: ScriptRequest[] = [];
  private readonly syncResult = deferred<readonly string[]>();
  private readonly athleteRequests: Array<Deferred<readonly string[]>> = [];
  private intake: Record<string, unknown> | null = null;
  private durableTrainingData = false;
  private intervalsConfigured = false;

  readonly script: DesktopFixtureScript = {
    onRequest: (value) => {
      const request = value as ScriptRequest;
      this.calls.push(request);
      if (request.method === "getAthleteState") {
        const pending = deferred<readonly string[]>();
        this.athleteRequests.push(pending);
        return pending.promise;
      }
      if (request.method === "getSetupStatus") {
        return response({
          schemaVersion: 1,
          intake: this.intake,
          durableTrainingData: this.durableTrainingData,
        });
      }
      if (request.method === "getUnitsPreference") {
        return response({ value: "metric", source: "default" });
      }
      if (request.method === "setUnitsPreference") {
        return response({ value: "metric", source: "cycling" });
      }
      if (request.method === "getChatQueue") {
        return response({ schemaVersion: 1, revision: 0, items: [] });
      }
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
      if (request.method === "hasSession") return response({ hasSession: false });
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
      if (
        request.method === "resumePlanningRequests" ||
        request.method === "listPlanningRequests"
      ) {
        return response({ deliveries: [] });
      }
      if (request.method === "getSpendSummary") {
        return response({
          schemaVersion: 1,
          currency: "USD",
          today: { spend: 0, cap: null },
          routes: [],
        });
      }
      if (request.method === "saveIntake") {
        this.intake = request.params as Record<string, unknown>;
        return response({ schemaVersion: 1, saved: true });
      }
      if (request.method === "verify_intervals_credential") {
        return response({ approval: FIXTURE_APPROVAL });
      }
      if (request.method === "configureRuntime") {
        const params = request.params as { readonly intervals?: unknown };
        if (params.intervals !== undefined) this.intervalsConfigured = true;
        return response({
          schemaVersion: 3,
          status: "applied",
          applied: { llm: true, intervals: params.intervals !== undefined, session: true },
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
            credential_configured: this.intervalsConfigured,
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
      if (request.method === "sync") {
        this.syncStarted.resolve();
        return this.syncResult.promise;
      }
      throw new Error(`Unexpected Coach request: ${request.method}`);
    },
  };

  failSyncProtocol(): void {
    this.syncResult.resolve(response({ schemaVersion: 1 }));
  }

  prepareRelaunch(): void {
    this.durableTrainingData = true;
    this.releaseAthleteRequests();
  }

  releaseAthleteRequests(): void {
    for (const request of this.athleteRequests.splice(0)) request.resolve(response(athleteState));
  }

  releasePendingRequests(): void {
    this.syncResult.resolve(
      response({
        schemaVersion: 1,
        published: false,
        referenceSucceeded: true,
        requests: { store: 1, reference: 1, total: 2 },
        droppedActivities: {
          overall: { total: 0, visible: 0, restrictions: [], other: 0 },
          recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
        },
      }),
    );
    this.releaseAthleteRequests();
  }
}

export interface ApplicationUiHarness {
  readonly fixture: RunningDesktopFixture;
  readonly backend: ApplicationStateBackend;
  close(): Promise<void>;
}

export async function launchApplicationUiHarness(input: {
  readonly width: number;
  readonly height: number;
  readonly colorScheme: "light" | "dark";
}): Promise<ApplicationUiHarness> {
  const backend = new ApplicationStateBackend();
  const fixture = await launchDesktopFixture({
    script: backend.script,
    token: FIXTURE_TOKEN,
    width: input.width,
    height: input.height,
    colorScheme: input.colorScheme,
    reducedMotion: true,
    hidden: true,
    inspectMain: true,
    routeChatAttachmentComposer: true,
    extraEnv: { LANG: "en_US.UTF-8", TZ: "UTC" },
  });
  try {
    const clipboardValue = await fixture.evaluateMain<string>(`
      const { createRequire } = process.getBuiltinModule("module");
      const require = createRequire(process.cwd() + "/package.json");
      const { clipboard } = require("electron");
      clipboard.readText = () => ${JSON.stringify(FIXTURE_INTERVALS_KEY)};
      clipboard.clear = () => {};
      return clipboard.readText();
    `);
    if (clipboardValue !== FIXTURE_INTERVALS_KEY)
      throw new Error("Fixture clipboard was not installed");
    await evaluateWhen<boolean>(
      fixture,
      `(() => {
        const shell = document.querySelector("[data-shell]");
        return shell?.getAttribute("data-onboarding") === "settled" &&
          shell.getAttribute("data-shell") === "gate" &&
          document.documentElement.getAttribute("data-theme") === ${JSON.stringify(input.colorScheme)};
      })()`,
      "the setup gate",
    );
    await clickSelector(fixture, '[data-setup-trigger="training"]', "the training setup action");
    await clickExactText(fixture, "button", "Use copied API key");
    await evaluateWhen<boolean>(
      fixture,
      `document.querySelector('[data-setup-row="training"] [data-setup-disc="ready"]') !== null`,
      "the connected training account",
    );
    await clickSelector(fixture, "#onboarding-injury-status", "the injury status selector");
    await clickExactText(fixture, '[role="option"]', "No current injury");
    await clickExactText(fixture, "button", "Start coaching");
    await evaluateWhen<boolean>(
      fixture,
      `(() => {
        const shell = document.querySelector("[data-shell]");
        const sync = document.querySelector(".first-sync");
        return shell?.getAttribute("data-shell") === "app" &&
          sync?.getAttribute("data-state") === "syncing";
      })()`,
      "the initial training sync",
    );
    await backend.syncStarted.promise;
  } catch (error) {
    const diagnostic = await fixture
      .evaluate(`
        return {
          readiness: document.querySelector("[data-setup-readiness]")?.textContent?.trim(),
          training: document.querySelector('[data-setup-row="training"]')?.textContent?.replace(/\\s+/gu, " ").trim(),
          errors: Array.from(document.querySelectorAll("[role=status]"))
            .map((element) => element.textContent?.replace(/\\s+/gu, " ").trim())
            .filter(Boolean),
        };
      `)
      .catch((diagnosticError: unknown) => ({ diagnosticError: String(diagnosticError) }));
    backend.releasePendingRequests();
    const outcome = await fixture.close();
    if (outcome.livePids.length > 0 || outcome.listenerCount !== 0) {
      throw new AggregateError(
        [
          error,
          new Error(
            `Fixture cleanup left ${outcome.livePids.length} processes and ${outcome.listenerCount} listeners`,
          ),
        ],
        "Application UI harness launch failed and cleanup was incomplete",
      );
    }
    throw new AggregateError(
      [
        error,
        new Error(
          `Application UI launch diagnostic: ${JSON.stringify({ diagnostic, calls: backend.calls })}`,
        ),
      ],
      "Application UI harness launch failed",
    );
  }

  const harness: ApplicationUiHarness = {
    fixture,
    backend,
    async close() {
      backend.releasePendingRequests();
      const outcome = await fixture.close();
      expect(outcome.livePids).toEqual([]);
      expect(outcome.listenerCount).toBe(0);
    },
  };
  return harness;
}

export const privateFixtureValues = [
  FIXTURE_TOKEN,
  FIXTURE_INTERVALS_KEY,
  FIXTURE_APPROVAL,
] as const;
