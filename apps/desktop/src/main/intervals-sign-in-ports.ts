import { appendFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { shell, type App } from "electron";
import {
  signInWithIntervals,
  type IntervalsOAuthGrant,
  type IntervalsSignInOptions,
} from "@enduragent/core";

export interface IntervalsSignInPorts {
  readonly openExternal: (url: string) => Promise<void>;
  readonly signIn: (options: IntervalsSignInOptions) => Promise<IntervalsOAuthGrant>;
}

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
  if (input.app.isPackaged || !input.hidden || log === undefined || !isAbsolute(log)) {
    return { openExternal, signIn: signInWithIntervals };
  }
  return {
    openExternal: (url) => appendFile(log, `${url}\n`, { mode: 0o600 }),
    signIn: (options) => signInWithIntervals({ ...options, fetch: acceptanceTokenFetch }),
  };
}
