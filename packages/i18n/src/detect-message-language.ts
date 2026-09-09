import type { LanguageTag } from "@enduragent/coach-contract";

type LatinLanguage = Exclude<LanguageTag, "ko" | "ja" | "zh-Hans" | "zh-Hant" | "pt-BR">;

const WORDS: Readonly<Record<LatinLanguage, string>> = {
  en: "the and of to in is that for it with as was on be this have from or by but not are my can should would how what after before today tomorrow yesterday ride training feel legs recovery easy week during want need more than also a an i me we you",
  es: "el la los las de del y en que para por con una un es mi mis al se no me como pero más hoy mañana ayer después antes entrenamiento bicicleta piernas puedo debo quiero hacer durante esta este semana tengo siento estoy suave recuperación",
  fr: "le la les de des du et en que pour avec une un est mon mes au aux je ne pas sur mais plus aujourd'hui demain hier après avant entraînement vélo jambes peux dois voudrais faire pendant cette ce semaine suis ai mes récupération sortie",
  it: "il lo la gli le di del della e che per con una un è mio mia al non mi come ma più oggi domani ieri dopo prima allenamento bicicletta gambe posso devo vorrei fare durante questa questo settimana sono ho sento recupero uscita",
  de: "der die das den dem des und in zu ist dass für mit ein eine mein meine am auf ich nicht mir wie aber mehr heute morgen gestern nach vor training fahrrad beine kann soll möchte machen während diese dieser woche habe fühle erholung fahrt",
  nl: "de het een en van te dat voor met is mijn op ik niet me hoe maar meer vandaag morgen gisteren na vóór training fiets benen kan moet wil doen tijdens deze dit week heb voel herstel rit zijn als om nog graag rustig omdat",
  da: "den det de en et og af at er for med min mine på jeg ikke mig hvordan men mere i dag morgen efter før træning cykel ben kan skal vil gøre under denne dette uge har føler restitution tur var som til gerne rolig fordi også træt træne trætte roligt kørt",
  sv: "den det de en ett och av att är för med min mina på jag inte mig hur men mer idag imorgon igår efter före träning cykel ben kan ska vill göra under denna detta vecka har känner återhämtning tur var som till gärna lugn eftersom också trött",
  nb: "den det de en et og av at er for med min mine på jeg ikke meg hvordan men mer i dag morgen etter før trening sykkel bein kan skal vil gjøre under denne dette uke har føler restitusjon tur var som til gjerne rolig fordi også sliten trene slitne syklet kjørt",
  fi: "ja on ei että se kun jos niin kuin mutta tai sekä minun olen oli ovat kanssa tänään huomenna eilen jälkeen ennen harjoitus pyörä jalat voin pitäisi haluan tehdä aikana tämä viikko minulla tuntuu palautuminen lenkki miten voinko paljon vielä nyt jotta olisi olivat haluaisin",
  "pt-PT":
    "o a os as de do da dos das e em que para por com uma um é meu minha meus minhas ao não me como mas mais hoje amanhã ontem depois antes treino bicicleta pernas posso devo quero fazer durante esta este semana tenho sinto estou recuperação pedalada",
  pl: "i w na z do że nie to jest się jak ale po przed dla czy mój moje mam jestem dzisiaj jutro wczoraj trening rower nogi mogę powinien chcę zrobić podczas ten ta tydzień czuję regeneracja jazda bardzo jeszcze ponieważ żeby oraz był były chciałbym odpoczynek",
};

const PROFILES = Object.entries(WORDS).map(([language, words]) => ({
  language,
  words: new Set(words.split(" ")),
}));

const DIACRITICS: Readonly<Partial<Record<LatinLanguage, RegExp>>> = {
  es: /[ñ¿¡]/u,
  fr: /[œç]|[àâêîôû]/u,
  it: /[ìòù]/u,
  de: /[ßü]/u,
  da: /[æø]/u,
  sv: /[äö]/u,
  nb: /[æø]/u,
  fi: /[äö]/u,
  "pt-PT": /[ãõç]/u,
  pl: /[ąćęłńśźż]/u,
};

function cleanMessage(text: string): string {
  const stripped = text
    .replace(/^\s*(?:\/[\w-]+(?:@[\w-]+)?(?:\s+|$))+/u, "")
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/gu, " ")
    .replace(/(?:https?:\/\/|www\.)\S+/giu, " ")
    .replace(/\p{N}+/gu, " ");
  let sample = "";
  let count = 0;
  for (const point of stripped) {
    if (count === 512) break;
    sample += point;
    count += 1;
  }
  return sample.normalize("NFC").toLowerCase();
}

export function detectMessageLanguage(text: string): LanguageTag | undefined {
  const sample = cleanMessage(text);
  if (/\p{Script=Hangul}/u.test(sample)) return "ko";
  if (/\p{Script=Hiragana}|\p{Script=Katakana}/u.test(sample)) return "ja";
  if (/\p{Script=Han}/u.test(sample)) {
    return /[體訓練這個們時學車騎鐘週強級區間]/u.test(sample) ? "zh-Hant" : "zh-Hans";
  }
  const tokens = new Set(sample.match(/[\p{Script=Latin}]+(?:['’][\p{Script=Latin}]+)?/gu) ?? []);
  if (tokens.size < 3) return undefined;
  const scores = PROFILES.map((profile) => {
    let score = 0;
    let matches = 0;
    for (const token of tokens) {
      if (!profile.words.has(token)) continue;
      matches += 1;
      const shared = PROFILES.filter((other) => other.words.has(token)).length;
      score += shared === 1 ? 3 : 1;
    }
    const language = Object.keys(WORDS).find(
      (key): key is LatinLanguage => key === profile.language && Object.hasOwn(WORDS, key),
    );
    if (language === undefined) return undefined;
    const marker = DIACRITICS[language];
    if (marker?.test(sample)) score += 2;
    return { language, score, matches };
  })
    .filter((score) => score !== undefined)
    .sort((a, b) => b.score - a.score);
  const best = scores[0];
  const second = scores[1];
  if (!best || best.matches < 3 || best.score < 6 || best.score - (second?.score ?? 0) < 3)
    return undefined;
  if (
    best.language === "pt-PT" &&
    (tokens.has("você") ||
      tokens.has("vocês") ||
      /treino de hoje|\b(?:celular|legal|pedalando)\b/u.test(sample))
  )
    return "pt-BR";
  return best.language;
}
