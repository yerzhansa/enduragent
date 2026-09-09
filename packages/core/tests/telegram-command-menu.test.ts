import { createPhrasebook } from "@enduragent/i18n/messages";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { msg, telegramRegistrationCodes } from "@enduragent/i18n";
import type { Api } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerTelegramCommandMenus,
  registerTelegramChatCommandMenu,
} from "../src/channels/telegram-command-menu.js";

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "telegram-command-menu-"));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("Telegram command menu registration", () => {
  it("registers English and every distinct registry code, then skips an unchanged restart", async () => {
    const setMyCommands = vi.fn<Api["setMyCommands"]>(async () => true);
    const input = {
      api: { setMyCommands },
      dataDir,
      token: "123:TEST",
      syncEnabled: true,
      updateDescription: msg("telegram.menu.update"),
    };
    await registerTelegramCommandMenus(input);
    expect(setMyCommands).toHaveBeenCalledTimes(telegramRegistrationCodes().length + 1);
    expect(setMyCommands.mock.calls.map(([, options]) => options?.language_code).sort()).toEqual(
      [undefined, ...telegramRegistrationCodes().map(({ code }) => code)].sort(),
    );
    expect(
      setMyCommands.mock.calls.find(([, options]) => options === undefined)?.[0],
    ).toContainEqual({
      command: "language",
      description: "Choose your language",
    });
    setMyCommands.mockClear();
    await registerTelegramCommandMenus(input);
    expect(setMyCommands).not.toHaveBeenCalled();
    await registerTelegramCommandMenus({ ...input, syncEnabled: false });
    expect(setMyCommands).toHaveBeenCalledTimes(telegramRegistrationCodes().length + 1);
  });
  it("hash-gates a chat preference and removes its override for Automatic", async () => {
    const setMyCommands = vi.fn<Api["setMyCommands"]>(async () => true);
    const deleteMyCommands = vi.fn<Api["deleteMyCommands"]>(async () => true);
    const input = {
      api: { setMyCommands, deleteMyCommands },
      dataDir,
      token: "123:TEST",
      chatId: 77,
      book: await createPhrasebook({ tag: "it", locale: "it-IT" }),
      automatic: false,
      syncEnabled: true,
      updateDescription: msg("telegram.menu.update"),
    };
    await registerTelegramChatCommandMenu(input);
    await registerTelegramChatCommandMenu(input);
    expect(setMyCommands).toHaveBeenCalledOnce();
    expect(setMyCommands).toHaveBeenCalledWith(expect.any(Array), {
      scope: { type: "chat", chat_id: 77 },
    });
    await registerTelegramChatCommandMenu({ ...input, automatic: true });
    await registerTelegramChatCommandMenu({ ...input, automatic: true });
    expect(deleteMyCommands).toHaveBeenCalledExactlyOnceWith({
      scope: { type: "chat", chat_id: 77 },
    });
  });
});
