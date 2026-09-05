import { createUtilityOAuthClient, isOAuthResponse } from "./oauth-protocol.js";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Readable, Writable } from "node:stream";
import { EXIT_AGENT_ERROR, type ExitCode } from "@enduragent/coach-contract";
import {
  runAppSupervisedEnduragent,
  type AppSupervisedEnduragentResult,
  type EnduragentDependencies,
} from "@enduragent/coach/enduragent";
import { UTILITY_TERMINAL_ACK_TIMEOUT_MS } from "../main/constants.js";
import { createUtilityTerminalFrame, isDesktopAppVersion } from "./protocol.js";

const parentPort = process.parentPort;

type UtilityStartFrame = {
  readonly type: "start";
  readonly homeRoot: string;
  readonly appVersion: string;
  readonly handoffCapability?: string;
};
function startFrame(value: unknown): UtilityStartFrame | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const optionalCapability = keys.length === 4 && keys[1] === "handoffCapability";
  if (
    record.type !== "start" ||
    typeof record.homeRoot !== "string" ||
    !isAbsolute(record.homeRoot) ||
    !isDesktopAppVersion(record.appVersion) ||
    (!optionalCapability &&
      (keys.length !== 3 ||
        keys[0] !== "appVersion" ||
        keys[1] !== "homeRoot" ||
        keys[2] !== "type")) ||
    (optionalCapability &&
      (keys[0] !== "appVersion" ||
        keys[2] !== "homeRoot" ||
        keys[3] !== "type" ||
        typeof record.handoffCapability !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(record.handoffCapability)))
  ) {
    return undefined;
  }
  return {
    type: "start",
    homeRoot: record.homeRoot,
    appVersion: record.appVersion,
    ...(optionalCapability ? { handoffCapability: record.handoffCapability as string } : {}),
  };
}

function exactFrame(value: unknown, type: "shutdown" | "terminal-ack"): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    (value as { readonly type?: unknown }).type === type
  );
}

async function postTerminalAndWait(result: AppSupervisedEnduragentResult): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      parentPort.removeListener("message", onMessage);
      resolve();
    };
    const onMessage = (event: Electron.MessageEvent): void => {
      if (exactFrame(event.data, "terminal-ack")) finish();
    };
    const timer = setTimeout(finish, UTILITY_TERMINAL_ACK_TIMEOUT_MS);
    parentPort.on("message", onMessage);
    parentPort.postMessage(createUtilityTerminalFrame(result));
  });
}

async function runtimeSmoke(): Promise<ExitCode> {
  const base = await realpath(tmpdir());
  const directory = await mkdtemp(join(base, "enduragent-desktop-runtime-"));
  try {
    const database = new DatabaseSync(join(directory, "runtime.db"));
    database.exec(
      "PRAGMA journal_mode=WAL; CREATE VIRTUAL TABLE notes USING fts5(body); INSERT INTO notes(body) VALUES ('tempo threshold');",
    );
    const row = database.prepare("SELECT body FROM notes WHERE notes MATCH 'tempo'").get() as {
      readonly body: string;
    };
    database.close();
    await new Promise<void>((resolveWrite) => {
      process.stdout.write(
        `DESKTOP_RUNTIME_SMOKE ${JSON.stringify({ electron: process.versions.electron, node: process.versions.node, sqlite: process.versions.sqlite, result: row.body, directory })}\n`,
        () => resolveWrite(),
      );
    });
    return 0;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function run(dependencies?: EnduragentDependencies): Promise<void> {
  if (process.argv.includes("--desktop-runtime-smoke")) {
    const exitCode: ExitCode = await runtimeSmoke().catch(() => EXIT_AGENT_ERROR);
    await postTerminalAndWait({ exitCode });
    process.exit(exitCode);
  }
  const controller = new AbortController();
  const oauth = createUtilityOAuthClient({
    send: (request) => parentPort.postMessage(request),
    signal: controller.signal,
  });
  let started = false;
  let finished = false;
  let resolveStart!: (frame: UtilityStartFrame | undefined) => void;
  const firstFrame = new Promise<UtilityStartFrame | undefined>((resolve) => {
    resolveStart = resolve;
  });
  const onMessage = (event: Electron.MessageEvent): void => {
    if (!started) {
      const frame = startFrame(event.data);
      started = true;
      resolveStart(frame);
      return;
    }
    if (isOAuthResponse(event.data)) {
      oauth.receive(event.data);
      return;
    }
    if (exactFrame(event.data, "shutdown")) {
      controller.abort();
      return;
    }
    controller.abort();
  };
  parentPort.on("message", onMessage);
  const frame = await firstFrame;
  let result: AppSupervisedEnduragentResult = { exitCode: EXIT_AGENT_ERROR };
  if (frame !== undefined) {
    const env: Record<string, string | undefined> = {
      ...process.env,
      ENDURAGENT_HOME: frame.homeRoot,
    };
    delete env.ENDURAGENT_DAEMON_OWNER;
    delete env.ENDURAGENT_HANDOFF_CAPABILITY;
    delete env.ENDURAGENT_STARTER_CONTEXT_FD;
    const sink = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    result = await runAppSupervisedEnduragent(
      {
        oauthOwner: oauth.owner,
        env,
        terminal: {
          input: Readable.from([]),
          stdout: sink,
          stderr: sink,
          isTTY: false,
        },
        signal: controller.signal,
        appVersion: frame.appVersion,
        ...(frame.handoffCapability === undefined
          ? {}
          : { handoffCapability: frame.handoffCapability }),
      },
      dependencies,
    );
  }
  if (!finished) {
    finished = true;
  }
  oauth.close();
  parentPort.removeListener("message", onMessage);
  await postTerminalAndWait(result);
  process.exit(result.exitCode);
}

export async function runDaemon(dependencies?: EnduragentDependencies): Promise<void> {
  await run(dependencies).catch(async () => {
    await postTerminalAndWait({ exitCode: EXIT_AGENT_ERROR });
    process.exit(EXIT_AGENT_ERROR);
  });
}
