import type { LanguageTag } from "@enduragent/coach-contract";
import type { createPhrasebook, Phrasebook } from "@enduragent/i18n/messages";

export async function createDesktopLanguage(input: {
  readonly preferredLanguages: readonly string[];
  readonly load?: typeof createPhrasebook;
}) {
  const { describeLanguage, normalizeLocaleHint } = await import("@enduragent/i18n");
  const load = input.load ?? (await import("@enduragent/i18n/messages")).createPhrasebook;
  const cache = new Map<LanguageTag, Promise<Phrasebook>>();
  const phrasebookFor = (tag: LanguageTag): Promise<Phrasebook> => {
    const cached = cache.get(tag);
    if (cached !== undefined) return cached;
    const pending = load({ tag, locale: describeLanguage(tag).defaultLocale });
    cache.set(tag, pending);
    return pending;
  };
  const loadOrEnglish = async (tag: LanguageTag): Promise<Phrasebook> => {
    try {
      return await phrasebookFor(tag);
    } catch {
      return await phrasebookFor("en");
    }
  };
  const system = await loadOrEnglish(normalizeLocaleHint(input.preferredLanguages) ?? "en");
  let current = system;
  let readPreference: (() => Promise<LanguageTag | null>) | undefined;
  let revision = 0;
  return {
    current: (): Phrasebook => current,
    useSystem(): void {
      revision += 1;
      current = system;
    },
    bind(reader: (() => Promise<LanguageTag | null>) | undefined): void {
      revision += 1;
      readPreference = reader;
      current = system;
    },
    async refresh(): Promise<void> {
      const request = ++revision;
      let next = system;
      try {
        const saved = await readPreference?.();
        if (saved !== undefined && saved !== null) next = await loadOrEnglish(saved);
      } catch {}
      if (request === revision) current = next;
    },
  };
}

export let desktopLanguage: Awaited<ReturnType<typeof createDesktopLanguage>>;

let initialization: Promise<void> | undefined;

export function initializeDesktopLanguage(
  preferredLanguages: readonly string[] = [],
): Promise<void> {
  initialization ??= createDesktopLanguage({ preferredLanguages }).then((language) => {
    desktopLanguage = language;
  });
  return initialization;
}

export const desktopPhrasebook = (): Phrasebook => desktopLanguage.current();

export const refreshDesktopLanguage = (): Promise<void> => desktopLanguage.refresh();
