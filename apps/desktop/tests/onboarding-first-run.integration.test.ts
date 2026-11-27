import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
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
const fixtures: RunningDesktopFixture[] = [];

interface ScriptRequest {
  readonly method: string;
  readonly params: unknown;
}

function response(value: unknown): readonly string[] {
  return [JSON.stringify(value)];
}

function makeScript(): DesktopFixtureScript {
  let durableTrainingData = true;
  let queueRevision = 0;
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
    onRequest(value) {
      const request = value as ScriptRequest;
      if (request.method === "getRuntimeConfig") {
        return response({
          schemaVersion: 3,
          llm: {
            provider: "anthropic",
            model: "fixture",
            credential_configured: true,
          },
          intervals: {
            athlete_id: "0",
            credential_configured: false,
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
      if (request.method === "configureRuntime") {
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
      if (request.method === "getSetupStatus") {
        return response({ schemaVersion: 1, durableTrainingData });
      }
      if (request.method === "sync") {
        durableTrainingData = true;
        return response({
          schemaVersion: 1,
          published: true,
          referenceSucceeded: true,
          requests: { store: 1, reference: 1, total: 2 },
          droppedActivities: {
            overall: { total: 0, visible: 0, restrictions: [], other: 0 },
            recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
          },
        });
      }
      if (request.method === "getAthleteState") {
        return response({
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
            trainingHistory: {
              kind: "computed",
              asOf: "1998-07-19T08:00:00.000Z",
              calendarTimeZone: "UTC",
              displayMode: "last-recorded",
              coverage: {
                kind: "sparse",
                latestKnownRideDate: "1998-07-09",
                latestImportAt: "1998-07-19T08:00:00.000Z",
              },
              anchorWeek: {
                id: "anchor",
                window: { start: "1998-07-06", end: "1998-07-12" },
                calendarState: "closed",
                coverage: {
                  kind: "incomplete",
                  recordedThrough: "1998-07-09",
                  reason: "sparse-imports",
                },
                totals: {
                  rideCount: { kind: "computed", value: 1 },
                  ridingSeconds: { kind: "computed", value: 3_600 },
                  distanceMeters: { kind: "computed", value: 40_000 },
                  load: { kind: "unavailable", reason: "no-recorded-value" },
                },
                rides: {
                  count: { kind: "exact", value: 1 },
                  items: [
                    {
                      id: "a".repeat(64),
                      title: null,
                      subSport: "road",
                      startEpochSeconds: 900_000_000,
                      timezoneOffsetSeconds: 0,
                      localDate: "1998-07-09",
                      ridingSeconds: 3_600,
                      ridingTimeBasis: "moving",
                      elapsedSeconds: 3_700,
                      distanceMeters: 40_000,
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
            anchorZones: { kind: "unknown", reason: "not-synced" },
            cyclingLoad: { kind: "unknown", reason: "no-platform-load" },
            plan: { kind: "unknown", reason: "no-plan" },
            adherence: { kind: "unknown", reason: "insufficient-data" },
            wellnessTrend: { kind: "unknown", reason: "no-wellness" },
          },
        });
      }
      if (request.method === "getTranscriptPage") {
        return response({ schemaVersion: 1, status: "page", turns: [], nextCursor: null });
      }
      if (request.method === "getUnitsPreference") {
        return response({ value: "metric", source: "default" });
      }
      if (request.method === "hasSession") {
        return response({ hasSession: false });
      }
      if (request.method === "getCoachDecision") return response({ decision: null });
      if (request.method === "getChatQueue") return response(queueSnapshot());
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
        queueItems = [];
        queueRevision += 1;
        return response({ snapshot: queueSnapshot() });
      }
      throw new TypeError(`unexpected fixture request: ${request.method}`);
    },
  };
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe.skipIf(process.platform !== "darwin" || !hasLoopback)("onboarding live", () => {
  it.each([
    { width: 1440, height: 900, colorScheme: "light", reducedMotion: false },
    { width: 800, height: 700, colorScheme: "dark", reducedMotion: true },
  ] as const)(
    "finishes file-only onboarding into working Chat and Training pages at $width in $colorScheme",
    async (appearance) => {
      const fixture = await launchDesktopFixture({
        script: makeScript(),
        token,
        ...appearance,
      });
      fixtures.push(fixture);
      const observed = await fixture.evaluate<{
        readonly trainingSubtitle: string;
        readonly trainingRowState: string | null;
        readonly readiness: string;
        readonly startEnabled: boolean;
        readonly completionStored: boolean;
        readonly present: boolean;
        readonly chatSetup: boolean;
        readonly scrimAbsent: boolean;
        readonly modalAbsent: boolean;
        readonly title: string;
        readonly escapeStayed: boolean;
        readonly shellReplaced: boolean;
        readonly finished: boolean;
        readonly shellRestored: boolean;
        readonly chatWorking: boolean;
        readonly trainingReady: boolean;
        readonly recentRideVisible: boolean;
        readonly syncNeedsAttention: boolean;
      }>(`
      const deadline = Date.now() + 10000;
      const setupSelector =
        '[data-shell="gate"][data-onboarding="settled"] [data-setup-host="gate"]';
      while (!document.querySelector(setupSelector) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const trainingSubtitle = document.querySelector('[data-setup-row="training"] [data-setup-row-subtitle]')?.textContent ?? "";
      const trainingRowState = document.querySelector('[data-setup-row="training"]')?.getAttribute("data-state") ?? null;
      const page = document.querySelector(setupSelector);
      const present = page !== null;
      const chatSetup = document.querySelector(setupSelector) !== null;
      const scrimAbsent = document.querySelector(".onboarding-scrim") === null;
      const modalAbsent =
        page?.getAttribute("role") !== "dialog" && page?.hasAttribute("aria-modal") !== true;
      const title = document.querySelector("#setup-panel-title")?.textContent ?? "";
      page?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 60));
      const escapeStayed = document.querySelector(setupSelector) !== null;
      const shellReplaced =
        document.querySelector('nav[aria-label="Main navigation"]') === null &&
        document.querySelector("textarea#message") === null;
      const button = (label) =>
        Array.from(document.querySelectorAll(".setup-panel button")).find(
          (entry) => entry.textContent?.trim() === label,
        );
      const panelButton = (name, label) =>
        Array.from(
          document.querySelectorAll('[data-setup-panel="' + name + '"] button'),
        ).find((entry) => entry.textContent?.trim() === label);
      const waitFor = async (selector) => {
        const stepDeadline = Date.now() + 10000;
        while (document.querySelector(selector) === null && Date.now() < stepDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const found = document.querySelector(selector);
        if (found === null) throw new Error("timed out waiting for " + selector);
        return found;
      };
      const waitGone = async (selector) => {
        const stepDeadline = Date.now() + 10000;
        while (document.querySelector(selector) !== null && Date.now() < stepDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        if (document.querySelector(selector) !== null) {
          throw new Error("timed out waiting for " + selector + " to disappear");
        }
      };
      const fill = (selector, value) => {
        const input = document.querySelector(selector);
        if (!(input instanceof HTMLInputElement)) {
          throw new Error("missing input " + selector);
        }
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        setter?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };
      document.querySelector('[data-setup-trigger="ai"]')?.click();
      await waitFor('[data-lane="api-key"]');
      document.querySelector('[data-lane="api-key"]')?.click();
      await waitFor('[data-setup-panel="api-key"]');
      fill('input[data-slot="anthropic"]', "synthetic-model-key");
      panelButton("api-key", "Save")?.click();
      await waitGone('[data-setup-panel="api-key"]');
      document.querySelector('[data-setup-trigger="training"]')?.click();
      const trainingPanel = await waitFor('[data-setup-panel="training"]');
      if (panelButton("training", "Sign in with Intervals.icu") === undefined) {
        throw new Error("missing Sign in with Intervals.icu action");
      }
      if (trainingPanel.querySelector('input[data-slot="intervals-icu"]') !== null) {
        throw new Error("unexpected Intervals.icu credential input");
      }
      await waitFor('[data-setup-readiness="2"]');
      await new Promise((resolve) => setTimeout(resolve, 60));
      const readiness = document.querySelector("[data-setup-readiness]")?.textContent ?? "";
      const startEnabled = button("Start coaching")?.disabled === false;
      button("Start coaching")?.click();
      const chatDeadline = Date.now() + 10000;
      const chatReady = () => {
        const composer = document.querySelector(
          '[data-view="chat"][data-onboarding="settled"] textarea#message',
        );
        return (
          document.querySelector("[data-setup-host]") === null &&
          composer instanceof HTMLTextAreaElement &&
          !composer.disabled
        );
      };
      while (!chatReady() && Date.now() < chatDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const composer = document.querySelector(
        '[data-view="chat"][data-onboarding="settled"] textarea#message',
      );
      const trainingNav = Array.from(
        document.querySelectorAll('nav[aria-label="Main navigation"] button'),
      ).find((entry) => entry.textContent?.includes("Training"));
      trainingNav?.click();
      const trainingDeadline = Date.now() + 10000;
      while (
        document.querySelector('section[aria-label="Training"]') === null &&
        Date.now() < trainingDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const training = document.querySelector('section[aria-label="Training"]');
      const recentRides = training?.querySelector('[data-panel="recent-rides"]');
      const syncChip = document.querySelector(".sync-chip");
      return {
        trainingSubtitle,
        trainingRowState,
        readiness,
        startEnabled,
        completionStored: localStorage.getItem("enduragent.desktop.onboarding") === '{"version":1,"completed":true}',
        present,
        chatSetup,
        scrimAbsent,
        modalAbsent,
        title,
        escapeStayed,
        shellReplaced,
        finished: document.querySelector("[data-setup-host]") === null,
        shellRestored: document.querySelector('nav[aria-label="Main navigation"]') !== null,
        chatWorking: composer !== null && composer.disabled === false,
        trainingReady:
          training !== null &&
          training.getAttribute("aria-busy") !== "true" &&
          training.querySelector('[data-panel="weekly-summary"]') !== null,
        recentRideVisible:
          recentRides?.querySelector('button[aria-label^="Open ride review:"]') !== null,
        syncNeedsAttention: syncChip?.getAttribute("data-status") === "attention",
      };
    `);
      expect(observed).toEqual({
        trainingSubtitle: "Rides saved on this Mac · connect to sync new ones",
        trainingRowState: "ready",
        readiness: "2 of 2 required ready",
        startEnabled: true,
        completionStored: true,
        present: true,
        chatSetup: true,
        scrimAbsent: true,
        modalAbsent: true,
        title: "Get your coach running before you can chat",
        escapeStayed: true,
        shellReplaced: true,
        finished: true,
        shellRestored: true,
        chatWorking: true,
        trainingReady: true,
        recentRideVisible: true,
        syncNeedsAttention: false,
      });
    },
    90_000,
  );
});
