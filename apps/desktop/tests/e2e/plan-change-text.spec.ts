import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser, type Page, type PlaywrightWorkerArgs } from "@playwright/test";
import { PlanChangePreviewRpcParamsSchema } from "@enduragent/coach-contract";
import { launchDesktopFixture, type RunningDesktopFixture } from "../helpers/desktop-fixture.js";
import { PlanCreationBackend } from "../helpers/plan-creation-backend.js";

const token = "d".repeat(43);
const previews = fileURLToPath(new URL("./previews/plan-change-text/", import.meta.url));

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
  const scratch = await mkdtemp(join(tmpdir(), "plan-change-text-"));
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

const appearances = [
  { width: 1180, colorScheme: "light" },
  { width: 1180, colorScheme: "dark" },
  { width: 720, colorScheme: "light" },
  { width: 720, colorScheme: "dark" },
] as const;
const durationTitle = "Limit weekday duration";
const ftpTitle = "Correct FTP";

function changes(scenario: Scenario) {
  return scenario.page.getByRole("region", { name: "Plan Changes", exact: true });
}

function pendingCard(scenario: Scenario, title: string) {
  return changes(scenario)
    .getByRole("region", { name: title, exact: true })
    .filter({ has: scenario.page.getByText("Pending", { exact: true }) });
}

async function send(scenario: Scenario, text: string) {
  const before = scenario.backend.creationRequests.length;
  const composer = scenario.page.getByRole("combobox", { name: "Message your coach" });
  await composer.fill(text);
  await scenario.page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(composer).toHaveValue("");
  await expect(
    scenario.page.locator("article.chat-message--athlete").getByText(text, { exact: true }),
  ).toBeVisible();
  await expect
    .poll(
      () =>
        scenario.backend.creationRequests
          .slice(before)
          .filter((request) => request.method === "plan_change.preview").length,
    )
    .toBe(1);
  const requests = scenario.backend.creationRequests
    .slice(before)
    .filter((request) => request.method === "plan_change.preview");
  expect(PlanChangePreviewRpcParamsSchema.parse(requests[0]?.params)).toMatchObject({
    planId: scenario.seed.planId,
    expectedVersion: 1,
    request: { kind: "text", text },
  });
}

for (const appearance of appearances) {
  test(`previews typed changes and explains unsupported requests at ${appearance.width} in ${appearance.colorScheme}`, async ({
    playwright,
  }) => {
    test.setTimeout(120_000);
    const scenario = await launch(playwright, appearance);
    try {
      const initial = await scenario.backend.inspectActivation();
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
      await expect(editor.getByRole("combobox", { name: "Change", exact: true })).toContainText(
        "Weekday duration cap",
      );
      await expect(editor.getByRole("combobox", { name: "Weekday", exact: true })).toContainText(
        "Wed",
      );
      await expect(
        editor.getByRole("spinbutton", {
          name: "Duration limit in minutes",
          exact: true,
        }),
      ).toHaveValue("30");
      await editor.getByRole("button", { name: "Preview change", exact: true }).click();
      const card = pendingCard(scenario, durationTitle);
      await expect(card.getByRole("heading")).toBeFocused();
      const cardPreview = (await scenario.backend.library()).changes.find(
        (change) => change.status === "pending",
      );
      if (!cardPreview) throw new TypeError("Weekday duration preview is unavailable");
      expect(cardPreview.intent).toEqual({ kind: "weekday-duration", day: 3, minutes: 30 });
      expect(cardPreview.diff).toHaveLength(4);
      const cardRows = await card
        .getByRole("table", {
          name: "Affected individual Workouts",
          exact: true,
        })
        .getByRole("cell")
        .allTextContents();
      await capture(scenario, "card-duration-preview");
      await card.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(card).toHaveCount(0);

      await send(scenario, "wednesdays at most 30 minutes");
      const typed = pendingCard(scenario, durationTitle);
      await expect(typed.getByRole("heading")).toBeFocused();
      const typedPreview = (await scenario.backend.library()).changes.find(
        (change) => change.status === "pending",
      );
      expect(typedPreview?.intent).toEqual(cardPreview.intent);
      expect(typedPreview?.diff).toEqual(cardPreview.diff);
      expect(typedPreview?.totals).toEqual(cardPreview.totals);
      await expect(
        typed
          .getByRole("table", {
            name: "Affected individual Workouts",
            exact: true,
          })
          .getByRole("cell"),
      ).toHaveText(cardRows);
      await typed.getByRole("heading").scrollIntoViewIfNeeded();
      await capture(scenario, "text-duration-preview");
      await typed.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(typed).toHaveCount(0);

      await send(scenario, "my ftp is 220");
      const ftp = pendingCard(scenario, ftpTitle);
      await expect(ftp.getByRole("heading")).toBeFocused();
      const ftpPreview = (await scenario.backend.library()).changes.find(
        (change) => change.status === "pending",
      );
      expect(ftpPreview?.intent).toEqual({ kind: "ftp", watts: 220 });
      expect(ftpPreview?.diff).toHaveLength(12);
      expect(
        ftpPreview?.diff.every((row) => row.before?.power === null && row.after?.power === 220),
      ).toBe(true);
      await expect(
        ftp
          .getByRole("table", {
            name: "Affected individual Workouts",
            exact: true,
          })
          .getByRole("cell"),
      ).toHaveText(ftpPreview?.diff.map(() => / → .* · \d+ min · 220 W$/) ?? []);
      await ftp.getByRole("heading").scrollIntoViewIfNeeded();
      await capture(scenario, "text-ftp-preview");
      await ftp.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(ftp).toHaveCount(0);

      const previewsBeforeRejections = (await scenario.backend.library()).changes;
      for (const request of [
        {
          text: "paint my bicycle blue",
          explanation: "This request is not supported yet. Choose one of the available actions.",
          screenshot: "unsupported-notice",
        },
        {
          text: "wednesdays at most 30 minutes and my ftp is 220",
          explanation: "Ask for one change at a time.",
          screenshot: "combined-notice",
        },
      ]) {
        await send(scenario, request.text);
        const notice = changes(scenario).getByRole("status");
        await expect(notice).toHaveText(request.explanation);
        await expect(changes(scenario).getByText("Pending", { exact: true })).toHaveCount(0);
        expect((await scenario.backend.library()).changes).toEqual(previewsBeforeRejections);
        await notice.scrollIntoViewIfNeeded();
        await capture(scenario, request.screenshot);
      }
      const previewRequests = scenario.backend.creationRequests
        .filter((request) => request.method === "plan_change.preview")
        .map((request) => PlanChangePreviewRpcParamsSchema.parse(request.params));
      expect(previewRequests).toHaveLength(5);
      expect(new Set(previewRequests.map((request) => request.commandId)).size).toBe(5);
      const final = await scenario.backend.inspectActivation();
      expect(final.workouts).toEqual(initial.workouts);
      expect(final.revisions).toEqual(initial.revisions);
      expect(final.planningPlans).toEqual(initial.planningPlans);
    } finally {
      await close(scenario);
    }
  });
}
