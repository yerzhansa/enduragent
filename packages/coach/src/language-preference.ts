import { randomBytes as systemRandomBytes } from "node:crypto";
import { LanguageTagSchema, type LanguageTag } from "@enduragent/coach-contract";
import type { LanguagePreferenceStore, StoredLanguagePreference } from "@enduragent/i18n";
import type { LanguagePreferenceRepository } from "@enduragent/kernel/store";
import {
  createDesktopUnitsUlid,
  type UnitsPreferenceServiceDependencies,
} from "./units-preference.js";

export interface LanguagePreferenceService {
  get(): Promise<{ readonly value: LanguageTag | null }>;
  set(value: LanguageTag | null): Promise<{ readonly value: LanguageTag | null }>;
}

export function createLanguagePreferenceService(
  repository: LanguagePreferenceRepository,
  dependencies: UnitsPreferenceServiceDependencies = {},
): LanguagePreferenceService {
  const now = dependencies.now ?? Date.now;
  const randomBytes = dependencies.randomBytes ?? systemRandomBytes;
  return {
    async get() {
      const parsed = LanguageTagSchema.safeParse((await repository.read()).language);
      return { value: parsed.success ? parsed.data : null };
    },
    async set(value) {
      const parsed = LanguageTagSchema.nullable().parse(value);
      const timestamp = now();
      const id = createDesktopUnitsUlid(timestamp, randomBytes(10));
      await repository.set(parsed, { id, deviceId: `desktop:${id}`, now: timestamp });
      return { value: parsed };
    },
  };
}

export function asLanguagePreferenceStore(
  service: LanguagePreferenceService,
): LanguagePreferenceStore {
  const stored = ({ value }: { readonly value: LanguageTag | null }): StoredLanguagePreference => ({
    value,
    origin: value === null ? "unset" : "stored",
  });
  return {
    read: async () => stored(await service.get()),
    write: async (value) => stored(await service.set(value)),
  };
}
