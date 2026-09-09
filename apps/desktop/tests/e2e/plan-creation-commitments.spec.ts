import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser, type Page, type PlaywrightWorkerArgs } from "@playwright/test";
import { launchDesktopFixture, type RunningDesktopFixture } from "../helpers/desktop-fixture.js";
import { PlanCreationBackend } from "../helpers/plan-creation-backend.js";

const commitments = "Wednesday at most 45 minutes";
const ambiguousCommitment = "Keep my evenings free";
const pendingSummary =
  "I understood your note as this limit. Confirm it and your other confirmed limits stay as they are.";
const previews = fileURLToPath(new URL("./previews/plan-creation-commitments/", import.meta.url));

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
    await page
      .getByRole("group", { name: "Appearance", exact: true })
      .getByRole("button", { name: colorScheme === "light" ? "Light" : "Dark", exact: true })
      .click();
    await navigation.getByRole("button", { name: "Chat", exact: true }).click();
  }
  await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
  return { browser, page };
}

async function capture(page: Page, name: string): Promise<void> {
  const path = join(previews, `${name}.png`);
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path });
  await test.info().attach(name, { path, contentType: "image/png" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

async function expectAboveComposer(
  page: Page,
  correction: ReturnType<Page["getByRole"]>,
): Promise<void> {
  const name = (await correction.getAttribute("aria-label")) ?? "";
  await expect(
    page
      .getByRole("region", { name: "Plan creation dock", exact: true })
      .getByRole("region", { name, exact: true }),
  ).toHaveCount(1);
  await expect(
    page
      .getByRole("region", { name: "Plan creation", exact: true })
      .getByRole("region", { name, exact: true }),
  ).toHaveCount(0);
  await expect(page.locator("#message")).toBeDisabled();
  await expect(page.locator("#message")).toHaveAttribute(
    "placeholder",
    "Finish the correction above",
  );
  const cardBox = await correction.boundingBox();
  const composerBox = await page.locator("#message").boundingBox();
  if (cardBox === null || composerBox === null)
    throw new TypeError("Correction or composer is unavailable");
  expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(composerBox.y);
}

async function card(backend: PlanCreationBackend) {
  const model = await backend.card();
  if (model === null) throw new TypeError("Plan Creation is unavailable");
  return model;
}

async function editCommitments(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Edit answers", exact: true }).click();
  await page.getByRole("button", { name: "Edit Commitments", exact: true }).click();
  if (!(await page.locator('[data-parity="custom.textarea"]').isVisible())) {
    await page.locator('[data-answer="custom"]').click();
  }
}

for (const appearance of [
  { width: 1180, colorScheme: "light" },
  { width: 1180, colorScheme: "dark" },
  { width: 720, colorScheme: "light" },
  { width: 720, colorScheme: "dark" },
] as const) {
  test(`interprets, confirms, clarifies and cancels commitments at ${appearance.width} in ${appearance.colorScheme}`, async ({
    playwright,
  }) => {
    test.setTimeout(180_000);
    const scratch = await mkdtemp(join(tmpdir(), "plan-commitments-"));
    const backend = new PlanCreationBackend(join(scratch, "store.db"), false, true);
    let failNextAnswer = false;
    let fixture: RunningDesktopFixture | undefined;
    let browser: Browser | undefined;
    try {
      await backend.open();
      await backend.seedTrainingCreation({ kind: "interpreted", text: ambiguousCommitment });
      fixture = await launchDesktopFixture({
        script: {
          ...backend.script,
          onRequest: (request) => {
            if (
              failNextAnswer &&
              typeof request === "object" &&
              request !== null &&
              "method" in request &&
              request.method === "plan_creation.answer"
            ) {
              failNextAnswer = false;
              throw new Error("Synthetic answer failure");
            }
            return backend.script.onRequest(request);
          },
        },
        token: "d".repeat(43),
        width: appearance.width,
        height: 1000,
        colorScheme: appearance.colorScheme,
        reducedMotion: true,
        hidden: true,
        routeChatAttachmentComposer: true,
      });
      await fixture.setViewport(appearance.width, 1000);
      let connected = await connect(playwright, fixture, appearance.colorScheme, true);
      browser = connected.browser;
      let page = connected.page;
      const screenshot = (name: string) =>
        capture(page, `${name}-${appearance.width}-${appearance.colorScheme}`);
      const build = page.getByRole("button", { name: "Build Draft", exact: true });
      const initialCorrection = page.getByRole("region", {
        name: "I could not use that answer",
        exact: true,
      });
      await expect(initialCorrection).toBeVisible();
      await expectAboveComposer(page, initialCorrection);
      await expect(build).toBeDisabled();
      await expect(build).toHaveAccessibleDescription(
        "Tell me again in a different way, with weekdays, time limits, or exact dates.",
      );
      await screenshot("pending-before-draft");
      await page.getByRole("button", { name: "Skip for now", exact: true }).click();
      await expect(build).toBeEnabled();
      await expect(page.locator("#message")).toBeFocused();
      await build.click();
      await expect(page.getByRole("button", { name: "Activate Plan", exact: true })).toBeEnabled();
      const original = await card(backend);
      if (original.draft === null) throw new TypeError("Original Draft is unavailable");
      const originalWednesdays = original.draft.weeks
        .flatMap((week) => week.workouts)
        .filter(
          (workout) =>
            workout.date !== null && new Date(`${workout.date}T12:00:00Z`).getUTCDay() === 3,
        );
      expect(originalWednesdays.some((workout) => workout.minutes > 45)).toBe(true);
      await editCommitments(page);
      await page.locator('[data-parity="custom.textarea"]').fill(commitments);
      await page.getByRole("button", { name: "Review interpretation", exact: true }).click();
      const confirmation = page.getByRole("region", {
        name: "Did I read this right?",
        exact: true,
      });
      await expect(confirmation).toBeVisible();
      await expect(
        confirmation.getByText("Plan creation · Commitments", { exact: true }),
      ).toBeVisible();
      await expect(confirmation.locator("[data-plan-card-status]")).toHaveCount(0);
      await expectAboveComposer(page, confirmation);
      await expect(
        confirmation.getByRole("row", { name: `You wrote ${commitments}`, exact: true }),
      ).toBeVisible();
      await expect(
        confirmation.getByRole("row", {
          name: "I understood Wed · at most 45 min",
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Activate Plan", exact: true })).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "Activate Plan", exact: true }),
      ).toHaveAccessibleDescription(pendingSummary);
      const pending = await card(backend);
      expect(pending).toMatchObject({
        draft: original.draft,
        draftStale: false,
        pendingCommitment: { text: commitments, status: "confirm" },
      });
      await confirmation.scrollIntoViewIfNeeded();
      await screenshot("pending-draft");
      await browser.close();
      await fixture.relaunch(() => backend.reopen());
      await fixture.setViewport(appearance.width, 1000);
      connected = await connect(playwright, fixture, appearance.colorScheme);
      browser = connected.browser;
      page = connected.page;
      await expect(
        page.getByRole("heading", { name: "Did I read this right?", exact: true }),
      ).toBeVisible();
      expect(await card(backend)).toEqual(pending);
      await expect(page.getByRole("button", { name: "Activate Plan", exact: true })).toBeDisabled();
      await screenshot("pending-restored");
      await page.getByRole("button", { name: "Confirm", exact: true }).click();
      await expect.poll(async () => (await backend.card())?.pendingCommitment).toBeNull();
      await expect(page.locator("#message")).toBeFocused();
      expect(await card(backend)).toMatchObject({ draft: original.draft, draftStale: true });
      await page.getByRole("button", { name: "Rebuild Draft", exact: true }).click();
      await expect(page.getByRole("button", { name: "Activate Plan", exact: true })).toBeEnabled();
      const rebuilt = await card(backend);
      if (rebuilt.draft === null) throw new TypeError("Rebuilt Draft is unavailable");
      expect(rebuilt.draft.inputFingerprint).not.toBe(original.draft.inputFingerprint);
      const wednesdays = rebuilt.draft.weeks
        .flatMap((week) => week.workouts)
        .filter(
          (workout) =>
            workout.date !== null && new Date(`${workout.date}T12:00:00Z`).getUTCDay() === 3,
        );
      expect(wednesdays.length).toBeGreaterThan(0);
      expect(wednesdays.every((workout) => workout.minutes <= 45)).toBe(true);
      for (const week of rebuilt.draft.weeks) {
        const rows = page
          .getByRole("list", { name: `Week ${week.number} Workouts`, exact: true })
          .getByRole("listitem");
        await expect(rows).toHaveCount(week.workouts.length);
        for (const [index, workout] of week.workouts.entries()) {
          await expect(rows.nth(index)).toContainText(`${workout.name} · ${workout.minutes} min`);
        }
      }
      await page
        .getByRole("region", { name: "Every week and Workout", exact: true })
        .getByRole("heading")
        .scrollIntoViewIfNeeded();
      await screenshot("confirmed-rebuilt");
      await editCommitments(page);
      await page.locator('[data-parity="custom.textarea"]').fill(ambiguousCommitment);
      await page.getByRole("button", { name: "Review interpretation", exact: true }).click();
      const clarification = page.getByRole("region", {
        name: "I could not use that answer",
        exact: true,
      });
      await expect(clarification).toBeVisible();
      await expect(
        clarification.getByRole("row", { name: `You wrote ${ambiguousCommitment}`, exact: true }),
      ).toBeVisible();
      await expect(clarification.getByRole("row")).toHaveCount(1);
      await expectAboveComposer(page, clarification);
      await expect(clarification.getByRole("button", { name: "Confirm", exact: true })).toHaveCount(
        0,
      );
      await expect(page.getByRole("button", { name: "Activate Plan", exact: true })).toBeDisabled();
      expect((await card(backend)).draft).toEqual(rebuilt.draft);
      await clarification.scrollIntoViewIfNeeded();
      await screenshot("clarify-pending");
      await page.getByRole("button", { name: "Answer", exact: true }).click();
      await expect(page.locator('[data-parity="custom.textarea"]')).toHaveValue(
        ambiguousCommitment,
      );
      await expect(
        page.getByText("Give the weekday and exact limit, or the exact time-off dates.", {
          exact: true,
        }),
      ).toBeVisible();
      await screenshot("clarify-editor");
      failNextAnswer = true;
      await page.locator('[data-parity="custom.textarea"]').fill("Some evenings are busy");
      await page.getByRole("button", { name: "Review interpretation", exact: true }).click();
      await expect(
        page.getByRole("region", { name: "Plan creation dock", exact: true }).getByRole("alert"),
      ).toHaveText("Plan Creation couldn’t save that. Try again.");
      await expect(page.locator('[data-parity="custom.textarea"]')).toHaveValue(
        "Some evenings are busy",
      );
      await screenshot("clarify-editor-error");
      await page.getByRole("button", { name: "Review interpretation", exact: true }).click();
      await expect(clarification).toBeVisible();
      await expect(
        clarification.getByText("Some evenings are busy", { exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Answer", exact: true }).click();
      await page.getByRole("button", { name: "Back to answers", exact: true }).click();
      await page.getByRole("button", { name: "Skip for now", exact: true }).click();
      await expect(page.locator("#message")).toBeFocused();
      const clarificationBeforeChat = await card(backend);
      await page
        .getByRole("combobox", { name: "Message your coach" })
        .fill("How easy should an easy ride feel?");
      await page.getByRole("button", { name: "Send message" }).click();
      await expect(
        page
          .getByRole("log", { name: "Coach conversation" })
          .getByText("Keep the effort conversational and finish feeling fresh.", { exact: true }),
      ).toBeVisible();
      expect(await card(backend)).toEqual(clarificationBeforeChat);
      await editCommitments(page);
      await page.locator('[data-parity="custom.textarea"]').fill("Saturday unavailable");
      await page.getByRole("button", { name: "Review interpretation", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Did I read this right?", exact: true }),
      ).toBeVisible();
      await expect
        .poll(async () => (await backend.card())?.pendingCommitment?.text)
        .toBe("Saturday unavailable");
      await page.getByRole("button", { name: "Change it", exact: true }).click();
      await expect(page.locator('[data-parity="custom.textarea"]')).toBeFocused();
      await page.locator('[data-parity="custom.textarea"]').fill(ambiguousCommitment);
      await page.getByRole("button", { name: "Review interpretation", exact: true }).click();
      await page
        .getByRole("region", { name: "I could not use that answer", exact: true })
        .getByRole("button", { name: "Skip for now", exact: true })
        .click();
      await expect.poll(async () => (await backend.card())?.pendingCommitment).toBeNull();
      await expect(page.locator("#message")).toBeFocused();
      expect(await card(backend)).toMatchObject({
        draft: rebuilt.draft,
        draftStale: false,
        answeredSummaries: rebuilt.answeredSummaries,
      });
      const activate = page.getByRole("button", { name: "Activate Plan", exact: true });
      await expect(activate).toBeEnabled();
      const answers = backend.creationRequests.filter(
        (request) => request.method === "plan_creation.answer",
      );
      expect(answers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            params: expect.objectContaining({
              answer: {
                kind: "commitments",
                commitments: { kind: "interpreted", text: commitments },
              },
            }),
          }),
          expect.objectContaining({
            params: expect.objectContaining({ answer: { kind: "commitments-confirm" } }),
          }),
          expect.objectContaining({
            params: expect.objectContaining({ answer: { kind: "commitments-cancel" } }),
          }),
          expect.objectContaining({
            params: expect.objectContaining({
              answer: {
                kind: "commitments",
                commitments: { kind: "interpreted", text: "Saturday unavailable" },
              },
            }),
          }),
        ]),
      );
      await activate.click();
      const dialog = page.getByRole("dialog", { name: "Activate Plan?", exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
      await screenshot("activation-confirmation");
    } finally {
      await browser?.close().catch(() => {});
      try {
        if (fixture !== undefined) {
          const cleanup = await fixture.close();
          await test
            .info()
            .attach("cleanup", { body: JSON.stringify(cleanup), contentType: "application/json" });
          expect(cleanup).toEqual({ livePids: [], listenerCount: 0 });
        }
      } finally {
        try {
          await backend.close();
        } finally {
          await rm(scratch, { recursive: true, force: true });
        }
      }
    }
  });
}
