import { appendFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { shell, type App, type Clipboard } from "electron";
import {
  OPENROUTER_KEY_STATUS_URL,
  readOpenRouterCreditStatus,
  signInWithOpenRouter,
  startOpenRouterCodeSignIn,
} from "@enduragent/core";
import { createCredentialVault, type CredentialEncryptionPort } from "./credential-vault.js";
import type { OpenRouterAuthDependencies, OpenRouterSignInPorts } from "./openrouter-auth.js";

export const OPENROUTER_ACCEPTANCE_KEY = `sk-or-v1-${"0".repeat(64)}`;

function acceptanceFetch(environment: Readonly<Record<string, string | undefined>>) {
  return async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    if (String(input) === OPENROUTER_KEY_STATUS_URL) {
      const neverPaid = environment.ENDURAGENT_ACCEPTANCE_OPENROUTER_CREDIT === "never-paid";
      return Response.json({ data: { is_free_tier: neverPaid } });
    }
    const body: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    const code = typeof body === "object" && body !== null && "code" in body ? body.code : null;
    if (code === "acceptance-unreachable") throw new TypeError("acceptance network failure");
    return Response.json({ key: OPENROUTER_ACCEPTANCE_KEY, user_id: null });
  };
}

export function openRouterSignInPorts(input: {
  readonly app: Pick<App, "isPackaged">;
  readonly hidden: boolean;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly openExternal?: (url: string) => Promise<void>;
  readonly fetch?: typeof fetch;
}): OpenRouterSignInPorts {
  const log = input.environment.ENDURAGENT_ACCEPTANCE_OPENROUTER_AUTHORIZE_LOG;
  const acceptance = !input.app.isPackaged && input.hidden && log !== undefined && isAbsolute(log);
  const openExternal = acceptance
    ? (url: string) => appendFile(log, `${url}\n`, { mode: 0o600 })
    : (input.openExternal ?? ((url: string) => shell.openExternal(url)));
  const doFetch = acceptance ? acceptanceFetch(input.environment) : input.fetch;
  const withFetch = doFetch === undefined ? {} : { fetch: doFetch };
  return {
    openExternal,
    signIn: (options) => signInWithOpenRouter({ ...options, ...withFetch }),
    startCodeSignIn: () => startOpenRouterCodeSignIn(withFetch),
    readCreditStatus: (key, signal) =>
      readOpenRouterCreditStatus({
        key,
        ...withFetch,
        ...(signal === undefined ? {} : { signal }),
      }),
  };
}

export function storedOpenRouterKeyReader(input: {
  readonly root: string;
  readonly encryption: CredentialEncryptionPort;
}): () => Promise<string | undefined> {
  return async () => {
    let key: string | undefined;
    const reader = createCredentialVault({
      root: input.root,
      encryption: input.encryption,
      applyCredential: () => Promise.reject(new TypeError()),
      reapplyCredential: async (slot, value) => {
        if (slot === "openrouter") key = value;
        return "stored-inactive";
      },
    });
    await reader.reapplyConfigured();
    return key;
  };
}

export function openRouterAuthDependencies(input: {
  readonly app: Pick<App, "isPackaged">;
  readonly hidden: boolean;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly clipboard: Pick<Clipboard, "readText" | "clear">;
  readonly credentialRoot: string;
  readonly encryption: CredentialEncryptionPort;
}): OpenRouterAuthDependencies {
  return {
    ports: openRouterSignInPorts(input),
    clipboard: input.clipboard,
    readStoredKey: storedOpenRouterKeyReader({
      root: input.credentialRoot,
      encryption: input.encryption,
    }),
  };
}
