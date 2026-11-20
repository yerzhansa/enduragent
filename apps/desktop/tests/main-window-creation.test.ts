import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("desktop main window creation", () => {
  const source = readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8");

  it("treats a window with destroyed web contents as absent", () => {
    const currentWindow = source.indexOf("const currentWindow = (): BrowserWindow | null =>");
    const destroyedGuard = source.indexOf("!window.isDestroyed()", currentWindow);
    const webContentsGuard = source.indexOf("!window.webContents.isDestroyed()", currentWindow);

    expect(currentWindow).toBeGreaterThan(-1);
    expect(destroyedGuard).toBeGreaterThan(currentWindow);
    expect(webContentsGuard).toBeGreaterThan(destroyedGuard);
  });

  it("requires a ready daemon connection before constructing the window", () => {
    const creationStart = source.indexOf("windowCreation = (async () => {");
    const connectionResolved = source.indexOf("lifecycle.connection().generation", creationStart);
    const windowConstructed = source.indexOf("new BrowserWindow(windowOptions)", creationStart);
    const preparedWithResolvedGeneration = source.indexOf(
      "navigationGeneration,",
      windowConstructed,
    );

    expect(creationStart).toBeGreaterThan(-1);
    expect(connectionResolved).toBeGreaterThan(creationStart);
    expect(windowConstructed).toBeGreaterThan(connectionResolved);
    expect(preparedWithResolvedGeneration).toBeGreaterThan(windowConstructed);
  });

  it("never caches a window whose creation failed and surfaces terminal-daemon copy", () => {
    const creationStart = source.indexOf("windowCreation = (async () => {");
    const creationCatch = source.indexOf(".catch((error: unknown) => {", creationStart);
    const cacheCleared = source.indexOf("window = null", creationCatch);
    const onboardingDisposed = source.indexOf("disposeOnboarding?.()", creationCatch);
    const windowDestroyed = source.indexOf(
      "if (!created.isDestroyed()) created.destroy()",
      creationCatch,
    );
    const terminalCopy = source.indexOf("lifecycleErrorCopy(lifecycleState)", creationCatch);
    const terminalDialog = source.indexOf(
      "dialog.showErrorBox(copy.title, copy.content)",
      terminalCopy,
    );
    const rethrown = source.indexOf("throw error;", terminalDialog);
    const creationReset = source.indexOf("windowCreation = undefined", rethrown);

    expect(creationCatch).toBeGreaterThan(creationStart);
    expect(cacheCleared).toBeGreaterThan(creationCatch);
    expect(onboardingDisposed).toBeGreaterThan(cacheCleared);
    expect(windowDestroyed).toBeGreaterThan(onboardingDisposed);
    expect(terminalCopy).toBeGreaterThan(windowDestroyed);
    expect(terminalDialog).toBeGreaterThan(terminalCopy);
    expect(rethrown).toBeGreaterThan(terminalDialog);
    expect(creationReset).toBeGreaterThan(rethrown);
  });
});
