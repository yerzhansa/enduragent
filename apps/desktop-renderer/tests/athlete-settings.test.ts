import { describe, expect, it, vi } from "vitest";
import {
  CoachClientDisconnectedError,
  CoachClientProtocolError,
  type CoachClient,
} from "@enduragent/coach-client";
import type { RuntimeConfigSnapshot } from "@enduragent/coach-contract";
import type { DesktopCoachClientProvider } from "../src/coach-client";
import {
  createAthleteSettingsController,
  type AthleteSettingsController,
  type AthleteSettingsView,
} from "../src/settings/athlete-controller";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function snapshot(
  athleteId = "0",
  overrides: Partial<RuntimeConfigSnapshot["intervals"]> = {},
): RuntimeConfigSnapshot {
  return {
    schemaVersion: 3,
    llm: {
      provider: "anthropic",
      model: "claude-sonnet",
      credential_configured: true,
    },
    intervals: {
      athlete_id: athleteId,
      credential_configured: true,
      managedByEnvironment: { athleteId: false },
      ...overrides,
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

function applied(intervals = true) {
  return {
    schemaVersion: 3,
    status: "applied",
    applied: { llm: false, intervals, session: false },
  } as const;
}

function fakeView() {
  let handlers:
    | {
        readonly onRetry: () => void;
        readonly onChange: (value: string) => void;
        readonly onSave: () => void;
        readonly onOpenSetup: () => void;
      }
    | undefined;
  const view: AthleteSettingsView = {
    bind: vi.fn((next) => {
      handlers = next;
    }),
    render: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    view,
    retry: () => handlers?.onRetry(),
    change: (value: string) => handlers?.onChange(value),
    save: () => handlers?.onSave(),
    openSetup: () => handlers?.onOpenSetup(),
  };
}

function clientWith(call: (method: string, request: unknown) => Promise<unknown>): CoachClient {
  return {
    handshake: {} as never,
    call,
    close: vi.fn(async () => {}),
  } as unknown as CoachClient;
}

function providerWith(client: CoachClient): DesktopCoachClientProvider {
  return {
    getClient: vi.fn(async () => client),
    reconnect: vi.fn(async () => client),
    onConnectionOpen: () => () => {},
    close: vi.fn(async () => {}),
  };
}

function createSubject(input: {
  readonly client?: CoachClient;
  readonly clients?: DesktopCoachClientProvider;
  readonly beginMutation?: () => (() => void) | null;
  readonly openSetup?: () => void;
}) {
  const subject = fakeView();
  const client =
    input.client ??
    clientWith(async (method) => {
      if (method === "getRuntimeConfig") return snapshot();
      if (method === "configureRuntime") return applied();
      throw new Error(`Unexpected method ${method}`);
    });
  const clients = input.clients ?? providerWith(client);
  const controller = createAthleteSettingsController({
    clients,
    view: subject.view,
    beginMutation: input.beginMutation ?? (() => () => {}),
    openSetup: input.openSetup ?? vi.fn(),
  });
  return { controller, subject, clients, client };
}

function form(controller: AthleteSettingsController) {
  const state = controller.state();
  if (
    state.status !== "ready" &&
    state.status !== "refreshing" &&
    state.status !== "saving" &&
    state.status !== "saved" &&
    !(state.status === "error" && state.kind === "save")
  ) {
    throw new Error(`Expected athlete form state, received ${state.status}`);
  }
  return state;
}

describe("training account settings controller", () => {
  it.each([
    ["", false],
    ["0", true],
    ["custom-athlete", true],
  ] as const)(
    "loads the authoritative athlete ID %j without coercion",
    async (athleteId, ready) => {
      const { controller } = createSubject({
        client: clientWith(async () =>
          snapshot(athleteId, { credential_configured: athleteId !== "" }),
        ),
      });

      await controller.activate();

      expect(form(controller)).toMatchObject({
        status: "ready",
        draft: athleteId,
        dirty: false,
        validationError: ready ? null : "athlete-required",
      });
    },
  );

  it("validates blank, whitespace, length, and C0/C1 controls without trimming", async () => {
    const call = vi.fn(async (method: string) =>
      method === "getRuntimeConfig" ? snapshot("current") : applied(),
    );
    const { controller, subject } = createSubject({ client: clientWith(call) });
    await controller.activate();

    for (const [value, error] of [
      ["", "athlete-required"],
      [" candidate", "athlete-whitespace"],
      ["candidate ", "athlete-whitespace"],
      ["a".repeat(513), "athlete-too-long"],
      [`candidate${String.fromCharCode(7)}`, "athlete-control-characters"],
      [`candidate${String.fromCharCode(133)}`, "athlete-control-characters"],
    ] as const) {
      subject.change(value);
      expect(form(controller)).toMatchObject({ draft: value, validationError: error });
      subject.save();
      await Promise.resolve();
    }
    expect(call).toHaveBeenCalledTimes(1);

    subject.change("a".repeat(512));
    expect(form(controller).validationError).toBeNull();
  });

  it.each(["0", "custom-athlete"] as const)(
    "sends only the exact athlete patch for %s and rereads authority",
    async (draft) => {
      const calls: Array<{ readonly method: string; readonly request: unknown }> = [];
      const call = vi.fn(async (method: string, request: unknown) => {
        calls.push({ method, request });
        if (method === "configureRuntime") return applied();
        return calls.length === 1 ? snapshot("current") : snapshot(draft);
      });
      const release = vi.fn();
      const beginMutation = vi.fn(() => release);
      const { controller, subject } = createSubject({
        client: clientWith(call),
        beginMutation,
      });
      await controller.activate();
      subject.change(draft);
      subject.save();
      await vi.waitFor(() => expect(controller.state().status).toBe("saved"));

      expect(calls).toEqual([
        { method: "getRuntimeConfig", request: {} },
        {
          method: "configureRuntime",
          request: { intervals: { athlete_id: draft } },
        },
        { method: "getRuntimeConfig", request: {} },
      ]);
      expect(JSON.stringify(calls[1])).not.toContain("api_key");
      expect(beginMutation).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
      expect(form(controller)).toMatchObject({
        status: "saved",
        draft,
        effective: { athlete_id: draft },
        dirty: false,
      });
    },
  );

  it.each([
    "credential-required",
    "ownership-unavailable",
    "training-account-mismatch",
    "managed-by-environment",
  ] as const)("retains the dirty draft after a typed %s refusal", async (reason) => {
    const call = vi.fn(async (method: string) => {
      if (method === "getRuntimeConfig") return snapshot("current");
      return { schemaVersion: 3, status: "refused", reason } as const;
    });
    const { controller, subject } = createSubject({ client: clientWith(call) });
    await controller.activate();
    subject.change("candidate");
    subject.save();
    await vi.waitFor(() => expect(controller.state().status).toBe("error"));

    expect(controller.state()).toMatchObject({
      status: "error",
      kind: "save",
      reason,
      draft: "candidate",
      dirty: true,
    });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("requires an applied intervals bit before the authoritative reread", async () => {
    const call = vi.fn(async (method: string) =>
      method === "getRuntimeConfig" ? snapshot("current") : applied(false),
    );
    const { controller, subject } = createSubject({ client: clientWith(call) });
    await controller.activate();
    subject.change("candidate");
    subject.save();
    await vi.waitFor(() => expect(controller.state().status).toBe("error"));

    expect(controller.state()).toMatchObject({
      status: "error",
      kind: "save",
      reason: "not-applied",
      draft: "candidate",
    });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("disables mutations under environment authority and credential absence", async () => {
    for (const intervals of [
      {
        credential_configured: true,
        managedByEnvironment: { athleteId: true },
      },
      {
        credential_configured: false,
        managedByEnvironment: { athleteId: false },
      },
    ] as const) {
      const call = vi.fn(async () => snapshot("managed", intervals));
      const { controller, subject } = createSubject({ client: clientWith(call) });
      await controller.activate();
      subject.change("candidate");
      subject.save();
      await Promise.resolve();
      expect(form(controller)).toMatchObject({ draft: "managed", dirty: false });
      expect(call).toHaveBeenCalledExactlyOnceWith("getRuntimeConfig", {});
    }
  });

  it("replaces a dirty draft when recovery newly locks the training account", async () => {
    for (const intervals of [
      {
        credential_configured: true,
        managedByEnvironment: { athleteId: true },
      },
      {
        credential_configured: false,
        managedByEnvironment: { athleteId: false },
      },
    ] as const) {
      const call = vi
        .fn()
        .mockResolvedValueOnce(snapshot("current"))
        .mockRejectedValueOnce(new Error("private detail"))
        .mockResolvedValueOnce(snapshot("authoritative", intervals));
      const { controller, subject } = createSubject({ client: clientWith(call) });
      await controller.activate();
      subject.change("candidate");
      subject.save();
      await vi.waitFor(() => expect(controller.state().status).toBe("error"));

      subject.retry();
      await vi.waitFor(() => expect(controller.state().status).toBe("ready"));
      expect(form(controller)).toMatchObject({
        effective: { athlete_id: "authoritative", ...intervals },
        draft: "authoritative",
        dirty: false,
      });
      expect(call).toHaveBeenLastCalledWith("getRuntimeConfig", {});
    }
  });

  it("opens Setup only for credential recovery", async () => {
    const openSetup = vi.fn();
    const { controller, subject } = createSubject({
      client: clientWith(async () =>
        snapshot("", {
          credential_configured: false,
          managedByEnvironment: { athleteId: false },
        }),
      ),
      openSetup,
    });
    await controller.activate();
    subject.openSetup();
    expect(openSetup).toHaveBeenCalledOnce();
  });

  it("does not replay a disconnected save and preserves the draft through reconnect", async () => {
    const disconnected = new CoachClientDisconnectedError(1006, "");
    const firstCall = vi
      .fn()
      .mockResolvedValueOnce(snapshot("current"))
      .mockRejectedValueOnce(disconnected);
    const secondCall = vi.fn(async () => snapshot("current"));
    const first = clientWith(firstCall);
    const second = clientWith(secondCall);
    const clients: DesktopCoachClientProvider = {
      getClient: vi.fn(async () => first),
      reconnect: vi.fn(async () => second),
      onConnectionOpen: () => () => {},
      close: vi.fn(async () => {}),
    };
    const { controller, subject } = createSubject({ clients });
    await controller.activate();
    subject.change("candidate");
    subject.save();
    await vi.waitFor(() => expect(controller.state().status).toBe("error"));
    expect(form(controller).draft).toBe("candidate");

    subject.retry();
    await vi.waitFor(() => expect(controller.state().status).toBe("ready"));
    expect(clients.reconnect).toHaveBeenCalledOnce();
    expect(secondCall).toHaveBeenCalledExactlyOnceWith("getRuntimeConfig", {});
    expect(firstCall.mock.calls.filter(([method]) => method === "configureRuntime")).toHaveLength(
      1,
    );
    expect(form(controller)).toMatchObject({ draft: "candidate", dirty: true });
  });

  it("retains a dirty draft when the authoritative reread fails", async () => {
    for (const error of [new Error("private detail"), new CoachClientProtocolError()]) {
      const call = vi
        .fn()
        .mockResolvedValueOnce(snapshot("current"))
        .mockResolvedValueOnce(applied())
        .mockRejectedValueOnce(error);
      const { controller, subject } = createSubject({ client: clientWith(call) });
      await controller.activate();
      subject.change("candidate");
      subject.save();
      await vi.waitFor(() => expect(controller.state().status).toBe("error"));
      expect(controller.state()).toMatchObject({
        status: "error",
        kind: "save",
        reason: "runtime-unavailable",
        draft: "candidate",
        dirty: true,
      });
    }
  });

  it("does not overlap another Settings mutation", async () => {
    const call = vi.fn(async () => snapshot("current"));
    const { controller, subject } = createSubject({
      client: clientWith(call),
      beginMutation: () => null,
    });
    await controller.activate();
    subject.change("candidate");
    subject.save();
    await Promise.resolve();
    expect(call).toHaveBeenCalledExactlyOnceWith("getRuntimeConfig", {});
    expect(form(controller)).toMatchObject({ draft: "candidate", dirty: true });
  });

  it("fences stale load, save, and reread completions across close and reopen", async () => {
    const firstLoad = deferred<RuntimeConfigSnapshot>();
    const save = deferred<ReturnType<typeof applied>>();
    const reread = deferred<RuntimeConfigSnapshot>();
    const call = vi
      .fn()
      .mockReturnValueOnce(firstLoad.promise)
      .mockResolvedValueOnce(snapshot("fresh"))
      .mockReturnValueOnce(save.promise)
      .mockReturnValueOnce(reread.promise)
      .mockResolvedValueOnce(snapshot("reopened"));
    const { controller, subject } = createSubject({ client: clientWith(call) });

    const initial = controller.activate();
    controller.close();
    const reopened = controller.activate();
    firstLoad.resolve(snapshot("stale"));
    await initial;
    await reopened;
    expect(form(controller).draft).toBe("fresh");

    subject.change("candidate");
    subject.save();
    await vi.waitFor(() => expect(controller.state().status).toBe("saving"));
    save.resolve(applied());
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(4));
    controller.close();
    const finalOpen = controller.activate();
    reread.resolve(snapshot("stale-reread"));
    await finalOpen;
    expect(form(controller).draft).toBe("reopened");
  });

  it.each(["load", "save"] as const)(
    "does not render a stale %s completion after disposal",
    async (operation) => {
      const loadGate = deferred<RuntimeConfigSnapshot>();
      const saveGate = deferred<ReturnType<typeof applied>>();
      const call =
        operation === "load"
          ? vi.fn(() => loadGate.promise)
          : vi
              .fn()
              .mockResolvedValueOnce(snapshot("current"))
              .mockReturnValueOnce(saveGate.promise);
      const { controller, subject } = createSubject({ client: clientWith(call) });
      const pending = controller.activate();
      if (operation === "save") {
        await pending;
        subject.change("candidate");
        subject.save();
        await vi.waitFor(() => expect(controller.state().status).toBe("saving"));
      }
      const renders = vi.mocked(subject.view.render).mock.calls.length;
      controller.dispose();
      if (operation === "load") loadGate.resolve(snapshot());
      else saveGate.resolve(applied());
      await Promise.resolve();
      await Promise.resolve();
      expect(subject.view.render).toHaveBeenCalledTimes(renders);
      expect(subject.view.dispose).toHaveBeenCalledOnce();
      expect(controller.state()).toEqual({ status: "closed" });
    },
  );
});
