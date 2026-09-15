import { expect, test } from "./fixtures/chat-desktop.js";

for (const appearance of ["light", "dark"] as const) {
  for (const width of [1180, 760]) {
    test(`Settings hides training account in ${appearance} at ${width}`, async ({
      chatDesktop,
    }, info) => {
      const { page } = chatDesktop;
      await page.setViewportSize({ width, height: 820 });
      await page.emulateMedia({ colorScheme: appearance, reducedMotion: "reduce" });
      const navigation = page.getByRole("navigation", { name: "Main navigation" });
      await navigation.getByRole("button", { name: "Settings", exact: true }).click();
      await page
        .getByRole("button", { name: appearance === "dark" ? "Dark" : "Light", exact: true })
        .click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", appearance);
      await expect(
        page.getByRole("heading", { name: "Training account", exact: true }),
      ).toHaveCount(0);
      await expect(page.getByRole("region", { name: "Training account", exact: true })).toHaveCount(
        0,
      );
      await expect(page.getByLabel("Athlete ID", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Save athlete ID" })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Coach", exact: true })).toBeVisible();
      await page
        .getByRole("heading", { name: "Conversation & time", exact: true })
        .scrollIntoViewIfNeeded();
      await expect(page.getByLabel("Timezone", { exact: true })).toBeVisible();
      await expect(page.getByLabel("Daily reset hour", { exact: true })).toHaveCount(0);
      await expect(page.getByLabel("Idle reset (minutes)", { exact: true })).toHaveCount(0);
      await expect(page.getByLabel("Archive retention (days)", { exact: true })).toHaveCount(0);
      await expect(page.getByLabel("History budget (%)", { exact: true })).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Save conversation settings", exact: true }),
      ).toHaveCount(0);
      await page.screenshot({ path: info.outputPath("settings-account-hidden.png") });
      await navigation.getByRole("button", { name: "Chat", exact: true }).click();
      await expect(page.getByRole("combobox", { name: "Message your coach" })).toBeVisible();
      await navigation.getByRole("button", { name: "Settings", exact: true }).click();
      await expect(page.getByLabel("Athlete ID", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Setup", exact: true })).toBeVisible();
      await expect(page.getByText("Intervals.icu", { exact: true }).first()).toBeVisible();
      await page.screenshot({ path: info.outputPath("settings-setup-preserved.png") });
    });
  }
}
