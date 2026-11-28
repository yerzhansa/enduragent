import { expect, test } from "@playwright/test";
import { addCivilDays } from "@enduragent/kernel/planning";
import { close, isoDay, launch, rideKey, snap } from "../helpers/calendar-app.js";

test.describe("One FTP", () => {
  test("reads a new FTP from intervals.icu, adds a history line, and writes the coach's proposal back after the confirm", async ({
    playwright,
  }) => {
    let today = 0;
    const scenario = await launch(playwright, async (backend) => {
      const seed = await backend.seedActiveTraining();
      if (seed.planId === null) throw new TypeError("Training Plan was not activated");
      await backend.calendarIdle();
      today = 19980301;
      backend.setCivilDate(isoDay(today));
      await backend.seedCalendarRide({
        key: rideKey(1),
        dateKey: addCivilDays(today, -1),
        name: "Synthetic road ride",
        movingS: 3_600,
        distanceM: 28_000,
      });
      await backend.seedCalendarRide({
        key: rideKey(2),
        dateKey: addCivilDays(today, -2),
        name: "Synthetic trainer ride",
        movingS: 3_000,
        distanceM: 0,
        subSport: "indoor_cycling",
      });
      await backend.seedCalendarRide({
        key: rideKey(3),
        dateKey: today,
        name: "Synthetic morning ride",
        movingS: 3_000,
        distanceM: 24_000,
      });
      backend.icuFtp.settings = {
        id: 77,
        ftp: 268,
        indoorFtp: null,
        updated: `${isoDay(addCivilDays(today, -60))}T08:00:00.120+00:00`,
      };
      await backend.syncFtp();
      return isoDay(today);
    });
    try {
      const page = scenario.page;
      const activities = page.getByRole("navigation", { name: "Activities" });
      await page
        .getByRole("navigation", { name: "Main navigation" })
        .getByRole("button", { name: "Activity review", exact: true })
        .click();
      await expect(page.locator('[data-activity-review-state="ready"]')).toBeVisible();
      await activities.locator(`[data-ride-id="${rideKey(1)}"]`).click();
      const line = page.locator("[data-ride-ftp]");
      await expect(line).toContainText("FTP 268 W from intervals.icu.");
      await line.getByRole("button", { name: "FTP history" }).click();
      const sheet = page.getByRole("complementary", { name: "FTP" });
      const history = sheet.getByRole("table", { name: "FTP history" }).locator("tbody");
      await expect(history.getByRole("row")).toHaveCount(1);
      await expect(history).toContainText("268 WIn intervals.icu when the app first synced");
      await expect(sheet.locator("[data-ftp-current]")).toContainText("268 W in intervals.icu");
      await expect(sheet.getByRole("region", { name: "The coach’s FTP proposal" })).toHaveCount(0);
      await snap(scenario, "one-ftp-history-before");
      await sheet.getByRole("button", { name: "Close" }).click();
      await expect(sheet).toBeHidden();
      await expect(line.getByRole("button", { name: "FTP history" })).toBeFocused();

      await scenario.backend.landIcuEstimates(
        Array.from({ length: 14 }, (_, offset) => addCivilDays(today, -offset)),
        291,
      );
      scenario.backend.icuFtp.settings = {
        id: 77,
        ftp: 282,
        indoorFtp: 274,
        updated: `${isoDay(addCivilDays(today, -20))}T18:02:00.345+00:00`,
      };
      await scenario.backend.syncFtp();

      await line.getByRole("button", { name: "FTP history" }).click();
      await expect(history.getByRole("row")).toHaveCount(2);
      await expect(history.getByRole("row").first()).toContainText(
        "282 WSet by you in intervals.icu",
      );
      await expect(sheet.locator("[data-ftp-current]")).toContainText(
        "282 W set by you in intervals.icu on",
      );
      const card = sheet.getByRole("region", { name: "The coach’s FTP proposal" });
      await expect(card).toContainText(
        "intervals.icu’s estimate has stayed above your FTP for 14 days",
      );
      await expect(card).toContainText(
        "The coach proposes 288 W, just under your lowest estimate in 14 days (291 W).",
      );
      await snap(scenario, "one-ftp-proposal");
      await card.getByRole("button", { name: "Use 288 W from today" }).click();
      const confirm = sheet.getByRole("region", {
        name: "Set your FTP to 288 W in intervals.icu?",
      });
      await expect(
        confirm.getByRole("heading", { name: "Set your FTP to 288 W in intervals.icu?" }),
      ).toBeFocused();
      await expect(confirm).toContainText(
        "Ride FTP in your intervals.icu settings: 282 W → 288 W, from today",
      );
      await expect(confirm).toContainText("Past rides keep 282 W. Your indoor FTP is not touched.");
      await snap(scenario, "one-ftp-confirm");
      expect(scenario.backend.icuFtp.writes).toEqual([]);
      scenario.backend.setSyncClock(Date.parse(`${isoDay(today)}T18:00:00.000Z`));
      await confirm.getByRole("button", { name: "Set 288 W in intervals.icu" }).click();
      const written = sheet.getByRole("status");
      await expect(written).toContainText(
        "Your FTP in intervals.icu is now 288 W. Every planned workout follows it from today.",
      );
      await expect(written).toBeFocused();
      expect(scenario.backend.icuFtp.writes.map((write) => write.watts)).toEqual([288]);
      expect(scenario.backend.icuFtp.writes[0]?.body).toMatchObject({
        ftp: 288,
        indoor_ftp: 274,
        lthr: 168,
        w_prime: 18_500,
      });
      expect(scenario.backend.icuFtp.settings.indoorFtp).toBe(274);
      await expect(history.getByRole("row").first()).toContainText(
        "288 WCoach’s proposal from intervals.icu’s estimate; you chose Use",
      );
      await expect(sheet.getByRole("region", { name: "The coach’s FTP proposal" })).toHaveCount(0);
      await snap(scenario, "one-ftp-written");
      await sheet.getByRole("button", { name: "Close" }).click();

      await activities.locator(`[data-ride-id="${rideKey(3)}"]`).click();
      await expect(line).toContainText("FTP 282 W, set by you in intervals.icu on");
      await snap(scenario, "one-ftp-same-day");
      await activities.locator(`[data-ride-id="${rideKey(1)}"]`).click();
      await expect(line).toContainText("FTP 282 W, set by you in intervals.icu on");
      await activities.locator(`[data-ride-id="${rideKey(2)}"]`).click();
      const indoor = page.locator("[data-ftp-indoor]");
      await expect(indoor).toContainText("FTP 274 W indoor · set by you in intervals.icu on");
      await expect(indoor).toContainText("Outdoor rides use 282 W.");
      await snap(scenario, "one-ftp-indoor");
    } finally {
      await close(scenario);
    }
  });

  test("Plan a 20-minute test keeps an existing Chat draft and adds the request after it", async ({
    playwright,
  }) => {
    const scenario = await launch(
      playwright,
      async (backend) => {
        const seed = await backend.seedActiveTraining();
        if (seed.planId === null) throw new TypeError("Training Plan was not activated");
        await backend.calendarIdle();
        const today = 19980301;
        backend.setCivilDate(isoDay(today));
        await backend.seedCalendarRide({
          key: rideKey(1),
          dateKey: addCivilDays(today, -1),
          name: "Synthetic road ride",
          movingS: 3_600,
          distanceM: 28_000,
        });
        backend.icuFtp.settings = {
          id: 77,
          ftp: 268,
          indoorFtp: null,
          updated: `${isoDay(addCivilDays(today, -60))}T08:00:00.120+00:00`,
        };
        await backend.syncFtp();
        await backend.landIcuEstimates(
          Array.from({ length: 14 }, (_, offset) => addCivilDays(today, -offset)),
          291,
        );
        backend.icuFtp.settings = {
          id: 77,
          ftp: 282,
          indoorFtp: null,
          updated: `${isoDay(addCivilDays(today, -20))}T18:02:00.345+00:00`,
        };
        await backend.syncFtp();
        return isoDay(today);
      },
      "light",
      { keepsDraftText: true },
    );
    try {
      const page = scenario.page;
      const composer = page.locator("textarea#message");
      await expect(composer).toBeVisible();
      await composer.fill("Keep my existing draft");
      await page
        .getByRole("navigation", { name: "Main navigation" })
        .getByRole("button", { name: "Activity review", exact: true })
        .click();
      await expect(page.locator('[data-activity-review-state="ready"]')).toBeVisible();
      await page.locator("[data-ride-ftp]").getByRole("button", { name: "FTP history" }).click();
      const card = page
        .getByRole("complementary", { name: "FTP" })
        .getByRole("region", { name: "The coach’s FTP proposal" });
      await expect(card).toBeVisible();
      await card.getByRole("button", { name: "Plan a 20-minute test" }).click();
      await expect(composer).toHaveValue(
        "Keep my existing draft\n\nPlease add a 20-minute FTP test to my Plan.",
      );
      await snap(scenario, "one-ftp-plan-test-draft");
      expect(scenario.backend.icuFtp.writes).toEqual([]);
    } finally {
      await close(scenario);
    }
  });
});
