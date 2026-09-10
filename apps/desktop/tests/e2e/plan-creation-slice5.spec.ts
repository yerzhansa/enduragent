import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Browser, type Page, type PlaywrightWorkerArgs } from "@playwright/test";
import type { PlanCreationCardModel } from "@enduragent/coach-contract";
import { launchDesktopFixture, type RunningDesktopFixture } from "../helpers/desktop-fixture.js";
import { PlanCreationBackend } from "../helpers/plan-creation-backend.js";

const token = "d".repeat(43);

interface Scenario {
  readonly backend: PlanCreationBackend;
  readonly fixture: RunningDesktopFixture;
  readonly scratch: string;
  readonly colorScheme: "light" | "dark";
  readonly width: number;
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
  if (page === undefined) throw new TypeError("Plan Creation renderer is unavailable");
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
  activePlan: boolean,
): Promise<Scenario> {
  const scratch = await mkdtemp(join(tmpdir(), "plan-activation-"));
  const backend = new PlanCreationBackend(join(scratch, "store.db"), false, true);
  let fixture: RunningDesktopFixture | undefined;
  try {
    await backend.open();
    if (activePlan) await backend.seedUnrelatedPlans();
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
    return { backend, fixture, scratch, ...appearance, ...connected };
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
    await test.info().attach("stored-creation", {
      body: JSON.stringify({
        card: await scenario.backend.card(),
        activation: await scenario.backend.inspectActivation(),
        requests: scenario.backend.creationRequests,
        unrelated: await scenario.backend.inspectUnrelated(),
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

async function card(backend: PlanCreationBackend): Promise<PlanCreationCardModel> {
  const value = await backend.card();
  if (value === null) throw new TypeError("Plan Creation is unavailable");
  return value;
}

async function choose(scenario: Scenario, answer: string): Promise<void> {
  const before = await card(scenario.backend);
  await scenario.page.locator(`[data-parity="choice.row"][data-answer="${answer}"]`).click();
  await expect.poll(async () => (await scenario.backend.card())?.version).toBe(before.version + 1);
}

async function continueAnswer(scenario: Scenario, confirm = false): Promise<void> {
  const before = await card(scenario.backend);
  await scenario.page.getByRole("button", { name: "Continue", exact: true }).click();
  if (confirm)
    await scenario.page
      .getByRole("region", { name: "Did I read this right?", exact: true })
      .getByRole("button", { name: "Confirm", exact: true })
      .click();
  await expect.poll(async () => (await scenario.backend.card())?.version).toBe(before.version + 1);
}

async function completeFitness(scenario: Scenario): Promise<void> {
  await scenario.page.locator("#message").fill("/plan");
  await scenario.page.locator("#message").press("Enter");
  await expect(
    scenario.page.locator('[data-parity="question.card"][data-question="goal"]'),
  ).toBeVisible();
  await expect.poll(async () => (await scenario.backend.card())?.version).toBe(1);
  await choose(scenario, "fitness");
  await choose(scenario, "4");
  await choose(scenario, "flexible");
  await scenario.page.locator('[data-answer="hours-6"]').click();
  await scenario.page.locator('[data-parity="availability.longest"]').fill("2");
  await continueAnswer(scenario);
  await choose(scenario, "asap");
  await choose(scenario, "none");
  await choose(scenario, "regular");
  await scenario.page.locator('[data-parity="choice.custom"][data-answer="custom"]').click();
  await scenario.page.locator('[data-parity="custom.textarea"]').fill("Ride four steady hours");
  await continueAnswer(scenario, true);
  await choose(scenario, "none");
  await expect(
    scenario.page.getByText("The essentials are complete.", { exact: true }),
  ).toBeVisible();
}

async function build(scenario: Scenario): Promise<PlanCreationCardModel> {
  const before = await card(scenario.backend);
  await scenario.page
    .getByRole("button", {
      name: "Build Draft",
      exact: true,
    })
    .click();
  await expect.poll(async () => (await scenario.backend.card())?.version).toBe(before.version + 1);
  const current = await card(scenario.backend);
  expect(current).toMatchObject({ status: "review", draftStale: false });
  expect(scenario.backend.creationRequests.at(-1)).toMatchObject({
    method: "plan_creation.preview",
    params: { creationId: before.creationId, expectedVersion: before.version },
  });
  await expect(
    scenario.page.getByRole("heading", { name: "Every week and Workout", exact: true }),
  ).toBeVisible();
  await expect(
    scenario.page.getByRole("button", { name: "Activate Plan", exact: true }),
  ).toBeEnabled();
  return current;
}

async function showActivePlan(scenario: Scenario, name = "active-plan"): Promise<void> {
  await scenario.page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Plan", exact: true })
    .click();
  await expect(
    scenario.page.getByRole("heading", { name: "Plan active · week 1 of 4", exact: true }),
  ).toBeVisible();
  await expect(scenario.page.getByText(/^Improve fitness · .* phase · starts /)).toBeVisible();
  await capture(scenario, name);
  await scenario.page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Chat", exact: true })
    .click();
}

async function assertActivated(
  scenario: Scenario,
  reviewed: PlanCreationCardModel,
  before: Awaited<ReturnType<PlanCreationBackend["inspectActivation"]>>,
): Promise<void> {
  if (reviewed.draft === null) throw new TypeError("Reviewed Draft is unavailable");
  await expect.poll(async () => scenario.backend.card()).toBeNull();
  await expect(
    scenario.page.getByRole("heading", { name: "Every week and Workout", exact: true }),
  ).toHaveCount(0);
  await expect(scenario.page.getByRole("dialog")).toHaveCount(0);
  const stored = await scenario.backend.inspectActivation();
  const activated = stored.planningPlans.filter((plan) => plan.status === "active");
  expect(activated).toHaveLength(1);
  const planId = activated[0]?.plan_id;
  expect(planId).toEqual(expect.any(String));
  expect(activated[0]).toMatchObject({ version: 1, current_revision_number: 1 });
  expect(stored.plans.find((plan) => plan.id === planId)).toMatchObject({
    name: "Improve fitness",
    status: "active",
    total_weeks: reviewed.draft.weeks.length,
  });
  expect(stored.creations).toHaveLength(1);
  expect(stored.creations[0]).toMatchObject({
    id: reviewed.creationId,
    status: "activated",
    activated_plan_id: planId,
    version: reviewed.version + 1,
    terminal_at_ms: expect.any(Number),
  });
  expect(stored.revisions).toHaveLength(1);
  expect(stored.revisions[0]).toMatchObject({
    plan_id: planId,
    revision_number: 1,
    source_kind: "activation",
    source_id: reviewed.creationId,
    fingerprint: reviewed.draft.outputFingerprint,
  });
  expect(JSON.parse(String(stored.revisions[0]?.snapshot_json))).toEqual(reviewed.draft);
  expect(stored.workouts).toHaveLength(
    reviewed.draft.weeks.flatMap((week) => week.workouts).filter((workout) => workout.date !== null)
      .length,
  );
  expect(stored.commands).toHaveLength(1);
  expect(stored.commands[0]).toMatchObject({ status: "succeeded" });
  for (const previous of before.planningPlans) {
    const current = stored.planningPlans.find((plan) => plan.plan_id === previous.plan_id);
    if (previous.status === "closed") {
      expect(current).toEqual(previous);
      expect(stored.plans.find((plan) => plan.id === previous.plan_id)).toEqual(
        before.plans.find((plan) => plan.id === previous.plan_id),
      );
    } else {
      expect(current).toMatchObject({
        status: "closed",
        close_reason: "stopped",
        close_actor: "fixture-device",
        version: Number(previous.version) + 1,
        closed_at_ms: expect.any(Number),
      });
      expect(stored.plans.find((plan) => plan.id === previous.plan_id)).toMatchObject({
        status: "ended",
      });
    }
  }
  expect(await scenario.backend.planState()).toMatchObject({
    status: "ready",
    state: { projection: "active", data: { plan: { id: planId, name: "Improve fitness" } } },
  });
}

for (const appearance of [
  { width: 1180, colorScheme: "light" },
  { width: 1180, colorScheme: "dark" },
  { width: 720, colorScheme: "light" },
  { width: 720, colorScheme: "dark" },
] as const) {
  for (const activePlan of [false, true]) {
    test(`confirms activation ${activePlan ? "over an active Plan" : "without an active Plan"} at ${appearance.width} in ${appearance.colorScheme}`, async ({
      playwright,
    }) => {
      test.setTimeout(120_000);
      const scenario = await launch(playwright, appearance, activePlan);
      try {
        await completeFitness(scenario);
        const reviewed = await build(scenario);
        const before = await scenario.backend.inspectActivation();
        const { active } = await scenario.backend.library();
        const unrelated = await scenario.backend.inspectUnrelated();
        const trigger = scenario.page.getByRole("button", { name: "Activate Plan", exact: true });
        const dialog = scenario.page.getByRole("dialog", {
          name: activePlan ? "Close and activate?" : "Activate Plan?",
          exact: true,
        });
        const openDialog = async () => {
          await trigger.click();
          await expect(dialog).toBeVisible();
          await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
          await expect(dialog.getByRole("button")).toHaveText([
            "Cancel",
            activePlan ? "Activate new Plan" : "Activate Plan",
          ]);
          await expect(
            dialog.getByText(
              `${activePlan ? "Active endurance Plan closes. Today’s calendar Workout stays. " : ""}The new Plan activates now.`,
              { exact: true },
            ),
          ).toBeVisible();
          await expect(
            dialog.getByText("Calendar updates wait until intervals.icu is connected.", {
              exact: true,
            }),
          ).toBeVisible();
        };
        await openDialog();
        await capture(scenario, "confirmation");
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(dialog).toHaveCount(0);
        await expect(trigger).toBeFocused();
        expect(await scenario.backend.inspectActivation()).toEqual(before);
        expect(await scenario.backend.card()).toEqual(reviewed);
        await openDialog();
        await scenario.page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expect(trigger).toBeFocused();
        expect(await scenario.backend.inspectActivation()).toEqual(before);
        await openDialog();
        await relaunch(scenario, playwright);
        expect(await scenario.backend.card()).toEqual(reviewed);
        expect(await scenario.backend.inspectActivation()).toEqual(before);
        await expect(scenario.page.getByRole("dialog")).toHaveCount(0);
        await expect(
          scenario.page.getByRole("heading", { name: "Every week and Workout", exact: true }),
        ).toBeVisible();
        expect(
          scenario.backend.creationRequests.filter(
            (request) => request.method === "plan_creation.activate",
          ),
        ).toHaveLength(0);
        await capture(scenario, "restored-review");
        await scenario.page.getByRole("button", { name: "Activate Plan", exact: true }).click();
        await scenario.page
          .getByRole("dialog")
          .getByRole("button", {
            name: activePlan ? "Activate new Plan" : "Activate Plan",
            exact: true,
          })
          .click();
        await assertActivated(scenario, reviewed, before);
        const activeCard = scenario.page.getByRole("region", {
          name: "Improve fitness",
          exact: true,
        });
        await expect(activeCard).toContainText("Improve fitness");
        await expect(
          activeCard.getByText("Connect to mirror Workouts", { exact: true }),
        ).toBeVisible();
        await expect(scenario.page.getByText("Plan activated locally.")).toHaveCount(0);
        const request = scenario.backend.creationRequests.at(-1);
        expect(request).toMatchObject({
          method: "plan_creation.activate",
          params: {
            creationId: reviewed.creationId,
            expectedVersion: reviewed.version,
            incumbent: active === null ? null : { planId: active.planId, version: active.version },
            commandId: expect.any(String),
          },
        });
        await capture(scenario, "activated-chat");
        await showActivePlan(scenario);
        const committed = await scenario.backend.inspectActivation();
        await relaunch(scenario, playwright);
        await assertActivated(scenario, reviewed, before);
        expect(await scenario.backend.inspectActivation()).toEqual(committed);
        await showActivePlan(scenario, "restored-active-plan");
        const after = await scenario.backend.inspectUnrelated();
        expect(after.schedule).toEqual(unrelated.schedule);
        expect(after.preferences).toEqual(unrelated.preferences);
        expect(after.restrictions).toEqual(unrelated.restrictions);
      } finally {
        await close(scenario);
      }
    });
  }
}

test("keeps the dialog and stored Plans intact when activation rolls back, then retries", async ({
  playwright,
}) => {
  test.setTimeout(120_000);
  const scenario = await launch(playwright, { width: 1180, colorScheme: "light" }, true);
  try {
    await completeFitness(scenario);
    const reviewed = await build(scenario);
    const before = await scenario.backend.inspectActivation();
    const { active } = await scenario.backend.library();
    expect(active).not.toBeNull();
    await scenario.backend.setActivationFailure(true);
    await scenario.page.getByRole("button", { name: "Activate Plan", exact: true }).click();
    const dialog = scenario.page.getByRole("dialog", { name: "Close and activate?", exact: true });
    await dialog.getByRole("button", { name: "Activate new Plan", exact: true }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(dialog.getByRole("alert")).toHaveText(
      "The activation result could not be confirmed. The Plan library will show the current state after refresh.",
    );
    expect(await scenario.backend.inspectActivation()).toEqual(before);
    expect(await scenario.backend.card()).toEqual(reviewed);
    await capture(scenario, "activation-error");
    await scenario.backend.setActivationFailure(false);
    await dialog.getByRole("button", { name: "Activate new Plan", exact: true }).click();
    await assertActivated(scenario, reviewed, before);
    const requests = scenario.backend.creationRequests.filter(
      (request) => request.method === "plan_creation.activate",
    );
    expect(requests).toHaveLength(2);
    expect(requests[0]?.params).toEqual({
      commandId: expect.any(String),
      creationId: reviewed.creationId,
      expectedVersion: reviewed.version,
      incumbent: { planId: active?.planId, version: active?.version },
    });
    expect(requests[1]?.params).toEqual(requests[0]?.params);
    await showActivePlan(scenario);
  } finally {
    await close(scenario);
  }
});

test("prevents activation when the current Plan cannot be read", async ({ playwright }) => {
  test.setTimeout(120_000);
  const scenario = await launch(playwright, { width: 1180, colorScheme: "light" }, true);
  try {
    await completeFitness(scenario);
    const reviewed = await build(scenario);
    const before = await scenario.backend.inspectActivation();
    scenario.backend.planStateReadFails = true;
    await scenario.page.getByRole("button", { name: "Activate Plan", exact: true }).click();
    const dialog = scenario.page.getByRole("dialog");
    await expect(scenario.page.getByRole("alert")).toHaveText(
      "The current Plan could not be read. Refresh the Plan library before activating.",
    );
    await expect(dialog).toHaveCount(0);
    await expect(scenario.page.getByRole("alert")).toBeInViewport();
    const trigger = scenario.page.getByRole("button", { name: "Activate Plan", exact: true });
    await expect(trigger).toBeEnabled();
    expect(
      scenario.backend.creationRequests.filter(
        (request) => request.method === "plan_creation.activate",
      ),
    ).toHaveLength(0);
    expect(await scenario.backend.inspectActivation()).toEqual(before);
    expect(await scenario.backend.card()).toEqual(reviewed);
    await capture(scenario, "plan-read-error");
    scenario.backend.planStateReadFails = false;
    await trigger.click();
    await expect(dialog).toHaveAccessibleName("Close and activate?");
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(
      scenario.backend.creationRequests.filter(
        (request) => request.method === "plan_creation.activate",
      ),
    ).toHaveLength(0);
  } finally {
    await close(scenario);
  }
});
