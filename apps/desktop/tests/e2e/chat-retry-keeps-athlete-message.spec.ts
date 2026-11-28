import { expect, test } from "@playwright/test";
import {
  chatRpcDefault,
  openHiddenChatApp,
  rpcReply,
  type ChatRpcRequest,
} from "../helpers/hidden-chat-app.js";

const TOKEN = "chat-retry-keeps-athlete-message-e2e-012345";
const CHAT_ID = "desktop";
const TURN_ID = "turn-saved";
const CLAIM_ID = "claim-saved";
const QUEUED_ID = "queued-saved";
const ATHLETE_MESSAGE = "Recheck the recovery ride before Tuesday";
const STOPPED_REPLY = "The recovery ride stayed controlled until";
const RETRIED_REPLY = "The recovery ride stayed controlled throughout.";

function createCoach() {
  let revision = 2;
  let held = true;
  const retriedClaims: string[] = [];
  const savedTurn = {
    turnId: TURN_ID,
    completedAt: "1998-08-24T08:00:00.000Z",
    athleteText: ATHLETE_MESSAGE,
    coachText: STOPPED_REPLY,
    delivery: "interrupted" as const,
  };
  const snapshot = () => ({
    schemaVersion: 1 as const,
    revision,
    items: held
      ? [
          {
            queuedMessageId: QUEUED_ID,
            messageId: "message-saved",
            submissionId: "submission-saved",
            text: ATHLETE_MESSAGE,
            kind: "ordinary" as const,
            attachmentIds: [],
            restored: true,
            position: 0,
          },
        ]
      : [],
    ...(held
      ? {
          retryRequired: {
            claimId: CLAIM_ID,
            queuedMessageIds: [QUEUED_ID],
            turnId: TURN_ID,
            status: "retry-required" as const,
          },
        }
      : {}),
  });

  return {
    retriedClaims,
    script: {
      onRequest(value: unknown): readonly string[] {
        const request = value as ChatRpcRequest;
        switch (request.method) {
          case "getChatQueue":
            return rpcReply(snapshot());
          case "getTranscriptPage":
            return rpcReply({
              schemaVersion: 2,
              status: "page",
              turns: [savedTurn],
              entries: [{ kind: "turn", ...savedTurn }],
              nextCursor: null,
            });
          default:
            return chatRpcDefault(request);
        }
      },
      onStreamRequest(value: unknown, emitFrame: (frame: string) => void): string {
        const request = value as ChatRpcRequest;
        if (request.method === "resumeChatQueue") return JSON.stringify({ snapshot: snapshot() });
        if (request.method !== "retryQueuedTurn") {
          throw new Error(`Coach did not expect ${request.method}`);
        }
        const { claimId } = request.params as { claimId: string };
        retriedClaims.push(claimId);
        emitFrame(JSON.stringify({ type: "turn-start", turnId: TURN_ID, chatId: CHAT_ID }));
        emitFrame(JSON.stringify({ type: "text_delta", turnId: TURN_ID, delta: RETRIED_REPLY }));
        emitFrame(JSON.stringify({ type: "final-text", turnId: TURN_ID, text: RETRIED_REPLY }));
        held = false;
        revision += 1;
        return JSON.stringify({ snapshot: snapshot(), response: { text: RETRIED_REPLY } });
      },
    },
  };
}

test("retrying a saved stopped reply keeps the athlete's message in Chat", async ({
  playwright,
}, testInfo) => {
  const coach = createCoach();
  const app = await openHiddenChatApp({ playwright, testInfo, script: coach.script, token: TOKEN });
  try {
    const { page } = app;
    const athleteMessage = page.locator("article.chat-message--athlete", {
      hasText: ATHLETE_MESSAGE,
    });
    const coachReply = (text: string) =>
      page.locator("article.chat-message--coach", { hasText: text });
    const retry = page.locator(".chat-notice").getByRole("button", { name: "Retry message" });
    const still = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`) });

    await expect(athleteMessage).toHaveCount(1);
    await expect(coachReply(STOPPED_REPLY)).toHaveCount(1);
    await expect(retry).toBeVisible();
    await still("stopped");

    await retry.click();
    await expect(coachReply(RETRIED_REPLY)).toHaveCount(1);
    await expect(retry).toBeHidden();
    expect(coach.retriedClaims).toEqual([CLAIM_ID]);
    await still("retried");

    await expect(
      athleteMessage,
      "After Retry, the athlete's own message disappeared from Chat",
    ).toHaveCount(1);
    await expect(
      coachReply(STOPPED_REPLY),
      "After Retry, the stopped reply disappeared from Chat",
    ).toHaveCount(1);
  } finally {
    await app.close();
  }
});
