import { msg, type Message } from "@enduragent/i18n";

export interface SlashCommand {
  readonly command: string;
  readonly description: Message;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = Object.freeze([
  Object.freeze({ command: "/start", description: msg("chat.commands.start") }),
  Object.freeze({ command: "/plan", description: msg("chat.commands.plan") }),
  Object.freeze({ command: "/workout", description: msg("chat.commands.workout") }),
  Object.freeze({ command: "/status", description: msg("chat.commands.status") }),
  Object.freeze({ command: "/review", description: msg("chat.commands.review") }),
  Object.freeze({ command: "/feedback", description: msg("chat.commands.feedback") }),
  Object.freeze({
    command: "/sync",
    description: msg("chat.commands.sync", { intervals: "intervals.icu" }),
  }),
  Object.freeze({ command: "/version", description: msg("chat.commands.version") }),
  Object.freeze({
    command: "/whatsnew",
    description: msg("chat.commands.whatsnew"),
  }),
  Object.freeze({ command: "/update", description: msg("chat.commands.update") }),
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
