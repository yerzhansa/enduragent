import { createInterface } from "node:readline";
import { join } from "node:path";
import { app, BrowserWindow, nativeImage } from "electron";
import {
  isCleanUnregisteredLoginItem,
  readLoginItemResidency,
  setLoginItemResidency,
} from "../../../src/main/login-item.js";
import {
  createDesktopResidency,
  type DesktopResidency,
  type DesktopResidencyEvent,
} from "../../../src/main/residency.js";

let ready = false;
let trayCreationCount = 0;
let trayAlive = false;
let secondInstanceCount = 0;
let mainWindow: BrowserWindow | null = null;
let mainWindowCreation: Promise<BrowserWindow> | undefined;
let residency: DesktopResidency | undefined;

function output(value: object): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function observe(event: DesktopResidencyEvent): void {
  if (event.type === "tray-created") {
    trayCreationCount += 1;
    trayAlive = true;
  }
  if (event.type === "tray-destroyed") trayAlive = false;
  output({ event: event.type, trayCreationCount, trayAlive });
}

function windowPort() {
  return {
    current: () => (mainWindow !== null && !mainWindow.isDestroyed() ? mainWindow : null),
    show: (): Promise<BrowserWindow> => {
      if (mainWindowCreation !== undefined) return mainWindowCreation;
      const current = mainWindow !== null && !mainWindow.isDestroyed() ? mainWindow : null;
      if (current !== null) {
        if (current.isMinimized()) current.restore();
        current.show();
        current.focus();
        return Promise.resolve(current);
      }
      mainWindowCreation = (async () => {
        const created = new BrowserWindow({
          width: 640,
          height: 480,
          show: false,
          webPreferences: {
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            webSecurity: true,
          },
        });
        mainWindow = created;
        created.once("closed", () => {
          if (mainWindow === created) mainWindow = null;
          output({ event: "main-window-closed", mainWindowAlive: false, trayAlive });
        });
        await created.loadURL("data:text/html,<main>Enduragent Residency Acceptance</main>");
        created.show();
        created.focus();
        return created;
      })().finally(() => {
        mainWindowCreation = undefined;
      });
      return mainWindowCreation;
    },
  };
}

function state() {
  const login = readLoginItemResidency(app);
  return {
    pid: process.pid,
    ready,
    trayCreationCount,
    trayAlive,
    mainWindowAlive: mainWindow !== null && !mainWindow.isDestroyed(),
    secondInstanceCount,
    login,
  };
}

async function respond(request: Record<string, unknown>): Promise<void> {
  const id = typeof request.id === "string" ? request.id : "invalid";
  if (request.command === "state") {
    output({ id, ok: true, ...state() });
    return;
  }
  if (request.command === "close-main-window") {
    mainWindow?.destroy();
    output({ id, ok: true, ...state() });
    return;
  }
  if (request.command === "set-open-at-login" && typeof request.value === "boolean") {
    const login = setLoginItemResidency(app, request.value);
    output({ id, ok: true, ...state(), login, clean: isCleanUnregisteredLoginItem(login) });
    return;
  }
  if (request.command === "show-main-window") {
    await residency?.showMainWindow();
    output({ id, ok: true, ...state() });
    return;
  }
  if (request.command === "quit") {
    residency?.close();
    output({ id, ok: true, ...state() });
    residency?.quit();
    return;
  }
  output({ id, ok: false, reason: "invalid-command" });
}

async function run(): Promise<void> {
  app.on("second-instance", () => {
    secondInstanceCount += 1;
    void residency?.showMainWindow();
    output({ event: "second-instance", secondInstanceCount, trayCreationCount, trayAlive });
  });
  app.on("window-all-closed", () => {});
  app.on("before-quit", () => residency?.close());
  await app.whenReady();
  const trayIconPath = join(app.getAppPath(), "resources", "trayTemplate.png");
  const icon = nativeImage.createFromPath(trayIconPath);
  icon.setTemplateImage(true);
  residency = createDesktopResidency({
    app,
    mainWindow: windowPort(),
    trayIconPath,
    persistLoginPreference: async (enabled) => ({ status: "stored", enabled }),
    reportFailure(operation) {
      output({ event: "failure", operation });
    },
    observe,
  });
  await residency.showMainWindow();
  await residency.start();
  ready = true;
  output({
    event: "ready",
    ...state(),
    trayImageEmpty: icon.isEmpty(),
    trayImageTemplate: icon.isTemplateImage(),
    trayImageSize: icon.getSize(),
  });
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    let request: unknown;
    try {
      request = JSON.parse(line);
    } catch {
      output({ id: "invalid", ok: false, reason: "invalid-command" });
      return;
    }
    if (typeof request !== "object" || request === null || Array.isArray(request)) {
      output({ id: "invalid", ok: false, reason: "invalid-command" });
      return;
    }
    void respond(request as Record<string, unknown>);
  });
}

const primaryInstance = app.requestSingleInstanceLock();

if (!primaryInstance) {
  output({ event: "lock-denied", pid: process.pid, ready, trayCreationCount, trayAlive });
  app.exit(0);
} else {
  void run().catch(() => {
    output({ event: "failure", operation: "fixture-start" });
    app.exit(1);
  });
}
