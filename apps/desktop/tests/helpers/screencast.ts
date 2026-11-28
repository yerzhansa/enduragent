import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";

interface Frame {
  readonly data: Buffer;
  readonly at: number;
}

async function playwrightFfmpeg(): Promise<string | undefined> {
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  const folder = (await readdir(cache).catch(() => [] as string[])).find((entry) =>
    entry.startsWith("ffmpeg-"),
  );
  return folder === undefined ? undefined : join(cache, folder, "ffmpeg-mac");
}

async function encode(frames: readonly Frame[], path: string): Promise<void> {
  const first = frames[0];
  const last = frames.at(-1);
  const ffmpeg = await playwrightFfmpeg();
  if (first === undefined || last === undefined || ffmpeg === undefined) return;
  const encoder = spawn(
    ffmpeg,
    ["-loglevel", "error", "-f", "image2pipe", "-framerate", "10", "-c:v", "mjpeg", "-i", "pipe:0"]
      .concat(["-vf", "scale=1180:820:force_original_aspect_ratio=decrease,pad=1180:820:-1:-1"])
      .concat(["-y", "-an", "-c:v", "vp8", "-b:v", "1M", "-deadline", "realtime", path]),
    { stdio: ["pipe", "ignore", "ignore"] },
  );
  const done = new Promise<void>((resolve) => encoder.once("close", () => resolve()));
  let shown = first;
  let index = 0;
  for (let at = first.at; at <= last.at + 1_000; at += 100) {
    while (index < frames.length && (frames[index]?.at ?? Infinity) <= at) {
      shown = frames[index] ?? shown;
      index += 1;
    }
    encoder.stdin.write(shown.data);
  }
  encoder.stdin.end();
  await done;
}

export async function recordScreencast(
  context: BrowserContext,
  page: Page,
): Promise<(path: string) => Promise<void>> {
  const session = await context.newCDPSession(page);
  const frames: Frame[] = [];
  session.on("Page.screencastFrame", (event) => {
    frames.push({ data: Buffer.from(event.data, "base64"), at: Date.now() });
    void session.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
  });
  await session.send("Page.startScreencast", { format: "jpeg", quality: 70 });
  return async (path) => {
    await session.send("Page.stopScreencast").catch(() => undefined);
    await encode(frames, path);
  };
}
