import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Browser, type Page, type PlaywrightWorkerArgs } from "@playwright/test";
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
  const scratch = await mkdtemp(join(tmpdir(), "plan-close-history-"));
  const backend = new PlanCreationBackend(join(scratch, "store.db"), false, true);
  let fixture: RunningDesktopFixture | undefined;
  try {
    await backend.open();
    await backend.seedLibrary({ creation: false, active: true, closed: false });
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
    expect(backend.planListRequests).toHaveLength(1);
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
}

async function capture(scenario: Scenario, name: string): Promise<void> {
  const screenshotPath = test.info().outputPath(`${name}.png`);
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
    await test.info().attach("stored-creation", {
      body: JSON.stringify({
        card: await scenario.backend.card(),
        library: await scenario.backend.library(),
        stored: await scenario.backend.inspectActivation(),
        planListRequests: scenario.backend.planListRequests,
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

async function openLibrary(scenario: Scenario): Promise<void> {
  await scenario.page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Plan", exact: true })
    .click();
  await expect(
    scenario.page.getByRole("region", { name: "Plan library", exact: true }),
  ).toBeVisible();
  await expect(scenario.page.locator("#message")).not.toBeVisible();
}

async function assertFinalDetails(scenario: Scenario, reason: "Stopped" | "Completed") {
  const history = scenario.page.getByRole("region", { name: "Final Plan history", exact: true });
  await expect(history).toBeVisible();
  await expect(
    history.getByRole("heading", { name: "Active endurance Plan", exact: true }),
  ).toBeVisible();
  await expect(
    history.getByText(`1 Jan 1998 to 28 Jan 1998 · 4 weeks · ${reason}`, { exact: true }),
  ).toBeVisible();
  await expect(
    history.getByRole("heading", { name: "Final Plan details", exact: true }),
  ).toBeVisible();
  await expect(
    history.getByRole("row", { name: "Main Goal · your answer Improve fitness", exact: true }),
  ).toBeVisible();
  for (let week = 1; week <= 4; week += 1) {
    const workouts = history.getByRole("list", { name: `Week ${week} Workouts`, exact: true });
    const workout = workouts.getByRole("listitem");
    await expect(workout).toHaveCount(1);
    await expect(workout).toContainText(`${1 + (week - 1) * 7} Jan 1998`);
    await expect(workout).toContainText(
      "Endurance ride · 45 min · Keep the effort conversational.",
    );
    await expect(workout).toContainText("planned");
  }
  await expect(history.getByRole("button")).toHaveText(["Back to library"]);
}

async function assertClosedLibrary(scenario: Scenario, reason: "Stopped" | "Completed") {
  const library = scenario.page.getByRole("region", { name: "Plan library", exact: true });
  await expect(library.getByRole("heading")).toHaveText([
    "No active Plan",
    "Active endurance Plan",
  ]);
  const closed = library.getByRole("region", { name: "Closed Plan", exact: true });
  await expect(
    closed.getByText(`1 Jan 1998 to 28 Jan 1998 · 4 weeks · ${reason}`, { exact: true }),
  ).toBeVisible();
  await expect(library.getByRole("button", { name: "Stop Plan", exact: true })).toHaveCount(0);
  await expect(scenario.page.getByText(/^Plan active/)).toHaveCount(0);
  await closed.getByRole("button", { name: "Read final details", exact: true }).click();
  await assertFinalDetails(scenario, reason);
}

for (const appearance of [
  { width: 1180, colorScheme: "light" },
  { width: 1180, colorScheme: "dark" },
  { width: 720, colorScheme: "light" },
  { width: 720, colorScheme: "dark" },
] as const) {
  test(`cancels and stops offline, then restores final history at ${appearance.width} in ${appearance.colorScheme}`, async ({
    playwright,
  }) => {
    test.setTimeout(120_000);
    const scenario = await launch(playwright, appearance);
    try {
      await openLibrary(scenario);
      const before = await scenario.backend.inspectActivation();
      const stop = scenario.page
        .getByRole("region", { name: "Active Plan", exact: true })
        .getByRole("button", { name: "Stop Plan", exact: true });
      const dialog = scenario.page.getByRole("dialog", { name: "Stop this Plan?", exact: true });
      await stop.click();
      await expect(dialog.getByRole("button")).toHaveText(["Cancel", "Stop Plan"]);
      await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
      await expect(dialog).toContainText(
        "Final training stays readable. Calendar cleanup can finish later.",
      );
      await capture(scenario, "stop-confirmation");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(dialog).not.toBeVisible();
      await expect(stop).toBeFocused();
      expect(await scenario.backend.inspectActivation()).toEqual(before);
      await stop.click();
      await dialog.getByRole("button", { name: "Stop Plan", exact: true }).click();
      await assertFinalDetails(scenario, "Stopped");
      await expect(
        scenario.page
          .getByRole("status")
          .filter({ hasText: "Plan closed. Calendar cleanup pending." }),
      ).toBeVisible();
      await expect(
        scenario.page.getByRole("row", {
          name: "Calendar Calendar cleanup waits for intervals.icu",
          exact: true,
        }),
      ).toBeVisible();
      const after = await scenario.backend.inspectActivation();
      expect(after.planningPlans).toEqual([
        expect.objectContaining({
          status: "closed",
          close_reason: "stopped",
          close_actor: "athlete",
          version: 2,
        }),
      ]);
      expect(after.plans).toEqual([expect.objectContaining({ status: "ended" })]);
      expect(after.jobs).toEqual([expect.objectContaining({ kind: "cleanup", status: "pending" })]);
      expect(after.commands).toEqual([expect.objectContaining({ command_name: "plan.close" })]);
      expect(after.revisions).toEqual(before.revisions);
      expect(after.workouts).toEqual(before.workouts);
      await capture(scenario, "stopped-offline");
      await scenario.page.getByRole("button", { name: "Back to library", exact: true }).click();
      await assertClosedLibrary(scenario, "Stopped");
      await scenario.page.getByRole("button", { name: "Back to library", exact: true }).click();
      await relaunch(scenario, playwright);
      await assertClosedLibrary(scenario, "Stopped");
      expect(await scenario.backend.inspectActivation()).toEqual(after);
      await capture(scenario, "restored-final-history");
    } finally {
      await close(scenario);
    }
  });

  test(`rejects stale stops and retries failed stops at ${appearance.width} in ${appearance.colorScheme}`, async ({
    playwright,
  }) => {
    test.setTimeout(120_000);
    const scenario = await launch(playwright, appearance);
    try {
      await openLibrary(scenario);
      const stop = scenario.page
        .getByRole("region", { name: "Active Plan", exact: true })
        .getByRole("button", { name: "Stop Plan", exact: true });
      const dialog = scenario.page.getByRole("dialog", { name: "Stop this Plan?", exact: true });
      await stop.click();
      await scenario.backend.bumpActivePlanVersion();
      await dialog.getByRole("button", { name: "Stop Plan", exact: true }).click();
      await expect(dialog.getByRole("alert")).toHaveText(
        "The Plan changed. Review its current details before stopping.",
      );
      await expect(dialog.getByRole("button", { name: "Stop Plan", exact: true })).toBeDisabled();
      const stale = await scenario.backend.inspectActivation();
      expect(stale.planningPlans).toEqual([
        expect.objectContaining({ status: "active", version: 2, close_reason: null }),
      ]);
      expect(stale.plans).toEqual([expect.objectContaining({ status: "active" })]);
      expect(stale.jobs).toEqual([]);
      await capture(scenario, "stale-stop");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(stop).toBeFocused();
      const navigation = scenario.page.getByRole("navigation", { name: "Main navigation" });
      await navigation.getByRole("button", { name: "Chat", exact: true }).click();
      await openLibrary(scenario);
      scenario.backend.failNextClose();
      await stop.click();
      await dialog.getByRole("button", { name: "Stop Plan", exact: true }).click();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("alert")).toHaveText(
        "Stopping could not be confirmed. The library will show the current state after refresh.",
      );
      await expect(dialog.getByRole("button", { name: "Stop Plan", exact: true })).toBeEnabled();
      expect(await scenario.backend.inspectActivation()).toEqual(stale);
      await capture(scenario, "failed-stop");
      expect(scenario.backend.closeRequests).toHaveLength(2);
      const failedRequest = scenario.backend.closeRequests[1];
      expect(failedRequest?.params).toEqual({
        commandId: expect.any(String),
        planId: stale.planningPlans[0]?.plan_id,
        expectedVersion: 2,
      });
      await dialog.getByRole("button", { name: "Stop Plan", exact: true }).click();
      await expect(dialog).not.toBeVisible();
      await assertFinalDetails(scenario, "Stopped");
      expect(scenario.backend.closeRequests).toHaveLength(3);
      expect(scenario.backend.closeRequests[2]?.params).toEqual(failedRequest?.params);
      const stopped = await scenario.backend.inspectActivation();
      expect(stopped.planningPlans).toEqual([
        expect.objectContaining({
          status: "closed",
          version: 3,
          close_reason: "stopped",
          close_actor: "athlete",
        }),
      ]);
      expect(stopped.plans).toEqual([expect.objectContaining({ status: "ended" })]);
      expect(stopped.revisions).toEqual(stale.revisions);
      expect(stopped.workouts).toEqual(stale.workouts);
      await capture(scenario, "retried-stop");
    } finally {
      await close(scenario);
    }
  });

  test(`completes after the final day at ${appearance.width} in ${appearance.colorScheme}`, async ({
    playwright,
  }) => {
    test.setTimeout(120_000);
    const scenario = await launch(playwright, appearance);
    try {
      await scenario.backend.bumpActivePlanVersion();
      const stale = await scenario.backend.inspectActivation();
      const stop = scenario.page
        .getByRole("region", { name: "Active Plan", exact: true })
        .getByRole("button", { name: "Stop Plan", exact: true });
      const navigation = scenario.page.getByRole("navigation", { name: "Main navigation" });
      scenario.backend.setCivilDate("1998-01-28");
      await openLibrary(scenario);
      await expect(stop).toBeVisible();
      expect(await scenario.backend.inspectActivation()).toEqual(stale);
      await navigation.getByRole("button", { name: "Chat", exact: true }).click();
      scenario.backend.setCivilDate("1998-01-29");
      await openLibrary(scenario);
      await assertClosedLibrary(scenario, "Completed");
      const completed = await scenario.backend.inspectActivation();
      expect(completed.planningPlans).toEqual([
        expect.objectContaining({
          status: "closed",
          version: 3,
          close_reason: "completed",
          close_actor: "system:plan-completion",
          closed_at_ms: Date.parse("1998-01-29T00:00:00.000Z"),
        }),
      ]);
      expect(completed.plans).toEqual([expect.objectContaining({ status: "ended" })]);
      expect(completed.revisions).toEqual(stale.revisions);
      await capture(scenario, "completed-final-history");
    } finally {
      await close(scenario);
    }
  });
}
