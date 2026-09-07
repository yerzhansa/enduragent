import { readdir, readFile } from "node:fs/promises";
import { posix, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(import.meta.dirname, "..", "src");

const TOKENISED_FAMILY = /^(?:text|leading|font|tracking|rounded(?:-[trblse]{1,2})?|shadow)-\[/u;
const HEIGHT_FAMILY = /^(?:h|min-h|size)-\[\d+(?:\.\d+)?px\]!?$/u;
const TOKEN = /[^\s"'`]+/gu;

interface Usage {
  readonly file: string;
  readonly className: string;
}

const BASELINE: readonly Usage[] = [
  { file: "ui/archive/ArchiveView.tsx", className: "font-[var(--f-prose)]" },
  { file: "ui/archive/ArchiveView.tsx", className: "leading-[1.5]" },
  { file: "ui/archive/ArchiveView.tsx", className: "leading-[1.6]" },
  { file: "ui/archive/ArchiveView.tsx", className: "tracking-[0.002em]" },
  { file: "ui/chat/FirstSyncCard.tsx", className: "before:rounded-[inherit]" },
  { file: "ui/chat/FirstSyncCard.tsx", className: "tracking-[0.08em]" },
  { file: "ui/chat/Message.ts", className: "[&_code]:rounded-[4px]" },
  { file: "ui/chat/Message.ts", className: "[&_code]:text-[0.9em]" },
  { file: "ui/chat/Message.ts", className: "[&_h1]:leading-[1.25]" },
  { file: "ui/chat/Message.ts", className: "[&_h1]:text-[1.35em]" },
  { file: "ui/chat/Message.ts", className: "[&_h2]:leading-[1.25]" },
  { file: "ui/chat/Message.ts", className: "[&_h2]:text-[1.25em]" },
  { file: "ui/chat/Message.ts", className: "[&_h3]:leading-[1.25]" },
  { file: "ui/chat/Message.ts", className: "[&_h3]:text-[1.1em]" },
  { file: "ui/chat/Message.ts", className: "[&_h4]:leading-[1.25]" },
  { file: "ui/chat/Message.ts", className: "[&_h4]:text-[1.1em]" },
  { file: "ui/chat/Message.ts", className: "[&_h5]:leading-[1.25]" },
  { file: "ui/chat/Message.ts", className: "[&_h5]:text-[1.1em]" },
  { file: "ui/chat/Message.ts", className: "[&_h6]:leading-[1.25]" },
  { file: "ui/chat/Message.ts", className: "[&_h6]:text-[1.1em]" },
  { file: "ui/chat/Message.ts", className: "[&_table]:text-[0.92em]" },
  { file: "ui/chat/Message.ts", className: "leading-[1.6]" },
  { file: "ui/chat/NewConversationDialog.tsx", className: "leading-[1.5]" },
  { file: "ui/chat/PlanReferenceCard.tsx", className: "tracking-[0.06em]" },
  { file: "ui/chat/SlashPopup.tsx", className: "rounded-[4px]" },
  { file: "ui/chat/SlashPopup.tsx", className: "tracking-[0.07em]" },
  { file: "ui/chat/TrainingContextPanel.tsx", className: "tracking-[0.06em]" },
  { file: "ui/onboarding/AiRow.tsx", className: "size-[15px]" },
  { file: "ui/onboarding/OnboardingWizard.tsx", className: "min-h-[18px]" },
  { file: "ui/onboarding/OnboardingWizard.tsx", className: "tracking-[-0.02em]" },
  { file: "ui/onboarding/SetupCard.tsx", className: "h-[30px]" },
  { file: "ui/onboarding/SetupRow.tsx", className: "size-[18px]" },
  { file: "ui/plan/PlanView.tsx", className: "leading-[1.5]" },
  { file: "ui/plan/PlanView.tsx", className: "min-h-[76px]" },
  { file: "ui/plan/PlanView.tsx", className: "shadow-[inset_0_0_0_1px_var(--line-2)]" },
  { file: "ui/plan/PlanView.tsx", className: "size-[15px]" },
  { file: "ui/settings/PalettePicker.tsx", className: "text-[11.5px]" },
  { file: "ui/settings/TelegramSection.tsx", className: "[&_p]:text-[12.5px]" },
  { file: "ui/settings/TelegramSection.tsx", className: "font-[560]" },
  { file: "ui/settings/TelegramSection.tsx", className: "font-[620]" },
  { file: "ui/settings/TelegramSection.tsx", className: "font-[650]" },
  { file: "ui/settings/TelegramSection.tsx", className: "h-[18px]" },
  { file: "ui/settings/TelegramSection.tsx", className: "h-[30px]" },
  { file: "ui/settings/TelegramSection.tsx", className: "rounded-[4px]" },
  { file: "ui/settings/TelegramSection.tsx", className: "shadow-[inset_3px_0_0_var(--brand)]" },
  { file: "ui/settings/TelegramSection.tsx", className: "shadow-[inset_3px_0_0_var(--danger)]" },
  { file: "ui/settings/TelegramSection.tsx", className: "text-[11.5px]" },
  { file: "ui/settings/TelegramSection.tsx", className: "text-[11px]" },
  { file: "ui/settings/TelegramSection.tsx", className: "text-[12.5px]" },
  { file: "ui/settings/TelegramSection.tsx", className: "text-[13.5px]" },
  { file: "ui/settings/TelegramSection.tsx", className: "text-[13px]" },
  { file: "ui/settings/TelegramSection.tsx", className: "text-[15px]" },
  { file: "ui/settings/TelegramSection.tsx", className: "text-[22px]" },
  { file: "ui/settings/TelegramSection.tsx", className: "tracking-[0.07em]" },
  { file: "ui/settings/TelegramSection.tsx", className: "tracking-[0.14em]" },
  { file: "ui/settings/styles.ts", className: "[&_a]:text-[13px]" },
  { file: "ui/settings/styles.ts", className: "[&_h2]:text-[15px]" },
  { file: "ui/settings/styles.ts", className: "h-[3px]" },
  { file: "ui/settings/styles.ts", className: "text-[11px]" },
  { file: "ui/settings/styles.ts", className: "text-[12.5px]" },
  { file: "ui/settings/styles.ts", className: "text-[13.5px]" },
  { file: "ui/settings/styles.ts", className: "text-[13px]" },
  { file: "ui/settings/styles.ts", className: "tracking-[0.07em]" },
  { file: "ui/sidebar/Sidebar.tsx", className: "size-[18px]" },
  { file: "ui/sidebar/SyncChip.tsx", className: "size-[7px]" },
  { file: "ui/sidebar/SyncChip.tsx", className: "text-[11px]" },
  { file: "ui/settings/TrainingAccountSection.tsx", className: "size-[18px]" },
  { file: "ui/settings/TrainingAccountSection.tsx", className: "text-[10px]" },
  { file: "ui/settings/TrainingAccountSection.tsx", className: "text-[12.5px]" },
  { file: "ui/training/overviewStyles.ts", className: "[&_tbody_th::before]:h-[18px]" },
  { file: "ui/training/overviewStyles.ts", className: "leading-[1.45]" },
  { file: "ui/training/overviewStyles.ts", className: "max-[761px]:min-h-[76px]" },
  { file: "ui/training/overviewStyles.ts", className: "min-h-[78px]" },
  { file: "ui/training/overviewStyles.ts", className: "min-h-[92px]" },
  { file: "ui/training/responseStyles.ts", className: "[&>span:last-child>span]:leading-[1.3]" },
  { file: "ui/training/responseStyles.ts", className: "[&_dd]:leading-[1.4]" },
  { file: "ui/training/responseStyles.ts", className: "[&_figcaption]:leading-[1.5]" },
  { file: "ui/training/responseStyles.ts", className: "[&_summary]:leading-[1.4]" },
  { file: "ui/training/responseStyles.ts", className: "[&_thead_th]:text-[9px]" },
  { file: "ui/training/responseStyles.ts", className: "leading-[1.4]" },
  { file: "ui/training/responseStyles.ts", className: "leading-[1.5]" },
  { file: "ui/training/responseStyles.ts", className: "text-[10px]" },
  { file: "ui/training/rideStyles.ts", className: "[&>p]:leading-[1.45]" },
  { file: "ui/training/rideStyles.ts", className: "[&>span:last-child]:leading-[1.4]" },
  { file: "ui/training/rideStyles.ts", className: "[&_dd]:leading-[1.45]" },
  { file: "ui/training/rideStyles.ts", className: "[&_dd]:leading-[1.4]" },
  { file: "ui/training/rideStyles.ts", className: "[&_p]:leading-[1.3]" },
  { file: "ui/training/rideStyles.ts", className: "[&_p]:leading-[1.5]" },
  { file: "ui/training/rideStyles.ts", className: "[&_strong]:leading-[1.1]" },
  { file: "ui/training/rideStyles.ts", className: "leading-[1.45]" },
  { file: "ui/training/rideStyles.ts", className: "leading-[1.4]" },
  { file: "ui/training/rideStyles.ts", className: "leading-[1.5]" },
  { file: "ui/training/rideStyles.ts", className: "max-[520px]:h-[18px]" },
  { file: "ui/training/rideStyles.ts", className: "size-[25px]" },
];

function utility(token: string): string {
  let depth = 0;
  let start = 0;
  for (let index = 0; index < token.length; index += 1) {
    const char = token[index];
    if (char === "[") depth += 1;
    else if (char === "]") depth -= 1;
    else if (char === ":" && depth === 0) start = index + 1;
  }
  return token.slice(start).replace(/^[!-]+/u, "");
}

export function isArbitraryTokenValue(token: string): boolean {
  const name = utility(token);
  return TOKENISED_FAMILY.test(name) || HEIGHT_FAMILY.test(name);
}

function classNames(source: string): readonly string[] {
  return [...source.matchAll(TOKEN)].map((match) => match[0]).filter(isArbitraryTokenValue);
}

async function sourceFiles(): Promise<readonly string[]> {
  const entries = await readdir(sourceRoot, { recursive: true });
  return entries
    .filter((entry) => /\.tsx?$/u.test(entry) && !/\.test\.tsx?$/u.test(entry))
    .map((entry) => entry.split(sep).join(posix.sep))
    .sort();
}

async function scan(): Promise<readonly Usage[]> {
  const usages: Usage[] = [];
  for (const file of await sourceFiles()) {
    const source = await readFile(resolve(sourceRoot, file), "utf8");
    for (const className of new Set(classNames(source))) usages.push({ file, className });
  }
  return usages;
}

const key = (usage: Usage): string => `${usage.file} ${usage.className}`;

describe("class string guard", () => {
  it("classifies arbitrary values by token family", () => {
    for (const token of [
      "text-[13px]",
      "sm:text-[13px]",
      "leading-[1.5]",
      "font-[560]",
      "font-[var(--f-prose)]",
      "-tracking-[0.02em]",
      "rounded-[4px]",
      "rounded-tl-[4px]",
      "data-[open]:rounded-[6px]",
      "[&_h2]:text-[15px]",
      "shadow-[inset_0_0_0_1px_var(--line-2)]",
      "h-[30px]",
      "h-[30px]!",
      "min-h-[76px]",
      "size-[18px]",
      "[&_svg]:size-[18px]",
    ])
      expect(`${token} ${String(isArbitraryTokenValue(token))}`).toBe(`${token} true`);

    for (const token of [
      "w-[min(520px,calc(100vw-48px))]",
      "max-w-[720px]",
      "max-h-[min(70vh,620px)]",
      "p-[11px]",
      "py-[13px]",
      "gap-[3px]",
      "mt-[26px]",
      "[--chat-composer-clearance:0px]",
      "[&_svg]:size-4",
      "[&::-webkit-progress-bar]:rounded-full",
      "backdrop:bg-[var(--scrim)]",
      "min-h-[calc(var(--ctl-h-lg)+var(--row-inset))]",
      "h-[var(--ctl-h)]",
      "text-xs",
      "shadow-elev-1",
      "rounded-card",
      "leading-none",
      "font-semibold",
    ])
      expect(`${token} ${String(isArbitraryTokenValue(token))}`).toBe(`${token} false`);
  });

  it("flags every arbitrary token-family value outside the baseline", async () => {
    const allowed = new Set(BASELINE.map(key));
    const unlisted = (await scan()).filter((usage) => !allowed.has(key(usage)));
    expect(unlisted).toEqual([]);
  });

  it("drops baseline entries whose usage no longer exists", async () => {
    const present = new Set((await scan()).map(key));
    const stale = BASELINE.filter((usage) => !present.has(key(usage)));
    expect(stale).toEqual([]);
  });

  it("keeps the baseline free of duplicates", () => {
    expect(new Set(BASELINE.map(key)).size).toBe(BASELINE.length);
  });
});
