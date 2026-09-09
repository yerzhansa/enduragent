import { createPhrasebook, type Phrasebook } from "@enduragent/i18n/messages";
import { beforeAll, describe, expect, it } from "vitest";
import { presentTrayTelegramStatus } from "../src/tray-status";

let phrasebook: Phrasebook;
beforeAll(async () => {
  phrasebook = await createPhrasebook({ tag: "en", locale: "en-GB" });
});

describe("tray Telegram status", () => {
  it.each([
    ["disabled", "Telegram is off", "idle"],
    ["waiting-for-credential", "Telegram is off", "idle"],
    ["starting", "Connecting to Telegram", "idle"],
    ["online", "Connected to Telegram", "active"],
    ["offline-retrying", "Telegram is reconnecting", "warning"],
    ["conflict", "Another poller owns the bot", "failed"],
    ["invalid-token", "Telegram token rejected", "failed"],
    ["transfer-required", "Bot transfer required", "failed"],
    ["failed", "Telegram needs attention", "failed"],
  ] as const)("projects %s", (channelState, copy, tone) => {
    expect(
      presentTrayTelegramStatus({ channelState, gapWarning: false }, phrasebook),
    ).toMatchObject({
      copy,
      tone,
    });
  });

  it("gives a possible delivery gap precedence over channel health", () => {
    expect(
      presentTrayTelegramStatus({ channelState: "online", gapWarning: true }, phrasebook),
    ).toEqual({
      copy: "Check for missed messages",
      tag: "warning",
      tone: "warning",
    });
  });

  it("presents transient sleep suspension without calling Telegram off", () => {
    expect(
      presentTrayTelegramStatus({ channelState: "suspended", gapWarning: false }, phrasebook),
    ).toEqual({
      copy: "Telegram is paused while this Mac sleeps",
      tag: "paused",
      tone: "idle",
    });
  });

  it("renders the copy and visible tag through the injected phrasebook", () => {
    expect(
      presentTrayTelegramStatus(
        { channelState: "online", gapWarning: false },
        {
          say: (message) => `localized:${typeof message === "string" ? message : message.key}`,
        },
      ),
    ).toEqual({
      copy: "localized:desktop.tray.telegram.connected",
      tag: "localized:desktop.tray.tag.online",
      tone: "active",
    });
  });
});
