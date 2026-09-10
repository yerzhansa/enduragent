import type {
  ExecutePlanTransitionRpcResult,
  GetPlanStateRpcResult,
  PlanHydrationState,
  PlanProgressEvent,
} from "@enduragent/coach-contract";
import type { CoachClient } from "@enduragent/coach-client";
import type { DesktopCoachClientProvider } from "../src/coach-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closePlan,
  createPlanViewAdapter,
  readPlanHistory,
  previewPlanChange,
  applyPlanChange,
  type PlanBridge,
} from "../src/state/adapters/plan";
import {
  EMPTY_PLAN_SURFACE,
  type PlanSurfaceState,
  type PlanTransitionState,
} from "../src/state/plan-slice";
import { PLAN_ERROR, planCoachData, planReadModel } from "./plan-fixtures";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function harness(
  input: {
    readonly getPlanState?: () => Promise<GetPlanStateRpcResult>;
    readonly executePlanTransition?: PlanBridge["executePlanTransition"];
    readonly choosePlanRaceCourseFile?: PlanBridge["choosePlanRaceCourseFile"];
    readonly ids?: readonly string[];
    readonly clients?: DesktopCoachClientProvider;
    readonly messageIds?: readonly string[];
  } = {},
) {
  let surface: PlanSurfaceState = EMPTY_PLAN_SURFACE;
  let progressListener: ((progress: PlanProgressEvent) => void) | null = null;
  const disposeProgress = vi.fn();
  const defaultGetPlanState: PlanBridge["getPlanState"] = async () => ({
    status: "ready",
    state: planReadModel(),
  });
  const defaultExecute: PlanBridge["executePlanTransition"] = async () => ({
    status: "completed",
    state: planReadModel(),
  });
  const getPlanState = vi.fn<PlanBridge["getPlanState"]>(input.getPlanState ?? defaultGetPlanState);
  const executePlanTransition = vi.fn<PlanBridge["executePlanTransition"]>(
    input.executePlanTransition ?? defaultExecute,
  );
  const choosePlanRaceCourseFile = vi.fn<PlanBridge["choosePlanRaceCourseFile"]>(
    input.choosePlanRaceCourseFile ?? (async () => null),
  );
  const ids = [...(input.ids ?? ["command-1", "command-2", "command-3"])];
  const messageIds = [...(input.messageIds ?? ["message-1", "message-2", "message-3"])];
  const adapter = createPlanViewAdapter({
    bridge: {
      getPlanState,
      choosePlanRaceCourseFile,
      executePlanTransition,
      onPlanProgress(listener) {
        progressListener = listener;
        return disposeProgress;
      },
    },
    clients: input.clients,
    read: () => surface,
    publishHydration(next: PlanHydrationState) {
      const lastReady =
        next.status === "ready" || next.status === "stale" ? next.state : surface.lastReady;
      surface = { ...surface, hydration: next, lastReady };
    },
    publishTransition(next: PlanTransitionState) {
      surface = { ...surface, transition: next };
    },
    publishCoach(next) {
      surface = { ...surface, coach: next };
    },
    publishDiscardConfirmation(open) {
      surface = { ...surface, discardConfirmation: open };
    },
    publishRevisionComposer(open) {
      surface = { ...surface, revisionComposer: open };
    },
    publishCoursePicker(open) {
      surface = { ...surface, coursePicker: open };
    },
    publishDatePicker(open) {
      surface = { ...surface, datePicker: open };
    },
    publishSettingPending(next) {
      surface = { ...surface, settingPending: next };
    },
    createCommandId: () => ids.shift() ?? "unexpected-command",
    createMessageId: () => messageIds.shift() ?? "unexpected-message",
  });
  return {
    adapter,
    get surface() {
      return surface;
    },
    getPlanState,
    executePlanTransition,
    choosePlanRaceCourseFile,
    disposeProgress,
    progress(value: PlanProgressEvent) {
      progressListener?.(value);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Plan view adapter", () => {
  it("subscribes and hydrates once", async () => {
    const subject = harness();

    subject.adapter.start();
    subject.adapter.start();
    await settle();

    expect(subject.getPlanState).toHaveBeenCalledOnce();
    expect(subject.surface.hydration).toEqual({ status: "ready", state: planReadModel() });
  });

  it("keeps hydration failure retryable", async () => {
    const first = deferred<GetPlanStateRpcResult>();
    const getPlanState = vi
      .fn<() => Promise<GetPlanStateRpcResult>>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ status: "ready", state: planReadModel() });
    const subject = harness({ getPlanState });

    subject.adapter.start();
    first.reject(new TypeError());
    await settle();
    expect(subject.surface.hydration).toEqual({ status: "failed", error: expect.any(Object) });

    subject.adapter.retry();
    await settle();
    expect(subject.surface.hydration.status).toBe("ready");
    expect(getPlanState).toHaveBeenCalledTimes(2);
  });

  it("dispatches PL-T36 with one stable command identifier", async () => {
    const execute = deferred<ExecutePlanTransitionRpcResult>();
    const subject = harness({
      ids: ["create-draft-command"],
      executePlanTransition: () => execute.promise,
    });

    subject.adapter.openChatRequest("chat-1", "request-1");
    expect(subject.executePlanTransition).toHaveBeenCalledWith({
      transitionId: "PL-T36",
      commandId: "create-draft-command",
      sourceConversationId: "chat-1",
      requestId: "request-1",
    });
    expect(subject.surface.transition).toEqual({
      status: "submitting",
      transitionId: "PL-T36",
      commandId: "create-draft-command",
    });

    execute.resolve({
      status: "completed",
      state: planReadModel({ lifecycle: "intake", projection: "coach" }),
    });
    await settle();
    expect(subject.surface.transition).toEqual({ status: "idle" });
    expect(subject.surface.hydration.status).toBe("ready");
  });

  it("opens the exact Chat-originated request through PL-T36", async () => {
    const subject = harness({ ids: ["open-request-command"] });

    subject.adapter.openChatRequest("desktop", "request-plan-1");
    await settle();

    expect(subject.executePlanTransition).toHaveBeenCalledWith({
      transitionId: "PL-T36",
      commandId: "open-request-command",
      sourceConversationId: "desktop",
      requestId: "request-plan-1",
    });
  });

  it("saves manual FTP and automatically returns to the Plan coach", async () => {
    const required = planReadModel({
      lifecycle: "intake",
      scenarioId: "PL-S003",
      projection: "coach",
      data: planCoachData({
        ftp: {
          status: "required",
          manual: null,
          intervalsFtp: null,
          intervalsEftp: null,
          usedSource: null,
          usedWatts: null,
          conflict: false,
          error: null,
        },
      }),
    });
    const accepted = planReadModel({
      lifecycle: "intake",
      scenarioId: "PL-S062",
      projection: "coach",
      data: planCoachData({
        ftp: {
          status: "accepted",
          manual: { watts: 282, refreshedAtMs: 1 },
          intervalsFtp: null,
          intervalsEftp: null,
          usedSource: "manual",
          usedWatts: 282,
          conflict: false,
          error: null,
        },
      }),
    });
    const resumed = planReadModel({
      lifecycle: "intake",
      scenarioId: "PL-S016",
      projection: "coach",
      data: planCoachData({ ready: true }),
    });
    const getPlanState = vi
      .fn<() => Promise<GetPlanStateRpcResult>>()
      .mockResolvedValueOnce({ status: "ready", state: required })
      .mockResolvedValueOnce({ status: "ready", state: resumed });
    const subject = harness({
      ids: ["ftp-command"],
      getPlanState,
      executePlanTransition: async () => ({ status: "completed", state: accepted }),
    });
    subject.adapter.start();
    await settle();

    subject.adapter.saveFtp(282);
    await settle();
    expect(subject.executePlanTransition).toHaveBeenCalledWith({
      transitionId: "PL-T04",
      commandId: "ftp-command",
      conversationId: "00000000000000000000000001",
      source: "manual",
      watts: 282,
    });
    expect(getPlanState).toHaveBeenCalledTimes(2);
    expect(subject.surface.hydration).toEqual({ status: "ready", state: resumed });
  });

  it("refreshes all Intervals FTP sources through the generic PL-T04 command", async () => {
    const initial = planReadModel({
      lifecycle: "intake",
      scenarioId: "PL-S003",
      projection: "coach",
      data: planCoachData({
        ftp: {
          status: "required",
          manual: null,
          intervalsFtp: null,
          intervalsEftp: null,
          usedSource: null,
          usedWatts: null,
          conflict: false,
          error: null,
        },
      }),
    });
    const subject = harness({
      ids: ["refresh-command"],
      getPlanState: async () => ({ status: "ready", state: initial }),
    });
    subject.adapter.start();
    await settle();

    subject.adapter.refreshFtp();
    await settle();
    expect(subject.executePlanTransition).toHaveBeenCalledWith({
      transitionId: "PL-T04",
      commandId: "refresh-command",
      conversationId: "00000000000000000000000001",
      source: "intervals",
      watts: null,
    });
  });

  it("returns from the ready summary to the Coach interview through PL-T39", async () => {
    const ready = planReadModel({
      lifecycle: "intake",
      scenarioId: "PL-S016",
      projection: "coach",
      data: planCoachData({ ready: true }),
    });
    const subject = harness({
      ids: ["back-command"],
      getPlanState: async () => ({ status: "ready", state: ready }),
    });
    subject.adapter.start();
    await settle();

    subject.adapter.backToCoachInterview();

    expect(subject.executePlanTransition).toHaveBeenCalledWith({
      transitionId: "PL-T39",
      commandId: "back-command",
      action: "back",
      sourceScenarioId: "PL-S016",
      destinationScenarioId: "PL-S017",
      returnFocusId: "plan-coach-composer",
    });
  });

  it("closes the Coach interview and returns focus to the destination action", async () => {
    const interview = planReadModel({
      lifecycle: "intake",
      scenarioId: "PL-S017",
      projection: "coach",
      data: planCoachData(),
    });
    const subject = harness({
      ids: ["close-command"],
      getPlanState: async () => ({ status: "ready", state: interview }),
    });
    subject.adapter.start();
    await settle();

    subject.adapter.closeCoach();

    expect(subject.executePlanTransition).toHaveBeenCalledWith({
      transitionId: "PL-T39",
      commandId: "close-command",
      action: "close",
      sourceScenarioId: "PL-S017",
      destinationScenarioId: "PL-S001",
      returnFocusId: "start-plan",
    });
  });

  it("uses the native picker and resumes a route-only Course choice", async () => {
    const summary = {
      fileName: "route-only.gpx",
      format: "gpx" as const,
      pointCount: 42,
      distanceM: 120_000,
      elevationGainM: null,
      elevationStatus: "unavailable" as const,
    };
    const initial = planReadModel({
      lifecycle: "intake",
      scenarioId: "PL-S017",
      projection: "coach",
      data: planCoachData({
        course: {
          status: "undecided",
          accepted: null,
          candidate: null,
          fileName: null,
          detail: null,
        },
      }),
    });
    const missingElevation = planReadModel({
      lifecycle: "intake",
      scenarioId: "PL-S067",
      projection: "coach",
      data: planCoachData({
        course: {
          status: "missing-elevation",
          accepted: null,
          candidate: summary,
          fileName: null,
          detail: null,
        },
      }),
    });
    const ready = planReadModel({
      lifecycle: "intake",
      scenarioId: "PL-S016",
      projection: "coach",
      data: planCoachData({
        ready: true,
        course: {
          status: "ready",
          accepted: summary,
          candidate: null,
          fileName: null,
          detail: null,
        },
      }),
    });
    const executePlanTransition = vi
      .fn<PlanBridge["executePlanTransition"]>()
      .mockResolvedValueOnce({ status: "completed", state: missingElevation })
      .mockResolvedValueOnce({ status: "completed", state: ready });
    const subject = harness({
      ids: ["course-command", "route-only-command"],
      getPlanState: async () => ({ status: "ready", state: initial }),
      choosePlanRaceCourseFile: async () => "/tmp/route-only.gpx",
      executePlanTransition,
    });
    subject.adapter.start();
    await settle();

    subject.adapter.openCoursePicker();
    expect(subject.surface.coursePicker).toBe(true);
    subject.adapter.chooseCourseFile();
    await settle();
    expect(subject.choosePlanRaceCourseFile).toHaveBeenCalledOnce();
    expect(subject.surface.coursePicker).toBe(false);
    expect(executePlanTransition).toHaveBeenNthCalledWith(1, {
      transitionId: "PL-T02",
      commandId: "course-command",
      conversationId: "00000000000000000000000001",
      filePath: "/tmp/route-only.gpx",
      elevation: "require",
    });

    subject.adapter.useCourseWithoutElevation();
    await settle();
    expect(executePlanTransition).toHaveBeenNthCalledWith(2, {
      transitionId: "PL-T02",
      commandId: "route-only-command",
      conversationId: "00000000000000000000000001",
      filePath: "/tmp/route-only.gpx",
      elevation: "allow-missing",
    });
  });

  it("persists Course omission in intake and removes a Course through Draft recalculation", async () => {
    const intake = planReadModel({
      lifecycle: "intake",
      scenarioId: "PL-S017",
      projection: "coach",
      data: planCoachData({
        course: {
          status: "undecided",
          accepted: null,
          candidate: null,
          fileName: null,
          detail: null,
        },
      }),
    });
    const subject = harness({
      ids: ["omit-command"],
      getPlanState: async () => ({ status: "ready", state: intake }),
    });
    subject.adapter.start();
    await settle();
    subject.adapter.continueWithoutCourse();
    await settle();
    expect(subject.executePlanTransition).toHaveBeenCalledWith({
      transitionId: "PL-T03",
      commandId: "omit-command",
      conversationId: "00000000000000000000000001",
    });

    const draft = {
      id: "00000000000000000000000002",
      planId: "00000000000000000000000003",
      revision: 1,
      status: "ready" as const,
      snapshot: {},
    };
    const draftState = planReadModel({
      lifecycle: "draft",
      scenarioId: "PL-S002",
      projection: "draft",
      data: planCoachData({ draft }),
    });
    const draftSubject = harness({
      ids: ["remove-command"],
      getPlanState: async () => ({ status: "ready", state: draftState }),
    });
    draftSubject.adapter.start();
    await settle();
    draftSubject.adapter.removeCourse();
    await settle();
    expect(draftSubject.executePlanTransition).toHaveBeenCalledWith({
      transitionId: "PL-T09",
      commandId: "remove-command",
      draftId: draft.id,
      course: { action: "remove" },
    });
  });

  it("keeps a rejected transition inside Plan and retries it with a new command", async () => {
    const subject = harness({
      ids: ["rejected-command", "retry-command"],
      executePlanTransition: async () => ({
        status: "rejected",
        error: PLAN_ERROR,
        state: planReadModel(),
      }),
    });

    subject.adapter.openChatRequest("chat-1", "request-1");
    await settle();
    expect(subject.surface.transition).toEqual({
      status: "failed",
      commandId: "rejected-command",
      transitionId: "PL-T36",
      error: PLAN_ERROR,
    });

    subject.adapter.retry();
    await settle();
    expect(subject.executePlanTransition).toHaveBeenLastCalledWith({
      transitionId: "PL-T36",
      commandId: "retry-command",
      sourceConversationId: "chat-1",
      requestId: "request-1",
    });
  });

  it("streams PL-T05 inside the dedicated Plan conversation before the RPC completes", async () => {
    const initial = planReadModel({
      lifecycle: "intake",
      scenarioId: "PL-S017",
      projection: "coach",
      data: planCoachData(),
    });
    const completed = planReadModel({
      lifecycle: "intake",
      scenarioId: "PL-S016",
      projection: "coach",
      data: planCoachData({
        ready: true,
        messages: [
          { id: "intro", turnId: null, role: "coach", text: "What is your event?" },
          { id: "athlete", turnId: "turn-1", role: "athlete", text: "Gran Fondo Almaty." },
          { id: "coach", turnId: "turn-1", role: "coach", text: "I found your training." },
        ],
      }),
    });
    const transition = deferred<ExecutePlanTransitionRpcResult>();
    const subject = harness({
      ids: ["coach-command"],
      getPlanState: async () => ({ status: "ready", state: initial }),
      executePlanTransition: () => transition.promise,
    });
    subject.adapter.start();
    await settle();

    await expect(subject.adapter.submitCoach("Gran Fondo Almaty.")).resolves.toBe(true);
    expect(subject.executePlanTransition).toHaveBeenCalledWith({
      transitionId: "PL-T05",
      commandId: "coach-command",
      conversationId: "00000000000000000000000001",
      text: "Gran Fondo Almaty.",
    });
    subject.progress({
      commandId: "coach-command",
      transitionId: "PL-T05",
      operationId: "operation-1",
      phase: "running",
      completed: 0,
      total: 1,
      turnEvent: {
        type: "turn-start",
        turnId: "turn-1",
        chatId: "plan:00000000000000000000000001",
      },
    });
    subject.progress({
      commandId: "coach-command",
      transitionId: "PL-T05",
      operationId: "operation-1",
      phase: "running",
      completed: 0,
      total: 1,
      turnEvent: { type: "final-text", turnId: "turn-1", text: "I found your training." },
    });
    expect(subject.surface.coach.messages.at(-1)).toMatchObject({
      role: "coach",
      text: "I found your training.",
      delivery: "streaming",
    });
    transition.resolve({ status: "completed", state: completed });
    await settle();
    expect(subject.surface.coach.status).toBe("idle");
    expect(subject.surface.coach.messages.at(-1)).toMatchObject({
      role: "coach",
      text: "I found your training.",
      delivery: "complete",
    });
  });

  it("queues a second Plan coach message and stops only its active Plan turn", async () => {
    const initial = planReadModel({
      lifecycle: "intake",
      scenarioId: "PL-S017",
      projection: "coach",
      data: planCoachData(),
    });
    const transition = deferred<ExecutePlanTransitionRpcResult>();
    const queue = {
      schemaVersion: 1 as const,
      revision: 1,
      items: [
        {
          queuedMessageId: "queued-1",
          submissionId: "message-3",
          text: "Sunday must stay free.",
          kind: "ordinary" as const,
          position: 0,
          restored: false,
        },
      ],
    };
    const call = vi.fn(async (method: string) => {
      if (method === "enqueueChatMessage") return queue;
      return { stopped: true };
    });
    const clients = {
      getClient: async () => ({ call }),
      reconnect: async () => ({ call }),
      close: async () => undefined,
    } as unknown as DesktopCoachClientProvider;
    const subject = harness({
      clients,
      ids: ["coach-command"],
      messageIds: ["message-1", "message-2", "message-3"],
      getPlanState: async () => ({ status: "ready", state: initial }),
      executePlanTransition: () => transition.promise,
    });
    subject.adapter.start();
    await settle();
    await subject.adapter.submitCoach("Gran Fondo Almaty.");
    subject.progress({
      commandId: "coach-command",
      transitionId: "PL-T05",
      operationId: "operation-1",
      phase: "running",
      completed: 0,
      total: 1,
      turnEvent: {
        type: "turn-start",
        turnId: "turn-1",
        chatId: "plan:00000000000000000000000001",
      },
    });

    await expect(subject.adapter.submitCoach("Sunday must stay free.")).resolves.toBe(true);
    expect(call).toHaveBeenCalledWith("enqueueChatMessage", {
      chatId: "plan:00000000000000000000000001",
      submissionId: "message-3",
      text: "Sunday must stay free.",
    });
    expect(subject.surface.coach.queued).toMatchObject([
      { id: "queued-1", text: "Sunday must stay free." },
    ]);

    subject.adapter.stopCoach();
    await settle();
    expect(call).toHaveBeenCalledWith("stopChat", {
      chatId: "plan:00000000000000000000000001",
      turnId: "turn-1",
    });
  });

  it("answers a host-owned Coach decision through the persisted Plan transition", async () => {
    const decision = {
      decisionId: "decision-1",
      chatId: "plan:00000000000000000000000001",
      messageId: "message-1",
      question: "Which day must stay free?",
      options: [
        {
          id: "option-1",
          label: "Sunday",
          description: "Keep Sunday free.",
          recommended: true,
          consequence: "Training moves earlier in the week.",
        },
        {
          id: "option-2",
          label: "Monday",
          description: "Keep Monday free.",
          recommended: false,
          consequence: "Recovery moves to Monday.",
        },
      ],
      status: "unanswered" as const,
    };
    const initial = planReadModel({
      lifecycle: "intake",
      scenarioId: "PL-S017",
      projection: "coach",
      data: planCoachData({ decision }),
    });
    const subject = harness({
      ids: ["decision-command"],
      getPlanState: async () => ({ status: "ready", state: initial }),
    });
    subject.adapter.start();
    await settle();

    subject.adapter.answerCoachDecision("decision-1", { kind: "option", optionId: "option-1" });
    await settle();
    expect(subject.executePlanTransition).toHaveBeenCalledWith({
      transitionId: "PL-T05",
      commandId: "decision-command",
      conversationId: "00000000000000000000000001",
      text: "Sunday",
      decision: {
        action: "answer",
        decisionId: "decision-1",
        answer: { kind: "option", optionId: "option-1" },
      },
    });
  });

  it("resumes a saved Coach choice whose continuation was pending at relaunch", async () => {
    const decision = {
      decisionId: "decision-1",
      chatId: "plan:00000000000000000000000001",
      messageId: "message-1",
      question: "Which day must stay free?",
      options: [
        {
          id: "option-1",
          label: "Sunday",
          description: "Keep Sunday free.",
          recommended: true,
          consequence: "Training moves earlier in the week.",
        },
        {
          id: "option-2",
          label: "Monday",
          description: "Keep Monday free.",
          recommended: false,
          consequence: "Recovery moves to Monday.",
        },
      ],
      status: "answered" as const,
      answer: { kind: "option" as const, optionId: "option-1" },
      consequence: "Training moves earlier in the week.",
      continuation: { continuationId: "continuation-1", status: "pending" as const },
    };
    const initial = planReadModel({
      lifecycle: "intake",
      scenarioId: "PL-S017",
      projection: "coach",
      data: planCoachData({ decision }),
    });
    const subject = harness({
      ids: ["resume-command"],
      getPlanState: async () => ({ status: "ready", state: initial }),
    });

    subject.adapter.start();
    await settle();
    expect(subject.executePlanTransition).toHaveBeenCalledWith({
      transitionId: "PL-T05",
      commandId: "resume-command",
      conversationId: "00000000000000000000000001",
      text: "Sunday",
      decision: { action: "resume", decisionId: "decision-1" },
    });
    expect(subject.surface.coach.decisionPhase).toBe("recovering");
    expect(subject.surface.coach.decisionAnswerLabel).toBe("Sunday");
  });

  it("retries an interrupted queued Plan message through PL-T05", async () => {
    const queue = {
      schemaVersion: 1 as const,
      revision: 2,
      items: [
        {
          queuedMessageId: "queued-1",
          messageId: "message-1",
          submissionId: "submission-1",
          text: "Keep Sunday free.",
          kind: "ordinary" as const,
          attachmentIds: [],
          position: 0,
          restored: true,
        },
      ],
      retryRequired: {
        claimId: "claim-1",
        queuedMessageIds: ["queued-1"],
        turnId: "turn-1",
        status: "retry-required" as const,
      },
    };
    const initial = planReadModel({
      lifecycle: "intake",
      scenarioId: "PL-S017",
      projection: "coach",
      data: planCoachData({ queue }),
    });
    const subject = harness({
      ids: ["retry-command"],
      getPlanState: async () => ({ status: "ready", state: initial }),
    });
    subject.adapter.start();
    await settle();

    subject.adapter.retryQueuedCoachTurn("claim-1");
    await settle();
    expect(subject.executePlanTransition).toHaveBeenCalledWith({
      transitionId: "PL-T05",
      commandId: "retry-command",
      conversationId: "00000000000000000000000001",
      text: "Keep Sunday free.",
    });
  });

  it.each([
    { count: 1, projection: "workout" as const },
    { count: 2, projection: "attention" as const },
  ])("routes $count unresolved item(s) through PL-T33", async ({ count, projection }) => {
    const model = planReadModel({ attentionCount: count, planId: "plan-1" });
    const subject = harness({
      ids: ["attention-command"],
      getPlanState: async () => ({ status: "ready", state: model }),
      executePlanTransition: async () => ({
        status: "completed",
        state: planReadModel({
          attentionCount: count,
          lifecycle: "active",
          planId: "plan-1",
          projection,
        }),
      }),
    });
    subject.adapter.start();
    await settle();

    subject.adapter.open();
    await settle();

    expect(subject.executePlanTransition).toHaveBeenCalledWith({
      transitionId: "PL-T33",
      commandId: "attention-command",
      planId: "plan-1",
    });
    expect(subject.surface.hydration.status).toBe("ready");
    if (subject.surface.hydration.status === "ready") {
      expect(subject.surface.hydration.state.projection).toBe(projection);
    }
  });

  it("opens ordinary Plan without dispatching when attention is empty", async () => {
    const subject = harness();
    subject.adapter.start();
    await settle();

    subject.adapter.open();
    await settle();

    expect(subject.executePlanTransition).not.toHaveBeenCalled();
    expect(subject.getPlanState).toHaveBeenCalledTimes(2);
  });

  it("keeps date selection local and dispatches recalculation and approval with Draft identity", async () => {
    const draft = {
      id: "00000000000000000000000002",
      planId: "00000000000000000000000003",
      revision: 4,
      status: "ready" as const,
      snapshot: {},
    };
    const state = planReadModel({
      lifecycle: "draft",
      scenarioId: "PL-S002",
      projection: "draft",
      planId: draft.planId,
      revision: draft.revision,
      data: planCoachData({ draft }),
    });
    const subject = harness({
      ids: ["date-command", "approve-command"],
      getPlanState: async () => ({ status: "ready", state }),
      executePlanTransition: async () => ({ status: "completed", state }),
    });
    subject.adapter.start();
    await settle();

    subject.adapter.openDatePicker();
    expect(subject.surface.datePicker).toBe(true);
    subject.adapter.closeDatePicker();
    expect(subject.surface.datePicker).toBe(false);
    subject.adapter.recalculateStartDate("2026-07-20");
    await settle();
    expect(subject.executePlanTransition).toHaveBeenNthCalledWith(1, {
      transitionId: "PL-T08",
      commandId: "date-command",
      draftId: draft.id,
      startDate: "2026-07-20",
    });

    subject.adapter.approveDraft();
    await settle();
    expect(subject.executePlanTransition).toHaveBeenNthCalledWith(2, {
      transitionId: "PL-T11",
      commandId: "approve-command",
      draftId: draft.id,
      expectedRevision: 4,
    });
  });

  it("dispatches replacement intake, confirmation, cleanup recovery, and gated mirror actions", async () => {
    const previousPlanId = "00000000000000000000000003";
    const replacementPlanId = "00000000000000000000000004";
    const draft = {
      id: "00000000000000000000000005",
      planId: replacementPlanId,
      revision: 2,
      status: "ready" as const,
      snapshot: {},
    };
    const replacementDraft = planReadModel({
      lifecycle: "replacement-draft",
      scenarioId: "PL-S080",
      projection: "draft",
      planId: replacementPlanId,
      revision: 2,
      data: planCoachData({ replacement: true, replacesPlanId: previousPlanId, draft }),
    });
    const activeData = {
      plan: {
        id: replacementPlanId,
        name: "Replacement Plan",
        primaryGoal: "Finish",
        startDate: "2026-08-27",
        targetDate: "2026-11-18",
        kind: "full-plan" as const,
        totalWeeks: 12,
        weekStartDay: 4,
        workoutCount: 1,
        plannedDurationS: 3_600,
      },
      today: "2026-08-26",
      weekIndex: 1,
      todayWorkout: null,
      workouts: [],
      replacement: {
        id: "00000000000000000000000006",
        previousPlan: {
          id: previousPlanId,
          name: "Previous Plan",
          primaryGoal: "Finish",
          startDate: "2026-07-09",
          targetDate: "2026-09-30",
          kind: "full-plan" as const,
          totalWeeks: 12,
          weekStartDay: 4,
          workoutCount: 0,
          plannedDurationS: 0,
        },
        activatedAtMs: 100,
        cleanupItems: [],
      },
    };
    const failedCleanup = planReadModel({
      lifecycle: "active",
      scenarioId: "PL-S083",
      projection: "active",
      planId: replacementPlanId,
      data: activeData,
    });
    const currentActive = planReadModel({
      lifecycle: "active",
      scenarioId: "PL-S004",
      projection: "active",
      planId: previousPlanId,
    });
    const intake = harness({
      ids: ["start-replacement"],
      getPlanState: async () => ({ status: "ready", state: currentActive }),
      executePlanTransition: async () => ({ status: "completed", state: currentActive }),
    });
    intake.adapter.start();
    await settle();
    intake.adapter.openReplacement();
    await settle();

    const draftSubject = harness({
      ids: ["open-confirmation", "close-confirmation", "confirm-replacement"],
      getPlanState: async () => ({ status: "ready", state: replacementDraft }),
      executePlanTransition: async () => ({ status: "completed", state: replacementDraft }),
    });
    draftSubject.adapter.start();
    await settle();
    draftSubject.adapter.approveDraft();
    await settle();
    draftSubject.adapter.closeReplacementConfirmation();
    await settle();
    draftSubject.adapter.confirmReplacement();
    await settle();

    const recovery = harness({
      ids: ["retry-cleanup", "verify-cleanup", "write-mirror", "open-active"],
      getPlanState: async () => ({ status: "ready", state: failedCleanup }),
      executePlanTransition: async () => ({ status: "completed", state: failedCleanup }),
    });
    recovery.adapter.start();
    await settle();
    recovery.adapter.retryReplacementCleanup();
    await settle();
    recovery.adapter.verifyReplacementCleanup();
    await settle();
    recovery.adapter.writeReplacementMirror();
    await settle();
    recovery.adapter.openReplacementActivePlan();
    await settle();

    expect(intake.executePlanTransition).toHaveBeenCalledWith({
      transitionId: "PL-T25",
      commandId: "start-replacement",
      planId: previousPlanId,
    });
    expect(draftSubject.executePlanTransition.mock.calls.map(([command]) => command)).toEqual([
      {
        transitionId: "PL-T26",
        commandId: "open-confirmation",
        activePlanId: previousPlanId,
        draftId: draft.id,
        expectedRevision: 2,
      },
      {
        transitionId: "PL-T39",
        commandId: "close-confirmation",
        action: "back",
        sourceScenarioId: "PL-S081",
        destinationScenarioId: "PL-S080",
        returnFocusId: "plan-approve-replacement",
      },
      {
        transitionId: "PL-T26",
        commandId: "confirm-replacement",
        activePlanId: previousPlanId,
        draftId: draft.id,
        expectedRevision: 2,
        confirm: true,
      },
    ]);
    expect(recovery.executePlanTransition.mock.calls.map(([command]) => command)).toEqual([
      {
        transitionId: "PL-T27",
        commandId: "retry-cleanup",
        planId: previousPlanId,
        replacementPlanId,
        mode: "cleanup",
      },
      {
        transitionId: "PL-T27",
        commandId: "verify-cleanup",
        planId: previousPlanId,
        replacementPlanId,
        mode: "verify",
      },
      { transitionId: "PL-T28", commandId: "write-mirror", planId: replacementPlanId },
      {
        transitionId: "PL-T39",
        commandId: "open-active",
        action: "open",
        sourceScenarioId: "PL-S087",
        destinationScenarioId: "PL-S088",
        returnFocusId: replacementPlanId,
      },
    ]);
  });

  it("dispatches retry and provider-only verification for the active Plan", async () => {
    const state = planReadModel({
      lifecycle: "active",
      scenarioId: "PL-S039",
      projection: "active",
      planId: "00000000000000000000000003",
    });
    const subject = harness({
      ids: ["retry-command", "verify-command"],
      getPlanState: async () => ({ status: "ready", state }),
      executePlanTransition: async () => ({ status: "completed", state }),
    });
    subject.adapter.start();
    await settle();

    subject.adapter.reconcilePlan();
    await settle();
    subject.adapter.verifyReconciliation();
    await settle();

    expect(subject.executePlanTransition).toHaveBeenNthCalledWith(1, {
      transitionId: "PL-T12",
      commandId: "retry-command",
      planId: "00000000000000000000000003",
      mode: "reconcile",
    });
    expect(subject.executePlanTransition).toHaveBeenNthCalledWith(2, {
      transitionId: "PL-T12",
      commandId: "verify-command",
      planId: "00000000000000000000000003",
      mode: "verify",
    });
  });

  it("dispatches End Plan confirmation, cancellation, cleanup retry, and verify-only recovery", async () => {
    const planId = "00000000000000000000000003";
    const active = planReadModel({
      lifecycle: "active",
      scenarioId: "PL-S004",
      projection: "active",
      planId,
    });
    const subject = harness({
      ids: ["open-end", "cancel-end", "confirm-end", "retry-cleanup", "verify-cleanup"],
      getPlanState: async () => ({ status: "ready", state: active }),
      executePlanTransition: async () => ({ status: "completed", state: active }),
    });
    subject.adapter.start();
    await settle();

    subject.adapter.openEndConfirmation();
    await settle();
    subject.adapter.closeEndConfirmation();
    await settle();
    subject.adapter.confirmEndPlan();
    await settle();
    subject.adapter.retryPlanCleanup();
    await settle();
    subject.adapter.verifyPlanCleanup();
    await settle();

    expect(subject.executePlanTransition.mock.calls.map(([command]) => command)).toEqual([
      { transitionId: "PL-T23", commandId: "open-end", planId },
      {
        transitionId: "PL-T39",
        commandId: "cancel-end",
        action: "back",
        sourceScenarioId: "PL-S051",
        destinationScenarioId: "PL-S004",
        returnFocusId: "plan-end-trigger",
      },
      { transitionId: "PL-T24", commandId: "confirm-end", planId, mode: "cleanup" },
      { transitionId: "PL-T24", commandId: "retry-cleanup", planId, mode: "cleanup" },
      { transitionId: "PL-T24", commandId: "verify-cleanup", planId, mode: "verify" },
    ]);
  });

  it("opens and closes Plan history and dispatches single-step Undo", async () => {
    const planId = "00000000000000000000000003";
    const ledgerId = "00000000000000000000000005";
    const active = planReadModel({
      lifecycle: "active",
      scenarioId: "PL-S004",
      projection: "active",
      planId,
    });
    const history = { ...active, scenarioId: "PL-S005" as const };
    const subject = harness({
      ids: ["history-open", "history-close", "history-undo"],
      getPlanState: async () => ({ status: "ready", state: active }),
      executePlanTransition: async (command) => ({
        status: "completed",
        state: command.transitionId === "PL-T39" && command.action === "open" ? history : active,
      }),
    });
    subject.adapter.start();
    await settle();

    subject.adapter.openHistory();
    await settle();
    subject.adapter.closeHistory();
    await settle();
    subject.adapter.undoPlanChange(ledgerId);
    await settle();

    expect(subject.executePlanTransition).toHaveBeenNthCalledWith(1, {
      transitionId: "PL-T39",
      commandId: "history-open",
      action: "open",
      sourceScenarioId: "PL-S004",
      destinationScenarioId: "PL-S005",
      returnFocusId: planId,
    });
    expect(subject.executePlanTransition).toHaveBeenNthCalledWith(2, {
      transitionId: "PL-T39",
      commandId: "history-close",
      action: "back",
      sourceScenarioId: "PL-S005",
      destinationScenarioId: "PL-S004",
      returnFocusId: planId,
    });
    expect(subject.executePlanTransition).toHaveBeenNthCalledWith(3, {
      transitionId: "PL-T21",
      commandId: "history-undo",
      planId,
      ledgerId,
    });
  });

  it("opens a workout and resolves a heuristic match through PL-T13 and PL-T14", async () => {
    const state = planReadModel({
      lifecycle: "active",
      scenarioId: "PL-S004",
      projection: "active",
      planId: "00000000000000000000000003",
    });
    const subject = harness({
      ids: ["open-command", "confirm-command"],
      getPlanState: async () => ({ status: "ready", state }),
      executePlanTransition: async () => ({ status: "completed", state }),
    });
    subject.adapter.start();
    await settle();

    subject.adapter.openWorkout("00000000000000000000000004");
    await settle();
    subject.adapter.resolveWorkoutMatch("00000000000000000000000004", "activity-1", "confirm");
    await settle();

    expect(subject.executePlanTransition).toHaveBeenNthCalledWith(1, {
      transitionId: "PL-T13",
      commandId: "open-command",
      planId: "00000000000000000000000003",
      workoutId: "00000000000000000000000004",
      sourceScenarioId: "PL-S004",
    });
    expect(subject.executePlanTransition).toHaveBeenNthCalledWith(2, {
      transitionId: "PL-T14",
      commandId: "confirm-command",
      planId: "00000000000000000000000003",
      workoutId: "00000000000000000000000004",
      activityId: "activity-1",
      decision: "confirm",
    });
  });

  it("closes the active workout drawer and restores the initiating row", async () => {
    const planId = "00000000000000000000000003";
    const workoutId = "00000000000000000000000004";
    const workout = {
      id: workoutId,
      date: "1998-08-23",
      sport: "cycling" as const,
      name: "Suggested endurance",
      durationS: 1_800,
    };
    const drawer = planReadModel({
      lifecycle: "active",
      scenarioId: "PL-S021",
      projection: "active",
      planId,
      data: {
        plan: {
          id: planId,
          name: "Gran Fondo Plan",
          primaryGoal: "Finish",
          startDate: "1998-07-13",
          targetDate: "1998-10-04",
          kind: "full-plan",
          totalWeeks: 12,
          weekStartDay: 1,
          workoutCount: 1,
          plannedDurationS: 1_800,
        },
        today: "1998-08-23",
        weekIndex: 6,
        todayWorkout: workout,
        workouts: [workout],
        selectedWorkout: workout,
        selectedWorkoutId: workoutId,
        selectedWorkoutSourceScenarioId: "PL-S004",
      },
    });
    const subject = harness({
      ids: ["close-workout"],
      getPlanState: async () => ({ status: "ready", state: drawer }),
      executePlanTransition: async () => ({ status: "completed", state: drawer }),
    });
    subject.adapter.start();
    await settle();

    subject.adapter.closeWorkout();
    await settle();

    expect(subject.executePlanTransition).toHaveBeenCalledWith({
      transitionId: "PL-T39",
      commandId: "close-workout",
      action: "back",
      sourceScenarioId: "PL-S021",
      destinationScenarioId: "PL-S004",
      returnFocusId: `workout-row-${workoutId}`,
    });
  });

  it.each([
    ["PL-S021", "workout-match"],
    ["PL-S032", "workout-drift"],
  ] as const)(
    "returns %s from a Plan attention item to its exact attention row",
    async (scenarioId, attentionKind) => {
      const planId = "00000000000000000000000003";
      const workoutId = "00000000000000000000000004";
      const workout = {
        id: workoutId,
        date: "1998-08-23",
        sport: "cycling" as const,
        name: "Suggested endurance",
        durationS: 1_800,
      };
      const drawer = planReadModel({
        lifecycle: "active",
        scenarioId,
        projection: "active",
        planId,
        data: {
          plan: {
            id: planId,
            name: "Gran Fondo Plan",
            primaryGoal: "Finish",
            startDate: "1998-07-13",
            targetDate: "1998-10-04",
            kind: "full-plan",
            totalWeeks: 12,
            weekStartDay: 1,
            workoutCount: 1,
            plannedDurationS: 1_800,
          },
          today: "1998-08-23",
          weekIndex: 6,
          todayWorkout: workout,
          workouts: [workout],
          selectedWorkout: workout,
          selectedWorkoutId: workoutId,
          selectedWorkoutSourceScenarioId: "PL-S028",
        },
      });
      const subject = harness({
        ids: [`close-${attentionKind}`],
        getPlanState: async () => ({ status: "ready", state: drawer }),
        executePlanTransition: async () => ({ status: "completed", state: drawer }),
      });
      subject.adapter.start();
      await settle();

      subject.adapter.closeWorkout();
      await settle();

      expect(subject.executePlanTransition).toHaveBeenCalledWith({
        transitionId: "PL-T39",
        commandId: `close-${attentionKind}`,
        action: "back",
        sourceScenarioId: scenarioId,
        destinationScenarioId: "PL-S028",
        returnFocusId: `plan-attention-${attentionKind}:${workoutId}`,
      });
    },
  );

  it("returns a Proposal drawer to its exact active source and initiating row", async () => {
    const planId = "00000000000000000000000003";
    const workoutId = "00000000000000000000000004";
    const proposalId = "00000000000000000000000005";
    const workout = {
      id: workoutId,
      date: "1998-08-23",
      sport: "cycling" as const,
      name: "Endurance",
      durationS: 5_400,
    };
    const proposal = {
      id: proposalId,
      revision: 1,
      title: "Sunday recovery",
      rationale: "Recovery is lower than normal.",
      confidence: "High",
      targetWorkoutId: workoutId,
      affectedDate: "1998-08-23",
      createdAtMs: 903_766_320_000,
      stale: false,
      diff: [{ field: "duration", label: "Duration", before: "1:30", after: "0:30" }],
      premises: [],
      error: null,
    };
    const data = {
      plan: {
        id: planId,
        name: "Gran Fondo Plan",
        primaryGoal: "Finish",
        startDate: "1998-07-13",
        targetDate: "1998-10-04",
        kind: "full-plan" as const,
        totalWeeks: 12,
        weekStartDay: 1,
        workoutCount: 1,
        plannedDurationS: 5_400,
      },
      today: "1998-08-22",
      weekIndex: 6,
      todayWorkout: null,
      workouts: [workout],
      proposals: [proposal],
      selectedProposalId: null,
      selectedProposalReturn: null,
    };
    const overview = planReadModel({
      lifecycle: "active",
      scenarioId: "PL-S010",
      projection: "active",
      planId,
      data,
    });
    const selectedProposalReturn = {
      sourceScenarioId: "PL-S010" as const,
      returnFocusId: `workout-row-${workoutId}`,
    };
    const drawer = planReadModel({
      lifecycle: "active",
      scenarioId: "PL-S007",
      projection: "active",
      planId,
      data: {
        ...data,
        selectedProposalId: proposalId,
        selectedProposalReturn,
      },
    });
    const returned = planReadModel({
      lifecycle: "active",
      scenarioId: "PL-S010",
      projection: "active",
      planId,
      data: { ...data, returnFocusId: selectedProposalReturn.returnFocusId },
    });
    const subject = harness({
      ids: ["open-proposal", "close-proposal"],
      getPlanState: async () => ({ status: "ready", state: overview }),
      executePlanTransition: async (command) => ({
        status: "completed",
        state: command.transitionId === "PL-T17" ? drawer : returned,
      }),
    });
    subject.adapter.start();
    await settle();

    subject.adapter.openProposal(proposalId);
    await settle();
    subject.adapter.closeProposal();
    await settle();

    expect(subject.executePlanTransition).toHaveBeenNthCalledWith(1, {
      transitionId: "PL-T17",
      commandId: "open-proposal",
      planId,
      proposalId,
      selectedProposalReturn,
    });
    expect(subject.executePlanTransition).toHaveBeenNthCalledWith(2, {
      transitionId: "PL-T39",
      commandId: "close-proposal",
      action: "back",
      sourceScenarioId: "PL-S007",
      destinationScenarioId: "PL-S010",
      returnFocusId: `workout-row-${workoutId}`,
      selectedProposalReturn,
    });
  });

  it("navigates active Plan to Season and Race week with exact source commands", async () => {
    const planId = "00000000000000000000000003";
    const active = planReadModel({
      lifecycle: "active",
      scenarioId: "PL-S004",
      projection: "active",
      planId,
    });
    const season = { ...active, scenarioId: "PL-S006" as const };
    const raceWeek = { ...active, scenarioId: "PL-S009" as const };
    const subject = harness({
      ids: ["season-open", "race-open", "race-close", "season-close"],
      getPlanState: async () => ({ status: "ready", state: active }),
      executePlanTransition: async (command) => {
        const state =
          command.transitionId === "PL-T31"
            ? season
            : command.transitionId === "PL-T39" && command.destinationScenarioId === "PL-S009"
              ? raceWeek
              : command.transitionId === "PL-T39" && command.destinationScenarioId === "PL-S006"
                ? season
                : active;
        return { status: "completed", state };
      },
    });
    subject.adapter.start();
    await settle();

    subject.adapter.openSeason();
    await settle();
    subject.adapter.openRaceWeek();
    await settle();
    subject.adapter.closeRaceWeek();
    await settle();
    subject.adapter.closeSeason();
    await settle();

    expect(subject.executePlanTransition.mock.calls.map(([command]) => command)).toEqual([
      { transitionId: "PL-T31", commandId: "season-open", planId },
      {
        transitionId: "PL-T39",
        commandId: "race-open",
        action: "open",
        sourceScenarioId: "PL-S006",
        destinationScenarioId: "PL-S009",
        returnFocusId: "plan-race-week-trigger",
      },
      {
        transitionId: "PL-T39",
        commandId: "race-close",
        action: "back",
        sourceScenarioId: "PL-S009",
        destinationScenarioId: "PL-S006",
        returnFocusId: "plan-race-week-trigger",
      },
      {
        transitionId: "PL-T39",
        commandId: "season-close",
        action: "back",
        sourceScenarioId: "PL-S006",
        destinationScenarioId: "PL-S004",
        returnFocusId: "plan-season-trigger",
      },
    ]);
  });

  it("opens, refreshes, and closes Race readiness with exact commands", async () => {
    const planId = "00000000000000000000000003";
    const active = planReadModel({
      lifecycle: "active",
      scenarioId: "PL-S004",
      projection: "active",
      planId,
    });
    const readiness = { ...active, scenarioId: "PL-S012" as const };
    const subject = harness({
      ids: ["readiness-open", "readiness-refresh", "readiness-close"],
      getPlanState: async () => ({ status: "ready", state: active }),
      executePlanTransition: async (command) => ({
        status: "completed",
        state: command.transitionId === "PL-T39" ? active : readiness,
      }),
    });
    subject.adapter.start();
    await settle();

    subject.adapter.openReadiness();
    await settle();
    subject.adapter.refreshReadiness();
    await settle();
    subject.adapter.closeReadiness();
    await settle();

    expect(subject.executePlanTransition.mock.calls.map(([command]) => command)).toEqual([
      {
        transitionId: "PL-T32",
        commandId: "readiness-open",
        planId,
        mode: "open",
      },
      {
        transitionId: "PL-T32",
        commandId: "readiness-refresh",
        planId,
        mode: "refresh",
      },
      {
        transitionId: "PL-T39",
        commandId: "readiness-close",
        action: "back",
        sourceScenarioId: "PL-S012",
        destinationScenarioId: "PL-S004",
        returnFocusId: "plan-readiness-trigger",
      },
    ]);
  });

  it.each(["PL-S037", "PL-S042"] as const)(
    "starts or resumes reconciliation once after hydrating %s",
    async (scenarioId) => {
      const state = planReadModel({
        lifecycle: "active",
        scenarioId,
        projection: "active",
        planId: "00000000000000000000000003",
      });
      const subject = harness({
        ids: ["resume-command"],
        getPlanState: async () => ({ status: "ready", state }),
        executePlanTransition: async () => ({ status: "completed", state }),
      });

      subject.adapter.start();
      await settle();
      await settle();

      expect(subject.executePlanTransition).toHaveBeenCalledOnce();
      expect(subject.executePlanTransition).toHaveBeenCalledWith({
        transitionId: "PL-T12",
        commandId: "resume-command",
        planId: "00000000000000000000000003",
        mode: "reconcile",
      });
    },
  );

  it("resumes an interrupted ended-Plan cleanup once after hydration", async () => {
    const planId = "00000000000000000000000003";
    const state = planReadModel({
      lifecycle: "ended",
      scenarioId: "PL-S052",
      projection: "ended",
      planId,
    });
    const subject = harness({
      ids: ["resume-cleanup"],
      getPlanState: async () => ({ status: "ready", state }),
      executePlanTransition: async () => ({ status: "completed", state }),
    });

    subject.adapter.start();
    await settle();
    await settle();

    expect(subject.executePlanTransition).toHaveBeenCalledOnce();
    expect(subject.executePlanTransition).toHaveBeenCalledWith({
      transitionId: "PL-T24",
      commandId: "resume-cleanup",
      planId,
      mode: "cleanup",
    });
  });

  it("resumes replacement cleanup once after the atomic local swap", async () => {
    const previousPlanId = "00000000000000000000000003";
    const replacementPlanId = "00000000000000000000000004";
    const state = planReadModel({
      lifecycle: "active",
      scenarioId: "PL-S082",
      projection: "active",
      planId: replacementPlanId,
      data: {
        plan: {
          id: replacementPlanId,
          name: "Replacement Plan",
          primaryGoal: "Finish",
          startDate: "2026-08-27",
          targetDate: "2026-11-18",
          kind: "full-plan",
          totalWeeks: 12,
          weekStartDay: 4,
          workoutCount: 1,
          plannedDurationS: 3_600,
        },
        today: "2026-08-26",
        weekIndex: 1,
        todayWorkout: null,
        workouts: [],
        replacement: {
          id: "00000000000000000000000005",
          previousPlan: {
            id: previousPlanId,
            name: "Previous Plan",
            primaryGoal: "Finish",
            startDate: "2026-07-09",
            targetDate: "2026-09-30",
            kind: "full-plan",
            totalWeeks: 12,
            weekStartDay: 4,
            workoutCount: 0,
            plannedDurationS: 0,
          },
          activatedAtMs: 100,
          cleanupItems: [],
        },
      },
    });
    const subject = harness({
      ids: ["resume-replacement-cleanup"],
      getPlanState: async () => ({ status: "ready", state }),
      executePlanTransition: async () => ({ status: "completed", state }),
    });

    subject.adapter.start();
    await settle();
    await settle();

    expect(subject.executePlanTransition).toHaveBeenCalledOnce();
    expect(subject.executePlanTransition).toHaveBeenCalledWith({
      transitionId: "PL-T27",
      commandId: "resume-replacement-cleanup",
      planId: previousPlanId,
      replacementPlanId,
      mode: "cleanup",
    });
  });

  it("hydrates an expired active Plan without issuing a completion command", async () => {
    const planId = "00000000000000000000000003";
    const active = planReadModel({
      lifecycle: "active",
      scenarioId: "PL-S004",
      projection: "active",
      planId,
      data: {
        plan: {
          id: planId,
          name: "Gran Fondo",
          primaryGoal: "Finish",
          startDate: "1998-07-13",
          targetDate: "1998-10-04",
          kind: "full-plan",
          totalWeeks: 12,
          weekStartDay: 1,
          workoutCount: 0,
          plannedDurationS: 0,
        },
        today: "1998-10-05",
        weekIndex: 12,
        todayWorkout: null,
        workouts: [],
      },
    });
    const subject = harness({
      getPlanState: async () => ({ status: "ready", state: active }),
    });

    subject.adapter.start();
    await settle();
    subject.adapter.open();
    await settle();

    expect(subject.surface.hydration).toEqual({ status: "ready", state: active });
    expect(subject.executePlanTransition).not.toHaveBeenCalled();
  });

  it("opens and records the separate race outcome", async () => {
    const planId = "00000000000000000000000003";
    const natural = planReadModel({
      lifecycle: "ended",
      scenarioId: "PL-S094",
      projection: "ended",
      planId,
      reconciliation: {
        status: "verified",
        created: 0,
        pending: 0,
        failed: 0,
        total: 0,
        currentThrough: "1998-10-06",
        error: null,
      },
    });
    const choice = planReadModel({
      lifecycle: "ended",
      scenarioId: "PL-S095",
      projection: "ended",
      planId,
    });
    const subject = harness({
      ids: ["open-outcome", "save-outcome"],
      getPlanState: async () => ({ status: "ready", state: natural }),
      executePlanTransition: async (command) => ({
        status: "completed",
        state: command.transitionId === "PL-T39" ? choice : natural,
      }),
    });
    subject.adapter.start();
    await settle();

    subject.adapter.openRaceOutcome();
    await settle();
    subject.adapter.recordRaceOutcome("not-completed");
    await settle();

    expect(subject.executePlanTransition.mock.calls.map(([command]) => command)).toEqual([
      {
        transitionId: "PL-T39",
        commandId: "open-outcome",
        action: "open",
        sourceScenarioId: "PL-S094",
        destinationScenarioId: "PL-S095",
        returnFocusId: planId,
      },
      {
        transitionId: "PL-T30",
        commandId: "save-outcome",
        planId,
        outcome: "not-completed",
      },
    ]);
  });

  it("delivers one due Weekly review per successful sync", async () => {
    const planId = "00000000000000000000000003";
    const dueData = {
      plan: {
        id: planId,
        name: "Gran Fondo",
        primaryGoal: "Finish",
        startDate: "2026-07-13",
        targetDate: "2026-10-04",
        kind: "full-plan" as const,
        totalWeeks: 12,
        weekStartDay: 1,
        workoutCount: 0,
        plannedDurationS: 0,
      },
      today: "2026-08-26",
      weekIndex: 7,
      todayWorkout: null,
      workouts: [],
      weeklyReview: {
        status: "due" as const,
        weekStart: "2026-08-17",
        weekEnd: "2026-08-23",
        lastSuccessfulSyncAtMs: 100,
      },
    };
    const due = planReadModel({
      lifecycle: "active",
      scenarioId: "PL-S004",
      projection: "active",
      planId,
      data: dueData,
    });
    const delivered = planReadModel({
      lifecycle: "active",
      scenarioId: "PL-S100",
      projection: "active",
      planId,
      data: {
        ...dueData,
        weeklyReview: {
          status: "delivered" as const,
          id: "00000000000000000000000004",
          weekStart: "2026-08-17",
          weekEnd: "2026-08-23",
          deliveredAtMs: 101,
          counts: { asPlanned: 3, adjusted: 1, moved: 0, missed: 1, extra: 1 },
          summary: "Last week: 3 as planned, 1 adjusted, 0 moved, 1 missed, 1 extra.",
        },
      },
    });
    const subject = harness({
      ids: ["weekly-review"],
      getPlanState: async () => ({ status: "ready", state: due }),
      executePlanTransition: async () => ({ status: "completed", state: delivered }),
    });

    subject.adapter.start();
    await settle();
    await settle();

    expect(subject.executePlanTransition).toHaveBeenCalledOnce();
    expect(subject.executePlanTransition).toHaveBeenCalledWith({
      transitionId: "PL-T35",
      commandId: "weekly-review",
      planId,
      weekStart: "2026-08-17",
    });
    expect(subject.surface.hydration).toEqual({ status: "ready", state: delivered });
  });

  it("optimistically saves one Plan setting, restores failure, and retries the same control", async () => {
    const planId = "00000000000000000000000003";
    const data = {
      plan: {
        id: planId,
        name: "Gran Fondo",
        primaryGoal: "Finish",
        startDate: "2026-07-13",
        targetDate: "2026-10-04",
        kind: "full-plan" as const,
        totalWeeks: 12,
        weekStartDay: 1,
        workoutCount: 0,
        plannedDurationS: 0,
      },
      today: "2026-08-26",
      weekIndex: 7,
      todayWorkout: null,
      workouts: [],
      settings: {
        autoApply: false,
        weeklyReview: true,
        updatedAtMs: 10,
        selectedSetting: null,
        error: null,
      },
    };
    const ready = planReadModel({
      lifecycle: "active",
      scenarioId: "PL-S090",
      projection: "active",
      planId,
      data,
    });
    const failed = {
      ...ready,
      scenarioId: "PL-S093" as const,
      data: {
        ...data,
        settings: {
          ...data.settings,
          selectedSetting: "auto-apply" as const,
          error: {
            code: "persistence-failed" as const,
            message: "Could not save.",
            retryable: true,
          },
        },
      },
    };
    const saved = {
      ...ready,
      scenarioId: "PL-S092" as const,
      data: {
        ...data,
        settings: {
          ...data.settings,
          autoApply: true,
          updatedAtMs: 11,
          selectedSetting: "auto-apply" as const,
        },
      },
    };
    const first = deferred<ExecutePlanTransitionRpcResult>();
    const second = deferred<ExecutePlanTransitionRpcResult>();
    const execute = vi
      .fn<PlanBridge["executePlanTransition"]>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const subject = harness({
      ids: ["setting-save", "setting-retry"],
      getPlanState: async () => ({ status: "ready", state: ready }),
      executePlanTransition: execute,
    });
    subject.adapter.start();
    await settle();

    subject.adapter.setPlanSetting("auto-apply", true);
    expect(subject.surface.settingPending).toEqual({ setting: "auto-apply", value: true });
    expect(subject.surface.transition).toMatchObject({
      status: "submitting",
      transitionId: "PL-T22",
    });
    expect(subject.executePlanTransition).toHaveBeenNthCalledWith(1, {
      transitionId: "PL-T22",
      commandId: "setting-save",
      planId,
      setting: "auto-apply",
      value: true,
    });

    first.resolve({
      status: "rejected",
      error: { code: "persistence-failed", message: "Could not save.", retryable: true },
      state: failed,
    });
    await settle();
    expect(subject.surface.settingPending).toBeNull();
    expect(subject.surface.hydration).toEqual({ status: "ready", state: failed });
    expect(subject.surface.transition.status).toBe("failed");

    subject.adapter.retry();
    expect(subject.surface.settingPending).toEqual({ setting: "auto-apply", value: true });
    expect(subject.executePlanTransition).toHaveBeenNthCalledWith(2, {
      transitionId: "PL-T22",
      commandId: "setting-retry",
      planId,
      setting: "auto-apply",
      value: true,
    });
    second.resolve({ status: "completed", state: saved });
    await settle();
    expect(subject.surface.settingPending).toBeNull();
    expect(subject.surface.hydration).toEqual({ status: "ready", state: saved });
    expect(subject.surface.transition).toEqual({ status: "idle" });
  });

  it("accepts progress only for the current command, transition, and operation", async () => {
    const state = planReadModel({ lifecycle: "intake", projection: "coach" });
    const subject = harness({
      ids: ["command-1"],
      executePlanTransition: async () => ({
        status: "accepted",
        operationId: "operation-1",
        state,
      }),
    });
    subject.adapter.start();
    await settle();
    subject.adapter.openChatRequest("chat-1", "request-1");
    await settle();

    const matching: PlanProgressEvent = {
      commandId: "command-1",
      transitionId: "PL-T36",
      operationId: "operation-1",
      phase: "running",
      completed: 1,
      total: 2,
    };
    subject.progress({ ...matching, operationId: "other-operation" });
    expect(subject.surface.transition).toMatchObject({ progress: null });

    subject.progress(matching);
    expect(subject.surface.transition).toMatchObject({ progress: matching });

    subject.progress({ ...matching, phase: "completed", completed: 2 });
    await settle();
    expect(subject.getPlanState).toHaveBeenCalledTimes(2);
  });

  it("disposes the progress subscription and ignores pending hydration", async () => {
    const load = deferred<GetPlanStateRpcResult>();
    const subject = harness({ getPlanState: () => load.promise });
    subject.adapter.start();

    subject.adapter.dispose();
    load.resolve({ status: "ready", state: planReadModel() });
    await settle();

    expect(subject.disposeProgress).toHaveBeenCalledOnce();
    expect(subject.surface.hydration).toEqual({ status: "loading" });
  });

  it("reloads the Plan state on demand", async () => {
    const subject = harness();
    subject.adapter.start();
    await settle();
    expect(subject.getPlanState).toHaveBeenCalledTimes(1);

    subject.adapter.reload();
    await settle();

    expect(subject.getPlanState).toHaveBeenCalledTimes(2);
    expect(subject.surface.hydration.status).toBe("ready");
  });
});

describe("Plan library RPC adapters", () => {
  function clientProvider() {
    const client: CoachClient = {
      call: async () => {
        throw new Error("Unexpected RPC call");
      },
      get handshake(): CoachClient["handshake"] {
        throw new Error("Unexpected handshake read");
      },
      close: async () => undefined,
    };
    const clients: DesktopCoachClientProvider = {
      getClient: async () => client,
      reconnect: async () => client,
      close: async () => undefined,
    };
    return { clients, call: vi.spyOn(client, "call") };
  }

  it("reads the final history for the selected Plan", async () => {
    const { clients, call } = clientProvider();
    call.mockResolvedValue(null);
    expect(await readPlanHistory(clients, "00000000000000000000000003")).toBeNull();
    expect(call).toHaveBeenCalledWith("plan.history", {
      planId: "00000000000000000000000003",
    });
  });

  it("closes the confirmed version with its supplied command id", async () => {
    const commandId = "12345678-1234-1234-1234-123456789012";
    const result = {
      status: "closed" as const,
      planId: "00000000000000000000000003",
      closedAt: 907459200000,
      cleanupJobId: "00000000000000000000000004",
    };
    const { clients, call } = clientProvider();
    call.mockResolvedValue(result);
    expect(
      await closePlan(clients, { commandId, planId: result.planId, expectedVersion: 7 }),
    ).toEqual(result);
    expect(call).toHaveBeenCalledWith("plan.close", {
      commandId,
      planId: result.planId,
      expectedVersion: 7,
    });
  });
});

describe("Plan Change RPC adapters", () => {
  it("preserves confirmed command ids and preview and decision payloads", async () => {
    const call = vi.fn().mockResolvedValue({ status: "rejected", reason: "stale-version" });
    const clients = { getClient: async () => ({ call }) } as unknown as DesktopCoachClientProvider;
    const preview = {
      commandId: "preview-command",
      planId: "plan-active",
      expectedVersion: 4,
      intent: { kind: "weekly-duration", hours: 6 },
    } as const;
    const decision = {
      commandId: "apply-command",
      planId: "plan-active",
      expectedVersion: 5,
      changeId: "change-pending",
      decision: "apply",
    } as const;
    expect(await previewPlanChange(clients, preview)).toEqual({
      status: "rejected",
      reason: "stale-version",
    });
    await applyPlanChange(clients, decision);
    await applyPlanChange(clients, {
      ...decision,
      commandId: "cancel-command",
      decision: "cancel",
    });
    expect(call).toHaveBeenNthCalledWith(1, "plan_change.preview", {
      ...preview,
    });
    expect(call).toHaveBeenNthCalledWith(2, "plan_change.apply", {
      ...decision,
    });
    expect(call).toHaveBeenNthCalledWith(3, "plan_change.apply", {
      ...decision,
      decision: "cancel",
      commandId: "cancel-command",
    });
    expect(new Set(call.mock.calls.map(([, request]) => request.commandId)).size).toBe(3);
  });

  it("forwards preview transport options when supplied", async () => {
    const call = vi.fn().mockResolvedValue({ status: "rejected", reason: "stale-version" });
    const clients = { getClient: async () => ({ call }) } as unknown as DesktopCoachClientProvider;
    const preview = {
      commandId: "preview-command",
      planId: "plan-active",
      expectedVersion: 4,
      intent: { kind: "weekly-duration", hours: 6 },
    } as const;
    const options = { onEvent: vi.fn() };
    expect(await previewPlanChange(clients, preview, options)).toEqual({
      status: "rejected",
      reason: "stale-version",
    });
    expect(call).toHaveBeenCalledWith("plan_change.preview", { ...preview }, options);
  });
});
