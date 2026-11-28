import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test as base, type Browser, type Page } from "@playwright/test";
import { planMirrorExternalId, planMirrorExternalIdPrefix } from "@enduragent/engine";
import { addCivilDays } from "@enduragent/kernel/planning";
import { launchDesktopFixture, type RunningDesktopFixture } from "../helpers/desktop-fixture.js";
import { createMemoryPlanCalendar } from "../helpers/plan-calendar-fake.js";
import { PlanCreationBackend } from "../helpers/plan-creation-backend.js";

const token = "c".repeat(43);
const today = "1998-01-03";
const todayKey = 19980103;
const seededLabel = "Calendar · 3 Jan 1998 to 16 Jan 1998 · Up to date";
const failedLabel = "Calendar sync failed. Retry available.";
const cleanupRetryLabel = "Calendar cleanup failed. Retry available.";

type Draft = NonNullable<Awaited<ReturnType<PlanCreationBackend["card"]>>>["draft"];

interface Scenario {
  readonly backend: PlanCreationBackend;
  readonly calendar: ReturnType<typeof createMemoryPlanCalendar>;
  readonly page: Page;
  readonly firstPlanId: string;
  readonly firstToday: NonNullable<ReturnType<typeof createMemoryPlanCalendar>["events"][number]>;
}

const test = base.extend<{ scenario: Scenario }>({
  scenario: async ({ playwright }, use, testInfo) => {
    const scratch = await mkdtemp(join(tmpdir(), "plan-replacement-cleanup-"));
    const calendar = createMemoryPlanCalendar();
    const backend = new PlanCreationBackend(join(scratch, "store.db"), false, true, {
      calendar,
      calendarConnected: true,
    });
    let fixture: RunningDesktopFixture | undefined;
    let browser: Browser | undefined;
    try {
      backend.setCivilDate(today);
      await backend.open();
      const seed = await backend.seedActiveTraining();
      if (seed.planId === null) throw new TypeError("The first Plan was not activated");
      await backend.calendarIdle();
      const firstToday = calendar.events.find((event) => event.dateKey === todayKey);
      if (firstToday === undefined) throw new TypeError("The first Plan has no Workout today");
      fixture = await launchDesktopFixture({
        script: backend.script,
        token,
        width: 1180,
        height: 820,
        colorScheme: "light",
        reducedMotion: true,
        hidden: true,
        routeChatAttachmentComposer: true,
      });
      await fixture.setViewport(1180, 820);
      browser = await playwright.chromium.connectOverCDP(fixture.remoteDebuggingUrl);
      const context = browser.contexts()[0];
      const page = context
        ?.pages()
        .find((candidate) => candidate.url().startsWith("enduragent://app/"));
      if (context === undefined || page === undefined)
        throw new TypeError("Plan calendar renderer is unavailable");
      await context.tracing.start({ screenshots: true, snapshots: true }).catch(() => undefined);
      await expect(page.locator("[data-shell]")).toHaveAttribute("data-onboarding", "settled", {
        timeout: 30_000,
      });
      await page.clock.setFixedTime(new Date(`${today}T12:00:00Z`));
      await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
      await use({ backend, calendar, page, firstPlanId: seed.planId, firstToday });
      await context.tracing.stop({ path: testInfo.outputPath("trace.zip") }).catch(() => undefined);
    } finally {
      calendar.refuseDeletes = false;
      await browser?.close().catch(() => {});
      try {
        if (fixture !== undefined)
          expect(await fixture.close()).toEqual({ livePids: [], listenerCount: 0 });
      } finally {
        try {
          await backend.close();
        } finally {
          await rm(scratch, { recursive: true, force: true });
        }
      }
    }
  },
});

function upToDate(endDateKey: number): string {
  const end = new Date(
    Date.UTC(
      Math.floor(endDateKey / 10_000),
      (Math.floor(endDateKey / 100) % 100) - 1,
      endDateKey % 100,
    ),
  );
  const day = end.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  return `Calendar · 3 Jan 1998 to ${day} · Up to date`;
}

async function navigate(scenario: Scenario, destination: "Chat" | "Plan") {
  await scenario.page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: destination, exact: true })
    .click();
}

function active(scenario: Scenario) {
  return scenario.page.getByRole("region", { name: "Active Plan", exact: true });
}

function draftWorkoutId(structureJson: string): string {
  const structure: unknown = JSON.parse(structureJson);
  if (
    structure === null ||
    typeof structure !== "object" ||
    !("id" in structure) ||
    typeof structure.id !== "string"
  )
    throw new TypeError("Stored Workout has no Draft identity");
  return structure.id;
}

async function choose(scenario: Scenario, answer: string) {
  const before = await scenario.backend.card();
  if (before === null) throw new TypeError("Plan Creation is unavailable");
  await scenario.page.locator(`[data-parity="choice.row"][data-answer="${answer}"]`).click();
  await expect.poll(async () => (await scenario.backend.card())?.version).toBe(before.version + 1);
}

async function continueAnswer(scenario: Scenario, confirm = false) {
  const before = await scenario.backend.card();
  if (before === null) throw new TypeError("Plan Creation is unavailable");
  await scenario.page.getByRole("button", { name: "Continue", exact: true }).click();
  if (confirm)
    await scenario.page
      .getByRole("region", { name: "Did I read this right?", exact: true })
      .getByRole("button", { name: "Confirm", exact: true })
      .click();
  await expect.poll(async () => (await scenario.backend.card())?.version).toBe(before.version + 1);
}

async function replace(scenario: Scenario): Promise<{ planId: string; draft: Draft }> {
  const before = await activePlanId(scenario);
  await navigate(scenario, "Plan");
  await expect(active(scenario)).toBeVisible();
  await navigate(scenario, "Chat");
  await scenario.page.locator("#message").fill("/plan");
  await scenario.page.locator("#message").press("Enter");
  await expect(
    scenario.page.locator('[data-parity="question.card"][data-question="goal"]'),
  ).toBeVisible();
  await expect.poll(async () => (await scenario.backend.card())?.status).toBe("in-progress");
  await choose(scenario, "fitness");
  await choose(scenario, "4");
  await choose(scenario, "fixed");
  await scenario.page.locator('[data-answer="hours-6"]').click();
  await scenario.page.locator('[data-parity="availability.longest"]').fill("2");
  for (const day of [1, 3, 6])
    await scenario.page.locator(`input[name="usableWeekdays"][value="${day}"]`).check();
  await continueAnswer(scenario);
  await scenario.page.locator('[data-answer="earliest"]').click();
  await scenario.page.getByLabel("Plan starts", { exact: true }).fill(today);
  await continueAnswer(scenario);
  await choose(scenario, "none");
  await choose(scenario, "regular");
  await scenario.page.locator('[data-parity="choice.custom"][data-answer="custom"]').click();
  await scenario.page.locator('[data-parity="custom.textarea"]').fill("Ride four steady hours");
  await continueAnswer(scenario, true);
  await choose(scenario, "none");
  await scenario.page.getByRole("button", { name: "Build Draft", exact: true }).click();
  await expect(
    scenario.page.getByRole("button", { name: "Activate Plan", exact: true }),
  ).toBeEnabled();
  const card = await scenario.backend.card();
  if (card?.draft === null || card?.draft === undefined)
    throw new TypeError("Replacement Draft is unavailable");
  await scenario.page.getByRole("button", { name: "Activate Plan", exact: true }).click();
  const dialog = scenario.page.getByRole("dialog", { name: "Close and activate?", exact: true });
  await expect(dialog).toContainText("Today’s calendar Workout stays. The new Plan activates now.");
  await dialog.getByRole("button", { name: "Activate new Plan", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const openActivePlan = scenario.page.getByRole("button", {
    name: "Open Active Plan",
    exact: true,
  });
  await expect(openActivePlan).toBeEnabled();
  await openActivePlan.click();
  await expect(active(scenario)).toContainText("Improve fitness");
  await scenario.backend.calendarIdle();
  const planId = await activePlanId(scenario);
  if (planId === before) throw new TypeError("The replacement Plan is not active");
  return { planId, draft: card.draft };
}

async function activePlanId(scenario: Scenario) {
  const plan = (await scenario.backend.inspectActivation()).planningPlans.find(
    (row) => row.status === "active",
  );
  if (typeof plan?.plan_id !== "string") throw new TypeError("No Plan is active");
  return plan.plan_id;
}

async function cleanupOf(scenario: Scenario, planId: string) {
  const job = (await scenario.backend.inspectActivation()).jobs.find(
    (row) => row.plan_id === planId && row.kind === "cleanup",
  );
  if (job === undefined) throw new TypeError("Replacing the Plan did not start its cleanup");
  return { status: String(job.status), failures: Number(job.failure_count) };
}

async function expectCleanup(
  scenario: Scenario,
  planId: string,
  status: "failed" | "verified",
  message?: string,
) {
  await expect
    .poll(async () => (await cleanupOf(scenario, planId)).status, { message, timeout: 20_000 })
    .toBe(status);
}

function writesOf(scenario: Scenario, planId: string) {
  return scenario.calendar.creates
    .filter((event) => event.externalId.startsWith(planMirrorExternalIdPrefix(planId)))
    .map((event) => event.dateKey);
}

function eventsOf(scenario: Scenario, planId: string) {
  return scenario.calendar.events.filter((event) =>
    event.externalId?.startsWith(planMirrorExternalIdPrefix(planId)),
  );
}

async function failCleanupFiveTimes(scenario: Scenario, planId: string) {
  await expect
    .poll(
      async () => {
        await scenario.backend.library();
        await scenario.backend.calendarIdle();
        return (await cleanupOf(scenario, planId)).failures;
      },
      {
        message: "The app should keep retrying the old Plan's cleanup until it has failed 5 times",
        timeout: 30_000,
      },
    )
    .toBe(5);
}

async function expectRetrySent(scenario: Scenario, reads: number) {
  await expect
    .poll(() => scenario.backend.planListRequests.slice(reads).map((request) => request.params), {
      message: "Retry calendar should ask the app to retry removing the old Plan's workouts",
    })
    .toContainEqual({ retryCalendar: true });
}

async function expectOnlyNewPlanFromTomorrow(scenario: Scenario, planId: string, draft: Draft) {
  if (draft === null) throw new TypeError("Replacement Draft is unavailable");
  const library = await scenario.backend.library();
  if (library.active === null) throw new TypeError("Replacement Plan is unavailable");
  const end = addCivilDays(Number(library.active.start.replaceAll("-", "")), 13);
  await expect(
    active(scenario).getByText(upToDate(end), { exact: true }),
    "After Retry the active Plan's calendar should be up to date",
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    active(scenario).getByRole("button", { name: "Retry calendar", exact: true }),
  ).toHaveCount(0);
  await scenario.backend.calendarIdle();
  expect(
    eventsOf(scenario, scenario.firstPlanId),
    "Only today's Workout from the first Plan should stay on intervals.icu",
  ).toEqual([scenario.firstToday]);
  const physicalIds = new Map(
    (await scenario.backend.physicalWorkouts(planId)).map((workout) => [
      draftWorkoutId(workout.structureJson),
      workout.id,
    ]),
  );
  const expected = draft.weeks
    .flatMap((week) => week.workouts)
    .filter(
      (workout) =>
        workout.date !== null &&
        workout.date > today &&
        Number(workout.date.replaceAll("-", "")) <= end,
    )
    .map((workout) => {
      const physicalId = physicalIds.get(workout.id);
      if (physicalId === undefined) throw new TypeError("Draft Workout has no physical identity");
      return planMirrorExternalId(planId, physicalId);
    })
    .sort();
  expect(expected.length).toBeGreaterThan(0);
  expect(
    eventsOf(scenario, planId)
      .map((event) => event.externalId)
      .sort(),
    "After Retry the new Plan's workouts from tomorrow should be on intervals.icu",
  ).toEqual(expected);
  expect(
    scenario.calendar.events.filter((event) => event.dateKey === todayKey),
    "Today's Workout should still be the first Plan's",
  ).toEqual([scenario.firstToday]);
}

test("shows the failed cleanup with Retry on the active Plan while the new Plan waits", async ({
  scenario,
}) => {
  test.setTimeout(150_000);
  await navigate(scenario, "Plan");
  await expect(active(scenario).getByText(seededLabel, { exact: true })).toBeVisible();
  scenario.calendar.refuseDeletes = true;
  const { planId, draft } = await replace(scenario);

  expect(
    scenario.calendar.deletes.length,
    "Replacing the Plan should try to remove the old Plan's workouts from intervals.icu",
  ).toBeGreaterThan(0);
  await expectCleanup(
    scenario,
    scenario.firstPlanId,
    "failed",
    "intervals.icu refused the deletes, so removing the old Plan's workouts should fail",
  );
  expect(
    writesOf(scenario, planId),
    "The new Plan's workouts reached intervals.icu while the old Plan's workouts could not be removed",
  ).toEqual([]);
  await expect(
    active(scenario).getByText(failedLabel, { exact: true }),
    "The active Plan should say its calendar sync failed while the old Plan is still on intervals.icu",
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    active(scenario).getByRole("button", { name: "Retry calendar", exact: true }),
  ).toBeVisible();

  scenario.calendar.refuseDeletes = false;
  const reads = scenario.backend.planListRequests.length;
  await active(scenario).getByRole("button", { name: "Retry calendar", exact: true }).click();
  await expectRetrySent(scenario, reads);
  await expectOnlyNewPlanFromTomorrow(scenario, planId, draft);
  await expectCleanup(scenario, scenario.firstPlanId, "verified");
});

test("keeps Retry on the closed Plan after five failed cleanups and runs the cleanup again", async ({
  scenario,
}) => {
  test.setTimeout(150_000);
  scenario.calendar.refuseDeletes = true;
  const { planId, draft } = await replace(scenario);
  await failCleanupFiveTimes(scenario, scenario.firstPlanId);
  expect(writesOf(scenario, planId)).toEqual([]);

  await navigate(scenario, "Chat");
  await navigate(scenario, "Plan");
  await scenario.page.getByRole("button", { name: "Read final details", exact: true }).click();
  const details = scenario.page.getByRole("region", { name: "Final Plan history", exact: true });
  await expect(
    details.getByText(cleanupRetryLabel, { exact: true }),
    "After 5 failed cleanups the closed Plan should still offer Retry",
  ).toBeVisible({ timeout: 15_000 });

  scenario.calendar.refuseDeletes = false;
  const reads = scenario.backend.planListRequests.length;
  await details.getByRole("button", { name: "Retry calendar", exact: true }).click();
  await expectRetrySent(scenario, reads);
  await expect(
    details.getByText("Cleanup complete", { exact: true }),
    "Retry should remove the old Plan's workouts after 5 failed cleanups",
  ).toBeVisible({ timeout: 20_000 });
  await details.getByRole("button", { name: "Back to library", exact: true }).click();
  await expectOnlyNewPlanFromTomorrow(scenario, planId, draft);
});

test("holds the newest Plan behind an older failed cleanup after a later cleanup verifies", async ({
  scenario,
}) => {
  test.setTimeout(240_000);
  scenario.calendar.refuseDeletes = true;
  const second = await replace(scenario);
  await expectCleanup(scenario, scenario.firstPlanId, "failed");
  expect(writesOf(scenario, second.planId)).toEqual([]);

  const third = await replace(scenario);
  await expectCleanup(
    scenario,
    second.planId,
    "verified",
    "The second Plan never reached intervals.icu, so its cleanup has nothing to remove",
  );
  await expectCleanup(scenario, scenario.firstPlanId, "failed");
  expect(
    writesOf(scenario, third.planId),
    "The newest Plan's workouts reached intervals.icu next to the first Plan's, whose cleanup failed",
  ).toEqual([]);
  await expect(
    active(scenario).getByText(failedLabel, { exact: true }),
    "The active Plan should say its calendar sync failed while the first Plan is still on intervals.icu",
  ).toBeVisible({ timeout: 15_000 });

  scenario.calendar.refuseDeletes = false;
  const reads = scenario.backend.planListRequests.length;
  await active(scenario).getByRole("button", { name: "Retry calendar", exact: true }).click();
  await expectRetrySent(scenario, reads);
  await expectOnlyNewPlanFromTomorrow(scenario, third.planId, third.draft);
  await expectCleanup(scenario, scenario.firstPlanId, "verified");
  expect(eventsOf(scenario, second.planId)).toEqual([]);
});
