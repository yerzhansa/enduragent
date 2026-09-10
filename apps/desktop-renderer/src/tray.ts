import { describeLanguage, normalizeLocaleHint } from "@enduragent/i18n";
import { createPhrasebook, type Phrasebook } from "@enduragent/i18n/messages";
import { presentTrayTelegramStatus, type TrayTelegramStatus } from "./tray-status";

const telegramCopy = document.querySelector<HTMLElement>("#telegram-status-copy");
const telegramTag = document.querySelector<HTMLElement>("#telegram-status-tag");

if (telegramCopy === null || telegramTag === null) throw new TypeError("missing tray status nodes");

let phrasebook: Phrasebook | undefined;
let latestStatus: TrayTelegramStatus | undefined;

function renderTelegramStatus(): void {
  if (
    phrasebook === undefined ||
    latestStatus === undefined ||
    telegramCopy === null ||
    telegramTag === null
  )
    return;
  const presentation = presentTrayTelegramStatus(latestStatus, phrasebook);
  telegramCopy.textContent = presentation.copy;
  telegramTag.textContent = presentation.tag;
  telegramTag.dataset.tone = presentation.tone;
}

function renderTrayCopy(book: Phrasebook): void {
  document
    .querySelector("main")
    ?.setAttribute("aria-label", book.say("desktop.tray.menuBarStatus", { product: "Enduragent" }));
  document
    .querySelector("header span[aria-label]")
    ?.setAttribute("aria-label", book.say("desktop.tray.running", { product: "Enduragent" }));
  const copy: readonly (readonly [string, string])[] = [
    ["section > p:first-child", book.say("desktop.tray.coach")],
    ["#residency-heading", book.say("desktop.tray.ready")],
    ["article:first-child > span:first-child", book.say("desktop.tray.residency")],
    ["article:first-child > strong", book.say("desktop.tray.runningInMenuBar")],
    ["article:first-child > span:last-child", book.say("desktop.tray.tag.active")],
    ["#telegram-status-copy", book.say("desktop.tray.checkingConnection")],
    ["#telegram-status-tag", book.say("desktop.tray.tag.checking")],
    ["section > p:last-child", book.say("desktop.tray.closeHint")],
  ];
  for (const [selector, text] of copy) {
    const node = document.querySelector(selector);
    if (node !== null && node.textContent?.trim() !== text) node.textContent = text;
  }
  document.documentElement.lang = book.tag;
}

const unsubscribe = window.enduragentTray.onTelegramStatus((status) => {
  latestStatus = status;
  renderTelegramStatus();
});

const tag = normalizeLocaleHint(navigator.languages) ?? "en";
void createPhrasebook({ tag, locale: describeLanguage(tag).defaultLocale })
  .catch(() => createPhrasebook({ tag: "en", locale: describeLanguage("en").defaultLocale }))
  .then((book) => {
    phrasebook = book;
    renderTrayCopy(book);
    renderTelegramStatus();
  });

window.addEventListener("pagehide", unsubscribe, { once: true });
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") window.close();
});
