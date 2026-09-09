import { initializeDesktopLanguage } from "../src/main/language.js";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { DESKTOP_APP_USER_MODEL_ID } from "../src/main/constants.js";
import {
  bindDesktopAppUserModelId,
  createDesktopActivationRelay,
  DesktopIdentityBindingError,
} from "../src/main/desktop-lifecycle.js";

await initializeDesktopLanguage();

describe("desktop platform lifecycle", () => {
  it("binds the frozen AppUserModelID only on Windows", () => {
    const setAppUserModelId = vi.fn();

    bindDesktopAppUserModelId({ setAppUserModelId } as never, "win32");

    expect(setAppUserModelId).toHaveBeenCalledOnce();
    expect(setAppUserModelId).toHaveBeenCalledWith(DESKTOP_APP_USER_MODEL_ID);

    setAppUserModelId.mockClear();
    bindDesktopAppUserModelId({ setAppUserModelId } as never, "darwin");
    expect(setAppUserModelId).not.toHaveBeenCalled();
  });

  it("fails closed when Windows rejects the AppUserModelID", () => {
    const sensitiveDetail = String.raw`C:\Users\Private Athlete\identity failure`;
    let failure: unknown;
    try {
      bindDesktopAppUserModelId(
        {
          setAppUserModelId() {
            throw new TypeError(sensitiveDetail);
          },
        },
        "win32",
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(DesktopIdentityBindingError);
    expect(failure).toMatchObject({
      name: "DesktopIdentityBindingError",
      message: "Windows desktop identity binding failed",
      stage: "set-app-user-model-id",
    });
    expect(failure).not.toHaveProperty("cause");
    expect(JSON.stringify(failure)).not.toContain(sensitiveDetail);
  });

  it("binds identity before scheme, lock, and window interaction in the production entry", async () => {
    const source = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");
    const identity = source.indexOf("bindDesktopAppUserModelId(app);");

    expect(identity).toBeGreaterThanOrEqual(0);
    expect(identity).toBeLessThan(source.indexOf("registerDesktopScheme();"));
    expect(identity).toBeLessThan(source.indexOf("app.requestSingleInstanceLock();"));
    expect(identity).toBeLessThan(source.indexOf("new BrowserWindow("));
  });

  it("restores, shows, and focuses the resident window for a second launch", async () => {
    const source = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");
    const currentWindow = source.indexOf("const current = mainWindow.current();");
    const currentReturn = source.indexOf("return Promise.resolve(current);", currentWindow);
    const presentation = source.slice(currentWindow, currentReturn);

    expect(presentation.indexOf("current.restore();")).toBeGreaterThanOrEqual(0);
    expect(presentation.indexOf("current.show();")).toBeGreaterThan(
      presentation.indexOf("current.restore();"),
    );
    expect(presentation.indexOf("current.focus();")).toBeGreaterThan(
      presentation.indexOf("current.show();"),
    );
  });

  it("coalesces early Windows activation and presents every later second launch", async () => {
    const first = { showMainWindow: vi.fn(async () => {}) };
    const second = { showMainWindow: vi.fn(async () => {}) };
    const relay = createDesktopActivationRelay("win32");

    relay.request();
    relay.request();
    await relay.bind(first);
    expect(first.showMainWindow).toHaveBeenCalledOnce();

    relay.request();
    expect(first.showMainWindow).toHaveBeenCalledTimes(2);

    relay.unbind(first);
    relay.request();
    await relay.bind(second);
    expect(second.showMainWindow).toHaveBeenCalledOnce();
  });

  it("preserves the macOS no-target activation behavior", async () => {
    const target = { showMainWindow: vi.fn(async () => {}) };
    const relay = createDesktopActivationRelay("darwin");

    relay.request();
    await relay.bind(target);
    expect(target.showMainWindow).not.toHaveBeenCalled();

    relay.request();
    expect(target.showMainWindow).toHaveBeenCalledOnce();
  });
});
