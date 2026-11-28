import { expect, test } from "@playwright/test";
import { PlanCoachProjectionDataSchema, PlanReadModelSchema } from "@enduragent/coach-contract";
import {
  chatRpcDefault,
  openHiddenChatApp,
  rpcReply,
  type ChatRpcRequest,
} from "../helpers/hidden-chat-app.js";
import { createPlanQaHydratedModel } from "../helpers/plan-qa-live.js";

const TOKEN = "plan-chat-discard-held-message-e2e-01234567";
const CHAT_ID = "plan:00000000000000000000000001";
const FIRST_MESSAGE = "Can my long ride move to Sunday?";
const FIRST_REPLY = "Yes. Sunday works if Saturday stays easy.";
const HELD_MESSAGE = "Also cap weekday rides at one hour";
const HELD_PARTIAL = "Capping weekday rides at one hour moves the threshold work";
const WAITING_MESSAGE = "And keep Friday as a rest day";
const WAITING_REPLY = "Friday stays a rest day in your plan.";
const WAITING_COPY = "Sends after you retry or discard the earlier message.";

interface QueueItem {
  readonly queuedMessageId: string;
  readonly messageId: string;
  readonly submissionId: string;
  readonly text: string;
  readonly kind: "ordinary";
  readonly attachmentIds: readonly string[];
  readonly restored: false;
}

interface QueueClaim {
  readonly claimId: string;
  readonly queuedMessageIds: readonly string[];
  readonly turnId: string;
  status: "claimed" | "retry-required";
}

interface TurnContext {
  readonly turnId: string;
  readonly text: string;
  emit(event: Record<string, unknown>): void;
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createPlanCoach() {
  const base = createPlanQaHydratedModel("PL-S017");
  const coach = PlanCoachProjectionDataSchema.parse(base.data);
  const persisted: { id: string; turnId: string; role: "athlete" | "coach"; text: string }[] = [];
  let revision = 0;
  let items: QueueItem[] = [];
  let claim: QueueClaim | undefined;
  let turns = 0;
  let claims = 0;
  let operations = 0;
  let enqueued = 0;
  const queued = [deferred(), deferred()];
  const stopped = deferred();
  const engineCalls: string[] = [];
  const discardedClaims: string[] = [];

  const snapshot = () => ({
    schemaVersion: 1 as const,
    revision,
    items: items.map((item, position) => ({ ...item, position })),
    ...(claim?.status === "retry-required" ? { retryRequired: { ...claim } } : {}),
  });
  const model = () =>
    PlanReadModelSchema.parse({
      ...base,
      data: { ...coach, messages: [...coach.messages, ...persisted], queue: snapshot() },
    });
  const persist = (turnId: string, athlete: string, reply: string) => {
    persisted.push(
      { id: `athlete-${turnId}`, turnId, role: "athlete", text: athlete },
      { id: `coach-${turnId}`, turnId, role: "coach", text: reply },
    );
  };
  const release = () => {
    const ids = new Set(claim?.queuedMessageIds ?? []);
    items = items.filter((item) => !ids.has(item.queuedMessageId));
    claim = undefined;
    revision += 1;
  };
  const queueText = () =>
    (claim?.status === "retry-required" ? items.slice(0, claim.queuedMessageIds.length) : items)
      .map((item) => item.text)
      .join("\n\n");

  const playTurn = async (turn: TurnContext): Promise<"completed" | "interrupted"> => {
    turn.emit({ type: "turn-start", turnId: turn.turnId, chatId: CHAT_ID });
    if (turn.text === FIRST_MESSAGE) {
      turn.emit({ type: "text_delta", turnId: turn.turnId, delta: FIRST_REPLY });
      await queued[0]!.promise;
      turn.emit({ type: "final-text", turnId: turn.turnId, text: FIRST_REPLY });
      persist(turn.turnId, turn.text, FIRST_REPLY);
      return "completed";
    }
    if (turn.text === HELD_MESSAGE) {
      turn.emit({ type: "text_delta", turnId: turn.turnId, delta: HELD_PARTIAL });
      await Promise.all([queued[1]!.promise, stopped.promise]);
      turn.emit({ type: "interrupted", turnId: turn.turnId, chatId: CHAT_ID, text: HELD_PARTIAL });
      persist(turn.turnId, turn.text, HELD_PARTIAL);
      return "interrupted";
    }
    if (turn.text === WAITING_MESSAGE) {
      turn.emit({ type: "text_delta", turnId: turn.turnId, delta: WAITING_REPLY });
      turn.emit({ type: "final-text", turnId: turn.turnId, text: WAITING_REPLY });
      persist(turn.turnId, turn.text, WAITING_REPLY);
      return "completed";
    }
    throw new Error(`Coach did not expect the message ${JSON.stringify(turn.text)}`);
  };

  const runCoachCall = async (text: string, emit: TurnContext["emit"]) => {
    let pending = text;
    for (let first = true; first || items.length > 0; first = false) {
      turns += 1;
      const turnId = `turn-${turns}`;
      if (items.length > 0 && queueText() === pending) {
        const retry = claim?.status === "retry-required";
        engineCalls.push(`${retry ? "retry" : "resume"}:${pending}`);
        if (claim === undefined) {
          claims += 1;
          const ids = items.map((item) => item.queuedMessageId);
          claim = { claimId: `claim-${claims}`, queuedMessageIds: ids, turnId, status: "claimed" };
        }
        claim.status = "claimed";
        const outcome = await playTurn({ turnId: claim.turnId, text: pending, emit });
        if (outcome === "completed") release();
        else claim.status = "retry-required";
        revision += 1;
      } else {
        engineCalls.push(`chat:${pending}`);
        await playTurn({ turnId, text: pending, emit });
      }
      if (claim?.status === "retry-required" || items.length === 0) break;
      pending = queueText();
    }
  };

  return {
    engineCalls,
    discardedClaims,
    script: {
      streamPlanTransitions: true as const,
      onRequest(value: unknown): readonly string[] {
        const request = value as ChatRpcRequest;
        const planChat = request.params?.chatId === CHAT_ID;
        switch (request.method) {
          case "getPlanState":
            return rpcReply({ status: "ready", state: model() });
          case "getChatQueue":
            return planChat ? rpcReply(snapshot()) : chatRpcDefault(request);
          case "enqueueChatMessage": {
            if (!planChat) throw new Error("Coach expected the message in the Plan chat");
            const params = request.params as { submissionId: string; text: string };
            revision += 1;
            items.push({
              queuedMessageId: `queued-${revision}`,
              messageId: `message-${revision}`,
              submissionId: params.submissionId,
              text: params.text,
              kind: "ordinary",
              attachmentIds: [],
              restored: false,
            });
            enqueued += 1;
            queued[enqueued - 1]?.resolve();
            return rpcReply(snapshot());
          }
          case "stopChat":
            stopped.resolve();
            return rpcReply({ stopped: true });
          case "discardQueuedTurn": {
            const { claimId } = request.params as { claimId: string };
            discardedClaims.push(claimId);
            if (claim?.claimId !== claimId || claim.status !== "retry-required") {
              throw new Error("Coach was asked to discard a message it is not holding");
            }
            release();
            return rpcReply(snapshot());
          }
          default:
            return chatRpcDefault(request);
        }
      },
      async onStreamRequest(value: unknown, emitFrame: (frame: string) => void): Promise<string> {
        const request = value as ChatRpcRequest;
        const params = request.params as { transitionId?: string; commandId: string; text: string };
        if (request.method !== "executePlanTransition" || params.transitionId !== "PL-T05") {
          throw new Error(`Coach did not expect ${request.method} ${params.transitionId ?? ""}`);
        }
        operations += 1;
        const progress = (phase: string, turnEvent?: Record<string, unknown>) =>
          emitFrame(
            JSON.stringify({
              event: {
                commandId: params.commandId,
                transitionId: "PL-T05",
                operationId: `operation-${operations}`,
                phase,
                completed: phase === "completed" ? 1 : 0,
                total: 1,
                ...(turnEvent === undefined ? {} : { turnEvent }),
              },
            }),
          );
        progress("queued");
        await runCoachCall(params.text, (event) => progress("running", event));
        progress("completed");
        return JSON.stringify({ status: "completed", state: model() });
      },
    },
  };
}

test("a stopped Plan chat message can be discarded so the messages queued after it send", async ({
  playwright,
}, testInfo) => {
  const coach = createPlanCoach();
  const app = await openHiddenChatApp({ playwright, testInfo, script: coach.script, token: TOKEN });
  try {
    const { page } = app;
    const still = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
    await page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("button", { name: "Plan", exact: true })
      .click();
    const composer = page.getByRole("combobox", { name: "Reply to your Plan coach" });
    const queue = page.getByRole("region", { name: "Queued coach messages" });
    const retry = queue.getByRole("button", { name: "Retry interrupted message" });

    await composer.fill(FIRST_MESSAGE);
    await composer.press("Enter");
    await expect(page.getByText(FIRST_REPLY)).toBeVisible();
    await composer.fill(HELD_MESSAGE);
    await composer.press("Enter");
    await expect(page.getByText(HELD_PARTIAL)).toBeVisible();
    await composer.fill(WAITING_MESSAGE);
    await composer.press("Enter");
    await expect(queue.getByText(WAITING_MESSAGE)).toBeVisible();

    await page.getByRole("button", { name: "Stop responding" }).click();
    await expect(retry).toBeVisible();
    await expect(queue.getByText(WAITING_MESSAGE)).toBeVisible();
    await expect(page.getByText(HELD_PARTIAL)).toBeVisible();
    await still("held");

    await expect
      .soft(
        queue.getByText(WAITING_COPY),
        "The waiting message does not say it sends after the stopped one is retried or discarded",
      )
      .toBeVisible();
    const discard = queue.getByRole("button", { name: "Discard", exact: true });
    await expect(
      discard,
      "The athlete has no way to drop the stopped Plan message, so the waiting message never sends",
    ).toBeVisible();

    await discard.click();
    await expect
      .poll(() => coach.discardedClaims, {
        message: "Discard did not tell Coach to drop the stopped Plan message",
      })
      .toEqual(["claim-1"]);
    await expect(
      page.getByText(WAITING_REPLY),
      "After Discard, the waiting Plan message was not sent to Coach",
    ).toBeVisible();
    expect(
      coach.engineCalls,
      "Coach should answer the first message, stop on the held one, then send the waiting one from the queue",
    ).toEqual([`chat:${FIRST_MESSAGE}`, `resume:${HELD_MESSAGE}`, `resume:${WAITING_MESSAGE}`]);
    await expect(queue).toHaveCount(0);
    await expect(page.getByText(HELD_MESSAGE, { exact: true })).toBeVisible();
    await expect(page.getByText(HELD_PARTIAL)).toBeVisible();
    await still("discarded");
  } finally {
    await app.close();
  }
});
