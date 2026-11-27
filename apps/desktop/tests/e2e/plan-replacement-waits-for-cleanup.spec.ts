import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test as base, type Browser, type Page } from "@playwright/test";
import { planMirrorExternalId, planMirrorExternalIdPrefix } from "@enduragent/engine";
import { launchDesktopFixture, type RunningDesktopFixture } from "../helpers/desktop-fixture.js";
import { createMemoryPlanCalendar } from "../helpers/plan-calendar-fake.js";
import { PlanCreationBackend } from "../helpers/plan-creation-backend.js";

const token = "c".repeat(43);
const today = "1998-01-03";
const windowLabel = "Calendar · 3 Jan 1998 to 9 Jan 1998 · Up to date";
const failedLabel = "Calendar sync failed. Retry available.";

interface Scenario {
  readonly backend: PlanCreationBackend;
  readonly calendar: ReturnType<typeof createMemoryPlanCalendar>;
  readonly page: Page;
  readonly oldPlanId: string;
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
      fixture = await launchDesktopFixture({
        script: backend.script,
        token,
        width: 1180,
        height: 820,
        colorScheme: "light",
        reducedMotion: true,
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
      await use({ backend, calendar, page, oldPlanId: seed.planId });
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

async function replacementDraft(scenario: Scenario) {
  await navigate(scenario, "Plan");
  await expect(active(scenario).getByText(windowLabel, { exact: true })).toBeVisible();
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
  await choose(scenario, "asap");
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
  return card.draft;
}

async function activateReplacement(scenario: Scenario) {
  await scenario.page.getByRole("button", { name: "Activate Plan", exact: true }).click();
  const dialog = scenario.page.getByRole("dialog", { name: "Close and activate?", exact: true });
  await expect(dialog).toContainText("Today’s calendar Workout stays. The new Plan activates now.");
  await expect(dialog).toContainText("Dated Workouts sync from tomorrow through 9 Jan 1998.");
  await dialog.getByRole("button", { name: "Activate new Plan", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const openActivePlan = scenario.page.getByRole("button", {
    name: "Open Active Plan",
    exact: true,
  });
  await expect(openActivePlan).toBeEnabled();
  await openActivePlan.click();
  await expect(active(scenario)).toContainText("Improve fitness");
}

async function newPlanId(scenario: Scenario) {
  const plan = (await scenario.backend.inspectActivation()).planningPlans.find(
    (row) => row.status === "active",
  );
  if (typeof plan?.plan_id !== "string" || plan.plan_id === scenario.oldPlanId)
    throw new TypeError("The replacement Plan is not active");
  return plan.plan_id;
}

async function oldPlanCleanup(scenario: Scenario) {
  const job = (await scenario.backend.inspectActivation()).jobs.find(
    (row) => row.plan_id === scenario.oldPlanId && row.kind === "cleanup",
  );
  if (job === undefined) throw new TypeError("Replacing the Plan did not start its cleanup");
  return { status: String(job.status), failures: Number(job.failure_count) };
}

function newPlanWrites(scenario: Scenario, planId: string) {
  return scenario.calendar.creates
    .filter((event) => event.externalId.startsWith(planMirrorExternalIdPrefix(planId)))
    .map((event) => event.dateKey);
}

async function freshLibraryRead(scenario: Scenario) {
  const reads = scenario.backend.planListRequests.length;
  await expect
    .poll(() => scenario.backend.planListRequests.length, { timeout: 20_000 })
    .toBeGreaterThanOrEqual(reads + 2);
}

test("waits for the old Plan's calendar cleanup before writing the replacement Plan", async ({
  scenario,
}) => {
  test.setTimeout(150_000);
  const oldToday = scenario.calendar.events.find((event) => event.dateKey === 19980103);
  expect(oldToday, "The first Plan should be on the calendar today").toBeDefined();
  const draft = await replacementDraft(scenario);
  scenario.calendar.refuseDeletes = true;
  await activateReplacement(scenario);
  await scenario.backend.calendarIdle();
  const planId = await newPlanId(scenario);

  expect(
    scenario.calendar.deletes.length,
    "Replacing the Plan should try to remove the old Plan's workouts from intervals.icu",
  ).toBeGreaterThan(0);
  expect(
    (await oldPlanCleanup(scenario)).status,
    "intervals.icu refused the deletes, so removing the old Plan's workouts should fail",
  ).toBe("failed");
  expect(
    newPlanWrites(scenario, planId),
    "The new Plan's workouts reached intervals.icu while the old Plan's workouts could not be removed, so both Plans share the same days",
  ).toEqual([]);
  await expect(
    active(scenario).getByText(failedLabel, { exact: true }),
    "The active Plan should say its calendar sync failed while the old Plan is still on intervals.icu",
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    active(scenario).getByRole("button", { name: "Retry calendar", exact: true }),
  ).toBeVisible();

  await expect
    .poll(
      async () => {
        await scenario.backend.library();
        await scenario.backend.calendarIdle();
        return (await oldPlanCleanup(scenario)).failures;
      },
      {
        message: "The app should keep retrying the old Plan's cleanup until it has failed 5 times",
        timeout: 30_000,
      },
    )
    .toBe(5);
  await navigate(scenario, "Chat");
  await navigate(scenario, "Plan");
  await freshLibraryRead(scenario);
  await expect(
    active(scenario).getByText(failedLabel, { exact: true }),
    "After 5 failed cleanups the active Plan should still say its calendar sync failed",
  ).toBeVisible();
  await expect(
    active(scenario).getByRole("button", { name: "Retry calendar", exact: true }),
    "After 5 failed cleanups the athlete should still be able to retry the calendar",
  ).toBeVisible();
  expect(
    newPlanWrites(scenario, planId),
    "The new Plan's workouts reached intervals.icu after 5 failed cleanups of the old Plan",
  ).toEqual([]);

  scenario.calendar.refuseDeletes = false;
  const reads = scenario.backend.planListRequests.length;
  await active(scenario).getByRole("button", { name: "Retry calendar", exact: true }).click();
  await expect
    .poll(() => scenario.backend.planListRequests.slice(reads).map((request) => request.params), {
      message: "Retry calendar should ask the app to retry removing the old Plan's workouts",
    })
    .toContainEqual({ retryCalendar: true });
  await expect(
    active(scenario).getByText(windowLabel, { exact: true }),
    "After Retry the active Plan's calendar should be up to date",
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    active(scenario).getByRole("button", { name: "Retry calendar", exact: true }),
  ).toHaveCount(0);
  await scenario.backend.calendarIdle();

  expect(
    (await oldPlanCleanup(scenario)).status,
    "After Retry the old Plan's workouts should be removed from intervals.icu",
  ).toBe("verified");
  expect(
    scenario.calendar.events.filter((event) =>
      event.externalId?.startsWith(planMirrorExternalIdPrefix(scenario.oldPlanId)),
    ),
    "Only today's Workout from the old Plan should stay on intervals.icu",
  ).toEqual([oldToday]);
  const workouts = await scenario.backend.physicalWorkouts(planId);
  const physicalIds = new Map(
    workouts.map((workout) => [draftWorkoutId(workout.structureJson), workout.id]),
  );
  const expected = draft.weeks
    .flatMap((week) => week.workouts)
    .filter(
      (workout) => workout.date !== null && workout.date > today && workout.date <= "1998-01-09",
    )
    .map((workout) => {
      const physicalId = physicalIds.get(workout.id);
      if (physicalId === undefined) throw new TypeError("Draft Workout has no physical identity");
      return planMirrorExternalId(planId, physicalId);
    })
    .sort();
  expect(expected.length).toBeGreaterThan(0);
  expect(
    scenario.calendar.events
      .filter((event) => event.externalId?.startsWith(planMirrorExternalIdPrefix(planId)))
      .map((event) => event.externalId)
      .sort(),
    "After Retry the new Plan's workouts from tomorrow should be on intervals.icu",
  ).toEqual(expected);
  expect(
    scenario.calendar.events.filter((event) => event.dateKey === 19980103),
    "Today's Workout should still be the old Plan's",
  ).toEqual([oldToday]);
});
