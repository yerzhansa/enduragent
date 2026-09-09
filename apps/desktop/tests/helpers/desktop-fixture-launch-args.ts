export function desktopFixtureLaunchArgs(
  platform: NodeJS.Platform,
  ci: string | undefined,
): string[] {
  return platform === "linux" && Boolean(ci) ? ["--no-sandbox", "--password-store=basic"] : [];
}
