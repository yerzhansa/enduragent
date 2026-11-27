import { expect, test } from "@playwright/test";
import { addCivilDays } from "@enduragent/kernel/planning";
import { cell, close, isoDay, launch, openCalendar, snap } from "../helpers/calendar-app.js";

const MONDAY = 19980105;

function nameOf(structureJson: string): string {
  const structure: unknown = JSON.parse(structureJson);
  if (structure === null || typeof structure !== "object" || !("name" in structure))
    throw new TypeError("Stored Workout has no name");
  return String(structure.name);
}

test.describe("The workout card", () => {
  test("opens over the grid, moves the workout a day with Move…, and asks the coach in Chat without sending", async ({
    playwright,
  }) => {
    let workoutId = "";
    let workoutName = "";
    let fromDateKey = 0;
    let toDateKey = 0;
    const scenario = await launch(
      playwright,
      async (backend) => {
        const seed = await backend.seedActiveTraining();
        if (seed.planId === null) throw new TypeError("Training Plan was not activated");
        await backend.calendarIdle();
        const workouts = (await backend.physicalWorkouts(seed.planId))
          .filter((workout) => workout.dateKey !== null && workout.dateKey > MONDAY)
          .sort((left, right) => (left.dateKey ?? 0) - (right.dateKey ?? 0));
        const busy = new Set(workouts.map((workout) => workout.dateKey));
        const chosen = workouts.find(
          (workout) =>
            workout.dateKey !== null &&
            !busy.has(addCivilDays(workout.dateKey, 1)) &&
            addCivilDays(workout.dateKey, 1) < addCivilDays(MONDAY, 14),
        );
        if (chosen?.dateKey == null) throw new TypeError("No workout with a free next day");
        workoutId = chosen.id;
        workoutName = nameOf(chosen.structureJson);
        fromDateKey = chosen.dateKey;
        toDateKey = addCivilDays(chosen.dateKey, 1);
        return isoDay(MONDAY);
      },
      "light",
      { keepsDraftText: true },
    );
    try {
      await openCalendar(scenario);
      const page = scenario.page;
      const source = page.locator(`[data-workout-id="${workoutId}"]`);
      await source.click();
      const card = page.getByRole("dialog", { name: workoutName, exact: true });
      await expect(card, "clicking a workout opens no card").toBeVisible();
      await expect(card).toContainText("Plan Workout");
      await expect(card.locator("[data-workout-copy]")).toHaveText("On intervals.icu");
      await expect(card.getByRole("heading", { name: workoutName })).toBeFocused();
      await expect(source).toHaveAttribute("aria-expanded", "true");
      await snap(scenario, "workout-card-light");
      await card.getByRole("button", { name: "Move…", exact: true }).click();
      await expect(card).toBeHidden();
      const dialog = page.locator("[data-move-dialog]");
      await expect(dialog, "Move… opens no move dialog").toBeVisible();
      await expect(cell(scenario, toDateKey).locator("[data-move-preview]")).toBeVisible();
      await snap(scenario, "workout-card-move-light");
      await dialog.getByRole("button", { name: "Move", exact: true }).click();
      await expect(dialog).toBeHidden({ timeout: 15_000 });
      const moved = cell(scenario, toDateKey).locator(`[data-workout-id="${workoutId}"]`);
      await expect(moved).toContainText("Moved by you from");
      await expect(
        cell(scenario, fromDateKey).locator(`[data-workout-id="${workoutId}"]`),
      ).toHaveCount(0);
      await expect(moved, "focus does not come back to the moved workout").toBeFocused();
      await expect
        .poll(
          () =>
            scenario.calendar.events.find((event) => event.externalId?.endsWith(workoutId))
              ?.dateKey,
        )
        .toBe(toDateKey);
      await snap(scenario, "workout-card-moved-light");
      await page.keyboard.press("Enter");
      await expect(card).toBeVisible();
      await card.getByRole("button", { name: "Ask the coach to change it", exact: true }).click();
      const composer = page.locator("#message");
      await expect(composer).toBeVisible();
      await expect(composer).toHaveValue(new RegExp(`^Please change ${workoutName} on `, "u"));
      await snap(scenario, "workout-card-ask-light");
      expect(scenario.backend.chatSubmissions, "asking the coach sent a message").toBe(0);
    } finally {
      await close(scenario);
    }
  });
});
