import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Browser, type Page, type PlaywrightWorkerArgs } from "@playwright/test";
import { launchDesktopFixture, type RunningDesktopFixture } from "./desktop-fixture.js";
import { createMemoryPlanCalendar } from "./plan-calendar-fake.js";
import { PlanCreationBackend } from "./plan-creation-backend.js";

const token = "c".repeat(43);
const seedDay = "1998-01-05";
const shots = process.env.CALENDAR_SHOTS_DIR;

export type Playwright = PlaywrightWorkerArgs["playwright"];

export interface Scenario {
  readonly calendar: ReturnType<typeof createMemoryPlanCalendar>;
  readonly backend: PlanCreationBackend;
  readonly fixture: RunningDesktopFixture;
  readonly scratch: string;
  browser: Browser;
  page: Page;
}

export function isoDay(dateKey: number): string {
  const text = String(dateKey);
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

export function minutesOf(structureJson: string): number {
  const structure: unknown = JSON.parse(structureJson);
  if (structure === null || typeof structure !== "object" || !("minutes" in structure))
    throw new TypeError("Stored Workout has no length");
  return Number(structure.minutes);
}

export function rideKey(index: number): string {
  return String(index).padStart(2, "0").repeat(32);
}

export async function launch(
  playwright: Playwright,
  prepare: (
    backend: PlanCreationBackend,
    calendar: ReturnType<typeof createMemoryPlanCalendar>,
  ) => Promise<string>,
  colorScheme: "light" | "dark" = "light",
  options: { readonly waitForApprove?: boolean; readonly keepsDraftText?: boolean } = {},
): Promise<Scenario> {
  const scratch = await mkdtemp(join(tmpdir(), "calendar-page-"));
  const calendar = createMemoryPlanCalendar();
  const backend = new PlanCreationBackend(join(scratch, "store.db"), false, true, {
    calendar,
    calendarConnected: true,
    waitForApprove: options.waitForApprove ?? false,
    keepsDraftText: options.keepsDraftText ?? false,
  });
  let fixture: RunningDesktopFixture | undefined;
  try {
    backend.setCivilDate(seedDay);
    await backend.open();
    const today = await prepare(backend, calendar);
    fixture = await launchDesktopFixture({
      script: backend.script,
      token,
      width: 1280,
      height: 860,
      colorScheme,
      reducedMotion: true,
      hidden: true,
      routeChatAttachmentComposer: true,
    });
    await fixture.setViewport(1280, 860);
    const browser = await playwright.chromium.connectOverCDP(fixture.remoteDebuggingUrl);
    const page = browser
      .contexts()[0]
      ?.pages()
      .find((candidate) => candidate.url().startsWith("enduragent://app/"));
    if (page === undefined) throw new TypeError("Calendar renderer is unavailable");
    await expect(page.locator("[data-shell]")).toHaveAttribute("data-onboarding", "settled", {
      timeout: 30_000,
    });
    await page.clock.setFixedTime(new Date(`${today}T12:00:00Z`));
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    return { calendar, backend, fixture, scratch, browser, page };
  } catch (error) {
    try {
      await fixture?.close();
    } finally {
      try {
        await backend.close();
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    }
    throw error;
  }
}

export async function close(scenario: Scenario) {
  await scenario.browser.close().catch(() => {});
  try {
    expect(await scenario.fixture.close()).toEqual({ livePids: [], listenerCount: 0 });
  } finally {
    try {
      await scenario.backend.close();
    } finally {
      await rm(scenario.scratch, { recursive: true, force: true });
    }
  }
}

export async function openCalendar(scenario: Scenario) {
  const entry = scenario.page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Calendar", exact: true });
  await expect(entry, "the sidebar has no Calendar page").toBeVisible();
  await entry.click();
  await expect(scenario.page.locator('[data-calendar-state="ready"]')).toBeVisible();
}

export async function snap(scenario: Scenario, name: string) {
  if (shots === undefined) return;
  await mkdir(shots, { recursive: true });
  await scenario.page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
}

export function cell(scenario: Scenario, dateKey: number) {
  return scenario.page.locator(`[role="cell"][data-date-key="${dateKey}"]`);
}
