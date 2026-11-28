import { expect, test, type Page } from "@playwright/test";
import type { DesktopFixtureScript } from "../helpers/desktop-fixture.js";
import {
  chatRpcDefault,
  openHiddenChatApp,
  rpcReply,
  type ChatRpcRequest,
} from "../helpers/hidden-chat-app.js";

test.describe.configure({ timeout: 120_000 });

const TOKEN = "chat-composer-locked-editor".padEnd(43, "0");
const TURN_ID = "turn-locked-editor";
const PROMPT = "Check my recent endurance volume";
const PARTIAL = "Looking over your last 6 weeks of aerobic rides before locking your volume...";
const QUESTION = "Any fixed commitments or time off during this Plan?";

const commitmentsCard = {
  creationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  version: 2,
  status: "in-progress",
  draft: null,
  draftStale: false,
  calendarWindow: { startDate: "1998-08-31", endDate: "1998-11-22" },
  pendingCommitment: null,
  pendingCheck: null,
  readiness: "incomplete",
  answeredSummaries: [],
  openQuestion: {
    kind: "commitments-question",
    step: { current: 7, total: 9 },
    prompt: QUESTION,
    noneOption: {
      label: "No fixed commitments",
      detail: "Use your normal weekly schedule across the Plan.",
    },
    authoredOption: {
      label: "Add commitments or time off",
      detail: "List busy weekdays, travel dates, or days off.",
      editorLabel: "Commitments or time off",
      placeholder: "Example: No riding Wednesdays; travel Sept 14 to Sept 18.",
    },
  },
};

interface FakeCoach {
  readonly script: DesktopFixtureScript;
  readonly stopRequests: Record<string, unknown>[];
  readonly sentMessages: string[];
  release(): void;
}

function fakeCoach(): FakeCoach {
  const stopRequests: Record<string, unknown>[] = [];
  const sentMessages: string[] = [];
  let releaseReply: () => void = () => undefined;
  const replyHeld = new Promise<void>((resolve) => {
    releaseReply = resolve;
  });
  let emitReplyFrame: ((frame: string) => void) | undefined;
  return {
    stopRequests,
    sentMessages,
    release: () => releaseReply(),
    script: {
      onStreamRequest: async (value, emitFrame) => {
        const request = value as ChatRpcRequest;
        if (request.method !== "resumeChatQueue") {
          throw new Error(`Unexpected streamed Coach request: ${request.method}`);
        }
        emitReplyFrame = emitFrame;
        emitFrame(JSON.stringify({ type: "turn-start", turnId: TURN_ID, chatId: "desktop" }));
        emitFrame(JSON.stringify({ type: "text_delta", turnId: TURN_ID, delta: PARTIAL }));
        await replyHeld;
        return JSON.stringify({
          snapshot: { schemaVersion: 1, revision: 2, items: [] },
          response: { text: PARTIAL },
        });
      },
      onRequest: (value) => {
        const request = value as ChatRpcRequest;
        switch (request.method) {
          case "listPlanningRequests":
            return rpcReply({ deliveries: [], planCreation: commitmentsCard });
          case "enqueueChatMessage":
            sentMessages.push(String(request.params.text));
            return rpcReply({
              schemaVersion: 1,
              revision: 1,
              items: [
                {
                  queuedMessageId: "queued-locked-editor",
                  messageId: "message-locked-editor",
                  submissionId: String(request.params.submissionId),
                  text: PROMPT,
                  kind: "ordinary",
                  attachmentIds: [],
                  position: 0,
                  restored: false,
                },
              ],
            });
          case "stopChat":
            stopRequests.push(request.params);
            emitReplyFrame?.(
              JSON.stringify({
                type: "interrupted",
                turnId: TURN_ID,
                chatId: "desktop",
                text: PARTIAL,
              }),
            );
            releaseReply();
            return rpcReply({ stopped: true });
          default:
            return chatRpcDefault(request);
        }
      },
    },
  };
}

async function holdForVideo(page: Page): Promise<void> {
  await page.waitForTimeout(1_000);
}

function chatBox(page: Page) {
  return page.getByRole("combobox", { name: "Message your coach" });
}

async function expectChatBoxAtBottom(page: Page): Promise<void> {
  const editor = page.getByRole("textbox", { name: "Commitments or time off" });
  const editorBox = await editor.boundingBox();
  const chatBoxBox = await chatBox(page).boundingBox();
  const windowHeight = await page.evaluate(() => innerHeight);
  if (editorBox === null || chatBoxBox === null) {
    throw new Error("The commitments editor or the chat box is not on screen");
  }
  expect(
    chatBoxBox.y,
    "The chat box should sit below the commitments editor, at the bottom of the window",
  ).toBeGreaterThan(editorBox.y + editorBox.height);
  expect(
    chatBoxBox.y + chatBoxBox.height,
    "The chat box should stay inside the bottom of the window",
  ).toBeLessThanOrEqual(windowHeight);
  expect(
    chatBoxBox.y,
    "The chat box should stay pinned to the bottom of the window",
  ).toBeGreaterThan(windowHeight * 0.7);
}

test("keeps the chat box and Stop responding while the commitments editor is open during a reply", async ({
  playwright,
}, testInfo) => {
  const coach = fakeCoach();
  const app = await openHiddenChatApp({ playwright, testInfo, script: coach.script, token: TOKEN });
  const { page } = app;
  try {
    await expect(page.getByText(QUESTION)).toBeVisible();
    await chatBox(page).fill(PROMPT);
    await chatBox(page).press("Enter");
    await expect(page.getByText(PARTIAL)).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop responding" })).toBeVisible();

    await page.getByRole("button", { name: /Add commitments or time off/u }).click();
    await expect(page.getByRole("textbox", { name: "Commitments or time off" })).toBeVisible();

    const stop = page.getByRole("button", { name: "Stop responding" });
    await expect
      .soft(
        chatBox(page),
        "The chat box should stay at the bottom, locked, while the editor is open",
      )
      .toBeDisabled({ timeout: 5_000 });
    await expect
      .soft(stop, "Stop responding should stay on screen while the commitments editor is open")
      .toBeVisible({ timeout: 1_000 });
    await expect
      .soft(stop, "Stop responding should stay clickable while the commitments editor is open")
      .toBeEnabled({ timeout: 1_000 });
    if (testInfo.errors.length > 0) return;
    await expect(chatBox(page)).toHaveAttribute("placeholder", "Coach is responding…");
    await expectChatBoxAtBottom(page);
    await holdForVideo(page);

    await stop.click();
    await expect
      .poll(() => coach.stopRequests, {
        message: "Clicking Stop responding should stop the coach's live reply",
        timeout: 5_000,
      })
      .toEqual([{ chatId: "desktop", turnId: TURN_ID }]);
    await expect(page.getByRole("button", { name: "Stop responding" })).toBeHidden();
    await expect(page.getByRole("textbox", { name: "Commitments or time off" })).toBeVisible();
    await expect(chatBox(page)).toBeDisabled();
    await expect(chatBox(page)).toHaveAttribute("placeholder", "Finish the Plan question above");
    await holdForVideo(page);
  } finally {
    coach.release();
    await app.close();
  }
});

test("locks the chat box at the bottom while the commitments editor is open", async ({
  playwright,
}, testInfo) => {
  const coach = fakeCoach();
  const app = await openHiddenChatApp({ playwright, testInfo, script: coach.script, token: TOKEN });
  const { page } = app;
  try {
    await expect(page.getByText(QUESTION)).toBeVisible();
    await chatBox(page).fill("Is Sunday still a long ride?");

    await page.getByRole("button", { name: /Add commitments or time off/u }).click();
    const editor = page.getByRole("textbox", { name: "Commitments or time off" });
    await expect(editor).toBeVisible();

    await expect(
      chatBox(page),
      "The chat box should stay at the bottom, locked, while the editor is open",
    ).toBeDisabled({ timeout: 5_000 });
    await expect(
      chatBox(page),
      "The chat box should say to finish the Plan question above",
    ).toHaveAttribute("placeholder", "Finish the Plan question above");
    await expect(chatBox(page), "The unsent message should stay in the chat box").toHaveValue(
      "Is Sunday still a long ride?",
    );
    await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Attach files" })).toBeDisabled();
    await expectChatBoxAtBottom(page);
    await holdForVideo(page);

    await editor.pressSequentially("/plan");
    await editor.press("Enter");
    await expect(editor).toHaveValue("/plan\n");
    await expect(chatBox(page)).toHaveValue("Is Sunday still a long ride?");
    expect(coach.sentMessages, "Typing in the editor should not send a chat message").toEqual([]);

    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(editor).toBeHidden();
    await expect(chatBox(page)).toBeEnabled();
    await expect(chatBox(page)).toHaveAttribute("placeholder", "Message your coach");
    await expect(chatBox(page)).toHaveValue("Is Sunday still a long ride?");
    await holdForVideo(page);
  } finally {
    coach.release();
    await app.close();
  }
});
