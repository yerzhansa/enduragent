import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser, type Page, type PlaywrightWorkerArgs } from "@playwright/test";
import { PlanChangeWorkoutSchema, PlanCreationDraftSchema } from "@enduragent/coach-contract";
import { launchDesktopFixture, type RunningDesktopFixture } from "../helpers/desktop-fixture.js";
import { PlanCreationBackend } from "../helpers/plan-creation-backend.js";

const token = "d".repeat(43);
const previews = fileURLToPath(new URL("./previews/plan-change-events/", import.meta.url));

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
  synchronized = false,
): Promise<Scenario> {
  const scratch = await mkdtemp(join(tmpdir(), "plan-change-events-"));
  const backend = new PlanCreationBackend(join(scratch, "store.db"), false, true, {
    calendarConnected: synchronized,
  });
  let fixture: RunningDesktopFixture | undefined;
  try {
    await backend.open();
    const seed = await backend.seedActiveTraining();
    if (synchronized) {
      if (seed.planId === null) throw new TypeError("Active Plan is unavailable");
      await backend.recordSuccessfulSync();
    }
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

async function capture(scenario: Scenario, name: string): Promise<void> {
  await mkdir(previews, { recursive: true });
  const screenshotPath = join(previews, `${name}-${scenario.width}-${scenario.colorScheme}.png`);
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

const appearances = [
  { width: 1180, colorScheme: "light" },
  { width: 1180, colorScheme: "dark" },
  { width: 720, colorScheme: "light" },
  { width: 720, colorScheme: "dark" },
] as const;

function changes(scenario: Scenario) {
  return scenario.page.getByRole("region", { name: "Plan Changes", exact: true });
}

function changeCard(scenario: Scenario, title: string, status: string) {
  return changes(scenario)
    .getByRole("region", { name: title, exact: true })
    .filter({ has: scenario.page.getByText(status, { exact: true }) });
}

async function openChanges(scenario: Scenario) {
  await scenario.page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Plan", exact: true })
    .click();
  await scenario.page
    .getByRole("region", { name: "Plan library", exact: true })
    .getByRole("button", { name: "Change in Chat", exact: true })
    .click();
  await expect(changes(scenario)).toBeVisible();
}

async function editEvent(scenario: Scenario, operation: string) {
  await changes(scenario).getByRole("button", { name: "Change one thing", exact: true }).click();
  const editor = changes(scenario).getByRole("region", {
    name: "What needs to change?",
    exact: true,
  });
  await editor.getByRole("combobox", { name: "Change", exact: true }).click();
  await scenario.page.getByRole("option", { name: "Supporting Event", exact: true }).click();
  await editor.getByRole("combobox", { name: "Supporting Event operation", exact: true }).click();
  await scenario.page.getByRole("option", { name: operation, exact: true }).click();
  return editor;
}

async function previewEvent(scenario: Scenario, title: string) {
  await changes(scenario).getByRole("button", { name: "Preview change", exact: true }).click();
  const card = changeCard(scenario, title, "Pending");
  await expect(card.getByRole("heading", { name: title, exact: true })).toBeFocused();
  await expect(card.getByText("Supporting Events before", { exact: true })).toBeVisible();
  await expect(card.getByText("Supporting Events after", { exact: true })).toBeVisible();
  return card;
}

async function applyEvent(scenario: Scenario, title: string) {
  await changeCard(scenario, title, "Pending")
    .getByRole("button", { name: "Apply to Plan", exact: true })
    .click();
  await expect(changes(scenario).getByRole("status")).toHaveText(
    "Change applied locally. Training now matches the confirmed preview.",
  );
  await expect(changeCard(scenario, title, "Applied")).toBeVisible();
  return latestDraft(scenario);
}

async function latestDraft(scenario: Scenario) {
  const stored = await scenario.backend.inspectActivation();
  const latest = stored.revisions.at(-1);
  if (typeof latest?.snapshot_json !== "string")
    throw new TypeError("Plan revision is unavailable");
  return PlanCreationDraftSchema.parse(JSON.parse(latest.snapshot_json));
}

for (const appearance of appearances) {
  test(`adds, changes role, renames, removes and undoes a Supporting Event at ${appearance.width} in ${appearance.colorScheme}`, async ({
    playwright,
  }) => {
    test.setTimeout(120_000);
    const scenario = await launch(playwright, appearance);
    try {
      await openChanges(scenario);
      const editor = await editEvent(scenario, "Add a Supporting Event");
      await editor.getByRole("textbox", { name: "Event name", exact: true }).fill("Meadow ride");
      await editor.getByLabel("Event date", { exact: true }).fill("1998-01-10");
      await editor.getByRole("combobox", { name: "Plan role", exact: true }).click();
      await scenario.page.getByRole("option", { name: "Training", exact: true }).click();
      await capture(scenario, "manual-editor");
      await editor.getByLabel("Event date", { exact: true }).fill("1998-01-09");
      await editor.getByRole("button", { name: "Preview change", exact: true }).click();
      await expect(editor.getByRole("alert")).toHaveText(
        "The event date conflicts with a confirmed training limit.",
      );
      await capture(scenario, "invalid-event-date");
      await editor.getByLabel("Event date", { exact: true }).fill("1998-01-10");
      const addedCard = await previewEvent(scenario, "Add a Supporting Event");
      await expect(
        addedCard.getByText("Meadow ride · 10 Jan 1998 · Training", { exact: true }),
      ).toBeVisible();
      await capture(scenario, "manual-preview");
      const added = await applyEvent(scenario, "Add a Supporting Event");
      const event = added.supportingEvents[0];
      if (event === undefined) throw new TypeError("Accepted event is unavailable");
      expect(event).toMatchObject({
        name: "Meadow ride",
        date: "1998-01-10",
        role: "Training",
        source: { kind: "manual" },
      });
      const eventWorkout = added.weeks
        .flatMap((week) => week.workouts)
        .find((workout) => workout.supportingEventId === event.id);
      expect(eventWorkout).toMatchObject({
        kind: "event",
        minutes: 45,
        pinned: true,
        date: "1998-01-10",
      });

      const roleEditor = await editEvent(scenario, "Change a Supporting Event role");
      await expect(
        roleEditor.getByRole("combobox", { name: "Accepted Supporting Event", exact: true }),
      ).toContainText("Meadow ride");
      await roleEditor.getByRole("combobox", { name: "Plan role", exact: true }).click();
      await scenario.page.getByRole("option", { name: "Important", exact: true }).click();
      const roleCard = await previewEvent(scenario, "Change a Supporting Event role");
      await expect(
        roleCard.getByText("Meadow ride · 10 Jan 1998 · Important", { exact: true }),
      ).toBeVisible();
      await capture(scenario, "important-preview");
      const important = await applyEvent(scenario, "Change a Supporting Event role");
      expect(important.supportingEvents[0]).toMatchObject({ id: event.id, role: "Important" });
      const importantWorkouts = important.weeks.flatMap((week) => week.workouts);
      const capped = importantWorkouts.filter(
        (workout) =>
          !workout.pinned &&
          workout.date !== null &&
          workout.date >= "1998-01-05" &&
          workout.date <= "1998-01-11",
      );
      expect(capped.length).toBeGreaterThan(0);
      for (const workout of capped) {
        expect(workout.minutes).toBeLessThanOrEqual(30);
        expect(workout.kind).not.toBe("hard");
      }
      const outsideWeek = added.weeks
        .flatMap((week) => week.workouts)
        .filter(
          (workout) =>
            workout.date === null || workout.date < "1998-01-05" || workout.date > "1998-01-11",
        );
      expect(outsideWeek.length).toBeGreaterThan(0);
      for (const workout of outsideWeek) {
        expect(importantWorkouts.find((item) => item.id === workout.id)).toEqual(workout);
      }
      expect(importantWorkouts.find((workout) => workout.supportingEventId === event.id)?.id).toBe(
        eventWorkout?.id,
      );

      const nameEditor = await editEvent(scenario, "Rename a Supporting Event");
      await nameEditor
        .getByRole("textbox", { name: "Event name", exact: true })
        .fill("Meadow loop");
      const renameCard = await previewEvent(scenario, "Rename a Supporting Event");
      await expect(renameCard.getByText("No Workout changes.", { exact: true })).toBeVisible();
      await expect(
        renameCard.getByText("Meadow loop · 10 Jan 1998 · Important", { exact: true }),
      ).toBeVisible();
      const rename = (await scenario.backend.library()).changes.find(
        (change) => change.status === "pending",
      );
      expect(rename?.diff).toEqual([]);
      await capture(scenario, "rename-preview");
      const renamed = await applyEvent(scenario, "Rename a Supporting Event");
      expect(renamed.weeks).toEqual(important.weeks);
      expect(renamed.supportingEvents[0]).toMatchObject({ id: event.id, name: "Meadow loop" });

      await editEvent(scenario, "Remove a Supporting Event");
      const removal = await previewEvent(scenario, "Remove a Supporting Event");
      await expect(removal.getByText("None", { exact: true })).toBeVisible();
      const removed = await applyEvent(scenario, "Remove a Supporting Event");
      expect(removed.supportingEvents).toEqual([]);
      expect(
        removed.weeks
          .flatMap((week) => week.workouts)
          .some((workout) => workout.supportingEventId === event.id),
      ).toBe(false);
      await capture(scenario, "removed-event");
      await changeCard(scenario, "Remove a Supporting Event", "Applied")
        .getByRole("button", { name: "Undo", exact: true })
        .click();
      await expect(changeCard(scenario, "Undo the latest Change", "Pending")).toBeVisible();
      const restored = await applyEvent(scenario, "Undo the latest Change");
      expect(restored.supportingEvents).toEqual(renamed.supportingEvents);
      expect(restored.weeks).toEqual(renamed.weeks);
      expect((await scenario.backend.inspectActivation()).planningPlans[0]).toMatchObject({
        current_revision_number: 6,
      });
      await expect(
        changes(scenario).getByRole("button", { name: "Undo", exact: true }),
      ).toHaveCount(0);
      await capture(scenario, "restored-event");
    } finally {
      await close(scenario);
    }
  });

  test(`refuses changed synchronized event details at ${appearance.width} in ${appearance.colorScheme}`, async ({
    playwright,
  }) => {
    test.setTimeout(90_000);
    const scenario = await launch(playwright, appearance, true);
    try {
      await openChanges(scenario);
      const editor = await editEvent(scenario, "Add a Supporting Event");
      await editor.getByRole("combobox", { name: "Synchronized event", exact: true }).click();
      await scenario.page
        .getByRole("option", {
          name: "Local supporting ride · Intervals.icu event",
          exact: true,
        })
        .click();
      await capture(scenario, "synchronized-editor");
      const pending = await previewEvent(scenario, "Add a Supporting Event");
      await expect(
        pending.getByText("Local supporting ride · 10 Jan 1998 · Training", { exact: true }),
      ).toBeVisible();
      await pending.getByRole("button", { name: "View evidence", exact: true }).click();
      const evidence = changes(scenario).getByRole("region", {
        name: "Source details",
        exact: true,
      });
      await expect(evidence.getByRole("heading")).toBeFocused();
      await expect(evidence).toContainText("Local supporting ride");
      await expect(evidence).toContainText("10 Jan 1998");
      await expect(evidence).toContainText("RACE_B");
      await expect(evidence).toContainText("Intervals.icu event");
      await capture(scenario, "synchronized-evidence");
      await evidence.getByRole("button", { name: "Back", exact: true }).click();
      const before = await scenario.backend.inspectActivation();
      const listRequests = scenario.backend.planListRequests.length;
      scenario.backend.setSyncedEventCandidate({ name: "Changed supporting ride" });
      await pending.getByRole("button", { name: "Apply to Plan", exact: true }).click();
      await expect(changes(scenario).getByRole("status")).toHaveText(
        "The synchronized event changed. Request a fresh preview before applying.",
      );
      await expect(pending).toBeVisible();
      await expect
        .poll(() => scenario.backend.planListRequests.length)
        .toBeGreaterThan(listRequests);
      expect(scenario.backend.changeApplyResponses.at(-1)?.result).toMatchObject({
        status: "rejected",
        reason: "event-source-changed",
      });
      const after = await scenario.backend.inspectActivation();
      expect(after.revisions).toEqual(before.revisions);
      expect(after.workouts).toEqual(before.workouts);
      expect(after.planningPlans).toEqual(before.planningPlans);
      const workouts = after.workouts.map((row) =>
        PlanChangeWorkoutSchema.parse(JSON.parse(String(row.structure_json))),
      );
      expect(workouts.some((workout) => workout.kind === "event")).toBe(false);
      await changes(scenario).getByRole("status").scrollIntoViewIfNeeded();
      await capture(scenario, "synchronized-drift-refusal");
    } finally {
      await close(scenario);
    }
  });
}
