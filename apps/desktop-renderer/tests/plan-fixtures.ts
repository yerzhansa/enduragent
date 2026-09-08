import type {
  ChatQueueSnapshot,
  ListPlansResult,
  CoachDecisionReadModel,
  PlanAttention,
  PlanDraftProjection,
  PlanDraftPlanProjection,
  PlanError,
  PlanFtpProjection,
  PlanDraftRequirement,
  PlanIntakeProjection,
  PlanProjectionKind,
  PlanRaceCourseProjection,
  PlanStartDateProjection,
  PlanReadModel,
} from "@enduragent/coach-contract";

export function emptyPlanLibrary(): ListPlansResult {
  return {
    calendarConnected: false,
    legacy: null,
    active: null,
    creation: null,
    closed: [],
    changesPaused: null,
    changes: [],
  };
}

export const PLAN_ERROR: PlanError = Object.freeze({
  code: "unavailable",
  message: "Plan is temporarily unavailable.",
  retryable: true,
});

export function planAttention(count = 0): PlanAttention {
  const items = Array.from({ length: count }, (_, index) => ({
    id: `attention-${index + 1}`,
    title: `Decision ${index + 1}`,
    scenarioId: "PL-S021" as const,
    priority: index === 0 ? ("blocker" as const) : ("recent" as const),
    affectedDate: null,
    createdAtMs: index + 1,
  }));
  return {
    count,
    destination: count === 0 ? "none" : count === 1 ? "direct" : "list",
    items,
  };
}

export function planReadModel(
  input: {
    readonly attentionCount?: number;
    readonly projection?: PlanProjectionKind;
    readonly lifecycle?: PlanReadModel["lifecycle"];
    readonly scenarioId?: PlanReadModel["scenarioId"];
    readonly planId?: string | null;
    readonly title?: string;
    readonly summary?: string;
    readonly revision?: number;
    readonly reconciliation?: PlanReadModel["reconciliation"];
    readonly data?: PlanReadModel["data"];
  } = {},
): PlanReadModel {
  return {
    schemaVersion: 1,
    scenarioId: input.scenarioId ?? "PL-S001",
    lifecycle: input.lifecycle ?? "none",
    planId: input.planId === undefined ? null : input.planId,
    revision: input.revision ?? 0,
    title: input.title ?? "",
    summary: input.summary ?? "",
    projection: input.projection ?? "no-plan",
    transitions: [{ transitionId: "PL-T01", status: "available", reason: null }],
    reconciliation: input.reconciliation ?? {
      status: "not-applicable",
      created: 0,
      pending: 0,
      failed: 0,
      total: 0,
      currentThrough: null,
      error: null,
    },
    attention: planAttention(input.attentionCount),
    activeOperation: null,
    data: input.data ?? {},
  };
}

export function planCoachData(
  input: {
    readonly ready?: boolean;
    readonly draft?: PlanDraftProjection | null;
    readonly decision?: CoachDecisionReadModel | null;
    readonly queue?: ChatQueueSnapshot;
    readonly messages?: readonly {
      readonly id: string;
      readonly turnId: string | null;
      readonly role: "athlete" | "coach";
      readonly text: string;
    }[];
    readonly ftp?: PlanFtpProjection | null;
    readonly course?: PlanRaceCourseProjection;
    readonly plan?: PlanDraftPlanProjection | null;
    readonly startDate?: PlanStartDateProjection;
    readonly replacement?: boolean;
    readonly replacesPlanId?: string | null;
    readonly intake?: PlanIntakeProjection;
    readonly missingDraftRequirements?: readonly PlanDraftRequirement[];
  } = {},
): PlanReadModel["data"] {
  return {
    conversationId: "00000000000000000000000001",
    chatId: "plan:00000000000000000000000001",
    sourceConversationId: null,
    replacement: input.replacement ?? false,
    replacesPlanId: input.replacesPlanId ?? null,
    readyToCreateDraft: input.ready ?? false,
    ...(input.intake === undefined ? {} : { intake: input.intake }),
    ...(input.missingDraftRequirements === undefined
      ? {}
      : { missingDraftRequirements: [...input.missingDraftRequirements] }),
    messages: input.messages?.map((message) => ({ ...message })) ?? [
      {
        id: "plan-intro",
        turnId: null,
        role: "coach",
        text: "Let’s build this here in Plan. What event are you training toward?",
      },
    ],
    queue: input.queue ?? { schemaVersion: 1, revision: 0, items: [] },
    decision: input.decision ?? null,
    draft: input.draft ?? null,
    ...(input.plan === undefined ? {} : { plan: input.plan }),
    ...(input.startDate === undefined ? {} : { startDate: input.startDate }),
    ...(input.ftp === undefined ? {} : { ftp: input.ftp }),
    ...(input.course === undefined ? {} : { course: input.course }),
  };
}
