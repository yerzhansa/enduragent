import { Api, type ApiClientOptions } from "grammy";
import { telegramApiClientOptions } from "./telegram-transport.js";

export type TelegramCredentialInspectionResult =
  | { readonly status: "ready"; readonly bot: { readonly id: number; readonly username: string } }
  | {
      readonly status: "webhook-removal-required";
      readonly bot: { readonly id: number; readonly username: string };
    }
  | { readonly status: "invalid-token" }
  | { readonly status: "unavailable"; readonly errorCode: "telegram-validation-failed" };

export interface TelegramSetupApi {
  getMe(): Promise<unknown>;
  getWebhookInfo(): Promise<unknown>;
  deleteWebhook(options: { readonly drop_pending_updates: false }): Promise<unknown>;
}

export interface TelegramSetupDependencies {
  readonly createApi: (token: string) => TelegramSetupApi;
}

let setupClientOptions: ApiClientOptions | undefined;

const DEFAULT_DEPENDENCIES: TelegramSetupDependencies = {
  createApi: (token) =>
    new Api(token, (setupClientOptions ??= telegramApiClientOptions(process.env))),
};

const INVALID_TOKEN = Object.freeze({ status: "invalid-token" } as const);
const UNAVAILABLE = Object.freeze({
  status: "unavailable",
  errorCode: "telegram-validation-failed",
} as const);
const BOT_USERNAME = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(error: unknown): TelegramCredentialInspectionResult {
  return isRecord(error) && error.error_code === 401 ? INVALID_TOKEN : UNAVAILABLE;
}

async function inspectWithApi(api: TelegramSetupApi): Promise<TelegramCredentialInspectionResult> {
  let me: unknown;
  try {
    me = await api.getMe();
  } catch (error) {
    return failure(error);
  }
  if (
    !isRecord(me) ||
    me.is_bot !== true ||
    !Number.isSafeInteger(me.id) ||
    (me.id as number) < 10 ||
    typeof me.username !== "string" ||
    !BOT_USERNAME.test(me.username)
  ) {
    return INVALID_TOKEN;
  }

  let webhook: unknown;
  try {
    webhook = await api.getWebhookInfo();
  } catch (error) {
    return failure(error);
  }
  if (!isRecord(webhook) || typeof webhook.url !== "string") return UNAVAILABLE;

  const bot = { id: me.id as number, username: me.username };
  return webhook.url === ""
    ? { status: "ready", bot }
    : { status: "webhook-removal-required", bot };
}

export async function inspectTelegramCredential(
  token: string,
  dependencies: TelegramSetupDependencies = DEFAULT_DEPENDENCIES,
): Promise<TelegramCredentialInspectionResult> {
  let api: TelegramSetupApi;
  try {
    api = dependencies.createApi(token);
  } catch (error) {
    return failure(error);
  }
  return inspectWithApi(api);
}

export async function deleteTelegramWebhook(
  token: string,
  dependencies: TelegramSetupDependencies = DEFAULT_DEPENDENCIES,
): Promise<TelegramCredentialInspectionResult> {
  let api: TelegramSetupApi;
  try {
    api = dependencies.createApi(token);
    await api.deleteWebhook({ drop_pending_updates: false });
  } catch (error) {
    return failure(error);
  }
  return inspectWithApi(api);
}
