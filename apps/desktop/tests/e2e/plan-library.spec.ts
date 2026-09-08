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
  presence: Parameters<PlanCreationBackend["seedLibrary"]>[0],
): Promise<Scenario> {
  const scratch = await mkdtemp(join(tmpdir(), "plan-library-"));
  const backend = new PlanCreationBackend(join(scratch, "store.db"), false, true);
  let fixture: RunningDesktopFixture | undefined;
  try {
    await backend.open();
    await backend.seedLibrary(presence);
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
        requests: scenario.backend.creationRequests,
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

async function assertMixedLibrary(scenario: Scenario): Promise<void> {
  const library = scenario.page.getByRole("region", { name: "Plan library", exact: true });
  await expect(library.getByRole("heading")).toHaveText([
    "Improve fitness",
    "Active endurance Plan",
    "Recent endurance Plan",
    "Closed base Plan",
    "Earlier fitness Plan",
  ]);
  await expect(library.getByRole("button")).toHaveText([
    "Discard",
    "Continue in Chat",
    "Stop Plan",
    "Read Plan details",
    "Change in Chat",
    "Read final details",
    "Read final details",
    "Read final details",
  ]);
  await expect(library).toContainText("1 of 9 answered. Active endurance Plan keeps running.");
  await expect(library).toContainText("1 Jan 1998 to 28 Jan 1998 · 4 weeks");
  await expect(library).toContainText("1 Nov 1997 to 28 Nov 1997 · 4 weeks · Completed");
  await expect(library).toContainText("1 Oct 1997 to 28 Oct 1997 · 4 weeks · Stopped");
  await expect(library).toContainText("1 Aug 1997 to 28 Aug 1997 · 4 weeks · Unknown reason");
  await expect(scenario.page.getByRole("button", { name: /^Start a (new )?Plan$/ })).toHaveCount(0);
}

for (const appearance of [
  { width: 1180, colorScheme: "light" },
  { width: 1180, colorScheme: "dark" },
  { width: 720, colorScheme: "light" },
  { width: 720, colorScheme: "dark" },
] as const) {
  test(`restores a mixed Plan library and opens Chat actions at ${appearance.width} in ${appearance.colorScheme}`, async ({
    playwright,
  }) => {
    test.setTimeout(120_000);
    const scenario = await launch(playwright, appearance, {
      creation: true,
      active: true,
      closed: true,
    });
    try {
      const readsBeforeNavigation = scenario.backend.planListRequests.length;
      await openLibrary(scenario);
      await assertMixedLibrary(scenario);
      expect(scenario.backend.planListRequests.length - readsBeforeNavigation).toBe(1);
      const before = await scenario.backend.library();
      await capture(scenario, "mixed-library");
      const readsBeforeRelaunch = scenario.backend.planListRequests.length;
      await relaunch(scenario, playwright);
      await assertMixedLibrary(scenario);
      expect(await scenario.backend.library()).toEqual(before);
      await capture(scenario, "restored-library");
      expect(scenario.backend.planListRequests.length - readsBeforeRelaunch).toBe(1);
      await scenario.page.getByRole("button", { name: "Continue in Chat", exact: true }).click();
      await expect(
        scenario.page
          .locator('[data-parity="question.card"][data-question="plan-length"]')
          .getByRole("heading"),
      ).toBeFocused();
      await capture(scenario, "continue-in-chat");
      await openLibrary(scenario);
      await expect(
        scenario.page.getByRole("button", { name: "Continue in Chat", exact: true }),
      ).toBeFocused();
      await scenario.page.getByRole("button", { name: "Change in Chat", exact: true }).click();
      await expect(scenario.page.locator("#message")).toBeFocused();
      expect(await scenario.backend.library()).toEqual(before);
      await capture(scenario, "change-in-chat");
      await openLibrary(scenario);
      await expect(
        scenario.page.getByRole("button", { name: "Change in Chat", exact: true }),
      ).toBeFocused();
      await scenario.page.getByRole("button", { name: "Read Plan details", exact: true }).click();
      await expect(
        scenario.page.getByRole("heading", { name: "Plan active · week 1 of 4", exact: true }),
      ).toBeInViewport();
      await capture(scenario, "active-details");
      const discard = scenario.page.getByRole("button", { name: "Discard", exact: true });
      await discard.click();
      const dialog = scenario.page.getByRole("dialog", {
        name: "Discard this Plan creation?",
        exact: true,
      });
      await expect(
        dialog.getByRole("button", { name: "Keep creating", exact: true }),
      ).toBeFocused();
      await capture(scenario, "discard-confirmation");
      await dialog.getByRole("button", { name: "Keep creating", exact: true }).click();
      await expect(discard).toBeFocused();
      expect(await scenario.backend.library()).toEqual(before);
      await discard.click();
      await dialog.getByRole("button", { name: "Discard creation", exact: true }).click();
      await expect.poll(async () => (await scenario.backend.library()).creation).toBeNull();
      await expect(
        scenario.page.getByRole("region", { name: "Plan library", exact: true }),
      ).not.toBeVisible();
      await expect(scenario.page.locator("#message")).toBeVisible();
      await expect(
        scenario.page.getByText("Plan creation discarded", { exact: true }),
      ).toBeVisible();
      await expect(scenario.page.locator("#message")).toBeFocused();
      await expect(
        scenario.page.getByRole("button", { name: "Continue in Chat", exact: true }),
      ).toHaveCount(0);
      const after = await scenario.backend.library();
      expect(after.active).toEqual(before.active);
      expect(after.closed).toEqual(before.closed);
      await capture(scenario, "creation-discarded");
      await scenario.page.locator("#message").fill("/plan");
      await scenario.page.locator("#message").press("Enter");
      await expect(
        scenario.page.locator('[data-parity="question.card"][data-question="goal"]'),
      ).toBeVisible();
      await expect(
        scenario.page
          .locator('[data-parity="question.card"][data-question="goal"]')
          .getByRole("heading"),
      ).toBeFocused();
      expect((await scenario.backend.library()).active).toEqual(before.active);
      await capture(scenario, "start-new-plan");
    } finally {
      await close(scenario);
    }
  });

  test(`starts from an empty Plan library at ${appearance.width} in ${appearance.colorScheme}`, async ({
    playwright,
  }) => {
    test.setTimeout(120_000);
    const scenario = await launch(playwright, appearance, {
      creation: false,
      active: false,
      closed: false,
    });
    try {
      await openLibrary(scenario);
      const library = () =>
        scenario.page.getByRole("region", { name: "Plan library", exact: true });
      await expect(library().getByRole("heading")).toHaveText(["No active Plan"]);
      await expect(
        scenario.page.getByRole("heading", { name: "No active Plan", exact: true }),
      ).toHaveCount(1);
      await expect(library()).toContainText("Create a Plan when you are ready.");
      await expect(library().getByRole("button")).toHaveCount(0);
      await expect(scenario.page.locator("#start-plan")).toBeVisible();
      await capture(scenario, "empty-library");
      await relaunch(scenario, playwright);
      await expect(library().getByRole("heading")).toHaveText(["No active Plan"]);
      await scenario.page.locator("#start-plan").click();
      await expect(
        scenario.page
          .locator('[data-parity="question.card"][data-question="goal"]')
          .getByRole("heading"),
      ).toBeFocused();
      await scenario.page.locator('[data-parity="choice.row"][data-answer="fitness"]').click();
      await expect.poll(async () => (await scenario.backend.card())?.version).toBe(2);
      await openLibrary(scenario);
      await expect(library().getByRole("heading")).toHaveText([
        "Improve fitness",
        "No active Plan",
      ]);
      await expect(library()).toContainText("1 of 9 answered. No Plan is active.");
      await expect(
        scenario.page.getByRole("button", { name: "Start a Plan", exact: true }),
      ).toHaveCount(0);
      await capture(scenario, "creation-without-active-plan");
    } finally {
      await close(scenario);
    }
  });
}

test("keeps the last library after a failed read and retries", async ({ playwright }) => {
  test.setTimeout(120_000);
  const scenario = await launch(
    playwright,
    { width: 1180, colorScheme: "light" },
    { creation: true, active: true, closed: true },
  );
  try {
    const readsBeforeNavigation = scenario.backend.planListRequests.length;
    await openLibrary(scenario);
    await assertMixedLibrary(scenario);
    expect(scenario.backend.planListRequests.length - readsBeforeNavigation).toBe(1);
    const before = await scenario.backend.library();
    await scenario.page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("button", { name: "Chat", exact: true })
      .click();
    scenario.backend.planListReadFails = true;
    await openLibrary(scenario);
    await expect(
      scenario.page.getByText("Plan library could not load. Try again.", { exact: true }),
    ).toBeVisible();
    await assertMixedLibrary(scenario);
    expect(await scenario.backend.library()).toEqual(before);
    await capture(scenario, "library-read-failed");
    expect(scenario.backend.planListRequests.length - readsBeforeNavigation).toBe(2);
    scenario.backend.planListReadFails = false;
    await scenario.page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(
      scenario.page.getByText("Plan library could not load. Try again.", { exact: true }),
    ).toHaveCount(0);
    await assertMixedLibrary(scenario);
    await capture(scenario, "library-read-recovered");
    expect(scenario.backend.planListRequests.length - readsBeforeNavigation).toBe(3);
  } finally {
    await close(scenario);
  }
});

test("refreshes a stale creation without leaving the library when Continue in Chat is clicked", async ({
  playwright,
}) => {
  test.setTimeout(120_000);
  const scenario = await launch(
    playwright,
    { width: 1180, colorScheme: "light" },
    { creation: true, active: true, closed: true },
  );
  try {
    await openLibrary(scenario);
    await assertMixedLibrary(scenario);
    const before = await scenario.backend.library();
    const creation = before.creation;
    if (creation === null) throw new TypeError("Plan creation is unavailable");
    await scenario.backend.script.onRequest({
      method: "plan_creation.discard",
      params: {
        commandId: "discard-visible-library-creation",
        creationId: creation.creationId,
        expectedVersion: creation.version,
      },
    });
    expect((await scenario.backend.library()).creation).toBeNull();
    const readsBeforeContinue = scenario.backend.planListRequests.length;
    await scenario.page.getByRole("button", { name: "Continue in Chat", exact: true }).click();
    await expect(
      scenario.page.getByRole("region", { name: "Plan library", exact: true }),
    ).toBeVisible();
    await expect(scenario.page.locator("#message")).not.toBeVisible();
    await expect(
      scenario.page
        .getByRole("region", { name: "Plan library", exact: true })
        .getByText(
          "This creation is no longer unfinished. Open the Plan library for its current result.",
          { exact: true },
        ),
    ).toBeVisible();
    await expect(
      scenario.page.getByRole("button", { name: "Continue in Chat", exact: true }),
    ).toHaveCount(0);
    await expect(
      scenario.page.getByRole("heading", { name: "Improve fitness", exact: true }),
    ).toHaveCount(0);
    const after = await scenario.backend.library();
    expect(after.active).toEqual(before.active);
    expect(after.closed).toEqual(before.closed);
    await capture(scenario, "stale-creation-refreshed");
    expect(scenario.backend.planListRequests.length - readsBeforeContinue).toBe(1);
  } finally {
    await close(scenario);
  }
});
