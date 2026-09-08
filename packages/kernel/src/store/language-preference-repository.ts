import type { SqlStore } from "./ports.js";

export interface LanguagePreferenceMutationStamp {
  readonly id: string;
  readonly deviceId: string;
  readonly now: number;
}

export interface LanguagePreferenceRepository {
  read(): Promise<{ readonly language: string | null }>;
  set(language: string | null, stamp: LanguagePreferenceMutationStamp): Promise<void>;
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function preference(value: unknown): string | null {
  if (value === null || (typeof value === "string" && value.length >= 2 && value.length <= 7)) {
    return value;
  }
  throw new TypeError("Persisted language preference is invalid.");
}

export function createLanguagePreferenceRepository(store: SqlStore): LanguagePreferenceRepository {
  const readRow = () => store.get("SELECT * FROM athlete_language WHERE id = 'singleton'");
  return {
    async read() {
      const row = await readRow();
      return { language: row === undefined ? null : preference(row.language) };
    },
    async set(language, stamp) {
      preference(language);
      if (!ULID.test(stamp.id) || !DEVICE_ID.test(stamp.deviceId)) {
        throw new TypeError("Language mutation identity is invalid.");
      }
      if (!Number.isSafeInteger(stamp.now) || stamp.now < 0) {
        throw new TypeError("Language mutation time is invalid.");
      }
      const current = await readRow();
      if (current === undefined) {
        await store.run(
          `INSERT INTO athlete_language (id, language, device_id, hlc_physical_ms, hlc_counter)
           VALUES ('singleton', ?, ?, ?, 0)`,
          [language, stamp.deviceId, stamp.now],
        );
        return;
      }
      if (preference(current.language) === language && language !== null) return;
      if (
        typeof current.hlc_physical_ms !== "number" ||
        !Number.isSafeInteger(current.hlc_physical_ms) ||
        current.hlc_physical_ms < 0 ||
        typeof current.hlc_counter !== "number" ||
        !Number.isSafeInteger(current.hlc_counter) ||
        current.hlc_counter < 0
      ) {
        throw new TypeError("Language preference stamp is invalid.");
      }
      const physical = Math.max(stamp.now, current.hlc_physical_ms);
      const counter = stamp.now > current.hlc_physical_ms ? 0 : current.hlc_counter + 1;
      if (!Number.isSafeInteger(counter))
        throw new TypeError("Language preference stamp overflow.");
      await store.run(
        `UPDATE athlete_language SET language = ?, hlc_physical_ms = ?, hlc_counter = ?
         WHERE id = 'singleton'`,
        [language, physical, counter],
      );
    },
  };
}
