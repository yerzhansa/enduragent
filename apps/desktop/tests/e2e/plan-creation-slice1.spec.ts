import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Browser, type Page, type PlaywrightWorkerArgs } from "@playwright/test";
import {
  createPlanCreationRepository,
  type PlanCreationRepository,
} from "@enduragent/kernel/planning";
import { runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import {
  createPlanCreationOperations,
  type PlanCreationHost,
} from "../../../../packages/coach/src/plan-creation-operations.js";
import {
  launchDesktopFixture,
  type DesktopFixtureScript,
  type RunningDesktopFixture,
} from "../helpers/desktop-fixture.js";
import { createPlanQaFixtureScript } from "../helpers/plan-qa-live.js";

const token = "c".repeat(43);
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
      checkedAt: "1998-09-02T00:00:00.000Z",
    },
  },
  draft: null,
} as const;

interface ScriptRequest {
  readonly method: string;
  readonly params: unknown;
}

const response = (value: unknown): readonly string[] => [JSON.stringify(value)];

class PlanCreationBackend {
  readonly script: DesktopFixtureScript;
  private store: (SqlStore & MigratorStore) | undefined;
  private repository: PlanCreationRepository | undefined;
  private host: PlanCreationHost | undefined;
  private sequence = 0;
  private instant = 883_612_800_000;

  constructor(private readonly databasePath: string) {
    const base = createPlanQaFixtureScript("PL-S004");
    this.script = {
      onRequest: async (value) => {
        const request = value as ScriptRequest;
        if (request.method === "getChatAttachmentComposer") {
          return response(emptyAttachmentComposer);
        }
        if (request.method === "resumePlanningRequests") return response({ deliveries: [] });
        if (request.method === "listPlanningRequests") {
          return response({ deliveries: [], planCreation: await this.requireHost().readCard() });
        }
        if (request.method === "plan_creation.start") {
          return response(
            await this.requireHost()["plan_creation.start"](
              request.params as Parameters<PlanCreationHost["plan_creation.start"]>[0],
            ),
          );
        }
        if (request.method === "plan_creation.answer") {
          return response(
            await this.requireHost()["plan_creation.answer"](
              request.params as Parameters<PlanCreationHost["plan_creation.answer"]>[0],
            ),
          );
        }
        return base.onRequest(value);
      },
    };
  }

  async open(): Promise<void> {
    this.store = openSqliteStorage(this.databasePath);
    await runMigrations(this.store, MIGRATIONS);
    this.repository = createPlanCreationRepository(this.store);
    this.host = createPlanCreationOperations({
      repository: this.repository,
      identity: {
        deviceId: async () => "fixture-device",
        newUlid: () => `${++this.sequence}`.padStart(26, "0"),
        hlcStamp: () => ({ physicalMs: this.instant++, counter: 0 }),
      },
      crypto: globalThis.crypto,
      eventCandidates: { read: async () => [] },
    });
  }

  async reopen(): Promise<void> {
    await this.close();
    await this.open();
  }

  async close(): Promise<void> {
    await this.store?.close();
    this.store = undefined;
    this.repository = undefined;
    this.host = undefined;
  }

  async inspect() {
    const store = this.requireStore();
    return {
      creation: await store.get("SELECT status,version FROM plan_creation"),
      answers: await store.all(
        "SELECT sequence,creation_version,answer_key FROM plan_creation_answer ORDER BY sequence",
      ),
      commands: await store.all(
        "SELECT command_name,status FROM planning_command WHERE command_name IN ('plan_creation.start','plan_creation.answer') ORDER BY created_at_ms,command_id",
      ),
    };
  }

  private requireStore(): SqlStore & MigratorStore {
    if (this.store === undefined) throw new TypeError("Plan Creation store is closed");
    return this.store;
  }

  private requireHost(): PlanCreationHost {
    if (this.host === undefined) throw new TypeError("Plan Creation host is closed");
    return this.host;
  }
}

interface Scenario {
  readonly backend: PlanCreationBackend;
  readonly fixture: RunningDesktopFixture;
  readonly scratch: string;
  browser: Browser;
  page: Page;
}

type Playwright = PlaywrightWorkerArgs["playwright"];

async function connect(playwright: Playwright, fixture: RunningDesktopFixture) {
  const browser = await playwright.chromium.connectOverCDP(fixture.remoteDebuggingUrl);
  const context = browser.contexts()[0];
  const page = context
    ?.pages()
    .find((candidate) => candidate.url().startsWith("enduragent://app/"));
  if (page === undefined) throw new TypeError("Plan Creation renderer is unavailable");
  await expect(page.locator("[data-shell]")).toHaveAttribute("data-onboarding", "settled", {
    timeout: 30_000,
  });
  return { browser, page };
}

async function launch(playwright: Playwright): Promise<Scenario> {
  const scratch = await mkdtemp(join(tmpdir(), "plan-creation-"));
  const backend = new PlanCreationBackend(join(scratch, "store.db"));
  await backend.open();
  const fixture = await launchDesktopFixture({
    script: backend.script,
    token,
    width: 1180,
    height: 820,
    colorScheme: "light",
    reducedMotion: true,
    hidden: false,
    routeChatAttachmentComposer: true,
  });
  return { backend, fixture, scratch, ...(await connect(playwright, fixture)) };
}

async function relaunch(scenario: Scenario, playwright: Playwright): Promise<void> {
  await scenario.browser.close();
  await scenario.fixture.relaunch(() => scenario.backend.reopen());
  Object.assign(scenario, await connect(playwright, scenario.fixture));
}

async function close(scenario: Scenario): Promise<void> {
  await scenario.browser.close().catch(() => {});
  await scenario.fixture.close().catch(() => {});
  await scenario.backend.close().catch(() => {});
  await rm(scenario.scratch, { recursive: true, force: true });
}

async function confirmFitnessGoal(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Start a Plan" }).click();
  await page.getByRole("button", { name: "Improve without an event" }).click();
  await page.getByRole("textbox", { name: "Goal outcome" }).fill("Build steady power");
  await page.getByRole("button", { name: "Confirm goal" }).click();
}

test("persists goal and success and restores the completed Card", async ({ playwright }) => {
  const scenario = await launch(playwright);
  try {
    await confirmFitnessGoal(scenario.page);
    await expect(
      scenario.page.getByRole("heading", {
        name: "What would success mean for this Fitness Goal?",
      }),
    ).toBeVisible();
    await scenario.page
      .getByRole("textbox", { name: "Success meaning" })
      .fill("Ride four steady hours");
    await scenario.page.getByRole("button", { name: "Confirm success" }).click();
    await expect(scenario.page.getByText("Build steady power", { exact: true })).toBeVisible();
    await expect(scenario.page.getByText("Ride four steady hours", { exact: true })).toBeVisible();
    await expect(scenario.page.getByText("2 answers confirmed", { exact: true })).toBeVisible();
    await expect(scenario.page.getByRole("button", { name: "Send message" })).toBeEnabled();
    await relaunch(scenario, playwright);
    await expect(scenario.page.getByText("Build steady power", { exact: true })).toBeVisible();
    await expect(scenario.page.getByText("Ride four steady hours", { exact: true })).toBeVisible();
    await expect(scenario.page.getByRole("button", { name: "Send message" })).toBeEnabled();
    await expect(scenario.backend.inspect()).resolves.toEqual({
      creation: { status: "in-progress", version: 3 },
      answers: [
        { sequence: 1, creation_version: 2, answer_key: "goal" },
        { sequence: 2, creation_version: 3, answer_key: "success" },
      ],
      commands: [
        { command_name: "plan_creation.start", status: "succeeded" },
        { command_name: "plan_creation.answer", status: "succeeded" },
        { command_name: "plan_creation.answer", status: "succeeded" },
      ],
    });
  } finally {
    await close(scenario);
  }
});

test("restores the success Card after relaunching between answers", async ({ playwright }) => {
  const scenario = await launch(playwright);
  try {
    await confirmFitnessGoal(scenario.page);
    await relaunch(scenario, playwright);
    await expect(
      scenario.page.getByRole("heading", {
        name: "What would success mean for this Fitness Goal?",
      }),
    ).toBeVisible();
    await expect(scenario.page.getByRole("combobox", { name: "Message your coach" })).toBeEnabled();
    await expect(scenario.page.getByRole("button", { name: "Send message" })).toBeDisabled();
  } finally {
    await close(scenario);
  }
});
