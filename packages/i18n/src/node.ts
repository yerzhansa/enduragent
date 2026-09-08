import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
  renameSync,
  rmSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { LanguageTagSchema, type LanguageTag } from "@enduragent/coach-contract";
import type { LanguagePreferenceStore, StoredLanguagePreference } from "./coach-language.js";
import { normalizeLocaleHint, type SurfaceHint } from "./resolve.js";

const PreferenceFileSchema = z
  .object({ version: z.literal(1), language: LanguageTagSchema.optional() })
  .strict();

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function createFileLanguagePreferenceStore(input: {
  readonly dir: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly onInvalidOverride?: (raw: string) => void;
}): LanguagePreferenceStore {
  const path = join(input.dir, "language.json");
  const rawOverride = (input.env ?? process.env).ENDURAGENT_LANGUAGE;
  const override = normalizeLocaleHint(rawOverride);
  if (rawOverride !== undefined && override === undefined) input.onInvalidOverride?.(rawOverride);
  let cachedStamp: string | undefined;
  let cached: StoredLanguagePreference = { value: null, origin: "unset" };

  function read(): StoredLanguagePreference {
    if (override !== undefined)
      return { value: override, origin: "environment", variable: "ENDURAGENT_LANGUAGE" };
    try {
      const stat = statSync(path, { bigint: true });
      const stamp = `${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}:${stat.size}`;
      if (stamp !== cachedStamp) {
        const content: unknown = JSON.parse(readFileSync(path, "utf8"));
        const parsed = PreferenceFileSchema.safeParse(content);
        cached = parsed.success
          ? { value: parsed.data.language ?? null, origin: "stored" }
          : { value: null, origin: "unset" };
        cachedStamp = stamp;
      }
      return { ...cached };
    } catch (error) {
      if (!isMissing(error) && !(error instanceof SyntaxError)) throw error;
      cachedStamp = undefined;
      cached = { value: null, origin: "unset" };
      return { ...cached };
    }
  }

  return {
    async read() {
      return read();
    },
    async write(value: LanguageTag | null) {
      const document = PreferenceFileSchema.parse({
        version: 1,
        ...(value === null ? {} : { language: value }),
      });
      mkdirSync(input.dir, { recursive: true, mode: 0o700 });
      const temporary = join(input.dir, `.language-${randomUUID()}.tmp`);
      const fd = openSync(temporary, "wx", 0o600);
      try {
        try {
          writeFileSync(fd, JSON.stringify(document), "utf8");
        } finally {
          closeSync(fd);
        }
        renameSync(temporary, path);
      } finally {
        rmSync(temporary, { force: true });
      }
      cachedStamp = undefined;
      return read();
    },
  };
}

export function readEnvironmentSurfaceHint(env: NodeJS.ProcessEnv): SurfaceHint {
  for (const value of [env.LANGUAGE, env.LC_ALL, env.LC_MESSAGES, env.LANG]) {
    for (const candidate of value?.split(":") ?? []) {
      const language = normalizeLocaleHint(candidate);
      if (language === undefined) continue;
      const localeHint = candidate.trim().split(/[.@]/)[0]?.replaceAll("_", "-");
      if (!localeHint) continue;
      try {
        const [locale] = Intl.getCanonicalLocales(localeHint);
        if (locale !== undefined) return { language, locale };
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
      }
    }
  }
  return { language: undefined, locale: undefined };
}
