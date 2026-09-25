import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canRenderWorkoutChartText,
  renderWorkoutChart,
  renderWorkoutChartSvg,
  UnsupportedWorkoutChartTextError,
} from "../src/channels/workout-chart.js";
import type { WorkoutChartModel } from "../src/workout-change-sets/presentation.js";

const model: WorkoutChartModel = {
  title: "Synthetic intervals",
  subtitle: "24 September 1998 · 15 min",
  axisLabel: "Effort · % FTP",
  startLabel: "0",
  endLabel: "15 min",
  unit: "percent_ftp",
  durationSeconds: 900,
  segments: [
    { kind: "ramp", durationSeconds: 300, start: 45, end: 60 },
    { kind: "range", durationSeconds: 300, low: 70, high: 80 },
    { kind: "steady", durationSeconds: 300, target: 50 },
  ],
};

function dimensions(png: Uint8Array): readonly [number, number] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return [view.getUint32(16), view.getUint32(20)];
}

describe("workout chart rasterization", () => {
  it("renders deterministic PNG bytes with a three-times scale", async () => {
    const first = await renderWorkoutChart(model);
    const second = await renderWorkoutChart(model);
    expect(Array.from(first.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(dimensions(first)).toEqual([1230, 639]);
    expect(createHash("sha256").update(first).digest("hex")).toBe(
      createHash("sha256").update(second).digest("hex"),
    );
  });

  it("draws steady, range, and ramp segments at duration-weighted widths", () => {
    const svg = renderWorkoutChartSvg({
      ...model,
      segments: [
        { kind: "ramp", durationSeconds: 225, start: 45, end: 60 },
        { kind: "range", durationSeconds: 450, low: 70, high: 80 },
        { kind: "steady", durationSeconds: 225, target: 50 },
      ],
    });
    expect(svg).toMatch(/<path fill="#2476ad" d="M36 [^"]+L124 /u);
    expect(svg).toMatch(/<path fill="#edf4f8" d="M124 [^"]+H300/u);
    expect(svg).toMatch(/<path fill="#2476ad" d="M300 [^"]+H388/u);
    expect(svg).toContain('font-size="10">75</text>');
    expect(svg).toContain('font-size="10">50</text>');
  });

  it("escapes labels and renders Latin, Cyrillic, and CJK names", async () => {
    const title = "Easy <ride> & Лёгкая 骑行";
    const svg = renderWorkoutChartSvg({ ...model, title });
    expect(svg).toContain("Easy &lt;ride&gt; &amp; Лёгкая 骑行");
    expect(canRenderWorkoutChartText({ ...model, title })).toBe(true);
    await expect(renderWorkoutChart({ ...model, title })).resolves.toBeInstanceOf(Uint8Array);
  });

  it("wraps a long wide title without dropping text", async () => {
    const title = "W".repeat(120);
    const svg = renderWorkoutChartSvg({ ...model, title });
    const titleGroup = svg.match(/<g fill="#20282d"[^>]*>(.*?)<\/g>/u)?.[1] ?? "";
    const lines = [...titleGroup.matchAll(/<text[^>]*>(.*?)<\/text>/gu)].map(
      (match) => match[1] ?? "",
    );
    expect(lines).toHaveLength(6);
    expect(lines.every((line) => line.length <= 20)).toBe(true);
    expect(lines.join("")).toBe(title);
    await expect(renderWorkoutChart({ ...model, title })).resolves.toBeInstanceOf(Uint8Array);
  });

  it("signals a text fallback for scripts outside the vendored font", async () => {
    const unsupported = { ...model, title: "جولة سهلة" };
    expect(canRenderWorkoutChartText(unsupported)).toBe(false);
    expect(() => renderWorkoutChartSvg(unsupported)).toThrow(UnsupportedWorkoutChartTextError);
    await expect(renderWorkoutChart(unsupported)).rejects.toThrow(UnsupportedWorkoutChartTextError);
  });

  it("signals a text fallback before an oversized label can allocate an image", () => {
    const oversized = { ...model, title: "W".repeat(513) };
    expect(canRenderWorkoutChartText(oversized)).toBe(false);
    expect(() => renderWorkoutChartSvg(oversized)).toThrow(UnsupportedWorkoutChartTextError);
  });

  it("rejects invalid chart geometry", () => {
    expect(() =>
      renderWorkoutChartSvg({
        ...model,
        durationSeconds: 899,
      }),
    ).toThrow("Chart segment durations must equal the workout duration.");
    expect(() =>
      renderWorkoutChartSvg({
        ...model,
        segments: [{ kind: "range", durationSeconds: 900, low: 80, high: 70 }],
      }),
    ).toThrow("Range chart targets must be ordered.");
  });
});
