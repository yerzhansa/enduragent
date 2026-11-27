import { expect, test } from "@playwright/test";
import { addCivilDays } from "@enduragent/kernel/planning";
import { close, isoDay, launch, openCalendar, snap } from "../helpers/calendar-app.js";

const MONDAY = 19980105;

function sheet(scenario: Awaited<ReturnType<typeof launch>>) {
  return scenario.page.locator("[data-approve-sheet]");
}

function weekHeader(scenario: Awaited<ReturnType<typeof launch>>, week: number) {
  return scenario.page
    .getByRole("rowheader")
    .filter({ hasText: `Week ${week}` })
    .first();
}

test.describe("Approving a new Plan's first weeks", () => {
  test("shows the first two Training Weeks for Approve, then sends them to intervals.icu", async ({
    playwright,
  }) => {
    let planId = "";
    const scenario = await launch(
      playwright,
      async (backend) => {
        const seed = await backend.seedActiveTraining();
        if (seed.planId === null) throw new TypeError("Training Plan was not activated");
        planId = seed.planId;
        await backend.calendarIdle();
        return isoDay(MONDAY);
      },
      "light",
      { waitForApprove: true },
    );
    try {
      await openCalendar(scenario);
      const page = scenario.page;
      await expect(sheet(scenario)).toBeVisible();
      await expect(
        sheet(scenario).getByRole("heading", {
          name: "Send the first two Training Weeks to intervals.icu?",
        }),
      ).toBeVisible();
      const approve = sheet(scenario).getByRole("button", { name: /^Approve \d+ workouts?$/u });
      await expect(approve).toBeVisible();
      await expect(page.getByText("Waiting for Approve").first()).toBeVisible();
      expect(
        scenario.calendar.events.filter((event) => event.externalId?.includes(planId)),
      ).toEqual([]);
      await snap(scenario, "approve-sheet-light");
      await approve.click();
      await expect(sheet(scenario)).toBeHidden({ timeout: 30_000 });
      await expect
        .poll(
          () =>
            scenario.calendar.events.filter((event) => event.externalId?.includes(planId)).length,
        )
        .toBeGreaterThan(0);
      await expect(page.getByText("Waiting for Approve")).toHaveCount(0);
      await snap(scenario, "approve-sent-light");
    } finally {
      await close(scenario);
    }
  });

  test("keeps Not now until the Calendar opens again", async ({ playwright }) => {
    const scenario = await launch(
      playwright,
      async (backend) => {
        await backend.seedActiveTraining();
        await backend.calendarIdle();
        return isoDay(MONDAY);
      },
      "light",
      { waitForApprove: true },
    );
    try {
      await openCalendar(scenario);
      await sheet(scenario).getByRole("button", { name: "Not now" }).click();
      await expect(sheet(scenario)).toBeHidden();
      await expect(weekHeader(scenario, 1)).toContainText("Waiting for Approve");
      await scenario.page
        .getByRole("navigation", { name: "Main navigation" })
        .getByRole("button", { name: "Chat", exact: true })
        .click();
      await openCalendar(scenario);
      await expect(sheet(scenario)).toBeVisible();
    } finally {
      await close(scenario);
    }
  });

  test("holds a later week for its own Approve when Approve each week is on", async ({
    playwright,
  }) => {
    const scenario = await launch(playwright, async (backend) => {
      await backend.seedActiveTraining();
      await backend.calendarIdle();
      await backend.saveWeekDeliverySetting("approve-each-week");
      backend.setCivilDate(isoDay(addCivilDays(MONDAY, 7)));
      return isoDay(addCivilDays(MONDAY, 7));
    });
    try {
      await openCalendar(scenario);
      const banner = scenario.page.locator("[data-week-ready]");
      await expect(banner).toContainText("Week 3 is ready:");
      await snap(scenario, "week-ready-banner-light");
      await banner.getByRole("button", { name: "Review and approve" }).click();
      await expect(
        sheet(scenario).getByRole("heading", { name: "Send Week 3 to intervals.icu?" }),
      ).toBeVisible();
      await sheet(scenario)
        .getByRole("button", { name: /^Approve \d+ workouts?$/u })
        .click();
      await expect(sheet(scenario)).toBeHidden({ timeout: 30_000 });
      await expect(banner).toBeHidden();
      await expect(weekHeader(scenario, 3)).toContainText("On intervals.icu");
    } finally {
      await close(scenario);
    }
  });
});
