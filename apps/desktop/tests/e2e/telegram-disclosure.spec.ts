import { expect, test } from "./fixtures/chat-desktop.js";

for (const appearance of ["light", "dark"] as const) {
  for (const width of [1180, 760]) {
    test(`Telegram ${appearance} ${width} setup opens only after Connect and collapses on Settings reentry`, async ({
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
      const telegram = page.getByRole("region", { name: "Telegram", exact: true });
      await telegram.scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath("telegram-entry.png") });
      const connect = telegram.getByRole("button", { name: "Connect", exact: true });
      await expect(connect).toBeVisible();
      await expect(telegram.getByText("Connect a Telegram bot with a copied token.")).toBeVisible();
      await expect(
        telegram.getByRole("button", { name: "Paste token from clipboard" }),
      ).toHaveCount(0);
      await connect.click();
      await expect(
        telegram.getByRole("heading", { name: "Create a bot with BotFather" }),
      ).toBeFocused();
      await expect(
        telegram.getByRole("button", { name: "Paste token from clipboard" }),
      ).toBeVisible();
      await page.screenshot({ path: info.outputPath("telegram-expanded.png") });
      await telegram.getByRole("button", { name: "Cancel Telegram bot setup" }).click();
      await expect(connect).toBeFocused();
      await connect.click();
      await navigation.getByRole("button", { name: "Chat", exact: true }).click();
      await navigation.getByRole("button", { name: "Settings", exact: true }).click();
      await expect(connect).toBeVisible();
      await expect(
        telegram.getByRole("button", { name: "Paste token from clipboard" }),
      ).toHaveCount(0);
    });
  }
}
