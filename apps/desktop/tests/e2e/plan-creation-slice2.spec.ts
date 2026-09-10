import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Browser, type Page, type PlaywrightWorkerArgs } from "@playwright/test";
import {
  GetPlanStateRpcResultSchema,
  type PlanCreationCardModel,
} from "@enduragent/coach-contract";
import { launchDesktopFixture, type RunningDesktopFixture } from "../helpers/desktop-fixture.js";
import { PlanCreationBackend } from "../helpers/plan-creation-backend.js";

const token = "d".repeat(43);

interface Scenario {
  readonly backend: PlanCreationBackend;
  readonly fixture: RunningDesktopFixture;
  readonly scratch: string;
  readonly colorScheme: "light" | "dark";
  readonly width: number;
  readonly height: number;
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
  await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
  await expect(page.locator("[data-shell]")).toHaveAttribute("data-onboarding", "settled", {
    timeout: 30_000,
  });
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
  appearance: {
    readonly width: number;
    readonly height: number;
    readonly colorScheme: "light" | "dark";
    readonly coexistence?: boolean;
  } = { width: 1180, height: 820, colorScheme: "light" },
): Promise<Scenario> {
  const scratch = await mkdtemp(join(tmpdir(), "plan-creation-"));
  const backend = new PlanCreationBackend(join(scratch, "store.db"), appearance.coexistence);
  let fixture: RunningDesktopFixture | undefined;
  try {
    await backend.open();
    fixture = await launchDesktopFixture({
      script: backend.script,
      token,
      ...appearance,
      inspectMain: appearance.width === 760,
      reducedMotion: true,
      hidden: true,
      routeChatAttachmentComposer: true,
    });
    const connected = await connect(playwright, fixture, appearance.colorScheme, true);
    await test.info().attach("initial-native-viewport", {
      body: JSON.stringify(
        await connected.page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
      ),
      contentType: "application/json",
    });
    expect(
      await connected.page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
    ).toEqual({ width: appearance.width, height: appearance.height });
    return {
      backend,
      fixture,
      scratch,
      colorScheme: appearance.colorScheme,
      width: appearance.width,
      height: appearance.height,
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
  Object.assign(scenario, await connect(playwright, scenario.fixture, scenario.colorScheme));
  await test.info().attach("relaunched-native-viewport", {
    body: JSON.stringify(
      await scenario.page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
    ),
    contentType: "application/json",
  });
  expect(await scenario.page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({
    width: scenario.width,
    height: scenario.height,
  });
  await expect(scenario.page.getByRole("region", { name: "Plan Creation progress" })).toBeVisible();
  await test.info().attach("relaunch-timing", {
    body: JSON.stringify({
      event: "relaunch-to-restored-progress",
      milliseconds: performance.now() - started,
    }),
    contentType: "application/json",
  });
}

async function close(scenario: Scenario): Promise<void> {
  try {
    await test.info().attach("final-state", {
      body: JSON.stringify({
        card: await scenario.backend.card(),
        store: await scenario.backend.inspect(),
        answers: await scenario.backend.answers(),
        requests: scenario.backend.creationRequests,
      }),
      contentType: "application/json",
    });
    const screenshotPath = test.info().outputPath("final-desktop.png");
    await scenario.fixture.screenshot(screenshotPath);
    await test.info().attach("final-desktop", { path: screenshotPath, contentType: "image/png" });
    await test.info().attach("final-dom", {
      body: scenario.fixture.readCapturedSurface("dom"),
      contentType: "text/html",
    });
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

async function requireCard(backend: PlanCreationBackend): Promise<PlanCreationCardModel> {
  const card = await backend.card();
  if (card === null) throw new TypeError("Plan Creation Card is unavailable");
  return card;
}

async function waitForVersion(
  backend: PlanCreationBackend,
  version: number,
): Promise<PlanCreationCardModel> {
  await expect.poll(async () => (await backend.card())?.version).toBe(version);
  return requireCard(backend);
}

async function choose(page: Page, backend: PlanCreationBackend, version: number, answer: string) {
  const started = performance.now();
  await page.locator(`[data-parity="choice.row"][data-answer="${answer}"]`).click();
  const card = await waitForVersion(backend, version);
  if (card.openQuestion !== null) {
    await expect(
      page.getByRole("heading", { name: card.openQuestion.prompt, exact: true }),
    ).toBeVisible();
  } else {
    await expect(
      page.getByText("The essentials are complete.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Build Draft", exact: true })).toBeVisible();
  }
  await test.info().attach(`answer-${version}-timing`, {
    body: JSON.stringify({
      event: "choice-to-returned-card",
      answer,
      version,
      milliseconds: performance.now() - started,
    }),
    contentType: "application/json",
  });
  return card;
}

async function startFitnessGoal(scenario: Scenario): Promise<void> {
  await scenario.page.locator("#message").fill("/plan");
  await scenario.page.locator("#message").press("Enter");
  await expect(
    scenario.page.locator('[data-parity="question.card"][data-question="goal"]'),
  ).toBeVisible();
  await waitForVersion(scenario.backend, 1);
  await choose(scenario.page, scenario.backend, 2, "fitness");
}

async function answerThroughBaseline(scenario: Scenario): Promise<void> {
  await startFitnessGoal(scenario);
  await choose(scenario.page, scenario.backend, 3, "8");
  await choose(scenario.page, scenario.backend, 4, "flexible");
  await scenario.page.locator('[data-answer="hours-6"]').click();
  await scenario.page.locator('[data-parity="availability.longest"]').fill("2");
  await scenario.page.getByRole("button", { name: "Continue", exact: true }).click();
  await waitForVersion(scenario.backend, 5);
  await choose(scenario.page, scenario.backend, 6, "asap");
  await choose(scenario.page, scenario.backend, 7, "none");
  await choose(scenario.page, scenario.backend, 8, "regular");
}

async function answerAuthoredSuccess(scenario: Scenario): Promise<void> {
  await scenario.page.locator('[data-parity="choice.custom"][data-answer="custom"]').click();
  await expect(scenario.page.locator('[data-parity="composer"]')).toHaveCount(0);
  const editor = scenario.page.locator('[data-parity="custom.textarea"]');
  await editor.fill("Ride four steady hours");
  await scenario.page.getByRole("button", { name: "Continue", exact: true }).click();
  await scenario.page
    .getByRole("region", { name: "Did I read this right?", exact: true })
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await waitForVersion(scenario.backend, 9);
}

async function answerRestriction(scenario: Scenario): Promise<void> {
  await scenario.page.locator('[data-answer="no-hard-training"]').click();
  expect((await requireCard(scenario.backend)).version).toBe(9);
  await scenario.page.getByLabel("Optional end date", { exact: true }).fill("1998-11-01");
  await scenario.page.getByRole("button", { name: "Continue", exact: true }).click();
  await waitForVersion(scenario.backend, 10);
  const card = await requireCard(scenario.backend);
  expect(card.readiness).toBe("ready");
  expect(card.openQuestion).toBeNull();
}

async function completeFitnessGoal(scenario: Scenario): Promise<void> {
  await answerThroughBaseline(scenario);
  await answerAuthoredSuccess(scenario);
  await answerRestriction(scenario);
}

async function installStaleExpectedVersionHook(
  fixture: RunningDesktopFixture,
  expectedVersion: number,
): Promise<void> {
  await fixture.evaluate<void>(`
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) {
      if (typeof data !== "string") return originalSend.call(this, data);
      let frame;
      try {
        frame = JSON.parse(data);
      } catch {
        return originalSend.call(this, data);
      }
      if (frame.method !== "plan_creation.answer") return originalSend.call(this, data);
      WebSocket.prototype.send = originalSend;
      frame.params.expectedVersion = ${expectedVersion};
      return originalSend.call(this, JSON.stringify(frame));
    };
  `);
}

test("completes the Fitness Goal with an authored success answer", async ({ playwright }) => {
  const scenario = await launch(playwright);
  try {
    await completeFitnessGoal(scenario);
    const progress = scenario.page.getByRole("region", { name: "Plan Creation progress" });
    await expect(
      progress.getByText("The essentials are complete.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(progress.getByRole("button", { name: "Build Draft", exact: true })).toBeVisible();
    await expect(scenario.page.getByRole("button", { name: "Send message" })).toBeEnabled();
    const answers = await scenario.backend.answers();
    expect(answers.map((answer) => answer.answer_key)).toEqual([
      "goal",
      "plan-length",
      "schedule-mode",
      "availability",
      "start-timing",
      "commitments",
      "baseline",
      "success",
      "restriction",
    ]);
    expect(answers).toHaveLength(9);
    for (const answer of answers) {
      expect(answer.scope).toBe("plan-creation");
      expect(JSON.parse(answer.value_json)).toMatchObject({ source: { kind: "athlete" } });
    }
    expect(JSON.parse(answers.at(-1)?.value_json ?? "null")).toMatchObject({
      answer: {
        kind: "restriction",
        restriction: { kind: "no-hard-training", endDate: "1998-11-01" },
      },
    });
  } finally {
    await close(scenario);
  }
});

test("edits the goal, pauses, and resumes the Event success Card", async ({ playwright }) => {
  const scenario = await launch(playwright);
  try {
    await completeFitnessGoal(scenario);
    const persisted = await scenario.backend.answers();
    const beforeEdit = await requireCard(scenario.backend);
    const goal = beforeEdit.answeredSummaries.find((summary) => summary.answerKey === "goal");
    if (goal === undefined) throw new TypeError("Goal summary is unavailable");
    await scenario.page.getByRole("button", { name: `Edit ${goal.title}`, exact: true }).click();
    await expect(scenario.page.locator('[data-answer="fitness"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await scenario.page.locator('[data-answer="event-not-listed"]').click();
    await expect(scenario.page.locator('[data-parity="composer"]')).toHaveCount(0);
    await scenario.page
      .getByRole("textbox", { name: "Event name", exact: true })
      .fill("Highland Classic");
    await scenario.page.getByLabel("Event date", { exact: true }).fill("1998-06-20");
    await test.info().attach("manual-event-editor", {
      body: await scenario.page.screenshot(),
      contentType: "image/png",
    });
    await scenario.page.getByRole("button", { name: "Continue", exact: true }).click();
    await scenario.page
      .getByRole("region", { name: "Did I read this right?", exact: true })
      .getByRole("button", { name: "Confirm", exact: true })
      .click();
    const changed = await waitForVersion(scenario.backend, 11);
    expect(changed.answeredSummaries.map((summary) => summary.answerKey)).toEqual([
      "goal",
      "schedule-mode",
      "availability",
      "start-timing",
      "commitments",
      "baseline",
      "restriction",
    ]);
    const editedRows = await scenario.backend.answers();
    expect(editedRows.slice(0, 9)).toEqual(persisted);
    expect(editedRows.at(-1)?.answer_key).toBe("goal");
    await scenario.page.getByRole("button", { name: "Later", exact: true }).click();
    await expect(scenario.page.getByRole("button", { name: "Send message" })).toBeEnabled();
    await relaunch(scenario, playwright);
    await expect(
      scenario.page.locator('[data-parity="question.card"][data-question="success"]'),
    ).toHaveCount(0);
    const continueButton = scenario.page.getByRole("button", { name: "Continue", exact: true });
    await continueButton.click();
    await expect(
      scenario.page.locator('[data-parity="question.card"][data-question="success"]'),
    ).toBeVisible();
    await choose(scenario.page, scenario.backend, 12, "finish-comfortably");
    const ready = await requireCard(scenario.backend);
    expect(ready.readiness).toBe("ready");
    expect(ready.openQuestion).toBeNull();
    expect(await scenario.backend.answers()).toHaveLength(11);
  } finally {
    await close(scenario);
  }
});

test("reinstalls the live Card after a stale-version rejection", async ({ playwright }) => {
  const scenario = await launch(playwright);
  try {
    await startFitnessGoal(scenario);
    const staleCard = await requireCard(scenario.backend);
    await installStaleExpectedVersionHook(scenario.fixture, staleCard.version - 1);
    await scenario.page.locator('[data-answer="8"]').click();
    await expect(
      scenario.page.locator('[data-parity="question.card"][data-question="plan-length"]'),
    ).toBeVisible();
    await expect(scenario.page.getByRole("alert")).toHaveText(
      "Plan Creation couldn’t save that. Try again.",
    );
    await expect.poll(async () => (await scenario.backend.card())?.version).toBe(staleCard.version);
    expect((await scenario.backend.answers()).map((row) => row.answer_key)).toEqual(["goal"]);
  } finally {
    await close(scenario);
  }
});

for (const appearance of [
  { name: "wide-light", width: 1180, height: 820, colorScheme: "light" },
  { name: "wide-dark", width: 1180, height: 820, colorScheme: "dark" },
  { name: "compact-light", width: 760, height: 600, colorScheme: "light" },
  { name: "compact-dark", width: 760, height: 600, colorScheme: "dark" },
] as const) {
  test(`completes a disconnected manual Event with editor cancellation and relaunch in ${appearance.name}`, async ({
    playwright,
  }) => {
    const scenario = await launch(playwright, { ...appearance, coexistence: true });
    const question = (key: string) =>
      scenario.page.locator(`[data-parity="question.card"][data-question="${key}"]`);
    const capture = async (name: string) => {
      await expect(scenario.page.locator("html")).toHaveAttribute(
        "data-theme",
        appearance.colorScheme,
      );
      const path = test.info().outputPath(`${name}.png`);
      await scenario.fixture.screenshot(path);
      await test.info().attach(name, { path, contentType: "image/png" });
      expect(
        await scenario.page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      expect(
        await scenario.page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches),
      ).toBe(true);
    };
    const cancelAuthoredEdit = async (title: string, field: string, next: string) => {
      const before = await scenario.backend.inspect();
      const answers = await scenario.backend.answers();
      await scenario.page.getByRole("button", { name: `Edit ${title}`, exact: true }).click();
      const editor = scenario.page.locator(field);
      await expect(editor).toBeFocused();
      if (title === "Commitments") await expect(editor).toHaveValue("Fridays off");
      await editor.fill("Unsaved change");
      await expect(scenario.page.locator('[data-parity="composer"]')).toHaveCount(0);
      await capture(`edit-${title}`);
      if (appearance.width === 760 && title === "Goal") {
        const cdp = await scenario.page.context().newCDPSession(scenario.page);
        await cdp.send("Emulation.clearDeviceMetricsOverride");
        const originalSize = await scenario.fixture.evaluateMain<readonly [number, number]>(`
          const { BrowserWindow } = process.getBuiltinModule("module").createRequire(process.cwd() + "/")("electron");
          const window = BrowserWindow.getAllWindows()[0];
          if (!window) throw new Error("Missing fixture window");
          const size = window.getContentSize();
          window.setContentSize(${appearance.width}, ${appearance.height});
          window.webContents.setZoomFactor(1.25);
          return size;
        `);
        try {
          await expect
            .poll(() => scenario.page.evaluate(() => window.innerWidth))
            .toBe(Math.round(appearance.width / 1.25));
          await scenario.page.getByRole("button", { name: "Back to answers", exact: true }).focus();
          await expect(
            scenario.page.getByRole("button", { name: "Back to answers", exact: true }),
          ).toBeInViewport();
          await capture("manual-editor-125-percent");
        } finally {
          await scenario.fixture.evaluateMain<void>(`
            const { BrowserWindow } = process.getBuiltinModule("module").createRequire(process.cwd() + "/")("electron");
            const window = BrowserWindow.getAllWindows()[0];
            if (!window) throw new Error("Missing fixture window");
            window.webContents.setZoomFactor(1);
            window.setContentSize(${originalSize[0]}, ${originalSize[1]});
          `);
          await cdp.detach();
          await scenario.fixture.setViewport(appearance.width, appearance.height);
        }
      }
      const cancel = scenario.page.getByRole("button", { name: "Back to answers", exact: true });
      await cancel.focus();
      await scenario.page.keyboard.press("Enter");
      await expect(question(next).getByRole("heading")).toBeFocused();
      await expect(scenario.page.locator('[data-parity="composer.textarea"]')).toBeDisabled();
      expect(await scenario.backend.inspect()).toEqual(before);
      expect(await scenario.backend.answers()).toEqual(answers);
    };
    try {
      await scenario.page.locator("#message").fill("/plan");
      await scenario.page.locator("#message").press("Enter");
      await expect(
        scenario.page.locator('[data-parity="question.card"][data-question="goal"]'),
      ).toBeVisible();
      await waitForVersion(scenario.backend, 1);
      await expect(question("goal").getByRole("heading")).toBeFocused();
      await capture("goal");
      await scenario.page.locator('[data-answer="event-not-listed"]').click();
      await expect(
        scenario.page.getByRole("button", { name: "Continue", exact: true }),
      ).toBeDisabled();
      await scenario.page
        .getByRole("textbox", { name: "Event name", exact: true })
        .fill("Autumn ride");
      await expect(
        scenario.page.getByRole("button", { name: "Continue", exact: true }),
      ).toBeDisabled();
      await scenario.page.getByLabel("Event date", { exact: true }).fill("1998-11-08");
      await scenario.page.getByRole("button", { name: "Continue", exact: true }).click();
      await scenario.page
        .getByRole("region", { name: "Did I read this right?", exact: true })
        .getByRole("button", { name: "Confirm", exact: true })
        .click();
      await waitForVersion(scenario.backend, 2);
      await cancelAuthoredEdit("Main Goal", '[data-parity="custom.textarea"]', "schedule-mode");
      await scenario.page.getByRole("button", { name: "Edit Main Goal", exact: true }).click();
      await scenario.page.keyboard.press("Escape");
      await expect(
        scenario.page.getByRole("button", { name: "Event not listed", exact: true }),
      ).toBeFocused();
      await scenario.page.getByRole("button", { name: "Back to answers", exact: true }).click();
      await choose(scenario.page, scenario.backend, 3, "fixed");
      await scenario.page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(scenario.page.getByRole("alert").first()).toBeVisible();
      expect((await requireCard(scenario.backend)).version).toBe(3);
      await scenario.page.locator('[data-answer="hours-8"]').click();
      await scenario.page.locator('[data-parity="availability.longest"]').fill("2");
      for (const day of [2, 4, 6])
        await scenario.page.locator(`input[name="usableWeekdays"][value="${day}"]`).check();
      await capture("fixed-availability");
      await scenario.page.getByRole("button", { name: "Continue", exact: true }).click();
      await waitForVersion(scenario.backend, 4);
      await scenario.page.locator('[data-answer="earliest"]').click();
      await scenario.page.getByLabel("Earliest start date", { exact: true }).fill("1998-09-07");
      await scenario.page.getByRole("button", { name: "Continue", exact: true }).click();
      await waitForVersion(scenario.backend, 5);
      await scenario.page.locator('[data-parity="choice.custom"]').click();
      await scenario.page.locator('[data-parity="custom.textarea"]').fill("Fridays off");
      await scenario.page
        .locator('[data-parity="custom.actions"]')
        .getByRole("button", { name: "Continue", exact: true })
        .click();
      await expect(
        scenario.page.getByRole("heading", { name: "Did I read this right?", exact: true }),
      ).toBeVisible();
      const pending = await waitForVersion(scenario.backend, 5);
      expect(pending.pendingCheck).toMatchObject({
        submission: { field: "commitments", text: "Fridays off" },
        state: "ready",
        result: { outcome: "understood", value: [{ kind: "weekday-unavailable", day: 5 }] },
      });
      expect(pending.answeredSummaries).toHaveLength(4);
      expect(await scenario.backend.answers()).toHaveLength(4);
      await scenario.page.getByRole("button", { name: "Confirm", exact: true }).click();
      const confirmed = await waitForVersion(scenario.backend, 6);
      expect(confirmed.pendingCheck).toBeNull();
      expect(confirmed.answeredSummaries).toHaveLength(5);
      expect(
        confirmed.answeredSummaries.find((summary) => summary.answerKey === "commitments"),
      ).toMatchObject({
        detail: "Fri · unavailable",
        answer: {
          kind: "commitments",
          commitments: {
            kind: "interpreted",
            text: "Fridays off",
            rules: [{ kind: "weekday-unavailable", day: 5 }],
            status: "confirmed",
          },
        },
      });
      const commitmentAnswers = await scenario.backend.answers();
      expect(commitmentAnswers).toHaveLength(5);
      expect(
        commitmentAnswers
          .filter((row) => row.answer_key === "commitments")
          .map((row) => ({ version: row.creation_version, value: JSON.parse(row.value_json) })),
      ).toEqual([
        {
          version: 6,
          value: {
            answer: {
              kind: "commitments",
              commitments: {
                kind: "interpreted",
                text: "Fridays off",
                rules: [{ kind: "weekday-unavailable", day: 5 }],
                status: "confirmed",
              },
            },
            source: { kind: "athlete" },
          },
        },
      ]);
      await cancelAuthoredEdit("Commitments", '[data-parity="custom.textarea"]', "baseline");
      await relaunch(scenario, playwright);
      await expect(question("baseline")).toBeVisible();
      await choose(scenario.page, scenario.backend, 7, "occasional");
      expect(await scenario.backend.answers()).toHaveLength(6);
      for (const label of ["Finish comfortably", "Finish fast", "Race for a result"]) {
        await expect(scenario.page.getByRole("button", { name: label, exact: true })).toBeVisible();
      }
      await scenario.page.locator('[data-parity="choice.custom"]').click();
      await scenario.page
        .locator('[data-parity="custom.textarea"]')
        .fill("Finish the final climb steadily");
      await scenario.page.getByRole("button", { name: "Continue", exact: true }).click();
      await scenario.page
        .getByRole("region", { name: "Did I read this right?", exact: true })
        .getByRole("button", { name: "Confirm", exact: true })
        .click();
      await waitForVersion(scenario.backend, 8);
      expect(await scenario.backend.answers()).toHaveLength(7);
      await cancelAuthoredEdit("Success", '[data-parity="custom.textarea"]', "restriction");
      await question("restriction").getByRole("heading").focus();
      await scenario.page.keyboard.press("Escape");
      await expect(scenario.page.getByRole("button", { name: "Send message" })).toBeEnabled();
      await scenario.page.getByRole("button", { name: "Edit Success", exact: true }).click();
      await scenario.page.locator('[data-parity="custom.textarea"]').fill("Another unsaved change");
      await scenario.page.getByRole("button", { name: "Back to answers", exact: true }).click();
      await expect(question("restriction")).toHaveCount(0);
      await expect(scenario.page.getByRole("button", { name: "Send message" })).toBeEnabled();
      await scenario.page.getByRole("button", { name: "Continue", exact: true }).click();
      await scenario.page.locator('[data-answer="max-duration"]').click();
      await scenario.page.getByLabel("Maximum duration hours", { exact: true }).fill("1.5");
      await scenario.page.getByLabel("Optional end date", { exact: true }).fill("1998-11-01");
      await capture("restriction");
      if (appearance.width === 760) {
        await scenario.fixture.setViewport(720, 600);
        await capture("restriction-720");
      }
      await scenario.page.getByRole("button", { name: "Continue", exact: true }).click();
      await waitForVersion(scenario.backend, 9);
      const card = await requireCard(scenario.backend);
      expect(card).toMatchObject({ readiness: "ready", openQuestion: null });
      expect(card.answeredSummaries.map((summary) => summary.answerKey)).toEqual([
        "goal",
        "schedule-mode",
        "availability",
        "start-timing",
        "commitments",
        "baseline",
        "success",
        "restriction",
      ]);
      const answers = await scenario.backend.answers();
      expect(answers).toHaveLength(8);
      expect(answers.map((row) => row.creation_version)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
      expect(answers.map((row) => row.answer_key)).toEqual([
        "goal",
        "schedule-mode",
        "availability",
        "start-timing",
        "commitments",
        "baseline",
        "success",
        "restriction",
      ]);
      expect(JSON.parse(answers.at(-1)?.value_json ?? "null")).toEqual({
        answer: {
          kind: "restriction",
          restriction: { kind: "max-duration", hours: 1.5, endDate: "1998-11-01" },
        },
        source: { kind: "athlete" },
      });
      await relaunch(scenario, playwright);
      await expect(scenario.page.locator('[data-parity="question.card"]')).toHaveCount(0);
      expect(await requireCard(scenario.backend)).toEqual(card);
      expect(await scenario.backend.answers()).toEqual(answers);
      await expect(
        scenario.page.getByText("The essentials are complete.", { exact: true }),
      ).toBeVisible();
      await expect(
        scenario.page.getByRole("button", { name: "Build Draft", exact: true }),
      ).toBeVisible();
    } finally {
      await close(scenario);
    }
  });
}

test("preserves ordinary Chat, Past chats, and active Plan editing during creation", async ({
  playwright,
}) => {
  const scenario = await launch(playwright, {
    width: 1180,
    height: 820,
    colorScheme: "light",
    coexistence: true,
  });
  const navigation = scenario.page.getByRole("navigation", { name: "Main navigation" });
  const composer = scenario.page.getByRole("combobox", { name: "Message your coach" });
  const historyText = "Keep Sunday easy if recovery slips.";
  const readPlanFacts = async () => {
    const frames = await scenario.backend.script.onRequest({ method: "getPlanState", params: {} });
    const result = GetPlanStateRpcResultSchema.parse(JSON.parse(frames[0] ?? "null"));
    if (result.status !== "ready") throw new TypeError("Active Plan is unavailable");
    const state = { ...result.state, data: { ...result.state.data } };
    delete state.data.returnFocusId;
    return state;
  };
  try {
    const originalPlan = await readPlanFacts();
    await expect(scenario.page.getByText(historyText, { exact: true })).toBeVisible();
    await startFitnessGoal(scenario);
    await expect(composer).toHaveValue("");
    await scenario.page.getByRole("button", { name: "Later", exact: true }).click();
    await expect(composer).toBeEnabled();
    await composer.fill("Keep this ordinary Chat draft.");
    await scenario.page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(composer).toBeDisabled();
    await expect(composer).toHaveValue("Keep this ordinary Chat draft.");
    await scenario.page.getByRole("button", { name: "Later", exact: true }).click();
    await expect(composer).toBeEnabled();
    await expect(composer).toHaveValue("Keep this ordinary Chat draft.");
    const creation = await scenario.backend.inspect();
    await navigation.getByRole("button", { name: "Past chats", exact: true }).click();
    await scenario.page.locator("button.archive-entry").click();
    await expect(scenario.page.getByText(historyText, { exact: true }).last()).toBeVisible();
    await expect(
      scenario.page.getByRole("main", { name: "Past chats" }).getByRole("combobox"),
    ).toHaveCount(0);
    await navigation.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(composer).toHaveValue("Keep this ordinary Chat draft.");
    await navigation.getByRole("button", { name: "Plan", exact: true }).click();
    await scenario.page.getByRole("button", { name: "Plan history", exact: true }).click();
    await scenario.page.getByRole("button", { name: "Open settings", exact: true }).click();
    await expect(
      scenario.page.getByRole("heading", { name: "Plan settings", exact: true }),
    ).toBeVisible();
    await expect(
      scenario.page.getByRole("switch", { name: "Weekly review", exact: true }),
    ).toBeEnabled();
    await scenario.page.getByRole("button", { name: "Back to history", exact: true }).click();
    await scenario.page.getByRole("button", { name: "Back to Plan", exact: true }).click();
    expect(await readPlanFacts()).toEqual(originalPlan);
    await navigation.getByRole("button", { name: "Chat", exact: true }).click();
    expect(await scenario.backend.inspect()).toEqual(creation);
    await expect(composer).toHaveValue("Keep this ordinary Chat draft.");
    await relaunch(scenario, playwright);
    await expect(scenario.page.getByText(historyText, { exact: true })).toBeVisible();
    expect(await scenario.backend.inspect()).toEqual(creation);
    expect(await readPlanFacts()).toEqual(originalPlan);
  } finally {
    await close(scenario);
  }
});
