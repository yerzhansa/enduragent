import { expect, test, type Page } from "@playwright/test";
import type { DesktopFixtureScript } from "../helpers/desktop-fixture.js";
import {
  chatRpcDefault,
  openHiddenChatApp,
  rpcReply,
  type ChatRpcRequest,
} from "../helpers/hidden-chat-app.js";

test.describe.configure({ timeout: 120_000 });

const TOKEN = "chat-commitments-gate".padEnd(43, "0");
const WAITING = "Can I swap Thursday and Friday this week?";
const TYPED = "Check my recent endurance volume";
const REPLY = "Sure, Thursday and Friday can swap.";
const COMMITMENTS = "Any fixed commitments or time off during this Plan?";
const PLAN_LENGTH = "How long should this Plan run?";

const baseCard = {
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
};

const commitmentsQuestion = {
  kind: "commitments-question",
  step: { current: 7, total: 9 },
  prompt: COMMITMENTS,
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
};

const planLengthQuestion = {
  kind: "plan-length-question",
  step: { current: 3, total: 9 },
  prompt: PLAN_LENGTH,
  options: [
    { weeks: 4, label: "4 weeks" },
    { weeks: 8, label: "8 weeks" },
    { weeks: 12, label: "12 weeks" },
    { weeks: 16, label: "16 weeks" },
  ],
};

const cards = {
  commitments: { ...baseCard, openQuestion: commitmentsQuestion },
  "plan-length": { ...baseCard, openQuestion: planLengthQuestion },
  "commitment-correction": {
    ...baseCard,
    openQuestion: commitmentsQuestion,
    pendingCommitment: {
      text: "Keep Sundays free.",
      rules: [],
      status: "clarify",
      unparsed: ["Keep Sundays free."],
    },
  },
} as const;

type CardName = keyof typeof cards;

interface FakeCoach {
  readonly script: DesktopFixtureScript;
  readonly enqueued: string[];
  readonly sentToCoach: string[];
  readonly planCreationCalls: string[];
}

function queueItem(id: string, text: string, submissionId: string) {
  return {
    queuedMessageId: `queued-${id}`,
    messageId: `message-${id}`,
    submissionId,
    text,
    kind: "ordinary",
    attachmentIds: [],
    position: 0,
    restored: false,
  };
}

function fakeCoach(card: CardName, waiting: boolean): FakeCoach {
  const enqueued: string[] = [];
  const sentToCoach: string[] = [];
  const planCreationCalls: string[] = [];
  let items: ReturnType<typeof queueItem>[] = waiting
    ? [queueItem("waiting", WAITING, "submission-waiting")]
    : [];
  let revision = 1;
  const snapshot = () => ({ schemaVersion: 1, revision, items });
  return {
    enqueued,
    sentToCoach,
    planCreationCalls,
    script: {
      onStreamRequest: async (value, emitFrame) => {
        const request = value as ChatRpcRequest;
        if (request.method !== "resumeChatQueue") {
          throw new Error(`Unexpected streamed Coach request: ${request.method}`);
        }
        const head = items[0];
        if (head === undefined) return JSON.stringify({ snapshot: snapshot() });
        sentToCoach.push(head.text);
        const turnId = `turn-${sentToCoach.length}`;
        emitFrame(JSON.stringify({ type: "turn-start", turnId, chatId: "desktop" }));
        emitFrame(JSON.stringify({ type: "final-text", turnId, text: REPLY }));
        items = items.slice(1);
        revision += 1;
        return JSON.stringify({ snapshot: snapshot(), response: { text: REPLY } });
      },
      onRequest: (value) => {
        const request = value as ChatRpcRequest;
        if (/plancreation/iu.test(request.method)) planCreationCalls.push(request.method);
        switch (request.method) {
          case "listPlanningRequests":
            return rpcReply({ deliveries: [], planCreation: cards[card] });
          case "getChatQueue":
            return rpcReply(snapshot());
          case "enqueueChatMessage": {
            const text = String(request.params.text);
            enqueued.push(text);
            items = [...items, queueItem("typed", text, String(request.params.submissionId))];
            revision += 1;
            return rpcReply(snapshot());
          }
          default:
            return chatRpcDefault(request);
        }
      },
    },
  };
}

function chatBox(page: Page) {
  return page.getByRole("combobox", { name: "Message your coach" });
}

async function holdForVideo(page: Page): Promise<void> {
  await page.waitForTimeout(1_000);
}

test("while the commitments question is open, a typed message goes to the coach as chat and the question stays open", async ({
  playwright,
}, testInfo) => {
  const coach = fakeCoach("commitments", false);
  const app = await openHiddenChatApp({ playwright, testInfo, script: coach.script, token: TOKEN });
  const { page } = app;
  try {
    await expect(page.getByText(COMMITMENTS)).toBeVisible();
    await expect(
      chatBox(page),
      "The chat box should be open while the commitments question waits",
    ).toBeEnabled();
    await expect(chatBox(page)).toHaveAttribute("placeholder", "Message your coach");
    await holdForVideo(page);

    await chatBox(page).fill(TYPED);
    await chatBox(page).press("Enter");
    await expect
      .poll(() => coach.sentToCoach, {
        message: "A message sent from the open chat box should reach the coach as chat",
        timeout: 10_000,
      })
      .toEqual([TYPED]);
    await expect(page.getByText(REPLY)).toBeVisible();
    await expect(
      page.getByText(COMMITMENTS),
      "Chatting should leave the commitments question open",
    ).toBeVisible();
    expect(
      coach.planCreationCalls,
      "A chat message must never be read as an answer to the commitments question",
    ).toEqual([]);
    await holdForVideo(page);
  } finally {
    await app.close();
  }
});

test("while the commitments question is open, a message already waiting in the queue goes to the coach", async ({
  playwright,
}, testInfo) => {
  const coach = fakeCoach("commitments", true);
  const app = await openHiddenChatApp({ playwright, testInfo, script: coach.script, token: TOKEN });
  const { page } = app;
  try {
    await expect(page.getByText(COMMITMENTS)).toBeVisible();
    await expect
      .poll(() => coach.sentToCoach, {
        message: "Chat is open, so the waiting message should go to the coach",
        timeout: 10_000,
      })
      .toEqual([WAITING]);
    await expect(page.getByText(REPLY)).toBeVisible();
    await expect(chatBox(page)).toBeEnabled();
    expect(coach.planCreationCalls).toEqual([]);
    await holdForVideo(page);
  } finally {
    await app.close();
  }
});

for (const { card, placeholder, prompt } of [
  { card: "plan-length", placeholder: "Finish the Plan question above", prompt: PLAN_LENGTH },
  {
    card: "commitment-correction",
    placeholder: "Finish the correction above",
    prompt: "I could not use that answer",
  },
] as const) {
  test(`while ${card === "plan-length" ? "another Plan question" : "a commitment correction"} waits, the chat box is locked and nothing reaches the coach`, async ({
    playwright,
  }, testInfo) => {
    const coach = fakeCoach(card, true);
    const app = await openHiddenChatApp({
      playwright,
      testInfo,
      script: coach.script,
      token: TOKEN,
    });
    const { page } = app;
    try {
      await expect(page.getByText(prompt).first()).toBeVisible();
      await expect(
        chatBox(page),
        "The chat box should be locked while this Plan question waits",
      ).toBeDisabled();
      await expect(chatBox(page)).toHaveAttribute("placeholder", placeholder);
      await page.waitForTimeout(3_000);
      expect(
        coach.sentToCoach,
        "The chat box is locked, so the waiting message must not go to the coach either",
      ).toEqual([]);
      expect(coach.enqueued).toEqual([]);
      await holdForVideo(page);
    } finally {
      await app.close();
    }
  });
}
