import { writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/chat-desktop.js";

const SAVED_RIDES_SUBTITLE = "Rides saved on this Mac · connect to sync new ones";
const FIRST_TIME_SUBTITLE = "Connect or import ride files.";

async function dropRideFile(page: Page, path: string): Promise<void> {
  const session = await page.context().newCDPSession(page);
  const data = { items: [], files: [path], dragOperationsMask: 1 };
  try {
    for (const type of ["dragEnter", "dragOver", "drop"] as const) {
      await session.send("Input.dispatchDragEvent", { type, x: 400, y: 300, data });
    }
  } finally {
    await session.detach();
  }
}

test.describe("first-run setup without Intervals.icu", () => {
  test.use({ durableTrainingData: false });

  test("a ride import marks the Intervals.icu row ready with the 2 of 2 badge", async ({
    chatDesktop,
  }, info) => {
    const { page } = chatDesktop;
    const gate = page.locator('[data-setup-host="gate"]');
    const badge = gate.locator("[data-setup-readiness]");
    const row = gate.locator('[data-setup-row="training"]');
    const start = gate.getByRole("button", { name: "Start coaching" });

    await expect(badge).toHaveText("1 of 2 required ready");
    await expect(row).toHaveAttribute("data-state", "pending");
    await expect(row).toContainText(FIRST_TIME_SUBTITLE);
    await expect(start).toBeDisabled();
    await page.screenshot({ path: info.outputPath("gate-before-import.png") });

    const ride = info.outputPath("synthetic-ride.fit");
    await writeFile(ride, "synthetic ride file\n");
    await dropRideFile(page, ride);

    await expect(badge).toHaveText("2 of 2 required ready");
    await expect(start).toBeEnabled();
    await expect(
      row,
      "the Intervals.icu row should read ready once the badge counts the imported rides",
    ).toHaveAttribute("data-state", "ready");
    await expect(row.locator('[data-setup-disc="ready"]')).toBeVisible();
    await expect(row).toContainText(SAVED_RIDES_SUBTITLE);
    await expect(gate.getByRole("button", { name: "Connect Intervals.icu" })).toBeEnabled();
    await page.screenshot({ path: info.outputPath("gate-after-import.png") });
  });
});

for (const width of [1180, 760]) {
  test(`Settings Setup shows saved rides as ready without Intervals.icu at ${width}`, async ({
    chatDesktop,
  }, info) => {
    const { page } = chatDesktop;
    await page.setViewportSize({ width, height: 820 });
    await expect(page.getByRole("combobox", { name: "Message your coach" })).toBeEnabled();
    const navigation = page.getByRole("navigation", { name: "Main navigation" });
    await navigation.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Setup", exact: true })).toBeVisible();

    const row = page.locator('[data-setup-host="settings"] [data-setup-row="training"]');
    await expect(row).toBeVisible();
    await expect(
      row,
      "the Intervals.icu row should read ready when coaching already runs on saved rides",
    ).toHaveAttribute("data-state", "ready");
    await expect(row.locator('[data-setup-disc="ready"]')).toBeVisible();
    await expect(row).toContainText(SAVED_RIDES_SUBTITLE);
    await expect(row).not.toContainText(FIRST_TIME_SUBTITLE);
    await expect(page.getByRole("button", { name: "Connect Intervals.icu" })).toBeEnabled();
    await page.screenshot({ path: info.outputPath("settings-setup-saved-rides.png") });
  });
}
