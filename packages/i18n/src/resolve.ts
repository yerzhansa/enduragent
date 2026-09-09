import {
  LanguageTagSchema,
  type LanguageSource,
  type LanguageTag,
} from "@enduragent/coach-contract";
import { describeLanguage } from "./registry.js";

export interface SurfaceHint {
  readonly language: LanguageTag | undefined;
  readonly locale: string | undefined;
}

export interface LanguageResolution {
  readonly language: LanguageTag;
  readonly source: LanguageSource;
  readonly locale: string;
}

export function resolveLanguage(input: {
  readonly saved: LanguageTag | null;
  readonly messageLanguageHint: LanguageTag | undefined;
  readonly surfaceHint: SurfaceHint;
}): LanguageResolution {
  const language = input.saved ?? input.messageLanguageHint ?? input.surfaceHint.language ?? "en";
  const source =
    input.saved !== null
      ? "preference"
      : input.messageLanguageHint !== undefined
        ? "message"
        : input.surfaceHint.language !== undefined
          ? "surface"
          : "default";
  return {
    language,
    source,
    locale: input.surfaceHint.locale ?? describeLanguage(language).defaultLocale,
  };
}

export function normalizeLocaleHint(
  hint: string | readonly string[] | null | undefined,
): LanguageTag | undefined {
  const entries = typeof hint === "string" ? [hint] : (hint ?? []);
  for (const entry of entries) {
    for (const candidate of entry.split(":")) {
      const normalized = candidate.trim().split(/[.@]/)[0]?.replaceAll("_", "-").toLowerCase();
      if (!normalized || normalized === "c" || normalized === "posix") continue;
      const [base, ...parts] = normalized.split("-");
      if (base === "no" || base === "nn") return "nb";
      if (base === "pt") return parts.includes("br") ? "pt-BR" : "pt-PT";
      if (base === "zh") {
        if (parts.includes("hant")) return "zh-Hant";
        if (parts.includes("hans")) return "zh-Hans";
        return parts.some((part) => part === "tw" || part === "hk" || part === "mo")
          ? "zh-Hant"
          : "zh-Hans";
      }
      const parsed = LanguageTagSchema.safeParse(base);
      if (parsed.success) return parsed.data;
    }
  }
  return undefined;
}
