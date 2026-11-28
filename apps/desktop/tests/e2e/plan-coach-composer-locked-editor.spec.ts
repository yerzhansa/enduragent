import { expect, test, type Page } from "@playwright/test";
import type { DesktopFixtureScript } from "../helpers/desktop-fixture.js";
import {
  chatRpcDefault,
  openHiddenChatApp,
  rpcReply,
  type ChatRpcRequest,
} from "../helpers/hidden-chat-app.js";
import {
  emptyPlanLibrary,
  planCoachData,
  planReadModel,
} from "../../../desktop-renderer/tests/plan-fixtures.js";

test.describe.configure({ timeout: 120_000 });

const TOKEN = "plan-coach-composer-locked-editor".padEnd(43, "0");
const CHAT_ID = "plan:00000000000000000000000001";
const TURN_ID = "turn-plan-locked-editor";
const PROMPT = "Build my week around the Sunday group ride";
const PARTIAL = "Your Sunday group ride can carry the week’s long endurance work, so first:";
const QUESTION = "How should the Sunday group ride fit your Plan?";
const INTRO = "Let’s build this here in Plan. What event are you training toward?";

const decision = {
  decisionId: "decision-plan-locked-editor",
  chatId: CHAT_ID,
  messageId: "message-plan-locked-editor",
  question: QUESTION,
  status: "unanswered" as const,
  options: [
    {
      id: "long-ride",
      label: "Make it the long ride",
      description: "Count Sunday’s group ride as the week’s long endurance session.",
      recommended: true,
      consequence: "Sunday becomes the week’s long endurance ride.",
    },
    {
      id: "extra-ride",
      label: "Keep it as an extra",
      description: "Hold the long ride on Saturday and treat Sunday as optional.",
      recommended: false,
      consequence: "Saturday holds the week’s long endurance ride.",
    },
  ],
};

function coachModel(input: { readonly answered: boolean; readonly decisionOpen: boolean }) {
  return planReadModel({
    lifecycle: "intake",
    scenarioId: "PL-S017",
    projection: "coach",
    data: planCoachData({
      messages: [
        { id: "plan-intro", turnId: null, role: "coach", text: INTRO },
        ...(input.answered
          ? [
              { id: "athlete-1", turnId: TURN_ID, role: "athlete" as const, text: PROMPT },
              { id: "coach-1", turnId: TURN_ID, role: "coach" as const, text: PARTIAL },
            ]
          : []),
      ],
      decision: input.decisionOpen ? decision : null,
      course: {
        status: "undecided",
        accepted: null,
        candidate: null,
        fileName: null,
        detail: null,
      },
    }),
  });
}

interface FakePlanCoach {
  readonly script: DesktopFixtureScript;
  readonly stopRequests: Record<string, unknown>[];
  release(): void;
}

function fakePlanCoach(input: { readonly decisionOpen: boolean }): FakePlanCoach {
  const stopRequests: Record<string, unknown>[] = [];
  let current = coachModel({ answered: false, decisionOpen: input.decisionOpen });
  let releaseReply: () => void = () => undefined;
  const replyHeld = new Promise<void>((resolve) => {
    releaseReply = resolve;
  });
  let emitTurnEvent: ((turnEvent: Record<string, unknown>) => void) | undefined;
  return {
    stopRequests,
    release: () => releaseReply(),
    script: {
      onStreamRequest: async (value, emitFrame) => {
        const request = value as ChatRpcRequest;
        if (
          request.method !== "executePlanTransition" ||
          request.params.transitionId !== "PL-T05"
        ) {
          throw new Error(`Unexpected streamed Coach request: ${request.method}`);
        }
        const progress = {
          commandId: String(request.params.commandId),
          transitionId: "PL-T05",
          operationId: "operation-plan-locked-editor",
          completed: 0,
          total: 1,
        };
        emitFrame(JSON.stringify({ event: { ...progress, phase: "queued" } }));
        emitTurnEvent = (turnEvent) =>
          emitFrame(JSON.stringify({ event: { ...progress, phase: "running", turnEvent } }));
        emitTurnEvent({ type: "turn-start", turnId: TURN_ID, chatId: CHAT_ID });
        emitTurnEvent({ type: "text_delta", turnId: TURN_ID, delta: PARTIAL });
        emitTurnEvent({ type: "decision-requested", turnId: TURN_ID, chatId: CHAT_ID, decision });
        await replyHeld;
        current = coachModel({ answered: true, decisionOpen: true });
        emitFrame(JSON.stringify({ event: { ...progress, phase: "completed", completed: 1 } }));
        return JSON.stringify({ status: "completed", state: current });
      },
      onRequest: (value) => {
        const request = value as ChatRpcRequest;
        switch (request.method) {
          case "getPlanState":
            return rpcReply({ status: "ready", state: current });
          case "plan.list":
            return rpcReply(emptyPlanLibrary());
          case "stopChat":
            stopRequests.push(request.params);
            emitTurnEvent?.({
              type: "interrupted",
              turnId: TURN_ID,
              chatId: CHAT_ID,
              text: PARTIAL,
            });
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

async function openPlan(page: Page): Promise<void> {
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Plan", exact: true })
    .click();
  await expect(page.getByText(INTRO)).toBeVisible();
}

function chatBox(page: Page) {
  return page.getByRole("combobox", { name: "Reply to your Plan coach" });
}

function ownAnswer(page: Page) {
  return page.getByRole("textbox", { name: "What would work better?" });
}

async function openOwnAnswer(page: Page): Promise<void> {
  await expect(page.getByText(QUESTION)).toBeVisible();
  await page.getByRole("button", { name: /Something else/u }).click();
  await expect(ownAnswer(page)).toBeVisible();
}

async function expectChatBoxAtBottom(page: Page): Promise<void> {
  const editorBox = await ownAnswer(page).boundingBox();
  const chatBoxBox = await chatBox(page).boundingBox();
  const windowHeight = await page.evaluate(() => innerHeight);
  if (editorBox === null || chatBoxBox === null) {
    throw new Error("The answer editor or the Plan chat box is not on screen");
  }
  expect(
    chatBoxBox.y,
    "The Plan chat box should sit below the answer editor, at the bottom of the window",
  ).toBeGreaterThan(editorBox.y + editorBox.height);
  expect(
    chatBoxBox.y + chatBoxBox.height,
    "The Plan chat box should stay inside the bottom of the window",
  ).toBeLessThanOrEqual(windowHeight);
  expect(
    chatBoxBox.y,
    "The Plan chat box should stay pinned to the bottom of the window",
  ).toBeGreaterThan(windowHeight * 0.7);
}

test("keeps the Plan chat box and Stop responding while a coaching choice's own answer is open during a reply", async ({
  playwright,
}, testInfo) => {
  const coach = fakePlanCoach({ decisionOpen: false });
  const app = await openHiddenChatApp({ playwright, testInfo, script: coach.script, token: TOKEN });
  const { page } = app;
  try {
    await openPlan(page);
    await chatBox(page).fill(PROMPT);
    await chatBox(page).press("Enter");
    await expect(page.getByText(PARTIAL)).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop responding" })).toBeVisible();

    await openOwnAnswer(page);

    const stop = page.getByRole("button", { name: "Stop responding" });
    await expect
      .soft(
        chatBox(page),
        "The Plan chat box should stay at the bottom while the answer editor is open",
      )
      .toBeVisible({ timeout: 5_000 });
    await expect
      .soft(stop, "Stop responding should stay on screen while the answer editor is open")
      .toBeVisible({ timeout: 1_000 });
    await expect
      .soft(stop, "Stop responding should stay clickable while the answer editor is open")
      .toBeEnabled({ timeout: 1_000 });
    if (testInfo.errors.length > 0) return;
    await expect(chatBox(page)).toBeDisabled();
    await expect(chatBox(page)).toHaveAttribute("placeholder", "Coach is responding…");
    await expect(page.getByRole("button", { name: "Attach Race Course" })).toBeDisabled();
    await expectChatBoxAtBottom(page);
    await holdForVideo(page);

    await stop.click();
    await expect
      .poll(() => coach.stopRequests, {
        message: "Clicking Stop responding should stop the Plan coach's live reply",
        timeout: 5_000,
      })
      .toEqual([{ chatId: CHAT_ID, turnId: TURN_ID }]);
    await expect(page.getByRole("button", { name: "Stop responding" })).toBeHidden();
    await expect(ownAnswer(page)).toBeVisible();
    await expect(chatBox(page)).toBeDisabled();
    await expect(chatBox(page)).toHaveAttribute("placeholder", "Finish your answer above");
    await expect(page.getByRole("button", { name: "Attach Race Course" })).toBeDisabled();
    await expectChatBoxAtBottom(page);
    await holdForVideo(page);
  } finally {
    coach.release();
    await app.close();
  }
});

test("locks the Plan chat box at the bottom while a coaching choice's own answer is open", async ({
  playwright,
}, testInfo) => {
  const coach = fakePlanCoach({ decisionOpen: true });
  const app = await openHiddenChatApp({ playwright, testInfo, script: coach.script, token: TOKEN });
  const { page } = app;
  try {
    await openPlan(page);
    await expect(chatBox(page)).toHaveAttribute("placeholder", "Reply to your coach…");
    await openOwnAnswer(page);

    await expect(
      chatBox(page),
      "The Plan chat box should stay at the bottom while the answer editor is open",
    ).toBeVisible({ timeout: 5_000 });
    await expect(chatBox(page)).toBeDisabled();
    await expect(
      chatBox(page),
      "The Plan chat box should say to finish the answer above",
    ).toHaveAttribute("placeholder", "Finish your answer above");
    await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Attach Race Course" }),
      "Attach Race Course should wait until the answer is finished",
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Continue without course" }),
      "Continue without course should wait until the answer is finished",
    ).toBeDisabled();
    await expectChatBoxAtBottom(page);
    await holdForVideo(page);

    await ownAnswer(page).pressSequentially("Ride Sunday easy and keep Saturday long");
    await expect(ownAnswer(page)).toHaveValue("Ride Sunday easy and keep Saturday long");
    await expect(chatBox(page)).toHaveValue("");
    await holdForVideo(page);

    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(ownAnswer(page)).toBeHidden();
    await expect(chatBox(page)).toBeVisible();
    await expect(chatBox(page)).toHaveAttribute("placeholder", "Reply to your coach…");
    await expect(page.getByRole("button", { name: "Attach Race Course" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Continue without course" })).toBeEnabled();
    await holdForVideo(page);
  } finally {
    coach.release();
    await app.close();
  }
});
