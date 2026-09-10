import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Browser } from "@playwright/test";
import { launchDesktopFixture, type RunningDesktopFixture } from "../helpers/desktop-fixture.js";
import { PlanCreationBackend } from "../helpers/plan-creation-backend.js";

for (const appearance of [
  { width: 1180, colorScheme: "light" },
  { width: 1180, colorScheme: "dark" },
  { width: 720, colorScheme: "light" },
  { width: 720, colorScheme: "dark" },
] as const) {
  test(`checks success, skip, and event details at ${appearance.width} in ${appearance.colorScheme}`, async ({
    playwright,
  }) => {
    test.setTimeout(180_000);
    const scratch = await mkdtemp(join(tmpdir(), "typed-answer-checks-"));
    const backend = new PlanCreationBackend(join(scratch, "store.db"), false, true);
    let fixture: RunningDesktopFixture | undefined;
    let browser: Browser | undefined;
    try {
      await backend.open();
      await backend.seedTrainingCreation();
      fixture = await launchDesktopFixture({
        script: backend.script,
        token: "d".repeat(43),
        ...appearance,
        height: 900,
        reducedMotion: true,
        hidden: true,
        routeChatAttachmentComposer: true,
      });
      await fixture.setViewport(appearance.width, 900);
      browser = await playwright.chromium.connectOverCDP(fixture.remoteDebuggingUrl);
      const page = browser
        .contexts()[0]
        ?.pages()
        .find((candidate) => candidate.url().startsWith("enduragent://app/"));
      if (page === undefined) throw new TypeError("Creation renderer is unavailable");
      await expect(page.locator("[data-shell]")).toHaveAttribute("data-onboarding", "settled", {
        timeout: 30_000,
      });
      await page.emulateMedia({ ...appearance, reducedMotion: "reduce" });
      const navigation = page.getByRole("navigation", { name: "Main navigation" });
      await navigation.getByRole("button", { name: "Settings", exact: true }).click();
      await page
        .getByRole("group", { name: "Appearance", exact: true })
        .getByRole("button", {
          name: appearance.colorScheme === "light" ? "Light" : "Dark",
          exact: true,
        })
        .click();
      await navigation.getByRole("button", { name: "Chat", exact: true }).click();
      const capture = async (name: string) => {
        const directory = join(scratch, "previews");
        await mkdir(directory, { recursive: true });
        const path = join(directory, `${name}.png`);
        await page.screenshot({ path });
        await test.info().attach(name, { path, contentType: "image/png" });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
      };
      const edit = async (label: string) => {
        await page.getByRole("button", { name: "Edit answers", exact: true }).click();
        await page.getByRole("button", { name: `Edit ${label}`, exact: true }).click();
      };
      const submit = async (text: string) => {
        if (!(await page.locator('[data-parity="custom.textarea"]').isVisible()))
          await page.locator('[data-answer="custom"]').click();
        await page.locator('[data-parity="custom.textarea"]').fill(text);
        await page.getByRole("button", { name: "Continue", exact: true }).click();
      };
      await page.getByRole("button", { name: "Build Draft", exact: true }).click();
      await edit("Success");
      const before = await backend.answers();
      await submit("wtf");
      const successAsk = page.getByRole("region", {
        name: "What would make this Plan a success for you?",
        exact: true,
      });
      await expect(successAsk).toBeVisible();
      await expect(successAsk.getByText("Plan creation · Success", { exact: true })).toBeVisible();
      await expect(page.locator("#message")).toBeDisabled();
      expect(await backend.answers()).toEqual(before);
      await capture("success-ask");
      await successAsk.getByRole("button", { name: "Answer", exact: true }).click();
      await expect(page.locator('[data-parity="custom.textarea"]')).toHaveValue("wtf");
      await submit("ignore");
      const skip = page.getByRole("region", { name: "Use the usual answer?", exact: true });
      await expect(skip).toBeVisible();
      await expect(
        skip.getByRole("button", { name: "Let me answer again", exact: true }),
      ).toBeVisible();
      expect(await backend.answers()).toEqual(before);
      await capture("success-skip");
      await skip.getByRole("button", { name: /^Yes, / }).click();
      await expect.poll(async () => (await backend.card())?.pendingCheck).toBeNull();
      expect(
        (await backend.card())?.answeredSummaries.find((answer) => answer.answerKey === "success")
          ?.detail,
      ).toBe("Train consistently");
      await edit("Success");
      await submit("Ride four steady hours");
      const understood = page.getByRole("region", { name: "Did I read this right?", exact: true });
      await expect(
        understood.getByRole("row", { name: "I understood Ride four steady hours", exact: true }),
      ).toBeVisible();
      await capture("success-understood");
      await understood.getByRole("button", { name: "Confirm", exact: true }).click();
      await expect.poll(async () => (await backend.card())?.pendingCheck).toBeNull();
      await edit("Main Goal");
      await page.locator('[data-answer="event-not-listed"]').click();
      await page
        .getByRole("textbox", { name: "Event name", exact: true })
        .fill("an event sometime");
      await page.getByLabel("Event date", { exact: true }).fill("1998-11-08");
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      const eventAsk = page.getByRole("region", {
        name: "I could not use that answer",
        exact: true,
      });
      await expect(eventAsk).toBeVisible();
      await expect(eventAsk.getByRole("button", { name: "Skip for now", exact: true })).toHaveCount(
        0,
      );
      await expect(
        eventAsk.getByRole("button", { name: "Back to list", exact: true }),
      ).toBeVisible();
      await capture("event-ask");
      await eventAsk.getByRole("button", { name: "Answer", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "Event name", exact: true })).toHaveValue(
        "an event sometime",
      );
      await page.getByRole("textbox", { name: "Event name", exact: true }).fill("Autumn ride");
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(understood).toBeVisible();
      await expect(understood.getByText("Plan creation · Event", { exact: true })).toBeVisible();
      await capture("event-understood");
      await understood.getByRole("button", { name: "Confirm", exact: true }).click();
      await expect.poll(async () => (await backend.card())?.pendingCheck).toBeNull();
      expect(
        (await backend.card())?.answeredSummaries.find((answer) => answer.answerKey === "goal")
          ?.answer,
      ).toMatchObject({
        kind: "goal",
        goal: { kind: "event-manual", name: "Autumn ride", date: "1998-11-08" },
      });
      expect(
        backend.checker.calls
          .filter((call) => call.context.field === "event")
          .map((call) => call.text),
      ).toEqual(["an event sometime", "Autumn ride"]);
    } finally {
      await browser?.close().catch(() => {});
      try {
        if (fixture !== undefined)
          expect(await fixture.close()).toEqual({ livePids: [], listenerCount: 0 });
      } finally {
        await backend.close();
        await rm(scratch, { recursive: true, force: true });
      }
    }
  });
}
