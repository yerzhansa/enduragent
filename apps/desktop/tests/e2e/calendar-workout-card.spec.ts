import { expect, test } from "@playwright/test";
import { addCivilDays } from "@enduragent/kernel/planning";
import {
  cell,
  close,
  isoDay,
  launch,
  openCalendar,
  snap,
  type Playwright,
  type Scenario,
} from "../helpers/calendar-app.js";

const MONDAY = 19980105;
const LAST_DAY = addCivilDays(MONDAY, 27);
const LAST_SHOWN_DAY = addCivilDays(MONDAY, 20);
const FIRST_PLAN_ONLY_DAY = addCivilDays(MONDAY, 14);

interface Chosen {
  readonly id: string;
  readonly name: string;
  readonly fromDateKey: number;
  readonly busy: ReadonlyMap<number, { readonly id: string; readonly name: string }>;
}

function nameOf(structureJson: string): string {
  const structure: unknown = JSON.parse(structureJson);
  if (structure === null || typeof structure !== "object" || !("name" in structure))
    throw new TypeError("Stored Workout has no name");
  return String(structure.name);
}

async function launchWithWorkout(playwright: Playwright): Promise<{
  readonly scenario: Scenario;
  readonly chosen: Chosen;
}> {
  let chosen: Chosen | null = null;
  const scenario = await launch(
    playwright,
    async (backend) => {
      const seed = await backend.seedActiveTraining();
      if (seed.planId === null) throw new TypeError("Training Plan was not activated");
      await backend.calendarIdle();
      const workouts = (await backend.physicalWorkouts(seed.planId))
        .filter((workout) => workout.dateKey !== null && workout.dateKey > MONDAY)
        .sort((left, right) => (left.dateKey ?? 0) - (right.dateKey ?? 0));
      const busy = new Map(
        workouts.map((workout) => [
          workout.dateKey ?? 0,
          { id: workout.id, name: nameOf(workout.structureJson) },
        ]),
      );
      const found = workouts.find(
        (workout) =>
          workout.dateKey !== null &&
          !busy.has(addCivilDays(workout.dateKey, 1)) &&
          addCivilDays(workout.dateKey, 1) < addCivilDays(MONDAY, 14),
      );
      if (found?.dateKey == null) throw new TypeError("No workout with a free next day");
      chosen = {
        id: found.id,
        name: nameOf(found.structureJson),
        fromDateKey: found.dateKey,
        busy,
      };
      return isoDay(MONDAY);
    },
    "light",
    { keepsDraftText: true },
  );
  if (chosen === null) throw new TypeError("No workout was chosen");
  return { scenario, chosen };
}

async function previewUncovered(scenario: Scenario, dateKey: number, workoutId: string) {
  return scenario.page.evaluate(
    ([day, id]) => {
      const target = document.querySelector(`[role="cell"][data-date-key="${day}"]`);
      const preview = target?.querySelector(`[data-move-preview="${id}"]`);
      if (target == null || preview == null) return false;
      const box = preview.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return hit !== null && target.contains(hit);
    },
    [dateKey, workoutId] as const,
  );
}

async function clearance(
  scenario: Scenario,
  dateKey: number,
  workoutId: string,
  swap: { readonly dateKey: number; readonly id: string } | null,
) {
  return scenario.page.evaluate(
    ([day, id, swapDay, swapId]) => {
      const margin = 11;
      const dialog = document.querySelector("[data-move-dialog]")?.getBoundingClientRect();
      const view = document.querySelector("[data-page-scroll]")?.getBoundingClientRect();
      if (dialog === undefined || view === undefined) return null;
      const clearOf = (element: Element | null | undefined) => {
        if (element == null) return null;
        const box = element.getBoundingClientRect();
        return (
          box.bottom <= dialog.top - margin || box.right <= dialog.left || box.left >= dialog.right
        );
      };
      const target = document.querySelector(`[role="cell"][data-date-key="${day}"]`);
      const source =
        swapDay === null
          ? null
          : document.querySelector(`[role="cell"][data-date-key="${swapDay}"]`);
      const boxes = [
        target?.querySelector(`[data-move-preview="${id}"]`),
        source?.querySelector(`[data-move-preview="${swapId}"]`),
      ]
        .filter((element): element is Element => element != null)
        .map((element) => element.getBoundingClientRect())
        .filter((box) => box.right > view.left && box.left < view.right);
      let lower = Number.NEGATIVE_INFINITY;
      let upper = Number.POSITIVE_INFINITY;
      for (const box of boxes) {
        const under = box.right > dialog.left && box.left < dialog.right;
        lower = Math.max(lower, box.bottom - (under ? dialog.top - 12 : view.bottom));
        upper = Math.min(upper, box.top - view.top);
      }
      const bothFit = boxes.length === 2 && lower <= upper + 1;
      return {
        target: clearOf(target?.querySelector(`[data-move-preview="${id}"]`)),
        swapped: clearOf(source?.querySelector(`[data-move-preview="${swapId}"]`)),
        bothFit,
      };
    },
    [dateKey, workoutId, swap?.dateKey ?? null, swap?.id ?? null] as const,
  );
}

async function expectTargetClear(
  scenario: Scenario,
  dateKey: number,
  workoutId: string,
  swap: { readonly dateKey: number; readonly id: string } | null = null,
) {
  await expect(
    cell(scenario, dateKey).locator(`[data-move-preview="${workoutId}"]`),
    `the preview on ${dateKey} is missing`,
  ).toBeVisible();
  await expect
    .poll(() => previewUncovered(scenario, dateKey, workoutId), {
      message: `the move dialog covers its target ${dateKey}`,
    })
    .toBe(true);
  await expect
    .poll(async () => (await clearance(scenario, dateKey, workoutId, swap))?.target, {
      message: `the move dialog covers the bottom of its target ${dateKey}`,
    })
    .toBe(true);
  if (swap === null) return;
  await expect
    .poll(
      async () => {
        const both = await clearance(scenario, dateKey, workoutId, swap);
        return both === null || !both.bothFit || both.swapped !== false;
      },
      {
        message: `the swapped preview on ${swap.dateKey} is covered while both fit (target ${dateKey})`,
      },
    )
    .toBe(true);
}

async function stepThroughEveryDay(scenario: Scenario, chosen: Chosen): Promise<void> {
  const page = scenario.page;
  const dialog = page.locator("[data-move-dialog]");
  const later = dialog.getByRole("button", { name: "Later day", exact: true });
  const days: number[] = [];
  for (let day = addCivilDays(chosen.fromDateKey, 1); day <= LAST_DAY; day = addCivilDays(day, 1))
    days.push(day);
  let swapChecked = false;
  let crossingChecked = false;
  const body = dialog.locator("[data-move-effect]");
  const sourceDay = new Date(Date.UTC(1998, 0, chosen.fromDateKey % 100)).toLocaleDateString(
    "en-GB",
    { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" },
  );
  for (const [index, day] of days.entries()) {
    const other = chosen.busy.get(day);
    await expectTargetClear(
      scenario,
      day,
      chosen.id,
      other === undefined ? null : { dateKey: chosen.fromDateKey, id: other.id },
    );
    const clash = chosen.busy.get(day)?.id;
    if (!swapChecked && clash !== undefined && day <= LAST_SHOWN_DAY) {
      swapChecked = true;
      const swapped = cell(scenario, chosen.fromDateKey).locator(`[data-move-preview="${clash}"]`);
      const swap = dialog.getByRole("radio", { name: /^Swap: .+ goes to \w{3} \d{1,2} \w{3}$/u });
      await swap.check();
      await expect(swapped, "Swap does not show the other workout on the source day").toBeVisible();
      await dialog.getByRole("radio", { name: /^Keep both on / }).check();
      await expect(swapped, "Keep both still shows a swap").toHaveCount(0);
      await swap.check();
      await expect(swapped).toBeVisible();
      await later.focus();
    }
    if (
      !crossingChecked &&
      other !== undefined &&
      day >= FIRST_PLAN_ONLY_DAY &&
      day <= LAST_SHOWN_DAY
    ) {
      crossingChecked = true;
      const swap = dialog.getByRole("radio", { name: /^Swap: / });
      await swap.check();
      await expect(body, "Swap across the line does not name both workouts").toContainText(
        `${chosen.name} comes off intervals.icu until Week 3 goes out. ${other.name} goes on intervals.icu for ${sourceDay}.`,
      );
      await dialog.getByRole("radio", { name: /^Keep both on / }).check();
      await expect(body).toContainText("It comes off intervals.icu until Week 3 goes out.");
      await expect(body, "Keep both names the other workout").not.toContainText(other.name);
      await later.focus();
    }
    if (index < days.length - 1) await later.click();
  }
  expect(swapChecked, "no day with another workout was stepped through").toBe(true);
  expect(crossingChecked, "no Plan-only day with another workout was stepped through").toBe(true);
  await expect(later, "Later day never reaches the Plan's last day").toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(later, "the last Later day press drops focus").toBeFocused();
  await dialog.getByRole("button", { name: "Earlier day", exact: true }).click();
  const back = days.at(-2) ?? chosen.fromDateKey;
  await expectTargetClear(scenario, back, chosen.id);
  await expect(cell(scenario, LAST_DAY).locator(`[data-move-preview="${chosen.id}"]`)).toHaveCount(
    0,
  );
}

test.describe("The workout card", () => {
  test("opens over the grid, moves the workout a day with Move…, and asks the coach in Chat without sending", async ({
    playwright,
  }) => {
    const { scenario, chosen } = await launchWithWorkout(playwright);
    const workoutId = chosen.id;
    const workoutName = chosen.name;
    const fromDateKey = chosen.fromDateKey;
    const toDateKey = addCivilDays(fromDateKey, 1);
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
      await stepThroughEveryDay(scenario, chosen);
      const firstShown = () =>
        page.evaluate(() =>
          Number(
            document.querySelector<HTMLElement>('[role="cell"][data-date-key]')?.dataset.dateKey,
          ),
        );
      const paged = await firstShown();
      for (const weeks of [1, 2]) {
        await page.getByRole("button", { name: "Next week", exact: true }).click();
        await expect
          .poll(firstShown, { message: "Next week snaps back while the move dialog is open" })
          .toBe(addCivilDays(paged, weeks * 7));
      }
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Earlier day", exact: true }).focus();
      await page.keyboard.press("Escape");
      await expect(dialog, "Escape no longer closes the move dialog").toBeHidden();
      await expect(source, "Escape does not page back to the workout's week").toBeFocused();
      await page.keyboard.press("Enter");
      await expect(card).toBeVisible();
      await card.getByRole("button", { name: "Move…", exact: true }).click();
      await expect(dialog).toBeVisible();
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
      const previews = () =>
        scenario.backend.creationRequests.filter(
          (request) => request.method === "plan_change.preview",
        ).length;
      const previewsBefore = previews();
      await card.getByRole("button", { name: "Ask the coach to change it", exact: true }).click();
      const composer = page.locator("#message");
      await expect(composer).toBeVisible();
      await expect(composer).toHaveValue(new RegExp(`^Please change ${workoutName} on `, "u"));
      await snap(scenario, "workout-card-ask-light");
      expect(scenario.backend.chatSubmissions, "asking the coach sent a message").toBe(0);
      expect(previews(), "asking the coach asked for a Plan change").toBe(previewsBefore);
    } finally {
      await close(scenario);
    }
  });

  test("keeps every move target in view in the compact window", async ({ playwright }) => {
    const { scenario, chosen } = await launchWithWorkout(playwright);
    try {
      await scenario.fixture.setViewport(760, 600);
      await openCalendar(scenario);
      const page = scenario.page;
      const source = page.locator(`[data-workout-id="${chosen.id}"]`);
      await source.click();
      const card = page.getByRole("dialog", { name: chosen.name, exact: true });
      await expect(card, "clicking a workout opens no card").toBeVisible();
      await card.getByRole("button", { name: "Move…", exact: true }).click();
      const dialog = page.locator("[data-move-dialog]");
      await expect(dialog).toBeVisible();
      await snap(scenario, "workout-card-move-compact");
      await stepThroughEveryDay(scenario, chosen);
      await snap(scenario, "workout-card-move-compact-last");
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(source).toBeFocused();
    } finally {
      await close(scenario);
    }
  });
});
