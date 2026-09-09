export type CommitmentRule =
  | { kind: "weekday-duration"; day: number; minutes: number }
  | { kind: "weekday-unavailable"; day: number }
  | { kind: "hard-weekday"; day: number }
  | { kind: "time-off"; start: string; end: string };

export interface CommitmentsInterpretation {
  rules: CommitmentRule[];
  unparsed: string[];
  status: "confirm" | "clarify";
}

const weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const weekdayPattern = `(${weekdays.flatMap((day) => [day, day.slice(0, 3)]).join("|")})s?`;
const durationPattern = new RegExp(
  `^${weekdayPattern}\\s+(?:(?:at most|maximum|max|up to)\\s+)?(\\d+(?:\\.\\d+)?)\\s+(min|minutes|h|hours)$`,
  "iu",
);
const unavailablePattern = new RegExp(
  `^${weekdayPattern}\\s+(?:off|free|unavailable|no training|no ride|rest)$`,
  "iu",
);
const noTrainingPattern = new RegExp(`^no (?:training|riding) on ${weekdayPattern}$`, "iu");
const noHardPattern = new RegExp(`^(?:no hard|easy only|nothing hard) on ${weekdayPattern}$`, "iu");
const easyOnlyPattern = new RegExp(`^${weekdayPattern} easy only$`, "iu");
const datePattern = "(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2} [a-z]+ \\d{4})";
const timeOffPattern = new RegExp(
  `^(?:time off|away|holiday|vacation|off) (${datePattern})\\s*(?:to|until|-)\\s*(${datePattern})$`,
  "iu",
);
const months = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

function civilDate(text: string): string | null {
  let date = text;
  const named = /^(\d{1,2}) ([a-z]+) (\d{4})$/iu.exec(text);
  if (named) {
    const [, day, name, year] = named;
    if (!day || !name || !year) return null;
    const month =
      months.findIndex(
        (value) => value === name.toLowerCase() || value.slice(0, 3) === name.toLowerCase(),
      ) + 1;
    if (!month) return null;
    date = `${year}-${String(month).padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  const [year, month, day] = date.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return null;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date
    ? date
    : null;
}

function dayNumber(text: string): number {
  return (
    weekdays.findIndex(
      (day) => day === text.toLowerCase() || day.slice(0, 3) === text.toLowerCase(),
    ) + 1
  );
}

function interpretFragment(text: string): CommitmentRule | null {
  const duration = durationPattern.exec(text);
  if (duration) {
    const [, day, amount, unit] = duration;
    if (!day || !amount || !unit) return null;
    const minutes = Number(amount) * (/^(?:h|hours)$/iu.test(unit) ? 60 : 1);
    return minutes > 0 && minutes <= 1440
      ? { kind: "weekday-duration", day: dayNumber(day), minutes }
      : null;
  }
  const unavailable = unavailablePattern.exec(text) ?? noTrainingPattern.exec(text);
  if (unavailable?.[1]) return { kind: "weekday-unavailable", day: dayNumber(unavailable[1]) };
  const noHard = noHardPattern.exec(text) ?? easyOnlyPattern.exec(text);
  if (noHard?.[1]) return { kind: "hard-weekday", day: dayNumber(noHard[1]) };
  const timeOff = timeOffPattern.exec(text);
  if (!timeOff?.[1] || !timeOff[2]) return null;
  const start = civilDate(timeOff[1]);
  const end = civilDate(timeOff[2]);
  return start && end && start <= end ? { kind: "time-off", start, end } : null;
}

function mergeRule(rules: CommitmentRule[], rule: CommitmentRule): void {
  if (rule.kind === "time-off") {
    let merged = rule;
    let insertAt = rules.length;
    for (let index = 0; index < rules.length;) {
      const existing = rules[index];
      if (
        existing?.kind === "time-off" &&
        existing.start <= merged.end &&
        existing.end >= merged.start
      ) {
        merged = {
          kind: "time-off",
          start: existing.start < merged.start ? existing.start : merged.start,
          end: existing.end > merged.end ? existing.end : merged.end,
        };
        insertAt = Math.min(insertAt, index);
        rules.splice(index, 1);
        index = 0;
      } else index += 1;
    }
    rules.splice(insertAt, 0, merged);
    return;
  }
  const existing = rules.find(
    (candidate) => candidate.kind === rule.kind && candidate.day === rule.day,
  );
  if (existing?.kind === "weekday-duration" && rule.kind === "weekday-duration") {
    existing.minutes = Math.min(existing.minutes, rule.minutes);
  } else if (existing === undefined) rules.push(rule);
}

export function interpretCommitments(text: string): CommitmentsInterpretation {
  const rules: CommitmentRule[] = [];
  const unparsed: string[] = [];
  const fragments = text
    .split(/\r?\n|[.!?](?=\s|$)/u)
    .map((fragment) => fragment.trim())
    .filter(Boolean);
  for (const fragment of fragments) {
    const rule = interpretFragment(fragment.replace(/\s+/gu, " "));
    if (rule) mergeRule(rules, rule);
    else unparsed.push(fragment);
  }
  return {
    rules,
    unparsed,
    status: rules.length > 0 && unparsed.length === 0 ? "confirm" : "clarify",
  };
}
