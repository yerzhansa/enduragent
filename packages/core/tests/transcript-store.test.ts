import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  readSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_ARCHIVED_CONVERSATION_ENTRIES,
  MAX_TRANSCRIPT_FILE_BYTES,
  MAX_TRANSCRIPT_PAGE_RESPONSE_BYTES,
  MAX_TRANSCRIPT_PAGE_TURNS,
  MAX_TRANSCRIPT_RECORD_BYTES,
  TranscriptRecordTooLargeError,
  TranscriptStore,
  UnsafeTranscriptTargetError,
  type ResetIntentRecord,
} from "../src/agent/transcript-store.js";
import { WindowsPrivatePathPolicyError } from "../src/io/windows-private-path-policy.js";

const roots: string[] = [];
const RESET_ID_A = "a".repeat(64);
const RESET_ID_B = "b".repeat(64);
const RESET_ID_C = "c".repeat(64);

function makeDataDir(): string {
  const path = mkdtempSync(join(tmpdir(), "transcript-store-"));
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

function turn(chatId: string, turnId: string, athleteText = "athlete", coachText = "coach") {
  return {
    chatId,
    turnId,
    completedAt: `2026-07-22T00:00:0${turnId.at(-1) ?? "0"}.000Z`,
    athleteText,
    coachText,
  };
}

function serializedTurn(input: ReturnType<typeof turn>): Buffer {
  return Buffer.from(
    `${JSON.stringify({ version: 1, kind: "turn-completed", ...input })}\n`,
    "utf8",
  );
}

function turnWithSerializedBytes(
  targetBytes: number,
  chatId = "record-size",
): ReturnType<typeof turn> {
  const input = turn(chatId, "turn-1", '🚴\n"\\', "synthetic coach");
  const paddingBytes = targetBytes - serializedTurn(input).length;
  if (paddingBytes < 0) throw new RangeError("Target record size is too small.");
  return { ...input, athleteText: `${input.athleteText}${"x".repeat(paddingBytes)}` };
}

function intent(
  chatId: string,
  resetId = RESET_ID_A,
  reason: ResetIntentRecord["reason"] = "explicit-reset",
): ResetIntentRecord {
  return {
    version: 1,
    kind: "conversation-reset-intent",
    resetId,
    chatId,
    boundaryAt: "2026-07-22T01:00:00.000Z",
    reason,
  };
}

function corruptionCases(chatId: string): readonly (readonly [string, Buffer])[] {
  return [
    ["invalid JSON", Buffer.from("not-json\n")],
    ["invalid UTF-8", Buffer.from([0xff, 0x0a])],
    ["empty unexpected line", Buffer.from("\n")],
    ["unknown version", Buffer.from('{"version":2,"kind":"turn-completed"}\n')],
    ["unknown kind", Buffer.from('{"version":1,"kind":"future-record"}\n')],
    [
      "non-strict schema",
      Buffer.from(
        `${JSON.stringify({ version: 1, kind: "turn-completed", ...turn(chatId, "turn-x"), extra: true })}\n`,
      ),
    ],
    [
      "wrong-chat record",
      Buffer.from(
        `${JSON.stringify({ version: 1, kind: "turn-completed", ...turn("other", "turn-x") })}\n`,
      ),
    ],
    [
      "boundary without resetId",
      Buffer.from(
        `${JSON.stringify({
          version: 1,
          kind: "conversation-boundary",
          chatId,
          boundaryAt: "2026-07-22T01:00:00.000Z",
          reason: "explicit-reset",
        })}\n`,
      ),
    ],
    ["unterminated EOF", Buffer.from('{"version":1,"kind":"turn-completed"')],
  ];
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("TranscriptStore archived conversation reads", () => {
  it("lists boundaries newest first with the turn count of each archived conversation", () => {
    const dataDir = makeDataDir();
    const chatId = "archive-list";
    const store = new TranscriptStore(dataDir);
    store.appendCompletedTurn(turn(chatId, "turn-1"));
    store.appendCompletedTurn(turn(chatId, "turn-2"));
    store.ensureConversationBoundary(intent(chatId, RESET_ID_A));
    store.appendCompletedTurn(turn(chatId, "turn-3"));
    store.ensureConversationBoundary(intent(chatId, RESET_ID_B, "stale-reset"));
    store.appendCompletedTurn(turn(chatId, "turn-4"));

    expect(store.listArchivedConversations(chatId)).toEqual({
      schemaVersion: 1,
      conversations: [
        {
          boundaryRef: RESET_ID_B,
          boundaryAt: "2026-07-22T01:00:00.000Z",
          reason: "stale-reset",
          turnCount: 1,
        },
        {
          boundaryRef: RESET_ID_A,
          boundaryAt: "2026-07-22T01:00:00.000Z",
          reason: "explicit-reset",
          turnCount: 2,
        },
      ],
      truncated: false,
    });
    expect(store.listArchivedConversations("missing")).toEqual({
      schemaVersion: 1,
      conversations: [],
      truncated: false,
    });
    expect(existsSync(transcriptPath(dataDir, "missing"))).toBe(false);
  });

  it("counts and pages archived recovery attempts as one logical turn", () => {
    const dataDir = makeDataDir();
    const chatId = "archive-recovered-turn";
    const store = new TranscriptStore(dataDir);
    store.appendCompletedTurn(turn(chatId, "turn-1"));
    store.appendInterruptedTurn(turn(chatId, "turn-2", "First", "Partial"));
    store.appendCompletedTurn({
      ...turn(chatId, "turn-2", "First", "Recovered"),
      completedAt: "1998-07-22T00:01:00.000Z",
    });
    store.ensureConversationBoundary(intent(chatId, RESET_ID_A));

    expect(store.listArchivedConversations(chatId).conversations[0]?.turnCount).toBe(2);
    const newest = store.readArchivedConversationPage(chatId, RESET_ID_A, {
      cursor: null,
      limit: 1,
    });
    expect(newest.turns.map(({ turnId, coachText }) => [turnId, coachText])).toEqual([
      ["turn-2", "Partial"],
      ["turn-2", "Recovered"],
    ]);
    expect(newest.nextCursor).not.toBeNull();
    expect(
      store
        .readArchivedConversationPage(chatId, RESET_ID_A, {
          cursor: newest.nextCursor,
          limit: 1,
        })
        .turns.map(({ turnId }) => turnId),
    ).toEqual(["turn-1"]);
  });

  it("caps the listed boundaries at the newest two hundred and reports truncation", () => {
    const dataDir = makeDataDir();
    const chatId = "archive-cap";
    const store = new TranscriptStore(dataDir);
    const total = MAX_ARCHIVED_CONVERSATION_ENTRIES + 2;
    const boundaryRef = (index: number): string => index.toString(16).padStart(64, "0");
    store.appendCompletedTurn(turn(chatId, "turn-1"));
    const records: Buffer[] = [];
    for (let index = 1; index <= total; index += 1) {
      records.push(
        Buffer.from(
          `${JSON.stringify({ ...intent(chatId, boundaryRef(index)), kind: "conversation-boundary" })}\n`,
        ),
        serializedTurn(turn(chatId, `turn-${index}`)),
      );
    }
    appendFileSync(transcriptPath(dataDir, chatId), Buffer.concat(records));

    const listed = store.listArchivedConversations(chatId);

    expect(listed.truncated).toBe(true);
    expect(listed.conversations).toHaveLength(MAX_ARCHIVED_CONVERSATION_ENTRIES);
    expect(listed.conversations[0]!.boundaryRef).toBe(boundaryRef(total));
    expect(listed.conversations.at(-1)!.boundaryRef).toBe(
      boundaryRef(total - MAX_ARCHIVED_CONVERSATION_ENTRIES + 1),
    );
    expect(
      store
        .readArchivedConversationPage(chatId, boundaryRef(total), { cursor: null, limit: 5 })
        .turns.map((record) => record.turnId),
    ).toEqual([`turn-${total - 1}`]);
  });

  it("pages one archived conversation backward without leaking neighbouring conversations", () => {
    const dataDir = makeDataDir();
    const chatId = "archive-page";
    const store = new TranscriptStore(dataDir);
    store.appendCompletedTurn(turn(chatId, "turn-0"));
    store.ensureConversationBoundary(intent(chatId, RESET_ID_B));
    for (let index = 1; index <= 3; index += 1) {
      store.appendCompletedTurn(turn(chatId, `turn-${index}`));
    }
    store.ensureConversationBoundary(intent(chatId, RESET_ID_A));
    store.appendCompletedTurn(turn(chatId, "turn-9"));

    const newest = store.readArchivedConversationPage(chatId, RESET_ID_A, {
      cursor: null,
      limit: 2,
    });
    expect(newest.status).toBe("page");
    expect(newest.turns.map((record) => record.turnId)).toEqual(["turn-2", "turn-3"]);
    expect(newest.nextCursor).not.toBeNull();

    const oldest = store.readArchivedConversationPage(chatId, RESET_ID_A, {
      cursor: newest.nextCursor,
      limit: 2,
    });
    expect(oldest.turns.map((record) => record.turnId)).toEqual(["turn-1"]);
    expect(oldest.nextCursor).toBeNull();

    expect(
      store
        .readArchivedConversationPage(chatId, RESET_ID_B, { cursor: null, limit: 10 })
        .turns.map((record) => record.turnId),
    ).toEqual(["turn-0"]);
    expect(
      store
        .readCurrentConversationPage(chatId, { cursor: null, limit: 10 })
        .turns.map((record) => record.turnId),
    ).toEqual(["turn-9"]);
  });

  it("keeps an archived page immutable while the live conversation keeps appending", () => {
    const dataDir = makeDataDir();
    const chatId = "archive-immutable";
    const store = new TranscriptStore(dataDir);
    store.appendCompletedTurn(turn(chatId, "turn-1"));
    store.appendCompletedTurn(turn(chatId, "turn-2"));
    store.ensureConversationBoundary(intent(chatId, RESET_ID_A));
    const newest = store.readArchivedConversationPage(chatId, RESET_ID_A, {
      cursor: null,
      limit: 1,
    });
    store.appendCompletedTurn(turn(chatId, "turn-3"));
    store.ensureConversationBoundary(intent(chatId, RESET_ID_B));
    store.appendCompletedTurn(turn(chatId, "turn-4"));

    const older = store.readArchivedConversationPage(chatId, RESET_ID_A, {
      cursor: newest.nextCursor,
      limit: 1,
    });

    expect(newest.turns.map((record) => record.turnId)).toEqual(["turn-2"]);
    expect(older.turns.map((record) => record.turnId)).toEqual(["turn-1"]);
    expect(older.nextCursor).toBeNull();
  });

  it("refuses cursors minted for the live pager and boundary references from another chat", () => {
    const dataDir = makeDataDir();
    const chatId = "archive-cursor-namespace";
    const store = new TranscriptStore(dataDir);
    store.appendCompletedTurn(turn(chatId, "turn-1"));
    store.appendCompletedTurn(turn(chatId, "turn-2"));
    store.ensureConversationBoundary(intent(chatId, RESET_ID_A));
    store.appendCompletedTurn(turn(chatId, "turn-3"));
    store.appendCompletedTurn(turn(chatId, "turn-4"));
    store.appendCompletedTurn(turn("other", "turn-1"));
    store.appendCompletedTurn(turn("other", "turn-2"));
    store.ensureConversationBoundary(intent("other", RESET_ID_B));

    const live = store.readCurrentConversationPage(chatId, { cursor: null, limit: 1 });
    const archived = store.readArchivedConversationPage(chatId, RESET_ID_A, {
      cursor: null,
      limit: 1,
    });

    expect(live.nextCursor).not.toBeNull();
    expect(archived.nextCursor).not.toBeNull();
    expect(() =>
      store.readArchivedConversationPage(chatId, RESET_ID_A, { cursor: live.nextCursor, limit: 1 }),
    ).toThrow(TypeError);
    expect(() =>
      store.readCurrentConversationPage(chatId, { cursor: archived.nextCursor, limit: 1 }),
    ).toThrow(TypeError);
    expect(() =>
      store.readArchivedConversationPage("other", RESET_ID_B, {
        cursor: archived.nextCursor,
        limit: 1,
      }),
    ).toThrow(TypeError);
    expect(() =>
      store.readArchivedConversationPage(chatId, "z".repeat(64), { cursor: null, limit: 1 }),
    ).toThrow(TypeError);
    expect(() =>
      store.readArchivedConversationPage(chatId, RESET_ID_A, { cursor: null, limit: 0 }),
    ).toThrow(TypeError);
  });

  it("asks the reader to restart when the boundary reference is unknown or the file is gone", () => {
    const dataDir = makeDataDir();
    const chatId = "archive-restart";
    const store = new TranscriptStore(dataDir);
    store.appendCompletedTurn(turn(chatId, "turn-1"));

    const restart = {
      schemaVersion: 1,
      status: "restart-required",
      turns: [],
      nextCursor: null,
    };
    expect(
      store.readArchivedConversationPage(chatId, RESET_ID_A, { cursor: null, limit: 5 }),
    ).toEqual(restart);
    expect(
      store.readArchivedConversationPage("missing", RESET_ID_A, { cursor: null, limit: 5 }),
    ).toEqual(restart);
    expect(existsSync(transcriptPath(dataDir, "missing"))).toBe(false);
  });

  it("reports a corrupted archived conversation as empty without touching its neighbours", () => {
    const dataDir = makeDataDir();
    const chatId = "archive-corruption";
    const store = new TranscriptStore(dataDir);
    const path = transcriptPath(dataDir, chatId);
    store.appendCompletedTurn(turn(chatId, "turn-1"));
    appendFileSync(path, Buffer.from([0xff, 0x0a]));
    store.appendCompletedTurn(turn(chatId, "turn-2"));
    store.ensureConversationBoundary(intent(chatId, RESET_ID_A));
    store.appendCompletedTurn(turn(chatId, "turn-3"));
    store.ensureConversationBoundary(intent(chatId, RESET_ID_B));

    const listed = store.listArchivedConversations(chatId);

    expect(listed.conversations.map((entry) => [entry.boundaryRef, entry.turnCount])).toEqual([
      [RESET_ID_B, 1],
      [RESET_ID_A, 0],
    ]);
    expect(
      store.readArchivedConversationPage(chatId, RESET_ID_A, { cursor: null, limit: 5 }),
    ).toEqual({ schemaVersion: 1, status: "page", turns: [], nextCursor: null });
    expect(
      store
        .readArchivedConversationPage(chatId, RESET_ID_B, { cursor: null, limit: 5 })
        .turns.map((record) => record.turnId),
    ).toEqual(["turn-3"]);
  });

  it("keeps archived reads free of writes to the transcript target", () => {
    const dataDir = makeDataDir();
    const chatId = "archive-read-only";
    const store = new TranscriptStore(dataDir);
    store.appendCompletedTurn(turn(chatId, "turn-1"));
    store.ensureConversationBoundary(intent(chatId, RESET_ID_A));
    const before = readFileSync(transcriptPath(dataDir, chatId));

    store.listArchivedConversations(chatId);
    store.readArchivedConversationPage(chatId, RESET_ID_A, { cursor: null, limit: 5 });

    expect(readFileSync(transcriptPath(dataDir, chatId))).toEqual(before);
  });
});

describe("TranscriptStore archived conversation deletion", () => {
  it("inspects and deletes the oldest, middle, and newest segments without changing current", () => {
    const dataDir = makeDataDir();
    const chatId = "archive-delete-order";
    const store = new TranscriptStore(dataDir);
    const append = (turnId: string, attachmentId: string) =>
      store.appendCompletedTurn({
        ...turn(chatId, turnId),
        attachments: [
          {
            attachmentId,
            displayName: `${attachmentId}.txt`,
            kind: "document" as const,
            extension: "txt" as const,
          },
        ],
      });
    append("turn-1", "attachment-1");
    store.ensureConversationBoundary(intent(chatId, RESET_ID_A));
    append("turn-2", "attachment-2");
    store.ensureConversationBoundary(intent(chatId, RESET_ID_B));
    append("turn-3", "attachment-3");
    store.ensureConversationBoundary(intent(chatId, RESET_ID_C));
    append("turn-4", "attachment-current");

    const middle = store.inspectArchivedConversation(chatId, RESET_ID_B);
    expect(middle).toMatchObject({
      schemaVersion: 1,
      boundaryRef: RESET_ID_B,
      boundaryAt: "2026-07-22T01:00:00.000Z",
      turnIds: ["turn-2"],
      attachmentIds: ["attachment-2"],
      manifestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(store.finalizeArchivedConversationDeletion(chatId, middle!)).toBe(true);
    expect(
      store.listArchivedConversations(chatId).conversations.map((item) => item.boundaryRef),
    ).toEqual([RESET_ID_C, RESET_ID_A]);
    expect(
      store
        .readArchivedConversationPage(chatId, RESET_ID_A, { cursor: null, limit: 10 })
        .turns.map(({ turnId }) => turnId),
    ).toEqual(["turn-1"]);
    expect(
      store
        .readArchivedConversationPage(chatId, RESET_ID_C, { cursor: null, limit: 10 })
        .turns.map(({ turnId }) => turnId),
    ).toEqual(["turn-3"]);

    const oldest = store.inspectArchivedConversation(chatId, RESET_ID_A);
    expect(store.finalizeArchivedConversationDeletion(chatId, oldest!)).toBe(true);
    expect(
      store.listArchivedConversations(chatId).conversations.map((item) => item.boundaryRef),
    ).toEqual([RESET_ID_C]);

    const newest = store.inspectArchivedConversation(chatId, RESET_ID_C);
    expect(store.finalizeArchivedConversationDeletion(chatId, newest!)).toBe(true);
    expect(store.listArchivedConversations(chatId)).toEqual({
      schemaVersion: 1,
      conversations: [],
      truncated: false,
    });
    expect(store.readCurrentConversation(chatId).map(({ turnId }) => turnId)).toEqual(["turn-4"]);
    expect(readFileSync(transcriptPath(dataDir, chatId), "utf8")).toContain("attachment-current");
    expect(readFileSync(transcriptPath(dataDir, chatId), "utf8")).not.toContain("attachment-1");
    expect(readFileSync(transcriptPath(dataDir, chatId), "utf8")).not.toContain("attachment-2");
    expect(readFileSync(transcriptPath(dataDir, chatId), "utf8")).not.toContain("attachment-3");
  });

  it("makes not-found finalization idempotent and invalidates a deleted segment cursor", () => {
    const dataDir = makeDataDir();
    const chatId = "archive-delete-idempotent";
    const store = new TranscriptStore(dataDir);
    store.appendCompletedTurn(turn(chatId, "turn-1"));
    store.appendCompletedTurn(turn(chatId, "turn-2"));
    store.ensureConversationBoundary(intent(chatId, RESET_ID_A));
    store.appendCompletedTurn(turn(chatId, "turn-3"));
    const page = store.readArchivedConversationPage(chatId, RESET_ID_A, {
      cursor: null,
      limit: 1,
    });
    const manifest = store.inspectArchivedConversation(chatId, RESET_ID_A)!;

    expect(page.nextCursor).not.toBeNull();
    expect(store.finalizeArchivedConversationDeletion(chatId, manifest)).toBe(true);
    expect(store.inspectArchivedConversation(chatId, RESET_ID_A)).toBeNull();
    expect(store.finalizeArchivedConversationDeletion(chatId, manifest)).toBe(false);
    expect(
      store.finalizeArchivedConversationDeletion("missing", {
        ...manifest,
        boundaryRef: RESET_ID_B,
      }),
    ).toBe(false);
    expect(() =>
      store.readArchivedConversationPage(chatId, RESET_ID_A, {
        cursor: page.nextCursor,
        limit: 1,
      }),
    ).toThrow(TypeError);
    expect(store.readCurrentConversation(chatId).map(({ turnId }) => turnId)).toEqual(["turn-3"]);
  });

  it("rejects a manifest when the selected archived bytes changed", () => {
    const dataDir = makeDataDir();
    const chatId = "archive-delete-conflict";
    const store = new TranscriptStore(dataDir);
    store.appendCompletedTurn(turn(chatId, "turn-1"));
    store.ensureConversationBoundary(intent(chatId, RESET_ID_A));
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
    expect(store.listArchivedConversations(chatId).conversations).toHaveLength(1);
  });
});

describe("TranscriptStore append and corruption handling", () => {
  it("returns an empty conversation for a missing transcript without creating its file", () => {
    const dataDir = makeDataDir();
    const store = new TranscriptStore(dataDir);
    const path = transcriptPath(dataDir, "missing");

    expect(store.readCurrentConversation("missing")).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });

  it("round-trips exact Unicode and whitespace in one strict newline-terminated record", () => {
    const dataDir = makeDataDir();
    const store = new TranscriptStore(dataDir);
    const input = turn(
      "chat-unicode",
      "turn-1",
      "  🚴🏽‍♀️\n\tПривет\r\n尾部  ",
      "\n  Café\u00a0coach\t🏁\n",
    );

    store.appendCompletedTurn(input);

    const raw = readFileSync(transcriptPath(dataDir, input.chatId), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.split("\n")).toHaveLength(2);
    expect(JSON.parse(raw.trimEnd())).toEqual({
      version: 1,
      kind: "turn-completed",
      ...input,
    });
    expect(store.readCurrentConversation(input.chatId)).toEqual([
      { version: 1, kind: "turn-completed", ...input },
    ]);
  });

  it("round-trips only safe sent-attachment references for relaunch hydration", () => {
    const dataDir = makeDataDir();
    const store = new TranscriptStore(dataDir);
    const input = {
      ...turn("chat-attachments", "turn-1", "Review this", "Reviewed"),
      attachments: [
        {
          attachmentId: "attachment-1",
          displayName: "training-notes.txt",
          kind: "document" as const,
          extension: "txt" as const,
        },
      ],
    };

    store.appendCompletedTurn(input);

    expect(store.readCurrentConversation(input.chatId)).toEqual([
      { version: 1, kind: "turn-completed", ...input },
    ]);
    const page = store.readCurrentConversationPage(input.chatId, { cursor: null, limit: 10 });
    expect(page).toMatchObject({
      status: "page",
      turns: [{ turnId: "turn-1", attachments: input.attachments }],
    });
    expect(readFileSync(transcriptPath(dataDir, input.chatId), "utf8")).not.toContain(
      "private/source/path",
    );
  });

  it("rejects attachment transcript fields outside the strict safe reference shape", () => {
    const store = new TranscriptStore(makeDataDir());
    expect(() =>
      store.appendCompletedTurn({
        ...turn("chat-attachments-invalid", "turn-1"),
        attachments: [
          {
            attachmentId: "attachment-1",
            displayName: "ride.fit",
            kind: "activity",
            extension: "fit",
            sourcePath: "/private/ride.fit",
          },
        ],
      } as never),
    ).toThrow("Completed transcript turn is invalid");
  });

  it("round-trips one typed Plan reference for relaunch hydration", () => {
    const dataDir = makeDataDir();
    const store = new TranscriptStore(dataDir);
    const input = {
      ...turn("chat-plan-reference", "turn-1", "Show Tuesday", "Tempo builder"),
      planReference: {
        kind: "workout_detail" as const,
        planId: "plan-1",
        workoutId: "workout-1",
      },
    };

    store.appendCompletedTurn(input);

    expect(store.readCurrentConversation(input.chatId)).toEqual([
      { version: 1, kind: "turn-completed", ...input },
    ]);
    expect(
      store.readCurrentConversationPage(input.chatId, { cursor: null, limit: 10 }),
    ).toMatchObject({
      status: "page",
      turns: [{ turnId: "turn-1", planReference: input.planReference }],
    });
  });

  it("round-trips one typed Plan handoff for relaunch hydration", () => {
    const dataDir = makeDataDir();
    const store = new TranscriptStore(dataDir);
    const input = {
      ...turn("chat-plan-handoff", "turn-1", "Can we move Friday?", "Review it in Plan."),
      planHandoff: {
        kind: "plan_change" as const,
        title: "Review a lighter Friday",
        intent: "Move Friday's endurance Workout to Saturday and keep Friday easy.",
      },
    };

    store.appendCompletedTurn(input);

    expect(store.readCurrentConversation(input.chatId)).toEqual([
      { version: 1, kind: "turn-completed", ...input },
    ]);
    expect(
      store.readCurrentConversationPage(input.chatId, { cursor: null, limit: 10 }),
    ).toMatchObject({
      status: "page",
      turns: [{ turnId: "turn-1", planHandoff: input.planHandoff }],
    });
  });

  it("rejects arbitrary Plan-card markup in transcript records", () => {
    const store = new TranscriptStore(makeDataDir());
    expect(() =>
      store.appendCompletedTurn({
        ...turn("chat-plan-reference-invalid", "turn-1"),
        planReference: {
          kind: "active_plan_summary",
          planId: "plan-1",
          markup: "<button>Apply</button>",
        },
      } as never),
    ).toThrow("Completed transcript turn is invalid");
  });

  it("round-trips an interrupted turn and projects its delivery on transcript pages", () => {
    const dataDir = makeDataDir();
    const store = new TranscriptStore(dataDir);
    const input = turn("chat-interrupted", "turn-1", "stop this", "Partial response");

    store.appendInterruptedTurn(input);

    expect(store.readCurrentConversation(input.chatId)).toEqual([
      { version: 1, kind: "turn-interrupted", ...input },
    ]);
    const { chatId: _chatId, ...projected } = input;
    expect(store.readCurrentConversationPage(input.chatId, { cursor: null, limit: 10 })).toEqual({
      schemaVersion: 1,
      status: "page",
      turns: [{ ...projected, delivery: "interrupted" }],
      nextCursor: null,
    });

    const reopened = new TranscriptStore(dataDir);
    expect(
      reopened.readCurrentConversationPage(input.chatId, { cursor: null, limit: 10 }).turns,
    ).toEqual([{ ...projected, delivery: "interrupted" }]);
  });

  it("preserves append order across a fresh store instance", () => {
    const dataDir = makeDataDir();
    const first = new TranscriptStore(dataDir);
    first.appendCompletedTurn(turn("ordered", "turn-1"));
    first.appendCompletedTurn(turn("ordered", "turn-2"));

    const reopened = new TranscriptStore(dataDir);
    expect(reopened.readCurrentConversation("ordered").map((record) => record.turnId)).toEqual([
      "turn-1",
      "turn-2",
    ]);
  });

  it("walks newest pages backward within only the latest trusted conversation", () => {
    const dataDir = makeDataDir();
    const chatId = "paginated-boundary";
    const store = new TranscriptStore(dataDir);
    store.appendCompletedTurn(turn(chatId, "turn-8"));
    store.appendCompletedTurn(turn(chatId, "turn-9"));
    store.ensureConversationBoundary(intent(chatId));
    for (let index = 1; index <= 5; index += 1) {
      store.appendCompletedTurn(turn(chatId, `turn-${index}`));
    }

    const newest = store.readCurrentConversationPage(chatId, { cursor: null, limit: 2 });
    expect(newest.status).toBe("page");
    expect(newest.turns.map((record) => record.turnId)).toEqual(["turn-4", "turn-5"]);
    expect(newest.nextCursor).not.toBeNull();

    const middle = store.readCurrentConversationPage(chatId, {
      cursor: newest.nextCursor,
      limit: 2,
    });
    expect(middle.turns.map((record) => record.turnId)).toEqual(["turn-2", "turn-3"]);
    expect(middle.nextCursor).not.toBeNull();

    const oldest = store.readCurrentConversationPage(chatId, {
      cursor: middle.nextCursor,
      limit: 2,
    });
    expect(oldest.turns.map((record) => record.turnId)).toEqual(["turn-1"]);
    expect(oldest.nextCursor).toBeNull();
  });

  it("keeps current recovery attempts together as one pagination unit", () => {
    const dataDir = makeDataDir();
    const chatId = "paginated-recovered-turn";
    const store = new TranscriptStore(dataDir);
    store.appendCompletedTurn(turn(chatId, "turn-1"));
    store.appendInterruptedTurn(turn(chatId, "turn-2", "First", "Partial"));
    store.appendCompletedTurn({
      ...turn(chatId, "turn-2", "First", "Recovered"),
      completedAt: "1998-07-22T00:01:00.000Z",
    });

    const newest = store.readCurrentConversationPage(chatId, { cursor: null, limit: 1 });
    expect(newest.turns.map(({ turnId, coachText }) => [turnId, coachText])).toEqual([
      ["turn-2", "Partial"],
      ["turn-2", "Recovered"],
    ]);
    expect(newest.nextCursor).not.toBeNull();
    expect(
      store
        .readCurrentConversationPage(chatId, { cursor: newest.nextCursor, limit: 1 })
        .turns.map(({ turnId }) => turnId),
    ).toEqual(["turn-1"]);
  });

  it("keeps a cursor snapshot stable while completed turns append concurrently", () => {
    const dataDir = makeDataDir();
    const chatId = "append-stability";
    const store = new TranscriptStore(dataDir);
    for (let index = 1; index <= 4; index += 1) {
      store.appendCompletedTurn(turn(chatId, `turn-${index}`));
    }

    const newest = store.readCurrentConversationPage(chatId, { cursor: null, limit: 2 });
    store.appendCompletedTurn(turn(chatId, "turn-5"));
    const older = store.readCurrentConversationPage(chatId, {
      cursor: newest.nextCursor,
      limit: 2,
    });
    const refreshed = store.readCurrentConversationPage(chatId, { cursor: null, limit: 2 });

    expect(older.turns.map((record) => record.turnId)).toEqual(["turn-1", "turn-2"]);
    expect(older.nextCursor).toBeNull();
    expect(refreshed.turns.map((record) => record.turnId)).toEqual(["turn-4", "turn-5"]);
  });

  it("returns a fixed restart signal when a completed boundary supersedes a cursor", () => {
    const dataDir = makeDataDir();
    const chatId = "reset-between-pages";
    const store = new TranscriptStore(dataDir);
    for (let index = 1; index <= 3; index += 1) {
      store.appendCompletedTurn(turn(chatId, `turn-${index}`));
    }
    const first = store.readCurrentConversationPage(chatId, { cursor: null, limit: 1 });
    store.ensureConversationBoundary(intent(chatId));
    store.appendCompletedTurn(turn(chatId, "turn-4"));

    expect(
      store.readCurrentConversationPage(chatId, {
        cursor: first.nextCursor,
        limit: 1,
      }),
    ).toEqual({
      schemaVersion: 1,
      status: "restart-required",
      turns: [],
      nextCursor: null,
    });
  });

  it("enforces turn and encoded response budgets without losing pagination progress", () => {
    const dataDir = makeDataDir();
    const chatId = "page-budgets";
    const store = new TranscriptStore(dataDir);
    for (let index = 1; index <= MAX_TRANSCRIPT_PAGE_TURNS + 5; index += 1) {
      store.appendCompletedTurn(turn(chatId, `turn-${index}`));
    }
    expect(() =>
      store.readCurrentConversationPage(chatId, {
        cursor: null,
        limit: MAX_TRANSCRIPT_PAGE_TURNS + 1,
      }),
    ).toThrow(TypeError);
    const capped = store.readCurrentConversationPage(chatId, {
      cursor: null,
      limit: MAX_TRANSCRIPT_PAGE_TURNS,
    });
    expect(capped.turns).toHaveLength(MAX_TRANSCRIPT_PAGE_TURNS);
    expect(capped.nextCursor).not.toBeNull();

    const largeChatId = "page-byte-budget";
    for (let index = 1; index <= 3; index += 1) {
      store.appendCompletedTurn({
        ...turnWithSerializedBytes(140_000, largeChatId),
        turnId: `turn-${index}`,
      });
    }
    const large = store.readCurrentConversationPage(largeChatId, {
      cursor: null,
      limit: MAX_TRANSCRIPT_PAGE_TURNS,
    });
    expect(Buffer.byteLength(JSON.stringify(large), "utf8")).toBeLessThanOrEqual(
      MAX_TRANSCRIPT_PAGE_RESPONSE_BYTES,
    );
    expect(large.turns).toHaveLength(1);
    expect(large.nextCursor).not.toBeNull();
    const remaining = store.readCurrentConversationPage(largeChatId, {
      cursor: large.nextCursor,
      limit: MAX_TRANSCRIPT_PAGE_TURNS,
    });
    expect(remaining.turns).toHaveLength(1);
    expect(remaining.nextCursor).not.toBeNull();
  });

  it("applies fail-closed corruption recovery semantics to every pagination path", () => {
    const dataDir = makeDataDir();
    const chatId = "page-corruption";
    const store = new TranscriptStore(dataDir);
    const path = transcriptPath(dataDir, chatId);
    store.appendCompletedTurn(turn(chatId, "turn-1"));
    appendFileSync(path, Buffer.from([0xff, 0x0a]));
    store.appendCompletedTurn(turn(chatId, "turn-2"));

    expect(store.readCurrentConversationPage(chatId, { cursor: null, limit: 10 })).toEqual({
      schemaVersion: 1,
      status: "page",
      turns: [],
      nextCursor: null,
    });

    store.ensureConversationBoundary(intent(chatId));
    store.appendCompletedTurn(turn(chatId, "turn-3"));
    const recovered = store.readCurrentConversationPage(chatId, {
      cursor: null,
      limit: 10,
    });
    expect(recovered.turns.map((record) => record.turnId)).toEqual(["turn-3"]);
    expect(recovered.nextCursor).toBeNull();
  });

  it("accepts an exact 262,144-byte serialized Unicode and escaped record", () => {
    const dataDir = makeDataDir();
    const store = new TranscriptStore(dataDir);
    const input = turnWithSerializedBytes(MAX_TRANSCRIPT_RECORD_BYTES);
    const bytes = serializedTurn(input);

    expect(bytes).toHaveLength(MAX_TRANSCRIPT_RECORD_BYTES);
    expect(bytes.toString("utf8").length).toBeLessThan(MAX_TRANSCRIPT_RECORD_BYTES);

    store.appendCompletedTurn(input);

    expect(readFileSync(transcriptPath(dataDir, input.chatId))).toEqual(bytes);
    const page = store.readCurrentConversationPage(input.chatId, { cursor: null, limit: 1 });
    expect(page.turns).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(
      MAX_TRANSCRIPT_PAGE_RESPONSE_BYTES,
    );
  });

  it("rejects an exact 262,145-byte record before target access or mutation", () => {
    const dataDir = makeDataDir();
    let existingFileOpens = 0;
    const store = new TranscriptStore(dataDir, {
      beforeExistingFileOpen: () => {
        existingFileOpens += 1;
      },
    });
    const freshInput = turnWithSerializedBytes(MAX_TRANSCRIPT_RECORD_BYTES + 1);
    const freshPath = transcriptPath(dataDir, freshInput.chatId);
    const existingChatId = "existing-record-size";

    expect(serializedTurn(freshInput)).toHaveLength(MAX_TRANSCRIPT_RECORD_BYTES + 1);
    expect(serializedTurn(freshInput).toString("utf8").length).toBeLessThanOrEqual(
      MAX_TRANSCRIPT_RECORD_BYTES,
    );
    expect(() => store.appendCompletedTurn(freshInput)).toThrowError(
      expect.objectContaining({ code: "TRANSCRIPT_RECORD_TOO_LARGE" }),
    );
    expect(existsSync(freshPath)).toBe(false);

    store.appendCompletedTurn(turn(existingChatId, "turn-1"));
    const existingPath = transcriptPath(dataDir, existingChatId);
    const prefix = readFileSync(existingPath);
    const oversizedExisting = turnWithSerializedBytes(
      MAX_TRANSCRIPT_RECORD_BYTES + 1,
      existingChatId,
    );

    expect(() => store.appendCompletedTurn(oversizedExisting)).toThrow(
      TranscriptRecordTooLargeError,
    );
    expect(existingFileOpens).toBe(0);
    expect(readFileSync(existingPath)).toEqual(prefix);
  });

  it("hashes malicious chat IDs without creating paths outside the transcript directory", () => {
    const dataDir = makeDataDir();
    const store = new TranscriptStore(dataDir);
    const chatIds = ["../../escape", "/tmp/absolute", "..\\..\\windows", "nested/id"];

    for (const [index, chatId] of chatIds.entries()) {
      store.appendCompletedTurn(turn(chatId, `turn-${index + 1}`));
    }

    const names = readdirSync(join(dataDir, "transcripts"));
    expect(names).toHaveLength(chatIds.length);
    expect(names.every((name) => /^[a-f0-9]{64}\.jsonl$/.test(name))).toBe(true);
    expect(readdirSync(dataDir).sort()).toEqual(["transcripts"]);
  });

  it.each(corruptionCases("strict"))(
    "fails closed after %s and ignores later turns until a boundary",
    (_name, corrupt) => {
      const dataDir = makeDataDir();
      const chatId = "strict";
      const store = new TranscriptStore(dataDir);
      const path = transcriptPath(dataDir, chatId);
      store.appendCompletedTurn(turn(chatId, "turn-1"));
      appendFileSync(path, corrupt);
      const throughCorruption = readFileSync(path);
      store.appendCompletedTurn(turn(chatId, "turn-2"));

      expect(store.readCurrentConversation(chatId)).toEqual([]);
      expect(readFileSync(path).subarray(0, throughCorruption.length)).toEqual(throughCorruption);
    },
  );

  it.each(corruptionCases("recover-trust"))(
    "restores trust only at a fully valid same-chat boundary after %s",
    (_name, corrupt) => {
      const dataDir = makeDataDir();
      const chatId = "recover-trust";
      const store = new TranscriptStore(dataDir);
      const path = transcriptPath(dataDir, chatId);
      store.appendCompletedTurn(turn(chatId, "turn-1"));
      appendFileSync(path, corrupt);
      store.appendCompletedTurn(turn(chatId, "turn-2"));
      expect(store.readCurrentConversation(chatId)).toEqual([]);

      store.ensureConversationBoundary(intent(chatId));
      store.appendCompletedTurn(turn(chatId, "turn-3"));

      expect(store.readCurrentConversation(chatId).map((record) => record.turnId)).toEqual([
        "turn-3",
      ]);
    },
  );

  it("treats an injected oversize JSONL line as corruption until a later boundary", () => {
    const dataDir = makeDataDir();
    const chatId = "oversize-corruption";
    const path = transcriptPath(dataDir, chatId);
    const store = new TranscriptStore(dataDir);
    store.appendCompletedTurn(turn(chatId, "turn-1"));
    const injected = serializedTurn(
      turnWithSerializedBytes(MAX_TRANSCRIPT_RECORD_BYTES + 1, chatId),
    );
    appendFileSync(path, injected);
    const throughInjectedLine = readFileSync(path);

    store.appendCompletedTurn(turn(chatId, "turn-2"));
    expect(store.readCurrentConversation(chatId)).toEqual([]);

    store.ensureConversationBoundary(intent(chatId));
    store.appendCompletedTurn(turn(chatId, "turn-3"));

    expect(store.readCurrentConversation(chatId).map((record) => record.turnId)).toEqual([
      "turn-3",
    ]);
    expect(readFileSync(path).subarray(0, throughInjectedLine.length)).toEqual(throughInjectedLine);
  });

  it("keeps torn bytes unchanged and recovers through a later durable boundary", () => {
    const dataDir = makeDataDir();
    const chatId = "torn";
    const path = transcriptPath(dataDir, chatId);
    const store = new TranscriptStore(dataDir);
    store.appendCompletedTurn(turn(chatId, "turn-1"));
    appendFileSync(path, '{"version":1,"kind":"conversation-boundary"');
    const tornBytes = readFileSync(path);

    store.appendCompletedTurn(turn(chatId, "turn-9"));
    expect(store.readCurrentConversation(chatId)).toEqual([]);
    store.ensureConversationBoundary(intent(chatId));
    store.appendCompletedTurn(turn(chatId, "turn-2"));

    expect(readFileSync(path).subarray(0, tornBytes.length)).toEqual(tornBytes);
    const beforeRead = readFileSync(path);
    expect(store.readCurrentConversation(chatId).map((record) => record.turnId)).toEqual([
      "turn-2",
    ]);
    expect(readFileSync(path)).toEqual(beforeRead);
  });

  it("ensures one resetId boundary idempotently", () => {
    const dataDir = makeDataDir();
    const chatId = "boundaries";
    const store = new TranscriptStore(dataDir);
    const reset = intent(chatId);
    store.ensureConversationBoundary(reset);
    store.ensureConversationBoundary(reset);
    store.appendCompletedTurn(turn(chatId, "turn-1"));

    const records = readFileSync(transcriptPath(dataDir, chatId), "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; resetId?: string });
    expect(records.filter((record) => record.kind === "conversation-boundary")).toEqual([
      expect.objectContaining({ resetId: RESET_ID_A }),
    ]);
    expect(store.readCurrentConversation(chatId).map((record) => record.turnId)).toEqual([
      "turn-1",
    ]);
  });

  it("uses one newline-terminated write and syncs a new file before its directory entry", () => {
    const dataDir = makeDataDir();
    new TranscriptStore(dataDir);
    const writes: Buffer[] = [];
    const syncOrder: string[] = [];
    const store = new TranscriptStore(dataDir, {
      write: (descriptor, buffer, offset, length, position) => {
        writes.push(Buffer.from(buffer as Uint8Array).subarray(offset, offset + length));
        return writeSync(descriptor, buffer, offset, length, position);
      },
      syncFile: (descriptor) => {
        syncOrder.push("file");
        fsyncSync(descriptor);
      },
      syncDirectory: (descriptor) => {
        syncOrder.push("directory");
        fsyncSync(descriptor);
      },
    });

    store.appendCompletedTurn(turn("durable", "turn-1", "embedded\nnewline"));

    expect(writes).toHaveLength(1);
    expect([...writes[0]!].filter((byte) => byte === 0x0a)).toHaveLength(1);
    expect(syncOrder).toEqual(["file", "directory"]);
  });

  it("preserves every prior byte across normal appends and reads", () => {
    const dataDir = makeDataDir();
    const chatId = "append-only";
    const path = transcriptPath(dataDir, chatId);
    const store = new TranscriptStore(dataDir);
    store.appendCompletedTurn(turn(chatId, "turn-1"));
    const beforeAppend = readFileSync(path);

    store.appendCompletedTurn(turn(chatId, "turn-2"));

    const afterAppend = readFileSync(path);
    expect(afterAppend.subarray(0, beforeAppend.length)).toEqual(beforeAppend);
    store.readCurrentConversation(chatId);
    expect(readFileSync(path)).toEqual(afterAppend);
  });

  it("detects a short single-call write and leaves the torn bytes in place", () => {
    const dataDir = makeDataDir();
    let writes = 0;
    const store = new TranscriptStore(dataDir, {
      write: (descriptor, buffer, offset, length, position) => {
        writes += 1;
        return writeSync(descriptor, buffer, offset, Math.floor(length / 2), position);
      },
    });

    expect(() => store.appendCompletedTurn(turn("short-write", "turn-1"))).toThrow(
      "Transcript append was incomplete.",
    );
    expect(writes).toBe(1);
    const raw = readFileSync(transcriptPath(dataDir, "short-write"));
    expect(raw.length).toBeGreaterThan(0);
    expect(raw[raw.length - 1]).not.toBe(0x0a);
    expect(store.readCurrentConversation("short-write")).toEqual([]);
  });

  it("propagates file fsync failure after issuing the complete append", () => {
    const dataDir = makeDataDir();
    const failure = new Error("synthetic file sync failure");
    const store = new TranscriptStore(dataDir, {
      syncFile: () => {
        throw failure;
      },
    });

    expect(() => store.appendCompletedTurn(turn("sync-failure", "turn-1"))).toThrow(failure);
    const raw = readFileSync(transcriptPath(dataDir, "sync-failure"), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw)).toEqual(
      expect.objectContaining({ kind: "turn-completed", turnId: "turn-1" }),
    );
  });

  it("propagates transcript directory fsync failure after syncing a new file", () => {
    const dataDir = makeDataDir();
    new TranscriptStore(dataDir);
    const failure = new Error("synthetic directory sync failure");
    const store = new TranscriptStore(dataDir, {
      syncDirectory: () => {
        throw failure;
      },
    });

    expect(() => store.appendCompletedTurn(turn("directory-sync", "turn-1"))).toThrow(failure);
    const raw = readFileSync(transcriptPath(dataDir, "directory-sync"), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw)).toEqual(
      expect.objectContaining({ kind: "turn-completed", turnId: "turn-1" }),
    );
  });

  it("retries transcript directory durability on a later append", () => {
    const dataDir = makeDataDir();
    new TranscriptStore(dataDir);
    let directorySyncs = 0;
    const store = new TranscriptStore(dataDir, {
      syncDirectory: (descriptor) => {
        directorySyncs += 1;
        if (directorySyncs === 1) throw new Error("synthetic first directory sync failure");
        fsyncSync(descriptor);
      },
    });

    expect(() => store.appendCompletedTurn(turn("directory-retry", "turn-1"))).toThrow(
      "synthetic first directory sync failure",
    );
    store.appendCompletedTurn(turn("directory-retry", "turn-2"));

    expect(directorySyncs).toBe(2);
    expect(store.readCurrentConversation("directory-retry").map((record) => record.turnId)).toEqual(
      ["turn-1", "turn-2"],
    );
  });

  it("fails an append when its pathname is replaced during the write", () => {
    const dataDir = makeDataDir();
    const chatId = "write-path-replacement";
    const path = transcriptPath(dataDir, chatId);
    const originalPath = `${path}.original`;
    new TranscriptStore(dataDir).appendCompletedTurn(turn(chatId, "turn-1"));
    let replaced = false;
    const store = new TranscriptStore(dataDir, {
      write: (descriptor, buffer, offset, length, position) => {
        if (!replaced) {
          replaced = true;
          renameSync(path, originalPath);
          writeFileSync(path, "synthetic replacement\n", { mode: 0o600 });
        }
        return writeSync(descriptor, buffer, offset, length, position);
      },
    });

    expect(() => store.appendCompletedTurn(turn(chatId, "turn-2"))).toThrow(
      UnsafeTranscriptTargetError,
    );
    expect(readFileSync(path, "utf8")).toBe("synthetic replacement\n");
    expect(readFileSync(path, "utf8")).not.toContain("turn-2");
    expect(readFileSync(originalPath, "utf8")).toContain('"turnId":"turn-2"');
  });
});

describe("TranscriptStore private race-checked targets", () => {
  it("creates exact 0700/0600 storage and strict owner-only reset intents", () => {
    const dataDir = makeDataDir();
    const store = new TranscriptStore(dataDir);
    store.appendCompletedTurn(turn("mode", "turn-1"));
    store.createResetIntent(intent("intent-mode"));

    expect(lstatSync(join(dataDir, "transcripts")).mode & 0o7777).toBe(0o700);
    expect(lstatSync(transcriptPath(dataDir, "mode")).mode & 0o7777).toBe(0o600);
    const intentStats = lstatSync(intentPath(dataDir, "intent-mode"));
    expect(intentStats.mode & 0o7777).toBe(0o600);
    expect(intentStats.nlink).toBe(1);
    expect(store.readResetIntent("intent-mode")).toEqual(intent("intent-mode"));
    expect(JSON.parse(readFileSync(intentPath(dataDir, "intent-mode"), "utf8"))).toEqual(
      intent("intent-mode"),
    );
  });

  it("rejects a non-strict or wrong-version reset intent", () => {
    const dataDir = makeDataDir();
    const store = new TranscriptStore(dataDir);
    const reset = intent("invalid-intent");
    writeFileSync(
      intentPath(dataDir, reset.chatId),
      `${JSON.stringify({ ...reset, version: 2, extra: true })}\n`,
      { mode: 0o600 },
    );

    expect(() => store.readResetIntent(reset.chatId)).toThrow(UnsafeTranscriptTargetError);
    expect(() => store.listResetIntents()).toThrow(UnsafeTranscriptTargetError);
  });

  it("refuses permissive existing targets without chmodding them", () => {
    const dataDir = makeDataDir();
    const store = new TranscriptStore(dataDir);
    const path = transcriptPath(dataDir, "permissions");
    writeFileSync(path, "outside\n", { mode: 0o644 });
    chmodSync(path, 0o644);

    expect(() => store.appendCompletedTurn(turn("permissions", "turn-1"))).toThrow(
      UnsafeTranscriptTargetError,
    );
    expect(() => store.readCurrentConversation("permissions")).toThrow(UnsafeTranscriptTargetError);
    expect(lstatSync(path).mode & 0o7777).toBe(0o644);
    expect(readFileSync(path, "utf8")).toBe("outside\n");
  });

  it("refuses symlink, hardlink, and non-regular transcript targets", () => {
    const dataDir = makeDataDir();
    const store = new TranscriptStore(dataDir);
    const outside = join(dataDir, "outside.jsonl");
    writeFileSync(outside, "outside\n", { mode: 0o600 });

    symlinkSync(outside, transcriptPath(dataDir, "linked"));
    linkSync(outside, transcriptPath(dataDir, "hardlinked"));
    mkdirSync(transcriptPath(dataDir, "directory"), { mode: 0o600 });

    for (const chatId of ["linked", "hardlinked", "directory"]) {
      expect(() => store.appendCompletedTurn(turn(chatId, "turn-1"))).toThrow(
        UnsafeTranscriptTargetError,
      );
      expect(() => store.readCurrentConversation(chatId)).toThrow(UnsafeTranscriptTargetError);
    }
    expect(readFileSync(outside, "utf8")).toBe("outside\n");
    expect(lstatSync(outside).mode & 0o7777).toBe(0o600);
    expect(lstatSync(outside).nlink).toBe(2);
  });

  it("detects a target identity substitution between lstat and open", () => {
    const dataDir = makeDataDir();
    const path = transcriptPath(dataDir, "swap-file");
    let swapped = false;
    const store = new TranscriptStore(dataDir, {
      beforeExistingFileOpen: (openedPath) => {
        if (openedPath !== path || swapped) return;
        swapped = true;
        renameSync(path, `${path}.original`);
        writeFileSync(path, "replacement\n", { mode: 0o600 });
      },
    });
    store.appendCompletedTurn(turn("swap-file", "turn-1"));

    expect(() => store.readCurrentConversation("swap-file")).toThrow(UnsafeTranscriptTargetError);
    expect(readFileSync(`${path}.original`, "utf8")).toContain("turn-1");
    expect(readFileSync(path, "utf8")).toBe("replacement\n");
  });

  it("detects directory mode drift and never repairs it", () => {
    const dataDir = makeDataDir();
    const store = new TranscriptStore(dataDir);
    const directory = join(dataDir, "transcripts");
    store.appendCompletedTurn(turn("mode-drift", "turn-1"));
    const path = transcriptPath(dataDir, "mode-drift");
    const before = readFileSync(path);
    chmodSync(directory, 0o755);

    expect(() => store.readCurrentConversation("mode-drift")).toThrow(UnsafeTranscriptTargetError);
    expect(() => store.appendCompletedTurn(turn("mode-drift", "turn-2"))).toThrow(
      UnsafeTranscriptTargetError,
    );
    expect(readFileSync(path)).toEqual(before);
    expect(lstatSync(directory).mode & 0o7777).toBe(0o755);
  });

  it("detects a transcript directory swapped between operations", () => {
    const dataDir = makeDataDir();
    const store = new TranscriptStore(dataDir);
    const directory = join(dataDir, "transcripts");
    store.appendCompletedTurn(turn("directory-swap", "turn-1"));
    const original = readFileSync(transcriptPath(dataDir, "directory-swap"));
    renameSync(directory, `${directory}.original`);
    mkdirSync(directory, { mode: 0o700 });

    expect(() => store.readCurrentConversation("directory-swap")).toThrow(
      UnsafeTranscriptTargetError,
    );
    expect(() => store.appendCompletedTurn(turn("directory-swap", "turn-2"))).toThrow(
      UnsafeTranscriptTargetError,
    );
    expect(
      readFileSync(
        join(
          `${directory}.original`,
          `${createHash("sha256").update("directory-swap").digest("hex")}.jsonl`,
        ),
      ),
    ).toEqual(original);
    expect(readdirSync(directory)).toEqual([]);
  });

  it("detects a directory swap after a child is opened and before any append", () => {
    const dataDir = makeDataDir();
    const directory = join(dataDir, "transcripts");
    let swapped = false;
    const store = new TranscriptStore(dataDir, {
      afterChildOpen: () => {
        if (swapped) return;
        swapped = true;
        renameSync(directory, `${directory}.original`);
        mkdirSync(directory, { mode: 0o700 });
      },
    });

    expect(() => store.appendCompletedTurn(turn("mid-open-swap", "turn-1"))).toThrow(
      UnsafeTranscriptTargetError,
    );
    expect(readdirSync(`${directory}.original`)).toHaveLength(1);
    const name = readdirSync(`${directory}.original`)[0];
    expect(readFileSync(join(`${directory}.original`, name))).toHaveLength(0);
  });

  it("hardens an existing permissive transcript directory to 0700 and uses it", () => {
    const dataDir = makeDataDir();
    const directory = join(dataDir, "transcripts");
    mkdirSync(directory, { mode: 0o755 });
    chmodSync(directory, 0o755);
    expect(lstatSync(directory).mode & 0o7777).toBe(0o755);

    const store = new TranscriptStore(dataDir);
    store.appendCompletedTurn(turn("permissive-dir", "turn-1"));

    expect(lstatSync(directory).mode & 0o7777).toBe(0o700);
    expect(store.readCurrentConversation("permissive-dir").map((record) => record.turnId)).toEqual([
      "turn-1",
    ]);
  });

  it("refuses a symlink transcript directory without following or repairing it", () => {
    const dataDir = makeDataDir();
    const outside = join(dataDir, "outside");
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, join(dataDir, "transcripts"));

    expect(() => new TranscriptStore(dataDir)).toThrow(UnsafeTranscriptTargetError);
    expect(lstatSync(join(dataDir, "transcripts")).isSymbolicLink()).toBe(true);
    expect(lstatSync(outside).mode & 0o7777).toBe(0o700);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("refuses a pre-existing unsafe reset-intent target without overwriting it", () => {
    const dataDir = makeDataDir();
    const store = new TranscriptStore(dataDir);
    const reset = intent("unsafe-intent", RESET_ID_B);
    const target = intentPath(dataDir, reset.chatId);
    writeFileSync(target, "pre-existing\n", { mode: 0o644 });

    expect(() => store.createResetIntent(reset)).toThrow(UnsafeTranscriptTargetError);
    expect(readFileSync(target, "utf8")).toBe("pre-existing\n");
    expect(lstatSync(target).mode & 0o7777).toBe(0o644);
  });

  it("refuses a pre-existing symlink reset-intent temp without following it", () => {
    const dataDir = makeDataDir();
    const store = new TranscriptStore(dataDir);
    const reset = intent("unsafe-temp", RESET_ID_B);
    const outside = join(dataDir, "outside-intent.json");
    writeFileSync(outside, "outside\n", { mode: 0o600 });
    const digest = createHash("sha256").update(reset.chatId, "utf8").digest("hex");
    const temp = join(dataDir, "transcripts", `${digest}.${reset.resetId}.reset-intent.tmp`);
    symlinkSync(outside, temp);

    expect(() => store.createResetIntent(reset)).toThrow(UnsafeTranscriptTargetError);
    expect(readFileSync(outside, "utf8")).toBe("outside\n");
    expect(lstatSync(temp).isSymbolicLink()).toBe(true);
  });

  it("refuses a hardlinked reset-intent target", () => {
    const dataDir = makeDataDir();
    const store = new TranscriptStore(dataDir);
    const reset = intent("hardlinked-intent");
    store.createResetIntent(reset);
    linkSync(intentPath(dataDir, reset.chatId), join(dataDir, "shared-intent.json"));

    expect(() => store.readResetIntent(reset.chatId)).toThrow(UnsafeTranscriptTargetError);
  });
});

describe("TranscriptStore Windows private paths", () => {
  it("persists and reopens transcript records through injected Windows semantics", () => {
    const dataDir = makeDataDir();
    const first = new TranscriptStore(dataDir, { platform: "win32" });
    first.appendCompletedTurn(turn("restart", "turn-1"));

    const reopened = new TranscriptStore(dataDir, { platform: "win32" });

    expect(reopened.readCurrentConversation("restart").map((record) => record.turnId)).toEqual([
      "turn-1",
    ]);
  });

  it.runIf(process.platform !== "win32")(
    "does not inspect or repair POSIX modes under injected Windows semantics",
    () => {
      const dataDir = makeDataDir();
      const directory = join(dataDir, "transcripts");
      mkdirSync(directory, { mode: 0o755 });
      chmodSync(directory, 0o755);
      const path = transcriptPath(dataDir, "mode");
      writeFileSync(path, serializedTurn(turn("mode", "turn-1")), { mode: 0o644 });
      chmodSync(path, 0o644);

      const store = new TranscriptStore(dataDir, { platform: "win32" });

      expect(store.readCurrentConversation("mode").map((record) => record.turnId)).toEqual([
        "turn-1",
      ]);
      expect(lstatSync(directory).mode & 0o7777).toBe(0o755);
      expect(lstatSync(path).mode & 0o7777).toBe(0o644);
    },
  );

  it("rejects a replaced transcript directory as path-free corruption", () => {
    const dataDir = makeDataDir();
    const store = new TranscriptStore(dataDir, { platform: "win32" });
    store.appendCompletedTurn(turn("directory-swap", "turn-1"));
    const directory = join(dataDir, "transcripts");
    renameSync(directory, `${directory}.original`);
    mkdirSync(directory, { mode: 0o700 });

    let failure: unknown;
    try {
      store.readCurrentConversation("directory-swap");
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(WindowsPrivatePathPolicyError);
    expect(failure).toMatchObject({ stage: "binding-check", category: "corruption" });
    expect(failure).not.toHaveProperty("path");
    expect(failure).not.toHaveProperty("cause");
    expect(String(failure)).not.toContain(directory);
    expect(JSON.stringify(failure)).not.toContain(directory);
  });

  it("classifies an incomplete Windows content write without swallowing it", () => {
    const dataDir = makeDataDir();
    const path = transcriptPath(dataDir, "short-write");
    const store = new TranscriptStore(dataDir, {
      platform: "win32",
      write: () => 0,
    });

    let failure: unknown;
    try {
      store.appendCompletedTurn(turn("short-write", "turn-1"));
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(WindowsPrivatePathPolicyError);
    expect(failure).toMatchObject({ stage: "content-write", category: "io-failure" });
    expect(failure).not.toHaveProperty("path");
    expect(failure).not.toHaveProperty("cause");
    expect(String(failure)).not.toContain(path);
    expect(JSON.stringify(failure)).not.toContain(path);
  });

  it("rejects an oversized Windows transcript before allocating its contents", () => {
    const dataDir = makeDataDir();
    const chatId = "oversized";
    const store = new TranscriptStore(dataDir, { platform: "win32" });
    store.appendCompletedTurn(turn(chatId, "turn-1"));
    const path = transcriptPath(dataDir, chatId);
    truncateSync(path, MAX_TRANSCRIPT_FILE_BYTES + 1);

    let failure: unknown;
    try {
      store.readCurrentConversation(chatId);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(WindowsPrivatePathPolicyError);
    expect(failure).toMatchObject({ stage: "read-check", category: "corruption" });
    expect(failure).not.toHaveProperty("path");
    expect(failure).not.toHaveProperty("cause");
    expect(String(failure)).not.toContain(path);
    expect(JSON.stringify(failure)).not.toContain(path);
    expect(lstatSync(path).size).toBe(MAX_TRANSCRIPT_FILE_BYTES + 1);
  });

  it("rejects malformed Windows transcript content without appending to it", () => {
    const dataDir = makeDataDir();
    const chatId = "corrupt-transcript";
    const store = new TranscriptStore(dataDir, { platform: "win32" });
    const path = transcriptPath(dataDir, chatId);
    const corrupt = "{not-valid-json}\n";
    writeFileSync(path, corrupt, { mode: 0o600 });

    let readFailure: unknown;
    try {
      store.readCurrentConversation(chatId);
    } catch (error) {
      readFailure = error;
    }
    let appendFailure: unknown;
    try {
      store.appendCompletedTurn(turn(chatId, "turn-1"));
    } catch (error) {
      appendFailure = error;
    }

    expect(readFailure).toBeInstanceOf(WindowsPrivatePathPolicyError);
    expect(readFailure).toMatchObject({ stage: "read-check", category: "corruption" });
    expect(appendFailure).toBeInstanceOf(WindowsPrivatePathPolicyError);
    expect(appendFailure).toMatchObject({ stage: "read-check", category: "corruption" });
    expect(String(readFailure)).not.toContain(path);
    expect(String(appendFailure)).not.toContain(path);
    expect(readFileSync(path, "utf8")).toBe(corrupt);
  });

  it("rejects duplicate Windows reset boundaries on every transcript read", () => {
    const dataDir = makeDataDir();
    const chatId = "duplicate-boundary";
    const store = new TranscriptStore(dataDir, { platform: "win32" });
    const reset = intent(chatId);
    const boundary = `${JSON.stringify({
      version: 1,
      kind: "conversation-boundary",
      resetId: reset.resetId,
      chatId,
      boundaryAt: reset.boundaryAt,
      reason: reset.reason,
    })}\n`;
    const path = transcriptPath(dataDir, chatId);
    writeFileSync(path, boundary + boundary, { mode: 0o600 });

    let failure: unknown;
    try {
      store.readCurrentConversation(chatId);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(WindowsPrivatePathPolicyError);
    expect(failure).toMatchObject({ stage: "read-check", category: "corruption" });
    expect(failure).not.toHaveProperty("path");
    expect(failure).not.toHaveProperty("cause");
    expect(String(failure)).not.toContain(path);
    expect(JSON.stringify(failure)).not.toContain(path);
    expect(readFileSync(path, "utf8")).toBe(boundary + boundary);
  });

  it("classifies directory sync as unavailable while retaining file flushes", () => {
    const dataDir = makeDataDir();
    let directorySyncs = 0;
    let fileSyncs = 0;
    const store = new TranscriptStore(dataDir, {
      platform: "win32",
      syncDirectory: () => {
        directorySyncs += 1;
        throw new Error("Windows directory sync hook must not run");
      },
      syncFile: (descriptor) => {
        fileSyncs += 1;
        fsyncSync(descriptor);
      },
    });

    store.appendCompletedTurn(turn("durable", "turn-1"));

    expect(directorySyncs).toBe(0);
    expect(fileSyncs).toBe(1);
    expect(
      new TranscriptStore(dataDir, { platform: "win32" })
        .readCurrentConversation("durable")
        .map((record) => record.turnId),
    ).toEqual(["turn-1"]);
  });

  it("reopens an existing boundary with a writable Windows flush handle", () => {
    const dataDir = makeDataDir();
    const reset = intent("writable-flush");
    const first = new TranscriptStore(dataDir, { platform: "win32" });
    first.appendCompletedTurn(turn(reset.chatId, "turn-1"));
    first.createResetIntent(reset);
    first.ensureConversationBoundary(reset);
    let syncs = 0;
    const reopened = new TranscriptStore(dataDir, {
      platform: "win32",
      syncFile: (descriptor) => {
        syncs += 1;
        const firstByte = Buffer.allocUnsafe(1);
        expect(readSync(descriptor, firstByte, 0, 1, 0)).toBe(1);
        expect(writeSync(descriptor, firstByte, 0, 1, 0)).toBe(1);
        fsyncSync(descriptor);
      },
    });

    reopened.ensureConversationBoundary(reset);

    expect(syncs).toBe(1);
    expect(reopened.hasConversationBoundary(reset.chatId, reset.resetId)).toBe(true);
  });

  it("rejects malformed reset state as path-free corruption", () => {
    const dataDir = makeDataDir();
    const store = new TranscriptStore(dataDir, { platform: "win32" });
    const path = intentPath(dataDir, "corrupt-intent");
    writeFileSync(path, "{not-valid-json}\n", { mode: 0o644 });

    let failure: unknown;
    try {
      store.readResetIntent("corrupt-intent");
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(WindowsPrivatePathPolicyError);
    expect(failure).toMatchObject({ stage: "read-check", category: "corruption" });
    expect(failure).not.toHaveProperty("path");
    expect(failure).not.toHaveProperty("cause");
    expect(String(failure)).not.toContain(path);
    expect(JSON.stringify(failure)).not.toContain(path);
    expect(readFileSync(path, "utf8")).toBe("{not-valid-json}\n");
  });

  it("removes a malformed single-link orphan reset temp during recovery", () => {
    const dataDir = makeDataDir();
    const reset = intent("corrupt-orphan-temp");
    const digest = createHash("sha256").update(reset.chatId, "utf8").digest("hex");
    const path = join(dataDir, "transcripts", `${digest}.${reset.resetId}.reset-intent.tmp`);
    const store = new TranscriptStore(dataDir, { platform: "win32" });
    writeFileSync(path, "{not-valid-json}\n", { mode: 0o600 });

    expect(store.readResetIntent(reset.chatId)).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  it("does not swallow a Windows sharing violation during file flush", () => {
    const dataDir = makeDataDir();
    const path = transcriptPath(dataDir, "locked");
    const store = new TranscriptStore(dataDir, {
      platform: "win32",
      syncFile: () => {
        throw Object.assign(new Error(`locked ${path}`), { code: "EACCES", path });
      },
    });

    let failure: unknown;
    try {
      store.appendCompletedTurn(turn("locked", "turn-1"));
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(WindowsPrivatePathPolicyError);
    expect(failure).toMatchObject({ stage: "file-flush", category: "sharing-violation" });
    expect(failure).not.toHaveProperty("path");
    expect(failure).not.toHaveProperty("cause");
    expect(String(failure)).not.toContain(path);
    expect(JSON.stringify(failure)).not.toContain(path);
  });
});
