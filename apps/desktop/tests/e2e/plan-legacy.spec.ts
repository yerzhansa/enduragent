import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Browser } from "@playwright/test";
import { launchDesktopFixture, type RunningDesktopFixture } from "../helpers/desktop-fixture.js";
import { PlanCreationBackend } from "../helpers/plan-creation-backend.js";

test("shows the saved legacy Plan as a read-only closed card", async ({ playwright }) => {
  const scratch = await mkdtemp(join(tmpdir(), "plan-legacy-"));
  const backend = new PlanCreationBackend(join(scratch, "store.db"), false, true, {
    legacy: {
      name: "Earlier endurance training",
      goal: "Ride comfortably for four hours",
      weeks: 8,
      sourceStatus: "active",
      createdAt: "1998-07-06",
      targetDate: "1998-08-30",
      readOnly: true,
      source: "current-plan.json",
    },
  });
  let fixture: RunningDesktopFixture | undefined;
  let browser: Browser | undefined;
  try {
    backend.setCivilDate("1998-01-03");
    await backend.open();
    await backend.seedLibrary({ creation: false, active: true, closed: true });
    fixture = await launchDesktopFixture({
      script: backend.script,
      token: "d".repeat(43),
      width: 1180,
      height: 820,
      colorScheme: "light",
      reducedMotion: true,
      hidden: true,
      routeChatAttachmentComposer: true,
    });
    await fixture.setViewport(1180, 820);
    browser = await playwright.chromium.connectOverCDP(fixture.remoteDebuggingUrl);
    const page = browser
      .contexts()[0]
      ?.pages()
      .find((candidate) => candidate.url().startsWith("enduragent://app/"));
    if (page === undefined) throw new TypeError("Plan library renderer is unavailable");
    await expect(page.locator("[data-shell]")).toHaveAttribute("data-onboarding", "settled", {
      timeout: 30_000,
    });
    await page.clock.setFixedTime(new Date("1998-01-03T12:00:00Z"));
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("button", { name: "Plan", exact: true })
      .click();
    const cards = page.getByRole("region", { name: "Closed Plan", exact: true });
    await expect(cards).toHaveCount(4);
    const legacy = cards.last();
    await expect(legacy.getByText("Closed Plan", { exact: true })).toBeVisible();
    await expect(
      legacy.getByRole("heading", { name: "Earlier endurance training", exact: true }),
    ).toBeVisible();
    await expect(legacy.getByText("Closed", { exact: true })).toBeVisible();
    await expect(
      legacy.getByText(
        "Target 30 Aug 1998 · 8 weeks · Goal: Ride comfortably for four hours · Unknown reason",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      legacy.getByText("Read only · Saved before Plans moved to Chat", { exact: true }),
    ).toBeVisible();
    await expect(legacy.getByRole("button")).toHaveCount(0);
    await expect(legacy.getByRole("link")).toHaveCount(0);
  } finally {
    await browser?.close().catch(() => {});
    try {
      if (fixture !== undefined) {
        const cleanup = await fixture.close();
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
