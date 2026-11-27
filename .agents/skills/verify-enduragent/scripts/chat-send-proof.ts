import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { evidenceDir, launchReadyDesktop } from "./verify-driver.js";

const dir = await evidenceDir("chat-send");
const fixture = await launchReadyDesktop();
try {
  await fixture.screenshot(join(dir, "1-ready.png"));
  const result = await fixture.evaluate<{
    readonly composerFound: boolean;
    readonly submitFound: boolean;
    readonly chatStatus: string;
    readonly sent: string;
    readonly reply: string;
    readonly notices: readonly string[];
  }>(`
    const textarea = document.querySelector("textarea#message");
    const submit = document.querySelector('.composer button[type="submit"]');
    const state = () => ({
      composerFound: textarea instanceof HTMLTextAreaElement,
      submitFound: submit instanceof HTMLButtonElement,
      chatStatus: document.querySelector(".conversation")?.dataset.chatStatus ?? "",
      sent: document.querySelector(".chat-message--athlete .chat-message__text")?.textContent ?? "",
      reply: document.querySelector(".chat-message--coach .chat-message__text")?.textContent ?? "",
      notices: [...document.querySelectorAll('[role="alert"]')]
        .filter((node) => node.checkVisibility() && (node.textContent ?? "").trim() !== "")
        .map((node) => node.textContent.trim()),
    });
    if (!(textarea instanceof HTMLTextAreaElement) || !(submit instanceof HTMLButtonElement)) {
      return state();
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(textarea, "How should I ride today?");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    submit.click();
    const deadline = Date.now() + 15000;
    while ((state().reply === "" || state().chatStatus === "streaming") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    return state();
  `);
  await fixture.screenshot(join(dir, "2-replied.png"));
  await writeFile(join(dir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(join(dir, "dom.html"), fixture.readCapturedSurface("dom"));
  const pass =
    result.sent === "How should I ride today?" &&
    result.reply.includes("steady") &&
    result.notices.length === 0;
  console.log(JSON.stringify({ pass, evidence: dir, result }, null, 2));
  if (!pass) process.exitCode = 1;
} finally {
  const closed = await fixture.close();
  if (closed.livePids.length > 0) {
    console.error(`PROBLEM: fixture pids survived close: ${closed.livePids.join(", ")}`);
    process.exitCode = 1;
  }
}
