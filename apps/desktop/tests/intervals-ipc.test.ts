import { EventEmitter } from "node:events";
import {
  INTERVALS_CREDENTIAL_REQUEST_TIMEOUT_MS,
  INTERVALS_CREDENTIAL_VERIFICATION_TIMEOUT_MS,
  verifyIntervalsCredentialAtPath,
  type IntervalsCredentialVerificationResult,
} from "@enduragent/coach/backfill";
import {
  CoachClientTransportUnavailableError,
  CoachRpcRemoteError,
} from "@enduragent/coach-client";
import type { RuntimeConfigSnapshot } from "@enduragent/coach-contract";
import {
  IntervalsSignInError,
  type IntervalsOAuthGrant,
  type IntervalsSignInFailure,
  type IntervalsSignInOptions,
} from "@enduragent/core";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  DESKTOP_INTERVALS_SIGN_IN_CANCEL_CHANNEL,
  DESKTOP_INTERVALS_SIGN_IN_CHANNEL,
  DESKTOP_INTERVALS_SIGN_IN_PROGRESS_CHANNEL,
  DESKTOP_INTERVALS_SIGN_IN_REOPEN_CHANNEL,
} from "../src/main/constants.js";
import { createActiveIntervalsCredentialPreflight } from "../src/main/credential-runtime.js";
import {
  CredentialRuntimeRefusal,
  createCredentialVault,
  type CredentialVault,
  type CredentialWriteBehavior,
  type CredentialWriteResult,
} from "../src/main/credential-vault.js";
import {
  createDesktopIntervalsCredentialVerifier,
  installDesktopIntervalsIpc,
  type DesktopIntervalsCredentialVerificationResult,
  type DesktopIntervalsCredentialStatus,
} from "../src/main/intervals-ipc.js";
import { createDesktopRendererUrl } from "../src/main/renderer-navigation.js";

const API_KEY = "synthetic-intervals-api-key";
const CREDENTIAL = "intervals-oauth:fixture-token";
const EXISTING_CREDENTIAL = "intervals-oauth:fixture-existing-token";
const ATHLETE_NAME = "Test Athlete";
const AUTHORIZE_URL = "https://intervals.icu/oauth/authorize?client_id=fixture&state=fixture";
const RENDERER_URL = createDesktopRendererUrl("n".repeat(43));
const APPROVAL = "a".repeat(64);
const PRIVATE_DETAIL = `${CREDENTIAL} at /Users/private/id_ed25519 PRIVATE_KEY`;
const SIGN_IN_CHANNELS = [
  DESKTOP_INTERVALS_SIGN_IN_CHANNEL,
  DESKTOP_INTERVALS_SIGN_IN_CANCEL_CHANNEL,
  DESKTOP_INTERVALS_SIGN_IN_REOPEN_CHANNEL,
] as const;

type SignIn = (options: IntervalsSignInOptions) => Promise<IntervalsOAuthGrant>;

function deferred<T>() {
  const settle: { resolve?: (value: T) => void; reject?: (error: unknown) => void } = {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    settle.resolve = resolvePromise;
    settle.reject = rejectPromise;
  });
  return {
    promise,
    resolve: (value: T) => settle.resolve?.(value),
    reject: (error: unknown) => settle.reject?.(error),
  };
}

function grant(overrides: Partial<IntervalsOAuthGrant> = {}): IntervalsOAuthGrant {
  return {
    credential: CREDENTIAL,
    scope: "ACTIVITY:READ,WELLNESS:READ,CALENDAR:WRITE,SETTINGS:READ",
    athleteId: "101",
    athleteName: ATHLETE_NAME,
    ...overrides,
  };
}

function status(
  state: DesktopIntervalsCredentialStatus["state"] = "missing",
  runtimeState: DesktopIntervalsCredentialStatus["runtimeState"] = null,
): DesktopIntervalsCredentialStatus {
  return { slot: "intervals-icu", state, runtimeState };
}

function applied(current = status("configured", "active")) {
  return { outcome: "applied", current, athleteName: ATHLETE_NAME };
}

function runtimeSnapshot(athleteId = "synthetic-athlete"): RuntimeConfigSnapshot {
  return {
    schemaVersion: 3,
    llm: {
      provider: "anthropic",
      model: "synthetic-model",
      credential_configured: false,
    },
    intervals: {
      athlete_id: athleteId,
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

function rendererSender(url = RENDERER_URL) {
  const state = { destroyed: false, url };
  const send = vi.fn((_channel: string, _payload: unknown) => undefined);
  const sender = Object.assign(new EventEmitter(), {
    send,
    isDestroyed: () => state.destroyed,
    get mainFrame() {
      if (state.destroyed) throw new TypeError("Object has been destroyed");
      return { url: state.url };
    },
  });
  return { send, sender, state };
}

function controlledSignIn() {
  const outcome = deferred<IntervalsOAuthGrant>();
  const calls: IntervalsSignInOptions[] = [];
  const signIn: SignIn = (input) => {
    calls.push(input);
    return new Promise<IntervalsOAuthGrant>((resolve, reject) => {
      input.signal?.addEventListener("abort", () => reject(new IntervalsSignInError("cancelled")), {
        once: true,
      });
      outcome.promise.then(resolve, reject);
    });
  };
  const options = (): IntervalsSignInOptions => {
    const latest = calls.at(-1);
    if (latest === undefined) throw new Error("sign-in was not started");
    return latest;
  };
  return { calls, options, outcome, signIn };
}

function setup(
  options: {
    readonly trusted?: boolean;
    readonly current?: DesktopIntervalsCredentialStatus;
    readonly grant?: IntervalsOAuthGrant;
    readonly signIn?: SignIn;
    readonly sender?: ReturnType<typeof rendererSender>["sender"];
    readonly verification?: DesktopIntervalsCredentialVerificationResult;
    readonly verifyCredential?: (
      apiKey: string,
      signal: AbortSignal,
    ) => Promise<DesktopIntervalsCredentialVerificationResult>;
    readonly writeResult?: CredentialWriteResult;
    readonly vault?: Pick<CredentialVault, "credentialStatuses" | "runExclusiveMutation">;
  } = {},
) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const removed: string[] = [];
  const trace: string[] = [];
  const trust = { value: options.trusted ?? true };
  let current = options.current ?? status();
  const writeCredential = vi.fn(
    async (input: { readonly value: string }, _behavior?: CredentialWriteBehavior) => {
      trace.push(`write:${input.value}`);
      const result =
        options.writeResult ??
        ({
          slot: "intervals-icu",
          status: "configured",
          runtimeReady: true,
        } as const);
      if (result.status === "configured") {
        current = status("configured", result.runtimeReady ? "active" : "failed");
      }
      return result;
    },
  );
  const credentialStatuses = vi.fn(async () => [current]);
  const defaultVault = {
    credentialStatuses,
    runExclusiveMutation: vi.fn(
      async (
        operation: (mutation: {
          writeCredential: typeof writeCredential;
          credentialStatuses: () => Promise<readonly DesktopIntervalsCredentialStatus[]>;
        }) => Promise<unknown>,
      ) =>
        operation({
          writeCredential,
          credentialStatuses,
        }),
    ),
  };
  const vault = options.vault ?? defaultVault;
  const signIn = vi.fn(
    options.signIn ??
      (async (_input: IntervalsSignInOptions) => {
        trace.push("sign-in");
        return options.grant ?? grant();
      }),
  );
  const openExternal = vi.fn(async (_url: string) => undefined);
  const verifyCredential = vi.fn(
    options.verifyCredential ??
      (async (apiKey: string) => {
        trace.push(`verify:${apiKey}`);
        return options.verification ?? ({ status: "verified" } as const);
      }),
  );
  const appController = new AbortController();
  const dispose = installDesktopIntervalsIpc({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler as never),
      removeHandler: (channel) => removed.push(channel),
    },
    openExternal,
    signIn,
    isTrusted: () => trust.value,
    signal: appController.signal,
    vault: vault as never,
    verifyCredential,
  });
  const sender = options.sender ?? rendererSender().sender;
  const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const handler = handlers.get(channel);
    if (handler === undefined) throw new Error(`no handler for ${channel}`);
    return handler({ sender, senderFrame: {} }, ...args);
  };
  return {
    appController,
    cancel: (...args: unknown[]) => invoke(DESKTOP_INTERVALS_SIGN_IN_CANCEL_CHANNEL, ...args),
    defaultVault,
    dispose,
    handlers,
    invoke,
    openExternal,
    removed,
    reopen: (...args: unknown[]) => invoke(DESKTOP_INTERVALS_SIGN_IN_REOPEN_CHANNEL, ...args),
    signIn: (...args: unknown[]) => invoke(DESKTOP_INTERVALS_SIGN_IN_CHANNEL, ...args),
    signInStub: signIn,
    trace,
    trust,
    vault,
    verifyCredential,
    writeCredential,
  };
}

function testEncryption(
  options: {
    readonly available?: boolean;
    readonly backend?: string;
    readonly platform?: NodeJS.Platform;
  } = {},
) {
  const platform = options.platform ?? process.platform;
  return {
    isEncryptionAvailable: () => options.available ?? true,
    getSelectedStorageBackend: () =>
      options.backend ?? (platform === "win32" ? "dpapi" : "keychain"),
    encryptString: (value: string) =>
      platform === "win32"
        ? Buffer.from(Buffer.from(value, "utf8").map((byte) => byte ^ 0xa5))
        : Buffer.from(`sealed:${value}`, "utf8"),
    decryptString: (value: Buffer) =>
      platform === "win32"
        ? Buffer.from(Buffer.from(value).map((byte) => byte ^ 0xa5)).toString("utf8")
        : value.toString("utf8").slice("sealed:".length),
  };
}

async function temporaryVault(options: {
  readonly available?: boolean;
  readonly backend?: string;
  readonly encryption?: ReturnType<typeof testEncryption>;
  readonly platform?: NodeJS.Platform;
  readonly trace?: string[];
}) {
  const base = await mkdtemp(join(await realpath(tmpdir()), "intervals-ipc-"));
  await mkdir(join(base, "athlete-home"), { mode: 0o700 });
  const trace = options.trace ?? [];
  const clearCredential = vi.fn(async () => {
    trace.push("clear-runtime");
    return "cleared" as const;
  });
  const applyCredential = vi.fn(async (slot: string, value: string) => {
    trace.push(`apply:${slot}:${value}`);
  });
  const root = join(base, "credentials-v1");
  const platform = options.platform ?? process.platform;
  const runtimeState = new Map();
  const vault = createCredentialVault({
    root,
    encryption: options.encryption ?? testEncryption({ ...options, platform }),
    platform,
    runtimeState,
    applyCredential,
    clearCredential,
  });
  return { applyCredential, base, clearCredential, platform, root, runtimeState, trace, vault };
}

function athleteResponse(account = "synthetic-athlete"): Response {
  return new Response(
    JSON.stringify({
      sportSettings: [{ id: 1, athlete_id: account, types: ["Ride"], updated: "2010-01-01" }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function verificationOptions(input: {
  readonly baseFetch: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly compareOwner?: () => Promise<"unowned" | "matched" | "mismatch" | "store-unavailable">;
  readonly overallTimeoutMs?: number;
  readonly perRequestTimeoutMs?: number;
}) {
  return {
    apiKey: API_KEY,
    athleteId: "0",
    historyNewestDate: "1970-01-01",
    clock: { now: () => Date.now(), monotonicNow: () => performance.now() },
    signal: input.signal ?? new AbortController().signal,
    baseFetch: input.baseFetch,
    ...(input.compareOwner === undefined ? {} : { compareOwner: input.compareOwner }),
    ...(input.overallTimeoutMs === undefined ? {} : { overallTimeoutMs: input.overallTimeoutMs }),
    ...(input.perRequestTimeoutMs === undefined
      ? {}
      : { perRequestTimeoutMs: input.perRequestTimeoutMs }),
  };
}

function expectNoSecrets(result: unknown): void {
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain("fixture-token");
  expect(serialized).not.toContain("PRIVATE_KEY");
  expect(serialized).not.toContain(APPROVAL);
}

describe("Desktop Intervals.icu sign-in IPC", () => {
  it("registers the three sign-in handlers and removes them once", async () => {
    const runtime = setup();

    expect([...runtime.handlers.keys()]).toEqual([...SIGN_IN_CHANNELS]);
    const close = runtime.dispose();
    expect(runtime.dispose()).toBe(close);
    expect(runtime.removed).toEqual([...SIGN_IN_CHANNELS]);
    await close;
    for (const channel of SIGN_IN_CHANNELS) {
      await expect(runtime.invoke(channel)).rejects.toBeInstanceOf(TypeError);
    }
    expect(runtime.signInStub).not.toHaveBeenCalled();
  });

  it("verifies and stores the signed-in credential and returns the athlete name", async () => {
    const runtime = setup();

    const result = await runtime.signIn();

    expect(result).toEqual(applied());
    expect(runtime.trace).toEqual(["sign-in", `verify:${CREDENTIAL}`, `write:${CREDENTIAL}`]);
    expect(runtime.signInStub).toHaveBeenCalledOnce();
    const options = runtime.signInStub.mock.calls[0]?.[0];
    expect(options?.openExternal).toBe(runtime.openExternal);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.signal?.aborted).toBe(false);
    expect(runtime.verifyCredential).toHaveBeenCalledWith(CREDENTIAL, expect.any(AbortSignal));
    expect(runtime.writeCredential).toHaveBeenCalledWith(
      { slot: "intervals-icu", value: CREDENTIAL },
      { rollbackOnRuntimeRefusal: true },
    );
    expect(runtime.openExternal).not.toHaveBeenCalled();
    expectNoSecrets(result);
    expect(JSON.stringify(result)).not.toContain('"101"');
  });

  it("omits the athlete name when the grant carries none", async () => {
    const runtime = setup({ grant: grant({ athleteName: "" }) });

    const result = await runtime.signIn();

    expect(result).toEqual({ outcome: "applied", current: status("configured", "active") });
    expect(result).not.toHaveProperty("athleteName");
    expect(runtime.writeCredential).toHaveBeenCalledOnce();
  });

  it("forwards a daemon approval only to activation and never returns it to the renderer", async () => {
    const runtime = setup({
      verifyCredential: async (apiKey) => {
        runtime.trace.push(`preflight:${apiKey}`);
        return { status: "verified", verificationApproval: APPROVAL };
      },
    });

    const result = await runtime.signIn();

    expect(runtime.trace).toEqual(["sign-in", `preflight:${CREDENTIAL}`, `write:${CREDENTIAL}`]);
    expect(runtime.writeCredential).toHaveBeenCalledWith(
      { slot: "intervals-icu", value: CREDENTIAL },
      { rollbackOnRuntimeRefusal: true, verificationApproval: APPROVAL },
    );
    expect(result).toEqual(applied());
    expectNoSecrets(result);
  });

  it.each([
    ["access-denied", "sign-in-denied"],
    ["timed-out", "sign-in-timed-out"],
    ["cancelled", "sign-in-cancelled"],
    ["unreachable", "sign-in-unreachable"],
    ["authorization-failed", "sign-in-failed"],
    ["exchange-failed", "sign-in-failed"],
    ["callback-unavailable", "sign-in-failed"],
  ] as const satisfies ReadonlyArray<readonly [IntervalsSignInFailure, string]>)(
    "maps the %s sign-in failure to %s without touching the vault",
    async (failure, reason) => {
      const runtime = setup({
        current: status("configured", "active"),
        signIn: async () => {
          throw new IntervalsSignInError(failure);
        },
      });

      const result = await runtime.signIn();

      expect(result).toEqual({
        outcome: "refused",
        reason,
        current: status("configured", "active"),
      });
      expect(runtime.verifyCredential).not.toHaveBeenCalled();
      expect(runtime.defaultVault.runExclusiveMutation).not.toHaveBeenCalled();
      expect(runtime.writeCredential).not.toHaveBeenCalled();
    },
  );

  it("maps an unexpected sign-in failure to sign-in-failed without private details", async () => {
    for (const thrown of [
      new Error(PRIVATE_DETAIL),
      { name: "IntervalsSignInError", reason: "access-denied", message: PRIVATE_DETAIL },
    ]) {
      const runtime = setup({
        signIn: async () => {
          throw thrown;
        },
      });

      const result = await runtime.signIn();

      expect(result).toEqual({ outcome: "refused", reason: "sign-in-failed", current: status() });
      expect(runtime.writeCredential).not.toHaveBeenCalled();
      expectNoSecrets(result);
    }
  });

  it("reports the closed status when the status read fails after a sign-in refusal", async () => {
    const runtime = setup({
      signIn: async () => {
        throw new IntervalsSignInError("access-denied");
      },
    });
    runtime.defaultVault.credentialStatuses.mockRejectedValueOnce(new Error(PRIVATE_DETAIL));

    const result = await runtime.signIn();

    expect(result).toEqual({
      outcome: "refused",
      reason: "sign-in-denied",
      current: status("re-prompt", null),
    });
    expectNoSecrets(result);
  });

  it("cancels a waiting sign-in by aborting the signal it was given", async () => {
    const control = controlledSignIn();
    const runtime = setup({ signIn: control.signIn });

    await expect(runtime.cancel()).resolves.toBe(false);
    const pending = runtime.signIn();
    await vi.waitFor(() => expect(control.calls).toHaveLength(1));
    const signal = control.options().signal;
    expect(signal?.aborted).toBe(false);

    await expect(runtime.cancel()).resolves.toBe(true);

    expect(signal?.aborted).toBe(true);
    await expect(pending).resolves.toEqual({
      outcome: "refused",
      reason: "sign-in-cancelled",
      current: status(),
    });
    await expect(runtime.cancel()).resolves.toBe(false);
    expect(runtime.verifyCredential).not.toHaveBeenCalled();
    expect(runtime.writeCredential).not.toHaveBeenCalled();
  });

  it("reopens the last authorize URL only while a sign-in is waiting for it", async () => {
    const control = controlledSignIn();
    const runtime = setup({ signIn: control.signIn });

    await expect(runtime.reopen()).resolves.toBe(false);
    const pending = runtime.signIn();
    await vi.waitFor(() => expect(control.calls).toHaveLength(1));
    await expect(runtime.reopen()).resolves.toBe(false);
    expect(runtime.openExternal).not.toHaveBeenCalled();

    control.options().onAuthorizeUrl?.(AUTHORIZE_URL);
    await expect(runtime.reopen()).resolves.toBe(true);
    expect(runtime.openExternal).toHaveBeenCalledExactlyOnceWith(AUTHORIZE_URL);

    runtime.openExternal.mockRejectedValueOnce(new Error(PRIVATE_DETAIL));
    await expect(runtime.reopen()).resolves.toBe(false);
    expect(runtime.openExternal).toHaveBeenCalledTimes(2);

    control.outcome.resolve(grant());
    await expect(pending).resolves.toEqual(applied());
    await expect(runtime.reopen()).resolves.toBe(false);
    expect(runtime.openExternal).toHaveBeenCalledTimes(2);
  });

  it("refuses cancel and reopen once the browser approved the sign-in", async () => {
    const control = controlledSignIn();
    const runtime = setup({ signIn: control.signIn });

    const pending = runtime.signIn();
    await vi.waitFor(() => expect(control.calls).toHaveLength(1));
    control.options().onAuthorizeUrl?.(AUTHORIZE_URL);
    control.options().onPhase?.("completing-sign-in");
    const signal = control.options().signal;

    await expect(runtime.cancel()).resolves.toBe(false);
    await expect(runtime.reopen()).resolves.toBe(false);
    expect(signal?.aborted).toBe(false);
    expect(runtime.openExternal).not.toHaveBeenCalled();

    control.outcome.resolve(grant());
    await expect(pending).resolves.toEqual(applied());
    expect(runtime.writeCredential).toHaveBeenCalledOnce();
  });

  it("rejects a second sign-in while one is running", async () => {
    const control = controlledSignIn();
    const runtime = setup({ signIn: control.signIn });

    const first = runtime.signIn();
    await vi.waitFor(() => expect(control.calls).toHaveLength(1));

    await expect(runtime.signIn()).rejects.toThrow("desktop Intervals sign-in already running");
    expect(control.calls).toHaveLength(1);
    expect(control.options().signal?.aborted).toBe(false);

    control.outcome.resolve(grant());
    await expect(first).resolves.toEqual(applied());
    expect(runtime.writeCredential).toHaveBeenCalledOnce();

    await expect(runtime.signIn()).resolves.toEqual(applied());
    expect(control.calls).toHaveLength(2);
  });

  it("accepts a new sign-in after a refused one", async () => {
    const failures = [new IntervalsSignInError("access-denied")];
    const runtime = setup({
      signIn: async () => {
        const failure = failures.shift();
        if (failure !== undefined) throw failure;
        return grant();
      },
    });

    await expect(runtime.signIn()).resolves.toMatchObject({ reason: "sign-in-denied" });
    await expect(runtime.signIn()).resolves.toEqual(applied());
    expect(runtime.signInStub).toHaveBeenCalledTimes(2);
  });

  it("publishes progress phases to the live desktop renderer that started the sign-in", async () => {
    const renderer = rendererSender();
    const control = controlledSignIn();
    const runtime = setup({ signIn: control.signIn, sender: renderer.sender });

    const pending = runtime.signIn();
    await vi.waitFor(() => expect(control.calls).toHaveLength(1));
    control.options().onPhase?.("waiting-for-browser");
    control.options().onPhase?.("completing-sign-in");

    expect(renderer.send.mock.calls).toEqual([
      [DESKTOP_INTERVALS_SIGN_IN_PROGRESS_CHANNEL, { phase: "waiting-for-browser" }],
      [DESKTOP_INTERVALS_SIGN_IN_PROGRESS_CHANNEL, { phase: "completing-sign-in" }],
    ]);

    renderer.state.destroyed = true;
    expect(() => control.options().onPhase?.("completing-sign-in")).not.toThrow();
    expect(renderer.send).toHaveBeenCalledTimes(2);

    control.outcome.resolve(grant());
    await expect(pending).resolves.toEqual(applied());
  });

  it.each([
    ["a foreign page", "https://intervals.icu/oauth/authorize"],
    ["a renderer URL with an extra parameter", `${RENDERER_URL}&extra=1`],
    ["a renderer URL without a navigation token", "enduragent://app/index.html"],
  ])("does not publish progress to %s", async (_label, url) => {
    const renderer = rendererSender(url);
    const runtime = setup({
      sender: renderer.sender,
      signIn: async (input) => {
        input.onPhase?.("waiting-for-browser");
        input.onPhase?.("completing-sign-in");
        return grant();
      },
    });

    await expect(runtime.signIn()).resolves.toEqual(applied());
    expect(renderer.send).not.toHaveBeenCalled();
  });

  it("does not publish progress to a renderer destroyed before the first phase", async () => {
    const renderer = rendererSender();
    renderer.state.destroyed = true;
    const runtime = setup({
      sender: renderer.sender,
      signIn: async (input) => {
        input.onPhase?.("waiting-for-browser");
        return grant();
      },
    });

    await expect(runtime.signIn()).resolves.toEqual(applied());
    expect(renderer.send).not.toHaveBeenCalled();
  });

  it("rejects untrusted and extra-argument calls on every sign-in channel", async () => {
    const control = controlledSignIn();
    const runtime = setup({ signIn: control.signIn });
    const pending = runtime.signIn();
    await vi.waitFor(() => expect(control.calls).toHaveLength(1));
    control.options().onAuthorizeUrl?.(AUTHORIZE_URL);

    runtime.trust.value = false;
    for (const channel of SIGN_IN_CHANNELS) {
      await expect(runtime.invoke(channel)).rejects.toThrow("untrusted desktop Intervals request");
    }
    runtime.trust.value = true;
    for (const channel of SIGN_IN_CHANNELS) {
      await expect(runtime.invoke(channel, "extra")).rejects.toThrow(
        "invalid desktop Intervals request",
      );
    }

    expect(control.calls).toHaveLength(1);
    expect(control.options().signal?.aborted).toBe(false);
    expect(runtime.openExternal).not.toHaveBeenCalled();

    const untrusted = setup({ trusted: false });
    await expect(untrusted.signIn()).rejects.toThrow("untrusted desktop Intervals request");
    expect(untrusted.signInStub).not.toHaveBeenCalled();
    expect(untrusted.defaultVault.credentialStatuses).not.toHaveBeenCalled();

    control.outcome.resolve(grant());
    await expect(pending).resolves.toEqual(applied());
  });

  it.each([
    ["   ", undefined],
    ["Test\tAthlete", undefined],
    ["x".repeat(201), undefined],
    ["  Test Athlete  ", "Test Athlete"],
  ])("sends only a displayable athlete name for %j", async (name, expected) => {
    const runtime = setup({ grant: grant({ athleteName: name }) });

    const result = await runtime.signIn();

    expect(result).toEqual(
      expected === undefined
        ? { outcome: "applied", current: status("configured", "active") }
        : { outcome: "applied", current: status("configured", "active"), athleteName: expected },
    );
    expect(runtime.writeCredential).toHaveBeenCalledOnce();
  });

  it("ends the sign-in as failed when the browser cannot open", async () => {
    const control = controlledSignIn();
    const runtime = setup({ signIn: control.signIn });
    const pending = runtime.signIn();
    await vi.waitFor(() => expect(control.calls).toHaveLength(1));

    control.options().onBrowserOpenFailed?.();

    expect(control.options().signal?.aborted).toBe(true);
    await expect(pending).resolves.toEqual({
      outcome: "refused",
      reason: "sign-in-failed",
      current: status(),
    });
    expect(runtime.writeCredential).not.toHaveBeenCalled();
  });

  it("waits for an active sign-in to settle before dispose resolves", async () => {
    const control = controlledSignIn();
    const runtime = setup({ signIn: control.signIn });
    const pending = runtime.signIn();
    await vi.waitFor(() => expect(control.calls).toHaveLength(1));
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    await runtime.dispose();

    expect(settled).toBe(true);
  });

  it("aborts an active sign-in on dispose and removes every handler", async () => {
    const control = controlledSignIn();
    const runtime = setup({ signIn: control.signIn });
    const pending = runtime.signIn();
    await vi.waitFor(() => expect(control.calls).toHaveLength(1));
    const signal = control.options().signal;

    const close = runtime.dispose();

    expect(signal?.aborted).toBe(true);
    expect(runtime.removed).toEqual([...SIGN_IN_CHANNELS]);
    await expect(pending).resolves.toEqual({
      outcome: "refused",
      reason: "sign-in-cancelled",
      current: status(),
    });
    await close;
    expect(runtime.verifyCredential).not.toHaveBeenCalled();
    expect(runtime.writeCredential).not.toHaveBeenCalled();
  });

  it("aborts an active sign-in when the application signal aborts", async () => {
    const control = controlledSignIn();
    const runtime = setup({ signIn: control.signIn });
    const pending = runtime.signIn();
    await vi.waitFor(() => expect(control.calls).toHaveLength(1));

    runtime.appController.abort();

    expect(control.options().signal?.aborted).toBe(true);
    await expect(pending).resolves.toMatchObject({ reason: "sign-in-cancelled" });
    await runtime.dispose();
  });

  it("stops publishing progress after dispose", async () => {
    const renderer = rendererSender();
    const control = controlledSignIn();
    const runtime = setup({ signIn: control.signIn, sender: renderer.sender });
    const pending = runtime.signIn();
    await vi.waitFor(() => expect(control.calls).toHaveLength(1));
    const options = control.options();

    const close = runtime.dispose();
    options.onPhase?.("completing-sign-in");

    expect(renderer.send).not.toHaveBeenCalled();
    await pending;
    await close;
  });

  it("fences new requests, aborts verification, and drains accepted work", async () => {
    const verification = deferred<IntervalsCredentialVerificationResult>();
    let acceptedSignal: AbortSignal | undefined;
    const runtime = setup({
      verifyCredential: async (_apiKey, signal) => {
        acceptedSignal = signal;
        return verification.promise;
      },
    });

    const accepted = runtime.signIn();
    await vi.waitFor(() => expect(runtime.verifyCredential).toHaveBeenCalledOnce());
    const firstClose = runtime.dispose();
    const secondClose = runtime.dispose();

    expect(secondClose).toBe(firstClose);
    expect(acceptedSignal?.aborted).toBe(true);
    await expect(runtime.signIn()).rejects.toBeInstanceOf(TypeError);
    await expect(accepted).resolves.toEqual({
      outcome: "refused",
      reason: "validation-aborted",
      current: status(),
    });
    let drained = false;
    void firstClose.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(runtime.writeCredential).not.toHaveBeenCalled();
    verification.resolve({ status: "verified" });
    await firstClose;
    expect(drained).toBe(true);
  });

  it("bounds the complete verification callback with the production overall deadline", async () => {
    vi.useFakeTimers();
    const verification = deferred<IntervalsCredentialVerificationResult>();
    const runtime = setup({ verifyCredential: async () => verification.promise });
    try {
      const pending = runtime.signIn();
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.verifyCredential).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(INTERVALS_CREDENTIAL_VERIFICATION_TIMEOUT_MS);

      await expect(pending).resolves.toEqual({
        outcome: "refused",
        reason: "validation-timeout",
        current: status(),
      });
      expect(runtime.writeCredential).not.toHaveBeenCalled();
      const close = runtime.dispose();
      verification.resolve({ status: "verified" });
      await close;
    } finally {
      verification.resolve({ status: "verified" });
      vi.useRealTimers();
    }
  });

  it("closes thrown and malformed verification failures without private details", async () => {
    const thrown = setup({
      verifyCredential: async () => {
        throw new Error(PRIVATE_DETAIL);
      },
    });
    const thrownResult = await thrown.signIn();
    expect(thrownResult).toEqual({
      outcome: "refused",
      reason: "validation-unavailable",
      current: status(),
    });

    const malformed = setup({
      verifyCredential: async () =>
        ({
          status: "refused",
          reason: "credential-rejected",
          apiKey: CREDENTIAL,
        }) as never,
    });
    const malformedResult = await malformed.signIn();
    expect(malformedResult).toEqual({
      outcome: "refused",
      reason: "validation-unavailable",
      current: status(),
    });

    for (const result of [thrownResult, malformedResult]) expectNoSecrets(result);
    expect(thrown.writeCredential).not.toHaveBeenCalled();
    expect(malformed.writeCredential).not.toHaveBeenCalled();
  });

  it.each(["encryption-unavailable", "unsafe-backend"] as const)(
    "passes through the closed %s storage refusal",
    async (reason) => {
      const value = await temporaryVault({
        available: reason !== "encryption-unavailable",
        ...(reason === "unsafe-backend" ? { backend: "basic_text", platform: "darwin" } : {}),
      });
      try {
        const runtime = setup({ vault: value.vault });
        const result = await runtime.signIn();

        expect(result).toEqual({ outcome: "refused", reason, current: status() });
        expect(value.applyCredential).not.toHaveBeenCalled();
        expectNoSecrets(result);
      } finally {
        await rm(value.base, { recursive: true, force: true });
      }
    },
  );

  it("reports secure-storage write failure after successful verification", async () => {
    const encryption = {
      ...testEncryption(),
      encryptString: () => {
        throw new Error(PRIVATE_DETAIL);
      },
    };
    const value = await temporaryVault({ encryption });
    try {
      const runtime = setup({ vault: value.vault });

      const result = await runtime.signIn();

      expect(runtime.verifyCredential).toHaveBeenCalledOnce();
      expect(result).toEqual({ outcome: "refused", reason: "storage-failed", current: status() });
      expect(value.applyCredential).not.toHaveBeenCalled();
      expectNoSecrets(result);
      expect(JSON.stringify(result)).not.toContain("credential-rejected");
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it
    .skipIf(process.platform === "win32")
    .each(["encryption-unavailable", "unsafe-backend"] as const)(
    "preserves an existing credential across the %s storage refusal",
    async (reason) => {
      const security = { available: true, backend: "keychain" };
      const encryption = {
        isEncryptionAvailable: () => security.available,
        getSelectedStorageBackend: () => security.backend,
        encryptString: (value: string) => Buffer.from(`sealed:${value}`, "utf8"),
        decryptString: (value: Buffer) => value.toString("utf8").slice("sealed:".length),
      };
      const value = await temporaryVault({ encryption });
      try {
        await value.vault.writeCredential({ slot: "intervals-icu", value: EXISTING_CREDENTIAL });
        const before = await readFile(join(value.root, "intervals-icu.bin"));
        value.applyCredential.mockClear();
        if (reason === "encryption-unavailable") security.available = false;
        else security.backend = "basic_text";
        const runtime = setup({ vault: value.vault });

        await expect(runtime.signIn()).resolves.toEqual({
          outcome: "refused",
          reason,
          current: status("configured", "active"),
        });
        expect(await readFile(join(value.root, "intervals-icu.bin"))).toEqual(before);
        expect(value.applyCredential).not.toHaveBeenCalled();
      } finally {
        await rm(value.base, { recursive: true, force: true });
      }
    },
  );

  it("rejects widened vault results without copying secrets", async () => {
    const runtime = setup({
      writeResult: {
        slot: "intervals-icu",
        status: "configured",
        runtimeReady: true,
        apiKey: CREDENTIAL,
      } as never,
    });

    const result = await runtime.signIn();

    expect(result).toEqual({
      outcome: "uncertain",
      reason: "storage-uncertain",
      current: status("re-prompt", null),
    });
    expectNoSecrets(result);
    expect(runtime.defaultVault.credentialStatuses).not.toHaveBeenCalled();
  });

  it("rejects widened status snapshots without copying secrets", async () => {
    const runtime = setup();
    runtime.defaultVault.credentialStatuses.mockResolvedValueOnce([
      { ...status("configured", "active"), privateDetail: PRIVATE_DETAIL },
    ] as never);

    const result = await runtime.signIn();

    expect(result).toEqual({
      outcome: "uncertain",
      reason: "storage-uncertain",
      current: status("re-prompt", null),
    });
    expect(runtime.writeCredential).toHaveBeenCalledOnce();
    expect(runtime.defaultVault.credentialStatuses).toHaveBeenCalledOnce();
    expectNoSecrets(result);
  });

  it.each([
    "credential-rejected",
    "malformed-athlete-response",
    "validation-timeout",
    "validation-aborted",
    "validation-unavailable",
    "training-account-mismatch",
    "owner-unresolved",
    "store-unavailable",
  ] as const)("passes through the metadata-only %s verification refusal", async (reason) => {
    const runtime = setup({
      current: status("configured", "active"),
      verification: { status: "refused", reason },
    });

    const result = await runtime.signIn();

    expect(result).toEqual({
      outcome: "refused",
      reason,
      current: status("configured", "active"),
    });
    expect(result).not.toHaveProperty("athleteName");
    expect(runtime.writeCredential).not.toHaveBeenCalled();
    expectNoSecrets(result);
  });

  for (const { platform, expectedCiphertext } of [
    {
      platform: "darwin",
      expectedCiphertext: Buffer.from(`sealed:${EXISTING_CREDENTIAL}`, "utf8"),
    },
    {
      platform: "win32",
      expectedCiphertext: Buffer.from(
        Buffer.from(EXISTING_CREDENTIAL, "utf8").map((byte) => byte ^ 0xa5),
      ),
    },
  ] as const) {
    it.skipIf(process.platform === "win32" && platform === "darwin")(
      "keeps an existing encrypted credential and runtime state unchanged after verification refusal",
      async () => {
        const value = await temporaryVault({ platform });
        try {
          await expect(
            value.vault.writeCredential({ slot: "intervals-icu", value: EXISTING_CREDENTIAL }),
          ).resolves.toMatchObject({ status: "configured", runtimeReady: true });
          const before = await readFile(join(value.root, "intervals-icu.bin"));
          expect(before).toEqual(expectedCiphertext);
          value.applyCredential.mockClear();
          const runtime = setup({
            vault: value.vault,
            verification: { status: "refused", reason: "training-account-mismatch" },
          });

          await expect(runtime.signIn()).resolves.toEqual({
            outcome: "refused",
            reason: "training-account-mismatch",
            current: status("configured", "active"),
          });

          expect(await readFile(join(value.root, "intervals-icu.bin"))).toEqual(before);
          expect(value.applyCredential).not.toHaveBeenCalled();
          await expect(value.vault.credentialStatuses()).resolves.toContainEqual(
            status("configured", "active"),
          );
        } finally {
          await rm(value.base, { recursive: true, force: true });
        }
      },
    );
  }

  it("retains a coherent verified candidate when runtime application is uncertain", async () => {
    const value = await temporaryVault({});
    try {
      await expect(
        value.vault.writeCredential({ slot: "intervals-icu", value: EXISTING_CREDENTIAL }),
      ).resolves.toMatchObject({ status: "configured", runtimeReady: true });
      const before = await readFile(join(value.root, "intervals-icu.bin"));
      let appliedRuntimeCredential = EXISTING_CREDENTIAL;
      value.applyCredential.mockReset();
      value.applyCredential.mockImplementationOnce(async (_slot, candidate) => {
        appliedRuntimeCredential = candidate;
        throw new Error(PRIVATE_DETAIL);
      });
      const runtime = setup({ vault: value.vault });

      const result = await runtime.signIn();

      expect(result).toEqual({
        outcome: "uncertain",
        reason: "runtime-uncertain",
        current: status("configured", "failed"),
      });
      expect(await readFile(join(value.root, "intervals-icu.bin"))).not.toEqual(before);
      const ciphertext = await readFile(join(value.root, "intervals-icu.bin"));
      if (value.platform === "win32") {
        expect(ciphertext.includes(Buffer.from(CREDENTIAL, "utf8"))).toBe(false);
      } else {
        expect(ciphertext).toEqual(Buffer.from(`sealed:${CREDENTIAL}`, "utf8"));
      }
      expect(appliedRuntimeCredential).toBe(CREDENTIAL);
      expect(value.applyCredential).toHaveBeenCalledOnce();
      await expect(value.vault.credentialStatuses()).resolves.toContainEqual(
        status("configured", "failed"),
      );
      expectNoSecrets(result);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it("retains an initial verified candidate when runtime application is uncertain", async () => {
    const value = await temporaryVault({});
    try {
      let ownerClaimed = false;
      value.applyCredential.mockImplementationOnce(async () => {
        ownerClaimed = true;
        throw new Error(PRIVATE_DETAIL);
      });
      const runtime = setup({ vault: value.vault });

      await expect(runtime.signIn()).resolves.toEqual({
        outcome: "uncertain",
        reason: "runtime-uncertain",
        current: status("configured", "failed"),
      });
      const ciphertext = await readFile(join(value.root, "intervals-icu.bin"));
      if (value.platform === "win32") {
        expect(ciphertext.includes(Buffer.from(CREDENTIAL, "utf8"))).toBe(false);
      } else {
        expect(ciphertext).toEqual(Buffer.from(`sealed:${CREDENTIAL}`, "utf8"));
      }
      expect(ownerClaimed).toBe(true);
      expect(value.clearCredential).not.toHaveBeenCalled();
      await expect(value.vault.credentialStatuses()).resolves.toContainEqual(
        status("configured", "failed"),
      );
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it("replaces a configured sign-in that intervals.icu stopped accepting", async () => {
    const value = await temporaryVault({});
    try {
      await value.vault.writeCredential({ slot: "intervals-icu", value: EXISTING_CREDENTIAL });
      value.applyCredential.mockClear();
      const runtime = setup({ vault: value.vault });

      await expect(runtime.signIn()).resolves.toEqual(applied());

      expect(runtime.verifyCredential).toHaveBeenCalledWith(CREDENTIAL, expect.any(AbortSignal));
      expect(value.applyCredential).toHaveBeenCalledExactlyOnceWith("intervals-icu", CREDENTIAL);
      await value.vault.reapplyConfigured();
      expect(value.applyCredential).toHaveBeenLastCalledWith("intervals-icu", CREDENTIAL);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it("keeps the configured sign-in when the new one belongs to another athlete", async () => {
    const value = await temporaryVault({});
    try {
      await value.vault.writeCredential({ slot: "intervals-icu", value: EXISTING_CREDENTIAL });
      const before = await readFile(join(value.root, "intervals-icu.bin"));
      value.applyCredential.mockClear();
      const runtime = setup({
        vault: value.vault,
        verification: { status: "refused", reason: "training-account-mismatch" },
      });

      await expect(runtime.signIn()).resolves.toEqual({
        outcome: "refused",
        reason: "training-account-mismatch",
        current: status("configured", "active"),
      });
      expect(await readFile(join(value.root, "intervals-icu.bin"))).toEqual(before);
      expect(value.applyCredential).not.toHaveBeenCalled();
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it("rolls back a known late training-account mismatch", async () => {
    const value = await temporaryVault({});
    try {
      await value.vault.writeCredential({ slot: "intervals-icu", value: EXISTING_CREDENTIAL });
      const before = await readFile(join(value.root, "intervals-icu.bin"));
      value.applyCredential.mockReset();
      value.applyCredential.mockRejectedValueOnce(
        new CredentialRuntimeRefusal("training-account-mismatch"),
      );
      const runtime = setup({ vault: value.vault });

      await expect(runtime.signIn()).resolves.toEqual({
        outcome: "refused",
        reason: "training-account-mismatch",
        current: status("configured", "active"),
      });
      expect(await readFile(join(value.root, "intervals-icu.bin"))).toEqual(before);
      expect(value.applyCredential).toHaveBeenCalledOnce();
      await expect(value.vault.credentialStatuses()).resolves.toContainEqual(
        status("configured", "active"),
      );
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it("removes an initial write and clears its runtime state after a known late refusal", async () => {
    const value = await temporaryVault({});
    try {
      value.applyCredential.mockRejectedValueOnce(
        new CredentialRuntimeRefusal("training-account-mismatch"),
      );
      const runtime = setup({ vault: value.vault });

      await expect(runtime.signIn()).resolves.toEqual({
        outcome: "refused",
        reason: "training-account-mismatch",
        current: status(),
      });
      await expect(readFile(join(value.root, "intervals-icu.bin"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(value.vault.credentialStatuses()).resolves.toContainEqual(status());
      expect(value.runtimeState.has("intervals-icu")).toBe(false);
      expect(value.clearCredential).not.toHaveBeenCalled();
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it("reports storage uncertainty when restoring the previous ciphertext fails", async () => {
    const value = await temporaryVault({});
    try {
      await value.vault.writeCredential({ slot: "intervals-icu", value: EXISTING_CREDENTIAL });
      const before = await readFile(join(value.root, "intervals-icu.bin"));
      let createIdCalls = 0;
      const applyCredential = vi.fn(async () => {
        throw new CredentialRuntimeRefusal("training-account-mismatch");
      });
      const vault = createCredentialVault({
        root: value.root,
        encryption: testEncryption(),
        applyCredential,
        createId: () => {
          createIdCalls += 1;
          if (createIdCalls === 2) throw new TypeError(PRIVATE_DETAIL);
          return "candidate-write";
        },
      });
      const runtime = setup({ vault });

      const result = await runtime.signIn();

      expect(result).toEqual({
        outcome: "uncertain",
        reason: "storage-uncertain",
        current: status("re-prompt", null),
      });
      expect(await readFile(join(value.root, "intervals-icu.bin"))).not.toEqual(before);
      expect(createIdCalls).toBe(2);
      expect(applyCredential).toHaveBeenCalledOnce();
      expectNoSecrets(result);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it("maps other late runtime refusals to runtime unavailable", async () => {
    const value = await temporaryVault({});
    try {
      value.applyCredential.mockRejectedValueOnce(
        new CredentialRuntimeRefusal("ownership-unavailable"),
      );
      const runtime = setup({ vault: value.vault });

      const result = await runtime.signIn();

      expect(result).toEqual({
        outcome: "refused",
        reason: "runtime-unavailable",
        current: status(),
      });
      await expect(readFile(join(value.root, "intervals-icu.bin"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expectNoSecrets(result);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it("serializes verification and commit with generic vault writes and deletes", async () => {
    const trace: string[] = [];
    const value = await temporaryVault({ trace });
    try {
      await value.vault.writeCredential({ slot: "intervals-icu", value: EXISTING_CREDENTIAL });
      trace.splice(0);
      const verification = deferred<IntervalsCredentialVerificationResult>();
      const runtime = setup({
        vault: value.vault,
        verifyCredential: async () => {
          trace.push("verify");
          return verification.promise;
        },
      });

      const signIn = runtime.signIn();
      await vi.waitFor(() => expect(trace).toEqual(["verify"]));
      const genericWrite = value.vault.writeCredential({
        slot: "anthropic",
        value: "synthetic-model-key",
      });
      const genericDelete = value.vault.deleteCredential("intervals-icu");
      await Promise.resolve();

      expect(trace).toEqual(["verify"]);
      expect(value.clearCredential).not.toHaveBeenCalled();

      verification.resolve({ status: "verified" });
      await expect(genericWrite).resolves.toMatchObject({ status: "configured" });
      await expect(genericDelete).resolves.toMatchObject({ status: "deleted" });
      await expect(signIn).resolves.toEqual(applied());
      expect(trace).toEqual([
        "verify",
        `apply:intervals-icu:${CREDENTIAL}`,
        "apply:anthropic:synthetic-model-key",
        "clear-runtime",
      ]);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });
});

describe("Intervals.icu credential verification", () => {
  it("pins the overall and per-request production deadlines", () => {
    expect(INTERVALS_CREDENTIAL_VERIFICATION_TIMEOUT_MS).toBe(20_000);
    expect(INTERVALS_CREDENTIAL_REQUEST_TIMEOUT_MS).toBe(8_000);
  });

  it("refuses verification when the active runtime configuration is unavailable", async () => {
    const signal = new AbortController().signal;
    const readRuntimeConfig = vi.fn(async () => {
      throw new Error(PRIVATE_DETAIL);
    });
    const verifyCredential = createDesktopIntervalsCredentialVerifier({
      storePath: "/synthetic/unavailable-store.db",
      readRuntimeConfig,
    });

    const result = await verifyCredential(API_KEY, signal);

    expect(result).toEqual({ status: "refused", reason: "validation-unavailable" });
    expect(readRuntimeConfig).toHaveBeenCalledOnce();
    expect(readRuntimeConfig).toHaveBeenCalledWith(signal);
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_KEY");
  });

  it("uses daemon preflight without a main-process fetch and preserves refusal mappings", async () => {
    const readRuntimeConfig = vi.fn(async () => runtimeSnapshot());
    const accepted = createDesktopIntervalsCredentialVerifier({
      storePath: "/synthetic/store.db",
      readRuntimeConfig,
      verifyWithDaemon: async () => ({ approval: APPROVAL }),
    });

    await expect(accepted(API_KEY, new AbortController().signal)).resolves.toEqual({
      status: "verified",
      verificationApproval: APPROVAL,
    });
    expect(readRuntimeConfig).not.toHaveBeenCalled();

    for (const reason of [
      "credential-rejected",
      "malformed-athlete-response",
      "validation-timeout",
      "validation-aborted",
      "validation-unavailable",
      "training-account-mismatch",
      "owner-unresolved",
      "store-unavailable",
    ] as const) {
      const refused = createDesktopIntervalsCredentialVerifier({
        storePath: "/synthetic/store.db",
        readRuntimeConfig,
        verifyWithDaemon: async () => ({ reason }),
      });
      await expect(refused(API_KEY, new AbortController().signal)).resolves.toEqual({
        status: "refused",
        reason,
      });
    }
    expect(readRuntimeConfig).not.toHaveBeenCalled();
  });

  it("uses the legacy tokenless lane when an old daemon has no preflight method", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "intervals-fallback-"));
    const storePath = join(root, "store.db");
    const store = new DatabaseSync(storePath);
    store.exec(
      "CREATE TABLE store_owner (singleton INTEGER PRIMARY KEY, account_fingerprint TEXT NOT NULL)",
    );
    store.close();
    const readRuntimeConfig = vi.fn(async (_signal?: AbortSignal) => runtimeSnapshot(""));
    const verifyIntervalsCredential = vi.fn(async () => {
      throw new CoachRpcRemoteError(-32601, "synthetic method unavailable");
    });
    const binding = { authority: { verifyIntervalsCredential } };
    const verifyWithDaemon = vi.fn(
      createActiveIntervalsCredentialPreflight({
        currentBinding: () => binding,
        lifecycleSnapshot: () => ({ status: "ready", generation: 1 }),
      }),
    );
    const fetch = vi.fn(async () => athleteResponse());
    vi.stubGlobal("fetch", fetch);
    try {
      const verifyCredential = createDesktopIntervalsCredentialVerifier({
        storePath,
        readRuntimeConfig,
        verifyWithDaemon,
      });
      const runtime = setup({ verifyCredential });

      await expect(runtime.signIn()).resolves.toEqual(applied());
      expect(verifyWithDaemon).toHaveBeenCalledOnce();
      expect(verifyWithDaemon).toHaveBeenCalledWith(CREDENTIAL, expect.any(AbortSignal));
      expect(verifyIntervalsCredential).toHaveBeenCalledOnce();
      expect(readRuntimeConfig).toHaveBeenCalledOnce();
      expect(readRuntimeConfig).toHaveBeenCalledWith(expect.any(AbortSignal));
      expect(readRuntimeConfig.mock.calls[0]?.[0]).toBe(verifyWithDaemon.mock.calls[0]?.[1]);
      expect(fetch).toHaveBeenCalledOnce();
      expect(runtime.writeCredential).toHaveBeenCalledOnce();
      expect(runtime.writeCredential.mock.calls[0]?.[1]).toEqual({
        rollbackOnRuntimeRefusal: true,
      });
    } finally {
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses after one transport attempt without reading config or writing the vault", async () => {
    const readRuntimeConfig = vi.fn(async () => runtimeSnapshot(""));
    const verifyIntervalsCredential = vi.fn(async () => {
      throw new CoachClientTransportUnavailableError();
    });
    const binding = { authority: { verifyIntervalsCredential } };
    const verifyWithDaemon = vi.fn(
      createActiveIntervalsCredentialPreflight({
        currentBinding: () => binding,
        lifecycleSnapshot: () => ({ status: "ready", generation: 1 }),
      }),
    );
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      const verifyCredential = createDesktopIntervalsCredentialVerifier({
        storePath: "/synthetic/store.db",
        readRuntimeConfig,
        verifyWithDaemon,
      });
      const runtime = setup({ verifyCredential });

      await expect(runtime.signIn()).resolves.toEqual({
        outcome: "refused",
        reason: "validation-unavailable",
        current: status(),
      });
      expect(verifyWithDaemon).toHaveBeenCalledOnce();
      expect(verifyIntervalsCredential).toHaveBeenCalledOnce();
      expect(readRuntimeConfig).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(runtime.writeCredential).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the lifecycle-not-ready refusal on the zero-connection legacy lane", async () => {
    const lifecycle = { status: "starting", generation: 1 };
    const verifyIntervalsCredential = vi.fn(async () => ({ approval: APPROVAL }));
    const binding = { authority: { verifyIntervalsCredential } };
    const configConnection = vi.fn(async () => runtimeSnapshot(""));
    const verifyWithDaemon = vi.fn(
      createActiveIntervalsCredentialPreflight({
        currentBinding: () => binding,
        lifecycleSnapshot: () => lifecycle,
      }),
    );
    const readRuntimeConfig = vi.fn(async () => {
      if (lifecycle.status !== "ready") throw new TypeError();
      return configConnection();
    });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      const verifyCredential = createDesktopIntervalsCredentialVerifier({
        storePath: "/synthetic/store.db",
        readRuntimeConfig,
        verifyWithDaemon,
      });
      const runtime = setup({ verifyCredential });

      await expect(runtime.signIn()).resolves.toEqual({
        outcome: "refused",
        reason: "validation-unavailable",
        current: status(),
      });
      expect(verifyWithDaemon).toHaveBeenCalledOnce();
      expect(readRuntimeConfig).toHaveBeenCalledOnce();
      expect(verifyIntervalsCredential).not.toHaveBeenCalled();
      expect(configConnection).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(runtime.writeCredential).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("verifies a valid key before accepting a matching or ownerless store", async () => {
    for (const comparison of ["matched", "unowned"] as const) {
      const compareOwner = vi.fn(async () => comparison);

      await expect(
        verifyIntervalsCredentialAtPath(
          "/synthetic/store.db",
          verificationOptions({
            baseFetch: vi.fn(async () => athleteResponse()),
            compareOwner,
          }),
        ),
      ).resolves.toEqual({ status: "verified" });
      expect(compareOwner).toHaveBeenCalledWith(
        "/synthetic/store.db",
        expect.stringMatching(/^[0-9a-f]{64}$/),
      );
    }
  });

  it("does not claim an ownerless store while validating it", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "intervals-owner-"));
    const storePath = join(root, "store.db");
    const store = new DatabaseSync(storePath);
    store.exec(
      "CREATE TABLE store_owner (singleton INTEGER PRIMARY KEY, account_fingerprint TEXT NOT NULL)",
    );
    store.close();
    try {
      await expect(
        verifyIntervalsCredentialAtPath(
          storePath,
          verificationOptions({ baseFetch: vi.fn(async () => athleteResponse()) }),
        ),
      ).resolves.toEqual({ status: "verified" });

      const reopened = new DatabaseSync(storePath, { readOnly: true });
      try {
        expect(reopened.prepare("SELECT count(*) AS count FROM store_owner").get()).toEqual({
          count: 0,
        });
      } finally {
        reopened.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([401, 403])("classifies HTTP %s as a credential rejection", async (httpStatus) => {
    const result = await verifyIntervalsCredentialAtPath(
      "/synthetic/store.db",
      verificationOptions({
        baseFetch: vi.fn(
          async () =>
            new Response("", {
              status: httpStatus,
              headers: { "content-type": "application/json" },
            }),
        ),
      }),
    );

    expect(result).toEqual({ status: "refused", reason: "credential-rejected" });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it("classifies a malformed athlete response without exposing it", async () => {
    for (const body of [
      `{"private":"${PRIVATE_DETAIL}"`,
      JSON.stringify({
        sportSettings: [{ id: 1, types: ["Ride"], updated: "2010-01-01" }],
      }),
    ]) {
      const result = await verifyIntervalsCredentialAtPath(
        "/synthetic/store.db",
        verificationOptions({
          baseFetch: vi.fn(
            async () =>
              new Response(body, {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
          ),
        }),
      );

      expect(result).toEqual({ status: "refused", reason: "malformed-athlete-response" });
      expect(JSON.stringify(result)).not.toContain(API_KEY);
      expect(JSON.stringify(result)).not.toContain("PRIVATE_KEY");
    }
  });

  it("preserves transport and timeout classification while reading the response body", async () => {
    const failedBody = (): ReadableStream<Uint8Array> =>
      new ReadableStream({
        start(controller) {
          controller.error(new Error(PRIVATE_DETAIL));
        },
      });

    await expect(
      verifyIntervalsCredentialAtPath(
        "/synthetic/store.db",
        verificationOptions({
          baseFetch: vi.fn(
            async () =>
              new Response(failedBody(), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
          ),
        }),
      ),
    ).resolves.toEqual({ status: "refused", reason: "validation-unavailable" });

    await expect(
      verifyIntervalsCredentialAtPath(
        "/synthetic/store.db",
        verificationOptions({
          baseFetch: vi.fn(
            async () =>
              new Response(failedBody(), {
                status: 401,
                headers: { "content-type": "application/json" },
              }),
          ),
        }),
      ),
    ).resolves.toEqual({ status: "refused", reason: "credential-rejected" });

    await expect(
      verifyIntervalsCredentialAtPath(
        "/synthetic/store.db",
        verificationOptions({
          baseFetch: vi.fn(
            async () =>
              new Response(new ReadableStream<Uint8Array>({ start() {} }), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
          ),
          overallTimeoutMs: 100,
          perRequestTimeoutMs: 5,
        }),
      ),
    ).resolves.toEqual({ status: "refused", reason: "validation-timeout" });
  });

  it("distinguishes an owner-unresolved valid response", async () => {
    const compareOwner = vi.fn();
    const result = await verifyIntervalsCredentialAtPath(
      "/synthetic/store.db",
      verificationOptions({
        baseFetch: vi.fn(
          async () =>
            new Response(JSON.stringify({ sportSettings: [] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
        ),
        compareOwner,
      }),
    );

    expect(result).toEqual({ status: "refused", reason: "owner-unresolved" });
    expect(compareOwner).not.toHaveBeenCalled();
  });

  it("distinguishes request timeout, shutdown abort, and offline transport", async () => {
    const neverFetch = vi.fn(() => new Promise<Response>(() => {}));
    await expect(
      verifyIntervalsCredentialAtPath(
        "/synthetic/store.db",
        verificationOptions({
          baseFetch: neverFetch,
          overallTimeoutMs: 100,
          perRequestTimeoutMs: 5,
        }),
      ),
    ).resolves.toEqual({ status: "refused", reason: "validation-timeout" });

    const shutdown = new AbortController();
    const aborted = verifyIntervalsCredentialAtPath(
      "/synthetic/store.db",
      verificationOptions({
        baseFetch: neverFetch,
        signal: shutdown.signal,
        overallTimeoutMs: 100,
        perRequestTimeoutMs: 50,
      }),
    );
    shutdown.abort(new Error(PRIVATE_DETAIL));
    await expect(aborted).resolves.toEqual({
      status: "refused",
      reason: "validation-aborted",
    });

    await expect(
      verifyIntervalsCredentialAtPath(
        "/synthetic/store.db",
        verificationOptions({
          baseFetch: vi.fn(async () => {
            throw new Error(PRIVATE_DETAIL);
          }),
        }),
      ),
    ).resolves.toEqual({ status: "refused", reason: "validation-unavailable" });
  });

  it.each([
    ["mismatch", "training-account-mismatch"],
    ["store-unavailable", "store-unavailable"],
  ] as const)("maps %s store comparison without writing", async (comparison, reason) => {
    const result = await verifyIntervalsCredentialAtPath(
      "/synthetic/store.db",
      verificationOptions({
        baseFetch: vi.fn(async () => athleteResponse()),
        compareOwner: async () => comparison,
      }),
    );

    expect(result).toEqual({ status: "refused", reason });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });
});
