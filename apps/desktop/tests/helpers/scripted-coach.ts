import type {
  CoachEngine,
  CoachOperations,
  SpendOperations,
  OperationProgressEvent,
  PlanningOperations,
  PlanningRequestOperations,
  PlanProgressEvent,
} from "@enduragent/coach-contract";
export interface DesktopFixtureScript {
  readonly onRequest: (request: unknown) => readonly string[] | Promise<readonly string[]>;
  readonly onStreamRequest?: (
    request: unknown,
    emitFrame: (frame: string) => void,
  ) => string | Promise<string>;
}

interface ScriptRequest {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params: unknown;
}

function parseScriptFrames(values: readonly string[]): readonly unknown[] {
  return values.map((value) => JSON.parse(value) as unknown);
}

function frameValue(value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if ("result" in record) return record.result;
  }
  return value;
}

function frameEvent(value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.params !== null && typeof record.params === "object") {
      const event = (record.params as Record<string, unknown>).event;
      if (event !== undefined) return event;
    }
    if (record.event !== undefined) return record.event;
  }
  return value;
}

async function scripted(
  script: DesktopFixtureScript,
  method: string,
  params: unknown,
): Promise<readonly unknown[]> {
  const request: ScriptRequest = { jsonrpc: "2.0", method, params };
  return parseScriptFrames(await script.onRequest(request));
}

async function scriptedStream<TEvent>(
  script: DesktopFixtureScript,
  method: string,
  params: unknown,
  onEvent: ((event: TEvent) => void) | undefined,
  eventDelayMs: number,
): Promise<unknown> {
  const request: ScriptRequest = { jsonrpc: "2.0", method, params };
  if (script.onStreamRequest !== undefined) {
    const terminalFrame = await script.onStreamRequest(request, (value) => {
      onEvent?.(frameEvent(JSON.parse(value) as unknown) as TEvent);
    });
    return frameValue(JSON.parse(terminalFrame) as unknown);
  }
  const frames = parseScriptFrames(await script.onRequest(request));
  for (const event of eventFrames(frames)) {
    onEvent?.(event as TEvent);
    if (eventDelayMs > 0) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, eventDelayMs));
    }
  }
  return finalFrame(frames);
}

function finalFrame(frames: readonly unknown[]): unknown {
  const value = frames.at(-1);
  if (value === undefined) throw new TypeError("fixture script returned no terminal frame");
  return frameValue(value);
}

function eventFrames(frames: readonly unknown[]): readonly unknown[] {
  return frames.length < 2 ? [] : frames.slice(0, -1).map(frameEvent);
}

export function createScriptedCoach(input: {
  readonly script: DesktopFixtureScript;
  readonly routeChatAttachmentComposer?: boolean;
  readonly routeChatAttachmentOperations?: boolean;
}) {
  const invoke = (method: string, params: unknown) => scripted(input.script, method, params);
  const engine: CoachEngine = {
    async chat(request, onEvent) {
      return (await scriptedStream(input.script, "chat", request, onEvent, 40)) as Awaited<
        ReturnType<CoachEngine["chat"]>
      >;
    },
    async stopChat(request) {
      return finalFrame(await invoke("stopChat", request)) as Awaited<
        ReturnType<NonNullable<CoachEngine["stopChat"]>>
      >;
    },
    async enqueueChatMessage(request) {
      return finalFrame(await invoke("enqueueChatMessage", request)) as Awaited<
        ReturnType<NonNullable<CoachEngine["enqueueChatMessage"]>>
      >;
    },
    async getChatQueue(request) {
      return finalFrame(await invoke("getChatQueue", request)) as Awaited<
        ReturnType<NonNullable<CoachEngine["getChatQueue"]>>
      >;
    },
    async removeQueuedChatMessage(request) {
      return finalFrame(await invoke("removeQueuedChatMessage", request)) as Awaited<
        ReturnType<NonNullable<CoachEngine["removeQueuedChatMessage"]>>
      >;
    },
    async resumeChatQueue(request, onEvent) {
      return (await scriptedStream(
        input.script,
        "resumeChatQueue",
        request,
        onEvent,
        40,
      )) as Awaited<ReturnType<NonNullable<CoachEngine["resumeChatQueue"]>>>;
    },
    async runQueuedCommand(request, onEvent) {
      return (await scriptedStream(
        input.script,
        "runQueuedCommand",
        request,
        onEvent,
        0,
      )) as Awaited<ReturnType<NonNullable<CoachEngine["runQueuedCommand"]>>>;
    },
    async retryQueuedTurn(request, onEvent) {
      return (await scriptedStream(
        input.script,
        "retryQueuedTurn",
        request,
        onEvent,
        0,
      )) as Awaited<ReturnType<NonNullable<CoachEngine["retryQueuedTurn"]>>>;
    },
    async getCoachDecision(request) {
      return finalFrame(await invoke("getCoachDecision", request)) as Awaited<
        ReturnType<CoachEngine["getCoachDecision"]>
      >;
    },
    async answerCoachDecision(request, onEvent) {
      return (await scriptedStream(
        input.script,
        "answerCoachDecision",
        request,
        onEvent,
        0,
      )) as Awaited<ReturnType<CoachEngine["answerCoachDecision"]>>;
    },
    async skipCoachDecision(request) {
      return finalFrame(await invoke("skipCoachDecision", request)) as Awaited<
        ReturnType<CoachEngine["skipCoachDecision"]>
      >;
    },
    async resumeCoachDecision(request, onEvent) {
      return (await scriptedStream(
        input.script,
        "resumeCoachDecision",
        request,
        onEvent,
        0,
      )) as Awaited<ReturnType<CoachEngine["resumeCoachDecision"]>>;
    },
    async resetSession(request) {
      return finalFrame(await invoke("resetSession", request)) as Awaited<
        ReturnType<CoachEngine["resetSession"]>
      >;
    },
    async hasSession(request) {
      return finalFrame(await invoke("hasSession", request)) as Awaited<
        ReturnType<CoachEngine["hasSession"]>
      >;
    },
    async getAthleteState() {
      return finalFrame(await invoke("getAthleteState", {})) as Awaited<
        ReturnType<CoachEngine["getAthleteState"]>
      >;
    },
  };
  const operations: CoachOperations & PlanningOperations & PlanningRequestOperations = {
    async importFiles(request, onEvent) {
      const frames = await invoke("importFiles", request);
      for (const event of eventFrames(frames)) onEvent?.(event as OperationProgressEvent);
      return finalFrame(frames) as Awaited<ReturnType<CoachOperations["importFiles"]>>;
    },
    async sync(request, onEvent) {
      const frames = await invoke("sync", request);
      for (const event of eventFrames(frames)) onEvent?.(event as OperationProgressEvent);
      return finalFrame(frames) as Awaited<ReturnType<CoachOperations["sync"]>>;
    },
    async saveIntake(request) {
      return finalFrame(await invoke("saveIntake", request)) as Awaited<
        ReturnType<CoachOperations["saveIntake"]>
      >;
    },
    async getSetupStatus(request) {
      return finalFrame(await invoke("getSetupStatus", request)) as Awaited<
        ReturnType<NonNullable<CoachOperations["getSetupStatus"]>>
      >;
    },
    async getTranscriptPage(request) {
      return finalFrame(await invoke("getTranscriptPage", request)) as Awaited<
        ReturnType<CoachOperations["getTranscriptPage"]>
      >;
    },
    async listArchivedConversations(request) {
      return finalFrame(await invoke("listArchivedConversations", request)) as Awaited<
        ReturnType<CoachOperations["listArchivedConversations"]>
      >;
    },
    async getArchivedTranscriptPage(request) {
      return finalFrame(await invoke("getArchivedTranscriptPage", request)) as Awaited<
        ReturnType<CoachOperations["getArchivedTranscriptPage"]>
      >;
    },
    async deleteArchivedConversation(request) {
      return finalFrame(await invoke("deleteArchivedConversation", request)) as Awaited<
        ReturnType<CoachOperations["deleteArchivedConversation"]>
      >;
    },
    async getActivityAnalysis(request) {
      return finalFrame(await invoke("getActivityAnalysis", request)) as Awaited<
        ReturnType<NonNullable<CoachOperations["getActivityAnalysis"]>>
      >;
    },
    async configureRuntime(request) {
      return finalFrame(await invoke("configureRuntime", request)) as Awaited<
        ReturnType<CoachOperations["configureRuntime"]>
      >;
    },
    async getRuntimeConfig(request) {
      return finalFrame(await invoke("getRuntimeConfig", request)) as Awaited<
        ReturnType<CoachOperations["getRuntimeConfig"]>
      >;
    },
    async getUnitsPreference(request) {
      return finalFrame(await invoke("getUnitsPreference", request)) as {
        value: "metric" | "imperial";
        source: "cycling" | "athlete" | "default";
      };
    },
    ...(input.routeChatAttachmentComposer === true
      ? {
          async getChatAttachmentComposer(request) {
            return finalFrame(await invoke("getChatAttachmentComposer", request)) as Awaited<
              ReturnType<NonNullable<CoachOperations["getChatAttachmentComposer"]>>
            >;
          },
          async saveChatAttachmentDraftText(request) {
            return finalFrame(await invoke("saveChatAttachmentDraftText", request)) as Awaited<
              ReturnType<NonNullable<CoachOperations["saveChatAttachmentDraftText"]>>
            >;
          },
          async removeChatAttachment(request) {
            return finalFrame(await invoke("removeChatAttachment", request)) as Awaited<
              ReturnType<NonNullable<CoachOperations["removeChatAttachment"]>>
            >;
          },
          async retryChatAttachment(request) {
            return finalFrame(await invoke("retryChatAttachment", request)) as Awaited<
              ReturnType<NonNullable<CoachOperations["retryChatAttachment"]>>
            >;
          },
          async selectChatAttachmentWorkout(request) {
            return finalFrame(await invoke("selectChatAttachmentWorkout", request)) as Awaited<
              ReturnType<NonNullable<CoachOperations["selectChatAttachmentWorkout"]>>
            >;
          },
          async clearChatAttachmentDraft(request) {
            return finalFrame(await invoke("clearChatAttachmentDraft", request)) as Awaited<
              ReturnType<NonNullable<CoachOperations["clearChatAttachmentDraft"]>>
            >;
          },
        }
      : {}),
    ...(input.routeChatAttachmentOperations === true
      ? {
          async admitChatAttachment(request) {
            return finalFrame(await invoke("admitChatAttachment", request)) as Awaited<
              ReturnType<NonNullable<CoachOperations["admitChatAttachment"]>>
            >;
          },
          async admitPastedChatAttachment(request) {
            return finalFrame(await invoke("admitPastedChatAttachment", request)) as Awaited<
              ReturnType<NonNullable<CoachOperations["admitPastedChatAttachment"]>>
            >;
          },
          async saveChatAttachmentDraftText(request) {
            return finalFrame(await invoke("saveChatAttachmentDraftText", request)) as Awaited<
              ReturnType<NonNullable<CoachOperations["saveChatAttachmentDraftText"]>>
            >;
          },
          async removeChatAttachment(request) {
            return finalFrame(await invoke("removeChatAttachment", request)) as Awaited<
              ReturnType<NonNullable<CoachOperations["removeChatAttachment"]>>
            >;
          },
          async retryChatAttachment(request) {
            return finalFrame(await invoke("retryChatAttachment", request)) as Awaited<
              ReturnType<NonNullable<CoachOperations["retryChatAttachment"]>>
            >;
          },
          async selectChatAttachmentWorkout(request) {
            return finalFrame(await invoke("selectChatAttachmentWorkout", request)) as Awaited<
              ReturnType<NonNullable<CoachOperations["selectChatAttachmentWorkout"]>>
            >;
          },
          async clearChatAttachmentDraft(request) {
            return finalFrame(await invoke("clearChatAttachmentDraft", request)) as Awaited<
              ReturnType<NonNullable<CoachOperations["clearChatAttachmentDraft"]>>
            >;
          },
        }
      : {}),
    async setUnitsPreference(request) {
      return finalFrame(await invoke("setUnitsPreference", request)) as {
        value: "metric" | "imperial";
        source: "cycling";
      };
    },
    async createPlanningRequest(request) {
      return finalFrame(await invoke("createPlanningRequest", request)) as Awaited<
        ReturnType<NonNullable<PlanningRequestOperations["createPlanningRequest"]>>
      >;
    },
    async createWorkoutPlanningRequest(request) {
      return finalFrame(await invoke("createWorkoutPlanningRequest", request)) as Awaited<
        ReturnType<NonNullable<PlanningRequestOperations["createWorkoutPlanningRequest"]>>
      >;
    },
    async getPlanningRequest(request) {
      return finalFrame(await invoke("getPlanningRequest", request)) as Awaited<
        ReturnType<NonNullable<PlanningRequestOperations["getPlanningRequest"]>>
      >;
    },
    async retryPlanningRequest(request) {
      return finalFrame(await invoke("retryPlanningRequest", request)) as Awaited<
        ReturnType<NonNullable<PlanningRequestOperations["retryPlanningRequest"]>>
      >;
    },
    async resumePlanningRequests(request) {
      return finalFrame(await invoke("resumePlanningRequests", request)) as Awaited<
        ReturnType<NonNullable<PlanningRequestOperations["resumePlanningRequests"]>>
      >;
    },
    async listPlanningRequests(request) {
      return finalFrame(await invoke("listPlanningRequests", request)) as Awaited<
        ReturnType<NonNullable<PlanningRequestOperations["listPlanningRequests"]>>
      >;
    },
    async getPlanState(request) {
      return finalFrame(await invoke("getPlanState", request)) as Awaited<
        ReturnType<NonNullable<PlanningOperations["getPlanState"]>>
      >;
    },
    async executePlanTransition(request, onEvent) {
      const frames = await invoke("executePlanTransition", request);
      for (const event of eventFrames(frames)) onEvent?.(event as PlanProgressEvent);
      return finalFrame(frames) as Awaited<
        ReturnType<NonNullable<PlanningOperations["executePlanTransition"]>>
      >;
    },
  };
  const spend: SpendOperations = {
    async getSpendSummary(request) {
      return finalFrame(await invoke("getSpendSummary", request)) as Awaited<
        ReturnType<SpendOperations["getSpendSummary"]>
      >;
    },
    async setDailySpendCap(request) {
      return finalFrame(await invoke("setDailySpendCap", request)) as Awaited<
        ReturnType<SpendOperations["setDailySpendCap"]>
      >;
    },
  };
  return { engine, operations, spend };
}
