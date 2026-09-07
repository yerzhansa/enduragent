export const DESKTOP_SCHEME = "enduragent" as const;
export const DESKTOP_APP_USER_MODEL_ID = "icu.enduragent.desktop" as const;
export const DESKTOP_HOST = "app" as const;
export const DESKTOP_RENDERER_ORIGIN = "enduragent://app" as const;
export const DESKTOP_RENDERER_URL = "enduragent://app/index.html" as const;
export const DESKTOP_CONNECTION_CHANNEL = "desktop:get-daemon-connection" as const;
export const DESKTOP_DOCUMENT_REGISTRATION_CHANNEL =
  "desktop:register-document-navigation" as const;
export const DESKTOP_INITIAL_SETUP_STATUS_SETTLED_CHANNEL =
  "desktop:initial-setup-status-settled" as const;
export const DESKTOP_TRANSCRIPT_PAGE_CHANNEL = "desktop:get-transcript-page" as const;
export const DESKTOP_ARCHIVED_CONVERSATIONS_CHANNEL =
  "desktop:list-archived-conversations" as const;
export const DESKTOP_DELETE_ARCHIVED_CONVERSATION_CHANNEL =
  "desktop:delete-archived-conversation" as const;
export const DESKTOP_ARCHIVED_TRANSCRIPT_PAGE_CHANNEL =
  "desktop:get-archived-transcript-page" as const;
export const DESKTOP_PLANNING_READ_CHANNEL = "desktop:planning:read" as const;
export const DESKTOP_PLAN_STATE_CHANNEL = "desktop:plan:get-state" as const;
export const DESKTOP_PLAN_TRANSITION_CHANNEL = "desktop:plan:execute-transition" as const;
export const DESKTOP_PLAN_PROGRESS_CHANNEL = "desktop:plan:progress" as const;
export const DESKTOP_PLAN_COURSE_FILE_CHANNEL = "desktop:plan:choose-course-file" as const;
export const DESKTOP_TRAINING_EXPORT_CHANNEL = "desktop:training:export" as const;
export const DESKTOP_CHAT_ATTACHMENT_PICK_CHANNEL = "desktop:chat-attachment:pick" as const;
export const DESKTOP_CHAT_ATTACHMENT_DROP_CHANNEL = "desktop:chat-attachment:drop" as const;
export const DESKTOP_CHAT_ATTACHMENT_PASTE_CHANNEL = "desktop:chat-attachment:paste" as const;
export const DESKTOP_UPDATE_GET_CHANNEL = "desktop:update:get" as const;
export const DESKTOP_UPDATE_CHECK_CHANNEL = "desktop:update:check" as const;
export const DESKTOP_UPDATE_RESTART_CHANNEL = "desktop:update:restart" as const;
export const DESKTOP_UPDATE_STATE_CHANNEL = "desktop:update:state" as const;
export const DESKTOP_INTERVALS_PASTE_CREDENTIAL_CHANNEL =
  "desktop:intervals:paste-credential" as const;
export const DESKTOP_TELEGRAM_STATUS_CHANNEL = "desktop:telegram:status" as const;
export const DESKTOP_TELEGRAM_PASTE_CREDENTIAL_CHANNEL =
  "desktop:telegram:paste-credential" as const;
export const DESKTOP_TELEGRAM_ENABLE_CHANNEL = "desktop:telegram:enable" as const;
export const DESKTOP_TELEGRAM_DISABLE_CHANNEL = "desktop:telegram:disable" as const;
export const DESKTOP_TELEGRAM_REMOVE_CHANNEL = "desktop:telegram:remove" as const;
export const DESKTOP_TELEGRAM_RECONCILE_CHANNEL = "desktop:telegram:reconcile" as const;
export const DESKTOP_TELEGRAM_REMOVE_WEBHOOK_CHANNEL = "desktop:telegram:remove-webhook" as const;
export const DESKTOP_TELEGRAM_BEGIN_PAIRING_CHANNEL = "desktop:telegram:pairing:begin" as const;
export const DESKTOP_TELEGRAM_CANCEL_PAIRING_CHANNEL = "desktop:telegram:pairing:cancel" as const;
export const DESKTOP_TELEGRAM_LIST_ALLOWED_SENDERS_CHANNEL =
  "desktop:telegram:allowed-senders:list" as const;
export const DESKTOP_TELEGRAM_ADD_ALLOWED_SENDER_CHANNEL =
  "desktop:telegram:allowed-senders:add" as const;
export const DESKTOP_TELEGRAM_REMOVE_ALLOWED_SENDER_CHANNEL =
  "desktop:telegram:allowed-senders:remove" as const;
export const DESKTOP_TELEGRAM_ACKNOWLEDGE_GAP_WARNING_CHANNEL =
  "desktop:telegram:gap-warning:acknowledge" as const;
export const DESKTOP_TRAY_TELEGRAM_STATUS_CHANNEL = "desktop:tray:telegram-status" as const;
export const DESKTOP_LIFECYCLE_CHANNEL = "desktop:daemon-lifecycle" as const;
export const DESKTOP_OPEN_EXTERNAL_CHANNEL = "desktop:open-external" as const;
export const DESKTOP_OPEN_SETTINGS_CHANNEL = "enduragent:open-settings" as const;
export const DESKTOP_APPEARANCE_CHANNEL = "desktop:set-appearance" as const;
export const DESKTOP_WINDOW_LIGHT_BACKGROUND = "#f4f6f5" as const;
export const DESKTOP_WINDOW_DARK_BACKGROUND = "#0f1520" as const;
export const DESKTOP_WINDOW_WIDTH = 1_180 as const;
export const DESKTOP_WINDOW_HEIGHT = 820 as const;
export const DESKTOP_WINDOW_MIN_WIDTH = 760 as const;
export const DESKTOP_WINDOW_MIN_HEIGHT = 600 as const;
export const UTILITY_EXIT_TIMEOUT_MS = 5_000 as const;
export const UTILITY_FORCE_EXIT_TIMEOUT_MS = 2_000 as const;
export const UTILITY_SPAWN_TIMEOUT_MS = 5_000 as const;
export const UTILITY_TERMINAL_ACK_TIMEOUT_MS = 1_000 as const;

export function createDesktopContentSecurityPolicy(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("invalid daemon port");
  }
  return `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src ws://127.0.0.1:${port}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`;
}

export function createDesktopDevelopmentContentSecurityPolicy(
  port: number,
  developmentUrl: string,
): string {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("invalid daemon port");
  }
  const parsed = new URL(developmentUrl);
  if (parsed.protocol !== "http:") throw new TypeError("invalid development url");
  const devPort = parsed.port === "" ? "80" : parsed.port;
  const devSources = `ws://127.0.0.1:${devPort} ws://localhost:${devPort} http://127.0.0.1:${devPort} http://localhost:${devPort}`;
  return `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src ws://127.0.0.1:${port} ${devSources}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`;
}
