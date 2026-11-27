import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatQueueStore } from "../src/agent/chat-queue-store.js";
import { ChatStore } from "../src/agent/chat-store.js";
import { ConversationStore, createConversationStore } from "../src/agent/conversation-store.js";
import { TranscriptStore } from "../src/agent/transcript-store.js";
import { WindowsPrivatePathPolicyError } from "../src/io/windows-private-path-policy.js";

describe("ChatQueueStore", () => {
  const roots: string[] = [];

  afterEach(() => {
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  function store(): { root: string; value: ChatQueueStore } {
    const root = mkdtempSync(join(tmpdir(), "chat-queue-"));
    roots.push(root);
    return { root, value: new ChatQueueStore(root) };
  }

  it("durably enqueues idempotently and restores FIFO state with a monotonic revision", () => {
    const { root, value } = store();
    const first = value.enqueue("desktop", "submission-1", "First", "message-1");
    const duplicate = value.enqueue("desktop", "submission-1", "Changed", "message-2");
    const second = value.enqueue("desktop", "submission-2", "/review", "message-3");

    expect(first).toMatchObject({ revision: 1, items: [{ text: "First", restored: false }] });
    expect(duplicate).toEqual(first);
    expect(second.items.map((item) => [item.text, item.position])).toEqual([
      ["First", 0],
      ["/review", 1],
    ]);

    const restored = new ChatQueueStore(root).get("desktop");
    expect(restored.revision).toBe(2);
    expect(restored.items.map((item) => item.restored)).toEqual([true, true]);
  });

  it("stores one stable Message identity and attachment list per ordinary queue item", () => {
    const { value } = store();
    const queued = value.enqueue(
      "desktop",
      "submission-1",
      "Review this",
      "queued-1",
      "message-1",
      ["attachment-1"],
    );
    expect(queued.items[0]).toMatchObject({
      queuedMessageId: "queued-1",
      messageId: "message-1",
      attachmentIds: ["attachment-1"],
    });
    expect(() =>
      value.enqueue("desktop", "submission-2", "/review", "queued-2", "message-2", [
        "attachment-2",
      ]),
    ).toThrow(/text-only/u);
  });

  it("restores legacy queues with deterministic Message identities and upgrades on mutation", () => {
    const { root, value } = store();
    const path = join(
      root,
      "chat-queues",
      `${createHash("sha256").update("desktop").digest("hex")}.json`,
    );
    writeFileSync(
      path,
      `${JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        items: [
          {
            queuedMessageId: "legacy-queued-1",
            submissionId: "legacy-submission-1",
            text: "Legacy message",
            kind: "ordinary",
          },
        ],
      })}\n`,
      { mode: 0o600 },
    );

    expect(value.get("desktop").items[0]).toMatchObject({
      queuedMessageId: "legacy-queued-1",
      messageId: "legacy-queued-1",
      attachmentIds: [],
      restored: true,
    });
    value.enqueue("desktop", "submission-2", "New", "queued-2", "message-2", []);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      schemaVersion: 2,
      items: [
        { messageId: "legacy-queued-1", attachmentIds: [] },
        { messageId: "message-2", attachmentIds: [] },
      ],
    });
  });

  it("removes every unclaimed item by stable identity before dispatch", () => {
    const { value } = store();
    value.enqueue("desktop", "submission-1", "First", "message-1");
    value.enqueue("desktop", "submission-2", "Second", "message-2");
    value.enqueue("desktop", "submission-3", "Third", "message-3");

    expect(value.remove("desktop", "message-2").items.map((item) => item.queuedMessageId)).toEqual([
      "message-1",
      "message-3",
    ]);
    expect(value.remove("desktop", "message-1").items.map((item) => item.queuedMessageId)).toEqual([
      "message-3",
    ]);
    expect(value.remove("desktop", "message-3").items).toEqual([]);
  });

  it("claims the exact head, preserves later messages on interruption, and removes only on completion", () => {
    const { value } = store();
    value.enqueue("desktop", "submission-1", "First", "message-1");
    value.enqueue("desktop", "submission-2", "Second", "message-2");
    value.claim("desktop", {
      claimId: "claim-1",
      turnId: "turn-1",
      queuedMessageIds: ["message-1"],
    });

    expect(() => value.remove("desktop", "message-1")).toThrow(/claimed/u);
    const recovery = value.requireRetry("desktop", "claim-1");
    expect(recovery.retryRequired).toMatchObject({ claimId: "claim-1", turnId: "turn-1" });
    expect(recovery.items.map((item) => item.text)).toEqual(["First", "Second"]);

    value.retry("desktop", "claim-1", "turn-2");
    const completed = value.complete("desktop", "claim-1");
    expect(completed.items.map((item) => item.text)).toEqual(["Second"]);
    expect(completed.retryRequired).toBeUndefined();
  });

  it("reconciles a completed claimed turn without rerun and fences an incomplete claim", () => {
    const complete = store();
    complete.value.enqueue("desktop", "submission-1", "First", "message-1");
    complete.value.claim("desktop", {
      claimId: "claim-1",
      turnId: "turn-1",
      queuedMessageIds: ["message-1"],
    });
    expect(
      new ChatQueueStore(complete.root).reconcile("desktop", new Set(["turn-1"])).items,
    ).toEqual([]);

    const incomplete = store();
    incomplete.value.enqueue("desktop", "submission-2", "First", "message-2");
    incomplete.value.claim("desktop", {
      claimId: "claim-2",
      turnId: "turn-2",
      queuedMessageIds: ["message-2"],
    });
    expect(
      new ChatQueueStore(incomplete.root).reconcile("desktop", new Set()).retryRequired,
    ).toMatchObject({
      claimId: "claim-2",
    });

    const retry = store();
    retry.value.enqueue("desktop", "submission-3", "First", "message-3", "athlete-message-3");
    retry.value.claim("desktop", {
      claimId: "claim-3",
      turnId: "turn-3",
      queuedMessageIds: ["message-3"],
    });
    retry.value.requireRetry("desktop", "claim-3");
    const restored = new ChatQueueStore(retry.root);
    expect(restored.getCompletedClaim("desktop", new Set(["turn-3"]))).toEqual({
      turnId: "turn-3",
      messageIds: ["athlete-message-3"],
    });
    expect(restored.reconcile("desktop", new Set(["turn-3"])).items).toEqual([]);
  });

  it("fails closed on corrupt or non-private queue snapshots", () => {
    const { root, value } = store();
    value.enqueue("desktop", "submission-1", "First", "message-1");
    const queues = join(root, "chat-queues");
    const path = join(queues, `${createHash("sha256").update("desktop").digest("hex")}.json`);
    writeFileSync(path, "{}\n", { mode: 0o600 });
    chmodSync(path, 0o644);
    expect(() => value.get("desktop")).toThrow();
  });

  it("does not require a directory descriptor flush on Windows", () => {
    const root = mkdtempSync(join(tmpdir(), "chat-queue-win-"));
    roots.push(root);
    const value = new ChatQueueStore(root, "win32");
    expect(value.enqueue("desktop", "submission-1", "First", "message-1")).toMatchObject({
      revision: 1,
      items: [{ text: "First" }],
    });
  });

  it("binds Windows queue paths to the private conversation directory", () => {
    const symlinkRoot = mkdtempSync(join(tmpdir(), "chat-queue-win-link-"));
    roots.push(symlinkRoot);
    const outside = join(symlinkRoot, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(symlinkRoot, "chat-queues"));
    expect(() => createConversationStore(symlinkRoot, 0, { platform: "win32" })).toThrow(
      WindowsPrivatePathPolicyError,
    );

    const hardlinkRoot = mkdtempSync(join(tmpdir(), "chat-queue-win-hardlink-"));
    roots.push(hardlinkRoot);
    const conversations = createConversationStore(hardlinkRoot, 0, { platform: "win32" });
    conversations.enqueueChatMessage("desktop", "submission-1", "First", "message-1");
    const queuePath = join(
      hardlinkRoot,
      "chat-queues",
      `${createHash("sha256").update("desktop").digest("hex")}.json`,
    );
    linkSync(queuePath, join(hardlinkRoot, "shared-queue.json"));
    expect(() => conversations.getChatQueue("desktop")).toThrow(WindowsPrivatePathPolicyError);
  });

  it("rejects Windows queue identity changes and unstable reads through ConversationStore", () => {
    const identityRoot = mkdtempSync(join(tmpdir(), "chat-queue-win-identity-"));
    roots.push(identityRoot);
    const seedIdentity = createConversationStore(identityRoot, 0, { platform: "win32" });
    seedIdentity.enqueueChatMessage("desktop", "submission-1", "First", "message-1");
    let replaced = false;
    const identityStore = createConversationStore(identityRoot, 0, {
      platform: "win32",
      chatQueueHooks: {
        afterFileOpen(path) {
          if (replaced) return;
          replaced = true;
          const moved = `${path}.moved`;
          renameSync(path, moved);
          copyFileSync(moved, path);
        },
      },
    });
    expect(() => identityStore.getChatQueue("desktop")).toThrow(WindowsPrivatePathPolicyError);

    const stableRoot = mkdtempSync(join(tmpdir(), "chat-queue-win-stable-"));
    roots.push(stableRoot);
    const seedStable = createConversationStore(stableRoot, 0, { platform: "win32" });
    seedStable.enqueueChatMessage("desktop", "submission-1", "First", "message-1");
    expect(seedStable.getChatQueue("desktop").items).toHaveLength(1);
    let changed = false;
    const unstableStore = createConversationStore(stableRoot, 0, {
      platform: "win32",
      chatQueueHooks: {
        afterFileRead(path) {
          if (changed) return;
          changed = true;
          appendFileSync(path, " ");
        },
      },
    });
    expect(() => unstableStore.getChatQueue("desktop")).toThrow(WindowsPrivatePathPolicyError);
  });

  it("reconciles a decision-requested crash window without resending the queued prompt", () => {
    const root = mkdtempSync(join(tmpdir(), "chat-queue-decision-recovery-"));
    roots.push(root);
    const conversations = createConversationStore(root);
    const queued = conversations.enqueueChatMessage(
      "desktop",
      "submission-1",
      "Should I race tomorrow?",
      "message-1",
    );
    conversations.claimChatQueue("desktop", "claim-1", "turn-1", [
      queued.items[0]!.queuedMessageId,
    ]);
    conversations.appendDecisionRequested({
      turnId: "turn-1",
      decision: {
        status: "unanswered",
        decisionId: "decision-1",
        chatId: "desktop",
        messageId: "decision-message-1",
        question: "Choose tomorrow's priority.",
        options: [
          {
            id: "recover",
            label: "Recover",
            description: "Protect recovery.",
            recommended: true,
            consequence: "Tomorrow stays easy.",
          },
          {
            id: "race",
            label: "Race",
            description: "Keep the race.",
            recommended: false,
            consequence: "Tomorrow is a race day.",
          },
        ],
      },
      toolCallId: "tool-1",
      athleteText: "Should I race tomorrow?",
      requestedAt: "2026-08-25T00:00:00.000Z",
    });

    const recovered = createConversationStore(root);
    expect(recovered.getChatQueue("desktop")).toMatchObject({ items: [] });
    expect(recovered.getDecision("desktop")).toMatchObject({
      decisionId: "decision-1",
      status: "unanswered",
    });
  });

  it("clears the durable queue only after a successful conversation reset", () => {
    const root = mkdtempSync(join(tmpdir(), "chat-queue-reset-"));
    roots.push(root);
    const conversations = createConversationStore(root);
    conversations.enqueueChatMessage!("desktop", "submission-1", "First", "message-1");
    conversations.resetConversation({
      chatId: "desktop",
      boundaryAt: "2026-08-25T00:00:00.000Z",
      reason: "explicit-reset",
    });
    expect(conversations.getChatQueue!("desktop").items).toEqual([]);
  });

  it("keeps the reset intent until queue clearing succeeds and recovers the exact crash window", () => {
    const root = mkdtempSync(join(tmpdir(), "chat-queue-reset-recovery-"));
    roots.push(root);
    class FailingClearQueueStore extends ChatQueueStore {
      override clear(_chatId: string): never {
        throw new Error("synthetic queue clear failure");
      }
    }
    const queue = new FailingClearQueueStore(root);
    const transcript = new TranscriptStore(root);
    const conversations = new ConversationStore(
      new ChatStore(root),
      transcript,
      () => "a".repeat(64),
      queue,
    );
    queue.enqueue("desktop", "submission-1", "First", "message-1");
    expect(() =>
      conversations.resetConversation({
        chatId: "desktop",
        boundaryAt: "2026-08-25T00:00:00.000Z",
        reason: "explicit-reset",
      }),
    ).toThrow("synthetic queue clear failure");
    expect(transcript.readResetIntent("desktop")).not.toBeNull();

    const recoveredQueue = new ChatQueueStore(root);
    const recoveredTranscript = new TranscriptStore(root);
    const recovered = new ConversationStore(
      new ChatStore(root),
      recoveredTranscript,
      () => "b".repeat(64),
      recoveredQueue,
    );
    expect(recovered.getChatQueue("desktop").items).toEqual([]);
    expect(recoveredTranscript.readResetIntent("desktop")).toBeNull();
  });

  it("preserves the active claim and queued follow-ups during a stale-reset", () => {
    const root = mkdtempSync(join(tmpdir(), "chat-queue-stale-reset-"));
    roots.push(root);
    const conversations = createConversationStore(root);
    conversations.enqueueChatMessage("desktop", "submission-1", "First", "message-1");
    conversations.enqueueChatMessage("desktop", "submission-2", "Follow-up", "message-2");
    conversations.claimChatQueue("desktop", "claim-1", "turn-1", ["message-1"]);

    conversations.resetConversation({
      chatId: "desktop",
      boundaryAt: "1998-08-25T00:00:00.000Z",
      reason: "stale-reset",
    });

    const completed = conversations.completeChatQueueClaim("desktop", "claim-1");
    expect(completed.retryRequired).toBeUndefined();
    expect(completed.items.map((item) => [item.queuedMessageId, item.text])).toEqual([
      ["message-2", "Follow-up"],
    ]);
  });

  it("preserves the queue when recovering a crashed stale-reset intent", () => {
    const root = mkdtempSync(join(tmpdir(), "chat-queue-stale-reset-recovery-"));
    roots.push(root);
    const queue = new ChatQueueStore(root);
    const transcript = new TranscriptStore(root);
    queue.enqueue("desktop", "submission-1", "Queued before crash", "message-1");
    queue.claim("desktop", {
      claimId: "claim-1",
      turnId: "turn-1",
      queuedMessageIds: ["message-1"],
    });
    transcript.createResetIntent({
      version: 1,
      kind: "conversation-reset-intent",
      resetId: "d".repeat(64),
      chatId: "desktop",
      boundaryAt: "1998-08-25T00:00:00.000Z",
      reason: "stale-reset",
    });

    const recoveredTranscript = new TranscriptStore(root);
    const recovered = new ConversationStore(
      new ChatStore(root),
      recoveredTranscript,
      () => "e".repeat(64),
      new ChatQueueStore(root),
    );

    expect(recoveredTranscript.readResetIntent("desktop")).toBeNull();
    expect(recovered.getChatQueue("desktop")).toMatchObject({
      items: [{ queuedMessageId: "message-1", text: "Queued before crash" }],
      retryRequired: { claimId: "claim-1", turnId: "turn-1" },
    });
  });
});
