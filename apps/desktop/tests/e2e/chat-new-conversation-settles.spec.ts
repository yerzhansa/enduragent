import { expect, test, type Page } from "@playwright/test";
import {
  chatRpcDefault,
  openHiddenChatApp,
  rpcReply,
  type ChatRpcRequest,
} from "../helpers/hidden-chat-app.js";

const TOKEN = "newConversationSettlesAfterAnUncertainReset";

const OLD_QUESTION = "How does my endurance week look?";
const OLD_ANSWER = "Load is steady at 286 across 5 rides. Keep Saturday easy.";
const NOT_STARTED = /^The new conversation didn.t start\. Your conversation is unchanged\.$/u;
const STARTED_WITH_MEMORY_WARNING =
  /^New conversation started\. Some recent details may not have been saved to coach memory\.$/u;
const COULD_NOT_CONFIRM = /couldn.t confirm whether the new conversation started/u;

type ResetBehavior = "throws-before-changing" | "clears-then-throws" | "clears-then-check-fails";

interface FakeEngine {
  readonly resetCalls: () => number;
  readonly onRequest: (value: unknown) => readonly string[];
}

function fakeEngine(behavior: ResetBehavior): FakeEngine {
  let turns = [
    {
      turnId: "turn-old-1",
      completedAt: "1998-08-25T08:00:00.000Z",
      athleteText: OLD_QUESTION,
      coachText: OLD_ANSWER,
    },
  ];
  let sessionPresent = true;
  let failNextSessionCheck = false;
  let resetCalls = 0;
  return {
    resetCalls: () => resetCalls,
    onRequest(value) {
      const request = value as ChatRpcRequest;
      switch (request.method) {
        case "getTranscriptPage":
          return rpcReply({ schemaVersion: 1, status: "page", turns, nextCursor: null });
        case "hasSession":
          if (failNextSessionCheck) {
            failNextSessionCheck = false;
            throw new Error("Simulated blocked conversation read");
          }
          return rpcReply({ hasSession: sessionPresent });
        case "clearChatAttachmentDraft":
          return chatRpcDefault({ method: "getChatAttachmentComposer", params: {} });
        case "resetSession":
          resetCalls += 1;
          if (behavior !== "throws-before-changing") {
            turns = [];
            sessionPresent = false;
          }
          if (behavior === "clears-then-check-fails") failNextSessionCheck = true;
          throw new Error("Simulated reset transport failure");
        default:
          return chatRpcDefault(request);
      }
    },
  };
}

async function startNewConversation(page: Page): Promise<void> {
  await expect(page.getByText(OLD_QUESTION)).toBeVisible();
  await page.getByRole("button", { name: "New chat" }).click();
  await page.getByRole("button", { name: "Start new conversation" }).click();
}

const newConversationStatus = (page: Page) => page.locator(".new-conversation-status");

async function showFinalState(page: Page): Promise<void> {
  await expect(page.getByRole("dialog"), "The New conversation dialog must close").toHaveCount(0);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

test("a New conversation that never started says so and unlocks New chat", async ({
  playwright,
}, testInfo) => {
  const engine = fakeEngine("throws-before-changing");
  const app = await openHiddenChatApp({
    playwright,
    testInfo,
    script: { onRequest: engine.onRequest },
    token: TOKEN,
  });
  try {
    const { page } = app;
    await startNewConversation(page);

    await expect(
      newConversationStatus(page),
      "After a New conversation that never started, Chat must say it didn't start instead of staying on “couldn't confirm”",
    ).toHaveText(NOT_STARTED, { timeout: 5_000 });
    const newChat = page.getByRole("button", { name: "New chat" });
    await expect(newChat, "New chat must work again after the failed attempt").toBeEnabled();
    await expect(newChat).not.toHaveAttribute("aria-disabled", "true");
    await expect(page.getByText(OLD_QUESTION), "The old conversation must stay").toBeVisible();
    await expect(page.getByText(OLD_ANSWER)).toBeVisible();
    await expect(page.getByRole("button", { name: "Check again" })).toHaveCount(0);

    await newChat.click();
    await expect(
      page.getByRole("button", { name: "Start new conversation" }),
      "Clicking New chat must open the New conversation dialog again",
    ).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await showFinalState(page);
    expect(engine.resetCalls(), "The reset must never be sent twice").toBe(1);
  } finally {
    await app.close();
  }
});

test("a New conversation that started before the error clears the thread", async ({
  playwright,
}, testInfo) => {
  const engine = fakeEngine("clears-then-throws");
  const app = await openHiddenChatApp({
    playwright,
    testInfo,
    script: { onRequest: engine.onRequest },
    token: TOKEN,
  });
  try {
    const { page } = app;
    await startNewConversation(page);

    await expect(
      newConversationStatus(page),
      "After a New conversation that did start, Chat must say it started instead of staying on “couldn't confirm”",
    ).toHaveText(STARTED_WITH_MEMORY_WARNING, { timeout: 5_000 });
    await expect(page.getByText(OLD_QUESTION), "The old thread must be cleared").toHaveCount(0);
    await expect(page.getByText(OLD_ANSWER)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Check again" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "New chat" })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await showFinalState(page);
    expect(engine.resetCalls(), "The reset must never be sent twice").toBe(1);
  } finally {
    await app.close();
  }
});

test("Check again settles a New conversation the first check couldn't read", async ({
  playwright,
}, testInfo) => {
  const engine = fakeEngine("clears-then-check-fails");
  const app = await openHiddenChatApp({
    playwright,
    testInfo,
    script: { onRequest: engine.onRequest },
    token: TOKEN,
  });
  try {
    const { page } = app;
    await startNewConversation(page);

    const checkAgain = page.getByRole("button", { name: "Check again" });
    await expect(
      checkAgain,
      "When Chat can't tell whether the New conversation started, it must offer Check again",
    ).toBeVisible({ timeout: 5_000 });
    await expect(newConversationStatus(page)).toHaveText(COULD_NOT_CONFIRM);
    await expect(
      page.getByText(OLD_QUESTION),
      "The old thread stays until Chat knows",
    ).toBeVisible();

    await checkAgain.click();
    await expect(
      newConversationStatus(page),
      "Check again must settle to the New conversation that started",
    ).toHaveText(STARTED_WITH_MEMORY_WARNING);
    await expect(page.getByText(OLD_QUESTION), "The old thread must be cleared").toHaveCount(0);
    await expect(checkAgain).toHaveCount(0);
    await showFinalState(page);
    expect(engine.resetCalls(), "The reset must never be sent twice").toBe(1);
  } finally {
    await app.close();
  }
});
