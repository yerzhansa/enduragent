import { z } from "zod";

export interface OpenRouterModelMetadataSnapshot {
  readonly modelId: string;
  readonly inputModalities: readonly string[];
  readonly fetchedAtMs: number;
}

export interface OpenRouterModelMetadataCache {
  read(modelId: string): Promise<OpenRouterModelMetadataSnapshot | undefined>;
  write(snapshot: OpenRouterModelMetadataSnapshot): Promise<void>;
}

export interface ResolveOpenRouterModelMetadataInput {
  readonly modelId: string;
  readonly apiKey?: string;
  readonly cache: OpenRouterModelMetadataCache;
  readonly maxAgeMs: number;
  readonly now?: () => number;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly baseUrl?: string;
}

const MAX_RESPONSE_CHARS = 1_048_576;
const MODEL_ID = /^[A-Za-z0-9._~:+-]+\/[A-Za-z0-9._~:+-]+$/u;
const SnapshotSchema = z
  .object({
    modelId: z.string().regex(MODEL_ID),
    inputModalities: z.array(z.string().min(1).max(32)).max(16),
    fetchedAtMs: z.number().int().nonnegative(),
  })
  .strict();
const ResponseSchema = z
  .object({
    data: z
      .object({
        id: z.string().regex(MODEL_ID),
        architecture: z
          .object({
            input_modalities: z.array(z.string().min(1).max(32)).max(16),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function fresh(snapshot: OpenRouterModelMetadataSnapshot, now: number, maxAgeMs: number): boolean {
  return snapshot.fetchedAtMs <= now && now - snapshot.fetchedAtMs <= maxAgeMs;
}

function modelUrl(baseUrl: string, modelId: string): URL {
  const encoded = modelId
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return new URL(`model/${encoded}`, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
}

async function fetchSnapshot(
  input: ResolveOpenRouterModelMetadataInput,
  now: number,
): Promise<OpenRouterModelMetadataSnapshot | undefined> {
  const fetcher = input.fetch ?? globalThis.fetch;
  const response = await fetcher(
    modelUrl(input.baseUrl ?? "https://openrouter.ai/api/v1/", input.modelId),
    {
      method: "GET",
      headers:
        input.apiKey === undefined || input.apiKey.length === 0
          ? { accept: "application/json" }
          : { accept: "application/json", authorization: `Bearer ${input.apiKey}` },
      signal: input.signal,
    },
  );
  if (!response.ok) return undefined;
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_CHARS) return undefined;
  const body = await response.text();
  if (body.length > MAX_RESPONSE_CHARS) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const result = ResponseSchema.safeParse(parsed);
  if (!result.success || result.data.data.id !== input.modelId) return undefined;
  return SnapshotSchema.parse({
    modelId: result.data.data.id,
    inputModalities: [...new Set(result.data.data.architecture.input_modalities)].sort(),
    fetchedAtMs: now,
  });
}

export function parseOpenRouterModelMetadataSnapshot(
  value: unknown,
): OpenRouterModelMetadataSnapshot {
  return SnapshotSchema.parse(value);
}

export async function resolveOpenRouterModelMetadata(
  input: ResolveOpenRouterModelMetadataInput,
): Promise<OpenRouterModelMetadataSnapshot | undefined> {
  if (!MODEL_ID.test(input.modelId)) return undefined;
  positiveInteger(input.maxAgeMs, "maxAgeMs");
  const now = (input.now ?? Date.now)();
  let cached: OpenRouterModelMetadataSnapshot | undefined;
  try {
    cached = await input.cache.read(input.modelId);
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && String(error.code) === "ENOENT")) throw error;
    cached = undefined;
  }
  if (cached !== undefined) {
    const parsed = SnapshotSchema.safeParse(cached);
    if (parsed.success && fresh(parsed.data, now, input.maxAgeMs)) return parsed.data;
  }
  let refreshed: OpenRouterModelMetadataSnapshot | undefined;
  try {
    refreshed = await fetchSnapshot(input, now);
  } catch {
    refreshed = undefined;
  }
  if (refreshed !== undefined) {
    await input.cache.write(refreshed);
    return refreshed;
  }
  const parsed = SnapshotSchema.safeParse(cached);
  return parsed.success ? parsed.data : undefined;
}
