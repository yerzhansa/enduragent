import { expect, test } from "@playwright/test";
import type { PlanMirrorEvent } from "@enduragent/engine";
import { close, isoDay, launch, openCalendar, snap } from "../helpers/calendar-app.js";

const MONDAY = 19980105;

test.describe("Plan details", () => {
  test("ends the Plan from Plan details and keeps the workout the athlete changed", async ({
    playwright,
  }) => {
    let planId = "";
    let changed: PlanMirrorEvent | undefined;
    const scenario = await launch(playwright, async (backend, calendar) => {
      const seed = await backend.seedActiveTraining();
      if (seed.planId === null) throw new TypeError("Training Plan was not activated");
      planId = seed.planId;
      await backend.calendarIdle();
      changed = calendar.events
        .filter((event) => event.externalId?.includes(planId) === true && event.dateKey > MONDAY)
        .sort((left, right) => left.dateKey - right.dateKey)[0];
      if (changed === undefined) throw new TypeError("No later workout on intervals.icu");
      calendar.editByAthlete(changed.id, { name: "My own long ride" });
      await backend.calendarRun();
      return isoDay(MONDAY);
    });
    try {
      if (changed === undefined) throw new TypeError("No changed workout");
      await openCalendar(scenario);
      const page = scenario.page;
      await page.getByRole("button", { name: "Plan details", exact: true }).click();
      const sheet = page.locator("[data-plan-details]");
      await expect(sheet.getByRole("heading", { name: "Plan details" })).toBeVisible();
      await expect(sheet).toContainText("Plan saved");
      await snap(scenario, "details-light");
      await sheet.getByRole("button", { name: "End Plan", exact: true }).click();
      const confirm = page.locator("[data-end-confirm]");
      await expect(confirm).toContainText("from tomorrow on.");
      await expect(confirm).toContainText("you changed in intervals.icu stays, as your own");
      await expect(confirm).toContainText("My own long ride");
      await snap(scenario, "end-confirm-light");
      const laterPlanEvents = () =>
        scenario.calendar.events.filter(
          (event) => event.externalId?.includes(planId) === true && event.dateKey > MONDAY,
        );
      expect(laterPlanEvents().length).toBeGreaterThan(1);
      await confirm.getByRole("button", { name: "End Plan", exact: true }).click();
      await expect(sheet).toBeHidden({ timeout: 15_000 });
      await expect(page.getByRole("heading", { name: "No Plan yet" })).toBeVisible({
        timeout: 15_000,
      });
      await expect.poll(() => laterPlanEvents().map((event) => event.id)).toEqual([changed.id]);
      await snap(scenario, "ended-light");
    } finally {
      await close(scenario);
    }
  });
});
