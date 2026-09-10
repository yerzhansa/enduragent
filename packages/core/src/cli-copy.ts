import { AsyncLocalStorage } from "node:async_hooks";
import { createCoachLanguage, type CatalogKey, type Message } from "@enduragent/i18n";
import { createPhrasebook, type Phrasebook } from "@enduragent/i18n/messages";

const english = await createCoachLanguage({
  store: {
    async read() {
      return { value: null, origin: "unset" };
    },
    async write(value) {
      return { value, origin: "stored" };
    },
  },
  surface: { language: "en", locale: "en-GB" },
  phrasebooks: createPhrasebook,
}).phrasebookFor({});

const phrasebooks = new AsyncLocalStorage<Phrasebook>();

export function cliPhrasebook(): Phrasebook {
  return phrasebooks.getStore() ?? english;
}

export function say(message: Message | CatalogKey, vars?: Message["vars"]): string {
  const phrasebook = cliPhrasebook();
  return typeof message === "string" ? phrasebook.say(message, vars) : phrasebook.say(message);
}

export function withCliPhrasebook<T>(phrasebook: Phrasebook, run: () => T): T {
  return phrasebooks.run(phrasebook, run);
}
