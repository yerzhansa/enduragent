import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures/chat-desktop.js";

const NOT_WORKING_SUBTITLE = "Signed in, but not working yet";
const NOT_WORKING_ERROR =
  "Your Intervals.icu sign-in is saved, but Enduragent couldn’t start using it. Choose Retry saved keys, or Disconnect and sign in again.";

async function expectRecoveryOffered(page: Page, host: Locator): Promise<void> {
  const recovery = host.locator('[data-setup-panel="training-recovery"]');
  await expect(recovery).toContainText(NOT_WORKING_ERROR);
  await expect(recovery).not.toContainText("Reload credential status");
  await expect(
    host.getByRole("button", { name: "Retry saved keys" }),
    "keyboard focus should land on the recovery step, not on Disconnect",
  ).toBeFocused();
  await expect(page.getByRole("button", { name: "Disconnect Intervals.icu" })).not.toBeFocused();
}

async function signInToIntervals(
  page: Page,
  host: Locator,
  approveIntervalsSignIn: () => Promise<void>,
): Promise<void> {
  await host.getByRole("button", { name: "Connect Intervals.icu" }).click();
  await host.getByRole("button", { name: "Sign in with Intervals.icu" }).click();
  await approveIntervalsSignIn();
  await expect(page.locator('[data-setup-panel="training"]')).toHaveCount(0);
}

test.describe("first-run setup when the Intervals.icu sign-in cannot be used", () => {
  test.use({ durableTrainingData: false, intervalsRuntimeApplies: false });

  test("the Intervals.icu row needs attention while the badge says 1 of 2", async ({
    chatDesktop,
  }, info) => {
    const { page } = chatDesktop;
    const gate = page.locator('[data-setup-host="gate"]');
    const badge = gate.locator("[data-setup-readiness]");
    const row = gate.locator('[data-setup-row="training"]');
    await expect(badge).toHaveText("1 of 2 required ready");
    await expect(row).toHaveAttribute("data-state", "pending");

    await signInToIntervals(page, gate, chatDesktop.approveIntervalsSignIn);

    await expect(gate.getByRole("button", { name: "Retry saved keys" })).toBeVisible();
    await expect(badge).toHaveText("1 of 2 required ready");
    await expect(gate.getByRole("button", { name: "Start coaching" })).toBeDisabled();
    await expect(
      row,
      "the Intervals.icu row should not look connected while setup still says 1 of 2",
    ).toHaveAttribute("data-state", "attention");
    await expect(row.locator('[data-setup-disc="ready"]')).toHaveCount(0);
    await expect(row).toContainText(NOT_WORKING_SUBTITLE);
    await expect(row).not.toContainText("where your rides come from");
    await expect(gate.getByRole("button", { name: "Disconnect Intervals.icu" })).toBeEnabled();
    await expectRecoveryOffered(page, gate);
    await page.screenshot({ path: info.outputPath("gate-sign-in-not-working.png") });
  });
});

test.describe("first-run setup when the Intervals.icu sign-in works", () => {
  test.use({ durableTrainingData: false, intervalsRuntimeApplies: true });

  test("the Intervals.icu row reads connected and the badge says 2 of 2", async ({
    chatDesktop,
  }) => {
    const { page } = chatDesktop;
    const gate = page.locator('[data-setup-host="gate"]');
    const row = gate.locator('[data-setup-row="training"]');

    await signInToIntervals(page, gate, chatDesktop.approveIntervalsSignIn);

    await expect(gate.locator("[data-setup-readiness]")).toHaveText("2 of 2 required ready");
    await expect(row).toHaveAttribute("data-state", "ready");
    await expect(row).toContainText("Connected as Test Athlete · where your rides come from");
    await expect(gate.getByRole("button", { name: "Retry saved keys" })).toHaveCount(0);
  });
});

test.describe("Settings when the Intervals.icu sign-in cannot be used", () => {
  test.use({ durableTrainingData: true, intervalsRuntimeApplies: false });

  test("the Intervals.icu row needs attention even with saved rides", async ({
    chatDesktop,
  }, info) => {
    const { page } = chatDesktop;
    const navigation = page.getByRole("navigation", { name: "Main navigation" });
    await navigation.getByRole("button", { name: "Settings", exact: true }).click();
    const setup = page.locator('[data-setup-host="settings"]');
    const row = setup.locator('[data-setup-row="training"]');
    await expect(row).toHaveAttribute("data-state", "ready");

    await signInToIntervals(page, setup, chatDesktop.approveIntervalsSignIn);

    await expect(setup.getByRole("button", { name: "Retry saved keys" })).toBeVisible();
    await expect(
      row,
      "the Intervals.icu row should not look connected when its sign-in is not working",
    ).toHaveAttribute("data-state", "attention");
    await expect(row).toContainText(NOT_WORKING_SUBTITLE);
    await expect(row).not.toContainText("where your rides come from");
    await expectRecoveryOffered(page, setup);
    await page.screenshot({ path: info.outputPath("settings-sign-in-not-working.png") });
  });
});
