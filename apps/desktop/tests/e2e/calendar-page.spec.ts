import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Browser, type Page, type PlaywrightWorkerArgs } from "@playwright/test";
import { addCivilDays } from "@enduragent/kernel/planning";
import { launchDesktopFixture, type RunningDesktopFixture } from "../helpers/desktop-fixture.js";
import { createMemoryPlanCalendar } from "../helpers/plan-calendar-fake.js";
import { PlanCreationBackend } from "../helpers/plan-creation-backend.js";

const token = "c".repeat(43);
const seedDay = "1998-01-05";
const shots = process.env.CALENDAR_SHOTS_DIR;

type Playwright = PlaywrightWorkerArgs["playwright"];

interface Scenario {
  readonly backend: PlanCreationBackend;
  readonly fixture: RunningDesktopFixture;
  readonly scratch: string;
  browser: Browser;
  page: Page;
}

function isoDay(dateKey: number): string {
  const text = String(dateKey);
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

function minutesOf(structureJson: string): number {
  const structure: unknown = JSON.parse(structureJson);
  if (structure === null || typeof structure !== "object" || !("minutes" in structure))
    throw new TypeError("Stored Workout has no length");
  return Number(structure.minutes);
}

function rideKey(index: number): string {
  return String(index).padStart(2, "0").repeat(32);
}

async function launch(
  playwright: Playwright,
  prepare: (backend: PlanCreationBackend) => Promise<string>,
  colorScheme: "light" | "dark" = "light",
): Promise<Scenario> {
  const scratch = await mkdtemp(join(tmpdir(), "calendar-page-"));
  const calendar = createMemoryPlanCalendar();
  const backend = new PlanCreationBackend(join(scratch, "store.db"), false, true, {
    calendar,
    calendarConnected: true,
  });
  let fixture: RunningDesktopFixture | undefined;
  try {
    backend.setCivilDate(seedDay);
    await backend.open();
    const today = await prepare(backend);
    fixture = await launchDesktopFixture({
      script: backend.script,
      token,
      width: 1280,
      height: 860,
      colorScheme,
      reducedMotion: true,
      hidden: true,
      routeChatAttachmentComposer: true,
    });
    await fixture.setViewport(1280, 860);
    const browser = await playwright.chromium.connectOverCDP(fixture.remoteDebuggingUrl);
    const page = browser
      .contexts()[0]
      ?.pages()
      .find((candidate) => candidate.url().startsWith("enduragent://app/"));
    if (page === undefined) throw new TypeError("Calendar renderer is unavailable");
    await expect(page.locator("[data-shell]")).toHaveAttribute("data-onboarding", "settled", {
      timeout: 30_000,
    });
    await page.clock.setFixedTime(new Date(`${today}T12:00:00Z`));
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    return { backend, fixture, scratch, browser, page };
  } catch (error) {
    try {
      await fixture?.close();
    } finally {
      try {
        await backend.close();
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    }
    throw error;
  }
}

async function close(scenario: Scenario) {
  await scenario.browser.close().catch(() => {});
  try {
    expect(await scenario.fixture.close()).toEqual({ livePids: [], listenerCount: 0 });
  } finally {
    try {
      await scenario.backend.close();
    } finally {
      await rm(scenario.scratch, { recursive: true, force: true });
    }
  }
}

async function openCalendar(scenario: Scenario) {
  const entry = scenario.page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Calendar", exact: true });
  await expect(entry, "the sidebar has no Calendar page").toBeVisible();
  await entry.click();
  await expect(scenario.page.locator('[data-calendar-state="ready"]')).toBeVisible();
}

async function snap(scenario: Scenario, name: string) {
  if (shots === undefined) return;
  await mkdir(shots, { recursive: true });
  await scenario.page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
}

function cell(scenario: Scenario, dateKey: number) {
  return scenario.page.locator(`[role="cell"][data-date-key="${dateKey}"]`);
}

async function runningPlan(backend: PlanCreationBackend) {
  const seed = await backend.seedActiveTraining();
  if (seed.planId === null) throw new TypeError("Training Plan was not activated");
  await backend.calendarIdle();
  const workouts = [...(await backend.physicalWorkouts(seed.planId))].sort(
    (left, right) => left.dateKey - right.dateKey,
  );
  const first = workouts[0];
  if (first === undefined) throw new TypeError("Training Plan has no workouts");
  const today = addCivilDays(first.dateKey, 9);
  const pastDays = workouts.filter((workout) => workout.dateKey < today);
  const [asPlanned, differently, asked, missed] = pastDays;
  if (missed === undefined) throw new TypeError("Training Plan has too few past workouts");
  backend.setCivilDate(isoDay(today));
  const rides = [
    { workout: asPlanned, decision: "confirmed" as const, ratio: 1.02 },
    { workout: differently, decision: "confirmed" as const, ratio: 0.7 },
    { workout: asked, decision: "suggested" as const, ratio: 0.9 },
  ];
  for (const [index, ride] of rides.entries()) {
    const workout = ride.workout;
    if (workout === undefined) continue;
    const seconds = Math.round(minutesOf(workout.structureJson) * 60 * ride.ratio);
    await backend.seedCalendarRide({
      key: rideKey(index + 1),
      dateKey: workout.dateKey,
      name: "Road ride",
      movingS: seconds,
      distanceM: seconds * 8,
      match: { planId: seed.planId, planWorkoutId: workout.id, decision: ride.decision },
    });
  }
  const restDay = [0, 1, 2, 3, 4, 5, 6]
    .map((offset) => addCivilDays(first.dateKey, offset))
    .find((dateKey) => workouts.every((workout) => workout.dateKey !== dateKey));
  if (restDay !== undefined) {
    await backend.seedCalendarRide({
      key: rideKey(9),
      dateKey: restDay,
      name: "Café ride",
      movingS: 3_300,
      distanceM: 24_000,
    });
  }
  await backend.recordSuccessfulSync(Date.parse(`${isoDay(today)}T06:00:00Z`));
  return { today, asPlanned, differently, asked, missed, restDay };
}

test.describe("Calendar page", () => {
  test("shows a running Plan by Training Week with each workout's outcome", async ({
    playwright,
  }) => {
    let plan: Awaited<ReturnType<typeof runningPlan>> | undefined;
    const scenario = await launch(playwright, async (backend) => {
      plan = await runningPlan(backend);
      return isoDay(plan.today);
    });
    try {
      if (plan === undefined) throw new TypeError("Plan seed did not run");
      await openCalendar(scenario);
      const page = scenario.page;
      await expect(page.getByText(/Training Week 2 of \d+$/u)).toBeVisible();
      await expect(page.locator("[data-season-strip]")).toBeVisible();
      const { asPlanned, differently, asked, missed, restDay, today } = plan;
      if (asPlanned === undefined || differently === undefined || asked === undefined)
        throw new TypeError("Plan seed is incomplete");
      if (missed === undefined) throw new TypeError("Plan seed is incomplete");
      await expect(cell(scenario, asPlanned.dateKey)).toContainText("Done as planned");
      await expect(cell(scenario, differently.dateKey)).toContainText("Done differently");
      await expect(cell(scenario, asked.dateKey)).toContainText("Is this it?");
      await expect(cell(scenario, missed.dateKey)).toContainText("Missed");
      await expect(cell(scenario, today)).toContainText("Today");
      if (restDay !== undefined) {
        await expect(cell(scenario, restDay)).toContainText("Café ride");
        await expect(cell(scenario, restDay)).toContainText("Extra");
      }
      const firstDay = await page.evaluate(
        () =>
          (window as unknown as { enduragentAuth: { platform: { firstDayOfWeek: number } } })
            .enduragentAuth.platform.firstDayOfWeek,
      );
      if (firstDay === 1) {
        await expect(page.getByRole("rowheader").filter({ hasText: "Week 1" })).toContainText(
          "ride to confirm",
        );
        await expect(page.getByRole("rowheader").filter({ hasText: "Week 3" })).toContainText(
          "On intervals.icu",
        );
        const fourth = page.getByRole("rowheader").filter({ hasText: "Week 4" });
        await expect(fourth).toContainText("Plan only");
        await expect(fourth).toContainText("Goes out");
      } else {
        await expect(page.getByRole("rowheader").filter({ hasText: "Week 1 → 2" })).toContainText(
          "Week 2 starts",
        );
      }
      await snap(scenario, "calendar-running-light");
      await page.getByRole("button", { name: "Next week" }).click();
      await expect(cell(scenario, addCivilDays(today, 21))).toBeVisible();
      await page.getByRole("button", { name: "Today", exact: true }).click();
      await expect(cell(scenario, today)).toContainText("Today");
    } finally {
      await close(scenario);
    }
  });

  test("shows the athlete's Activities by date when there is no Plan", async ({ playwright }) => {
    const today = 19980114;
    const scenario = await launch(playwright, async (backend) => {
      backend.setCivilDate(isoDay(today));
      await backend.seedCalendarRide({
        key: rideKey(1),
        dateKey: addCivilDays(today, -2),
        name: "Road ride",
        movingS: 3_900,
        distanceM: 32_000,
      });
      await backend.seedCalendarRide({
        key: rideKey(2),
        dateKey: today,
        name: "Indoor ride",
        movingS: 2_700,
        distanceM: 0,
      });
      return isoDay(today);
    });
    try {
      await openCalendar(scenario);
      const page = scenario.page;
      await expect(page.getByText("No Plan · your Activities from intervals.icu")).toBeVisible();
      await expect(page.getByRole("heading", { name: "No Plan yet" })).toBeVisible();
      await expect(cell(scenario, addCivilDays(today, -2))).toContainText("1h 5m · 32 km");
      await expect(cell(scenario, today)).toContainText("Indoor ride");
      await expect(page.getByRole("columnheader", { name: "Week", exact: true })).toBeVisible();
      await snap(scenario, "calendar-no-plan-light");
    } finally {
      await close(scenario);
    }
  });

  test("keeps the calendar readable in the dark theme", async ({ playwright }) => {
    let today = 0;
    const scenario = await launch(
      playwright,
      async (backend) => {
        const plan = await runningPlan(backend);
        today = plan.today;
        return isoDay(plan.today);
      },
      "dark",
    );
    try {
      await openCalendar(scenario);
      await expect(cell(scenario, today)).toContainText("Today");
      await snap(scenario, "calendar-running-dark");
    } finally {
      await close(scenario);
    }
  });
});
