export const INTERVALS_ATHLETE_NAME_MAX_LENGTH = 200;

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
  });
}

export function displayableAthleteName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  return name === "" || name.length > INTERVALS_ATHLETE_NAME_MAX_LENGTH || hasControlCharacter(name)
    ? undefined
    : name;
}
