import { expect, test } from "@playwright/test";
import type { PlanMirrorEvent } from "@enduragent/engine";
import {
  cell,
  close,
  isoDay,
  launch,
  minutesOf,
  openCalendar,
  snap,
} from "../helpers/calendar-app.js";

const MONDAY = 19980105;

function planEvents(events: readonly PlanMirrorEvent[], planId: string): PlanMirrorEvent[] {
  return events
    .filter((event) => event.externalId?.includes(planId) === true && event.dateKey > MONDAY)
    .sort((left, right) => left.dateKey - right.dateKey);
}

function card(scenario: Awaited<ReturnType<typeof launch>>, dateKey: number) {
  return cell(scenario, dateKey).getByRole("button");
}

function sheet(scenario: Awaited<ReturnType<typeof launch>>) {
  return scenario.page.locator("[data-change-sheet]");
}

test.describe("Workouts changed in intervals.icu", () => {
  test("keeps an athlete's shorter workout in the Plan when they choose Keep", async ({
    playwright,
  }) => {
    let planId = "";
    let edited: PlanMirrorEvent | undefined;
    const scenario = await launch(playwright, async (backend, calendar) => {
      const seed = await backend.seedActiveTraining();
      if (seed.planId === null) throw new TypeError("Training Plan was not activated");
      planId = seed.planId;
      await backend.calendarIdle();
      edited = planEvents(calendar.events, planId)[0];
      if (edited?.durationS == null) throw new TypeError("No workout on intervals.icu");
      calendar.editByAthlete(edited.id, { durationS: edited.durationS - 900 });
      await backend.calendarRun();
      return isoDay(MONDAY);
    });
    try {
      if (edited?.durationS == null) throw new TypeError("No edited workout");
      const before = edited.durationS;
      await openCalendar(scenario);
      const changed = card(scenario, edited.dateKey);
      await expect(changed).toContainText("Changed in intervals.icu");
      await expect(changed).toContainText(" here, ");
      await expect(scenario.page.locator("[data-intervals-changes]")).toContainText(
        "1 workout was changed in intervals.icu.",
      );
      expect(scenario.calendar.updates).toEqual([]);
      await snap(scenario, "changed-card-light");
      await changed.click();
      await expect(sheet(scenario)).toHaveAttribute("data-change-sheet", "edited");
      await expect(
        sheet(scenario).getByRole("heading", { name: "You changed this workout in intervals.icu" }),
      ).toBeVisible();
      await snap(scenario, "change-sheet-light");
      await sheet(scenario)
        .getByRole("button", { name: /^Keep / })
        .click();
      await expect(sheet(scenario)).toBeHidden({ timeout: 15_000 });
      await expect(scenario.page.locator("[data-intervals-changes]")).toBeHidden();
      await expect(cell(scenario, edited.dateKey)).not.toContainText("Changed in intervals.icu");
      const stored = (await scenario.backend.physicalWorkouts(planId)).find(
        (workout) => workout.dateKey === edited?.dateKey,
      );
      expect(stored === undefined ? null : minutesOf(stored.structureJson)).toBe(
        Math.round((before - 900) / 60),
      );
      expect(scenario.calendar.updates).toEqual([]);
      expect(scenario.calendar.events.find((event) => event.id === edited?.id)?.durationS).toBe(
        before - 900,
      );
    } finally {
      await close(scenario);
    }
  });

  test("puts a deleted workout back on intervals.icu when the athlete chooses Put it back", async ({
    playwright,
  }) => {
    let planId = "";
    let deleted: PlanMirrorEvent | undefined;
    const scenario = await launch(playwright, async (backend, calendar) => {
      const seed = await backend.seedActiveTraining();
      if (seed.planId === null) throw new TypeError("Training Plan was not activated");
      planId = seed.planId;
      await backend.calendarIdle();
      deleted = planEvents(calendar.events, planId)[1];
      if (deleted === undefined) throw new TypeError("No second workout on intervals.icu");
      calendar.deleteByAthlete(deleted.id);
      await backend.calendarRun();
      return isoDay(MONDAY);
    });
    try {
      if (deleted === undefined) throw new TypeError("No deleted workout");
      await openCalendar(scenario);
      const ghost = card(scenario, deleted.dateKey);
      await expect(ghost).toContainText("Deleted in intervals.icu");
      await snap(scenario, "deleted-card-light");
      expect(
        scenario.calendar.creates.filter((entry) => entry.dateKey === deleted?.dateKey),
      ).toHaveLength(1);
      await ghost.click();
      await expect(sheet(scenario)).toHaveAttribute("data-change-sheet", "deleted");
      await expect(sheet(scenario).getByRole("table")).toHaveCount(0);
      await snap(scenario, "deleted-sheet-light");
      await sheet(scenario).getByRole("button", { name: "Put it back", exact: true }).click();
      await expect(sheet(scenario)).toBeHidden({ timeout: 15_000 });
      await expect(cell(scenario, deleted.dateKey)).not.toContainText("Deleted in intervals.icu");
      expect(
        planEvents(scenario.calendar.events, planId).filter(
          (event) => event.dateKey === deleted?.dateKey,
        ),
      ).toHaveLength(1);
    } finally {
      await close(scenario);
    }
  });
});
