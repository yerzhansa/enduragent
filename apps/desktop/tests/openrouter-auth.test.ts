import {
  OPENROUTER_CREDITS_PAGE_URL,
  OPENROUTER_KEYS_PAGE_URL,
  OpenRouterSignInError,
  type OpenRouterSignInOptions,
  type OpenRouterSignInPhase,
} from "@enduragent/core";
import { describe, expect, it, vi } from "vitest";
import {
  OPENROUTER_CODE_ATTEMPT_LIFETIME_MS,
  createOpenRouterAuth,
  type OpenRouterSignInResult,
  type OpenRouterStoreOutcome,
} from "../src/main/openrouter-auth.js";

const KEY = `sk-or-v1-${"7".repeat(64)}`;
const CODE = "synthetic-code-0001";
const AUTHORIZE_URL = "https://openrouter.ai/auth?callback_url=x&state=s";
const HEADLESS_URL = "https://openrouter.ai/auth?code_challenge=c";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function harness(options: { readonly clipboardText?: string | (() => string) } = {}) {
  let clock = 1_000;
  const browser: { hooks?: OpenRouterSignInOptions; result?: Deferred<string> } = {};
  const exchange = vi.fn(async (_text: string, _signal?: AbortSignal) => KEY);
  const clipboardText = options.clipboardText ?? CODE;
  const clipboard = {
    readText: vi.fn(async () =>
      typeof clipboardText === "function" ? clipboardText() : clipboardText,
    ),
    clear: vi.fn(),
  };
  const ports = {
    openExternal: vi.fn(async (_url: string) => undefined),
    signIn: vi.fn((hooks: OpenRouterSignInOptions) => {
      const result = deferred<string>();
      browser.hooks = hooks;
      browser.result = result;
      hooks.signal?.addEventListener("abort", () =>
        result.reject(new OpenRouterSignInError("cancelled")),
      );
      return result.promise;
    }),
    startCodeSignIn: vi.fn(() => ({ authorizeUrl: HEADLESS_URL, exchange })),
    readCreditStatus: vi.fn(async (_key: string, _signal?: AbortSignal) => "paid" as const),
  };
  const readStoredKey = vi.fn(async (): Promise<string | undefined> => KEY);
  const auth = createOpenRouterAuth({ ports, clipboard, readStoredKey, now: () => clock });
  const store = vi.fn(async (_key: string): Promise<OpenRouterStoreOutcome> => "connected");
  const phases: OpenRouterSignInPhase[] = [];
  const onPhase = (phase: OpenRouterSignInPhase) => phases.push(phase);
  const results: OpenRouterSignInResult[] = [];
  const record = <T extends OpenRouterSignInResult>(result: T): T => {
    results.push(result);
    return result;
  };
  const startBrowser = (operationId = "op-browser") =>
    auth.signIn(operationId, store, onPhase).then(record);
  const approve = async () => {
    browser.hooks?.onAuthorizeUrl?.(AUTHORIZE_URL);
    browser.hooks?.onPhase?.("waiting-for-browser");
    await Promise.resolve();
  };
  return {
    auth,
    ports,
    clipboard,
    exchange,
    readStoredKey,
    store,
    phases,
    results,
    record,
    browser,
    startBrowser,
    approve,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("OpenRouter sign-in controller", () => {
  it("stores the key from a browser sign-in and returns only the credit status", async () => {
    const subject = harness();
    const pending = subject.startBrowser();
    await subject.approve();
    subject.browser.hooks?.onPhase?.("completing-sign-in");
    subject.browser.result?.resolve(KEY);
    await expect(pending).resolves.toEqual({
      status: "connected",
      operationId: "op-browser",
      credit: "paid",
    });
    expect(subject.store).toHaveBeenCalledWith(KEY);
    expect(subject.ports.readCreditStatus).toHaveBeenCalledWith(KEY, expect.any(AbortSignal));
    expect(subject.phases).toEqual(["waiting-for-browser", "completing-sign-in"]);
    expect(JSON.stringify(subject.results)).not.toContain(KEY);
  });

  it("runs one browser sign-in at a time", async () => {
    const subject = harness();
    const first = subject.startBrowser("op-first");
    await expect(subject.startBrowser("op-second")).resolves.toEqual({
      status: "refused",
      operationId: "op-second",
      reason: "already-in-progress",
    });
    subject.browser.result?.resolve(KEY);
    await expect(first).resolves.toMatchObject({ status: "connected" });
    const third = subject.startBrowser("op-third");
    subject.browser.result?.resolve(KEY);
    await expect(third).resolves.toMatchObject({ status: "connected", operationId: "op-third" });
  });

  it("cancels a waiting sign-in and refuses to cancel once OpenRouter approved", async () => {
    const subject = harness();
    const cancelled = subject.startBrowser("op-cancel");
    expect(subject.auth.cancel("op-other")).toBe(false);
    expect(subject.auth.cancel("op-cancel")).toBe(true);
    await expect(cancelled).resolves.toEqual({
      status: "refused",
      operationId: "op-cancel",
      reason: "cancelled",
    });
    expect(subject.store).not.toHaveBeenCalled();

    const approved = subject.startBrowser("op-approved");
    subject.browser.hooks?.onPhase?.("completing-sign-in");
    expect(subject.auth.cancel("op-approved")).toBe(false);
    subject.browser.result?.resolve(KEY);
    await expect(approved).resolves.toMatchObject({ status: "connected" });
  });

  it("reopens only the pending authorize page", async () => {
    const subject = harness();
    void subject.startBrowser("op-reopen");
    await expect(subject.auth.reopen("op-reopen")).resolves.toBe(false);
    await subject.approve();
    await expect(subject.auth.reopen("op-other")).resolves.toBe(false);
    await expect(subject.auth.reopen("op-reopen")).resolves.toBe(true);
    expect(subject.ports.openExternal).toHaveBeenLastCalledWith(AUTHORIZE_URL);
    subject.browser.hooks?.onPhase?.("completing-sign-in");
    await expect(subject.auth.reopen("op-reopen")).resolves.toBe(false);
  });

  it.each([
    ["timed-out", "not-finished"],
    ["access-denied", "not-finished"],
    ["exchange-failed", "unreachable"],
    ["unreachable", "unreachable"],
  ] as const)("reports a %s browser sign-in as %s", async (failure, reason) => {
    const subject = harness();
    const pending = subject.startBrowser();
    subject.browser.result?.reject(new OpenRouterSignInError(failure));
    await expect(pending).resolves.toEqual({
      status: "refused",
      operationId: "op-browser",
      reason,
    });
    expect(subject.store).not.toHaveBeenCalled();
  });

  it("stops and reports not finished when the browser cannot open", async () => {
    const subject = harness();
    const pending = subject.startBrowser();
    subject.browser.hooks?.onBrowserOpenFailed?.();
    await expect(pending).resolves.toMatchObject({ reason: "not-finished" });
  });

  it("falls back to a code sign-in when the loopback listener cannot bind", async () => {
    const subject = harness();
    const pending = subject.startBrowser("op-bind");
    subject.browser.result?.reject(new OpenRouterSignInError("callback-unavailable"));
    await expect(pending).resolves.toEqual({ status: "awaiting-code", operationId: "op-bind" });
    expect(subject.ports.openExternal).toHaveBeenCalledWith(HEADLESS_URL);
    await expect(subject.auth.useCopiedCode("op-bind", vi.fn())).resolves.toMatchObject({
      status: "connected",
    });
    expect(subject.store).toHaveBeenCalledWith(KEY);
  });

  it("replaces a browser sign-in with a code sign-in and opens the headless page", async () => {
    const subject = harness();
    const browser = subject.startBrowser("op-browser");
    expect(subject.auth.startCodeSignIn("op-code", subject.store)).toEqual({
      status: "awaiting-code",
      operationId: "op-code",
    });
    await expect(browser).resolves.toMatchObject({ reason: "cancelled" });
    expect(subject.ports.openExternal).toHaveBeenCalledWith(HEADLESS_URL);
    await expect(subject.auth.reopen("op-code")).resolves.toBe(true);
    expect(subject.ports.openExternal).toHaveBeenLastCalledWith(HEADLESS_URL);
  });

  it("reads the copied code, exchanges it, then clears the clipboard and stores", async () => {
    const subject = harness({ clipboardText: `  ${CODE}\n` });
    subject.auth.startCodeSignIn("op-code", subject.store);
    const phases: OpenRouterSignInPhase[] = [];
    const result = await subject.auth.useCopiedCode("op-code", (phase) => phases.push(phase));
    expect(result).toEqual({ status: "connected", operationId: "op-code", credit: "paid" });
    expect(subject.clipboard.clear).toHaveBeenCalledOnce();
    expect(subject.exchange.mock.invocationCallOrder[0]).toBeLessThan(
      subject.clipboard.clear.mock.invocationCallOrder[0] ?? 0,
    );
    expect(subject.exchange).toHaveBeenCalledWith(CODE, expect.any(AbortSignal));
    expect(phases).toEqual(["completing-sign-in"]);
    expect(JSON.stringify(result)).not.toContain(CODE);
    await expect(subject.auth.useCopiedCode("op-code", vi.fn())).resolves.toMatchObject({
      reason: "code-expired",
    });
  });

  it("keeps the code sign-in open when the clipboard holds no code", async () => {
    let text = "a note about something else";
    const subject = harness({ clipboardText: () => text });
    subject.auth.startCodeSignIn("op-code", subject.store);
    await expect(subject.auth.useCopiedCode("op-code", vi.fn())).resolves.toEqual({
      status: "refused",
      operationId: "op-code",
      reason: "clipboard-no-code",
    });
    expect(subject.clipboard.clear).not.toHaveBeenCalled();
    expect(subject.exchange).not.toHaveBeenCalled();
    text = CODE;
    await expect(subject.auth.useCopiedCode("op-code", vi.fn())).resolves.toMatchObject({
      status: "connected",
    });
  });

  it("clears the clipboard only after a successful exchange and only if it still holds the code", async () => {
    let text = CODE;
    const subject = harness({ clipboardText: () => text });
    subject.exchange.mockRejectedValueOnce(new OpenRouterSignInError("code-rejected"));
    subject.auth.startCodeSignIn("op-rejected", subject.store);
    await expect(subject.auth.useCopiedCode("op-rejected", vi.fn())).resolves.toMatchObject({
      reason: "code-expired",
    });
    expect(subject.clipboard.clear).not.toHaveBeenCalled();

    subject.exchange.mockImplementationOnce(async () => {
      text = "something the rider copied meanwhile";
      return KEY;
    });
    subject.auth.startCodeSignIn("op-copied", subject.store);
    await expect(subject.auth.useCopiedCode("op-copied", vi.fn())).resolves.toMatchObject({
      status: "connected",
    });
    expect(subject.clipboard.clear).not.toHaveBeenCalled();
  });

  it("keeps the code attempt and the clipboard when OpenRouter does not answer", async () => {
    const subject = harness();
    subject.exchange.mockRejectedValueOnce(new OpenRouterSignInError("unreachable"));
    subject.auth.startCodeSignIn("op-code", subject.store);
    await expect(subject.auth.useCopiedCode("op-code", vi.fn())).resolves.toEqual({
      status: "refused",
      operationId: "op-code",
      reason: "unreachable",
    });
    expect(subject.clipboard.clear).not.toHaveBeenCalled();
    await expect(subject.auth.useCopiedCode("op-code", vi.fn())).resolves.toMatchObject({
      status: "connected",
    });
    expect(subject.exchange).toHaveBeenCalledTimes(2);
    expect(subject.clipboard.clear).toHaveBeenCalledOnce();
  });

  it("keeps the code sign-in open when the clipboard cannot be read", async () => {
    const subject = harness({
      clipboardText: () => {
        throw new Error("clipboard locked");
      },
    });
    subject.auth.startCodeSignIn("op-code", subject.store);
    await expect(subject.auth.useCopiedCode("op-code", vi.fn())).resolves.toMatchObject({
      reason: "clipboard-unavailable",
    });
    expect(subject.auth.cancel("op-code")).toBe(true);
  });

  it("runs one code exchange at a time", async () => {
    const subject = harness();
    const held = deferred<string>();
    subject.exchange.mockReturnValueOnce(held.promise);
    subject.auth.startCodeSignIn("op-code", subject.store);
    const first = subject.auth.useCopiedCode("op-code", vi.fn());
    await expect(subject.auth.useCopiedCode("op-code", vi.fn())).resolves.toMatchObject({
      reason: "already-in-progress",
    });
    expect(subject.auth.cancel("op-code")).toBe(false);
    held.resolve(KEY);
    await expect(first).resolves.toMatchObject({ status: "connected" });
    expect(subject.exchange).toHaveBeenCalledOnce();
  });

  it("frees a cancelled browser attempt at once so a new sign-in can start", async () => {
    const subject = harness();
    const cancelled = subject.startBrowser("op-cancel");
    await subject.approve();
    expect(subject.auth.cancel("op-cancel")).toBe(true);
    await expect(subject.auth.reopen("op-cancel")).resolves.toBe(false);
    const next = subject.startBrowser("op-next");
    await expect(cancelled).resolves.toMatchObject({ reason: "cancelled" });
    subject.browser.result?.resolve(KEY);
    await expect(next).resolves.toMatchObject({ status: "connected", operationId: "op-next" });
    expect(subject.ports.openExternal).not.toHaveBeenCalled();
  });

  it("does not fall back to a code sign-in for a cancelled browser attempt", async () => {
    const subject = harness();
    const listener = deferred<string>();
    subject.ports.signIn.mockReturnValueOnce(listener.promise);
    const pending = subject.startBrowser("op-cancel");
    expect(subject.auth.cancel("op-cancel")).toBe(true);
    listener.reject(new OpenRouterSignInError("callback-unavailable"));
    await expect(pending).resolves.toMatchObject({ reason: "cancelled" });
    expect(subject.ports.startCodeSignIn).not.toHaveBeenCalled();
    expect(subject.ports.openExternal).not.toHaveBeenCalled();
  });

  it("drops an expired code attempt instead of reopening its page", async () => {
    const subject = harness();
    subject.auth.startCodeSignIn("op-code", subject.store);
    subject.advance(OPENROUTER_CODE_ATTEMPT_LIFETIME_MS + 1);
    await expect(subject.auth.reopen("op-code")).resolves.toBe(false);
    expect(subject.ports.openExternal).toHaveBeenCalledOnce();
    expect(subject.auth.cancel("op-code")).toBe(false);
  });

  it("stops before reading credits with the key once disposed during the vault write", async () => {
    const subject = harness();
    const stored = deferred<OpenRouterStoreOutcome>();
    subject.store.mockReturnValueOnce(stored.promise);
    const pending = subject.startBrowser();
    subject.browser.result?.resolve(KEY);
    await vi.waitFor(() => expect(subject.store).toHaveBeenCalledOnce());
    subject.auth.dispose();
    stored.resolve("connected");
    await expect(pending).resolves.toMatchObject({ reason: "cancelled" });
    expect(subject.ports.readCreditStatus).not.toHaveBeenCalled();
    await expect(subject.auth.readCreditStatus()).resolves.toBe("unknown");
    expect(subject.ports.readCreditStatus).not.toHaveBeenCalled();
  });

  it("reports a rejected code as expired and drops the attempt", async () => {
    const subject = harness();
    subject.exchange.mockRejectedValueOnce(new OpenRouterSignInError("code-rejected"));
    subject.auth.startCodeSignIn("op-code", subject.store);
    await expect(subject.auth.useCopiedCode("op-code", vi.fn())).resolves.toMatchObject({
      reason: "code-expired",
    });
    expect(subject.auth.cancel("op-code")).toBe(false);
    expect(subject.store).not.toHaveBeenCalled();
  });

  it("refuses a code sign-in that outlived its lifetime without reading the clipboard", async () => {
    const subject = harness();
    subject.auth.startCodeSignIn("op-code", subject.store);
    subject.advance(OPENROUTER_CODE_ATTEMPT_LIFETIME_MS + 1);
    await expect(subject.auth.useCopiedCode("op-code", vi.fn())).resolves.toMatchObject({
      reason: "code-expired",
    });
    expect(subject.clipboard.readText).not.toHaveBeenCalled();
  });

  it.each([
    ["saved-not-active", "saved-not-active"],
    ["not-saved", "not-saved"],
  ] as const)("reports a %s vault outcome without reading credits", async (outcome, reason) => {
    const subject = harness();
    subject.store.mockResolvedValueOnce(outcome);
    const pending = subject.startBrowser();
    subject.browser.result?.resolve(KEY);
    await expect(pending).resolves.toEqual({
      status: "refused",
      operationId: "op-browser",
      reason,
    });
    expect(subject.ports.readCreditStatus).not.toHaveBeenCalled();
  });

  it("reports a throwing vault write as not saved", async () => {
    const subject = harness();
    subject.store.mockRejectedValueOnce(new Error(`write failed for ${KEY}`));
    const pending = subject.startBrowser();
    subject.browser.result?.resolve(KEY);
    const result = await pending;
    expect(result).toMatchObject({ reason: "not-saved" });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("aborts the browser attempt on dispose and refuses later work", async () => {
    const subject = harness();
    const pending = subject.startBrowser();
    subject.auth.dispose();
    await expect(pending).resolves.toMatchObject({ reason: "cancelled" });
    await expect(subject.startBrowser("op-later")).resolves.toMatchObject({ reason: "cancelled" });
    expect(subject.auth.startCodeSignIn("op-code", subject.store)).toMatchObject({
      reason: "cancelled",
    });
  });

  it("reads the credit status of the stored key and answers unknown without one", async () => {
    const subject = harness();
    await expect(subject.auth.readCreditStatus()).resolves.toBe("paid");
    expect(subject.ports.readCreditStatus).toHaveBeenCalledWith(KEY, expect.any(AbortSignal));
    subject.readStoredKey.mockResolvedValueOnce(undefined);
    await expect(subject.auth.readCreditStatus()).resolves.toBe("unknown");
    subject.readStoredKey.mockRejectedValueOnce(new Error("vault locked"));
    await expect(subject.auth.readCreditStatus()).resolves.toBe("unknown");
  });

  it("opens only the fixed OpenRouter pages", async () => {
    const subject = harness();
    await expect(subject.auth.openPage("credits")).resolves.toBe(true);
    await expect(subject.auth.openPage("keys")).resolves.toBe(true);
    expect(subject.ports.openExternal.mock.calls).toEqual([
      [OPENROUTER_CREDITS_PAGE_URL],
      [OPENROUTER_KEYS_PAGE_URL],
    ]);
  });
});
