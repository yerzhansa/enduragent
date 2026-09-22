import { InputFile } from "grammy";
import { escapeHtmlText } from "./html-escape.js";
import { canRenderWorkoutChartText, renderWorkoutChart } from "./workout-chart.js";
import type {
  WorkoutCardBlock,
  WorkoutCardContent,
  WorkoutReviewDocument,
} from "../workout-change-sets/presentation.js";

const TELEGRAM_PHOTO_CAPTION_LIMIT = 1024;
const TELEGRAM_MESSAGE_LIMIT = 4096;

function softSplitLength(characters: readonly string[], maximum: number): number {
  let units = 0;
  let limit = 0;
  while (limit < characters.length && units + (characters[limit]?.length ?? 0) <= maximum) {
    units += characters[limit]?.length ?? 0;
    limit += 1;
  }
  if (limit === characters.length) return limit;
  for (let index = limit; index > Math.floor(limit / 2); index -= 1) {
    const character = characters[index - 1];
    if (character === "\n" || character === " " || character === "\t") return index;
  }
  return limit;
}

function formatCardFragment(block: WorkoutCardBlock, text: string): string {
  const escaped = escapeHtmlText(text);
  return block.kind === "heading" ? `<b>${escaped}</b>` : escaped;
}

export function splitWorkoutCardContent(
  content: WorkoutCardContent,
  maximumVisibleCharacters: number,
): string[] {
  const parts: string[] = [];
  let html = "";
  let visible = 0;
  const flush = (): void => {
    if (visible > 0) parts.push(html);
    html = "";
    visible = 0;
  };
  for (const block of content.blocks) {
    let remaining = Array.from(block.text);
    let firstFragment = true;
    while (remaining.length > 0) {
      const separator = visible > 0 && firstFragment ? "\n\n" : "";
      const capacity = maximumVisibleCharacters - visible - separator.length;
      if (capacity <= 0) {
        flush();
        continue;
      }
      const length = softSplitLength(remaining, capacity);
      if (length === 0) {
        flush();
        continue;
      }
      const fragment = remaining.slice(0, length).join("");
      remaining = remaining.slice(length);
      html += `${separator}${formatCardFragment(block, fragment)}`;
      visible += separator.length + fragment.length;
      firstFragment = false;
      if (remaining.length > 0) flush();
    }
  }
  flush();
  return parts;
}

export async function deliverTelegramWorkoutReview(
  ctx: {
    reply: (text: string, options?: Record<string, unknown>) => Promise<unknown>;
    replyWithPhoto: (photo: InputFile, options?: Record<string, unknown>) => Promise<unknown>;
  },
  document: WorkoutReviewDocument,
  sendText: (text: string) => Promise<void>,
): Promise<void> {
  await sendText(document.introduction);
  for (const card of document.cards) {
    const content = card.kind === "plot" ? card.caption : card.content;
    const parts = splitWorkoutCardContent(
      content,
      card.kind === "plot" ? TELEGRAM_PHOTO_CAPTION_LIMIT : TELEGRAM_MESSAGE_LIMIT,
    );
    if (card.kind === "text" || !canRenderWorkoutChartText(card.chart)) {
      for (const part of parts) await ctx.reply(part, { parse_mode: "HTML" });
      continue;
    }
    const image = await renderWorkoutChart(card.chart);
    const caption = parts[0];
    await ctx.replyWithPhoto(
      new InputFile(image, "workout-review.png"),
      caption === undefined ? {} : { caption, parse_mode: "HTML" },
    );
    for (const overflow of parts.slice(1)) {
      await ctx.reply(overflow, { parse_mode: "HTML" });
    }
  }
  if (document.context !== "") await sendText(document.context);
}
