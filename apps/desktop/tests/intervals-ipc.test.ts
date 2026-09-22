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
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { DESKTOP_INTERVALS_PASTE_CREDENTIAL_CHANNEL } from "../src/main/constants.js";
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

const API_KEY = "synthetic-intervals-api-key";
const EXISTING_API_KEY = "synthetic-existing-intervals-key";
const APPROVAL = "a".repeat(64);
const PRIVATE_DETAIL = `${API_KEY} at /Users/private/id_ed25519 PRIVATE_KEY`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function status(
  state: DesktopIntervalsCredentialStatus["state"] = "missing",
  runtimeState: DesktopIntervalsCredentialStatus["runtimeState"] = null,
): DesktopIntervalsCredentialStatus {
  return { slot: "intervals-icu", state, runtimeState };
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

function setup(
  options: {
    readonly trusted?: boolean;
    readonly current?: DesktopIntervalsCredentialStatus;
    readonly verification?: DesktopIntervalsCredentialVerificationResult;
    readonly verifyCredential?: (
      apiKey: string,
      signal: AbortSignal,
    ) => Promise<DesktopIntervalsCredentialVerificationResult>;
    readonly writeResult?: CredentialWriteResult;
    readonly vault?: Pick<CredentialVault, "credentialStatuses" | "runExclusiveMutation">;
    readonly clipboardValue?: string;
  } = {},
) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const removed: string[] = [];
  const trace: string[] = [];
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
  const clipboard = {
    readText: vi.fn(() => {
      trace.push("read");
      return Promise.resolve(options.clipboardValue ?? `  ${API_KEY}  `);
    }),
    clear: vi.fn(() => {
      trace.push("clear");
    }),
  };
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
    clipboard,
    isTrusted: () => options.trusted ?? true,
    signal: appController.signal,
    vault: vault as never,
    verifyCredential,
  });
  const invoke = (...args: unknown[]) =>
    handlers.get(DESKTOP_INTERVALS_PASTE_CREDENTIAL_CHANNEL)!(
      { sender: {}, senderFrame: {} },
      ...args,
    );
  return {
    appController,
    clipboard,
    defaultVault,
    dispose,
    handlers,
    invoke,
    removed,
    trace,
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

describe("Desktop Intervals.icu clipboard IPC", () => {
  it("registers one semantic handler and removes it", () => {
    const runtime = setup();

    expect([...runtime.handlers.keys()]).toEqual([DESKTOP_INTERVALS_PASTE_CREDENTIAL_CHANNEL]);
    const close = runtime.dispose();
    expect(runtime.removed).toEqual([DESKTOP_INTERVALS_PASTE_CREDENTIAL_CHANNEL]);
    return close;
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

    const accepted = Promise.resolve(runtime.invoke());
    await vi.waitFor(() => expect(runtime.verifyCredential).toHaveBeenCalledOnce());
    const firstClose = runtime.dispose();
    const secondClose = runtime.dispose();

    expect(secondClose).toBe(firstClose);
    expect(acceptedSignal?.aborted).toBe(true);
    expect(() => runtime.invoke()).toThrow(TypeError);
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
      const pending = Promise.resolve(runtime.invoke());
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

  it("clears the clipboard before verification or vault work", async () => {
    const runtime = setup();

    const pending = runtime.invoke();
    await Promise.resolve();
    expect(runtime.trace).toEqual(["read", "clear"]);
    expect(runtime.verifyCredential).not.toHaveBeenCalled();
    expect(runtime.defaultVault.runExclusiveMutation).not.toHaveBeenCalled();

    await expect(pending).resolves.toEqual({
      outcome: "applied",
      current: status("configured", "active"),
    });
    expect(runtime.trace).toEqual(["read", "clear", `verify:${API_KEY}`, `write:${API_KEY}`]);
    expect(runtime.verifyCredential).toHaveBeenCalledWith(API_KEY, expect.any(AbortSignal));
    expect(runtime.writeCredential).toHaveBeenCalledWith(
      { slot: "intervals-icu", value: API_KEY },
      { rollbackOnRuntimeRefusal: true },
    );
  });

  it("forwards a daemon approval only to activation and never returns it to the renderer", async () => {
    const runtime = setup({
      verifyCredential: async (apiKey) => {
        runtime.trace.push(`preflight:${apiKey}`);
        return { status: "verified", verificationApproval: APPROVAL };
      },
    });

    const result = await runtime.invoke();

    expect(runtime.trace).toEqual(["read", "clear", `preflight:${API_KEY}`, `write:${API_KEY}`]);
    expect(runtime.writeCredential).toHaveBeenCalledWith(
      { slot: "intervals-icu", value: API_KEY },
      { rollbackOnRuntimeRefusal: true, verificationApproval: APPROVAL },
    );
    expect(result).toEqual({ outcome: "applied", current: status("configured", "active") });
    expect(JSON.stringify(result)).not.toContain(APPROVAL);
  });

  it.each(["", "   ", "a\u0000b", "a\nb", "a\u007fb", "a\u0085b", "x".repeat(257)])(
    "refuses the invalid key shape without verification: %j",
    async (candidate) => {
      const runtime = setup({ clipboardValue: candidate, current: status("configured", "active") });

      await expect(runtime.invoke()).resolves.toEqual({
        outcome: "refused",
        reason: "invalid-key-format",
        current: status("configured", "active"),
      });
      expect(runtime.clipboard.clear).toHaveBeenCalledOnce();
      expect(runtime.verifyCredential).not.toHaveBeenCalled();
      expect(runtime.writeCredential).not.toHaveBeenCalled();
    },
  );

  it("attempts clear after read failure and refuses the unavailable clipboard", async () => {
    const runtime = setup();
    runtime.clipboard.readText.mockImplementationOnce(() => {
      runtime.trace.push("read-failed");
      throw new Error(PRIVATE_DETAIL);
    });

    const result = await runtime.invoke();

    expect(result).toEqual({
      outcome: "refused",
      reason: "clipboard-unavailable",
      current: status(),
    });
    expect(runtime.clipboard.clear).toHaveBeenCalledOnce();
    expect(runtime.verifyCredential).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_KEY");
  });

  it("gives clear failure precedence over a captured credential", async () => {
    const runtime = setup();
    runtime.clipboard.clear.mockImplementationOnce(() => {
      runtime.trace.push("clear-failed");
      throw new Error(PRIVATE_DETAIL);
    });

    await expect(runtime.invoke()).resolves.toEqual({
      outcome: "refused",
      reason: "clipboard-clear-failed",
      current: status(),
    });
    expect(runtime.verifyCredential).not.toHaveBeenCalled();
    expect(runtime.writeCredential).not.toHaveBeenCalled();
  });

  it("closes thrown and malformed verification failures without private details", async () => {
    const thrown = setup({
      verifyCredential: async () => {
        throw new Error(PRIVATE_DETAIL);
      },
    });
    const thrownResult = await thrown.invoke();
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
          apiKey: API_KEY,
        }) as never,
    });
    const malformedResult = await malformed.invoke();
    expect(malformedResult).toEqual({
      outcome: "refused",
      reason: "validation-unavailable",
      current: status(),
    });

    for (const result of [thrownResult, malformedResult]) {
      expect(JSON.stringify(result)).not.toContain(API_KEY);
      expect(JSON.stringify(result)).not.toContain("PRIVATE_KEY");
    }
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
        const result = await runtime.invoke();

        expect(result).toEqual({ outcome: "refused", reason, current: status() });
        expect(value.applyCredential).not.toHaveBeenCalled();
        expect(JSON.stringify(result)).not.toContain(API_KEY);
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

      const result = await runtime.invoke();

      expect(runtime.verifyCredential).toHaveBeenCalledOnce();
      expect(runtime.clipboard.clear).toHaveBeenCalledOnce();
      expect(result).toEqual({ outcome: "refused", reason: "storage-failed", current: status() });
      expect(value.applyCredential).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain(API_KEY);
      expect(JSON.stringify(result)).not.toContain("credential-rejected");
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it
    .skipIf(process.platform === "win32")
    .each(["encryption-unavailable", "unsafe-backend"] as const)(
    "preserves an existing key across the %s storage refusal",
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
        await value.vault.writeCredential({ slot: "intervals-icu", value: EXISTING_API_KEY });
        const before = await readFile(join(value.root, "intervals-icu.bin"));
        value.applyCredential.mockClear();
        if (reason === "encryption-unavailable") security.available = false;
        else security.backend = "basic_text";
        const runtime = setup({ vault: value.vault });

        await expect(runtime.invoke()).resolves.toEqual({
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
        apiKey: API_KEY,
      } as never,
    });

    const result = await runtime.invoke();

    expect(result).toEqual({
      outcome: "uncertain",
      reason: "storage-uncertain",
      current: status("re-prompt", null),
    });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_KEY");
    expect(runtime.defaultVault.credentialStatuses).not.toHaveBeenCalled();
  });

  it("rejects widened status snapshots without copying secrets", async () => {
    const runtime = setup();
    runtime.defaultVault.credentialStatuses.mockResolvedValueOnce([
      { ...status("configured", "active"), privateDetail: PRIVATE_DETAIL },
    ] as never);

    const result = await runtime.invoke();

    expect(result).toEqual({
      outcome: "uncertain",
      reason: "storage-uncertain",
      current: status("re-prompt", null),
    });
    expect(runtime.writeCredential).toHaveBeenCalledOnce();
    expect(runtime.defaultVault.credentialStatuses).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_KEY");
  });

  it("rejects untrusted and extra-argument calls before clipboard access", () => {
    const untrusted = setup({ trusted: false });
    expect(() => untrusted.invoke()).toThrow("untrusted desktop Intervals request");
    expect(untrusted.clipboard.readText).not.toHaveBeenCalled();
    expect(untrusted.clipboard.clear).not.toHaveBeenCalled();

    const extra = setup();
    expect(() => extra.invoke(API_KEY)).toThrow(TypeError);
    expect(extra.clipboard.readText).not.toHaveBeenCalled();
    expect(extra.clipboard.clear).not.toHaveBeenCalled();
    expect(extra.verifyCredential).not.toHaveBeenCalled();
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

    const result = await runtime.invoke();

    expect(result).toEqual({
      outcome: "refused",
      reason,
      current: status("configured", "active"),
    });
    expect(runtime.writeCredential).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  for (const { platform, expectedCiphertext } of [
    {
      platform: "darwin",
      expectedCiphertext: Buffer.from(`sealed:${EXISTING_API_KEY}`, "utf8"),
    },
    {
      platform: "win32",
      expectedCiphertext: Buffer.from(
        Buffer.from(EXISTING_API_KEY, "utf8").map((byte) => byte ^ 0xa5),
      ),
    },
  ] as const) {
    it.skipIf(process.platform === "win32" && platform === "darwin")(
      "keeps an existing encrypted key and runtime state unchanged after verification refusal",
      async () => {
        const value = await temporaryVault({ platform });
        try {
          await expect(
            value.vault.writeCredential({ slot: "intervals-icu", value: EXISTING_API_KEY }),
          ).resolves.toMatchObject({ status: "configured", runtimeReady: true });
          const before = await readFile(join(value.root, "intervals-icu.bin"));
          expect(before).toEqual(expectedCiphertext);
          value.applyCredential.mockClear();
          const runtime = setup({
            vault: value.vault,
            verification: { status: "refused", reason: "training-account-mismatch" },
          });

          await expect(runtime.invoke()).resolves.toEqual({
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
        value.vault.writeCredential({ slot: "intervals-icu", value: EXISTING_API_KEY }),
      ).resolves.toMatchObject({ status: "configured", runtimeReady: true });
      const before = await readFile(join(value.root, "intervals-icu.bin"));
      let appliedRuntimeKey = EXISTING_API_KEY;
      value.applyCredential.mockReset();
      value.applyCredential.mockImplementationOnce(async (_slot, candidate) => {
        appliedRuntimeKey = candidate;
        throw new Error(PRIVATE_DETAIL);
      });
      const runtime = setup({ vault: value.vault });

      const result = await runtime.invoke();

      expect(result).toEqual({
        outcome: "uncertain",
        reason: "runtime-uncertain",
        current: status("configured", "failed"),
      });
      expect(await readFile(join(value.root, "intervals-icu.bin"))).not.toEqual(before);
      const ciphertext = await readFile(join(value.root, "intervals-icu.bin"));
      if (value.platform === "win32") {
        expect(ciphertext.includes(Buffer.from(API_KEY, "utf8"))).toBe(false);
      } else {
        expect(ciphertext).toEqual(Buffer.from(`sealed:${API_KEY}`, "utf8"));
      }
      expect(appliedRuntimeKey).toBe(API_KEY);
      expect(value.applyCredential).toHaveBeenCalledOnce();
      await expect(value.vault.credentialStatuses()).resolves.toContainEqual(
        status("configured", "failed"),
      );
      expect(JSON.stringify(result)).not.toContain(API_KEY);
      expect(JSON.stringify(result)).not.toContain(PRIVATE_DETAIL);
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

      await expect(runtime.invoke()).resolves.toEqual({
        outcome: "uncertain",
        reason: "runtime-uncertain",
        current: status("configured", "failed"),
      });
      const ciphertext = await readFile(join(value.root, "intervals-icu.bin"));
      if (value.platform === "win32") {
        expect(ciphertext.includes(Buffer.from(API_KEY, "utf8"))).toBe(false);
      } else {
        expect(ciphertext).toEqual(Buffer.from(`sealed:${API_KEY}`, "utf8"));
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

  it("rolls back a known late training-account mismatch", async () => {
    const value = await temporaryVault({});
    try {
      await value.vault.writeCredential({ slot: "intervals-icu", value: EXISTING_API_KEY });
      const before = await readFile(join(value.root, "intervals-icu.bin"));
      value.applyCredential.mockReset();
      value.applyCredential.mockRejectedValueOnce(
        new CredentialRuntimeRefusal("training-account-mismatch"),
      );
      const runtime = setup({ vault: value.vault });

      await expect(runtime.invoke()).resolves.toEqual({
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

      await expect(runtime.invoke()).resolves.toEqual({
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
      await value.vault.writeCredential({ slot: "intervals-icu", value: EXISTING_API_KEY });
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

      const result = await runtime.invoke();

      expect(result).toEqual({
        outcome: "uncertain",
        reason: "storage-uncertain",
        current: status("re-prompt", null),
      });
      expect(await readFile(join(value.root, "intervals-icu.bin"))).not.toEqual(before);
      expect(createIdCalls).toBe(2);
      expect(applyCredential).toHaveBeenCalledOnce();
      expect(JSON.stringify(result)).not.toContain(API_KEY);
      expect(JSON.stringify(result)).not.toContain("PRIVATE_KEY");
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

      const result = await runtime.invoke();

      expect(result).toEqual({
        outcome: "refused",
        reason: "runtime-unavailable",
        current: status(),
      });
      await expect(readFile(join(value.root, "intervals-icu.bin"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(JSON.stringify(result)).not.toContain(API_KEY);
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it("serializes verification and commit with generic vault writes and deletes", async () => {
    const trace: string[] = [];
    const value = await temporaryVault({ trace });
    try {
      await value.vault.writeCredential({ slot: "intervals-icu", value: EXISTING_API_KEY });
      trace.splice(0);
      const verification = deferred<IntervalsCredentialVerificationResult>();
      const runtime = setup({
        vault: value.vault,
        verifyCredential: async () => {
          trace.push("verify");
          return verification.promise;
        },
      });

      const paste = Promise.resolve(runtime.invoke());
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
      await expect(paste).resolves.toEqual({
        outcome: "applied",
        current: status("configured", "active"),
      });
      expect(trace).toEqual([
        "verify",
        `apply:intervals-icu:${API_KEY}`,
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

      await expect(runtime.invoke()).resolves.toEqual({
        outcome: "applied",
        current: status("configured", "active"),
      });
      expect(verifyWithDaemon).toHaveBeenCalledOnce();
      expect(verifyWithDaemon).toHaveBeenCalledWith(API_KEY, expect.any(AbortSignal));
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

      await expect(runtime.invoke()).resolves.toEqual({
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

      await expect(runtime.invoke()).resolves.toEqual({
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
