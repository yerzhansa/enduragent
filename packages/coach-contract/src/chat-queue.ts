import { z } from "zod";
import { ChatResponseSchema } from "./engine.js";
import { TurnRefusalSchema } from "./spend.js";
import { CHAT_ATTACHMENT_LIMITS } from "./chat-attachment.js";

const AttachmentIdsSchema = z
  .array(z.string().min(1))
  .max(CHAT_ATTACHMENT_LIMITS.attachmentsPerMessage)
  .refine((value) => new Set(value).size === value.length, "attachment ids must be unique");

export const QueuedChatMessageSchema = z
  .object({
    queuedMessageId: z.string().min(1),
    messageId: z.string().min(1),
    submissionId: z.string().min(1),
    text: z.string(),
    kind: z.enum(["ordinary", "slash-command"]),
    attachmentIds: AttachmentIdsSchema,
    position: z.number().int().nonnegative(),
    restored: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!/\S/u.test(value.text) && value.attachmentIds.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["text"],
        message: "queued message cannot be empty",
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
export type QueuedChatMessage = z.infer<typeof QueuedChatMessageSchema>;

export const ChatQueueRecoveryClaimSchema = z
  .object({
    claimId: z.string().min(1),
    queuedMessageIds: z.array(z.string().min(1)).min(1),
    turnId: z.string().min(1),
    status: z.literal("retry-required"),
  })
  .strict();
export type ChatQueueRecoveryClaim = z.infer<typeof ChatQueueRecoveryClaimSchema>;

export const ChatQueueSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    items: z.array(QueuedChatMessageSchema),
    retryRequired: ChatQueueRecoveryClaimSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    const messageIds = new Set<string>();
    const submissions = new Set<string>();
    value.items.forEach((item, index) => {
      if (item.position !== index) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "position"],
          message: "queue position must match FIFO order",
        });
      }
      if (ids.has(item.queuedMessageId)) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "queuedMessageId"],
          message: "queued message ids must be unique",
        });
      }
      if (submissions.has(item.submissionId)) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "submissionId"],
          message: "submission ids must be unique",
        });
      }
      if (messageIds.has(item.messageId)) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "messageId"],
          message: "message ids must be unique",
        });
      }
      ids.add(item.queuedMessageId);
      messageIds.add(item.messageId);
      submissions.add(item.submissionId);
    });
    if (value.retryRequired !== undefined) {
      const expected = value.items
        .slice(0, value.retryRequired.queuedMessageIds.length)
        .map((item) => item.queuedMessageId);
      if (
        expected.length !== value.retryRequired.queuedMessageIds.length ||
        expected.some((id, index) => id !== value.retryRequired?.queuedMessageIds[index])
      ) {
        context.addIssue({
          code: "custom",
          path: ["retryRequired", "queuedMessageIds"],
          message: "retry claim must own an exact queue-head prefix",
        });
      }
    }
  });
export type ChatQueueSnapshot = z.infer<typeof ChatQueueSnapshotSchema>;

export const EnqueueChatMessageRequestSchema = z
  .object({
    chatId: z.string().min(1),
    submissionId: z.string().min(1),
    text: z.string(),
    attachmentIds: AttachmentIdsSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!/\S/u.test(value.text) && (value.attachmentIds?.length ?? 0) === 0) {
      context.addIssue({
        code: "custom",
        path: ["text"],
        message: "Chat Send cannot be empty",
      });
    }
    if (/^\s*\//u.test(value.text) && (value.attachmentIds?.length ?? 0) !== 0) {
      context.addIssue({
        code: "custom",
        path: ["attachmentIds"],
        message: "slash commands are text-only",
      });
    }
  });
export type EnqueueChatMessageRequest = z.infer<typeof EnqueueChatMessageRequestSchema>;

export const GetChatQueueRequestSchema = z.object({ chatId: z.string().min(1) }).strict();
export type GetChatQueueRequest = z.infer<typeof GetChatQueueRequestSchema>;

export const RemoveQueuedChatMessageRequestSchema = z
  .object({ chatId: z.string().min(1), queuedMessageId: z.string().min(1) })
  .strict();
export type RemoveQueuedChatMessageRequest = z.infer<typeof RemoveQueuedChatMessageRequestSchema>;

export const ResumeChatQueueRequestSchema = GetChatQueueRequestSchema;
export type ResumeChatQueueRequest = z.infer<typeof ResumeChatQueueRequestSchema>;

export const RunQueuedCommandRequestSchema = z
  .object({ chatId: z.string().min(1), queuedMessageId: z.string().min(1) })
  .strict();
export type RunQueuedCommandRequest = z.infer<typeof RunQueuedCommandRequestSchema>;

export const RetryQueuedTurnRequestSchema = z
  .object({ chatId: z.string().min(1), claimId: z.string().min(1) })
  .strict();
export type RetryQueuedTurnRequest = z.infer<typeof RetryQueuedTurnRequestSchema>;

export const ChatQueueRunResultSchema = z
  .object({
    snapshot: ChatQueueSnapshotSchema,
    response: ChatResponseSchema.optional(),
    refusal: TurnRefusalSchema.optional(),
  })
  .strict();
export type ChatQueueRunResult = z.infer<typeof ChatQueueRunResultSchema>;
