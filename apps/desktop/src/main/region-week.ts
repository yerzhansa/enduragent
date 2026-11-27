export type RegionFirstDay = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const REGION_FIRST_DAY_ARGUMENT = "--enduragent-first-day=";

function firstDay(value: unknown): RegionFirstDay | null {
  if (value === 1 || value === 2 || value === 3 || value === 4) return value;
  if (value === 5 || value === 6 || value === 7) return value;
  return null;
}

function weekInfoOf(locale: Intl.Locale): unknown {
  const source: object = locale;
  if ("getWeekInfo" in source && typeof source.getWeekInfo === "function") {
    return Reflect.apply(source.getWeekInfo, locale, []);
  }
  return "weekInfo" in source ? source.weekInfo : null;
}

export function regionFirstDayOfWeek(countryCode: string): RegionFirstDay {
  if (!/^[A-Z]{2}$/u.test(countryCode)) return 1;
  try {
    const info = weekInfoOf(new Intl.Locale(`und-${countryCode}`));
    if (info === null || typeof info !== "object" || !("firstDay" in info)) return 1;
    return firstDay(info.firstDay) ?? 1;
  } catch {
    return 1;
  }
}

export function macFirstWeekday(preference: unknown): RegionFirstDay | null {
  if (preference === null || typeof preference !== "object") return null;
  const gregorian: unknown = Reflect.get(preference, "gregorian");
  if (typeof gregorian !== "number" || !Number.isInteger(gregorian)) return null;
  return firstDay(((gregorian + 5) % 7) + 1);
}

export function regionFirstDayArgument(
  countryCode: string,
  chosen: RegionFirstDay | null = null,
): string {
  return `${REGION_FIRST_DAY_ARGUMENT}${chosen ?? regionFirstDayOfWeek(countryCode)}`;
}

export function regionFirstDayFromArguments(argv: readonly string[]): RegionFirstDay {
  const argument = argv.find((value) => value.startsWith(REGION_FIRST_DAY_ARGUMENT));
  return firstDay(Number(argument?.slice(REGION_FIRST_DAY_ARGUMENT.length))) ?? 1;
}
