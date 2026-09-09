type ChannelSummary = {
  min: number;
  max: number;
  mean: number;
};

export type StreamSummary = {
  sampleCount: number;
  channels: Record<string, ChannelSummary>;
};

function toChannelArrays(raw: unknown): Array<[string, unknown[]]> {
  if (Array.isArray(raw)) {
    const out: Array<[string, unknown[]]> = [];
    for (const el of raw) {
      if (el === null || typeof el !== "object") continue;
      const { type, data } = el as { type?: unknown; data?: unknown };
      if (typeof type === "string" && Array.isArray(data)) out.push([type, data]);
    }
    return out;
  }
  if (raw !== null && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>).filter(
      (entry): entry is [string, unknown[]] => Array.isArray(entry[1]),
    );
  }
  return [];
}

function summarizeChannel(values: readonly unknown[]): ChannelSummary | null {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let count = 0;

  for (const v of values) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    count++;
  }

  if (count === 0) return null;
  const mean = Math.round((sum / count) * 10) / 10;
  return { min, max, mean };
}

export function summarizeStreams(raw: Record<string, unknown> | unknown[]): StreamSummary {
  const channels: Record<string, ChannelSummary> = {};
  let sampleCount = 0;

  for (const [name, values] of toChannelArrays(raw)) {
    const summary = summarizeChannel(values);
    if (!summary) continue;
    channels[name] = summary;
    if (values.length > sampleCount) sampleCount = values.length;
  }

  return { sampleCount, channels };
}
