import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Browser, type Page, type PlaywrightWorkerArgs } from "@playwright/test";
import type { PlanCreationCardModel } from "@enduragent/coach-contract";
import { launchDesktopFixture, type RunningDesktopFixture } from "../helpers/desktop-fixture.js";
import { PlanCreationBackend } from "../helpers/plan-creation-backend.js";

const token = "d".repeat(43);

interface Scenario {
  readonly backend: PlanCreationBackend;
  readonly fixture: RunningDesktopFixture;
  readonly scratch: string;
  readonly colorScheme: "light" | "dark";
  readonly width: number;
  browser: Browser;
  page: Page;
}

type Playwright = PlaywrightWorkerArgs["playwright"];

async function connect(
  playwright: Playwright,
  fixture: RunningDesktopFixture,
  colorScheme: "light" | "dark",
  initializeAppearance = false,
) {
  const browser = await playwright.chromium.connectOverCDP(fixture.remoteDebuggingUrl);
  const page = browser
    .contexts()[0]
    ?.pages()
    .find((candidate) => candidate.url().startsWith("enduragent://app/"));
  if (page === undefined) throw new TypeError("Plan Creation renderer is unavailable");
  await expect(page.locator("[data-shell]")).toHaveAttribute("data-onboarding", "settled", {
    timeout: 30_000,
  });
  await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
  if (initializeAppearance) {
    const navigation = page.getByRole("navigation", { name: "Main navigation" });
    await navigation.getByRole("button", { name: "Settings", exact: true }).click();
    const appearance = page
      .getByRole("group", { name: "Appearance", exact: true })
      .getByRole("button", { name: colorScheme === "light" ? "Light" : "Dark", exact: true });
    await appearance.click();
    await expect(appearance).toHaveAttribute("aria-pressed", "true");
    await navigation.getByRole("button", { name: "Chat", exact: true }).click();
  }
  await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
  expect(await page.evaluate(() => localStorage.getItem("enduragent.ui.appearance"))).toBe(
    colorScheme,
  );
  return { browser, page };
}

async function launch(
  playwright: Playwright,
  appearance: { readonly width: number; readonly colorScheme: "light" | "dark" },
): Promise<Scenario> {
  const scratch = await mkdtemp(join(tmpdir(), "plan-draft-review-"));
  const backend = new PlanCreationBackend(join(scratch, "store.db"));
  let fixture: RunningDesktopFixture | undefined;
  try {
    await backend.open();
    await backend.seedUnrelatedPlans();
    fixture = await launchDesktopFixture({
      script: backend.script,
      token,
      width: appearance.width,
      height: 820,
      colorScheme: appearance.colorScheme,
      reducedMotion: true,
      hidden: true,
      routeChatAttachmentComposer: true,
    });
    await fixture.setViewport(appearance.width, 820);
    const connected = await connect(playwright, fixture, appearance.colorScheme, true);
    expect(await connected.page.evaluate(() => innerWidth)).toBe(appearance.width);
    return { backend, fixture, scratch, ...appearance, ...connected };
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
  await scenario.fixture.setViewport(scenario.width, 820);
  Object.assign(scenario, await connect(playwright, scenario.fixture, scenario.colorScheme));
  expect(await scenario.page.evaluate(() => innerWidth)).toBe(scenario.width);
  await expect(
    scenario.page.getByRole("heading", { name: "Every week and Workout", exact: true }),
  ).toBeVisible();
}

async function capture(scenario: Scenario, name: string): Promise<void> {
  const screenshotPath = test.info().outputPath(`${name}.png`);
  await scenario.page.screenshot({ path: screenshotPath });
  await test.info().attach(`${name}-screenshot`, {
    path: screenshotPath,
    contentType: "image/png",
  });
  if (name === "review" || name === "stale" || name === "rebuilt" || name === "restored") {
    for (const title of ["Draft inputs", "Every week and Workout"]) {
      const region = scenario.page.getByRole("region", { name: title, exact: true });
      await region.getByRole("heading").scrollIntoViewIfNeeded();
      const path = test.info().outputPath(`${name}-${title}.png`);
      await scenario.page.screenshot({ path });
      await test.info().attach(`${name}-${title}`, { path, contentType: "image/png" });
    }
    await scenario.page
      .getByRole("button", { name: "Edit answers", exact: true })
      .scrollIntoViewIfNeeded();
    const path = test.info().outputPath(`${name}-actions.png`);
    await scenario.page.screenshot({ path });
    await test.info().attach(`${name}-actions`, { path, contentType: "image/png" });
  }
  await test.info().attach(`${name}-dom`, {
    body: await scenario.page.content(),
    contentType: "text/html",
  });
  expect(
    await scenario.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await expect(scenario.page.locator("html")).toHaveAttribute("data-theme", scenario.colorScheme);
}

async function close(scenario: Scenario): Promise<void> {
  try {
    await test.info().attach("stored-creation", {
      body: JSON.stringify({
        card: await scenario.backend.card(),
        drafts: await scenario.backend.inspectDrafts(),
        requests: scenario.backend.creationRequests,
        unrelated: await scenario.backend.inspectUnrelated(),
      }),
      contentType: "application/json",
    });
    await capture(scenario, "final");
  } finally {
    await scenario.browser.close().catch(() => {});
    try {
      const cleanup = await scenario.fixture.close();
      await test.info().attach("cleanup", {
        body: JSON.stringify(cleanup),
        contentType: "application/json",
      });
      expect(cleanup).toEqual({ livePids: [], listenerCount: 0 });
    } finally {
      try {
        await scenario.backend.close();
      } finally {
        await rm(scenario.scratch, { recursive: true, force: true });
      }
    }
  }
}

async function card(backend: PlanCreationBackend): Promise<PlanCreationCardModel> {
  const value = await backend.card();
  if (value === null) throw new TypeError("Plan Creation is unavailable");
  return value;
}

async function choose(scenario: Scenario, answer: string): Promise<void> {
  const before = await card(scenario.backend);
  await scenario.page.locator(`[data-parity="choice.row"][data-answer="${answer}"]`).click();
  await expect.poll(async () => (await scenario.backend.card())?.version).toBe(before.version + 1);
}

async function continueAnswer(scenario: Scenario, confirm = false): Promise<void> {
  const before = await card(scenario.backend);
  await scenario.page.getByRole("button", { name: "Continue", exact: true }).click();
  if (confirm)
    await scenario.page
      .getByRole("region", { name: "Did I read this right?", exact: true })
      .getByRole("button", { name: "Confirm", exact: true })
      .click();
  await expect.poll(async () => (await scenario.backend.card())?.version).toBe(before.version + 1);
}

async function completeFitness(scenario: Scenario): Promise<void> {
  await scenario.page.locator("#message").fill("/plan");
  await scenario.page.locator("#message").press("Enter");
  await expect(
    scenario.page.locator('[data-parity="question.card"][data-question="goal"]'),
  ).toBeVisible();
  await expect.poll(async () => (await scenario.backend.card())?.version).toBe(1);
  await choose(scenario, "fitness");
  await choose(scenario, "4");
  await choose(scenario, "flexible");
  await scenario.page.locator('[data-answer="hours-6"]').click();
  await scenario.page.locator('[data-parity="availability.longest"]').fill("2");
  await continueAnswer(scenario);
  await choose(scenario, "asap");
  await choose(scenario, "none");
  await choose(scenario, "regular");
  await scenario.page.locator('[data-parity="choice.custom"][data-answer="custom"]').click();
  await scenario.page.locator('[data-parity="custom.textarea"]').fill("Ride four steady hours");
  await continueAnswer(scenario, true);
  await choose(scenario, "none");
  await expect(
    scenario.page.getByText("The essentials are complete.", { exact: true }),
  ).toBeVisible();
}

async function build(scenario: Scenario, rebuild = false): Promise<PlanCreationCardModel> {
  const before = await card(scenario.backend);
  await scenario.page
    .getByRole("button", {
      name: rebuild ? "Rebuild Draft" : "Build Draft",
      exact: true,
    })
    .click();
  await expect.poll(async () => (await scenario.backend.card())?.version).toBe(before.version + 1);
  const current = await card(scenario.backend);
  expect(current).toMatchObject({ status: "review", draftStale: false });
  expect(scenario.backend.creationRequests.at(-1)).toMatchObject({
    method: "plan_creation.preview",
    params: { creationId: before.creationId, expectedVersion: before.version },
  });
  await expect(
    scenario.page.getByRole("heading", { name: "Every week and Workout", exact: true }),
  ).toBeVisible();
  await expect(
    scenario.page.getByRole("button", { name: "Activate Plan", exact: true }),
  ).toBeEnabled();
  return current;
}

for (const appearance of [
  { width: 1180, colorScheme: "light" },
  { width: 1180, colorScheme: "dark" },
  { width: 720, colorScheme: "light" },
  { width: 720, colorScheme: "dark" },
] as const) {
  test(`reviews, rebuilds, and restores a Draft at ${appearance.width} in ${appearance.colorScheme}`, async ({
    playwright,
  }) => {
    const scenario = await launch(playwright, appearance);
    try {
      const unrelated = await scenario.backend.inspectUnrelated();
      await completeFitness(scenario);
      await capture(scenario, "ready");
      const first = await build(scenario);
      if (first.draft === null) throw new TypeError("Built Draft is unavailable");
      const stored = await scenario.backend.inspectDrafts();
      expect(stored.revisions).toHaveLength(1);
      expect(stored.revisions[0]).toMatchObject({
        revision_number: 1,
        parent_revision_number: null,
      });
      expect(stored.creations[0]).toMatchObject({
        status: "review",
        current_draft_revision_number: 1,
      });
      await expect(
        scenario.page.getByText("Review the whole Draft before activating.", { exact: true }),
      ).toBeVisible();
      await expect(scenario.page.getByText("Local review only", { exact: true })).toBeVisible();
      await expect(
        scenario.page
          .getByRole("table", { name: "Draft inputs", exact: true })
          .getByRole("row")
          .filter({ hasText: "Main Goal" })
          .getByRole("cell"),
      ).toHaveText("Improve fitness");
      const disclosure = scenario.page
        .locator("details")
        .filter({ has: scenario.page.locator("summary", { hasText: "How this Plan was built" }) });
      await expect(disclosure).not.toHaveAttribute("open", "");
      await disclosure.locator("summary").click();
      await expect(disclosure).toContainText("Heart rate or perceived effort. No FTP test.");
      await disclosure.locator("summary").click();
      for (const week of first.draft.weeks) {
        await expect(scenario.page.getByText(new RegExp(`^Week ${week.number} ·`))).toHaveCount(1);
        const rows = scenario.page
          .getByRole("list", { name: `Week ${week.number} Workouts`, exact: true })
          .getByRole("listitem");
        await expect(rows).toHaveCount(week.workouts.length);
        for (const [index, workout] of week.workouts.entries()) {
          await expect(rows.nth(index)).toContainText(
            `${workout.name} · ${workout.minutes} min · ${workout.guidance}`,
          );
        }
      }
      await expect(scenario.page.getByText("Priority 1 · Undated", { exact: true })).toHaveCount(4);
      await capture(scenario, "review");
      await scenario.page.getByRole("button", { name: "Edit answers", exact: true }).click();
      await scenario.page.getByRole("button", { name: "Back to Draft", exact: true }).click();
      await expect(
        scenario.page.getByRole("button", { name: "Edit answers", exact: true }),
      ).toBeFocused();
      await scenario.page.getByRole("button", { name: "Edit answers", exact: true }).click();
      await scenario.page.getByRole("button", { name: "Edit Plan length", exact: true }).click();
      await choose(scenario, "8");
      await expect(
        scenario.page.getByRole("heading", { name: "Changed answers", exact: true }),
      ).toBeVisible();
      const stale = await card(scenario.backend);
      expect(stale.draftStale).toBe(true);
      expect(stale.draft).toEqual(first.draft);
      expect((await scenario.backend.inspectDrafts()).revisions).toEqual(stored.revisions);
      await capture(scenario, "stale");
      await relaunch(scenario, playwright);
      expect(await card(scenario.backend)).toEqual(stale);
      await expect(
        scenario.page.getByRole("button", { name: "Rebuild Draft", exact: true }),
      ).toBeVisible();
      const rebuilt = await build(scenario, true);
      expect(rebuilt.draft?.weeks).toHaveLength(8);
      expect(rebuilt.draft?.answeredSummaries).toEqual(rebuilt.answeredSummaries);
      const revised = await scenario.backend.inspectDrafts();
      expect(revised.revisions).toHaveLength(2);
      expect(revised.revisions[0]).toEqual(stored.revisions[0]);
      expect(revised.revisions[1]).toMatchObject({ revision_number: 2, parent_revision_number: 1 });
      await expect(
        scenario.page.getByRole("heading", { name: "Changed answers", exact: true }),
      ).toHaveCount(0);
      await capture(scenario, "rebuilt");
      await relaunch(scenario, playwright);
      expect(await card(scenario.backend)).toEqual(rebuilt);
      expect(await scenario.backend.inspectDrafts()).toEqual(revised);
      expect(await scenario.backend.inspectUnrelated()).toEqual(unrelated);
      await expect(
        scenario.page.getByRole("button", { name: "Activate Plan", exact: true }),
      ).toBeEnabled();
      await capture(scenario, "restored");
    } finally {
      await close(scenario);
    }
  });
}

test("preserves the earlier Draft when changed limits leave no Workouts", async ({
  playwright,
}) => {
  const scenario = await launch(playwright, { width: 1180, colorScheme: "light" });
  try {
    await completeFitness(scenario);
    const original = await build(scenario);
    const stored = await scenario.backend.inspectDrafts();
    await scenario.page.getByRole("button", { name: "Edit answers", exact: true }).click();
    await scenario.page
      .getByRole("button", { name: "Edit Training Restriction", exact: true })
      .click();
    await scenario.page.locator('[data-answer="no-training"]').click();
    await continueAnswer(scenario);
    await scenario.page.getByRole("button", { name: "Rebuild Draft", exact: true }).click();
    await expect(
      scenario.page.getByText(
        "No Workouts fit anywhere in this Plan under your confirmed limits. Edit those limits to continue.",
        { exact: true },
      ),
    ).toBeVisible();
    expect((await card(scenario.backend)).draft).toEqual(original.draft);
    expect((await card(scenario.backend)).draftStale).toBe(true);
    expect((await scenario.backend.inspectDrafts()).revisions).toEqual(stored.revisions);
    await expect(
      scenario.page.getByRole("heading", { name: "Every week and Workout", exact: true }),
    ).toBeVisible();
    await capture(scenario, "no-workouts");
  } finally {
    await close(scenario);
  }
});
