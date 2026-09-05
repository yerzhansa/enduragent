import {
  TokenRefreshError,
  type OAuthCredentialOwner,
  type RefreshFailureReason,
} from "@enduragent/core";

export type OAuthRequest = {
  readonly type: "oauth-request";
  readonly id: number;
  readonly operation: "status" | "token" | "delete";
  readonly profile: string;
  readonly rejectedAccessToken?: string;
};
export type OAuthResponse = {
  readonly type: "oauth-response";
  readonly id: number;
} & (
  | { readonly status: "ok"; readonly value: string | boolean | null }
  | { readonly status: "failed"; readonly reason: RefreshFailureReason }
);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isOAuthRequest(value: unknown): value is OAuthRequest {
  return (
    record(value) &&
    value.type === "oauth-request" &&
    typeof value.id === "number" &&
    Number.isSafeInteger(value.id) &&
    value.id > 0 &&
    typeof value.profile === "string" &&
    value.profile.length > 0 &&
    ["status", "token", "delete"].includes(String(value.operation)) &&
    (value.rejectedAccessToken === undefined ||
      (value.operation === "token" && typeof value.rejectedAccessToken === "string"))
  );
}

export function isOAuthResponse(value: unknown): value is OAuthResponse {
  return (
    record(value) &&
    value.type === "oauth-response" &&
    typeof value.id === "number" &&
    Number.isSafeInteger(value.id) &&
    value.id > 0 &&
    ((value.status === "ok" &&
      (typeof value.value === "string" ||
        typeof value.value === "boolean" ||
        value.value === null)) ||
      (value.status === "failed" &&
        (value.reason === "reauth" ||
          value.reason === "rate_limit" ||
          value.reason === "server_error" ||
          value.reason === "network" ||
          value.reason === "unknown")))
  );
}

export function createUtilityOAuthClient(input: {
  readonly send: (request: OAuthRequest) => void;
  readonly signal: AbortSignal;
}): {
  readonly owner: OAuthCredentialOwner;
  receive(response: OAuthResponse): void;
  close(): void;
} {
  let sequence = 0;
  const pending = new Map<number, (response: OAuthResponse | undefined) => void>();
  const request = (
    operation: OAuthRequest["operation"],
    profile: string,
    signal?: AbortSignal,
    rejectedAccessToken?: string,
  ): Promise<string | boolean | null> => {
    const combined = AbortSignal.any([
      input.signal,
      AbortSignal.timeout(60_000),
      ...(signal === undefined ? [] : [signal]),
    ]);
    combined.throwIfAborted();
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const finish = (response: OAuthResponse | undefined): void => {
        pending.delete(id);
        combined.removeEventListener("abort", abort);
        if (response?.status === "ok") resolve(response.value);
        else reject(new TokenRefreshError(response?.reason ?? "unknown"));
      };
      const abort = (): void => finish(undefined);
      pending.set(id, finish);
      combined.addEventListener("abort", abort, { once: true });
      try {
        input.send({
          type: "oauth-request",
          id,
          operation,
          profile,
          ...(rejectedAccessToken === undefined ? {} : { rejectedAccessToken }),
        });
      } catch {
        finish(undefined);
      }
    });
  };
  return {
    owner: {
      async hasProfile(profile) {
        return (await request("status", profile)) === true;
      },
      async getAccessToken(profile, signal, rejectedAccessToken) {
        const value = await request("token", profile, signal, rejectedAccessToken);
        if (typeof value !== "string" || value.length === 0) throw new TokenRefreshError("unknown");
        return value;
      },
      async deleteProfile(profile) {
        await request("delete", profile);
      },
    },
    receive(response) {
      pending.get(response.id)?.(response);
    },
    close() {
      for (const finish of pending.values()) finish(undefined);
    },
  };
}
