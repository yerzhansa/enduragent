import { msg, type Message } from "@enduragent/i18n";
import type { Phrasebook } from "@enduragent/i18n/messages";
import type { ApiError } from "intervals-icu-api";
import { readRefreshFailureReason } from "../auth/refresh-failure.js";
import { classifyFailure, extractRetryAfterMs, isRateLimitError } from "./token-utils.js";

export type AgentErrorKind =
  | "rate_limit"
  | "provider-auth"
  | "provider-down"
  | "intervals"
  | "unknown";

const PROVIDER_DOWN_MESSAGE = msg("coach.error.providerDown");
const INTERVALS_TRANSIENT_MESSAGE = msg("coach.error.intervalsTransient", {
  service: "intervals.icu",
});
const INTERVALS_CREDENTIALS_MESSAGE = msg("coach.error.intervalsCredentials", {
  service: "intervals.icu",
});

// Routing for intervals' ApiError, whose `kind` is a type-only discriminated
// union (no importable class) we mirror here. The `satisfies Record<ApiError
// ["kind"], …>` tie makes `pnpm check` fail if the upstream union gains or
// renames a kind, forcing a routing decision instead of silently degrading to
// the generic apology.
const INTERVALS_KIND_ROUTING = {
  Unauthorized: "intervals",
  Forbidden: "intervals",
  NotFound: "intervals",
  Validation: "intervals",
  Http: "intervals",
  Unknown: "intervals",
  RateLimit: "rate_limit",
  Timeout: "intervals",
  Network: "intervals",
} satisfies Record<ApiError["kind"], AgentErrorKind>;

// Narrow guard: match only objects whose string `kind` is one the upstream
// union actually defines, so unrelated errors that happen to carry a `kind`
// are not misclassified as intervals failures.
function isIntervalsApiError(err: unknown): err is ApiError {
  return (
    typeof err === "object" &&
    err !== null &&
    "kind" in err &&
    typeof (err as { kind: unknown }).kind === "string" &&
    (err as { kind: string }).kind in INTERVALS_KIND_ROUTING
  );
}

function carriedRetryAfterMs(err: unknown): number | null {
  const carried = (err as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof carried === "number" && Number.isFinite(carried) && carried > 0 ? carried : null;
}

function rateLimited(
  err: unknown,
  format?: Pick<Phrasebook["format"], "number">,
): { kind: AgentErrorKind; athleteMessage: Message } {
  const ms = extractRetryAfterMs(err) ?? carriedRetryAfterMs(err);
  if (!ms) return { kind: "rate_limit", athleteMessage: msg("coach.error.rateLimitDefault") };
  const seconds = Math.ceil(ms / 1000);
  const count = seconds < 60 ? seconds : Math.ceil(seconds / 60);
  const value = format?.number(count, { useGrouping: false }) ?? count;
  return {
    kind: "rate_limit",
    athleteMessage:
      seconds < 60
        ? msg("coach.error.rateLimitSeconds", { count, seconds: value })
        : msg("coach.error.rateLimitMinutes", { count, minutes: value }),
  };
}

function assertNever(value: never): never {
  throw new TypeError(`Unhandled failure reason: ${String(value)}`);
}

export function classifyAgentError(
  err: unknown,
  format?: Pick<Phrasebook["format"], "number">,
): {
  kind: AgentErrorKind;
  athleteMessage: Message;
} {
  const refreshFailureReason = readRefreshFailureReason(err);
  switch (refreshFailureReason) {
    case "reauth":
      return {
        kind: "provider-auth",
        athleteMessage: msg("coach.error.reauth", { provider: "ChatGPT" }),
      };
    case "rate_limit":
      return rateLimited(err, format);
    case "server_error":
    case "network":
      return {
        kind: "provider-down",
        athleteMessage: PROVIDER_DOWN_MESSAGE,
      };
    case "unknown":
      return {
        kind: "unknown",
        athleteMessage: msg("coach.error.unknown"),
      };
    case null:
      break;
    default:
      return assertNever(refreshFailureReason);
  }

  if (isRateLimitError(err)) {
    return rateLimited(err, format);
  }

  if (isIntervalsApiError(err)) {
    if (INTERVALS_KIND_ROUTING[err.kind] === "rate_limit") {
      return rateLimited(err, format);
    }
    if (err.kind === "Unauthorized" || err.kind === "Forbidden") {
      return {
        kind: "intervals",
        athleteMessage: INTERVALS_CREDENTIALS_MESSAGE,
      };
    }
    return {
      kind: "intervals",
      athleteMessage: INTERVALS_TRANSIENT_MESSAGE,
    };
  }

  const failure = classifyFailure(err);
  switch (failure) {
    case "reauth":
      return {
        kind: "provider-auth",
        athleteMessage: msg("coach.error.reauth", { provider: "ChatGPT" }),
      };
    case "rate_limit":
      return rateLimited(err, format);
    case "auth":
      return {
        kind: "provider-auth",
        athleteMessage: msg("coach.error.providerCredentials"),
      };
    case "server_error":
    case "network":
    case "timeout":
      return {
        kind: "provider-down",
        athleteMessage: PROVIDER_DOWN_MESSAGE,
      };
    case "overflow":
    case "invalid_request":
    case "unknown":
      return {
        kind: "unknown",
        athleteMessage: msg("coach.error.unknown"),
      };
    default:
      return assertNever(failure);
  }
}
