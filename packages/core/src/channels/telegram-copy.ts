import { msg, type Message } from "@enduragent/i18n";

export function telegramReleaseMessage(value: string | Message): string | Message {
  if (typeof value !== "string") return value;
  switch (value) {
    case "Check for updates in the Desktop app":
      return msg("telegram.release.desktopUpdateDescription");
    case "Open the Desktop app to see release notes.":
      return msg("telegram.release.desktopReleaseNotes");
    case "Updates are installed from the Desktop app.":
      return msg("telegram.release.desktopUpdateNotice");
    default:
      return value;
  }
}
