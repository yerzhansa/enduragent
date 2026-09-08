import { createTestCoachLanguage } from "./language-fixture.js";
import { describe, expect, it, vi } from "vitest";
import type { CoachEngine } from "@enduragent/coach-contract";
import type { CreateTelegramChannelInput, TelegramChannelRuntime } from "@enduragent/core";
import { createDesktopTelegramRuntimeFactory } from "../src/desktop-telegram-runtime.js";
import type { InvocationCoordinator } from "../src/daemon/invocation-coordinator.js";
import type { LocalCoachLifecycle } from "../src/local-runner.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("Desktop Telegram runtime projection", () => {
  it("stays transport-dormant until enabled and projects only daemon-owned capabilities", async () => {
    const channel: TelegramChannelRuntime = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      captureDrain: vi.fn(() => ({ wait: vi.fn(async () => undefined) })),
      drainPending: vi.fn(async () => undefined),
      sendMessage: vi.fn(async () => undefined),
    };
    const createBot = vi.fn((_input: CreateTelegramChannelInput) => channel);
    const middleware = vi.fn(async (_context, next: () => Promise<void>) => next());
    type CreateAccessMiddleware = NonNullable<
      NonNullable<
        Parameters<typeof createDesktopTelegramRuntimeFactory>[1]
      >["createAccessMiddleware"]
    >;
    const createAccessMiddleware = vi.fn<CreateAccessMiddleware>((_input) => middleware);
    const loadAllowedSenders = vi.fn(() => ({ primaryOperator: "73" }));
    const reservation = { run: vi.fn(), cancel: vi.fn(), key: "telegram:73" };
    const reserve = vi.fn(() => reservation);
    const confirmations = {
      peek: vi.fn(() => ({ nonce: "n", summary: "Save plan" })),
      confirm: vi.fn(async () => ({
        status: "executed" as const,
        summary: "Save plan",
        result: {},
      })),
      cancel: vi.fn(() => "canceled" as const),
    };
    const sync = vi.fn(async () => ({
      schemaVersion: 1 as const,
      published: true,
      referenceSucceeded: true,
      requests: { store: 1, reference: 1, total: 2 },
      droppedActivities: {
        overall: { total: 0, visible: 0, restrictions: [], other: 0 },
        recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
      },
    }));
    const chat = vi.fn<CoachEngine["chat"]>(async () => ({ text: "Bonjour" }));
    const lifecycle = {
      language: createTestCoachLanguage(),
      home: { root: "/synthetic/home" },
      engine: { chat },
      operations: { sync },
      confirmations,
    } as unknown as Pick<
      LocalCoachLifecycle,
      "home" | "engine" | "operations" | "confirmations" | "language"
    >;
    const invocations = {
      canAdmit: () => true,
      reserve,
    } as unknown as InvocationCoordinator;

    const runtimeFactory = createDesktopTelegramRuntimeFactory(
      { lifecycle, invocations, appVersion: "1.2.3" },
      {
        createBot,
        createAccessMiddleware,
        loadAllowedSenders: loadAllowedSenders as unknown as NonNullable<
          Parameters<typeof createDesktopTelegramRuntimeFactory>[1]
        >["loadAllowedSenders"],
      },
    );

    expect(createBot).not.toHaveBeenCalled();
    const onStarted = vi.fn();
    const onPollingSuccess = vi.fn();
    const onPollingFailure = vi.fn();
    const consumePairing = vi.fn(async () => true);
    let admitted = true;
    expect(
      runtimeFactory({
        token: "secret",
        admitted: () => admitted,
        onStarted,
        onPollingSuccess,
        onPollingFailure,
        consumePairing,
      }),
    ).toBe(channel);
    expect(createBot).toHaveBeenCalledOnce();
    const projected = createBot.mock.calls[0]![0];
    expect(projected.token).toBe("secret");
    expect(projected.webhookPolicy).toBe("preserve");
    expect(projected.engine).not.toBe(lifecycle.engine);
    await projected.engine.chat({
      chatId: "telegram:73",
      message: "Hello\nBonjour",
      turn: { language: "fr", languageSource: "message" },
    });
    expect(chat).toHaveBeenCalledWith(
      {
        chatId: "telegram:73",
        message: "Hello\nBonjour",
        turn: { language: "fr", languageSource: "message" },
      },
      undefined,
    );
    expect(projected.host.language).toBe(lifecycle.language);
    expect(projected.host.diagnostics).toBeUndefined();
    const next = vi.fn(async () => undefined);
    await projected.host.access.middleware({} as never, next);
    expect(middleware).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
    admitted = false;
    await projected.host.access.middleware({} as never, next);
    expect(middleware).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();

    const accessInput = createAccessMiddleware.mock.calls[0]![0];
    expect(accessInput.loadAllowedSenders).toBe(loadAllowedSenders);
    expect(accessInput.consumePairing).toBe(consumePairing);
    expect(accessInput.pairingChallenge!({ senderId: "73", senderName: "Athlete" })).toContain(
      "Desktop → Settings → Telegram",
    );
    expect(await projected.host.authorization.isPrimaryOperator({ senderId: "73" })).toBe(true);
    expect(projected.host.invocations?.reserve("telegram:73")).toBe(reservation);
    expect(reserve).toHaveBeenCalledWith({ key: "telegram:73" });
    await expect(projected.host.confirmations.peek({ chatId: "telegram:73" })).resolves.toEqual({
      nonce: "n",
      summary: "Save plan",
    });
    await expect(projected.host.operations?.sync({ chatId: "telegram:73" })).resolves.toEqual({
      text: "Sync complete — your training data is up to date.",
    });
    expect(sync).toHaveBeenCalledWith({});
    await expect(projected.host.release.version()).resolves.toBe("Cycling Coach Desktop v1.2.3");

    projected.onStart?.();
    projected.onPollingSuccess?.();
    projected.onPollingFailure?.();
    expect(onStarted).toHaveBeenCalledOnce();
    expect(onPollingSuccess).toHaveBeenCalledOnce();
    expect(onPollingFailure).toHaveBeenCalledOnce();
  });

  it("does not enter downstream offset dedupe after shared admission closes", async () => {
    const channel: TelegramChannelRuntime = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      captureDrain: vi.fn(() => ({ wait: vi.fn(async () => undefined) })),
      drainPending: vi.fn(async () => undefined),
      sendMessage: vi.fn(async () => undefined),
    };
    const createBot = vi.fn((_input: CreateTelegramChannelInput) => channel);
    const accessEntered = deferred<void>();
    const releaseAccess = deferred<void>();
    const middleware = vi.fn(async (_context, next: () => Promise<void>) => {
      accessEntered.resolve();
      await releaseAccess.promise;
      await next();
    });
    let admissionOpen = true;
    const reserve = vi.fn(() => {
      if (!admissionOpen) throw new Error("admission closed");
      return { run: vi.fn(), cancel: vi.fn(), key: "telegram:73" };
    });
    const lifecycle = {
      language: createTestCoachLanguage(),
      home: { root: "/synthetic/home" },
      engine: {},
      operations: { sync: vi.fn() },
      confirmations: {},
    } as unknown as Pick<
      LocalCoachLifecycle,
      "home" | "engine" | "operations" | "confirmations" | "language"
    >;
    const runtimeFactory = createDesktopTelegramRuntimeFactory(
      {
        lifecycle,
        invocations: {
          canAdmit: () => admissionOpen,
          reserve,
        } as unknown as InvocationCoordinator,
        appVersion: "1.2.3",
      },
      {
        createBot,
        createAccessMiddleware: vi.fn(() => middleware),
        loadAllowedSenders: vi.fn(() => ({
          version: 1 as const,
          dmPolicy: "allowlist" as const,
          allowFrom: ["73"],
          primaryOperator: "73",
          capturedAt: null,
          addedAt: {},
        })),
      },
    );
    const runtime = runtimeFactory({
      token: "secret",
      admitted: () => true,
      onStarted: vi.fn(),
      onPollingSuccess: vi.fn(),
      onPollingFailure: vi.fn(),
      consumePairing: vi.fn(async () => false),
    });
    const projected = createBot.mock.calls[0]![0];
    const recordOffset = vi.fn();
    const downstream = vi.fn(async () => {
      recordOffset();
      projected.host.invocations?.reserve("telegram:73");
    });

    const handling = projected.host.access.middleware({} as never, downstream);
    await accessEntered.promise;
    admissionOpen = false;
    await runtime.stop();
    releaseAccess.resolve();

    await expect(handling).resolves.toBeUndefined();
    expect(downstream).not.toHaveBeenCalled();
    expect(recordOffset).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });
});
