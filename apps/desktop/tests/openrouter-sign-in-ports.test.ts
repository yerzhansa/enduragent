import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPENROUTER_KEY_EXCHANGE_URL, OpenRouterSignInError } from "@enduragent/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCredentialVault,
  type CredentialEncryptionPort,
} from "../src/main/credential-vault.js";
import {
  OPENROUTER_ACCEPTANCE_KEY,
  openRouterSignInPorts,
  storedOpenRouterKeyReader,
} from "../src/main/openrouter-sign-in-ports.js";

const directories: string[] = [];

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "openrouter-ports-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function approveWith(code: string): (url: string) => Promise<void> {
  return async (url) => {
    const authorize = new URL(url);
    const callback = new URL(authorize.searchParams.get("callback_url") ?? "");
    callback.hostname = "127.0.0.1";
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");
    await fetch(callback);
  };
}

function encryption(): CredentialEncryptionPort {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.concat([Buffer.from("SAFE:"), Buffer.from(value).reverse()]),
    decryptString: (value) => value.subarray(5).reverse().toString(),
  };
}

describe("OpenRouter sign-in ports", () => {
  it.each([
    { isPackaged: true, hidden: true, log: "/tmp/authorize.log" },
    { isPackaged: false, hidden: false, log: "/tmp/authorize.log" },
    { isPackaged: false, hidden: true, log: undefined },
    { isPackaged: false, hidden: true, log: "relative/authorize.log" },
  ])("uses the real browser and OpenRouter outside acceptance runs: %o", async (gate) => {
    const openExternal = vi.fn(async (_url: string) => undefined);
    const fetch = vi.fn(async () => Response.json({ data: { is_free_tier: false } }));
    const ports = openRouterSignInPorts({
      app: { isPackaged: gate.isPackaged },
      hidden: gate.hidden,
      environment: { ENDURAGENT_ACCEPTANCE_OPENROUTER_AUTHORIZE_LOG: gate.log },
      openExternal,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(ports.openExternal).toBe(openExternal);
    await expect(ports.readCreditStatus("sk-or-v1-real")).resolves.toBe("paid");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("logs the consent page and answers with a synthetic key in an acceptance run", async () => {
    const log = join(await scratch(), "authorize.log");
    const ports = openRouterSignInPorts({
      app: { isPackaged: false },
      hidden: true,
      environment: { ENDURAGENT_ACCEPTANCE_OPENROUTER_AUTHORIZE_LOG: log },
      openExternal: async () => {
        throw new Error("the real browser must not open");
      },
    });
    await ports.openExternal("https://openrouter.ai/auth?state=fixture");
    expect(await readFile(log, "utf8")).toBe("https://openrouter.ai/auth?state=fixture\n");
    await expect(ports.signIn({ openExternal: approveWith("acceptance-code") })).resolves.toBe(
      OPENROUTER_ACCEPTANCE_KEY,
    );
    expect(OPENROUTER_ACCEPTANCE_KEY).toBe(`sk-or-v1-${"0".repeat(64)}`);
    await expect(ports.readCreditStatus(OPENROUTER_ACCEPTANCE_KEY)).resolves.toBe("paid");
    await expect(ports.startCodeSignIn().exchange("acceptance-code")).resolves.toBe(
      OPENROUTER_ACCEPTANCE_KEY,
    );
  });

  it("reads a never-paid account and simulates an unreachable exchange", async () => {
    const ports = openRouterSignInPorts({
      app: { isPackaged: false },
      hidden: true,
      environment: {
        ENDURAGENT_ACCEPTANCE_OPENROUTER_AUTHORIZE_LOG: join(await scratch(), "authorize.log"),
        ENDURAGENT_ACCEPTANCE_OPENROUTER_CREDIT: "never-paid",
      },
    });
    await expect(ports.readCreditStatus(OPENROUTER_ACCEPTANCE_KEY)).resolves.toBe("never-paid");
    const failure = await ports
      .signIn({ openExternal: approveWith("acceptance-unreachable") })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OpenRouterSignInError);
    expect((failure as OpenRouterSignInError).reason).toBe("unreachable");
    expect(OPENROUTER_KEY_EXCHANGE_URL).toBe("https://openrouter.ai/api/v1/auth/keys");
  });

  it("reads the stored OpenRouter key through the vault without touching the runtime", async () => {
    const root = join(await scratch(), "credentials-v1");
    const applyCredential = vi.fn(async () => undefined);
    const vault = createCredentialVault({ root, encryption: encryption(), applyCredential });
    const read = storedOpenRouterKeyReader({ root, encryption: encryption() });
    await expect(read()).resolves.toBeUndefined();
    await vault.writeCredential(
      { slot: "anthropic", value: "sk-ant-synthetic" },
      { activate: false },
    );
    await expect(read()).resolves.toBeUndefined();
    await vault.writeCredential(
      { slot: "openrouter", value: OPENROUTER_ACCEPTANCE_KEY },
      { activate: false },
    );
    await expect(read()).resolves.toBe(OPENROUTER_ACCEPTANCE_KEY);
    expect(applyCredential).not.toHaveBeenCalled();
  });
});
