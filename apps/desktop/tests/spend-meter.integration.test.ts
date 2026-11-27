import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoachEngine, SpendSummary, TurnEvent } from "@enduragent/coach-contract";
import {
  Memory,
  appendUsageLine,
  classifyFailure,
  createConversationStore,
  createMissingPlatformCalendarMutations,
  extractRetryAfterMs,
} from "@enduragent/core";
import {
  createCoachEngine,
  type EngineConfig,
  type EngineHostPorts,
  type ModelTransportRequest,
} from "@enduragent/engine";
import type { GenerateResult, Sport } from "@enduragent/engine/sport";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSpendMeterService } from "../../../packages/coach/src/spend-meter.js";
import { isDesktopRendererUrl } from "../src/main/renderer-navigation.js";
import {
  launchDesktopFixture,
  type DesktopFixtureScript,
  type RunningDesktopFixture,
} from "./helpers/desktop-fixture.js";

const hasLoopback = await new Promise<boolean>((resolveAvailability) => {
  const server = createServer();
  server.once("error", () => resolveAvailability(false));
  server.listen({ host: "127.0.0.1", port: 0 }, () => {
    server.close(() => resolveAvailability(true));
  });
});

const token = "s".repeat(43);
const fixtures: RunningDesktopFixture[] = [];
const scratch: string[] = [];

const readySetupStatus = {
  schemaVersion: 1,
  durableTrainingData: true,
} as const;

interface ScriptRequest {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params: unknown;
}

function response(value: unknown): readonly string[] {
  return [JSON.stringify(value)];
}

function summary(dailyCapUsd = 0.5) {
  return {
    localDate: "1998-07-06",
    timezone: "UTC",
    dailyCapUsd,
    knownSpendUsd: 0.6,
    generationCount: 2,
    pricedGenerationCount: 1,
    unpricedGenerationCount: 1,
    malformedLineCount: 1,
    spendComplete: false,
    capStatus: 0.6 >= dailyCapUsd ? "reached" : "unknown",
    cacheReadTokens: 400,
    knownCacheReadSavingsUsd: 0,
    cacheSavingsComplete: false,
    routes: [
      {
        provider: "openrouter",
        model: "anthropic/synthetic",
        generationCount: 2,
        pricedGenerationCount: 1,
        unpricedGenerationCount: 1,
        providerReportedGenerationCount: 1,
        knownSpendUsd: 0.6,
        cacheReadTokens: 400,
        cacheReadSavingsUsd: null,
        caching: "unavailable",
        disclosure: "caching unavailable on this route",
      },
    ],
  } as const;
}

function completeSummary(dailyCapUsd = 0.5) {
  return {
    localDate: "1998-07-06",
    timezone: "UTC",
    dailyCapUsd,
    knownSpendUsd: 0.14,
    generationCount: 1,
    pricedGenerationCount: 1,
    unpricedGenerationCount: 0,
    malformedLineCount: 0,
    spendComplete: true,
    capStatus: 0.14 >= dailyCapUsd ? "reached" : "below",
    cacheReadTokens: 400,
    knownCacheReadSavingsUsd: 0.03,
    cacheSavingsComplete: true,
    routes: [
      {
        provider: "openrouter",
        model: "openai/synthetic",
        generationCount: 1,
        pricedGenerationCount: 1,
        unpricedGenerationCount: 0,
        providerReportedGenerationCount: 1,
        knownSpendUsd: 0.14,
        cacheReadTokens: 400,
        cacheReadSavingsUsd: 0.03,
        caching: "provider-dependent",
        disclosure: null,
      },
    ],
  } as const;
}

const liveModel = {
  kind: "catalog" as const,
  catalogRevision: 1,
  provider: "anthropic" as const,
  model: "claude-synthetic",
  compatibilityProfile: "anthropic-ai-sdk-v1" as const,
  contextWindowTokens: 200_000,
  imageInput: "unsupported" as const,
  pricing: {
    kind: "token-rates" as const,
    inputUsdPerMillion: 2,
    outputUsdPerMillion: 10,
    cacheReadUsdPerMillion: 0.2,
    cacheWriteUsdPerMillion: 2.5,
  },
};

const liveCallUsage = {
  inputTokens: 50_000,
  outputTokens: 5_000,
  totalTokens: 55_000,
  inputTokenDetails: { noCacheTokens: 50_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokenDetails: { textTokens: 5_000, reasoningTokens: 0 },
};

const liveSport = {
  id: "cycling",
  soul: "",
  skills: {},
  sessionClusterGapMinutes: 30,
  memorySections: [],
  mustPreserveTokens: [],
  intervalsActivityTypes: [],
  athleteProfileSchema: {},
  tools: () => [],
} as unknown as Sport;

function liveServerError(): Error {
  const error = new Error("Synthetic provider unavailable");
  error.name = "ServerError";
  return error;
}

class LiveSpendBackend {
  readonly providerCalls: ModelTransportRequest[] = [];
  private instant = Date.UTC(1998, 6, 6, 8);
  private idSequence = 0;
  private engine: CoachEngine | undefined;

  constructor(private readonly root: string) {}

  async open(): Promise<void> {
    const dataDir = join(this.root, "data");
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const conversation = createConversationStore(dataDir);
    const config: EngineConfig = {
      dataSource: "platform",
      llm: {
        provider: "anthropic",
        model: liveModel.model,
        ["api" + "Key"]: "synthetic",
      } as unknown as EngineConfig["llm"],
      session: {
        historyTokenBudgetRatio: 0.3,
        idleMinutes: 0,
        dailyResetHour: 4,
        resetArchiveRetentionDays: 0,
        timezone: "UTC",
      },
      models: { catalogRevision: 1, chat: liveModel, compact: liveModel, flush: liveModel },
      contextWindowTokens: 200_000,
      compactContextWindowTokens: 200_000,
    };
    const ports: EngineHostPorts = {
      language: {
        resolveFor: async () => ({ language: "en", source: "default", locale: "en-GB" }),
      },
      config,
      memory: new Memory(dataDir, "UTC"),
      chatStore: conversation,
      transcriptWriter: conversation,
      coachDecisions: conversation,
      secrets: { resolve: async () => "" },
      platform: {
        legacyClient: null,
        athleteData: undefined,
        calendarMutations: createMissingPlatformCalendarMutations(),
      },
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      usage: { append: (line) => appendUsageLine(dataDir, line) },
      stateReader: {
        getAthleteState: async () => {
          throw new TypeError("athlete state is unavailable in this fixture");
        },
      },
      readReferenceState: () => ({ errorState: null, latest: null }),
      getAccessToken: async () => "token",
      classifyFailure,
      extractRetryAfterMs,
      now: () => ++this.instant,
      randomId: () => `live-${++this.idSequence}`,
      modelTransportDecorator: () => ({
        generate: (request) => this.generate(request),
      }),
    };
    this.engine = createCoachEngine({ sport: liveSport, ports });
  }

  async chat(message: string, emit: (event: TurnEvent) => void): Promise<string> {
    if (this.engine === undefined) throw new TypeError("live engine is not open");
    const result = await this.engine.chat({ chatId: "desktop", message }, emit);
    return result.text;
  }

  summary(): Promise<SpendSummary> {
    return createSpendMeterService({
      dataDir: join(this.root, "data"),
      configDir: join(this.root, "config"),
      timezone: "UTC",
      now: () => this.instant,
    }).getSpendSummary();
  }

  private async generate(request: ModelTransportRequest): Promise<GenerateResult> {
    this.providerCalls.push(request);
    if (this.providerCalls.length === 1) throw liveServerError();
    if (this.providerCalls.length === 2) {
      request.options.onStepUsage?.({ usage: liveCallUsage });
      throw liveServerError();
    }
    const text = "Keep tomorrow's ride easy.";
    request.options.onTextDelta?.(text);
    return {
      text,
      toolCalls: [],
      finishReason: "stop",
      usage: liveCallUsage,
      totalUsage: liveCallUsage,
      steps: 1,
    };
  }
}

function script(calls: ScriptRequest[], initial: "reached" | "complete", live?: LiveSpendBackend) {
  let cap = 0.5;
  let complete = initial === "complete";
  let spendAvailable = true;
  let queueRevision = 0;
  let queueItems: Array<{
    queuedMessageId: string;
    messageId: string;
    submissionId: string;
    attachmentIds: string[];
    text: string;
    kind: "ordinary" | "slash-command";
    position: number;
    restored: boolean;
  }> = [];
  const queueSnapshot = () => ({
    schemaVersion: 1 as const,
    revision: queueRevision,
    items: queueItems,
  });
  const fixture: DesktopFixtureScript = {
    async onRequest(value) {
      const request = value as ScriptRequest;
      calls.push(request);
      if (request.method === "getSpendSummary" && live !== undefined) {
        return response(await live.summary());
      }
      if (request.method === "resumeChatQueue" && live !== undefined) {
        const message = queueItems[0]?.text ?? "";
        queueItems = [];
        queueRevision += 1;
        const frames: string[] = [];
        const text = await live.chat(message, (event) => frames.push(JSON.stringify(event)));
        return [...frames, JSON.stringify({ snapshot: queueSnapshot(), response: { text } })];
      }
      if (request.method === "getSpendSummary") {
        if (!spendAvailable) throw new Error("synthetic spend failure");
        return response(complete ? completeSummary(cap) : summary(cap));
      }
      if (request.method === "setDailySpendCap") {
        cap = (request.params as { readonly dailyCapUsd: number }).dailyCapUsd;
        complete = false;
        return response(summary(cap));
      }
      if (request.method === "getAthleteState") {
        return response({
          schemaVersion: "1",
          lastUpdated: "1998-07-06T08:00:00.000Z",
          freshness: "fresh",
          degraded: false,
          lastSynced: null,
          athleteProfile: {},
          currentStatus: {},
          derivedMetrics: {},
          recentActivities: [],
          plannedWorkouts: [],
          wellness: {},
        });
      }
      if (request.method === "getSetupStatus") {
        return response(readySetupStatus);
      }
      if (request.method === "getUnitsPreference") {
        return response({ value: "metric", source: "default" });
      }
      if (request.method === "setUnitsPreference") {
        return response({ value: "metric", source: "cycling" });
      }
      if (request.method === "getChatQueue") return response(queueSnapshot());
      if (request.method === "enqueueChatMessage") {
        const params = request.params as { readonly submissionId: string; readonly text: string };
        if (!queueItems.some((item) => item.submissionId === params.submissionId)) {
          queueRevision += 1;
          queueItems.push({
            queuedMessageId: `queued-${queueRevision}`,
            messageId: `message-${queueRevision}`,
            submissionId: params.submissionId,
            attachmentIds: [],
            text: params.text,
            kind: params.text.trimStart().startsWith("/") ? "slash-command" : "ordinary",
            position: queueItems.length,
            restored: false,
          });
        }
        return response(queueSnapshot());
      }
      if (request.method === "removeQueuedChatMessage") {
        const id = (request.params as { readonly queuedMessageId: string }).queuedMessageId;
        queueItems = queueItems
          .filter((item) => item.queuedMessageId !== id)
          .map((item, position) => ({ ...item, position }));
        queueRevision += 1;
        return response(queueSnapshot());
      }
      if (request.method === "resumeChatQueue") {
        queueItems = [];
        queueRevision += 1;
        return [
          JSON.stringify({ type: "turn-start", turnId: "turn-spend", chatId: "desktop" }),
          JSON.stringify({ type: "text_delta", turnId: "turn-spend", delta: "Keep " }),
          JSON.stringify({ type: "final-text", turnId: "turn-spend", text: "Keep riding." }),
          JSON.stringify({ snapshot: queueSnapshot(), response: { text: "Keep riding." } }),
        ];
      }
      if (request.method === "sync") {
        return response({
          schemaVersion: 1,
          published: false,
          referenceSucceeded: true,
          requests: { store: 0, reference: 0, total: 0 },
          droppedActivities: {
            overall: { total: 0, visible: 0, restrictions: [], other: 0 },
            recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
          },
        });
      }
      if (request.method === "hasSession") return response({ hasSession: false });
      if (request.method === "getCoachDecision") return response({ decision: null });
      if (request.method === "resetSession") return response({ memoryFlushed: true });
      if (request.method === "importFiles") {
        return response({
          schemaVersion: 2,
          files: { total: 1, imported: 1, quarantined: 0 },
          changes: {
            rawFilesInserted: 1,
            sourceRecordsInserted: 1,
            sourceRecordsUpdated: 0,
            relinkedSourceRecords: 0,
          },
          publication: { scope: "activities-and-streams", status: "available" },
        });
      }
      if (request.method === "configureRuntime") {
        return response({
          schemaVersion: 3,
          status: "applied",
          applied: { llm: true, intervals: true, session: false },
        });
      }
      if (request.method === "getRuntimeConfig") {
        return response({
          schemaVersion: 3,
          llm: {
            provider: "codex-agent",
            model: "synthetic-codex",
            credential_configured: true,
          },
          intervals: {
            athlete_id: "0",
            credential_configured: false,
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
        });
      }
      throw new TypeError(`unexpected fixture method ${request.method}`);
    },
  };
  return {
    fixture,
    failSpend() {
      spendAvailable = false;
    },
  };
}

const NAVIGATE = `
  const readySelector = (label) =>
    label === "Chat"
      ? '[data-view="chat"] main[aria-label="Coaching conversation"]'
      : '[data-view="' + label.toLowerCase() + '"] section[aria-label="' + label + '"]';
  const navigate = async (label) => {
    const button = Array.from(
      document.querySelectorAll('nav[aria-label="Main navigation"] button'),
    ).find((entry) => entry.textContent.includes(label));
    button.click();
    const selector = readySelector(label);
    const deadline = Date.now() + 5000;
    while (!document.querySelector(selector) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!document.querySelector(selector)) throw new Error("navigation to " + label + " stalled");
  };
  const openSpending = async (expected) => {
    await navigate("Settings");
    const deadline = Date.now() + 5000;
    while (
      document.querySelector("[data-spend-meter] strong")?.textContent !== expected &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return document.querySelector("[data-spend-meter]");
  };
`;

async function launch(
  initial: "reached" | "complete" = "reached",
  display: {
    readonly width?: number;
    readonly height?: number;
    readonly colorScheme?: "light" | "dark";
  } = {},
  live?: LiveSpendBackend,
) {
  const calls: ScriptRequest[] = [];
  const scripted = script(calls, initial, live);
  const fixture = await launchDesktopFixture({
    script: scripted.fixture,
    token,
    width: display.width ?? 1440,
    height: display.height ?? 900,
    colorScheme: display.colorScheme ?? "light",
    reducedMotion: false,
  });
  fixtures.push(fixture);
  expect(fixture.readCapturedSurface("dom"), "renderer document at launch").not.toBe("");
  await fixture.evaluate<void>(`
    const deadline = Date.now() + 10000;
    while (document.documentElement.dataset.rpc !== "connected" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const onboardingDeadline = Date.now() + 10000;
    const onboardingState = () =>
      document.querySelector("[data-onboarding]")?.getAttribute("data-onboarding") ?? null;
    while (onboardingState() !== "settled" && Date.now() < onboardingDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (onboardingState() !== "settled") {
      throw new Error("onboarding startup decision did not settle");
    }
    if (document.querySelector("[data-setup-host]") !== null) {
      throw new Error("ready fixture unexpectedly requires setup");
    }
    const composerDeadline = Date.now() + 10000;
    let composer = document.querySelector("textarea#message");
    while (
      (!(composer instanceof HTMLTextAreaElement) || composer.disabled) &&
      Date.now() < composerDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      composer = document.querySelector("textarea#message");
    }
    if (!(composer instanceof HTMLTextAreaElement) || composer.disabled) {
      throw new Error("ready fixture did not enable chat");
    }
  `);
  return { fixture, calls, failSpend: scripted.failSpend };
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== "darwin" || !hasLoopback)("desktop spend meter", () => {
  it("counts the coach's failed provider calls in today's spend with their known usage", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "spend-live-"));
    scratch.push(root);
    await mkdir(join(root, "config"), { recursive: true, mode: 0o700 });
    const live = new LiveSpendBackend(root);
    await live.open();
    const { fixture } = await launch("complete", {}, live);

    const shown = await fixture.evaluate<{
      readonly reply: string;
      readonly amount: string;
      readonly route: string;
      readonly notices: string;
    }>(`
      ${NAVIGATE}
      const textarea = document.querySelector("#message");
      textarea.value = "How should I ride tomorrow?";
      textarea.closest("form").requestSubmit();
      const replyDeadline = Date.now() + 15000;
      let reply = "";
      while (reply !== "Keep tomorrow's ride easy." && Date.now() < replyDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        reply = document.querySelector(".chat-message--coach .chat-message__text")?.textContent ?? "";
      }
      await navigate("Settings");
      const spendDeadline = Date.now() + 5000;
      const routeText = () =>
        document.querySelector('[data-spend-meter] [aria-label="Spend details"] article')?.textContent ?? "";
      while (!routeText().includes("generations priced") && Date.now() < spendDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const spending = document.querySelector("[data-spend-meter]");
      return {
        reply,
        amount: spending.querySelector("strong").textContent,
        route: routeText(),
        notices: Array.from(spending.querySelectorAll("p")).map((node) => node.textContent).join(" | "),
      };
    `);

    expect(live.providerCalls).toHaveLength(3);
    expect(shown.reply).toBe("Keep tomorrow's ride easy.");
    expect(shown.route, "every provider call the coach made is counted and priced").toContain(
      "3/3 generations priced",
    );
    expect(shown.amount, "the failed call's known usage is part of today's spend").toBe(
      "$0.30 / $0.50",
    );
    expect(shown.notices).not.toContain("Some provider costs are unavailable");
  }, 60_000);

  it("keeps the spending surface visible at both viewport bands and never blocks reached-cap chat", async () => {
    const { fixture, calls } = await launch();
    const desktop = await fixture.evaluate<{
      readonly visible: boolean;
      readonly trackHeight: number;
      readonly warning: string;
      readonly disclosure: string;
      readonly overflow: boolean;
      readonly composerInputDisabled: boolean;
      readonly submitDisabled: boolean;
      readonly final: string;
    }>(`
      ${NAVIGATE}
      const spending = await openSpending("$0.60+ / $0.50");
      const before = {
        visible: spending.getBoundingClientRect().width >= 132,
        trackHeight: spending.querySelector("progress").getBoundingClientRect().height,
        disclosure: spending.textContent,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
      await navigate("Chat");
      const textarea = document.querySelector("#message");
      const submit = textarea.closest("form").querySelector('button[type="submit"]');
      const warning = document.querySelector("#spend-cap-warning").textContent;
      const composerInputDisabled = textarea.disabled;
      const submitDisabled = submit.disabled;
      textarea.value = "Can I keep chatting?";
      textarea.closest("form").requestSubmit();
      const deadline = Date.now() + 5000;
      let final = "";
      while (final !== "Keep riding." && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        final = document.querySelector(".chat-message--coach .chat-message__text")?.textContent ?? "";
      }
      return { ...before, warning, composerInputDisabled, submitDisabled, final };
    `);
    expect(desktop.visible).toBe(true);
    expect(desktop.trackHeight).toBe(3);
    expect(desktop.warning).toBe(
      "You’ve reached today’s $0.50 spend cap. You can keep chatting; this is a warning, not a block.",
    );
    expect(desktop.disclosure).toContain("Some provider costs are unavailable");
    expect(desktop.disclosure).toContain("caching unavailable on this route");
    expect(desktop.overflow).toBe(false);
    expect(desktop.composerInputDisabled).toBe(false);
    expect(desktop.submitDisabled).toBe(false);
    expect(desktop.final).toBe("Keep riding.");
    expect(calls.filter((call) => call.method === "enqueueChatMessage")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "resumeChatQueue")).toHaveLength(1);
    await vi.waitFor(() =>
      expect(calls.filter((call) => call.method === "getSpendSummary").length).toBeGreaterThan(1),
    );

    await fixture.setViewport(720, 900);
    const narrow = await fixture.evaluate<{
      readonly visible: boolean;
      readonly overflow: boolean;
    }>(`
      ${NAVIGATE}
      await navigate("Settings");
      return {
        visible: document.querySelector("[data-spend-meter]").getBoundingClientRect().width >= 132,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    `);
    expect(narrow).toEqual({ visible: true, overflow: false });
  }, 60_000);

  it("preserves the closed bridge, sidebar sync chip, hardened renderer, and token containment", async () => {
    const { fixture } = await launch();
    const screenshotRoot = await mkdtemp(join(await realpath(tmpdir()), "spend-shot-"));
    scratch.push(screenshotRoot);
    const screenshot = join(screenshotRoot, "spend.png");
    await fixture.screenshot(screenshot);
    const state = await fixture.evaluate<{
      readonly bridgeKeys: readonly string[];
      readonly syncChip: boolean;
      readonly node: string;
      readonly location: string;
      readonly dom: string;
    }>(`
      return {
        bridgeKeys: Object.keys(window.enduragentAuth).sort(),
        syncChip: document.querySelectorAll("button.sync-chip").length === 1,
        node: typeof process + ":" + typeof require,
        location: location.href,
        dom: document.documentElement.outerHTML,
      };
    `);
    expect(state.bridgeKeys).toEqual([
      "acknowledgeTelegramGapWarning",
      "addTelegramAllowedSender",
      "applyLlmSelection",
      "beginTelegramPairing",
      "cancelChatgptLogin",
      "cancelIntervalsSignIn",
      "cancelOpenRouterSignIn",
      "cancelTelegramPairing",
      "chatgptLogin",
      "chatgptStatus",
      "checkForUpdates",
      "chooseChatAttachments",
      "chooseImportFiles",
      "choosePlanRaceCourseFile",
      "claudeCliRecheck",
      "claudeCliStatus",
      "credentialRecoveryStatus",
      "credentialStatuses",
      "deleteArchivedConversation",
      "deleteCredential",
      "disableTelegram",
      "enableTelegram",
      "executePlanTransition",
      "exportTrainingFile",
      "getArchivedTranscriptPage",
      "getDaemonConnection",
      "getPlanState",
      "getPlanningReadModel",
      "getTranscriptPage",
      "getUpdateState",
      "initialSetupStatusSettled",
      "listArchivedConversations",
      "listTelegramAllowedSenders",
      "llmConfiguration",
      "onChatgptLoginProgress",
      "onDroppedChatAttachments",
      "onDroppedImportFiles",
      "onIntervalsSignInProgress",
      "onOpenRouterSignInProgress",
      "onOpenSettings",
      "onPlanProgress",
      "onUpdateState",
      "openOpenRouterPage",
      "openRouterCreditStatus",
      "openRouterSignIn",
      "pasteChatAttachment",
      "pasteTelegramTokenFromClipboard",
      "platform",
      "reconcileTelegram",
      "removeTelegram",
      "removeTelegramAllowedSender",
      "removeTelegramWebhook",
      "reopenIntervalsSignIn",
      "reopenOpenRouterSignIn",
      "resetAllCredentials",
      "restartToUpdate",
      "retryCredentialRecovery",
      "retryFailedCredentials",
      "setAppearance",
      "signInWithIntervals",
      "startOpenRouterCodeSignIn",
      "submitAthleteFeedback",
      "telegramStatus",
      "useCopiedOpenRouterCode",
      "writeCredential",
    ]);
    expect(state.syncChip).toBe(true);
    expect(state.node).toBe("undefined:undefined");
    expect(isDesktopRendererUrl(state.location)).toBe(true);
    for (const surface of [
      state.location,
      state.dom,
      fixture.readCapturedSurface("console"),
      fixture.readCapturedSurface("stdout"),
      fixture.readCapturedSurface("stderr"),
      fixture.readCapturedSurface("dom"),
      (await readFile(screenshot)).toString("latin1"),
    ]) {
      expect(surface).not.toContain(token);
    }
    await expect(fixture.close()).resolves.toEqual({ livePids: [], listenerCount: 0 });
  }, 60_000);

  it.each([
    { label: "wide light", width: 1180, height: 820, colorScheme: "light" as const },
    { label: "wide dark", width: 1180, height: 820, colorScheme: "dark" as const },
    { label: "compact light", width: 760, height: 820, colorScheme: "light" as const },
    { label: "compact dark", width: 760, height: 820, colorScheme: "dark" as const },
  ])(
    "autosaves and restores the cap on reentry in $label mode",
    async ({ width, height, colorScheme }) => {
      const { fixture, calls, failSpend } = await launch("complete", {
        width,
        height,
        colorScheme,
      });
      const complete = await fixture.evaluate<{
        readonly amount: string;
        readonly status: string;
        readonly warningHidden: boolean;
        readonly disclosure: string;
      }>(`
      ${NAVIGATE}
      const spending = await openSpending("$0.14 / $0.50");
      return {
        amount: spending.querySelector("strong").textContent,
        status: spending.dataset.capStatus,
        warningHidden: document.querySelector("#spend-cap-warning")?.hidden ?? true,
        disclosure: spending.textContent,
      };
    `);
      expect(complete).toMatchObject({
        amount: "$0.14 / $0.50",
        status: "below",
        warningHidden: true,
      });
      expect(complete.disclosure).toContain(
        "Provider-dependent caching; no explicit breakpoint on this route.",
      );

      const saved = await fixture.evaluate<{
        readonly amount: string;
        readonly status: string;
        readonly warningHidden: boolean;
        readonly disclosure: string;
        readonly inputValue: string;
        readonly saveButtonMissing: boolean;
        readonly colorScheme: string;
        readonly overflow: boolean;
      }>(`
        ${NAVIGATE}
      const spending = document.querySelector("[data-spend-meter]");
      const cap = document.querySelector("#daily-spend-cap");
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      cap.focus();
      setter.call(cap, "0.75");
      cap.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      cap.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      const deadline = Date.now() + 5000;
      while (document.querySelector("[data-spend-meter]").dataset.capStatus !== "unknown" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
        await navigate("Chat");
        const current = await openSpending("$0.60+ / $0.75");
      return {
        amount: current.querySelector("strong").textContent,
        status: current.dataset.capStatus,
        warningHidden: document.querySelector("#spend-cap-warning")?.hidden ?? true,
        disclosure: current.textContent,
          inputValue: current.querySelector("#daily-spend-cap").value,
          saveButtonMissing: !Array.from(current.querySelectorAll("button")).some(
            (entry) => entry.textContent === "Save cap",
          ),
          colorScheme: getComputedStyle(document.documentElement).colorScheme,
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    `);
      expect(saved).toMatchObject({
        amount: "$0.60+ / $0.75",
        status: "unknown",
        warningHidden: true,
        inputValue: "0.75",
        saveButtonMissing: true,
        colorScheme,
        overflow: false,
      });
      expect(saved.disclosure).toContain(
        "Some provider costs are unavailable, so today’s total is a known minimum.",
      );
      expect(calls.filter((call) => call.method === "setDailySpendCap")).toEqual([
        expect.objectContaining({ params: { dailyCapUsd: 0.75 } }),
      ]);

      failSpend();
      const stale = await fixture.evaluate<string>(`
      const textarea = document.querySelector("#message");
      textarea.value = "Refresh the spend display";
      textarea.closest("form").requestSubmit();
      const deadline = Date.now() + 5000;
      while (!document.querySelector("[data-spend-meter]").textContent.includes("Spend data may be out of date.") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return document.querySelector("[data-spend-meter]").textContent;
    `);
      expect(stale).toContain("Spend data may be out of date.");
      expect(calls.filter((call) => call.method === "enqueueChatMessage")).toHaveLength(1);
      expect(calls.filter((call) => call.method === "resumeChatQueue")).toHaveLength(1);
    },
    60_000,
  );
});
