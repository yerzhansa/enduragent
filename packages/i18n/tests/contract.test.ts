import { expect, it } from "vitest";
import {
  ChatRequestSchema,
  LanguageTagSchema,
  LanguageSourceSchema,
  COACH_RPC_METHOD_NAMES,
  COACH_RPC_METHOD_REGISTRY,
  CoachRpcRequestEnvelopeSchema,
} from "@enduragent/coach-contract";

it("exposes the ordered language tags and language sources", () => {
  expect(Object.keys(COACH_RPC_METHOD_REGISTRY)).toEqual(COACH_RPC_METHOD_NAMES);
  expect(LanguageTagSchema.options).toEqual([
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
  expect(LanguageSourceSchema.options).toEqual(["preference", "message", "surface", "default"]);
});

it("accepts optional language evidence while preserving strict chat turns", () => {
  const request = { chatId: "synthetic-chat", message: "hello" };
  expect(ChatRequestSchema.safeParse(request).success).toBe(true);
  for (const language of LanguageTagSchema.options) {
    for (const languageSource of LanguageSourceSchema.options) {
      expect(
        ChatRequestSchema.safeParse({ ...request, turn: { language, languageSource } }).success,
      ).toBe(true);
    }
  }
  for (const turn of [
    { language: "xx" },
    { languageSource: "environment" },
    { language: null },
    { extra: true },
  ]) {
    expect(ChatRequestSchema.safeParse({ ...request, turn }).success).toBe(false);
  }
});

it.each(["getLanguagePreference", "setLanguagePreference"] as const)(
  "registers strict %s requests and results without events",
  (method) => {
    const entry = COACH_RPC_METHOD_REGISTRY[method];
    expect(COACH_RPC_METHOD_NAMES).toContain(method);
    expect(entry.wireName).toBe(method);
    for (const value of [null, ...LanguageTagSchema.options]) {
      const params = method === "getLanguagePreference" ? {} : { value };
      expect(
        CoachRpcRequestEnvelopeSchema.safeParse({ jsonrpc: "2.0", id: 1, method, params }).success,
      ).toBe(true);
      expect(entry.requestSchema.safeParse({ ...params, extra: true }).success).toBe(false);
      expect(entry.responseSchema.safeParse({ value }).success).toBe(true);
      expect(entry.responseSchema.safeParse({ value, extra: true }).success).toBe(false);
    }
    expect(entry.responseSchema.safeParse({ value: "automatic" }).success).toBe(false);
    expect(entry.responseSchema.safeParse({}).success).toBe(false);
    expect(entry.eventSchema.safeParse({}).success).toBe(false);
  },
);
