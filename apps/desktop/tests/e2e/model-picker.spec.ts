import type { Locator, Page, TestInfo } from "@playwright/test";
import { test as readyTest } from "./fixtures/chat-desktop.js";
import { expect, test as firstRunTest } from "./fixtures/first-run-desktop.js";

const OPEN_LIST = '[data-slot="select-content"][data-open]';
const PROVIDERS = ["Anthropic", "OpenRouter"] as const;
const WIDTHS = [1180, 760] as const;
const SETUP_BUTTON_MAX_WIDTH = 236;
const SETTINGS_BUTTON_MAX_WIDTH = 260;

type ButtonPlacement = "centered" | "bottom-edge";

interface ModelListMeasure {
  readonly problems: string[];
  readonly widestRow: number;
}

async function settledOpenList(page: Page): Promise<Locator> {
  const list = page.locator(OPEN_LIST);
  await expect(list.getByRole("option").first()).toBeVisible();
  await list.evaluate(async (element) => {
    await Promise.all(
      element.getAnimations({ subtree: true }).map((animation) => animation.finished),
    );
    let previous = "";
    for (let frame = 0; frame < 60; frame += 1) {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rect = element.getBoundingClientRect();
      const current = `${rect.left} ${rect.top} ${rect.width} ${rect.height} ${element.scrollTop}`;
      if (current === previous) return;
      previous = current;
    }
  });
  return list;
}

async function visibleModelListProblems(
  page: Page,
  trigger: Locator,
  placement: ButtonPlacement,
  maxTriggerWidth: number,
  info: TestInfo,
  capture: string,
): Promise<readonly string[]> {
  const block = placement === "centered" ? ("center" as const) : ("end" as const);
  await trigger.evaluate(
    (element, position) => element.scrollIntoView({ block: position, behavior: "instant" }),
    block,
  );
  const closedWidth = await trigger.evaluate((element) => element.getBoundingClientRect().width);
  await trigger.click();
  const list = await settledOpenList(page);
  if (placement === "centered") {
    await expect(list).toHaveAttribute("data-side", "none");
  }
  const openWidth = await trigger.evaluate((element) => element.getBoundingClientRect().width);
  const measure = await list.evaluate((element): ModelListMeasure => {
    const found: string[] = [];
    const listStyle = getComputedStyle(element);
    const listRect = element.getBoundingClientRect();
    const listChrome =
      listRect.width -
      element.clientWidth +
      Number.parseFloat(listStyle.paddingLeft) +
      Number.parseFloat(listStyle.paddingRight);
    let widestRow = 0;
    const visibleRight = listRect.left + element.clientLeft + element.clientWidth;
    if (listRect.left < 0 || listRect.right > window.innerWidth) {
      found.push(
        `the list runs off the window (${Math.round(listRect.left)}px to ${Math.round(listRect.right)}px of ${window.innerWidth}px)`,
      );
    }
    for (const option of element.querySelectorAll('[role="option"]')) {
      const text = option.firstElementChild;
      if (text === null) continue;
      const label = (text.textContent ?? "").trim();
      const range = document.createRange();
      range.selectNodeContents(text);
      const textRect = range.getBoundingClientRect();
      const optionStyle = getComputedStyle(option);
      const paddingLeft = Number.parseFloat(optionStyle.paddingLeft);
      const paddingRight = Number.parseFloat(optionStyle.paddingRight);
      widestRow = Math.max(widestRow, textRect.width + paddingLeft + paddingRight + listChrome);
      const optionRect = option.getBoundingClientRect();
      const contentRight = optionRect.right - paddingRight;
      if (textRect.right > contentRight + 0.5) {
        found.push(`"${label}" is cut off by ${Math.ceil(textRect.right - contentRight)}px`);
      }
      if (optionRect.right > visibleRight + 0.5) {
        found.push(
          `the row for "${label}" runs ${Math.ceil(optionRect.right - visibleRight)}px past the list`,
        );
      }
      if (option.getAttribute("aria-selected") !== "true") continue;
      const indicator = [...option.children].find((child) => child !== text);
      if (indicator === undefined) {
        found.push(`"${label}" is selected but shows no check mark`);
        continue;
      }
      const indicatorRect = indicator.getBoundingClientRect();
      if (textRect.right > indicatorRect.left + 0.5) {
        found.push(
          `the check mark overlaps "${label}" by ${Math.ceil(textRect.right - indicatorRect.left)}px`,
        );
      }
      if (indicatorRect.right > visibleRight + 0.5) {
        found.push(`the check mark for "${label}" is cut off by the list's edge`);
      }
    }
    return { problems: found, widestRow };
  });
  const problems = [...measure.problems];
  if (Math.abs(openWidth - closedWidth) > 0.5) {
    problems.push(`the picker button changed from ${closedWidth}px to ${openWidth}px when opened`);
  }
  if (closedWidth > maxTriggerWidth + 0.5) {
    problems.push(`the picker button is ${closedWidth}px wide, over its ${maxTriggerWidth}px cap`);
  }
  const path = info.outputPath(`${capture}.png`);
  await page.screenshot({ path });
  await info.attach(capture, { path, contentType: "image/png" });
  await page.keyboard.press("Escape");
  await expect(page.locator(OPEN_LIST)).toHaveCount(0);
  expect(
    measure.widestRow,
    `${capture}: no model name needs more room than its ${closedWidth}px button, so this list cannot show the clipping`,
  ).toBeGreaterThan(closedWidth);
  return problems;
}

async function chooseProvider(page: Page, trigger: Locator, provider: string): Promise<void> {
  await trigger.click();
  const list = await settledOpenList(page);
  await list.getByRole("option", { name: provider, exact: true }).click();
  await expect(page.locator(OPEN_LIST)).toHaveCount(0);
  await expect(trigger.locator('[data-slot="select-value"]')).toHaveText(provider);
}

for (const width of WIDTHS) {
  firstRunTest(
    `Setup model picker shows whole model names at ${width}px`,
    async ({ firstRunDesktop }, info) => {
      const { page } = firstRunDesktop;
      await page.setViewportSize({ width, height: 820 });
      await page.locator('[data-setup-trigger="ai"]').click();
      await page.locator('[data-setup-menu="ai"] [data-lane="api-key"]').click();
      const panel = page.locator('[data-setup-panel="api-key"]');
      const providerTrigger = page.locator("#onboarding-llm-provider");
      const modelTrigger = page.locator("#onboarding-llm-model");
      for (const provider of PROVIDERS) {
        await chooseProvider(page, providerTrigger, provider);
        const advanced = panel.locator("details");
        if (!(await advanced.evaluate((element) => (element as HTMLDetailsElement).open))) {
          await advanced.locator("summary").click();
        }
        await expect(modelTrigger).toBeVisible();
        const problems = await visibleModelListProblems(
          page,
          modelTrigger,
          "centered",
          SETUP_BUTTON_MAX_WIDTH,
          info,
          `setup-${provider.toLowerCase()}-${width}`,
        );
        expect
          .soft(
            problems,
            `Setup ${provider} model list must show whole names clear of the check mark`,
          )
          .toEqual([]);
      }
    },
  );
}

for (const width of WIDTHS) {
  readyTest(
    `Settings model picker shows whole model names at ${width}px`,
    async ({ chatDesktop }, info) => {
      const { page } = chatDesktop;
      await page.setViewportSize({ width, height: 820 });
      await page
        .getByRole("navigation", { name: "Main navigation" })
        .getByRole("button", { name: "Settings", exact: true })
        .click();
      const providerTrigger = page.locator("#coach-provider");
      const modelTrigger = page.locator("#coach-model");
      await providerTrigger.scrollIntoViewIfNeeded();
      for (const provider of PROVIDERS) {
        await chooseProvider(page, providerTrigger, provider);
        for (const placement of ["centered", "bottom-edge"] as const) {
          const problems = await visibleModelListProblems(
            page,
            modelTrigger,
            placement,
            SETTINGS_BUTTON_MAX_WIDTH,
            info,
            `settings-${provider.toLowerCase()}-${placement}-${width}`,
          );
          expect
            .soft(
              problems,
              `Settings ${provider} model list (button ${placement}) must show whole names clear of the check mark`,
            )
            .toEqual([]);
        }
      }
    },
  );
}
