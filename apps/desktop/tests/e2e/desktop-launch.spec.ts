import { expect, test } from "./fixtures/desktop-app.js";
import { launchDesktopFixture } from "../helpers/desktop-fixture.js";

test("launches a deterministic isolated desktop shell", async ({ desktop }) => {
  await expect(desktop.page).toHaveTitle("Enduragent");
  await expect(desktop.page.locator("#root")).toHaveCount(1);
  const shell = desktop.page.locator("[data-shell]");
  await expect(shell).toBeVisible();
  await expect(shell).toHaveAttribute("data-onboarding", "settled", { timeout: 30_000 });
  await expect(shell).toHaveAttribute("data-shell", /^(app|gate)$/);
  await expect(desktop.page.locator("body")).not.toContainText(desktop.paths.athleteHome);
  await expect
    .poll(() => desktop.application.evaluate(({ app }) => app.getPath("userData")))
    .toBe(desktop.paths.userData);
});

test("traces hidden desktop startup through its first navigation", async ({}, testInfo) => {
  const fixture = await launchDesktopFixture({
    script: { onRequest: () => [] },
    token: "s".repeat(43),
    width: 1180,
    height: 820,
    colorScheme: "light",
    reducedMotion: true,
  });
  try {
    const expectedStages = [
      "main-start",
      "single-instance-lock",
      "app-ready",
      "background-at-login",
      "prepare-athlete-home",
      "seed-first-run-config",
      "adopt-device-timezone",
      "resolve-daemon",
      "resolve-athlete-home",
      "prepare-credential-encryption",
      "reapply-credentials",
      "start-telegram",
      "install-protocol",
      ...(process.platform === "win32" ? ["bind-activation"] : []),
      "start-residency",
      "show-main-window",
      "create-browser-window",
      "navigate-main-window",
      "main-window-navigated",
    ];
    await expect
      .poll(() =>
        fixture
          .readCapturedSurface("stderr")
          .split(/\r?\n/)
          .filter((line) => line.startsWith("desktop-startup-stage "))
          .map((line) => line.slice("desktop-startup-stage ".length)),
      )
      .toEqual(expectedStages);
    expect(await fixture.evaluate("return location.href;")).toMatch(/^enduragent:\/\/app\//);
    expect(await fixture.evaluate("return document.title;")).toBe("Enduragent");
  } finally {
    const diagnostics = fixture.readCapturedSurface("stderr");
    const closed = await fixture.close();
    await testInfo.attach("desktop-startup-stages", {
      body: diagnostics,
      contentType: "text/plain",
    });
    expect(closed.livePids).toEqual([]);
    expect(closed.listenerCount).toBe(0);
  }
});
