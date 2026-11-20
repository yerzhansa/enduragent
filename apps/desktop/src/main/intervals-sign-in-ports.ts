import { appendFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { shell, type App } from "electron";
import {
  revokeIntervalsAccess,
  signInWithIntervals,
  type IntervalsOAuthGrant,
  type IntervalsRevokeResult,
  type IntervalsSignInOptions,
} from "@enduragent/core";

export interface IntervalsSignInPorts {
  readonly openExternal: (url: string) => Promise<void>;
  readonly signIn: (options: IntervalsSignInOptions) => Promise<IntervalsOAuthGrant>;
}

export const INTERVALS_REVOKE_TIMEOUT_MS = 10_000;

const ACCEPTANCE_SCOPE = "ACTIVITY:READ,WELLNESS:READ,CALENDAR:WRITE,SETTINGS:READ";

async function acceptanceTokenFetch(
  _input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<Response> {
  const code = new URLSearchParams(typeof init?.body === "string" ? init.body : "").get("code");
  if (code === "acceptance-unreachable") throw new TypeError("acceptance network failure");
  if (code === "acceptance-rejected") return new Response("{}", { status: 400 });
  return Response.json({
    token_type: "Bearer",
    access_token: "acceptance-token",
    scope: ACCEPTANCE_SCOPE,
    athlete: { id: "101", name: "Test Athlete" },
  });
}

export function intervalsSignInPorts(input: {
  readonly app: Pick<App, "isPackaged">;
  readonly hidden: boolean;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly openExternal?: (url: string) => Promise<void>;
}): IntervalsSignInPorts {
  const openExternal = input.openExternal ?? ((url: string) => shell.openExternal(url));
  const log = input.environment.ENDURAGENT_ACCEPTANCE_INTERVALS_AUTHORIZE_LOG;
  if (!acceptanceRun(input) || log === undefined) {
    return { openExternal, signIn: signInWithIntervals };
  }
  return {
    openExternal: (url) => appendFile(log, `${url}\n`, { mode: 0o600 }),
    signIn: (options) => signInWithIntervals({ ...options, fetch: acceptanceTokenFetch }),
  };
}

function acceptanceRun(input: {
  readonly app: Pick<App, "isPackaged">;
  readonly hidden: boolean;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): boolean {
  const log = input.environment.ENDURAGENT_ACCEPTANCE_INTERVALS_AUTHORIZE_LOG;
  return !input.app.isPackaged && input.hidden && log !== undefined && isAbsolute(log);
}

export function intervalsRevokePort(input: {
  readonly app: Pick<App, "isPackaged">;
  readonly hidden: boolean;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): (credential: string) => Promise<IntervalsRevokeResult> {
  if (!acceptanceRun(input)) {
    return (credential) =>
      revokeIntervalsAccess({ credential, timeoutMs: INTERVALS_REVOKE_TIMEOUT_MS });
  }
  const result = input.environment.ENDURAGENT_ACCEPTANCE_INTERVALS_REVOKE_RESULT;
  const acceptanceRevokeFetch = async (): Promise<Response> => {
    if (result === "failed") throw new TypeError("acceptance network failure");
    return new Response(null, { status: result === "already-invalid" ? 401 : 204 });
  };
  return (credential) =>
    revokeIntervalsAccess({
      credential,
      timeoutMs: INTERVALS_REVOKE_TIMEOUT_MS,
      fetch: acceptanceRevokeFetch,
    });
}
