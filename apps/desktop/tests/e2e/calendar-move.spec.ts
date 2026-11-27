import { expect, test } from "@playwright/test";
import { addCivilDays } from "@enduragent/kernel/planning";
import { cell, close, isoDay, launch, openCalendar, snap } from "../helpers/calendar-app.js";

const MONDAY = 19980105;

test.describe("Moving a workout by hand", () => {
  test("drags a workout to a free day, asks first, and moves it in the Plan and on intervals.icu", async ({
    playwright,
  }) => {
    let planId = "";
    let workoutId = "";
    let fromDateKey = 0;
    let toDateKey = 0;
    const scenario = await launch(playwright, async (backend) => {
      const seed = await backend.seedActiveTraining();
      if (seed.planId === null) throw new TypeError("Training Plan was not activated");
      planId = seed.planId;
      await backend.calendarIdle();
      const workouts = (await backend.physicalWorkouts(planId))
        .filter((workout) => workout.dateKey !== null && workout.dateKey > MONDAY)
        .sort((left, right) => (left.dateKey ?? 0) - (right.dateKey ?? 0));
      const first = workouts[0];
      if (first?.dateKey == null) throw new TypeError("No later workout");
      const busy = new Set(workouts.map((workout) => workout.dateKey));
      let free = addCivilDays(first.dateKey, 1);
      while (busy.has(free)) free = addCivilDays(free, 1);
      workoutId = first.id;
      fromDateKey = first.dateKey;
      toDateKey = free;
      return isoDay(MONDAY);
    });
    try {
      await openCalendar(scenario);
      const page = scenario.page;
      const source = page.locator(`[data-workout-id="${workoutId}"]`);
      await expect(source, "the later workout cannot be dragged").toHaveAttribute(
        "draggable",
        "true",
      );
      await snap(scenario, "move-before-light");
      await source.dragTo(cell(scenario, toDateKey));
      const dialog = page.locator("[data-move-dialog]");
      await expect(dialog, "dropping the workout asks nothing").toBeVisible();
      await expect(dialog).toContainText("It moves on intervals.icu too");
      await expect(cell(scenario, toDateKey).locator("[data-move-preview]")).toBeVisible();
      await snap(scenario, "move-dialog-light");
      const eventBefore = scenario.calendar.events.find((event) =>
        event.externalId?.endsWith(workoutId),
      );
      expect(eventBefore?.dateKey).toBe(fromDateKey);
      await dialog.getByRole("button", { name: "Move", exact: true }).click();
      await expect(dialog).toBeHidden({ timeout: 15_000 });
      const moved = cell(scenario, toDateKey).locator(`[data-workout-id="${workoutId}"]`);
      await expect(moved).toContainText("Moved by you from");
      await expect(
        cell(scenario, fromDateKey).locator(`[data-workout-id="${workoutId}"]`),
      ).toHaveCount(0);
      await expect
        .poll(
          () =>
            scenario.calendar.events.find((event) => event.externalId?.endsWith(workoutId))
              ?.dateKey,
        )
        .toBe(toDateKey);
      expect(
        scenario.calendar.events.find((event) => event.externalId?.endsWith(workoutId))?.id,
      ).toBe(eventBefore?.id);
      await snap(scenario, "move-after-light");
    } finally {
      await close(scenario);
    }
  });
});
