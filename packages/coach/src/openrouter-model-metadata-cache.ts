import { chmod, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson } from "@enduragent/core";
import {
  parseOpenRouterModelMetadataSnapshot,
  type OpenRouterModelMetadataCache,
  type OpenRouterModelMetadataSnapshot,
} from "@enduragent/engine";

const CACHE_FILE = "openrouter-model-capabilities.json";
const MAX_CACHE_BYTES = 1_048_576;
const MAX_CACHED_MODELS = 256;

interface CacheEnvelope {
  readonly version: 1;
  readonly models: Readonly<Record<string, OpenRouterModelMetadataSnapshot>>;
}

function parseEnvelope(value: unknown): Map<string, OpenRouterModelMetadataSnapshot> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return new Map();
  const candidate = value as { version?: unknown; models?: unknown };
  if (
    candidate.version !== 1 ||
    candidate.models === null ||
    typeof candidate.models !== "object" ||
    Array.isArray(candidate.models)
  ) {
    return new Map();
  }
  const parsed = new Map<string, OpenRouterModelMetadataSnapshot>();
  for (const [modelId, snapshot] of Object.entries(candidate.models)) {
    try {
      const normalized = parseOpenRouterModelMetadataSnapshot(snapshot);
      if (normalized.modelId === modelId) parsed.set(modelId, normalized);
    } catch {
      continue;
    }
  }
  return parsed;
}

export function createPersistentOpenRouterModelMetadataCache(
  configDir: string,
): OpenRouterModelMetadataCache {
  const path = join(configDir, CACHE_FILE);
  let loaded: Promise<Map<string, OpenRouterModelMetadataSnapshot>> | undefined;
  let writes = Promise.resolve();
  const load = (): Promise<Map<string, OpenRouterModelMetadataSnapshot>> => {
    loaded ??= (async () => {
      try {
        const metadata = await stat(path);
        if (!metadata.isFile() || metadata.size > MAX_CACHE_BYTES) return new Map();
        const text = await readFile(path, "utf8");
        if (text.length > MAX_CACHE_BYTES) return new Map();
        return parseEnvelope(JSON.parse(text));
      } catch {
        return new Map();
      }
    })();
    return loaded;
  };
  return Object.freeze({
    async read(modelId: string) {
      return (await load()).get(modelId);
    },
    async write(snapshot: OpenRouterModelMetadataSnapshot) {
      const normalized = parseOpenRouterModelMetadataSnapshot(snapshot);
      const work = writes.then(async () => {
        const models = await load();
        const next = new Map(models);
        next.set(normalized.modelId, normalized);
        const retained = [...next.entries()]
          .sort(([, left], [, right]) => right.fetchedAtMs - left.fetchedAtMs)
          .slice(0, MAX_CACHED_MODELS);
        await mkdir(configDir, { recursive: true, mode: 0o700 });
        if (process.platform !== "win32") await chmod(configDir, 0o700);
        const envelope: CacheEnvelope = {
          version: 1,
          models: Object.fromEntries(retained.sort(([a], [b]) => a.localeCompare(b))),
        };
        await atomicWriteJson(path, envelope);
        models.clear();
        for (const [modelId, value] of retained) models.set(modelId, value);
      });
      writes = work.catch(() => undefined);
      await work;
    },
  });
}
