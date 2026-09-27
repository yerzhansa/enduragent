import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  CHAT_ATTACHMENT_LIMITS,
  ChatQueueSnapshotSchema,
  type ChatQueueSnapshot,
  type QueuedChatMessage,
} from "@enduragent/coach-contract";
import { z } from "zod";
import {
  assertWindowsPrivateDirectoryStable,
  assertWindowsPrivateFileBinding,
  assertWindowsPrivateFileMetadata,
  assertWindowsPrivatePathRead,
  bindWindowsPrivateDirectory,
  classifyWindowsPrivatePathFailure,
  sameWindowsPrivatePathIdentity,
  windowsPrivatePathIdentity,
  type WindowsPrivateDirectoryBinding,
} from "../io/windows-private-path-policy.js";

const LegacyStoredItemSchema = z
  .object({
    queuedMessageId: z.string().min(1),
    submissionId: z.string().min(1),
    text: z.string().refine((value) => /\S/u.test(value)),
    kind: z.enum(["ordinary", "slash-command"]),
  })
  .strict();

const StoredItemSchema = z
  .object({
    queuedMessageId: z.string().min(1),
    submissionId: z.string().min(1),
    messageId: z.string().min(1),
    text: z.string(),
    kind: z.enum(["ordinary", "slash-command"]),
    attachmentIds: z.array(z.string().min(1)).max(CHAT_ATTACHMENT_LIMITS.attachmentsPerMessage),
  })
  .strict()
  .superRefine((value, context) => {
    if (!/\S/u.test(value.text) && value.attachmentIds.length === 0) {
      context.addIssue({ code: "custom", path: ["text"], message: "queued item is empty" });
    }
    if (new Set(value.attachmentIds).size !== value.attachmentIds.length) {
      context.addIssue({
        code: "custom",
        path: ["attachmentIds"],
        message: "attachment ids must be unique",
      });
    }
    if (value.kind === "slash-command" && value.attachmentIds.length !== 0) {
      context.addIssue({
        code: "custom",
        path: ["attachmentIds"],
        message: "slash commands are text-only",
      });
    }
  });

const StoredClaimSchema = z
  .object({
    claimId: z.string().min(1),
    queuedMessageIds: z.array(z.string().min(1)).min(1),
    turnId: z.string().min(1),
    status: z.enum(["claimed", "retry-required"]),
  })
  .strict();

function validateQueueHead(
  value: {
    readonly items: readonly { readonly queuedMessageId: string; readonly submissionId: string }[];
    readonly claim?: z.infer<typeof StoredClaimSchema>;
  },
  context: z.RefinementCtx,
): void {
  const ids = value.items.map((item) => item.queuedMessageId);
  const submissions = value.items.map((item) => item.submissionId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["items"], message: "duplicate queue ids" });
  }
  if (new Set(submissions).size !== submissions.length) {
    context.addIssue({ code: "custom", path: ["items"], message: "duplicate submissions" });
  }
  if (
    value.claim !== undefined &&
    (value.claim.queuedMessageIds.length > ids.length ||
      value.claim.queuedMessageIds.some((id, index) => id !== ids[index]))
  ) {
    context.addIssue({ code: "custom", path: ["claim"], message: "claim is not queue head" });
  }
}

const LegacyStoredQueueSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    items: z.array(LegacyStoredItemSchema),
    claim: StoredClaimSchema.optional(),
  })
  .strict()
  .superRefine(validateQueueHead);

const StoredQueueSchema = z
  .object({
    schemaVersion: z.literal(2),
    revision: z.number().int().nonnegative(),
    items: z.array(StoredItemSchema),
    claim: StoredClaimSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    validateQueueHead(value, context);
    const messageIds = value.items.map((item) => item.messageId);
    if (new Set(messageIds).size !== messageIds.length) {
      context.addIssue({ code: "custom", path: ["items"], message: "duplicate message ids" });
    }
  });

type StoredQueue = z.infer<typeof StoredQueueSchema>;
type StoredClaim = z.infer<typeof StoredClaimSchema>;

export interface ChatQueueStoreHooks {
  readonly afterFileOpen?: (path: string, descriptor: number) => void;
  readonly afterFileRead?: (path: string, descriptor: number) => void;
}

function emptyQueue(): StoredQueue {
  return { schemaVersion: 2, revision: 0, items: [] };
}

function parseStoredQueue(value: unknown): StoredQueue {
  const current = StoredQueueSchema.safeParse(value);
  if (current.success) return current.data;
  const legacy = LegacyStoredQueueSchema.parse(value);
  return StoredQueueSchema.parse({
    schemaVersion: 2,
    revision: legacy.revision,
    items: legacy.items.map((item) => ({
      ...item,
      messageId: item.queuedMessageId,
      attachmentIds: [],
    })),
    ...(legacy.claim === undefined ? {} : { claim: legacy.claim }),
  });
}

function safeName(chatId: string): string {
  return `${createHash("sha256").update(chatId).digest("hex")}.json`;
}

export class ChatQueueStore {
  private readonly directory: string;
  private readonly windowsDirectoryBinding: WindowsPrivateDirectoryBinding | undefined;
  private readonly freshIds = new Set<string>();

  constructor(
    dataDir: string,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly hooks: ChatQueueStoreHooks = {},
  ) {
    this.directory = join(dataDir, "chat-queues");
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw this.platform === "win32"
        ? classifyWindowsPrivatePathFailure("entry-check", error)
        : error;
    }
    if (this.platform === "win32") {
      this.windowsDirectoryBinding = bindWindowsPrivateDirectory(dataDir, this.directory);
      return;
    }
    this.windowsDirectoryBinding = undefined;
    const stats = lstatSync(this.directory);
    if (!stats.isDirectory() || stats.isSymbolicLink())
      throw new Error("Chat queue directory is unsafe.");
    if ((stats.mode & 0o7777) !== 0o700) {
      const descriptor = openSync(
        this.directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        fchmodSync(descriptor, 0o700);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    }
  }

  get(chatId: string): ChatQueueSnapshot {
    return this.snapshot(this.read(chatId));
  }

  enqueue(
    chatId: string,
    submissionId: string,
    text: string,
    queuedMessageId: string,
    messageId = queuedMessageId,
    attachmentIds: readonly string[] = [],
  ): ChatQueueSnapshot {
    const state = this.read(chatId);
    const duplicate = state.items.find((item) => item.submissionId === submissionId);
    if (duplicate !== undefined) return this.snapshot(state);
    const item = StoredItemSchema.parse({
      queuedMessageId,
      messageId,
      submissionId,
      text,
      kind: /^\s*\//u.test(text) ? ("slash-command" as const) : ("ordinary" as const),
      attachmentIds: [...attachmentIds],
    });
    this.freshIds.add(queuedMessageId);
    return this.commit(chatId, {
      ...state,
      revision: state.revision + 1,
      items: [...state.items, item],
    });
  }

  remove(chatId: string, queuedMessageId: string): ChatQueueSnapshot {
    const state = this.read(chatId);
    if (state.claim?.queuedMessageIds.includes(queuedMessageId) === true) {
      throw new Error("A claimed queued message cannot be removed.");
    }
    const items = state.items.filter((item) => item.queuedMessageId !== queuedMessageId);
    if (items.length === state.items.length) return this.snapshot(state);
    this.freshIds.delete(queuedMessageId);
    return this.commit(chatId, { ...state, revision: state.revision + 1, items });
  }

  claim(chatId: string, claim: Omit<StoredClaim, "status">): ChatQueueSnapshot {
    const state = this.read(chatId);
    if (state.claim !== undefined) throw new Error("The chat queue already has a claim.");
    const actual = state.items
      .slice(0, claim.queuedMessageIds.length)
      .map((item) => item.queuedMessageId);
    if (actual.join("\u0000") !== claim.queuedMessageIds.join("\u0000")) {
      throw new Error("The queue head changed before it could be claimed.");
    }
    return this.commit(chatId, {
      ...state,
      revision: state.revision + 1,
      claim: { ...claim, status: "claimed" },
    });
  }

  complete(chatId: string, claimId: string): ChatQueueSnapshot {
    const state = this.read(chatId);
    if (state.claim?.claimId !== claimId)
      throw new Error("The queue claim changed before completion.");
    const claimed = new Set(state.claim.queuedMessageIds);
    const items = state.items.filter((item) => !claimed.has(item.queuedMessageId));
    state.claim.queuedMessageIds.forEach((id) => this.freshIds.delete(id));
    return this.commit(chatId, { schemaVersion: 2, revision: state.revision + 1, items });
  }

  requireRetry(chatId: string, claimId: string): ChatQueueSnapshot {
    const state = this.read(chatId);
    if (state.claim?.claimId !== claimId)
      throw new Error("The queue claim changed before recovery.");
    if (state.claim.status === "retry-required") return this.snapshot(state);
    return this.commit(chatId, {
      ...state,
      revision: state.revision + 1,
      claim: { ...state.claim, status: "retry-required" },
    });
  }

  retry(chatId: string, claimId: string, turnId: string): ChatQueueSnapshot {
    const state = this.read(chatId);
    if (state.claim?.claimId !== claimId || state.claim.status !== "retry-required") {
      throw new Error("The recovery claim changed before retry.");
    }
    return this.commit(chatId, {
      ...state,
      revision: state.revision + 1,
      claim: { ...state.claim, turnId, status: "claimed" },
    });
  }

  clear(chatId: string): ChatQueueSnapshot {
    const state = this.read(chatId);
    if (state.items.length === 0 && state.claim === undefined) return this.snapshot(state);
    state.items.forEach((item) => this.freshIds.delete(item.queuedMessageId));
    return this.commit(chatId, { schemaVersion: 2, revision: state.revision + 1, items: [] });
  }

  reconcile(chatId: string, completedTurnIds: ReadonlySet<string>): ChatQueueSnapshot {
    const state = this.read(chatId);
    if (state.claim === undefined) return this.snapshot(state);
    return completedTurnIds.has(state.claim.turnId)
      ? this.complete(chatId, state.claim.claimId)
      : state.claim.status === "claimed"
        ? this.requireRetry(chatId, state.claim.claimId)
        : this.snapshot(state);
  }

  getCompletedClaim(
    chatId: string,
    completedTurnIds: ReadonlySet<string>,
  ): { readonly turnId: string; readonly messageIds: readonly string[] } | null {
    const state = this.read(chatId);
    if (state.claim === undefined || !completedTurnIds.has(state.claim.turnId)) return null;
    const claimedIds = new Set(state.claim.queuedMessageIds);
    return {
      turnId: state.claim.turnId,
      messageIds: state.items
        .filter((item) => claimedIds.has(item.queuedMessageId))
        .map((item) => item.messageId),
    };
  }

  private snapshot(state: StoredQueue): ChatQueueSnapshot {
    const items: QueuedChatMessage[] = state.items.map((item, position) => ({
      ...item,
      position,
      restored: !this.freshIds.has(item.queuedMessageId),
    }));
    return ChatQueueSnapshotSchema.parse({
      schemaVersion: 1,
      revision: state.revision,
      items,
      ...(state.claim?.status === "retry-required" ? { retryRequired: state.claim } : {}),
    });
  }

  private read(chatId: string): StoredQueue {
    const path = join(this.directory, safeName(chatId));
    if (this.platform === "win32") {
      assertWindowsPrivateDirectoryStable(this.windowsDirectoryBinding!);
    }
    let descriptor: number;
    try {
      descriptor = openSync(
        path,
        constants.O_RDONLY | (this.platform === "win32" ? 0 : constants.O_NOFOLLOW),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (this.platform === "win32") {
          assertWindowsPrivateDirectoryStable(this.windowsDirectoryBinding!);
        }
        return emptyQueue();
      }
      throw error;
    }
    try {
      this.hooks.afterFileOpen?.(path, descriptor);
      const before = fstatSync(descriptor);
      if (
        !before.isFile() ||
        (this.platform !== "win32" && ((before.mode & 0o7777) !== 0o600 || before.nlink !== 1))
      ) {
        throw new Error("Chat queue file is unsafe.");
      }
      if (this.platform === "win32") {
        assertWindowsPrivateFileMetadata(before);
        assertWindowsPrivateFileBinding(
          this.windowsDirectoryBinding!,
          path,
          windowsPrivatePathIdentity(before),
        );
      }
      const contents = readFileSync(descriptor, "utf8");
      this.hooks.afterFileRead?.(path, descriptor);
      let parsed: StoredQueue;
      try {
        parsed = parseStoredQueue(JSON.parse(contents));
      } catch (error) {
        if (this.platform === "win32") {
          assertWindowsPrivatePathRead({
            bounded: true,
            identityStable: true,
            contentValid: false,
            authenticatedHomeBinding: true,
          });
        }
        throw error;
      }
      if (this.platform === "win32") {
        const after = fstatSync(descriptor);
        assertWindowsPrivateFileMetadata(after);
        const current = assertWindowsPrivateFileBinding(
          this.windowsDirectoryBinding!,
          path,
          windowsPrivatePathIdentity(after),
        );
        assertWindowsPrivatePathRead({
          bounded: Number.isSafeInteger(before.size) && before.size >= 0,
          identityStable:
            sameWindowsPrivatePathIdentity(
              windowsPrivatePathIdentity(before),
              windowsPrivatePathIdentity(after),
            ) &&
            before.size === after.size &&
            before.size === current.size &&
            before.mtimeMs === after.mtimeMs &&
            before.mtimeMs === current.mtimeMs &&
            before.ctimeMs === after.ctimeMs &&
            before.ctimeMs === current.ctimeMs,
          contentValid: true,
          authenticatedHomeBinding: true,
        });
        assertWindowsPrivateDirectoryStable(this.windowsDirectoryBinding!);
      }
      return parsed;
    } finally {
      closeSync(descriptor);
    }
  }

  private commit(chatId: string, state: StoredQueue): ChatQueueSnapshot {
    const parsed = StoredQueueSchema.parse(state);
    const path = join(this.directory, safeName(chatId));
    const temporary = `${path}.${randomBytes(16).toString("hex")}.tmp`;
    let descriptor: number | undefined;
    try {
      if (this.platform === "win32") {
        assertWindowsPrivateDirectoryStable(this.windowsDirectoryBinding!);
      }
      descriptor = openSync(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      writeFileSync(descriptor, `${JSON.stringify(parsed)}\n`, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      if (this.platform === "win32") {
        const temporaryMetadata = lstatSync(temporary);
        assertWindowsPrivateFileMetadata(temporaryMetadata);
        assertWindowsPrivateFileBinding(
          this.windowsDirectoryBinding!,
          temporary,
          windowsPrivatePathIdentity(temporaryMetadata),
        );
      }
      renameSync(temporary, path);
      if (this.platform === "win32") {
        const targetMetadata = lstatSync(path);
        assertWindowsPrivateFileMetadata(targetMetadata);
        assertWindowsPrivateFileBinding(
          this.windowsDirectoryBinding!,
          path,
          windowsPrivatePathIdentity(targetMetadata),
        );
        assertWindowsPrivateDirectoryStable(this.windowsDirectoryBinding!);
      } else {
        const directoryDescriptor = openSync(
          this.directory,
          constants.O_RDONLY | constants.O_DIRECTORY,
        );
        try {
          fsyncSync(directoryDescriptor);
        } finally {
          closeSync(directoryDescriptor);
        }
      }
      return this.snapshot(parsed);
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(temporary, { force: true });
      throw error;
    }
  }
}
