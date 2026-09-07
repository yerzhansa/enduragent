import { describe, expect, it, vi } from "vitest";
import type { CoachClient } from "@enduragent/coach-client";
import {
  COACH_RPC_METHOD_REGISTRY,
  createAcceptedServerHandshakeFrame,
  PROTOCOL_VERSION,
  type PlanCreationAnswerRpcParams,
  type PlanCreationAnswerRpcResult,
  type PlanCreationCardModel,
  type CoachRpcResponse,
} from "@enduragent/coach-contract";
import { createChatController, type ChatViewControls } from "../src/chat/controller";
import { planCreationDraft } from "./plan-creation-draft-fixtures";

describe("written commitments acknowledgement", () => {
  it("sends one acknowledgement command during confirmation and focuses Activate after success", async () => {
    const text = "Keep Sundays free.";
    const pending: PlanCreationCardModel = {
      creationId: "01J00000000000000000000000",
      version: 3,
      status: "review",
      readiness: "ready",
      answeredSummaries: [],
      openQuestion: null,
      draft: planCreationDraft(),
      draftStale: false,
      commitmentsAcknowledgement: { text },
    };
    const confirmed: PlanCreationCardModel = {
      ...pending,
      version: 4,
      commitmentsAcknowledgement: null,
      draftStale: false,
    };
    const finishAnswer = vi.fn<(result: PlanCreationAnswerRpcResult) => void>();
    const answerResult = new Promise<PlanCreationAnswerRpcResult>((resolve) => {
      finishAnswer.mockImplementation(resolve);
    });
    const call = vi.fn<CoachClient["call"]>().mockReturnValue(answerResult);
    const client: CoachClient = {
      handshake: createAcceptedServerHandshakeFrame("service-managed", PROTOCOL_VERSION, {
        athleteHome: "/synthetic/athlete",
        rendererCapability: "A".repeat(43),
      }),
      call: async (method, request) => {
        const result = await call(method, request);
        return COACH_RPC_METHOD_REGISTRY[method].responseSchema.parse(result) as CoachRpcResponse<
          typeof method
        >;
      },
      close: vi.fn(async () => {}),
    };
    const controls: ChatViewControls[] = [];
    const controller = createChatController({
      clients: {
        getClient: vi.fn(async () => client),
        reconnect: vi.fn(async () => client),
        close: vi.fn(async () => {}),
      },
      view: {
        render: (_state, next) => {
          if (next !== undefined) controls.push(structuredClone(next));
        },
      },
      refreshTrainingContext: vi.fn(async () => {}),
      refreshSpend: vi.fn(async () => {}),
    });
    controller.resumeCreation(pending);
    const initialFocusRevision = controls.at(-1)?.planCreation?.focusRequest?.revision ?? 0;
    const answer: PlanCreationAnswerRpcParams["answer"] = {
      kind: "commitments",
      commitments: { kind: "authored", text, acknowledged: true },
    };
    const first = controller.answerPlanCreation(answer);
    const second = controller.answerPlanCreation(answer);
    await vi.waitFor(() => expect(call).toHaveBeenCalledOnce());
    expect(call).toHaveBeenCalledWith("plan_creation.answer", {
      commandId: expect.any(String),
      creationId: pending.creationId,
      expectedVersion: pending.version,
      answer: {
        kind: "commitments",
        commitments: { kind: "authored", text, acknowledged: true },
      },
    });
    expect(controls.at(-1)?.planCreation).toMatchObject({ value: pending, busy: true });
    finishAnswer({ status: "answered", planCreation: confirmed });
    await Promise.all([first, second]);
    expect(call).toHaveBeenCalledOnce();
    expect(controls.at(-1)?.planCreation).toMatchObject({
      value: confirmed,
      busy: false,
      focusRequest: { target: "activate" },
    });
    expect(controls.at(-1)?.planCreation?.focusRequest?.revision).toBeGreaterThan(
      initialFocusRevision,
    );
    controller.dispose();
  });
});
