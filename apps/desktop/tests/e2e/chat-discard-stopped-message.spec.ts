import { expect, test } from "@playwright/test";
import {
  chatRpcDefault,
  openHiddenChatApp,
  rpcReply,
  type ChatRpcRequest,
} from "../helpers/hidden-chat-app.js";

const TOKEN = "chat-discard-stopped-message-e2e-0123456789";
const CHAT_ID = "desktop";
const FIRST_MESSAGE = "Adjust Thursday intervals for heavy legs";
const SECOND_MESSAGE = "Also check my sleep hours this week";
const PARTIAL_REPLY = "Your last three rides pushed fatigue up, so keeping Thursday steady";
const SECOND_REPLY = "Sleep averaged seven hours, which supports a steady Thursday.";
const STOPPED_COPY = "Response stopped. Your partial response is preserved.";
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

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createCoach() {
  let revision = 0;
  let items: QueueItem[] = [];
  let claim: QueueClaim | undefined;
  let turns = 0;
  const stopped = deferred();
  const sentTurns: string[][] = [];
  const discardedClaims: string[] = [];
  const snapshot = () => ({
    schemaVersion: 1 as const,
    revision,
    items: items.map((item, position) => ({ ...item, position })),
    ...(claim?.status === "retry-required"
      ? {
          retryRequired: {
            claimId: claim.claimId,
            queuedMessageIds: claim.queuedMessageIds,
            turnId: claim.turnId,
            status: "retry-required" as const,
          },
        }
      : {}),
  });
  const release = (ids: readonly string[]) => {
    items = items.filter((item) => !ids.includes(item.queuedMessageId));
    claim = undefined;
    revision += 1;
  };

  return {
    sentTurns,
    discardedClaims,
    script: {
      onRequest(value: unknown): readonly string[] {
        const request = value as ChatRpcRequest;
        switch (request.method) {
          case "getChatQueue":
            return rpcReply(snapshot());
          case "enqueueChatMessage": {
            const params = request.params as { submissionId: string; text: string };
            if (!items.some((item) => item.submissionId === params.submissionId)) {
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
            }
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
            release(claim.queuedMessageIds);
            return rpcReply(snapshot());
          }
          case "hasSession":
            return rpcReply({ hasSession: turns > 0 });
          default:
            return chatRpcDefault(request);
        }
      },
      async onStreamRequest(value: unknown, emitFrame: (frame: string) => void): Promise<string> {
        const request = value as ChatRpcRequest;
        if (request.method !== "resumeChatQueue") {
          throw new Error(`Coach did not expect ${request.method}`);
        }
        if (claim !== undefined || items.length === 0)
          return JSON.stringify({ snapshot: snapshot() });
        turns += 1;
        const turnId = `turn-${turns}`;
        const claimed = items.map((item) => item.queuedMessageId);
        revision += 1;
        claim = { claimId: `claim-${turns}`, queuedMessageIds: claimed, turnId, status: "claimed" };
        sentTurns.push(items.map((item) => item.text));
        emitFrame(JSON.stringify({ type: "turn-start", turnId, chatId: CHAT_ID }));
        if (turns === 1) {
          emitFrame(JSON.stringify({ type: "text_delta", turnId, delta: PARTIAL_REPLY }));
          await stopped.promise;
          emitFrame(
            JSON.stringify({ type: "interrupted", turnId, chatId: CHAT_ID, text: PARTIAL_REPLY }),
          );
          claim.status = "retry-required";
          revision += 1;
          return JSON.stringify({ snapshot: snapshot(), response: { text: PARTIAL_REPLY } });
        }
        emitFrame(JSON.stringify({ type: "text_delta", turnId, delta: SECOND_REPLY }));
        emitFrame(JSON.stringify({ type: "final-text", turnId, text: SECOND_REPLY }));
        release(claimed);
        return JSON.stringify({ snapshot: snapshot(), response: { text: SECOND_REPLY } });
      },
    },
  };
}

test("a stopped reply can be discarded so the next message sends and New chat works", async ({
  playwright,
}, testInfo) => {
  const coach = createCoach();
  const app = await openHiddenChatApp({ playwright, testInfo, script: coach.script, token: TOKEN });
  try {
    const { page } = app;
    const composer = page.getByRole("combobox", { name: "Message your coach" });
    const newChat = page.getByRole("button", { name: "New chat" });
    const notice = page.locator(".chat-notice");
    const queue = page.getByRole("region", { name: /^Queued messages/u });
    const still = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`) });

    await composer.fill(FIRST_MESSAGE);
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText(PARTIAL_REPLY)).toBeVisible();

    await composer.fill(SECOND_MESSAGE);
    await composer.press("Enter");
    await expect(queue.getByText(SECOND_MESSAGE)).toBeVisible();

    await page.getByRole("button", { name: "Stop responding" }).click();
    await expect(notice.getByText(STOPPED_COPY)).toBeVisible();
    await expect(notice.getByRole("button", { name: "Retry message" })).toBeVisible();
    await expect(page.getByText(PARTIAL_REPLY)).toBeVisible();
    await still("stopped");

    await expect
      .soft(newChat, "After stopping a reply, the athlete cannot start a New chat")
      .toBeEnabled();
    await expect
      .soft(
        queue.getByText(WAITING_COPY),
        "The waiting message does not say it sends after the stopped one is retried or discarded",
      )
      .toBeVisible();
    const discard = notice.getByRole("button", { name: "Discard", exact: true });
    await expect(
      discard,
      "The athlete has no way to drop the stopped message, so the waiting message never sends",
    ).toBeVisible();

    await discard.click();
    await expect
      .poll(() => coach.discardedClaims, {
        message: "Discard did not tell Coach to drop the stopped message",
      })
      .toEqual(["claim-1"]);
    await expect(
      page.getByText(SECOND_REPLY),
      "After Discard, the waiting message was not sent to Coach",
    ).toBeVisible();
    expect(
      coach.sentTurns,
      "Coach should get the stopped message once, then the waiting one",
    ).toEqual([[FIRST_MESSAGE], [SECOND_MESSAGE]]);
    await expect(notice.getByText(STOPPED_COPY)).toBeHidden();
    await expect(notice.getByRole("button", { name: "Retry message" })).toBeHidden();
    await expect(queue).toHaveCount(0);
    await expect(page.getByText(FIRST_MESSAGE)).toBeVisible();
    await expect(page.getByText(PARTIAL_REPLY)).toBeVisible();
    await expect(newChat, "After Discard, New chat is still unavailable").toBeEnabled();
    await still("discarded");
  } finally {
    await app.close();
  }
});
