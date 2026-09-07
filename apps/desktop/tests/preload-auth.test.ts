import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { LLM_MODEL_CATALOGUE } from "../../../packages/core/src/runtime-config.js";

const NAVIGATION_TOKEN = "n".repeat(43);
const RENDERER_URL = `enduragent://app/index.html?navigationToken=${NAVIGATION_TOKEN}`;

const mocks = vi.hoisted(() => {
  const exposed: Record<string, unknown> = {};
  class FakeAnchor {
    constructor(
      readonly href: string,
      readonly target = "_blank",
    ) {}
  }
  class FakeElement {
    closest(selector: string): FakeElement | null {
      return selector === "[data-chat-attachment-dropzone]" ? this : null;
    }
  }
  let clickListener: ((event: Record<string, unknown>) => void) | undefined;
  let dropListener: ((event: Record<string, unknown>) => void) | undefined;
  const fakeWindow = {
    location: {
      href: `enduragent://app/index.html?navigationToken=${"n".repeat(43)}`,
    },
    addEventListener: vi.fn((name: string, listener: typeof clickListener) => {
      if (name === "click") clickListener = listener;
      if (name === "drop") dropListener = listener;
    }),
    removeEventListener: vi.fn((name: string, listener: typeof clickListener) => {
      if (name === "drop" && dropListener === listener) dropListener = undefined;
    }),
    dispatchEvent: vi.fn(),
  };
  const getPathForFile = vi.fn();
  return {
    exposed,
    FakeAnchor,
    FakeElement,
    fakeWindow,
    get clickListener() {
      return clickListener;
    },
    get dropListener() {
      return dropListener;
    },
    getPathForFile,
    exposeInMainWorld: vi.fn((name: string, value: unknown) => {
      exposed[name] = value;
    }),
    invoke: vi.fn(),
    on: vi.fn(),
    send: vi.fn(),
    sendSync: vi.fn((_channel: string, _request?: unknown) => true),
  };
});

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: mocks.exposeInMainWorld },
  ipcRenderer: {
    invoke: mocks.invoke,
    on: mocks.on,
    send: mocks.send,
    sendSync: mocks.sendSync,
  },
  webUtils: { getPathForFile: mocks.getPathForFile },
}));

interface AuthBridge {
  readonly platform: unknown;
  onOpenSettings(listener: unknown): () => void;
  getDaemonConnection(failedGeneration?: number): Promise<unknown>;
  initialSetupStatusSettled(input: unknown): Promise<unknown>;
  getTranscriptPage(input: unknown): Promise<unknown>;
  listArchivedConversations(): Promise<unknown>;
  deleteArchivedConversation(boundaryRef: unknown): Promise<unknown>;
  getArchivedTranscriptPage(input: unknown): Promise<unknown>;
  getPlanningReadModel(): Promise<unknown>;
  getPlanState(): Promise<unknown>;
  executePlanTransition(input: unknown): Promise<unknown>;
  onPlanProgress(listener: (progress: unknown) => void): () => void;
  credentialStatuses(): Promise<unknown>;
  credentialRecoveryStatus(): Promise<unknown>;
  retryCredentialRecovery(): Promise<unknown>;
  resetAllCredentials(): Promise<unknown>;
  deleteCredential(input: unknown): Promise<unknown>;
  retryFailedCredentials(): Promise<unknown>;
  writeCredential(input: unknown): Promise<unknown>;
  llmConfiguration(): Promise<unknown>;
  applyLlmSelection(input: unknown): Promise<unknown>;
  chatgptStatus(): Promise<unknown>;
  chatgptLogin(input: unknown): Promise<unknown>;
  cancelChatgptLogin(input: unknown): Promise<unknown>;
  onChatgptLoginProgress(listener: (progress: unknown) => void): () => void;
  claudeCliStatus(): Promise<unknown>;
  claudeCliRecheck(): Promise<unknown>;
  telegramStatus(): Promise<unknown>;
  setAppearance(appearance: "system" | "light" | "dark"): void;
  pasteIntervalsApiKeyFromClipboard(): Promise<unknown>;
  pasteTelegramTokenFromClipboard(): Promise<unknown>;
  enableTelegram(): Promise<unknown>;
  disableTelegram(): Promise<unknown>;
  removeTelegram(): Promise<unknown>;
  reconcileTelegram(): Promise<unknown>;
  removeTelegramWebhook(): Promise<unknown>;
  beginTelegramPairing(): Promise<unknown>;
  cancelTelegramPairing(): Promise<unknown>;
  listTelegramAllowedSenders(): Promise<unknown>;
  addTelegramAllowedSender(input: unknown): Promise<unknown>;
  removeTelegramAllowedSender(input: unknown): Promise<unknown>;
  acknowledgeTelegramGapWarning(): Promise<unknown>;
  chooseImportFiles(): Promise<readonly string[]>;
  chooseChatAttachments(): Promise<readonly unknown[]>;
  pasteChatAttachment(): Promise<readonly unknown[]>;
  onDroppedChatAttachments(
    listener: (
      event:
        | { readonly phase: "started"; readonly operationId: string }
        | {
            readonly phase: "settled";
            readonly operationId: string;
            readonly results: readonly unknown[] | null;
          },
    ) => boolean | void,
  ): () => void;
  choosePlanRaceCourseFile(): Promise<string | null>;
  exportTrainingFile(input: unknown): Promise<unknown>;
  getUpdateState(): Promise<unknown>;
  checkForUpdates(): Promise<unknown>;
  restartToUpdate(): Promise<unknown>;
  onUpdateState(listener: (state: unknown) => void): () => void;
}

function validTranscriptCursor(): string {
  const bytes = Buffer.alloc(114);
  bytes[0] = 1;
  return bytes.toString("base64url");
}

const BOUNDARY_REF = "b".repeat(64);

function validArchivedCursor(): string {
  const bytes = Buffer.alloc(114);
  bytes[0] = 2;
  bytes[1] = 1;
  bytes.fill(0xcd, 34, 66);
  return bytes.toString("base64url");
}

const chatGptSelection = {
  provider: "openai-codex",
  model: "gpt-5.5",
  endpoint: { mode: "automatic" },
} as const;

const chatGptLoginInput = {
  operationId: "login-1",
  selection: chatGptSelection,
} as const;

const providerOrder = [
  "anthropic",
  "openai",
  "google",
  "openai-codex",
  "claude-cli",
  "codex-agent",
  "deepseek",
  "qwen",
  "minimax",
  "kimi",
  "zai",
  "openrouter",
] as const;

const catalogueProviderOrder = providerOrder.filter((provider) => provider !== "codex-agent");

const defaultEndpointProviders = new Set([
  "deepseek",
  "qwen",
  "minimax",
  "kimi",
  "zai",
  "openrouter",
]);

function pinnedPreloadProviderOrder(): string[] {
  const source = readFileSync(new URL("../src/preload/index.ts", import.meta.url), "utf8");
  const open = source.indexOf("const LLM_PROVIDER_ORDER = [");
  if (open === -1) throw new Error("preload provider order missing");
  const close = source.indexOf("] as const;", open);
  if (close === -1) throw new Error("preload provider order unterminated");
  return [...source.slice(open, close).matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}

function pinnedPreloadOffCatalogueProviders(): string[] {
  const source = readFileSync(new URL("../src/preload/index.ts", import.meta.url), "utf8");
  const open = source.indexOf("const OFF_CATALOGUE_LLM_PROVIDERS = new Set<string>([");
  if (open === -1) throw new Error("preload off-catalogue set missing");
  const close = source.indexOf("]);", open);
  if (close === -1) throw new Error("preload off-catalogue set unterminated");
  return [...source.slice(open, close).matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}

function llmConfiguration() {
  return {
    schemaVersion: 1,
    providers: catalogueProviderOrder.map((provider) => {
      const defaultModel = `${provider}-default`;
      return {
        provider,
        defaultModel,
        models: [{ value: defaultModel, label: `${provider} default` }],
        ...(defaultEndpointProviders.has(provider)
          ? { defaultBaseUrl: `https://${provider}.example.invalid/v1` }
          : {}),
      };
    }),
    active: { provider: "anthropic", model: "athlete-custom-model" },
  };
}

function pinnedSmokeBridgeKeys(): string[] {
  const source = readFileSync(new URL("../scripts/electron-smoke.mjs", import.meta.url), "utf8");
  const anchor = source.indexOf("JSON.stringify(ready.bridgeKeys) ===");
  if (anchor === -1) throw new Error("electron-smoke bridge assertion missing");
  const open = source.indexOf("JSON.stringify([", anchor);
  if (open === -1) throw new Error("electron-smoke bridge literal missing");
  const close = source.indexOf("])", open);
  if (close === -1) throw new Error("electron-smoke bridge literal unterminated");
  return [...source.slice(open, close).matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}

let bridge: AuthBridge;

function documentNavigationToken(): string {
  return (mocks.sendSync.mock.calls[0]![1] as { readonly navigationToken: string }).navigationToken;
}

beforeAll(async () => {
  Object.assign(globalThis, {
    window: mocks.fakeWindow,
    HTMLAnchorElement: mocks.FakeAnchor,
    Element: mocks.FakeElement,
  });
  await import("../src/preload/index.js");
  bridge = mocks.exposed.enduragentAuth as AuthBridge;
});

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.send.mockReset();
  mocks.getPathForFile.mockReset();
  mocks.fakeWindow.dispatchEvent.mockReset();
  Object.assign(globalThis, {
    window: mocks.fakeWindow,
    HTMLAnchorElement: mocks.FakeAnchor,
    Element: mocks.FakeElement,
  });
  mocks.fakeWindow.location.href = RENDERER_URL;
});

describe("desktop preload ChatGPT auth", () => {
  it("confirms the URL navigation token before exposing the public bridge", () => {
    expect(mocks.sendSync).toHaveBeenCalledOnce();
    expect(mocks.sendSync).toHaveBeenCalledWith("desktop:register-document-navigation", {
      navigationToken: NAVIGATION_TOKEN,
    });
    expect(mocks.sendSync.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.exposeInMainWorld.mock.invocationCallOrder[0]!,
    );
    expect(Object.values(mocks.exposed)).not.toContain(documentNavigationToken());
  });

  it("does not expose the public bridge when document registration fails", async () => {
    const exposureCount = mocks.exposeInMainWorld.mock.calls.length;
    mocks.sendSync.mockReturnValueOnce(false);
    vi.resetModules();

    await expect(import("../src/preload/index.js")).rejects.toBeInstanceOf(TypeError);
    expect(mocks.exposeInMainWorld).toHaveBeenCalledTimes(exposureCount);
  });

  it.each([
    "enduragent://app/index.html",
    "enduragent://app/index.html?navigationToken=short",
    `${RENDERER_URL}&extra=true`,
  ])("does not expose or register a non-canonical renderer URL: %s", async (url) => {
    const exposureCount = mocks.exposeInMainWorld.mock.calls.length;
    const registrationCount = mocks.sendSync.mock.calls.length;
    mocks.fakeWindow.location.href = url;
    vi.resetModules();

    try {
      await expect(import("../src/preload/index.js")).rejects.toBeInstanceOf(TypeError);
      expect(mocks.sendSync).toHaveBeenCalledTimes(registrationCount);
      expect(mocks.exposeInMainWorld).toHaveBeenCalledTimes(exposureCount);
    } finally {
      mocks.fakeWindow.location.href = RENDERER_URL;
    }
  });

  it("reuses the connection channel with a closed recovery request", async () => {
    mocks.invoke.mockResolvedValue(undefined);
    await bridge.getDaemonConnection();
    await bridge.getDaemonConnection(7);
    expect(mocks.invoke.mock.calls).toEqual([
      ["desktop:get-daemon-connection", { navigationToken: documentNavigationToken() }],
      [
        "desktop:get-daemon-connection",
        { navigationToken: documentNavigationToken(), generation: 7 },
      ],
    ]);
  });

  it("forwards only a strict positive initial setup generation", async () => {
    mocks.invoke.mockResolvedValue(undefined);
    await expect(bridge.initialSetupStatusSettled({ generation: 4 })).resolves.toBeUndefined();
    expect(mocks.invoke).toHaveBeenCalledWith("desktop:initial-setup-status-settled", {
      navigationToken: documentNavigationToken(),
      generation: 4,
    });
    for (const request of [
      undefined,
      null,
      {},
      { generation: 0 },
      { generation: 1.5 },
      {
        generation: 1,
        extra: true,
      },
    ]) {
      expect(() => bridge.initialSetupStatusSettled(request)).toThrow(TypeError);
    }
    expect(() =>
      (bridge.initialSetupStatusSettled as (...args: unknown[]) => Promise<unknown>)(
        { generation: 1 },
        { generation: 2 },
      ),
    ).toThrow(TypeError);
    expect(mocks.invoke).toHaveBeenCalledOnce();
  });

  it("forwards only closed lifecycle states to the renderer", () => {
    const listener = mocks.on.mock.calls.find(
      ([channel]) => channel === "desktop:daemon-lifecycle",
    )?.[1] as (_event: unknown, value: unknown) => void;
    listener(undefined, { status: "recovering", generation: 2 });
    listener(undefined, { status: "recovering", generation: 0 });
    expect(mocks.fakeWindow.dispatchEvent).toHaveBeenCalledTimes(1);
    expect(mocks.fakeWindow.dispatchEvent.mock.calls[0]![0]).toMatchObject({
      type: "enduragent-lifecycle",
      detail: { status: "recovering", generation: 2 },
    });
  });

  it("keeps the external-link sender private while preserving the exact public bridge", () => {
    expect(Object.keys(mocks.exposed)).toEqual(["enduragentAuth"]);
    expect(Object.keys(bridge).sort()).toEqual(
      [
        "applyLlmSelection",
        "acknowledgeTelegramGapWarning",
        "addTelegramAllowedSender",
        "beginTelegramPairing",
        "cancelTelegramPairing",
        "cancelChatgptLogin",
        "chatgptLogin",
        "chatgptStatus",
        "chooseChatAttachments",
        "chooseImportFiles",
        "choosePlanRaceCourseFile",
        "claudeCliRecheck",
        "claudeCliStatus",
        "credentialStatuses",
        "credentialRecoveryStatus",
        "deleteArchivedConversation",
        "deleteCredential",
        "disableTelegram",
        "enableTelegram",
        "executePlanTransition",
        "exportTrainingFile",
        "getUpdateState",
        "getDaemonConnection",
        "getPlanState",
        "getTranscriptPage",
        "getPlanningReadModel",
        "initialSetupStatusSettled",
        "listArchivedConversations",
        "listTelegramAllowedSenders",
        "getArchivedTranscriptPage",
        "llmConfiguration",
        "checkForUpdates",
        "onChatgptLoginProgress",
        "onDroppedChatAttachments",
        "onDroppedImportFiles",
        "onPlanProgress",
        "onOpenSettings",
        "onUpdateState",
        "pasteChatAttachment",
        "pasteIntervalsApiKeyFromClipboard",
        "pasteTelegramTokenFromClipboard",
        "platform",
        "reconcileTelegram",
        "removeTelegram",
        "removeTelegramAllowedSender",
        "removeTelegramWebhook",
        "restartToUpdate",
        "resetAllCredentials",
        "retryCredentialRecovery",
        "retryFailedCredentials",
        "setAppearance",
        "telegramStatus",
        "writeCredential",
      ].sort(),
    );
    expect(bridge).not.toHaveProperty("openExternal");
  });

  it("hands dropped attachment work to the renderer before admission starts", async () => {
    type DropEvent =
      | { readonly phase: "started"; readonly operationId: string }
      | {
          readonly phase: "settled";
          readonly operationId: string;
          readonly results: readonly unknown[] | null;
        };
    const events: DropEvent[] = [];
    const dispose = bridge.onDroppedChatAttachments((event) => {
      events.push(event);
      return event.phase === "started";
    });
    const drop = mocks.dropListener;
    if (drop === undefined) throw new TypeError("drop listener missing");
    mocks.getPathForFile.mockReturnValue("/tmp/synthetic-recovery.jpg");
    let resolveAdmission!: (value: unknown) => void;
    mocks.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAdmission = resolve;
        }),
    );
    const event = {
      target: new mocks.FakeElement(),
      preventDefault: vi.fn(),
      dataTransfer: { files: [{}] },
    };

    drop(event);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ phase: "started" });
    expect(mocks.invoke).toHaveBeenCalledWith("desktop:chat-attachment:drop", [
      "/tmp/synthetic-recovery.jpg",
    ]);
    resolveAdmission([
      {
        selectionId: "selection-drop-1",
        displayName: "synthetic-recovery.jpg",
        status: "accepted",
        attachmentId: "attachment-drop-1",
      },
    ]);
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events[1]).toEqual({
      phase: "settled",
      operationId: events[0]!.operationId,
      results: [
        {
          selectionId: "selection-drop-1",
          displayName: "synthetic-recovery.jpg",
          status: "accepted",
          attachmentId: "attachment-drop-1",
        },
      ],
    });

    mocks.invoke.mockRejectedValueOnce(new Error("synthetic admission failure"));
    drop(event);
    await vi.waitFor(() => expect(events).toHaveLength(4));
    expect(events[3]).toEqual({
      phase: "settled",
      operationId: events[2]!.operationId,
      results: null,
    });
    dispose();

    mocks.invoke.mockClear();
    const disposeBlocked = bridge.onDroppedChatAttachments(() => false);
    const blockedDrop = mocks.dropListener;
    if (blockedDrop === undefined) throw new TypeError("blocked drop listener missing");
    blockedDrop(event);
    expect(mocks.invoke).not.toHaveBeenCalled();
    disposeBlocked();
  });

  it("sends only the three supported appearances to the main process", () => {
    bridge.setAppearance("system");
    bridge.setAppearance("light");
    bridge.setAppearance("dark");

    expect(mocks.send.mock.calls).toEqual([
      ["desktop:set-appearance", "system"],
      ["desktop:set-appearance", "light"],
      ["desktop:set-appearance", "dark"],
    ]);
  });

  it("refuses an appearance outside the three supported values", () => {
    for (const value of ["Dark", "auto", "", " dark", 1, null, undefined, { appearance: "dark" }]) {
      expect(() => bridge.setAppearance(value as never)).toThrow(TypeError);
    }
    expect(() => (bridge.setAppearance as (...args: unknown[]) => void)("dark", "extra")).toThrow(
      TypeError,
    );

    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("keeps the release-gate smoke bridge list byte-equal to the sorted public bridge", () => {
    expect(pinnedSmokeBridgeKeys()).toEqual(Object.keys(bridge).sort());
  });

  it("validates and copies strict Planning state, commands, and progress", async () => {
    const state = {
      schemaVersion: 1,
      scenarioId: "PL-S001",
      lifecycle: "none",
      planId: null,
      revision: 0,
      title: "Plan",
      summary: "No active Plan",
      projection: "no-plan",
      transitions: [{ transitionId: "PL-T01", status: "available", reason: null }],
      reconciliation: {
        status: "not-applicable",
        created: 0,
        pending: 0,
        failed: 0,
        total: 0,
        currentThrough: null,
        error: null,
      },
      attention: { count: 0, destination: "none", items: [] },
      activeOperation: null,
      data: {},
    };
    const command = {
      transitionId: "PL-T01",
      commandId: "command-1",
      sourceConversationId: null,
    };
    mocks.invoke
      .mockResolvedValueOnce({ status: "ready", state })
      .mockResolvedValueOnce({ status: "completed", state });

    await expect(bridge.getPlanState()).resolves.toEqual({ status: "ready", state });
    await expect(bridge.executePlanTransition(command)).resolves.toEqual({
      status: "completed",
      state,
    });
    expect(mocks.invoke.mock.calls).toEqual([
      ["desktop:plan:get-state"],
      ["desktop:plan:execute-transition", command],
    ]);

    const received: unknown[] = [];
    const dispose = bridge.onPlanProgress((value) => received.push(value));
    const listener = mocks.on.mock.calls.find(
      ([channel]) => channel === "desktop:plan:progress",
    )?.[1] as (_event: unknown, value: unknown) => void;
    const progress = {
      commandId: "command-1",
      transitionId: "PL-T01",
      operationId: "operation-1",
      phase: "completed",
      completed: 1,
      total: 1,
    };
    listener(undefined, progress);
    listener(undefined, { ...progress, total: 0 });
    expect(received).toEqual([progress]);
    expect(received[0]).not.toBe(progress);
    dispose();
    listener(undefined, progress);
    expect(received).toHaveLength(1);
  });

  it("rejects malformed Planning commands and daemon results", async () => {
    await expect(
      bridge.executePlanTransition({ transitionId: "PL-T01", commandId: "command-1" }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(mocks.invoke).not.toHaveBeenCalled();

    mocks.invoke.mockResolvedValueOnce({
      status: "ready",
      state: { schemaVersion: 1, scenarioId: "PL-S999" },
    });
    await expect(bridge.getPlanState()).rejects.toBeInstanceOf(TypeError);
  });

  it("exports only a closed training request and validates the minimized result", async () => {
    const request = {
      kind: "activity",
      canonicalActivityId: "a".repeat(64),
      localDate: "1998-07-19",
      format: "fit",
    };
    mocks.invoke.mockResolvedValue({ status: "saved", byteLength: 4096 });

    await expect(bridge.exportTrainingFile(request)).resolves.toEqual({
      status: "saved",
      byteLength: 4096,
    });
    expect(mocks.invoke).toHaveBeenCalledWith("desktop:training:export", request);

    await expect(
      bridge.exportTrainingFile({ ...request, canonicalActivityId: "provider-activity-42" }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      bridge.exportTrainingFile({ ...request, localDate: "1998-02-30" }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      bridge.exportTrainingFile({ ...request, destinationPath: "/tmp/private.fit" }),
    ).rejects.toBeInstanceOf(TypeError);

    mocks.invoke.mockResolvedValue({ status: "saved", byteLength: 0 });
    await expect(bridge.exportTrainingFile(request)).rejects.toBeInstanceOf(TypeError);
    mocks.invoke.mockResolvedValue({ status: "refused", reason: "private-provider-detail" });
    await expect(bridge.exportTrainingFile(request)).rejects.toBeInstanceOf(TypeError);
  });

  it("accepts platform-absolute import paths and validates uppercase extensions", async () => {
    const paths = [
      "C:\\x\\ride.FIT",
      "C:/x/second-ride.gpx",
      "\\\\server\\share\\ride.gpx",
      "/home/x/ride.tcx",
    ] as const;
    mocks.invoke.mockResolvedValue(paths);

    await expect(bridge.chooseImportFiles()).resolves.toEqual(paths);
    expect(mocks.invoke).toHaveBeenCalledWith("enduragent:onboarding:choose-import-files");
  });

  it("accepts one platform-absolute Race Course path or cancellation", async () => {
    mocks.invoke.mockResolvedValue("C:\\x\\course.GPX");
    await expect(bridge.choosePlanRaceCourseFile()).resolves.toBe("C:\\x\\course.GPX");
    expect(mocks.invoke).toHaveBeenCalledWith("desktop:plan:choose-course-file");
    mocks.invoke.mockResolvedValue(null);
    await expect(bridge.choosePlanRaceCourseFile()).resolves.toBeNull();
    mocks.invoke.mockResolvedValue("relative/course.gpx");
    await expect(bridge.choosePlanRaceCourseFile()).rejects.toBeInstanceOf(TypeError);
  });

  it.each([
    ["a bad extension", ["/home/x/ride.txt"]],
    ["duplicate paths", ["/home/x/ride.fit", "/home/x/ride.fit"]],
    ["more than 256 paths", Array.from({ length: 257 }, (_, index) => `/home/x/ride-${index}.fit`)],
  ])("rejects import results with %s", async (_case, paths) => {
    mocks.invoke.mockResolvedValue(paths);

    await expect(bridge.chooseImportFiles()).rejects.toBeInstanceOf(TypeError);
  });

  it("accepts closed workout archive ranges and rejects inverted ranges", async () => {
    const request = {
      kind: "workout-archive",
      oldest: "1998-07-20",
      newest: "1998-07-26",
      format: "zwo",
    };
    mocks.invoke.mockResolvedValue({ status: "cancelled" });
    await expect(bridge.exportTrainingFile(request)).resolves.toEqual({ status: "cancelled" });
    await expect(
      bridge.exportTrainingFile({ ...request, oldest: "1998-07-27" }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("exposes semantic Telegram controls and validates redacted snapshots", async () => {
    const status = {
      channel: {
        desiredState: "enabled",
        state: "online",
        lastSuccessfulPollAt: "1998-06-01T00:00:00.000Z",
      },
      bot: { state: "ready", username: "synthetic_bot" },
      pairing: { state: "paired" },
      credentialConfigured: true,
      gapWarning: { state: "clear" },
    };
    const applied = { outcome: "applied", current: status };
    mocks.invoke.mockResolvedValue(applied);
    mocks.invoke.mockResolvedValueOnce(status);

    await expect(bridge.telegramStatus()).resolves.toEqual(status);
    await expect(bridge.pasteTelegramTokenFromClipboard()).resolves.toEqual(applied);
    await expect(bridge.enableTelegram()).resolves.toEqual(applied);
    await expect(bridge.disableTelegram()).resolves.toEqual(applied);
    await expect(bridge.removeTelegram()).resolves.toEqual(applied);
    await expect(bridge.reconcileTelegram()).resolves.toEqual(applied);
    await expect(bridge.removeTelegramWebhook()).resolves.toEqual(applied);
    await expect(bridge.beginTelegramPairing()).resolves.toEqual(applied);
    await expect(bridge.cancelTelegramPairing()).resolves.toEqual(applied);
    await expect(bridge.acknowledgeTelegramGapWarning()).resolves.toEqual(applied);
    expect(mocks.invoke.mock.calls).toEqual([
      ["desktop:telegram:status"],
      ["desktop:telegram:paste-credential"],
      ["desktop:telegram:enable"],
      ["desktop:telegram:disable"],
      ["desktop:telegram:remove"],
      ["desktop:telegram:reconcile"],
      ["desktop:telegram:remove-webhook"],
      ["desktop:telegram:pairing:begin"],
      ["desktop:telegram:pairing:cancel"],
      ["desktop:telegram:gap-warning:acknowledge"],
    ]);

    mocks.invoke.mockClear();
    await expect(
      (bridge.telegramStatus as unknown as (...args: unknown[]) => Promise<unknown>)("token"),
    ).rejects.toBeInstanceOf(TypeError);
    expect(mocks.invoke).not.toHaveBeenCalled();

    mocks.invoke.mockResolvedValue({ ...status, token: "must-not-cross" });
    await expect(bridge.telegramStatus()).rejects.toBeInstanceOf(TypeError);

    mocks.invoke.mockResolvedValue({
      ...status,
      channel: { ...status.channel, lastSuccessfulPollAt: "not-canonical" },
    });
    await expect(bridge.telegramStatus()).rejects.toBeInstanceOf(TypeError);

    for (const state of ["invalid-token", "conflict"] as const) {
      mocks.invoke.mockResolvedValue({
        ...status,
        channel: {
          desiredState: "disabled",
          state,
          errorCode:
            state === "invalid-token" ? "telegram-invalid-token" : "telegram-polling-conflict",
        },
      });
      await expect(bridge.telegramStatus()).rejects.toBeInstanceOf(TypeError);
    }
  });

  it("exposes a zero-argument Intervals.icu clipboard lane with a copied result", async () => {
    const current = {
      slot: "intervals-icu",
      state: "configured",
      runtimeState: "active",
    };
    const result = { outcome: "applied", current };
    mocks.invoke.mockResolvedValueOnce(result);

    const copied = (await bridge.pasteIntervalsApiKeyFromClipboard()) as typeof result;

    expect(copied).toEqual(result);
    expect(copied).not.toBe(result);
    expect(copied.current).not.toBe(current);
    expect(mocks.invoke).toHaveBeenCalledWith("desktop:intervals:paste-credential");

    mocks.invoke.mockClear();
    await expect(
      (
        bridge.pasteIntervalsApiKeyFromClipboard as unknown as (
          ...args: unknown[]
        ) => Promise<unknown>
      )("must-not-cross"),
    ).rejects.toBeInstanceOf(TypeError);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it.each([
    "clipboard-unavailable",
    "clipboard-clear-failed",
    "invalid-key-format",
    "credential-rejected",
    "malformed-athlete-response",
    "validation-timeout",
    "validation-aborted",
    "validation-unavailable",
    "training-account-mismatch",
    "owner-unresolved",
    "store-unavailable",
    "encryption-unavailable",
    "unsafe-backend",
    "storage-failed",
    "runtime-unavailable",
  ] as const)("accepts the closed Intervals.icu refusal reason %s", async (reason) => {
    const result = {
      outcome: "refused",
      reason,
      current: { slot: "intervals-icu", state: "missing", runtimeState: null },
    };
    mocks.invoke.mockResolvedValueOnce(result);

    const copied = (await bridge.pasteIntervalsApiKeyFromClipboard()) as typeof result;

    expect(copied).toEqual(result);
    expect(copied).not.toBe(result);
    expect(copied.current).not.toBe(result.current);
  });

  it("accepts only exact secret-safe Intervals.icu clipboard envelopes", async () => {
    const current = { slot: "intervals-icu", state: "re-prompt", runtimeState: null };
    const uncertain = { outcome: "uncertain", reason: "storage-uncertain", current };
    mocks.invoke.mockResolvedValueOnce(uncertain);

    const copied = (await bridge.pasteIntervalsApiKeyFromClipboard()) as typeof uncertain;

    expect(copied).toEqual(uncertain);
    expect(copied).not.toBe(uncertain);
    expect(copied.current).not.toBe(current);

    const runtimeUncertain = { ...uncertain, reason: "runtime-uncertain" };
    mocks.invoke.mockResolvedValueOnce(runtimeUncertain);
    const copiedRuntimeUncertain =
      (await bridge.pasteIntervalsApiKeyFromClipboard()) as typeof runtimeUncertain;
    expect(copiedRuntimeUncertain).toEqual(runtimeUncertain);
    expect(copiedRuntimeUncertain).not.toBe(runtimeUncertain);
    expect(copiedRuntimeUncertain.current).not.toBe(current);

    for (const malformed of [
      { ...uncertain, apiKey: "must-not-cross" },
      { ...uncertain, reason: "storage-failed" },
      { ...uncertain, current: { ...current, owner: "private" } },
      {
        outcome: "applied",
        current: { slot: "intervals-icu", state: "configured", runtimeState: null },
      },
      {
        outcome: "refused",
        reason: "private-network-detail",
        current,
      },
      {
        outcome: "refused",
        reason: "credential-rejected",
        current: { slot: "other", state: "missing", runtimeState: null },
      },
    ]) {
      mocks.invoke.mockResolvedValueOnce(malformed);
      const failure = await bridge
        .pasteIntervalsApiKeyFromClipboard()
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(TypeError);
      expect((failure as TypeError).message).toBe("");
    }
  });

  it("redacts Intervals.icu clipboard invocation failures", async () => {
    const privateDetail =
      "private-api-key at /Users/private/intervals-key and athlete-response-body";
    mocks.invoke.mockRejectedValueOnce(new Error(privateDetail));

    const failure = await bridge
      .pasteIntervalsApiKeyFromClipboard()
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as TypeError).message).toBe("");
    expect(String(failure)).not.toContain(privateDetail);
    expect(String(failure)).not.toContain("/Users/private/intervals-key");
  });

  it("accepts only closed secret-safe Telegram mutation envelopes", async () => {
    const current = {
      channel: { desiredState: "enabled", state: "online" },
      bot: { state: "ready", username: "synthetic_bot" },
      pairing: { state: "paired" },
      credentialConfigured: true,
      gapWarning: { state: "clear" },
    };
    const refusal = { outcome: "refused", reason: "invalid-token", current };
    mocks.invoke.mockResolvedValueOnce(refusal);

    await expect(bridge.pasteTelegramTokenFromClipboard()).resolves.toEqual(refusal);

    const secureStorageRefusal = {
      outcome: "refused",
      reason: "encryption-unavailable",
      current,
    };
    mocks.invoke.mockResolvedValueOnce(secureStorageRefusal);
    await expect(bridge.pasteTelegramTokenFromClipboard()).resolves.toEqual(secureStorageRefusal);

    const unsafeBackendRefusal = {
      outcome: "refused",
      reason: "unsafe-backend",
      current,
    };
    mocks.invoke.mockResolvedValueOnce(unsafeBackendRefusal);
    await expect(bridge.pasteTelegramTokenFromClipboard()).resolves.toEqual(unsafeBackendRefusal);

    const controlUncertainty = {
      outcome: "uncertain",
      reason: "control-uncertain",
      current,
    };
    mocks.invoke.mockResolvedValueOnce(controlUncertainty);
    await expect(bridge.pasteTelegramTokenFromClipboard()).resolves.toEqual(controlUncertainty);

    for (const malformed of [
      { ...refusal, token: "must-not-cross" },
      { ...refusal, exception: "private detail" },
      { ...refusal, reason: "arbitrary-private-reason" },
      { outcome: "uncertain", reason: "storage-failed", current },
    ]) {
      mocks.invoke.mockResolvedValueOnce(malformed);
      await expect(bridge.pasteTelegramTokenFromClipboard()).rejects.toBeInstanceOf(TypeError);
    }
  });

  it("redacts every Telegram IPC rejection", async () => {
    const privateDetail =
      "https://bot.example.invalid/123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi at /Users/private/id_rsa PRIVATE_KEY";
    const operations = [
      () => bridge.telegramStatus(),
      () => bridge.pasteTelegramTokenFromClipboard(),
      () => bridge.enableTelegram(),
      () => bridge.disableTelegram(),
      () => bridge.removeTelegram(),
      () => bridge.reconcileTelegram(),
      () => bridge.removeTelegramWebhook(),
      () => bridge.beginTelegramPairing(),
      () => bridge.cancelTelegramPairing(),
      () => bridge.acknowledgeTelegramGapWarning(),
      () => bridge.listTelegramAllowedSenders(),
    ];

    for (const operation of operations) {
      mocks.invoke.mockRejectedValueOnce(new Error(privateDetail));
      const failure = await operation().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(TypeError);
      expect((failure as TypeError).message).toBe("");
      expect(String(failure)).not.toContain(privateDetail);
      expect(String(failure)).not.toContain("/Users/private/id_rsa");
      expect(String(failure)).not.toContain("PRIVATE_KEY");
    }

    for (const operation of [
      () => bridge.addTelegramAllowedSender({ senderId: 84 }),
      () => bridge.removeTelegramAllowedSender({ senderId: 84 }),
    ]) {
      mocks.invoke.mockRejectedValueOnce(new Error(privateDetail));
      await expect(operation()).resolves.toEqual({
        outcome: "uncertain",
        reason: "control-uncertain",
      });
    }
  });

  it("redacts Telegram status and sender-list parse failures independently", async () => {
    const privateDetail =
      "https://bot.example.invalid/123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi at /Users/private/id_ed25519 PRIVATE_KEY";
    const malformedResponses = [
      () => {
        mocks.invoke.mockResolvedValueOnce({
          channel: { desiredState: "enabled", state: "online" },
          bot: { state: "ready", username: "synthetic_bot" },
          pairing: { state: "paired" },
          credentialConfigured: true,
          gapWarning: { state: "clear" },
          privateKeyPath: privateDetail,
        });
        return bridge.telegramStatus();
      },
      () => {
        mocks.invoke.mockResolvedValueOnce({
          senders: [{ senderId: 42, role: "primary", privateKeyName: privateDetail }],
        });
        return bridge.listTelegramAllowedSenders();
      },
    ];

    for (const operation of malformedResponses) {
      const failure = await operation().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(TypeError);
      expect((failure as TypeError).message).toBe("");
      expect(String(failure)).not.toContain(privateDetail);
      expect(String(failure)).not.toContain("PRIVATE_KEY");
    }
  });

  it("accepts an honest suspended Telegram channel status", async () => {
    const status = {
      channel: { desiredState: "enabled", state: "suspended" },
      bot: { state: "ready", username: "synthetic_bot" },
      pairing: { state: "paired" },
      credentialConfigured: true,
      gapWarning: { state: "clear" },
    };
    mocks.invoke.mockResolvedValueOnce(status);

    await expect(bridge.telegramStatus()).resolves.toEqual(status);
  });

  it("accepts only the redacted Telegram settings storage uncertainty code", async () => {
    const status = {
      channel: {
        desiredState: "enabled",
        state: "failed",
        errorCode: "telegram-settings-storage-uncertain",
      },
      bot: { state: "ready", username: "synthetic_bot" },
      pairing: { state: "unpaired" },
      credentialConfigured: true,
      gapWarning: { state: "clear" },
    };
    mocks.invoke.mockResolvedValueOnce(status);

    await expect(bridge.telegramStatus()).resolves.toEqual(status);

    mocks.invoke.mockResolvedValueOnce({
      ...status,
      channel: { ...status.channel, privateDetail: "private disk path" },
    });
    await expect(bridge.telegramStatus()).rejects.toBeInstanceOf(TypeError);
  });

  it.each([
    "telegram-credential-encryption-unavailable",
    "telegram-credential-unsafe-backend",
  ] as const)("accepts the closed redacted %s status code", async (errorCode) => {
    const status = {
      channel: { desiredState: "enabled", state: "failed", errorCode },
      bot: { state: "unconfigured" },
      pairing: { state: "unpaired" },
      credentialConfigured: false,
      gapWarning: { state: "clear" },
    };
    mocks.invoke.mockResolvedValueOnce(status);

    await expect(bridge.telegramStatus()).resolves.toEqual(status);
  });

  it("accepts only the redacted pairing storage uncertainty code", async () => {
    const status = {
      channel: { desiredState: "disabled", state: "disabled" },
      bot: { state: "ready", username: "synthetic_bot" },
      pairing: { state: "failed", errorCode: "telegram-pairing-storage-uncertain" },
      credentialConfigured: true,
      gapWarning: { state: "clear" },
    };
    mocks.invoke.mockResolvedValueOnce(status);

    await expect(bridge.telegramStatus()).resolves.toEqual(status);

    mocks.invoke.mockResolvedValueOnce({
      ...status,
      pairing: {
        state: "failed",
        errorCode: "telegram-pairing-storage-uncertain",
        privateDetail: "private disk path",
      },
    });
    await expect(bridge.telegramStatus()).rejects.toBeInstanceOf(TypeError);
  });

  it("validates Telegram sender management at the preload boundary", async () => {
    const senders = {
      senders: [
        {
          senderId: 42,
          role: "primary",
          addedAt: "1998-07-06T00:00:00.000Z",
        },
      ],
    };
    mocks.invoke
      .mockResolvedValueOnce(senders)
      .mockResolvedValueOnce({ outcome: "applied", current: senders })
      .mockResolvedValueOnce({ outcome: "uncertain", reason: "storage-uncertain" })
      .mockResolvedValueOnce({ outcome: "uncertain", reason: "control-uncertain" })
      .mockResolvedValueOnce({ outcome: "refused", reason: "invalid-state" });

    await expect(bridge.listTelegramAllowedSenders()).resolves.toEqual(senders);
    await expect(bridge.addTelegramAllowedSender({ senderId: 84 })).resolves.toEqual({
      outcome: "applied",
      current: senders,
    });
    await expect(bridge.removeTelegramAllowedSender({ senderId: 84 })).resolves.toEqual({
      outcome: "uncertain",
      reason: "storage-uncertain",
    });
    await expect(bridge.addTelegramAllowedSender({ senderId: 84 })).resolves.toEqual({
      outcome: "uncertain",
      reason: "control-uncertain",
    });
    await expect(bridge.removeTelegramAllowedSender({ senderId: 84 })).resolves.toEqual({
      outcome: "refused",
      reason: "invalid-state",
    });
    expect(mocks.invoke.mock.calls).toEqual([
      ["desktop:telegram:allowed-senders:list"],
      ["desktop:telegram:allowed-senders:add", { senderId: 84 }],
      ["desktop:telegram:allowed-senders:remove", { senderId: 84 }],
      ["desktop:telegram:allowed-senders:add", { senderId: 84 }],
      ["desktop:telegram:allowed-senders:remove", { senderId: 84 }],
    ]);

    mocks.invoke.mockClear();
    for (const value of [{ senderId: 9 }, { senderId: 42, extra: true }, { senderId: "42" }]) {
      await expect(bridge.addTelegramAllowedSender(value)).rejects.toBeInstanceOf(TypeError);
    }
    expect(mocks.invoke).not.toHaveBeenCalled();

    mocks.invoke.mockResolvedValue({ senders: [{ senderId: 42, role: "additional" }] });
    await expect(bridge.listTelegramAllowedSenders()).rejects.toBeInstanceOf(TypeError);

    mocks.invoke.mockResolvedValueOnce({
      outcome: "uncertain",
      reason: "storage-uncertain",
      current: senders,
    });
    await expect(bridge.addTelegramAllowedSender({ senderId: 84 })).resolves.toEqual({
      outcome: "uncertain",
      reason: "control-uncertain",
    });

    mocks.invoke.mockRejectedValueOnce(new Error("private token and /private/path"));
    await expect(bridge.removeTelegramAllowedSender({ senderId: 84 })).resolves.toEqual({
      outcome: "uncertain",
      reason: "control-uncertain",
    });
  });

  it("validates and copies strict bounded transcript pages", async () => {
    const cursor = validTranscriptCursor();
    const response = {
      schemaVersion: 1,
      status: "page",
      turns: [
        {
          turnId: "turn-1",
          completedAt: "1998-07-06T00:00:00.000Z",
          athleteText: "a",
          coachText: "b",
          attachments: [
            {
              attachmentId: "attachment-1",
              displayName: "training-notes.txt",
              kind: "document",
              extension: "txt",
            },
          ],
        },
      ],
      nextCursor: cursor,
    };
    mocks.invoke.mockResolvedValueOnce(response);

    const page = await bridge.getTranscriptPage({ cursor: null, limit: 25 });

    expect(page).toEqual(response);
    expect(page).not.toBe(response);
    expect(mocks.invoke).toHaveBeenCalledWith("desktop:get-transcript-page", {
      cursor: null,
      limit: 25,
    });
  });

  it("validates decision-aware transcript pages with typed Plan references", async () => {
    const turn = {
      turnId: "turn-1",
      completedAt: "1998-07-06T00:00:00.000Z",
      athleteText: "Show Tuesday",
      coachText: "Tempo builder",
      planReference: { kind: "workout_detail", planId: "plan-1", workoutId: "workout-1" },
    };
    const response = {
      schemaVersion: 2,
      status: "page",
      turns: [turn],
      entries: [{ kind: "turn", ...turn }],
      nextCursor: null,
    };
    mocks.invoke.mockResolvedValueOnce(response);

    await expect(bridge.getTranscriptPage({ cursor: null, limit: 25 })).resolves.toEqual(response);

    mocks.invoke.mockResolvedValueOnce({
      ...response,
      turns: [
        { ...turn, planReference: { ...turn.planReference, markup: "<button>Apply</button>" } },
      ],
      entries: [
        {
          kind: "turn",
          ...turn,
          planReference: { ...turn.planReference, markup: "<button>Apply</button>" },
        },
      ],
    });
    await expect(bridge.getTranscriptPage({ cursor: null, limit: 25 })).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it("validates and copies the Planning-owned read model", async () => {
    const response = {
      schemaVersion: 1,
      status: "no-plan",
      asOfDateKey: 20260826,
      plan: null,
    };
    mocks.invoke.mockResolvedValueOnce(response);
    const value = await bridge.getPlanningReadModel();
    expect(value).toEqual(response);
    expect(value).not.toBe(response);
    expect(mocks.invoke).toHaveBeenCalledWith("desktop:planning:read");

    mocks.invoke.mockResolvedValueOnce({ ...response, athleteHome: "/private/athlete" });
    await expect(bridge.getPlanningReadModel()).rejects.toBeInstanceOf(TypeError);
  });

  it("rejects malformed transcript requests before IPC and redacts malformed responses", async () => {
    for (const request of [
      null,
      {},
      { cursor: null, limit: 0 },
      { cursor: null, limit: 51 },
      { cursor: "a".repeat(152), limit: 10 },
      { cursor: null, limit: 10, path: "/private/transcript" },
    ]) {
      await expect(bridge.getTranscriptPage(request)).rejects.toBeInstanceOf(TypeError);
    }
    expect(mocks.invoke).not.toHaveBeenCalled();

    for (const response of [
      {
        schemaVersion: 1,
        status: "restart-required",
        turns: [],
        nextCursor: validTranscriptCursor(),
      },
      {
        schemaVersion: 1,
        status: "page",
        turns: [],
        nextCursor: null,
        transcriptPath: "/private/transcript",
      },
      {
        schemaVersion: 1,
        status: "page",
        turns: [
          {
            turnId: "turn-1",
            completedAt: "not-a-timestamp",
            athleteText: "a",
            coachText: "b",
          },
        ],
        nextCursor: null,
      },
      {
        schemaVersion: 1,
        status: "page",
        turns: [
          {
            turnId: "turn-1",
            completedAt: "1998-07-06T00:00:00.000Z",
            athleteText: "a",
            coachText: "b",
            attachments: [
              {
                attachmentId: "attachment-1",
                displayName: "ride.fit",
                kind: "activity",
                extension: "fit",
                sourcePath: "/private/ride.fit",
              },
            ],
          },
        ],
        nextCursor: null,
      },
    ]) {
      mocks.invoke.mockResolvedValueOnce(response);
      await expect(bridge.getTranscriptPage({ cursor: null, limit: 10 })).rejects.toBeInstanceOf(
        TypeError,
      );
    }
  });

  it("validates and copies archived conversation lists and archived pages", async () => {
    const list = {
      schemaVersion: 1,
      conversations: [
        {
          boundaryRef: BOUNDARY_REF,
          boundaryAt: "1998-07-06T00:00:00.000Z",
          reason: "explicit-reset",
          turnCount: 3,
        },
      ],
      truncated: false,
    };
    const cursor = validArchivedCursor();
    const archivedPage = {
      schemaVersion: 1,
      status: "page",
      turns: [
        {
          turnId: "turn-1",
          completedAt: "1998-07-06T00:00:00.000Z",
          athleteText: "a",
          coachText: "b",
        },
      ],
      nextCursor: cursor,
    };
    mocks.invoke.mockResolvedValueOnce(list).mockResolvedValueOnce(archivedPage);

    const listed = await bridge.listArchivedConversations();
    expect(listed).toEqual(list);
    expect(listed).not.toBe(list);
    const paged = await bridge.getArchivedTranscriptPage({
      boundaryRef: BOUNDARY_REF,
      cursor,
      limit: 25,
    });
    expect(paged).toEqual(archivedPage);
    expect(mocks.invoke.mock.calls).toEqual([
      ["desktop:list-archived-conversations"],
      ["desktop:get-archived-transcript-page", { boundaryRef: BOUNDARY_REF, cursor, limit: 25 }],
    ]);
  });

  it("rejects malformed archive requests before IPC and redacts malformed archive responses", async () => {
    for (const request of [
      null,
      {},
      { boundaryRef: BOUNDARY_REF, cursor: null, limit: 0 },
      { boundaryRef: BOUNDARY_REF, cursor: null, limit: 51 },
      { boundaryRef: BOUNDARY_REF.toUpperCase(), cursor: null, limit: 25 },
      { boundaryRef: BOUNDARY_REF, cursor: validTranscriptCursor(), limit: 25 },
      { cursor: null, limit: 25 },
      { boundaryRef: BOUNDARY_REF, cursor: null, limit: 25, path: "/private/transcript" },
    ]) {
      await expect(bridge.getArchivedTranscriptPage(request)).rejects.toBeInstanceOf(TypeError);
    }
    expect(mocks.invoke).not.toHaveBeenCalled();

    for (const response of [
      { schemaVersion: 1, conversations: [], truncated: true },
      {
        schemaVersion: 1,
        conversations: [
          {
            boundaryRef: BOUNDARY_REF,
            boundaryAt: "1998-07-06T00:00:00.000Z",
            reason: "idle-reset",
            turnCount: 1,
          },
        ],
        truncated: false,
      },
      {
        schemaVersion: 1,
        conversations: [
          {
            boundaryRef: BOUNDARY_REF,
            boundaryAt: "1998-07-06T00:00:00.000Z",
            reason: "explicit-reset",
            turnCount: 1,
          },
        ],
        truncated: false,
        transcriptPath: "/private/transcript",
      },
    ]) {
      mocks.invoke.mockResolvedValueOnce(response);
      await expect(bridge.listArchivedConversations()).rejects.toBeInstanceOf(TypeError);
    }

    mocks.invoke.mockResolvedValueOnce({
      schemaVersion: 1,
      status: "page",
      turns: [],
      nextCursor: validTranscriptCursor(),
    });
    await expect(
      bridge.getArchivedTranscriptPage({ boundaryRef: BOUNDARY_REF, cursor: null, limit: 25 }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("validates archived conversation deletion at both sides of IPC", async () => {
    const deleted = { schemaVersion: 1, status: "deleted" };
    mocks.invoke.mockResolvedValueOnce(deleted);

    const result = await bridge.deleteArchivedConversation(BOUNDARY_REF);
    expect(result).toEqual(deleted);
    expect(result).not.toBe(deleted);
    expect(mocks.invoke).toHaveBeenCalledWith("desktop:delete-archived-conversation", {
      boundaryRef: BOUNDARY_REF,
    });

    mocks.invoke.mockClear();
    for (const boundaryRef of [BOUNDARY_REF.toUpperCase(), "a".repeat(63), "z".repeat(64), null]) {
      await expect(bridge.deleteArchivedConversation(boundaryRef)).rejects.toBeInstanceOf(
        TypeError,
      );
    }
    await expect(
      (bridge.deleteArchivedConversation as (...args: unknown[]) => Promise<unknown>)(
        BOUNDARY_REF,
        "extra",
      ),
    ).rejects.toBeInstanceOf(TypeError);
    expect(mocks.invoke).not.toHaveBeenCalled();

    for (const response of [
      { schemaVersion: 2, status: "deleted" },
      { schemaVersion: 1, status: "missing" },
      { schemaVersion: 1, status: "not-found", path: "/private/transcript" },
    ]) {
      mocks.invoke.mockResolvedValueOnce(response);
      await expect(bridge.deleteArchivedConversation(BOUNDARY_REF)).rejects.toBeInstanceOf(
        TypeError,
      );
    }
  });

  it("returns strict copied update states from zero-argument channels", async () => {
    const downloaded = { status: "downloaded", version: "2026.7.23" };
    mocks.invoke
      .mockResolvedValueOnce({ status: "idle" })
      .mockResolvedValueOnce(downloaded)
      .mockResolvedValueOnce({ status: "installing", version: "2026.7.23" })
      .mockResolvedValueOnce({ status: "restart-required", stage: "check" });

    await expect(bridge.getUpdateState()).resolves.toEqual({ status: "idle" });
    const copy = await bridge.checkForUpdates();
    expect(copy).toEqual(downloaded);
    expect(copy).not.toBe(downloaded);
    await expect(bridge.restartToUpdate()).resolves.toEqual({
      status: "installing",
      version: "2026.7.23",
    });
    await expect(bridge.getUpdateState()).resolves.toEqual({
      status: "restart-required",
      stage: "check",
    });
    expect(mocks.invoke.mock.calls).toEqual([
      ["desktop:update:get"],
      ["desktop:update:check"],
      ["desktop:update:restart"],
      ["desktop:update:get"],
    ]);
  });

  it("forwards only strict update events and supports idempotent listener disposal", () => {
    const listener = vi.fn();
    const dispose = bridge.onUpdateState(listener);
    const onState = mocks.on.mock.calls.find(
      ([channel]) => channel === "desktop:update:state",
    )?.[1] as (_event: unknown, value: unknown) => void;
    onState(undefined, { status: "downloaded", version: "2026.7.23" });
    onState(undefined, {
      status: "downloaded",
      version: "2026.7.23",
      downloadedFile: "/private/update.zip",
    });
    onState(undefined, { status: "failed", stage: "install" });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      status: "downloaded",
      version: "2026.7.23",
    });
    dispose();
    dispose();
    onState(undefined, { status: "current" });
    expect(listener).toHaveBeenCalledOnce();
  });

  it("rejects malformed update state unions without exposing raw fields", async () => {
    for (const value of [
      null,
      { status: "idle", extra: true },
      { status: "downloading", version: "2026.7.23-beta.1" },
      { status: "downloaded", version: " 2026.7.23" },
      { status: "failed", stage: "install" },
      { status: "failed", stage: "check", error: "Authorization: secret" },
      { status: "restart-required", stage: "install" },
      { status: "restart-required", stage: "check", extra: true },
    ]) {
      mocks.invoke.mockResolvedValueOnce(value);
      await expect(bridge.getUpdateState()).rejects.toBeInstanceOf(TypeError);
    }
  });

  it("sends a nested trusted target-blank anchor activation over the private channel", () => {
    const anchor = new mocks.FakeAnchor("https://example.test/guide");
    const preventDefault = vi.fn();

    mocks.clickListener?.({
      isTrusted: true,
      defaultPrevented: false,
      button: 0,
      composedPath: () => [{}, anchor],
      preventDefault,
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenCalledWith("desktop:open-external", "https://example.test/guide");
    expect(mocks.fakeWindow.addEventListener).toHaveBeenCalledWith(
      "click",
      expect.any(Function),
      true,
    );
  });

  it("ignores synthetic, handled, non-primary, non-anchor, and non-blank clicks", () => {
    const preventDefault = vi.fn();
    const cases = [
      {
        isTrusted: false,
        defaultPrevented: false,
        button: 0,
        composedPath: () => [new mocks.FakeAnchor("https://example.test/")],
      },
      {
        isTrusted: true,
        defaultPrevented: true,
        button: 0,
        composedPath: () => [new mocks.FakeAnchor("https://example.test/")],
      },
      {
        isTrusted: true,
        defaultPrevented: false,
        button: 1,
        composedPath: () => [new mocks.FakeAnchor("https://example.test/")],
      },
      {
        isTrusted: true,
        defaultPrevented: false,
        button: 0,
        composedPath: () => [{}],
      },
      {
        isTrusted: true,
        defaultPrevented: false,
        button: 0,
        composedPath: () => [new mocks.FakeAnchor("https://example.test/", "_self")],
      },
    ];
    for (const event of cases) mocks.clickListener?.({ ...event, preventDefault });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("exposes closed credential runtime states and the retry command", async () => {
    const statuses = [
      { slot: "anthropic", state: "configured", runtimeState: "stored-inactive" },
      { slot: "openrouter", state: "configured", runtimeState: "failed" },
      { slot: "openai", state: "configured", runtimeState: "active" },
      { slot: "google", state: "missing", runtimeState: null },
      { slot: "deepseek", state: "missing", runtimeState: null },
      { slot: "qwen", state: "missing", runtimeState: null },
      { slot: "minimax", state: "missing", runtimeState: null },
      { slot: "kimi", state: "missing", runtimeState: null },
      { slot: "zai", state: "missing", runtimeState: null },
      { slot: "intervals-icu", state: "missing", runtimeState: null },
    ];
    mocks.invoke.mockResolvedValueOnce(statuses).mockResolvedValueOnce(statuses);

    await expect(bridge.credentialStatuses()).resolves.toEqual(statuses);
    await expect(bridge.retryFailedCredentials()).resolves.toEqual(statuses);
    expect(mocks.invoke.mock.calls.map(([channel]) => channel)).toEqual([
      "enduragent:onboarding:credential-status",
      "enduragent:onboarding:credential-retry",
    ]);
  });

  it("validates credential recovery status, retry, and reset results", async () => {
    mocks.invoke
      .mockResolvedValueOnce({ state: "ready", unverifiedEnvelopes: 2 })
      .mockResolvedValueOnce({ state: "locked" })
      .mockResolvedValueOnce({ status: "reset", keyCleanupPending: false });

    await expect(bridge.credentialRecoveryStatus()).resolves.toEqual({
      state: "ready",
      unverifiedEnvelopes: 2,
    });
    await expect(bridge.retryCredentialRecovery()).resolves.toEqual({ state: "locked" });
    await expect(bridge.resetAllCredentials()).resolves.toEqual({
      status: "reset",
      keyCleanupPending: false,
    });
    expect(mocks.invoke.mock.calls.map(([channel]) => channel)).toEqual([
      "enduragent:settings:credential-recovery-status",
      "enduragent:settings:credential-recovery-retry",
      "enduragent:settings:credential-reset",
    ]);
  });

  it("rejects widened or malformed credential recovery and reset results", async () => {
    for (const malformed of [
      { state: "ready", unverifiedEnvelopes: -1 },
      { state: "ready", unverifiedEnvelopes: 0, extra: true },
      { state: "locked", unverifiedEnvelopes: 1 },
      { state: "unknown" },
    ]) {
      mocks.invoke.mockResolvedValueOnce(malformed);
      await expect(bridge.credentialRecoveryStatus()).rejects.toBeInstanceOf(TypeError);
    }

    for (const malformed of [
      { status: "reset", keyCleanupPending: false, extra: true },
      { status: "reset", keyCleanupPending: "false" },
      { status: "refused", reason: "unknown" },
    ]) {
      mocks.invoke.mockResolvedValueOnce(malformed);
      await expect(bridge.resetAllCredentials()).rejects.toBeInstanceOf(TypeError);
    }
  });

  it("validates and copies deletion metadata without accepting widened shapes", async () => {
    const result = {
      credential: "anthropic",
      status: "deleted",
      cleanupPending: false,
    };
    mocks.invoke.mockResolvedValueOnce(result);

    const copied = await bridge.deleteCredential({ credential: "anthropic" });

    expect(copied).toEqual(result);
    expect(copied).not.toBe(result);
    expect(mocks.invoke).toHaveBeenCalledWith("enduragent:settings:credential-delete", {
      credential: "anthropic",
    });

    for (const input of [
      { credential: "unknown" },
      { credential: "anthropic", extra: true },
      "anthropic",
    ]) {
      await expect(bridge.deleteCredential(input)).rejects.toBeInstanceOf(TypeError);
    }
    expect(mocks.invoke).toHaveBeenCalledTimes(1);

    mocks.invoke.mockResolvedValueOnce({
      credential: "anthropic",
      status: "deleted",
      cleanupPending: false,
      extra: true,
    });
    await expect(bridge.deleteCredential({ credential: "anthropic" })).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it("accepts a successful Intervals.icu credential deletion result", async () => {
    const result = {
      credential: "intervals-icu",
      status: "deleted",
      cleanupPending: false,
    };
    mocks.invoke.mockResolvedValueOnce(result);

    const copied = await bridge.deleteCredential({ credential: "intervals-icu" });

    expect(copied).toEqual(result);
    expect(copied).not.toBe(result);
    expect(mocks.invoke).toHaveBeenCalledWith("enduragent:settings:credential-delete", {
      credential: "intervals-icu",
    });
  });

  it("accepts only the exact Keychain deletion refusal envelope", async () => {
    const result = {
      credential: "anthropic",
      status: "refused",
      reason: "encryption-unavailable",
    };
    mocks.invoke.mockResolvedValueOnce(result);

    const copied = await bridge.deleteCredential({ credential: "anthropic" });

    expect(copied).toEqual(result);
    expect(copied).not.toBe(result);

    for (const malformed of [
      { ...result, extra: true },
      { ...result, credential: "unknown" },
      { ...result, reason: "keychain-unavailable" },
      { slot: "anthropic", status: "refused", reason: "encryption-unavailable" },
    ]) {
      mocks.invoke.mockResolvedValueOnce(malformed);
      await expect(bridge.deleteCredential({ credential: "anthropic" })).rejects.toBeInstanceOf(
        TypeError,
      );
    }
  });

  it("accepts only the exact credential deletion uncertainty envelope", async () => {
    const result = {
      slot: "anthropic",
      status: "uncertain",
      reason: "storage-uncertain",
    };
    mocks.invoke.mockResolvedValueOnce(result);

    const copied = await bridge.deleteCredential({ credential: "anthropic" });

    expect(copied).toEqual(result);
    expect(copied).not.toBe(result);

    for (const malformed of [
      { ...result, extra: true },
      { ...result, slot: "unknown" },
      { ...result, reason: "storage-failed" },
      { credential: "anthropic", status: "uncertain", reason: "storage-uncertain" },
    ]) {
      mocks.invoke.mockResolvedValueOnce(malformed);
      await expect(bridge.deleteCredential({ credential: "anthropic" })).rejects.toBeInstanceOf(
        TypeError,
      );
    }
  });

  it("pins the provider union order and keeps the off-catalogue lane out of the catalogue payload", () => {
    expect(pinnedPreloadProviderOrder()).toEqual([...providerOrder]);
    expect(providerOrder.indexOf("codex-agent")).toBe(providerOrder.indexOf("claude-cli") + 1);
    expect(catalogueProviderOrder).not.toContain("codex-agent");
    expect(llmConfiguration().providers).toHaveLength(catalogueProviderOrder.length);
  });

  it("keeps the preload's off-catalogue set in step with the catalogue the payload is built from", () => {
    const cataloguedProviders = LLM_MODEL_CATALOGUE.map((entry) => entry.provider);
    const offCatalogue = pinnedPreloadOffCatalogueProviders();

    expect(offCatalogue.length).toBeGreaterThan(0);
    for (const provider of offCatalogue) {
      expect(providerOrder).toContain(provider);
      expect(cataloguedProviders).not.toContain(provider);
    }
    expect(
      [...providerOrder].filter((provider) => !cataloguedProviders.includes(provider)),
    ).toEqual(offCatalogue);
    expect(cataloguedProviders).toEqual(
      [...providerOrder].filter((provider) => !offCatalogue.includes(provider)),
    );
  });

  it("copies the bounded model catalogue and active selection from its private channel", async () => {
    const configuration = llmConfiguration();
    mocks.invoke.mockResolvedValueOnce(configuration);

    const copied = (await bridge.llmConfiguration()) as typeof configuration;

    expect(copied).toEqual(configuration);
    expect(copied).not.toBe(configuration);
    expect(copied.providers).not.toBe(configuration.providers);
    expect(copied.providers[0]?.models).not.toBe(configuration.providers[0]?.models);
    expect(mocks.invoke).toHaveBeenCalledWith("enduragent:onboarding:llm-configuration");
  });

  it("normalizes strict selections and credential writes before invoking main", async () => {
    mocks.invoke
      .mockResolvedValueOnce({ status: "configured", runtimeReady: true })
      .mockResolvedValueOnce({
        slot: "openrouter",
        status: "configured",
        runtimeReady: true,
      });
    const selection = {
      provider: "openrouter",
      model: "  athlete-model  ",
      endpoint: { mode: "custom", value: "  https://models.example.invalid/v1  " },
    };

    await expect(bridge.applyLlmSelection(selection)).resolves.toEqual({
      status: "configured",
      runtimeReady: true,
    });
    await expect(
      bridge.writeCredential({
        slot: "openrouter",
        value: "obviously-fake-key",
        selection,
      }),
    ).resolves.toMatchObject({ status: "configured" });
    const normalized = {
      provider: "openrouter",
      model: "athlete-model",
      endpoint: { mode: "custom", value: "https://models.example.invalid/v1" },
    };
    expect(mocks.invoke.mock.calls).toEqual([
      ["enduragent:onboarding:llm-selection-apply", normalized],
      [
        "enduragent:onboarding:credential-write",
        { slot: "openrouter", value: "obviously-fake-key", selection: normalized },
      ],
    ]);
  });

  it("accepts a securely stored inactive credential result", async () => {
    mocks.invoke.mockResolvedValueOnce({
      slot: "anthropic",
      status: "configured",
      runtimeReady: false,
    });

    await expect(
      bridge.writeCredential({
        slot: "anthropic",
        value: "obviously-fake-key",
      }),
    ).resolves.toEqual({
      slot: "anthropic",
      status: "configured",
      runtimeReady: false,
    });
  });

  it("accepts only the closed credential storage uncertainty envelope", async () => {
    mocks.invoke.mockResolvedValueOnce({
      slot: "anthropic",
      status: "uncertain",
      reason: "storage-uncertain",
    });

    await expect(
      bridge.writeCredential({
        slot: "anthropic",
        value: "obviously-fake-key",
      }),
    ).resolves.toEqual({
      slot: "anthropic",
      status: "uncertain",
      reason: "storage-uncertain",
    });

    mocks.invoke.mockResolvedValueOnce({
      slot: "anthropic",
      status: "uncertain",
      reason: "storage-uncertain",
      path: "/private/detail",
    });
    await expect(
      bridge.writeCredential({
        slot: "anthropic",
        value: "obviously-fake-key",
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("rejects malformed model and endpoint inputs before IPC", async () => {
    const malformed = [
      { provider: "anthropic", model: "", endpoint: { mode: "automatic" } },
      { provider: "anthropic", model: "x".repeat(513), endpoint: { mode: "automatic" } },
      { provider: "anthropic", model: "bad\u0000model", endpoint: { mode: "automatic" } },
      { provider: "anthropic", model: "\tmodel", endpoint: { mode: "automatic" } },
      { provider: "anthropic", model: "model", endpoint: { mode: "default" } },
      {
        provider: "openrouter",
        model: "model",
        endpoint: { mode: "custom", value: "http://models.example.invalid/v1" },
      },
      {
        provider: "openrouter",
        model: "model",
        endpoint: { mode: "custom", value: "https://user:secret@example.invalid/v1" },
      },
      {
        provider: "openrouter",
        model: "model",
        endpoint: { mode: "custom", value: "https://example.invalid/v1?secret=value" },
      },
      {
        provider: "openrouter",
        model: "model",
        endpoint: { mode: "custom", value: "https://example.invalid/v1#" },
      },
      {
        provider: "openrouter",
        model: "model",
        endpoint: { mode: "custom", value: "https://example.invalid/v1#secret" },
      },
      {
        provider: "openrouter",
        model: "model",
        endpoint: { mode: "custom", value: `https://example.invalid/${"x".repeat(4_096)}` },
      },
      {
        provider: "openrouter",
        model: "model",
        endpoint: { mode: "automatic", extra: true },
      },
    ];

    for (const selection of malformed) {
      await expect(bridge.applyLlmSelection(selection)).rejects.toBeInstanceOf(TypeError);
    }
    await expect(
      bridge.writeCredential({
        slot: "anthropic",
        value: "obviously-fake-key",
        selection: {
          provider: "openrouter",
          model: "model",
          endpoint: { mode: "automatic" },
        },
      }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      bridge.chatgptLogin({
        provider: "anthropic",
        model: "model",
        endpoint: { mode: "automatic" },
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("rejects malformed privileged model responses without exposing extra fields", async () => {
    const configuration = llmConfiguration();
    const malformed = [
      { ...configuration, secret: "private" },
      {
        ...configuration,
        providers: configuration.providers.map((provider, index) =>
          index === 0 ? { ...provider, rawBaseUrl: "https://private.invalid" } : provider,
        ),
      },
      {
        ...configuration,
        providers: configuration.providers.map((provider, index) =>
          index === 0 ? { ...provider, defaultModel: "not-in-models" } : provider,
        ),
      },
      { ...configuration, active: { ...configuration.active, apiKey: "private" } },
    ];
    for (const value of malformed) {
      mocks.invoke.mockResolvedValueOnce(value);
      await expect(bridge.llmConfiguration()).rejects.toBeInstanceOf(TypeError);
    }
    for (const value of [
      { status: "configured", runtimeReady: true, raw: "private" },
      { status: "refused", reason: "storage-failed" },
    ]) {
      mocks.invoke.mockResolvedValueOnce(value);
      await expect(
        bridge.applyLlmSelection({
          provider: "anthropic",
          model: "model",
          endpoint: { mode: "automatic" },
        }),
      ).rejects.toBeInstanceOf(TypeError);
    }
  });

  it("exposes strict status and configured results", async () => {
    mocks.invoke
      .mockResolvedValueOnce({ state: "configured", runtimeReady: false })
      .mockResolvedValueOnce({ status: "stored", operationId: "login-1" });
    await expect(bridge.chatgptStatus()).resolves.toEqual({
      state: "configured",
      runtimeReady: false,
    });
    await expect(bridge.chatgptLogin(chatGptLoginInput)).resolves.toEqual({
      status: "stored",
      operationId: "login-1",
    });
    expect(mocks.invoke.mock.calls.map(([channel]) => channel)).toEqual([
      "enduragent:onboarding:chatgpt-status",
      "enduragent:onboarding:chatgpt-login",
    ]);
  });

  it("correlates cancellation and forwards only closed progress events", async () => {
    mocks.invoke.mockResolvedValueOnce({ status: "cancelling", operationId: "login-1" });
    await expect(bridge.cancelChatgptLogin("login-1")).resolves.toEqual({
      status: "cancelling",
      operationId: "login-1",
    });
    expect(mocks.invoke).toHaveBeenCalledWith("enduragent:onboarding:chatgpt-login-cancel", {
      operationId: "login-1",
    });

    const received: unknown[] = [];
    const dispose = bridge.onChatgptLoginProgress((progress) => received.push(progress));
    const listener = mocks.on.mock.calls.find(
      ([channel]) => channel === "enduragent:onboarding:chatgpt-login-progress",
    )?.[1] as (_event: unknown, value: unknown) => void;
    listener(undefined, { operationId: "login-1", phase: "waiting-for-browser" });
    listener(undefined, { operationId: "login-1", phase: "unknown" });
    listener(undefined, {
      operationId: "login-1",
      phase: "completing-sign-in",
      credential: "private",
    });
    expect(received).toEqual([{ operationId: "login-1", phase: "waiting-for-browser" }]);

    dispose();
    dispose();
    listener(undefined, { operationId: "login-1", phase: "completing-sign-in" });
    expect(received).toHaveLength(1);
  });

  it("rejects invalid and mismatched ChatGPT operation IDs", async () => {
    await expect(bridge.cancelChatgptLogin("bad id")).rejects.toBeInstanceOf(TypeError);
    await expect(
      bridge.chatgptLogin({ ...chatGptLoginInput, operationId: "bad id" }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(mocks.invoke).not.toHaveBeenCalled();

    mocks.invoke.mockResolvedValueOnce({ status: "not-active", operationId: "stale" });
    await expect(bridge.cancelChatgptLogin("login-1")).rejects.toBeInstanceOf(TypeError);
  });

  it("copies claude-cli status payloads with their exact optional keys", async () => {
    mocks.invoke
      .mockResolvedValueOnce({
        state: "ready",
        email: "athlete@synthetic.test",
        plan: "Max",
        version: "2.9.0",
      })
      .mockResolvedValueOnce({ state: "disabled" })
      .mockResolvedValueOnce({ state: "working-area-unavailable" });
    await expect(bridge.claudeCliStatus()).resolves.toEqual({
      state: "ready",
      email: "athlete@synthetic.test",
      plan: "Max",
      version: "2.9.0",
    });
    await expect(bridge.claudeCliRecheck()).resolves.toEqual({ state: "disabled" });
    await expect(bridge.claudeCliStatus()).resolves.toEqual({
      state: "working-area-unavailable",
    });
    expect(mocks.invoke.mock.calls.map(([channel]) => channel)).toEqual([
      "enduragent:onboarding:claude-cli-status",
      "enduragent:onboarding:claude-cli-recheck",
      "enduragent:onboarding:claude-cli-status",
    ]);
  });

  it("rejects claude-cli status payloads outside the closed state set", async () => {
    for (const value of [
      { state: "signed-in" },
      { state: "ready", identity: "athlete@synthetic.test" },
      { state: "ready", email: "" },
      { state: "ready-api-key", version: 2 },
      { email: "athlete@synthetic.test" },
      [],
    ]) {
      mocks.invoke.mockResolvedValueOnce(value);
      await expect(bridge.claudeCliStatus()).rejects.toBeInstanceOf(TypeError);
    }
  });

  it("accepts only closed refusal reasons and exact keys", async () => {
    mocks.invoke.mockResolvedValueOnce({
      status: "refused",
      operationId: "login-1",
      reason: "timed-out",
    });
    await expect(bridge.chatgptLogin(chatGptLoginInput)).resolves.toEqual({
      status: "refused",
      operationId: "login-1",
      reason: "timed-out",
    });
    for (const value of [
      { state: "configured", runtimeReady: true, extra: true },
      { state: "unknown", runtimeReady: false },
      { status: "refused", operationId: "login-1", reason: "unknown" },
      { status: "stored", operationId: "stale-login" },
    ]) {
      mocks.invoke.mockResolvedValueOnce(value);
      const operation = Object.hasOwn(value, "state")
        ? bridge.chatgptStatus()
        : bridge.chatgptLogin(chatGptLoginInput);
      await expect(operation).rejects.toBeInstanceOf(TypeError);
    }
  });
});

describe("Settings navigation", () => {
  it("delivers the fixed Settings command and removes disposed listeners", () => {
    const event = mocks.on.mock.calls.find(([channel]) => channel === "enduragent:open-settings");
    if (event === undefined) throw new Error("Settings event missing");
    const listener = vi.fn();
    const dispose = bridge.onOpenSettings(listener);
    event[1]({});
    expect(listener).toHaveBeenCalledExactlyOnceWith();
    dispose();
    dispose();
    event[1]({});
    expect(listener).toHaveBeenCalledOnce();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(() => bridge.onOpenSettings("settings")).toThrow(TypeError);
  });
});
