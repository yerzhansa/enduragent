import { describe, expect, it } from "vitest";
import type { LanguageTag } from "@enduragent/coach-contract";
import { detectMessageLanguage } from "../src/detect-message-language.js";

const MESSAGES: Readonly<Record<LanguageTag, readonly [string, string, string]>> = {
  en: [
    "I finished the long ride yesterday and my legs still feel tired. Should I keep today's training easy or take a recovery day?",
    "Can you help me plan the next week of cycling? I want to improve my climbing without doing too much hard training.",
    "My heart rate was higher than usual during the ride this morning, but the power felt comfortable and I slept well.",
  ],
  es: [
    "Ayer terminé una salida larga en bicicleta y hoy tengo las piernas cansadas. ¿Debo hacer un entrenamiento suave o descansar antes de mañana?",
    "Quiero mejorar en las subidas durante esta semana, pero no sé cómo combinar el entrenamiento intenso con la recuperación después de cada salida.",
    "Mi pulso fue más alto de lo normal durante la salida de hoy, aunque me siento bien y dormí bastante antes del entrenamiento.",
  ],
  fr: [
    "J'ai terminé une longue sortie à vélo hier et mes jambes sont encore fatiguées. Dois je faire un entraînement facile aujourd'hui ou récupérer?",
    "Je voudrais améliorer mes performances dans les montées cette semaine, mais je ne sais pas comment organiser les séances avec assez de récupération.",
    "Mon rythme cardiaque était plus élevé pendant la sortie de ce matin, mais je me sens bien et la puissance est restée stable.",
  ],
  it: [
    "Ieri ho finito una lunga uscita in bicicletta e oggi sento le gambe stanche. Devo fare un allenamento leggero oppure riposare prima di domani?",
    "Vorrei migliorare sulle salite durante questa settimana, ma non so come organizzare gli allenamenti più intensi con abbastanza tempo per il recupero.",
    "La mia frequenza cardiaca era più alta durante questa uscita, ma mi sento bene e ho dormito abbastanza prima di andare in bicicletta.",
  ],
  de: [
    "Ich habe gestern eine lange Fahrt gemacht und meine Beine sind heute noch müde. Soll ich morgen locker trainieren oder einen Ruhetag machen?",
    "Ich möchte diese Woche besser am Berg werden, aber ich weiß nicht wie ich die harten Einheiten mit genug Erholung planen soll.",
    "Mein Puls war heute während der Fahrt höher als sonst, aber meine Leistung blieb gleich und ich habe vor dem Training gut geschlafen.",
  ],
  nl: [
    "Ik heb gisteren een lange rit gemaakt en mijn benen voelen vandaag nog moe. Moet ik morgen rustig fietsen of een dag rust nemen?",
    "Ik wil deze week beter klimmen, maar ik weet niet hoe ik de zware training met genoeg herstel moet combineren voor mijn volgende rit.",
    "Mijn hartslag was vandaag tijdens de rit hoger dan normaal, maar ik voel me goed en heb voor de training genoeg geslapen.",
  ],
  da: [
    "Jeg har kørt en lang tur i går og mine ben er stadig trætte. Skal jeg træne roligt i morgen eller tage en hviledag?",
    "Jeg vil gerne blive bedre på bakkerne denne uge, men jeg ved ikke hvordan jeg skal planlægge hård træning med nok restitution.",
    "Min puls var højere under denne tur end normalt, men jeg føler mig godt tilpas og har sovet godt før min træning i dag.",
  ],
  sv: [
    "Jag cyklade en lång tur igår och mina ben är fortfarande trötta idag. Ska jag träna lugnt imorgon eller ta en dag för återhämtning?",
    "Jag vill gärna bli bättre i backarna denna vecka, men jag vet inte hur jag ska planera hård träning med tillräckligt mycket återhämtning.",
    "Min puls var högre under denna tur än vanligt, men jag känner mig bra och har sovit ordentligt före min träning idag.",
  ],
  nb: [
    "Jeg syklet en lang tur i går og beina mine er fortsatt slitne. Skal jeg trene rolig i morgen eller ta en dag med restitusjon?",
    "Jeg vil gjerne bli bedre i bakkene denne uke, men jeg vet ikke hvordan jeg skal planlegge hard trening med nok tid til restitusjon.",
    "Pulsen min var høyere under denne turen enn vanlig, men jeg føler meg bra og har sovet godt før trening i dag.",
  ],
  fi: [
    "Tein eilen pitkän lenkin pyörällä ja jalat tuntuvat vielä väsyneiltä tänään. Pitäisikö minun harjoitella huomenna kevyesti vai pitää kokonainen päivä lepoa?",
    "Haluan kehittyä ylämäissä tällä viikolla, mutta en tiedä miten minun pitäisi suunnitella kova harjoitus ja palautuminen ennen seuraavaa pitkää lenkkiä viikonloppuna.",
    "Minun sykkeeni oli tänään lenkillä tavallista korkeampi, mutta olo tuntuu hyvältä ja olen nukkunut paljon ennen harjoitusta. Voinko jatkaa suunnitelman mukaan?",
  ],
  "pt-PT": [
    "Ontem fiz uma volta longa de bicicleta e hoje tenho as pernas cansadas. Devo fazer um treino leve ou descansar antes de amanhã?",
    "Quero melhorar nas subidas durante esta semana, mas não sei como organizar os treinos mais intensos com tempo suficiente para a recuperação.",
    "A minha frequência cardíaca foi mais alta durante esta volta, mas sinto que estou bem e dormi bastante antes de sair de bicicleta.",
  ],
  "pt-BR": [
    "Você pode avaliar meu treino de hoje? Fiz uma pedalada longa e estou com as pernas cansadas, mas quero treinar de novo amanhã.",
    "Quero melhorar nas subidas durante esta semana, mas não sei como organizar os treinos. Você pode me ajudar com a recuperação depois das pedaladas?",
    "Minha frequência cardíaca ficou mais alta no treino de hoje, mas estou me sentindo bem e dormi bastante antes de sair para pedalar.",
  ],
  pl: [
    "Wczoraj zrobiłem długą jazdę na rowerze i dzisiaj moje nogi są nadal zmęczone. Czy powinienem jutro zrobić lekki trening czy odpocząć cały dzień?",
    "Chcę lepiej jeździć na podjazdach w tym tygodniu, ale nie wiem jak zaplanować mocny trening oraz odpoczynek przed następną długą jazdą.",
    "Moje tętno było dzisiaj wyższe podczas jazdy niż zwykle, ale czuję się dobrze i spałem długo przed treningiem. Czy mogę jutro trenować?",
  ],
  ko: [
    "어제 자전거로 긴 거리를 달렸는데 오늘도 다리가 많이 피곤합니다. 내일은 가볍게 훈련하는 것이 좋을까요 아니면 하루 쉬는 것이 좋을까요? 다음 주 대회를 준비하고 있습니다.",
    "이번 주에는 오르막 실력을 높이고 싶습니다. 강도 높은 훈련과 회복 시간을 어떻게 배치하면 좋을까요? 주말에는 친구들과 긴 거리를 달릴 계획입니다.",
    "오늘 아침 자전거를 탈 때 평소보다 심박수가 높았습니다. 하지만 몸 상태는 괜찮고 어젯밤에는 충분히 잤습니다. 내일 계획한 훈련을 그대로 진행해도 될까요?",
  ],
  ja: [
    "昨日は長い距離を自転車で走りましたが、今日はまだ脚が疲れています。明日は軽い練習にするべきでしょうか、それとも一日休む方がよいでしょうか。来週末のレースに向けて準備しています。",
    "今週は登り坂での走りを改善したいです。強度の高い練習と回復の時間をどのように組み合わせればよいでしょうか。週末には仲間と長距離を走る予定があります。",
    "今朝のライドでは心拍数が普段より高くなりましたが、出力は安定していて体調もよく、昨夜は十分に眠れました。明日の練習は予定通り行ってもよいでしょうか。",
  ],
  "zh-Hans": [
    "昨天我完成了一次很长的自行车骑行，今天双腿仍然感到疲劳。明天应该轻松训练还是休息一天？我正在为下周末的比赛做准备。",
    "这周我想提高爬坡能力，但是不知道如何安排高强度训练和恢复时间。周末我还计划和朋友一起完成一次长距离骑行，你能帮我调整计划吗？",
    "今天早上骑车时我的心率比平时高，但是功率一直很稳定，身体感觉不错，昨晚也睡得很好。明天可以继续按照原来的训练计划进行吗？",
  ],
  "zh-Hant": [
    "昨天我完成了一次很長的自行車騎行，今天雙腿仍然感到疲勞。明天應該輕鬆訓練還是休息一天？我正在為下週末的比賽做準備。",
    "這週我想提高爬坡能力，但是不知道如何安排高強度訓練和恢復時間。週末我還計畫和朋友一起完成一次長距離騎行，可以幫我調整計畫嗎？",
    "今天早上騎車時我的心率比平時高，但是功率一直很穩定，身體感覺不錯，昨晚也睡得很好。明天可以繼續按照原來的訓練計畫進行嗎？",
  ],
};

describe("detectMessageLanguage", () => {
  for (const [language, messages] of Object.entries(MESSAGES)) {
    it.each(messages)(`detects ${language}: %s`, (message) => {
      expect(detectMessageLanguage(message)).toBe(language);
    });
  }

  it.each([
    "",
    "ok",
    "/review",
    "/review@coach",
    "🚲💪🌧️",
    "123 456 789",
    "FTP 250 W",
    "https://example.com/the-and-with",
    "```ts\nconst message = 'the and of';\n```",
    "~~~\nthe and of\n~~~",
    "bonjour",
    "fiets",
    "the und et",
  ])('abstains for "%s"', (message) => {
    expect(detectMessageLanguage(message)).toBeUndefined();
  });

  it("strips commands, links, code and numbers before detection", () => {
    const message =
      "/review@coach https://example.com/日本語 ```한국어``` 123456 " + MESSAGES.it[0];
    expect(detectMessageLanguage(message)).toBe("it");
  });

  it("strips an unterminated fenced block", () => {
    expect(detectMessageLanguage("```日本語")).toBeUndefined();
  });

  it("inspects at most 512 code points", () => {
    expect(detectMessageLanguage("🚲".repeat(512) + MESSAGES.ko[0])).toBeUndefined();
    expect(detectMessageLanguage("🚲".repeat(511) + "한")).toBe("ko");
  });

  it("defaults Portuguese to Portugal without Brazilian markers", () => {
    expect(
      detectMessageLanguage(
        "Tenho as pernas cansadas e quero fazer uma volta de bicicleta com mais tempo para recuperação depois do treino.",
      ),
    ).toBe("pt-PT");
  });

  it("recognizes decomposed Latin diacritics", () => {
    expect(detectMessageLanguage(MESSAGES.pl[0].normalize("NFD"))).toBe("pl");
  });
});
