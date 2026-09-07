import { mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class Emitter {
    private readonly listeners = new Map<string, Set<(...args: any[]) => void>>();
    on(name: string, listener: (...args: any[]) => void) {
      const listeners = this.listeners.get(name) ?? new Set();
      listeners.add(listener);
      this.listeners.set(name, listeners);
      return this;
    }
    emit(name: string, ...args: any[]) {
      for (const listener of this.listeners.get(name) ?? []) listener(...args);
    }
    removeAllListeners() {
      this.listeners.clear();
      return this;
    }
    listenerCount(name: string) {
      return this.listeners.get(name)?.size ?? 0;
    }
  }
  const order: string[] = [];
  const image = {
    isEmpty: vi.fn(() => false),
    setTemplateImage: vi.fn(() => order.push("template")),
  };
  class FakeTray extends Emitter {
    static instances: FakeTray[] = [];
    readonly setToolTip = vi.fn();
    readonly popUpContextMenu = vi.fn();
    readonly getBounds = vi.fn(() => ({ x: 10, y: 10, width: 16, height: 16 }));
    readonly destroy = vi.fn(() => order.push("tray-destroy"));
    constructor(readonly constructorImage: unknown) {
      super();
      order.push("tray-create");
      FakeTray.instances.push(this);
    }
  }
  const app = Object.assign(new Emitter(), {
    requestSingleInstanceLock: vi.fn(() => true),
    exit: vi.fn(),
    whenReady: vi.fn(async () => {}),
    quit: vi.fn(),
    setAppUserModelId: vi.fn(),
    setPath: vi.fn(),
    getLoginItemSettings: vi.fn(),
    setLoginItemSettings: vi.fn(),
    getVersion: vi.fn(() => "0.0.1"),
    getPath: vi.fn(() => "/synthetic/user-data"),
    getAppPath: vi.fn(() => "/synthetic/app"),
    commandLine: { getSwitchValue: vi.fn(() => ""), appendSwitch: vi.fn() },
  });
  return {
    Emitter,
    order,
    image,
    FakeTray,
    buildFromTemplate: vi.fn((template) => ({ template })),
    app,
    BrowserWindow: vi.fn(),
    supervisor: vi.fn(),
    registerDesktopScheme: vi.fn(),
    crashReporter: { start: vi.fn() },
  };
});

vi.mock("electron", () => ({
  app: mocks.app,
  crashReporter: mocks.crashReporter,
  BrowserWindow: mocks.BrowserWindow,
  Menu: { buildFromTemplate: mocks.buildFromTemplate },
  Tray: mocks.FakeTray,
  nativeImage: { createFromPath: vi.fn(() => mocks.image) },
  dialog: {},
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn(), removeListener: vi.fn() },
  safeStorage: {},
  session: { defaultSession: { protocol: { unhandle: vi.fn() } } },
  utilityProcess: { fork: vi.fn() },
}));

vi.mock("../src/main/security.js", () => ({
  registerDesktopScheme: mocks.registerDesktopScheme,
  desktopWindowOptions: vi.fn(),
  hardenDesktopWindow: vi.fn(),
  installDesktopProtocol: vi.fn(),
  isTrustedConnectionRequest: vi.fn(),
  rendererOutputRoot: vi.fn(),
}));

vi.mock("../src/main/supervisor.js", () => ({
  DesktopDaemonSupervisor: mocks.supervisor,
  isUtilityTerminalFrame: vi.fn(),
}));

vi.mock("../src/main/credential-vault.js", () => ({
  CREDENTIAL_DIRECTORY_NAME: "credentials",
  createCredentialVault: vi.fn(),
}));

vi.mock("../src/main/onboarding-ipc.js", () => ({
  registerOnboardingIpc: vi.fn(),
  runtimeConfigurationForCredential: vi.fn(),
}));

vi.mock("@enduragent/coach-client", () => ({ connectCoachClient: vi.fn() }));

import { createDesktopResidency } from "../src/main/residency.js";
import {
  BACKGROUND_AT_LOGIN_PREFERENCE_FILE_NAME,
  createBackgroundAtLoginPreferenceStore,
  LOGIN_ITEM_PREFERENCE_FILE_MODE,
  shouldStartInBackgroundAtLogin,
  WINDOWS_BACKGROUND_AT_LOGIN_ARGUMENT,
  type BackgroundAtLoginPreferenceWriteResult,
} from "../src/main/login-item.js";

const scratchDirectories: string[] = [];

async function scratch(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "enduragent-residency-"));
  scratchDirectories.push(path);
  return path;
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function loginState(
  status: "not-found" | "not-registered" | "enabled" | "requires-approval" = "not-found",
  openAtLogin = false,
) {
  return { openAtLogin, executableWillLaunchAtLogin: openAtLogin, status };
}

function setup(
  options: {
    readonly platform?: NodeJS.Platform;
    readonly loginItemExecutablePath?: string;
  } = {},
) {
  const events: unknown[] = [];
  const reportFailure = vi.fn();
  const browserWindow = Object.assign(new mocks.Emitter(), {
    hide: vi.fn(),
    webContents: { send: vi.fn() },
  });
  const mainWindow = {
    current: vi.fn(() => null),
    show: vi.fn(async () => browserWindow),
  };
  const persistLoginPreference = vi.fn<
    (enabled: boolean) => Promise<BackgroundAtLoginPreferenceWriteResult>
  >(async (enabled) => ({ status: "stored", enabled }));
  mocks.app.getLoginItemSettings.mockReturnValue(loginState() as never);
  const residency = createDesktopResidency({
    app: mocks.app as never,
    mainWindow: mainWindow as never,
    trayIconPath: "/synthetic/trayTemplate.png",
    platform: options.platform ?? "darwin",
    loginItemExecutablePath: options.loginItemExecutablePath,
    persistLoginPreference,
    reportFailure,
    observe: (event) => events.push(event),
  });
  return {
    residency,
    events,
    reportFailure,
    mainWindow,
    browserWindow,
    persistLoginPreference,
  };
}

beforeEach(() => {
  mocks.order.length = 0;
  mocks.FakeTray.instances.length = 0;
  mocks.image.isEmpty.mockReturnValue(false);
  mocks.image.isEmpty.mockClear();
  mocks.image.setTemplateImage.mockClear();
  mocks.buildFromTemplate.mockClear();
  mocks.app.quit.mockClear();
  mocks.app.getLoginItemSettings.mockReset();
  mocks.app.setLoginItemSettings.mockReset();
});

afterEach(async () => {
  await Promise.all(
    scratchDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("desktop residency", () => {
  it("deduplicates start, template-marks before one tray, and opens the native menu on either click", async () => {
    const { residency, events } = setup();
    const first = residency.start();
    const second = residency.start();
    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(mocks.order.slice(0, 2)).toEqual(["template", "tray-create"]);
    expect(mocks.image.isEmpty).toHaveBeenCalledOnce();
    expect(mocks.FakeTray.instances).toHaveLength(1);
    const tray = mocks.FakeTray.instances[0]!;
    expect(tray.setToolTip).toHaveBeenCalledWith("Enduragent");
    expect(tray.listenerCount("click")).toBe(1);
    expect(tray.listenerCount("right-click")).toBe(1);
    tray.emit("click");
    tray.emit("right-click");
    expect(mocks.buildFromTemplate).toHaveBeenCalledTimes(2);
    expect(tray.popUpContextMenu).toHaveBeenCalledTimes(2);
    expect(mocks.app.getLoginItemSettings).toHaveBeenCalledTimes(2);
    expect(mocks.BrowserWindow).not.toHaveBeenCalled();
    expect(events).toContainEqual({ type: "tray-created" });
  });

  it("uses the Windows tray icon as-is and opens the main window on left click", async () => {
    const { residency, mainWindow } = setup({ platform: "win32" });

    await residency.start();
    const tray = mocks.FakeTray.instances[0]!;
    tray.emit("click");
    tray.emit("click");

    await vi.waitFor(() => expect(mainWindow.show).toHaveBeenCalledTimes(2));
    expect(mocks.image.setTemplateImage).not.toHaveBeenCalled();
    expect(mocks.buildFromTemplate).not.toHaveBeenCalled();
    expect(tray.listenerCount("right-click")).toBe(1);
  });

  it("hides a Windows main window on close and allows explicit Quit to close it", async () => {
    const { residency, browserWindow } = setup({ platform: "win32" });

    await residency.showMainWindow();
    const closeToTray = { preventDefault: vi.fn() };
    browserWindow.emit("close", closeToTray);
    expect(closeToTray.preventDefault).toHaveBeenCalledOnce();
    expect(browserWindow.hide).toHaveBeenCalledOnce();

    residency.quit();
    const explicitQuit = { preventDefault: vi.fn() };
    browserWindow.emit("close", explicitQuit);
    expect(explicitQuit.preventDefault).not.toHaveBeenCalled();
    expect(browserWindow.hide).toHaveBeenCalledOnce();
    expect(mocks.app.quit).toHaveBeenCalledOnce();
  });

  it("uses effective Windows Startup Apps truth in the native menu", async () => {
    const executablePath = String.raw`C:\Users\Athlete\Enduragent.exe`;
    const { residency } = setup({ platform: "win32", loginItemExecutablePath: executablePath });
    mocks.app.getLoginItemSettings.mockReturnValue(loginState("enabled", true) as never);
    mocks.app.getLoginItemSettings.mockReturnValueOnce({
      ...loginState("enabled", true),
      executableWillLaunchAtLogin: false,
    } as never);

    await residency.start();
    mocks.FakeTray.instances[0]!.emit("right-click");

    const menu = mocks.buildFromTemplate.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(menu[3]).toMatchObject({ type: "checkbox", checked: false, enabled: true });
    expect(mocks.app.getLoginItemSettings).toHaveBeenCalledWith({
      path: executablePath,
      args: [WINDOWS_BACKGROUND_AT_LOGIN_ARGUMENT],
    });
  });

  it("builds a fresh exact native menu and uses current checkbox truth", async () => {
    const { residency, mainWindow, events } = setup();
    await residency.start();
    const tray = mocks.FakeTray.instances[0]!;
    mocks.app.getLoginItemSettings
      .mockReturnValueOnce(loginState("enabled", true) as never)
      .mockReturnValueOnce(loginState("not-registered", false) as never);
    tray.emit("right-click");
    tray.emit("right-click");
    expect(mocks.app.getLoginItemSettings).toHaveBeenCalledTimes(2);
    expect(mocks.buildFromTemplate).toHaveBeenCalledTimes(2);
    const first = mocks.buildFromTemplate.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(first.map((item) => item.label ?? item.type)).toEqual([
      "Open Enduragent",
      "separator",
      "Settings…",
      "Start in background at login",
      "separator",
      "Quit Enduragent",
    ]);
    expect(first[3]).toMatchObject({ type: "checkbox", checked: true, enabled: true });
    (first[0]!.click as () => void)();
    await vi.waitFor(() => expect(mainWindow.show).toHaveBeenCalledOnce());
    (first[3]!.click as (item: { checked: boolean }) => void)({ checked: false });
    await vi.waitFor(() =>
      expect(mocks.app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: false }),
    );
    expect(events).toContainEqual({ type: "main-window-shown" });
  });

  it("opens Settings only after the main window is ready", async () => {
    const { residency, mainWindow, browserWindow } = setup();
    const opening = deferred<typeof browserWindow>();
    mainWindow.show.mockReturnValueOnce(opening.promise);
    await residency.start();
    mocks.FakeTray.instances[0]!.emit("click");
    const menu = mocks.buildFromTemplate.mock.calls[0]![0] as Array<Record<string, unknown>>;

    (menu[2]!.click as () => void)();

    expect(mainWindow.show).toHaveBeenCalledOnce();
    expect(browserWindow.webContents.send).not.toHaveBeenCalled();
    opening.resolve(browserWindow);
    await vi.waitFor(() =>
      expect(browserWindow.webContents.send).toHaveBeenCalledWith("enduragent:open-settings"),
    );
  });

  it("does not send Settings after residency closes while the main window is opening", async () => {
    const { residency, mainWindow, browserWindow } = setup();
    const opening = deferred<typeof browserWindow>();
    mainWindow.show.mockReturnValueOnce(opening.promise);
    await residency.start();
    mocks.FakeTray.instances[0]!.emit("click");
    const menu = mocks.buildFromTemplate.mock.calls[0]![0] as Array<Record<string, unknown>>;
    (menu[2]!.click as () => void)();

    await residency.close();
    opening.resolve(browserWindow);
    await opening.promise;

    expect(browserWindow.webContents.send).not.toHaveBeenCalled();
  });

  it("reports Settings window failures without sending the navigation request", async () => {
    const { residency, mainWindow, browserWindow, reportFailure } = setup();
    mainWindow.show.mockRejectedValueOnce(new Error("private path"));
    await residency.start();
    mocks.FakeTray.instances[0]!.emit("click");
    const menu = mocks.buildFromTemplate.mock.calls[0]![0] as Array<Record<string, unknown>>;

    (menu[2]!.click as () => void)();

    await vi.waitFor(() => expect(reportFailure).toHaveBeenCalledWith("show-window"));
    expect(browserWindow.webContents.send).not.toHaveBeenCalled();
  });

  it("keeps Open and Quit usable when reads fail and emits fixed failure tags only", async () => {
    const secret = new Error("private setting path");
    secret.stack = "private stack";
    const { residency, reportFailure, mainWindow } = setup();
    await residency.start();
    mocks.app.getLoginItemSettings.mockImplementation(() => {
      throw secret;
    });
    mocks.FakeTray.instances[0]!.emit("right-click");
    const menu = mocks.buildFromTemplate.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(menu[0]!.click).toBeTypeOf("function");
    expect(menu[3]).toMatchObject({ checked: false, enabled: false });
    expect(menu[5]!.click).toBeTypeOf("function");
    expect(reportFailure).toHaveBeenCalledWith("read-login-item");
    expect(JSON.stringify(reportFailure.mock.calls)).not.toContain(secret.message);
    (menu[0]!.click as () => void)();
    await vi.waitFor(() => expect(mainWindow.show).toHaveBeenCalledOnce());
    (menu[5]!.click as () => void)();
    expect(mocks.app.quit).toHaveBeenCalledOnce();
  });

  it("re-reads after setter failure and reports no caught value", async () => {
    const { residency, reportFailure, events, persistLoginPreference } = setup();
    await residency.start();
    mocks.app.getLoginItemSettings
      .mockReturnValueOnce(loginState() as never)
      .mockReturnValueOnce(loginState("not-registered") as never);
    mocks.app.setLoginItemSettings.mockImplementation(() => {
      throw new Error("private setter path");
    });
    mocks.FakeTray.instances[0]!.emit("right-click");
    const menu = mocks.buildFromTemplate.mock.calls[0]![0] as Array<Record<string, unknown>>;
    (menu[3]!.click as (item: { checked: boolean }) => void)({ checked: true });
    await vi.waitFor(() => expect(reportFailure).toHaveBeenCalledWith("set-login-item"));
    expect(persistLoginPreference.mock.calls).toEqual([[true], [false]]);
    expect(mocks.app.getLoginItemSettings).toHaveBeenCalled();
    expect(events).toContainEqual({ type: "login-item-read", state: loginState("not-registered") });
  });

  it.each(["refused", "uncertain"] as const)(
    "leaves the OS login item unchanged when durable preference storage is %s",
    async (status) => {
      const { residency, reportFailure, persistLoginPreference } = setup();
      persistLoginPreference.mockResolvedValueOnce({ status } as never);
      await residency.start();
      mocks.app.getLoginItemSettings.mockReturnValue(loginState("not-registered", false) as never);
      mocks.FakeTray.instances[0]!.emit("right-click");
      const menu = mocks.buildFromTemplate.mock.calls[0]![0] as Array<Record<string, unknown>>;

      (menu[3]!.click as (item: { checked: boolean }) => void)({ checked: true });

      await vi.waitFor(() => expect(persistLoginPreference).toHaveBeenCalledWith(true));
      expect(mocks.app.setLoginItemSettings).not.toHaveBeenCalled();
      expect(reportFailure).toHaveBeenCalledWith("set-login-item");
    },
  );

  it("deduplicates quit and destroys the tray exactly once", async () => {
    const { residency } = setup();
    await residency.start();
    mocks.FakeTray.instances[0]!.emit("click");
    residency.quit();
    residency.quit();
    expect(mocks.app.quit).toHaveBeenCalledOnce();
    const firstClose = residency.close();
    expect(residency.close()).toBe(firstClose);
    await firstClose;
    expect(mocks.FakeTray.instances[0]!.destroy).toHaveBeenCalledOnce();
    expect(mocks.order.at(-1)).toBe("tray-destroy");
    expect(mocks.app.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it("fences captured tray callbacks and waits for a pending durable login-item update", async () => {
    const persistence = deferred<{ readonly status: "stored"; readonly enabled: true }>();
    const { residency, mainWindow, persistLoginPreference } = setup();
    persistLoginPreference.mockReturnValueOnce(persistence.promise);
    await residency.start();
    const tray = mocks.FakeTray.instances[0]!;
    let openAtLogin = false;
    mocks.app.getLoginItemSettings.mockImplementation(
      () => loginState(openAtLogin ? "enabled" : "not-registered", openAtLogin) as never,
    );
    mocks.app.setLoginItemSettings.mockImplementation((settings) => {
      openAtLogin = settings.openAtLogin;
    });
    tray.emit("click");
    tray.emit("right-click");
    const menu = mocks.buildFromTemplate.mock.calls[0]![0] as Array<Record<string, unknown>>;

    (menu[3]!.click as (item: { checked: boolean }) => void)({ checked: true });
    await vi.waitFor(() => expect(persistLoginPreference).toHaveBeenCalledWith(true));

    const close = residency.close();
    let settled = false;
    void close.then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(tray.destroy).toHaveBeenCalledOnce();
    (menu[0]!.click as () => void)();
    (menu[2]!.click as () => void)();
    (menu[3]!.click as (item: { checked: boolean }) => void)({ checked: false });
    (menu[5]!.click as () => void)();
    expect(mainWindow.show).not.toHaveBeenCalled();
    expect(persistLoginPreference).toHaveBeenCalledTimes(1);
    expect(mocks.app.quit).not.toHaveBeenCalled();

    persistence.resolve({ status: "stored", enabled: true });
    await close;

    expect(mocks.app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true });
    expect(settled).toBe(true);
  });

  it("waits for durable compensation and OS restoration after a login-item setter failure", async () => {
    const compensation = deferred<{ readonly status: "stored"; readonly enabled: false }>();
    const { residency, reportFailure, persistLoginPreference } = setup();
    persistLoginPreference
      .mockResolvedValueOnce({ status: "stored", enabled: true })
      .mockReturnValueOnce(compensation.promise);
    mocks.app.getLoginItemSettings.mockReturnValue(loginState("not-registered", false) as never);
    mocks.app.setLoginItemSettings
      .mockImplementationOnce(() => {
        throw new TypeError();
      })
      .mockImplementationOnce(() => undefined);
    await residency.start();
    mocks.FakeTray.instances[0]!.emit("right-click");
    const menu = mocks.buildFromTemplate.mock.calls[0]![0] as Array<Record<string, unknown>>;

    (menu[3]!.click as (item: { checked: boolean }) => void)({ checked: true });
    await vi.waitFor(() => expect(persistLoginPreference).toHaveBeenNthCalledWith(2, false));

    const close = residency.close();
    let settled = false;
    void close.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(mocks.app.setLoginItemSettings).toHaveBeenCalledTimes(1);

    compensation.resolve({ status: "stored", enabled: false });
    await close;

    expect(mocks.app.setLoginItemSettings.mock.calls).toEqual([
      [{ openAtLogin: true }],
      [{ openAtLogin: false }],
    ]);
    expect(reportFailure).toHaveBeenCalledWith("set-login-item");
    expect(settled).toBe(true);
  });

  it("converges the OS to the durable new preference when compensation is refused", async () => {
    const { residency, persistLoginPreference, reportFailure } = setup();
    persistLoginPreference
      .mockResolvedValueOnce({ status: "stored", enabled: true })
      .mockResolvedValueOnce({ status: "refused" });
    let openAtLogin = false;
    mocks.app.getLoginItemSettings.mockImplementation(
      () => loginState(openAtLogin ? "enabled" : "not-registered", openAtLogin) as never,
    );
    mocks.app.setLoginItemSettings
      .mockImplementationOnce(() => {
        throw new TypeError();
      })
      .mockImplementationOnce(({ openAtLogin: requested }) => {
        openAtLogin = requested;
      });
    await residency.start();
    mocks.FakeTray.instances[0]!.emit("right-click");
    const menu = mocks.buildFromTemplate.mock.calls[0]![0] as Array<Record<string, unknown>>;

    (menu[3]!.click as (item: { checked: boolean }) => void)({ checked: true });
    await vi.waitFor(() => expect(reportFailure).toHaveBeenCalledWith("set-login-item"));
    await residency.close();

    expect(persistLoginPreference.mock.calls).toEqual([[true], [false]]);
    expect(mocks.app.setLoginItemSettings.mock.calls).toEqual([
      [{ openAtLogin: true }],
      [{ openAtLogin: true }],
    ]);
    expect(openAtLogin).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "keeps a partial OS enablement restart-safe when durable compensation is uncertain",
    async () => {
      const root = join(await scratch(), "preferences");
      const seed = createBackgroundAtLoginPreferenceStore({ root, createId: () => "seed" });
      await expect(seed.set(true)).resolves.toEqual({ status: "stored", enabled: true });
      await writeFile(
        join(root, BACKGROUND_AT_LOGIN_PREFERENCE_FILE_NAME),
        `${JSON.stringify({ schemaVersion: 1, enabled: false })}\n`,
        { mode: LOGIN_ITEM_PREFERENCE_FILE_MODE },
      );
      let syncCount = 0;
      const syncDirectory = async (path: string): Promise<void> => {
        syncCount += 1;
        if (syncCount >= 3) throw new TypeError();
        const directory = await open(path, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      };
      let renameCount = 0;
      const renameFile: typeof rename = async (from, to) => {
        renameCount += 1;
        if (renameCount === 3) throw new TypeError();
        await rename(from, to);
      };
      const faulted = createBackgroundAtLoginPreferenceStore({
        root,
        createId: () => "faulted",
        renameFile,
        syncDirectory,
      });
      const { residency, persistLoginPreference, reportFailure } = setup();
      const persistenceResults: unknown[] = [];
      persistLoginPreference.mockImplementation(async (enabled) => {
        const result = await faulted.set(enabled);
        persistenceResults.push(result);
        return result;
      });
      let openAtLogin = false;
      mocks.app.getLoginItemSettings.mockImplementation(
        () => loginState(openAtLogin ? "enabled" : "not-registered", openAtLogin) as never,
      );
      mocks.app.setLoginItemSettings.mockImplementation(({ openAtLogin: requested }) => {
        openAtLogin = requested;
        throw new TypeError();
      });
      await residency.start();
      mocks.FakeTray.instances[0]!.emit("right-click");
      const menu = mocks.buildFromTemplate.mock.calls[0]![0] as Array<Record<string, unknown>>;

      (menu[3]!.click as (item: { checked: boolean }) => void)({ checked: true });
      await vi.waitFor(() => expect(reportFailure).toHaveBeenCalledWith("set-login-item"));
      await residency.close();

      expect(mocks.app.setLoginItemSettings).toHaveBeenCalledOnce();
      expect(openAtLogin).toBe(true);
      expect(persistLoginPreference.mock.calls).toEqual([[true], [false]]);
      expect(persistenceResults).toEqual([
        { status: "stored", enabled: true },
        { status: "uncertain" },
      ]);
      const reopened = createBackgroundAtLoginPreferenceStore({ root });
      await expect(reopened.read()).resolves.toEqual({
        state: "configured",
        enabled: false,
        loginLaunchBehavior: "background",
      });
      await expect(
        shouldStartInBackgroundAtLogin(
          { getLoginItemSettings: () => ({ wasOpenedAtLogin: openAtLogin }) } as never,
          reopened,
        ),
      ).resolves.toBe(true);
    },
  );

  it("reports show failures by operation and keeps observer data closed", async () => {
    const { residency, reportFailure, mainWindow, events } = setup();
    mainWindow.show.mockRejectedValue(new Error("secret token and path"));
    await residency.showMainWindow();
    expect(reportFailure).toHaveBeenCalledWith("show-window");
    expect(JSON.stringify(reportFailure.mock.calls)).not.toContain("secret");
    expect(events).toEqual([]);
  });

  it("presents the initial window only after its renderer URL loads", async () => {
    const source = await readFile(resolve(import.meta.dirname, "../src/main/index.ts"), "utf8");
    const creationStart = source.indexOf("windowCreation = (async () => {");
    const prepare = source.indexOf("connectionIpc!.prepareDocumentNavigation", creationStart);
    const load = source.indexOf(
      "const initialNavigation = startRendererNavigation(created, navigationUrl);",
      prepare,
    );
    const waitForCurrent = source.indexOf(
      "await rendererNavigationTracker.waitForCurrent(initialNavigation);",
      load,
    );
    const restore = source.indexOf("if (created.isMinimized()) created.restore();", load);
    const show = source.indexOf("created.show();", load);
    const focus = source.indexOf("created.focus();", load);
    const creationEnd = source.indexOf("windowCreation = undefined;", focus);
    const residencyStart = source.indexOf("await residency.start();", creationEnd);
    const initialShow = source.indexOf(
      "const initialWindow = desktopStartedInBackground ? undefined : await mainWindow.show();",
      residencyStart,
    );

    expect(source).not.toContain('created.once("ready-to-show"');
    expect(creationStart).toBeGreaterThanOrEqual(0);
    expect(prepare).toBeGreaterThan(creationStart);
    expect(load).toBeGreaterThan(prepare);
    expect(waitForCurrent).toBeGreaterThan(load);
    expect(restore).toBeGreaterThan(waitForCurrent);
    expect(show).toBeGreaterThan(restore);
    expect(focus).toBeGreaterThan(show);
    expect(creationEnd).toBeGreaterThan(focus);
    expect(residencyStart).toBeGreaterThan(creationEnd);
    expect(initialShow).toBeGreaterThan(residencyStart);
  });

  it("reads repaired Telegram intent after successor reconciliation", async () => {
    const source = await readFile(resolve(import.meta.dirname, "../src/main/index.ts"), "utf8");
    const block = source.slice(
      source.indexOf("const successorTelegramCoordinator"),
      source.indexOf('throw new TypeError("Telegram successor preparation failed")'),
    );
    const reconcile = block.indexOf(".reconcile();");
    const desiredRead = block.indexOf("telegramVault.desiredState();");

    expect(reconcile).toBeGreaterThanOrEqual(0);
    expect(desiredRead).toBeGreaterThan(reconcile);
  });

  it("continues initial startup through Telegram startup preparation", async () => {
    const source = await readFile(resolve(import.meta.dirname, "../src/main/index.ts"), "utf8");
    const startup = source.indexOf("await startDesktopTelegram({");
    const protocolStart = source.indexOf("await installDesktopProtocol({", startup);

    expect(startup).toBeGreaterThanOrEqual(0);
    expect(protocolStart).toBeGreaterThan(startup);
    expect(source.slice(startup, protocolStart)).not.toMatch(/\bthrow\b/u);
    expect(source).not.toContain("Telegram startup reconciliation failed");
  });

  it("reports tray-start and keeps running when the tray icon cannot load", async () => {
    const { residency, reportFailure, events } = setup();
    mocks.image.isEmpty.mockReturnValue(true);
    await expect(residency.start()).resolves.toBeUndefined();
    expect(mocks.FakeTray.instances).toHaveLength(0);
    expect(reportFailure).toHaveBeenCalledWith("tray-start");
    expect(events).toEqual([]);
    await residency.close();
    residency.quit();
    expect(mocks.app.quit).toHaveBeenCalledOnce();
  });

  it("anchors the tray icon to the build output instead of the launch-dependent app path", async () => {
    const source = await readFile(resolve(import.meta.dirname, "../src/main/index.ts"), "utf8");
    expect(source.replace(/\s+/g, " ")).toContain(
      'trayIconPath: resolve( mainDirectory, process.platform === "win32" ? "../../resources/tray.ico" : "../../resources/trayTemplate.png"',
    );
    expect(source).not.toContain('join(app.getAppPath(), "resources"');
  });

  it("keeps the production failure adapter closed and gates the loser before bootstrap", async () => {
    const source = await readFile(resolve(import.meta.dirname, "../src/main/index.ts"), "utf8");
    expect(source).toContain("desktop-residency-failure ${operation}\\n");
    expect(source).toContain('if (process.argv.includes("--desktop-keychain-binding-probe")) {');
    expect(source).toContain("const primaryInstance = app.requestSingleInstanceLock();");
    expect(source).toContain("if (!primaryInstance) {\n    void exitSecondaryDesktop();");
    mocks.app.requestSingleInstanceLock.mockReturnValueOnce(false);
    await import("../src/main/index.js");
    expect(mocks.crashReporter.start).toHaveBeenCalledWith({ uploadToServer: false });
    expect(mocks.app.listenerCount("render-process-gone")).toBe(1);
    expect(mocks.app.listenerCount("child-process-gone")).toBe(1);
    expect(mocks.app.exit).toHaveBeenCalledWith(0);
    expect(mocks.app.whenReady).not.toHaveBeenCalled();
    expect(mocks.app.commandLine.appendSwitch).not.toHaveBeenCalled();
    expect(mocks.BrowserWindow).not.toHaveBeenCalled();
    expect(mocks.FakeTray.instances).toHaveLength(0);
    expect(mocks.app.getLoginItemSettings).not.toHaveBeenCalled();
    expect(mocks.app.setLoginItemSettings).not.toHaveBeenCalled();
    expect(mocks.supervisor).not.toHaveBeenCalled();
  }, 30_000);
});
