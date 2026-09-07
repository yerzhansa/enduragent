import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { preferencesContract } from "../../../tools/ui-verification/contracts.js";
import {
  checkStructure,
  probeExpression,
  type StructuralSnapshot,
} from "../../../tools/ui-verification/structure.js";
import { isDesktopRendererUrl } from "../src/main/renderer-navigation.js";
import {
  launchDesktopFixture,
  type DesktopFixtureScript,
  type RunningDesktopFixture,
} from "./helpers/desktop-fixture.js";

const hasLoopback = await new Promise<boolean>((resolveAvailability) => {
  const server = createServer();
  server.once("error", () => resolveAvailability(false));
  server.listen({ host: "127.0.0.1", port: 0 }, () => {
    server.close(() => resolveAvailability(true));
  });
});

const token = "t".repeat(43);
const archivedBoundaryRef = "a".repeat(64);
const transcriptCursorBytes = Buffer.alloc(114);
transcriptCursorBytes[0] = 1;
const transcriptCursor = transcriptCursorBytes.toString("base64url");
const fixtures: RunningDesktopFixture[] = [];
const scratchPaths: string[] = [];
const liveTurns: LiveTurnControl[] = [];
const followLatestThreshold = 80;
const streamQuestion = "Keep streaming while I compare the earlier notes.";
const streamDraft = "Keep this draft while I read.";
const streamTurnId = "turn-scroll-stream";
const firstStreamDelta = Array.from(
  { length: 28 },
  (_, index) => `Following update ${index + 1}: hold the aerobic effort steady.`,
).join("\n\n");
const secondStreamDelta = Array.from(
  { length: 12 },
  (_, index) => `Reading update ${index + 1}: preserve the current comparison point.`,
).join("\n\n");
const thirdStreamDelta = Array.from(
  { length: 12 },
  (_, index) => `Hidden update ${index + 1}: continue without moving the reader.`,
).join("\n\n");

async function visibleQaCheckpoint(name: string): Promise<void> {
  const gateDirectory = process.env.ENDURAGENT_VISIBLE_QA_GATE_DIR;
  if (gateDirectory === undefined) return;
  if (!/^[a-z0-9-]+$/.test(name)) throw new TypeError("invalid visible QA checkpoint name");
  await mkdir(gateDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(gateDirectory, `${name}.ready`), "ready\n", { mode: 0o600 });
  const releasePath = join(gateDirectory, `${name}.release`);
  while (!existsSync(releasePath)) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
}

const trainingContext = {
  performanceProgress: { kind: "unavailable", reason: "not-synced" },
  recentRides: {
    kind: "computed",
    asOf: "2026-07-19T08:00:00.000Z",
    windowDays: 28,
    items: [
      {
        id: "c".repeat(64),
        subSport: "road",
        startEpochSeconds: 1_784_358_000,
        timezoneOffsetSeconds: 18_000,
        localDate: "2026-07-18",
        elapsedSeconds: 5_460,
        movingSeconds: 5_100,
        distanceMeters: 42_120,
      },
      {
        id: "d".repeat(64),
        subSport: "indoor_cycling",
        startEpochSeconds: 1_784_268_000,
        timezoneOffsetSeconds: null,
        localDate: "2026-07-17",
        elapsedSeconds: 3_600,
        movingSeconds: 3_600,
        distanceMeters: null,
      },
    ],
  },
  trainingHistory: {
    kind: "computed",
    asOf: "2026-07-19T08:00:00.000Z",
    calendarTimeZone: "Asia/Almaty",
    displayMode: "current",
    coverage: {
      kind: "contiguous",
      start: "2026-06-01",
      through: "2026-07-19",
      committedAt: "2026-07-19T07:55:00.000Z",
    },
    anchorWeek: {
      id: "anchor",
      window: { start: "2026-07-13", end: "2026-07-19" },
      calendarState: "closed",
      coverage: { kind: "complete" },
      totals: {
        rideCount: { kind: "computed", value: 1 },
        ridingSeconds: { kind: "computed", value: 5_100 },
        distanceMeters: { kind: "computed", value: 42_120 },
        load: { kind: "unavailable", reason: "no-recorded-value" },
      },
      rides: {
        count: { kind: "exact", value: 1 },
        items: [
          {
            id: "c".repeat(64),
            title: null,
            subSport: "road",
            startEpochSeconds: 1_784_358_000,
            timezoneOffsetSeconds: 18_000,
            localDate: "2026-07-18",
            ridingSeconds: 5_100,
            ridingTimeBasis: "moving",
            elapsedSeconds: 5_460,
            distanceMeters: 42_120,
            load: null,
            averagePowerWatts: null,
            averageHeartRateBpm: null,
            perceivedExertion: null,
            energyKilojoules: null,
          },
        ],
        truncated: false,
      },
      trend: { kind: "unavailable", reason: "limited-history" },
      callout: null,
    },
    previousWeek: null,
  },
  anchorZones: {
    kind: "computed",
    asOf: "2026-07-19T08:00:00.000Z",
    anchor: {
      watts: 300,
      validFrom: "2026-07-01",
      source: "intervals.icu",
      confidence: "platform",
      ageDays: 18,
      stalenessBand: "fresh",
      stale: false,
    },
    zones: [
      { name: "Recovery", range: "0–164 W", overlaps: false },
      { name: "Endurance", range: "165–224 W", overlaps: false },
      { name: "Tempo", range: "225–269 W", overlaps: false },
      { name: "Threshold", range: "270–314 W", overlaps: false },
      { name: "VO₂ max", range: "315–359 W", overlaps: false },
      { name: "Anaerobic", range: "360+ W", overlaps: false },
    ],
  },
  cyclingLoad: {
    kind: "computed",
    asOf: "2026-07-19T08:00:00.000Z",
    source: "intervals.icu",
    windowDays: 7,
    value: 240,
    activityCount: 3,
    missingLoadCount: 1,
  },
  plan: {
    kind: "computed",
    asOf: "2026-07-19T08:00:00.000Z",
    items: [
      {
        id: "plan-1",
        date: "2026-07-20",
        name: "Tempo ride",
        category: "WORKOUT",
        workoutType: "Ride",
      },
    ],
  },
  adherence: {
    kind: "computed",
    asOf: "2026-07-19T08:00:00.000Z",
    ratio: 0.8,
    plannedDays: 5,
    completedDays: 4,
    matchedDays: 4,
  },
  wellnessTrend: {
    kind: "computed",
    asOf: "2026-07-19T08:00:00.000Z",
    windowDays: 7,
    series: [
      { metric: "hrv", unit: "ms", points: [{ date: "2026-07-19", value: 65 }] },
      { metric: "sleep", unit: "seconds", points: [{ date: "2026-07-19", value: 27_000 }] },
      { metric: "resting-hr", unit: "bpm", points: [{ date: "2026-07-19", value: 48 }] },
    ],
  },
} as const;

const athleteState = {
  schemaVersion: "1",
  lastUpdated: "2026-07-19T08:00:00.000Z",
  freshness: "fresh",
  degraded: false,
  lastSynced: "2026-07-19T07:55:00.000Z",
  athleteProfile: {},
  currentStatus: {},
  derivedMetrics: {},
  recentActivities: [],
  plannedWorkouts: [],
  wellness: {},
  trainingContext,
} as const;

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
      checkedAt: "2026-08-26T00:00:00.000Z",
    },
  },
  draft: null,
} as const;

const tallTurn =
  "Long ride notes that make the newest restored turn taller than the window. ".repeat(52);

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

async function bounded<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface LiveTurnControl {
  readonly ready: Promise<void>;
  attach(emitFrame: (frame: string) => void): void;
  waitForFinish(): Promise<string>;
  emit(event: unknown): void;
  finish(text: string): void;
  abort(): void;
}

function createLiveTurnControl(): LiveTurnControl {
  const entered = deferred<void>();
  let emitFrame: ((frame: string) => void) | undefined;
  let outcome: ReturnType<typeof deferred<string>> | undefined;
  let settled = false;
  const control: LiveTurnControl = {
    ready: entered.promise,
    attach(nextEmitFrame) {
      if (settled) throw new TypeError("live turn control is already settled");
      if (emitFrame !== undefined) throw new TypeError("live turn control is already attached");
      emitFrame = nextEmitFrame;
      outcome = deferred<string>();
      entered.resolve(undefined);
    },
    waitForFinish() {
      if (outcome === undefined) throw new TypeError("live turn control is not attached");
      return outcome.promise;
    },
    emit(event) {
      if (emitFrame === undefined) throw new TypeError("live turn control is not attached");
      emitFrame(JSON.stringify(event));
    },
    finish(text) {
      if (settled) return;
      if (outcome === undefined) throw new TypeError("live turn control is not attached");
      settled = true;
      outcome.resolve(text);
    },
    abort() {
      if (settled) return;
      settled = true;
      outcome?.reject(new Error("live turn fixture closed"));
    },
  };
  liveTurns.push(control);
  return control;
}

type SyncOutcome = "no-change" | "partial";

function makeScript(
  calls: ScriptRequest[],
  syncOutcome: SyncOutcome,
  transcriptHistory: boolean,
  liveTurn?: LiveTurnControl,
): DesktopFixtureScript {
  let units: "metric" | "imperial" = "metric";
  let hasSession = false;
  let lastSynced: string = athleteState.lastSynced;
  let queueRevision = 0;
  let archivedDeleted = false;
  let queueItems: Array<{
    queuedMessageId: string;
    messageId: string;
    submissionId: string;
    attachmentIds: string[];
    text: string;
    kind: "ordinary" | "slash-command";
    position: number;
    restored: boolean;
  }> = [];
  const queueSnapshot = () => ({
    schemaVersion: 1 as const,
    revision: queueRevision,
    items: queueItems,
  });
  return {
    ...(liveTurn === undefined
      ? {}
      : {
          async onStreamRequest(value: unknown, emitFrame: (frame: string) => void) {
            const request = value as ScriptRequest;
            calls.push(request);
            if (request.method !== "resumeChatQueue") {
              throw new TypeError(`unexpected live fixture method ${request.method}`);
            }
            hasSession = true;
            liveTurn.attach(emitFrame);
            const finalText = await liveTurn.waitForFinish();
            queueItems = [];
            queueRevision += 1;
            return JSON.stringify({ snapshot: queueSnapshot(), response: { text: finalText } });
          },
        }),
    onRequest(value) {
      const request = value as ScriptRequest;
      calls.push(request);
      if (request.method === "getAthleteState") {
        return response({ ...athleteState, lastSynced });
      }
      if (request.method === "getSetupStatus") {
        return response(readySetupStatus);
      }
      if (request.method === "getActivityAnalysis") {
        const canonicalActivityId = (request.params as { readonly canonicalActivityId: string })
          .canonicalActivityId;
        return response({
          schemaVersion: 1,
          activity: {
            id: canonicalActivityId,
            workoutId: "e".repeat(64),
            sessionSequence: 0,
            isMultisport: false,
            sport: "cycling",
            subSport: "road",
            isTransition: false,
            startEpochSeconds: 1_784_358_000,
            timezoneOffsetSeconds: 18_000,
            localDate: "2026-07-18",
            elapsedSeconds: 5_460,
            timerSeconds: 5_200,
            movingSeconds: 5_100,
            distanceMeters: 42_120,
          },
          revision: "f".repeat(64),
          sections: {
            aerobicDrift: {
              kind: "computed",
              data: {
                method: "local-time-weighted-efficiency-factor",
                firstHalf: {
                  durationSeconds: 2_550,
                  sampleCount: 2_550,
                  averagePowerWatts: 205,
                  averageHeartRateBpm: 140,
                  efficiencyFactor: 1.46,
                },
                secondHalf: {
                  durationSeconds: 2_550,
                  sampleCount: 2_550,
                  averagePowerWatts: 202,
                  averageHeartRateBpm: 145,
                  efficiencyFactor: 1.39,
                },
                decouplingPercent: 4.8,
                coverage: {
                  totalSamples: 5_460,
                  validSamples: 5_100,
                  includedDurationSeconds: 5_100,
                  windowDurationSeconds: 5_460,
                  fraction: 5_100 / 5_460,
                },
                evidence: "limited",
                limitations: ["moving-status-unavailable"],
              },
              provenance: {
                source: "local-canonical",
                delivery: "live",
                observedAt: "2026-07-19T08:00:00.000Z",
              },
            },
            intervals: {
              kind: "computed",
              data: {
                source: "provider",
                intervals: [
                  {
                    ordinal: 1,
                    groupOrdinal: null,
                    kind: "work",
                    label: "Threshold",
                    startIndex: 0,
                    endIndex: 299,
                    startSeconds: 0,
                    endSeconds: 300,
                    movingSeconds: 300,
                    elapsedSeconds: 300,
                    distanceMeters: 2_500,
                    averagePowerWatts: 250,
                    maximumPowerWatts: 310,
                    averageHeartRateBpm: 155,
                    maximumHeartRateBpm: 170,
                    averageCadenceRpm: 91,
                    maximumCadenceRpm: 104,
                    zone: 4,
                    intensityPercent: 96,
                    trainingLoad: 12,
                  },
                ],
                groups: [],
              },
              provenance: {
                source: "provider",
                delivery: "live",
                observedAt: "2026-07-19T08:00:00.000Z",
              },
            },
            bestEfforts: {
              kind: "computed",
              data: {
                scope: {
                  kind: "selected-activity",
                  stream: "power",
                  durationSeconds: 300,
                  tieRule: "earliest-start",
                },
                efforts: [
                  {
                    rank: 1,
                    startIndex: 900,
                    endIndex: 1_199,
                    durationSeconds: 300,
                    distanceMeters: 2_600,
                    averageWatts: 310,
                  },
                ],
              },
              provenance: {
                source: "provider",
                delivery: "live",
                observedAt: "2026-07-19T08:00:00.000Z",
              },
            },
            powerDistribution: {
              kind: "computed",
              data: {
                unit: "watts",
                buckets: [
                  { lower: 0, upper: 100, seconds: 300 },
                  { lower: 100, upper: 200, seconds: 600 },
                  { lower: 225, upper: 300, seconds: 120 },
                ],
                totalSeconds: 1_020,
              },
              provenance: {
                source: "provider",
                delivery: "live",
                observedAt: "2026-07-19T08:00:00.000Z",
              },
            },
            heartRateDistribution: {
              kind: "computed",
              data: {
                unit: "bpm",
                buckets: [
                  { lower: 110, upper: 130, seconds: 420 },
                  { lower: 130, upper: 150, seconds: 600 },
                ],
                totalSeconds: 1_020,
              },
              provenance: {
                source: "provider",
                delivery: "live",
                observedAt: "2026-07-19T08:00:00.000Z",
              },
            },
            powerHeartRate: {
              kind: "computed",
              data: {
                source: "provider",
                rows: Array.from({ length: 6 }, (_, index) => ({
                  startSeconds: index * 60,
                  watts: 150 + index * 10,
                  heartRateBpm: 120 + index * 2,
                  cadenceRpm: index === 0 ? null : 85 + index,
                  movingSeconds: 60,
                  seconds: 60,
                })),
                curves: [{ kind: "all", coefficients: [100, 0.1], rSquared: 0.9 }],
                coverageFraction: 0.6,
                heartRateLagSeconds: 15,
                warmupSeconds: 60,
                cooldownSeconds: 30,
              },
              provenance: {
                source: "provider",
                delivery: "live",
                observedAt: "2026-07-19T08:00:00.000Z",
              },
            },
          },
        });
      }
      if (request.method === "getUnitsPreference") {
        return response({ value: units, source: units === "metric" ? "default" : "cycling" });
      }
      if (request.method === "setUnitsPreference") {
        units = (request.params as { readonly value: "metric" | "imperial" }).value;
        return response({ value: units, source: "cycling" });
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
        const params = request.params as { readonly submissionId: string; readonly text: string };
        if (!queueItems.some((item) => item.submissionId === params.submissionId)) {
          queueRevision += 1;
          queueItems.push({
            queuedMessageId: `queued-${queueRevision}`,
            messageId: `message-${queueRevision}`,
            submissionId: params.submissionId,
            attachmentIds: [],
            text: params.text,
            kind: params.text.trimStart().startsWith("/") ? "slash-command" : "ordinary",
            position: queueItems.length,
            restored: false,
          });
        }
        return response(queueSnapshot());
      }
      if (request.method === "removeQueuedChatMessage") {
        const id = (request.params as { readonly queuedMessageId: string }).queuedMessageId;
        queueItems = queueItems
          .filter((item) => item.queuedMessageId !== id)
          .map((item, position) => ({ ...item, position }));
        queueRevision += 1;
        return response(queueSnapshot());
      }
      if (request.method === "resumeChatQueue") {
        hasSession = true;
        const firstDelta = "## Today’s ride\n\nHold   **ste";
        const finalText = `${firstDelta}ady**.

<script>globalThis.hostile = true</script>

| Segment | Prescription |
| --- | --- |
| Endurance | ${"steady".repeat(40)} |

\`\`\`text
${"nonwrapping".repeat(36)}
\`\`\`

[Guide](https://example.test/guide)`;
        return [
          JSON.stringify({ type: "turn-start", turnId: "turn-fixture", chatId: "desktop" }),
          JSON.stringify({
            type: "text_delta",
            turnId: "turn-fixture",
            delta: firstDelta,
          }),
          JSON.stringify({
            type: "text_delta",
            turnId: "turn-fixture",
            delta: finalText.slice(firstDelta.length),
          }),
          JSON.stringify({ type: "final-text", turnId: "turn-fixture", text: finalText }),
          JSON.stringify(
            (() => {
              queueItems = [];
              queueRevision += 1;
              return { snapshot: queueSnapshot(), response: { text: finalText } };
            })(),
          ),
        ];
      }
      if (request.method === "hasSession") return response({ hasSession });
      if (request.method === "getCoachDecision") return response({ decision: null });
      if (request.method === "getTranscriptPage") {
        if (!transcriptHistory) {
          return response({
            schemaVersion: 1,
            status: "page",
            turns: [],
            nextCursor: null,
          });
        }
        const cursor = (request.params as { readonly cursor: string | null }).cursor;
        return response({
          schemaVersion: 1,
          status: "page",
          turns:
            cursor === null
              ? [
                  {
                    turnId: "persisted-turn-3",
                    completedAt: "2001-01-03T00:00:00.000Z",
                    athleteText: "Persisted athlete 3",
                    coachText: "**Persisted coach 3**",
                    attachments: [
                      {
                        attachmentId: "attachment-persisted-3",
                        displayName: "training-notes.txt",
                        kind: "document",
                        extension: "txt",
                      },
                    ],
                  },
                  {
                    turnId: "persisted-turn-4",
                    completedAt: "2001-01-04T00:00:00.000Z",
                    athleteText: `Persisted athlete 4 ${tallTurn}`,
                    coachText: "Persisted coach 4",
                  },
                ]
              : [
                  {
                    turnId: "persisted-turn-1",
                    completedAt: "2001-01-01T00:00:00.000Z",
                    athleteText: "Persisted athlete 1",
                    coachText: "Persisted coach 1",
                  },
                  {
                    turnId: "persisted-turn-2",
                    completedAt: "2001-01-02T00:00:00.000Z",
                    athleteText: "Persisted athlete 2",
                    coachText: "Persisted coach 2",
                  },
                ],
          nextCursor: cursor === null ? transcriptCursor : null,
        });
      }
      if (request.method === "listArchivedConversations") {
        return response({
          schemaVersion: 1,
          conversations: archivedDeleted
            ? []
            : [
                {
                  boundaryRef: archivedBoundaryRef,
                  boundaryAt: "2001-01-05T08:00:00.000Z",
                  reason: "explicit-reset",
                  turnCount: 1,
                },
              ],
          truncated: false,
        });
      }
      if (request.method === "getArchivedTranscriptPage") {
        return response({
          schemaVersion: 1,
          status: archivedDeleted ? "restart-required" : "page",
          turns: archivedDeleted
            ? []
            : [
                {
                  turnId: "archived-turn-1",
                  completedAt: "2001-01-05T07:00:00.000Z",
                  athleteText: "How did that block go?",
                  coachText: "The block was consistent.",
                },
              ],
          nextCursor: null,
        });
      }
      if (request.method === "deleteArchivedConversation") {
        const status = archivedDeleted ? "not-found" : "deleted";
        archivedDeleted = true;
        return response({ schemaVersion: 1, status });
      }
      if (request.method === "resetSession") {
        hasSession = false;
        queueItems = [];
        queueRevision += 1;
        return response({ memoryFlushed: true });
      }
      if (request.method === "sync") {
        lastSynced = "2026-07-19T07:55:01.000Z";
        const partial = syncOutcome === "partial";
        return [
          JSON.stringify({ phase: "started", completed: 0, total: 1 }),
          JSON.stringify({ phase: "completed", completed: 1, total: 1 }),
          JSON.stringify({
            schemaVersion: 1,
            published: partial,
            referenceSucceeded: !partial,
            requests: { store: 1, reference: 1, total: 2 },
            droppedActivities: {
              overall: { total: 0, visible: 0, restrictions: [], other: 0 },
              recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
            },
          }),
        ];
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
      if (request.method === "saveIntake") return response({ schemaVersion: 1, saved: true });
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
      throw new TypeError(`unexpected fixture method ${request.method}`);
    },
  };
}

interface ScriptRequest {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params: unknown;
}

async function launch(input: {
  readonly width: number;
  readonly height: number;
  readonly reducedMotion: boolean;
  readonly colorScheme?: "light" | "dark";
  readonly syncOutcome?: SyncOutcome;
  readonly transcriptHistory?: boolean;
  readonly liveTurn?: LiveTurnControl;
  readonly hidden?: boolean;
}): Promise<{ readonly fixture: RunningDesktopFixture; readonly calls: ScriptRequest[] }> {
  const calls: ScriptRequest[] = [];
  const fixture = await launchDesktopFixture({
    script: makeScript(
      calls,
      input.syncOutcome ?? "no-change",
      input.transcriptHistory ?? false,
      input.liveTurn,
    ),
    token,
    width: input.width,
    height: input.height,
    colorScheme: input.colorScheme ?? "light",
    reducedMotion: input.reducedMotion,
    hidden: input.hidden,
    routeChatAttachmentComposer: true,
  });
  fixtures.push(fixture);
  await fixture.evaluate<void>(`
    const deadline = Date.now() + 10000;
    await document.fonts.ready;
    const chipStatus = () => document.querySelector(".sync-chip")?.dataset.status;
    while ((document.documentElement.dataset.rpc !== "connected" || chipStatus() === undefined || chipStatus() === "loading") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const onboardingDeadline = Date.now() + 10000;
    const onboardingState = () =>
      document.querySelector("[data-onboarding]")?.getAttribute("data-onboarding") ?? null;
    while (onboardingState() !== "settled" && Date.now() < onboardingDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (onboardingState() !== "settled") {
      throw new Error("onboarding startup decision did not settle");
    }
    if (document.querySelector("[data-setup-host]") !== null) {
      throw new Error("ready fixture unexpectedly requires setup");
    }
    const composerDeadline = Date.now() + 10000;
    let composer = document.querySelector("textarea#message");
    while (
      (!(composer instanceof HTMLTextAreaElement) || composer.disabled) &&
      Date.now() < composerDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      composer = document.querySelector("textarea#message");
    }
    if (!(composer instanceof HTMLTextAreaElement) || composer.disabled) {
      throw new Error(
        "ready fixture did not enable chat: " + JSON.stringify({
          composerFound: composer instanceof HTMLTextAreaElement,
          composerDisabled:
            composer instanceof HTMLTextAreaElement ? composer.disabled : null,
          rpc: document.documentElement.dataset.rpc ?? null,
          newConversationDisabled:
            document.querySelector("button.new-conversation-button")?.hasAttribute("disabled") ??
            null,
          alerts: Array.from(document.querySelectorAll('[role="alert"]')).map((node) =>
            node.textContent?.trim(),
          ),
          statuses: Array.from(document.querySelectorAll('[role="status"]')).map((node) =>
            node.textContent?.trim(),
          ),
        }),
      );
    }
  `);
  return { fixture, calls };
}

async function stackedProjectionGeometry(fixture: RunningDesktopFixture): Promise<{
  readonly attachmentIssue: boolean;
  readonly planningIssue: boolean;
  readonly composerWithinViewport: boolean;
  readonly disclaimerWithinViewport: boolean;
  readonly projectionsScrollLocally: boolean;
  readonly disclaimerStableAfterProjectionScroll: boolean;
  readonly footerOrder: boolean;
  readonly documentVerticalOverflow: boolean;
}> {
  return fixture.evaluate(`
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const composerWrap = document.querySelector(".composer-wrap");
    const projections = document.querySelector(".composer-projections");
    const composer = composerWrap?.querySelector("form");
    const disclaimer = composerWrap?.querySelector(":scope > p:last-child");
    if (!(composerWrap instanceof HTMLElement) || !(projections instanceof HTMLElement) ||
        !(composer instanceof HTMLFormElement) || !(disclaimer instanceof HTMLElement)) {
      throw new Error("stacked composer surface is incomplete");
    }
    const text = composerWrap.textContent ?? "";
    const wrapRect = composerWrap.getBoundingClientRect();
    const disclaimerBefore = disclaimer.getBoundingClientRect();
    projections.scrollTop = projections.scrollHeight;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const disclaimerAfter = disclaimer.getBoundingClientRect();
    return {
      attachmentIssue: text.includes("We couldn’t update that attachment. Your message draft is preserved."),
      planningIssue: text.includes("We couldn’t check saved Plan requests. Reconnect and try again."),
      composerWithinViewport: wrapRect.top >= 0 && wrapRect.bottom <= window.innerHeight,
      disclaimerWithinViewport:
        disclaimerAfter.top >= 0 && disclaimerAfter.bottom <= window.innerHeight,
      projectionsScrollLocally: getComputedStyle(projections).overflowY === "auto",
      disclaimerStableAfterProjectionScroll:
        Math.abs(disclaimerBefore.top - disclaimerAfter.top) < 1 &&
        Math.abs(disclaimerBefore.bottom - disclaimerAfter.bottom) < 1,
      footerOrder:
        projections.nextElementSibling === composer && composer.nextElementSibling === disclaimer,
      documentVerticalOverflow:
        document.documentElement.scrollHeight > document.documentElement.clientHeight,
    };
  `);
}

afterEach(async () => {
  for (const liveTurn of liveTurns.splice(0)) liveTurn.abort();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  await Promise.all(
    scratchPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform !== "darwin" || !hasLoopback)("desktop chat panels", () => {
  it("hydrates persisted conversation pages without replay, focus loss, or row churn", async () => {
    const { fixture, calls } = await launch({
      width: 1440,
      height: 900,
      reducedMotion: false,
      transcriptHistory: true,
    });
    const hydrated = await fixture.evaluate<{
      readonly initialRows: number;
      readonly allRows: number;
      readonly initialAtNewest: boolean;
      readonly newerRowsStable: boolean;
      readonly anchorPreserved: boolean;
      readonly focusPreserved: boolean;
      readonly historySilent: boolean;
      readonly athleteLiteral: boolean;
      readonly coachMarkdown: boolean;
      readonly loadEarlierHidden: boolean;
      readonly sentAttachmentRestored: boolean;
    }>(`
      const conversation = document.querySelector(".conversation");
      const textarea = document.querySelector("#message");
      const loadEarlier = document.querySelector(".chat-history-load");
      const deadline = Date.now() + 5000;
      while (
        (document.querySelectorAll(".chat-message").length !== 4 || loadEarlier.hidden) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const initialRows = [...document.querySelectorAll(".chat-message")];
      const initialAtNewest =
        conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight <= 1;
      conversation.scrollTop = Math.max(0, initialRows[0].offsetTop - 40);
      const anchorTop = initialRows[0].getBoundingClientRect().top;
      textarea.focus();
      loadEarlier.click();
      while (
        document.querySelectorAll(".chat-message").length !== 8 &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const allRows = [...document.querySelectorAll(".chat-message")];
      return {
        initialRows: initialRows.length,
        allRows: allRows.length,
        initialAtNewest,
        newerRowsStable:
          allRows[4] === initialRows[0] &&
          allRows[5] === initialRows[1] &&
          allRows[6] === initialRows[2] &&
          allRows[7] === initialRows[3],
        anchorPreserved: Math.abs(initialRows[0].getBoundingClientRect().top - anchorTop) <= 1,
        focusPreserved: document.activeElement === textarea,
        historySilent: allRows.every((row) => row.getAttribute("aria-live") === "off"),
        athleteLiteral:
          allRows[4].querySelector(".chat-message__text")?.querySelectorAll("strong").length === 0 &&
          allRows[4].querySelector(".chat-message__text").textContent === "Persisted athlete 3",
        coachMarkdown:
          allRows[5].querySelector("strong")?.textContent === "Persisted coach 3",
        sentAttachmentRestored:
          allRows[4].textContent.includes("training-notes.txt") &&
          allRows[4].textContent.includes("TXT"),
        loadEarlierHidden: loadEarlier.hidden,
      };
    `);

    expect(hydrated).toEqual({
      initialRows: 4,
      allRows: 8,
      initialAtNewest: true,
      newerRowsStable: true,
      anchorPreserved: true,
      focusPreserved: true,
      historySilent: true,
      athleteLiteral: true,
      coachMarkdown: true,
      sentAttachmentRestored: true,
      loadEarlierHidden: true,
    });
    expect(calls.filter((call) => call.method === "getTranscriptPage")).toEqual([
      {
        jsonrpc: "2.0",
        method: "getTranscriptPage",
        params: { cursor: null, limit: 25 },
      },
      {
        jsonrpc: "2.0",
        method: "getTranscriptPage",
        params: { cursor: transcriptCursor, limit: 25 },
      },
    ]);
  }, 90_000);

  it("follows a live Chat stream only near the bottom and preserves reading position across navigation", async () => {
    const liveTurn = createLiveTurnControl();
    const evidenceDirectory = process.env.SCR_02_EVIDENCE_DIR;
    if (evidenceDirectory !== undefined) {
      await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
    }
    const { fixture, calls } = await launch({
      width: 1180,
      height: 820,
      reducedMotion: true,
      transcriptHistory: true,
      liveTurn,
      hidden: process.env.SCR_02_VISIBLE !== "1",
    });
    const beforeStream = await fixture.evaluate<{
      readonly rows: number;
      readonly bottomGap: number;
      readonly draft: string;
    }>(`
      const deadline = Date.now() + 5000;
      while (document.querySelectorAll(".chat-message").length !== 4 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const conversation = document.querySelector(".conversation");
      const textarea = document.querySelector("textarea#message");
      const form = textarea?.closest("form");
      if (!(conversation instanceof HTMLElement) || !(textarea instanceof HTMLTextAreaElement) ||
          !(form instanceof HTMLFormElement)) {
        throw new Error("live Chat fixture did not mount");
      }
      conversation.scrollTop = conversation.scrollHeight;
      conversation.dispatchEvent(new Event("scroll"));
      textarea.value = ${JSON.stringify(streamQuestion)};
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      form.requestSubmit();
      return {
        rows: document.querySelectorAll(".chat-message").length,
        bottomGap: conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight,
        draft: textarea.value,
      };
    `);
    await bounded(liveTurn.ready, 5_000, "live Chat stream did not attach");
    expect(beforeStream.rows).toBe(4);
    expect(beforeStream.bottomGap).toBeGreaterThanOrEqual(-1);
    expect(beforeStream.bottomGap).toBeLessThanOrEqual(1);
    expect(beforeStream.draft).toBe(streamQuestion);
    liveTurn.emit({ type: "turn-start", turnId: streamTurnId, chatId: "desktop" });
    const beforeFirstDelta = await fixture.evaluate<{
      readonly rows: number;
      readonly scrollTop: number;
      readonly scrollHeight: number;
      readonly bottomGap: number;
      readonly status: string | undefined;
    }>(`
      const deadline = Date.now() + 5000;
      const conversation = document.querySelector(".conversation");
      while (
        (document.querySelectorAll(".chat-message").length !== 5 ||
          conversation?.dataset.chatStatus !== "streaming") &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      if (!(conversation instanceof HTMLElement)) throw new Error("conversation missing");
      conversation.scrollTop = conversation.scrollHeight;
      conversation.dispatchEvent(new Event("scroll"));
      return {
        rows: document.querySelectorAll(".chat-message").length,
        scrollTop: conversation.scrollTop,
        scrollHeight: conversation.scrollHeight,
        bottomGap: conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight,
        status: conversation.dataset.chatStatus,
      };
    `);
    expect(beforeFirstDelta.rows).toBe(5);
    expect(beforeFirstDelta.status).toBe("streaming");
    expect(beforeFirstDelta.bottomGap).toBeLessThanOrEqual(1);

    liveTurn.emit({ type: "text_delta", turnId: streamTurnId, delta: firstStreamDelta });
    const following = await fixture.evaluate<{
      readonly scrollTop: number;
      readonly scrollHeight: number;
      readonly bottomGap: number;
      readonly status: string | undefined;
    }>(`
      const deadline = Date.now() + 5000;
      const conversation = document.querySelector(".conversation");
      const coachText = () =>
        Array.from(document.querySelectorAll(".chat-message--coach .chat-message__text")).at(-1)
          ?.textContent ?? "";
      while (!coachText().includes("Following update 28") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (!(conversation instanceof HTMLElement)) throw new Error("conversation missing");
      return {
        scrollTop: conversation.scrollTop,
        scrollHeight: conversation.scrollHeight,
        bottomGap: conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight,
        status: conversation.dataset.chatStatus,
      };
    `);
    expect(following.scrollHeight).toBeGreaterThan(beforeFirstDelta.scrollHeight);
    expect(following.scrollTop).toBeGreaterThan(beforeFirstDelta.scrollTop);
    expect(following.bottomGap).toBeLessThanOrEqual(1);
    expect(following.status).toBe("streaming");
    if (evidenceDirectory !== undefined) {
      await fixture.screenshot(join(evidenceDirectory, "scr-02-following.png"));
    }

    const readingPosition = await fixture.evaluate<{
      readonly anchorIndex: number;
      readonly anchorTop: number;
      readonly scrollTop: number;
      readonly scrollHeight: number;
      readonly bottomGap: number;
      readonly draft: string;
      readonly status: string | undefined;
    }>(`
      const conversation = document.querySelector(".conversation");
      const textarea = document.querySelector("textarea#message");
      if (!(conversation instanceof HTMLElement) || !(textarea instanceof HTMLTextAreaElement)) {
        throw new Error("reading surface missing");
      }
      textarea.value = ${JSON.stringify(streamDraft)};
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      const maximum = conversation.scrollHeight - conversation.clientHeight;
      conversation.scrollTop = Math.max(40, maximum - ${followLatestThreshold + 80});
      conversation.dispatchEvent(new Event("scroll"));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const conversationRect = conversation.getBoundingClientRect();
      const rows = Array.from(document.querySelectorAll(".chat-message"));
      const anchorIndex = rows.findIndex((row) => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > conversationRect.top && rect.top < conversationRect.bottom;
      });
      const anchor = rows[anchorIndex];
      if (!(anchor instanceof HTMLElement)) throw new Error("visible reading row missing");
      return {
        anchorIndex,
        anchorTop: anchor.getBoundingClientRect().top - conversationRect.top,
        scrollTop: conversation.scrollTop,
        scrollHeight: conversation.scrollHeight,
        bottomGap: conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight,
        draft: textarea.value,
        status: conversation.dataset.chatStatus,
      };
    `);
    expect(readingPosition.scrollTop).toBeGreaterThan(32);
    expect(readingPosition.bottomGap).toBeGreaterThan(followLatestThreshold);
    expect(readingPosition.draft).toBe(streamDraft);
    expect(readingPosition.status).toBe("streaming");

    liveTurn.emit({ type: "text_delta", turnId: streamTurnId, delta: secondStreamDelta });
    const afterReadingDelta = await fixture.evaluate<{
      readonly anchorTop: number;
      readonly scrollTop: number;
      readonly scrollHeight: number;
      readonly bottomGap: number;
      readonly draft: string;
      readonly status: string | undefined;
    }>(`
      const deadline = Date.now() + 5000;
      const coachText = () =>
        Array.from(document.querySelectorAll(".chat-message--coach .chat-message__text")).at(-1)
          ?.textContent ?? "";
      while (!coachText().includes("Reading update 12") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const conversation = document.querySelector(".conversation");
      const textarea = document.querySelector("textarea#message");
      const anchor = document.querySelectorAll(".chat-message")[${readingPosition.anchorIndex}];
      if (!(conversation instanceof HTMLElement) || !(textarea instanceof HTMLTextAreaElement) ||
          !(anchor instanceof HTMLElement)) {
        throw new Error("reading surface changed unexpectedly");
      }
      const conversationRect = conversation.getBoundingClientRect();
      return {
        anchorTop: anchor.getBoundingClientRect().top - conversationRect.top,
        scrollTop: conversation.scrollTop,
        scrollHeight: conversation.scrollHeight,
        bottomGap: conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight,
        draft: textarea.value,
        status: conversation.dataset.chatStatus,
      };
    `);
    expect(afterReadingDelta.scrollHeight).toBeGreaterThan(readingPosition.scrollHeight);
    expect(Math.abs(afterReadingDelta.scrollTop - readingPosition.scrollTop)).toBeLessThanOrEqual(
      1,
    );
    expect(Math.abs(afterReadingDelta.anchorTop - readingPosition.anchorTop)).toBeLessThanOrEqual(
      1,
    );
    expect(afterReadingDelta.bottomGap).toBeGreaterThan(followLatestThreshold);
    expect(afterReadingDelta.draft).toBe(streamDraft);
    expect(afterReadingDelta.status).toBe("streaming");
    if (evidenceDirectory !== undefined) {
      await fixture.screenshot(join(evidenceDirectory, "scr-02-scrolled-up.png"));
    }
    await visibleQaCheckpoint("scr-02-scrolled-up");

    const trainingView = await fixture.evaluate<{
      readonly view: string | null;
      readonly weeklySummary: string;
      readonly recentRides: string;
      readonly historyStatus: string;
    }>(`
      const navigation = document.querySelector('nav[aria-label="Main navigation"]');
      const training = Array.from(navigation?.querySelectorAll("button") ?? []).find(
        (entry) => entry.textContent?.trim() === "Training",
      );
      if (!(training instanceof HTMLButtonElement)) throw new Error("Training navigation missing");
      training.click();
      const deadline = Date.now() + 5000;
      while (!document.querySelector('[data-panel="weekly-summary"]') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const weeklySummary = document.querySelector('[data-panel="weekly-summary"]');
      const recentRides = document.querySelector('[data-panel="recent-rides"]');
      if (!(weeklySummary instanceof HTMLElement) || !(recentRides instanceof HTMLElement)) {
        throw new Error("week-first Training surface missing");
      }
      return {
        view: document.querySelector("[data-view]")?.getAttribute("data-view") ?? null,
        weeklySummary: weeklySummary.querySelector("h2")?.textContent ?? "",
        recentRides: recentRides.querySelector("h2")?.textContent ?? "",
        historyStatus: weeklySummary.querySelector("p")?.textContent ?? "",
      };
    `);
    expect(trainingView).toEqual({
      view: "training",
      weeklySummary: "Weekly summary",
      recentRides: "Recent rides",
      historyStatus: "This week",
    });
    liveTurn.emit({ type: "text_delta", turnId: streamTurnId, delta: thirdStreamDelta });
    const hiddenUpdate = await fixture.evaluate<{
      readonly view: string | null;
      readonly updated: boolean;
      readonly clientHeight: number;
      readonly scrollHeight: number;
    }>(`
      const deadline = Date.now() + 5000;
      const coachText = () =>
        Array.from(document.querySelectorAll(".chat-message--coach .chat-message__text")).at(-1)
          ?.textContent ?? "";
      while (!coachText().includes("Hidden update 12") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const conversation = document.querySelector(".conversation");
      if (!(conversation instanceof HTMLElement)) throw new Error("hidden conversation missing");
      return {
        view: document.querySelector("[data-view]")?.getAttribute("data-view") ?? null,
        updated: coachText().includes("Hidden update 12"),
        clientHeight: conversation.clientHeight,
        scrollHeight: conversation.scrollHeight,
      };
    `);
    expect(hiddenUpdate).toEqual({
      view: "training",
      updated: true,
      clientHeight: 0,
      scrollHeight: 0,
    });

    const returned = await fixture.evaluate<{
      readonly anchorTop: number;
      readonly scrollTop: number;
      readonly bottomGap: number;
      readonly draft: string;
      readonly status: string | undefined;
      readonly view: string | null;
    }>(`
      const navigation = document.querySelector('nav[aria-label="Main navigation"]');
      const chat = Array.from(navigation?.querySelectorAll("button") ?? []).find(
        (entry) => entry.textContent?.trim() === "Chat",
      );
      if (!(chat instanceof HTMLButtonElement)) throw new Error("Chat navigation missing");
      chat.click();
      const deadline = Date.now() + 5000;
      while (!document.querySelector('[data-view="chat"]') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const conversation = document.querySelector(".conversation");
      const textarea = document.querySelector("textarea#message");
      const anchor = document.querySelectorAll(".chat-message")[${readingPosition.anchorIndex}];
      if (!(conversation instanceof HTMLElement) || !(textarea instanceof HTMLTextAreaElement) ||
          !(anchor instanceof HTMLElement)) {
        throw new Error("returned reading surface missing");
      }
      const conversationRect = conversation.getBoundingClientRect();
      return {
        anchorTop: anchor.getBoundingClientRect().top - conversationRect.top,
        scrollTop: conversation.scrollTop,
        bottomGap: conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight,
        draft: textarea.value,
        status: conversation.dataset.chatStatus,
        view: document.querySelector("[data-view]")?.getAttribute("data-view") ?? null,
      };
    `);
    expect(Math.abs(returned.scrollTop - readingPosition.scrollTop)).toBeLessThanOrEqual(1);
    expect(Math.abs(returned.anchorTop - readingPosition.anchorTop)).toBeLessThanOrEqual(1);
    expect(returned.bottomGap).toBeGreaterThan(followLatestThreshold);
    expect(returned.draft).toBe(streamDraft);
    expect(returned.status).toBe("streaming");
    expect(returned.view).toBe("chat");
    if (evidenceDirectory !== undefined) {
      await fixture.screenshot(join(evidenceDirectory, "scr-02-returned.png"));
    }
    await visibleQaCheckpoint("scr-02-returned");

    const finalText = [firstStreamDelta, secondStreamDelta, thirdStreamDelta].join("\n\n");
    liveTurn.emit({ type: "final-text", turnId: streamTurnId, text: finalText });
    liveTurn.finish(finalText);
    const settled = await fixture.evaluate<{
      readonly anchorTop: number;
      readonly scrollTop: number;
      readonly bottomGap: number;
      readonly draft: string;
      readonly status: string | undefined;
      readonly finalTextVisible: boolean;
    }>(`
      const deadline = Date.now() + 5000;
      const conversation = document.querySelector(".conversation");
      const coachText = () =>
        Array.from(document.querySelectorAll(".chat-message--coach .chat-message__text")).at(-1)
          ?.textContent ?? "";
      while (
        (conversation?.dataset.chatStatus !== "idle" || !coachText().includes("Hidden update 12")) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const textarea = document.querySelector("textarea#message");
      const anchor = document.querySelectorAll(".chat-message")[${readingPosition.anchorIndex}];
      if (!(conversation instanceof HTMLElement) || !(textarea instanceof HTMLTextAreaElement) ||
          !(anchor instanceof HTMLElement)) {
        throw new Error("settled reading surface missing");
      }
      const conversationRect = conversation.getBoundingClientRect();
      return {
        anchorTop: anchor.getBoundingClientRect().top - conversationRect.top,
        scrollTop: conversation.scrollTop,
        bottomGap: conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight,
        draft: textarea.value,
        status: conversation.dataset.chatStatus,
        finalTextVisible: coachText().includes("Hidden update 12"),
      };
    `);
    expect(Math.abs(settled.scrollTop - readingPosition.scrollTop)).toBeLessThanOrEqual(1);
    expect(Math.abs(settled.anchorTop - readingPosition.anchorTop)).toBeLessThanOrEqual(1);
    expect(settled.bottomGap).toBeGreaterThan(followLatestThreshold);
    expect(settled.draft).toBe(streamDraft);
    expect(settled.status).toBe("idle");
    expect(settled.finalTextVisible).toBe(true);
    expect(calls.filter((call) => call.method === "resumeChatQueue")).toEqual([
      { jsonrpc: "2.0", method: "resumeChatQueue", params: { chatId: "desktop" } },
    ]);
    expect(calls.filter((call) => call.method === "getTranscriptPage")).toEqual([
      {
        jsonrpc: "2.0",
        method: "getTranscriptPage",
        params: { cursor: null, limit: 25 },
      },
    ]);
    expect(calls.filter((call) => call.method === "enqueueChatMessage")).toEqual([
      {
        jsonrpc: "2.0",
        method: "enqueueChatMessage",
        params: {
          chatId: "desktop",
          submissionId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
          text: streamQuestion,
        },
      },
    ]);
  }, 150_000);

  it("preserves IME composition until committed Enter", async () => {
    const { fixture, calls } = await launch({ width: 1440, height: 900, reducedMotion: false });
    const composingDraft = "回復走を";
    const composingEnter = await fixture.evaluate<{
      readonly isComposing: boolean;
      readonly dispatchResult: boolean;
      readonly defaultPrevented: boolean;
      readonly text: string;
      readonly focused: boolean;
      readonly chatStateUnchanged: boolean;
      readonly liveRegionUnchanged: boolean;
      readonly athleteRows: number;
      readonly quickActionClicks: number;
    }>(`
      const textarea = document.querySelector("#message");
      const submit = document.querySelector('.composer button[type="submit"]');
      const conversation = document.querySelector(".conversation");
      const liveRegion = document.querySelector(".new-conversation-status");
      const quickActions = [...document.querySelectorAll(".coaching-shortcut")];
      let quickActionClicks = 0;
      const recordQuickActionClick = () => {
        quickActionClicks += 1;
      };
      for (const quickAction of quickActions) {
        quickAction.addEventListener("click", recordQuickActionClick);
      }
      textarea.value = ${JSON.stringify(composingDraft)};
      textarea.focus();
      const chatStateBefore = JSON.stringify({
        status: conversation.dataset.chatStatus,
        textareaDisabled: textarea.disabled,
        submitDisabled: submit.disabled,
      });
      const liveRegionBefore = JSON.stringify({
        html: liveRegion.innerHTML,
        role: liveRegion.getAttribute("role"),
        ariaLive: liveRegion.getAttribute("aria-live"),
      });
      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        isComposing: true,
        bubbles: true,
        cancelable: true,
      });
      const dispatchResult = textarea.dispatchEvent(event);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      for (const quickAction of quickActions) {
        quickAction.removeEventListener("click", recordQuickActionClick);
      }
      return {
        isComposing: event.isComposing,
        dispatchResult,
        defaultPrevented: event.defaultPrevented,
        text: textarea.value,
        focused: document.activeElement === textarea,
        chatStateUnchanged:
          JSON.stringify({
            status: conversation.dataset.chatStatus,
            textareaDisabled: textarea.disabled,
            submitDisabled: submit.disabled,
          }) === chatStateBefore,
        liveRegionUnchanged:
          JSON.stringify({
            html: liveRegion.innerHTML,
            role: liveRegion.getAttribute("role"),
            ariaLive: liveRegion.getAttribute("aria-live"),
          }) === liveRegionBefore,
        athleteRows: document.querySelectorAll(".chat-message--athlete").length,
        quickActionClicks,
      };
    `);
    expect(composingEnter).toEqual({
      isComposing: true,
      dispatchResult: true,
      defaultPrevented: false,
      text: composingDraft,
      focused: true,
      chatStateUnchanged: true,
      liveRegionUnchanged: true,
      athleteRows: 0,
      quickActionClicks: 0,
    });
    expect(calls.filter((call) => call.method === "enqueueChatMessage")).toHaveLength(0);

    const committedMessage = "回復走を30分します。";
    const committedEnter = await fixture.evaluate<{
      readonly isComposing: boolean;
      readonly dispatchResult: boolean;
      readonly defaultPrevented: boolean;
      readonly athleteMessages: readonly string[];
      readonly quickActionClicks: number;
    }>(`
      const textarea = document.querySelector("#message");
      const quickActions = [...document.querySelectorAll(".coaching-shortcut")];
      let quickActionClicks = 0;
      const recordQuickActionClick = () => {
        quickActionClicks += 1;
      };
      for (const quickAction of quickActions) {
        quickAction.addEventListener("click", recordQuickActionClick);
      }
      textarea.value = ${JSON.stringify(committedMessage)};
      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      });
      const dispatchResult = textarea.dispatchEvent(event);
      const deadline = Date.now() + 5000;
      while (
        document.querySelectorAll(".chat-message--athlete").length === 0 &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      for (const quickAction of quickActions) {
        quickAction.removeEventListener("click", recordQuickActionClick);
      }
      return {
        isComposing: event.isComposing,
        dispatchResult,
        defaultPrevented: event.defaultPrevented,
        athleteMessages: [...document.querySelectorAll(".chat-message--athlete")].map(
          (row) => row.querySelector(".chat-message__text")?.textContent ?? "",
        ),
        quickActionClicks,
      };
    `);
    expect(committedEnter).toEqual({
      isComposing: false,
      dispatchResult: false,
      defaultPrevented: true,
      athleteMessages: [committedMessage],
      quickActionClicks: 0,
    });
    expect(calls.filter((call) => call.method === "enqueueChatMessage")).toEqual([
      {
        jsonrpc: "2.0",
        method: "enqueueChatMessage",
        params: {
          chatId: "desktop",
          submissionId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
          text: committedMessage,
        },
      },
    ]);
    expect(calls.filter((call) => call.method === "resumeChatQueue")).toEqual([
      { jsonrpc: "2.0", method: "resumeChatQueue", params: { chatId: "desktop" } },
    ]);
  }, 90_000);

  it("streams chat, proves no-change sync, preserves focus, and fits desktop geometry", async () => {
    const { fixture, calls } = await launch({ width: 1440, height: 900, reducedMotion: false });
    const initial = await fixture.evaluate<{
      readonly location: string;
      readonly bridgeKeys: readonly string[];
      readonly thread: boolean;
      readonly partial: string;
      readonly final: string;
      readonly athleteStable: boolean;
      readonly coachStable: boolean;
      readonly busyObserved: boolean;
      readonly busyCleared: boolean;
      readonly partialWhiteSpace: string | null;
      readonly partialSourcePreserved: boolean;
      readonly streamingInputEnabled: boolean;
      readonly streamingStopEnabled: boolean;
      readonly quickActionsAbsent: boolean;
      readonly streamingEnterHandled: boolean;
      readonly streamingDraftCleared: boolean;
      readonly streamingQueued: readonly string[];
      readonly streamingQueueCleared: boolean;
      readonly streamingFocusPreserved: boolean;
      readonly settledSendEnabled: boolean;
      readonly settledDraftPreserved: boolean;
      readonly settledFocusPreserved: boolean;
      readonly controlExercised: boolean;
      readonly controlOnlyMutations: number;
      readonly heading: string;
      readonly strong: string;
      readonly hostileTextVisible: boolean;
      readonly hostileElementCount: number;
      readonly link: {
        readonly href: string | null;
        readonly target: string | null;
        readonly rel: string | null;
        readonly referrerPolicy: string | null;
      };
      readonly syncChip: { readonly status: string; readonly text: string };
      readonly documentOverflow: boolean;
    }>(`
      const bridgeKeys = Object.keys(window.enduragentAuth).sort();
      const thread = document.querySelectorAll(".thread").length === 1;
      const textarea = document.querySelector("#message");
      const observed = [];
      let athleteRow;
      let coachRow;
      let athleteStable = true;
      let coachStable = true;
      let busyObserved = false;
      let busyCleared = false;
      let partialWhiteSpace = null;
      let partialSourcePreserved = false;
      const capturePartial = (candidate) => {
        if (!candidate.includes("Hold   **ste") || candidate.includes("ady**")) return;
        partialSourcePreserved =
          candidate.startsWith("## Today’s ride") &&
          candidate.includes(String.fromCharCode(10) + String.fromCharCode(10));
        partialWhiteSpace = getComputedStyle(
          document.querySelector(".chat-message--coach .chat-message__text"),
        ).whiteSpace;
      };
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === "characterData" && record.oldValue) {
            observed.push(record.oldValue);
            capturePartial(record.oldValue);
          }
          if (record.type === "attributes" && record.attributeName === "aria-busy" && record.oldValue === "true") {
            busyObserved = true;
          }
        }
        const value = document.querySelector(".chat-message--coach .chat-message__text")?.textContent ?? "";
        if (value.length > 0) {
          observed.push(value);
          capturePartial(value);
        }
        const currentAthlete = document.querySelector(".chat-message--athlete");
        const currentCoach = document.querySelector(".chat-message--coach");
        if (currentAthlete && athleteRow && currentAthlete !== athleteRow) athleteStable = false;
        if (currentCoach && coachRow && currentCoach !== coachRow) coachStable = false;
        athleteRow ??= currentAthlete;
        coachRow ??= currentCoach;
        if (currentCoach?.getAttribute("aria-busy") === "true") busyObserved = true;
        if (busyObserved && currentCoach && !currentCoach.hasAttribute("aria-busy")) busyCleared = true;
      });
      observer.observe(document.querySelector(".chat-messages"), {
        attributes: true,
        attributeOldValue: true,
        attributeFilter: ["aria-busy"],
        childList: true,
        characterData: true,
        characterDataOldValue: true,
        subtree: true,
      });
      textarea.value = "What should I ride?";
      textarea.closest("form").requestSubmit();
      const streamingDeadline = Date.now() + 5000;
      while (
        document.querySelector(".conversation").dataset.chatStatus !== "streaming" &&
        Date.now() < streamingDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      textarea.value = "How should I recover?";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      // A real key press occurs in a later browser task. Let React commit the
      // controlled draft before exercising Enter so this test observes the
      // product path instead of racing the synthetic input event.
      await new Promise((resolve) => setTimeout(resolve, 0));
      textarea.focus();
      const streamingInputEnabled = !textarea.disabled;
      const stop = document.querySelector('[aria-label="Stop responding"]');
      const streamingStopEnabled = stop !== null && !stop.disabled;
      const quickActionsAbsent = document.querySelector(".coaching-shortcuts") === null;
      const streamingEnter = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      });
      textarea.dispatchEvent(streamingEnter);
      const streamingEnterHandled = streamingEnter.defaultPrevented;
      const streamingFocusPreserved = document.activeElement === textarea;
      const queueDeadline = Date.now() + 5000;
      while (
        (textarea.value !== "" ||
          document.querySelector(".chat-queue__text")?.textContent !== "How should I recover?") &&
        Date.now() < queueDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const streamingDraftCleared = textarea.value === "";
      const streamingQueued = [...document.querySelectorAll(".chat-queue__text")].map(
        (node) => node.textContent,
      );
      document.querySelector(".chat-queue__remove")?.click();
      const removalDeadline = Date.now() + 5000;
      while (document.querySelector(".chat-queue") && Date.now() < removalDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const streamingQueueCleared = document.querySelector(".chat-queue") === null;
      textarea.value = "How should I recover?";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.focus();
      athleteRow ??= document.querySelector(".chat-message--athlete");
      const finalDeadline = Date.now() + 5000;
      let final = "";
      while (Date.now() < finalDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const currentCoach = document.querySelector(".chat-message--coach");
        final = currentCoach?.querySelector(".chat-message__text")?.textContent ?? "";
        if (
          final.includes("<script>globalThis.hostile = true</script>") &&
          final.includes("Guide") &&
          !currentCoach?.hasAttribute("aria-busy")
        ) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      observer.disconnect();
      const settledSend = textarea.closest("form").querySelector('button[type="submit"]');
      const settledSendEnabled = settledSend !== null && !settledSend.disabled;
      const settledDraftPreserved = textarea.value === "How should I recover?";
      const settledFocusPreserved = document.activeElement === textarea;
      const partial = observed.find(
        (value) => value.includes("Hold   **ste") && !value.includes("ady**"),
      ) ?? "";
      const opener = document.querySelector(".new-conversation-button");
      const controlDeadline = Date.now() + 5000;
      while (
        (opener.disabled || opener.getAttribute("aria-disabled") === "true") &&
        Date.now() < controlDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const controlRecords = [];
      const controlObserver = new MutationObserver((records) => controlRecords.push(...records));
      controlObserver.observe(document.querySelector(".chat-messages"), {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      });
      const controlExercised = !opener.disabled && opener.getAttribute("aria-disabled") !== "true";
      if (controlExercised) {
        opener.click();
        document.querySelector(".new-conversation-dialog button")?.click();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      controlObserver.disconnect();
      const coach = document.querySelector(".chat-message--coach");
      const link = coach?.querySelector("a");
      const syncChip = document.querySelector("[data-sync-chip]");
      return {
        location: location.href,
        bridgeKeys,
        thread,
        partial,
        final,
        athleteStable: athleteStable && athleteRow === document.querySelector(".chat-message--athlete"),
        coachStable: coachStable && coachRow === coach,
        busyObserved,
        busyCleared,
        partialWhiteSpace,
        partialSourcePreserved,
        streamingInputEnabled,
        streamingStopEnabled,
        quickActionsAbsent,
        streamingEnterHandled,
        streamingDraftCleared,
        streamingQueued,
        streamingQueueCleared,
        streamingFocusPreserved,
        settledSendEnabled,
        settledDraftPreserved,
        settledFocusPreserved,
        controlExercised,
        controlOnlyMutations: controlRecords.length,
        heading: coach?.querySelector("h2")?.textContent ?? "",
        strong: coach?.querySelector("strong")?.textContent ?? "",
        hostileTextVisible: coach?.textContent.includes("<script>globalThis.hostile = true</script>") ?? false,
        hostileElementCount: coach?.querySelectorAll("script, img").length ?? -1,
        link: {
          href: link?.getAttribute("href") ?? null,
          target: link?.getAttribute("target") ?? null,
          rel: link?.getAttribute("rel") ?? null,
          referrerPolicy: link?.getAttribute("referrerpolicy") ?? null,
        },
        syncChip: {
          status: syncChip?.dataset.status ?? "missing",
          text: syncChip?.textContent ?? "missing",
        },
        documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    `);
    expect(isDesktopRendererUrl(initial.location)).toBe(true);
    expect(initial).toEqual({
      location: expect.any(String),
      bridgeKeys: [
        "acknowledgeTelegramGapWarning",
        "addTelegramAllowedSender",
        "applyLlmSelection",
        "beginTelegramPairing",
        "cancelChatgptLogin",
        "cancelTelegramPairing",
        "chatgptLogin",
        "chatgptStatus",
        "checkForUpdates",
        "chooseChatAttachments",
        "chooseImportFiles",
        "choosePlanRaceCourseFile",
        "claudeCliRecheck",
        "claudeCliStatus",
        "credentialRecoveryStatus",
        "credentialStatuses",
        "deleteArchivedConversation",
        "deleteCredential",
        "disableTelegram",
        "enableTelegram",
        "executePlanTransition",
        "exportTrainingFile",
        "getArchivedTranscriptPage",
        "getDaemonConnection",
        "getPlanState",
        "getPlanningReadModel",
        "getTranscriptPage",
        "getUpdateState",
        "initialSetupStatusSettled",
        "listArchivedConversations",
        "listTelegramAllowedSenders",
        "llmConfiguration",
        "onChatgptLoginProgress",
        "onDroppedChatAttachments",
        "onDroppedImportFiles",
        "onOpenSettings",
        "onPlanProgress",
        "onUpdateState",
        "pasteChatAttachment",
        "pasteIntervalsApiKeyFromClipboard",
        "pasteTelegramTokenFromClipboard",
        "platform",
        "reconcileTelegram",
        "removeTelegram",
        "removeTelegramAllowedSender",
        "removeTelegramWebhook",
        "resetAllCredentials",
        "restartToUpdate",
        "retryCredentialRecovery",
        "retryFailedCredentials",
        "setAppearance",
        "telegramStatus",
        "writeCredential",
      ],
      thread: true,
      partial: "## Today’s ride\n\nHold   **ste",
      final: expect.stringContaining("<script>globalThis.hostile = true</script>"),
      athleteStable: true,
      coachStable: true,
      busyObserved: true,
      busyCleared: true,
      partialWhiteSpace: "pre-wrap",
      partialSourcePreserved: true,
      streamingInputEnabled: true,
      streamingStopEnabled: true,
      quickActionsAbsent: true,
      streamingEnterHandled: true,
      streamingDraftCleared: true,
      streamingQueued: ["How should I recover?"],
      streamingQueueCleared: true,
      streamingFocusPreserved: true,
      settledSendEnabled: true,
      settledDraftPreserved: true,
      settledFocusPreserved: true,
      controlExercised: true,
      controlOnlyMutations: 0,
      heading: "Today’s ride",
      strong: "steady",
      hostileTextVisible: true,
      hostileElementCount: 0,
      link: {
        href: "https://example.test/guide",
        target: "_blank",
        rel: "noopener noreferrer",
        referrerPolicy: "no-referrer",
      },
      syncChip: {
        status: "synced",
        text: "Training data synced2026-07-19 07:55:00 UTCSync now",
      },
      documentOverflow: false,
    });
    expect(calls.filter((call) => call.method === "hasSession")).toEqual([
      {
        jsonrpc: "2.0",
        method: "hasSession",
        params: { chatId: "desktop" },
      },
    ]);
    const readingRoom = await fixture.evaluate<{
      readonly heading: string | null;
      readonly quickActionsAbsent: boolean;
      readonly contextVisibleBefore: boolean;
      readonly contextVisibleAfter: boolean;
      readonly draft: string;
      readonly documentOverflow: boolean;
      readonly composerHeight: number;
      readonly composerOpaque: boolean;
      readonly finalTranscriptClearsComposer: boolean;
    }>(`
      const textarea = document.querySelector("#message");
      textarea.value = "  keep draft\\n";
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const contextVisibleBefore = document.querySelector(".training-context") !== null;
      document.querySelector('[aria-label="Hide training context"]')?.click();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const contextVisibleAfter = document.querySelector(".training-context") !== null;
      const conversation = document.querySelector(".conversation");
      const composer = document.querySelector(".composer-wrap");
      conversation.scrollTop = conversation.scrollHeight;
      const composerRect = composer.getBoundingClientRect();
      const finalTranscriptItem = [...document.querySelectorAll(".chat-message, .chat-notice, .chat-retry")]
        .filter((node) => !node.hidden)
        .at(-1);
      return {
        heading: document.querySelector(".chat-surface h1")?.textContent ?? null,
        quickActionsAbsent: document.querySelector(".coaching-shortcuts") === null,
        contextVisibleBefore,
        contextVisibleAfter,
        draft: textarea.value,
        documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        composerHeight: composerRect.height,
        composerOpaque: getComputedStyle(composer).backgroundColor !== "rgba(0, 0, 0, 0)",
        finalTranscriptClearsComposer:
          finalTranscriptItem.getBoundingClientRect().bottom <= composerRect.top + 1,
      };
    `);
    expect(readingRoom).toEqual({
      heading: "Chat",
      quickActionsAbsent: true,
      contextVisibleBefore: true,
      contextVisibleAfter: false,
      draft: "  keep draft\n",
      documentOverflow: false,
      composerHeight: expect.any(Number),
      composerOpaque: true,
      finalTranscriptClearsComposer: true,
    });
    expect(readingRoom.composerHeight).toBeGreaterThan(0);
    await fixture.setViewport(1180, 820);
    expect(await stackedProjectionGeometry(fixture)).toEqual({
      attachmentIssue: false,
      planningIssue: true,
      composerWithinViewport: true,
      disclaimerWithinViewport: true,
      projectionsScrollLocally: true,
      disclaimerStableAfterProjectionScroll: true,
      footerOrder: true,
      documentVerticalOverflow: false,
    });
    await fixture.setViewport(760, 820);
    expect(await stackedProjectionGeometry(fixture)).toEqual({
      attachmentIssue: false,
      planningIssue: true,
      composerWithinViewport: true,
      disclaimerWithinViewport: true,
      projectionsScrollLocally: true,
      disclaimerStableAfterProjectionScroll: true,
      footerOrder: true,
      documentVerticalOverflow: false,
    });
    await fixture.setViewport(720, 800);
    const compact = await fixture.evaluate<{
      readonly documentOverflow: boolean;
      readonly tableScrollsLocally: boolean;
      readonly codeScrollsLocally: boolean;
      readonly contextDrawerOpened: boolean;
      readonly composerOpaque: boolean;
      readonly composerHeight: number;
      readonly finalTranscriptClearsComposer: boolean;
    }>(`
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const tableScroll = document.querySelector(".chat-markdown__table-scroll");
        const codeBlock = document.querySelector(".chat-message--coach pre");
        const conversation = document.querySelector(".conversation");
        const composer = document.querySelector(".composer-wrap");
        document.querySelector('[aria-label="Show training context"]')?.click();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const contextDrawerOpened = document.querySelector('[data-slot="dialog-content"] .training-context') !== null;
        conversation.scrollTop = conversation.scrollHeight;
        const composerRect = composer.getBoundingClientRect();
        const finalTranscriptItem = [...document.querySelectorAll(".chat-message, .chat-notice, .chat-retry")]
          .filter((node) => !node.hidden)
          .at(-1);
        return {
          documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          tableScrollsLocally: tableScroll.scrollWidth > tableScroll.clientWidth && getComputedStyle(tableScroll).overflowX === "auto",
          codeScrollsLocally: codeBlock.scrollWidth > codeBlock.clientWidth && getComputedStyle(codeBlock).overflowX === "auto",
          contextDrawerOpened,
          composerOpaque: getComputedStyle(composer).backgroundColor !== "rgba(0, 0, 0, 0)",
          composerHeight: composerRect.height,
          finalTranscriptClearsComposer:
            finalTranscriptItem.getBoundingClientRect().bottom <= composerRect.top + 1,
        };
      `);
    expect(compact).toEqual({
      documentOverflow: false,
      tableScrollsLocally: true,
      codeScrollsLocally: true,
      contextDrawerOpened: true,
      composerOpaque: true,
      composerHeight: expect.any(Number),
      finalTranscriptClearsComposer: true,
    });
    expect(compact.composerHeight).toBeGreaterThan(0);
    await fixture.pressKey("Tab");
    await fixture.pressKey("Tab");
    await fixture.pressKey("Tab", { shift: true });
    await fixture.pressKey("Escape");
    expect(
      await fixture.evaluate<{
        readonly drawerClosed: boolean;
        readonly triggerFocused: boolean;
      }>(`
        const closeDeadline = Date.now() + 2000;
        while (
          document.querySelector('[data-slot="dialog-content"]') !== null &&
          Date.now() < closeDeadline
        ) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        const trigger = document.querySelector('[aria-label="Show training context"]');
        return {
          drawerClosed: document.querySelector('[data-slot="dialog-content"]') === null,
          triggerFocused: document.activeElement === trigger,
        };
      `),
    ).toEqual({ drawerClosed: true, triggerFocused: true });
    const reset = await fixture.evaluate<{
      readonly enabledBefore: boolean;
      readonly dialogOpen: boolean;
      readonly transcriptEmpty: boolean;
      readonly composerValue: string;
      readonly composerInputDisabled: boolean;
      readonly resetDisabled: boolean;
      readonly focused: string | null;
      readonly transcriptClearMutations: number;
    }>(`
      const opener = document.querySelector(".new-conversation-button");
      const textarea = document.querySelector("#message");
      const readyDeadline = Date.now() + 5000;
      while ((opener.disabled || opener.getAttribute("aria-disabled") === "true" || textarea.disabled) && Date.now() < readyDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const enabledBefore = !opener.disabled && opener.getAttribute("aria-disabled") !== "true" && !textarea.disabled;
      if (enabledBefore) opener.click();
      const dialog = document.querySelector(".new-conversation-dialog");
      const dialogOpen = dialog !== null;
      const clearRecords = [];
      const clearObserver = new MutationObserver((records) => clearRecords.push(...records));
      clearObserver.observe(document.querySelector(".chat-messages"), { childList: true });
      if (dialogOpen) dialog.querySelector(".new-conversation-dialog__confirm").click();
      const resetDeadline = Date.now() + 5000;
      while (document.querySelector(".new-conversation-dialog") !== null && Date.now() < resetDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      clearObserver.disconnect();
      return {
        enabledBefore,
        dialogOpen,
        transcriptEmpty: document.querySelectorAll(".chat-message").length === 0,
        composerValue: textarea.value,
        composerInputDisabled: textarea.disabled,
        resetDisabled: opener.disabled,
        focused: document.activeElement?.id ?? null,
        transcriptClearMutations: clearRecords.filter((record) => record.type === "childList").length,
      };
    `);
    expect(reset).toEqual({
      enabledBefore: true,
      dialogOpen: true,
      transcriptEmpty: true,
      composerValue: "",
      composerInputDisabled: false,
      resetDisabled: true,
      focused: "message",
      transcriptClearMutations: 1,
    });
    expect(calls.filter((call) => call.method === "resetSession")).toEqual([
      {
        jsonrpc: "2.0",
        method: "resetSession",
        params: { chatId: "desktop" },
      },
    ]);
    const training = await fixture.evaluate<{
      readonly current: string | null;
      readonly order: readonly string[];
      readonly retiredPanelsAbsent: boolean;
      readonly pageOverflow: boolean;
      readonly documentOverflow: boolean;
      readonly sync: {
        readonly buttonResident: boolean;
        readonly initialStatus: string;
        readonly initialLabel: string | null;
        readonly syncingObserved: boolean;
        readonly syncingLabel: string | null;
        readonly disabledWhileSyncing: boolean;
        readonly ariaBusyAbsentWhileSyncing: boolean;
        readonly terminalStatus: string;
        readonly terminalLabel: string | null;
        readonly busyCleared: boolean;
        readonly keyboardFocusRestored: boolean;
        readonly syncDetailChanged: boolean;
        readonly trainingPanelsUnchanged: boolean;
        readonly detailBefore: string;
        readonly detailAfter: string;
        readonly chipFitsSidebar: boolean;
        readonly chipHasNoOverflow: boolean;
        readonly buttonReachable: boolean;
      };
    }>(`
      const rail = document.querySelector('nav[aria-label="Main navigation"]');
      const trainingNav = Array.from(rail.querySelectorAll("button")).find(
        (entry) => entry.textContent.includes("Training"),
      );
      trainingNav.click();
      const mountDeadline = Date.now() + 5000;
      while (!document.querySelector('[data-panel="weekly-summary"]') && Date.now() < mountDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const page = document.querySelector('section[aria-label="Training"]');
      const panels = [...page.querySelectorAll("[data-panel]")];
      const opened = {
        current: trainingNav.getAttribute("aria-current"),
        order: panels.map((entry) => entry.dataset.panel),
        retiredPanelsAbsent: ["anchor", "load", "wellness", "plan", "adherence"].every(
          (name) => page.querySelector('[data-panel="' + name + '"]') === null,
        ),
      };
      const syncButton = document.querySelector("button.sync-chip");
      const syncSurface = document.querySelector("[data-sync-chip]");
      const sidebar = syncSurface.closest("aside");
      const syncDetail = () => syncSurface.querySelector('[role="status"]')?.textContent ?? "";
      const panelsBefore = panels.map((panel) => panel.textContent ?? "");
      const initialStatus = syncButton.dataset.status;
      const initialLabel = syncButton.getAttribute("aria-label");
      const detailBefore = syncDetail();
      syncButton.focus();
      syncButton.click();
      const syncingDeadline = Date.now() + 5000;
      while (syncButton.dataset.status !== "syncing" && Date.now() < syncingDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const syncingObserved = syncButton.dataset.status === "syncing";
      const syncingLabel = syncButton.getAttribute("aria-label");
      const disabledWhileSyncing = syncButton.disabled;
      const ariaBusyAbsentWhileSyncing = !syncButton.hasAttribute("aria-busy");
      syncButton.click();
      syncButton.blur();
      const syncDeadline = Date.now() + 5000;
      while (
        (syncButton.dataset.status !== "synced" || syncDetail() === detailBefore) &&
        Date.now() < syncDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const detailAfter = syncDetail();
      const panelsAfter = [...page.querySelectorAll("[data-panel]")].map(
        (panel) => panel.textContent ?? "",
      );
      const syncButtonRect = syncButton.getBoundingClientRect();
      const syncSurfaceRect = syncSurface.getBoundingClientRect();
      const sidebarRect = sidebar.getBoundingClientRect();
      const syncResult = {
        buttonResident:
          syncButton === document.querySelector("button.sync-chip") &&
          document.querySelectorAll("button.sync-chip").length === 1,
        initialStatus,
        initialLabel,
        syncingObserved,
        syncingLabel,
        disabledWhileSyncing,
        ariaBusyAbsentWhileSyncing,
        terminalStatus: syncButton.dataset.status,
        terminalLabel: syncButton.getAttribute("aria-label"),
        busyCleared: !syncButton.hasAttribute("aria-busy") && !syncButton.disabled,
        keyboardFocusRestored: document.activeElement === syncButton,
        syncDetailChanged: detailAfter !== detailBefore,
        trainingPanelsUnchanged: JSON.stringify(panelsBefore) === JSON.stringify(panelsAfter),
        detailBefore,
        detailAfter,
        chipFitsSidebar:
          syncSurfaceRect.left >= sidebarRect.left && syncSurfaceRect.right <= sidebarRect.right,
        chipHasNoOverflow: syncSurface.scrollWidth <= syncSurface.clientWidth,
        buttonReachable:
          syncButtonRect.left >= 0 &&
          syncButtonRect.right <= window.innerWidth &&
          syncButtonRect.top >= 0 &&
          syncButtonRect.bottom <= window.innerHeight,
      };
      return {
        ...opened,
        pageOverflow: Array.from(page.querySelectorAll("section, div, ol, dl")).some(
          (node) => node.scrollWidth > node.clientWidth,
        ),
        documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        sync: syncResult,
      };
    `);
    expect(training).toEqual({
      current: "page",
      order: ["weekly-summary", "recent-rides"],
      retiredPanelsAbsent: true,
      pageOverflow: false,
      documentOverflow: false,
      sync: {
        buttonResident: true,
        initialStatus: "synced",
        initialLabel: "Sync now · Training data synced · 2026-07-19 07:55:00 UTC",
        syncingObserved: true,
        syncingLabel: "Sync now · Syncing · Sync queued.",
        disabledWhileSyncing: true,
        ariaBusyAbsentWhileSyncing: true,
        terminalStatus: "synced",
        terminalLabel:
          "Sync again · Training data synced · Local training-data processing completed.",
        busyCleared: true,
        keyboardFocusRestored: true,
        syncDetailChanged: true,
        trainingPanelsUnchanged: true,
        detailBefore: "2026-07-19 07:55:00 UTC",
        detailAfter: "Local training-data processing completed.",
        chipFitsSidebar: true,
        chipHasNoOverflow: true,
        buttonReachable: true,
      },
    });
    const rideReview = await fixture.evaluate<{
      readonly page: string | null;
      readonly titleFocused: boolean;
      readonly overview: string;
      readonly canonicalIdVisible: boolean;
      readonly pageOverflow: boolean;
      readonly documentOverflow: boolean;
      readonly drift: string;
      readonly limitation: string;
      readonly interval: string;
      readonly efforts: string;
      readonly powerDistribution: boolean;
      readonly heartRateDistribution: boolean;
      readonly powerHeartRate: boolean;
    }>(`
      const recent = document.querySelector('[data-panel="recent-rides"]');
      const opener = recent.querySelector("button");
      opener.scrollIntoView({ block: "nearest" });
      opener.click();
      const mountDeadline = Date.now() + 5000;
      while (!document.querySelector('section[aria-label="Ride review"]') && Date.now() < mountDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const page = document.querySelector('section[aria-label="Ride review"]');
      const title = page.querySelector("h1");
      const titleFocused = document.activeElement === title;
      const analysisDisclosure = [...page.querySelectorAll("summary")].find(
        (entry) => entry.textContent.includes("Recorded analysis"),
      );
      analysisDisclosure.click();
      const analysisDeadline = Date.now() + 5000;
      while (
        (!page.textContent.includes("+4.8%") ||
          !page.textContent.includes("Threshold") ||
          !page.textContent.includes("17 min of measured ride time · 3 recorded buckets") ||
          !page.textContent.includes("17 min of measured ride time · 2 recorded buckets") ||
          !page.textContent.includes("60%ride coverage")) &&
        Date.now() < analysisDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const powerHeartRatePanel = page.querySelector('[aria-labelledby="power-heart-rate-title"]');
      return {
        page: page.getAttribute("aria-label"),
        titleFocused,
        overview: page.querySelector('[aria-labelledby="ride-overview-title"]').textContent,
        canonicalIdVisible: page.textContent.includes("${"c".repeat(64)}"),
        pageOverflow: Array.from(page.querySelectorAll("section, div, dl")).some(
          (node) => node.scrollWidth > node.clientWidth,
        ),
        documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        drift: page.querySelector('[aria-label^="Observed efficiency-factor change"]')?.textContent ?? "",
        limitation: page.querySelector('[aria-label="Analysis limitations"]')?.textContent ?? "",
        interval: page.querySelector('[aria-labelledby="interval-review-title"]')?.textContent ?? "",
        efforts: page.querySelector('[aria-labelledby="best-efforts-title"]')?.textContent ?? "",
        powerDistribution: page
          .querySelector('[aria-labelledby="powerDistribution-title"]')
          ?.textContent.includes("17 min of measured ride time · 3 recorded buckets") ?? false,
        heartRateDistribution: page
          .querySelector('[aria-labelledby="heartRateDistribution-title"]')
          ?.textContent.includes("17 min of measured ride time · 2 recorded buckets") ?? false,
        powerHeartRate:
          powerHeartRatePanel?.textContent.includes("60%ride coverage") === true &&
          powerHeartRatePanel.textContent.includes("No missing points or lines are interpolated."),
      };
    `);
    expect(rideReview).toEqual({
      page: "Ride review",
      titleFocused: true,
      overview: "Road rideRoad rideDateJul 18, 2026 · 12:00 PMRiding time1h 25mDistance42.1 km",
      canonicalIdVisible: false,
      pageOverflow: false,
      documentOverflow: false,
      drift: "+4.8%",
      limitation: "No moving-status stream was available, so stopped time may be included.",
      interval:
        "Ordered ride segmentsIntervals and lapsShows recorded segments in order. Missing metrics stay unavailable, and no planned workout targets are inferred.Ordered analysis from intervals.icu1WorkThresholdDuration5 minDistance2.5 kmPower250 avg · 310 max WHeart rate155 avg · 170 max bpmCadence91 avg · 104 max rpmZoneZone 4Intensity96%Training load12",
      efforts:
        "Selected-ride scopeFive-minute best effortsRanks measured five-minute power efforts from this ride only. It does not compare against other rides or all-history results.This ride · power · 5 min · equal efforts rank the earlier start first#1310 W2.6 km",
      powerDistribution: true,
      heartRateDistribution: true,
      powerHeartRate: true,
    });
    const rideReturn = await fixture.evaluate<{
      readonly page: string | null;
      readonly openerFocused: boolean;
    }>(`
      document.querySelector('section[aria-label="Ride review"] button').click();
      const mountDeadline = Date.now() + 5000;
      while (!document.querySelector('section[aria-label="Training"]') && Date.now() < mountDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const page = document.querySelector('section[aria-label="Training"]');
      const opener = page.querySelector('[data-panel="recent-rides"] button');
      return { page: page.getAttribute("aria-label"), openerFocused: document.activeElement === opener };
    `);
    expect(rideReturn).toEqual({ page: "Training", openerFocused: true });
    const units = await fixture.evaluate<{
      readonly pressed: string | null;
      readonly enabled: boolean;
    }>(`
      const rail = document.querySelector('nav[aria-label="Main navigation"]');
      Array.from(rail.querySelectorAll("button"))
        .find((entry) => entry.textContent.includes("Settings"))
        .click();
      const mountDeadline = Date.now() + 5000;
      while (!document.querySelector('[role="group"][aria-label="Display units"]') && Date.now() < mountDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const group = document.querySelector('[role="group"][aria-label="Display units"]');
      const imperial = Array.from(group.querySelectorAll("button")).find(
        (entry) => entry.textContent === "Imperial",
      );
      imperial.click();
      const unitsDeadline = Date.now() + 5000;
      while (imperial.getAttribute("aria-pressed") !== "true" && Date.now() < unitsDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const settled = Array.from(
        document.querySelectorAll('[role="group"][aria-label="Display units"] button'),
      ).find((entry) => entry.textContent === "Imperial");
      Array.from(document.querySelectorAll('nav[aria-label="Main navigation"] button'))
        .find((entry) => entry.textContent.includes("Chat"))
        .click();
      return {
        pressed: settled.getAttribute("aria-pressed"),
        enabled: !settled.disabled,
      };
    `);
    expect(units).toEqual({ pressed: "true", enabled: true });
    const syncCallIndex = calls.findIndex((call) => call.method === "sync");
    expect(syncCallIndex).toBeGreaterThan(-1);
    expect(calls.filter((call) => call.method === "sync")).toEqual([
      { jsonrpc: "2.0", method: "sync", params: {} },
    ]);
    expect(
      calls.slice(syncCallIndex + 1).filter((call) => call.method === "getAthleteState"),
    ).toHaveLength(1);
    expect(calls.filter((call) => call.method === "enqueueChatMessage")).toEqual([
      {
        jsonrpc: "2.0",
        method: "enqueueChatMessage",
        params: {
          chatId: "desktop",
          submissionId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
          text: "What should I ride?",
        },
      },
      {
        jsonrpc: "2.0",
        method: "enqueueChatMessage",
        params: {
          chatId: "desktop",
          submissionId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
          text: "How should I recover?",
        },
      },
    ]);
    expect(calls.filter((call) => call.method === "resumeChatQueue")).toEqual([
      { jsonrpc: "2.0", method: "resumeChatQueue", params: { chatId: "desktop" } },
    ]);
    expect(calls.filter((call) => call.method === "setUnitsPreference")).toEqual([
      { jsonrpc: "2.0", method: "setUnitsPreference", params: { value: "imperial" } },
    ]);
    expect(calls.filter((call) => call.method === "getActivityAnalysis")).toEqual([
      {
        jsonrpc: "2.0",
        method: "getActivityAnalysis",
        params: {
          canonicalActivityId: "c".repeat(64),
          sections: [
            "aerobic-drift",
            "intervals",
            "best-efforts",
            "power-distribution",
            "heart-rate-distribution",
            "power-heart-rate",
          ],
        },
      },
    ]);
    await fixture.setViewport(720, 800);
    const compactTrainingGeometry = await fixture.evaluate<{
      readonly documentOverflow: boolean;
      readonly settingsResident: boolean;
      readonly settingsReachable: boolean;
      readonly settingsAccessibleLabel: string;
      readonly sidebarFullyVisible: boolean;
      readonly chipReachable: boolean;
      readonly syncFitsRail: boolean;
      readonly syncHasNoOverflow: boolean;
      readonly completeStatusVisible: boolean;
      readonly surfaceMinWidthZero: boolean;
      readonly readableWrapping: boolean;
      readonly trainingOpen: boolean;
      readonly panelOrder: readonly string[];
      readonly retiredPanelsAbsent: boolean;
      readonly chipResident: boolean;
      readonly chipAccessibleLabel: string | null;
      readonly syncOutcomeVisible: boolean;
      readonly horizontalOverflow: boolean;
    }>(`
      const rail = document.querySelector('nav[aria-label="Main navigation"]');
      Array.from(rail.querySelectorAll("button"))
        .find((entry) => entry.textContent.includes("Training"))
        .click();
      const mountDeadline = Date.now() + 5000;
      while (!document.querySelector('[data-panel="weekly-summary"]') && Date.now() < mountDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
      const settings = Array.from(rail.querySelectorAll("button")).find(
        (entry) => entry.textContent.includes("Settings"),
      );
      const page = document.querySelector('section[aria-label="Training"]');
      const panels = [...page.querySelectorAll("[data-panel]")];
      const chip = document.querySelector("button.sync-chip");
      const syncSurface = document.querySelector("[data-sync-chip]");
      const sidebar = syncSurface.closest("aside");
      const headline = syncSurface.querySelector("[data-sync-headline]");
      const detail = syncSurface.querySelector("[data-sync-detail]");
      const action = syncSurface.querySelector("[data-sync-action]");
      const railRect = rail.getBoundingClientRect();
      const settingsRect = settings.getBoundingClientRect();
      const chipRect = chip.getBoundingClientRect();
      const syncRect = syncSurface.getBoundingClientRect();
      const sidebarRect = sidebar.getBoundingClientRect();
      return {
        documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        settingsResident: rail.contains(settings),
        settingsReachable:
          settingsRect.left >= railRect.left &&
          settingsRect.right <= railRect.right &&
          settingsRect.top >= railRect.top &&
          settingsRect.bottom <= railRect.bottom,
        settingsAccessibleLabel: settings.textContent.trim(),
        sidebarFullyVisible:
          sidebarRect.left >= 0 &&
          sidebarRect.right <= window.innerWidth &&
          sidebarRect.top >= 0 &&
          sidebarRect.bottom <= window.innerHeight,
        chipReachable:
          chipRect.left >= 0 &&
          chipRect.right <= window.innerWidth &&
          chipRect.bottom <= window.innerHeight,
        syncFitsRail:
          syncRect.left >= sidebarRect.left && syncRect.right <= sidebarRect.right,
        syncHasNoOverflow: syncSurface.scrollWidth <= syncSurface.clientWidth,
        completeStatusVisible:
          headline.textContent === "Training data synced" &&
          detail.textContent === "Local training-data processing completed." &&
          action.textContent === "Sync again" &&
          [headline, detail, action].every((row) => getComputedStyle(row).display !== "none"),
        surfaceMinWidthZero: getComputedStyle(syncSurface).minWidth === "0px",
        readableWrapping:
          syncSurface.querySelectorAll(".truncate").length === 0 &&
          [headline, detail, action].every(
            (row) =>
              getComputedStyle(row).whiteSpace === "normal" && row.scrollWidth <= row.clientWidth,
          ),
        trainingOpen: page.getAttribute("aria-hidden") === null,
        panelOrder: panels.map((panel) => panel.dataset.panel),
        retiredPanelsAbsent: ["anchor", "load", "wellness", "plan", "adherence"].every(
          (name) => page.querySelector('[data-panel="' + name + '"]') === null,
        ),
        chipResident:
          sidebar.contains(chip) && document.querySelectorAll("button.sync-chip").length === 1,
        chipAccessibleLabel: chip.getAttribute("aria-label"),
        syncOutcomeVisible: syncSurface.textContent.includes(
          "Local training-data processing completed.",
        ),
        horizontalOverflow: page.scrollWidth > page.clientWidth,
      };
    `);
    expect(compactTrainingGeometry).toEqual({
      documentOverflow: false,
      settingsResident: true,
      settingsReachable: true,
      settingsAccessibleLabel: "Settings",
      sidebarFullyVisible: true,
      chipReachable: true,
      syncFitsRail: true,
      syncHasNoOverflow: true,
      completeStatusVisible: true,
      surfaceMinWidthZero: true,
      readableWrapping: true,
      trainingOpen: true,
      panelOrder: ["weekly-summary", "recent-rides"],
      retiredPanelsAbsent: true,
      chipResident: true,
      chipAccessibleLabel:
        "Sync again · Training data synced · Local training-data processing completed.",
      syncOutcomeVisible: true,
      horizontalOverflow: false,
    });
    const runtimeReadsBeforeSettings = calls.filter(
      (call) => call.method === "getRuntimeConfig",
    ).length;
    const compactSettingsGeometry = await fixture.evaluate<{
      readonly open: boolean;
      readonly onePage: boolean;
      readonly hasEverySection: boolean;
      readonly horizontalOverflow: boolean;
      readonly withinViewport: boolean;
      readonly saveReachableAfterScroll: boolean;
      readonly scrolled: boolean;
      readonly resetWarningVisible: boolean;
      readonly retentionWarningVisible: boolean;
      readonly paletteSwatchesFillButtons: boolean;
    }>(`
      const settings = Array.from(
        document.querySelectorAll('nav[aria-label="Main navigation"] button'),
      ).find((entry) => entry.textContent.includes("Settings"));
      settings.click();
      const deadline = Date.now() + 5000;
      while (
        !document.querySelector('section[aria-label="Conversation and time"] input') &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const page = document.querySelector('section[aria-label="Settings"]');
      const sessionSave = Array.from(page.querySelectorAll("button")).find(
        (entry) => entry.textContent === "Save conversation settings",
      );
      const rect = page.getBoundingClientRect();
      const scroll = page.querySelector("[data-page-scroll]");
      if (!(scroll instanceof HTMLElement)) throw new Error("page scrollport did not mount");
      const layoutDeadline = Date.now() + 2000;
      let previousScrollHeight = -1;
      let stableFrames = 0;
      while (stableFrames < 2 && Date.now() < layoutDeadline) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const nextScrollHeight = scroll.scrollHeight;
        stableFrames = nextScrollHeight === previousScrollHeight ? stableFrames + 1 : 0;
        previousScrollHeight = nextScrollHeight;
      }
      if (stableFrames < 2) throw new Error("page scrollport did not stabilize");
      sessionSave.scrollIntoView({ block: "nearest" });
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const saveRect = sessionSave.getBoundingClientRect();
      const scrollRect = scroll.getBoundingClientRect();
      const subpixelTolerance = 1;
      const copy = page.textContent;
      const paletteButtons = Array.from(
        page.querySelectorAll('button[aria-label^="Use the "][aria-label$=" palette"]'),
      );
      return {
        open: page.getAttribute("aria-hidden") === null,
        onePage: document.querySelectorAll('section[aria-label="Settings"]').length === 1,
        hasEverySection:
          ["Coach", "Training account", "Conversation and time", "Spending", "Preferences", "Application"].every(
            (label) => document.querySelectorAll('section[aria-label="' + label + '"]').length === 1,
          ) &&
          copy.includes("Coach route") &&
          copy.includes("Athlete ID") &&
          copy.includes("Daily reset hour"),
        horizontalOverflow:
          document.documentElement.scrollWidth > document.documentElement.clientWidth ||
          Array.from(page.querySelectorAll("section, div")).some(
            (node) => node.scrollWidth > node.clientWidth,
          ),
        withinViewport:
          rect.left >= 0 &&
          rect.right <= window.innerWidth &&
          rect.top >= 0 &&
          rect.bottom <= window.innerHeight,
        saveReachableAfterScroll:
          saveRect.left >= scrollRect.left - subpixelTolerance &&
          saveRect.right <= scrollRect.right + subpixelTolerance &&
          saveRect.top >= scrollRect.top - subpixelTolerance &&
          saveRect.bottom <= scrollRect.bottom + subpixelTolerance,
        scrolled: scroll.scrollTop > 0,
        resetWarningVisible: copy.includes(
          "may make your next message start a fresh conversation",
        ),
        retentionWarningVisible: copy.includes("changes apply only to future pruning"),
        paletteSwatchesFillButtons:
          paletteButtons.length > 0 &&
          paletteButtons.every((button) => {
            const swatch = button.firstElementChild;
            return (
              swatch !== null &&
              Math.abs(swatch.getBoundingClientRect().width - button.getBoundingClientRect().width) < 1
            );
          }),
      };
    `);
    expect(compactSettingsGeometry).toEqual({
      open: true,
      onePage: true,
      hasEverySection: true,
      horizontalOverflow: false,
      withinViewport: true,
      saveReachableAfterScroll: true,
      scrolled: true,
      resetWarningVisible: true,
      retentionWarningVisible: true,
      paletteSwatchesFillButtons: true,
    });
    const preferences = await fixture.evaluate<StructuralSnapshot>(
      `return ${probeExpression(preferencesContract.anchors)}`,
    );
    expect(checkStructure(preferences, preferencesContract)).toEqual([]);
    const runtimeReads = calls.filter((call) => call.method === "getRuntimeConfig");
    expect(runtimeReads.length).toBeGreaterThan(runtimeReadsBeforeSettings);
    expect(runtimeReads).toEqual(
      runtimeReads.map(() => ({
        jsonrpc: "2.0",
        method: "getRuntimeConfig",
        params: {},
      })),
    );
    const base = await realpath(process.platform === "darwin" ? "/tmp" : tmpdir());
    const screenshotRoot = await mkdtemp(join(base, "eap-shot-"));
    scratchPaths.push(screenshotRoot);
    const screenshotPath = join(screenshotRoot, "chat-panels.png");
    await mkdir(screenshotRoot, { recursive: true, mode: 0o700 });
    await fixture.screenshot(screenshotPath);
    const screenshot = await readFile(screenshotPath);
    expect(screenshot.includes(Buffer.from(token))).toBe(false);
    for (const name of ["location", "console", "stdout", "stderr", "dom"] as const) {
      expect(fixture.readCapturedSurface(name)).not.toContain(token);
    }
    expect(await fixture.close()).toEqual({ livePids: [], listenerCount: 0 });
    fixtures.splice(fixtures.indexOf(fixture), 1);
  }, 90_000);

  it("keeps partial-sync attention reachable without sidebar overflow at 720×800", async () => {
    const { fixture, calls } = await launch({
      width: 720,
      height: 800,
      reducedMotion: false,
      syncOutcome: "partial",
    });
    const compact = await fixture.evaluate<{
      readonly trainingOpen: boolean;
      readonly panelOrder: readonly string[];
      readonly retiredPanelsAbsent: boolean;
      readonly chipResident: boolean;
      readonly chipReachable: boolean;
      readonly sidebarFullyVisible: boolean;
      readonly syncingObserved: boolean;
      readonly disabledWhileSyncing: boolean;
      readonly ariaBusyAbsentWhileSyncing: boolean;
      readonly terminalStatus: string;
      readonly terminalLabel: string | null;
      readonly terminalText: string;
      readonly enabledAfterSync: boolean;
      readonly longStatusPresent: boolean;
      readonly surfaceMinWidthZero: boolean;
      readonly readableStatus: boolean;
      readonly chipHasNoOverflow: boolean;
      readonly keyboardFocusRestored: boolean;
      readonly horizontalOverflow: boolean;
    }>(`
      Array.from(document.querySelectorAll('nav[aria-label="Main navigation"] button'))
        .find((entry) => entry.textContent.includes("Training"))
        .click();
      const mountDeadline = Date.now() + 5000;
      while (!document.querySelector('[data-panel="weekly-summary"]') && Date.now() < mountDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const page = document.querySelector('section[aria-label="Training"]');
      const panels = [...page.querySelectorAll("[data-panel]")];
      const syncButton = document.querySelector("button.sync-chip");
      const syncSurface = document.querySelector("[data-sync-chip]");
      const sidebar = syncSurface.closest("aside");
      syncButton.focus();
      syncButton.click();
      const syncingDeadline = Date.now() + 5000;
      while (syncButton.dataset.status !== "syncing" && Date.now() < syncingDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const syncingObserved = syncButton.dataset.status === "syncing";
      const disabledWhileSyncing = syncButton.disabled;
      const ariaBusyAbsentWhileSyncing = !syncButton.hasAttribute("aria-busy");
      syncButton.click();
      syncButton.blur();
      const deadline = Date.now() + 5000;
      while (syncButton.dataset.status !== "attention" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const chipRect = syncButton.getBoundingClientRect();
      const syncRect = syncSurface.getBoundingClientRect();
      const sidebarRect = sidebar.getBoundingClientRect();
      const headline = syncSurface.querySelector("[data-sync-headline]");
      const action = syncSurface.querySelector("[data-sync-action]");
      return {
        trainingOpen: page.getAttribute("aria-hidden") === null,
        panelOrder: panels.map((panel) => panel.dataset.panel),
        retiredPanelsAbsent: ["anchor", "load", "wellness", "plan", "adherence"].every(
          (name) => page.querySelector('[data-panel="' + name + '"]') === null,
        ),
        chipResident:
          sidebar.contains(syncButton) && document.querySelectorAll("button.sync-chip").length === 1,
        chipReachable:
          chipRect.left >= sidebarRect.left &&
          chipRect.right <= sidebarRect.right &&
          chipRect.top >= 0 &&
          chipRect.bottom <= window.innerHeight,
        sidebarFullyVisible:
          sidebarRect.left >= 0 &&
          sidebarRect.right <= window.innerWidth &&
          sidebarRect.top >= 0 &&
          sidebarRect.bottom <= window.innerHeight,
        syncingObserved,
        disabledWhileSyncing,
        ariaBusyAbsentWhileSyncing,
        terminalStatus: syncButton.dataset.status,
        terminalLabel: syncButton.getAttribute("aria-label"),
        terminalText: syncSurface.textContent ?? "",
        enabledAfterSync: !syncButton.disabled,
        longStatusPresent: syncSurface.textContent.includes(
          "Training-data processing partially completed. Try again to finish.",
        ),
        surfaceMinWidthZero: getComputedStyle(syncSurface).minWidth === "0px",
        readableStatus:
          headline.textContent === "Sync needs attention" &&
          action.textContent === "Try again" &&
          getComputedStyle(headline).whiteSpace === "normal" &&
          getComputedStyle(action).display !== "none" &&
          headline.scrollWidth <= headline.clientWidth &&
          action.scrollWidth <= action.clientWidth,
        chipHasNoOverflow:
          syncRect.left >= sidebarRect.left &&
          syncRect.right <= sidebarRect.right &&
          syncSurface.scrollWidth <= syncSurface.clientWidth,
        keyboardFocusRestored: document.activeElement === syncButton,
        horizontalOverflow:
          document.documentElement.scrollWidth > document.documentElement.clientWidth ||
          page.scrollWidth > page.clientWidth,
      };
    `);
    expect(compact).toEqual({
      trainingOpen: true,
      panelOrder: ["weekly-summary", "recent-rides"],
      retiredPanelsAbsent: true,
      chipResident: true,
      chipReachable: true,
      sidebarFullyVisible: true,
      syncingObserved: true,
      disabledWhileSyncing: true,
      ariaBusyAbsentWhileSyncing: true,
      terminalStatus: "attention",
      terminalLabel:
        "Try again · Sync needs attention · Training-data processing partially completed. Try again to finish.",
      terminalText:
        "Sync needs attentionTraining-data processing partially completed. Try again to finish.Try again",
      enabledAfterSync: true,
      longStatusPresent: true,
      surfaceMinWidthZero: true,
      readableStatus: true,
      chipHasNoOverflow: true,
      keyboardFocusRestored: true,
      horizontalOverflow: false,
    });
    const syncCallIndex = calls.findIndex((call) => call.method === "sync");
    expect(syncCallIndex).toBeGreaterThan(-1);
    expect(calls.filter((call) => call.method === "sync")).toEqual([
      { jsonrpc: "2.0", method: "sync", params: {} },
    ]);
    expect(
      calls.slice(syncCallIndex + 1).filter((call) => call.method === "getAthleteState"),
    ).toHaveLength(1);
    expect(await fixture.close()).toEqual({ livePids: [], listenerCount: 0 });
    fixtures.splice(fixtures.indexOf(fixture), 1);
  }, 90_000);

  it("deletes one opened past chat through the native confirmation flow", async () => {
    const { fixture, calls } = await launch({
      width: 1180,
      height: 820,
      reducedMotion: false,
    });
    const confirmation = await fixture.evaluate<{
      readonly entryOpened: boolean;
      readonly dialogOpen: boolean;
      readonly cancelFocused: boolean;
      readonly actionOrder: readonly string[];
      readonly impactCopy: string;
    }>(`
      const archiveNavigation = Array.from(
        document.querySelectorAll('nav[aria-label="Main navigation"] button'),
      ).find((entry) => entry.textContent?.includes("Past chats"));
      archiveNavigation?.click();
      const entryDeadline = Date.now() + 5000;
      let entry = document.querySelector("button.archive-entry");
      while (entry === null && Date.now() < entryDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        entry = document.querySelector("button.archive-entry");
      }
      entry?.click();
      const readerDeadline = Date.now() + 5000;
      let trigger = document.querySelector("button.archive-delete");
      while (trigger === null && Date.now() < readerDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        trigger = document.querySelector("button.archive-delete");
      }
      trigger?.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const dialog = document.querySelector(".archive-delete-dialog");
      const buttons = Array.from(dialog?.querySelectorAll("button") ?? []);
      return {
        entryOpened: document.querySelector('[aria-label="Past conversation"]') !== null,
        dialogOpen: dialog !== null,
        cancelFocused: document.activeElement === buttons[0],
        actionOrder: buttons.map((button) => button.textContent?.trim() ?? ""),
        impactCopy: dialog?.textContent ?? "",
      };
    `);
    expect(confirmation).toEqual({
      entryOpened: true,
      dialogOpen: true,
      cancelFocused: true,
      actionOrder: ["Cancel", "Delete conversation"],
      impactCopy: expect.stringContaining("Imported activities in Training and work in Plan stay."),
    });

    await fixture.pressKey("Escape");
    expect(
      await fixture.evaluate<{
        readonly dialogClosed: boolean;
        readonly triggerFocused: boolean;
      }>(`
        const closeDeadline = Date.now() + 2000;
        while (
          document.querySelector(".archive-delete-dialog") !== null &&
          Date.now() < closeDeadline
        ) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        const trigger = document.querySelector("button.archive-delete");
        return {
          dialogClosed: document.querySelector(".archive-delete-dialog") === null,
          triggerFocused: document.activeElement === trigger,
        };
      `),
    ).toEqual({ dialogClosed: true, triggerFocused: true });

    expect(
      await fixture.evaluate<{
        readonly dialogClosed: boolean;
        readonly listEmpty: boolean;
      }>(`
        document.querySelector("button.archive-delete")?.click();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const dialog = document.querySelector(".archive-delete-dialog");
        Array.from(dialog?.querySelectorAll("button") ?? [])
          .find((button) => button.textContent?.trim() === "Delete conversation")
          ?.click();
        const deleteDeadline = Date.now() + 5000;
        while (
          (document.querySelector(".archive-delete-dialog") !== null ||
            document.querySelector(".archive-empty")?.hasAttribute("hidden")) &&
          Date.now() < deleteDeadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return {
          dialogClosed: document.querySelector(".archive-delete-dialog") === null,
          listEmpty:
            document.querySelector(".archive-empty")?.hasAttribute("hidden") === false &&
            document.querySelector("button.archive-entry") === null,
        };
      `),
    ).toEqual({ dialogClosed: true, listEmpty: true });
    expect(calls.filter((call) => call.method === "deleteArchivedConversation")).toEqual([
      {
        jsonrpc: "2.0",
        method: "deleteArchivedConversation",
        params: { boundaryRef: archivedBoundaryRef },
      },
    ]);
    expect(calls.filter((call) => call.method === "listArchivedConversations")).toHaveLength(2);
    expect(await fixture.close()).toEqual({ livePids: [], listenerCount: 0 });
    fixtures.splice(fixtures.indexOf(fixture), 1);
  }, 90_000);

  it("keeps the dark Reading room usable at wide and compact viewports", async () => {
    const { fixture } = await launch({
      width: 1180,
      height: 820,
      reducedMotion: false,
      colorScheme: "dark",
    });
    expect(
      await fixture.evaluate<{
        readonly theme: string | undefined;
        readonly colorScheme: string;
        readonly overflow: boolean;
        readonly composerOpaque: boolean;
        readonly disclaimerCentered: boolean;
        readonly contextVisible: boolean;
      }>(`
        const composer = document.querySelector(".composer-wrap");
        const disclaimer = document.querySelector(".composer-wrap > p:last-child");
        return {
          theme: document.documentElement.dataset.theme,
          colorScheme: getComputedStyle(document.documentElement).colorScheme,
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          composerOpaque: getComputedStyle(composer).backgroundColor !== "rgba(0, 0, 0, 0)",
          disclaimerCentered: getComputedStyle(disclaimer).textAlign === "center",
          contextVisible: document.querySelector(".training-context") !== null,
        };
      `),
    ).toEqual({
      theme: "dark",
      colorScheme: "dark",
      overflow: false,
      composerOpaque: true,
      disclaimerCentered: true,
      contextVisible: true,
    });
    expect(await stackedProjectionGeometry(fixture)).toEqual({
      attachmentIssue: false,
      planningIssue: true,
      composerWithinViewport: true,
      disclaimerWithinViewport: true,
      projectionsScrollLocally: true,
      disclaimerStableAfterProjectionScroll: true,
      footerOrder: true,
      documentVerticalOverflow: false,
    });

    await fixture.setViewport(760, 820);
    expect(await stackedProjectionGeometry(fixture)).toEqual({
      attachmentIssue: false,
      planningIssue: true,
      composerWithinViewport: true,
      disclaimerWithinViewport: true,
      projectionsScrollLocally: true,
      disclaimerStableAfterProjectionScroll: true,
      footerOrder: true,
      documentVerticalOverflow: false,
    });
    expect(
      await fixture.evaluate<{
        readonly overflow: boolean;
        readonly contextDrawerOpened: boolean;
        readonly composerVisible: boolean;
        readonly disclaimerCentered: boolean;
      }>(`
        const compactDeadline = Date.now() + 5000;
        while (
          document.querySelector('[aria-label="Show training context"]') === null &&
          Date.now() < compactDeadline
        ) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        document.querySelector('[aria-label="Show training context"]')?.click();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const composer = document.querySelector(".composer-wrap").getBoundingClientRect();
        const disclaimer = document.querySelector(".composer-wrap > p:last-child");
        return {
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          contextDrawerOpened:
            document.querySelector('[data-slot="dialog-content"] .training-context') !== null,
          composerVisible: composer.top >= 0 && composer.bottom <= window.innerHeight,
          disclaimerCentered: getComputedStyle(disclaimer).textAlign === "center",
        };
      `),
    ).toEqual({
      overflow: false,
      contextDrawerOpened: true,
      composerVisible: true,
      disclaimerCentered: true,
    });
    expect(await fixture.close()).toEqual({ livePids: [], listenerCount: 0 });
    fixtures.splice(fixtures.indexOf(fixture), 1);
  }, 90_000);

  it("honors reduced motion at the compact viewport", async () => {
    const { fixture } = await launch({ width: 720, height: 800, reducedMotion: true });
    expect(
      await fixture.evaluate<{
        readonly reduced: boolean;
        readonly overflow: boolean;
        readonly railWidth: number;
      }>(`
      return {
        reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        railWidth: document.querySelector('nav[aria-label="Main navigation"]').closest("aside").getBoundingClientRect().width,
      };
    `),
    ).toEqual({ reduced: true, overflow: false, railWidth: 184 });
    expect(await fixture.close()).toEqual({ livePids: [], listenerCount: 0 });
    fixtures.splice(fixtures.indexOf(fixture), 1);
  }, 90_000);
});
