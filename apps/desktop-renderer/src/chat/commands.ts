export interface SlashCommand {
  readonly command: string;
  readonly description: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = Object.freeze([
  Object.freeze({ command: "/start", description: "Start a fresh session" }),
  Object.freeze({ command: "/plan", description: "Start a Plan in Chat" }),
  Object.freeze({ command: "/workout", description: "Get today's workout" }),
  Object.freeze({ command: "/status", description: "Check current fitness, fatigue, and form" }),
  Object.freeze({ command: "/review", description: "Review your last session" }),
  Object.freeze({
    command: "/sync",
    description: "Force-refresh training data from intervals.icu",
  }),
  Object.freeze({ command: "/version", description: "Show current version" }),
  Object.freeze({
    command: "/whatsnew",
    description: "See what changed in the latest version",
  }),
  Object.freeze({ command: "/update", description: "Check for and install updates" }),
]);

export function filterSlashCommands(draft: string): readonly SlashCommand[] {
  if (!draft.startsWith("/") || /\s/u.test(draft)) return [];
  const needle = draft.toLowerCase();
  return SLASH_COMMANDS.filter((entry) => entry.command.startsWith(needle));
}

export function isSlashCommandText(text: string): boolean {
  const head = text.trim().split(/\s/u, 1)[0] ?? "";
  return SLASH_COMMANDS.some((entry) => entry.command === head.toLowerCase());
}
