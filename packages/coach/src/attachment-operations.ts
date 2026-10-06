import { createHash, randomUUID } from "node:crypto";
import {
  AttachmentAdmissionReadModelSchema,
  CHAT_ATTACHMENT_LIMITS,
  type AdmitChatAttachmentRequest,
  type AttachmentAdmissionReadModel,
} from "@enduragent/coach-contract";
import type { ChatAttachmentRepository } from "@enduragent/kernel/store";
import type { ChatAttachmentObjectRow, ChatAttachmentRow } from "@enduragent/kernel/store";
import {
  ManagedAttachmentSourceError,
  chatAttachmentRelativePath,
  type ManagedChatAttachmentStore,
} from "@enduragent/kernel-node/chat-attachments";
import type { AttachmentObservation } from "./attachment-observability.js";

function displayNameFromPath(sourcePath: string): string {
  const segments = sourcePath.split(/[\\/]/u);
  return segments.at(-1) || "Attachment";
}

export function unavailableChatAttachmentAdmission(
  request: AdmitChatAttachmentRequest,
): AttachmentAdmissionReadModel {
  return AttachmentAdmissionReadModelSchema.parse({
    selectionId: request.selectionId,
    displayName: displayNameFromPath(request.candidate.sourcePath),
    status: "storage_failed",
    failureCode: "admission_unavailable",
    retryable: false,
  });
}

export interface ManagedChatAttachmentOperations {
  admit(request: AdmitChatAttachmentRequest): Promise<AttachmentAdmissionReadModel>;
  admitPasted(input: {
    readonly chatId: string;
    readonly selectionId: string;
    readonly displayName: string;
    readonly bytes: Uint8Array;
  }): Promise<AttachmentAdmissionReadModel>;
  removeDraftAttachment(conversationId: string, attachmentId: string): Promise<void>;
  saveDraftText(conversationId: string, text: string): Promise<void>;
  retryDraftAttachment(conversationId: string, attachmentId: string): Promise<void>;
  clearDraft(conversationId: string): Promise<void>;
  cleanupAttachments(conversationId: string, attachmentIds: readonly string[]): Promise<void>;
  cleanupConversation(conversationId: string): Promise<void>;
  reconcile(): Promise<void>;
}

export interface ManagedChatAttachmentOperationsInput {
  readonly repository: ChatAttachmentRepository;
  readonly objects: ManagedChatAttachmentStore;
  readonly runExclusive: <T>(work: () => Promise<T>) => Promise<T>;
  readonly now?: () => number;
  readonly randomId?: () => string;
  readonly onAdmitted?: (input: {
    readonly attachment: ChatAttachmentRow;
    readonly object: ChatAttachmentObjectRow;
  }) => Promise<void>;
  readonly beforeConversationCleanup?: (conversationId: string) => Promise<void>;
  readonly observe?: (input: AttachmentObservation) => void;
}

const CAPACITY_LIMITS = {
  attachmentsPerMessage: CHAT_ATTACHMENT_LIMITS.attachmentsPerMessage,
  messageBytes: CHAT_ATTACHMENT_LIMITS.messageBytes,
  conversationBytes: CHAT_ATTACHMENT_LIMITS.conversationBytes,
  athleteBytes: CHAT_ATTACHMENT_LIMITS.athleteBytes,
} as const;

const PASTED_DISPLAY_NAME = Symbol("pasted-display-name");
type InternalAdmissionRequest = AdmitChatAttachmentRequest & {
  readonly [PASTED_DISPLAY_NAME]?: string;
};

function conversationKey(conversationId: string): string {
  return createHash("sha256").update(conversationId, "utf8").digest("hex");
}

function rejected(
  request: AdmitChatAttachmentRequest,
  displayName: string,
  reason: Extract<AttachmentAdmissionReadModel, { status: "rejected" }>["reason"],
): AttachmentAdmissionReadModel {
  return AttachmentAdmissionReadModelSchema.parse({
    selectionId: request.selectionId,
    displayName,
    status: "rejected",
    reason,
  });
}

export function createManagedChatAttachmentOperations(
  input: ManagedChatAttachmentOperationsInput,
): ManagedChatAttachmentOperations {
  const now = input.now ?? Date.now;
  const randomId = input.randomId ?? randomUUID;

  const operations: ManagedChatAttachmentOperations = {
    async admit(request) {
      const internalRequest = request as InternalAdmissionRequest;
      const pastedDisplayName = internalRequest[PASTED_DISPLAY_NAME];
      const fallbackName = pastedDisplayName ?? displayNameFromPath(request.candidate.sourcePath);
      let source: Awaited<ReturnType<ManagedChatAttachmentStore["inspectNativeSource"]>>;
      try {
        source = await input.objects.inspectNativeSource(request.candidate.sourcePath);
        if (pastedDisplayName !== undefined) source = { ...source, displayName: pastedDisplayName };
      } catch (error) {
        if (error instanceof ManagedAttachmentSourceError) {
          return rejected(request, fallbackName, error.reason);
        }
        return AttachmentAdmissionReadModelSchema.parse({
          selectionId: request.selectionId,
          displayName: fallbackName,
          status: "storage_failed",
          failureCode: "storage_failed",
          retryable: true,
        });
      }

      return input.runExclusive(async () => {
        const createdAtMs = now();
        const key = conversationKey(request.chatId);
        const objectId = randomId();
        const attachmentId = randomId();
        const relativePath = chatAttachmentRelativePath(key, objectId);
        let reservation: Awaited<ReturnType<ChatAttachmentRepository["reserveObject"]>>;
        try {
          reservation = await input.repository.reserveObject({
            object: {
              id: objectId,
              conversation_id: request.chatId,
              conversation_key: key,
              sha256: source.sha256,
              byte_size: source.byteSize,
              relative_path: relativePath,
              status: "reserved",
              failure_code: null,
              created_at_ms: createdAtMs,
              updated_at_ms: createdAtMs,
            },
            limits: CAPACITY_LIMITS,
          });
        } catch {
          return AttachmentAdmissionReadModelSchema.parse({
            selectionId: request.selectionId,
            displayName: source.displayName,
            status: "storage_failed",
            failureCode: "storage_failed",
            retryable: true,
          });
        }
        if (reservation.kind === "message_limit") {
          return rejected(request, source.displayName, "message_limit");
        }
        if (reservation.kind === "storage_full") {
          return rejected(request, source.displayName, "storage_full");
        }

        const object = reservation.object;
        if (reservation.kind === "reserved") {
          try {
            await input.objects.copyInspectedSource({ source, relativePath: object.relative_path });
          } catch (error) {
            await input.repository
              .failObject(
                object.id,
                error instanceof ManagedAttachmentSourceError
                  ? "source_changed"
                  : "storage_write_failed",
                now(),
              )
              .catch(() => {});
            if (error instanceof ManagedAttachmentSourceError) {
              return rejected(request, source.displayName, error.reason);
            }
            return AttachmentAdmissionReadModelSchema.parse({
              selectionId: request.selectionId,
              displayName: source.displayName,
              status: "storage_failed",
              failureCode: "storage_failed",
              retryable: true,
            });
          }
        }

        const attachment: ChatAttachmentRow = {
          id: attachmentId,
          schema_version: 1,
          conversation_id: request.chatId,
          object_id: object.id,
          kind: source.kind,
          display_name: source.displayName,
          media_type: source.mediaType,
          extension: source.extension,
          byte_size: source.byteSize,
          sha256: source.sha256,
          status: "preprocessing",
          state_json: null,
          message_id: null,
          created_at_ms: createdAtMs,
          updated_at_ms: now(),
        };
        try {
          await input.repository.commitAdmission({
            objectId: object.id,
            attachment,
            draftUpdatedAtMs: now(),
          });
        } catch {
          if (reservation.kind === "reserved") {
            await input.repository
              .failObject(object.id, "metadata_commit_failed", now())
              .catch(() => {});
            await input.objects.removeObject(object.relative_path).catch(() => {});
          }
          return AttachmentAdmissionReadModelSchema.parse({
            selectionId: request.selectionId,
            displayName: source.displayName,
            status: "storage_failed",
            failureCode: "storage_failed",
            retryable: true,
          });
        }
        const durableObject = await input.repository.readObject(object.id);
        if (durableObject !== undefined) {
          await input.onAdmitted?.({ attachment, object: durableObject }).catch(() => {});
        }
        return AttachmentAdmissionReadModelSchema.parse({
          selectionId: request.selectionId,
          displayName: source.displayName,
          status: "accepted",
          attachmentId,
        });
      });
    },

    async admitPasted({ chatId, selectionId, displayName, bytes }) {
      let staged: Awaited<ReturnType<ManagedChatAttachmentStore["stagePrivateBytes"]>>;
      try {
        staged = await input.objects.stagePrivateBytes({ displayName, bytes });
      } catch (error) {
        if (error instanceof ManagedAttachmentSourceError) {
          return AttachmentAdmissionReadModelSchema.parse({
            selectionId,
            displayName,
            status: "rejected",
            reason: error.reason,
          });
        }
        return AttachmentAdmissionReadModelSchema.parse({
          selectionId,
          displayName,
          status: "storage_failed",
          failureCode: "storage_failed",
          retryable: true,
        });
      }
      try {
        const request: InternalAdmissionRequest = {
          chatId,
          selectionId,
          source: "picker",
          candidate: { kind: "native-path", sourcePath: staged.sourcePath },
          [PASTED_DISPLAY_NAME]: staged.displayName,
        };
        return await operations.admit(request);
      } finally {
        await input.objects.removeStagedSource(staged.sourcePath).catch(() => {});
      }
    },

    async removeDraftAttachment(conversationId, attachmentId) {
      await input.runExclusive(async () => {
        const result = await input.repository.removeDraftAttachment({
          conversationId,
          attachmentId,
        });
        if (result.unreferencedObject !== undefined) {
          await input.objects.removeObject(result.unreferencedObject.relative_path);
        }
      });
    },

    async saveDraftText(conversationId, text) {
      await input.runExclusive(async () => {
        await input.repository.saveDraftText({
          conversationId,
          text,
          state: "active",
          updatedAtMs: now(),
        });
      });
    },

    async retryDraftAttachment(conversationId, attachmentId) {
      await input.runExclusive(async () => {
        const draft = await input.repository.readDraft(conversationId);
        if (draft === undefined || !draft.attachmentIds.includes(attachmentId)) {
          throw new Error("attachment draft item is unavailable");
        }
        const attachment = await input.repository.readAttachment(attachmentId);
        if (
          attachment === undefined ||
          attachment.conversation_id !== conversationId ||
          (attachment.status !== "failed" && attachment.status !== "blocked")
        ) {
          throw new Error("attachment draft item cannot be retried");
        }
        const preprocessing = await input.repository.transitionAttachment({
          conversationId,
          attachmentId,
          from: [attachment.status],
          to: "preprocessing",
          stateJson: null,
          messageId: null,
          updatedAtMs: now(),
        });
        const object = await input.repository.readObject(preprocessing.object_id);
        if (object === undefined || object.status !== "durable") {
          throw new Error("attachment object is unavailable");
        }
        await input.onAdmitted?.({ attachment: preprocessing, object });
      });
    },

    async clearDraft(conversationId) {
      await input.runExclusive(async () => {
        const draft = await input.repository.readDraft(conversationId);
        for (const attachmentId of draft?.attachmentIds ?? []) {
          const result = await input.repository.removeDraftAttachment({
            conversationId,
            attachmentId,
          });
          if (result.unreferencedObject !== undefined) {
            await input.objects.removeObject(result.unreferencedObject.relative_path);
          }
        }
        await input.repository.saveDraftText({
          conversationId,
          text: "",
          state: "clearing",
          updatedAtMs: now(),
        });
      });
    },

    async cleanupAttachments(conversationId, attachmentIds) {
      const startedAt = now();
      try {
        const count = await input.runExclusive(async () => {
          const objects = await input.repository.prepareAttachmentCleanup({
            conversationId,
            attachmentIds,
          });
          for (const object of objects) await input.objects.removeObject(object.relative_path);
          await input.repository.finalizeAttachmentCleanup({
            conversationId,
            attachmentIds,
            removedObjectIds: objects.map((object) => object.id),
          });
          return attachmentIds.length;
        });
        input.observe?.({
          operation: "cleanup",
          kind: "unknown",
          result: "succeeded",
          count,
          durationMs: now() - startedAt,
        });
      } catch (error) {
        input.observe?.({
          operation: "cleanup",
          kind: "unknown",
          result: "failed",
          durationMs: now() - startedAt,
        });
        throw error;
      }
    },

    async cleanupConversation(conversationId) {
      const startedAt = now();
      try {
        const count = await input.runExclusive(async () => {
          await input.beforeConversationCleanup?.(conversationId);
          const objects = await input.repository.cleanupConversation(conversationId);
          for (const object of objects) await input.objects.removeObject(object.relative_path);
          return objects.length;
        });
        input.observe?.({
          operation: "cleanup",
          kind: "unknown",
          result: "succeeded",
          count,
          durationMs: now() - startedAt,
        });
      } catch (error) {
        input.observe?.({
          operation: "cleanup",
          kind: "unknown",
          result: "failed",
          durationMs: now() - startedAt,
        });
        throw error;
      }
    },

    async reconcile() {
      const startedAt = now();
      try {
        const result = await input.runExclusive(() =>
          input.objects.reconcile(input.repository, CHAT_ATTACHMENT_LIMITS.orphanGraceMs),
        );
        const count = result.missing + result.interruptedReservations + result.orphansRemoved;
        if (count > 0) {
          input.observe?.({
            operation: "reconcile",
            kind: "unknown",
            result: "succeeded",
            count,
            durationMs: now() - startedAt,
          });
        }
      } catch (error) {
        input.observe?.({
          operation: "reconcile",
          kind: "unknown",
          result: "failed",
          durationMs: now() - startedAt,
        });
        throw error;
      }
    },
  };
  return operations;
}
