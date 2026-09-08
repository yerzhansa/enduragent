import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Browser, type Page, type PlaywrightWorkerArgs } from "@playwright/test";
import { planMirrorExternalId, planMirrorExternalIdPrefix } from "@enduragent/engine";
import { launchDesktopFixture, type RunningDesktopFixture } from "../helpers/desktop-fixture.js";
import { createMemoryPlanCalendar } from "../helpers/plan-calendar-fake.js";
import { PlanCreationBackend } from "../helpers/plan-creation-backend.js";

const token = "d".repeat(43);
const today = "1998-01-03";
const windowLabel = "Calendar · 3 Jan 1998 to 9 Jan 1998 · Up to date";
type Playwright = PlaywrightWorkerArgs["playwright"];

interface Scenario {
  readonly backend: PlanCreationBackend;
  readonly calendar: ReturnType<typeof createMemoryPlanCalendar>;
  readonly fixture: RunningDesktopFixture;
  readonly scratch: string;
  readonly seed: Awaited<ReturnType<PlanCreationBackend["seedActiveTraining"]>>;
  browser: Browser;
  page: Page;
}

async function connect(playwright: Playwright, fixture: RunningDesktopFixture) {
  const browser = await playwright.chromium.connectOverCDP(fixture.remoteDebuggingUrl);
  const page = browser
    .contexts()[0]
    ?.pages()
    .find((candidate) => candidate.url().startsWith("enduragent://app/"));
  if (page === undefined) throw new TypeError("Plan calendar renderer is unavailable");
  await expect(page.locator("[data-shell]")).toHaveAttribute("data-onboarding", "settled", {
    timeout: 30_000,
  });
  await page.clock.setFixedTime(new Date(`${today}T12:00:00Z`));
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  return { browser, page };
}

async function launch(
  playwright: Playwright,
  options: {
    readonly delayMs?: number;
    readonly calendarConnected?: boolean;
  } = {},
): Promise<Scenario> {
  const scratch = await mkdtemp(join(tmpdir(), "plan-calendar-"));
  const calendar = createMemoryPlanCalendar();
  calendar.delayMs = options.delayMs ?? 0;
  const backend = new PlanCreationBackend(join(scratch, "store.db"), false, true, {
    calendar,
    calendarConnected: options.calendarConnected ?? true,
  });
  let fixture: RunningDesktopFixture | undefined;
  try {
    backend.setCivilDate(today);
    await backend.open();
    const seed = await backend.seedActiveTraining();
    if (calendar.delayMs === 0) await backend.calendarIdle();
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
    return { backend, calendar, fixture, scratch, seed, ...(await connect(playwright, fixture)) };
  } catch (error) {
    calendar.delayMs = 0;
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
  scenario.calendar.delayMs = 0;
  await scenario.browser.close().catch(() => {});
  try {
    const cleanup = await scenario.fixture.close();
    expect(cleanup).toEqual({ livePids: [], listenerCount: 0 });
  } finally {
    try {
      await scenario.backend.close();
    } finally {
      await rm(scenario.scratch, { recursive: true, force: true });
    }
  }
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

async function physicalWorkoutIds(backend: PlanCreationBackend, planId: string) {
  const workouts = await backend.physicalWorkouts(planId);
  const ids = new Map(
    workouts.map((workout) => [draftWorkoutId(workout.structureJson), workout.id]),
  );
  return (draftId: string) => {
    const id = ids.get(draftId);
    if (id === undefined) throw new TypeError("Draft Workout has no physical identity");
    return id;
  };
}

async function choose(scenario: Scenario, answer: string) {
  const before = await scenario.backend.card();
  if (before === null) throw new TypeError("Plan Creation is unavailable");
  await scenario.page.locator(`[data-parity="choice.row"][data-answer="${answer}"]`).click();
  await expect.poll(async () => (await scenario.backend.card())?.version).toBe(before.version + 1);
}

async function continueAnswer(scenario: Scenario) {
  const before = await scenario.backend.card();
  if (before === null) throw new TypeError("Plan Creation is unavailable");
  await scenario.page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect.poll(async () => (await scenario.backend.card())?.version).toBe(before.version + 1);
}

async function replacementDraft(scenario: Scenario, mode: "fixed" | "flexible" = "fixed") {
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
  await choose(scenario, mode);
  await scenario.page.locator('[data-answer="hours-6"]').click();
  await scenario.page.locator('[data-parity="availability.longest"]').fill("2");
  if (mode === "fixed") {
    for (const day of [1, 3, 6])
      await scenario.page.locator(`input[name="usableWeekdays"][value="${day}"]`).check();
  }
  await continueAnswer(scenario);
  await choose(scenario, "asap");
  await choose(scenario, "none");
  await choose(scenario, "regular");
  await scenario.page.locator('[data-parity="choice.custom"][data-answer="custom"]').click();
  await scenario.page.locator('[data-parity="custom.textarea"]').fill("Ride four steady hours");
  await continueAnswer(scenario);
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

async function confirmReplacement(scenario: Scenario, connected = true) {
  expect((await scenario.backend.card())?.calendarWindow).toEqual(
    connected ? { startDate: "1998-01-04", endDate: "1998-01-09" } : null,
  );
  await scenario.page.getByRole("button", { name: "Activate Plan", exact: true }).click();
  const dialog = scenario.page.getByRole("dialog", { name: "Close and activate?", exact: true });
  await expect(dialog).toContainText("Today’s calendar Workout stays. The new Plan activates now.");
  await expect(dialog).toContainText(
    connected
      ? "Dated Workouts sync from tomorrow through 9 Jan 1998."
      : "Calendar updates wait until intervals.icu is connected.",
  );
  await dialog.getByRole("button", { name: "Activate new Plan", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(scenario.page.getByText("Plan activated locally.", { exact: true })).toBeVisible();
}

test("shows calendar progress and the verified seven-day window", async ({ playwright }) => {
  test.setTimeout(120_000);
  const scenario = await launch(playwright, { delayMs: 30_000 });
  try {
    await navigate(scenario, "Plan");
    await expect(
      active(scenario).getByText("Calendar · Updating calendar", { exact: true }),
    ).toBeVisible();
    scenario.calendar.delayMs = 0;
    await scenario.backend.calendarIdle();
    await expect(active(scenario).getByText(windowLabel, { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    expect(scenario.calendar.events.map((event) => event.dateKey)).toEqual([
      19980103, 19980105, 19980107,
    ]);
  } finally {
    await close(scenario);
  }
});

test("retries a failed calendar mirror from the library", async ({ playwright }) => {
  test.setTimeout(120_000);
  const scenario = await launch(playwright);
  try {
    await navigate(scenario, "Plan");
    await expect(active(scenario).getByText(windowLabel, { exact: true })).toBeVisible();
    await navigate(scenario, "Chat");
    const preview = await scenario.backend.previewChange({
      commandId: "calendar-retry-preview",
      planId: scenario.seed.planId,
      expectedVersion: 1,
      intent: { kind: "longest-workout", minutes: 60 },
    });
    if (preview.status !== "previewed") throw new TypeError("Calendar retry Change is unavailable");
    scenario.calendar.failNextList = true;
    const applied = await scenario.backend.applyChange({
      commandId: "calendar-retry-apply",
      planId: scenario.seed.planId,
      expectedVersion: 1,
      changeId: preview.change.changeId,
      decision: "apply",
    });
    expect(applied.status).toBe("applied");
    await scenario.backend.calendarIdle();
    scenario.calendar.failNextList = true;
    await navigate(scenario, "Plan");
    await expect(
      active(scenario).getByText("Calendar sync failed. Retry available.", { exact: true }),
    ).toBeVisible();
    await scenario.backend.calendarIdle();
    expect((await scenario.backend.inspectActivation()).jobs).toEqual([
      expect.objectContaining({ status: "failed" }),
    ]);
    scenario.calendar.delayMs = 30_000;
    const reads = scenario.backend.planListRequests.length;
    await active(scenario).getByRole("button", { name: "Retry calendar", exact: true }).click();
    await expect.poll(() => scenario.backend.planListRequests.length).toBeGreaterThan(reads);
    await expect(
      active(scenario).getByText("Calendar · Updating calendar", { exact: true }),
    ).toBeVisible();
    scenario.calendar.delayMs = 0;
    await scenario.backend.calendarIdle();
    await expect(active(scenario).getByText(windowLabel, { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      active(scenario).getByRole("button", { name: "Retry calendar", exact: true }),
    ).toHaveCount(0);
  } finally {
    await close(scenario);
  }
});

test("recovers unfinished calendar work after crashing during a provider call", async ({
  playwright,
}) => {
  test.setTimeout(120_000);
  const scenario = await launch(playwright, { delayMs: 30_000 });
  try {
    await navigate(scenario, "Plan");
    await expect(
      active(scenario).getByText("Calendar · Updating calendar", { exact: true }),
    ).toBeVisible();
    expect(
      (await scenario.backend.inspectActivation()).jobs.some((job) => job.status === "running"),
    ).toBe(true);
    await scenario.browser.close();
    await scenario.fixture.relaunch(async () => {
      await scenario.backend.crash();
      scenario.calendar.delayMs = 0;
      await scenario.backend.reopen();
    });
    await scenario.backend.calendarIdle();
    await scenario.fixture.setViewport(1180, 820);
    Object.assign(scenario, await connect(playwright, scenario.fixture));
    await navigate(scenario, "Plan");
    await expect(active(scenario).getByText(windowLabel, { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    const workouts = (await scenario.backend.physicalWorkouts(scenario.seed.planId)).filter(
      (workout) =>
        workout.dateKey !== null && workout.dateKey >= 19980103 && workout.dateKey <= 19980109,
    );
    expect(workouts).toHaveLength(3);
    expect(scenario.calendar.events.map((event) => event.externalId).sort()).toEqual(
      workouts.map((workout) => planMirrorExternalId(scenario.seed.planId, workout.id)).sort(),
    );
  } finally {
    await close(scenario);
  }
});

test("keeps today's old Workout when replacement mirroring starts tomorrow", async ({
  playwright,
}) => {
  test.setTimeout(120_000);
  const scenario = await launch(playwright);
  try {
    const oldToday = scenario.calendar.events.find((event) => event.dateKey === 19980103);
    expect(oldToday).toBeDefined();
    const draft = await replacementDraft(scenario);
    await confirmReplacement(scenario);
    await scenario.backend.calendarIdle();
    const library = await scenario.backend.library();
    if (library.active === null) throw new TypeError("Replacement Plan is unavailable");
    const currentPlanId = library.active.planId;
    expect(currentPlanId).not.toBe(scenario.seed.planId);
    expect(
      scenario.calendar.events.filter((event) =>
        event.externalId?.startsWith(planMirrorExternalIdPrefix(scenario.seed.planId)),
      ),
    ).toEqual([oldToday]);
    const expected = draft.weeks
      .flatMap((week) => week.workouts)
      .filter(
        (workout) => workout.date !== null && workout.date > today && workout.date <= "1998-01-09",
      );
    expect(expected.length).toBeGreaterThan(0);
    const physicalIds = await physicalWorkoutIds(scenario.backend, currentPlanId);
    expect(
      scenario.calendar.events
        .filter((event) => event.externalId?.startsWith(planMirrorExternalIdPrefix(currentPlanId)))
        .map((event) => event.externalId)
        .sort(),
    ).toEqual(
      expected
        .map((workout) => planMirrorExternalId(currentPlanId, physicalIds(workout.id)))
        .sort(),
    );
    expect(scenario.calendar.events.filter((event) => event.dateKey === 19980103)).toEqual([
      oldToday,
    ]);
    await navigate(scenario, "Plan");
    await expect(active(scenario).getByText(windowLabel, { exact: true })).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await close(scenario);
  }
});

test("never mirrors undated Workouts", async ({ playwright }) => {
  test.setTimeout(120_000);
  const scenario = await launch(playwright);
  try {
    const draft = await replacementDraft(scenario, "flexible");
    const undated = draft.weeks
      .flatMap((week) => week.workouts)
      .filter((workout) => workout.date === null);
    expect(undated.length).toBeGreaterThan(0);
    await confirmReplacement(scenario);
    await scenario.backend.calendarIdle();
    const library = await scenario.backend.library();
    if (library.active === null) throw new TypeError("Replacement Plan is unavailable");
    const currentPlanId = library.active.planId;
    const physical = await scenario.backend.physicalWorkouts(currentPlanId);
    const undatedIds = new Set(undated.map((workout) => workout.id));
    expect(
      physical.filter((workout) => undatedIds.has(draftWorkoutId(workout.structureJson))),
    ).toEqual([]);
    const expected = physical.filter(
      (workout) =>
        workout.dateKey !== null && workout.dateKey > 19980103 && workout.dateKey <= 19980109,
    );
    expect(
      scenario.calendar.events
        .filter((event) => event.externalId?.startsWith(planMirrorExternalIdPrefix(currentPlanId)))
        .map((event) => event.externalId)
        .sort(),
    ).toEqual(expected.map((workout) => planMirrorExternalId(currentPlanId, workout.id)).sort());
    expect(
      scenario.calendar.creates.filter(
        (event) =>
          event.externalId.startsWith(planMirrorExternalIdPrefix(currentPlanId)) &&
          undatedIds.has(draftWorkoutId(event.structureJson)),
      ),
    ).toEqual([]);
  } finally {
    await close(scenario);
  }
});

test("explains that disconnected calendar updates must wait", async ({ playwright }) => {
  test.setTimeout(120_000);
  const scenario = await launch(playwright, { calendarConnected: false });
  try {
    await navigate(scenario, "Plan");
    await expect(
      active(scenario).getByText("Calendar · Connect to mirror Workouts", { exact: true }),
    ).toBeVisible();
    await replacementDraft(scenario);
    await confirmReplacement(scenario, false);
    await scenario.backend.calendarIdle();
    expect(scenario.calendar.events).toEqual([]);
    expect(scenario.calendar.lists).toEqual([]);
  } finally {
    await close(scenario);
  }
});

test("shows completed cleanup in final details after stopping a Plan", async ({ playwright }) => {
  test.setTimeout(120_000);
  const scenario = await launch(playwright);
  try {
    const oldToday = scenario.calendar.events.find((event) => event.dateKey === 19980103);
    expect(oldToday).toBeDefined();
    await navigate(scenario, "Plan");
    await active(scenario).getByRole("button", { name: "Stop Plan", exact: true }).click();
    await scenario.page
      .getByRole("dialog", { name: "Stop this Plan?", exact: true })
      .getByRole("button", { name: "Stop Plan", exact: true })
      .click();
    await expect(
      scenario.page.getByRole("button", { name: "Back to library", exact: true }),
    ).toBeVisible();
    await scenario.backend.calendarIdle();
    await scenario.page.getByRole("button", { name: "Back to library", exact: true }).click();
    await scenario.page.getByRole("button", { name: "Read final details", exact: true }).click();
    await expect(
      scenario.page.getByRole("row", { name: "Calendar Cleanup complete", exact: true }),
    ).toBeVisible();
    expect(scenario.calendar.events).toEqual([oldToday]);
    await expect(
      scenario.page.getByRole("button", { name: "Retry calendar", exact: true }),
    ).toHaveCount(0);
  } finally {
    await close(scenario);
  }
});
