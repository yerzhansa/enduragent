import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TurnEvent } from "@enduragent/coach-contract";
import type { LanguageResolution } from "@enduragent/i18n";
import { cyclingSport } from "@enduragent/sport-cycling";
import { createCoachEngine } from "../src/index.js";
import { createCoachDecisionTool } from "../src/agent/coach-decision-tool.js";
import { getTurnContext } from "../src/agent/turn-context.js";
import type { EngineHostPorts, ModelTransportRequest } from "../src/host-ports.js";
import type { AttachmentCapabilitiesPort, ChatAttachmentTurnPort } from "../src/host-ports.js";
import type { GenerateResult, Sport } from "../src/sport.js";
import { baseAgentConfig } from "./helpers/base-agent-config.js";

const roots: string[] = [];

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function generated(text: string): GenerateResult {
  const usage = {
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
  };
  return { text, toolCalls: [], finishReason: "stop", usage, totalUsage: usage, steps: 1 };
}

function setup(
  root = mkdtempSync(join(tmpdir(), "engine-chat-queue-")),
  generate: (request: ModelTransportRequest) => Promise<GenerateResult> = async () =>
    generated("Done"),
  chatAttachments?: ChatAttachmentTurnPort,
  attachmentCapabilities?: AttachmentCapabilitiesPort,
) {
  if (!roots.includes(root)) roots.push(root);
  const base = baseAgentConfig(root);
  let sequence = 0;
  const ports: EngineHostPorts = {
    ...base,
    transcriptWriter: base.chatStore as unknown as EngineHostPorts["transcriptWriter"],
    randomId: () => `id-${++sequence}`,
    modelTransportDecorator: () => ({ generate }),
    ...(chatAttachments === undefined ? {} : { chatAttachments }),
    ...(attachmentCapabilities === undefined ? {} : { attachmentCapabilities }),
  };
  return {
    root,
    ports,
    engine: createCoachEngine({ sport: cyclingSport as unknown as Sport, ports }),
  };
}

describe("engine durable chat queue", () => {
  it("persists the full queued message through a decision continuation", async () => {
    const requests: ModelTransportRequest[] = [];
    const { engine, ports } = setup(undefined, async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        if (ports.coachDecisions === undefined) throw new Error("Missing decision store");
        const decisionTool = createCoachDecisionTool({
          store: ports.coachDecisions,
          randomId: ports.randomId,
          now: () => 0,
        });
        if (decisionTool?.execute === undefined) throw new Error("Missing decision tool");
        await decisionTool.execute(
          {
            question: "Choose tomorrow's priority.",
            options: [
              {
                label: "Recovery",
                description: "Ride easy.",
                recommended: true,
                consequence: "Tomorrow becomes a recovery day.",
              },
              {
                label: "Tempo",
                description: "Keep the planned work.",
                recommended: false,
                consequence: "Tomorrow keeps the tempo session.",
              },
            ],
          },
          {
            toolCallId: "decision-tool",
            messages: [],
            experimental_context: request.options.context,
          },
        );
        return generated("");
      }
      return generated("Keep tomorrow easy.");
    });
    const resolveFor = vi.spyOn(ports.language, "resolveFor");
    for (const [submissionId, text] of [
      ["earlier-message", "How was my ride?"],
      ["latest-message", "Come recupero domani?"],
    ] as const) {
      await engine.enqueueChatMessage!({ chatId: "desktop", submissionId, text });
    }

    await engine.resumeChatQueue!({ chatId: "desktop" });

    expect(resolveFor).toHaveBeenCalledExactlyOnceWith({
      chatId: "desktop",
      athleteText: "Come recupero domani?",
    });
    const decision = ports.coachDecisions?.getDecision("desktop");
    const option = decision?.options[0];
    if (decision == null || option === undefined) throw new Error("Missing queued decision");
    expect(
      getTurnContext({ experimental_context: requests[0]?.options.context })?.athleteText,
    ).toBe("How was my ride?\n\nCome recupero domani?");

    await expect(
      engine.answerCoachDecision({
        chatId: "desktop",
        decisionId: decision.decisionId,
        answer: { kind: "option", optionId: option.id },
      }),
    ).resolves.toMatchObject({
      decision: {
        status: "answered",
        continuation: { status: "completed", coachText: "Keep tomorrow easy." },
      },
    });
    expect(resolveFor).toHaveBeenLastCalledWith({
      chatId: "desktop",
      athleteText: "How was my ride?\n\nCome recupero domani?",
    });
    expect(requests).toHaveLength(2);
  });

  it("waits for the active chat before resolving a queued turn's language", async () => {
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requests: ModelTransportRequest[] = [];
    const { engine, ports } = setup(undefined, async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        markStarted();
        await gate;
      }
      return generated("Done");
    });
    const resolveFor = vi.spyOn(ports.language, "resolveFor");
    const claim = vi.spyOn(ports.chatStore, "claimChatQueue");
    let language: LanguageResolution = { language: "it", source: "preference", locale: "it-IT" };
    resolveFor.mockImplementation(async () => language);
    const active = engine.chat({
      chatId: "desktop",
      message: "Earlier turn",
      turn: { language: "en", languageSource: "preference" },
    });
    await started;
    await engine.enqueueChatMessage!({
      chatId: "desktop",
      submissionId: "later",
      text: "Come recupero?",
    });
    const queued = engine.resumeChatQueue!({ chatId: "desktop" });
    try {
      await vi.waitFor(() => expect(claim).toHaveBeenCalledOnce());
      expect(resolveFor).not.toHaveBeenCalled();
      language = { language: "ja", source: "preference", locale: "ja-JP" };
    } finally {
      release();
      await active;
      await queued;
    }
    expect(resolveFor).toHaveBeenCalledExactlyOnceWith({
      chatId: "desktop",
      athleteText: "Come recupero?",
    });
    expect(requests.at(-1)?.options.system).toContain("The athlete chose Japanese (日本語).");
  });

  it("resolves the latest queued athlete message at execution and again on retry", async () => {
    const requests: ModelTransportRequest[] = [];
    const { engine, ports } = setup(undefined, async (request) => {
      requests.push(request);
      if (requests.length === 1) throw new Error("failed turn");
      return generated("Done");
    });
    const resolveFor = vi.spyOn(ports.language, "resolveFor");
    let language: LanguageResolution = { language: "it", source: "preference", locale: "it-IT" };
    resolveFor.mockImplementation(async () => language);
    await engine.enqueueChatMessage!({
      chatId: "desktop",
      submissionId: "earlier-message",
      text: "How was my ride?",
    });
    await engine.enqueueChatMessage!({
      chatId: "desktop",
      submissionId: "latest-message",
      text: "Come recupero domani?",
    });
    expect(resolveFor).not.toHaveBeenCalled();
    await expect(engine.resumeChatQueue!({ chatId: "desktop" })).rejects.toThrow("failed turn");
    expect(resolveFor).toHaveBeenCalledExactlyOnceWith({
      chatId: "desktop",
      athleteText: "Come recupero domani?",
    });
    expect(requests[0]?.options.system).toContain("The athlete chose Italian (Italiano).");
    expect(
      getTurnContext({ experimental_context: requests[0]?.options.context })?.athleteText,
    ).toBe("How was my ride?\n\nCome recupero domani?");
    const failed = await engine.getChatQueue!({ chatId: "desktop" });
    const claimId = failed.retryRequired?.claimId;
    expect(claimId).toBeDefined();
    if (claimId === undefined) throw new Error("Expected a retry claim");
    language = { language: "ja", source: "preference", locale: "ja-JP" };
    await engine.retryQueuedTurn!({ chatId: "desktop", claimId });
    expect(resolveFor).toHaveBeenCalledTimes(2);
    expect(resolveFor).toHaveBeenLastCalledWith({
      chatId: "desktop",
      athleteText: "Come recupero domani?",
    });
    expect(requests.at(-1)?.options.system).toContain("The athlete chose Japanese (日本語).");
    expect(JSON.stringify(requests.at(-1)?.options.messages)).toContain(
      "How was my ride?\\n\\nCome recupero domani?",
    );
  });

  it("assigns host-owned Message identities and preserves ordinary attachment references", async () => {
    const { engine } = setup();
    const queued = await engine.enqueueChatMessage!({
      chatId: "desktop",
      submissionId: "submission-1",
      text: "Review this activity",
      attachmentIds: ["attachment-1"],
    });
    expect(queued.items[0]).toMatchObject({
      queuedMessageId: "id-1",
      messageId: "id-2",
      attachmentIds: ["attachment-1"],
    });
    await expect(
      engine.enqueueChatMessage!({
        chatId: "desktop",
        submissionId: "submission-2",
        text: "/review",
        attachmentIds: ["attachment-2"],
      }),
    ).rejects.toThrow(/text-only/u);
  });

  it("links admitted attachments to the stable queued Message or rolls the queue item back", async () => {
    const acceptQueuedMessage = vi.fn(async () => {});
    const linked = setup(undefined, undefined, {
      acceptQueuedMessage,
      prepareQueuedTurn: async () => ({ activities: [] }),
      completeQueuedTurn: async () => {},
    });
    await expect(
      linked.engine.enqueueChatMessage!({
        chatId: "desktop",
        submissionId: "submission-linked",
        text: "",
        attachmentIds: ["attachment-1"],
      }),
    ).resolves.toMatchObject({ items: [{ messageId: "id-2", attachmentIds: ["attachment-1"] }] });
    expect(acceptQueuedMessage).toHaveBeenCalledWith({
      chatId: "desktop",
      messageId: "id-2",
      attachmentIds: ["attachment-1"],
    });

    const failed = setup(undefined, undefined, {
      acceptQueuedMessage: async () => {
        throw new Error("link failed");
      },
      prepareQueuedTurn: async () => ({ activities: [] }),
      completeQueuedTurn: async () => {},
    });
    await expect(
      failed.engine.enqueueChatMessage!({
        chatId: "desktop",
        submissionId: "submission-failed",
        text: "Review",
        attachmentIds: ["attachment-1"],
      }),
    ).rejects.toThrow("link failed");
    await expect(failed.engine.getChatQueue!({ chatId: "desktop" })).resolves.toMatchObject({
      items: [],
    });
  });

  it("imports queued attachments before Coach and exposes only normalized canonical activity fields", async () => {
    const order: string[] = [];
    const prepareQueuedTurn = vi.fn(async () => {
      order.push("prepared");
      return {
        activities: [
          {
            attachmentId: "attachment-1",
            messageId: "id-2",
            activityIds: ["activity-1"],
            sessions: [
              {
                activityId: "activity-1",
                sport: "cycling",
                startUtc: 1_777_000_000,
                elapsedSeconds: 3_600,
                distanceMeters: 40_000,
              },
            ],
          },
        ],
        attachments: [
          {
            attachmentId: "attachment-1",
            displayName: "morning-ride.fit",
            kind: "activity" as const,
            extension: "fit" as const,
          },
        ],
      };
    });
    const completeQueuedTurn = vi.fn(async () => {
      order.push("completed");
    });
    const requests: ModelTransportRequest[] = [];
    const value = setup(
      undefined,
      async (request) => {
        order.push("coach");
        requests.push(request);
        return generated("Reviewed");
      },
      { prepareQueuedTurn, completeQueuedTurn },
    );
    const transcriptAppend = vi.spyOn(value.ports.transcriptWriter, "appendCompletedTurn");
    await value.engine.enqueueChatMessage!({
      chatId: "desktop",
      submissionId: "submission-1",
      text: "Review the ride",
      attachmentIds: ["attachment-1"],
    });
    await expect(value.engine.resumeChatQueue!({ chatId: "desktop" })).resolves.toMatchObject({
      response: { text: "Reviewed" },
      snapshot: { items: [] },
    });
    expect(prepareQueuedTurn).toHaveBeenCalledWith({
      chatId: "desktop",
      messages: [{ messageId: "id-2", attachmentIds: ["attachment-1"] }],
    });
    expect(completeQueuedTurn).toHaveBeenCalledWith({
      chatId: "desktop",
      messageIds: ["id-2"],
    });
    expect(order).toEqual(["prepared", "coach", "completed"]);
    const providerMessages = JSON.stringify(requests[0]?.options.messages);
    expect(providerMessages).toContain("Canonical Training activities imported");
    expect(providerMessages).toContain("activity-1");
    expect(providerMessages).not.toContain("raw-fit-private-bytes");
    expect(transcriptAppend).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          {
            attachmentId: "attachment-1",
            displayName: "morning-ride.fit",
            kind: "activity",
            extension: "fit",
          },
        ],
      }),
    );
  });

  it("leaves the stable queue claim retryable when attachment preparation fails before Coach", async () => {
    const generate = vi.fn(async () => generated("Reviewed after recovery"));
    const prepareQueuedTurn = vi
      .fn<ChatAttachmentTurnPort["prepareQueuedTurn"]>()
      .mockRejectedValueOnce(new Error("import interrupted"))
      .mockResolvedValue({
        activities: [],
        attachments: [
          {
            attachmentId: "attachment-1",
            displayName: "recovery-ride.fit",
            kind: "activity",
            extension: "fit",
          },
        ],
      });
    const { engine, ports } = setup(undefined, generate, {
      prepareQueuedTurn,
      completeQueuedTurn: async () => {},
    });
    const transcriptAppend = vi.spyOn(ports.transcriptWriter, "appendCompletedTurn");
    await engine.enqueueChatMessage!({
      chatId: "desktop",
      submissionId: "submission-1",
      text: "Review the ride",
      attachmentIds: ["attachment-1"],
    });
    await expect(engine.resumeChatQueue!({ chatId: "desktop" })).rejects.toThrow(
      "import interrupted",
    );
    expect(generate).not.toHaveBeenCalled();
    const interrupted = await engine.getChatQueue!({ chatId: "desktop" });
    expect(interrupted).toMatchObject({
      items: [{ messageId: "id-2", attachmentIds: ["attachment-1"] }],
      retryRequired: { queuedMessageIds: ["id-1"] },
    });
    await expect(
      engine.retryQueuedTurn!({
        chatId: "desktop",
        claimId: interrupted.retryRequired!.claimId,
      }),
    ).resolves.toMatchObject({ response: { text: "Reviewed after recovery" } });
    expect(transcriptAppend).toHaveBeenCalledWith(
      expect.objectContaining({
        athleteText: "Review the ride",
        coachText: "Reviewed after recovery",
        attachments: [
          {
            attachmentId: "attachment-1",
            displayName: "recovery-ride.fit",
            kind: "activity",
            extension: "fit",
          },
        ],
      }),
    );
  });

  it("recovers attachment completion after restart without sending a completed turn twice", async () => {
    const generate = vi.fn(async () => generated("Reviewed once"));
    const completeQueuedTurn = vi
      .fn<ChatAttachmentTurnPort["completeQueuedTurn"]>()
      .mockRejectedValueOnce(new Error("completion interrupted"))
      .mockResolvedValue(undefined);
    const chatAttachments: ChatAttachmentTurnPort = {
      prepareQueuedTurn: async () => ({
        activities: [],
        attachments: [
          {
            attachmentId: "attachment-1",
            displayName: "ride.fit",
            kind: "activity",
            extension: "fit",
          },
        ],
      }),
      completeQueuedTurn,
    };
    const first = setup(undefined, generate, chatAttachments);
    const queued = await first.engine.enqueueChatMessage!({
      chatId: "desktop",
      submissionId: "submission-recovery",
      text: "Review the ride",
      attachmentIds: ["attachment-1"],
    });

    await expect(first.engine.resumeChatQueue!({ chatId: "desktop" })).rejects.toThrow(
      "completion interrupted",
    );

    const restored = setup(first.root, generate, chatAttachments);
    const recovered = await restored.engine.getChatQueue!({ chatId: "desktop" });
    expect(recovered.items).toEqual([]);
    expect(recovered).not.toHaveProperty("retryRequired");
    expect(completeQueuedTurn).toHaveBeenNthCalledWith(2, {
      chatId: "desktop",
      messageIds: [queued.items[0]!.messageId],
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("revalidates capability before Send and keeps provider image bytes out of history", async () => {
    const order: string[] = [];
    const capabilities: Awaited<ReturnType<AttachmentCapabilitiesPort["resolve"]>> = {
      schemaVersion: 1,
      active: { provider: "openai", model: "gpt-5.6-sol", transport: "ai-sdk" },
      documents: { enabled: true, extensions: ["pdf", "txt", "csv", "docx"] },
      completedActivities: { enabled: true, extensions: ["fit", "tcx", "gpx"] },
      plannedWorkouts: { enabled: true, extensions: ["zwo", "erg", "mrc"] },
      images: {
        enabled: true,
        mediaTypes: ["image/png", "image/jpeg", "image/webp"],
        reason: "supported",
        source: "maintained_catalogue",
        checkedAt: "2026-08-26T00:00:00.000Z",
      },
    };
    const mediaBytes = new Uint8Array([137, 80, 78, 71]);
    const prepareQueuedTurn = vi.fn(async (request) => {
      order.push("prepared");
      expect(request.capabilities).toEqual(capabilities);
      return {
        activities: [],
        nativeMedia: [
          {
            attachmentId: "attachment-1",
            mediaType: "image/png" as const,
            bytes: mediaBytes,
            width: 1,
            height: 1,
          },
        ],
      };
    });
    const requests: ModelTransportRequest[] = [];
    const value = setup(
      undefined,
      async (request) => {
        order.push("coach");
        requests.push(request);
        return generated("Reviewed image");
      },
      { prepareQueuedTurn, completeQueuedTurn: async () => {} },
      {
        resolve: async () => {
          order.push("capability");
          return capabilities;
        },
      },
    );
    await value.engine.enqueueChatMessage!({
      chatId: "desktop",
      submissionId: "submission-image",
      text: "Review this image",
      attachmentIds: ["attachment-1"],
    });
    await value.engine.resumeChatQueue!({ chatId: "desktop" });
    expect(order).toEqual(["capability", "prepared", "coach"]);
    const providerUser = requests[0]?.options.messages?.at(-1);
    expect(providerUser).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: expect.stringContaining("Review this image") },
        { type: "image", image: mediaBytes, mediaType: "image/png" },
      ],
    });
    const history = value.ports.chatStore.load("desktop").messages;
    expect(history).toMatchObject([
      { role: "user", content: expect.stringMatching(/^Review this image\nCurrent time: /) },
      { role: "assistant", content: "Reviewed image" },
    ]);
    expect(JSON.stringify(history)).not.toContain("137,80,78,71");
  });

  it("groups consecutive ordinary messages and stops at a command barrier", async () => {
    const requests: ModelTransportRequest[] = [];
    const { engine } = setup(undefined, async (request) => {
      requests.push(request);
      return generated(`Reply ${requests.length}`);
    });
    await engine.enqueueChatMessage!({ chatId: "desktop", submissionId: "s1", text: "First" });
    await engine.enqueueChatMessage!({ chatId: "desktop", submissionId: "s2", text: "Second" });
    await engine.enqueueChatMessage!({ chatId: "desktop", submissionId: "s3", text: "/review" });
    await engine.enqueueChatMessage!({ chatId: "desktop", submissionId: "s4", text: "Later" });

    const first = await engine.resumeChatQueue!({ chatId: "desktop" });
    expect(first.response?.text).toBe("Reply 1");
    expect(first.snapshot.items.map((item) => item.text)).toEqual(["/review", "Later"]);
    expect(JSON.stringify(requests[0]?.options.messages)).toContain("First\\n\\nSecond");

    const command = await engine.resumeChatQueue!({ chatId: "desktop" });
    expect(command.response?.text).toBe("Reply 2");
    expect(command.snapshot.items.map((item) => item.text)).toEqual(["Later"]);
  });

  it("requires Run command only after a slash command is restored", async () => {
    const first = setup();
    const queued = await first.engine.enqueueChatMessage!({
      chatId: "desktop",
      submissionId: "s1",
      text: "/review",
    });
    const id = queued.items[0]!.queuedMessageId;
    const restored = setup(first.root);

    const held = await restored.engine.resumeChatQueue!({ chatId: "desktop" });
    expect(held.response).toBeUndefined();
    expect(held.snapshot.items[0]).toMatchObject({ restored: true, queuedMessageId: id });
    await expect(
      restored.engine.runQueuedCommand!({ chatId: "desktop", queuedMessageId: id }),
    ).resolves.toMatchObject({ response: { text: "Done" }, snapshot: { items: [] } });
  });

  it("does not claim or run while an unanswered coach decision owns the chat", async () => {
    const generate = vi.fn(async () => generated("Unexpected"));
    const { engine, ports } = setup(undefined, generate);
    await engine.enqueueChatMessage!({ chatId: "desktop", submissionId: "s1", text: "Later" });
    ports.coachDecisions!.appendDecisionRequested({
      turnId: "turn-decision",
      decision: {
        status: "unanswered",
        decisionId: "decision-1",
        chatId: "desktop",
        messageId: "message-1",
        question: "Choose.",
        options: [
          { id: "a", label: "A", description: "A", recommended: true, consequence: "A" },
          { id: "b", label: "B", description: "B", recommended: false, consequence: "B" },
        ],
      },
      toolCallId: "tool-1",
      athleteText: "Question",
      requestedAt: "2026-08-25T00:00:00.000Z",
    });

    const blocked = await engine.resumeChatQueue!({ chatId: "desktop" });
    expect(blocked.response).toBeUndefined();
    expect(blocked.snapshot.items.map((item) => item.text)).toEqual(["Later"]);
    expect(generate).not.toHaveBeenCalled();
  });

  it("fences queue execution behind a paused reset for the same chat", async () => {
    let releaseFlush!: () => void;
    const flushStarted = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    let allowFlush!: () => void;
    const flushGate = new Promise<void>((resolve) => {
      allowFlush = resolve;
    });
    const generate = vi.fn(async (request: ModelTransportRequest) => {
      if (request.options.caller === "flush") {
        releaseFlush();
        await flushGate;
        return generated("Flush complete");
      }
      return generated("Unexpected queue response");
    });
    const { engine, ports } = setup(undefined, generate);
    ports.chatStore.overwriteHistory("desktop", [{ role: "user", content: "Earlier message" }]);
    await engine.enqueueChatMessage!({
      chatId: "desktop",
      submissionId: "submission-1",
      text: "Queued during reset race",
    });

    const reset = engine.resetSession({ chatId: "desktop" });
    await flushStarted;
    const resume = engine.resumeChatQueue!({ chatId: "desktop" });
    await Promise.resolve();
    expect(generate).toHaveBeenCalledTimes(1);
    allowFlush();

    await expect(reset).resolves.toMatchObject({ memoryFlushed: true });
    await expect(resume).resolves.toMatchObject({ snapshot: { items: [] } });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("reconciles a durably projected claimed turn without rerunning it", async () => {
    const generate = vi.fn(async () => generated("Unexpected"));
    const { engine, ports } = setup(undefined, generate);
    const queued = await engine.enqueueChatMessage!({
      chatId: "desktop",
      submissionId: "s1",
      text: "First",
    });
    const id = queued.items[0]!.queuedMessageId;
    ports.chatStore.claimChatQueue!("desktop", "claim-1", "turn-1", [id]);
    ports.transcriptWriter.appendCompletedTurn({
      chatId: "desktop",
      turnId: "turn-1",
      completedAt: "2026-08-25T00:00:00.000Z",
      athleteText: "First",
      coachText: "Done",
    });

    expect(await engine.getChatQueue!({ chatId: "desktop" })).toMatchObject({ items: [] });
    expect(generate).not.toHaveBeenCalled();
  });

  it("hands an active recovery claim to a fresh retry before later ordinary work", async () => {
    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    const requests: ModelTransportRequest[] = [];
    const generate = vi.fn((request: ModelTransportRequest): Promise<GenerateResult> => {
      requests.push(request);
      if (requests.length === 1) {
        request.options.onTextDelta?.("Partial");
        announceStarted();
        return new Promise<GenerateResult>((_resolve, reject) => {
          request.options.signal?.addEventListener("abort", () => reject(new Error("stopped")), {
            once: true,
          });
        });
      }
      return Promise.resolve(generated(requests.length === 2 ? "Recovered" : "Later reply"));
    });
    const { engine } = setup(undefined, generate);
    await engine.enqueueChatMessage!({ chatId: "desktop", submissionId: "s1", text: "First" });
    const activeEvents: TurnEvent[] = [];
    const running = engine.resumeChatQueue!({ chatId: "desktop" }, (event) =>
      activeEvents.push(event),
    );
    await started;
    await engine.enqueueChatMessage!({
      chatId: "desktop",
      submissionId: "s2",
      text: "Later 1",
    });
    await engine.enqueueChatMessage!({
      chatId: "desktop",
      submissionId: "s3",
      text: "Later 2",
    });

    const recovery = await engine.getChatQueue!({ chatId: "desktop" });
    expect(recovery.items.map((item) => item.text)).toEqual(["First", "Later 1", "Later 2"]);
    expect(recovery.retryRequired).toMatchObject({
      queuedMessageIds: [recovery.items[0]!.queuedMessageId],
    });

    const retryEvents: TurnEvent[] = [];
    const retrying = engine.retryQueuedTurn!(
      { chatId: "desktop", claimId: recovery.retryRequired!.claimId },
      (event) => retryEvents.push(event),
    );
    await expect(running).resolves.toMatchObject({
      response: { text: "Partial" },
      snapshot: { retryRequired: { claimId: recovery.retryRequired!.claimId } },
    });
    const retried = await retrying;
    expect(retried.response?.text).toBe("Recovered");
    expect(retried.snapshot.items.map((item) => item.text)).toEqual(["Later 1", "Later 2"]);
    expect(retried.snapshot.retryRequired).toBeUndefined();
    const firstTurnId = activeEvents.find((event) => event.type === "turn-start")?.turnId;
    const retryTurnId = retryEvents.find((event) => event.type === "turn-start")?.turnId;
    expect(retryTurnId).toBeDefined();
    expect(retryTurnId).toBe(firstTurnId);
    expect(retryEvents.map((event) => event.type)).toEqual(["turn-start", "final-text"]);

    const later = await engine.resumeChatQueue!({ chatId: "desktop" });
    expect(later.response?.text).toBe("Later reply");
    expect(later.snapshot.items).toEqual([]);
    expect(requests[1]?.options.messages?.at(-1)).toMatchObject({
      role: "user",
      content: expect.stringContaining("First"),
    });
    expect(requests[2]?.options.messages?.at(-1)).toMatchObject({
      role: "user",
      content: expect.stringContaining("Later 1\n\nLater 2"),
    });
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it("coalesces a duplicate retry after its turn starts and preserves different-claim behavior", async () => {
    const failure = new Error("terminal queue failure");
    let announceRetryStarted!: () => void;
    const retryStarted = new Promise<void>((resolve) => {
      announceRetryStarted = resolve;
    });
    let completeRetry!: () => void;
    let attempts = 0;
    const generate = vi.fn((request: ModelTransportRequest): Promise<GenerateResult> => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(failure);
      return new Promise<GenerateResult>((resolve, reject) => {
        completeRetry = () => resolve(generated("Recovered"));
        request.options.signal?.addEventListener("abort", () => reject(new Error("restarted")), {
          once: true,
        });
        announceRetryStarted();
      });
    });
    const { engine } = setup(undefined, generate);
    await engine.enqueueChatMessage!({ chatId: "desktop", submissionId: "s1", text: "Queued" });
    await expect(engine.resumeChatQueue!({ chatId: "desktop" })).rejects.toBe(failure);
    const recovery = await engine.getChatQueue!({ chatId: "desktop" });

    const retryEvents: TurnEvent[] = [];
    const collectRetryEvent = (event: TurnEvent): void => {
      retryEvents.push(event);
    };
    const first = engine.retryQueuedTurn!(
      { chatId: "desktop", claimId: recovery.retryRequired!.claimId },
      collectRetryEvent,
    );
    await retryStarted;
    const sameSubscriber = engine.retryQueuedTurn!(
      { chatId: "desktop", claimId: recovery.retryRequired!.claimId },
      collectRetryEvent,
    );
    expect(sameSubscriber).toBe(first);
    expect(retryEvents.map((event) => event.type)).toEqual(["turn-start"]);
    const duplicateEvents: TurnEvent[] = [];
    const duplicate = engine.retryQueuedTurn!(
      { chatId: "desktop", claimId: recovery.retryRequired!.claimId },
      (event) => duplicateEvents.push(event),
    );
    expect(duplicate).toBe(first);
    expect(duplicateEvents.map((event) => event.type)).toEqual(["turn-start"]);
    const throwingSubscriber = vi.fn(() => {
      throw new Error("detached subscriber");
    });
    expect(() =>
      engine.retryQueuedTurn!(
        { chatId: "desktop", claimId: recovery.retryRequired!.claimId },
        throwingSubscriber,
      ),
    ).not.toThrow();

    const different = engine.retryQueuedTurn!({ chatId: "desktop", claimId: "stale-claim" });
    expect(different).not.toBe(first);
    await expect(different).resolves.toMatchObject({
      snapshot: { retryRequired: { claimId: recovery.retryRequired!.claimId } },
    });

    completeRetry();
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
    expect(duplicateResult).toBe(firstResult);
    expect(firstResult).toMatchObject({ response: { text: "Recovered" }, snapshot: { items: [] } });
    expect(retryEvents.filter((event) => event.type === "turn-start")).toHaveLength(1);
    expect(retryEvents.filter((event) => event.type === "final-text")).toHaveLength(1);
    expect(duplicateEvents.map((event) => event.type)).toEqual(["turn-start", "final-text"]);
    expect(duplicateEvents).toEqual(retryEvents);
    expect(throwingSubscriber).toHaveBeenCalledTimes(2);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("keeps a thrown queue claim unchanged while direct chat succeeds", async () => {
    const failure = new Error("terminal queue failure");
    let attempts = 0;
    const generate = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw failure;
      return generated(attempts === 2 ? "Direct reply" : "Recovered");
    });
    const { engine } = setup(undefined, generate);
    await engine.enqueueChatMessage!({ chatId: "desktop", submissionId: "s1", text: "Queued" });

    await expect(engine.resumeChatQueue!({ chatId: "desktop" })).rejects.toBe(failure);
    const beforeDirect = await engine.getChatQueue!({ chatId: "desktop" });
    expect(beforeDirect.retryRequired).toMatchObject({
      queuedMessageIds: [beforeDirect.items[0]!.queuedMessageId],
    });

    await expect(engine.chat({ chatId: "desktop", message: "Independent" })).resolves.toEqual({
      text: "Direct reply",
    });
    expect(await engine.getChatQueue!({ chatId: "desktop" })).toEqual(beforeDirect);

    await expect(
      engine.retryQueuedTurn!({
        chatId: "desktop",
        claimId: beforeDirect.retryRequired!.claimId,
      }),
    ).resolves.toMatchObject({ response: { text: "Recovered" }, snapshot: { items: [] } });
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it("Stop marks only the active claim retry-required and never drains the command behind it", async () => {
    let started!: () => void;
    const active = new Promise<void>((resolve) => {
      started = resolve;
    });
    let attempts = 0;
    const generate = vi.fn((request: ModelTransportRequest) => {
      attempts += 1;
      if (attempts === 2) return Promise.resolve(generated("Recovered"));
      return new Promise<GenerateResult>((_resolve, reject) => {
        started();
        request.options.signal?.addEventListener("abort", () => reject(new Error("stopped")), {
          once: true,
        });
      });
    });
    const { engine, ports } = setup(undefined, generate);
    const transcriptAppend = vi.spyOn(ports.transcriptWriter, "appendCompletedTurn");
    await engine.enqueueChatMessage!({ chatId: "desktop", submissionId: "s1", text: "First" });
    await engine.enqueueChatMessage!({ chatId: "desktop", submissionId: "s2", text: "/review" });
    let activeTurnId: string | undefined;
    const running = engine.resumeChatQueue!({ chatId: "desktop" }, (event) => {
      if (event.type === "turn-start") activeTurnId = event.turnId;
    }).catch(() => undefined);
    await active;
    if (activeTurnId === undefined) throw new Error("active turn was not announced");
    await engine.stopChat!({ chatId: "desktop", turnId: activeTurnId });
    await running;

    const snapshot = await engine.getChatQueue!({ chatId: "desktop" });
    expect(snapshot.retryRequired).toMatchObject({
      queuedMessageIds: [snapshot.items[0]!.queuedMessageId],
    });
    expect(snapshot.items.map((item) => item.text)).toEqual(["First", "/review"]);
    expect(generate).toHaveBeenCalledTimes(1);

    const retried = await engine.retryQueuedTurn!({
      chatId: "desktop",
      claimId: snapshot.retryRequired!.claimId,
    });
    expect(retried.response?.text).toBe("Recovered");
    expect(retried.snapshot.retryRequired).toBeUndefined();
    expect(retried.snapshot.items.map((item) => item.text)).toEqual(["/review"]);
    expect(transcriptAppend).toHaveBeenCalledWith(
      expect.objectContaining({ athleteText: "First", coachText: "Recovered" }),
    );
    expect(generate).toHaveBeenCalledTimes(2);
  });
});
