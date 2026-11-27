import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getLocaleCountryCode: () => "US" },
  systemPreferences: { getUserDefault: () => ({}) },
  BrowserWindow: class {},
  net: { fetch: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn() },
}));

import { net } from "electron";

import {
  DESKTOP_CONNECTION_CHANNEL,
  DESKTOP_HOST,
  DESKTOP_OPEN_EXTERNAL_CHANNEL,
  DESKTOP_RENDERER_ORIGIN,
  DESKTOP_RENDERER_URL,
  DESKTOP_SCHEME,
  DESKTOP_WINDOW_HEIGHT,
  DESKTOP_WINDOW_MIN_HEIGHT,
  DESKTOP_WINDOW_MIN_WIDTH,
  DESKTOP_WINDOW_WIDTH,
  createDesktopContentSecurityPolicy,
  createDesktopDevelopmentContentSecurityPolicy,
} from "../src/main/constants.js";
import {
  createDesktopRendererConsoleCapture,
  desktopWindowOptions,
  hardenDesktopWindow,
  installDesktopProtocol,
  isTrustedConnectionRequest,
  resolveDesktopRendererSource,
} from "../src/main/security.js";
import {
  createDesktopRendererUrl,
  desktopRendererNavigationToken,
  isDesktopRendererUrl,
} from "../src/main/renderer-navigation.js";

const NAVIGATION_TOKEN = "A".repeat(43);
const RENDERER_URL = createDesktopRendererUrl(NAVIGATION_TOKEN);

describe("desktop security boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["absent", undefined],
    ["valid", "https://attacker.invalid/renderer"],
    ["malformed", ":///synthetic-malformed-renderer"],
  ])("uses bundled renderers when packaged and the override is %s", (_case, override) => {
    expect(resolveDesktopRendererSource(true, override)).toEqual({
      kind: "bundled",
      trayPopoverUrl: "enduragent://app/tray.html",
    });
  });

  it("uses bundled renderers during development without an override", () => {
    expect(resolveDesktopRendererSource(false, undefined)).toEqual({
      kind: "bundled",
      trayPopoverUrl: "enduragent://app/tray.html",
    });
  });

  it("uses the development proxy and tray path when an override is present", () => {
    expect(
      resolveDesktopRendererSource(
        false,
        "http://127.0.0.1:5173/renderer/index.html?source=synthetic",
      ),
    ).toEqual({
      kind: "development",
      developmentUrl: "http://127.0.0.1:5173/renderer/index.html?source=synthetic",
      trayPopoverUrl: "http://127.0.0.1:5173/tray.html",
    });
  });

  it("proxies development renderer requests through the resolved source", async () => {
    let handler: ((request: Request) => Promise<Response>) | undefined;
    const protocol = {
      handle: vi.fn(async (_scheme: string, installed: (request: Request) => Promise<Response>) => {
        handler = installed;
      }),
    };
    vi.mocked(net.fetch).mockResolvedValueOnce(new Response("synthetic-proxied-renderer"));
    await installDesktopProtocol({
      session: { protocol } as never,
      currentDaemonPort: () => 45_001,
      rendererRoot: "/synthetic/renderer",
      rendererSource: resolveDesktopRendererSource(false, "http://127.0.0.1:5173/root"),
    });

    const response = await handler!(
      new Request("enduragent://app/assets/renderer.js?cache=synthetic"),
    );

    expect(net.fetch).toHaveBeenCalledOnce();
    expect(net.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:5173/assets/renderer.js?cache=synthetic",
    );
    expect(await response.text()).toBe("synthetic-proxied-renderer");
    expect(response.headers.get("Content-Security-Policy")).toBe(
      createDesktopDevelopmentContentSecurityPolicy(45_001, "http://127.0.0.1:5173/root"),
    );
  });

  it("serves packaged renderer requests without fetching the override", async () => {
    let handler: ((request: Request) => Promise<Response>) | undefined;
    const protocol = {
      handle: vi.fn(async (_scheme: string, installed: (request: Request) => Promise<Response>) => {
        handler = installed;
      }),
    };
    const rendererSource = resolveDesktopRendererSource(true, "https://attacker.invalid/renderer");
    await installDesktopProtocol({
      session: { protocol } as never,
      currentDaemonPort: () => 45_001,
      rendererRoot: "/synthetic/renderer",
      rendererSource,
    });

    const response = await handler!(new Request("enduragent://app/missing.html"));

    expect(rendererSource).not.toHaveProperty("developmentUrl");
    expect(net.fetch).not.toHaveBeenCalled();
    expect(response.status).toBe(404);
  });

  it("maps bundled renderer asset extensions onto their content types", async () => {
    const rendererRoot = await mkdtemp(join(tmpdir(), "enduragent-renderer-"));
    await mkdir(join(rendererRoot, "assets"), { recursive: true });
    await writeFile(join(rendererRoot, "index.html"), "<!doctype html>");
    await writeFile(join(rendererRoot, "assets", "renderer.js"), "export {};");
    await writeFile(join(rendererRoot, "assets", "renderer.css"), ":root{}");
    await writeFile(join(rendererRoot, "assets", "coach-prose.woff2"), "synthetic-font");
    await writeFile(join(rendererRoot, "assets", "trayTemplate.png"), "synthetic-image");
    let handler: ((request: Request) => Promise<Response>) | undefined;
    const protocol = {
      handle: vi.fn(async (_scheme: string, installed: (request: Request) => Promise<Response>) => {
        handler = installed;
      }),
    };
    await installDesktopProtocol({
      session: { protocol } as never,
      currentDaemonPort: () => 45_001,
      rendererRoot,
      rendererSource: resolveDesktopRendererSource(true, undefined),
    });

    const contentType = async (pathname: string) =>
      (
        await handler!(
          new Request(pathname === "/index.html" ? RENDERER_URL : `enduragent://app${pathname}`),
        )
      ).headers.get("Content-Type");

    expect(await contentType("/index.html")).toBe("text/html; charset=utf-8");
    expect(await contentType("/assets/renderer.js")).toBe("text/javascript; charset=utf-8");
    expect(await contentType("/assets/renderer.css")).toBe("text/css; charset=utf-8");
    expect(await contentType("/assets/coach-prose.woff2")).toBe("font/woff2");
    expect(await contentType("/assets/trayTemplate.png")).toBeNull();
    await rm(rendererRoot, { recursive: true, force: true });
  });

  it("requires one exact navigation token for the renderer document", async () => {
    let handler: ((request: Request) => Promise<Response>) | undefined;
    const protocol = {
      handle: vi.fn(async (_scheme: string, installed: (request: Request) => Promise<Response>) => {
        handler = installed;
      }),
    };
    vi.mocked(net.fetch).mockResolvedValue(new Response("synthetic-renderer"));
    await installDesktopProtocol({
      session: { protocol } as never,
      currentDaemonPort: () => 45_001,
      rendererRoot: "/synthetic/renderer",
      rendererSource: resolveDesktopRendererSource(false, "http://127.0.0.1:5173/root"),
    });

    await expect(handler!(new Request(DESKTOP_RENDERER_URL))).resolves.toMatchObject({
      status: 404,
    });
    await expect(handler!(new Request(`${RENDERER_URL}&extra=1`))).resolves.toMatchObject({
      status: 404,
    });
    await expect(handler!(new Request(RENDERER_URL))).resolves.toMatchObject({ status: 200 });
    expect(net.fetch).toHaveBeenCalledOnce();
    expect(net.fetch).toHaveBeenCalledWith(
      `http://127.0.0.1:5173/index.html?navigationToken=${NAVIGATION_TOKEN}`,
    );
  });

  it("accepts only the byte-exact canonical renderer navigation URL", () => {
    expect(desktopRendererNavigationToken(RENDERER_URL)).toBe(NAVIGATION_TOKEN);
    expect(isDesktopRendererUrl(RENDERER_URL)).toBe(true);
    for (const value of [
      DESKTOP_RENDERER_URL,
      `${RENDERER_URL}&extra=1`,
      `${RENDERER_URL}#fragment`,
      `${DESKTOP_RENDERER_URL}?navigationToken=${"a".repeat(42)}`,
      `${DESKTOP_RENDERER_URL}?navigationToken=${NAVIGATION_TOKEN}&navigationToken=${NAVIGATION_TOKEN}`,
    ]) {
      expect(desktopRendererNavigationToken(value)).toBeUndefined();
      expect(isDesktopRendererUrl(value)).toBe(false);
    }
  });

  it("pins the scheme, IPC, window, and assigned-port-only CSP constants", () => {
    expect({
      DESKTOP_SCHEME,
      DESKTOP_HOST,
      DESKTOP_RENDERER_ORIGIN,
      DESKTOP_RENDERER_URL,
      DESKTOP_CONNECTION_CHANNEL,
      DESKTOP_OPEN_EXTERNAL_CHANNEL,
    }).toEqual({
      DESKTOP_SCHEME: "enduragent",
      DESKTOP_HOST: "app",
      DESKTOP_RENDERER_ORIGIN: "enduragent://app",
      DESKTOP_RENDERER_URL: "enduragent://app/index.html",
      DESKTOP_CONNECTION_CHANNEL: "desktop:get-daemon-connection",
      DESKTOP_OPEN_EXTERNAL_CHANNEL: "desktop:open-external",
    });
    expect({
      DESKTOP_WINDOW_WIDTH,
      DESKTOP_WINDOW_HEIGHT,
      DESKTOP_WINDOW_MIN_WIDTH,
      DESKTOP_WINDOW_MIN_HEIGHT,
    }).toEqual({
      DESKTOP_WINDOW_WIDTH: 1180,
      DESKTOP_WINDOW_HEIGHT: 820,
      DESKTOP_WINDOW_MIN_WIDTH: 760,
      DESKTOP_WINDOW_MIN_HEIGHT: 600,
    });
    expect(createDesktopContentSecurityPolicy(45_001)).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src ws://127.0.0.1:45001; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
    );
  });

  it("relaxes only inline execution and dev-server connections in the development policy", () => {
    expect(createDesktopDevelopmentContentSecurityPolicy(45_001, "http://localhost:5173/")).toBe(
      "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src ws://127.0.0.1:45001 ws://127.0.0.1:5173 ws://localhost:5173 http://127.0.0.1:5173 http://localhost:5173; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
    );
    expect(() =>
      createDesktopDevelopmentContentSecurityPolicy(0, "http://localhost:5173/"),
    ).toThrow(TypeError);
    expect(() =>
      createDesktopDevelopmentContentSecurityPolicy(45_001, "https://example.com/"),
    ).toThrow(TypeError);
  });

  it("uses the exact hardened BrowserWindow preferences", () => {
    expect(desktopWindowOptions("/synthetic/out/preload/index.cjs", "light")).toEqual({
      width: 1180,
      height: 820,
      minWidth: 760,
      minHeight: 600,
      show: false,
      backgroundColor: "#f4f6f5",
      webPreferences: {
        preload: "/synthetic/out/preload/index.cjs",
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        additionalArguments: ["--enduragent-first-day=7"],
      },
    });
  });

  it("paints the window with the resolved theme background before first paint", () => {
    expect(desktopWindowOptions("/synthetic/out/preload/index.cjs", "dark").backgroundColor).toBe(
      "#0f1520",
    );
    expect(desktopWindowOptions("/synthetic/out/preload/index.cjs", "light").backgroundColor).toBe(
      "#f4f6f5",
    );
  });

  it("always denies renderer navigation, new windows, and permissions", () => {
    let navigate: ((event: { preventDefault(): void }, url: string) => void) | undefined;
    let openHandler: ((details: { url: string }) => unknown) | undefined;
    let permissionRequest:
      | ((_contents: unknown, _permission: string, callback: (allowed: boolean) => void) => void)
      | undefined;
    let permissionCheck: (() => boolean) | undefined;
    hardenDesktopWindow({
      webContents: {
        on: vi.fn((name: string, listener: typeof navigate) => {
          if (name === "will-navigate") navigate = listener;
        }),
        setWindowOpenHandler: vi.fn((handler: typeof openHandler) => {
          openHandler = handler;
        }),
        session: {
          setPermissionRequestHandler: vi.fn((handler: typeof permissionRequest) => {
            permissionRequest = handler;
          }),
          setPermissionCheckHandler: vi.fn((handler: typeof permissionCheck) => {
            permissionCheck = handler;
          }),
        },
      },
    } as never);
    const preventAppNavigation = vi.fn();
    const preventExternalNavigation = vi.fn();
    const permissionResult = vi.fn();

    navigate?.({ preventDefault: preventAppNavigation }, DESKTOP_RENDERER_URL);
    navigate?.({ preventDefault: preventExternalNavigation }, "https://example.test/guide");
    permissionRequest?.({}, "notifications", permissionResult);

    expect(preventAppNavigation).toHaveBeenCalledOnce();
    expect(preventExternalNavigation).toHaveBeenCalledOnce();
    expect(openHandler?.({ url: "https://example.test/guide" })).toEqual({ action: "deny" });
    expect(openHandler?.({ url: "javascript:alert(1)" })).toEqual({ action: "deny" });
    expect(permissionResult).toHaveBeenCalledWith(false);
    expect(permissionCheck?.()).toBe(false);
  });

  it("does not register or retain renderer console messages when capture is disabled", () => {
    const on = vi.fn();
    const capture = createDesktopRendererConsoleCapture(false);

    capture.attach({ on } as never);

    expect(on).not.toHaveBeenCalled();
    expect(capture.hasMessageContaining("synthetic-disabled-message")).toBe(false);
  });

  it("registers one listener and captures every renderer console message when enabled", () => {
    let listener: ((event: unknown, level: number, message: string) => void) | undefined;
    const on = vi.fn(
      (event: string, installed: (event: unknown, level: number, message: string) => void) => {
        if (event === "console-message") listener = installed;
      },
    );
    const capture = createDesktopRendererConsoleCapture(true);

    capture.attach({ on } as never);
    listener?.({}, 1, "synthetic-first-message");
    listener?.({}, 2, "synthetic-second-message");

    expect(on).toHaveBeenCalledOnce();
    expect(on).toHaveBeenCalledWith("console-message", expect.any(Function));
    expect(capture.hasMessageContaining("synthetic-first-message")).toBe(true);
    expect(capture.hasMessageContaining("synthetic-second-message")).toBe(true);
  });

  it("keeps renderer console capture state isolated between instances", () => {
    let firstListener: ((event: unknown, level: number, message: string) => void) | undefined;
    let secondListener: ((event: unknown, level: number, message: string) => void) | undefined;
    const first = createDesktopRendererConsoleCapture(true);
    const second = createDesktopRendererConsoleCapture(true);
    first.attach({
      on: vi.fn(
        (_event: string, installed: (event: unknown, level: number, message: string) => void) => {
          firstListener = installed;
        },
      ),
    } as never);
    second.attach({
      on: vi.fn(
        (_event: string, installed: (event: unknown, level: number, message: string) => void) => {
          secondListener = installed;
        },
      ),
    } as never);

    firstListener?.({}, 1, "synthetic-first-capture");
    secondListener?.({}, 1, "synthetic-second-capture");

    expect(first.hasMessageContaining("synthetic-first-capture")).toBe(true);
    expect(first.hasMessageContaining("synthetic-second-capture")).toBe(false);
    expect(second.hasMessageContaining("synthetic-first-capture")).toBe(false);
    expect(second.hasMessageContaining("synthetic-second-capture")).toBe(true);
  });

  it("emits an exact CSP pin from the current daemon port on every document load", async () => {
    let handler: ((request: Request) => Promise<Response>) | undefined;
    const protocol = {
      handle: vi.fn(async (_scheme: string, installed: (request: Request) => Promise<Response>) => {
        handler = installed;
      }),
    };
    let port = 45_001;
    await installDesktopProtocol({
      session: { protocol } as never,
      currentDaemonPort: () => port,
      rendererRoot: "/synthetic/renderer",
      rendererSource: resolveDesktopRendererSource(false, undefined),
    });
    const first = await handler!(new Request("enduragent://app/missing.html"));
    port = 45_002;
    const second = await handler!(new Request("enduragent://app/missing.html"));
    const firstPolicy = first.headers.get("Content-Security-Policy");
    const secondPolicy = second.headers.get("Content-Security-Policy");
    expect(firstPolicy).toContain("connect-src ws://127.0.0.1:45001;");
    expect(secondPolicy).toContain("connect-src ws://127.0.0.1:45002;");
    expect(secondPolicy).not.toContain("ws://127.0.0.1:*");
  });

  it("requires the live window, sender, main frame, and exact URL", () => {
    const mainFrame: { url: string } = { url: RENDERER_URL };
    const webContents = { isDestroyed: () => false, mainFrame };
    const window = { isDestroyed: () => false, webContents };
    expect(
      isTrustedConnectionRequest(
        { sender: webContents, senderFrame: mainFrame } as never,
        window as never,
      ),
    ).toBe(true);
    expect(
      isTrustedConnectionRequest(
        { sender: webContents, senderFrame: { url: RENDERER_URL } } as never,
        window as never,
      ),
    ).toBe(false);
    mainFrame.url = "https://example.invalid";
    expect(
      isTrustedConnectionRequest(
        { sender: webContents, senderFrame: mainFrame } as never,
        window as never,
      ),
    ).toBe(false);
  });
});
