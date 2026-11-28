import { expect, type Browser, type Page, type TestInfo } from "@playwright/test";
import type { PlaywrightWorkerArgs } from "@playwright/test";
import {
  launchDesktopFixture,
  type DesktopFixtureScript,
  type RunningDesktopFixture,
} from "./desktop-fixture.js";
import { recordScreencast } from "./screencast.js";

export interface ChatRpcRequest {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export function rpcReply(value: unknown): readonly string[] {
  return [JSON.stringify(value)];
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

export function chatRpcDefault(request: ChatRpcRequest): readonly string[] {
  switch (request.method) {
    case "getAthleteState":
      return rpcReply({
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
    case "getSetupStatus":
      return rpcReply({ schemaVersion: 1, durableTrainingData: true });
    case "getLanguagePreference":
      return rpcReply({ value: null });
    case "getUnitsPreference":
      return rpcReply({ value: "metric", source: "default" });
    case "getChatAttachmentComposer":
    case "saveChatAttachmentDraftText":
      return rpcReply(emptyAttachmentComposer);
    case "hasSession":
      return rpcReply({ hasSession: true });
    case "getCoachDecision":
      return rpcReply({ decision: null });
    case "getChatQueue":
      return rpcReply({ schemaVersion: 1, revision: 0, items: [] });
    case "getTranscriptPage":
      return rpcReply({ schemaVersion: 1, status: "page", turns: [], nextCursor: null });
    case "listArchivedConversations":
      return rpcReply({ schemaVersion: 1, conversations: [], truncated: false });
    case "resumePlanningRequests":
      return rpcReply({ deliveries: [] });
    case "listPlanningRequests":
      return rpcReply({ deliveries: [], planCreation: null });
    case "getRuntimeConfig":
      return rpcReply({
        schemaVersion: 3,
        llm: { provider: "codex-agent", model: "fixture", credential_configured: true },
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
    case "listPlans":
      return rpcReply({ active: null, history: [], changes: [] });
    case "getSpendSummary":
      return rpcReply({
        schemaVersion: 1,
        todayUsd: 0,
        limitUsd: null,
        warning: null,
        pricedGenerations: 0,
        totalGenerations: 0,
      });
    default:
      return rpcReply({});
  }
}

export interface HiddenChatApp {
  readonly page: Page;
  readonly fixture: RunningDesktopFixture;
  close(): Promise<void>;
}

export async function openHiddenChatApp(input: {
  readonly playwright: PlaywrightWorkerArgs["playwright"];
  readonly testInfo: TestInfo;
  readonly script: DesktopFixtureScript;
  readonly token: string;
}): Promise<HiddenChatApp> {
  const fixture = await launchDesktopFixture({
    script: input.script,
    token: input.token,
    width: 1180,
    height: 820,
    colorScheme: "light",
    reducedMotion: true,
    hidden: true,
    routeChatAttachmentComposer: true,
    extraEnv: { ENDURAGENT_ACCEPTANCE_HIDDEN: "1", LANG: "en_US.UTF-8", TZ: "UTC" },
  });
  let browser: Browser | undefined;
  try {
    browser = await input.playwright.chromium.connectOverCDP(fixture.remoteDebuggingUrl);
    const context = browser.contexts()[0];
    if (context === undefined) throw new Error("Playwright did not find the Electron context");
    const page = context.pages().find((c) => c.url().startsWith("enduragent://app/"));
    if (page === undefined) throw new Error("Playwright did not find the Electron renderer");
    await context.route(/^https?:\/\//u, (route) => route.abort("blockedbyclient"));
    const stopRecording = await recordScreencast(context, page);
    await expect(page.locator("[data-shell]")).toHaveAttribute("data-onboarding", "settled", {
      timeout: 30_000,
    });
    const opened = browser;
    return {
      page,
      fixture,
      async close() {
        await stopRecording(input.testInfo.outputPath("video.webm")).catch(() => undefined);
        await opened.close().catch(() => undefined);
        await fixture.close().catch(() => undefined);
      },
    };
  } catch (error) {
    await browser?.close().catch(() => undefined);
    await fixture.close().catch(() => undefined);
    throw error;
  }
}
