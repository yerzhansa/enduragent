import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser, type Page, type PlaywrightWorkerArgs } from "@playwright/test";
import type { PlanChangeModel } from "@enduragent/coach-contract";
import { launchDesktopFixture, type RunningDesktopFixture } from "../helpers/desktop-fixture.js";
import { PlanCreationBackend } from "../helpers/plan-creation-backend.js";

const previews = fileURLToPath(new URL("./previews/plan-change-sync-age/", import.meta.url));
const lastSyncAtMs = Date.parse("1998-01-01T00:00:00.000Z");
const staleAtMs = lastSyncAtMs + 25 * 60 * 60 * 1_000;
const pausedNotice =
  "Plan Changes are paused because synchronized training is older than 24 hours. Refresh the connection, then request a fresh preview.";
const resumedNotice = "Sources are available again. Request a fresh preview before applying.";

const token = "d".repeat(43);

interface Scenario {
  readonly backend: PlanCreationBackend;
  readonly fixture: RunningDesktopFixture;
  readonly scratch: string;
  readonly colorScheme: "light" | "dark";
  readonly width: number;
  readonly pending: PlanChangeModel;
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
  const scratch = await mkdtemp(join(tmpdir(), "plan-change-sync-age-"));
  const backend = new PlanCreationBackend(join(scratch, "store.db"), false, true, {
    calendarConnected: true,
  });
  let fixture: RunningDesktopFixture | undefined;
  try {
    await backend.open();
    backend.setSyncClock(lastSyncAtMs);
    const seed = await backend.seedActiveTraining();
    await backend.recordSuccessfulSync();
    const earlier = await backend.previewChange({
      commandId: "seed-earlier-preview",
      planId: seed.planId,
      expectedVersion: 1,
      intent: { kind: "weekday-duration", day: 1, minutes: 45 },
    });
    if (earlier.status !== "previewed") throw new TypeError("Earlier Change seed was rejected");
    const applied = await backend.applyChange({
      commandId: "seed-earlier-apply",
      planId: seed.planId,
      changeId: earlier.change.changeId,
      expectedVersion: earlier.version,
      decision: "apply",
    });
    if (applied.status !== "applied") throw new TypeError("Earlier Change was not applied");
    const previewed = await backend.previewChange({
      commandId: "seed-pending-change",
      planId: seed.planId,
      expectedVersion: applied.version,
      intent: { kind: "weekday-duration", day: 3, minutes: 30 },
    });
    if (previewed.status !== "previewed") throw new TypeError("Pending Change seed was rejected");
    backend.setSyncClock(staleAtMs);
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
    return {
      backend,
      fixture,
      scratch,
      seed,
      pending: previewed.change,
      ...appearance,
      ...connected,
    };
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
  const screenshotPath = join(previews, `${name}-${scenario.width}-${scenario.colorScheme}.png`);
  await mkdir(previews, { recursive: true });
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

function changes(scenario: Scenario) {
  return scenario.page.getByRole("region", { name: "Plan Changes", exact: true });
}

function pendingCard(scenario: Scenario) {
  return changes(scenario)
    .getByRole("region", { name: scenario.pending.title, exact: true })
    .filter({ has: scenario.page.getByText("Pending", { exact: true }) });
}

async function navigate(scenario: Scenario, destination: "Chat" | "Plan") {
  await scenario.page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: destination, exact: true })
    .click();
}

async function refreshLibrary(scenario: Scenario) {
  const before = scenario.backend.planListRequests.length;
  await navigate(scenario, "Plan");
  await navigate(scenario, "Chat");
  await expect.poll(() => scenario.backend.planListRequests.length).toBeGreaterThan(before);
}

async function assertPaused(scenario: Scenario) {
  const section = changes(scenario);
  const notice = section.getByRole("status");
  await expect(notice).toHaveText(pausedNotice);
  await expect(section.locator(":scope > :first-child")).toHaveAttribute("role", "status");
  const noticeId = await notice.getAttribute("id");
  if (!noticeId) throw new TypeError("Pause notice has no accessible reference");
  for (const button of [
    section.getByRole("button", { name: "Change one thing", exact: true }),
    section.getByRole("button", { name: "Undo", exact: true }),
    pendingCard(scenario).getByRole("button", { name: "Apply to Plan", exact: true }),
  ]) {
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute("aria-describedby", noticeId);
    await expect(button).toHaveAccessibleDescription(pausedNotice);
  }
  await expect(
    pendingCard(scenario).getByRole("button", { name: "Cancel", exact: true }),
  ).toBeEnabled();
  await expect(section.getByRole("alert")).toHaveCount(0);
  await expect(section.getByRole("combobox", { name: "Change", exact: true })).toHaveCount(0);
  expect((await scenario.backend.library()).changes).toContainEqual(scenario.pending);
}

for (const appearance of [
  { width: 1180, colorScheme: "light" },
  { width: 1180, colorScheme: "dark" },
  { width: 720, colorScheme: "light" },
  { width: 720, colorScheme: "dark" },
] as const) {
  test(`keeps a pending Change paused through relaunch and resumes after sync at ${appearance.width} in ${appearance.colorScheme}`, async ({
    playwright,
  }) => {
    test.setTimeout(120_000);
    const scenario = await launch(playwright, appearance);
    try {
      const stored = await scenario.backend.inspectActivation();
      await assertPaused(scenario);
      await changes(scenario).getByRole("status").scrollIntoViewIfNeeded();
      await capture(scenario, "paused-launch");
      await pendingCard(scenario)
        .getByRole("button", { name: "Apply to Plan", exact: true })
        .scrollIntoViewIfNeeded();
      await capture(scenario, "paused-actions");
      await relaunch(scenario, playwright);
      await assertPaused(scenario);
      expect(await scenario.backend.inspectActivation()).toEqual(stored);
      await capture(scenario, "paused-relaunch");

      await scenario.backend.recordSuccessfulSync(staleAtMs);
      await refreshLibrary(scenario);
      await expect(changes(scenario).getByRole("status")).toHaveText(resumedNotice);
      await expect(
        changes(scenario).getByRole("button", { name: "Change one thing", exact: true }),
      ).toBeEnabled();
      await expect(
        pendingCard(scenario).getByRole("button", { name: "Apply to Plan", exact: true }),
      ).toBeEnabled();
      await expect(
        changes(scenario).getByRole("button", { name: "Undo", exact: true }),
      ).toBeEnabled();
      expect((await scenario.backend.library()).changesPaused).toBeNull();
      expect((await scenario.backend.library()).changes).toContainEqual(scenario.pending);
      await capture(scenario, "sources-available-actions");
      await changes(scenario).getByRole("status").scrollIntoViewIfNeeded();
      await capture(scenario, "sources-available");

      await changes(scenario)
        .getByRole("button", { name: "Change one thing", exact: true })
        .click();
      await changes(scenario).getByRole("button", { name: "Preview change", exact: true }).click();
      await expect(pendingCard(scenario).getByRole("heading")).toBeFocused();
      await expect(changes(scenario).getByRole("status")).not.toHaveText(resumedNotice);
      await refreshLibrary(scenario);
      await expect(changes(scenario).getByRole("status")).not.toHaveText(resumedNotice);
      const pending = (await scenario.backend.library()).changes.find(
        (change) => change.status === "pending",
      );
      if (!pending) throw new TypeError("Fresh preview is unavailable");
      const beforeRefusal = await scenario.backend.inspectActivation();
      const reads = scenario.backend.planListRequests.length;
      scenario.backend.setSyncClock(staleAtMs + 25 * 60 * 60 * 1_000);
      await pendingCard(scenario)
        .getByRole("button", { name: "Apply to Plan", exact: true })
        .click();
      await expect(changes(scenario).getByRole("status")).toHaveText(pausedNotice);
      await expect(changes(scenario).getByRole("alert")).toHaveCount(0);
      await expect.poll(() => scenario.backend.planListRequests.length).toBeGreaterThan(reads);
      expect(scenario.backend.changeApplyResponses.at(-1)?.result).toEqual({
        status: "rejected",
        reason: "sync-stale",
      });
      expect(await scenario.backend.inspectActivation()).toEqual(beforeRefusal);
      await capture(scenario, "apply-paused");

      await pendingCard(scenario).getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(pendingCard(scenario)).toHaveCount(0);
      expect(
        (await scenario.backend.library()).changes.find(
          (change) => change.changeId === pending.changeId,
        )?.status,
      ).toBe("cancelled");
      const afterCancel = await scenario.backend.inspectActivation();
      expect(afterCancel.revisions).toEqual(beforeRefusal.revisions);
      expect(afterCancel.workouts).toEqual(beforeRefusal.workouts);
      await expect(changes(scenario).getByRole("status")).toHaveText(pausedNotice);
      await capture(scenario, "cancelled-while-paused");

      await scenario.backend.recordSuccessfulSync();
      await refreshLibrary(scenario);
      const undo = changes(scenario).getByRole("button", { name: "Undo", exact: true });
      await expect(undo).toBeEnabled();
      const beforeUndo = await scenario.backend.inspectActivation();
      const beforeUndoReads = scenario.backend.planListRequests.length;
      scenario.backend.setSyncClock(staleAtMs + 50 * 60 * 60 * 1_000);
      await undo.click();
      await expect(changes(scenario).getByRole("status")).toHaveText(pausedNotice);
      await expect(changes(scenario).getByRole("alert")).toHaveCount(0);
      await expect(undo).toBeDisabled();
      await expect(undo).toHaveAccessibleDescription(pausedNotice);
      await expect
        .poll(() => scenario.backend.planListRequests.length)
        .toBeGreaterThan(beforeUndoReads);
      expect(await scenario.backend.inspectActivation()).toEqual(beforeUndo);
      await capture(scenario, "undo-paused");
    } finally {
      await close(scenario);
    }
  });
}
