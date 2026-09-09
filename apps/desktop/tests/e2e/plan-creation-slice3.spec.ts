import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Browser, type Page, type PlaywrightWorkerArgs } from "@playwright/test";
import { launchDesktopFixture, type RunningDesktopFixture } from "../helpers/desktop-fixture.js";
import { PlanCreationBackend } from "../helpers/plan-creation-backend.js";

const token = "d".repeat(43);
const ordinaryPrompt = "How should I pace a steady endurance ride?";
const ordinaryCoachReply = "Keep the effort conversational and finish feeling fresh.";

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
  options: {
    width: number;
    colorScheme: "light" | "dark";
    failure?: "before" | "after";
    coexistence?: boolean;
  } = { width: 1180, colorScheme: "light" },
): Promise<Scenario> {
  const scratch = await mkdtemp(join(tmpdir(), "plan-creation-discard-"));
  const backend = new PlanCreationBackend(join(scratch, "store.db"), options.coexistence);
  let fixture: RunningDesktopFixture | undefined;
  try {
    await backend.open();
    await backend.seedUnrelatedPlans();
    let failDiscard = options.failure;
    fixture = await launchDesktopFixture({
      script: {
        onRequest: async (request) => {
          const isDiscard =
            typeof request === "object" &&
            request !== null &&
            "method" in request &&
            request.method === "plan_creation.discard";
          if (isDiscard && failDiscard === "before") {
            failDiscard = undefined;
            throw new Error("Synthetic discard transport failure");
          }
          const result = await backend.script.onRequest(request);
          if (isDiscard && failDiscard === "after") {
            failDiscard = undefined;
            throw new Error("Synthetic discard response loss");
          }
          return result;
        },
      },
      token,
      width: options.width,
      height: 820,
      colorScheme: options.colorScheme,
      reducedMotion: true,
      hidden: true,
      routeChatAttachmentComposer: true,
    });
    await fixture.setViewport(options.width, 820);
    const connected = await connect(playwright, fixture, options.colorScheme, true);
    expect(await connected.page.evaluate(() => innerWidth)).toBe(options.width);
    return {
      backend,
      fixture,
      scratch,
      colorScheme: options.colorScheme,
      width: options.width,
      ...connected,
    };
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
  const started = performance.now();
  await scenario.fixture.relaunch(() => scenario.backend.reopen());
  await scenario.fixture.setViewport(scenario.width, 820);
  Object.assign(scenario, await connect(playwright, scenario.fixture, scenario.colorScheme));
  expect(await scenario.page.evaluate(() => innerWidth)).toBe(scenario.width);
  await expect(scenario.page.locator("#message")).toBeVisible();
  await test.info().attach("relaunch-timing", {
    body: JSON.stringify({ milliseconds: performance.now() - started }),
    contentType: "application/json",
  });
}

async function close(scenario: Scenario): Promise<void> {
  try {
    await test.info().attach("stored-creation", {
      body: JSON.stringify({
        card: await scenario.backend.card(),
        discard: await scenario.backend.inspectDiscard(),
        requests: scenario.backend.creationRequests,
        unrelated: await scenario.backend.inspectUnrelated(),
      }),
      contentType: "application/json",
    });
    await capture(scenario.page, "final");
  } finally {
    await scenario.browser.close().catch(() => {});
    try {
      const cleanup = await scenario.fixture.close();
      await test
        .info()
        .attach("cleanup", { body: JSON.stringify(cleanup), contentType: "application/json" });
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

async function capture(page: Page, name: string): Promise<void> {
  await test
    .info()
    .attach(`${name}-screenshot`, { body: await page.screenshot(), contentType: "image/png" });
  await test.info().attach(`${name}-dom`, { body: await page.content(), contentType: "text/html" });
  const measured = await page.evaluate(() => {
    const selectors = {
      dialog: '[role="dialog"]',
      title: '[data-slot="dialog-title"]',
      header: '[data-slot="dialog-header"]',
      actions: '[data-slot="dialog-footer"]',
      consequence: '[data-parity="discarded.record"]',
      composer: "#message",
    };
    const result: Record<string, unknown> = {};
    for (const [key, selector] of Object.entries(selectors)) {
      const element = document.querySelector(selector);
      if (element === null) continue;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      result[key] = {
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        padding: style.padding,
        marginTop: style.marginTop,
        marginBottom: style.marginBottom,
        rowGap: style.rowGap,
        columnGap: style.columnGap,
        borderRadius: style.borderRadius,
        borderColor: style.borderColor,
        borderWidth: style.borderWidth,
        background: style.backgroundColor,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
      };
    }
    const consequence = document.querySelector('[data-parity="discarded.record"]');
    const composer = document.querySelector("#message");
    result.consequenceBeforeComposer =
      consequence !== null && composer !== null
        ? Boolean(consequence.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING)
        : null;
    result.environment = {
      width: innerWidth,
      height: innerHeight,
      theme: document.documentElement.dataset.theme,
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
    return result;
  });
  await test.info().attach(`${name}-geometry`, {
    body: JSON.stringify(measured),
    contentType: "application/json",
  });
}

async function waitForVersion(backend: PlanCreationBackend, version: number): Promise<void> {
  await expect.poll(async () => (await backend.card())?.version).toBe(version);
}

async function startAndAnswerGoal(scenario: Scenario): Promise<void> {
  await scenario.page.locator("#message").fill("/plan");
  await scenario.page.locator("#message").press("Enter");
  await expect(
    scenario.page.locator('[data-parity="question.card"][data-question="goal"]'),
  ).toBeVisible();
  await waitForVersion(scenario.backend, 1);
  await scenario.page.getByRole("button", { name: "Improve without an event" }).click();
  await waitForVersion(scenario.backend, 2);
  await expect(
    scenario.page.getByRole("heading", { name: "How long should this Fitness Plan be?" }),
  ).toBeVisible();
}

async function openDiscardConfirmation(page: Page) {
  const discard = page.getByRole("button", { name: "Discard", exact: true });
  await discard.click();
  const keepCreating = page.getByRole("button", { name: "Keep creating", exact: true });
  await expect(page.getByRole("heading", { name: "Discard this Plan creation?" })).toBeVisible();
  await expect(
    page.getByText(
      "Your answers are discarded. Your active Plan, Schedule, restrictions, saved preferences, and history stay unchanged.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Discard creation" })).toBeVisible();
  await expect(keepCreating).toBeFocused();
  await expect(page.locator("#message")).toBeDisabled();
  await capture(page, "discard-dialog");
  return { discard, keepCreating };
}

async function discardPlanCreation(page: Page): Promise<void> {
  await openDiscardConfirmation(page);
  const started = performance.now();
  await page.getByRole("button", { name: "Discard creation" }).click();
  await expect(page.locator("#message")).toBeFocused();
  await test.info().attach("discard-timing", {
    body: JSON.stringify({ milliseconds: performance.now() - started }),
    contentType: "application/json",
  });
  await expect(page.getByText("Plan creation discarded", { exact: true })).toBeVisible();
  await expect(page.locator('[data-parity="discarded.record"]')).toBeVisible();
  await expect(
    page.getByText(
      "No Plan was created. Your active Plan, Schedule, training restrictions, saved preferences, and chat history are unchanged.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.locator("#message")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Message your coach" })).toBeEnabled();
  expect(
    await page.locator('[data-parity="discarded.record"]').evaluate((record) => {
      const composer = document.querySelector("#message");
      return (
        composer !== null &&
        Boolean(record.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING)
      );
    }),
  ).toBe(true);
  await capture(page, "discarded");
}

async function sendOrdinaryTurn(page: Page): Promise<void> {
  await page.getByRole("combobox", { name: "Message your coach" }).fill(ordinaryPrompt);
  await page.getByRole("button", { name: "Send message" }).click();
  const conversation = page.getByRole("log", { name: "Coach conversation" });
  await expect(conversation.getByText(ordinaryPrompt, { exact: true })).toBeVisible();
  await expect(conversation.getByText(ordinaryCoachReply, { exact: true })).toBeVisible();
}

async function expectNoPlanCreationSummaries(page: Page): Promise<void> {
  await expect(page.locator('[data-parity="summary.row"]')).toHaveCount(0);
  await expect(page.locator('[data-parity="progress.card"]')).toHaveCount(0);
}

for (const appearance of [
  { width: 1180, colorScheme: "light" },
  { width: 1180, colorScheme: "dark" },
  { width: 760, colorScheme: "light" },
  { width: 760, colorScheme: "dark" },
  { width: 720, colorScheme: "dark" },
] as const) {
  test(`cancels and persists discard at ${appearance.width} in ${appearance.colorScheme}`, async ({
    playwright,
  }) => {
    const scenario = await launch(playwright, appearance);
    try {
      await startAndAnswerGoal(scenario);
      const beforeDiscard = await scenario.backend.inspectDiscard();
      expect(beforeDiscard.creations).toHaveLength(1);
      expect(beforeDiscard.creations[0]).toMatchObject({
        status: "in-progress",
        version: 2,
        terminalAtMs: null,
      });
      expect(beforeDiscard.answers).toHaveLength(1);

      const { keepCreating } = await openDiscardConfirmation(scenario.page);
      await scenario.page.keyboard.press("Tab");
      await expect(
        scenario.page.getByRole("button", { name: "Discard creation", exact: true }),
      ).toBeFocused();
      await scenario.page.keyboard.press("Tab");
      await expect(keepCreating).toBeFocused();
      await keepCreating.click();
      await expect(scenario.page.getByRole("dialog")).toHaveCount(0);
      await expect(scenario.backend.inspectDiscard()).resolves.toEqual(beforeDiscard);
      const { discard } = await openDiscardConfirmation(scenario.page);
      await scenario.fixture.pressKey("Escape");
      await expect(scenario.page.getByRole("button", { name: "Discard creation" })).toHaveCount(0);
      await expect(discard).toBeFocused();
      await expect(scenario.backend.inspectDiscard()).resolves.toEqual(beforeDiscard);

      await discardPlanCreation(scenario.page);
      await expect(scenario.page.locator("#message")).toBeFocused();
      const afterDiscard = await scenario.backend.inspectDiscard();
      expect(afterDiscard.creations).toEqual([
        {
          ...beforeDiscard.creations[0],
          status: "discarded",
          version: 3,
          terminalAtMs: expect.any(Number),
        },
      ]);
      expect(afterDiscard.answers).toEqual(beforeDiscard.answers);
      expect(
        afterDiscard.commands.filter((command) => command.command_name !== "plan_creation.discard"),
      ).toEqual(beforeDiscard.commands);
      expect(
        afterDiscard.commands.filter((command) => command.command_name === "plan_creation.discard"),
      ).toHaveLength(1);
      await expectNoPlanCreationSummaries(scenario.page);

      await relaunch(scenario, playwright);
      await expect(scenario.page.locator("#message")).toBeVisible();
      await expectNoPlanCreationSummaries(scenario.page);
    } finally {
      await close(scenario);
    }
  });
}

test("preserves an ordinary Chat turn after discard and relaunch", async ({ playwright }) => {
  const scenario = await launch(playwright);
  try {
    await sendOrdinaryTurn(scenario.page);
    await startAndAnswerGoal(scenario);
    const unrelatedBeforeDiscard = await scenario.backend.inspectUnrelated();
    expect(unrelatedBeforeDiscard.activePlans).toHaveLength(1);
    expect(unrelatedBeforeDiscard.closedPlans).toHaveLength(1);
    await discardPlanCreation(scenario.page);
    await expect(scenario.backend.inspectUnrelated()).resolves.toEqual(unrelatedBeforeDiscard);
    await expect(scenario.page.getByText(ordinaryPrompt, { exact: true })).toBeVisible();
    await expect(scenario.page.getByText(ordinaryCoachReply, { exact: true })).toBeVisible();

    await relaunch(scenario, playwright);
    await expect(scenario.backend.inspectUnrelated()).resolves.toEqual(unrelatedBeforeDiscard);
    await expect(scenario.page.locator("#message")).toBeVisible();
    await expect(scenario.page.getByText(ordinaryPrompt, { exact: true })).toBeVisible();
    await expect(scenario.page.getByText(ordinaryCoachReply, { exact: true })).toBeVisible();
  } finally {
    await close(scenario);
  }
});

test("starts a distinct Plan Creation after discard", async ({ playwright }) => {
  const scenario = await launch(playwright);
  try {
    await startAndAnswerGoal(scenario);
    const beforeDiscard = await scenario.backend.inspectDiscard();
    const discardedId = beforeDiscard.creations[0]?.id;
    if (discardedId === undefined) throw new TypeError("Plan Creation row is unavailable");
    await discardPlanCreation(scenario.page);

    await scenario.page.locator("#message").fill("/plan");
    await scenario.page.locator("#message").press("Enter");
    await expect(
      scenario.page.locator('[data-parity="question.card"][data-question="goal"]'),
    ).toBeVisible();
    await expect(
      scenario.page.getByRole("heading", {
        name: "What do you want this Plan to prepare you for?",
      }),
    ).toBeVisible();
    await expect(scenario.page.getByText("Plan creation discarded", { exact: true })).toBeVisible();
    const restarted = await scenario.backend.inspectDiscard();
    expect(restarted.creations).toHaveLength(2);
    expect(restarted.creations[0]).toMatchObject({ id: discardedId, status: "discarded" });
    expect(restarted.creations[1]).toMatchObject({ status: "in-progress", terminalAtMs: null });
    expect(restarted.creations[1]?.id).not.toBe(discardedId);
  } finally {
    await close(scenario);
  }
});

for (const failure of ["before", "after"] as const) {
  test(`recovers discard from a ${failure}-commit local failure`, async ({ playwright }) => {
    const scenario = await launch(playwright, { width: 1180, colorScheme: "light", failure });
    try {
      await startAndAnswerGoal(scenario);
      const before = await scenario.backend.inspectDiscard();
      await openDiscardConfirmation(scenario.page);
      await scenario.page.getByRole("button", { name: "Discard creation", exact: true }).click();
      await expect(scenario.page.getByRole("dialog").getByRole("alert")).toHaveText(
        "Plan Creation couldn’t save that. Try again.",
      );
      await expect(
        scenario.page.getByRole("button", { name: "Discard creation", exact: true }),
      ).toBeEnabled();
      await expect(scenario.page.getByText("Plan creation discarded", { exact: true })).toHaveCount(
        0,
      );
      if (failure === "before") expect(await scenario.backend.inspectDiscard()).toEqual(before);
      else expect((await scenario.backend.inspectDiscard()).creations[0]?.status).toBe("discarded");
      await scenario.page.getByRole("button", { name: "Discard creation", exact: true }).click();
      await expect(scenario.page.locator("#message")).toBeFocused();
      const requests = scenario.backend.creationRequests.filter(
        (request) => request.method === "plan_creation.discard",
      );
      expect(requests).toHaveLength(failure === "before" ? 1 : 2);
      if (failure === "after") expect(requests[1]).toEqual(requests[0]);
      expect((await scenario.backend.inspectDiscard()).answers).toEqual(before.answers);
      await expect(scenario.page.getByText("Plan creation discarded", { exact: true })).toHaveCount(
        1,
      );
      await relaunch(scenario, playwright);
      await expectNoPlanCreationSummaries(scenario.page);
    } finally {
      await close(scenario);
    }
  });
}

test("installs the current card when discard rejects a stale revision", async ({ playwright }) => {
  const scenario = await launch(playwright);
  try {
    await startAndAnswerGoal(scenario);
    await openDiscardConfirmation(scenario.page);
    const card = await scenario.backend.card();
    if (card === null) throw new TypeError("Plan Creation unavailable");
    await scenario.backend.script.onRequest({
      method: "plan_creation.answer",
      params: {
        commandId: "concurrent-plan-length",
        creationId: card.creationId,
        expectedVersion: card.version,
        answer: { kind: "plan-length", weeks: 8 },
      },
    });
    const before = await scenario.backend.inspectDiscard();
    await scenario.page.getByRole("button", { name: "Discard creation", exact: true }).click();
    await expect(scenario.page.getByRole("dialog")).toHaveCount(0);
    await expect(
      scenario.page.getByText(
        "Plan Creation changed before it could be discarded. The latest version is shown.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(scenario.page.getByRole("button", { name: "Discard", exact: true })).toBeFocused();
    expect(await scenario.backend.inspectDiscard()).toEqual(before);
    await discardPlanCreation(scenario.page);
  } finally {
    await close(scenario);
  }
});
