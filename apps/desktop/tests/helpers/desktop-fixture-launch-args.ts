export function desktopFixtureWindowHidden(playwrightDebug: string | undefined): boolean {
  return playwrightDebug !== "1";
}

export function desktopFixtureLaunchArgs(
  platform: NodeJS.Platform,
  ci: string | undefined,
): string[] {
  return platform === "linux" && Boolean(ci) ? ["--no-sandbox", "--password-store=basic"] : [];
}
