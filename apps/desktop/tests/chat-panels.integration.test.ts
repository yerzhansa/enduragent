import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
const transcriptCursorBytes = Buffer.alloc(114);
transcriptCursorBytes[0] = 1;
const transcriptCursor = transcriptCursorBytes.toString("base64url");
const fixtures: RunningDesktopFixture[] = [];
const scratchPaths: string[] = [];

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

const tallTurn =
  "Long ride notes that make the newest restored turn taller than the window. ".repeat(52);

function response(value: unknown): readonly string[] {
  return [JSON.stringify(value)];
}

type SyncOutcome = "no-change" | "partial";

function makeScript(
  calls: ScriptRequest[],
  syncOutcome: SyncOutcome,
  transcriptHistory: boolean,
): DesktopFixtureScript {
  let units: "metric" | "imperial" = "metric";
  let hasSession = false;
  let lastSynced: string = athleteState.lastSynced;
  return {
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
      if (request.method === "chat") {
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
          JSON.stringify({ text: finalText }),
        ];
      }
      if (request.method === "hasSession") return response({ hasSession });
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
      if (request.method === "resetSession") {
        hasSession = false;
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
  readonly syncOutcome?: SyncOutcome;
  readonly transcriptHistory?: boolean;
}): Promise<{ readonly fixture: RunningDesktopFixture; readonly calls: ScriptRequest[] }> {
  const calls: ScriptRequest[] = [];
  const fixture = await launchDesktopFixture({
    script: makeScript(calls, input.syncOutcome ?? "no-change", input.transcriptHistory ?? false),
    token,
    width: input.width,
    height: input.height,
    colorScheme: "light",
    reducedMotion: input.reducedMotion,
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
    const composer = document.querySelector("textarea#message");
    if (!(composer instanceof HTMLTextAreaElement) || composer.disabled) {
      throw new Error("ready fixture did not enable chat");
    }
  `);
  return { fixture, calls };
}

afterEach(async () => {
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
          allRows[4].querySelectorAll("strong").length === 0 &&
          allRows[4].querySelector(".chat-message__text").textContent === "Persisted athlete 3",
        coachMarkdown:
          allRows[5].querySelector("strong")?.textContent === "Persisted coach 3",
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
    expect(calls.filter((call) => call.method === "chat")).toHaveLength(0);

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
      const conversation = document.querySelector(".conversation");
      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      });
      const dispatchResult = textarea.dispatchEvent(event);
      const deadline = Date.now() + 5000;
      while (conversation.dataset.chatStatus === "streaming" && Date.now() < deadline) {
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
    expect(calls.filter((call) => call.method === "chat")).toEqual([
      {
        jsonrpc: "2.0",
        method: "chat",
        params: { chatId: "desktop", message: committedMessage },
      },
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
      readonly streamingSendEnabled: boolean;
      readonly streamingQuickActionsEnabled: boolean;
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
      const submit = textarea.closest("form").querySelector('button[type="submit"]');
      const quickActions = [...document.querySelectorAll(".coaching-shortcut")];
      const streamingDeadline = Date.now() + 5000;
      while (
        document.querySelector(".conversation").dataset.chatStatus !== "streaming" &&
        Date.now() < streamingDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      textarea.value = "How should I recover?";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.focus();
      const streamingInputEnabled = !textarea.disabled;
      const streamingSendEnabled = !submit.disabled;
      const streamingQuickActionsEnabled = quickActions.every((button) => !button.disabled);
      const streamingEnter = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      });
      textarea.dispatchEvent(streamingEnter);
      const streamingEnterHandled = streamingEnter.defaultPrevented;
      const streamingDraftCleared = textarea.value === "";
      const streamingFocusPreserved = document.activeElement === textarea;
      await new Promise((resolve) => setTimeout(resolve, 0));
      const streamingQueued = [...document.querySelectorAll(".chat-queue__text")].map(
        (node) => node.textContent,
      );
      document.querySelector(".chat-queue__remove")?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
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
      const settledSendEnabled = !submit.disabled;
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
        streamingSendEnabled,
        streamingQuickActionsEnabled,
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
        "chooseImportFiles",
        "claudeCliRecheck",
        "claudeCliStatus",
        "credentialRecoveryStatus",
        "credentialStatuses",
        "deleteCredential",
        "disableTelegram",
        "enableTelegram",
        "exportTrainingFile",
        "getArchivedTranscriptPage",
        "getDaemonConnection",
        "getTranscriptPage",
        "getUpdateState",
        "initialSetupStatusSettled",
        "listArchivedConversations",
        "listTelegramAllowedSenders",
        "llmConfiguration",
        "onChatgptLoginProgress",
        "onDroppedImportFiles",
        "onUpdateState",
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
      streamingSendEnabled: true,
      streamingQuickActionsEnabled: true,
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
    const quickActions = await fixture.evaluate<{
      readonly groupLabel: string | null;
      readonly labels: readonly string[];
      readonly commands: readonly string[];
      readonly terminalResponses: number;
      readonly keyboardActivationDetail: number | null;
      readonly keyboardShortcutResidentAfterTerminal: boolean;
      readonly keyboardShortcutFocusedAfterTerminal: boolean;
      readonly draft: string;
      readonly documentOverflow: boolean;
      readonly composerHeight: number;
      readonly composerOpaque: boolean;
      readonly composerClearanceTracksHeight: boolean;
      readonly finalTranscriptClearsComposer: boolean;
    }>(`
      const group = document.querySelector(".coaching-shortcuts");
      const buttons = [...group.querySelectorAll(".coaching-shortcut")];
      const keyboardShortcut = buttons.at(-1);
      const textarea = document.querySelector("#message");
      textarea.value = "  keep draft\\n";
      let terminalResponses = 0;
      let keyboardActivationDetail = null;
      let keyboardShortcutResidentAfterTerminal = false;
      let keyboardShortcutFocusedAfterTerminal = false;
      keyboardShortcut.addEventListener("click", (event) => {
        keyboardActivationDetail = event.detail;
      }, { once: true });
      for (const button of buttons) {
        const readyDeadline = Date.now() + 5000;
        while (button.disabled && Date.now() < readyDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        const coachCount = document.querySelectorAll(".chat-message--coach").length;
        if (button === keyboardShortcut) button.focus();
        button.click();
        const terminalDeadline = Date.now() + 5000;
        while (Date.now() < terminalDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          const coaches = [...document.querySelectorAll(".chat-message--coach")];
          const latest = coaches.at(-1);
          if (coaches.length === coachCount + 1 && latest && !latest.hasAttribute("aria-busy")) {
            terminalResponses += 1;
            if (button === keyboardShortcut) {
              keyboardShortcutResidentAfterTerminal =
                [...group.querySelectorAll(".coaching-shortcut")].at(-1) === keyboardShortcut;
              keyboardShortcutFocusedAfterTerminal = document.activeElement === keyboardShortcut;
            }
            break;
          }
        }
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const conversation = document.querySelector(".conversation");
      const composer = document.querySelector(".composer-wrap");
      conversation.scrollTop = conversation.scrollHeight;
      const composerRect = composer.getBoundingClientRect();
      const finalTranscriptItem = [...document.querySelectorAll(".chat-message, .chat-notice, .chat-retry")]
        .filter((node) => !node.hidden)
        .at(-1);
      const reservedBottom = Number.parseFloat(getComputedStyle(conversation).paddingBottom);
      return {
        groupLabel: group.getAttribute("aria-label"),
        labels: buttons.map((button) => button.querySelector(".coaching-shortcut__label")?.textContent ?? ""),
        commands: buttons.map((button) => button.querySelector(".coaching-shortcut__command")?.textContent ?? ""),
        terminalResponses,
        keyboardActivationDetail,
        keyboardShortcutResidentAfterTerminal,
        keyboardShortcutFocusedAfterTerminal,
        draft: textarea.value,
        documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        composerHeight: composerRect.height,
        composerOpaque: getComputedStyle(composer).backgroundColor !== "rgba(0, 0, 0, 0)",
        composerClearanceTracksHeight: Math.abs(reservedBottom - composerRect.height) < 1,
        finalTranscriptClearsComposer:
          finalTranscriptItem.getBoundingClientRect().bottom <= composerRect.top + 1,
      };
    `);
    expect(quickActions).toEqual({
      groupLabel: "Coaching shortcuts",
      labels: ["Build a plan", "Today’s workout", "Training status", "Review last session"],
      commands: ["/plan", "/workout", "/status", "/review"],
      terminalResponses: 4,
      keyboardActivationDetail: 0,
      keyboardShortcutResidentAfterTerminal: true,
      keyboardShortcutFocusedAfterTerminal: true,
      draft: "  keep draft\n",
      documentOverflow: false,
      composerHeight: expect.any(Number),
      composerOpaque: true,
      composerClearanceTracksHeight: true,
      finalTranscriptClearsComposer: true,
    });
    expect(quickActions.composerHeight).toBeGreaterThan(0);
    await fixture.setViewport(720, 800);
    const compact = await fixture.evaluate<{
      readonly documentOverflow: boolean;
      readonly tableScrollsLocally: boolean;
      readonly codeScrollsLocally: boolean;
      readonly shortcutsWrapped: boolean;
      readonly composerOpaque: boolean;
      readonly composerHeight: number;
      readonly composerClearanceTracksHeight: boolean;
      readonly finalTranscriptClearsComposer: boolean;
    }>(`
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const tableScroll = document.querySelector(".chat-markdown__table-scroll");
        const codeBlock = document.querySelector(".chat-message--coach pre");
        const conversation = document.querySelector(".conversation");
        const composer = document.querySelector(".composer-wrap");
        const shortcutGroup = document.querySelector(".coaching-shortcuts");
        const firstShortcut = shortcutGroup.querySelector(".coaching-shortcut");
        conversation.scrollTop = conversation.scrollHeight;
        const composerRect = composer.getBoundingClientRect();
        const finalTranscriptItem = [...document.querySelectorAll(".chat-message, .chat-notice, .chat-retry")]
          .filter((node) => !node.hidden)
          .at(-1);
        const reservedBottom = Number.parseFloat(getComputedStyle(conversation).paddingBottom);
        return {
          documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          tableScrollsLocally: tableScroll.scrollWidth > tableScroll.clientWidth && getComputedStyle(tableScroll).overflowX === "auto",
          codeScrollsLocally: codeBlock.scrollWidth > codeBlock.clientWidth && getComputedStyle(codeBlock).overflowX === "auto",
          shortcutsWrapped: shortcutGroup.getBoundingClientRect().height > firstShortcut.getBoundingClientRect().height,
          composerOpaque: getComputedStyle(composer).backgroundColor !== "rgba(0, 0, 0, 0)",
          composerHeight: composerRect.height,
          composerClearanceTracksHeight: Math.abs(reservedBottom - composerRect.height) < 1,
          finalTranscriptClearsComposer:
            finalTranscriptItem.getBoundingClientRect().bottom <= composerRect.top + 1,
        };
      `);
    expect(compact).toEqual({
      documentOverflow: false,
      tableScrollsLocally: true,
      codeScrollsLocally: true,
      shortcutsWrapped: true,
      composerOpaque: true,
      composerHeight: expect.any(Number),
      composerClearanceTracksHeight: true,
      finalTranscriptClearsComposer: true,
    });
    expect(compact.composerHeight).toBeGreaterThan(quickActions.composerHeight);
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
      readonly status: string;
      readonly statusHidden: boolean;
      readonly anchorValue: string;
      readonly wellnessValue: string;
      readonly pageOverflow: boolean;
      readonly documentOverflow: boolean;
      readonly sync: {
        readonly buttonResident: boolean;
        readonly queued: string;
        readonly runningObserved: boolean;
        readonly terminal: string;
        readonly label: string;
        readonly atomicLiveRegion: boolean;
        readonly busyQueued: boolean;
        readonly busyCleared: boolean;
        readonly keyboardFocusRestored: boolean;
        readonly noChangeTerminalObservations: number;
        readonly noChangeTerminalOnlyAfterRefresh: boolean;
        readonly onlyLastSyncedChanged: boolean;
        readonly trainingPanelsUnchanged: boolean;
        readonly asOfUnchanged: boolean;
        readonly asOfBefore: string;
        readonly asOfAfter: string;
        readonly lastSyncedBefore: string;
        readonly lastSyncedAfter: string;
        readonly chipStatus: string;
        readonly statusWraps: boolean;
        readonly buttonReachable: boolean;
      };
    }>(`
      const rail = document.querySelector('nav[aria-label="Main navigation"]');
      const trainingNav = Array.from(rail.querySelectorAll("button")).find(
        (entry) => entry.textContent.includes("Training"),
      );
      trainingNav.click();
      const mountDeadline = Date.now() + 5000;
      while (!document.querySelector('[data-panel="wellness"]') && Date.now() < mountDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const page = document.querySelector('section[aria-label="Training"]');
      const panels = [...page.querySelectorAll("[data-panel]")];
      const panel = (name) => panels.find((entry) => entry.dataset.panel === name);
      const statusLine = page.querySelector(".training-status");
      const opened = {
        current: trainingNav.getAttribute("aria-current"),
        order: panels.map((entry) => entry.querySelector("h2").textContent),
        status: statusLine.textContent,
        statusHidden: statusLine.hidden,
        anchorValue: panel("anchor").querySelector("p").textContent,
        wellnessValue: panel("wellness").querySelector("span").textContent,
      };
      const dataPanels = ["anchor", "load", "plan", "adherence", "wellness"];
      const syncButton = page.querySelector(".training-sync-action");
      const syncStatus = page.querySelector(".training-sync-message");
      const metadataText = () => [...page.querySelectorAll(".training-metadata-item")].map((node) => node.textContent ?? "");
      const metadataChildrenText = () => [...page.querySelector(".training-metadata").children].map((node) => node.textContent ?? "");
      const metadataBefore = metadataChildrenText();
      const panelsBefore = dataPanels.map((name) => panel(name).textContent ?? "");
      const asOfBefore = metadataText().find((value) => value.startsWith("As of ")) ?? "";
      const lastSyncedBefore = metadataText().find((value) => value.startsWith("Last synced ")) ?? "";
      const liveValues = [];
      const noChangeCopy = "Local training-data processing completed.";
      let noChangeTerminalObservations = 0;
      let noChangeTerminalBeforeRefresh = false;
      const liveObserver = new MutationObserver(() => {
        const value = syncStatus.textContent ?? "";
        liveValues.push(value);
        if (value === noChangeCopy) {
          noChangeTerminalObservations += 1;
          const currentLastSynced = metadataText().find((item) => item.startsWith("Last synced ")) ?? "";
          if (currentLastSynced === lastSyncedBefore) noChangeTerminalBeforeRefresh = true;
        }
      });
      liveObserver.observe(syncStatus, { childList: true, characterData: true, subtree: true });
      syncButton.focus();
      syncButton.click();
      const queued = syncStatus.textContent ?? "";
      const busyQueued = syncButton.disabled && syncButton.getAttribute("aria-busy") === "true";
      syncButton.click();
      syncButton.blur();
      const syncDeadline = Date.now() + 5000;
      while (syncButton.disabled && Date.now() < syncDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      liveObserver.disconnect();
      const asOfAfter = metadataText().find((value) => value.startsWith("As of ")) ?? "";
      const lastSyncedAfter = metadataText().find((value) => value.startsWith("Last synced ")) ?? "";
      const metadataAfter = metadataChildrenText();
      const panelsAfter = dataPanels.map((name) => panel(name).textContent ?? "");
      syncStatus.scrollIntoView({ block: "nearest" });
      const syncButtonRect = syncButton.getBoundingClientRect();
      const pageRect = page.getBoundingClientRect();
      const syncResult = {
        buttonResident: syncButton === page.querySelector(".training-sync-action"),
        queued,
        runningObserved: liveValues.includes("Syncing training data…"),
        terminal: syncStatus.textContent ?? "",
        label: syncButton.textContent ?? "",
        atomicLiveRegion:
          syncStatus.getAttribute("role") === "status" &&
          syncStatus.getAttribute("aria-live") === "polite" &&
          syncStatus.getAttribute("aria-atomic") === "true",
        busyQueued,
        busyCleared: !syncButton.hasAttribute("aria-busy") && !syncButton.disabled,
        keyboardFocusRestored: document.activeElement === syncButton,
        noChangeTerminalObservations,
        noChangeTerminalOnlyAfterRefresh:
          noChangeTerminalObservations === 1 &&
          !noChangeTerminalBeforeRefresh &&
          lastSyncedAfter !== lastSyncedBefore,
        onlyLastSyncedChanged:
          metadataBefore.length === metadataAfter.length &&
          metadataBefore.filter((value, index) => value !== metadataAfter[index]).length === 1 &&
          metadataBefore.find((value) => value.startsWith("Last synced ")) === lastSyncedBefore &&
          metadataAfter.find((value) => value.startsWith("Last synced ")) === lastSyncedAfter,
        trainingPanelsUnchanged: JSON.stringify(panelsBefore) === JSON.stringify(panelsAfter),
        asOfUnchanged: asOfBefore === asOfAfter,
        asOfBefore,
        asOfAfter,
        lastSyncedBefore,
        lastSyncedAfter,
        chipStatus: document.querySelector(".sync-chip").dataset.status,
        statusWraps: syncStatus.scrollWidth <= syncStatus.clientWidth,
        buttonReachable:
          syncButtonRect.top >= pageRect.top && syncButtonRect.bottom <= pageRect.bottom,
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
      order: [
        "Sync",
        "Power progress",
        "Recent rides",
        "Current cycling anchor",
        "Cycling Load",
        "Plan",
        "Adherence",
        "Wellness trend",
        "Import ride files",
      ],
      status: "",
      statusHidden: true,
      anchorValue: "300 W",
      wellnessValue: "65 ms",
      pageOverflow: false,
      documentOverflow: false,
      sync: {
        buttonResident: true,
        queued: "Sync queued.",
        runningObserved: true,
        terminal: "Local training-data processing completed.",
        label: "Sync again",
        atomicLiveRegion: true,
        busyQueued: true,
        busyCleared: true,
        keyboardFocusRestored: true,
        noChangeTerminalObservations: 1,
        noChangeTerminalOnlyAfterRefresh: true,
        onlyLastSyncedChanged: true,
        trainingPanelsUnchanged: true,
        asOfUnchanged: true,
        asOfBefore: "As of 2026-07-19",
        asOfAfter: "As of 2026-07-19",
        lastSyncedBefore: "Last synced 2026-07-19 07:55:00 UTC",
        lastSyncedAfter: "Last synced 2026-07-19 07:55:01 UTC",
        chipStatus: "synced",
        statusWraps: true,
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
      const title = page.querySelector("h1");
      const powerHeartRatePanel = page.querySelector('[aria-labelledby="power-heart-rate-title"]');
      return {
        page: page.getAttribute("aria-label"),
        titleFocused: document.activeElement === title,
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
      overview: "Recent rideRoad rideDate2026-07-18 · 12:00Duration1h 31mDistance42.1 km",
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
    expect(calls.filter((call) => call.method === "chat")).toEqual([
      {
        jsonrpc: "2.0",
        method: "chat",
        params: { chatId: "desktop", message: "What should I ride?" },
      },
      {
        jsonrpc: "2.0",
        method: "chat",
        params: { chatId: "desktop", message: "/plan" },
      },
      {
        jsonrpc: "2.0",
        method: "chat",
        params: { chatId: "desktop", message: "/workout" },
      },
      {
        jsonrpc: "2.0",
        method: "chat",
        params: { chatId: "desktop", message: "/status" },
      },
      {
        jsonrpc: "2.0",
        method: "chat",
        params: { chatId: "desktop", message: "/review" },
      },
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
      readonly chipReachable: boolean;
      readonly syncFitsRail: boolean;
      readonly syncHasNoOverflow: boolean;
      readonly syncActionHidden: boolean;
      readonly trainingOpen: boolean;
      readonly buttonResident: boolean;
      readonly buttonReachable: boolean;
      readonly noChangeStatus: boolean;
      readonly statusFits: boolean;
      readonly horizontalOverflow: boolean;
    }>(`
      const rail = document.querySelector('nav[aria-label="Main navigation"]');
      Array.from(rail.querySelectorAll("button"))
        .find((entry) => entry.textContent.includes("Training"))
        .click();
      const mountDeadline = Date.now() + 5000;
      while (!document.querySelector('[data-panel="wellness"]') && Date.now() < mountDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
      const settings = Array.from(rail.querySelectorAll("button")).find(
        (entry) => entry.textContent.includes("Settings"),
      );
      const page = document.querySelector('section[aria-label="Training"]');
      const compactButton = page.querySelector(".training-sync-action");
      const compactStatus = page.querySelector(".training-sync-message");
      const chip = document.querySelector(".sync-chip");
      const syncSurface = document.querySelector("[data-sync-chip]");
      const sidebar = syncSurface.closest("aside");
      const syncAction = syncSurface.lastElementChild;
      const pageRect = page.getBoundingClientRect();
      const buttonRect = compactButton.getBoundingClientRect();
      const railRect = rail.getBoundingClientRect();
      const settingsRect = settings.getBoundingClientRect();
      const chipRect = chip.getBoundingClientRect();
      const syncRect = syncSurface.getBoundingClientRect();
      const sidebarRect = sidebar.getBoundingClientRect();
      compactButton.scrollIntoView({ block: "nearest" });
      return {
        documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        settingsResident: rail.contains(settings),
        settingsReachable:
          settingsRect.left >= railRect.left &&
          settingsRect.right <= railRect.right &&
          settingsRect.top >= railRect.top &&
          settingsRect.bottom <= railRect.bottom,
        settingsAccessibleLabel: settings.textContent.trim(),
        chipReachable:
          chipRect.left >= 0 &&
          chipRect.right <= window.innerWidth &&
          chipRect.bottom <= window.innerHeight,
        syncFitsRail:
          syncRect.left >= sidebarRect.left && syncRect.right <= sidebarRect.right,
        syncHasNoOverflow: syncSurface.scrollWidth <= syncSurface.clientWidth,
        syncActionHidden: getComputedStyle(syncAction).display === "none",
        trainingOpen: page.getAttribute("aria-hidden") === null,
        buttonResident: page.querySelectorAll(".training-sync-action").length === 1,
        buttonReachable:
          buttonRect.left >= pageRect.left &&
          buttonRect.right <= pageRect.right &&
          buttonRect.top >= pageRect.top &&
          buttonRect.bottom <= Math.min(pageRect.bottom, window.innerHeight),
        noChangeStatus: compactStatus.textContent === "Local training-data processing completed.",
        statusFits: compactStatus.scrollWidth <= compactStatus.clientWidth,
        horizontalOverflow: Array.from(page.querySelectorAll("section, div, ol, dl, p")).some(
          (node) => node.scrollWidth > node.clientWidth,
        ),
      };
    `);
    expect(compactTrainingGeometry).toEqual({
      documentOverflow: false,
      settingsResident: true,
      settingsReachable: true,
      settingsAccessibleLabel: "Settings",
      chipReachable: true,
      syncFitsRail: true,
      syncHasNoOverflow: true,
      syncActionHidden: true,
      trainingOpen: true,
      buttonResident: true,
      buttonReachable: true,
      noChangeStatus: true,
      statusFits: true,
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

  it("keeps the long partial-sync status reachable and wrapped at 720×800", async () => {
    const { fixture, calls } = await launch({
      width: 720,
      height: 800,
      reducedMotion: false,
      syncOutcome: "partial",
    });
    const compact = await fixture.evaluate<{
      readonly trainingOpen: boolean;
      readonly buttonResident: boolean;
      readonly buttonReachable: boolean;
      readonly terminal: string;
      readonly label: string;
      readonly chipStatus: string;
      readonly statusWrapped: boolean;
      readonly keyboardFocusRestored: boolean;
      readonly horizontalOverflow: boolean;
    }>(`
      Array.from(document.querySelectorAll('nav[aria-label="Main navigation"] button'))
        .find((entry) => entry.textContent.includes("Training"))
        .click();
      const mountDeadline = Date.now() + 5000;
      while (!document.querySelector(".training-sync-action") && Date.now() < mountDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const page = document.querySelector('section[aria-label="Training"]');
      const syncButton = page.querySelector(".training-sync-action");
      const syncStatus = page.querySelector(".training-sync-message");
      syncButton.focus();
      syncButton.click();
      syncButton.blur();
      const deadline = Date.now() + 5000;
      while (syncButton.disabled && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      syncStatus.scrollIntoView({ block: "nearest" });
      const pageRect = page.getBoundingClientRect();
      const buttonRect = syncButton.getBoundingClientRect();
      const statusRect = syncStatus.getBoundingClientRect();
      const lineHeight = Number.parseFloat(getComputedStyle(syncStatus).lineHeight);
      return {
        trainingOpen: page.getAttribute("aria-hidden") === null,
        buttonResident: page.querySelectorAll(".training-sync-action").length === 1,
        buttonReachable:
          buttonRect.left >= pageRect.left &&
          buttonRect.right <= pageRect.right &&
          buttonRect.top >= pageRect.top &&
          buttonRect.bottom <= Math.min(pageRect.bottom, window.innerHeight),
        terminal: syncStatus.textContent ?? "",
        label: syncButton.textContent ?? "",
        chipStatus: document.querySelector(".sync-chip").dataset.status,
        statusWrapped:
          statusRect.height >= lineHeight * 1.9 &&
          syncStatus.scrollWidth <= syncStatus.clientWidth,
        keyboardFocusRestored: document.activeElement === syncButton,
        horizontalOverflow:
          document.documentElement.scrollWidth > document.documentElement.clientWidth ||
          Array.from(page.querySelectorAll("section, div, ol, dl, p")).some(
            (node) => node.scrollWidth > node.clientWidth,
          ),
      };
    `);
    expect(compact).toEqual({
      trainingOpen: true,
      buttonResident: true,
      buttonReachable: true,
      terminal: "Training-data processing partially completed. Try again to finish.",
      label: "Try again",
      chipStatus: "attention",
      statusWrapped: true,
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
