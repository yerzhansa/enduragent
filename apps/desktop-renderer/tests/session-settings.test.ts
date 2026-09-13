import { describe, expect, it, vi } from "vitest";
import { CoachClientDisconnectedError, type CoachClient } from "@enduragent/coach-client";
import type { RuntimeConfigSnapshot } from "@enduragent/coach-contract";
import type { DesktopCoachClientProvider } from "../src/coach-client";
import {
  createSessionSettingsController,
  type SessionSettingField,
  type SessionSettingsController,
  type SessionSettingsView,
} from "../src/settings/session-controller";

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
  overrides: Partial<RuntimeConfigSnapshot["session"]> = {},
): RuntimeConfigSnapshot {
  return {
    schemaVersion: 3,
    llm: {
      provider: "anthropic",
      model: "claude-sonnet",
      credential_configured: true,
    },
    intervals: {
      athlete_id: "0",
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
      ...overrides,
    },
  };
}

function applied() {
  return {
    schemaVersion: 3 as const,
    status: "applied" as const,
    applied: { llm: false, intervals: false, session: true },
  };
}

function fakeView() {
  let handlers:
    | {
        readonly onRetry: () => void;
        readonly onChange: (field: SessionSettingField, value: string) => void;
        readonly onCommit: () => void;
      }
    | undefined;
  const view: SessionSettingsView = {
    bind: vi.fn((next) => {
      handlers = next;
    }),
    render: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    view,
    retry: () => handlers?.onRetry(),
    change: (field: SessionSettingField, value: string) => handlers?.onChange(field, value),
    commit: () => handlers?.onCommit(),
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
    close: vi.fn(async () => {}),
  };
}

function createSubject(
  input: {
    readonly client?: CoachClient;
    readonly clients?: DesktopCoachClientProvider;
    readonly beginMutation?: () => (() => void) | null;
  } = {},
) {
  const subject = fakeView();
  const client =
    input.client ??
    clientWith(async (method) => {
      if (method === "getRuntimeConfig") return snapshot();
      if (method === "configureRuntime") return applied();
      throw new Error(`Unexpected method ${method}`);
    });
  const clients = input.clients ?? providerWith(client);
  const controller = createSessionSettingsController({
    clients,
    view: subject.view,
    beginMutation: input.beginMutation ?? (() => () => {}),
  });
  return { controller, subject, clients, client };
}

function form(controller: SessionSettingsController) {
  const state = controller.state();
  if (
    state.status !== "ready" &&
    state.status !== "refreshing" &&
    state.status !== "saving" &&
    state.status !== "saved" &&
    !(state.status === "error" && state.kind === "save")
  ) {
    throw new Error(`Expected session form state, received ${state.status}`);
  }
  return state;
}

describe("conversation and time settings controller", () => {
  it("loads only timezone into the athlete editor while retaining the full runtime snapshot", async () => {
    const effective = snapshot({
      historyTokenBudgetRatio: 0.41,
      idleMinutes: 37,
      dailyResetHour: 8,
      resetArchiveRetentionDays: 92,
    });
    const call = vi.fn(async () => effective);
    const { controller } = createSubject({ client: clientWith(call) });

    await controller.activate();

    expect(form(controller)).toMatchObject({
      status: "ready",
      draft: { timezone: "UTC" },
      effective: {
        historyTokenBudgetRatio: 0.41,
        idleMinutes: 37,
        dailyResetHour: 8,
        resetArchiveRetentionDays: 92,
      },
      validationErrors: {},
    });
    expect(Object.keys(form(controller).draft)).toEqual(["timezone"]);
  });

  it("keeps an environment-managed timezone read-only", async () => {
    const effective = snapshot({
      managedByEnvironment: {
        ...snapshot().session.managedByEnvironment,
        timezone: true,
      },
    });
    const { controller, subject } = createSubject({
      client: clientWith(async () => effective),
    });

    await controller.activate();
    subject.change("timezone", "Asia/Qyzylorda");
    subject.commit();
    await Promise.resolve();

    expect(form(controller).draft.timezone).toBe("UTC");
    expect(form(controller).dirtyFields.size).toBe(0);
  });

  it("rejects an incomplete timezone without sending a mutation", async () => {
    const call = vi.fn(async (method: string) => {
      if (method === "getRuntimeConfig") return snapshot();
      throw new Error("configure should not run");
    });
    const { controller, subject } = createSubject({ client: clientWith(call) });
    await controller.activate();

    subject.change("timezone", "Asia/");
    subject.commit();
    await Promise.resolve();

    expect(form(controller).validationErrors).toEqual({
      timezone: "Enter a valid IANA timezone, such as Europe/London.",
    });
    expect(call).toHaveBeenCalledExactlyOnceWith("getRuntimeConfig", {});
  });

  it("sends an exact timezone-only patch and rereads the complete authority", async () => {
    const calls: Array<{ readonly method: string; readonly request: unknown }> = [];
    const call = vi.fn(async (method: string, request: unknown) => {
      calls.push({ method, request });
      if (method === "configureRuntime") return applied();
      return calls.length === 1
        ? snapshot({
            historyTokenBudgetRatio: 0.41,
            idleMinutes: 37,
            dailyResetHour: 8,
            resetArchiveRetentionDays: 92,
          })
        : snapshot({
            timezone: "Asia/Qyzylorda",
            historyTokenBudgetRatio: 0.41,
            idleMinutes: 37,
            dailyResetHour: 8,
            resetArchiveRetentionDays: 92,
          });
    });
    const release = vi.fn();
    const beginMutation = vi.fn(() => release);
    const { controller, subject } = createSubject({
      client: clientWith(call),
      beginMutation,
    });
    await controller.activate();

    subject.change("timezone", "Asia/Qyzylorda");
    subject.commit();
    await vi.waitFor(() => expect(controller.state().status).toBe("saved"));

    expect(calls).toEqual([
      { method: "getRuntimeConfig", request: {} },
      {
        method: "configureRuntime",
        request: { session: { timezone: "Asia/Qyzylorda" } },
      },
      { method: "getRuntimeConfig", request: {} },
    ]);
    expect(beginMutation).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(form(controller)).toMatchObject({
      status: "saved",
      draft: { timezone: "Asia/Qyzylorda" },
      effective: {
        historyTokenBudgetRatio: 0.41,
        idleMinutes: 37,
        dailyResetHour: 8,
        resetArchiveRetentionDays: 92,
      },
    });
  });

  it("serializes rapid commits and applies the latest timezone", async () => {
    const first = deferred<ReturnType<typeof applied>>();
    const second = deferred<ReturnType<typeof applied>>();
    const requests: unknown[] = [];
    let reads = 0;
    const call = vi.fn((method: string, request: unknown) => {
      if (method === "getRuntimeConfig") {
        reads += 1;
        if (reads === 1) return Promise.resolve(snapshot());
        if (reads === 2) return Promise.resolve(snapshot({ timezone: "Asia/Qyzylorda" }));
        return Promise.resolve(snapshot({ timezone: "UTC" }));
      }
      requests.push(request);
      return requests.length === 1 ? first.promise : second.promise;
    });
    const release = vi.fn();
    const { controller, subject } = createSubject({
      client: clientWith(call),
      beginMutation: () => release,
    });
    await controller.activate();

    subject.change("timezone", "Asia/Qyzylorda");
    subject.commit();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    subject.change("timezone", "UTC");
    subject.commit();
    expect(form(controller)).toMatchObject({ status: "saving", draft: { timezone: "UTC" } });

    first.resolve(applied());
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(controller.state().status).toBe("saving");
    second.resolve(applied());
    await vi.waitFor(() => expect(controller.state().status).toBe("saved"));

    expect(requests).toEqual([
      { session: { timezone: "Asia/Qyzylorda" } },
      { session: { timezone: "UTC" } },
    ]);
    expect(form(controller).draft.timezone).toBe("UTC");
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not save or overwrite newer uncommitted text", async () => {
    const configure = deferred<ReturnType<typeof applied>>();
    let reads = 0;
    const call = vi.fn((method: string) => {
      if (method === "getRuntimeConfig") {
        reads += 1;
        return Promise.resolve(reads === 1 ? snapshot() : snapshot({ timezone: "Asia/Qyzylorda" }));
      }
      return configure.promise;
    });
    const { controller, subject } = createSubject({ client: clientWith(call) });
    await controller.activate();

    subject.change("timezone", "Asia/Qyzylorda");
    subject.commit();
    await vi.waitFor(() => expect(controller.state().status).toBe("saving"));
    subject.change("timezone", "Asia/");
    subject.commit();
    configure.resolve(applied());
    await vi.waitFor(() => expect(controller.state().status).toBe("ready"));

    expect(call.mock.calls.filter(([method]) => method === "configureRuntime")).toHaveLength(1);
    expect(form(controller)).toMatchObject({
      draft: { timezone: "Asia/" },
      validationErrors: {
        timezone: "Enter a valid IANA timezone, such as Europe/London.",
      },
    });
  });

  it("reloads authority before retrying an ambiguous disconnected save", async () => {
    const disconnected = new CoachClientDisconnectedError(1006, "");
    const firstCall = vi.fn().mockResolvedValueOnce(snapshot()).mockRejectedValueOnce(disconnected);
    const secondCall = vi.fn(async () => snapshot({ timezone: "Asia/Qyzylorda" }));
    const first = clientWith(firstCall);
    const second = clientWith(secondCall);
    const clients: DesktopCoachClientProvider = {
      getClient: vi.fn(async () => first),
      reconnect: vi.fn(async () => second),
      close: vi.fn(async () => {}),
    };
    const { controller, subject } = createSubject({ clients });
    await controller.activate();
    subject.change("timezone", "Asia/Qyzylorda");
    subject.commit();
    await vi.waitFor(() => expect(controller.state().status).toBe("error"));

    subject.retry();
    await vi.waitFor(() => expect(controller.state().status).toBe("saved"));

    expect(clients.reconnect).toHaveBeenCalledOnce();
    expect(secondCall).toHaveBeenCalledExactlyOnceWith("getRuntimeConfig", {});
    expect(firstCall.mock.calls.filter(([method]) => method === "configureRuntime")).toHaveLength(
      1,
    );
    expect(form(controller).draft.timezone).toBe("Asia/Qyzylorda");
  });

  it("does not start a commit while another settings mutation owns the shell", async () => {
    const call = vi.fn(async () => snapshot());
    const { controller, subject } = createSubject({
      client: clientWith(call),
      beginMutation: () => null,
    });
    await controller.activate();

    subject.change("timezone", "Asia/Qyzylorda");
    subject.commit();
    await Promise.resolve();

    expect(call).toHaveBeenCalledExactlyOnceWith("getRuntimeConfig", {});
    expect(form(controller)).toMatchObject({
      status: "ready",
      draft: { timezone: "Asia/Qyzylorda" },
    });
  });

  it("continues an in-flight commit across Settings close and re-entry", async () => {
    const configure = deferred<ReturnType<typeof applied>>();
    let reads = 0;
    const call = vi.fn((method: string) => {
      if (method === "getRuntimeConfig") {
        reads += 1;
        return Promise.resolve(reads === 1 ? snapshot() : snapshot({ timezone: "Asia/Qyzylorda" }));
      }
      return configure.promise;
    });
    const { controller, subject } = createSubject({ client: clientWith(call) });
    await controller.activate();

    subject.change("timezone", "Asia/Qyzylorda");
    subject.commit();
    await vi.waitFor(() => expect(controller.state().status).toBe("saving"));
    controller.close();

    expect(controller.state()).toEqual({ status: "closed" });
    const reentry = controller.activate();
    expect(form(controller)).toMatchObject({
      status: "saving",
      draft: { timezone: "Asia/Qyzylorda" },
    });
    expect(reads).toBe(1);

    configure.resolve(applied());
    await reentry;

    expect(reads).toBe(2);
    expect(form(controller)).toMatchObject({
      status: "saved",
      draft: { timezone: "Asia/Qyzylorda" },
    });
  });

  it("fences a stale load completion after Settings closes", async () => {
    const gate = deferred<RuntimeConfigSnapshot>();
    const { controller, subject } = createSubject({
      client: clientWith(async () => gate.promise),
    });
    const pending = controller.activate();
    controller.close();
    gate.resolve(snapshot());
    await pending;

    expect(controller.state()).toEqual({ status: "closed" });
    expect(subject.view.render).toHaveBeenCalledTimes(1);
    expect(subject.view.render).toHaveBeenLastCalledWith({ status: "loading" });
  });
});
