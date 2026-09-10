import type { Phrasebook } from "@enduragent/i18n/messages";

export interface TrayTelegramStatus {
  readonly channelState:
    | "disabled"
    | "waiting-for-credential"
    | "starting"
    | "suspended"
    | "online"
    | "offline-retrying"
    | "conflict"
    | "invalid-token"
    | "transfer-required"
    | "failed";
  readonly gapWarning: boolean;
}

export interface TrayTelegramPresentation {
  readonly copy: string;
  readonly tag: string;
  readonly tone: "active" | "idle" | "warning" | "failed";
}

export function presentTrayTelegramStatus(
  status: TrayTelegramStatus,
  phrasebook: Pick<Phrasebook, "say">,
): TrayTelegramPresentation {
  if (status.gapWarning) {
    return {
      copy: phrasebook.say("desktop.tray.telegram.missedMessages"),
      tag: phrasebook.say("desktop.tray.tag.warning"),
      tone: "warning",
    };
  }
  if (status.channelState === "online") {
    return {
      copy: phrasebook.say("desktop.tray.telegram.connected"),
      tag: phrasebook.say("desktop.tray.tag.online"),
      tone: "active",
    };
  }
  if (status.channelState === "starting") {
    return {
      copy: phrasebook.say("desktop.tray.telegram.connecting"),
      tag: phrasebook.say("desktop.tray.tag.starting"),
      tone: "idle",
    };
  }
  if (status.channelState === "suspended") {
    return {
      copy: phrasebook.say("desktop.tray.telegram.suspended"),
      tag: phrasebook.say("desktop.tray.tag.paused"),
      tone: "idle",
    };
  }
  if (status.channelState === "offline-retrying") {
    return {
      copy: phrasebook.say("desktop.tray.telegram.reconnecting"),
      tag: phrasebook.say("desktop.tray.tag.retrying"),
      tone: "warning",
    };
  }
  if (status.channelState === "conflict") {
    return {
      copy: phrasebook.say("desktop.tray.telegram.conflict"),
      tag: phrasebook.say("desktop.tray.tag.conflict"),
      tone: "failed",
    };
  }
  if (status.channelState === "invalid-token") {
    return {
      copy: phrasebook.say("desktop.tray.telegram.tokenRejected"),
      tag: phrasebook.say("desktop.tray.tag.attention"),
      tone: "failed",
    };
  }
  if (status.channelState === "transfer-required") {
    return {
      copy: phrasebook.say("desktop.tray.telegram.transferRequired"),
      tag: phrasebook.say("desktop.tray.tag.attention"),
      tone: "failed",
    };
  }
  if (status.channelState === "failed") {
    return {
      copy: phrasebook.say("desktop.tray.telegram.needsAttention"),
      tag: phrasebook.say("desktop.tray.tag.attention"),
      tone: "failed",
    };
  }
  return {
    copy: phrasebook.say("desktop.tray.telegram.off"),
    tag: phrasebook.say("desktop.tray.tag.off"),
    tone: "idle",
  };
}
