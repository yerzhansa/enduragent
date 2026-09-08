import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Browser, type Page, type PlaywrightWorkerArgs } from "@playwright/test";
import {
  PlanChangeApplyRpcParamsSchema,
  PlanChangeWorkoutSchema,
  PlanCreationDraftSchema,
  type PlanChangeIntent,
  type PlanChangeModel,
  type PlanChangeWorkout,
  type PlanCreationDraft,
} from "@enduragent/coach-contract";
import { canonicalJson } from "@enduragent/kernel/archive";
import { launchDesktopFixture, type RunningDesktopFixture } from "../helpers/desktop-fixture.js";
import { PlanCreationBackend } from "../helpers/plan-creation-backend.js";

const token = "d".repeat(43);

interface Scenario {
  readonly backend: PlanCreationBackend;
  readonly fixture: RunningDesktopFixture;
  readonly scratch: string;
  readonly colorScheme: "light" | "dark";
  readonly width: number;
  readonly seed: Awaited<ReturnType<PlanCreationBackend["seedActiveTraining"]>>;
  browser: Browser;
  page: Page;
}

type Playwright = PlaywrightWorkerArgs["playwright"];

async function connect(
  playwright: Playwright,
  fixture: RunningDesktopFixture,
  colorScheme: "light" | "dark",
  initializeAppearance = false,
) {
  const browser = await playwright.chromium.connectOverCDP(fixture.remoteDebuggingUrl);
  const page = browser
    .contexts()[0]
    ?.pages()
    .find((candidate) => candidate.url().startsWith("enduragent://app/"));
  if (page === undefined) throw new TypeError("Plan Change renderer is unavailable");
  await expect(page.locator("[data-shell]")).toHaveAttribute("data-onboarding", "settled", {
    timeout: 30_000,
  });
  await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
  if (initializeAppearance) {
    const navigation = page.getByRole("navigation", { name: "Main navigation" });
    await navigation.getByRole("button", { name: "Settings", exact: true }).click();
    const appearance = page
      .getByRole("group", { name: "Appearance", exact: true })
      .getByRole("button", { name: colorScheme === "light" ? "Light" : "Dark", exact: true });
    await appearance.click();
    await expect(appearance).toHaveAttribute("aria-pressed", "true");
    await navigation.getByRole("button", { name: "Chat", exact: true }).click();
  }
  await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
  expect(await page.evaluate(() => localStorage.getItem("enduragent.ui.appearance"))).toBe(
    colorScheme,
  );
  return { browser, page };
}

async function launch(
  playwright: Playwright,
  appearance: { readonly width: number; readonly colorScheme: "light" | "dark" },
): Promise<Scenario> {
  const scratch = await mkdtemp(join(tmpdir(), "plan-change-"));
  const backend = new PlanCreationBackend(join(scratch, "store.db"), false, true);
  let fixture: RunningDesktopFixture | undefined;
  try {
    await backend.open();
    const seed = await backend.seedActiveTraining();
    fixture = await launchDesktopFixture({
      script: backend.script,
      token,
      width: appearance.width,
      height: 820,
      colorScheme: appearance.colorScheme,
      reducedMotion: true,
      hidden: true,
      routeChatAttachmentComposer: true,
    });
    await fixture.setViewport(appearance.width, 820);
    const connected = await connect(playwright, fixture, appearance.colorScheme, true);
    expect(await connected.page.evaluate(() => innerWidth)).toBe(appearance.width);
    return { backend, fixture, scratch, seed, ...appearance, ...connected };
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

async function relaunch(scenario: Scenario, playwright: Playwright): Promise<void> {
  await scenario.browser.close();
  await scenario.fixture.relaunch(() => scenario.backend.reopen());
  await scenario.fixture.setViewport(scenario.width, 820);
  Object.assign(scenario, await connect(playwright, scenario.fixture, scenario.colorScheme));
  expect(await scenario.page.evaluate(() => innerWidth)).toBe(scenario.width);
}

async function capture(scenario: Scenario, name: string): Promise<void> {
  const screenshotPath = test.info().outputPath(`${name}.png`);
  await scenario.page.screenshot({ path: screenshotPath });
  await test.info().attach(`${name}-screenshot`, {
    path: screenshotPath,
    contentType: "image/png",
  });
  await test.info().attach(`${name}-dom`, {
    body: await scenario.page.content(),
    contentType: "text/html",
  });
  expect(
    await scenario.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await expect(scenario.page.locator("html")).toHaveAttribute("data-theme", scenario.colorScheme);
}

async function close(scenario: Scenario): Promise<void> {
  try {
    await test.info().attach("stored-plan-change", {
      body: JSON.stringify({
        card: await scenario.backend.card(),
        activation: await scenario.backend.inspectActivation(),
        requests: scenario.backend.creationRequests,
        seed: scenario.seed,
        library: await scenario.backend.library(),
        responses: scenario.backend.changeApplyResponses,
      }),
      contentType: "application/json",
    });
    await capture(scenario, "final");
  } finally {
    await scenario.browser.close().catch(() => {});
    try {
      const cleanup = await scenario.fixture.close();
      await test.info().attach("cleanup", {
        body: JSON.stringify(cleanup),
        contentType: "application/json",
      });
      expect(cleanup).toEqual({ livePids: [], listenerCount: 0 });
    } finally {
      try {
        await scenario.backend.close();
      } finally {
        await rm(scenario.scratch, { recursive: true, force: true });
      }
    }
  }
}

type Stored = Awaited<ReturnType<PlanCreationBackend["inspectActivation"]>>;

const appearances = [
  { width: 1180, colorScheme: "light" },
  { width: 1180, colorScheme: "dark" },
  { width: 720, colorScheme: "light" },
  { width: 720, colorScheme: "dark" },
] as const;
const options = [
  "Weekday duration cap",
  "Weekday unavailable",
  "No hard training on a weekday",
  "Weekly duration cap",
  "Longest-Workout cap",
  "Correct FTP",
  "Supporting Event",
];
const confidence =
  "Moderate confidence. Based on your confirmed limits and the available training record.";
const durationCap = {
  label: "Weekday duration cap",
  title: "Limit weekday duration",
  intent: { kind: "weekday-duration", day: 3, minutes: 30 },
  weeklyMinutes: 135,
} satisfies ChangeCase;

interface ChangeCase {
  readonly label: string;
  readonly title: string;
  readonly intent: PlanChangeIntent;
  readonly weeklyMinutes: number;
}

function changes(scenario: Scenario) {
  return scenario.page.getByRole("region", { name: "Plan Changes", exact: true });
}

function changeCard(scenario: Scenario, title: string, status: string) {
  return changes(scenario)
    .getByRole("region", { name: title, exact: true })
    .filter({ has: scenario.page.getByText(status, { exact: true }) });
}

async function navigate(scenario: Scenario, destination: "Chat" | "Plan") {
  await scenario.page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: destination, exact: true })
    .click();
}

async function enterChanges(scenario: Scenario) {
  await expect(changes(scenario)).toBeVisible();
  await expect(changes(scenario).getByRole("button")).toHaveText(["Change one thing", "Open Plan"]);
  await navigate(scenario, "Plan");
  await scenario.page
    .getByRole("region", { name: "Plan library", exact: true })
    .getByRole("button", { name: "Change in Chat", exact: true })
    .click();
  await expect(changes(scenario)).toBeVisible();
  await expect(changes(scenario).getByRole("button")).toHaveText(["Change one thing", "Open Plan"]);
  const stored = await scenario.backend.inspectActivation();
  expect(stored.planningPlans).toHaveLength(1);
  expect(stored.planningPlans[0]).toMatchObject({
    plan_id: scenario.seed.planId,
    status: "active",
    version: 1,
    current_revision_number: 1,
  });
  expect(stored.revisions).toHaveLength(1);
  expect(
    PlanCreationDraftSchema.parse(JSON.parse(String(stored.revisions[0]?.snapshot_json))),
  ).toEqual(scenario.seed.draft);
  const seeded = scenario.seed.draft.weeks.flatMap((week) => week.workouts);
  expect(seeded).toHaveLength(12);
  expect(
    stored.workouts.map((row) =>
      PlanChangeWorkoutSchema.parse(JSON.parse(String(row.structure_json))),
    ),
  ).toEqual(seeded);
  expect(
    scenario.seed.draft.weeks.map((week) =>
      week.workouts.map((workout) => ({
        name: workout.name,
        minutes: workout.minutes,
        pinned: workout.pinned,
        weekday: weekday(workout),
      })),
    ),
  ).toEqual(
    Array.from({ length: 4 }, () => [
      { name: "Controlled effort", minutes: 45, pinned: false, weekday: 6 },
      { name: "Endurance ride", minutes: 60, pinned: false, weekday: 1 },
      { name: "Long ride", minutes: 100, pinned: false, weekday: 3 },
    ]),
  );
}

function weekday(workout: PlanChangeWorkout): number | null {
  return workout.date === null ? null : new Date(`${workout.date}T12:00:00Z`).getUTCDay() || 7;
}

function expectedChange(draft: PlanCreationDraft, intent: PlanChangeIntent) {
  const diff: PlanChangeModel["diff"] = [];
  const weeks = draft.weeks.map((week) => {
    const beforeMinutes = week.workouts.reduce((sum, workout) => sum + workout.minutes, 0);
    const workouts = week.workouts.flatMap((before) => {
      if (before.pinned || before.date === null || before.date < "1998-01-01") return [before];
      let after: PlanChangeWorkout | null = before;
      switch (intent.kind) {
        case "weekday-duration":
          if (weekday(before) === intent.day && before.minutes > intent.minutes)
            after = { ...before, minutes: intent.minutes };
          break;
        case "weekday-unavailable":
          if (weekday(before) === intent.day) after = null;
          break;
        case "hard-weekday":
          if (weekday(before) === intent.day && before.kind === "hard")
            after = { ...before, kind: "easy", name: "Easy ride" };
          break;
        case "weekly-duration":
          if (before.kind === "long" && beforeMinutes > intent.hours * 60)
            after = { ...before, minutes: before.minutes - (beforeMinutes - intent.hours * 60) };
          break;
        case "longest-workout":
          if (before.minutes > intent.minutes) after = { ...before, minutes: intent.minutes };
          break;
      }
      if (after !== before) diff.push({ workoutId: before.id, before, after });
      return after === null ? [] : [after];
    });
    return { ...week, workouts };
  });
  const totals = (value: PlanCreationDraft["weeks"]) => {
    const weeks = value.map((week) => ({
      number: week.number,
      minutes: week.workouts.reduce(
        (sum, workout) => sum + (workout.date === null ? 0 : workout.minutes),
        0,
      ),
    }));
    return { plan: weeks.reduce((sum, week) => sum + week.minutes, 0), weeks };
  };
  return { diff, weeks, totals: { before: totals(draft.weeks), after: totals(weeks) } };
}

function workoutText(workout: PlanChangeWorkout | null): string {
  if (workout === null) return "Not in Plan";
  const date =
    workout.date === null
      ? "Undated"
      : new Intl.DateTimeFormat("en-GB", {
          day: "numeric",
          month: "short",
          year: "numeric",
          timeZone: "UTC",
        }).format(new Date(`${workout.date}T12:00:00Z`));
  return `${date} · ${workout.minutes} min`;
}

async function preview(scenario: Scenario, change: ChangeCase) {
  await changes(scenario).getByRole("button", { name: "Change one thing", exact: true }).click();
  const editor = changes(scenario).getByRole("region", {
    name: "What needs to change?",
    exact: true,
  });
  const kind = editor.getByRole("combobox", { name: "Change", exact: true });
  await expect(kind).toBeFocused();
  await expect(kind).toContainText("Weekday duration cap");
  await expect(editor.getByRole("combobox", { name: "Weekday", exact: true })).toContainText("Wed");
  await expect(
    editor.getByRole("spinbutton", { name: "Duration limit in minutes", exact: true }),
  ).toHaveValue("30");
  await expect(editor.getByRole("button", { name: /^(Back|Preview change)$/ })).toHaveText([
    "Back",
    "Preview change",
  ]);
  await kind.click();
  await expect(scenario.page.getByRole("option")).toHaveText(options);
  await scenario.page.getByRole("option", { name: change.label, exact: true }).click();
  const intent = change.intent;
  if (
    intent.kind === "weekday-duration" ||
    intent.kind === "weekday-unavailable" ||
    intent.kind === "hard-weekday"
  ) {
    const day = editor.getByRole("combobox", { name: "Weekday", exact: true });
    await expect(day).toContainText(intent.kind === "hard-weekday" ? "Mon" : "Wed");
    await day.click();
    const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    await expect(scenario.page.getByRole("option")).toHaveText(days);
    await scenario.page.getByRole("option", { name: days[intent.day - 1], exact: true }).click();
  }
  if (intent.kind === "weekday-duration" || intent.kind === "longest-workout")
    await expect(
      editor.getByRole("spinbutton", { name: "Duration limit in minutes", exact: true }),
    ).toHaveValue(String(intent.minutes));
  if (intent.kind === "weekly-duration")
    await expect(
      editor.getByRole("spinbutton", { name: "Weekly limit in hours", exact: true }),
    ).toHaveValue("3");
  await editor.getByRole("button", { name: "Preview change", exact: true }).click();
  await expect(
    changeCard(scenario, change.title, "Pending").getByRole("heading", {
      name: change.title,
      exact: true,
    }),
  ).toBeFocused();
  expect(scenario.backend.creationRequests.at(-1)).toMatchObject({
    method: "plan_change.preview",
    params: { planId: scenario.seed.planId, expectedVersion: 1, intent },
  });
  return assertPreview(scenario, change);
}

async function assertPreview(scenario: Scenario, change: ChangeCase) {
  const expected = expectedChange(scenario.seed.draft, change.intent);
  expect(expected.diff).toHaveLength(4);
  expect(expected.totals.before.plan).toBe(820);
  expect(expected.totals.after.plan).toBe(change.weeklyMinutes * 4);
  const pending = changeCard(scenario, change.title, "Pending");
  await expect(pending.getByText("Pending", { exact: true })).toBeVisible();
  const table = pending.getByRole("table", { name: "Affected individual Workouts", exact: true });
  await expect(table.getByRole("row")).toHaveCount(expected.diff.length);
  await expect(table.getByRole("rowheader")).toHaveText(
    expected.diff.map((row) => row.before?.name ?? "Workout"),
  );
  await expect(table.getByRole("cell")).toHaveText(
    expected.diff.map(
      (row) =>
        `${workoutText(row.before)} → ${workoutText(row.after)}${row.before && row.after && row.before.name !== row.after.name ? ` · ${row.after.name}` : ""}`,
    ),
  );
  const totals = pending.getByRole("table", { name: "Before and after totals", exact: true });
  await expect(totals.getByRole("rowheader")).toHaveText([
    "Plan totals",
    "Week 1",
    "Week 2",
    "Week 3",
    "Week 4",
  ]);
  await expect(totals.getByRole("cell")).toHaveText([
    `${expected.totals.before.plan} min → ${expected.totals.after.plan} min`,
    ...expected.totals.before.weeks.map(
      (week, index) => `${week.minutes} min → ${expected.totals.after.weeks[index]?.minutes} min`,
    ),
  ]);
  const facts = pending.getByRole("table", { name: "Facts", exact: true });
  await expect(facts.getByRole("rowheader")).toHaveText([
    "Main Goal",
    "Supporting Events before",
    "Supporting Events after",
    "Confidence",
  ]);
  await expect(facts.getByRole("cell")).toHaveText(["Improve fitness", "None", "None", confidence]);
  await expect(pending.getByRole("button")).toHaveText([
    "View evidence",
    "Cancel",
    "Apply to Plan",
  ]);
  const stored = (await scenario.backend.library()).changes.find(
    (value) => value.status === "pending",
  );
  if (!stored) throw new TypeError("Pending Change is unavailable");
  expect(stored).toMatchObject({
    title: change.title,
    intent: change.intent,
    diff: expected.diff,
    totals: expected.totals,
    baseRevisionNumber: 1,
  });
  return stored;
}

function training(stored: Stored) {
  return {
    plans: stored.plans,
    planningPlans: stored.planningPlans,
    revisions: stored.revisions,
    workouts: stored.workouts,
    creations: stored.creations,
  };
}

async function assertApplied(scenario: Scenario, pending: PlanChangeModel, before: Stored) {
  await expect(changes(scenario).getByRole("status")).toHaveText(
    "Change applied locally. Training now matches the confirmed preview.",
  );
  await expect(changeCard(scenario, pending.title, "Applied")).toBeVisible();
  await expect(changeCard(scenario, pending.title, "Pending")).toHaveCount(0);
  const after = await scenario.backend.inspectActivation();
  expect(after.planningPlans).toHaveLength(1);
  expect(after.planningPlans[0]).toMatchObject({
    plan_id: scenario.seed.planId,
    version: 2,
    current_revision_number: 2,
  });
  expect(after.revisions).toHaveLength(2);
  expect(after.revisions[0]).toEqual(before.revisions[0]);
  expect(after.revisions[1]).toMatchObject({
    plan_id: scenario.seed.planId,
    revision_number: 2,
    parent_revision_number: 1,
    source_kind: "plan-change",
    source_id: pending.changeId,
  });
  const expected = expectedChange(scenario.seed.draft, pending.intent);
  const revision = PlanCreationDraftSchema.parse(
    JSON.parse(String(after.revisions[1]?.snapshot_json)),
  );
  expect(revision).toEqual({
    ...scenario.seed.draft,
    weeks: expected.weeks,
    outputFingerprint: revision.outputFingerprint,
  });
  expect(revision.outputFingerprint).not.toBe(scenario.seed.draft.outputFingerprint);
  expect(after.workouts.map((row) => row.id)).toEqual(before.workouts.map((row) => row.id));
  const expectedById = new Map(expected.diff.map((row) => [row.workoutId, row.after]));
  for (const original of before.workouts) {
    const workout = PlanChangeWorkoutSchema.parse(JSON.parse(String(original.structure_json)));
    const updated = after.workouts.find((row) => row.id === original.id);
    const target = expectedById.get(workout.id);
    if (target === undefined) {
      expect(updated).toEqual(original);
    } else {
      if (target === null) throw new TypeError("Apply fixture must retain every Workout");
      expect(updated).toEqual({
        ...original,
        duration_s: target.minutes * 60,
        structure_json: canonicalJson(target),
        hlc_physical_ms: after.revisions[1]?.hlc_physical_ms,
      });
    }
  }
  expect(after.changes).toHaveLength(1);
  expect(after.changes[0]).toMatchObject({ id: pending.changeId, status: "applied" });
  expect(after.commands.slice(0, -1)).toEqual(before.commands);
  expect(after.commands.at(-1)).toMatchObject({
    command_name: "plan_change.apply",
    status: "succeeded",
  });
  return after;
}

async function assertPlanPage(scenario: Scenario, stored: Stored) {
  await navigate(scenario, "Plan");
  await scenario.page.getByRole("button", { name: "Read Plan details", exact: true }).click();
  await expect(
    scenario.page.getByRole("heading", { name: "Plan active · week 1 of 4", exact: true }),
  ).toBeVisible();
  const firstWednesday = stored.workouts.find((row) => row.date_key === 19980107);
  if (!firstWednesday) throw new TypeError("First Wednesday is unavailable");
  await expect(
    scenario.page.locator(`#workout-row-${firstWednesday.id}`).getByText("30 min", { exact: true }),
  ).toBeVisible();
}

for (const appearance of appearances) {
  test(`persists and applies a Schedule Change at ${appearance.width} in ${appearance.colorScheme}`, async ({
    playwright,
  }) => {
    test.setTimeout(120_000);
    const scenario = await launch(playwright, appearance);
    try {
      await enterChanges(scenario);
      const initial = await scenario.backend.inspectActivation();
      const pending = await preview(scenario, durationCap);
      const before = await scenario.backend.inspectActivation();
      expect(training(before)).toEqual(training(initial));
      const card = changeCard(scenario, pending.title, "Pending");
      await card.getByRole("button", { name: "View evidence", exact: true }).click();
      const source = changes(scenario).getByRole("region", { name: "Source details", exact: true });
      await expect(
        source.getByRole("heading", { name: "Source details", exact: true }),
      ).toBeFocused();
      const details = source.getByRole("table", { name: "Source details", exact: true });
      await expect(details.getByRole("rowheader")).toHaveText([
        "Confirmed Plan limits · Your confirmed answers",
      ]);
      await expect(details.getByRole("cell")).toHaveText([
        "Up to 6 h a week, longest Workout 2 h, Mon, Wed, Sat · No fixed commitments · No training restrictions",
      ]);
      await source.getByRole("button", { name: "Back", exact: true }).click();
      await expect(card.getByRole("button", { name: "View evidence", exact: true })).toBeFocused();
      await expect(source).toHaveCount(0);
      await card.getByRole("heading").scrollIntoViewIfNeeded();
      await capture(scenario, `preview-${appearance.width}-${appearance.colorScheme}`);
      await navigate(scenario, "Plan");
      await navigate(scenario, "Chat");
      expect(await assertPreview(scenario, durationCap)).toEqual(pending);
      await relaunch(scenario, playwright);
      expect(await assertPreview(scenario, durationCap)).toEqual(pending);
      expect(await scenario.backend.inspectActivation()).toEqual(before);
      await changeCard(scenario, pending.title, "Pending")
        .getByRole("button", { name: "Apply to Plan", exact: true })
        .click();
      const after = await assertApplied(scenario, pending, before);
      await capture(scenario, `applied-${appearance.width}-${appearance.colorScheme}`);
      await assertPlanPage(scenario, after);
      await capture(scenario, `plan-${appearance.width}-${appearance.colorScheme}`);
    } finally {
      await close(scenario);
    }
  });
}

const otherChanges: ChangeCase[] = [
  {
    label: "Weekday unavailable",
    title: "Keep a weekday free",
    intent: { kind: "weekday-unavailable", day: 3 },
    weeklyMinutes: 105,
  },
  {
    label: "No hard training on a weekday",
    title: "No hard training on a weekday",
    intent: { kind: "hard-weekday", day: 6 },
    weeklyMinutes: 205,
  },
  {
    label: "Weekly duration cap",
    title: "Limit weekly duration",
    intent: { kind: "weekly-duration", hours: 3 },
    weeklyMinutes: 180,
  },
  {
    label: "Longest-Workout cap",
    title: "Limit the longest Workout",
    intent: { kind: "longest-workout", minutes: 60 },
    weeklyMinutes: 165,
  },
];

for (const change of otherChanges) {
  for (const appearance of appearances) {
    test(`previews ${change.label} and cancels without changing training at ${appearance.width} in ${appearance.colorScheme}`, async ({
      playwright,
    }) => {
      test.setTimeout(120_000);
      const scenario = await launch(playwright, appearance);
      try {
        await enterChanges(scenario);
        const initial = await scenario.backend.inspectActivation();
        const pending = await preview(scenario, change);
        const before = await scenario.backend.inspectActivation();
        expect(training(before)).toEqual(training(initial));
        await capture(scenario, `preview-${change.intent.kind}`);
        await changeCard(scenario, pending.title, "Pending")
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        await expect(changes(scenario).getByRole("status")).toHaveText(
          "Change cancelled. Training is unchanged; the preview remains in history.",
        );
        await expect(changeCard(scenario, pending.title, "Cancelled")).toBeVisible();
        await expect(changeCard(scenario, pending.title, "Pending")).toHaveCount(0);
        await expect(
          changes(scenario).getByRole("button", { name: "Change one thing", exact: true }),
        ).toBeFocused();
        const after = await scenario.backend.inspectActivation();
        expect(training(after)).toEqual(training(before));
        expect(after.changes).toHaveLength(1);
        expect(after.changes[0]).toMatchObject({
          id: pending.changeId,
          status: "discarded",
          version: Number(before.changes[0]?.version) + 1,
        });
        expect(after.commands.slice(0, -1)).toEqual(before.commands);
        expect(
          after.commands.filter((row) => row.command_name === "plan_change.apply"),
        ).toHaveLength(1);
        expect(after.commands.at(-1)).toMatchObject({
          command_name: "plan_change.apply",
          status: "succeeded",
        });
        expect(scenario.backend.changeApplyResponses.at(-1)).toMatchObject({
          params: { decision: "cancel", changeId: pending.changeId },
          result: { status: "cancelled" },
        });
        const history = changeCard(scenario, pending.title, "Cancelled");
        await history.getByRole("button", { name: "Read this difference", exact: true }).click();
        const source = changes(scenario).getByRole("region", {
          name: "Source details",
          exact: true,
        });
        await expect(source.getByText("Cancelled", { exact: true })).toBeVisible();
        await expect(
          source
            .getByRole("table", { name: "Affected individual Workouts", exact: true })
            .getByRole("row"),
        ).toHaveCount(4);
        await source.getByRole("button", { name: "Back", exact: true }).click();
        await capture(scenario, `cancelled-${change.intent.kind}`);
      } finally {
        await close(scenario);
      }
    });
  }
}

test("supersedes a pending Change with a second request", async ({ playwright }) => {
  test.setTimeout(120_000);
  const scenario = await launch(playwright, appearances[0]);
  try {
    await enterChanges(scenario);
    const first = await preview(scenario, durationCap);
    const before = await scenario.backend.inspectActivation();
    const secondCase = otherChanges.find((change) => change.intent.kind === "longest-workout");
    if (!secondCase) throw new TypeError("Second Change is unavailable");
    const second = await preview(scenario, secondCase);
    await expect(changes(scenario).getByRole("status")).toHaveText(
      `This preview supersedes “${first.title}”. Training is unchanged until confirmation.`,
    );
    await expect(changeCard(scenario, first.title, "Superseded")).toBeVisible();
    await expect(changeCard(scenario, first.title, "Pending")).toHaveCount(0);
    expect(second.supersedes).toBe(first.changeId);
    const library = await scenario.backend.library();
    expect(library.changes.find((change) => change.changeId === first.changeId)).toEqual({
      ...first,
      status: "superseded",
      supersededBy: second.changeId,
    });
    const after = await scenario.backend.inspectActivation();
    expect(training(after)).toEqual(training(before));
    expect(after.changes.map((row) => ({ id: row.id, status: row.status }))).toEqual([
      { id: first.changeId, status: "discarded" },
      { id: second.changeId, status: "preview" },
    ]);
    expect(after.commands.slice(0, -1)).toEqual(before.commands);
    expect(after.commands.at(-1)).toMatchObject({
      command_name: "plan_change.preview",
      status: "succeeded",
    });
    await capture(scenario, "superseded");
  } finally {
    await close(scenario);
  }
});

test("rejects a stale preview after an out-of-band Plan revision", async ({ playwright }) => {
  test.setTimeout(120_000);
  const scenario = await launch(playwright, appearances[0]);
  try {
    await enterChanges(scenario);
    const pending = await preview(scenario, durationCap);
    const advanced = await scenario.backend.previewChange({
      commandId: "advance-plan-preview",
      planId: scenario.seed.planId,
      expectedVersion: 1,
      intent: { kind: "longest-workout", minutes: 60 },
    });
    if (advanced.status !== "previewed") throw new TypeError("Out-of-band preview was rejected");
    expect(
      await scenario.backend.applyChange({
        commandId: "advance-plan-apply",
        planId: scenario.seed.planId,
        expectedVersion: 1,
        changeId: advanced.change.changeId,
        decision: "apply",
      }),
    ).toEqual({
      status: "applied",
      changeId: advanced.change.changeId,
      revisionNumber: 2,
      version: 2,
    });
    const before = await scenario.backend.inspectActivation();
    await changeCard(scenario, pending.title, "Pending")
      .getByRole("button", { name: "Apply to Plan", exact: true })
      .click();
    await expect(changes(scenario).getByRole("status")).toHaveText(
      "This preview is stale because the Plan or its sources changed. Request a fresh preview; no training changed.",
    );
    expect(scenario.backend.changeApplyResponses).toHaveLength(1);
    expect(scenario.backend.changeApplyResponses[0]).toMatchObject({
      params: { changeId: pending.changeId, expectedVersion: 1, decision: "apply" },
      result: { status: "rejected", reason: "stale-version" },
    });
    expect(await scenario.backend.inspectActivation()).toEqual(before);
    await capture(scenario, "stale");
  } finally {
    await close(scenario);
  }
});

test("replays the renderer apply command without another write", async ({ playwright }) => {
  test.setTimeout(120_000);
  const scenario = await launch(playwright, appearances[0]);
  try {
    await enterChanges(scenario);
    const pending = await preview(scenario, durationCap);
    const before = await scenario.backend.inspectActivation();
    await changeCard(scenario, pending.title, "Pending")
      .getByRole("button", { name: "Apply to Plan", exact: true })
      .click();
    const applied = await assertApplied(scenario, pending, before);
    const request = scenario.backend.creationRequests.find(
      (entry) => entry.method === "plan_change.apply",
    );
    if (!request) throw new TypeError("Renderer apply request is unavailable");
    const params = PlanChangeApplyRpcParamsSchema.parse(request.params);
    const response = scenario.backend.changeApplyResponses.find(
      (entry) => entry.params.commandId === params.commandId,
    );
    if (!response) throw new TypeError("Renderer apply response is unavailable");
    expect(response.params).toEqual(params);
    expect(response.result).toEqual({
      status: "applied",
      changeId: pending.changeId,
      revisionNumber: 2,
      version: 2,
    });
    expect(await scenario.backend.applyChange(params)).toEqual(response.result);
    expect(await scenario.backend.inspectActivation()).toEqual(applied);
    expect(applied.commands.filter((row) => row.command_name === "plan_change.apply")).toHaveLength(
      1,
    );
    await capture(scenario, "replayed");
  } finally {
    await close(scenario);
  }
});
