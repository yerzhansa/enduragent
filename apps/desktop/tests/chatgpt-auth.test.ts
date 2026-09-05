import { dirname } from "node:path";
import { syntheticOAuthOwner } from "./helpers/oauth-owner.js";
import type { CodexCredentials } from "@enduragent/core";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmProvider, RuntimeConfigSnapshot } from "@enduragent/coach-contract";
import { createChatGptAuth as createChatGptAuthSubject } from "../src/main/chatgpt-auth.js";

const roots: string[] = [];
const owners = new Map<string, ReturnType<typeof syntheticOAuthOwner>>();
function profileOwner(configDir: string) {
  let owner = owners.get(configDir);
  if (owner === undefined) {
    owner = syntheticOAuthOwner(configDir);
    owners.set(configDir, owner);
  }
  return owner;
}
const hasChatGptProfile = (configDir: string) => profileOwner(configDir).hasProfile("openai-codex");
const writeChatGptProfile = (configDir: string, credentials: CodexCredentials) =>
  profileOwner(configDir).writeProfile(credentials);
const deleteChatGptProfile = (configDir: string) =>
  profileOwner(configDir).deleteProfile("openai-codex");

async function configDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "desktop-chatgpt-auth-"));
  roots.push(root);
  return join(root, "config");
}

function credentials() {
  return {
    access: "obviously-fake-access",
    refresh: "obviously-fake-refresh",
    expires: 4_102_444_800_000,
    accountId: "obviously-fake-account",
  };
}

function selection(model = "gpt-5.5") {
  return {
    provider: "openai-codex" as const,
    model,
    endpoint: { mode: "automatic" as const },
  };
}

function runtimeSnapshot(
  provider: LlmProvider = "openai-codex",
  credentialConfigured = provider === "openai-codex",
): RuntimeConfigSnapshot {
  return {
    schemaVersion: 3,
    llm: {
      provider,
      model: "custom-selected-model",
      credential_configured: credentialConfigured,
    },
    intervals: {
      athlete_id: "custom-athlete",
      credential_configured: true,
      managedByEnvironment: { athleteId: false },
    },
    session: {
      historyTokenBudgetRatio: 0.3,
      idleMinutes: 0,
      dailyResetHour: 4,
      resetArchiveRetentionDays: 0,
      timezone: "UTC",
      managedByEnvironment: {
        historyTokenBudgetRatio: false,
        idleMinutes: false,
        dailyResetHour: false,
        resetArchiveRetentionDays: false,
        timezone: false,
      },
    },
  };
}

function createChatGptAuth(
  options: Omit<
    Parameters<typeof createChatGptAuthSubject>[0],
    "getRuntimeConfig" | "profileStore" | "dependencies"
  > & {
    readonly configDir: string;
    readonly dependencies?: Parameters<typeof createChatGptAuthSubject>[0]["dependencies"] & {
      readonly writeProfile?: (configDir: string, credentials: CodexCredentials) => Promise<void>;
    };
    readonly getRuntimeConfig?: () => Promise<RuntimeConfigSnapshot>;
  },
) {
  return createChatGptAuthSubject({
    ...options,
    profileStore: {
      ...profileOwner(options.configDir),
      writeProfile:
        options.dependencies?.writeProfile === undefined
          ? profileOwner(options.configDir).writeProfile
          : (credentials) => options.dependencies!.writeProfile!(options.configDir, credentials),
    },
    getRuntimeConfig: options.getRuntimeConfig ?? (async () => runtimeSnapshot()),
  });
}

function invalidUtf8ProfilesBytes(): Buffer {
  return Buffer.concat([
    Buffer.from('{"openai-codex":{"type":"oauth","access":"invalid-', "utf8"),
    Buffer.from([0xc3, 0x28]),
    Buffer.from('","refresh":"invalid-refresh","expires":4102444800000}}', "utf8"),
  ]);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("desktop ChatGPT auth", () => {
  it("deletes an inactive local profile without a runtime cutover", async () => {
    const directory = await configDir();
    await writeChatGptProfile(directory, credentials());
    const clearRuntimeCredential = vi.fn(async () => "cleared" as const);
    const auth = createChatGptAuth({
      configDir: directory,
      applyRuntimeConfig: vi.fn(async () => {}),
      clearRuntimeCredential,
      getRuntimeConfig: async () => runtimeSnapshot("anthropic", true),
      openExternal: vi.fn(async () => {}),
    });

    await expect(auth.deleteCredential()).resolves.toEqual({
      status: "deleted",
      cleanupPending: false,
    });

    expect(clearRuntimeCredential).not.toHaveBeenCalled();
    await expect(hasChatGptProfile(directory)).resolves.toBe(false);
  });

  it("deletes an active profile through the serialized runtime cutover", async () => {
    const directory = await configDir();
    await writeChatGptProfile(directory, credentials());
    const clearRuntimeCredential = vi.fn(async () => {
      await deleteChatGptProfile(directory);
      return "cleared" as const;
    });
    const auth = createChatGptAuth({
      configDir: directory,
      applyRuntimeConfig: vi.fn(async () => {}),
      clearRuntimeCredential,
      openExternal: vi.fn(async () => {}),
    });

    await expect(auth.deleteCredential()).resolves.toEqual({
      status: "deleted",
      cleanupPending: false,
    });

    expect(clearRuntimeCredential).toHaveBeenCalledOnce();
    await expect(hasChatGptProfile(directory)).resolves.toBe(false);
  });

  it.each([false, true])(
    "disconnects an active custom profile and preserves other profiles (default: %s)",
    async (includeDefault) => {
      const directory = await configDir();
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "auth-profiles.json"),
        JSON.stringify({
          custom: { type: "oauth", ...credentials() },
          unrelated: { type: "oauth", ...credentials(), access: "obviously-fake-unrelated" },
          ...(includeDefault ? { "openai-codex": { type: "oauth", ...credentials() } } : {}),
        }),
      );
      const owner = syntheticOAuthOwner(directory, { selectedProfile: "custom" });
      owners.set(directory, owner);
      await owner.initialize();
      const auth = createChatGptAuth({
        configDir: directory,
        activeProfileName: async () => "custom",
        applyRuntimeConfig: async () => {},
        openExternal: async () => {},
        clearRuntimeCredential: async () => {
          await owner.deleteProfile("custom");
          return "cleared";
        },
      });
      await expect(auth.deleteCredential()).resolves.toEqual({
        status: "deleted",
        cleanupPending: false,
      });
      await expect(owner.hasProfile("custom")).resolves.toBe(false);
      await expect(owner.hasProfile("openai-codex")).resolves.toBe(includeDefault);
      const remaining = JSON.parse(await readFile(join(directory, "auth-profiles.json"), "utf8"));
      expect(Object.keys(remaining)).toEqual(["unrelated"]);
    },
  );

  it("fails closed and surfaces profile/runtime divergence during deletion", async () => {
    const directory = await configDir();
    await writeChatGptProfile(directory, credentials());
    const unavailable = createChatGptAuth({
      configDir: directory,
      applyRuntimeConfig: vi.fn(async () => {}),
      getRuntimeConfig: vi.fn(async () => {
        throw new TypeError();
      }),
      openExternal: vi.fn(async () => {}),
    });

    await expect(unavailable.deleteCredential()).resolves.toEqual({
      status: "refused",
      reason: "runtime-unavailable",
    });
    await expect(hasChatGptProfile(directory)).resolves.toBe(true);

    const ambiguous = createChatGptAuth({
      configDir: directory,
      applyRuntimeConfig: vi.fn(async () => {}),
      clearRuntimeCredential: vi.fn(async () => {
        throw new TypeError();
      }),
      openExternal: vi.fn(async () => {}),
    });
    await expect(ambiguous.deleteCredential()).resolves.toEqual({
      status: "refused",
      reason: "runtime-state-diverged",
    });
    await expect(hasChatGptProfile(directory)).resolves.toBe(true);

    const divergent = createChatGptAuth({
      configDir: directory,
      applyRuntimeConfig: vi.fn(async () => {}),
      clearRuntimeCredential: vi.fn(async () => "cleared" as const),
      openExternal: vi.fn(async () => {}),
    });
    await expect(divergent.deleteCredential()).resolves.toEqual({
      status: "refused",
      reason: "runtime-state-diverged",
    });
  });

  it("stores login credentials only in the encrypted envelope", async () => {
    const directory = await configDir();
    await writeChatGptProfile(directory, credentials());
    const path = join(dirname(directory), "credentials-v1", "oauth.bin");
    const bytes = await readFile(path);
    expect(bytes.includes(Buffer.from(credentials().access))).toBe(false);
    expect(bytes.includes(Buffer.from(credentials().refresh))).toBe(false);
    await expect(readFile(join(directory, "auth-profiles.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(hasChatGptProfile(directory)).resolves.toBe(true);
  });

  it("retains unrelated legacy profiles during migration", async () => {
    const directory = await configDir();
    await mkdir(directory, { recursive: true });
    const other = { type: "oauth", access: "synthetic-other", future: { generation: 1 } };
    const path = join(directory, "auth-profiles.json");
    await writeFile(
      path,
      JSON.stringify({ other, "openai-codex": { type: "oauth", ...credentials() } }),
      { mode: 0o600 },
    );
    await expect(hasChatGptProfile(directory)).resolves.toBe(true);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ other });
  });

  it("does not fall back to newly added plaintext after encrypted storage becomes corrupt", async () => {
    const directory = await configDir();
    await writeChatGptProfile(directory, credentials());
    await writeFile(join(dirname(directory), "credentials-v1", "oauth.bin"), "corrupt");
    await writeFile(
      join(directory, "auth-profiles.json"),
      JSON.stringify({ "openai-codex": { type: "oauth", ...credentials() } }),
    );
    await expect(hasChatGptProfile(directory)).resolves.toBe(false);
  });

  it("reports invalid UTF-8 profile bytes as absent before login", async () => {
    const directory = await configDir();
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "auth-profiles.json"), invalidUtf8ProfilesBytes());
    const auth = createChatGptAuth({
      configDir: directory,
      openExternal: async () => {},
      applyRuntimeConfig: async () => {},
      getRuntimeConfig: async () => runtimeSnapshot("openai-codex", false),
    });

    await expect(hasChatGptProfile(directory)).resolves.toBe(false);
    await expect(auth.status()).resolves.toEqual({ state: "absent", runtimeReady: false });
  });

  it("reports a valid target with an invalid sibling profile as absent", async () => {
    const directory = await configDir();
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "auth-profiles.json"),
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "obviously-fake-access",
          refresh: "obviously-fake-refresh",
          expires: 4_102_444_800_000,
        },
        invalidSibling: "not-a-profile-map",
      }),
    );
    const auth = createChatGptAuth({
      configDir: directory,
      openExternal: async () => {},
      applyRuntimeConfig: async () => {},
      getRuntimeConfig: async () => runtimeSnapshot("openai-codex", false),
    });

    await expect(hasChatGptProfile(directory)).resolves.toBe(false);
    await expect(auth.status()).resolves.toEqual({ state: "absent", runtimeReady: false });
  });

  it("refuses malformed legacy migration without creating a plaintext quarantine", async () => {
    const directory = await configDir();
    const path = join(directory, "auth-profiles.json");
    const originalBytes = invalidUtf8ProfilesBytes();
    await mkdir(directory, { recursive: true });
    await writeFile(path, originalBytes, { mode: 0o600 });
    const auth = createChatGptAuth({
      configDir: directory,
      openExternal: async () => {},
      applyRuntimeConfig: async () => {},
      dependencies: { loginCodex: async () => credentials() },
    });

    await expect(auth.login("quarantine", selection())).resolves.toEqual({
      status: "refused",
      operationId: "quarantine",
      reason: "storage-failed",
    });
    expect(await readFile(path)).toEqual(originalBytes);
    await expect(readFile(`${path}.corrupt`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(hasChatGptProfile(directory)).resolves.toBe(false);
  });

  it("does not replace an unreadable existing profile path", async () => {
    const directory = await configDir();
    const path = join(directory, "auth-profiles.json");
    await mkdir(path, { recursive: true });
    await expect(writeChatGptProfile(directory, credentials())).rejects.toBeDefined();
    expect((await stat(path)).isDirectory()).toBe(true);
    await expect(hasChatGptProfile(directory)).resolves.toBe(false);
    const auth = createChatGptAuth({
      configDir: directory,
      openExternal: async () => {},
      applyRuntimeConfig: async () => {},
      dependencies: { loginCodex: async () => credentials() },
    });
    await expect(auth.login("unreadable", selection())).resolves.toEqual({
      status: "refused",
      operationId: "unreadable",
      reason: "storage-failed",
    });
    expect((await stat(path)).isDirectory()).toBe(true);
  });

  it("maps timeout, browser cancellation, and exchange failures", async () => {
    const directory = await configDir();
    const timedOut = createChatGptAuth({
      configDir: directory,
      openExternal: async () => {},
      applyRuntimeConfig: async () => {},
      dependencies: {
        loginCodex: async () => {
          throw Object.assign(new Error("authorization timed out"), {
            name: "CodexLoginError",
            reason: "authorization-timed-out" as const,
          });
        },
      },
    });
    await expect(timedOut.login("timeout", selection())).resolves.toEqual({
      status: "refused",
      operationId: "timeout",
      reason: "timed-out",
    });

    const cancelled = createChatGptAuth({
      configDir: directory,
      openExternal: async () => {
        throw new TypeError();
      },
      applyRuntimeConfig: async () => {},
      dependencies: {
        loginCodex: async (options) => {
          options.onAuth({ url: "https://auth.openai.com/obviously-fake" });
          return await new Promise((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
              once: true,
            });
          });
        },
      },
    });
    await expect(cancelled.login("browser-cancel", selection())).resolves.toEqual({
      status: "refused",
      operationId: "browser-cancel",
      reason: "cancelled",
    });

    const exchange = createChatGptAuth({
      configDir: directory,
      openExternal: async () => {},
      applyRuntimeConfig: async () => {},
      dependencies: {
        loginCodex: async () => {
          throw new TypeError();
        },
      },
    });
    await expect(exchange.login("exchange", selection())).resolves.toEqual({
      status: "refused",
      operationId: "exchange",
      reason: "exchange-failed",
    });
  });

  it("forwards the separate login limits and closed progress phases", async () => {
    const directory = await configDir();
    const progress: string[] = [];
    const loginCodex = vi.fn(async (options) => {
      expect(options.authorizationTimeoutMs).toBe(300_000);
      expect(options.tokenExchangeTimeoutMs).toBe(10_000);
      options.onProgress?.("waiting-for-browser");
      options.onProgress?.("completing-sign-in");
      return credentials();
    });
    const auth = createChatGptAuth({
      configDir: directory,
      authorizationTimeoutMs: 300_000,
      tokenExchangeTimeoutMs: 10_000,
      openExternal: async () => {},
      applyRuntimeConfig: async () => {},
      dependencies: { loginCodex },
    });

    await expect(
      auth.login("progress", selection(), (phase) => progress.push(phase)),
    ).resolves.toEqual({ status: "stored", operationId: "progress" });
    expect(progress).toEqual(["waiting-for-browser", "completing-sign-in"]);
  });

  it("cancels only the matching active browser operation", async () => {
    const directory = await configDir();
    const loginCodex = vi.fn(
      async (options) =>
        await new Promise<ReturnType<typeof credentials>>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    );
    const auth = createChatGptAuth({
      configDir: directory,
      openExternal: async () => {},
      applyRuntimeConfig: async () => {},
      dependencies: { loginCodex },
    });

    const pending = auth.login("active-login", selection());
    await vi.waitFor(() => expect(loginCodex).toHaveBeenCalledOnce());
    expect(auth.cancelLogin("stale-login")).toEqual({
      status: "not-active",
      operationId: "stale-login",
    });
    expect(auth.cancelLogin("active-login")).toEqual({
      status: "cancelling",
      operationId: "active-login",
    });
    await expect(pending).resolves.toEqual({
      status: "refused",
      operationId: "active-login",
      reason: "cancelled",
    });
  });

  it("keeps stored terminal once secure persistence has completed during cancellation", async () => {
    const directory = await configDir();
    let releaseStorage!: () => void;
    let storageStarted!: () => void;
    const storageGate = new Promise<void>((resolve) => {
      releaseStorage = resolve;
    });
    const started = new Promise<void>((resolve) => {
      storageStarted = resolve;
    });
    const auth = createChatGptAuth({
      configDir: directory,
      openExternal: async () => {},
      applyRuntimeConfig: async () => {},
      dependencies: {
        loginCodex: async () => credentials(),
        writeProfile: async (configDirectory, value) => {
          storageStarted();
          await storageGate;
          await writeChatGptProfile(configDirectory, value);
        },
      },
    });

    const pending = auth.login("persisting", selection());
    await started;
    expect(auth.cancelLogin("persisting")).toEqual({
      status: "cancelling",
      operationId: "persisting",
    });
    releaseStorage();
    await expect(pending).resolves.toEqual({ status: "stored", operationId: "persisting" });
    await expect(hasChatGptProfile(directory)).resolves.toBe(true);
  });

  it("bounds an already-selected stored-profile activation and aborts its runtime request", async () => {
    const directory = await configDir();
    await writeChatGptProfile(directory, credentials());
    let activationSignal: AbortSignal | undefined;
    const activationController = new AbortController();
    const overallActivationSignal = activationController.signal;
    const auth = createChatGptAuth({
      configDir: directory,
      activationTimeoutMs: 100,
      openExternal: async () => {},
      getRuntimeConfig: async () => runtimeSnapshot("openai-codex", true),
      applyRuntimeConfig: async (_request, signal) => {
        activationSignal = signal;
        queueMicrotask(() => activationController.abort());
        return await new Promise<void>(() => {});
      },
    });

    await expect(auth.activate(selection(), overallActivationSignal)).resolves.toEqual({
      status: "refused",
      reason: "runtime-unavailable",
    });
    expect(overallActivationSignal.aborted).toBe(true);
    expect(activationSignal?.aborted).toBe(true);
  });

  it("does not open or abort the browser flow when the callback listener is unavailable", async () => {
    const directory = await configDir();
    const openExternal = vi.fn(async () => {});
    let reachedPrompt = false;
    const auth = createChatGptAuth({
      configDir: directory,
      openExternal,
      applyRuntimeConfig: async () => {},
      dependencies: {
        loginCodex: async (options) => {
          options.onAuth({
            url: "https://auth.openai.com/obviously-fake",
            callbackAvailable: false,
          });
          expect(options.signal?.aborted).toBe(false);
          reachedPrompt = true;
          await options.onPrompt({
            message: "obviously-fake",
            signal: options.signal ?? new AbortController().signal,
          });
          return credentials();
        },
      },
    });

    await expect(auth.login("callback-missing", selection())).resolves.toEqual({
      status: "refused",
      operationId: "callback-missing",
      reason: "callback-unavailable",
    });
    expect(reachedPrompt).toBe(true);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("treats missing callback availability as available for compatibility", async () => {
    const directory = await configDir();
    const openExternal = vi.fn(async () => {});
    const auth = createChatGptAuth({
      configDir: directory,
      openExternal,
      applyRuntimeConfig: async () => {},
      dependencies: {
        loginCodex: async (options) => {
          options.onAuth({ url: "https://auth.openai.com/obviously-fake" });
          await vi.waitFor(() => expect(openExternal).toHaveBeenCalledOnce());
          return credentials();
        },
      },
    });

    await expect(auth.login("compatibility", selection())).resolves.toEqual({
      status: "stored",
      operationId: "compatibility",
    });
    expect(openExternal).toHaveBeenCalledOnce();
  });

  it("publishes stored before a separate keyless runtime activation", async () => {
    const directory = await configDir();
    const order: string[] = [];
    const openExternal = vi.fn(async () => {
      order.push("browser");
    });
    const writeProfile = vi.fn(async () => {
      order.push("storage");
      await writeChatGptProfile(directory, credentials());
    });
    const applyRuntimeConfig = vi.fn(async () => {
      order.push("runtime");
      await writeFile(
        join(directory, "config.yaml"),
        "llm:\n  provider: openai-codex\n  model: gpt-5.5\n",
      );
    });
    const auth = createChatGptAuth({
      configDir: directory,
      openExternal,
      applyRuntimeConfig,
      dependencies: {
        writeProfile,
        loginCodex: async (options) => {
          expect(options.signal).toBeInstanceOf(AbortSignal);
          options.onAuth({
            url: "https://auth.openai.com/obviously-fake",
            callbackAvailable: true,
          });
          await vi.waitFor(() => expect(openExternal).toHaveBeenCalledOnce());
          return credentials();
        },
      },
    });
    await expect(auth.login("store-first", selection())).resolves.toEqual({
      status: "stored",
      operationId: "store-first",
    });
    expect(applyRuntimeConfig).not.toHaveBeenCalled();
    expect(order).toEqual(["browser", "storage"]);
    await expect(auth.activate(selection())).resolves.toEqual({
      status: "configured",
      runtimeReady: true,
    });
    expect(applyRuntimeConfig).toHaveBeenCalledWith(
      { llm: { provider: "openai-codex", model: "gpt-5.5" } },
      expect.any(AbortSignal),
    );
    expect(order).toEqual(["browser", "storage", "runtime"]);
    await expect(auth.status()).resolves.toEqual({ state: "configured", runtimeReady: true });
  });

  it("activates a stored profile with the selected model without reauthenticating", async () => {
    const directory = await configDir();
    await writeChatGptProfile(directory, credentials());
    const applyRuntimeConfig = vi.fn(async () => {});
    const loginCodex = vi.fn(async () => credentials());
    const auth = createChatGptAuth({
      configDir: directory,
      openExternal: async () => {},
      applyRuntimeConfig,
      dependencies: { loginCodex },
    });

    await expect(auth.activate(selection("athlete-custom-model"))).resolves.toEqual({
      status: "configured",
      runtimeReady: true,
    });
    expect(applyRuntimeConfig).toHaveBeenCalledWith(
      { llm: { provider: "openai-codex", model: "athlete-custom-model" } },
      expect.any(AbortSignal),
    );
    expect(loginCodex).not.toHaveBeenCalled();
  });

  it("returns fixed stored-profile activation refusals", async () => {
    const directory = await configDir();
    const absent = createChatGptAuth({
      configDir: directory,
      openExternal: async () => {},
      applyRuntimeConfig: async () => {},
    });
    await expect(absent.activate(selection())).resolves.toEqual({
      status: "refused",
      reason: "credential-required",
    });
    await expect(
      absent.activate({
        provider: "anthropic",
        model: "model",
        endpoint: { mode: "automatic" },
      }),
    ).resolves.toEqual({ status: "refused", reason: "invalid-input" });

    await writeChatGptProfile(directory, credentials());
    const unavailable = createChatGptAuth({
      configDir: directory,
      openExternal: async () => {},
      applyRuntimeConfig: async () => {
        throw new Error("private runtime detail");
      },
    });
    await expect(unavailable.activate(selection())).resolves.toEqual({
      status: "refused",
      reason: "runtime-unavailable",
    });
  });

  it("restores configured runtime readiness from the daemon snapshot", async () => {
    const directory = await configDir();
    await writeChatGptProfile(directory, credentials());
    await writeFile(
      join(directory, "config.yaml"),
      "llm:\n  provider: openai-codex\n  model: gpt-5.5\n",
    );
    const auth = createChatGptAuth({
      configDir: directory,
      openExternal: async () => {},
      applyRuntimeConfig: async () => {},
    });
    await expect(auth.status()).resolves.toEqual({ state: "configured", runtimeReady: true });
  });

  it("reports a valid active custom profile from the daemon without a default local profile", async () => {
    const directory = await configDir();
    const auth = createChatGptAuth({
      configDir: directory,
      openExternal: async () => {},
      applyRuntimeConfig: async () => {},
      getRuntimeConfig: async () => runtimeSnapshot("openai-codex", true),
    });

    await expect(hasChatGptProfile(directory)).resolves.toBe(false);
    await expect(auth.status()).resolves.toEqual({ state: "configured", runtimeReady: true });
  });

  it("falls back to local default-profile status when the daemon read is unavailable", async () => {
    const directory = await configDir();
    await writeChatGptProfile(directory, credentials());
    const auth = createChatGptAuth({
      configDir: directory,
      openExternal: async () => {},
      applyRuntimeConfig: async () => {},
      getRuntimeConfig: async () => {
        throw new TypeError("synthetic daemon unavailable");
      },
    });

    await expect(auth.status()).resolves.toEqual({ state: "configured", runtimeReady: false });
  });

  it("refuses concurrent login and maps callback, storage, and runtime failures", async () => {
    const directory = await configDir();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const auth = createChatGptAuth({
      configDir: directory,
      openExternal: async () => {},
      applyRuntimeConfig: async () => {},
      dependencies: {
        loginCodex: async () => {
          await gate;
          return credentials();
        },
      },
    });
    const first = auth.login("first", selection());
    await expect(auth.login("second", selection())).resolves.toEqual({
      status: "refused",
      operationId: "second",
      reason: "already-in-progress",
    });
    release();
    await expect(first).resolves.toEqual({ status: "stored", operationId: "first" });

    const callback = createChatGptAuth({
      configDir: directory,
      openExternal: async () => {},
      applyRuntimeConfig: async () => {},
      dependencies: {
        loginCodex: async (options) => {
          await options.onPrompt({
            message: "obviously-fake",
            signal: options.signal ?? new AbortController().signal,
          });
          return credentials();
        },
      },
    });
    await expect(callback.login("callback", selection())).resolves.toEqual({
      status: "refused",
      operationId: "callback",
      reason: "callback-unavailable",
    });

    const storage = createChatGptAuth({
      configDir: directory,
      openExternal: async () => {},
      applyRuntimeConfig: async () => {},
      dependencies: {
        loginCodex: async () => credentials(),
        writeProfile: async () => {
          throw new TypeError();
        },
      },
    });
    await expect(storage.login("storage", selection())).resolves.toEqual({
      status: "refused",
      operationId: "storage",
      reason: "storage-failed",
    });

    const runtime = createChatGptAuth({
      configDir: directory,
      openExternal: async () => {},
      applyRuntimeConfig: async () => {
        throw new TypeError();
      },
      dependencies: { loginCodex: async () => credentials() },
    });
    await expect(runtime.login("runtime", selection())).resolves.toEqual({
      status: "stored",
      operationId: "runtime",
    });
    await expect(runtime.activate(selection())).resolves.toEqual({
      status: "refused",
      reason: "runtime-unavailable",
    });
  });

  it("reports a saved ChatGPT profile as inactive after an API-key provider is selected", async () => {
    const directory = await configDir();
    let provider: LlmProvider = "anthropic";
    const auth = createChatGptAuth({
      configDir: directory,
      openExternal: async () => {},
      applyRuntimeConfig: async (request) => {
        provider = request.llm?.provider ?? provider;
        await writeFile(
          join(directory, "config.yaml"),
          `llm:\n  provider: ${request.llm?.provider}\n  model: ${request.llm?.model}\n`,
        );
      },
      getRuntimeConfig: async () => runtimeSnapshot(provider),
      dependencies: { loginCodex: async () => credentials() },
    });
    await expect(auth.login("inactive-profile", selection())).resolves.toEqual({
      status: "stored",
      operationId: "inactive-profile",
    });
    await expect(auth.status()).resolves.toEqual({ state: "configured", runtimeReady: false });

    await writeFile(
      join(directory, "config.yaml"),
      "llm:\n  provider: openrouter\n  model: deepseek/deepseek-v4-flash\n",
    );
    provider = "openrouter";

    await expect(auth.status()).resolves.toEqual({ state: "configured", runtimeReady: false });
  });
});
