import { createCoachLanguage, type CoachLanguage } from "@enduragent/i18n";
import { createPhrasebook } from "@enduragent/i18n/messages";
import {
  createFileLanguagePreferenceStore,
  readEnvironmentSurfaceHint,
} from "@enduragent/i18n/node";
import { createSubsystemLogger } from "./logging/index.js";

export function createNpmCoachLanguage(dataDir: string): CoachLanguage {
  const log = createSubsystemLogger("language", dataDir);
  return createCoachLanguage({
    phrasebooks: createPhrasebook,
    store: createFileLanguagePreferenceStore({
      dir: dataDir,
      env: process.env,
      onInvalidOverride: (raw) => {
        log.warn("Invalid ENDURAGENT_LANGUAGE override; ignoring it.", undefined, { value: raw });
      },
    }),
    surface: readEnvironmentSurfaceHint(process.env),
  });
}
