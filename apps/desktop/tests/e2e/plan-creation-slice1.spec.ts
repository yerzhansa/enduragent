import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Browser, type Page, type PlaywrightWorkerArgs } from "@playwright/test";
import { launchDesktopFixture, type RunningDesktopFixture } from "../helpers/desktop-fixture.js";
import { PlanCreationBackend } from "../helpers/plan-creation-backend.js";

const token = "c".repeat(43);

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
  const page = browser
    .contexts()[0]
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
  let fixture: RunningDesktopFixture | undefined;
  try {
    await backend.open();
    fixture = await launchDesktopFixture({
      script: backend.script,
      token,
      width: 1180,
      height: 820,
      colorScheme: "light",
      reducedMotion: true,
      hidden: true,
      routeChatAttachmentComposer: true,
    });
    return { backend, fixture, scratch, ...(await connect(playwright, fixture)) };
  } catch (error) {
    try {
      await fixture?.close();
    } finally {
      try {
        await backend.close();
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    }
    throw error;
  }
}

async function relaunch(scenario: Scenario, playwright: Playwright): Promise<void> {
  await scenario.browser.close();
  await scenario.fixture.relaunch(() => scenario.backend.reopen());
  Object.assign(scenario, await connect(playwright, scenario.fixture));
}

async function close(scenario: Scenario): Promise<void> {
  await scenario.browser.close().catch(() => {});
  try {
    await expect(scenario.fixture.close()).resolves.toEqual({ livePids: [], listenerCount: 0 });
  } finally {
    try {
      await scenario.backend.close();
    } finally {
      await rm(scenario.scratch, { recursive: true, force: true });
    }
  }
}

async function waitForVersion(backend: PlanCreationBackend, version: number): Promise<void> {
  await expect.poll(async () => (await backend.card())?.version).toBe(version);
}

async function choose(page: Page, backend: PlanCreationBackend, version: number, answer: string) {
  await page.locator(`[data-parity="choice.row"][data-answer="${answer}"]`).click();
  await waitForVersion(backend, version);
}

async function answerThroughFitnessSuccess(scenario: Scenario): Promise<void> {
  await scenario.page.locator("#message").fill("/plan");
  await scenario.page.locator("#message").press("Enter");
  await expect(
    scenario.page.locator('[data-parity="question.card"][data-question="goal"]'),
  ).toBeVisible();
  await waitForVersion(scenario.backend, 1);
  await choose(scenario.page, scenario.backend, 2, "fitness");
  await choose(scenario.page, scenario.backend, 3, "8");
  await choose(scenario.page, scenario.backend, 4, "flexible");
  await scenario.page.locator('[data-answer="hours-6"]').click();
  await scenario.page.locator('[data-parity="availability.longest"]').fill("2");
  await scenario.page.getByRole("button", { name: "Continue", exact: true }).click();
  await waitForVersion(scenario.backend, 5);
  await choose(scenario.page, scenario.backend, 6, "asap");
  await choose(scenario.page, scenario.backend, 7, "none");
  await choose(scenario.page, scenario.backend, 8, "regular");
  await choose(scenario.page, scenario.backend, 9, "train-consistently");
}

test("persists the Fitness success choice and restores the Restriction Card", async ({
  playwright,
}) => {
  const scenario = await launch(playwright);
  try {
    await answerThroughFitnessSuccess(scenario);
    await expect(
      scenario.page.locator('[data-parity="question.card"][data-question="restriction"]'),
    ).toBeVisible();
    await expect(scenario.page.getByText("Train consistently", { exact: true })).toBeVisible();
    await expect(scenario.page.getByRole("button", { name: "Send message" })).toBeDisabled();
    await relaunch(scenario, playwright);
    await expect(
      scenario.page.locator('[data-parity="question.card"][data-question="restriction"]'),
    ).toBeVisible();
    await expect(scenario.page.getByRole("button", { name: "Send message" })).toBeDisabled();
    const inspected = await scenario.backend.inspect();
    expect(inspected.creation).toEqual({ status: "in-progress", version: 9 });
    expect(inspected.answers).toEqual([
      { sequence: 1, creation_version: 2, answer_key: "goal" },
      { sequence: 2, creation_version: 3, answer_key: "plan-length" },
      { sequence: 3, creation_version: 4, answer_key: "schedule-mode" },
      { sequence: 4, creation_version: 5, answer_key: "availability" },
      { sequence: 5, creation_version: 6, answer_key: "start-timing" },
      { sequence: 6, creation_version: 7, answer_key: "commitments" },
      { sequence: 7, creation_version: 8, answer_key: "baseline" },
      { sequence: 8, creation_version: 9, answer_key: "success" },
    ]);
    expect(inspected.commands).toHaveLength(9);
    expect(inspected.commands).toEqual(
      expect.arrayContaining([
        { command_name: "plan_creation.start", status: "succeeded" },
        { command_name: "plan_creation.answer", status: "succeeded" },
      ]),
    );
  } finally {
    await close(scenario);
  }
});

test("restores the Plan length Card after relaunching between answers", async ({ playwright }) => {
  const scenario = await launch(playwright);
  try {
    await scenario.page.locator("#message").fill("/plan");
    await scenario.page.locator("#message").press("Enter");
    await expect(
      scenario.page.locator('[data-parity="question.card"][data-question="goal"]'),
    ).toBeVisible();
    await waitForVersion(scenario.backend, 1);
    await choose(scenario.page, scenario.backend, 2, "fitness");
    await relaunch(scenario, playwright);
    await expect(
      scenario.page.locator('[data-parity="question.card"][data-question="plan-length"]'),
    ).toBeVisible();
    await expect(
      scenario.page.getByRole("combobox", { name: "Message your coach" }),
    ).toBeDisabled();
    await expect(scenario.page.getByRole("button", { name: "Send message" })).toBeDisabled();
  } finally {
    await close(scenario);
  }
});
