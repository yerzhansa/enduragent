import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { launchDesktopFixture, type RunningDesktopFixture } from "../helpers/desktop-fixture.js";
import { PlanCreationBackend } from "../helpers/plan-creation-backend.js";

const commitments = "Keep Tuesday evenings free and finish Sunday rides before noon.";
const previews = fileURLToPath(new URL("./previews/plan-creation-commitments/", import.meta.url));

async function capture(page: Page, name: string): Promise<void> {
  const path = join(previews, `${name}.png`);
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path });
  await test.info().attach(name, { path, contentType: "image/png" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const appearance of [
  { width: 1180, colorScheme: "light" },
  { width: 1180, colorScheme: "dark" },
  { width: 720, colorScheme: "light" },
  { width: 720, colorScheme: "dark" },
] as const) {
  test(`confirms written commitments before opening Plan activation at ${appearance.width} in ${appearance.colorScheme}`, async ({
    playwright,
  }) => {
    test.setTimeout(120_000);
    const scratch = await mkdtemp(join(tmpdir(), "plan-commitments-"));
    const backend = new PlanCreationBackend(join(scratch, "store.db"), false, true);
    let fixture: RunningDesktopFixture | undefined;
    let browser: Browser | undefined;
    try {
      await backend.open();
      const creation = await backend.seedTrainingCreation({ kind: "authored", text: commitments });
      fixture = await launchDesktopFixture({
        script: backend.script,
        token: "d".repeat(43),
        width: appearance.width,
        height: 1000,
        colorScheme: appearance.colorScheme,
        reducedMotion: true,
        hidden: true,
        routeChatAttachmentComposer: true,
      });
      await fixture.setViewport(appearance.width, 1000);
      browser = await playwright.chromium.connectOverCDP(fixture.remoteDebuggingUrl);
      const page = browser
        .contexts()[0]
        ?.pages()
        .find((candidate) => candidate.url().startsWith("enduragent://app/"));
      if (page === undefined) throw new TypeError("Plan Creation renderer is unavailable");
      await expect(page.locator("[data-shell]")).toHaveAttribute("data-onboarding", "settled", {
        timeout: 30_000,
      });
      await page.emulateMedia({ colorScheme: appearance.colorScheme, reducedMotion: "reduce" });
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
      await expect(page.locator("html")).toHaveAttribute("data-theme", appearance.colorScheme);
      await page.getByRole("button", { name: "Build Draft", exact: true }).click();
      await expect.poll(async () => (await backend.card())?.version).toBe(creation.version + 1);
      const draft = await backend.card();
      if (draft === null) throw new TypeError("Built Draft is unavailable");
      expect(draft).toMatchObject({
        status: "review",
        draftStale: false,
        commitmentsAcknowledgement: { text: commitments },
      });
      const heading = page.getByRole("heading", {
        name: "Confirm your written commitments",
        exact: true,
      });
      await expect(heading).toBeVisible();
      await expect(page.getByText("Not yet confirmed", { exact: true })).toBeVisible();
      const activate = page.getByRole("button", { name: "Activate Plan", exact: true });
      await expect(activate).toBeDisabled();
      await expect(activate).toHaveAttribute("aria-describedby", /\S+/);
      const edit = page.getByRole("button", { name: "Edit commitments", exact: true });
      await expect(edit).toBeVisible();
      await heading.scrollIntoViewIfNeeded();
      await capture(page, `pending-commitments-${appearance.width}-${appearance.colorScheme}`);
      await edit.click();
      await expect(page.locator('[data-parity="custom.textarea"]')).toHaveValue(commitments);
      await capture(page, `edit-commitments-${appearance.width}-${appearance.colorScheme}`);
      await page.getByRole("button", { name: "Back to answers", exact: true }).click();
      await expect(heading).toBeVisible();
      await expect(activate).toBeDisabled();
      await page.getByRole("button", { name: "Confirm limits", exact: true }).click();
      await expect.poll(async () => (await backend.card())?.commitmentsAcknowledgement).toBeNull();
      expect(await backend.card()).toMatchObject({ draftStale: false });
      await expect(heading).toHaveCount(0);
      await expect(activate).toBeEnabled();
      await expect(activate).toBeFocused();
      const answers = backend.creationRequests.filter(
        (request) => request.method === "plan_creation.answer",
      );
      expect(answers).toHaveLength(1);
      expect(answers[0]?.params).toEqual({
        commandId: expect.any(String),
        creationId: draft.creationId,
        expectedVersion: draft.version,
        answer: {
          kind: "commitments",
          commitments: { kind: "authored", text: commitments, acknowledged: true },
        },
      });
      await activate.click();
      const dialog = page.getByRole("dialog", { name: "Activate Plan?", exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
      await capture(page, `activation-confirmation-${appearance.width}-${appearance.colorScheme}`);
    } finally {
      await browser?.close().catch(() => {});
      try {
        if (fixture !== undefined) {
          const cleanup = await fixture.close();
          await test.info().attach("cleanup", {
            body: JSON.stringify(cleanup),
            contentType: "application/json",
          });
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
