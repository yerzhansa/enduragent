import { z } from "zod";
import { AthleteStateSchema } from "./athlete-state.js";
import { isActiveIanaZone } from "./time-zone.js";
import {
  ChatRequestSchema,
  ChatResponseSchema,
  HasSessionRequestSchema,
  HasSessionResponseSchema,
  ResetSessionRequestSchema,
  ResetSessionResponseSchema,
  StopChatRequestSchema,
  StopChatResponseSchema,
  type CoachEngine,
} from "./engine.js";
import { TurnEventSchema, type TurnEvent } from "./turn-event.js";
import { PlatformAbsolutePathSchema } from "./platform-path.js";
import { PlanHandoffSuggestionSchema, PlanReferenceSelectionSchema } from "./plan-chat-card.js";
import {
  AdmitPastedChatAttachmentRequestSchema,
  AdmitChatAttachmentRequestSchema,
  AttachmentAdmissionReadModelSchema,
  ChatAttachmentComposerReadModelSchema,
  ChatAttachmentReferenceSchema,
  ChatAttachmentMutationRequestSchema,
  ClearChatAttachmentDraftRequestSchema,
  GetChatAttachmentComposerRequestSchema,
  SaveChatAttachmentDraftTextRequestSchema,
  SelectChatAttachmentWorkoutRequestSchema,
  type AdmitPastedChatAttachmentRequest,
  type AdmitChatAttachmentRequest,
  type AttachmentAdmissionReadModel,
  type ChatAttachmentComposerReadModel,
  type ChatAttachmentMutationRequest,
  type ClearChatAttachmentDraftRequest,
  type GetChatAttachmentComposerRequest,
  type SaveChatAttachmentDraftTextRequest,
  type SelectChatAttachmentWorkoutRequest,
} from "./chat-attachment.js";
import {
  AnswerCoachDecisionRpcParamsSchema,
  AnswerCoachDecisionRpcResultSchema,
  GetCoachDecisionRpcParamsSchema,
  GetCoachDecisionRpcResultSchema,
  ResumeCoachDecisionRpcParamsSchema,
  ResumeCoachDecisionRpcResultSchema,
  SkipCoachDecisionRpcParamsSchema,
  SkipCoachDecisionRpcResultSchema,
  CoachDecisionAnswerSchema,
  CoachDecisionContinuationLineageSchema,
  CoachDecisionReadModelSchema,
  type AnswerCoachDecisionRpcParams,
  type AnswerCoachDecisionRpcResult,
  type GetCoachDecisionRpcParams,
  type GetCoachDecisionRpcResult,
  type ResumeCoachDecisionRpcParams,
  type ResumeCoachDecisionRpcResult,
  type SkipCoachDecisionRpcParams,
  type SkipCoachDecisionRpcResult,
} from "./coach-decision.js";
import {
  GetSpendSummaryRpcParamsSchema,
  SetDailySpendCapRpcParamsSchema,
  SpendSummarySchema,
  type SpendOperations,
} from "./spend.js";
import {
  SelfTestRpcParamsSchema,
  SelfTestRpcResultSchema,
  type SelfTestRpcResult,
} from "./self-test.js";
import {
  ActivityAnalysisRequestSchema,
  ActivityAnalysisResultSchema,
  type ActivityAnalysisRequest,
  type ActivityAnalysisResult,
} from "./activity-analysis.js";
import {
  ExportTrainingFileRpcParamsSchema,
  ExportTrainingFileRpcResultSchema,
  type ExportTrainingFileRpcParams,
  type ExportTrainingFileRpcResult,
} from "./training-export.js";
import {
  ConfigureTelegramRpcParamsSchema,
  DeleteTelegramWebhookRpcParamsSchema,
  InspectTelegramCredentialRpcParamsSchema,
  ReplaceTelegramRpcParamsSchema,
  TelegramAllowedSenderRpcParamsSchema,
  TelegramAllowedSendersMutationResultSchema,
  TelegramAllowedSendersResultSchema,
  TelegramControlMutationResultSchema,
  TelegramControlSnapshotSchema,
  TelegramCredentialInspectionSchema,
  type ConfigureTelegramRpcParams,
  type DeleteTelegramWebhookRpcParams,
  type InspectTelegramCredentialRpcParams,
  type ReplaceTelegramRpcParams,
  type TelegramAllowedSenderRpcParams,
  type TelegramAllowedSendersMutationResult,
  type TelegramAllowedSendersResult,
  type TelegramControlMutationResult,
  type TelegramControlSnapshot,
  type TelegramCredentialInspection,
} from "./telegram-control.js";
import {
  ExecutePlanTransitionRpcParamsSchema,
  ExecutePlanTransitionRpcResultSchema,
  GetPlanStateRpcParamsSchema,
  GetPlanStateRpcResultSchema,
  PlanProgressEventSchema,
  type PlanningOperations,
} from "./planning.js";
import {
  ChatQueueRunResultSchema,
  ChatQueueSnapshotSchema,
  EnqueueChatMessageRequestSchema,
  GetChatQueueRequestSchema,
  RemoveQueuedChatMessageRequestSchema,
  ResumeChatQueueRequestSchema,
  RetryQueuedTurnRequestSchema,
  RunQueuedCommandRequestSchema,
} from "./chat-queue.js";
import {
  GetPlanningReadModelRpcParamsSchema,
  GetPlanningReadModelRpcResultSchema,
  type PlanningReadOperations,
} from "./planning-read.js";
import {
  CreatePlanningRequestRpcParamsSchema,
  CreatePlanningRequestRpcResultSchema,
  CreateWorkoutPlanningRequestRpcParamsSchema,
  CreateWorkoutPlanningRequestRpcResultSchema,
  GetPlanningRequestRpcParamsSchema,
  GetPlanningRequestRpcResultSchema,
  ListPlanningRequestsRpcParamsSchema,
  ListPlanningRequestsRpcResultSchema,
  ResumePlanningRequestsRpcParamsSchema,
  ResumePlanningRequestsRpcResultSchema,
  RetryPlanningRequestRpcParamsSchema,
  RetryPlanningRequestRpcResultSchema,
  type PlanningRequestOperations,
} from "./planning-request.js";
import {
  PlanCreationAnswerRpcParamsSchema,
  PlanCreationAnswerRpcResultSchema,
  PlanCreationStartRpcParamsSchema,
  PlanCreationStartRpcResultSchema,
  type PlanCreationOperations,
} from "./plan-creation.js";

export const JsonValueSchema = z.json();
export type JsonValue = z.infer<typeof JsonValueSchema>;

export const JsonRpcIdSchema = z.union([
  z.string().min(1),
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
]);
export type JsonRpcId = z.infer<typeof JsonRpcIdSchema>;

export const JsonRpcErrorObjectSchema = z
  .object({
    code: z.number().int(),
    message: z.string(),
    data: JsonValueSchema.optional(),
  })
  .strict();
export type JsonRpcErrorObject = z.infer<typeof JsonRpcErrorObjectSchema>;

export const JsonRpcRequestEnvelopeSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: JsonRpcIdSchema,
    method: z.string().min(1),
    params: JsonValueSchema,
  })
  .strict();
export type JsonRpcRequestEnvelope = z.infer<typeof JsonRpcRequestEnvelopeSchema>;

export const JsonRpcSuccessResponseEnvelopeSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: JsonRpcIdSchema,
    result: JsonValueSchema,
  })
  .strict();
export type JsonRpcSuccessResponseEnvelope = z.infer<typeof JsonRpcSuccessResponseEnvelopeSchema>;

export const JsonRpcErrorResponseEnvelopeSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: JsonRpcIdSchema,
    error: JsonRpcErrorObjectSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.error.code === -32700) {
      context.addIssue({
        code: "custom",
        path: ["error", "code"],
        message: "parse error must use an unrecoverable null id",
      });
    }
  });
export type JsonRpcErrorResponseEnvelope = z.infer<typeof JsonRpcErrorResponseEnvelopeSchema>;

export const JsonRpcProtocolErrorCodeSchema = z.union([z.literal(-32700), z.literal(-32600)]);
export type JsonRpcProtocolErrorCode = z.infer<typeof JsonRpcProtocolErrorCodeSchema>;

export const JsonRpcProtocolErrorObjectSchema = JsonRpcErrorObjectSchema.extend({
  code: JsonRpcProtocolErrorCodeSchema,
}).strict();
export type JsonRpcProtocolErrorObject = z.infer<typeof JsonRpcProtocolErrorObjectSchema>;

export const JsonRpcProtocolErrorResponseEnvelopeSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.null(),
    error: JsonRpcProtocolErrorObjectSchema,
  })
  .strict();
export type JsonRpcProtocolErrorResponseEnvelope = z.infer<
  typeof JsonRpcProtocolErrorResponseEnvelopeSchema
>;

export const JsonRpcResponseEnvelopeSchema = z.union([
  JsonRpcSuccessResponseEnvelopeSchema,
  JsonRpcErrorResponseEnvelopeSchema,
  JsonRpcProtocolErrorResponseEnvelopeSchema,
]);
export type JsonRpcResponseEnvelope = z.infer<typeof JsonRpcResponseEnvelopeSchema>;

export const JsonRpcNotificationEnvelopeSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    method: z.string().min(1),
    params: JsonValueSchema,
  })
  .strict();
export type JsonRpcNotificationEnvelope = z.infer<typeof JsonRpcNotificationEnvelopeSchema>;

export const COACH_RPC_METHOD_NAMES = [
  "chat",
  "stopChat",
  "admitChatAttachment",
  "admitPastedChatAttachment",
  "getChatAttachmentComposer",
  "saveChatAttachmentDraftText",
  "removeChatAttachment",
  "retryChatAttachment",
  "selectChatAttachmentWorkout",
  "clearChatAttachmentDraft",
  "enqueueChatMessage",
  "getChatQueue",
  "removeQueuedChatMessage",
  "resumeChatQueue",
  "runQueuedCommand",
  "retryQueuedTurn",
  "resetSession",
  "hasSession",
  "getCoachDecision",
  "answerCoachDecision",
  "skipCoachDecision",
  "resumeCoachDecision",
  "getTranscriptPage",
  "listArchivedConversations",
  "deleteArchivedConversation",
  "getArchivedTranscriptPage",
  "getAthleteState",
  "getPlanningReadModel",
  "getActivityAnalysis",
  "exportTrainingFile",
  "importFiles",
  "sync",
  "getSetupStatus",
  "saveIntake",
  "configureRuntime",
  "verify_intervals_credential",
  "getRuntimeConfig",
  "getUnitsPreference",
  "setUnitsPreference",
  "configureTelegram",
  "enableTelegram",
  "disableTelegram",
  "suspendTelegramPolling",
  "resumeTelegramPolling",
  "drainTelegram",
  "replaceTelegram",
  "getTelegramStatus",
  "reconcileTelegram",
  "inspectTelegramCredential",
  "deleteTelegramWebhook",
  "forgetTelegramCredential",
  "resetTelegramAccess",
  "beginTelegramPairing",
  "cancelTelegramPairing",
  "listTelegramAllowedSenders",
  "addTelegramAllowedSender",
  "removeTelegramAllowedSender",
  "getSpendSummary",
  "setDailySpendCap",
  "selfTest",
  "getPlanState",
  "executePlanTransition",
  "createPlanningRequest",
  "createWorkoutPlanningRequest",
  "getPlanningRequest",
  "retryPlanningRequest",
  "resumePlanningRequests",
  "listPlanningRequests",
  "plan_creation.start",
  "plan_creation.answer",
] as const satisfies readonly (keyof CoachRpcService)[];

export const CoachRpcMethodNameSchema = z.enum(COACH_RPC_METHOD_NAMES);
export type CoachRpcMethodName = z.infer<typeof CoachRpcMethodNameSchema>;

export const COACH_TURN_EVENT_NOTIFICATION_METHOD = "coach.turnEvent" as const;

export const ChatRpcParamsSchema = ChatRequestSchema.superRefine((value, context) => {
  if (!JsonValueSchema.safeParse(value).success) {
    context.addIssue({
      code: "custom",
      message: "chat params must contain only JSON values",
    });
  }
});
export type ChatRpcParams = z.infer<typeof ChatRpcParamsSchema>;

export const EmptyRpcParamsSchema = z.object({}).strict();
export type EmptyRpcParams = z.infer<typeof EmptyRpcParamsSchema>;

export const MAX_TRANSCRIPT_PAGE_TURNS = 50;
export const MAX_TRANSCRIPT_PAGE_RESPONSE_BYTES = 266_240;
export const MAX_ARCHIVED_CONVERSATION_ENTRIES = 200;
const TRANSCRIPT_CURSOR_LENGTH = 152;
const TRANSCRIPT_CURSOR_PATTERN = /^[A-Za-z0-9_-]{152}$/;
const TRANSCRIPT_CURSOR_VERSION = 1;
const ARCHIVED_TRANSCRIPT_CURSOR_VERSION = 2;
const BOUNDARY_REF_PATTERN = /^[a-f0-9]{64}$/;
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const RPC_TEXT_ENCODER = new TextEncoder();

function decodedBase64Url(value: string): Uint8Array | null {
  let accumulator = 0;
  let bits = 0;
  const decoded: number[] = [];
  for (const character of value) {
    const digit = BASE64URL_ALPHABET.indexOf(character);
    if (digit < 0) return null;
    accumulator = (accumulator << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      decoded.push((accumulator >> bits) & 0xff);
      accumulator &= (1 << bits) - 1;
    }
  }
  return bits === 0 ? Uint8Array.from(decoded) : null;
}

function safeCursorOffset(bytes: Uint8Array, offset: number): number | null {
  let value = 0;
  for (let index = offset; index < offset + 8; index += 1) {
    value = value * 256 + bytes[index]!;
    if (!Number.isSafeInteger(value)) return null;
  }
  return value;
}

function validCursorVersion(value: string, version: number, archived: boolean): boolean {
  if (value.length !== TRANSCRIPT_CURSOR_LENGTH || !TRANSCRIPT_CURSOR_PATTERN.test(value)) {
    return false;
  }
  const bytes = decodedBase64Url(value);
  if (bytes === null || bytes.length !== 114 || bytes[0] !== version) return false;
  const fenceKind = bytes[1];
  if (fenceKind !== 0 && fenceKind !== 1) return false;
  if (archived && fenceKind !== 1) return false;
  if (fenceKind === 0 && bytes.slice(34, 66).some((byte) => byte !== 0)) return false;
  const snapshotEnd = safeCursorOffset(bytes, 98);
  const before = safeCursorOffset(bytes, 106);
  return snapshotEnd !== null && before !== null && before <= snapshotEnd;
}

export const TranscriptCursorSchema = z
  .string()
  .length(TRANSCRIPT_CURSOR_LENGTH)
  .regex(TRANSCRIPT_CURSOR_PATTERN)
  .refine((value) => validCursorVersion(value, TRANSCRIPT_CURSOR_VERSION, false));
export type TranscriptCursor = z.infer<typeof TranscriptCursorSchema>;

export const ArchivedTranscriptCursorSchema = z
  .string()
  .length(TRANSCRIPT_CURSOR_LENGTH)
  .regex(TRANSCRIPT_CURSOR_PATTERN)
  .refine((value) => validCursorVersion(value, ARCHIVED_TRANSCRIPT_CURSOR_VERSION, true));
export type ArchivedTranscriptCursor = z.infer<typeof ArchivedTranscriptCursorSchema>;

export const ArchivedConversationBoundaryRefSchema = z
  .string()
  .length(64)
  .regex(BOUNDARY_REF_PATTERN);
export type ArchivedConversationBoundaryRef = z.infer<typeof ArchivedConversationBoundaryRefSchema>;

export const GetTranscriptPageRpcParamsSchema = z
  .object({
    cursor: TranscriptCursorSchema.nullable(),
    limit: z.number().int().min(1).max(MAX_TRANSCRIPT_PAGE_TURNS),
  })
  .strict();
export type GetTranscriptPageRpcParams = z.infer<typeof GetTranscriptPageRpcParamsSchema>;

export const GetArchivedTranscriptPageRpcParamsSchema = z
  .object({
    boundaryRef: ArchivedConversationBoundaryRefSchema,
    cursor: ArchivedTranscriptCursorSchema.nullable(),
    limit: z.number().int().min(1).max(MAX_TRANSCRIPT_PAGE_TURNS),
  })
  .strict();
export type GetArchivedTranscriptPageRpcParams = z.infer<
  typeof GetArchivedTranscriptPageRpcParamsSchema
>;

function canonicalTranscriptTimestamp(value: string): boolean {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

export const TranscriptPageTurnSchema = z
  .object({
    turnId: z.string().min(1),
    completedAt: z.string().refine(canonicalTranscriptTimestamp),
    athleteText: z.string(),
    coachText: z.string(),
    delivery: z.literal("interrupted").optional(),
    attachments: z.array(ChatAttachmentReferenceSchema).max(5).optional(),
    planReference: PlanReferenceSelectionSchema.optional(),
    planHandoff: PlanHandoffSuggestionSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.delivery === "interrupted" &&
      (value.planReference !== undefined || value.planHandoff !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["planHandoff"],
        message: "interrupted turns cannot carry Plan metadata",
      });
    }
  });
export type TranscriptPageTurn = z.infer<typeof TranscriptPageTurnSchema>;

export const TranscriptPageEntrySchema = z.discriminatedUnion("kind", [
  TranscriptPageTurnSchema.extend({ kind: z.literal("turn") }).strict(),
  z
    .object({
      kind: z.literal("decision-requested"),
      recordedAt: z.string().refine(canonicalTranscriptTimestamp),
      athleteText: z.string(),
      decision: CoachDecisionReadModelSchema,
    })
    .strict()
    .superRefine((value, context) => {
      if (value.decision.status !== "unanswered") {
        context.addIssue({
          code: "custom",
          path: ["decision", "status"],
          message: "decision request entry requires an unanswered decision",
        });
      }
    }),
  z
    .object({
      kind: z.literal("decision-answered"),
      recordedAt: z.string().refine(canonicalTranscriptTimestamp),
      decisionId: z.string().min(1),
      answer: CoachDecisionAnswerSchema,
      consequence: z.string().min(1).max(2_000),
      continuationId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("decision-skipped"),
      recordedAt: z.string().refine(canonicalTranscriptTimestamp),
      decisionId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("decision-abandoned"),
      recordedAt: z.string().refine(canonicalTranscriptTimestamp),
      decisionId: z.string().min(1),
      reason: z.literal("new_conversation"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("decision-continuation-completed"),
      recordedAt: z.string().refine(canonicalTranscriptTimestamp),
      completedAt: z.string().refine(canonicalTranscriptTimestamp),
      decisionId: z.string().min(1),
      continuationId: z.string().min(1),
      turnId: z.string().min(1),
      coachText: z.string(),
      lineage: CoachDecisionContinuationLineageSchema.optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.recordedAt !== value.completedAt) {
        context.addIssue({
          code: "custom",
          path: ["completedAt"],
          message: "continuation completion timestamps must match",
        });
      }
    }),
]);
export type TranscriptPageEntry = z.infer<typeof TranscriptPageEntrySchema>;

function transcriptPageResultSchema(cursorSchema: z.ZodType<string, string>) {
  return z
    .union([
      z
        .object({
          schemaVersion: z.literal(1),
          status: z.literal("page"),
          turns: z.array(TranscriptPageTurnSchema).max(MAX_TRANSCRIPT_PAGE_TURNS),
          nextCursor: cursorSchema.nullable(),
        })
        .strict()
        .superRefine((value, context) => {
          if (value.turns.length === 0 && value.nextCursor !== null) {
            context.addIssue({
              code: "custom",
              path: ["nextCursor"],
              message: "empty transcript page cannot continue",
            });
          }
        }),
      z
        .object({
          schemaVersion: z.literal(2),
          status: z.literal("page"),
          turns: z.array(TranscriptPageTurnSchema).max(MAX_TRANSCRIPT_PAGE_TURNS),
          entries: z.array(TranscriptPageEntrySchema).max(MAX_TRANSCRIPT_PAGE_TURNS),
          nextCursor: cursorSchema.nullable(),
        })
        .strict()
        .superRefine((value, context) => {
          if (value.entries.length === 0 && value.nextCursor !== null) {
            context.addIssue({
              code: "custom",
              path: ["nextCursor"],
              message: "empty transcript page cannot continue",
            });
          }
          const projectedTurns = value.entries.filter((entry) => entry.kind === "turn");
          if (
            JSON.stringify(projectedTurns.map(({ kind: _kind, ...turn }) => turn)) !==
            JSON.stringify(value.turns)
          ) {
            context.addIssue({
              code: "custom",
              path: ["turns"],
              message: "turns must match turn entries",
            });
          }
        }),
      z
        .object({
          schemaVersion: z.literal(1),
          status: z.literal("restart-required"),
          turns: z.array(TranscriptPageTurnSchema).length(0),
          nextCursor: z.null(),
        })
        .strict(),
    ])
    .superRefine((value, context) => {
      if (
        RPC_TEXT_ENCODER.encode(JSON.stringify(value)).byteLength >
        MAX_TRANSCRIPT_PAGE_RESPONSE_BYTES
      ) {
        context.addIssue({ code: "custom", message: "transcript page exceeds response budget" });
      }
    });
}

export const GetTranscriptPageRpcResultSchema = transcriptPageResultSchema(TranscriptCursorSchema);
export type GetTranscriptPageRpcResult = z.infer<typeof GetTranscriptPageRpcResultSchema>;

export const GetArchivedTranscriptPageRpcResultSchema = transcriptPageResultSchema(
  ArchivedTranscriptCursorSchema,
);
export type GetArchivedTranscriptPageRpcResult = z.infer<
  typeof GetArchivedTranscriptPageRpcResultSchema
>;

export const ArchivedConversationSummarySchema = z
  .object({
    boundaryRef: ArchivedConversationBoundaryRefSchema,
    boundaryAt: z.string().refine(canonicalTranscriptTimestamp),
    reason: z.enum(["explicit-reset", "stale-reset"]),
    turnCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type ArchivedConversationSummary = z.infer<typeof ArchivedConversationSummarySchema>;

export const ListArchivedConversationsRpcParamsSchema = EmptyRpcParamsSchema;
export type ListArchivedConversationsRpcParams = z.infer<
  typeof ListArchivedConversationsRpcParamsSchema
>;

export const ListArchivedConversationsRpcResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    conversations: z
      .array(ArchivedConversationSummarySchema)
      .max(MAX_ARCHIVED_CONVERSATION_ENTRIES),
    truncated: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    const refs = new Set(value.conversations.map((entry) => entry.boundaryRef));
    if (refs.size !== value.conversations.length) {
      context.addIssue({
        code: "custom",
        path: ["conversations"],
        message: "boundary references must be unique",
      });
    }
    if (value.truncated && value.conversations.length < MAX_ARCHIVED_CONVERSATION_ENTRIES) {
      context.addIssue({
        code: "custom",
        path: ["truncated"],
        message: "truncation requires a full page of conversations",
      });
    }
  });
export type ListArchivedConversationsRpcResult = z.infer<
  typeof ListArchivedConversationsRpcResultSchema
>;

export const DeleteArchivedConversationRpcParamsSchema = z
  .object({
    boundaryRef: ArchivedConversationBoundaryRefSchema,
  })
  .strict();
export type DeleteArchivedConversationRpcParams = z.infer<
  typeof DeleteArchivedConversationRpcParamsSchema
>;

export const DeleteArchivedConversationRpcResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(["deleted", "not-found"]),
  })
  .strict();
export type DeleteArchivedConversationRpcResult = z.infer<
  typeof DeleteArchivedConversationRpcResultSchema
>;

export const AbsoluteImportPathSchema = PlatformAbsolutePathSchema;

export const ImportFilesRpcParamsSchema = z
  .object({
    paths: z.array(AbsoluteImportPathSchema).min(1).max(256),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.paths).size !== value.paths.length) {
      context.addIssue({ code: "custom", path: ["paths"], message: "paths must be unique" });
    }
  });
export type ImportFilesRpcParams = z.infer<typeof ImportFilesRpcParamsSchema>;

export const ImportFilesRpcResultSchema = z
  .object({
    schemaVersion: z.literal(2),
    files: z
      .object({
        total: z.number().int().nonnegative(),
        imported: z.number().int().nonnegative(),
        quarantined: z.number().int().nonnegative(),
      })
      .strict(),
    changes: z
      .object({
        rawFilesInserted: z.number().int().nonnegative(),
        sourceRecordsInserted: z.number().int().nonnegative(),
        sourceRecordsUpdated: z.number().int().nonnegative(),
        relinkedSourceRecords: z.number().int().nonnegative(),
      })
      .strict(),
    publication: z
      .object({
        scope: z.literal("activities-and-streams"),
        status: z.enum(["available", "retryable-failure"]),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.files.imported + value.files.quarantined !== value.files.total) {
      context.addIssue({ code: "custom", path: ["files"], message: "file counts must balance" });
    }
  });
export type ImportFilesRpcResult = z.infer<typeof ImportFilesRpcResultSchema>;

export const SyncRpcParamsSchema = EmptyRpcParamsSchema;
export type SyncRpcParams = z.infer<typeof SyncRpcParamsSchema>;

export const SyncBackfillOutcomeSchema = z.enum([
  "completed",
  "skipped-no-credential",
  "pending-verification",
]);
export type SyncBackfillOutcome = z.infer<typeof SyncBackfillOutcomeSchema>;

export const ActivityRestrictionSchema = z
  .object({
    reason: z.literal("source-restricted"),
    source: z.string().min(1),
    count: z.number().int().positive(),
  })
  .strict();
export type ActivityRestriction = z.infer<typeof ActivityRestrictionSchema>;

export const ActivityRestrictionWindowSchema = z
  .object({
    total: z.number().int().nonnegative(),
    visible: z.number().int().nonnegative(),
    restrictions: z.array(ActivityRestrictionSchema),
    other: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    const restricted = value.restrictions.reduce((sum, entry) => sum + entry.count, 0);
    if (value.visible + restricted + value.other !== value.total) {
      context.addIssue({
        code: "custom",
        path: [],
        message: "activity counts must balance",
      });
    }
    for (let index = 1; index < value.restrictions.length; index += 1) {
      if (value.restrictions[index - 1]!.source >= value.restrictions[index]!.source) {
        context.addIssue({
          code: "custom",
          path: ["restrictions", index, "source"],
          message: "activity restriction sources must be unique and sorted",
        });
      }
    }
  });
export type ActivityRestrictionWindow = z.infer<typeof ActivityRestrictionWindowSchema>;

export const DroppedActivitiesSchema = z
  .object({
    overall: ActivityRestrictionWindowSchema,
    recent7Days: ActivityRestrictionWindowSchema,
  })
  .strict()
  .superRefine((value, context) => {
    for (const field of ["total", "visible", "other"] as const) {
      if (value.recent7Days[field] > value.overall[field]) {
        context.addIssue({
          code: "custom",
          path: ["recent7Days", field],
          message: "recent activity count cannot exceed overall activity count",
        });
      }
    }
    const overallBySource = new Map(
      value.overall.restrictions.map((entry) => [entry.source, entry.count]),
    );
    for (const entry of value.recent7Days.restrictions) {
      if (entry.count > (overallBySource.get(entry.source) ?? 0)) {
        context.addIssue({
          code: "custom",
          path: ["recent7Days", "restrictions"],
          message: "recent source restriction count cannot exceed its overall count",
        });
      }
    }
  });
export type DroppedActivities = z.infer<typeof DroppedActivitiesSchema>;

export const EMPTY_DROPPED_ACTIVITIES: DroppedActivities = Object.freeze({
  overall: Object.freeze({ total: 0, visible: 0, restrictions: [], other: 0 }),
  recent7Days: Object.freeze({ total: 0, visible: 0, restrictions: [], other: 0 }),
});

export const SyncRpcResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    backfill: SyncBackfillOutcomeSchema.optional(),
    published: z.boolean(),
    referenceSucceeded: z.boolean(),
    requests: z
      .object({
        store: z.number().int().nonnegative(),
        reference: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
      })
      .strict(),
    droppedActivities: DroppedActivitiesSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.requests.store + value.requests.reference !== value.requests.total) {
      context.addIssue({
        code: "custom",
        path: ["requests"],
        message: "request counts must balance",
      });
    }
  });
export type SyncRpcResult = z.infer<typeof SyncRpcResultSchema>;

export const InjuryStatusSchema = z.enum(["none", "managing", "returning"]);
export type InjuryStatus = z.infer<typeof InjuryStatusSchema>;

export const SaveIntakeRpcParamsSchema = z
  .object({
    swim_skill_floor: z.null(),
    continuous_distance_capable: z.null(),
    open_water_comfort: z.null(),
    prior_bsi: z.boolean(),
    clinician_cleared: z.boolean().nullable(),
    injury_status: InjuryStatusSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const couldBeAsked = value.prior_bsi || value.injury_status !== "none";
    if (!couldBeAsked && value.clinician_cleared !== null) {
      context.addIssue({
        code: "custom",
        path: ["clinician_cleared"],
        message: "clinician clearance must be null",
      });
    }
  });
export type SaveIntakeRpcParams = z.infer<typeof SaveIntakeRpcParamsSchema>;

export const GetSetupStatusRpcParamsSchema = EmptyRpcParamsSchema;
export type GetSetupStatusRpcParams = z.infer<typeof GetSetupStatusRpcParamsSchema>;

export const GetSetupStatusRpcResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    intake: SaveIntakeRpcParamsSchema.nullable(),
    durableTrainingData: z.boolean(),
  })
  .strict();
export type GetSetupStatusRpcResult = z.infer<typeof GetSetupStatusRpcResultSchema>;

export const SaveIntakeRpcResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    saved: z.literal(true),
  })
  .strict();
export type SaveIntakeRpcResult = z.infer<typeof SaveIntakeRpcResultSchema>;

export const LlmProviderSchema = z.enum([
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
]);
export type LlmProvider = z.infer<typeof LlmProviderSchema>;

export const KEYLESS_LLM_PROVIDERS = ["openai-codex", "claude-cli", "codex-agent"] as const;

export type KeylessLlmProvider = (typeof KEYLESS_LLM_PROVIDERS)[number];

export function isKeylessProvider(provider: string): provider is KeylessLlmProvider {
  return (KEYLESS_LLM_PROVIDERS as readonly string[]).includes(provider);
}

export const CODEX_AGENT_DISABLED_MESSAGE =
  "The Codex agent provider is not enabled on this instance (set llm.codex_agent.enabled: true in config.yaml). It is experimental and off by default.";

export const CODEX_AGENT_WINDOWS_MESSAGE =
  "The Codex agent provider is not supported on Windows yet (macOS and Linux only). Track the Windows lane in the project backlog.";

const RuntimeOptionalStringSchema = z.string().min(1).max(512).nullable();

const RuntimeClaudeCliSchema = z
  .object({
    enabled: z.boolean().optional(),
    binary_path: z.string().min(1).max(4_096).nullable().optional(),
    config_dir: z.string().min(1).max(4_096).nullable().optional(),
    billing: z.enum(["subscription", "api-key"]).optional(),
  })
  .strict();

const RuntimeCodexAgentSchema = z
  .object({
    enabled: z.boolean().optional(),
    binary_path: z.string().min(1).max(4_096).nullable().optional(),
    reasoning_effort: z.enum(["low", "medium", "high", "ultra"]).optional(),
  })
  .strict();

const RuntimeLlmSchema = z
  .object({
    provider: LlmProviderSchema.optional(),
    model: z.string().min(1).max(512).optional(),
    api_key: z.string().min(1).max(16_384).optional(),
    clear_credential: z.literal(true).optional(),
    base_url: z.string().min(1).max(4_096).nullable().optional(),
    flush_model: RuntimeOptionalStringSchema.optional(),
    compact_model: RuntimeOptionalStringSchema.optional(),
    claude_cli: RuntimeClaudeCliSchema.optional(),
    codex_agent: RuntimeCodexAgentSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.provider !== undefined &&
      isKeylessProvider(value.provider) &&
      value.api_key !== undefined
    ) {
      context.addIssue({ code: "custom", path: ["api_key"], message: "api_key must be absent" });
    }
    if (value.clear_credential === true) {
      if (value.provider === undefined) {
        context.addIssue({
          code: "custom",
          path: ["provider"],
          message: "provider is required for credential deletion",
        });
      }
      if (Object.keys(value).some((key) => key !== "provider" && key !== "clear_credential")) {
        context.addIssue({
          code: "custom",
          path: ["clear_credential"],
          message: "credential deletion must contain only provider and clear_credential",
        });
      }
    }
    if (Object.keys(value).length === 0) {
      context.addIssue({ code: "custom", message: "llm patch must not be empty" });
    }
  });

const RuntimeIntervalsSchema = z
  .object({
    api_key: z.string().min(1).max(16_384).optional(),
    clear_credential: z.literal(true).optional(),
    athlete_id: z.string().min(1).max(512).optional(),
    verification_approval: z
      .string()
      .length(64)
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.clear_credential === true && Object.keys(value).length !== 1) {
      context.addIssue({
        code: "custom",
        path: ["clear_credential"],
        message: "clear_credential must be the only intervals patch field",
      });
    }
    if (value.verification_approval !== undefined && value.api_key === undefined) {
      context.addIssue({
        code: "custom",
        path: ["verification_approval"],
        message: "verification_approval requires api_key",
      });
    }
    if (Object.keys(value).length === 0) {
      context.addIssue({ code: "custom", message: "intervals patch must not be empty" });
    }
  });

const RuntimeHistoryTokenBudgetRatioSchema = z.number().finite().positive().max(1);
const RuntimeNonnegativeSafeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const RuntimeDailyResetHourSchema = z.number().int().min(0).max(23);
const RuntimeTimezoneSchema = z.string().trim().min(1).max(512).refine(isActiveIanaZone);

const RuntimeSessionSchema = z
  .object({
    historyTokenBudgetRatio: RuntimeHistoryTokenBudgetRatioSchema.optional(),
    idleMinutes: RuntimeNonnegativeSafeIntegerSchema.optional(),
    dailyResetHour: RuntimeDailyResetHourSchema.optional(),
    resetArchiveRetentionDays: RuntimeNonnegativeSafeIntegerSchema.optional(),
    timezone: RuntimeTimezoneSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!Object.values(value).some((field) => field !== undefined)) {
      context.addIssue({ code: "custom", message: "session patch must not be empty" });
    }
  });

export const ConfigureRuntimeRpcParamsSchema = z
  .object({
    llm: RuntimeLlmSchema.optional(),
    intervals: RuntimeIntervalsSchema.optional(),
    session: RuntimeSessionSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.llm === undefined && value.intervals === undefined && value.session === undefined) {
      context.addIssue({ code: "custom", message: "at least one runtime slot is required" });
    }
    if (
      (value.llm?.clear_credential === true || value.intervals?.clear_credential === true) &&
      Object.keys(value).length !== 1
    ) {
      context.addIssue({
        code: "custom",
        message: "credential deletion must be the only runtime patch",
      });
    }
  });
export type ConfigureRuntimeRpcParams = z.infer<typeof ConfigureRuntimeRpcParamsSchema>;

export const ConfigureRuntimeRpcRefusalReasonSchema = z.enum([
  "credential-required",
  "ownership-unavailable",
  "training-account-mismatch",
  "managed-by-environment",
]);
export type ConfigureRuntimeRpcRefusalReason = z.infer<
  typeof ConfigureRuntimeRpcRefusalReasonSchema
>;

export const ConfigureRuntimeRpcResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      schemaVersion: z.literal(3),
      status: z.literal("applied"),
      applied: z
        .object({
          llm: z.boolean(),
          intervals: z.boolean(),
          session: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(3),
      status: z.literal("refused"),
      reason: ConfigureRuntimeRpcRefusalReasonSchema,
    })
    .strict(),
]);
export type ConfigureRuntimeRpcResult = z.infer<typeof ConfigureRuntimeRpcResultSchema>;

export const IntervalsCredentialVerificationRefusalReasonSchema = z.enum([
  "credential-rejected",
  "malformed-athlete-response",
  "validation-timeout",
  "validation-aborted",
  "validation-unavailable",
  "training-account-mismatch",
  "owner-unresolved",
  "store-unavailable",
]);
export type IntervalsCredentialVerificationRefusalReason = z.infer<
  typeof IntervalsCredentialVerificationRefusalReasonSchema
>;

export const IntervalsCredentialApprovalSchema = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/);
export type IntervalsCredentialApproval = z.infer<typeof IntervalsCredentialApprovalSchema>;

export const VerifyIntervalsCredentialRpcParamsSchema = z
  .object({
    api_key: z.string().min(1).max(16_384),
  })
  .strict();
export type VerifyIntervalsCredentialRpcParams = z.infer<
  typeof VerifyIntervalsCredentialRpcParamsSchema
>;

export const VerifyIntervalsCredentialRpcResultSchema = z.union([
  z.object({ approval: IntervalsCredentialApprovalSchema }).strict(),
  z.object({ reason: IntervalsCredentialVerificationRefusalReasonSchema }).strict(),
]);
export type VerifyIntervalsCredentialRpcResult = z.infer<
  typeof VerifyIntervalsCredentialRpcResultSchema
>;

export const RuntimeConfigSnapshotSchema = z
  .object({
    schemaVersion: z.literal(3),
    llm: z
      .object({
        provider: LlmProviderSchema,
        model: z.string().min(1).max(512),
        credential_configured: z.boolean(),
      })
      .strict(),
    intervals: z
      .object({
        athlete_id: z.string().max(512),
        credential_configured: z.boolean(),
        credential_verification_pending: z.boolean().optional(),
        managedByEnvironment: z
          .object({
            athleteId: z.boolean(),
          })
          .strict(),
      })
      .strict(),
    session: z
      .object({
        historyTokenBudgetRatio: RuntimeHistoryTokenBudgetRatioSchema,
        idleMinutes: RuntimeNonnegativeSafeIntegerSchema,
        dailyResetHour: RuntimeDailyResetHourSchema,
        resetArchiveRetentionDays: RuntimeNonnegativeSafeIntegerSchema,
        timezone: RuntimeTimezoneSchema,
        managedByEnvironment: z
          .object({
            historyTokenBudgetRatio: z.boolean(),
            idleMinutes: z.boolean(),
            dailyResetHour: z.boolean(),
            resetArchiveRetentionDays: z.boolean(),
            timezone: z.boolean(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
export type RuntimeConfigSnapshot = z.infer<typeof RuntimeConfigSnapshotSchema>;

export const GetRuntimeConfigRpcParamsSchema = EmptyRpcParamsSchema;
export type GetRuntimeConfigRpcParams = z.infer<typeof GetRuntimeConfigRpcParamsSchema>;
export const GetRuntimeConfigRpcResultSchema = RuntimeConfigSnapshotSchema;
export type GetRuntimeConfigRpcResult = z.infer<typeof GetRuntimeConfigRpcResultSchema>;

export const UnitsPreferenceSchema = z.enum(["metric", "imperial"]);
export type UnitsPreference = z.infer<typeof UnitsPreferenceSchema>;

export const GetUnitsPreferenceRpcParamsSchema = EmptyRpcParamsSchema;
export type GetUnitsPreferenceRpcParams = z.infer<typeof GetUnitsPreferenceRpcParamsSchema>;
export const GetUnitsPreferenceRpcResultSchema = z
  .object({
    value: UnitsPreferenceSchema,
    source: z.enum(["cycling", "athlete", "default"]),
  })
  .strict();
export type GetUnitsPreferenceRpcResult = z.infer<typeof GetUnitsPreferenceRpcResultSchema>;

export const SetUnitsPreferenceRpcParamsSchema = z
  .object({ value: UnitsPreferenceSchema })
  .strict();
export type SetUnitsPreferenceRpcParams = z.infer<typeof SetUnitsPreferenceRpcParamsSchema>;
export const SetUnitsPreferenceRpcResultSchema = z
  .object({ value: UnitsPreferenceSchema, source: z.literal("cycling") })
  .strict();
export type SetUnitsPreferenceRpcResult = z.infer<typeof SetUnitsPreferenceRpcResultSchema>;

export const OperationProgressEventSchema = z
  .object({
    phase: z.enum(["started", "completed"]),
    completed: z.number().int().nonnegative(),
    total: z.number().int().positive(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.completed > value.total) {
      context.addIssue({ code: "custom", path: ["completed"], message: "completed exceeds total" });
    }
    if (value.phase === "started" && value.completed !== 0) {
      context.addIssue({
        code: "custom",
        path: ["completed"],
        message: "started progress begins at zero",
      });
    }
    if (value.phase === "completed" && value.completed !== value.total) {
      context.addIssue({
        code: "custom",
        path: ["completed"],
        message: "completed progress reaches total",
      });
    }
  });
export type OperationProgressEvent = z.infer<typeof OperationProgressEventSchema>;

export interface CoachOperations {
  admitChatAttachment?(request: AdmitChatAttachmentRequest): Promise<AttachmentAdmissionReadModel>;
  admitPastedChatAttachment?(
    request: AdmitPastedChatAttachmentRequest,
  ): Promise<AttachmentAdmissionReadModel>;
  getChatAttachmentComposer?(
    request: GetChatAttachmentComposerRequest,
  ): Promise<ChatAttachmentComposerReadModel>;
  saveChatAttachmentDraftText?(
    request: SaveChatAttachmentDraftTextRequest,
  ): Promise<ChatAttachmentComposerReadModel>;
  removeChatAttachment?(
    request: ChatAttachmentMutationRequest,
  ): Promise<ChatAttachmentComposerReadModel>;
  retryChatAttachment?(
    request: ChatAttachmentMutationRequest,
  ): Promise<ChatAttachmentComposerReadModel>;
  selectChatAttachmentWorkout?(
    request: SelectChatAttachmentWorkoutRequest,
  ): Promise<ChatAttachmentComposerReadModel>;
  clearChatAttachmentDraft?(
    request: ClearChatAttachmentDraftRequest,
  ): Promise<ChatAttachmentComposerReadModel>;
  getActivityAnalysis?(
    request: ActivityAnalysisRequest,
    signal?: AbortSignal,
  ): Promise<ActivityAnalysisResult>;
  exportTrainingFile?(
    request: ExportTrainingFileRpcParams,
    signal?: AbortSignal,
  ): Promise<ExportTrainingFileRpcResult>;
  importFiles(
    request: ImportFilesRpcParams,
    onEvent?: (event: OperationProgressEvent) => void,
  ): Promise<ImportFilesRpcResult>;
  sync(
    request: SyncRpcParams,
    onEvent?: (event: OperationProgressEvent) => void,
  ): Promise<SyncRpcResult>;
  getSetupStatus?(request: GetSetupStatusRpcParams): Promise<GetSetupStatusRpcResult>;
  saveIntake(request: SaveIntakeRpcParams): Promise<SaveIntakeRpcResult>;
  getCoachDecision?(request: GetCoachDecisionRpcParams): Promise<GetCoachDecisionRpcResult>;
  answerCoachDecision?(
    request: AnswerCoachDecisionRpcParams,
    onEvent?: (event: TurnEvent) => void,
  ): Promise<AnswerCoachDecisionRpcResult>;
  skipCoachDecision?(request: SkipCoachDecisionRpcParams): Promise<SkipCoachDecisionRpcResult>;
  resumeCoachDecision?(
    request: ResumeCoachDecisionRpcParams,
    onEvent?: (event: TurnEvent) => void,
  ): Promise<ResumeCoachDecisionRpcResult>;
  getTranscriptPage(request: GetTranscriptPageRpcParams): Promise<GetTranscriptPageRpcResult>;
  listArchivedConversations(
    request: ListArchivedConversationsRpcParams,
  ): Promise<ListArchivedConversationsRpcResult>;
  deleteArchivedConversation(
    request: DeleteArchivedConversationRpcParams,
  ): Promise<DeleteArchivedConversationRpcResult>;
  getArchivedTranscriptPage(
    request: GetArchivedTranscriptPageRpcParams,
  ): Promise<GetArchivedTranscriptPageRpcResult>;
  configureRuntime(
    request: ConfigureRuntimeRpcParams,
    signal?: AbortSignal,
  ): Promise<ConfigureRuntimeRpcResult>;
  verify_intervals_credential?(
    request: VerifyIntervalsCredentialRpcParams,
    signal?: AbortSignal,
  ): Promise<VerifyIntervalsCredentialRpcResult>;
  getRuntimeConfig(request: GetRuntimeConfigRpcParams): Promise<GetRuntimeConfigRpcResult>;
  getUnitsPreference?(request: GetUnitsPreferenceRpcParams): Promise<GetUnitsPreferenceRpcResult>;
  setUnitsPreference?(request: SetUnitsPreferenceRpcParams): Promise<SetUnitsPreferenceRpcResult>;
}

export interface CoachSelfTestOperations {
  selfTest(onEvent?: (event: OperationProgressEvent) => void): Promise<SelfTestRpcResult>;
}

export interface TelegramControlOperations {
  configureTelegram(request: ConfigureTelegramRpcParams): Promise<TelegramControlMutationResult>;
  enableTelegram(request: EmptyRpcParams): Promise<TelegramControlSnapshot>;
  disableTelegram(request: EmptyRpcParams): Promise<TelegramControlSnapshot>;
  suspendTelegramPolling(request: EmptyRpcParams): Promise<TelegramControlSnapshot>;
  resumeTelegramPolling(request: EmptyRpcParams): Promise<TelegramControlSnapshot>;
  drainTelegram(request: EmptyRpcParams): Promise<TelegramControlSnapshot>;
  replaceTelegram(request: ReplaceTelegramRpcParams): Promise<TelegramControlMutationResult>;
  getTelegramStatus(request: EmptyRpcParams): Promise<TelegramControlSnapshot>;
  reconcileTelegram(request: EmptyRpcParams): Promise<TelegramControlSnapshot>;
  inspectTelegramCredential(
    request: InspectTelegramCredentialRpcParams,
  ): Promise<TelegramCredentialInspection>;
  deleteTelegramWebhook(
    request: DeleteTelegramWebhookRpcParams,
  ): Promise<TelegramCredentialInspection>;
  forgetTelegramCredential(request: EmptyRpcParams): Promise<TelegramControlSnapshot>;
  resetTelegramAccess(request: EmptyRpcParams): Promise<TelegramControlSnapshot>;
  beginTelegramPairing(request: EmptyRpcParams): Promise<TelegramControlSnapshot>;
  cancelTelegramPairing(request: EmptyRpcParams): Promise<TelegramControlSnapshot>;
  listTelegramAllowedSenders(request: EmptyRpcParams): Promise<TelegramAllowedSendersResult>;
  addTelegramAllowedSender(
    request: TelegramAllowedSenderRpcParams,
  ): Promise<TelegramAllowedSendersMutationResult>;
  removeTelegramAllowedSender(
    request: TelegramAllowedSenderRpcParams,
  ): Promise<TelegramAllowedSendersMutationResult>;
}

export type CoachRpcService = CoachEngine &
  CoachOperations &
  PlanningReadOperations &
  PlanningRequestOperations &
  PlanCreationOperations &
  SpendOperations &
  CoachSelfTestOperations &
  TelegramControlOperations &
  PlanningOperations;

export const CoachRpcRequestEnvelopeSchema = z.discriminatedUnion("method", [
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("chat"),
      params: ChatRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("stopChat"),
      params: StopChatRequestSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("admitChatAttachment"),
      params: AdmitChatAttachmentRequestSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("admitPastedChatAttachment"),
      params: AdmitPastedChatAttachmentRequestSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("getChatAttachmentComposer"),
      params: GetChatAttachmentComposerRequestSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("saveChatAttachmentDraftText"),
      params: SaveChatAttachmentDraftTextRequestSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("removeChatAttachment"),
      params: ChatAttachmentMutationRequestSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("retryChatAttachment"),
      params: ChatAttachmentMutationRequestSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("selectChatAttachmentWorkout"),
      params: SelectChatAttachmentWorkoutRequestSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("clearChatAttachmentDraft"),
      params: ClearChatAttachmentDraftRequestSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("enqueueChatMessage"),
      params: EnqueueChatMessageRequestSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("getChatQueue"),
      params: GetChatQueueRequestSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("removeQueuedChatMessage"),
      params: RemoveQueuedChatMessageRequestSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("resumeChatQueue"),
      params: ResumeChatQueueRequestSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("runQueuedCommand"),
      params: RunQueuedCommandRequestSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("retryQueuedTurn"),
      params: RetryQueuedTurnRequestSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("resetSession"),
      params: ResetSessionRequestSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("hasSession"),
      params: HasSessionRequestSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("getCoachDecision"),
      params: GetCoachDecisionRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("answerCoachDecision"),
      params: AnswerCoachDecisionRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("skipCoachDecision"),
      params: SkipCoachDecisionRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("resumeCoachDecision"),
      params: ResumeCoachDecisionRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("getTranscriptPage"),
      params: GetTranscriptPageRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("listArchivedConversations"),
      params: ListArchivedConversationsRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("deleteArchivedConversation"),
      params: DeleteArchivedConversationRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("getArchivedTranscriptPage"),
      params: GetArchivedTranscriptPageRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("getAthleteState"),
      params: EmptyRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("getPlanningReadModel"),
      params: GetPlanningReadModelRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("getActivityAnalysis"),
      params: ActivityAnalysisRequestSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("exportTrainingFile"),
      params: ExportTrainingFileRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("importFiles"),
      params: ImportFilesRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("sync"),
      params: SyncRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("getSetupStatus"),
      params: GetSetupStatusRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("saveIntake"),
      params: SaveIntakeRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("configureRuntime"),
      params: ConfigureRuntimeRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("verify_intervals_credential"),
      params: VerifyIntervalsCredentialRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("getRuntimeConfig"),
      params: GetRuntimeConfigRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("getUnitsPreference"),
      params: GetUnitsPreferenceRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("setUnitsPreference"),
      params: SetUnitsPreferenceRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("configureTelegram"),
      params: ConfigureTelegramRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("enableTelegram"),
      params: EmptyRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("disableTelegram"),
      params: EmptyRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("suspendTelegramPolling"),
      params: EmptyRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("resumeTelegramPolling"),
      params: EmptyRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("drainTelegram"),
      params: EmptyRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("replaceTelegram"),
      params: ReplaceTelegramRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("getTelegramStatus"),
      params: EmptyRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("reconcileTelegram"),
      params: EmptyRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("inspectTelegramCredential"),
      params: InspectTelegramCredentialRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("deleteTelegramWebhook"),
      params: DeleteTelegramWebhookRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("forgetTelegramCredential"),
      params: EmptyRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("resetTelegramAccess"),
      params: EmptyRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("beginTelegramPairing"),
      params: EmptyRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("cancelTelegramPairing"),
      params: EmptyRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("listTelegramAllowedSenders"),
      params: EmptyRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("addTelegramAllowedSender"),
      params: TelegramAllowedSenderRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("removeTelegramAllowedSender"),
      params: TelegramAllowedSenderRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("getSpendSummary"),
      params: GetSpendSummaryRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("setDailySpendCap"),
      params: SetDailySpendCapRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("selfTest"),
      params: SelfTestRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("getPlanState"),
      params: GetPlanStateRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("executePlanTransition"),
      params: ExecutePlanTransitionRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("createPlanningRequest"),
      params: CreatePlanningRequestRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("createWorkoutPlanningRequest"),
      params: CreateWorkoutPlanningRequestRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("getPlanningRequest"),
      params: GetPlanningRequestRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("retryPlanningRequest"),
      params: RetryPlanningRequestRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("resumePlanningRequests"),
      params: ResumePlanningRequestsRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("listPlanningRequests"),
      params: ListPlanningRequestsRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("plan_creation.start"),
      params: PlanCreationStartRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("plan_creation.answer"),
      params: PlanCreationAnswerRpcParamsSchema,
    })
    .strict(),
]);
export type CoachRpcRequestEnvelope = z.infer<typeof CoachRpcRequestEnvelopeSchema>;

export const CoachTurnEventNotificationEnvelopeSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    method: z.literal(COACH_TURN_EVENT_NOTIFICATION_METHOD),
    params: z
      .object({
        requestId: JsonRpcIdSchema,
        requestMethod: z.enum([
          "chat",
          "resumeChatQueue",
          "runQueuedCommand",
          "retryQueuedTurn",
          "answerCoachDecision",
          "resumeCoachDecision",
        ]),
        turnId: z.string().min(1),
        event: TurnEventSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.params.turnId !== value.params.event.turnId) {
      context.addIssue({
        code: "custom",
        path: ["params", "turnId"],
        message: "notification turnId must equal event.turnId",
      });
    }
  });
export type CoachTurnEventNotificationEnvelope = z.infer<
  typeof CoachTurnEventNotificationEnvelopeSchema
>;

export const COACH_OPERATION_PROGRESS_NOTIFICATION_METHOD = "coach.operationProgress" as const;

export const CoachOperationProgressNotificationEnvelopeSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    method: z.literal(COACH_OPERATION_PROGRESS_NOTIFICATION_METHOD),
    params: z
      .object({
        requestId: JsonRpcIdSchema,
        requestMethod: z.enum(["importFiles", "sync", "selfTest"]),
        event: OperationProgressEventSchema,
      })
      .strict(),
  })
  .strict();
export type CoachOperationProgressNotificationEnvelope = z.infer<
  typeof CoachOperationProgressNotificationEnvelopeSchema
>;

export const COACH_PLAN_PROGRESS_NOTIFICATION_METHOD = "coach.planProgress" as const;

export const CoachPlanProgressNotificationEnvelopeSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    method: z.literal(COACH_PLAN_PROGRESS_NOTIFICATION_METHOD),
    params: z
      .object({
        requestId: JsonRpcIdSchema,
        requestMethod: z.literal("executePlanTransition"),
        event: PlanProgressEventSchema,
      })
      .strict(),
  })
  .strict();
export type CoachPlanProgressNotificationEnvelope = z.infer<
  typeof CoachPlanProgressNotificationEnvelopeSchema
>;

export const CoachRpcNotificationEnvelopeSchema = z.union([
  CoachTurnEventNotificationEnvelopeSchema,
  CoachOperationProgressNotificationEnvelopeSchema,
  CoachPlanProgressNotificationEnvelopeSchema,
]);
export type CoachRpcNotificationEnvelope = z.infer<typeof CoachRpcNotificationEnvelopeSchema>;

export const CoachRpcEnvelopeSchema = z.union([
  CoachRpcRequestEnvelopeSchema,
  JsonRpcResponseEnvelopeSchema,
  CoachRpcNotificationEnvelopeSchema,
]);
export type CoachRpcEnvelope = z.infer<typeof CoachRpcEnvelopeSchema>;

export function parseCoachRpcEnvelope(text: string): CoachRpcEnvelope {
  return CoachRpcEnvelopeSchema.parse(JSON.parse(text));
}

export function serializeCoachRpcEnvelope(value: unknown): string {
  const parsed = CoachRpcEnvelopeSchema.parse(value);
  JsonValueSchema.parse(parsed);
  return JSON.stringify(parsed);
}

export type CoachRpcMethodRegistryShape = {
  readonly [K in keyof CoachRpcService]: {
    readonly wireName: K;
    readonly requestSchema: z.ZodType;
    readonly responseSchema: z.ZodType;
    readonly eventSchema: z.ZodType;
  };
};

export const NoRpcEventSchema = z.never();
export type NoRpcEvent = z.infer<typeof NoRpcEventSchema>;

export const COACH_RPC_METHOD_REGISTRY = {
  chat: {
    wireName: "chat",
    requestSchema: ChatRpcParamsSchema,
    responseSchema: ChatResponseSchema,
    eventSchema: TurnEventSchema,
  },
  stopChat: {
    wireName: "stopChat",
    requestSchema: StopChatRequestSchema,
    responseSchema: StopChatResponseSchema,
    eventSchema: NoRpcEventSchema,
  },
  admitChatAttachment: {
    wireName: "admitChatAttachment",
    requestSchema: AdmitChatAttachmentRequestSchema,
    responseSchema: AttachmentAdmissionReadModelSchema,
    eventSchema: NoRpcEventSchema,
  },
  admitPastedChatAttachment: {
    wireName: "admitPastedChatAttachment",
    requestSchema: AdmitPastedChatAttachmentRequestSchema,
    responseSchema: AttachmentAdmissionReadModelSchema,
    eventSchema: NoRpcEventSchema,
  },
  getChatAttachmentComposer: {
    wireName: "getChatAttachmentComposer",
    requestSchema: GetChatAttachmentComposerRequestSchema,
    responseSchema: ChatAttachmentComposerReadModelSchema,
    eventSchema: NoRpcEventSchema,
  },
  saveChatAttachmentDraftText: {
    wireName: "saveChatAttachmentDraftText",
    requestSchema: SaveChatAttachmentDraftTextRequestSchema,
    responseSchema: ChatAttachmentComposerReadModelSchema,
    eventSchema: NoRpcEventSchema,
  },
  removeChatAttachment: {
    wireName: "removeChatAttachment",
    requestSchema: ChatAttachmentMutationRequestSchema,
    responseSchema: ChatAttachmentComposerReadModelSchema,
    eventSchema: NoRpcEventSchema,
  },
  retryChatAttachment: {
    wireName: "retryChatAttachment",
    requestSchema: ChatAttachmentMutationRequestSchema,
    responseSchema: ChatAttachmentComposerReadModelSchema,
    eventSchema: NoRpcEventSchema,
  },
  selectChatAttachmentWorkout: {
    wireName: "selectChatAttachmentWorkout",
    requestSchema: SelectChatAttachmentWorkoutRequestSchema,
    responseSchema: ChatAttachmentComposerReadModelSchema,
    eventSchema: NoRpcEventSchema,
  },
  clearChatAttachmentDraft: {
    wireName: "clearChatAttachmentDraft",
    requestSchema: ClearChatAttachmentDraftRequestSchema,
    responseSchema: ChatAttachmentComposerReadModelSchema,
    eventSchema: NoRpcEventSchema,
  },
  enqueueChatMessage: {
    wireName: "enqueueChatMessage",
    requestSchema: EnqueueChatMessageRequestSchema,
    responseSchema: ChatQueueSnapshotSchema,
    eventSchema: NoRpcEventSchema,
  },
  getChatQueue: {
    wireName: "getChatQueue",
    requestSchema: GetChatQueueRequestSchema,
    responseSchema: ChatQueueSnapshotSchema,
    eventSchema: NoRpcEventSchema,
  },
  removeQueuedChatMessage: {
    wireName: "removeQueuedChatMessage",
    requestSchema: RemoveQueuedChatMessageRequestSchema,
    responseSchema: ChatQueueSnapshotSchema,
    eventSchema: NoRpcEventSchema,
  },
  resumeChatQueue: {
    wireName: "resumeChatQueue",
    requestSchema: ResumeChatQueueRequestSchema,
    responseSchema: ChatQueueRunResultSchema,
    eventSchema: TurnEventSchema,
  },
  runQueuedCommand: {
    wireName: "runQueuedCommand",
    requestSchema: RunQueuedCommandRequestSchema,
    responseSchema: ChatQueueRunResultSchema,
    eventSchema: TurnEventSchema,
  },
  retryQueuedTurn: {
    wireName: "retryQueuedTurn",
    requestSchema: RetryQueuedTurnRequestSchema,
    responseSchema: ChatQueueRunResultSchema,
    eventSchema: TurnEventSchema,
  },
  resetSession: {
    wireName: "resetSession",
    requestSchema: ResetSessionRequestSchema,
    responseSchema: ResetSessionResponseSchema,
    eventSchema: NoRpcEventSchema,
  },
  hasSession: {
    wireName: "hasSession",
    requestSchema: HasSessionRequestSchema,
    responseSchema: HasSessionResponseSchema,
    eventSchema: NoRpcEventSchema,
  },
  getCoachDecision: {
    wireName: "getCoachDecision",
    requestSchema: GetCoachDecisionRpcParamsSchema,
    responseSchema: GetCoachDecisionRpcResultSchema,
    eventSchema: NoRpcEventSchema,
  },
  answerCoachDecision: {
    wireName: "answerCoachDecision",
    requestSchema: AnswerCoachDecisionRpcParamsSchema,
    responseSchema: AnswerCoachDecisionRpcResultSchema,
    eventSchema: TurnEventSchema,
  },
  skipCoachDecision: {
    wireName: "skipCoachDecision",
    requestSchema: SkipCoachDecisionRpcParamsSchema,
    responseSchema: SkipCoachDecisionRpcResultSchema,
    eventSchema: NoRpcEventSchema,
  },
  resumeCoachDecision: {
    wireName: "resumeCoachDecision",
    requestSchema: ResumeCoachDecisionRpcParamsSchema,
    responseSchema: ResumeCoachDecisionRpcResultSchema,
    eventSchema: TurnEventSchema,
  },
  getTranscriptPage: {
    wireName: "getTranscriptPage",
    requestSchema: GetTranscriptPageRpcParamsSchema,
    responseSchema: GetTranscriptPageRpcResultSchema,
    eventSchema: NoRpcEventSchema,
  },
  listArchivedConversations: {
    wireName: "listArchivedConversations",
    requestSchema: ListArchivedConversationsRpcParamsSchema,
    responseSchema: ListArchivedConversationsRpcResultSchema,
    eventSchema: NoRpcEventSchema,
  },
  deleteArchivedConversation: {
    wireName: "deleteArchivedConversation",
    requestSchema: DeleteArchivedConversationRpcParamsSchema,
    responseSchema: DeleteArchivedConversationRpcResultSchema,
    eventSchema: NoRpcEventSchema,
  },
  getArchivedTranscriptPage: {
    wireName: "getArchivedTranscriptPage",
    requestSchema: GetArchivedTranscriptPageRpcParamsSchema,
    responseSchema: GetArchivedTranscriptPageRpcResultSchema,
    eventSchema: NoRpcEventSchema,
  },
  getAthleteState: {
    wireName: "getAthleteState",
    requestSchema: EmptyRpcParamsSchema,
    responseSchema: AthleteStateSchema,
    eventSchema: NoRpcEventSchema,
  },
  getPlanningReadModel: {
    wireName: "getPlanningReadModel",
    requestSchema: GetPlanningReadModelRpcParamsSchema,
    responseSchema: GetPlanningReadModelRpcResultSchema,
    eventSchema: NoRpcEventSchema,
  },
  getActivityAnalysis: {
    wireName: "getActivityAnalysis",
    requestSchema: ActivityAnalysisRequestSchema,
    responseSchema: ActivityAnalysisResultSchema,
    eventSchema: NoRpcEventSchema,
  },
  exportTrainingFile: {
    wireName: "exportTrainingFile",
    requestSchema: ExportTrainingFileRpcParamsSchema,
    responseSchema: ExportTrainingFileRpcResultSchema,
    eventSchema: NoRpcEventSchema,
  },
  importFiles: {
    wireName: "importFiles",
    requestSchema: ImportFilesRpcParamsSchema,
    responseSchema: ImportFilesRpcResultSchema,
    eventSchema: OperationProgressEventSchema,
  },
  sync: {
    wireName: "sync",
    requestSchema: SyncRpcParamsSchema,
    responseSchema: SyncRpcResultSchema,
    eventSchema: OperationProgressEventSchema,
  },
  getSetupStatus: {
    wireName: "getSetupStatus",
    requestSchema: GetSetupStatusRpcParamsSchema,
    responseSchema: GetSetupStatusRpcResultSchema,
    eventSchema: NoRpcEventSchema,
  },
  saveIntake: {
    wireName: "saveIntake",
    requestSchema: SaveIntakeRpcParamsSchema,
    responseSchema: SaveIntakeRpcResultSchema,
    eventSchema: NoRpcEventSchema,
  },
  configureRuntime: {
    wireName: "configureRuntime",
    requestSchema: ConfigureRuntimeRpcParamsSchema,
    responseSchema: ConfigureRuntimeRpcResultSchema,
    eventSchema: NoRpcEventSchema,
  },
  verify_intervals_credential: {
    wireName: "verify_intervals_credential",
    requestSchema: VerifyIntervalsCredentialRpcParamsSchema,
    responseSchema: VerifyIntervalsCredentialRpcResultSchema,
    eventSchema: NoRpcEventSchema,
  },
  getRuntimeConfig: {
    wireName: "getRuntimeConfig",
    requestSchema: GetRuntimeConfigRpcParamsSchema,
    responseSchema: GetRuntimeConfigRpcResultSchema,
    eventSchema: NoRpcEventSchema,
  },
  getUnitsPreference: {
    wireName: "getUnitsPreference",
    requestSchema: GetUnitsPreferenceRpcParamsSchema,
    responseSchema: GetUnitsPreferenceRpcResultSchema,
    eventSchema: NoRpcEventSchema,
  },
  setUnitsPreference: {
    wireName: "setUnitsPreference",
    requestSchema: SetUnitsPreferenceRpcParamsSchema,
    responseSchema: SetUnitsPreferenceRpcResultSchema,
    eventSchema: NoRpcEventSchema,
  },
  configureTelegram: {
    wireName: "configureTelegram",
    requestSchema: ConfigureTelegramRpcParamsSchema,
    responseSchema: TelegramControlMutationResultSchema,
    eventSchema: NoRpcEventSchema,
  },
  enableTelegram: {
    wireName: "enableTelegram",
    requestSchema: EmptyRpcParamsSchema,
    responseSchema: TelegramControlSnapshotSchema,
    eventSchema: NoRpcEventSchema,
  },
  disableTelegram: {
    wireName: "disableTelegram",
    requestSchema: EmptyRpcParamsSchema,
    responseSchema: TelegramControlSnapshotSchema,
    eventSchema: NoRpcEventSchema,
  },
  suspendTelegramPolling: {
    wireName: "suspendTelegramPolling",
    requestSchema: EmptyRpcParamsSchema,
    responseSchema: TelegramControlSnapshotSchema,
    eventSchema: NoRpcEventSchema,
  },
  resumeTelegramPolling: {
    wireName: "resumeTelegramPolling",
    requestSchema: EmptyRpcParamsSchema,
    responseSchema: TelegramControlSnapshotSchema,
    eventSchema: NoRpcEventSchema,
  },
  drainTelegram: {
    wireName: "drainTelegram",
    requestSchema: EmptyRpcParamsSchema,
    responseSchema: TelegramControlSnapshotSchema,
    eventSchema: NoRpcEventSchema,
  },
  replaceTelegram: {
    wireName: "replaceTelegram",
    requestSchema: ReplaceTelegramRpcParamsSchema,
    responseSchema: TelegramControlMutationResultSchema,
    eventSchema: NoRpcEventSchema,
  },
  getTelegramStatus: {
    wireName: "getTelegramStatus",
    requestSchema: EmptyRpcParamsSchema,
    responseSchema: TelegramControlSnapshotSchema,
    eventSchema: NoRpcEventSchema,
  },
  reconcileTelegram: {
    wireName: "reconcileTelegram",
    requestSchema: EmptyRpcParamsSchema,
    responseSchema: TelegramControlSnapshotSchema,
    eventSchema: NoRpcEventSchema,
  },
  inspectTelegramCredential: {
    wireName: "inspectTelegramCredential",
    requestSchema: InspectTelegramCredentialRpcParamsSchema,
    responseSchema: TelegramCredentialInspectionSchema,
    eventSchema: NoRpcEventSchema,
  },
  deleteTelegramWebhook: {
    wireName: "deleteTelegramWebhook",
    requestSchema: DeleteTelegramWebhookRpcParamsSchema,
    responseSchema: TelegramCredentialInspectionSchema,
    eventSchema: NoRpcEventSchema,
  },
  forgetTelegramCredential: {
    wireName: "forgetTelegramCredential",
    requestSchema: EmptyRpcParamsSchema,
    responseSchema: TelegramControlSnapshotSchema,
    eventSchema: NoRpcEventSchema,
  },
  resetTelegramAccess: {
    wireName: "resetTelegramAccess",
    requestSchema: EmptyRpcParamsSchema,
    responseSchema: TelegramControlSnapshotSchema,
    eventSchema: NoRpcEventSchema,
  },
  beginTelegramPairing: {
    wireName: "beginTelegramPairing",
    requestSchema: EmptyRpcParamsSchema,
    responseSchema: TelegramControlSnapshotSchema,
    eventSchema: NoRpcEventSchema,
  },
  cancelTelegramPairing: {
    wireName: "cancelTelegramPairing",
    requestSchema: EmptyRpcParamsSchema,
    responseSchema: TelegramControlSnapshotSchema,
    eventSchema: NoRpcEventSchema,
  },
  listTelegramAllowedSenders: {
    wireName: "listTelegramAllowedSenders",
    requestSchema: EmptyRpcParamsSchema,
    responseSchema: TelegramAllowedSendersResultSchema,
    eventSchema: NoRpcEventSchema,
  },
  addTelegramAllowedSender: {
    wireName: "addTelegramAllowedSender",
    requestSchema: TelegramAllowedSenderRpcParamsSchema,
    responseSchema: TelegramAllowedSendersMutationResultSchema,
    eventSchema: NoRpcEventSchema,
  },
  removeTelegramAllowedSender: {
    wireName: "removeTelegramAllowedSender",
    requestSchema: TelegramAllowedSenderRpcParamsSchema,
    responseSchema: TelegramAllowedSendersMutationResultSchema,
    eventSchema: NoRpcEventSchema,
  },
  getSpendSummary: {
    wireName: "getSpendSummary",
    requestSchema: GetSpendSummaryRpcParamsSchema,
    responseSchema: SpendSummarySchema,
    eventSchema: NoRpcEventSchema,
  },
  setDailySpendCap: {
    wireName: "setDailySpendCap",
    requestSchema: SetDailySpendCapRpcParamsSchema,
    responseSchema: SpendSummarySchema,
    eventSchema: NoRpcEventSchema,
  },
  selfTest: {
    wireName: "selfTest",
    requestSchema: SelfTestRpcParamsSchema,
    responseSchema: SelfTestRpcResultSchema,
    eventSchema: OperationProgressEventSchema,
  },
  getPlanState: {
    wireName: "getPlanState",
    requestSchema: GetPlanStateRpcParamsSchema,
    responseSchema: GetPlanStateRpcResultSchema,
    eventSchema: NoRpcEventSchema,
  },
  executePlanTransition: {
    wireName: "executePlanTransition",
    requestSchema: ExecutePlanTransitionRpcParamsSchema,
    responseSchema: ExecutePlanTransitionRpcResultSchema,
    eventSchema: PlanProgressEventSchema,
  },
  createPlanningRequest: {
    wireName: "createPlanningRequest",
    requestSchema: CreatePlanningRequestRpcParamsSchema,
    responseSchema: CreatePlanningRequestRpcResultSchema,
    eventSchema: NoRpcEventSchema,
  },
  createWorkoutPlanningRequest: {
    wireName: "createWorkoutPlanningRequest",
    requestSchema: CreateWorkoutPlanningRequestRpcParamsSchema,
    responseSchema: CreateWorkoutPlanningRequestRpcResultSchema,
    eventSchema: NoRpcEventSchema,
  },
  getPlanningRequest: {
    wireName: "getPlanningRequest",
    requestSchema: GetPlanningRequestRpcParamsSchema,
    responseSchema: GetPlanningRequestRpcResultSchema,
    eventSchema: NoRpcEventSchema,
  },
  retryPlanningRequest: {
    wireName: "retryPlanningRequest",
    requestSchema: RetryPlanningRequestRpcParamsSchema,
    responseSchema: RetryPlanningRequestRpcResultSchema,
    eventSchema: NoRpcEventSchema,
  },
  resumePlanningRequests: {
    wireName: "resumePlanningRequests",
    requestSchema: ResumePlanningRequestsRpcParamsSchema,
    responseSchema: ResumePlanningRequestsRpcResultSchema,
    eventSchema: NoRpcEventSchema,
  },
  listPlanningRequests: {
    wireName: "listPlanningRequests",
    requestSchema: ListPlanningRequestsRpcParamsSchema,
    responseSchema: ListPlanningRequestsRpcResultSchema,
    eventSchema: NoRpcEventSchema,
  },
  "plan_creation.start": {
    wireName: "plan_creation.start",
    requestSchema: PlanCreationStartRpcParamsSchema,
    responseSchema: PlanCreationStartRpcResultSchema,
    eventSchema: NoRpcEventSchema,
  },
  "plan_creation.answer": {
    wireName: "plan_creation.answer",
    requestSchema: PlanCreationAnswerRpcParamsSchema,
    responseSchema: PlanCreationAnswerRpcResultSchema,
    eventSchema: NoRpcEventSchema,
  },
} as const satisfies CoachRpcMethodRegistryShape;

export type CoachRpcRequest<K extends CoachRpcMethodName> = z.input<
  (typeof COACH_RPC_METHOD_REGISTRY)[K]["requestSchema"]
>;
export type CoachRpcResponse<K extends CoachRpcMethodName> = z.output<
  (typeof COACH_RPC_METHOD_REGISTRY)[K]["responseSchema"]
>;
export type CoachRpcEvent<K extends CoachRpcMethodName> = z.output<
  (typeof COACH_RPC_METHOD_REGISTRY)[K]["eventSchema"]
>;

export type CoachRpcNotification<K extends CoachRpcMethodName> = K extends
  | "chat"
  | "answerCoachDecision"
  | "resumeCoachDecision"
  ? CoachTurnEventNotificationEnvelope
  : K extends "importFiles" | "sync" | "selfTest"
    ? CoachOperationProgressNotificationEnvelope
    : K extends "executePlanTransition"
      ? CoachPlanProgressNotificationEnvelope
      : never;
