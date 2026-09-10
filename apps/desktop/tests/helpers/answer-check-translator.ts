import type { IntentTranslationPort } from "@enduragent/engine";
import type { z } from "zod";

type IntentTranslationContext = Parameters<IntentTranslationPort["translateIntent"]>[2];

const prose = {
  title: "Did I read this right?",
  body: "Confirm this answer before I use it in your plan.",
};
const understood = (value: unknown) => ({ ...prose, outcome: "understood", value });
const ask = (title: string, body: string) => ({ outcome: "ask", title, body, value: null });
const examples: Readonly<Record<string, unknown>> = {
  "Wednesday at most 45 minutes": understood([{ kind: "weekday-duration", day: 3, minutes: 45 }]),
  "Wednesdays at most 30 minutes": understood([{ kind: "weekday-duration", day: 3, minutes: 30 }]),
  "Saturday unavailable": understood([{ kind: "weekday-unavailable", day: 6 }]),
  "Fridays off": understood([{ kind: "weekday-unavailable", day: 5 }]),
  "I may be away some days next month.": ask(
    "Which dates will you be away?",
    "You said you may be away some days next month. Give me the dates, even roughly, and I will keep those days free. If you do not know yet, skip this and add days off later.",
  ),
  "Wednesdays short": ask(
    "How short should Wednesdays be?",
    "I read that as a shorter ride on Wednesdays. Tell me the most minutes you can spare, for example 30 minutes, and I will hold Wednesdays to that.",
  ),
  wtf: ask(
    "What would make this Plan a success for you?",
    'One sentence is enough, for example "finish the ride feeling strong" or "hold 200 W for the climbs". Or use the usual measure for an event goal: finish comfortably.',
  ),
  ignore: {
    outcome: "skip",
    title: "Use the usual answer?",
    body: "You can use the usual answer and change it later.",
    value: null,
  },
};
const successes = new Set(["Ride four steady hours", "Finish the final climb steadily"]);
const events: Readonly<Record<string, string>> = {
  "Highland Classic": "1998-06-20",
  "Autumn ride": "1998-11-08",
  "Autumn Hills Ride": "1998-10-04",
};

export class ScriptedAnswerChecker implements IntentTranslationPort {
  readonly calls: { text: string; context: IntentTranslationContext }[] = [];
  readonly results = new Map<string, unknown>();
  failures = 0;
  private gate: Promise<void> | null = null;

  constructor(private readonly today: () => string) {}

  pause(): () => void {
    let release = () => {};
    this.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      this.gate = null;
      release();
    };
  }

  async translateIntent<T>(
    text: string,
    schema: z.ZodType<T>,
    context: IntentTranslationContext,
  ): Promise<T | null> {
    this.calls.push({ text, context });
    if (this.gate !== null) await this.gate;
    if (this.failures > 0) {
      this.failures -= 1;
      return null;
    }
    let result = this.results.get(text) ?? examples[text];
    if (result === undefined && context.field === "success" && successes.has(text))
      result = understood(text);
    if (context.field === "event") {
      const date =
        text === "Local cycling event"
          ? new Date(Date.parse(`${this.today()}T00:00:00.000Z`) + 6 * 86_400_000)
              .toISOString()
              .slice(0, 10)
          : events[text];
      if (date !== undefined) result = understood({ name: text, date });
    }
    if (text === "ignore" && context.field === "commitments")
      result = {
        outcome: "skip",
        title: "Treat this as no fixed commitments?",
        body: 'You wrote "ignore". I take that to mean nothing is fixed this month. I will plan every available day, and you can add days off at any time.',
        value: null,
      };
    if (context.field === "change") {
      if (text === "wednesdays at most 30 minutes")
        result = understood({ kind: "weekday-duration", day: 3, minutes: 30 });
      if (text === "my ftp is 220") result = understood({ kind: "ftp", watts: 220 });
      if (text === "WHAT SHOULD I RIDE TODAY?!")
        result = understood({ kind: "choose-workout", workoutId: "candidate-1" });
      if (text === "wednesdays at most 30 minutes and my ftp is 220")
        result = ask("Which change should we make first?", "Ask for one change at a time.");
    }
    result ??= ask(
      "I could not use that answer",
      "Tell me again in a different way, with weekdays, time limits, or exact dates.",
    );
    const parsed = schema.safeParse(result);
    return parsed.success ? parsed.data : null;
  }
}
