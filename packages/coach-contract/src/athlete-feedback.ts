export const ATHLETE_FEEDBACK_ENDPOINT = "https://feedback.enduragent.icu/v1/feedback" as const;
export const ATHLETE_FEEDBACK_MAX_TEXT_CHARS = 4000;
export const ATHLETE_FEEDBACK_TIMEOUT_MS = 10_000;
export const ATHLETE_FEEDBACK_MAX_ATTEMPTS = 2;

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FEEDBACK_SLASH = /^\/feedback(?:@[\w]+)?(?:\s+([\s\S]*))?$/iu;
const ALLOWED_CHANNELS = new Set(["desktop", "ios", "telegram"]);

export type AthleteFeedbackChannel = "desktop" | "ios" | "telegram";

export type ParsedFeedbackCommand =
  | { readonly kind: "other" }
  | { readonly kind: "usage" }
  | { readonly kind: "too-long" }
  | { readonly kind: "invalid" }
  | { readonly kind: "ready"; readonly text: string };

export type SubmitFeedbackResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "invalid" | "rejected" | "unavailable" };

export interface FeedbackRequestInit {
  readonly method: "POST";
  readonly headers: { readonly "content-type": "application/json" };
  readonly body: string;
  readonly credentials: "omit";
  readonly redirect: "error";
  readonly cache: "no-store";
  readonly signal: AbortSignal;
}

export interface SubmitFeedbackInput {
  readonly channel: AthleteFeedbackChannel;
  readonly id: string;
  readonly text: string;
  readonly request?: (url: string, init: FeedbackRequestInit) => Promise<{ readonly status: number }>;
}

export function prepareFeedbackText(raw: string): Exclude<ParsedFeedbackCommand, { kind: "other" }> {
  const text = raw.trim();
  if (text.length === 0) return { kind: "usage" };
  if (text.includes("\u0000")) return { kind: "invalid" };
  if (text.length > ATHLETE_FEEDBACK_MAX_TEXT_CHARS) return { kind: "too-long" };
  return { kind: "ready", text };
}

export function parseFeedbackCommand(message: string): ParsedFeedbackCommand {
  const match = FEEDBACK_SLASH.exec(message.trim());
  if (match === null) return { kind: "other" };
  return prepareFeedbackText(match[1] ?? "");
}

function validSubmission(input: SubmitFeedbackInput): { channel: AthleteFeedbackChannel; id: string; text: string } | null {
  if (!ALLOWED_CHANNELS.has(input.channel)) return null;
  if (typeof input.id !== "string" || !UUID_V4_PATTERN.test(input.id)) return null;
  const prepared = prepareFeedbackText(input.text);
  if (prepared.kind !== "ready") return null;
  return { channel: input.channel, id: input.id, text: prepared.text };
}

async function postOnce(
  request: NonNullable<SubmitFeedbackInput["request"]>,
  payload: { channel: AthleteFeedbackChannel; id: string; text: string },
): Promise<SubmitFeedbackResult> {
  const controller = new AbortController();
  const deadline = globalThis.setTimeout(() => controller.abort(), ATHLETE_FEEDBACK_TIMEOUT_MS);
  try {
    const response = await request(ATHLETE_FEEDBACK_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channel: payload.channel,
        id: payload.id,
        text: payload.text,
      }),
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
    });
    if (response.status === 204) return { ok: true };
    if (response.status === 503) return { ok: false, reason: "unavailable" };
    return { ok: false, reason: "rejected" };
  } catch {
    return { ok: false, reason: "unavailable" };
  } finally {
    globalThis.clearTimeout(deadline);
  }
}

export async function submitFeedback(input: SubmitFeedbackInput): Promise<SubmitFeedbackResult> {
  const payload = validSubmission(input);
  if (payload === null) return { ok: false, reason: "invalid" };
  const request =
    input.request ??
    (async (url, init) => {
      const response = await globalThis.fetch(url, init);
      return { status: response.status };
    });
  let last: SubmitFeedbackResult = { ok: false, reason: "unavailable" };
  for (let attempt = 0; attempt < ATHLETE_FEEDBACK_MAX_ATTEMPTS; attempt += 1) {
    last = await postOnce(request, payload);
    if (last.ok || last.reason !== "unavailable") return last;
  }
  return last;
}
