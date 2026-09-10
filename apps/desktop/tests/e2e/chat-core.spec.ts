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
