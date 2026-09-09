import { createCoachLanguage, type CoachLanguage } from "@enduragent/i18n";
import { createPhrasebook } from "@enduragent/i18n/messages";

export function createTestCoachLanguage(): CoachLanguage {
  return createCoachLanguage({
    phrasebooks: createPhrasebook,
    store: {
      read: async () => ({ value: null, origin: "unset" }),
      write: async (value) => ({ value, origin: value === null ? "unset" : "stored" }),
    },
    surface: { language: "en", locale: "en-US" },
  });
}
