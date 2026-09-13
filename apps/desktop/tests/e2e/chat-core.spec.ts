import { expect, test } from "./fixtures/chat-desktop.js";

test("streams a coach response through the visible Chat surface", async ({ chatDesktop }) => {
  const { page, coach } = chatDesktop;
  const prompt = "How should I pace a steady indoor ride?";
  const firstDelta = "Start smoothly and keep the first minutes easy.";
  const secondDelta = " Then settle into a steady effort you could repeat.";
  const finalText = `${firstDelta}${secondDelta}`;
  const conversation = page.getByRole("main", { name: "Coaching conversation" });
  const transcript = page.getByRole("log", { name: "Coach conversation" });
  const composer = page.getByRole("combobox", { name: "Message your coach" });

  await composer.fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
  await coach.waitForPrompt(prompt);

  const athleteArticle = transcript.getByText("Your message", { exact: true }).locator("..");
  await expect(athleteArticle.getByText(prompt, { exact: true })).toBeVisible();
  await expect(page.getByText("Coach is working…", { exact: true })).toBeVisible();
  const working = page.locator(".coach-progress");
  await expect(working).toBeVisible();
  await expect(working.locator("svg.animate-spin")).toBeVisible();
  await expect(working).not.toHaveClass(/rounded-card/);
  await expect(working).not.toHaveClass(/bg-surface/);
  await expect(working.getByRole("progressbar")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop responding" })).toBeVisible();

  coach.emitText(firstDelta);
  const coachArticle = transcript.locator("article[data-delivery]").filter({
    hasText: "Coach response",
  });
  await expect(coachArticle).toHaveAttribute("aria-busy", "true");
  await expect(coachArticle.getByText(firstDelta, { exact: true })).toBeVisible();
  coach.emitText(secondDelta);
  await expect(coachArticle).toContainText(finalText);
  coach.finish(finalText);

  await expect(coachArticle.getByText(finalText, { exact: true })).toBeVisible();
  await expect(coachArticle).toHaveAttribute("data-delivery", "complete");
  await expect(coachArticle).not.toHaveAttribute("aria-busy", "true");
  await expect(conversation).toHaveAttribute("data-chat-status", "idle");
  await expect(transcript.getByRole("article")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
});

test("preserves a draft and an in-flight response across navigation", async ({ chatDesktop }) => {
  const { page, coach } = chatDesktop;
  const prompt = "Keep this cadence draft while I check Training.";
  const firstDelta = "Cadence can stay relaxed while you hold the same power.";
  const secondDelta = " Let comfort guide the exact number.";
  const finalText = `${firstDelta}${secondDelta}`;
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  const chatButton = navigation.getByRole("button", { name: "Chat", exact: true });
  const trainingButton = navigation.getByRole("button", { name: "Training", exact: true });
  const transcript = page.getByRole("log", { name: "Coach conversation" });
  const composer = page.getByRole("combobox", { name: "Message your coach" });

  await composer.fill(prompt);
  await trainingButton.click();
  await expect(page.getByRole("heading", { name: "Training" })).toBeVisible();
  await expect(trainingButton).toHaveAttribute("aria-current", "page");
  await chatButton.click();
  await expect(page.getByRole("heading", { name: "Chat" })).toBeVisible();
  await expect(composer).toHaveValue(prompt);

  await page.getByRole("button", { name: "Send message" }).click();
  await coach.waitForPrompt(prompt);
  const coachArticle = page
    .locator('[role="log"][aria-label="Coach conversation"] article[data-delivery]')
    .filter({ hasText: "Coach response" });
  coach.emitText(firstDelta);
  await expect(coachArticle.getByText(firstDelta, { exact: true })).toBeVisible();

  await trainingButton.click();
  await expect(page.getByRole("heading", { name: "Training" })).toBeVisible();
  coach.emitText(secondDelta);
  coach.finish(finalText);
  await expect(coachArticle).toContainText(finalText);
  await expect(coachArticle).toHaveAttribute("data-delivery", "complete");
  await expect(trainingButton).toHaveAttribute("aria-current", "page");

  await chatButton.click();
  await expect(page.getByRole("heading", { name: "Chat" })).toBeVisible();
  await expect(coachArticle.getByText(finalText, { exact: true })).toBeVisible();
  await expect(coachArticle).toHaveAttribute("data-delivery", "complete");
  await expect(transcript.getByText("Your message", { exact: true })).toHaveCount(1);
  await expect(transcript.getByText("Coach response", { exact: true })).toHaveCount(1);
  await expect(transcript.getByText(prompt, { exact: true })).toHaveCount(1);
  await expect(transcript.getByText(finalText, { exact: true })).toHaveCount(1);
  await expect(transcript.getByRole("article")).toHaveCount(2);
  await expect(composer).toHaveValue("");
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
});

test("keeps the latest reply clear while queued work shares the composer shell", async ({
  chatDesktop,
}) => {
  const { page, coach } = chatDesktop;
  const prompt = "Summarize the pacing details from our conversation.";
  const queuedPrompt = "Also compare it with the longer ride.";
  const longReply = Array.from(
    { length: 24 },
    (_, index) => `Pacing detail ${index + 1} stays visible above the composer.`,
  ).join("\n\n");
  const conversation = page.getByRole("main", { name: "Coaching conversation" });
  const composer = page.getByRole("combobox", { name: "Message your coach" });

  await composer.fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
  await coach.waitForPrompt(prompt);
  coach.emitText(longReply);
  await expect(page.getByText("Pacing detail 24 stays visible above the composer.")).toBeVisible();

  await composer.fill(queuedPrompt);
  await composer.press("Enter");
  const queue = page.getByRole("region", { name: "Queued messages, 1 queued message" });
  await expect(queue).toBeVisible();
  await conversation.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });

  const geometry = await page.evaluate(() => {
    const conversationElement = document.querySelector<HTMLElement>(".conversation");
    const wrap = document.querySelector<HTMLElement>(".composer-wrap");
    const shell = document.querySelector<HTMLElement>(".composer-shell");
    const controls = document.querySelector<HTMLElement>(".chat-composer__controls");
    const latestReply = [...document.querySelectorAll<HTMLElement>(".chat-message--coach")].at(-1);
    const queueElement = document.querySelector<HTMLElement>(".chat-queue");
    if (
      conversationElement === null ||
      wrap === null ||
      shell === null ||
      controls === null ||
      latestReply === undefined ||
      queueElement === null
    ) {
      return null;
    }
    const conversationBox = conversationElement.getBoundingClientRect();
    const wrapBox = wrap.getBoundingClientRect();
    const shellBox = shell.getBoundingClientRect();
    const replyBox = latestReply.getBoundingClientRect();
    const shellStyle = getComputedStyle(shell);
    const controlsStyle = getComputedStyle(controls);
    const queueStyle = getComputedStyle(queueElement);
    return {
      transcriptClearsComposer: replyBox.bottom <= conversationBox.bottom + 1,
      composerDoesNotOverlapTranscript: wrapBox.top >= conversationBox.bottom - 1,
      shellStartsWithoutOcclusionStrip: Math.abs(shellBox.top - wrapBox.top) <= 1,
      wrapPaddingTop: getComputedStyle(wrap).paddingTop,
      shellBorderWidth: shellStyle.borderTopWidth,
      shellRadius: shellStyle.borderTopLeftRadius,
      controlsBorderWidth: controlsStyle.borderTopWidth,
      controlsRadius: controlsStyle.borderTopLeftRadius,
      queueBackground: queueStyle.backgroundColor,
    };
  });

  expect(geometry).not.toBeNull();
  expect(geometry).toMatchObject({
    transcriptClearsComposer: true,
    composerDoesNotOverlapTranscript: true,
    shellStartsWithoutOcclusionStrip: true,
    wrapPaddingTop: "0px",
    shellBorderWidth: "1px",
    controlsBorderWidth: "0px",
    controlsRadius: "0px",
    queueBackground: "rgba(0, 0, 0, 0)",
  });
  expect(Number.parseFloat(geometry?.shellRadius ?? "0")).toBeGreaterThan(0);

  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 760, height: 760 });
  await conversation.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const compactGeometry = await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".composer-shell");
    const conversationElement = document.querySelector<HTMLElement>(".conversation");
    const latestReply = [...document.querySelectorAll<HTMLElement>(".chat-message--coach")].at(-1);
    if (shell === null || conversationElement === null || latestReply === undefined) return null;
    const shellBox = shell.getBoundingClientRect();
    const conversationBox = conversationElement.getBoundingClientRect();
    const replyBox = latestReply.getBoundingClientRect();
    return {
      left: shellBox.left,
      right: shellBox.right,
      viewportWidth: document.documentElement.clientWidth,
      horizontalOverflow:
        document.documentElement.scrollWidth > document.documentElement.clientWidth,
      transcriptClearsComposer: replyBox.bottom <= conversationBox.bottom + 1,
    };
  });
  expect(compactGeometry).not.toBeNull();
  expect(compactGeometry?.left ?? -1).toBeGreaterThanOrEqual(0);
  expect(compactGeometry?.right ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
    compactGeometry?.viewportWidth ?? 0,
  );
  expect(compactGeometry?.horizontalOverflow).toBe(false);
  expect(compactGeometry?.transcriptClearsComposer).toBe(true);

  coach.finish(longReply);
  await expect(conversation).toHaveAttribute("data-chat-status", "idle");
});
