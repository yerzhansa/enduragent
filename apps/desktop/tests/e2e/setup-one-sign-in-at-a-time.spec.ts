import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures/chat-desktop.js";

async function recordScreencast(context: BrowserContext, page: Page) {
  const session = await context.newCDPSession(page);
  const frames: { readonly data: Buffer; readonly at: number }[] = [];
  session.on("Page.screencastFrame", (event) => {
    frames.push({ data: Buffer.from(event.data, "base64"), at: Date.now() });
    void session.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
  });
  await session.send("Page.startScreencast", { format: "jpeg", quality: 70 });
  return async (path: string): Promise<void> => {
    await session.send("Page.stopScreencast").catch(() => undefined);
    if (frames.length === 0) return;
    const cache = join(homedir(), "Library/Caches/ms-playwright");
    const folder = (await readdir(cache).catch(() => [] as string[])).find((entry) =>
      entry.startsWith("ffmpeg-"),
    );
    if (folder === undefined) return;
    const encoder = spawn(
      join(cache, folder, "ffmpeg-mac"),
      [
        "-loglevel",
        "error",
        "-f",
        "image2pipe",
        "-framerate",
        "10",
        "-c:v",
        "mjpeg",
        "-i",
        "pipe:0",
      ].concat(["-y", "-an", "-c:v", "vp8", "-b:v", "1M", "-deadline", "realtime", path]),
      { stdio: ["pipe", "ignore", "ignore"] },
    );
    const done = new Promise<void>((resolve) => encoder.once("close", () => resolve()));
    const start = frames[0]!.at;
    const end = frames.at(-1)!.at + 1_000;
    let index = 0;
    for (let at = start; at <= end; at += 100) {
      while (index + 1 < frames.length && frames[index + 1]!.at <= at) index += 1;
      encoder.stdin.write(frames[index]!.data);
    }
    encoder.stdin.end();
    await done;
  };
}

test.describe("first-run setup runs one sign-in at a time", () => {
  test.use({ durableTrainingData: false });

  test("locks the Intervals.icu controls while the OpenRouter sign-in waits for the browser", async ({
    chatDesktop,
  }, info) => {
    const { page } = chatDesktop;
    const stopScreencast = await recordScreencast(page.context(), page);
    try {
      const gate = page.locator('[data-setup-host="gate"]');
      const connect = gate.locator('[data-setup-trigger="training"]');
      const training = gate.locator('[data-setup-panel="training"]');
      const intervalsSignIn = training.getByRole("button", {
        name: "Sign in with Intervals.icu",
        exact: true,
      });
      const importFiles = training.getByRole("button", {
        name: "Import ride files instead",
        exact: true,
      });
      await connect.click();
      await expect(intervalsSignIn).toBeEnabled();
      await expect(importFiles).toBeEnabled();

      await gate.locator('[data-setup-trigger="ai"]').click();
      await page.locator('[data-setup-menu="ai"] [data-lane="openrouter"]').click();
      const openRouter = gate.locator('[data-setup-panel="openrouter"]');
      await openRouter
        .getByRole("button", { name: "Sign in with OpenRouter", exact: true })
        .click();
      await expect(openRouter.getByRole("button", { name: "Waiting for browser…" })).toBeDisabled();
      await expect.poll(async () => (await chatDesktop.openedExternalUrls()).length).toBe(1);
      await expect(training).toBeVisible();
      await page.screenshot({ path: info.outputPath("openrouter-waiting.png") });

      await expect
        .soft(connect, "Connect Intervals.icu stays clickable while OpenRouter waits")
        .toBeDisabled();
      await expect
        .soft(intervalsSignIn, "Sign in with Intervals.icu stays clickable while OpenRouter waits")
        .toBeDisabled();
      await expect
        .soft(importFiles, "Import ride files instead stays clickable while OpenRouter waits")
        .toBeDisabled();
      await expect(
        openRouter.getByRole("button", { name: "Open the sign-in page again", exact: true }),
      ).toBeEnabled();
      await expect(
        openRouter.getByRole("button", { name: "Enter a code instead", exact: true }),
      ).toBeEnabled();

      await openRouter.getByRole("button", { name: "Cancel sign-in", exact: true }).click();
      await expect(
        openRouter.getByRole("button", { name: "Sign in with OpenRouter", exact: true }),
      ).toBeEnabled();
      await expect(connect).toBeEnabled();
      await expect(intervalsSignIn).toBeEnabled();
      await expect(importFiles).toBeEnabled();
      await page.screenshot({ path: info.outputPath("openrouter-cancelled.png") });
    } finally {
      await stopScreencast(info.outputPath("video.webm")).catch(() => undefined);
    }
  });
});
