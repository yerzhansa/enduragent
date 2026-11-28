import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/chat-desktop.js";

const PROMPT = "How long should Saturday's endurance ride be?";
const REPLY = "Plan about two hours at an easy, conversational effort.";

const FAILURES = [
  {
    name: "Claude Code sign-in ended",
    kind: "subscription-signed-out",
    message: { key: "coach.error.reauthSetup", vars: { provider: "Claude Code" } },
    copy: "Your Claude Code sign-in is no longer valid. Open Setup and sign in again.",
  },
  {
    name: "DeepSeek out of credits",
    kind: "provider-credits",
    message: { key: "coach.error.providerCredits", vars: { provider: "DeepSeek" } },
    copy: "Your DeepSeek account doesn’t have enough credits. Add credits with DeepSeek, then send your message again.",
  },
  {
    name: "DeepSeek model gone",
    kind: "model-unavailable",
    message: { key: "coach.error.modelUnavailable", vars: { provider: "DeepSeek" } },
    copy: "DeepSeek no longer serves this model. Pick another model in Settings, Coach, then send your message again.",
  },
] as const;

async function recordVideo(page: Page): Promise<(path: string) => Promise<void>> {
  const session = await page.context().newCDPSession(page);
  const frames: { readonly data: Buffer; readonly at: number }[] = [];
  session.on("Page.screencastFrame", (event) => {
    frames.push({ data: Buffer.from(event.data, "base64"), at: Date.now() });
    void session.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
  });
  await session.send("Page.startScreencast", { format: "jpeg", quality: 70 });
  return async (path) => {
    await session.send("Page.stopScreencast").catch(() => undefined);
    const cache = join(homedir(), "Library/Caches/ms-playwright");
    const ffmpeg = (await readdir(cache).catch(() => [] as string[])).find((entry) =>
      entry.startsWith("ffmpeg-"),
    );
    if (frames.length === 0 || ffmpeg === undefined) return;
    const encoder = spawn(
      join(cache, ffmpeg, "ffmpeg-mac"),
      ["-loglevel", "error", "-f", "image2pipe", "-framerate", "10", "-c:v", "mjpeg"].concat([
        "-i",
        "pipe:0",
        "-y",
        "-an",
        "-c:v",
        "vp8",
        "-b:v",
        "1M",
        "-deadline",
        "realtime",
        path,
      ]),
      { stdio: ["pipe", "ignore", "ignore"] },
    );
    const done = new Promise<void>((resolve) => encoder.once("close", () => resolve()));
    let index = 0;
    for (let at = frames[0]!.at; at <= frames.at(-1)!.at + 1_000; at += 100) {
      while (index + 1 < frames.length && frames[index + 1]!.at <= at) index += 1;
      encoder.stdin.write(frames[index]!.data);
    }
    encoder.stdin.end();
    await done;
  };
}

test("says what went wrong when the sign-in ends, credits run out or the model is gone", async ({
  chatDesktop,
}, testInfo) => {
  const { page, coach } = chatDesktop;
  const stopVideo = await recordVideo(page);
  try {
    const transcript = page.getByRole("log", { name: "Coach conversation" });
    const composer = page.getByRole("combobox", { name: "Message your coach" });
    const notice = transcript.locator(".chat-error-notice");
    const retry = transcript.getByRole("button", { name: "Retry message" });

    await composer.fill(PROMPT);
    await page.getByRole("button", { name: "Send message" }).click();

    for (const [index, failure] of FAILURES.entries()) {
      if (index > 0) await retry.click();
      await coach.waitForPrompt(PROMPT);
      coach.fail({
        error_class: "unknown",
        kind: failure.kind,
        athleteMessage: failure.copy,
        message: failure.message,
        overflowAttempts: 0,
        timeoutAttempts: 0,
        rateLimitAttempts: 0,
        duration_ms: 1,
        compactions: 0,
      });

      await expect(retry, `${failure.name}: the failed message has no Retry`).toBeEnabled();
      await page.waitForTimeout(600);
      await page.screenshot({ path: testInfo.outputPath(`notice-${index + 1}.png`) });
      await expect(
        notice,
        `${failure.name}: Chat shows only a red icon and Retry, not what went wrong`,
      ).toBeVisible();
      await expect(notice.getByRole("alert")).toHaveText(failure.copy);
      await expect(page.getByText(failure.copy, { exact: true })).toHaveCount(1);
      await expect(notice.getByRole("button", { name: "Add credits" })).toHaveCount(0);
      await expect(transcript.getByText(PROMPT, { exact: true })).toBeVisible();
    }

    await retry.click();
    await coach.waitForPrompt(PROMPT);
    coach.emitText(REPLY);
    coach.finish(REPLY);

    const coachArticle = transcript
      .locator("article[data-delivery]")
      .filter({ hasText: "Coach response" });
    await expect(coachArticle.getByText(REPLY, { exact: true })).toBeVisible();
    await expect(notice).toHaveCount(0);
    await expect(retry).toHaveCount(0);
    expect(chatDesktop.streamRequests).toEqual([
      "resumeChatQueue",
      "retryQueuedTurn",
      "retryQueuedTurn",
      "retryQueuedTurn",
    ]);
    await page.waitForTimeout(600);
  } finally {
    await stopVideo(testInfo.outputPath("video.webm")).catch(() => undefined);
  }
});
