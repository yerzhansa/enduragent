import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type {
  WorkoutChartModel,
  WorkoutChartSegment,
} from "../workout-change-sets/presentation.js";

const width = 410;
const plotLeft = 36;
const plotRight = 388;
const plotWidth = plotRight - plotLeft;
const plotHeight = 100;
const fontFamily = "Noto Sans CJK SC";
const bundledFontPath = fileURLToPath(new URL("./workout-chart-font.otf", import.meta.url));

function resolveFontPath(): string {
  if (existsSync(bundledFontPath)) return bundledFontPath;
  return createRequire(import.meta.url).resolve(
    "@fontpkg/noto-sans-cjk-sc/NotoSansCJKsc-Regular.otf",
  );
}

export class UnsupportedWorkoutChartTextError extends Error {
  constructor() {
    super("The workout chart font cannot render every label.");
    this.name = "UnsupportedWorkoutChartTextError";
  }
}

function finitePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${label} must be positive.`);
}

function finiteNonnegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${label} must be nonnegative.`);
}

function segmentValues(segment: WorkoutChartSegment): readonly number[] {
  switch (segment.kind) {
    case "steady":
      return [segment.target];
    case "range":
      return [segment.low, segment.high];
    case "ramp":
      return [segment.start, segment.end];
  }
}

function validate(model: WorkoutChartModel): void {
  finitePositive(model.durationSeconds, "Chart duration");
  if (model.segments.length === 0 || model.segments.length > 512)
    throw new TypeError("A chart must contain between 1 and 512 segments.");
  let durationSeconds = 0;
  for (const segment of model.segments) {
    finitePositive(segment.durationSeconds, "Segment duration");
    durationSeconds += segment.durationSeconds;
    for (const value of segmentValues(segment)) {
      finiteNonnegative(value, "Segment target");
      if (model.unit === "zone" && value > 7)
        throw new TypeError("Zone chart targets must be between 0 and 7.");
    }
    if (segment.kind === "range" && segment.low > segment.high)
      throw new TypeError("Range chart targets must be ordered.");
  }
  if (Math.abs(durationSeconds - model.durationSeconds) > 0.000001)
    throw new TypeError("Chart segment durations must equal the workout duration.");
}

function cleanText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function supportedCodePoint(value: number): boolean {
  return (
    (value >= 0x20 && value <= 0x7e) ||
    (value >= 0xa0 && value <= 0x0103) ||
    (value >= 0x0110 && value <= 0x0113) ||
    (value >= 0x011a && value <= 0x011b) ||
    (value >= 0x0128 && value <= 0x012b) ||
    (value >= 0x0143 && value <= 0x0144) ||
    (value >= 0x0147 && value <= 0x0148) ||
    (value >= 0x014c && value <= 0x014f) ||
    (value >= 0x0152 && value <= 0x0153) ||
    (value >= 0x0168 && value <= 0x016d) ||
    value === 0x0192 ||
    (value >= 0x01a0 && value <= 0x01a1) ||
    (value >= 0x01af && value <= 0x01b0) ||
    (value >= 0x01cd && value <= 0x01dc) ||
    value === 0x01f8 ||
    value === 0x01f9 ||
    value === 0x0251 ||
    value === 0x0261 ||
    value === 0x0300 ||
    value === 0x0301 ||
    value === 0x0304 ||
    value === 0x0307 ||
    value === 0x030c ||
    (value >= 0x0391 && value <= 0x03a1) ||
    (value >= 0x03a3 && value <= 0x03a9) ||
    (value >= 0x03b1 && value <= 0x03c9) ||
    value === 0x0401 ||
    (value >= 0x0410 && value <= 0x044f) ||
    value === 0x0451 ||
    (value >= 0x1100 && value <= 0x11ff) ||
    (value >= 0x2002 && value <= 0x2003) ||
    (value >= 0x2010 && value <= 0x2016) ||
    (value >= 0x2018 && value <= 0x201a) ||
    (value >= 0x201c && value <= 0x201e) ||
    (value >= 0x2020 && value <= 0x2022) ||
    (value >= 0x2025 && value <= 0x2027) ||
    value === 0x2030 ||
    (value >= 0x2032 && value <= 0x2033) ||
    value === 0x2035 ||
    (value >= 0x2039 && value <= 0x203c) ||
    value === 0x2042 ||
    (value >= 0x2047 && value <= 0x2049) ||
    value === 0x2051 ||
    (value >= 0x2190 && value <= 0x2199) ||
    (value >= 0x3000 && value <= 0x303f) ||
    (value >= 0x3041 && value <= 0x3096) ||
    (value >= 0x3099 && value <= 0x30ff) ||
    (value >= 0x3105 && value <= 0x312f) ||
    (value >= 0x3131 && value <= 0x318e) ||
    (value >= 0x3400 && value <= 0x4db5) ||
    (value >= 0x4e00 && value <= 0x9fef) ||
    (value >= 0xa960 && value <= 0xa97c) ||
    (value >= 0xac00 && value <= 0xd7a3) ||
    (value >= 0xd7b0 && value <= 0xd7c6) ||
    (value >= 0xd7cb && value <= 0xd7fb) ||
    (value >= 0xf900 && value <= 0xfa6d) ||
    (value >= 0xff01 && value <= 0xffbe) ||
    (value >= 0xffc2 && value <= 0xffc7) ||
    (value >= 0xffca && value <= 0xffcf) ||
    (value >= 0xffd2 && value <= 0xffd7) ||
    (value >= 0xffda && value <= 0xffdc) ||
    (value >= 0xffe0 && value <= 0xffe6) ||
    (value >= 0xffe8 && value <= 0xffee)
  );
}

function chartText(model: WorkoutChartModel): readonly string[] {
  return [model.title, model.subtitle, model.axisLabel, model.startLabel, model.endLabel];
}

export function canRenderWorkoutChartText(model: WorkoutChartModel): boolean {
  const values = chartText(model).map((value) => [...cleanText(value)]);
  return (
    values.every((characters) => characters.length <= 512) &&
    values.reduce((sum, characters) => sum + characters.length, 0) <= 1024 &&
    values.every((characters) =>
      characters.every((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && supportedCodePoint(codePoint);
      }),
    )
  );
}

function displayWidth(character: string): number {
  const value = character.codePointAt(0) ?? 0;
  if (value >= 0x0300 && value <= 0x036f) return 0;
  if (value >= 0x2e80) return 1;
  if (character === " ") return 0.35;
  if (/[MW@%]/u.test(character)) return 1;
  return 0.7;
}

function wrap(value: string, maximumWidth: number): string[] {
  const characters = [...cleanText(value)];
  if (characters.length === 0) return [""];
  const lines: string[] = [];
  let line: string[] = [];
  let lineWidth = 0;
  let lastSpace = -1;
  for (const character of characters) {
    const characterWidth = displayWidth(character);
    if (lineWidth + characterWidth <= maximumWidth || line.length === 0) {
      line.push(character);
      lineWidth += characterWidth;
      if (character === " ") lastSpace = line.length - 1;
      continue;
    }
    if (lastSpace > 0) {
      const next = line.slice(lastSpace + 1);
      lines.push(line.slice(0, lastSpace).join(""));
      line = [...next, character];
    } else {
      lines.push(line.join(""));
      line = [character];
    }
    lineWidth = line.reduce((sum, item) => sum + displayWidth(item), 0);
    lastSpace = line.lastIndexOf(" ");
  }
  if (line.length > 0) lines.push(line.join("").trim());
  return lines;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function textLines(lines: readonly string[], x: number, y: number, lineHeight: number): string {
  return lines
    .map((line, index) => `<text x="${x}" y="${y + index * lineHeight}">${escapeXml(line)}</text>`)
    .join("");
}

function niceMaximum(model: WorkoutChartModel): number {
  if (model.unit === "zone") return 7;
  const maximum = Math.max(...model.segments.flatMap((segment) => segmentValues(segment)));
  const minimum = model.unit === "percent_ftp" ? 100 : 1;
  const target = Math.max(maximum, minimum);
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const normalized = target / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return factor * magnitude;
}

function tickValues(model: WorkoutChartModel, maximum: number): readonly number[] {
  if (model.unit === "zone") return [6, 3];
  if (model.unit === "percent_ftp" && maximum === 100) return [75, 50];
  return [maximum * 0.75, maximum * 0.5];
}

function formatTick(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/u, "");
}

function segmentPath(input: {
  readonly segment: WorkoutChartSegment;
  readonly x: number;
  readonly span: number;
  readonly baseline: number;
  readonly maximum: number;
}): string {
  const y = (value: number): number => input.baseline - (value / input.maximum) * plotHeight;
  const right = input.x + input.span;
  switch (input.segment.kind) {
    case "steady":
      return `<path fill="#2476ad" d="M${input.x} ${input.baseline}V${y(input.segment.target)}H${right}V${input.baseline}Z"/>`;
    case "range":
      return `<path fill="#edf4f8" d="M${input.x} ${y(input.segment.low)}H${right}V${input.baseline}H${input.x}Z"/><path fill="#779db4" d="M${input.x} ${y(input.segment.high)}H${right}V${y(input.segment.low)}H${input.x}Z"/>`;
    case "ramp":
      return `<path fill="#2476ad" d="M${input.x} ${input.baseline}V${y(input.segment.start)}L${right} ${y(input.segment.end)}V${input.baseline}Z"/>`;
  }
}

export function renderWorkoutChartSvg(model: WorkoutChartModel): string {
  validate(model);
  if (!canRenderWorkoutChartText(model)) throw new UnsupportedWorkoutChartTextError();
  const titleLines = wrap(model.title, 20);
  const subtitleLines = wrap(model.subtitle, 30);
  const axisLines = wrap(model.axisLabel, 30);
  const headerHeight =
    18 + titleLines.length * 19 + subtitleLines.length * 16 + axisLines.length * 15;
  const plotTop = headerHeight + 10;
  const baseline = plotTop + plotHeight;
  const imageHeight = baseline + 35;
  const maximum = niceMaximum(model);
  const ticks = tickValues(model, maximum);
  let x = plotLeft;
  const paths = model.segments
    .map((segment, index) => {
      const remaining = plotRight - x;
      const span =
        index === model.segments.length - 1
          ? remaining
          : (segment.durationSeconds / model.durationSeconds) * plotWidth;
      const path = segmentPath({ segment, x, span, baseline, maximum });
      x += span;
      return path;
    })
    .join("");
  const grid = ticks
    .map((tick) => {
      const tickY = baseline - (tick / maximum) * plotHeight;
      return `<text x="4" y="${tickY + 4}" font-size="10">${escapeXml(formatTick(tick))}</text><line x1="${plotLeft}" y1="${tickY}" x2="${plotRight}" y2="${tickY}" stroke="#d7dfe2" stroke-dasharray="3 4"/>`;
    })
    .join("");
  const titleY = 25;
  const subtitleY = titleY + titleLines.length * 19;
  const axisY = subtitleY + subtitleLines.length * 16 + 5;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${imageHeight}" viewBox="0 0 ${width} ${imageHeight}"><rect width="${width}" height="${imageHeight}" fill="#ffffff"/><g fill="#62717a" font-family="${fontFamily}" font-size="11"><g fill="#20282d" font-size="16" font-weight="600">${textLines(titleLines, 28, titleY, 19)}</g>${textLines(subtitleLines, 28, subtitleY, 16)}${textLines(axisLines, 28, axisY, 15)}${grid}${paths}<line x1="${plotLeft}" y1="${baseline}" x2="${plotRight}" y2="${baseline}" stroke="#d7dfe2"/><text x="${plotLeft}" y="${baseline + 22}">${escapeXml(cleanText(model.startLabel))}</text><text x="${plotRight}" y="${baseline + 22}" text-anchor="end">${escapeXml(cleanText(model.endLabel))}</text></g></svg>`;
}

export async function renderWorkoutChart(model: WorkoutChartModel): Promise<Uint8Array> {
  const svg = renderWorkoutChartSvg(model);
  const { Resvg } = await import("@resvg/resvg-js");
  const renderer = new Resvg(svg, {
    background: "#ffffff",
    fitTo: { mode: "width", value: 1230 },
    font: {
      defaultFontFamily: fontFamily,
      fontFiles: [resolveFontPath()],
      loadSystemFonts: false,
      sansSerifFamily: fontFamily,
    },
    imageRendering: 0,
    shapeRendering: 2,
    textRendering: 2,
  });
  return renderer.render().asPng();
}
