import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser, type Page, type PlaywrightWorkerArgs } from "@playwright/test";
import { PlanChangeWorkoutSchema, PlanCreationDraftSchema } from "@enduragent/coach-contract";
import { launchDesktopFixture, type RunningDesktopFixture } from "../helpers/desktop-fixture.js";
import { PlanCreationBackend } from "../helpers/plan-creation-backend.js";

const token = "d".repeat(43);
const previews = fileURLToPath(new URL("./previews/plan-change-ftp/", import.meta.url));

interface Scenario {
  readonly backend: PlanCreationBackend;
  readonly fixture: RunningDesktopFixture;
  readonly scratch: string;
  readonly colorScheme: "light" | "dark";
  readonly width: number;
  readonly seed: Awaited<ReturnType<PlanCreationBackend["seedActiveTraining"]>>;
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
  if (page === undefined) throw new TypeError("Plan Change renderer is unavailable");
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
  const scratch = await mkdtemp(join(tmpdir(), "plan-change-ftp-"));
  const backend = new PlanCreationBackend(join(scratch, "store.db"), false, true);
  let fixture: RunningDesktopFixture | undefined;
  try {
    await backend.open();
    const seed = await backend.seedActiveTraining();
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
    return { backend, fixture, scratch, seed, ...appearance, ...connected };
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

async function capture(scenario: Scenario, name: string): Promise<void> {
  await mkdir(previews, { recursive: true });
  const screenshotPath = join(previews, `${name}-${scenario.width}-${scenario.colorScheme}.png`);
  await scenario.page.screenshot({ path: screenshotPath });
  await test.info().attach(`${name}-screenshot`, {
    path: screenshotPath,
    contentType: "image/png",
  });
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
    await test.info().attach("stored-plan-change", {
      body: JSON.stringify({
        card: await scenario.backend.card(),
        activation: await scenario.backend.inspectActivation(),
        requests: scenario.backend.creationRequests,
        seed: scenario.seed,
        library: await scenario.backend.library(),
        responses: scenario.backend.changeApplyResponses,
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

type Stored = Awaited<ReturnType<PlanCreationBackend["inspectActivation"]>>;

const appearances = [
  { width: 1180, colorScheme: "light" },
  { width: 1180, colorScheme: "dark" },
  { width: 720, colorScheme: "light" },
  { width: 720, colorScheme: "dark" },
] as const;
const changeTitle = "Correct FTP";
const inverseTitle = "Undo the latest Change";

function changes(scenario: Scenario) {
  return scenario.page.locator('[data-conversation-projection^="plan-change"]');
}

function changeCard(scenario: Scenario, title: string, status: string) {
  return changes(scenario)
    .getByRole("region", { name: title, exact: true })
    .filter({ has: scenario.page.getByText(status, { exact: true }) });
}

function storedWorkouts(stored: Stored) {
  return stored.workouts.map((row) =>
    PlanChangeWorkoutSchema.parse(JSON.parse(String(row.structure_json))),
  );
}

const ftpElsewhere =
  "To change your FTP, set it in intervals.icu, or use FTP history in Activity review.";

for (const appearance of appearances) {
  test(`offers no Correct FTP and keeps a past FTP change undoable at ${appearance.width} in ${appearance.colorScheme}`, async ({
    playwright,
  }) => {
    test.setTimeout(120_000);
    const scenario = await launch(playwright, appearance);
    try {
      const initial = await scenario.backend.inspectActivation();
      expect(storedWorkouts(initial).every((workout) => workout.power === null)).toBe(true);
      const past = await scenario.backend.seedPastFtpChange(scenario.seed.planId, 220);
      const pastDiff =
        (await scenario.backend.library()).changes.find(
          (change) => change.changeId === past.changeId,
        )?.diff ?? [];
      expect(pastDiff.length).toBeGreaterThan(0);
      await scenario.page
        .getByRole("navigation", { name: "Main navigation" })
        .getByRole("button", { name: "Plan", exact: true })
        .click();
      const library = scenario.page.getByRole("region", { name: "Plan library", exact: true });
      await library.getByRole("button", { name: "Read Plan details", exact: true }).click();
      await expect(scenario.page.getByRole("heading", { level: 1, name: "Plan" })).toBeVisible();
      await expect(scenario.page.getByText(/confirmed FTP/u)).toHaveCount(0);
      await capture(scenario, "plan-details");
      await library.getByRole("button", { name: "Change one thing", exact: true }).click();
      const applied = changeCard(scenario, changeTitle, "Applied");
      await expect(applied.getByRole("button", { name: "Undo", exact: true })).toBeVisible();
      const editor = changes(scenario).getByRole("region", {
        name: "What needs to change?",
        exact: true,
      });
      await expect(editor).toContainText(ftpElsewhere);
      await capture(scenario, "editor-note");
      await editor.getByRole("combobox", { name: "Change", exact: true }).click();
      const options = scenario.page.getByRole("option");
      await expect(options).toHaveText([
        "Weekday duration cap",
        "Weekday unavailable",
        "No hard training on a weekday",
        "Weekly duration cap",
        "Longest-Workout cap",
        "Supporting Event",
      ]);
      await expect(scenario.page.getByRole("option", { name: changeTitle })).toHaveCount(0);
      await capture(scenario, "editor");
      await scenario.page.keyboard.press("Escape");
      await editor.getByRole("button", { name: "Back", exact: true }).click();
      await applied.getByRole("button", { name: "Undo", exact: true }).click();
      const inverse = changeCard(scenario, inverseTitle, "Pending");
      await expect(inverse.getByRole("heading")).toBeFocused();
      await expect(
        inverse
          .getByRole("table", { name: "Affected individual Workouts", exact: true })
          .getByRole("cell"),
      ).toHaveText(pastDiff.map(() => / · 220 W → .* · \d+ min/));
      await capture(scenario, "undo-preview");
      await inverse.getByRole("button", { name: "Apply to Plan", exact: true }).click();
      await expect(changeCard(scenario, inverseTitle, "Applied")).toBeVisible();
      const restored = await scenario.backend.inspectActivation();
      expect(restored.planningPlans[0]).toMatchObject({ version: 3, current_revision_number: 3 });
      const restoredDraft = PlanCreationDraftSchema.parse(
        JSON.parse(String(restored.revisions[2]?.snapshot_json)),
      );
      expect(restoredDraft.ftp).toBeNull();
      expect(restoredDraft.weeks).toEqual(scenario.seed.draft.weeks);
      expect(storedWorkouts(restored)).toEqual(storedWorkouts(initial));
      await capture(scenario, "restored");
    } finally {
      await close(scenario);
    }
  });
}
