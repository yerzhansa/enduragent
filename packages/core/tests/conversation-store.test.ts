import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  archiveAndResetDurably,
  ChatStore,
  createChatStoreWithHooks,
} from "../src/agent/chat-store.js";
import { ConversationRecoveryError, ConversationStore } from "../src/agent/conversation-store.js";
import { TranscriptStore, type ResetIntentRecord } from "../src/agent/transcript-store.js";
import { WindowsPrivatePathPolicyError } from "../src/io/windows-private-path-policy.js";

const roots: string[] = [];
const RESET_ID = "c".repeat(64);
const RESET_ID_A = "a".repeat(64);
const RESET_ID_B = "b".repeat(64);

function makeDataDir(): string {
  const path = mkdtempSync(join(tmpdir(), "conversation-store-"));
  roots.push(path);
  return path;
}

function transcriptPath(dataDir: string, chatId: string): string {
  const digest = createHash("sha256").update(chatId, "utf8").digest("hex");
  return join(dataDir, "transcripts", `${digest}.jsonl`);
}

function intentPath(dataDir: string, chatId: string): string {
  const digest = createHash("sha256").update(chatId, "utf8").digest("hex");
  return join(dataDir, "transcripts", `${digest}.reset-intent.json`);
}

function intentTempPath(dataDir: string, chatId: string, resetId: string): string {
  const digest = createHash("sha256").update(chatId, "utf8").digest("hex");
  return join(dataDir, "transcripts", `${digest}.${resetId}.reset-intent.tmp`);
}

function resetIntent(chatId: string, resetId = RESET_ID): ResetIntentRecord {
  return {
    version: 1,
    kind: "conversation-reset-intent",
    resetId,
    chatId,
    boundaryAt: "2026-07-22T01:02:03.000Z",
    reason: "explicit-reset",
  };
}

const LINEAGE = {
  templateHash: "template",
  assembledHash: "assembled",
  provider: "synthetic",
  model: "synthetic",
  lineageVersion: "1",
};

function seedSession(store: ChatStore, chatId: string): void {
  store.appendTurn(chatId, "athlete", "coach", LINEAGE);
}

function sessionName(chatId: string, platform = process.platform): string {
  return platform === "win32" ? createHash("sha256").update(chatId, "utf8").digest("hex") : chatId;
}

function sessionPath(dataDir: string, chatId: string, platform = process.platform): string {
  return join(dataDir, "sessions", `${sessionName(chatId, platform)}.jsonl`);
}

function resetArchives(dataDir: string, chatId: string, platform = process.platform): string[] {
  return readdirSync(join(dataDir, "sessions")).filter((name) =>
    name.startsWith(`${sessionName(chatId, platform)}.jsonl.reset.`),
  );
}

function windowsSessionPath(dataDir: string, chatId: string): string {
  return sessionPath(dataDir, chatId, "win32");
}

function windowsResetArchives(dataDir: string, chatId: string): string[] {
  return resetArchives(dataDir, chatId, "win32");
}

function resetArchivePath(
  dataDir: string,
  reset: ResetIntentRecord,
  platform = process.platform,
): string {
  return join(
    dataDir,
    "sessions",
    `${sessionName(reset.chatId, platform)}.jsonl.reset.${reset.boundaryAt.replace(/:/g, "-")}.${reset.resetId}`,
  );
}

function boundaryLine(reset: ResetIntentRecord): Buffer {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      kind: "conversation-boundary",
      resetId: reset.resetId,
      chatId: reset.chatId,
      boundaryAt: reset.boundaryAt,
      reason: reset.reason,
    }),
    "utf8",
  );
}

function platformError(message: string): string | typeof WindowsPrivatePathPolicyError {
  return process.platform === "win32" ? WindowsPrivatePathPolicyError : message;
}

function boundaryCount(dataDir: string, chatId: string, resetId = RESET_ID): number {
  const path = transcriptPath(dataDir, chatId);
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => {
      if (line.length === 0) return false;
      try {
        const value = JSON.parse(line) as { kind?: string; resetId?: string };
        return value.kind === "conversation-boundary" && value.resetId === resetId;
      } catch {
        return false;
      }
    }).length;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ConversationStore reset transaction recovery", () => {
  it("keeps transcript pagination read-only when a reset intent is pending", () => {
    const dataDir = makeDataDir();
    const chatId = "read-only-page";
    const chat = new ChatStore(dataDir);
    const transcript = new TranscriptStore(dataDir);
    const store = new ConversationStore(chat, transcript);
    store.appendCompletedTurn({
      chatId,
      turnId: "turn-1",
      completedAt: "2026-07-22T00:00:00.000Z",
      athleteText: "a",
      coachText: "b",
    });
    const pending = resetIntent(chatId);
    transcript.createResetIntent(pending);
    const before = readFileSync(transcriptPath(dataDir, chatId));

    const page = store.readCurrentConversationPage(chatId, { cursor: null, limit: 1 });

    expect(page.turns.map((turn) => turn.turnId)).toEqual(["turn-1"]);
    expect(transcript.readResetIntent(chatId)).toEqual(pending);
    expect(readFileSync(transcriptPath(dataDir, chatId))).toEqual(before);
    expect(boundaryCount(dataDir, chatId)).toBe(0);
  });

  it("surfaces the pre-reset conversation as an archived read after a completed reset", () => {
    const dataDir = makeDataDir();
    const chatId = "archived-after-reset";
    const chat = new ChatStore(dataDir);
    const transcript = new TranscriptStore(dataDir);
    const store = new ConversationStore(chat, transcript, () => RESET_ID);
    store.appendCompletedTurn({
      chatId,
      turnId: "turn-1",
      completedAt: "2026-07-22T00:00:00.000Z",
      athleteText: "a",
      coachText: "b",
    });
    store.appendCompletedTurn({
      chatId,
      turnId: "turn-2",
      completedAt: "2026-07-22T00:00:01.000Z",
      athleteText: "c",
      coachText: "d",
    });

    store.resetConversation({
      chatId,
      boundaryAt: "2026-07-22T01:02:03.000Z",
      reason: "explicit-reset",
    });
    store.appendCompletedTurn({
      chatId,
      turnId: "turn-3",
      completedAt: "2026-07-22T02:00:00.000Z",
      athleteText: "e",
      coachText: "f",
    });
    const before = readFileSync(transcriptPath(dataDir, chatId));

    expect(store.listArchivedConversations(chatId)).toEqual({
      schemaVersion: 1,
      conversations: [
        {
          boundaryRef: RESET_ID,
          boundaryAt: "2026-07-22T01:02:03.000Z",
          reason: "explicit-reset",
          turnCount: 2,
        },
      ],
      truncated: false,
    });
    expect(
      store
        .readArchivedConversationPage(chatId, RESET_ID, { cursor: null, limit: 25 })
        .turns.map((record) => record.turnId),
    ).toEqual(["turn-1", "turn-2"]);
    expect(
      store
        .readCurrentConversationPage(chatId, { cursor: null, limit: 25 })
        .turns.map((record) => record.turnId),
    ).toEqual(["turn-3"]);
    expect(readFileSync(transcriptPath(dataDir, chatId))).toEqual(before);
  });

  it("deletes only the selected archived session after validating its transcript manifest", () => {
    const dataDir = makeDataDir();
    const chatId = "delete-one-archive";
    const chat = new ChatStore(dataDir);
    const transcript = new TranscriptStore(dataDir);
    const resetIds = [RESET_ID_A, RESET_ID_B, RESET_ID];
    const store = new ConversationStore(chat, transcript, () => resetIds.shift()!);
    const boundaries = [
      "2026-07-22T01:00:00.000Z",
      "2026-07-22T02:00:00.000Z",
      "2026-07-22T03:00:00.000Z",
    ];
    for (let index = 0; index < boundaries.length; index += 1) {
      store.appendTurn(chatId, `athlete-${index + 1}`, `coach-${index + 1}`, LINEAGE);
      store.appendCompletedTurn({
        chatId,
        turnId: `turn-${index + 1}`,
        completedAt: `2026-07-22T00:00:0${index}.000Z`,
        athleteText: `athlete-${index + 1}`,
        coachText: `coach-${index + 1}`,
      });
      store.resetConversation({
        chatId,
        boundaryAt: boundaries[index]!,
        reason: "explicit-reset",
      });
    }
    store.appendTurn(chatId, "athlete-current", "coach-current", LINEAGE);
    store.appendCompletedTurn({
      chatId,
      turnId: "turn-current",
      completedAt: "2026-07-22T04:00:00.000Z",
      athleteText: "athlete-current",
      coachText: "coach-current",
    });
    const manifest = store.inspectArchivedConversation(chatId, RESET_ID_B)!;

    expect(store.finalizeArchivedConversationDeletion(chatId, manifest)).toBe(true);
    expect(store.finalizeArchivedConversationDeletion(chatId, manifest)).toBe(false);
    expect(resetArchives(dataDir, chatId).sort()).toEqual(
      [
        `${sessionName(chatId)}.jsonl.reset.${boundaries[0]!.replace(/:/g, "-")}.${RESET_ID_A}`,
        `${sessionName(chatId)}.jsonl.reset.${boundaries[2]!.replace(/:/g, "-")}.${RESET_ID}`,
      ].sort(),
    );
    expect(existsSync(sessionPath(dataDir, chatId))).toBe(true);
    expect(
      store.listArchivedConversations(chatId).conversations.map(({ boundaryRef }) => boundaryRef),
    ).toEqual([RESET_ID, RESET_ID_A]);
    expect(store.readCurrentConversation(chatId).map(({ turnId }) => turnId)).toEqual([
      "turn-current",
    ]);
  });

  it("keeps the exact session archive when transcript inspection becomes stale", () => {
    const dataDir = makeDataDir();
    const chatId = "stale-delete-manifest";
    const chat = new ChatStore(dataDir);
    const transcript = new TranscriptStore(dataDir);
    const store = new ConversationStore(chat, transcript, () => RESET_ID_A);
    store.appendTurn(chatId, "athlete", "coach", LINEAGE);
    store.appendCompletedTurn({
      chatId,
      turnId: "turn-1",
      completedAt: "2026-07-22T00:00:00.000Z",
      athleteText: "athlete",
      coachText: "coach",
    });
    store.resetConversation({
      chatId,
      boundaryAt: "2026-07-22T01:00:00.000Z",
      reason: "explicit-reset",
    });
    const manifest = store.inspectArchivedConversation(chatId, RESET_ID_A)!;
    const path = transcriptPath(dataDir, chatId);
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace('"athleteText":"athlete"', '"athleteText":"changed"'),
      { mode: 0o600 },
    );

    expect(() => store.finalizeArchivedConversationDeletion(chatId, manifest)).toThrow(
      "Archived conversation changed before deletion completed.",
    );
    expect(
      existsSync(
        join(
          dataDir,
          "sessions",
          `${sessionName(chatId)}.jsonl.reset.2026-07-22T01-00-00.000Z.${RESET_ID_A}`,
        ),
      ),
    ).toBe(true);
  });

  it("fences a pagination cursor after the reset transaction completes", () => {
    const dataDir = makeDataDir();
    const chatId = "completed-reset-page";
    const chat = new ChatStore(dataDir);
    const transcript = new TranscriptStore(dataDir);
    const store = new ConversationStore(chat, transcript, () => RESET_ID);
    store.appendCompletedTurn({
      chatId,
      turnId: "turn-1",
      completedAt: "2026-07-22T00:00:00.000Z",
      athleteText: "a",
      coachText: "b",
    });
    store.appendCompletedTurn({
      chatId,
      turnId: "turn-2",
      completedAt: "2026-07-22T00:00:01.000Z",
      athleteText: "c",
      coachText: "d",
    });
    const page = store.readCurrentConversationPage(chatId, { cursor: null, limit: 1 });

    store.resetConversation({
      chatId,
      boundaryAt: "2026-07-22T01:02:03.000Z",
      reason: "explicit-reset",
    });

    expect(
      store.readCurrentConversationPage(chatId, {
        cursor: page.nextCursor,
        limit: 1,
      }),
    ).toEqual({
      schemaVersion: 1,
      status: "restart-required",
      turns: [],
      nextCursor: null,
    });
  });

  it("marks only a stale-reset archive as flush-pending, including one recovered from an intent", () => {
    const dataDir = makeDataDir();
    const chat = new ChatStore(dataDir);
    const transcript = new TranscriptStore(dataDir);
    const store = new ConversationStore(chat, transcript, () => RESET_ID);
    seedSession(chat, "explicit");
    store.resetConversation({
      chatId: "explicit",
      boundaryAt: "2026-07-22T00:00:00.000Z",
      reason: "explicit-reset",
    });
    seedSession(chat, "stale");
    store.resetConversation({
      chatId: "stale",
      boundaryAt: "2026-07-22T00:00:00.000Z",
      reason: "stale-reset",
    });
    const recoveredReset = { ...resetIntent("recovered"), reason: "stale-reset" as const };
    seedSession(chat, recoveredReset.chatId);
    transcript.createResetIntent(recoveredReset);
    const recovered = new ConversationStore(chat, transcript);

    expect(store.loadUnflushedResetArchive("explicit")).toBeNull();
    const stale = store.loadUnflushedResetArchive("stale");
    expect(stale?.messages.map((message) => message.content)).toEqual(["athlete", "coach"]);
    expect(recovered.loadUnflushedResetArchive("recovered")?.archiveRef).toBe(
      `${recoveredReset.boundaryAt.replace(/:/g, "-")}.${recoveredReset.resetId}`,
    );

    store.markResetArchiveFlushed("stale", stale!.archiveRef);
    expect(store.loadUnflushedResetArchive("stale")).toBeNull();
  });

  it("recovers intent-only by ensuring one boundary and archiving the active session", () => {
    const dataDir = makeDataDir();
    const chat = new ChatStore(dataDir);
    const transcript = new TranscriptStore(dataDir);
    const reset = resetIntent("intent-only");
    seedSession(chat, reset.chatId);
    transcript.createResetIntent(reset);

    const recovered = new ConversationStore(chat, transcript);

    expect(recovered.hasSession(reset.chatId)).toBe(false);
    expect(transcript.readResetIntent(reset.chatId)).toBeNull();
    expect(boundaryCount(dataDir, reset.chatId)).toBe(1);
    expect(resetArchives(dataDir, reset.chatId)).toHaveLength(1);
  });

  it("recovers intent plus a torn boundary without changing torn bytes", () => {
    const dataDir = makeDataDir();
    const chat = new ChatStore(dataDir);
    const transcript = new TranscriptStore(dataDir);
    const reset = resetIntent("torn-boundary");
    seedSession(chat, reset.chatId);
    transcript.createResetIntent(reset);
    transcript.appendCompletedTurn({
      chatId: reset.chatId,
      turnId: "old-turn",
      completedAt: "2026-07-22T00:00:00.000Z",
      athleteText: "old athlete",
      coachText: "old coach",
    });
    appendFileSync(transcriptPath(dataDir, reset.chatId), '{"version":1,"kind":"conversation');
    const torn = readFileSync(transcriptPath(dataDir, reset.chatId));

    const recovered = new ConversationStore(chat, transcript);

    expect(recovered.hasSession(reset.chatId)).toBe(false);
    expect(readFileSync(transcriptPath(dataDir, reset.chatId)).subarray(0, torn.length)).toEqual(
      torn,
    );
    expect(boundaryCount(dataDir, reset.chatId)).toBe(1);
  });

  it("recovers a durable boundary with an active session without duplicating the boundary", () => {
    const dataDir = makeDataDir();
    const chat = new ChatStore(dataDir);
    const transcript = new TranscriptStore(dataDir);
    const reset = resetIntent("boundary-active");
    seedSession(chat, reset.chatId);
    transcript.createResetIntent(reset);
    transcript.ensureConversationBoundary(reset);

    new ConversationStore(chat, transcript);

    expect(chat.hasSession(reset.chatId)).toBe(false);
    expect(boundaryCount(dataDir, reset.chatId)).toBe(1);
    expect(resetArchives(dataDir, reset.chatId)).toHaveLength(1);
  });

  it("removes a surviving intent after an already-completed archive without a second archive", () => {
    const dataDir = makeDataDir();
    const chat = new ChatStore(dataDir);
    const transcript = new TranscriptStore(dataDir);
    const reset = resetIntent("archived-intent");
    seedSession(chat, reset.chatId);
    transcript.createResetIntent(reset);
    transcript.ensureConversationBoundary(reset);
    archiveAndResetDurably(chat, reset.chatId, reset);
    expect(resetArchives(dataDir, reset.chatId)).toHaveLength(1);

    new ConversationStore(chat, transcript);

    expect(transcript.readResetIntent(reset.chatId)).toBeNull();
    expect(resetArchives(dataDir, reset.chatId)).toHaveLength(1);
    expect(boundaryCount(dataDir, reset.chatId)).toBe(1);
  });

  it("recovers the archive hardlink window without creating another archive", () => {
    const dataDir = makeDataDir();
    const chat = new ChatStore(dataDir);
    const transcript = new TranscriptStore(dataDir);
    const reset = resetIntent("archive-link-window");
    seedSession(chat, reset.chatId);
    transcript.createResetIntent(reset);
    transcript.ensureConversationBoundary(reset);
    const active = sessionPath(dataDir, reset.chatId);
    const archive = resetArchivePath(dataDir, reset);
    linkSync(active, archive);
    expect(lstatSync(active).nlink).toBe(2);

    new ConversationStore(chat, transcript);

    expect(existsSync(active)).toBe(false);
    expect(lstatSync(archive).nlink).toBe(1);
    expect(resetArchives(dataDir, reset.chatId)).toHaveLength(1);
    expect(transcript.readResetIntent(reset.chatId)).toBeNull();
    expect(boundaryCount(dataDir, reset.chatId)).toBe(1);
  });

  it("replays the same completed intent idempotently after recovery", () => {
    const dataDir = makeDataDir();
    const chatId = "replay";
    const chat = new ChatStore(dataDir);
    const transcript = new TranscriptStore(dataDir);
    const first = new ConversationStore(chat, transcript, () => RESET_ID);
    seedSession(chat, chatId);
    first.resetConversation({
      chatId,
      boundaryAt: "2026-07-22T01:02:03.000Z",
      reason: "explicit-reset",
    });
    const completed = resetIntent(chatId);
    transcript.createResetIntent(completed);

    new ConversationStore(chat, transcript);
    new ConversationStore(chat, transcript);

    expect(boundaryCount(dataDir, chatId)).toBe(1);
    expect(resetArchives(dataDir, chatId)).toHaveLength(1);
    expect(transcript.readResetIntent(chatId)).toBeNull();
  });

  it("reconciles the hardlink publication window before construction recovery", () => {
    const dataDir = makeDataDir();
    const chat = new ChatStore(dataDir);
    const transcript = new TranscriptStore(dataDir);
    const reset = resetIntent("linked-intent-window");
    seedSession(chat, reset.chatId);
    transcript.createResetIntent(reset);
    const target = intentPath(dataDir, reset.chatId);
    const temp = intentTempPath(dataDir, reset.chatId, reset.resetId);
    linkSync(target, temp);
    expect(lstatSync(target).nlink).toBe(2);

    new ConversationStore(chat, transcript);

    expect(existsSync(temp)).toBe(false);
    expect(existsSync(target)).toBe(false);
    expect(boundaryCount(dataDir, reset.chatId)).toBe(1);
    expect(resetArchives(dataDir, reset.chatId)).toHaveLength(1);
  });

  it("removes a partial orphan temp from a crash before intent publication", () => {
    const dataDir = makeDataDir();
    const chat = new ChatStore(dataDir);
    const transcript = new TranscriptStore(dataDir);
    const reset = resetIntent("orphan-temp");
    seedSession(chat, reset.chatId);
    const temp = intentTempPath(dataDir, reset.chatId, reset.resetId);
    writeFileSync(temp, '{"version":1', { mode: 0o600 });

    const recovered = new ConversationStore(chat, transcript);

    expect(existsSync(temp)).toBe(false);
    expect(recovered.hasSession(reset.chatId)).toBe(true);
    expect(boundaryCount(dataDir, reset.chatId)).toBe(0);
    expect(resetArchives(dataDir, reset.chatId)).toHaveLength(0);
  });

  it("cleans a proven zero-byte boundary failure and leaves the active session usable", () => {
    const dataDir = makeDataDir();
    const chat = new ChatStore(dataDir);
    const chatId = "safe-cleanup";
    seedSession(chat, chatId);
    new TranscriptStore(dataDir).appendCompletedTurn({
      chatId,
      turnId: "old-turn",
      completedAt: "2026-07-22T00:00:00.000Z",
      athleteText: "synthetic athlete",
      coachText: "synthetic coach",
    });
    let writes = 0;
    const transcript = new TranscriptStore(dataDir, {
      write: (descriptor, buffer, offset, length, position) => {
        writes += 1;
        if (writes === 2) return 0;
        return writeSync(descriptor, buffer, offset, length, position);
      },
    });
    const store = new ConversationStore(chat, transcript, () => RESET_ID);

    expect(() =>
      store.resetConversation({
        chatId,
        boundaryAt: "2026-07-22T01:02:03.000Z",
        reason: "explicit-reset",
      }),
    ).toThrow(platformError("Transcript append was incomplete."));
    expect(chat.hasSession(chatId)).toBe(true);
    expect(transcript.readResetIntent(chatId)).toBeNull();
    expect(boundaryCount(dataDir, chatId)).toBe(0);
    expect(resetArchives(dataDir, chatId)).toHaveLength(0);
    expect(store.load(chatId).messages).toHaveLength(2);
  });

  it("retains a one-shot short boundary write and recovers through one valid boundary", () => {
    const dataDir = makeDataDir();
    const chatId = "short-boundary-recovery";
    const chat = new ChatStore(dataDir);
    seedSession(chat, chatId);
    new TranscriptStore(dataDir).appendCompletedTurn({
      chatId,
      turnId: "old-turn",
      completedAt: "2026-07-22T00:00:00.000Z",
      athleteText: "synthetic athlete",
      coachText: "synthetic coach",
    });
    let writes = 0;
    const transcript = new TranscriptStore(dataDir, {
      write: (descriptor, buffer, offset, length, position) => {
        writes += 1;
        const bytes = writes === 2 ? Math.floor(length / 2) : length;
        return writeSync(descriptor, buffer, offset, bytes, position);
      },
    });
    const removeIntent = vi.spyOn(transcript, "removeResetIntent");
    const store = new ConversationStore(chat, transcript, () => RESET_ID);

    expect(() =>
      store.resetConversation({
        chatId,
        boundaryAt: "2026-07-22T01:02:03.000Z",
        reason: "explicit-reset",
      }),
    ).toThrow(platformError("Transcript append was incomplete."));
    expect(chat.hasSession(chatId)).toBe(true);
    expect(transcript.readResetIntent(chatId)).not.toBeNull();
    expect(boundaryCount(dataDir, chatId)).toBe(0);
    expect(new TranscriptStore(dataDir).readCurrentConversation(chatId)).toEqual([]);
    expect(removeIntent).not.toHaveBeenCalled();

    expect(store.load(chatId).messages).toEqual([]);

    expect(chat.hasSession(chatId)).toBe(false);
    expect(transcript.readResetIntent(chatId)).toBeNull();
    expect(boundaryCount(dataDir, chatId)).toBe(1);
    expect(transcript.readCurrentConversation(chatId)).toEqual([]);
    expect(resetArchives(dataDir, chatId)).toHaveLength(1);
    expect(removeIntent).toHaveBeenCalledTimes(1);
  });

  it("keeps a repeatedly short boundary failure blocked without trusting an old turn", () => {
    const dataDir = makeDataDir();
    const chatId = "repeated-short-boundary";
    const chat = new ChatStore(dataDir);
    seedSession(chat, chatId);
    new TranscriptStore(dataDir).appendCompletedTurn({
      chatId,
      turnId: "old-turn",
      completedAt: "2026-07-22T00:00:00.000Z",
      athleteText: "synthetic athlete",
      coachText: "synthetic coach",
    });
    let writes = 0;
    const transcript = new TranscriptStore(dataDir, {
      write: (descriptor, buffer, offset, length, position) => {
        writes += 1;
        const bytes = writes === 1 ? length : Math.floor(length / 2);
        return writeSync(descriptor, buffer, offset, bytes, position);
      },
    });
    const removeIntent = vi.spyOn(transcript, "removeResetIntent");
    const store = new ConversationStore(chat, transcript, () => RESET_ID);

    expect(() =>
      store.resetConversation({
        chatId,
        boundaryAt: "2026-07-22T01:02:03.000Z",
        reason: "explicit-reset",
      }),
    ).toThrow(platformError("Transcript append was incomplete."));
    expect(() => store.load(chatId)).toThrow(ConversationRecoveryError);

    expect(chat.hasSession(chatId)).toBe(true);
    expect(transcript.readResetIntent(chatId)).not.toBeNull();
    expect(boundaryCount(dataDir, chatId)).toBe(0);
    expect(new TranscriptStore(dataDir).readCurrentConversation(chatId)).toEqual([]);
    expect(removeIntent).not.toHaveBeenCalled();
  });

  it("retains a valid boundary intent after archive failure and finishes before later access", () => {
    const dataDir = makeDataDir();
    let fileSyncs = 0;
    const chat = createChatStoreWithHooks(dataDir, 0, {
      syncFile: (descriptor) => {
        fileSyncs += 1;
        if (fileSyncs === 1) throw new Error("synthetic archive failure");
        fsyncSync(descriptor);
      },
    });
    const transcript = new TranscriptStore(dataDir);
    const store = new ConversationStore(chat, transcript, () => RESET_ID);
    const chatId = "archive-failure";
    seedSession(chat, chatId);

    expect(() =>
      store.resetConversation({
        chatId,
        boundaryAt: "2026-07-22T01:02:03.000Z",
        reason: "explicit-reset",
      }),
    ).toThrow(platformError("synthetic archive failure"));
    expect(chat.hasSession(chatId)).toBe(true);
    expect(transcript.readResetIntent(chatId)).not.toBeNull();
    expect(boundaryCount(dataDir, chatId)).toBe(1);

    expect(store.load(chatId).messages).toEqual([]);
    expect(chat.hasSession(chatId)).toBe(false);
    expect(transcript.readResetIntent(chatId)).toBeNull();
    expect(boundaryCount(dataDir, chatId)).toBe(1);
    expect(resetArchives(dataDir, chatId)).toHaveLength(1);
    expect(fileSyncs).toBe(2);
  });

  it("never cleans an intent when a valid but duplicate reset boundary is present", () => {
    const dataDir = makeDataDir();
    const chatId = "duplicate-boundary";
    const chat = new ChatStore(dataDir);
    const transcript = new TranscriptStore(dataDir);
    const reset = resetIntent(chatId);
    transcript.ensureConversationBoundary(reset);
    appendFileSync(transcriptPath(dataDir, chatId), readFileSync(transcriptPath(dataDir, chatId)));
    seedSession(chat, chatId);
    const store = new ConversationStore(chat, transcript, () => RESET_ID);

    expect(() =>
      store.resetConversation({
        chatId,
        boundaryAt: reset.boundaryAt,
        reason: reset.reason,
      }),
    ).toThrow(platformError("Transcript contains duplicate reset boundaries."));
    expect(transcript.readResetIntent(chatId)).toEqual(reset);
    expect(chat.hasSession(chatId)).toBe(true);
    expect(() => store.load(chatId)).toThrow(ConversationRecoveryError);
    expect(boundaryCount(dataDir, chatId)).toBe(2);
  });

  it("treats a full append followed by fsync failure as a retained valid boundary", () => {
    const dataDir = makeDataDir();
    let fileSyncs = 0;
    const transcript = new TranscriptStore(dataDir, {
      syncFile: (descriptor) => {
        fileSyncs += 1;
        if (fileSyncs === 2) throw new Error("synthetic boundary fsync failure");
        fsyncSync(descriptor);
      },
    });
    const chat = new ChatStore(dataDir);
    const store = new ConversationStore(chat, transcript, () => RESET_ID);
    const chatId = "boundary-sync-failure";
    seedSession(chat, chatId);

    expect(() =>
      store.resetConversation({
        chatId,
        boundaryAt: "2026-07-22T01:02:03.000Z",
        reason: "explicit-reset",
      }),
    ).toThrow(platformError("synthetic boundary fsync failure"));
    expect(chat.hasSession(chatId)).toBe(true);
    expect(transcript.readResetIntent(chatId)).not.toBeNull();
    expect(boundaryCount(dataDir, chatId)).toBe(1);

    expect(store.readCurrentConversation(chatId)).toEqual([]);
    expect(chat.hasSession(chatId)).toBe(false);
    expect(transcript.readResetIntent(chatId)).toBeNull();
    expect(fileSyncs).toBe(3);
  });

  it.skipIf(process.platform === "win32")(
    "retries boundary directory fsync before removing a retained intent",
    () => {
      const dataDir = makeDataDir();
      new TranscriptStore(dataDir);
      let directorySyncs = 0;
      const transcript = new TranscriptStore(dataDir, {
        syncDirectory: (descriptor) => {
          directorySyncs += 1;
          if (directorySyncs === 3) {
            throw new Error("synthetic boundary directory sync failure");
          }
          fsyncSync(descriptor);
        },
      });
      const originalRemove = transcript.removeResetIntent.bind(transcript);
      let directorySyncsAtRemoval = 0;
      vi.spyOn(transcript, "removeResetIntent").mockImplementation((reset) => {
        directorySyncsAtRemoval = directorySyncs;
        originalRemove(reset);
      });
      const chat = new ChatStore(dataDir);
      const store = new ConversationStore(chat, transcript, () => RESET_ID);
      const chatId = "boundary-directory-sync-failure";
      seedSession(chat, chatId);

      expect(() =>
        store.resetConversation({
          chatId,
          boundaryAt: "2026-07-22T01:02:03.000Z",
          reason: "explicit-reset",
        }),
      ).toThrow("synthetic boundary directory sync failure");
      expect(boundaryCount(dataDir, chatId)).toBe(1);
      expect(transcript.readResetIntent(chatId)).not.toBeNull();
      expect(directorySyncs).toBe(3);

      expect(store.load(chatId).messages).toEqual([]);

      expect(directorySyncsAtRemoval).toBe(4);
      expect(directorySyncs).toBe(5);
      expect(transcript.readResetIntent(chatId)).toBeNull();
      expect(chat.hasSession(chatId)).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "retries the sessions directory fsync after unlink before removing the intent",
    () => {
      const dataDir = makeDataDir();
      let directorySyncs = 0;
      const chat = createChatStoreWithHooks(dataDir, 0, {
        syncDirectory: (descriptor) => {
          directorySyncs += 1;
          if (directorySyncs === 2) {
            throw new Error("synthetic post-unlink directory sync failure");
          }
          fsyncSync(descriptor);
        },
      });
      const transcript = new TranscriptStore(dataDir);
      const originalRemove = transcript.removeResetIntent.bind(transcript);
      let sessionsSyncsAtRemoval = 0;
      vi.spyOn(transcript, "removeResetIntent").mockImplementation((reset) => {
        sessionsSyncsAtRemoval = directorySyncs;
        originalRemove(reset);
      });
      const store = new ConversationStore(chat, transcript, () => RESET_ID);
      const chatId = "session-directory-retry";
      seedSession(chat, chatId);

      expect(() =>
        store.resetConversation({
          chatId,
          boundaryAt: "2026-07-22T01:02:03.000Z",
          reason: "explicit-reset",
        }),
      ).toThrow("synthetic post-unlink directory sync failure");
      expect(chat.hasSession(chatId)).toBe(false);
      expect(resetArchives(dataDir, chatId)).toHaveLength(1);
      expect(transcript.readResetIntent(chatId)).not.toBeNull();
      expect(directorySyncs).toBe(2);

      expect(store.load(chatId).messages).toEqual([]);

      expect(sessionsSyncsAtRemoval).toBe(3);
      expect(directorySyncs).toBe(3);
      expect(transcript.readResetIntent(chatId)).toBeNull();
      expect(resetArchives(dataDir, chatId)).toHaveLength(1);
    },
  );

  it("keeps completed-turn transcript bytes stable across ChatStore compaction mutations", () => {
    const dataDir = makeDataDir();
    const chatId = "compaction-boundary";
    const chat = new ChatStore(dataDir);
    const transcript = new TranscriptStore(dataDir);
    const store = new ConversationStore(chat, transcript);
    store.appendCompletedTurn({
      chatId,
      turnId: "turn-1",
      completedAt: "2026-07-22T00:00:01.000Z",
      athleteText: "synthetic athlete one",
      coachText: "synthetic coach one",
    });
    store.appendCompletedTurn({
      chatId,
      turnId: "turn-2",
      completedAt: "2026-07-22T00:00:02.000Z",
      athleteText: "synthetic athlete two",
      coachText: "synthetic coach two",
    });
    store.appendTurn(chatId, "synthetic user", "synthetic assistant", LINEAGE);
    const before = readFileSync(transcriptPath(dataDir, chatId));

    store.archivePreCompact(chatId);
    store.overwriteHistory(chatId, [{ role: "assistant", content: "synthetic compacted" }]);

    expect(readFileSync(transcriptPath(dataDir, chatId))).toEqual(before);
    expect(store.readCurrentConversation(chatId).map((record) => record.turnId)).toEqual([
      "turn-1",
      "turn-2",
    ]);
  });

  it("blocks load, completed-turn append, and transcript read while recovery cannot finish", () => {
    const dataDir = makeDataDir();
    const chat = new ChatStore(dataDir);
    const transcript = new TranscriptStore(dataDir);
    const reset = resetIntent("blocked");
    seedSession(chat, reset.chatId);
    transcript.createResetIntent(reset);
    vi.spyOn(transcript, "ensureConversationBoundary").mockImplementation(() => {
      throw new Error("synthetic persistent recovery failure");
    });
    const store = new ConversationStore(chat, transcript);

    expect(() => store.load(reset.chatId)).toThrow(ConversationRecoveryError);
    expect(() =>
      store.appendCompletedTurn({
        chatId: reset.chatId,
        turnId: "blocked-turn",
        completedAt: "2026-07-22T02:00:00.000Z",
        athleteText: "athlete",
        coachText: "coach",
      }),
    ).toThrow(ConversationRecoveryError);
    expect(() => store.readCurrentConversation(reset.chatId)).toThrow(ConversationRecoveryError);
    expect(chat.hasSession(reset.chatId)).toBe(true);
    expect(boundaryCount(dataDir, reset.chatId)).toBe(0);
  });
});

describe("ConversationStore Windows restart recovery", () => {
  it("removes an unparseable orphan reset temp on simulated Windows", () => {
    const dataDir = makeDataDir();
    const chat = new ChatStore(dataDir, 0, { platform: "win32" });
    const transcript = new TranscriptStore(dataDir, { platform: "win32" });
    const reset = resetIntent("telegram:synthetic-orphan-temp");
    seedSession(chat, reset.chatId);
    const temp = intentTempPath(dataDir, reset.chatId, reset.resetId);
    writeFileSync(temp, '{"version":1', { mode: 0o600 });

    const recovered = new ConversationStore(chat, transcript);

    expect(existsSync(temp)).toBe(false);
    expect(recovered.hasSession(reset.chatId)).toBe(true);
    expect(windowsResetArchives(dataDir, reset.chatId)).toHaveLength(0);
  });

  it("rejects a hardlinked orphan reset temp on simulated Windows", () => {
    const dataDir = makeDataDir();
    const chat = new ChatStore(dataDir, 0, { platform: "win32" });
    const transcript = new TranscriptStore(dataDir, { platform: "win32" });
    const reset = resetIntent("telegram:synthetic-linked-orphan");
    const temp = intentTempPath(dataDir, reset.chatId, reset.resetId);
    const alias = join(dataDir, "synthetic-reset-temp-alias");
    writeFileSync(temp, '{"version":1', { mode: 0o600 });
    linkSync(temp, alias);

    expect(() => new ConversationStore(chat, transcript)).toThrow(WindowsPrivatePathPolicyError);
    expect(existsSync(temp)).toBe(true);
    expect(existsSync(alias)).toBe(true);
  });

  it("recovers only an exact pending boundary prefix on simulated Windows", () => {
    const dataDir = makeDataDir();
    const chat = new ChatStore(dataDir, 0, { platform: "win32" });
    const transcript = new TranscriptStore(dataDir, { platform: "win32" });
    const reset = resetIntent("telegram:synthetic-torn-boundary");
    seedSession(chat, reset.chatId);
    transcript.createResetIntent(reset);
    transcript.appendCompletedTurn({
      chatId: reset.chatId,
      turnId: "old-turn",
      completedAt: "2026-07-22T00:00:00.000Z",
      athleteText: "old athlete",
      coachText: "old coach",
    });
    const canonical = boundaryLine(reset);
    appendFileSync(
      transcriptPath(dataDir, reset.chatId),
      canonical.subarray(0, Math.floor(canonical.length / 2)),
    );

    const recovered = new ConversationStore(chat, transcript);

    expect(recovered.hasSession(reset.chatId)).toBe(false);
    expect(transcript.readResetIntent(reset.chatId)).toBeNull();
    expect(boundaryCount(dataDir, reset.chatId)).toBe(1);
    expect(transcript.readCurrentConversation(reset.chatId)).toEqual([]);
    expect(windowsResetArchives(dataDir, reset.chatId)).toHaveLength(1);
  });

  it.each([
    [
      "an unfenced canonical prefix",
      (reset: ResetIntentRecord) => boundaryLine(reset).subarray(0, 7),
    ],
    ["an arbitrary malformed tail", () => Buffer.from('{"untrusted":', "utf8")],
  ])("rejects %s on an ordinary simulated-Windows read", (_name, tail) => {
    const dataDir = makeDataDir();
    const transcript = new TranscriptStore(dataDir, { platform: "win32" });
    const reset = resetIntent("telegram:synthetic-unfenced-tail");
    writeFileSync(transcriptPath(dataDir, reset.chatId), tail(reset), { mode: 0o600 });

    expect(() => transcript.readCurrentConversation(reset.chatId)).toThrow(
      WindowsPrivatePathPolicyError,
    );
  });

  it.each(["resetId", "chatId"] as const)(
    "rejects a torn boundary with the wrong %s on simulated Windows",
    (field) => {
      const dataDir = makeDataDir();
      const transcript = new TranscriptStore(dataDir, { platform: "win32" });
      const pending = resetIntent("telegram:synthetic-wrong-boundary", "a".repeat(64));
      const wrong = {
        ...pending,
        [field]: field === "resetId" ? "b".repeat(64) : "telegram:synthetic-other-chat",
      };
      transcript.createResetIntent(pending);
      const canonical = boundaryLine(wrong);
      writeFileSync(
        transcriptPath(dataDir, pending.chatId),
        canonical.subarray(0, canonical.length - 1),
        { mode: 0o600 },
      );

      expect(() => transcript.ensureConversationBoundary(pending)).toThrow(
        WindowsPrivatePathPolicyError,
      );
      expect(transcript.readResetIntent(pending.chatId)).toEqual(pending);
      expect(boundaryCount(dataDir, pending.chatId)).toBe(0);
    },
  );

  it("rejects recovery when the persisted intent does not match on simulated Windows", () => {
    const dataDir = makeDataDir();
    const transcript = new TranscriptStore(dataDir, { platform: "win32" });
    const persisted = resetIntent("telegram:synthetic-intent-mismatch", "a".repeat(64));
    const requested = resetIntent(persisted.chatId, "b".repeat(64));
    transcript.createResetIntent(persisted);
    const canonical = boundaryLine(requested);
    writeFileSync(
      transcriptPath(dataDir, requested.chatId),
      canonical.subarray(0, Math.floor(canonical.length / 2)),
      { mode: 0o600 },
    );

    expect(() => transcript.ensureConversationBoundary(requested)).toThrow(
      WindowsPrivatePathPolicyError,
    );
    expect(transcript.readResetIntent(persisted.chatId)).toEqual(persisted);
  });

  it("finishes a complete unterminated pending boundary on simulated Windows", () => {
    const dataDir = makeDataDir();
    const transcript = new TranscriptStore(dataDir, { platform: "win32" });
    const reset = resetIntent("telegram:synthetic-unclosed-boundary");
    transcript.createResetIntent(reset);
    writeFileSync(transcriptPath(dataDir, reset.chatId), boundaryLine(reset), { mode: 0o600 });

    transcript.ensureConversationBoundary(reset);

    expect(readFileSync(transcriptPath(dataDir, reset.chatId))).toEqual(
      Buffer.concat([boundaryLine(reset), Buffer.from("\n", "utf8")]),
    );
    expect(boundaryCount(dataDir, reset.chatId)).toBe(1);
  });

  it("continues one canonical prefix after a short recovery append on simulated Windows", () => {
    const dataDir = makeDataDir();
    const reset = resetIntent("telegram:synthetic-recovery-short-write");
    const original = new TranscriptStore(dataDir, { platform: "win32" });
    original.createResetIntent(reset);
    const canonical = boundaryLine(reset);
    writeFileSync(
      transcriptPath(dataDir, reset.chatId),
      canonical.subarray(0, Math.floor(canonical.length / 3)),
      { mode: 0o600 },
    );
    const interrupted = new TranscriptStore(dataDir, {
      platform: "win32",
      write: (descriptor, buffer, offset, length, position) =>
        writeSync(descriptor, buffer, offset, Math.floor(length / 2), position),
    });

    expect(() => interrupted.ensureConversationBoundary(reset)).toThrow(
      WindowsPrivatePathPolicyError,
    );
    const afterInterrupted = readFileSync(transcriptPath(dataDir, reset.chatId));
    expect(afterInterrupted.length).toBeGreaterThan(Math.floor(canonical.length / 3));
    expect(canonical.subarray(0, afterInterrupted.length).equals(afterInterrupted)).toBe(true);

    const recovered = new TranscriptStore(dataDir, { platform: "win32" });
    recovered.ensureConversationBoundary(reset);
    expect(boundaryCount(dataDir, reset.chatId)).toBe(1);
    expect(readFileSync(transcriptPath(dataDir, reset.chatId))).toEqual(
      Buffer.concat([canonical, Buffer.from("\n", "utf8")]),
    );
  });

  it("rejects a malformed prefix unless the next boundary is exact on simulated Windows", () => {
    const dataDir = makeDataDir();
    const transcript = new TranscriptStore(dataDir, { platform: "win32" });
    const first = resetIntent("telegram:synthetic-prefix-pair", "a".repeat(64));
    const second = resetIntent(first.chatId, "b".repeat(64));
    const firstLine = boundaryLine(first);
    writeFileSync(
      transcriptPath(dataDir, first.chatId),
      Buffer.concat([
        firstLine.subarray(0, Math.floor(firstLine.length / 2)),
        Buffer.from("\n", "utf8"),
        boundaryLine(second),
        Buffer.from("\n", "utf8"),
      ]),
      { mode: 0o600 },
    );

    expect(() => transcript.readCurrentConversation(first.chatId)).toThrow(
      WindowsPrivatePathPolicyError,
    );
  });

  it("rejects duplicate boundaries on simulated Windows", () => {
    const dataDir = makeDataDir();
    const transcript = new TranscriptStore(dataDir, { platform: "win32" });
    const reset = resetIntent("telegram:synthetic-duplicate-boundary");
    const line = boundaryLine(reset);
    writeFileSync(
      transcriptPath(dataDir, reset.chatId),
      Buffer.concat([line, Buffer.from("\n", "utf8"), line, Buffer.from("\n", "utf8")]),
      { mode: 0o600 },
    );

    expect(() => transcript.readCurrentConversation(reset.chatId)).toThrow(
      WindowsPrivatePathPolicyError,
    );
  });

  it("reopens completed archives without changing the recovered conversation", () => {
    const dataDir = makeDataDir();
    const chatId = "telegram:synthetic-windows-restart";
    const first = new ConversationStore(
      new ChatStore(dataDir, 0, { platform: "win32" }),
      new TranscriptStore(dataDir, { platform: "win32" }),
      () => RESET_ID,
    );
    first.appendTurn(chatId, "synthetic athlete", "synthetic coach", LINEAGE);
    first.appendCompletedTurn({
      chatId,
      turnId: "turn-1",
      completedAt: "2026-07-22T00:00:00.000Z",
      athleteText: "synthetic athlete",
      coachText: "synthetic coach",
    });
    first.resetConversation({
      chatId,
      boundaryAt: "2026-07-22T01:02:03.000Z",
      reason: "explicit-reset",
    });

    const reopened = new ConversationStore(
      new ChatStore(dataDir, 0, { platform: "win32" }),
      new TranscriptStore(dataDir, { platform: "win32" }),
    );

    expect(reopened.hasSession(chatId)).toBe(false);
    expect(reopened.listArchivedConversations(chatId)).toEqual({
      schemaVersion: 1,
      conversations: [
        {
          boundaryRef: RESET_ID,
          boundaryAt: "2026-07-22T01:02:03.000Z",
          reason: "explicit-reset",
          turnCount: 1,
        },
      ],
      truncated: false,
    });
    expect(
      reopened
        .readArchivedConversationPage(chatId, RESET_ID, { cursor: null, limit: 25 })
        .turns.map((record) => record.turnId),
    ).toEqual(["turn-1"]);
  });

  it("keeps corrupt recovery scoped to its chat and completes an unrelated intent", () => {
    const dataDir = makeDataDir();
    const chat = new ChatStore(dataDir, 0, { platform: "win32" });
    const transcript = new TranscriptStore(dataDir, { platform: "win32" });
    const corrupt = resetIntent("telegram:synthetic-windows-corrupt", "a".repeat(64));
    const unrelated = resetIntent("telegram:synthetic-windows-unrelated", "b".repeat(64));
    seedSession(chat, corrupt.chatId);
    seedSession(chat, unrelated.chatId);
    transcript.createResetIntent(corrupt);
    transcript.createResetIntent(unrelated);
    const corruptActive = windowsSessionPath(dataDir, corrupt.chatId);
    linkSync(corruptActive, join(dataDir, "synthetic-shared-session.jsonl"));

    const recovered = new ConversationStore(chat, transcript);

    let failure: unknown;
    try {
      recovered.load(corrupt.chatId);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ConversationRecoveryError);
    expect((failure as Error & { cause?: unknown }).cause).toBeInstanceOf(
      WindowsPrivatePathPolicyError,
    );
    expect((failure as Error & { cause?: unknown }).cause).toMatchObject({
      stage: "binding-check",
      category: "corruption",
    });
    expect(String(failure)).not.toContain(corruptActive);
    expect(JSON.stringify(failure)).not.toContain(corruptActive);
    expect(existsSync(corruptActive)).toBe(true);
    expect(existsSync(intentPath(dataDir, corrupt.chatId))).toBe(true);
    expect(windowsResetArchives(dataDir, corrupt.chatId)).toHaveLength(0);
    expect(recovered.hasSession(unrelated.chatId)).toBe(false);
    expect(existsSync(intentPath(dataDir, unrelated.chatId))).toBe(false);
    expect(windowsResetArchives(dataDir, unrelated.chatId)).toHaveLength(1);
  });
});
