import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test as base, type Browser, type Page } from "@playwright/test";
import {
  launchDesktopFixture,
  type DesktopFixtureScript,
  type RunningDesktopFixture,
} from "../helpers/desktop-fixture.js";

const TOKEN = "o".repeat(43);
const SYNTHETIC_KEY = `sk-or-v1-${"0".repeat(64)}`;
const ANTHROPIC_KEY = `sk-ant-api03-${"0".repeat(80)}`;

interface ScriptRequest {
  readonly method: string;
  readonly params: unknown;
}

interface LlmRuntimeRequest {
  readonly provider?: string;
  readonly model?: string;
  readonly api_key?: string;
  readonly clear_credential?: boolean;
}

interface RuntimeRequest {
  readonly llm?: LlmRuntimeRequest;
  readonly session?: unknown;
}

function response(value: unknown): readonly string[] {
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

class OpenRouterCoach {
  readonly llmRequests: LlmRuntimeRequest[] = [];
  readonly unexpected: string[] = [];
  private llm: { readonly provider: string; readonly model: string; readonly configured: boolean } =
    { provider: "anthropic", model: "synthetic-model", configured: false };

  readonly script: DesktopFixtureScript = {
    onRequest: (value) => {
      const request = value as ScriptRequest;
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
        case "saveChatAttachmentDraftText":
        case "removeChatAttachment":
        case "retryChatAttachment":
        case "selectChatAttachmentWorkout":
        case "clearChatAttachmentDraft":
          return response(emptyAttachmentComposer);
        case "hasSession":
          return response({ hasSession: false });
        case "getCoachDecision":
          return response({ decision: null });
        case "getTranscriptPage":
        case "getArchivedTranscriptPage":
          return response({ schemaVersion: 1, status: "page", turns: [], nextCursor: null });
        case "listArchivedConversations":
          return response({ schemaVersion: 1, conversations: [], truncated: false });
        case "deleteArchivedConversation":
          return response({ schemaVersion: 1, status: "not-found" });
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
          return response(athleteState);
        case "sync":
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
        case "configureRuntime":
          return response(this.configure(request.params));
        case "getRuntimeConfig":
          return response(this.runtimeConfig());
        default:
          this.unexpected.push(request.method);
          throw new Error(`Unexpected Coach request: ${request.method}`);
      }
    },
  };

  private configure(params: unknown) {
    const request = params as RuntimeRequest;
    const llm = request.llm;
    if (llm !== undefined) {
      this.llmRequests.push(llm);
      this.llm = {
        provider: llm.provider ?? this.llm.provider,
        model: llm.model ?? this.llm.model,
        configured:
          llm.clear_credential !== true && (this.llm.configured || llm.api_key !== undefined),
      };
    }
    return {
      schemaVersion: 3,
      status: "applied",
      applied: {
        llm: llm !== undefined,
        intervals: false,
        session: request.session !== undefined,
      },
    };
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

interface OpenRouterDesktop {
  readonly page: Page;
  readonly fixture: RunningDesktopFixture;
  readonly coach: OpenRouterCoach;
  approveSignIn(): Promise<void>;
}

async function authorizeLines(log: string): Promise<readonly string[]> {
  const text = await readFile(log, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line.length > 0);
}

const test = base.extend<{ openRouterDesktop: OpenRouterDesktop }>({
  openRouterDesktop: async ({ playwright }, use, testInfo) => {
    const coach = new OpenRouterCoach();
    const directory = await mkdtemp(join(tmpdir(), "openrouter-e2e-"));
    const log = join(directory, "authorize.log");
    let approved = 0;
    let fixture: RunningDesktopFixture | undefined;
    let browser: Browser | undefined;
    try {
      fixture = await launchDesktopFixture({
        script: coach.script,
        token: TOKEN,
        width: 1180,
        height: 820,
        colorScheme: "light",
        reducedMotion: true,
        hidden: true,
        extraEnv: {
          LANG: "en_US.UTF-8",
          TZ: "UTC",
          ENDURAGENT_ACCEPTANCE_OPENROUTER_AUTHORIZE_LOG: log,
        },
      });
      browser = await playwright.chromium.connectOverCDP(fixture.remoteDebuggingUrl);
      const context = browser.contexts()[0];
      const page = context?.pages().find((entry) => entry.url().startsWith("enduragent://app/"));
      if (context === undefined || page === undefined) {
        throw new Error("Playwright did not find the Electron renderer");
      }
      await context.route(/^https?:\/\//u, (route) => route.abort("blockedbyclient"));
      await expect(page.locator("[data-shell]")).toHaveAttribute("data-onboarding", "settled", {
        timeout: 30_000,
      });
      await use({
        page,
        fixture,
        coach,
        async approveSignIn() {
          await expect.poll(async () => (await authorizeLines(log)).length).toBe(approved + 1);
          const lines = await authorizeLines(log);
          approved = lines.length;
          const authorize = new URL(lines.at(-1) ?? "");
          expect(authorize.origin + authorize.pathname).toBe("https://openrouter.ai/auth");
          expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
          const callback = new URL(authorize.searchParams.get("callback_url") ?? "");
          expect(callback.hostname).toBe("localhost");
          callback.hostname = "127.0.0.1";
          callback.searchParams.set("code", "acceptance-code");
          callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");
          const reply = await fetch(callback);
          expect(reply.status).toBe(200);
        },
      });
    } finally {
      if (testInfo.status !== testInfo.expectedStatus && fixture !== undefined) {
        const surfaces = (["console", "stdout", "stderr", "dom"] as const).map(
          (surface) => `${surface}\n${fixture?.readCapturedSurface(surface) ?? ""}`,
        );
        await writeFile(
          testInfo.outputPath("desktop.log"),
          [`unexpected coach requests: ${coach.unexpected.join(", ")}`, ...surfaces].join("\n\n"),
        ).catch(() => undefined);
      }
      await browser?.close().catch(() => undefined);
      const outcome = await fixture?.close();
      await rm(directory, { recursive: true, force: true });
      if (outcome !== undefined) {
        expect(outcome.livePids).toEqual([]);
        expect(outcome.listenerCount).toBe(0);
      }
    }
  },
});

async function chooseOpenRouter(page: Page): Promise<void> {
  await page.locator('[data-setup-trigger="ai"]').click();
  await page.locator('[data-setup-menu="ai"] [data-lane="openrouter"]').click();
  await expect(page.locator('[data-setup-panel="openrouter"]')).toBeVisible();
}

async function expectConnected(page: Page): Promise<void> {
  const row = page.locator('[data-setup-row="ai"]');
  await expect(row.locator("[data-setup-row-title]")).toHaveText("OpenRouter");
  await expect(row.locator("[data-setup-row-subtitle]")).toHaveText(
    "Connected · powers your coach",
  );
  await expect(row).toHaveAttribute("data-state", "ready");
}

async function expectNoSecretInRenderer(desktop: OpenRouterDesktop): Promise<void> {
  await expect(desktop.page.locator('input[data-slot="openrouter"]')).toHaveCount(0);
  const html = await desktop.page.content();
  expect(html).not.toContain(SYNTHETIC_KEY);
  expect(html).not.toContain("acceptance-code");
  for (const surface of ["console", "stdout", "stderr", "dom"] as const) {
    expect(desktop.fixture.readCapturedSurface(surface)).not.toContain(SYNTHETIC_KEY);
    expect(desktop.fixture.readCapturedSurface(surface)).not.toContain("acceptance-code");
  }
}

test("connects OpenRouter by signing in through the browser, with no key pasted", async ({
  openRouterDesktop: desktop,
}, testInfo) => {
  const { page } = desktop;
  await expect(page.locator("[data-shell]")).toHaveAttribute("data-shell", "gate");
  await chooseOpenRouter(page);
  const panel = page.locator('[data-setup-panel="openrouter"]');
  await expect(panel).toContainText(
    "Opens OpenRouter in your browser. Approve there, and the key it makes stays on this Mac. The approval page calls this app localhost.",
  );
  await panel.getByRole("button", { name: "Sign in with OpenRouter", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Waiting for browser…" })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("waiting-for-browser.png") });

  await desktop.approveSignIn();

  await expectConnected(page);
  await expect(panel).toHaveCount(0);
  expect(desktop.coach.llmRequests).toContainEqual(
    expect.objectContaining({ provider: "openrouter", api_key: SYNTHETIC_KEY }),
  );
  await expectNoSecretInRenderer(desktop);
  await page.screenshot({ path: testInfo.outputPath("connected.png") });
});

test("signs in to OpenRouter again from Settings after setup", async ({
  openRouterDesktop: desktop,
}, testInfo) => {
  const { page } = desktop;
  await chooseOpenRouter(page);
  await page.getByRole("button", { name: "Sign in with OpenRouter", exact: true }).click();
  await desktop.approveSignIn();
  await expectConnected(page);
  await page.getByRole("button", { name: "Start coaching", exact: true }).click();
  await expect(page.locator("[data-shell]")).toHaveAttribute("data-shell", "app");

  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await navigation.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Setup", exact: true })).toBeVisible();
  await expectConnected(page);
  await expect(
    page.getByRole("button", { name: "Delete the OpenRouter credential" }),
  ).toBeVisible();

  await chooseOpenRouter(page);
  const panel = page.locator('[data-setup-panel="openrouter"]');
  await expect(panel).toContainText(
    "Signing in again replaces the key on this Mac. The old key keeps working on OpenRouter until you delete it there.",
  );
  await panel.getByRole("button", { name: "Sign in again", exact: true }).click();
  await desktop.approveSignIn();

  await expectConnected(page);
  await expect(panel).toHaveCount(0);
  expect(
    desktop.coach.llmRequests.filter((request) => request.api_key === SYNTHETIC_KEY),
  ).toHaveLength(2);
  await expectNoSecretInRenderer(desktop);
  await page.screenshot({ path: testInfo.outputPath("settings-signed-in-again.png") });
});

async function openSettings(page: Page): Promise<void> {
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await navigation.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Setup", exact: true })).toBeVisible();
}

async function setUpWithAnthropicKey(page: Page): Promise<void> {
  await page.locator('[data-setup-trigger="ai"]').click();
  await page.locator('[data-setup-menu="ai"] [data-lane="api-key"]').click();
  await page.locator("#credential-anthropic").fill(ANTHROPIC_KEY);
  await page.getByRole("button", { name: "Save API key", exact: true }).click();
  const row = page.locator('[data-setup-row="ai"]');
  await expect(row).toHaveAttribute("data-state", "ready");
  await page.getByRole("button", { name: "Start coaching", exact: true }).click();
  await expect(page.locator("[data-shell]")).toHaveAttribute("data-shell", "app");
}

function coachRoute(page: Page) {
  return page
    .getByRole("region", { name: "Coach", exact: true })
    .locator("div", { hasText: /^Coach route$/u })
    .locator("xpath=following-sibling::*[1]");
}

test("refreshes Settings after an OpenRouter sign-in replaces a pasted Anthropic key", async ({
  openRouterDesktop: desktop,
}, testInfo) => {
  const { page } = desktop;
  await setUpWithAnthropicKey(page);
  await openSettings(page);
  await expect(coachRoute(page)).toContainText("Anthropic");

  await chooseOpenRouter(page);
  await page.getByRole("button", { name: "Sign in with OpenRouter", exact: true }).click();
  await desktop.approveSignIn();

  await expectConnected(page);
  await expect(
    page.getByRole("button", { name: "Delete the OpenRouter credential" }),
  ).toBeVisible();
  await expect(coachRoute(page)).toContainText("OpenRouter");
  await expectNoSecretInRenderer(desktop);
  await page.screenshot({ path: testInfo.outputPath("settings-after-sign-in.png") });
});
