import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser, type Page, type PlaywrightWorkerArgs } from "@playwright/test";
import {
  PlanChangePreviewRpcParamsSchema,
  PlanChangeWorkoutSchema,
  PlanCreationDraftSchema,
  type PlanChangeModel,
} from "@enduragent/coach-contract";
import { launchDesktopFixture, type RunningDesktopFixture } from "../helpers/desktop-fixture.js";
import { PlanCreationBackend } from "../helpers/plan-creation-backend.js";

const token = "d".repeat(43);
const previews = fileURLToPath(new URL("./previews/plan-change-undo/", import.meta.url));

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
  const scratch = await mkdtemp(join(tmpdir(), "plan-change-undo-"));
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

async function relaunch(scenario: Scenario, playwright: Playwright): Promise<void> {
  await scenario.browser.close();
  await scenario.fixture.relaunch(() => scenario.backend.reopen());
  await scenario.fixture.setViewport(scenario.width, 820);
  Object.assign(scenario, await connect(playwright, scenario.fixture, scenario.colorScheme));
  expect(await scenario.page.evaluate(() => innerWidth)).toBe(scenario.width);
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
const changeTitle = "Limit weekday duration";
const inverseTitle = "Undo the latest Change";
const inverseSummary =
  "Restore the previewed future training. Completed and past training stays unchanged.";

function changes(scenario: Scenario) {
  return scenario.page.getByRole("region", { name: "Plan Changes", exact: true });
}

function changeCard(scenario: Scenario, title: string, status: string) {
  return changes(scenario)
    .getByRole("region", { name: title, exact: true })
    .filter({ has: scenario.page.getByText(status, { exact: true }) });
}

function training(stored: Stored) {
  return {
    plans: stored.plans,
    planningPlans: stored.planningPlans,
    revisions: stored.revisions,
    workouts: stored.workouts,
    creations: stored.creations,
  };
}

async function applyDurationChange(scenario: Scenario) {
  await scenario.page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Plan", exact: true })
    .click();
  await scenario.page
    .getByRole("region", { name: "Plan library", exact: true })
    .getByRole("button", { name: "Change in Chat", exact: true })
    .click();
  await expect(changes(scenario)).toBeVisible();
  await expect(changes(scenario).getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);
  await changes(scenario).getByRole("button", { name: "Change one thing", exact: true }).click();
  const editor = changes(scenario).getByRole("region", {
    name: "What needs to change?",
    exact: true,
  });
  await expect(editor.getByRole("combobox", { name: "Change", exact: true })).toContainText(
    "Weekday duration cap",
  );
  await expect(editor.getByRole("combobox", { name: "Weekday", exact: true })).toContainText("Wed");
  await expect(
    editor.getByRole("spinbutton", { name: "Duration limit in minutes", exact: true }),
  ).toHaveValue("30");
  await editor.getByRole("button", { name: "Preview change", exact: true }).click();
  const pending = changeCard(scenario, changeTitle, "Pending");
  await expect(pending.getByRole("heading")).toBeFocused();
  await pending.getByRole("button", { name: "Apply to Plan", exact: true }).click();
  await expect(changes(scenario).getByRole("status")).toHaveText(
    "Change applied locally. Training now matches the confirmed preview.",
  );
  const applied = (await scenario.backend.library()).changes.find(
    (change) => change.status === "applied",
  );
  if (!applied) throw new TypeError("Applied Change is unavailable");
  expect(applied).toMatchObject({
    title: changeTitle,
    intent: { kind: "weekday-duration", day: 3, minutes: 30 },
    undo: { eligible: true },
  });
  await expect(changeCard(scenario, changeTitle, "Applied").getByRole("button")).toHaveText([
    "Read historical evidence",
    "Undo",
    "Read this difference",
  ]);
  await expect(changes(scenario).getByRole("button", { name: "Undo", exact: true })).toHaveCount(1);
  const stored = await scenario.backend.inspectActivation();
  expect(stored.planningPlans[0]).toMatchObject({ version: 2, current_revision_number: 2 });
  expect(stored.revisions).toHaveLength(2);
  expect(stored.revisions[1]).toMatchObject({
    revision_number: 2,
    parent_revision_number: 1,
    source_kind: "plan-change",
    source_id: applied.changeId,
  });
  const workouts = stored.workouts.map((row) =>
    PlanChangeWorkoutSchema.parse(JSON.parse(String(row.structure_json))),
  );
  expect(
    workouts.filter((workout) => workout.name === "Long ride").map((workout) => workout.minutes),
  ).toEqual([30, 30, 30, 30]);
  return applied;
}

async function previewUndo(scenario: Scenario, applied: PlanChangeModel) {
  const requestsBefore = scenario.backend.creationRequests.length;
  await changeCard(scenario, applied.title, "Applied")
    .getByRole("button", { name: "Undo", exact: true })
    .click();
  const pending = changeCard(scenario, inverseTitle, "Pending");
  await expect(pending.getByRole("heading", { name: inverseTitle, exact: true })).toBeFocused();
  await expect(pending.getByText(inverseSummary, { exact: true })).toBeVisible();
  await expect(pending.getByRole("button")).toHaveText([
    "View evidence",
    "Cancel",
    "Apply to Plan",
  ]);
  const requests = scenario.backend.creationRequests
    .slice(requestsBefore)
    .filter((request) => request.method === "plan_change.preview");
  expect(requests).toHaveLength(1);
  const params = PlanChangePreviewRpcParamsSchema.parse(requests[0]?.params);
  expect(params).toEqual({
    commandId: expect.any(String),
    planId: scenario.seed.planId,
    expectedVersion: 2,
    intent: { kind: "inverse", changeId: applied.changeId },
  });
  const inverse = (await scenario.backend.library()).changes.find(
    (change) => change.status === "pending",
  );
  if (!inverse) throw new TypeError("Pending inverse is unavailable");
  expect(inverse).toMatchObject({
    title: inverseTitle,
    intent: { kind: "inverse", changeId: applied.changeId },
    baseRevisionNumber: 2,
    undo: null,
  });
  expect(inverse.diff).toHaveLength(4);
  expect(inverse.diff.map((row) => row.before?.minutes)).toEqual([30, 30, 30, 30]);
  expect(inverse.diff.map((row) => row.after?.minutes)).toEqual([100, 100, 100, 100]);
  for (const row of inverse.diff) expect(row.after?.id).toBe(row.before?.id);
  return { inverse, commandId: params.commandId };
}

async function assertRestored(scenario: Scenario, initial: Stored, inverse: PlanChangeModel) {
  await expect(changes(scenario).getByRole("status")).toHaveText(
    "Change applied locally. Training now matches the confirmed preview.",
  );
  await expect(changeCard(scenario, inverseTitle, "Applied")).toBeVisible();
  await expect(changeCard(scenario, inverseTitle, "Pending")).toHaveCount(0);
  await expect(changes(scenario).getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);
  const restored = await scenario.backend.inspectActivation();
  expect(restored.planningPlans[0]).toMatchObject({ version: 3, current_revision_number: 3 });
  expect(restored.revisions).toHaveLength(3);
  expect(restored.revisions[0]).toEqual(initial.revisions[0]);
  expect(restored.revisions[2]).toMatchObject({
    revision_number: 3,
    parent_revision_number: 2,
    source_kind: "plan-change",
    source_id: inverse.changeId,
  });
  expect(
    PlanCreationDraftSchema.parse(JSON.parse(String(restored.revisions[2]?.snapshot_json))).weeks,
  ).toEqual(scenario.seed.draft.weeks);
  expect(restored.workouts.map((row) => row.id)).toEqual(initial.workouts.map((row) => row.id));
  expect(restored.workouts).toHaveLength(12);
  for (const original of initial.workouts) {
    const workout = restored.workouts.find((row) => row.id === original.id);
    expect(workout).toMatchObject({
      ...original,
      hlc_physical_ms: expect.any(Number),
    });
  }
  expect(
    restored.workouts.map((row) =>
      PlanChangeWorkoutSchema.parse(JSON.parse(String(row.structure_json))),
    ),
  ).toEqual(scenario.seed.draft.weeks.flatMap((week) => week.workouts));
  const library = await scenario.backend.library();
  expect(library.changes.find((change) => change.changeId === inverse.changeId)).toMatchObject({
    status: "applied",
    undo: { eligible: false, reason: "inverse" },
  });
  expect(library.changes.filter((change) => change.undo?.eligible)).toHaveLength(0);
}

for (const appearance of appearances) {
  test(`cancels, restores and persists Undo at ${appearance.width} in ${appearance.colorScheme}`, async ({
    playwright,
  }) => {
    test.setTimeout(120_000);
    const scenario = await launch(playwright, appearance);
    try {
      const initial = await scenario.backend.inspectActivation();
      const applied = await applyDurationChange(scenario);
      const changed = await scenario.backend.inspectActivation();
      await capture(scenario, "eligible-history");
      const first = await previewUndo(scenario, applied);
      expect(training(await scenario.backend.inspectActivation())).toEqual(training(changed));
      await changeCard(scenario, inverseTitle, "Pending")
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      await expect(changes(scenario).getByRole("status")).toHaveText(
        "Change cancelled. Training is unchanged; the preview remains in history.",
      );
      await expect(changeCard(scenario, inverseTitle, "Cancelled")).toBeVisible();
      await expect(changeCard(scenario, inverseTitle, "Cancelled").getByRole("button")).toHaveText([
        "Read historical evidence",
        "Read this difference",
      ]);
      const cancelled = await scenario.backend.inspectActivation();
      expect(training(cancelled)).toEqual(training(changed));
      expect(cancelled.planningPlans[0]).toMatchObject({ version: 2, current_revision_number: 2 });
      await expect(
        changes(scenario).getByRole("button", { name: "Undo", exact: true }),
      ).toHaveCount(1);
      await capture(scenario, "cancelled-inverse");
      const second = await previewUndo(scenario, applied);
      expect(second.commandId).not.toBe(first.commandId);
      expect(second.inverse.changeId).not.toBe(first.inverse.changeId);
      const pendingCard = changeCard(scenario, inverseTitle, "Pending");
      await pendingCard.getByRole("button", { name: "View evidence", exact: true }).click();
      const evidence = changes(scenario).getByRole("region", {
        name: "Source details",
        exact: true,
      });
      await expect(evidence.getByRole("heading")).toBeFocused();
      await expect(evidence.getByRole("cell", { name: applied.title, exact: true })).toBeVisible();
      await capture(scenario, "inverse-evidence");
      await evidence.getByRole("button", { name: "Back", exact: true }).click();
      await expect(
        pendingCard.getByRole("button", { name: "View evidence", exact: true }),
      ).toBeFocused();
      await pendingCard.getByRole("heading").scrollIntoViewIfNeeded();
      await capture(scenario, "pending-inverse");
      const beforeRelaunch = await scenario.backend.inspectActivation();
      await relaunch(scenario, playwright);
      const persisted = changeCard(scenario, inverseTitle, "Pending");
      await expect(persisted.getByText(inverseSummary, { exact: true })).toBeVisible();
      expect(
        (await scenario.backend.library()).changes.find((change) => change.status === "pending"),
      ).toEqual(second.inverse);
      expect(await scenario.backend.inspectActivation()).toEqual(beforeRelaunch);
      await persisted.getByRole("heading").scrollIntoViewIfNeeded();
      await capture(scenario, "relaunched-inverse");
      await persisted
        .getByRole("button", { name: "Apply to Plan", exact: true })
        .scrollIntoViewIfNeeded();
      await capture(scenario, "inverse-actions");
      await persisted.getByRole("button", { name: "Apply to Plan", exact: true }).click();
      await assertRestored(scenario, initial, second.inverse);
      await capture(scenario, "restored-training");
    } finally {
      await close(scenario);
    }
  });
}
