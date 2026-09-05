import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { startFixtureBridge } from "./fixture-bridge.js";
import { buildFixtureApplication } from "./fixture-build.js";
import type { DesktopFixtureScript } from "./scripted-coach.js";
import { connectCdp, reservePort, waitForPage } from "../../scripts/support/desktop-cdp.js";
import { BACKGROUND_AT_LOGIN_PREFERENCE_DIRECTORY_NAME } from "../../src/main/login-item.js";
import { SESSION_TIMEZONE_PIN_FILE_NAME } from "../../src/main/session-timezone-contract.js";

export type { DesktopFixtureScript } from "./scripted-coach.js";

export interface DesktopFixturePaths {
  readonly athleteHome: string;
  readonly configPath: string;
  readonly userData: string;
  readonly desktopPreferences: string;
  readonly sessionTimezonePinPath: string;
}

export interface RunningDesktopFixture {
  readonly paths: DesktopFixturePaths;
  readonly remoteDebuggingUrl: string;
  evaluate<T>(source: string): Promise<T>;
  evaluateMain<T>(source: string): Promise<T>;
  dropFiles(selector: string, paths: readonly string[]): Promise<void>;
  relaunch(beforeLaunch?: () => void | Promise<void>): Promise<void>;
  screenshot(path: string): Promise<void>;
  setViewport(width: number, height: number): Promise<void>;
  pressKey(
    key: "Escape" | "Tab" | "v",
    options?: { readonly shift?: boolean; readonly meta?: boolean },
  ): Promise<void>;
  readCapturedSurface(name: "location" | "console" | "stdout" | "stderr" | "dom"): string;
  close(): Promise<{
    readonly livePids: readonly number[];
    readonly listenerCount: number;
  }>;
}

const require = createRequire(import.meta.url);
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DESKTOP_FIXTURE_LAUNCH_TIMEOUT_MS = 45_000;

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function visibleQaCheckpoint(name: string): Promise<void> {
  const gateDirectory = process.env.ENDURAGENT_VISIBLE_QA_GATE_DIR;
  if (gateDirectory === undefined) return;
  if (!/^[a-z0-9-]+$/.test(name)) throw new TypeError("invalid visible QA checkpoint name");
  await mkdir(gateDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(gateDirectory, `${name}.ready`), "ready\n", { mode: 0o600 });
  const releasePath = join(gateDirectory, `${name}.release`);
  const deadline = Date.now() + 600_000;
  while (!existsSync(releasePath)) {
    if (Date.now() >= deadline) throw new Error(`visible QA checkpoint timed out: ${name}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
}

export async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise<boolean>((resolveExit) => child.once("exit", () => resolveExit(true))),
    new Promise<boolean>((resolveExit) => setTimeout(() => resolveExit(false), 5_000)),
  ]);
  if (!exited) {
    child.kill("SIGKILL");
    await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  }
}

export async function launchDesktopFixture(input: {
  readonly script: DesktopFixtureScript;
  readonly token: string;
  readonly width: number;
  readonly height: number;
  readonly colorScheme: "light" | "dark";
  readonly reducedMotion: boolean;
  readonly executable?: string;
  readonly applicationBundle?: string;
  readonly hidden?: boolean;
  readonly inspectMain?: boolean;
  readonly routeChatAttachmentComposer?: boolean;
  readonly routeChatAttachmentOperations?: boolean;
  readonly seedConfig?: boolean;
  readonly sessionTimezonePinned?: false | "embedded" | "legacy";
  readonly extraEnv?: Readonly<Record<string, string>>;
}): Promise<RunningDesktopFixture> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.token)) throw new TypeError("invalid fixture token");
  if (!existsSync(join(desktopRoot, "out/main/index.js"))) {
    throw new Error("desktop build output is required before launching the fixture");
  }
  const base = await realpath(process.platform === "darwin" ? "/tmp" : tmpdir());
  const scratch = await mkdtemp(join(base, "eap-"));
  const athleteHome = join(scratch, "h");
  const configDir = join(athleteHome, "config");
  const userData = join(scratch, "u");
  const desktopPreferences = join(userData, BACKGROUND_AT_LOGIN_PREFERENCE_DIRECTORY_NAME);
  await Promise.all([
    mkdir(configDir, { recursive: true, mode: 0o700 }),
    mkdir(userData, { recursive: true, mode: 0o700 }),
    mkdir(desktopPreferences, { recursive: true, mode: 0o700 }),
  ]);
  const sessionTimezonePinned = input.sessionTimezonePinned ?? "legacy";
  const sessionTimezonePinFile = join(desktopPreferences, SESSION_TIMEZONE_PIN_FILE_NAME);
  await Promise.all([
    ...(sessionTimezonePinned === "legacy"
      ? [
          writeFile(
            sessionTimezonePinFile,
            `${JSON.stringify({ schemaVersion: 1, pinned: true })}\n`,
            { mode: 0o600 },
          ),
        ]
      : []),
    writeFile(join(configDir, "daemon.token"), `${input.token}\n`, { mode: 0o600 }),
    ...(input.seedConfig === false
      ? []
      : [
          writeFile(
            join(configDir, "config.yaml"),
            [
              "data_source: store",
              `data_dir: ${JSON.stringify(athleteHome)}`,
              "llm:",
              "  provider: anthropic",
              "  model: fixture",
              "  api_key: fixture",
              "intervals:",
              "  api_key: ''",
              "  athlete_id: '0'",
              "session:",
              "  timezone: UTC",
              ...(sessionTimezonePinned === "embedded" ? ["  timezonePinned: true"] : []),
              "",
            ].join("\n"),
            { mode: 0o600 },
          ),
        ]),
  ]);
  const executable =
    input.applicationBundle === undefined
      ? (input.executable ?? (require("electron") as string))
      : "/usr/bin/open";
  const applicationArgs =
    input.applicationBundle === undefined
      ? input.executable === undefined
        ? [await buildFixtureApplication()]
        : []
      : ["-n", "-W", input.applicationBundle, "--args"];
  const bridge = await startFixtureBridge(input);
  let stdout = "";
  let stderr = "";
  let child: ChildProcess | undefined;
  let cdp: Awaited<ReturnType<typeof connectCdp>> | undefined;
  let mainCdp: Awaited<ReturnType<typeof connectCdp>> | undefined;
  let remoteDebuggingUrl: string | undefined;
  const processIds = new Set<number>();
  const surfaces: Record<"location" | "console" | "stdout" | "stderr" | "dom", string> = {
    location: "",
    console: "",
    stdout: "",
    stderr: "",
    dom: "",
  };
  const consoleMessages: string[] = [];
  const refreshSurfaces = async (): Promise<void> => {
    if (cdp === undefined) return;
    const result = await cdp.call("Runtime.evaluate", {
      expression: "({ location: location.href, dom: document.documentElement.outerHTML })",
      returnByValue: true,
    });
    const value = ((result.result as Record<string, unknown> | undefined)?.value ?? {}) as Record<
      string,
      unknown
    >;
    surfaces.location = typeof value.location === "string" ? value.location : "";
    surfaces.dom = typeof value.dom === "string" ? value.dom : "";
    surfaces.console = consoleMessages.join("\n");
    surfaces.stdout = stdout;
    surfaces.stderr = stderr;
  };
  const stopApplication = async (): Promise<void> => {
    const activeMainCdp = mainCdp;
    mainCdp = undefined;
    if (activeMainCdp !== undefined && activeMainCdp.socket.readyState === WebSocket.OPEN) {
      activeMainCdp.socket.close();
    }
    const activeCdp = cdp;
    cdp = undefined;
    if (activeCdp !== undefined && activeCdp.socket.readyState === WebSocket.OPEN) {
      await activeCdp.call("Browser.close").catch(() => {});
      activeCdp.socket.close();
    }
    const activeChild = child;
    child = undefined;
    if (activeChild !== undefined) await stopProcess(activeChild).catch(() => {});
  };
  const launchApplication = async (): Promise<void> => {
    const debuggerPort = await reservePort();
    remoteDebuggingUrl = `http://127.0.0.1:${debuggerPort}`;
    const mainDebuggerPort = input.inspectMain === true ? await reservePort() : undefined;
    const nextChild = spawn(
      executable,
      [
        ...(mainDebuggerPort === undefined ? [] : [`--inspect=${mainDebuggerPort}`]),
        ...applicationArgs,
        `--remote-debugging-port=${debuggerPort}`,
        `--user-data-dir=${userData}`,
      ],
      {
        env: {
          ...process.env,
          ...input.extraEnv,
          ENDURAGENT_HOME: athleteHome,
          ENDURAGENT_FIXTURE_BRIDGE: JSON.stringify(bridge.connection),
          ENDURAGENT_ACCEPTANCE_HIDDEN: input.hidden === false ? "0" : "1",
          ENDURAGENT_ACCEPTANCE_CREDENTIAL_BACKEND: "memory",
          ENDURAGENT_DISPOSABLE_SAFE_STORAGE_CONTEXT: "1",
          FORCE_COLOR: undefined,
          NO_COLOR: undefined,
          CLICOLOR_FORCE: undefined,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child = nextChild;
    if (nextChild.pid !== undefined) processIds.add(nextChild.pid);
    nextChild.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    nextChild.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const debuggerUrl = await waitForPage(debuggerPort, {
      timeoutMs: DESKTOP_FIXTURE_LAUNCH_TIMEOUT_MS,
    });
    if (mainDebuggerPort !== undefined) {
      const deadline = Date.now() + DESKTOP_FIXTURE_LAUNCH_TIMEOUT_MS;
      let mainDebuggerUrl: string | undefined;
      while (Date.now() < deadline && mainDebuggerUrl === undefined) {
        try {
          const response = await fetch(`http://127.0.0.1:${mainDebuggerPort}/json/list`, {
            signal: AbortSignal.timeout(1_000),
          });
          if (response.ok) {
            const entries = (await response.json()) as readonly {
              readonly webSocketDebuggerUrl?: unknown;
            }[];
            const target = entries.find((entry) => typeof entry.webSocketDebuggerUrl === "string");
            if (target !== undefined) mainDebuggerUrl = target.webSocketDebuggerUrl as string;
          }
        } catch {}
        if (mainDebuggerUrl === undefined) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
        }
      }
      if (mainDebuggerUrl === undefined) throw new Error("timed out waiting for desktop main");
      mainCdp = await connectCdp(mainDebuggerUrl, () => {});
      await mainCdp.call("Runtime.enable");
    }
    const nextCdp = await connectCdp(debuggerUrl, (message) => {
      if (message.method !== "Runtime.consoleAPICalled") return;
      const args =
        (message.params as { readonly args?: readonly { readonly value?: unknown }[] } | undefined)
          ?.args ?? [];
      consoleMessages.push(args.map((arg) => String(arg.value ?? "")).join(" "));
    });
    cdp = nextCdp;
    const setup = [
      nextCdp.call("Runtime.enable"),
      nextCdp.call("Page.enable"),
      nextCdp.call("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-color-scheme", value: input.colorScheme },
          {
            name: "prefers-reduced-motion",
            value: input.reducedMotion ? "reduce" : "no-preference",
          },
        ],
      }),
    ];
    if (input.hidden !== false) {
      setup.push(
        nextCdp.call("Emulation.setDeviceMetricsOverride", {
          width: input.width,
          height: input.height,
          deviceScaleFactor: 1,
          mobile: false,
        }),
      );
    }
    await Promise.all(setup);
    await refreshSurfaces();
  };
  const cleanupFixture = async (): Promise<void> => {
    await stopApplication();
    await bridge.close();
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  let closed = false;
  try {
    await launchApplication();
  } catch (error) {
    closed = true;
    await cleanupFixture();
    throw error;
  }
  return {
    get remoteDebuggingUrl() {
      if (closed || remoteDebuggingUrl === undefined) {
        throw new Error("desktop fixture debugger is unavailable");
      }
      return remoteDebuggingUrl;
    },
    paths: {
      athleteHome,
      configPath: join(configDir, "config.yaml"),
      userData,
      desktopPreferences,
      sessionTimezonePinPath: sessionTimezonePinFile,
    },
    async evaluate<T>(source: string): Promise<T> {
      if (closed || cdp === undefined) throw new Error("desktop fixture is closed");
      const response = await cdp.call("Runtime.evaluate", {
        expression: `(async () => { ${source} })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      const exception = response.exceptionDetails as
        | { readonly text?: unknown; readonly exception?: { readonly description?: unknown } }
        | undefined;
      if (exception !== undefined) {
        await refreshSurfaces();
        throw new Error(
          String(exception.exception?.description ?? exception.text ?? "evaluation failed"),
        );
      }
      const remote = response.result as
        | { readonly value?: unknown; readonly description?: unknown }
        | undefined;
      if (remote?.description !== undefined && remote.value === undefined) {
        throw new Error(String(remote.description));
      }
      await refreshSurfaces();
      return remote?.value as T;
    },
    async evaluateMain<T>(source: string): Promise<T> {
      if (closed || mainCdp === undefined) throw new Error("desktop main inspection is disabled");
      const response = await mainCdp.call("Runtime.evaluate", {
        expression: `(async () => { ${source} })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      const exception = response.exceptionDetails as
        | { readonly text?: unknown; readonly exception?: { readonly description?: unknown } }
        | undefined;
      if (exception !== undefined) {
        throw new Error(
          String(exception.exception?.description ?? exception.text ?? "main evaluation failed"),
        );
      }
      const remote = response.result as
        | { readonly value?: unknown; readonly description?: unknown }
        | undefined;
      if (remote?.description !== undefined && remote.value === undefined) {
        throw new Error(String(remote.description));
      }
      return remote?.value as T;
    },
    async dropFiles(selector, paths) {
      if (closed || cdp === undefined) throw new Error("desktop fixture is closed");
      const inputId = `desktop-fixture-files-${process.pid}`;
      await cdp.call("Runtime.evaluate", {
        expression: `(() => {
          const input = document.createElement("input");
          input.type = "file";
          input.multiple = true;
          input.id = ${JSON.stringify(inputId)};
          document.body.append(input);
        })()`,
      });
      const documentResult = await cdp.call("DOM.getDocument");
      const root = documentResult.root as { readonly nodeId?: unknown } | undefined;
      if (typeof root?.nodeId !== "number") throw new Error("desktop document is unavailable");
      const queryResult = await cdp.call("DOM.querySelector", {
        nodeId: root.nodeId,
        selector: `#${inputId}`,
      });
      if (typeof queryResult.nodeId !== "number" || queryResult.nodeId === 0) {
        throw new Error("desktop file input is unavailable");
      }
      await cdp.call("DOM.setFileInputFiles", { nodeId: queryResult.nodeId, files: [...paths] });
      await cdp.call("Runtime.evaluate", {
        expression: `(() => {
          const input = document.querySelector(${JSON.stringify(`#${inputId}`)});
          const target = document.querySelector(${JSON.stringify(selector)});
          if (!(input instanceof HTMLInputElement) || !(target instanceof Element)) {
            throw new Error("desktop drop target is unavailable");
          }
          const transfer = new DataTransfer();
          for (const file of input.files ?? []) transfer.items.add(file);
          target.dispatchEvent(new DragEvent("dragover", {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
          }));
          target.dispatchEvent(new DragEvent("drop", {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
          }));
          input.remove();
        })()`,
      });
      await refreshSurfaces();
    },
    async relaunch(beforeLaunch) {
      if (closed) throw new Error("desktop fixture is closed");
      try {
        await stopApplication();
        await beforeLaunch?.();
        await launchApplication();
      } catch (error) {
        closed = true;
        await cleanupFixture();
        throw error;
      }
    },
    async screenshot(path: string) {
      if (closed || cdp === undefined) throw new Error("desktop fixture is closed");
      const response = await cdp.call("Page.captureScreenshot", { format: "png" });
      const data = response.data;
      if (typeof data !== "string") throw new TypeError("desktop screenshot was not returned");
      await writeFile(path, Buffer.from(data, "base64"));
      await refreshSurfaces();
    },
    async setViewport(width: number, height: number) {
      if (closed || cdp === undefined) throw new Error("desktop fixture is closed");
      await cdp.call("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await refreshSurfaces();
    },
    async pressKey(key, options) {
      if (closed || cdp === undefined) throw new Error("desktop fixture is closed");
      const virtualKeyCode = key === "Tab" ? 9 : key === "Escape" ? 27 : 86;
      const code = key === "Tab" ? "Tab" : key === "Escape" ? "Escape" : "KeyV";
      const modifiers = (options?.shift === true ? 8 : 0) | (options?.meta === true ? 4 : 0);
      await cdp.call("Input.dispatchKeyEvent", {
        type: "keyDown",
        key,
        code,
        windowsVirtualKeyCode: virtualKeyCode,
        nativeVirtualKeyCode: virtualKeyCode,
        modifiers,
        ...(key === "v" && options?.meta === true ? { commands: ["Paste"] } : {}),
      });
      await cdp.call("Input.dispatchKeyEvent", {
        type: "keyUp",
        key,
        code,
        windowsVirtualKeyCode: virtualKeyCode,
        nativeVirtualKeyCode: virtualKeyCode,
        modifiers,
      });
      await refreshSurfaces();
    },
    readCapturedSurface(name) {
      if (name === "stdout") return stdout;
      if (name === "stderr") return stderr;
      return surfaces[name];
    },
    async close() {
      if (closed) return { livePids: [], listenerCount: 0 };
      closed = true;
      await cleanupFixture();
      const livePids = [...processIds].filter(processAlive);
      return { livePids, listenerCount: 0 };
    },
  };
}
