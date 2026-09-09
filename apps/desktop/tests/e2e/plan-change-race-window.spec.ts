import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser, type Page, type PlaywrightWorkerArgs } from "@playwright/test";
import {
  PlanChangePreviewRpcParamsSchema,
  PlanChangeWorkoutSchema,
} from "@enduragent/coach-contract";
import { launchDesktopFixture, type RunningDesktopFixture } from "../helpers/desktop-fixture.js";
import { PlanCreationBackend } from "../helpers/plan-creation-backend.js";

const token = "d".repeat(43);
const previews = fileURLToPath(new URL("./previews/plan-change-race-window/", import.meta.url));

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
  const scratch = await mkdtemp(join(tmpdir(), "plan-change-race-window-"));
  const backend = new PlanCreationBackend(join(scratch, "store.db"), false, true);
  let fixture: RunningDesktopFixture | undefined;
  try {
    await backend.open();
    const seed = await backend.seedActiveTraining({ goal: "event" });
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

const appearances = [
  { width: 1180, colorScheme: "light" },
  { width: 1180, colorScheme: "dark" },
  { width: 720, colorScheme: "light" },
  { width: 720, colorScheme: "dark" },
] as const;
const changeTitle = "Limit weekday duration";
const refusalNotice =
  "Only training reductions are allowed during this race window. Training is unchanged.";

for (const appearance of appearances) {
  test(`allows a race-window reduction and refuses its Undo at ${appearance.width} in ${appearance.colorScheme}`, async ({
    playwright,
  }) => {
    test.setTimeout(120_000);
    const scenario = await launch(playwright, appearance);
    try {
      expect(scenario.seed.draft.goal).toMatchObject({ kind: "event", date: "1998-01-07" });
      const initial = await scenario.backend.inspectActivation();
      await scenario.page
        .getByRole("navigation", { name: "Main navigation" })
        .getByRole("button", { name: "Plan", exact: true })
        .click();
      await scenario.page
        .getByRole("region", { name: "Plan library", exact: true })
        .getByRole("button", { name: "Change in Chat", exact: true })
        .click();
      const changes = scenario.page.getByRole("region", { name: "Plan Changes", exact: true });
      await changes.getByRole("button", { name: "Change one thing", exact: true }).click();
      const editor = changes.getByRole("region", { name: "What needs to change?", exact: true });
      await expect(editor.getByRole("combobox", { name: "Change", exact: true })).toContainText(
        "Weekday duration cap",
      );
      await editor.getByRole("combobox", { name: "Weekday", exact: true }).click();
      await scenario.page.getByRole("option", { name: "Mon", exact: true }).click();
      await expect(
        editor.getByRole("spinbutton", { name: "Duration limit in minutes", exact: true }),
      ).toHaveValue("30");
      await editor.getByRole("button", { name: "Preview change", exact: true }).click();
      const changeCard = changes.getByRole("region", { name: changeTitle, exact: true });
      await expect(changeCard.getByRole("heading")).toBeFocused();
      await expect(changeCard.getByText("Pending", { exact: true })).toBeVisible();
      const previewed = (await scenario.backend.library()).changes.find(
        (change) => change.status === "pending",
      );
      if (!previewed) throw new TypeError("Reducing Change preview is unavailable");
      expect(previewed.intent).toEqual({ kind: "weekday-duration", day: 1, minutes: 30 });
      expect(previewed.diff.length).toBeGreaterThan(0);
      for (const row of previewed.diff) {
        expect(row.before?.minutes).toBe(60);
        expect(row.after?.minutes).toBe(30);
        expect(row.after?.date).toBe("1998-01-05");
      }
      const beforeApply = await scenario.backend.inspectActivation();
      expect(beforeApply.workouts).toEqual(initial.workouts);
      expect(beforeApply.revisions).toEqual(initial.revisions);
      await capture(scenario, "reducing-preview");
      await changeCard.getByRole("button", { name: "Apply to Plan", exact: true }).click();
      await expect(changes.getByRole("status")).toHaveText(
        "Change applied locally. Training now matches the confirmed preview.",
      );
      await expect(changeCard.getByText("Applied", { exact: true })).toBeVisible();
      const applied = (await scenario.backend.library()).changes.find(
        (change) => change.changeId === previewed.changeId,
      );
      expect(applied).toMatchObject({ status: "applied", undo: { eligible: true } });
      const reduced = await scenario.backend.inspectActivation();
      expect(reduced.planningPlans[0]).toMatchObject({ version: 2, current_revision_number: 2 });
      expect(reduced.revisions).toHaveLength(2);
      const reducedWorkouts = reduced.workouts.map((row) =>
        PlanChangeWorkoutSchema.parse(JSON.parse(String(row.structure_json))),
      );
      expect(reducedWorkouts.find((workout) => workout.date === "1998-01-05")).toMatchObject({
        name: "Endurance ride",
        minutes: 30,
      });
      await capture(scenario, "reduction-applied");
      const requestsBefore = scenario.backend.creationRequests.length;
      const libraryReadsBefore = scenario.backend.planListRequests.length;
      await changeCard.getByRole("button", { name: "Undo", exact: true }).click();
      await expect(changes.getByRole("status")).toHaveText(refusalNotice);
      await expect(scenario.page.getByRole("alert")).toHaveCount(0);
      await expect(changes.getByText("Pending", { exact: true })).toHaveCount(0);
      await expect(changeCard.getByText("Applied", { exact: true })).toBeVisible();
      await expect(changeCard.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
      await expect
        .poll(() => scenario.backend.planListRequests.length)
        .toBeGreaterThan(libraryReadsBefore);
      const requests = scenario.backend.creationRequests.slice(requestsBefore);
      expect(requests.map((request) => request.method)).toEqual(["plan_change.preview"]);
      expect(PlanChangePreviewRpcParamsSchema.parse(requests[0]?.params)).toEqual({
        commandId: expect.any(String),
        planId: scenario.seed.planId,
        expectedVersion: 2,
        intent: { kind: "inverse", changeId: previewed.changeId },
      });
      const refused = await scenario.backend.inspectActivation();
      expect(refused.plans).toEqual(reduced.plans);
      expect(refused.planningPlans).toEqual(reduced.planningPlans);
      expect(refused.revisions).toEqual(reduced.revisions);
      expect(refused.workouts).toEqual(reduced.workouts);
      expect(refused.changes).toEqual(reduced.changes);
      await capture(scenario, "undo-refused");
    } finally {
      await close(scenario);
    }
  });
}
