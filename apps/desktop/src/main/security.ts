import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  type IpcMainInvokeEvent,
  net,
  protocol,
  type Session,
  type WebContents,
} from "electron";
import { desktopWindowBackgroundColor, type DesktopResolvedTheme } from "./appearance.js";
import { regionFirstDayArgument } from "./region-week.js";
import {
  DESKTOP_HOST,
  DESKTOP_SCHEME,
  DESKTOP_WINDOW_HEIGHT,
  DESKTOP_WINDOW_MIN_HEIGHT,
  DESKTOP_WINDOW_MIN_WIDTH,
  DESKTOP_WINDOW_WIDTH,
  createDesktopContentSecurityPolicy,
  createDesktopDevelopmentContentSecurityPolicy,
} from "./constants.js";
import { isDesktopRendererUrl } from "./renderer-navigation.js";

export function registerDesktopScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: DESKTOP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

function responseWithPolicy(response: Response, policy: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", policy);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function safeRendererPath(rendererRoot: string, pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes("\\") || decoded.includes("\0")) return undefined;
  const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const normalized = normalize(relativePath);
  if (normalized === ".." || normalized.startsWith(`..${sep}`) || isAbsolute(normalized)) {
    return undefined;
  }
  const target = resolve(rendererRoot, normalized);
  const rootPrefix = rendererRoot.endsWith(sep) ? rendererRoot : `${rendererRoot}${sep}`;
  return target.startsWith(rootPrefix) ? target : undefined;
}

export type DesktopRendererSource =
  | {
      readonly kind: "bundled";
      readonly trayPopoverUrl: string;
    }
  | {
      readonly kind: "development";
      readonly developmentUrl: string;
      readonly trayPopoverUrl: string;
    };

export function resolveDesktopRendererSource(
  isPackaged: boolean,
  developmentUrl: string | undefined,
): DesktopRendererSource {
  if (isPackaged || developmentUrl === undefined) {
    return { kind: "bundled", trayPopoverUrl: "enduragent://app/tray.html" };
  }
  return {
    kind: "development",
    developmentUrl,
    trayPopoverUrl: new URL("/tray.html", developmentUrl).toString(),
  };
}

export async function installDesktopProtocol(input: {
  readonly session: Session;
  readonly currentDaemonPort: () => number;
  readonly rendererRoot: string;
  readonly rendererSource: DesktopRendererSource;
}): Promise<void> {
  const withCurrentPolicy = (response: Response): Response =>
    responseWithPolicy(
      response,
      input.rendererSource.kind === "development"
        ? createDesktopDevelopmentContentSecurityPolicy(
            input.currentDaemonPort(),
            input.rendererSource.developmentUrl,
          )
        : createDesktopContentSecurityPolicy(input.currentDaemonPort()),
    );
  await input.session.protocol.handle(DESKTOP_SCHEME, async (request) => {
    const requested = new URL(request.url);
    if (requested.host !== DESKTOP_HOST)
      return withCurrentPolicy(new Response(null, { status: 404 }));
    if (requested.pathname === "/index.html" && !isDesktopRendererUrl(request.url)) {
      return withCurrentPolicy(new Response(null, { status: 404 }));
    }
    if (input.rendererSource.kind === "development") {
      const upstream = new URL(input.rendererSource.developmentUrl);
      upstream.pathname = requested.pathname;
      upstream.search = requested.search;
      return withCurrentPolicy(await net.fetch(upstream.toString()));
    }
    const target = safeRendererPath(resolve(input.rendererRoot), requested.pathname);
    if (target === undefined) return withCurrentPolicy(new Response(null, { status: 404 }));
    try {
      const body = await readFile(target);
      const headers = new Headers();
      if (target.endsWith(".html")) headers.set("Content-Type", "text/html; charset=utf-8");
      if (target.endsWith(".js")) headers.set("Content-Type", "text/javascript; charset=utf-8");
      if (target.endsWith(".css")) headers.set("Content-Type", "text/css; charset=utf-8");
      if (target.endsWith(".woff2")) headers.set("Content-Type", "font/woff2");
      return withCurrentPolicy(new Response(body, { status: 200, headers }));
    } catch {
      return withCurrentPolicy(new Response(null, { status: 404 }));
    }
  });
}

export function desktopWindowOptions(
  preload: string,
  theme: DesktopResolvedTheme,
): Electron.BrowserWindowConstructorOptions {
  if (!isAbsolute(preload)) throw new TypeError("preload path must be absolute");
  return {
    width: DESKTOP_WINDOW_WIDTH,
    height: DESKTOP_WINDOW_HEIGHT,
    minWidth: DESKTOP_WINDOW_MIN_WIDTH,
    minHeight: DESKTOP_WINDOW_MIN_HEIGHT,
    show: false,
    backgroundColor: desktopWindowBackgroundColor(theme),
    webPreferences: {
      preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      additionalArguments: [regionFirstDayArgument(app.getLocaleCountryCode())],
    },
  };
}

export function hardenDesktopWindow(window: BrowserWindow): void {
  window.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  window.webContents.session.setPermissionCheckHandler(() => false);
}

export type DesktopRendererConsoleCapture = {
  readonly attach: (webContents: Pick<WebContents, "on">) => void;
  readonly hasMessageContaining: (value: string) => boolean;
};

export function createDesktopRendererConsoleCapture(
  enabled: boolean,
): DesktopRendererConsoleCapture {
  if (!enabled) {
    return {
      attach: () => undefined,
      hasMessageContaining: () => false,
    };
  }
  const messages: string[] = [];
  return {
    attach(webContents) {
      webContents.on("console-message", (_event, _level, message) => {
        messages.push(message);
      });
    },
    hasMessageContaining(value) {
      return messages.some((message) => message.includes(value));
    },
  };
}

export function isTrustedConnectionRequest(
  event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">,
  window: BrowserWindow | undefined,
): boolean {
  return (
    window !== undefined &&
    !window.isDestroyed() &&
    !window.webContents.isDestroyed() &&
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    isDesktopRendererUrl(event.senderFrame.url)
  );
}

export function rendererOutputRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../renderer");
}
