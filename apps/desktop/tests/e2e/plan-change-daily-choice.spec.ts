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
const previews = fileURLToPath(new URL("./previews/plan-change-daily-choice/", import.meta.url));

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
  const scratch = await mkdtemp(join(tmpdir(), "plan-change-daily-choice-"));
  const backend = new PlanCreationBackend(join(scratch, "store.db"), false, true);
  let fixture: RunningDesktopFixture | undefined;
  try {
    await backend.open();
    const seed = await backend.seedActiveTraining({ mode: "flexible" });
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
const choiceTitle = "Choose a Workout for today";
const inverseTitle = "Undo the latest Change";
const occupiedReason = "Today already belongs to a dated Workout.";

function changes(scenario: Scenario) {
  return scenario.page.getByRole("region", { name: "Plan Changes", exact: true });
}

function todayCard(scenario: Scenario) {
  return changes(scenario).getByRole("region", {
    name: "Choose one eligible Workout",
    exact: true,
  });
}

function changeCard(scenario: Scenario, title: string, status: string) {
  return changes(scenario)
    .getByRole("region", { name: title, exact: true })
    .filter({ has: scenario.page.getByText(status, { exact: true }) });
}

for (const appearance of appearances) {
  test(`chooses today's Workout and restores its undated state at ${appearance.width} in ${appearance.colorScheme}`, async ({
    playwright,
  }) => {
    test.setTimeout(120_000);
    const scenario = await launch(playwright, appearance);
    try {
      const initial = await scenario.backend.inspectActivation();
      const library = await scenario.backend.library();
      const choice = library.active?.todayChoice;
      const selected = choice?.eligible[0];
      if (!choice || !selected || !scenario.seed.planId)
        throw new TypeError("Flexible Plan daily choice is unavailable");
      expect(choice.eligible.length).toBeGreaterThan(1);
      expect(initial.workouts).toHaveLength(0);
      await scenario.page
        .getByRole("navigation", { name: "Main navigation" })
        .getByRole("button", { name: "Plan", exact: true })
        .click();
      await scenario.page
        .getByRole("region", { name: "Plan library", exact: true })
        .getByRole("button", { name: "Change in Chat", exact: true })
        .click();
      const today = todayCard(scenario);
      await expect(today.getByText("Today", { exact: true })).toBeVisible();
      for (const workout of choice.eligible) {
        await expect(
          today.getByText(`${workout.name} · ${workout.minutes} min`, { exact: true }),
        ).toBeVisible();
        await expect(
          today.getByRole("button", { name: `Review ${workout.name}`, exact: true }),
        ).toBeEnabled();
      }
      await capture(scenario, "eligible-workouts");
      await today.getByRole("button", { name: `Review ${selected.name}`, exact: true }).click();
      const pending = changeCard(scenario, choiceTitle, "Pending");
      await expect(pending.getByRole("heading", { name: choiceTitle, exact: true })).toBeFocused();
      await expect(
        pending.getByText("Only this Workout will receive today’s date after confirmation.", {
          exact: true,
        }),
      ).toBeVisible();
      const previewRequests = scenario.backend.creationRequests.filter(
        (request) => request.method === "plan_change.preview",
      );
      expect(previewRequests).toHaveLength(1);
      expect(PlanChangePreviewRpcParamsSchema.parse(previewRequests[0]?.params)).toMatchObject({
        planId: scenario.seed.planId,
        expectedVersion: 1,
        intent: { kind: "choose-workout", workoutId: selected.workoutId },
      });
      const preview = (await scenario.backend.library()).changes.find(
        (change) => change.status === "pending",
      );
      expect(preview?.diff).toHaveLength(1);
      expect(preview?.diff[0]).toMatchObject({
        before: { id: selected.workoutId, date: null },
        after: { id: selected.workoutId, date: choice.date },
      });
      expect((await scenario.backend.inspectActivation()).workouts).toEqual(initial.workouts);
      await pending.scrollIntoViewIfNeeded();
      await capture(scenario, "pending-choice");
      await pending.getByRole("button", { name: "Apply to Plan", exact: true }).click();
      await expect(changeCard(scenario, choiceTitle, "Applied")).toBeVisible();
      await expect(changes(scenario).getByRole("status")).toHaveText(
        "Change applied locally. Training now matches the confirmed preview.",
      );
      const applied = await scenario.backend.inspectActivation();
      const afterDraft = PlanCreationDraftSchema.parse(
        JSON.parse(String(applied.revisions[1]?.snapshot_json)),
      );
      expect(afterDraft.weeks).toEqual(
        scenario.seed.draft.weeks.map((week) => ({
          ...week,
          workouts: week.workouts.map((workout) =>
            workout.id === selected.workoutId ? { ...workout, date: choice.date } : workout,
          ),
        })),
      );
      expect(applied.workouts).toHaveLength(1);
      expect(applied.workouts[0]).toMatchObject({
        date_key: Number(choice.date.replaceAll("-", "")),
      });
      expect(
        PlanChangeWorkoutSchema.parse(JSON.parse(String(applied.workouts[0]?.structure_json))),
      ).toEqual(preview?.diff[0]?.after);
      expect(applied.planningPlans[0]).toMatchObject({ version: 2, current_revision_number: 2 });
      const blocked = (await scenario.backend.library()).active?.todayChoice;
      expect(blocked?.eligible).toEqual([]);
      expect(blocked?.reason).toBe(occupiedReason);
      expect(blocked?.blocked).toHaveLength(choice.eligible.length - 1);
      await expect(today.getByRole("button")).toHaveCount(0);
      await expect(today.getByText(occupiedReason, { exact: true })).toHaveCount(
        choice.eligible.length,
      );
      for (const workout of blocked?.blocked ?? []) {
        await expect(today.getByText(workout.name, { exact: true })).toBeVisible();
        expect(workout.reason).toBe(occupiedReason);
      }
      await today.getByRole("heading").scrollIntoViewIfNeeded();
      await capture(scenario, "blocked-workouts");
      await changeCard(scenario, choiceTitle, "Applied")
        .getByRole("button", { name: "Undo", exact: true })
        .click();
      const inverse = changeCard(scenario, inverseTitle, "Pending");
      await expect(inverse.getByRole("heading")).toBeFocused();
      const inversePreview = (await scenario.backend.library()).changes.find(
        (change) => change.status === "pending",
      );
      expect(inversePreview?.diff).toHaveLength(1);
      expect(inversePreview?.diff[0]).toMatchObject({
        before: { id: selected.workoutId, date: choice.date },
        after: { id: selected.workoutId, date: null },
      });
      await inverse.scrollIntoViewIfNeeded();
      await capture(scenario, "pending-undo");
      await inverse.getByRole("button", { name: "Apply to Plan", exact: true }).click();
      await expect(changeCard(scenario, inverseTitle, "Applied")).toBeVisible();
      const restored = await scenario.backend.inspectActivation();
      expect(restored.planningPlans[0]).toMatchObject({ version: 3, current_revision_number: 3 });
      expect(restored.workouts).toEqual(initial.workouts);
      expect(
        PlanCreationDraftSchema.parse(JSON.parse(String(restored.revisions[2]?.snapshot_json)))
          .weeks,
      ).toEqual(scenario.seed.draft.weeks);
      expect((await scenario.backend.library()).active?.todayChoice).toEqual(choice);
      await expect(
        today.getByRole("button", { name: `Review ${selected.name}`, exact: true }),
      ).toBeEnabled();
      await today.getByRole("heading").scrollIntoViewIfNeeded();
      await capture(scenario, "restored-choice");
      await changes(scenario)
        .getByRole("button", { name: "Change one thing", exact: true })
        .click();
      const requestsBeforeChat = scenario.backend.creationRequests.length;
      const composer = scenario.page.getByRole("combobox", { name: "Message your coach" });
      await composer.fill("WHAT SHOULD I RIDE TODAY?!");
      await scenario.page.getByRole("button", { name: "Send message", exact: true }).click();
      const chatPending = changeCard(scenario, choiceTitle, "Pending");
      await expect(chatPending.getByRole("heading")).toBeFocused();
      await expect(composer).toHaveValue("");
      const chatRequests = scenario.backend.creationRequests
        .slice(requestsBeforeChat)
        .filter((request) => request.method === "plan_change.preview");
      expect(chatRequests).toHaveLength(1);
      expect(PlanChangePreviewRpcParamsSchema.parse(chatRequests[0]?.params)).toMatchObject({
        planId: scenario.seed.planId,
        expectedVersion: 3,
        request: { kind: "text", text: "WHAT SHOULD I RIDE TODAY?!" },
      });
      await chatPending.scrollIntoViewIfNeeded();
      await capture(scenario, "chat-choice");
      await chatPending.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(changeCard(scenario, choiceTitle, "Cancelled")).toBeVisible();
      await expect(changes(scenario).getByRole("status")).toHaveText(
        "Change cancelled. Training is unchanged; the preview remains in history.",
      );
      const cancelled = await scenario.backend.inspectActivation();
      expect(cancelled.workouts).toEqual(restored.workouts);
      expect(cancelled.revisions).toEqual(restored.revisions);
      expect(cancelled.planningPlans).toEqual(restored.planningPlans);
      expect((await scenario.backend.library()).active?.todayChoice).toEqual(choice);
    } finally {
      await close(scenario);
    }
  });
}
