import type { Api } from "grammy";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describeLanguage, msg, telegramRegistrationCodes, type Message } from "@enduragent/i18n";
import { createPhrasebook, type Phrasebook } from "@enduragent/i18n/messages";

export function commandMenuFor(
  book: Phrasebook,
  syncEnabled: boolean,
  updateDescription: string | Message,
): { command: string; description: string }[] {
  const menu = [
    { command: "start", description: book.say(msg("telegram.menu.start")) },
    { command: "plan", description: book.say(msg("telegram.menu.plan")) },
    { command: "workout", description: book.say(msg("telegram.menu.workout")) },
    { command: "status", description: book.say(msg("telegram.menu.status")) },
    { command: "review", description: book.say(msg("telegram.menu.review")) },
    { command: "language", description: book.say(msg("telegram.language.choose")) },
  ];
  if (syncEnabled)
    menu.push({
      command: "sync",
      description: book.say(msg("telegram.menu.sync", { service: "intervals.icu" })),
    });
  menu.push(
    { command: "version", description: book.say(msg("telegram.menu.version")) },
    { command: "whatsnew", description: book.say(msg("telegram.menu.whatsnew")) },
    {
      command: "update",
      description:
        typeof updateDescription === "string" ? updateDescription : book.say(updateDescription),
    },
  );
  return menu;
}

export async function registerTelegramCommandMenus(input: {
  readonly api: Pick<Api, "setMyCommands">;
  readonly dataDir: string;
  readonly token: string;
  readonly syncEnabled: boolean;
  readonly updateDescription: string | Message;
}): Promise<void> {
  const tokenHash = createHash("sha256").update(input.token).digest("hex");
  const directory = join(input.dataDir, "telegram-command-menus", tokenHash);
  await mkdir(directory, { recursive: true });
  const registrations = [
    { code: "" as const, representative: "en" as const },
    ...telegramRegistrationCodes(),
  ];
  await Promise.all(
    registrations.map(async ({ code, representative }) => {
      const book = await createPhrasebook({
        tag: representative,
        locale: describeLanguage(representative).defaultLocale,
      });
      const commands = commandMenuFor(book, input.syncEnabled, input.updateDescription);
      const hash = createHash("sha256").update(JSON.stringify(commands)).digest("hex");
      const path = join(directory, `${code || "default"}.sha256`);
      const previous = await readFile(path, "utf8").catch(() => undefined);
      if (previous === hash) return;
      await input.api.setMyCommands(commands, code === "" ? undefined : { language_code: code });
      await writeFile(path, hash, { mode: 0o600 });
    }),
  );
}

export async function registerTelegramChatCommandMenu(input: {
  readonly api: Pick<Api, "setMyCommands" | "deleteMyCommands">;
  readonly dataDir: string;
  readonly token: string;
  readonly chatId: number;
  readonly book: Phrasebook;
  readonly automatic: boolean;
  readonly syncEnabled: boolean;
  readonly updateDescription: string | Message;
}): Promise<void> {
  const tokenHash = createHash("sha256").update(input.token).digest("hex");
  const directory = join(input.dataDir, "telegram-command-menus", tokenHash);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `chat-${input.chatId}.sha256`);
  const previous = await readFile(path, "utf8").catch(() => undefined);
  const scope = { type: "chat" as const, chat_id: input.chatId };
  if (input.automatic) {
    if (previous === undefined || previous === "automatic") return;
    await input.api.deleteMyCommands({ scope });
    await writeFile(path, "automatic", { mode: 0o600 });
    return;
  }
  const commands = commandMenuFor(input.book, input.syncEnabled, input.updateDescription);
  const hash = createHash("sha256").update(JSON.stringify(commands)).digest("hex");
  if (hash === previous) return;
  await input.api.setMyCommands(commands, { scope });
  await writeFile(path, hash, { mode: 0o600 });
}
