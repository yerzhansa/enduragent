import { describe, expect, it } from "vitest";
import {
  AgentErrorKindSchema,
  AthleteHomeIdentitySchema,
  AthleteStateSchema,
  COACH_RPC_METHOD_NAMES,
  COACH_RPC_METHOD_REGISTRY,
  COACH_TURN_EVENT_NOTIFICATION_METHOD,
  COACH_OPERATION_PROGRESS_NOTIFICATION_METHOD,
  ChatResponseSchema,
  ChatRpcParamsSchema,
  ClientHandshakeFrameSchema,
  CoachRpcEnvelopeSchema,
  CoachRpcRequestEnvelopeSchema,
  CoachOperationProgressNotificationEnvelopeSchema,
  CoachTurnEventNotificationEnvelopeSchema,
  DaemonOwnerSchema,
  EmptyRpcParamsSchema,
  ConfigureRuntimeRpcParamsSchema,
  ConfigureRuntimeRpcResultSchema,
  ConfigureTelegramRpcParamsSchema,
  DeleteArchivedConversationRpcParamsSchema,
  DeleteArchivedConversationRpcResultSchema,
  DeleteTelegramWebhookRpcParamsSchema,
  GetRuntimeConfigRpcParamsSchema,
  GetRuntimeConfigRpcResultSchema,
  GetSetupStatusRpcParamsSchema,
  GetSetupStatusRpcResultSchema,
  GetArchivedTranscriptPageRpcParamsSchema,
  GetArchivedTranscriptPageRpcResultSchema,
  GetTranscriptPageRpcParamsSchema,
  GetTranscriptPageRpcResultSchema,
  ListArchivedConversationsRpcParamsSchema,
  ListArchivedConversationsRpcResultSchema,
  GetUnitsPreferenceRpcParamsSchema,
  GetUnitsPreferenceRpcResultSchema,
  ImportFilesRpcParamsSchema,
  ImportFilesRpcResultSchema,
  InspectTelegramCredentialRpcParamsSchema,
  IntervalsCredentialApprovalSchema,
  IntervalsCredentialVerificationRefusalReasonSchema,
  OperationProgressEventSchema,
  Protocol11AcceptedServerHandshakeFrameSchema,
  SaveIntakeRpcParamsSchema,
  SaveIntakeRpcResultSchema,
  SyncRpcParamsSchema,
  SyncRpcResultSchema,
  HasSessionRequestSchema,
  HasSessionResponseSchema,
  JsonRpcErrorResponseEnvelopeSchema,
  JsonRpcProtocolErrorResponseEnvelopeSchema,
  JsonRpcResponseEnvelopeSchema,
  JsonRpcSuccessResponseEnvelopeSchema,
  LlmProviderSchema,
  NoRpcEventSchema,
  PROTOCOL_VERSION,
  ResetSessionRequestSchema,
  ResetSessionResponseSchema,
  RendererCapabilitySchema,
  ReplaceTelegramRpcParamsSchema,
  SetUnitsPreferenceRpcParamsSchema,
  SetUnitsPreferenceRpcResultSchema,
  GetSpendSummaryRpcParamsSchema,
  SetDailySpendCapRpcParamsSchema,
  SelfTestCommandTerminalSchema,
  SelfTestRpcParamsSchema,
  SelfTestRpcResultSchema,
  SpendSummarySchema,
  TelegramAllowedSenderRpcParamsSchema,
  TelegramAllowedSendersMutationResultSchema,
  TelegramAllowedSendersResultSchema,
  TelegramControlMutationResultSchema,
  TelegramControlSnapshotSchema,
  TelegramClipboardCredentialSchema,
  TelegramCredentialSchema,
  TelegramCredentialInspectionSchema,
  ServerHandshakeFrameSchema,
  TurnEventSchema,
  UNKNOWN_CYCLING_TRAINING_CONTEXT,
  VerifyIntervalsCredentialRpcParamsSchema,
  VerifyIntervalsCredentialRpcResultSchema,
  compareProtocolVersions,
  createAcceptedServerHandshakeFrame,
  createClientHandshakeFrame,
  EXIT_VERSION_MISMATCH,
  createVersionMismatchServerHandshakeFrame,
  parseCoachRpcEnvelope,
  serializeCoachRpcEnvelope,
  type CoachRpcService,
  type CoachRpcEnvelope,
} from "../src/index.js";

const turnEvent = {
  type: "turn-start",
  turnId: "turn-1",
  chatId: "chat-1",
} as const;

const acceptedHandshakeBinding = {
  athleteHome: "/synthetic/athlete",
  rendererCapability: "A".repeat(43),
} as const;

const notification = {
  jsonrpc: "2.0",
  method: COACH_TURN_EVENT_NOTIFICATION_METHOD,
  params: {
    requestId: 1,
    requestMethod: "chat",
    turnId: "turn-1",
    event: turnEvent,
  },
} as const;

const progressNotification = {
  jsonrpc: "2.0",
  method: COACH_OPERATION_PROGRESS_NOTIFICATION_METHOD,
  params: {
    requestId: 5,
    requestMethod: "importFiles",
    event: { phase: "started", completed: 0, total: 1 },
  },
} as const;

function transcriptCursor(): string {
  const bytes = Buffer.alloc(114);
  bytes[0] = 1;
  return bytes.toString("base64url");
}

const BOUNDARY_REF = "a".repeat(64);
const INTERVALS_APPROVAL = "b".repeat(64);

describe("Telegram clipboard credentials", () => {
  it("accepts representative bot-token syntax without claiming provenance or narrowing the wire credential", () => {
    const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
    expect(TelegramClipboardCredentialSchema.parse(token)).toBe(token);
    expect(TelegramClipboardCredentialSchema.parse(`12345:${"A".repeat(35)}`)).toBe(
      `12345:${"A".repeat(35)}`,
    );
    expect(TelegramClipboardCredentialSchema.parse(`${"9".repeat(16)}:${"_".repeat(35)}`)).toBe(
      `${"9".repeat(16)}:${"_".repeat(35)}`,
    );
    expect(TelegramCredentialSchema.parse("sk-unrelated-secret")).toBe("sk-unrelated-secret");

    for (const value of [
      "sk-unrelated-secret",
      "password",
      "bot-id:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi",
      "123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi",
      "123456789:",
      "1234:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi",
      `123456789:${"A".repeat(34)}`,
      `123456789:${"A".repeat(36)}`,
      `${"9".repeat(17)}:${"A".repeat(35)}`,
      "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg+i",
    ]) {
      expect(TelegramClipboardCredentialSchema.safeParse(value).success).toBe(false);
    }
  });
});

function archivedTranscriptCursor(): string {
  const bytes = Buffer.alloc(114);
  bytes[0] = 2;
  bytes[1] = 1;
  bytes.fill(0xab, 34, 66);
  return bytes.toString("base64url");
}

function roundTrip(value: unknown): CoachRpcEnvelope {
  const serialized = serializeCoachRpcEnvelope(value);
  expect(serialized.endsWith("\n")).toBe(false);
  const first = parseCoachRpcEnvelope(serialized);
  const second = parseCoachRpcEnvelope(serializeCoachRpcEnvelope(first));
  expect(second).toEqual(first);
  return second;
}

describe("JSON-RPC envelopes", () => {
  it("round trips requests, successes, ordinary errors, protocol errors, and notifications", () => {
    const values = [
      { jsonrpc: "2.0", id: 1, method: "chat", params: { chatId: "chat-1", message: "hello" } },
      { jsonrpc: "2.0", id: 1, result: { text: "hello" } },
      { jsonrpc: "2.0", id: 1, error: { code: -32600, message: "invalid request" } },
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } },
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } },
      notification,
      progressNotification,
    ];
    for (const value of values) expect(roundTrip(value)).toEqual(value);
  });

  it("keeps null ids exclusive to the two unrecoverable protocol errors", () => {
    expect(
      JsonRpcErrorResponseEnvelopeSchema.safeParse({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32700, message: "parse error" },
      }).success,
    ).toBe(false);
    expect(
      JsonRpcSuccessResponseEnvelopeSchema.safeParse({
        jsonrpc: "2.0",
        id: null,
        result: {},
      }).success,
    ).toBe(false);
    expect(
      JsonRpcProtocolErrorResponseEnvelopeSchema.safeParse({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message: "foreign" },
      }).success,
    ).toBe(false);
  });

  it("rejects malformed JSON, missing and extra keys, invalid ids, and mixed terminals", () => {
    expect(() => parseCoachRpcEnvelope("{")).toThrow();
    const invalid = [
      { jsonrpc: "2.0", id: 1, method: "chat" },
      { jsonrpc: "2.0", id: 1, method: "chat", params: {}, extra: true },
      { jsonrpc: "2.0", id: "", method: "chat", params: {} },
      { jsonrpc: "2.0", id: -1, method: "chat", params: {} },
      { jsonrpc: "2.0", id: 1.5, method: "chat", params: {} },
      { jsonrpc: "2.0", id: Number.MAX_SAFE_INTEGER + 1, method: "chat", params: {} },
      { jsonrpc: "2.0", id: 1, result: {}, error: { code: 1, message: "mixed" } },
      { ...notification, id: 1 },
    ];
    for (const value of invalid)
      expect(CoachRpcEnvelopeSchema.safeParse(value).success).toBe(false);
  });

  it("rejects non-JSON payload values", () => {
    const invalid = [undefined, () => undefined, Symbol("x"), 1n, NaN, Infinity, -Infinity];
    for (const value of invalid) {
      expect(
        JsonRpcResponseEnvelopeSchema.safeParse({ jsonrpc: "2.0", id: 1, result: value }).success,
      ).toBe(false);
      expect(() =>
        serializeCoachRpcEnvelope({
          jsonrpc: "2.0",
          id: 1,
          error: { code: 1, message: "x", data: value },
        }),
      ).toThrow();
    }
  });
});

const spendSummary = SpendSummarySchema.parse({
  localDate: "1998-07-06",
  timezone: "UTC",
  dailyCapUsd: 0.5,
  knownSpendUsd: 0,
  generationCount: 0,
  pricedGenerationCount: 0,
  unpricedGenerationCount: 0,
  malformedLineCount: 0,
  spendComplete: true,
  capStatus: "below",
  cacheReadTokens: 0,
  knownCacheReadSavingsUsd: 0,
  cacheSavingsComplete: true,
  routes: [],
});

const telegramSnapshot = {
  channel: { desiredState: "disabled", state: "disabled" },
  bot: { state: "unconfigured" },
  pairing: { state: "unpaired" },
} as const;

describe("coach request and event projection", () => {
  it("admits every strict method request", () => {
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "chat", params: { chatId: "chat-1", message: "hello" } },
      { jsonrpc: "2.0", id: 2, method: "resetSession", params: { chatId: "chat-1" } },
      { jsonrpc: "2.0", id: 3, method: "hasSession", params: { chatId: "chat-1" } },
      { jsonrpc: "2.0", id: 4, method: "getAthleteState", params: {} },
      { jsonrpc: "2.0", id: 5, method: "importFiles", params: { paths: ["/synthetic/ride.fit"] } },
      { jsonrpc: "2.0", id: 6, method: "sync", params: {} },
      {
        jsonrpc: "2.0",
        id: 7,
        method: "saveIntake",
        params: {
          swim_skill_floor: null,
          continuous_distance_capable: null,
          open_water_comfort: null,
          prior_bsi: false,
          clinician_cleared: null,
          injury_status: "none",
        },
      },
      {
        jsonrpc: "2.0",
        id: 8,
        method: "configureRuntime",
        params: { llm: { provider: "anthropic", api_key: "placeholder" } },
      },
      {
        jsonrpc: "2.0",
        id: 37,
        method: "verify_intervals_credential",
        params: { api_key: "placeholder" },
      },
      { jsonrpc: "2.0", id: 9, method: "getRuntimeConfig", params: {} },
      { jsonrpc: "2.0", id: 10, method: "getUnitsPreference", params: {} },
      {
        jsonrpc: "2.0",
        id: 11,
        method: "setUnitsPreference",
        params: { value: "imperial" },
      },
      { jsonrpc: "2.0", id: 12, method: "getSpendSummary", params: {} },
      {
        jsonrpc: "2.0",
        id: 13,
        method: "setDailySpendCap",
        params: { dailyCapUsd: 0.75 },
      },
      { jsonrpc: "2.0", id: 14, method: "selfTest", params: {} },
      {
        jsonrpc: "2.0",
        id: 15,
        method: "getTranscriptPage",
        params: { cursor: null, limit: 25 },
      },
      { jsonrpc: "2.0", id: 16, method: "listArchivedConversations", params: {} },
      {
        jsonrpc: "2.0",
        id: 38,
        method: "deleteArchivedConversation",
        params: { boundaryRef: BOUNDARY_REF },
      },
      {
        jsonrpc: "2.0",
        id: 17,
        method: "getArchivedTranscriptPage",
        params: { boundaryRef: BOUNDARY_REF, cursor: null, limit: 25 },
      },
      { jsonrpc: "2.0", id: 18, method: "configureTelegram", params: { token: "bot-token" } },
      { jsonrpc: "2.0", id: 19, method: "enableTelegram", params: {} },
      { jsonrpc: "2.0", id: 20, method: "disableTelegram", params: {} },
      { jsonrpc: "2.0", id: 34, method: "suspendTelegramPolling", params: {} },
      { jsonrpc: "2.0", id: 35, method: "resumeTelegramPolling", params: {} },
      { jsonrpc: "2.0", id: 36, method: "drainTelegram", params: {} },
      { jsonrpc: "2.0", id: 21, method: "replaceTelegram", params: { token: "new-token" } },
      { jsonrpc: "2.0", id: 22, method: "getTelegramStatus", params: {} },
      { jsonrpc: "2.0", id: 23, method: "reconcileTelegram", params: {} },
      {
        jsonrpc: "2.0",
        id: 24,
        method: "inspectTelegramCredential",
        params: { token: "bot-token" },
      },
      {
        jsonrpc: "2.0",
        id: 25,
        method: "deleteTelegramWebhook",
        params: { token: "bot-token" },
      },
      { jsonrpc: "2.0", id: 26, method: "forgetTelegramCredential", params: {} },
      { jsonrpc: "2.0", id: 32, method: "resetTelegramAccess", params: {} },
      { jsonrpc: "2.0", id: 27, method: "beginTelegramPairing", params: {} },
      { jsonrpc: "2.0", id: 28, method: "cancelTelegramPairing", params: {} },
      { jsonrpc: "2.0", id: 29, method: "listTelegramAllowedSenders", params: {} },
      {
        jsonrpc: "2.0",
        id: 30,
        method: "addTelegramAllowedSender",
        params: { senderId: 123_456 },
      },
      {
        jsonrpc: "2.0",
        id: 31,
        method: "removeTelegramAllowedSender",
        params: { senderId: 123_456 },
      },
    ];
    for (const request of requests) {
      expect(CoachRpcRequestEnvelopeSchema.parse(request)).toEqual(request);
      expect(roundTrip(request)).toEqual(request);
    }
    expect(
      CoachRpcRequestEnvelopeSchema.safeParse({ jsonrpc: "2.0", id: 4, method: "getAthleteState" })
        .success,
    ).toBe(false);
    expect(
      CoachRpcRequestEnvelopeSchema.safeParse({
        jsonrpc: "2.0",
        id: 4,
        method: "getAthleteState",
        params: { chatId: "x" },
      }).success,
    ).toBe(false);
    expect(
      CoachRpcRequestEnvelopeSchema.safeParse({
        jsonrpc: "2.0",
        id: 5,
        method: "analyze",
        params: {},
      }).success,
    ).toBe(false);
    expect(
      CoachRpcRequestEnvelopeSchema.safeParse({
        jsonrpc: "2.0",
        id: 36,
        method: "drainTelegram",
        params: { stop: true },
      }).success,
    ).toBe(false);
  });

  it("enforces the exact bounded transcript page wire shape", () => {
    const cursor = transcriptCursor();
    expect(GetTranscriptPageRpcParamsSchema.parse({ cursor, limit: 50 })).toEqual({
      cursor,
      limit: 50,
    });
    expect(
      GetTranscriptPageRpcResultSchema.parse({
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
      }),
    ).toMatchObject({ status: "page", nextCursor: cursor });
    for (const request of [
      { cursor: null, limit: 0 },
      { cursor: null, limit: 51 },
      { cursor: "a".repeat(152), limit: 25 },
      { cursor: null, limit: 25, chatId: "other" },
    ]) {
      expect(GetTranscriptPageRpcParamsSchema.safeParse(request).success).toBe(false);
    }
    for (const result of [
      {
        schemaVersion: 1,
        status: "restart-required",
        turns: [],
        nextCursor: cursor,
      },
      {
        schemaVersion: 1,
        status: "page",
        turns: [],
        nextCursor: null,
        path: "/synthetic/private/transcript",
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
      expect(GetTranscriptPageRpcResultSchema.safeParse(result).success).toBe(false);
    }
  });

  it("keeps the archived conversation wire shape bounded and cursor-namespaced", () => {
    const archived = archivedTranscriptCursor();
    expect(
      GetArchivedTranscriptPageRpcParamsSchema.parse({
        boundaryRef: BOUNDARY_REF,
        cursor: archived,
        limit: 50,
      }),
    ).toEqual({ boundaryRef: BOUNDARY_REF, cursor: archived, limit: 50 });
    expect(
      GetArchivedTranscriptPageRpcResultSchema.parse({
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
        nextCursor: archived,
      }),
    ).toMatchObject({ status: "page", nextCursor: archived });
    for (const request of [
      { boundaryRef: BOUNDARY_REF, cursor: null, limit: 0 },
      { boundaryRef: BOUNDARY_REF, cursor: null, limit: 51 },
      { boundaryRef: BOUNDARY_REF.toUpperCase(), cursor: null, limit: 25 },
      { boundaryRef: "a".repeat(63), cursor: null, limit: 25 },
      { boundaryRef: BOUNDARY_REF, cursor: transcriptCursor(), limit: 25 },
      { cursor: null, limit: 25 },
      { boundaryRef: BOUNDARY_REF, cursor: null, limit: 25, chatId: "other" },
    ]) {
      expect(GetArchivedTranscriptPageRpcParamsSchema.safeParse(request).success).toBe(false);
    }
    expect(
      GetArchivedTranscriptPageRpcResultSchema.safeParse({
        schemaVersion: 1,
        status: "page",
        turns: [],
        nextCursor: transcriptCursor(),
      }).success,
    ).toBe(false);
    expect(
      GetTranscriptPageRpcParamsSchema.safeParse({ cursor: archived, limit: 25 }).success,
    ).toBe(false);

    const summary = {
      boundaryRef: BOUNDARY_REF,
      boundaryAt: "1998-07-06T00:00:00.000Z",
      reason: "explicit-reset",
      turnCount: 4,
    };
    expect(ListArchivedConversationsRpcParamsSchema.parse({})).toEqual({});
    expect(
      ListArchivedConversationsRpcResultSchema.parse({
        schemaVersion: 1,
        conversations: [summary],
        truncated: false,
      }),
    ).toEqual({ schemaVersion: 1, conversations: [summary], truncated: false });
    for (const result of [
      { schemaVersion: 1, conversations: [summary, summary], truncated: false },
      { schemaVersion: 1, conversations: [summary], truncated: true },
      { schemaVersion: 1, conversations: [{ ...summary, reason: "idle-reset" }], truncated: false },
      {
        schemaVersion: 1,
        conversations: [{ ...summary, boundaryAt: "1998-07-06T00:00:00Z" }],
        truncated: false,
      },
      { schemaVersion: 1, conversations: [{ ...summary, turnCount: -1 }], truncated: false },
      { schemaVersion: 1, conversations: [summary], truncated: false, chatId: "desktop" },
    ]) {
      expect(ListArchivedConversationsRpcResultSchema.safeParse(result).success).toBe(false);
    }
    expect(ListArchivedConversationsRpcParamsSchema.safeParse({ chatId: "desktop" }).success).toBe(
      false,
    );
    expect(DeleteArchivedConversationRpcParamsSchema.parse({ boundaryRef: BOUNDARY_REF })).toEqual({
      boundaryRef: BOUNDARY_REF,
    });
    for (const request of [
      { boundaryRef: BOUNDARY_REF.toUpperCase() },
      { boundaryRef: BOUNDARY_REF, chatId: "desktop" },
      {},
    ]) {
      expect(DeleteArchivedConversationRpcParamsSchema.safeParse(request).success).toBe(false);
    }
    for (const status of ["deleted", "not-found"] as const) {
      expect(DeleteArchivedConversationRpcResultSchema.parse({ schemaVersion: 1, status })).toEqual(
        { schemaVersion: 1, status },
      );
    }
    for (const result of [
      { schemaVersion: 2, status: "deleted" },
      { schemaVersion: 1, status: "missing" },
      { schemaVersion: 1, status: "deleted", boundaryRef: BOUNDARY_REF },
    ]) {
      expect(DeleteArchivedConversationRpcResultSchema.safeParse(result).success).toBe(false);
    }
  });

  it("rejects every nested non-JSON resolvedCs value at every wire boundary", () => {
    const values = [() => undefined, Symbol("x"), undefined, 1n, NaN, Infinity, -Infinity];
    for (const value of values) {
      const params = {
        chatId: "chat-1",
        message: "hello",
        turn: { resolvedCs: { nested: value } },
      };
      const request = { jsonrpc: "2.0", id: 1, method: "chat", params };
      expect(ChatRpcParamsSchema.safeParse(params).success).toBe(false);
      expect(CoachRpcRequestEnvelopeSchema.safeParse(request).success).toBe(false);
      expect(CoachRpcEnvelopeSchema.safeParse(request).success).toBe(false);
      expect(() => serializeCoachRpcEnvelope(request)).toThrow();
    }
  });

  it("binds notification request and turn identifiers", () => {
    expect(CoachTurnEventNotificationEnvelopeSchema.parse(notification)).toEqual(notification);
    expect(
      CoachTurnEventNotificationEnvelopeSchema.safeParse({
        ...notification,
        params: { ...notification.params, turnId: "turn-2" },
      }).success,
    ).toBe(false);
    expect(
      CoachTurnEventNotificationEnvelopeSchema.safeParse({
        ...notification,
        params: { ...notification.params, requestMethod: "hasSession" },
      }).success,
    ).toBe(false);
  });

  it("validates operational paths, balanced results, and progress", () => {
    expect(ImportFilesRpcParamsSchema.parse({ paths: ["/synthetic/ride.fit"] })).toEqual({
      paths: ["/synthetic/ride.fit"],
    });
    for (const paths of [
      ["ride.fit"],
      ["/synthetic/a.fit", "/synthetic/a.fit"],
      [],
      ["/synthetic/\0.fit"],
    ]) {
      expect(ImportFilesRpcParamsSchema.safeParse({ paths }).success).toBe(false);
    }
    const importResult = {
      schemaVersion: 2,
      files: { total: 2, imported: 1, quarantined: 1 },
      changes: {
        rawFilesInserted: 1,
        sourceRecordsInserted: 1,
        sourceRecordsUpdated: 0,
        relinkedSourceRecords: 0,
      },
      publication: {
        scope: "activities-and-streams",
        status: "available",
      },
    } as const;
    expect(ImportFilesRpcResultSchema.parse(importResult)).toEqual(importResult);
    for (const invalid of [
      { ...importResult, schemaVersion: 1 },
      { ...importResult, files: { ...importResult.files, total: 3 } },
      { ...importResult, files: { ...importResult.files, extra: true } },
      { ...importResult, changes: { ...importResult.changes, extra: true } },
      { ...importResult, publication: { ...importResult.publication, scope: "activities" } },
      { ...importResult, publication: { ...importResult.publication, status: "failed" } },
      { ...importResult, publication: { ...importResult.publication, extra: true } },
      { ...importResult, publication: undefined },
      { ...importResult, extra: true },
    ]) {
      expect(ImportFilesRpcResultSchema.safeParse(invalid).success).toBe(false);
    }
    expect(
      ImportFilesRpcResultSchema.parse({
        ...importResult,
        publication: { ...importResult.publication, status: "retryable-failure" },
      }),
    ).toMatchObject({
      publication: { scope: "activities-and-streams", status: "retryable-failure" },
    });
    const syncResult = {
      schemaVersion: 1,
      published: true,
      referenceSucceeded: true,
      requests: { store: 2, reference: 1, total: 3 },
      droppedActivities: {
        overall: { total: 0, visible: 0, restrictions: [], other: 0 },
        recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
      },
    } as const;
    expect(SyncRpcResultSchema.parse(syncResult)).toEqual(syncResult);
    for (const backfill of [
      "completed",
      "skipped-no-credential",
      "pending-verification",
    ] as const) {
      expect(SyncRpcResultSchema.parse({ ...syncResult, backfill })).toEqual({
        ...syncResult,
        backfill,
      });
    }
    expect(SyncRpcResultSchema.safeParse({ ...syncResult, backfill: "skipped" }).success).toBe(
      false,
    );
    expect(
      SyncRpcResultSchema.safeParse({
        ...syncResult,
        requests: { ...syncResult.requests, total: 4 },
      }).success,
    ).toBe(false);
    const restricted = {
      overall: {
        total: 67,
        visible: 5,
        restrictions: [{ reason: "source-restricted", source: "STRAVA", count: 60 }],
        other: 2,
      },
      recent7Days: {
        total: 5,
        visible: 1,
        restrictions: [{ reason: "source-restricted", source: "STRAVA", count: 4 }],
        other: 0,
      },
    } as const;
    expect(
      SyncRpcResultSchema.parse({ ...syncResult, droppedActivities: restricted }).droppedActivities,
    ).toEqual(restricted);
    expect(
      SyncRpcResultSchema.safeParse({
        ...syncResult,
        droppedActivities: {
          overall: {
            total: 67,
            visible: 5,
            restrictions: [
              { reason: "source-restricted", source: "GARMIN_CONNECT", count: 10 },
              { reason: "source-restricted", source: "STRAVA", count: 50 },
            ],
            other: 2,
          },
          recent7Days: {
            total: 5,
            visible: 1,
            restrictions: [
              { reason: "source-restricted", source: "GARMIN_CONNECT", count: 1 },
              { reason: "source-restricted", source: "STRAVA", count: 3 },
            ],
            other: 0,
          },
        },
      }).success,
    ).toBe(true);
    for (const droppedActivities of [
      { ...restricted, overall: { ...restricted.overall, total: 68 } },
      {
        ...restricted,
        recent7Days: {
          total: 62,
          visible: 1,
          restrictions: [{ reason: "source-restricted", source: "STRAVA", count: 61 }],
          other: 0,
        },
      },
      {
        ...restricted,
        overall: {
          total: 67,
          visible: 5,
          restrictions: [
            { reason: "source-restricted", source: "STRAVA", count: 30 },
            { reason: "source-restricted", source: "STRAVA", count: 30 },
          ],
          other: 2,
        },
      },
    ]) {
      expect(SyncRpcResultSchema.safeParse({ ...syncResult, droppedActivities }).success).toBe(
        false,
      );
    }
    expect(
      OperationProgressEventSchema.parse({ phase: "started", completed: 0, total: 1 }),
    ).toEqual({ phase: "started", completed: 0, total: 1 });
    expect(
      OperationProgressEventSchema.parse({ phase: "completed", completed: 1, total: 1 }),
    ).toEqual({ phase: "completed", completed: 1, total: 1 });
    expect(
      OperationProgressEventSchema.safeParse({ phase: "completed", completed: 0, total: 1 })
        .success,
    ).toBe(false);
    expect(CoachOperationProgressNotificationEnvelopeSchema.parse(progressNotification)).toEqual(
      progressNotification,
    );
  });

  it("validates strict intake and runtime configuration round trips", () => {
    const safeIntake = {
      swim_skill_floor: null,
      continuous_distance_capable: null,
      open_water_comfort: null,
      prior_bsi: false,
      clinician_cleared: null,
      injury_status: "none",
    } as const;
    const clearedIntake = {
      ...safeIntake,
      clinician_cleared: true,
      injury_status: "returning",
    } as const;
    expect(SaveIntakeRpcParamsSchema.parse(safeIntake)).toEqual(safeIntake);
    expect(SaveIntakeRpcParamsSchema.parse(clearedIntake)).toEqual(clearedIntake);
    const historicalIntake = {
      ...safeIntake,
      prior_bsi: true,
      clinician_cleared: true,
    } as const;
    expect(SaveIntakeRpcParamsSchema.parse(historicalIntake)).toEqual(historicalIntake);
    const unclearedIntake = { ...clearedIntake, clinician_cleared: null } as const;
    expect(SaveIntakeRpcParamsSchema.parse(unclearedIntake)).toEqual(unclearedIntake);
    const priorBsiIntake = { ...safeIntake, prior_bsi: true } as const;
    expect(SaveIntakeRpcParamsSchema.parse(priorBsiIntake)).toEqual(priorBsiIntake);
    const { prior_bsi: _priorBsi, ...withoutPriorBsi } = safeIntake;
    for (const invalid of [
      withoutPriorBsi,
      { ...safeIntake, swim_skill_floor: "novice" },
      { ...safeIntake, extra: true },
      { ...safeIntake, clinician_cleared: true },
    ]) {
      expect(SaveIntakeRpcParamsSchema.safeParse(invalid).success).toBe(false);
    }
    expect(SaveIntakeRpcResultSchema.parse({ schemaVersion: 1, saved: true })).toEqual({
      schemaVersion: 1,
      saved: true,
    });
    const setupStatus = {
      schemaVersion: 1,
      intake: clearedIntake,
      durableTrainingData: true,
    } as const;
    expect(GetSetupStatusRpcParamsSchema.parse({})).toEqual({});
    expect(GetSetupStatusRpcResultSchema.parse(setupStatus)).toEqual(setupStatus);
    expect(
      GetSetupStatusRpcResultSchema.parse({ ...setupStatus, intake: unclearedIntake }).intake
        ?.clinician_cleared,
    ).toBeNull();
    for (const invalid of [
      { ...setupStatus, apiKey: "must-not-cross-boundary" },
      { ...setupStatus, intake: { ...setupStatus.intake, credential: "must-not-cross-boundary" } },
      { ...setupStatus, intake: { ...safeIntake, clinician_cleared: true } },
      { ...setupStatus, importedPaths: [] },
    ]) {
      expect(GetSetupStatusRpcResultSchema.safeParse(invalid).success).toBe(false);
    }

    const llm = {
      provider: "openrouter",
      model: "model-a",
      api_key: "placeholder",
      base_url: "https://invalid.example.test/v1",
      flush_model: "model-flush",
      compact_model: null,
    } as const;
    const codex = { provider: "openai-codex" } as const;
    const intervals = { api_key: "placeholder" } as const;
    for (const params of [
      { llm },
      { llm: codex },
      { llm: { model: "model-only" } },
      { llm: { provider: "anthropic", clear_credential: true } },
      { intervals },
      {
        intervals: {
          api_key: "placeholder",
          verification_approval: INTERVALS_APPROVAL,
        },
      },
      { intervals: { athlete_id: "athlete-a" } },
      { intervals: { clear_credential: true } },
      {
        session: {
          historyTokenBudgetRatio: 0.4,
          idleMinutes: 30,
          dailyResetHour: 3,
          resetArchiveRetentionDays: 14,
          timezone: "America/Denver",
        },
      },
      { session: { timezone: "  Europe/London  " } },
      { llm, intervals },
      { llm: { provider: "claude-cli", model: "sonnet" } },
      {
        llm: {
          provider: "claude-cli",
          claude_cli: {
            enabled: false,
            binary_path: "/opt/synthetic/bin/claude",
            config_dir: "/synthetic/claude-config",
            billing: "api-key",
          },
        },
      },
    ]) {
      const parsed = ConfigureRuntimeRpcParamsSchema.parse(params);
      if (params.session?.timezone === "  Europe/London  ") {
        expect(parsed).toEqual({ session: { timezone: "Europe/London" } });
      } else {
        expect(parsed).toEqual(params);
      }
    }
    for (const invalid of [
      {},
      { llm: {} },
      { intervals: {} },
      { session: {} },
      { session: { timezone: undefined } },
      { session: { historyTokenBudgetRatio: 0 } },
      { session: { historyTokenBudgetRatio: 1.01 } },
      { session: { idleMinutes: -1 } },
      { session: { idleMinutes: Number.MAX_SAFE_INTEGER + 1 } },
      { session: { dailyResetHour: 24 } },
      { session: { resetArchiveRetentionDays: -1 } },
      { session: { timezone: " " } },
      { session: { timezone: "Not/A-Timezone" } },
      { session: { timezone: "a".repeat(513) } },
      { llm: { ...llm, extra: true } },
      { llm: { provider: "openai-codex", api_key: "placeholder" } },
      { llm: { provider: "claude-cli", api_key: "placeholder" } },
      { llm: { provider: "claude-cli", claude_cli: { billing: "invoice" } } },
      { llm: { provider: "claude-cli", claude_cli: { extra: true } } },
      { llm: { clear_credential: true } },
      { llm: { provider: "anthropic", clear_credential: true, model: "model-a" } },
      {
        llm: { provider: "anthropic", clear_credential: true },
        session: { timezone: "UTC" },
      },
      { intervals: { api_key: "" } },
      { intervals: { verification_approval: INTERVALS_APPROVAL } },
      { intervals: { api_key: "placeholder", verification_approval: "A".repeat(64) } },
      { intervals: { api_key: "placeholder", verification_approval: "a".repeat(63) } },
      { intervals: { clear_credential: true, athlete_id: "athlete-a" } },
      {
        llm: { provider: "anthropic", clear_credential: true },
        intervals: { clear_credential: true },
      },
      { intervals: { athlete_id: "" } },
      { llm, extra: true },
    ]) {
      expect(ConfigureRuntimeRpcParamsSchema.safeParse(invalid).success).toBe(false);
    }
    const result = {
      schemaVersion: 3,
      status: "applied",
      applied: { llm: true, intervals: false, session: false },
    } as const;
    expect(ConfigureRuntimeRpcResultSchema.parse(result)).toEqual(result);
    expect(
      ConfigureRuntimeRpcResultSchema.safeParse({ ...result, api_key: "placeholder" }).success,
    ).toBe(false);
    for (const reason of [
      "credential-required",
      "ownership-unavailable",
      "training-account-mismatch",
      "managed-by-environment",
    ] as const) {
      const refused = { schemaVersion: 3, status: "refused", reason } as const;
      expect(ConfigureRuntimeRpcResultSchema.parse(refused)).toEqual(refused);
    }
    expect(
      ConfigureRuntimeRpcResultSchema.safeParse({
        schemaVersion: 3,
        status: "refused",
        reason: "ownership-unavailable",
        applied: { llm: false, intervals: false, session: false },
      }).success,
    ).toBe(false);
    expect(JSON.stringify(result)).not.toContain("placeholder");
    expect(IntervalsCredentialApprovalSchema.parse(INTERVALS_APPROVAL)).toBe(INTERVALS_APPROVAL);
    expect(VerifyIntervalsCredentialRpcParamsSchema.parse({ api_key: "placeholder" })).toEqual({
      api_key: "placeholder",
    });
    for (const invalid of [
      {},
      { api_key: "" },
      { api_key: "placeholder", athlete_id: "athlete-a" },
    ]) {
      expect(VerifyIntervalsCredentialRpcParamsSchema.safeParse(invalid).success).toBe(false);
    }
    expect(
      VerifyIntervalsCredentialRpcResultSchema.parse({ approval: INTERVALS_APPROVAL }),
    ).toEqual({ approval: INTERVALS_APPROVAL });
    for (const reason of IntervalsCredentialVerificationRefusalReasonSchema.options) {
      expect(VerifyIntervalsCredentialRpcResultSchema.parse({ reason })).toEqual({ reason });
    }
    for (const invalid of [
      { approval: "A".repeat(64) },
      { approval: INTERVALS_APPROVAL, reason: "credential-rejected" },
      { reason: "credential-rejected", status: "refused" },
      { reason: "unknown" },
    ]) {
      expect(VerifyIntervalsCredentialRpcResultSchema.safeParse(invalid).success).toBe(false);
    }
    const snapshot = {
      schemaVersion: 3,
      llm: {
        provider: "openrouter",
        model: "model-a",
        credential_configured: true,
      },
      intervals: {
        athlete_id: "athlete-a",
        credential_configured: true,
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
    } as const;
    expect(GetRuntimeConfigRpcResultSchema.parse(snapshot)).toEqual(snapshot);
    expect(
      GetRuntimeConfigRpcResultSchema.parse({
        ...snapshot,
        intervals: { ...snapshot.intervals, credential_verification_pending: true },
      }),
    ).toEqual({
      ...snapshot,
      intervals: { ...snapshot.intervals, credential_verification_pending: true },
    });
    expect(
      GetRuntimeConfigRpcResultSchema.safeParse({
        ...snapshot,
        intervals: { ...snapshot.intervals, credential_verification_pending: "true" },
      }).success,
    ).toBe(false);
    expect(
      GetRuntimeConfigRpcResultSchema.parse({
        ...snapshot,
        llm: {
          provider: "openrouter",
          model: "model-a",
          credential_configured: true,
        },
        intervals: {
          athlete_id: "",
          credential_configured: false,
          managedByEnvironment: { athleteId: true },
        },
      }),
    ).toEqual({
      ...snapshot,
      llm: {
        provider: "openrouter",
        model: "model-a",
        credential_configured: true,
      },
      intervals: {
        athlete_id: "",
        credential_configured: false,
        managedByEnvironment: { athleteId: true },
      },
    });
    for (const malformed of [
      { ...snapshot, api_key: "placeholder" },
      { ...snapshot, llm: { ...snapshot.llm, api_key: "placeholder" } },
      {
        ...snapshot,
        llm: {
          provider: snapshot.llm.provider,
          model: snapshot.llm.model,
        },
      },
      { ...snapshot, llm: { ...snapshot.llm, credential_configured: "true" } },
      { ...snapshot, intervals: { ...snapshot.intervals, api_key: "placeholder" } },
      { ...snapshot, intervals: { ...snapshot.intervals, athlete_id: "a".repeat(513) } },
      {
        ...snapshot,
        intervals: {
          athlete_id: "athlete-a",
          credential_configured: true,
        },
      },
      {
        ...snapshot,
        intervals: {
          ...snapshot.intervals,
          managedByEnvironment: { athleteId: "false" },
        },
      },
      {
        ...snapshot,
        session: {
          historyTokenBudgetRatio: 0.3,
          idleMinutes: 0,
          dailyResetHour: 4,
          resetArchiveRetentionDays: 0,
          timezone: "UTC",
        },
      },
      {
        ...snapshot,
        session: {
          ...snapshot.session,
          managedByEnvironment: {
            ...snapshot.session.managedByEnvironment,
            timezone: "false",
          },
        },
      },
      { ...snapshot, session: { ...snapshot.session, dataDir: "/private" } },
      { ...snapshot, llm: { provider: "openrouter" } },
    ]) {
      expect(GetRuntimeConfigRpcResultSchema.safeParse(malformed).success).toBe(false);
    }
    expect(
      GetRuntimeConfigRpcResultSchema.safeParse({
        ...snapshot,
        llm: { ...snapshot.llm, base_url: "https://api.example.invalid/v1" },
      }).success,
    ).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain("api_key");
    expect(LlmProviderSchema.options).toEqual([
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
  });

  it("keeps the method registry exhaustive and schema-identical", async () => {
    const fake: CoachRpcService = {
      chat: async () => ({ text: "ok" }),
      stopChat: async () => ({ stopped: true }),
      admitChatAttachment: async ({ selectionId }) => ({
        selectionId,
        displayName: "activity.fit",
        status: "storage_failed",
        failureCode: "admission_unavailable",
        retryable: false,
      }),
      admitPastedChatAttachment: async ({ selectionId, displayName }) => ({
        selectionId,
        displayName,
        status: "storage_failed",
        failureCode: "admission_unavailable",
        retryable: false,
      }),
      getChatAttachmentComposer: async () => ({
        schemaVersion: 1,
        capabilities: {
          schemaVersion: 1,
          active: { provider: "test", model: "text-only", transport: "test" },
          documents: { enabled: true, extensions: ["pdf", "txt", "csv", "docx"] },
          completedActivities: { enabled: true, extensions: ["fit", "tcx", "gpx"] },
          plannedWorkouts: { enabled: true, extensions: ["zwo", "erg", "mrc"] },
          images: {
            enabled: false,
            mediaTypes: [],
            reason: "model_incompatible",
            source: "maintained_catalogue",
            checkedAt: "2026-08-26T00:00:00.000Z",
          },
        },
        draft: null,
      }),
      saveChatAttachmentDraftText: async () =>
        fake.getChatAttachmentComposer!({ chatId: "desktop" }),
      removeChatAttachment: async () => fake.getChatAttachmentComposer!({ chatId: "desktop" }),
      retryChatAttachment: async () => fake.getChatAttachmentComposer!({ chatId: "desktop" }),
      selectChatAttachmentWorkout: async () =>
        fake.getChatAttachmentComposer!({ chatId: "desktop" }),
      clearChatAttachmentDraft: async () => fake.getChatAttachmentComposer!({ chatId: "desktop" }),
      enqueueChatMessage: async () => ({ schemaVersion: 1, revision: 1, items: [] }),
      getChatQueue: async () => ({ schemaVersion: 1, revision: 1, items: [] }),
      removeQueuedChatMessage: async () => ({ schemaVersion: 1, revision: 2, items: [] }),
      resumeChatQueue: async () => ({
        snapshot: { schemaVersion: 1, revision: 2, items: [] },
      }),
      runQueuedCommand: async () => ({
        snapshot: { schemaVersion: 1, revision: 2, items: [] },
      }),
      retryQueuedTurn: async () => ({
        snapshot: { schemaVersion: 1, revision: 2, items: [] },
      }),
      resetSession: async () => ({ memoryFlushed: true }),
      hasSession: async () => ({ hasSession: false }),
      getCoachDecision: async () => ({ decision: null }),
      answerCoachDecision: async ({ chatId, decisionId, answer }) => ({
        decision: {
          status: "answered",
          decisionId,
          chatId,
          messageId: "message-1",
          question: "Choose.",
          options: [
            {
              id: "first",
              label: "First",
              description: "Choose the first option.",
              recommended: true,
              consequence: "Use the first option.",
            },
            {
              id: "second",
              label: "Second",
              description: "Choose the second option.",
              recommended: false,
              consequence: "Use the second option.",
            },
          ],
          answer,
          consequence: "Use the selected option.",
          continuation: { continuationId: "continuation-1", status: "pending" },
        },
      }),
      skipCoachDecision: async ({ chatId, decisionId }) => ({
        decision: {
          status: "skipped",
          decisionId,
          chatId,
          messageId: "message-1",
          question: "Choose.",
          options: [
            {
              id: "first",
              label: "First",
              description: "Choose the first option.",
              recommended: true,
              consequence: "Use the first option.",
            },
            {
              id: "second",
              label: "Second",
              description: "Choose the second option.",
              recommended: false,
              consequence: "Use the second option.",
            },
          ],
        },
      }),
      resumeCoachDecision: async ({ chatId, decisionId }) => ({
        resumed: false,
        decision: {
          status: "answered",
          decisionId,
          chatId,
          messageId: "message-1",
          question: "Choose.",
          options: [
            {
              id: "first",
              label: "First",
              description: "Choose the first option.",
              recommended: true,
              consequence: "Use the first option.",
            },
            {
              id: "second",
              label: "Second",
              description: "Choose the second option.",
              recommended: false,
              consequence: "Use the second option.",
            },
          ],
          answer: { kind: "option", optionId: "first" },
          consequence: "Use the first option.",
          continuation: {
            continuationId: "continuation-1",
            status: "completed",
            turnId: "turn-1",
            coachText: "I will use the first option.",
          },
        },
      }),
      getTranscriptPage: async () => ({
        schemaVersion: 1,
        status: "page",
        turns: [],
        nextCursor: null,
      }),
      listArchivedConversations: async () => ({
        schemaVersion: 1,
        conversations: [],
        truncated: false,
      }),
      deleteArchivedConversation: async () => ({
        schemaVersion: 1,
        status: "deleted" as const,
      }),
      getArchivedTranscriptPage: async () => ({
        schemaVersion: 1,
        status: "page",
        turns: [],
        nextCursor: null,
      }),
      getAthleteState: async () =>
        AthleteStateSchema.parse({
          schemaVersion: "1",
          lastUpdated: "2020-01-01T00:00:00.000Z",
          freshness: "fresh",
          degraded: false,
          lastSynced: null,
          athleteProfile: {},
          currentStatus: {},
          derivedMetrics: {},
          recentActivities: [],
          plannedWorkouts: [],
          wellness: {},
        }),
      getPlanningReadModel: async () => ({
        schemaVersion: 1,
        status: "no-plan" as const,
        asOfDateKey: 20260826,
        plan: null,
      }),
      getActivityAnalysis: async () => {
        throw new Error("not exercised by registry exhaustiveness");
      },
      exportTrainingFile: async () => ({
        status: "refused",
        reason: "not-configured",
      }),
      importFiles: async ({ paths }) => ({
        schemaVersion: 2,
        files: { total: paths.length, imported: paths.length, quarantined: 0 },
        changes: {
          rawFilesInserted: 0,
          sourceRecordsInserted: 0,
          sourceRecordsUpdated: 0,
          relinkedSourceRecords: 0,
        },
        publication: { scope: "activities-and-streams", status: "available" },
      }),
      sync: async () => ({
        schemaVersion: 1,
        published: false,
        referenceSucceeded: true,
        requests: { store: 0, reference: 0, total: 0 },
        droppedActivities: {
          overall: { total: 0, visible: 0, restrictions: [], other: 0 },
          recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
        },
      }),
      getSetupStatus: async () => ({
        schemaVersion: 1,
        intake: null,
        durableTrainingData: false,
      }),
      saveIntake: async () => ({ schemaVersion: 1, saved: true }),
      configureRuntime: async ({ llm, intervals, session }) => ({
        schemaVersion: 3,
        status: "applied",
        applied: {
          llm: llm !== undefined,
          intervals: intervals !== undefined,
          session: session !== undefined,
        },
      }),
      verify_intervals_credential: async () => ({ approval: INTERVALS_APPROVAL }),
      getRuntimeConfig: async () => ({
        schemaVersion: 3,
        llm: { provider: "anthropic", model: "model", credential_configured: false },
        intervals: {
          athlete_id: "athlete",
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
      }),
      getUnitsPreference: async () => ({ value: "metric", source: "default" }),
      setUnitsPreference: async ({ value }) => ({ value, source: "cycling" }),
      configureTelegram: async () => ({ outcome: "applied", current: telegramSnapshot }),
      enableTelegram: async () => telegramSnapshot,
      disableTelegram: async () => telegramSnapshot,
      suspendTelegramPolling: async () => telegramSnapshot,
      resumeTelegramPolling: async () => telegramSnapshot,
      drainTelegram: async () => telegramSnapshot,
      replaceTelegram: async () => ({ outcome: "applied", current: telegramSnapshot }),
      getTelegramStatus: async () => telegramSnapshot,
      reconcileTelegram: async () => telegramSnapshot,
      inspectTelegramCredential: async () => ({
        status: "ready",
        bot: { id: 10001, username: "sample_bot" },
      }),
      deleteTelegramWebhook: async () => ({
        status: "ready",
        bot: { id: 10001, username: "sample_bot" },
      }),
      forgetTelegramCredential: async () => telegramSnapshot,
      resetTelegramAccess: async () => telegramSnapshot,
      beginTelegramPairing: async () => telegramSnapshot,
      cancelTelegramPairing: async () => telegramSnapshot,
      listTelegramAllowedSenders: async () => ({ senders: [] }),
      addTelegramAllowedSender: async () => ({ outcome: "applied", current: { senders: [] } }),
      removeTelegramAllowedSender: async () => ({
        outcome: "uncertain",
        reason: "storage-uncertain",
      }),
      getSpendSummary: async () => spendSummary,
      setDailySpendCap: async () => spendSummary,
      selfTest: async () => ({
        schemaVersion: 1,
        type: "self-test-terminal",
        ok: false,
        error: { code: "RUNNER_ERROR", message: "packaged self-test failed" },
      }),
      getPlanState: async () => ({
        status: "unsupported-capability",
        capability: "planning",
      }),
      executePlanTransition: async () => ({
        status: "unsupported-capability",
        capability: "planning",
      }),
      createPlanningRequest: async () => ({
        status: "rejected",
        reason: "invalid_request",
      }),
      createWorkoutPlanningRequest: async () => ({
        status: "rejected",
        reason: "invalid_request",
      }),
      getPlanningRequest: async () => ({ status: "missing" }),
      retryPlanningRequest: async () => ({ status: "missing" }),
      resumePlanningRequests: async () => ({ deliveries: [] }),
      listPlanningRequests: async () => ({ deliveries: [], planCreation: null }),
      "plan_creation.start": async () => ({
        status: "rejected",
        reason: "command-conflict",
      }),
      "plan_creation.answer": async () => ({
        status: "rejected",
        reason: "no-unfinished-creation",
        planCreation: null,
      }),
    };
    expect(Object.keys(COACH_RPC_METHOD_REGISTRY)).toEqual(Object.keys(fake));
    expect(COACH_RPC_METHOD_NAMES).toEqual(Object.keys(fake));
    expect(COACH_RPC_METHOD_REGISTRY.chat).toEqual({
      wireName: "chat",
      requestSchema: ChatRpcParamsSchema,
      responseSchema: ChatResponseSchema,
      eventSchema: TurnEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.resetSession).toEqual({
      wireName: "resetSession",
      requestSchema: ResetSessionRequestSchema,
      responseSchema: ResetSessionResponseSchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.hasSession).toEqual({
      wireName: "hasSession",
      requestSchema: HasSessionRequestSchema,
      responseSchema: HasSessionResponseSchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.getTranscriptPage).toEqual({
      wireName: "getTranscriptPage",
      requestSchema: GetTranscriptPageRpcParamsSchema,
      responseSchema: GetTranscriptPageRpcResultSchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.listArchivedConversations).toEqual({
      wireName: "listArchivedConversations",
      requestSchema: ListArchivedConversationsRpcParamsSchema,
      responseSchema: ListArchivedConversationsRpcResultSchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.deleteArchivedConversation).toEqual({
      wireName: "deleteArchivedConversation",
      requestSchema: DeleteArchivedConversationRpcParamsSchema,
      responseSchema: DeleteArchivedConversationRpcResultSchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.getArchivedTranscriptPage).toEqual({
      wireName: "getArchivedTranscriptPage",
      requestSchema: GetArchivedTranscriptPageRpcParamsSchema,
      responseSchema: GetArchivedTranscriptPageRpcResultSchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.getAthleteState).toEqual({
      wireName: "getAthleteState",
      requestSchema: EmptyRpcParamsSchema,
      responseSchema: AthleteStateSchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.importFiles).toEqual({
      wireName: "importFiles",
      requestSchema: ImportFilesRpcParamsSchema,
      responseSchema: ImportFilesRpcResultSchema,
      eventSchema: OperationProgressEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.sync).toEqual({
      wireName: "sync",
      requestSchema: SyncRpcParamsSchema,
      responseSchema: SyncRpcResultSchema,
      eventSchema: OperationProgressEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.getSetupStatus).toEqual({
      wireName: "getSetupStatus",
      requestSchema: GetSetupStatusRpcParamsSchema,
      responseSchema: GetSetupStatusRpcResultSchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.saveIntake).toEqual({
      wireName: "saveIntake",
      requestSchema: SaveIntakeRpcParamsSchema,
      responseSchema: SaveIntakeRpcResultSchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.configureRuntime).toEqual({
      wireName: "configureRuntime",
      requestSchema: ConfigureRuntimeRpcParamsSchema,
      responseSchema: ConfigureRuntimeRpcResultSchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.verify_intervals_credential).toEqual({
      wireName: "verify_intervals_credential",
      requestSchema: VerifyIntervalsCredentialRpcParamsSchema,
      responseSchema: VerifyIntervalsCredentialRpcResultSchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.getRuntimeConfig).toEqual({
      wireName: "getRuntimeConfig",
      requestSchema: GetRuntimeConfigRpcParamsSchema,
      responseSchema: GetRuntimeConfigRpcResultSchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.getUnitsPreference).toEqual({
      wireName: "getUnitsPreference",
      requestSchema: GetUnitsPreferenceRpcParamsSchema,
      responseSchema: GetUnitsPreferenceRpcResultSchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.setUnitsPreference).toEqual({
      wireName: "setUnitsPreference",
      requestSchema: SetUnitsPreferenceRpcParamsSchema,
      responseSchema: SetUnitsPreferenceRpcResultSchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.configureTelegram).toEqual({
      wireName: "configureTelegram",
      requestSchema: ConfigureTelegramRpcParamsSchema,
      responseSchema: TelegramControlMutationResultSchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.enableTelegram).toEqual({
      wireName: "enableTelegram",
      requestSchema: EmptyRpcParamsSchema,
      responseSchema: TelegramControlSnapshotSchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.disableTelegram).toEqual({
      wireName: "disableTelegram",
      requestSchema: EmptyRpcParamsSchema,
      responseSchema: TelegramControlSnapshotSchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.suspendTelegramPolling).toEqual({
      wireName: "suspendTelegramPolling",
      requestSchema: EmptyRpcParamsSchema,
      responseSchema: TelegramControlSnapshotSchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.resumeTelegramPolling).toEqual({
      wireName: "resumeTelegramPolling",
      requestSchema: EmptyRpcParamsSchema,
      responseSchema: TelegramControlSnapshotSchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.drainTelegram).toEqual({
      wireName: "drainTelegram",
      requestSchema: EmptyRpcParamsSchema,
      responseSchema: TelegramControlSnapshotSchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.replaceTelegram).toEqual({
      wireName: "replaceTelegram",
      requestSchema: ReplaceTelegramRpcParamsSchema,
      responseSchema: TelegramControlMutationResultSchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.getTelegramStatus).toEqual({
      wireName: "getTelegramStatus",
      requestSchema: EmptyRpcParamsSchema,
      responseSchema: TelegramControlSnapshotSchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.reconcileTelegram).toEqual({
      wireName: "reconcileTelegram",
      requestSchema: EmptyRpcParamsSchema,
      responseSchema: TelegramControlSnapshotSchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.inspectTelegramCredential).toEqual({
      wireName: "inspectTelegramCredential",
      requestSchema: InspectTelegramCredentialRpcParamsSchema,
      responseSchema: TelegramCredentialInspectionSchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.deleteTelegramWebhook).toEqual({
      wireName: "deleteTelegramWebhook",
      requestSchema: DeleteTelegramWebhookRpcParamsSchema,
      responseSchema: TelegramCredentialInspectionSchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.forgetTelegramCredential).toEqual({
      wireName: "forgetTelegramCredential",
      requestSchema: EmptyRpcParamsSchema,
      responseSchema: TelegramControlSnapshotSchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.beginTelegramPairing).toEqual({
      wireName: "beginTelegramPairing",
      requestSchema: EmptyRpcParamsSchema,
      responseSchema: TelegramControlSnapshotSchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.cancelTelegramPairing).toEqual({
      wireName: "cancelTelegramPairing",
      requestSchema: EmptyRpcParamsSchema,
      responseSchema: TelegramControlSnapshotSchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.listTelegramAllowedSenders).toEqual({
      wireName: "listTelegramAllowedSenders",
      requestSchema: EmptyRpcParamsSchema,
      responseSchema: TelegramAllowedSendersResultSchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.addTelegramAllowedSender).toEqual({
      wireName: "addTelegramAllowedSender",
      requestSchema: TelegramAllowedSenderRpcParamsSchema,
      responseSchema: TelegramAllowedSendersMutationResultSchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.removeTelegramAllowedSender).toEqual({
      wireName: "removeTelegramAllowedSender",
      requestSchema: TelegramAllowedSenderRpcParamsSchema,
      responseSchema: TelegramAllowedSendersMutationResultSchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.getSpendSummary).toEqual({
      wireName: "getSpendSummary",
      requestSchema: GetSpendSummaryRpcParamsSchema,
      responseSchema: SpendSummarySchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.setDailySpendCap).toEqual({
      wireName: "setDailySpendCap",
      requestSchema: SetDailySpendCapRpcParamsSchema,
      responseSchema: SpendSummarySchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.selfTest).toEqual({
      wireName: "selfTest",
      requestSchema: SelfTestRpcParamsSchema,
      responseSchema: SelfTestRpcResultSchema,
      eventSchema: OperationProgressEventSchema,
    });
    for (const method of [
      "resetSession",
      "hasSession",
      "getTranscriptPage",
      "listArchivedConversations",
      "deleteArchivedConversation",
      "getArchivedTranscriptPage",
      "getAthleteState",
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
    ] as const) {
      expect(COACH_RPC_METHOD_REGISTRY[method].eventSchema.safeParse(undefined).success).toBe(
        false,
      );
      expect(COACH_RPC_METHOD_REGISTRY[method].eventSchema.safeParse({}).success).toBe(false);
    }
    await expect(fake.chat({ chatId: "chat-1", message: "hello" })).resolves.toEqual({
      text: "ok",
    });
  });

  it("keeps Desktop Telegram snapshots and sender projections closed", () => {
    expect(TelegramControlSnapshotSchema.parse(telegramSnapshot)).toEqual(telegramSnapshot);
    expect(
      TelegramControlSnapshotSchema.safeParse({ ...telegramSnapshot, token: "private" }).success,
    ).toBe(false);
    expect(
      TelegramAllowedSendersResultSchema.safeParse({
        senders: [
          { senderId: 123_456, role: "primary" },
          { senderId: 123_456, role: "additional" },
        ],
      }).success,
    ).toBe(false);
    expect(
      TelegramAllowedSendersMutationResultSchema.safeParse({
        outcome: "applied",
        current: { senders: [] },
      }).success,
    ).toBe(true);
    expect(
      TelegramAllowedSendersMutationResultSchema.safeParse({
        outcome: "uncertain",
        reason: "storage-uncertain",
      }).success,
    ).toBe(true);
    expect(
      TelegramAllowedSendersMutationResultSchema.safeParse({
        outcome: "uncertain",
        reason: "control-uncertain",
      }).success,
    ).toBe(true);
    expect(
      TelegramAllowedSendersMutationResultSchema.safeParse({
        outcome: "refused",
        reason: "invalid-state",
      }).success,
    ).toBe(true);
    expect(
      TelegramControlSnapshotSchema.safeParse({
        ...telegramSnapshot,
        pairing: { state: "failed", errorCode: "telegram-pairing-storage-uncertain" },
      }).success,
    ).toBe(true);
    for (const malformed of [
      { outcome: "applied", senders: [] },
      { outcome: "uncertain", reason: "storage-uncertain", current: { senders: [] } },
      { outcome: "uncertain", reason: "storage-failed" },
      { outcome: "refused", reason: "primary-removal" },
      { outcome: "refused", reason: "invalid-state", current: { senders: [] } },
      { outcome: "applied", current: { senders: [] }, privateDetail: "private" },
    ]) {
      expect(TelegramAllowedSendersMutationResultSchema.safeParse(malformed).success).toBe(false);
    }
    expect(
      TelegramAllowedSendersResultSchema.safeParse({
        senders: [{ senderId: 123_456, role: "additional" }],
      }).success,
    ).toBe(false);
    expect(
      TelegramControlSnapshotSchema.safeParse({
        ...telegramSnapshot,
        channel: {
          desiredState: "enabled",
          state: "online",
          lastSuccessfulPollAt: "1998-06-01T12:00:00.000Z",
        },
      }).success,
    ).toBe(true);
    expect(
      TelegramControlSnapshotSchema.safeParse({
        ...telegramSnapshot,
        channel: {
          desiredState: "enabled",
          state: "offline-retrying",
          lastSuccessfulPollAt: "not-a-timestamp",
        },
      }).success,
    ).toBe(false);
  });

  it("keeps Telegram configure and replacement outcomes closed and secret-safe", () => {
    expect(
      TelegramControlMutationResultSchema.parse({
        outcome: "applied",
        current: telegramSnapshot,
      }),
    ).toEqual({ outcome: "applied", current: telegramSnapshot });
    for (const reason of [
      "invalid-token",
      "validation-unavailable",
      "webhook-removal-required",
      "invalid-state",
      "release-refused",
    ] as const) {
      expect(
        TelegramControlMutationResultSchema.parse({
          outcome: "refused",
          reason,
          current: telegramSnapshot,
        }),
      ).toEqual({ outcome: "refused", reason, current: telegramSnapshot });
    }
    expect(TelegramControlMutationResultSchema.safeParse(telegramSnapshot).success).toBe(false);
    expect(
      TelegramControlMutationResultSchema.safeParse({
        outcome: "refused",
        reason: "private-token-leaked",
        current: telegramSnapshot,
      }).success,
    ).toBe(false);
    expect(
      TelegramControlMutationResultSchema.safeParse({
        outcome: "refused",
        reason: "invalid-token",
        current: telegramSnapshot,
        token: "private",
      }).success,
    ).toBe(false);
  });

  it("validates strict self-test terminals and rejects contradictory resource results", () => {
    const digest = "a".repeat(64);
    const success = {
      schemaVersion: 1,
      type: "self-test-terminal",
      ok: true,
      runtime: { node: "24.18.0", electron: "43.1.1", v8: "15.0" },
      resources: {
        algorithm: "sha256",
        matrixSha256: digest,
        insideAsarSha256: digest,
        extraResourcesSha256: digest,
        byteIdentical: true,
      },
      suites: {
        parity: { cases: 2, passed: 2 },
        differential: { cases: 3, passed: 3 },
      },
    } as const;
    expect(SelfTestRpcResultSchema.parse(success)).toEqual(success);
    for (const invalid of [
      { ...success, extra: true },
      { ...success, resources: { ...success.resources, matrixSha256: digest.toUpperCase() } },
      { ...success, resources: { ...success.resources, extraResourcesSha256: "b".repeat(64) } },
      { ...success, suites: { ...success.suites, parity: { cases: 2, passed: 1 } } },
      { ...success, suites: { ...success.suites, differential: { cases: 0, passed: 0 } } },
    ]) {
      expect(SelfTestRpcResultSchema.safeParse(invalid).success).toBe(false);
    }
    const unavailable = {
      schemaVersion: 1,
      type: "self-test-terminal",
      ok: false,
      error: {
        code: "DAEMON_UNAVAILABLE",
        message: "Enduragent could not reach the local service.",
      },
    } as const;
    expect(SelfTestRpcResultSchema.safeParse(unavailable).success).toBe(false);
    expect(SelfTestCommandTerminalSchema.parse(unavailable)).toEqual(unavailable);
  });

  it("round trips strict units preference requests and results", () => {
    expect(
      roundTrip({ jsonrpc: "2.0", id: 40, method: "getUnitsPreference", params: {} }),
    ).toMatchObject({ method: "getUnitsPreference" });
    expect(
      roundTrip({
        jsonrpc: "2.0",
        id: 41,
        method: "setUnitsPreference",
        params: { value: "imperial" },
      }),
    ).toMatchObject({ method: "setUnitsPreference" });
    expect(GetUnitsPreferenceRpcResultSchema.parse({ value: "metric", source: "athlete" })).toEqual(
      { value: "metric", source: "athlete" },
    );
    expect(
      SetUnitsPreferenceRpcResultSchema.parse({ value: "imperial", source: "cycling" }),
    ).toEqual({ value: "imperial", source: "cycling" });
    expect(
      SetUnitsPreferenceRpcParamsSchema.safeParse({ value: "metric", extra: true }).success,
    ).toBe(false);
    expect(
      GetUnitsPreferenceRpcResultSchema.safeParse({ value: "other", source: "default" }).success,
    ).toBe(false);
  });

  it("round trips an athlete state result with persisted training context", () => {
    const state = AthleteStateSchema.parse({
      schemaVersion: "1",
      lastUpdated: "2026-07-19T08:00:00.000Z",
      freshness: "fresh",
      degraded: false,
      lastSynced: "2026-07-19T07:55:00.000Z",
      athleteProfile: {},
      currentStatus: {},
      derivedMetrics: {},
      recentActivities: [],
      plannedWorkouts: [],
      wellness: {},
      trainingContext: UNKNOWN_CYCLING_TRAINING_CONTEXT,
    });
    expect(roundTrip({ jsonrpc: "2.0", id: 42, result: state })).toEqual({
      jsonrpc: "2.0",
      id: 42,
      result: state,
    });
    expect(
      AthleteStateSchema.safeParse({
        ...state,
        trainingContext: {
          ...state.trainingContext,
          currentTrainingStress: 72,
        },
      }).success,
    ).toBe(false);
  });
});

describe("handshake", () => {
  it("round trips a protocol-33 accepted frame with its authenticated home and renderer capability", () => {
    const accepted = createAcceptedServerHandshakeFrame("service-managed", PROTOCOL_VERSION, {
      ...acceptedHandshakeBinding,
    });

    expect(ServerHandshakeFrameSchema.parse(JSON.parse(JSON.stringify(accepted)))).toEqual({
      type: "handshake",
      status: "accepted",
      clientProtocolVersion: 34,
      serverProtocolVersion: 34,
      owner: "service-managed",
      athleteHome: "/synthetic/athlete",
      rendererCapability: "A".repeat(43),
    });
  });

  it("refuses a previous-protocol client with a version-mismatch frame instead of a parse error", () => {
    const previous = PROTOCOL_VERSION - 1;
    expect(previous).toBe(33);
    expect(() =>
      createAcceptedServerHandshakeFrame("service-managed", previous, {
        ...acceptedHandshakeBinding,
      }),
    ).toThrow();
    expect(createVersionMismatchServerHandshakeFrame("service-managed", previous)).toEqual({
      type: "handshake",
      status: "version-mismatch",
      clientProtocolVersion: previous,
      serverProtocolVersion: PROTOCOL_VERSION,
      direction: "client-older",
      owner: "service-managed",
    });
    expect(EXIT_VERSION_MISMATCH).toBe(5);
    expect(
      SyncRpcResultSchema.safeParse({
        schemaVersion: 1,
        published: true,
        referenceSucceeded: true,
        requests: { store: 1, reference: 1, total: 2 },
      }).success,
    ).toBe(false);
  });

  it("keeps protocol-11 acceptance available only through the upgrade-control schema", () => {
    const protocol11Accepted = {
      type: "handshake",
      status: "accepted",
      clientProtocolVersion: 11,
      serverProtocolVersion: 11,
      owner: "service-managed",
    } as const;

    expect(Protocol11AcceptedServerHandshakeFrameSchema.parse(protocol11Accepted)).toEqual(
      protocol11Accepted,
    );
    expect(ServerHandshakeFrameSchema.safeParse(protocol11Accepted).success).toBe(false);
  });

  it("accepts only canonical-looking absolute homes and canonical 32-byte capabilities", () => {
    const capabilityEndingInK = Buffer.alloc(32, 9).toString("base64url");
    expect(capabilityEndingInK).toHaveLength(43);
    expect(capabilityEndingInK.endsWith("k")).toBe(true);
    expect(RendererCapabilitySchema.parse(capabilityEndingInK)).toBe(capabilityEndingInK);
    for (const validHome of [
      "/",
      "/synthetic/athlete",
      "C:\\synthetic\\athlete",
      "\\\\synthetic-host\\athletes\\one",
    ]) {
      expect(AthleteHomeIdentitySchema.parse(validHome)).toBe(validHome);
    }

    for (const invalidHome of [
      "relative/athlete",
      "/synthetic/../athlete",
      "/synthetic/./athlete",
      "/synthetic//athlete",
      "/synthetic/athlete/",
    ]) {
      expect(AthleteHomeIdentitySchema.safeParse(invalidHome).success).toBe(false);
    }
    for (const invalidCapability of [
      "A".repeat(42),
      `${"A".repeat(42)}=`,
      `${"A".repeat(42)}!`,
      `${"A".repeat(42)}B`,
    ]) {
      expect(RendererCapabilitySchema.safeParse(invalidCapability).success).toBe(false);
    }
  });

  it("accepts aligned protocol 33 peers and classifies mismatches in both directions", () => {
    const client = createClientHandshakeFrame("synthetic-test-token");
    expect(client.clientProtocolVersion).toBe(34);
    expect(ClientHandshakeFrameSchema.parse(JSON.parse(JSON.stringify(client)))).toEqual(client);
    const accepted = createAcceptedServerHandshakeFrame(
      "service-managed",
      PROTOCOL_VERSION,
      acceptedHandshakeBinding,
    );
    expect(ServerHandshakeFrameSchema.parse(JSON.parse(JSON.stringify(accepted)))).toEqual(
      accepted,
    );
    const oldClient = createVersionMismatchServerHandshakeFrame("ephemeral-client-started", 14, 15);
    const oldServer = createVersionMismatchServerHandshakeFrame("unmanaged-foreground", 16, 15);
    expect(ServerHandshakeFrameSchema.parse(oldClient)).toEqual(oldClient);
    expect(oldClient.direction).toBe("client-older");
    expect(ServerHandshakeFrameSchema.parse(oldServer)).toEqual(oldServer);
    expect(oldServer.direction).toBe("client-newer");
    expect(() =>
      createAcceptedServerHandshakeFrame("service-managed", 14, acceptedHandshakeBinding, 15),
    ).toThrow();
    expect(() =>
      createAcceptedServerHandshakeFrame("service-managed", 15, acceptedHandshakeBinding, 14),
    ).toThrow();
  });

  it("rejects invalid token and fail-open handshake shapes", () => {
    const invalid = [
      { type: "handshake", clientProtocolVersion: 1 },
      { type: "handshake", token: "", clientProtocolVersion: 1 },
      { type: "handshake", token: "x", clientProtocolVersion: 1, extra: true },
      {
        type: "handshake",
        token: "x",
        clientProtocolVersion: PROTOCOL_VERSION,
        authority: "renderer",
      },
      {
        type: "handshake",
        token: "x",
        clientProtocolVersion: PROTOCOL_VERSION,
        athleteHome: "/synthetic/athlete",
      },
      {
        type: "handshake",
        token: "x",
        clientProtocolVersion: PROTOCOL_VERSION,
        rendererCapability: "A".repeat(43),
      },
    ];
    for (const frame of invalid)
      expect(ClientHandshakeFrameSchema.safeParse(frame).success).toBe(false);
    const serverInvalid = [
      {
        type: "handshake",
        status: "accepted",
        clientProtocolVersion: 1,
        serverProtocolVersion: 2,
        owner: "service-managed",
      },
      {
        type: "handshake",
        status: "version-mismatch",
        clientProtocolVersion: 2,
        serverProtocolVersion: 2,
        direction: "client-older",
        owner: "service-managed",
      },
      {
        type: "handshake",
        status: "version-mismatch",
        clientProtocolVersion: 1,
        serverProtocolVersion: 2,
        direction: "client-newer",
        owner: "service-managed",
      },
      {
        type: "handshake",
        status: "future",
        clientProtocolVersion: 1,
        serverProtocolVersion: 1,
        owner: "service-managed",
      },
      {
        type: "handshake",
        status: "accepted",
        clientProtocolVersion: 1,
        serverProtocolVersion: 1,
        owner: "service-managed",
        extra: true,
      },
    ];
    for (const frame of serverInvalid)
      expect(ServerHandshakeFrameSchema.safeParse(frame).success).toBe(false);
  });

  it("pins the closed owner enum and independent comparison truth table", () => {
    expect(DaemonOwnerSchema.options).toEqual([
      "service-managed",
      "ephemeral-client-started",
      "unmanaged-foreground",
      "app-supervised",
    ]);
    expect(compareProtocolVersions(1, 2)).toBe("client-older");
    expect(compareProtocolVersions(2, 2)).toBe("equal");
    expect(compareProtocolVersions(3, 2)).toBe("client-newer");
    expect(() =>
      createAcceptedServerHandshakeFrame("service-managed", 1, acceptedHandshakeBinding, 2),
    ).toThrow();
    expect(() => createVersionMismatchServerHandshakeFrame("service-managed", 2, 2)).toThrow();
  });
});

describe("additive protocol signals", () => {
  it("keeps all existing error kinds and adds detached only", () => {
    for (const kind of [
      "rate_limit",
      "provider-auth",
      "provider-down",
      "intervals",
      "unknown",
      "detached",
    ] as const) {
      expect(AgentErrorKindSchema.parse(kind)).toBe(kind);
    }
    expect(AgentErrorKindSchema.safeParse("aborted").success).toBe(false);
  });

  it("uses protocol version 34", () => {
    expect(PROTOCOL_VERSION).toBe(34);
  });
});
