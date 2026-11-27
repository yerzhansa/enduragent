import { expect, test } from "./fixtures/chat-desktop.js";

const CREDITS_COPY =
  "Your OpenRouter account doesn't have enough credits. Add credits on OpenRouter, then send your message again.";

test("offers Add credits when OpenRouter has no credits and keeps the message to send again", async ({
  chatDesktop,
}) => {
  const { page, coach } = chatDesktop;
  const prompt = "How long should Saturday's endurance ride be?";
  const reply = "Plan about two hours at an easy, conversational effort.";
  const transcript = page.getByRole("log", { name: "Coach conversation" });
  const composer = page.getByRole("combobox", { name: "Message your coach" });

  await composer.fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
  await coach.waitForPrompt(prompt);
  coach.fail({
    error_class: "unknown",
    kind: "openrouter-credits",
    athleteMessage: CREDITS_COPY,
    message: { key: "coach.error.openRouterCredits", vars: { openrouter: "OpenRouter" } },
    overflowAttempts: 0,
    timeoutAttempts: 0,
    rateLimitAttempts: 0,
    duration_ms: 1,
    compactions: 0,
  });

  const credits = transcript.locator(".chat-error-notice");
  await expect(credits).toBeVisible();
  await expect(credits.getByRole("alert")).toHaveText(CREDITS_COPY);
  await expect(page.getByText(CREDITS_COPY, { exact: true })).toHaveCount(1);
  await expect(transcript.getByText(prompt, { exact: true })).toBeVisible();
  const retry = transcript.getByRole("button", { name: "Retry message" });
  await expect(retry).toBeEnabled();
  await expect(composer).toHaveValue("");

  await credits.getByRole("button", { name: "Add credits" }).click();
  await expect
    .poll(() => chatDesktop.openedExternalUrls())
    .toEqual(["https://openrouter.ai/settings/credits"]);
  await expect(credits).toBeVisible();
  expect(chatDesktop.streamRequests).toEqual(["resumeChatQueue"]);

  await retry.click();
  await coach.waitForPrompt(prompt);
  coach.emitText(reply);
  coach.finish(reply);

  const coachArticle = transcript.locator("article[data-delivery]").filter({
    hasText: "Coach response",
  });
  await expect(coachArticle.getByText(reply, { exact: true })).toBeVisible();
  await expect(coachArticle).toHaveAttribute("data-delivery", "complete");
  await expect(credits).toHaveCount(0);
  await expect(retry).toHaveCount(0);
  expect(chatDesktop.streamRequests).toEqual(["resumeChatQueue", "retryQueuedTurn"]);
  expect(await chatDesktop.openedExternalUrls()).toEqual([
    "https://openrouter.ai/settings/credits",
  ]);
});
