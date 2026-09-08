import { createCoachLanguage, type CoachLanguage } from "@enduragent/i18n";

export function createTestCoachLanguage(): CoachLanguage {
  return createCoachLanguage({
    store: {
      read: async () => ({ value: null, origin: "unset" }),
      write: async (value) => ({ value, origin: value === null ? "unset" : "stored" }),
    },
    surface: { language: "en", locale: "en-US" },
  });
}
