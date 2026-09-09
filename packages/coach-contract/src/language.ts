import { z } from "zod";

export const LanguageTagSchema = z.enum([
  "en",
  "es",
  "fr",
  "it",
  "de",
  "nl",
  "da",
  "sv",
  "nb",
  "fi",
  "pt-PT",
  "pt-BR",
  "pl",
  "ko",
  "ja",
  "zh-Hans",
  "zh-Hant",
]);
export type LanguageTag = z.infer<typeof LanguageTagSchema>;
export const LanguageSourceSchema = z.enum(["preference", "message", "surface", "default"]);
export type LanguageSource = z.infer<typeof LanguageSourceSchema>;
