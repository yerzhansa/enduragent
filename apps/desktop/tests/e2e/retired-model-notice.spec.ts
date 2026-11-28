import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  launchDesktopFixture,
  type DesktopFixtureScript,
  type RunningDesktopFixture,
} from "../helpers/desktop-fixture.js";
import { recordScreencast } from "../helpers/screencast.js";

const TOKEN = "r".repeat(43);
const ANTHROPIC_KEY = `sk-ant-api03-${"0".repeat(80)}`;

interface ScriptRequest {
  readonly method: string;
  readonly params: unknown;
}

interface LlmRuntimeRequest {
  readonly provider?: string;
  readonly model?: string;
  readonly api_key?: string;
}

const composer = {
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

class ScriptedCoach {
  readonly llmRequests: LlmRuntimeRequest[] = [];
  private readonly llm = { provider: "anthropic", model: "claude-opus-5", configured: true };

  readonly script: DesktopFixtureScript = {
    onStreamRequest: async (value) => {
      throw new Error(`Unexpected streamed Coach request: ${(value as ScriptRequest).method}`);
    },
    onRequest: async (value) => this.answer(value as ScriptRequest),
  };

  private answer(request: ScriptRequest): readonly string[] {
    switch (request.method) {
      case "getSetupStatus":
        return response({ schemaVersion: 1, durableTrainingData: true });
      case "getLanguagePreference":
        return response({ value: null });
      case "setLanguagePreference":
        return response(request.params);
      case "getUnitsPreference":
        return response({ value: "metric", source: "default" });
      case "setUnitsPreference":
        return response({ value: "metric", source: "cycling" });
      case "getChatQueue":
        return response({ schemaVersion: 1, revision: 0, items: [] });
      case "getChatAttachmentComposer":
        return response(composer);
      case "hasSession":
        return response({ hasSession: false });
      case "getCoachDecision":
        return response({ decision: null });
      case "getTranscriptPage":
      case "getArchivedTranscriptPage":
        return response({ schemaVersion: 1, status: "page", turns: [], nextCursor: null });
      case "listArchivedConversations":
        return response({ schemaVersion: 1, conversations: [], truncated: false });
      case "resumePlanningRequests":
        return response({ deliveries: [] });
      case "listPlanningRequests":
        return response({ deliveries: [], planCreation: null });
      case "getSpendSummary":
        return response({
          schemaVersion: 1,
          currency: "USD",
          today: { spend: 0, cap: null },
          routes: [],
        });
      case "getAthleteState":
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
      case "configureRuntime":
        return this.configure(request.params as { readonly llm?: LlmRuntimeRequest });
      case "plan.calendar":
        return response({ status: "settings", weekDelivery: "send-each-week" });
      case "getRuntimeConfig":
        return response(this.runtimeConfig());
      default:
        throw new Error(`Unexpected Coach request: ${request.method}`);
    }
  }

  private configure(params: { readonly llm?: LlmRuntimeRequest }): readonly string[] {
    if (params.llm !== undefined) {
      this.llmRequests.push(params.llm);
      this.llm.provider = params.llm.provider ?? this.llm.provider;
      this.llm.model = params.llm.model ?? this.llm.model;
    }
    return response({
      schemaVersion: 3,
      status: "applied",
      applied: { llm: params.llm !== undefined, intervals: false, session: false },
    });
  }

  private runtimeConfig() {
    return {
      schemaVersion: 3,
      llm: {
        provider: this.llm.provider,
        model: this.llm.model,
        credential_configured: this.llm.configured,
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
    };
  }
}

async function finishSetupWithSavedKey(page: Page): Promise<void> {
  const shell = page.locator("[data-shell]");
  await expect(shell).toHaveAttribute("data-onboarding", "settled", { timeout: 30_000 });
  await page.locator('[data-setup-trigger="ai"]').click();
  await page.locator('[data-setup-menu="ai"] [data-lane="api-key"]').click();
  const panel = page.locator('[data-setup-panel="api-key"]');
  await expect(panel).toBeVisible();
  await page.locator('input[data-slot="anthropic"]').fill(ANTHROPIC_KEY);
  await panel.locator("button", { hasText: /^Save$/u }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.locator("[data-setup-readiness]")).toHaveText("2 of 2 required ready");
  await page.getByRole("button", { name: "Start coaching", exact: true }).click();
  await expect(shell).toHaveAttribute("data-shell", "app");
}

test("an athlete whose saved model left the list is told so and switches with one press", async ({
  playwright,
}, testInfo) => {
  const coach = new ScriptedCoach();
  let fixture: RunningDesktopFixture | undefined;
  let browser: Browser | undefined;
  let stopScreencast: ((path: string) => Promise<void>) | undefined;
  try {
    fixture = await launchDesktopFixture({
      script: coach.script,
      token: TOKEN,
      width: 1180,
      height: 820,
      colorScheme: "light",
      reducedMotion: true,
      routeChatAttachmentComposer: true,
      extraEnv: { LANG: "en_US.UTF-8", TZ: "UTC" },
    });
    browser = await playwright.chromium.connectOverCDP(fixture.remoteDebuggingUrl);
    const context = browser.contexts()[0];
    const page = context?.pages().find((entry) => entry.url().startsWith("enduragent://app/"));
    if (context === undefined || page === undefined) {
      throw new Error("Playwright did not find the Electron renderer");
    }
    await context.route(/^https?:\/\//u, (route) => route.abort("blockedbyclient"));
    stopScreencast = await recordScreencast(context, page);

    await finishSetupWithSavedKey(page);
    expect(coach.llmRequests.map((request) => request.model)).not.toContain("claude-opus-5-5");

    await page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("button", { name: "Settings", exact: true })
      .click();
    const coachSection = page.getByRole("region", { name: "Coach", exact: true });
    await page
      .getByRole("heading", { name: "Coach", exact: true })
      .evaluate((element) => element.scrollIntoView({ block: "start", behavior: "instant" }));
    await expect(
      page.locator("#coach-model"),
      "Settings should name the saved model as no longer listed, not as a model the athlete typed",
    ).toHaveText(/^claude-opus-5 \(no longer listed\)▼?$/u);
    await expect(page.locator("#coach-custom-model")).toHaveCount(0);
    await expect(
      coachSection.getByText(
        "claude-opus-5 is no longer on the model list. Your coach keeps using it until you switch.",
        { exact: true },
      ),
      "Settings should say the saved model left the model list",
    ).toBeVisible();
    await expect(
      coachSection.getByText("Anthropic → claude-opus-5", { exact: true }),
    ).toBeVisible();
    await page.waitForTimeout(600);

    await coachSection
      .getByRole("button", { name: "Switch to Claude Opus 5.5", exact: true })
      .click();

    await expect(
      coachSection.getByText("Anthropic → Claude Opus 5.5", { exact: true }),
      "the coach route should become Claude Opus 5.5 after one press",
    ).toBeVisible();
    await expect(page.locator("#coach-model")).toHaveText(/^Claude Opus 5\.5/u);
    await expect(coachSection.getByText(/is no longer on the model list/u)).toHaveCount(0);
    expect(coach.llmRequests.at(-1)?.model, "the coach should be told to use Claude Opus 5.5").toBe(
      "claude-opus-5-5",
    );
    await page.waitForTimeout(600);
  } finally {
    await stopScreencast?.(testInfo.outputPath("video.webm")).catch(() => undefined);
    if (testInfo.status !== testInfo.expectedStatus && fixture !== undefined) {
      testInfo.attachments.push({
        name: "desktop.log",
        contentType: "text/plain",
        body: Buffer.from(
          (["console", "stdout", "stderr"] as const)
            .map((surface) => `${surface}\n${fixture?.readCapturedSurface(surface) ?? ""}`)
            .join("\n"),
        ),
      });
    }
    await browser?.close().catch(() => undefined);
    await fixture?.close().catch(() => undefined);
  }
});
