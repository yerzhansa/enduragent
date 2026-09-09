import type { CoachLanguage, Message } from "@enduragent/i18n";
import type { Phrasebook } from "@enduragent/i18n/messages";
import type { ChatRequest } from "@enduragent/coach-contract";
import type { Context, MiddlewareFn } from "grammy";
import type { ConfirmOutcome } from "../agent/confirmation-gate.js";
import type { SnapshotOutput } from "../reference/sync/snapshot-debug.js";

export interface TelegramConfirmationCapabilities {
  peek(request: {
    readonly chatId: string;
    readonly phrasebook?: Phrasebook;
  }): Promise<{ readonly nonce: string; readonly summary: string } | undefined>;
  confirm(request: {
    readonly chatId: string;
    readonly nonce: string;
    readonly phrasebook?: Phrasebook;
  }): Promise<ConfirmOutcome>;
  cancel(request: {
    readonly chatId: string;
    readonly nonce: string;
  }): Promise<"canceled" | "mismatch" | "none">;
}

export interface TelegramOperationsCapabilities {
  resolveTurnContext(): Promise<ChatRequest["turn"] | undefined>;
  sync(request: {
    readonly chatId: string;
    readonly phrasebook?: Phrasebook;
  }): Promise<{ readonly text: string }>;
}

export interface TelegramInvocationReservation {
  run<T>(operation: () => Promise<T>): Promise<T>;
  cancel(): void;
}

export interface TelegramInvocationCapabilities {
  reserve(chatId: string): TelegramInvocationReservation;
}

export interface TelegramDiagnosticsCapabilities {
  rawSnapshot(request: {
    readonly section?: string;
    readonly phrasebook?: Phrasebook;
  }): Promise<SnapshotOutput>;
}

export interface TelegramAuthorizationCapabilities {
  isPrimaryOperator(request: { readonly senderId: string }): Promise<boolean>;
}

export interface TelegramAccessCapabilities {
  readonly middleware: MiddlewareFn<Context>;
}

export interface TelegramReleaseBase {
  readonly updateDescription: string | Message;
  readonly whatsNewUnavailableText: string | Message;
  version(): Promise<string>;
  whatsNew(
    phrasebook?: Phrasebook,
  ): Promise<
    { readonly kind: "available"; readonly text: string } | { readonly kind: "unavailable" }
  >;
}

export type TelegramReleaseCapabilities =
  | (TelegramReleaseBase & {
      readonly updatePolicy: "npm-self-update";
      readonly binaryName: string;
      check(): Promise<{
        readonly current: string;
        readonly latest: string;
        readonly updateAvailable: boolean;
      } | null>;
      install(version: string): Promise<void>;
    })
  | (TelegramReleaseBase & {
      readonly updatePolicy: "managed-deploy" | "desktop-owned";
      updateNotice(): Promise<string | Message>;
    });

export interface TelegramHostCapabilities {
  readonly language: CoachLanguage;
  readonly access: TelegramAccessCapabilities;
  readonly confirmations: TelegramConfirmationCapabilities;
  readonly invocations?: TelegramInvocationCapabilities;
  readonly operations?: TelegramOperationsCapabilities;
  readonly diagnostics?: TelegramDiagnosticsCapabilities;
  readonly authorization: TelegramAuthorizationCapabilities;
  readonly release: TelegramReleaseCapabilities;
}
