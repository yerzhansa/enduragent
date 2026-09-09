import { expect, test, type TestInfo } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { preferencesContract } from "../../../../tools/ui-verification/contracts.js";
import {
  checkStructure,
  compareStructure,
  probeExpression,
  type StructuralSnapshot,
} from "../../../../tools/ui-verification/structure.js";
import {
  launchApplicationUiHarness,
  privateFixtureValues,
  type ApplicationUiHarness,
} from "./application-ui-states/fixture.js";
import { collectApplicationBuildIdentity } from "./application-ui-states/identity.js";

let harness: ApplicationUiHarness;

interface ScreenshotClip {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function viewport(info: TestInfo): { readonly width: number; readonly height: number } {
  const value = info.project.use.viewport;
  if (value === null || value === undefined || "width" in value === false) {
    throw new Error("Application UI project requires a fixed viewport");
  }
  return value;
}

async function screenshot(name: string, info: TestInfo, clip?: ScreenshotClip): Promise<Buffer> {
  const ready = await harness.fixture.evaluate<{
    readonly fonts: string;
    readonly bridge: string;
  }>(`
    await document.fonts.ready;
    return { fonts: document.fonts.status, bridge: typeof window.enduragentAuth };
  `);
  expect(ready).toEqual({ fonts: "loaded", bridge: "object" });
  const path = info.outputPath(`${name}.png`);
  await harness.fixture.screenshot(path, clip);
  const buffer = await readFile(path);
  const dimensions = clip ?? viewport(info);
  expect(buffer.readUInt32BE(16), `${name} image width`).toBe(dimensions.width);
  expect(buffer.readUInt32BE(20), `${name} image height`).toBe(dimensions.height);
  const dom = harness.fixture.readCapturedSurface("dom");
  for (const value of [
    ...privateFixtureValues,
    harness.fixture.paths.athleteHome,
    harness.fixture.paths.userData,
  ]) {
    expect(dom.includes(value), `${name} DOM contains private fixture data`).toBe(false);
  }
  return buffer;
}

async function preferencesClip(): Promise<ScreenshotClip> {
  return harness.fixture.evaluate<ScreenshotClip>(`
    const preferences = document.querySelector('[aria-label="Preferences"]');
    if (!(preferences instanceof HTMLElement)) {
      throw new Error("Preferences screenshot target is unavailable");
    }
    const bounds = preferences.getBoundingClientRect();
    const x = Math.floor(bounds.left) + 2;
    const y = Math.floor(bounds.top) + 2;
    return {
      x,
      y,
      width: Math.ceil(bounds.right) - 2 - x,
      height: Math.ceil(bounds.bottom) - 2 - y,
    };
  `);
}

async function capture(name: string, info: TestInfo): Promise<void> {
  const buffer = await screenshot(name, info);
  await info.attach(name, { body: buffer, contentType: "image/png" });
  expect(buffer).toMatchSnapshot(`${name}.png`);
}

async function waitFor<T>(expression: string, description: string): Promise<T> {
  return harness.fixture.evaluate<T>(`
    const deadline = performance.now() + 15_000;
    while (performance.now() < deadline) {
      const value = (${expression});
      if (value !== undefined && value !== null && value !== false) return value;
      await new Promise(requestAnimationFrame);
    }
    throw new Error(${JSON.stringify(`Timed out waiting for ${description}`)});
  `);
}

async function navigate(label: "Settings" | "Training"): Promise<void> {
  await waitFor<boolean>(
    `(() => {
      const nav = document.querySelector('nav[aria-label="Main navigation"]');
      const button = Array.from(nav?.querySelectorAll("button") ?? []).find(
        (candidate) => (candidate.textContent ?? "").replace(/\\s+/gu, " ").trim() === ${JSON.stringify(label)},
      );
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
      button.click();
      return true;
    })()`,
    `the ${label} navigation action`,
  );
}

async function structure(): Promise<StructuralSnapshot> {
  return harness.fixture.evaluate<StructuralSnapshot>(
    `return ${probeExpression(preferencesContract.anchors)}`,
  );
}

async function scrollToPreferences(): Promise<void> {
  await harness.fixture.evaluate(`
    const page = document.querySelector("[data-page-scroll]");
    const heading = Array.from(document.querySelectorAll("h2")).find(
      (candidate) => (candidate.textContent ?? "").trim() === "Preferences",
    );
    if (!(page instanceof HTMLElement) || !(heading instanceof HTMLElement)) {
      throw new Error("Preferences scroll target is unavailable");
    }
    heading.scrollIntoView({ block: "start" });
    page.scrollBy({ top: -28, behavior: "instant" });
    await new Promise(requestAnimationFrame);
  `);
}

test.describe.serial("production application UI states", () => {
  test.beforeAll(async ({ browserName: _browserName }, info) => {
    const dimensions = viewport(info);
    harness = await launchApplicationUiHarness({
      width: dimensions.width,
      height: dimensions.height,
      colorScheme: info.project.name.endsWith("dark") ? "dark" : "light",
    });
  });

  test.afterAll(async () => {
    await harness?.close();
  });

  test("desktop--chat-syncing", async ({ browserName: _browserName }, info) => {
    expect(
      await harness.fixture.evaluate(`
        const heading = document.querySelector('h1');
        const sync = document.querySelector('.first-sync[data-state="syncing"]');
        return {
          heading: heading?.textContent?.trim(),
          sync: sync?.textContent?.replace(/\\s+/gu, " ").trim(),
        };
      `),
    ).toMatchObject({
      heading: "Chat",
      sync: expect.stringContaining("Syncing your training history…"),
    });
    expect(harness.backend.calls.map((call) => call.method)).toEqual(
      expect.arrayContaining(["verify_intervals_credential", "configureRuntime", "sync"]),
    );
    const runtime = await harness.fixture.evaluateMain<{
      readonly architecture: string;
      readonly chrome: string;
      readonly electron: string;
      readonly node: string;
      readonly platform: string;
    }>(`
      return {
        architecture: process.arch,
        chrome: process.versions.chrome,
        electron: process.versions.electron,
        node: process.versions.node,
        platform: process.platform,
      };
    `);
    expect(runtime).toMatchObject({ architecture: "arm64", platform: "darwin" });
    expect(runtime.chrome).toMatch(/^\d+\.\d+\.\d+\.\d+$/u);
    expect(runtime.electron).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(runtime.node).toMatch(/^\d+\.\d+\.\d+$/u);
    const artifactIdentity = await collectApplicationBuildIdentity();
    expect(artifactIdentity.electron.runtime).toEqual({
      chrome: runtime.chrome,
      electron: runtime.electron,
      node: runtime.node,
    });
    await info.attach("runtime-identity", {
      body: JSON.stringify({
        ...runtime,
        project: info.project.name,
        viewport: viewport(info),
        deviceScaleFactor: 1,
        locale: "en-US",
        timezone: "UTC",
      }),
      contentType: "application/json",
    });
    await info.attach("application-artifact-identity", {
      body: JSON.stringify(artifactIdentity),
      contentType: "application/json",
    });
    await capture("desktop--chat-syncing", info);
  });

  test("desktop--chat-sync-failed", async ({ browserName: _browserName }, info) => {
    harness.backend.failSyncProtocol();
    const state = await waitFor<{
      readonly text: string;
      readonly retry: boolean;
    }>(
      `(() => {
        const card = document.querySelector('.first-sync[data-state="failed"]');
        if (card === null) return false;
        return {
          text: (card.textContent ?? "").replace(/\\s+/gu, " ").trim(),
          retry: Array.from(card.querySelectorAll("button")).some(
            (button) => (button.textContent ?? "").trim() === "Retry sync",
          ),
        };
      })()`,
      "the failed first sync state",
    );
    expect(state.text).toContain("Enduragent needs to reconnect safely");
    expect(state.text).toContain("Quit and reopen Enduragent.");
    expect(state.retry).toBe(false);
    await capture("desktop--chat-sync-failed", info);
  });

  test("desktop--chat-empty", async ({ browserName: _browserName }, info) => {
    harness.backend.prepareRelaunch();
    await harness.fixture.relaunch();
    const state = await waitFor<{
      readonly composer: boolean;
      readonly firstSync: boolean;
      readonly heading: string;
      readonly transcript: string;
    }>(
      `(() => {
        const shell = document.querySelector('[data-shell="app"][data-view="chat"]');
        const heading = document.querySelector("h1")?.textContent?.trim();
        const composer = document.querySelector("form") !== null;
        if (shell === null || heading !== "Chat" || !composer) return false;
        return {
          composer,
          firstSync: document.querySelector(".first-sync") !== null,
          heading,
          transcript: document.querySelector('[aria-label="Conversation"]')?.textContent?.replace(/\\s+/gu, " ").trim() ?? "",
        };
      })()`,
      "the empty chat after relaunch",
    );
    expect(state).toEqual({ composer: true, firstSync: false, heading: "Chat", transcript: "" });
    await capture("desktop--chat-empty", info);
  });

  test("desktop--settings-preferences", async ({ browserName: _browserName }, info) => {
    await navigate("Settings");
    const headings = await waitFor<readonly string[]>(
      `(() => {
        const page = document.querySelector('section[aria-label="Settings"]:not([aria-busy="true"])');
        if (page === null) return false;
        const values = Array.from(page.querySelectorAll("h2")).map(
          (heading) => (heading.textContent ?? "").replace(/\\s+/gu, " ").trim(),
        );
        return values.length === 10 ? values : false;
      })()`,
      "the complete Settings page",
    );
    expect(headings).toEqual([
      "Setup",
      "Channels",
      "Coach",
      "Training account",
      "Conversation & time",
      "Spending",
      "Preferences",
      "Palette",
      "Application",
      "Danger",
    ]);

    const expectedTheme = info.project.name.endsWith("dark") ? "dark" : "light";
    const themeLabel = expectedTheme === "dark" ? "Dark" : "Light";
    await waitFor<boolean>(
      `(() => {
        const group = document.querySelector('[role="group"][aria-label="Appearance"]');
        const button = Array.from(group?.querySelectorAll("button") ?? []).find(
          (candidate) => (candidate.textContent ?? "").trim() === ${JSON.stringify(themeLabel)},
        );
        if (!(button instanceof HTMLButtonElement)) return false;
        button.click();
        return true;
      })()`,
      `the ${themeLabel} appearance action`,
    );
    const appearance = await waitFor<{
      readonly pressed: string | null;
      readonly stored: string | null;
      readonly theme: string | null;
    }>(
      `(() => {
        const group = document.querySelector('[role="group"][aria-label="Appearance"]');
        const button = Array.from(group?.querySelectorAll("button") ?? []).find(
          (candidate) => (candidate.textContent ?? "").trim() === ${JSON.stringify(themeLabel)},
        );
        if (button?.getAttribute("aria-pressed") !== "true") return false;
        return {
          pressed: button.getAttribute("aria-pressed"),
          stored: localStorage.getItem("enduragent.ui.appearance"),
          theme: document.documentElement.getAttribute("data-theme"),
        };
      })()`,
      "the persisted appearance",
    );
    expect(appearance).toEqual({ pressed: "true", stored: expectedTheme, theme: expectedTheme });
    expect(
      await waitFor<string>(
        `document.documentElement.getAttribute("data-theme") === ${JSON.stringify(expectedTheme)} ? ${JSON.stringify(expectedTheme)} : false`,
        "the native appearance update",
      ),
    ).toBe(expectedTheme);
    expect(
      await harness.fixture.evaluateMain<string>(`
        const { createRequire } = process.getBuiltinModule("module");
        const require = createRequire(process.cwd() + "/package.json");
        const { nativeTheme } = require("electron");
        return nativeTheme.themeSource;
      `),
    ).toBe(expectedTheme);

    const original = await structure();
    expect(original.preferences).toHaveLength(1);
    expect(original.rows).toHaveLength(2);
    expect(original.labels).toHaveLength(2);
    expect(checkStructure(original, preferencesContract)).toEqual([]);
    await info.attach("preferences-structure", {
      body: JSON.stringify(original),
      contentType: "application/json",
    });
    await scrollToPreferences();
    await capture("desktop--settings-preferences", info);
  });

  test("second-row regression fails structure and image comparison, then recovers", async ({
    browserName: _browserName,
  }, info) => {
    const originalStructure = await structure();
    expect(checkStructure(originalStructure, preferencesContract)).toEqual([]);
    const clip = await preferencesClip();
    await screenshot("settings-correct-control", info, clip);
    const mutation = await harness.fixture.evaluate<{
      readonly after: number;
      readonly before: number;
      readonly computedPaddingStart: string;
      readonly expectedPaddingStart: number;
      readonly priority: string;
      readonly serialized: string;
    }>(`
      const row = document.querySelectorAll('[aria-label="Preferences"] > .settings-row')[1];
      if (!(row instanceof HTMLElement)) throw new Error("Second Preferences row is unavailable");
      const label = row.querySelector(".settings-label");
      if (!(label instanceof HTMLElement)) throw new Error("Second Preferences label is unavailable");
      const before = label.getBoundingClientRect().left;
      const beforeComputed = getComputedStyle(row);
      const padding = parseFloat(beforeComputed.paddingInlineStart) + 40;
      row.style.setProperty(
        "padding-inline",
        String(padding) + "px " + beforeComputed.paddingInlineEnd,
        "important",
      );
      const deadline = performance.now() + 2_000;
      while (performance.now() < deadline) {
        const after = label.getBoundingClientRect().left;
        if (Math.abs(after - before - 40) < 0.1) {
          return {
            after,
            before,
            computedPaddingStart: getComputedStyle(row).paddingInlineStart,
            expectedPaddingStart: padding,
            priority: row.style.getPropertyPriority("padding-inline"),
            serialized: row.style.getPropertyValue("padding-inline"),
          };
        }
        await new Promise(requestAnimationFrame);
      }
      throw new Error("The intentional Preferences mutation did not affect layout");
    `);
    await info.attach("intentional-mutation", {
      body: JSON.stringify(mutation),
      contentType: "application/json",
    });
    expect(mutation.after - mutation.before).toBeCloseTo(40, 1);
    expect(mutation.priority).toBe("important");
    expect(mutation.serialized).not.toBe("");
    expect(parseFloat(mutation.computedPaddingStart)).toBeCloseTo(mutation.expectedPaddingStart, 1);
    const defectiveStructure = await structure();
    const failures = checkStructure(defectiveStructure, preferencesContract);
    expect(
      failures.some(
        (failure) => failure.anchor === "labels[1]" && failure.property === "left-alignment",
      ),
    ).toBe(true);
    expect(
      compareStructure(originalStructure, defectiveStructure, preferencesContract.anchors).length,
    ).toBeGreaterThan(0);
    const defectiveImage = await screenshot("settings-intentional-defect", info, clip);
    expect(await screenshot("settings-defective-viewport", info)).not.toMatchSnapshot(
      "desktop--settings-preferences.png",
    );
    await info.attach("intentional-defect", {
      body: JSON.stringify(failures),
      contentType: "application/json",
    });
    await info.attach("intentional-defect-image", {
      body: defectiveImage,
      contentType: "image/png",
    });

    await harness.fixture.evaluate(`
      const row = document.querySelectorAll('[aria-label="Preferences"] > .settings-row')[1];
      if (!(row instanceof HTMLElement)) throw new Error("Second Preferences row is unavailable");
      row.style.removeProperty("padding-inline");
      await new Promise(requestAnimationFrame);
    `);
    await navigate("Training");
    await waitFor<boolean>(
      `document.querySelector('section[aria-label="Training"]') !== null`,
      "Training during regression recovery",
    );
    await navigate("Settings");
    await waitFor<boolean>(
      `document.querySelector('section[aria-label="Settings"]:not([aria-busy="true"])') !== null`,
      "Settings during regression recovery",
    );
    await scrollToPreferences();
    const recoveredStructure = await structure();
    expect(checkStructure(recoveredStructure, preferencesContract)).toEqual([]);
    await screenshot("settings-recovered-control", info, clip);
    await capture("desktop--settings-preferences", info);
    await info.attach("recovered-structure", {
      body: JSON.stringify(recoveredStructure),
      contentType: "application/json",
    });
  });

  test("desktop--training-loading", async ({ browserName: _browserName }, info) => {
    await navigate("Training");
    const state = await waitFor<{
      readonly busy: string | null;
      readonly heading: string;
      readonly notices: readonly string[];
      readonly text: string;
    }>(
      `(() => {
        const page = document.querySelector('section[aria-label="Training"][aria-busy="true"]');
        if (page === null) return false;
        return {
          busy: page.getAttribute("aria-busy"),
          heading: page.querySelector("h1")?.textContent?.trim() ?? "",
          notices: Array.from(page.querySelectorAll('[data-panel="data-notice"]')).map(
            (notice) => (notice.textContent ?? "").replace(/\\s+/gu, " ").trim(),
          ),
          text: (page.textContent ?? "").replace(/\\s+/gu, " ").trim(),
        };
      })()`,
      "the initial Training loading state",
    );
    expect(state.busy).toBe("true");
    expect(state.heading).toBe("Training");
    expect(state.text).toContain("Training history is not available yet.");
    expect(state.text).toContain("Recent rides are not available for this period.");
    expect(state.text).not.toContain("Loading training data…");
    expect(state.notices).toEqual([]);
    await info.attach("historical-scenario-mapping", {
      body: JSON.stringify({
        actualState: "loading",
        baselineId: "desktop--training-loading",
        historicalSourceId: "desktop--training-unavailable",
      }),
      contentType: "application/json",
    });
    await capture("desktop--training-loading", info);
  });
});
