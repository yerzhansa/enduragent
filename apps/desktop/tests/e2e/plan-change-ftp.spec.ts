import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser, type Page, type PlaywrightWorkerArgs } from "@playwright/test";
import {
  PlanChangePreviewRpcParamsSchema,
  PlanChangeWorkoutSchema,
  PlanCreationDraftSchema,
} from "@enduragent/coach-contract";
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
  return scenario.page.getByRole("region", { name: "Plan Changes", exact: true });
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

for (const appearance of appearances) {
  test(`corrects FTP and restores power with Undo at ${appearance.width} in ${appearance.colorScheme}`, async ({
    playwright,
  }) => {
    test.setTimeout(120_000);
    const scenario = await launch(playwright, appearance);
    try {
      const initial = await scenario.backend.inspectActivation();
      expect(storedWorkouts(initial).every((workout) => workout.power === null)).toBe(true);
      await scenario.page
        .getByRole("navigation", { name: "Main navigation" })
        .getByRole("button", { name: "Plan", exact: true })
        .click();
      await scenario.page
        .getByRole("region", { name: "Plan library", exact: true })
        .getByRole("button", { name: "Change in Chat", exact: true })
        .click();
      await changes(scenario)
        .getByRole("button", { name: "Change one thing", exact: true })
        .click();
      const editor = changes(scenario).getByRole("region", {
        name: "What needs to change?",
        exact: true,
      });
      await editor.getByRole("combobox", { name: "Change", exact: true }).click();
      await scenario.page.getByRole("option", { name: changeTitle, exact: true }).click();
      const watts = editor.getByRole("spinbutton", { name: "FTP in watts", exact: true });
      await expect(watts).toHaveValue("220");
      await expect(watts).toHaveAttribute("step", "1");
      await capture(scenario, "editor");
      await editor.getByRole("button", { name: "Preview change", exact: true }).click();
      const pending = changeCard(scenario, changeTitle, "Pending");
      await expect(pending.getByRole("heading")).toBeFocused();
      const request = [...scenario.backend.creationRequests]
        .reverse()
        .find((entry) => entry.method === "plan_change.preview");
      expect(PlanChangePreviewRpcParamsSchema.parse(request?.params)).toMatchObject({
        planId: scenario.seed.planId,
        expectedVersion: 1,
        intent: { kind: "ftp", watts: 220 },
      });
      const preview = (await scenario.backend.library()).changes.find(
        (change) => change.status === "pending",
      );
      if (!preview) throw new TypeError("FTP preview is unavailable");
      expect(preview.diff).toHaveLength(12);
      expect(
        preview.diff.every((row) => row.before?.power === null && row.after?.power === 220),
      ).toBe(true);
      const difference = pending.getByRole("table", {
        name: "Affected individual Workouts",
        exact: true,
      });
      await expect(difference.getByRole("cell")).toHaveText(
        preview.diff.map(() => / → .* · \d+ min · 220 W$/),
      );
      expect((await scenario.backend.inspectActivation()).revisions).toEqual(initial.revisions);
      await capture(scenario, "preview");
      await pending.getByRole("button", { name: "View evidence", exact: true }).click();
      const evidence = changes(scenario).getByRole("region", {
        name: "Source details",
        exact: true,
      });
      await expect(evidence.getByRole("heading")).toBeFocused();
      await expect(
        evidence.getByRole("rowheader").filter({
          hasText: "Saved profile and synchronized FTP evidence",
        }),
      ).toBeVisible();
      await expect(
        evidence.getByRole("listitem").filter({ hasText: "Intervals.icu FTP" }),
      ).toHaveText(/Intervals\.icu FTP.*210 W.*selected/i);
      await expect(evidence.getByRole("listitem").filter({ hasText: "Your entry" })).toHaveText(
        /Your entry.*220 W/,
      );
      await capture(scenario, "evidence");
      await evidence.getByRole("button", { name: "Back", exact: true }).click();
      await pending.getByRole("button", { name: "Apply to Plan", exact: true }).click();
      await expect(changes(scenario).getByRole("status")).toHaveText(
        "Change applied locally. Training now matches the confirmed preview.",
      );
      const applied = changeCard(scenario, changeTitle, "Applied");
      await expect(applied.getByRole("button", { name: "Undo", exact: true })).toBeVisible();
      const corrected = await scenario.backend.inspectActivation();
      expect(corrected.planningPlans[0]).toMatchObject({ version: 2, current_revision_number: 2 });
      expect(corrected.revisions).toHaveLength(2);
      expect(corrected.revisions[1]).toMatchObject({
        revision_number: 2,
        parent_revision_number: 1,
        source_kind: "plan-change",
        source_id: preview.changeId,
      });
      const correctedDraft = PlanCreationDraftSchema.parse(
        JSON.parse(String(corrected.revisions[1]?.snapshot_json)),
      );
      expect(correctedDraft.ftp).toBe(220);
      expect(
        correctedDraft.weeks.flatMap((week) => week.workouts).map((workout) => workout.power),
      ).toEqual(Array.from({ length: 12 }, () => 220));
      expect(storedWorkouts(corrected)).toEqual(
        storedWorkouts(initial).map((workout) => ({
          ...workout,
          power: 220,
          guidance: "Use your confirmed FTP of 220 W",
        })),
      );
      await capture(scenario, "applied");
      await applied.getByRole("button", { name: "Undo", exact: true }).click();
      const inverse = changeCard(scenario, inverseTitle, "Pending");
      await expect(inverse.getByRole("heading")).toBeFocused();
      await expect(
        inverse
          .getByRole("table", { name: "Affected individual Workouts", exact: true })
          .getByRole("cell"),
      ).toHaveText(preview.diff.map(() => / · 220 W → .* · \d+ min/));
      await capture(scenario, "undo-preview");
      await inverse.getByRole("button", { name: "Apply to Plan", exact: true }).click();
      await expect(changeCard(scenario, inverseTitle, "Applied")).toBeVisible();
      const restored = await scenario.backend.inspectActivation();
      expect(restored.planningPlans[0]).toMatchObject({ version: 3, current_revision_number: 3 });
      expect(restored.revisions).toHaveLength(3);
      const restoredDraft = PlanCreationDraftSchema.parse(
        JSON.parse(String(restored.revisions[2]?.snapshot_json)),
      );
      expect(restoredDraft.ftp).toBeNull();
      expect(restoredDraft.weeks).toEqual(scenario.seed.draft.weeks);
      expect(storedWorkouts(restored)).toEqual(storedWorkouts(initial));
      await expect(
        changes(scenario).getByRole("button", { name: "Undo", exact: true }),
      ).toHaveCount(0);
      await capture(scenario, "restored");
    } finally {
      await close(scenario);
    }
  });
}
