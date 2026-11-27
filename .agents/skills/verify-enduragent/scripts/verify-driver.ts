import { mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  launchDesktopFixture,
  type DesktopFixtureScript,
  type RunningDesktopFixture,
} from "../../../../apps/desktop/tests/helpers/desktop-fixture.js";

export type { DesktopFixtureScript, RunningDesktopFixture };
export { launchDesktopFixture };

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

export const response = (value: unknown): readonly string[] => [JSON.stringify(value)];

export interface ScriptRequest {
  readonly method: string;
  readonly params: unknown;
}

export type ScriptOverride = (request: ScriptRequest) => readonly string[] | undefined;

const readySetupStatus = {
  schemaVersion: 1,
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
      checkedAt: "1998-07-19T08:00:00.000Z",
    },
  },
  draft: null,
} as const;

const emptyPlanLibrary = {
  calendarConnected: false,
  legacy: null,
  creation: null,
  active: null,
  closed: [],
  changes: [],
  changesPaused: null,
  pendingChangeCheck: null,
} as const;

const spendSummary = {
  localDate: "1998-07-19",
  timezone: "UTC",
  dailyCapUsd: 0.5,
  knownSpendUsd: 0,
  generationCount: 0,
  pricedGenerationCount: 0,
  unpricedGenerationCount: 0,
  malformedLineCount: 0,
  spendComplete: true,
  capStatus: "below",
  cacheReadTokens: 0,
  knownCacheReadSavingsUsd: 0,
  cacheSavingsComplete: true,
  routes: [],
} as const;

const attachmentComposerMethods = new Set([
  "getChatAttachmentComposer",
  "saveChatAttachmentDraftText",
  "removeChatAttachment",
  "retryChatAttachment",
  "selectChatAttachmentWorkout",
  "clearChatAttachmentDraft",
]);

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

const athleteState = {
  schemaVersion: "1",
  lastUpdated: "1998-07-19T08:00:00.000Z",
  freshness: "fresh",
  degraded: false,
  lastSynced: null,
  athleteProfile: {},
  currentStatus: {},
  derivedMetrics: {},
  recentActivities: [],
  plannedWorkouts: [],
  wellness: {},
  trainingContext: {
    performanceProgress: { kind: "unavailable", reason: "not-synced" },
    recentRides: {
      kind: "computed",
      asOf: "1998-07-19T08:00:00.000Z",
      windowDays: 28,
      items: [
        {
          id: "a".repeat(64),
          subSport: "road",
          startEpochSeconds: 900_000_000,
          timezoneOffsetSeconds: 0,
          localDate: "1998-07-09",
          elapsedSeconds: 3_700,
          movingSeconds: 3_600,
          distanceMeters: 40_000,
        },
      ],
    },
    trainingHistory: { kind: "unavailable", reason: "not-synced" },
    anchorZones: { kind: "unknown", reason: "not-synced" },
    cyclingLoad: { kind: "unknown", reason: "no-platform-load" },
    plan: { kind: "unknown", reason: "no-plan" },
    adherence: { kind: "unknown", reason: "insufficient-data" },
    wellnessTrend: { kind: "unknown", reason: "no-wellness" },
  },
} as const;

const runtimeConfig = {
  schemaVersion: 3,
  llm: { provider: "codex-agent", model: "synthetic-codex", credential_configured: true },
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

export function baseScript(override?: ScriptOverride): DesktopFixtureScript {
  let hasSession = false;
  let units: "metric" | "imperial" = "metric";
  let queueRevision = 0;
  let queueItems: QueuedMessage[] = [];
  const queueSnapshot = () => ({
    schemaVersion: 1 as const,
    revision: queueRevision,
    items: queueItems,
  });
  return {
    onRequest(value) {
      const request = value as ScriptRequest;
      const overridden = override?.(request);
      if (overridden !== undefined) return overridden;
      if (attachmentComposerMethods.has(request.method)) {
        return response(emptyAttachmentComposer);
      }
      switch (request.method) {
        case "getAthleteState":
          return response(athleteState);
        case "getSetupStatus":
          return response(readySetupStatus);
        case "getRuntimeConfig":
          return response(runtimeConfig);
        case "configureRuntime": {
          const params = request.params as {
            readonly llm?: unknown;
            readonly intervals?: unknown;
            readonly session?: unknown;
          };
          return response({
            schemaVersion: 3,
            status: "applied",
            applied: {
              llm: params.llm !== undefined,
              intervals: params.intervals !== undefined,
              session: params.session !== undefined,
            },
          });
        }
        case "sync":
          return [
            JSON.stringify({ phase: "started", completed: 0, total: 1 }),
            JSON.stringify({ phase: "completed", completed: 1, total: 1 }),
            JSON.stringify({
              schemaVersion: 1,
              published: true,
              referenceSucceeded: true,
              requests: { store: 1, reference: 1, total: 2 },
              droppedActivities: {
                overall: { total: 0, visible: 0, restrictions: [], other: 0 },
                recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
              },
            }),
          ];
        case "getTranscriptPage":
          return response({ schemaVersion: 1, status: "page", turns: [], nextCursor: null });
        case "getUnitsPreference":
          return response({ value: units, source: "default" });
        case "setUnitsPreference": {
          units = (request.params as { readonly value: "metric" | "imperial" }).value;
          return response({ value: units, source: "cycling" });
        }
        case "hasSession":
          return response({ hasSession });
        case "resetSession": {
          hasSession = false;
          queueItems = [];
          queueRevision += 1;
          return response({ memoryFlushed: true });
        }
        case "getCoachDecision":
          return response({ decision: null });
        case "getPlanState":
          return response({ status: "unsupported-capability", capability: "planning" });
        case "plan.list":
          return response(emptyPlanLibrary);
        case "getSpendSummary":
          return response(spendSummary);
        case "listPlanningRequests":
          return response({ deliveries: [], planCreation: null });
        case "resumePlanningRequests":
          return response({ deliveries: [] });
        case "getChatQueue":
          return response(queueSnapshot());
        case "enqueueChatMessage": {
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
        case "removeQueuedChatMessage": {
          const { queuedMessageId } = request.params as { readonly queuedMessageId: string };
          queueItems = queueItems
            .filter((item) => item.queuedMessageId !== queuedMessageId)
            .map((item, position) => ({ ...item, position }));
          queueRevision += 1;
          return response(queueSnapshot());
        }
        case "resumeChatQueue": {
          hasSession = true;
          queueItems = [];
          queueRevision += 1;
          const text = "Fixture coach reply: keep it **steady** today.";
          return [
            JSON.stringify({ type: "turn-start", turnId: "turn-verify", chatId: "desktop" }),
            JSON.stringify({ type: "text_delta", turnId: "turn-verify", delta: text }),
            JSON.stringify({ type: "final-text", turnId: "turn-verify", text }),
            JSON.stringify({ snapshot: queueSnapshot(), response: { text } }),
          ];
        }
        default:
          console.error(`verify-driver baseScript: unhandled RPC "${request.method}"`);
          throw new TypeError(
            `verify-driver baseScript has no handler for "${request.method}" — pass an override that returns response(...) for it (copy real shapes from apps/desktop/tests/e2e/fixtures/chat-desktop.ts or the desktop integration tests)`,
          );
      }
    },
  };
}

export const READY_WAIT = `
  const deadline = Date.now() + 15000;
  await document.fonts.ready;
  const chipStatus = () => document.querySelector(".sync-chip")?.dataset.status;
  const onboardingState = () =>
    document.querySelector("[data-onboarding]")?.getAttribute("data-onboarding") ?? null;
  const composerReady = () => {
    const composer = document.querySelector("textarea#message");
    return composer instanceof HTMLTextAreaElement && !composer.disabled;
  };
  const ready = () =>
    document.documentElement.dataset.rpc === "connected" &&
    chipStatus() !== undefined &&
    chipStatus() !== "loading" &&
    onboardingState() === "settled" &&
    document.querySelector("[data-setup-host]") === null &&
    composerReady();
  while (!ready() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return {
    ready: ready(),
    rpc: document.documentElement.dataset.rpc ?? null,
    chip: chipStatus() ?? null,
    onboarding: onboardingState(),
    setupGate: document.querySelector("[data-setup-host]") !== null,
    composerEnabled: composerReady(),
  };
`;

export interface ReadyDiagnostics {
  readonly ready: boolean;
  readonly rpc: string | null;
  readonly chip: string | null;
  readonly onboarding: string | null;
  readonly setupGate: boolean;
  readonly composerEnabled: boolean;
}

export async function launchReadyDesktop(input?: {
  readonly script?: DesktopFixtureScript;
  readonly width?: number;
  readonly height?: number;
  readonly colorScheme?: "light" | "dark";
  readonly extraEnv?: Readonly<Record<string, string>>;
}): Promise<RunningDesktopFixture> {
  const fixture = await launchDesktopFixture({
    script: input?.script ?? baseScript(),
    token: "t".repeat(43),
    width: input?.width ?? 1440,
    height: input?.height ?? 900,
    colorScheme: input?.colorScheme ?? "light",
    reducedMotion: true,
    routeChatAttachmentComposer: true,
    extraEnv: input?.extraEnv,
  });
  const diagnostics = await fixture.evaluate<ReadyDiagnostics>(READY_WAIT);
  if (diagnostics?.ready !== true) {
    await fixture.close().catch(() => {});
    throw new Error(`desktop fixture did not reach ready chat: ${JSON.stringify(diagnostics)}`);
  }
  return fixture;
}

export async function evidenceDir(runName: string): Promise<string> {
  if (!/^[a-z0-9-]+$/.test(runName)) throw new TypeError("runName must be kebab-case");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join("/tmp/enduragent-verify", `${stamp}-${runName}`);
  await mkdir(dir, { recursive: true });
  return dir;
}
