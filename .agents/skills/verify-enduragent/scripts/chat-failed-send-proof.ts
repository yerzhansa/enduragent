import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  evidenceDir,
  launchReadyDesktop,
  baseScript,
  response,
  type ScriptRequest,
} from "./verify-driver.js";

const athleteText = "coach didn't anaswer";
const rateLimitCopy = "Rate limited — please try again shortly.";

const dir = await evidenceDir("chat-failed-send");
let queueRevision = 0;
let queueItems: Array<{
  queuedMessageId: string;
  messageId: string;
  submissionId: string;
  attachmentIds: string[];
  text: string;
  kind: "ordinary" | "slash-command";
  position: number;
  restored: boolean;
}> = [];
let retryRequired:
  | {
      claimId: string;
      queuedMessageIds: string[];
      turnId: string;
      status: "retry-required";
    }
  | undefined;

const queueSnapshot = () => ({
  schemaVersion: 1 as const,
  revision: queueRevision,
  items: queueItems,
  ...(retryRequired === undefined ? {} : { retryRequired }),
});

const fixture = await launchReadyDesktop({
  script: baseScript((request: ScriptRequest) => {
    if (request.method === "getChatQueue") return response(queueSnapshot());
    if (request.method === "enqueueChatMessage") {
      const params = request.params as { readonly submissionId: string; readonly text: string };
      if (!queueItems.some((item) => item.submissionId === params.submissionId)) {
        queueRevision += 1;
        queueItems.push({
          queuedMessageId: `queued-${queueRevision}`,
          messageId: `message-${queueRevision}`,
          submissionId: params.submissionId,
          attachmentIds: [],
          text: params.text,
          kind: "ordinary",
          position: queueItems.length,
          restored: false,
        });
      }
      return response(queueSnapshot());
    }
    if (request.method === "resumeChatQueue") {
      queueRevision += 1;
      retryRequired = {
        claimId: "claim-1",
        queuedMessageIds: queueItems.map((item) => item.queuedMessageId),
        turnId: "turn-fail",
        status: "retry-required",
      };
      return [
        JSON.stringify({ type: "turn-start", turnId: "turn-fail", chatId: "desktop" }),
        JSON.stringify({
          type: "error",
          turnId: "turn-fail",
          chatId: "desktop",
          error_class: "rate_limit",
          kind: "rate_limit",
          athleteMessage: rateLimitCopy,
          overflowAttempts: 0,
          timeoutAttempts: 0,
          rateLimitAttempts: 3,
          duration_ms: 12,
          compactions: 0,
        }),
        JSON.stringify({ snapshot: queueSnapshot() }),
      ];
    }
    return undefined;
  }),
});

try {
  await fixture.screenshot(join(dir, "1-before.png"));
  const result = await fixture.evaluate<{
    readonly sent: string;
    readonly queueTexts: readonly string[];
    readonly retryInterrupted: number;
    readonly retryMessage: number;
    readonly alertText: string;
    readonly chatStatus: string;
  }>(`
    const textarea = document.querySelector("textarea#message");
    const submit = document.querySelector('.composer button[type="submit"]');
    const isRetry = (button) =>
      !button.hidden &&
      (button.textContent?.trim() === "Retry message" ||
        (button.getAttribute("aria-label") ?? "").includes("Retry message"));
    if (!(textarea instanceof HTMLTextAreaElement) || !(submit instanceof HTMLButtonElement)) {
      return {
        sent: "",
        queueTexts: [],
        retryInterrupted: 0,
        retryMessage: 0,
        alertText: "",
        chatStatus: "",
      };
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(textarea, ${JSON.stringify(athleteText)});
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    submit.click();
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const retryReady = [...document.querySelectorAll("button")].some(isRetry);
      const athleteReady = [...document.querySelectorAll(".chat-message--athlete")].some(
        (row) => row.textContent?.includes(${JSON.stringify(athleteText)}),
      );
      if (retryReady && athleteReady) break;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    return {
      sent:
        document.querySelector(".chat-message--athlete .chat-message__text")?.textContent ?? "",
      queueTexts: [...document.querySelectorAll(".chat-queue__text")].map(
        (node) => node.textContent?.trim() ?? "",
      ),
      retryInterrupted: [...document.querySelectorAll("button")].filter(
        (button) => !button.hidden && button.textContent?.trim() === "Retry interrupted message",
      ).length,
      retryMessage: [...document.querySelectorAll("button")].filter(isRetry).length,
      alertText: document.querySelector('[role="alert"]')?.textContent?.trim() ?? "",
      chatStatus: document.querySelector(".conversation")?.dataset.chatStatus ?? "",
    };
  `);
  await fixture.screenshot(join(dir, "2-after.png"));
  await writeFile(join(dir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(join(dir, "dom.html"), fixture.readCapturedSurface("dom"));
  const pass =
    result.sent === athleteText &&
    result.retryMessage === 1 &&
    result.retryInterrupted === 0 &&
    result.queueTexts.includes(athleteText) === false &&
    result.alertText.includes(rateLimitCopy);
  console.log(JSON.stringify({ pass, evidence: dir, result }, null, 2));
  if (!pass) process.exitCode = 1;
} finally {
  const closed = await fixture.close();
  if (closed.livePids.length > 0) {
    console.error(`PROBLEM: fixture pids survived close: ${closed.livePids.join(", ")}`);
    process.exitCode = 1;
  }
}
