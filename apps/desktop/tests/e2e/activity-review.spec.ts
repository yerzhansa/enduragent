import { expect, test } from "@playwright/test";
import { addCivilDays } from "@enduragent/kernel/planning";
import { cell, close, isoDay, launch, minutesOf, rideKey, snap } from "../helpers/calendar-app.js";

test.describe("Activity review", () => {
  test("confirms a suggested match on a ride, and the ride and the Calendar show it done", async ({
    playwright,
  }) => {
    let workoutName = "";
    let rideDateKey = 0;
    const scenario = await launch(playwright, async (backend) => {
      const seed = await backend.seedActiveTraining();
      if (seed.planId === null) throw new TypeError("Training Plan was not activated");
      await backend.calendarIdle();
      const workouts = (await backend.physicalWorkouts(seed.planId))
        .flatMap((workout) =>
          workout.dateKey === null ? [] : [{ ...workout, dateKey: workout.dateKey }],
        )
        .sort((left, right) => left.dateKey - right.dateKey);
      const first = workouts[0];
      if (first === undefined) throw new TypeError("Training Plan has no workouts");
      const structure: unknown = JSON.parse(first.structureJson);
      if (
        structure === null ||
        typeof structure !== "object" ||
        !("name" in structure) ||
        typeof structure.name !== "string"
      )
        throw new TypeError("Stored Workout has no name");
      workoutName = structure.name;
      rideDateKey = first.dateKey;
      const today = addCivilDays(first.dateKey, 21);
      backend.setCivilDate(isoDay(today));
      const seconds = Math.round(minutesOf(first.structureJson) * 60);
      await backend.seedCalendarRide({
        key: rideKey(1),
        dateKey: first.dateKey,
        name: "Synthetic road ride",
        movingS: seconds,
        distanceM: seconds * 7,
        match: { planId: seed.planId, planWorkoutId: first.id, decision: "suggested" },
      });
      await backend.recordSuccessfulSync(Date.parse(`${isoDay(today)}T06:00:00Z`));
      return isoDay(today);
    });
    try {
      const page = scenario.page;
      const entry = page
        .getByRole("navigation", { name: "Main navigation" })
        .getByRole("button", { name: "Activity review", exact: true });
      await expect(entry, "the sidebar has no Activity review page").toBeVisible();
      await entry.click();
      await expect(page.locator('[data-activity-review-state="ready"]')).toBeVisible();
      const row = page
        .getByRole("navigation", { name: "Activities" })
        .locator(`[data-ride-id="${rideKey(1)}"]`);
      await expect(row).toContainText("Synthetic road ride");
      await expect(row).toContainText(`Is this ${workoutName}? Confirm`);
      const card = page.getByRole("region", { name: "Plan Workout match" });
      await expect(card).toContainText(`${workoutName}?`);
      await expect(card).toContainText(
        "Until you answer, this ride does not count toward the Plan",
      );
      await snap(scenario, "activity-review-match-light");
      await card.getByRole("button", { name: "Yes, it is" }).click();
      await expect(row).toContainText(/Done as planned|Done differently/u, { timeout: 15_000 });
      await expect(card).toBeHidden();
      await expect(page.getByText(/Plan Workout · confirmed by you/u)).toBeVisible();
      await snap(scenario, "activity-review-confirmed-light");
      await page.getByRole("button", { name: "Show in calendar" }).click();
      await expect(page.locator('[data-calendar-state="ready"]')).toBeVisible();
      await expect(cell(scenario, rideDateKey)).toContainText(/Done as planned|Done differently/u);
      await expect(cell(scenario, rideDateKey)).not.toContainText("Is this it?");
    } finally {
      await close(scenario);
    }
  });

  test("writes the coach's verdict on first open, keeps the athlete's note, and writes again on request", async ({
    playwright,
  }) => {
    const scenario = await launch(playwright, async (backend) => {
      const seed = await backend.seedActiveTraining();
      if (seed.planId === null) throw new TypeError("Training Plan was not activated");
      await backend.calendarIdle();
      const first = (await backend.physicalWorkouts(seed.planId))
        .flatMap((workout) =>
          workout.dateKey === null ? [] : [{ ...workout, dateKey: workout.dateKey }],
        )
        .sort((left, right) => left.dateKey - right.dateKey)[0];
      if (first === undefined) throw new TypeError("Training Plan has no workouts");
      const today = addCivilDays(first.dateKey, 21);
      backend.setCivilDate(isoDay(today));
      const seconds = Math.round(minutesOf(first.structureJson) * 60);
      await backend.seedCalendarRide({
        key: rideKey(2),
        dateKey: first.dateKey,
        name: "Synthetic threshold ride",
        movingS: seconds,
        distanceM: seconds * 7,
        averageWatts: 214,
        match: { planId: seed.planId, planWorkoutId: first.id, decision: "confirmed" },
      });
      backend.verdictReplies.push(
        "Steady from the first minute to the last, and the work matched the Plan.",
        "With heavy legs after Tuesday, holding the targets was the right call.",
      );
      await backend.recordSuccessfulSync(Date.parse(`${isoDay(today)}T06:00:00Z`));
      return isoDay(today);
    });
    try {
      const page = scenario.page;
      await page
        .getByRole("navigation", { name: "Main navigation" })
        .getByRole("button", { name: "Activity review", exact: true })
        .click();
      await expect(page.locator('[data-activity-review-state="ready"]')).toBeVisible();
      const verdict = page.getByRole("region", { name: "Coach’s verdict" });
      await expect(verdict).toContainText(
        "Steady from the first minute to the last, and the work matched the Plan.",
        { timeout: 15_000 },
      );
      await expect(verdict).toContainText(
        /Written at .+, when you first opened this ride, from its file and your Plan · 1 coach reply · kept/u,
      );
      await snap(scenario, "activity-review-verdict-light");
      const note = page.getByRole("textbox", { name: "Your note" });
      await note.fill("Legs heavy after Tuesday.");
      await page.getByRole("button", { name: "Save note" }).click();
      await expect(page.getByText("Note saved.")).toBeVisible();
      await expect(verdict).toContainText("1 coach reply · kept");
      expect(scenario.backend.verdictRequests.map((request) => request.note)).toEqual([null]);
      await verdict.getByRole("button", { name: "Write again · 1 reply" }).click();
      await expect(verdict).toContainText(
        "With heavy legs after Tuesday, holding the targets was the right call.",
        { timeout: 15_000 },
      );
      await expect(verdict).toContainText(
        /when you asked again, from its file, your Plan and your note · 2 coach replies · kept/u,
      );
      expect(scenario.backend.verdictRequests.map((request) => request.note)).toEqual([
        null,
        "Legs heavy after Tuesday.",
      ]);
      await snap(scenario, "activity-review-verdict-again-light");
    } finally {
      await close(scenario);
    }
  });
});
