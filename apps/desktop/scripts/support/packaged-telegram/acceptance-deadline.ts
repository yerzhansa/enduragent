import { spawn, type ChildProcess } from "node:child_process";

export interface AcceptanceCommandResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

interface AcceptanceDeadlineOptions {
  readonly timeoutMs: number;
  readonly onTimeout?: () => void;
}

interface AcceptanceCommandOptions {
  readonly input?: Buffer | string;
  readonly allowFailure?: boolean;
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly terminationGraceMs?: number;
}

interface AcceptanceChildTerminationOptions {
  readonly terminationGraceMs?: number;
  readonly killGraceMs?: number;
}

interface AcceptanceCdpConnection {
  readonly socket: { close(): void };
  call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

function positiveMilliseconds(value: number, description: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${description} is invalid`);
  }
  return value;
}

export async function withAcceptanceDeadline<T>(
  description: string,
  operation: Promise<T>,
  options: AcceptanceDeadlineOptions,
): Promise<T> {
  const timeoutMs = positiveMilliseconds(options.timeoutMs, "acceptance deadline");
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      try {
        options.onTimeout?.();
      } catch {}
      reject(new Error(`${description} timed out`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function runAcceptanceCommand(
  command: string,
  args: readonly string[],
  options: AcceptanceCommandOptions = {},
): Promise<AcceptanceCommandResult> {
  const timeoutMs = positiveMilliseconds(options.timeoutMs ?? 10_000, "command timeout");
  const terminationGraceMs = positiveMilliseconds(
    options.terminationGraceMs ?? 500,
    "command termination grace",
  );
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      env: options.environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let abandonTimer: NodeJS.Timeout | undefined;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        child.kill("SIGKILL");
        abandonTimer = setTimeout(() => finish(new Error("command timed out")), terminationGraceMs);
      }, terminationGraceMs);
    }, timeoutMs);
    const clearTimers = (): void => {
      clearTimeout(timeoutTimer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      if (abandonTimer !== undefined) clearTimeout(abandonTimer);
    };
    const finish = (error: Error | undefined, result?: AcceptanceCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (error !== undefined) rejectRun(error);
      else resolveRun(result as AcceptanceCommandResult);
    };
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on("error", () => undefined);
    child.once("error", () => finish(new Error("command could not start")));
    child.once("close", (code, signal) => {
      if (timedOut) {
        finish(new Error("command timed out"));
        return;
      }
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      };
      if (!options.allowFailure && (code !== 0 || signal !== null)) {
        finish(new Error("command failed"));
      } else {
        finish(undefined, result);
      }
    });
    try {
      child.stdin.end(options.input);
    } catch {
      child.kill("SIGKILL");
      finish(new Error("command input failed"));
    }
  });
}

export async function terminateAcceptanceChild(
  child: ChildProcess,
  options: AcceptanceChildTerminationOptions = {},
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  const terminationGraceMs = positiveMilliseconds(
    options.terminationGraceMs ?? 2_000,
    "child termination grace",
  );
  const killGraceMs = positiveMilliseconds(options.killGraceMs ?? 2_000, "child kill grace");
  const exited = new Promise<true>((resolveExit) => child.once("exit", () => resolveExit(true)));
  child.kill("SIGTERM");
  const terminated = await withAcceptanceDeadline("child termination", exited, {
    timeoutMs: terminationGraceMs,
  }).catch(() => false as const);
  if (terminated) return true;
  child.kill("SIGKILL");
  return withAcceptanceDeadline("child kill", exited, { timeoutMs: killGraceMs }).catch(
    () => false as const,
  );
}

export function callAcceptanceCdp(
  connection: AcceptanceCdpConnection,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
  return withAcceptanceDeadline("Desktop debugger command", connection.call(method, params), {
    timeoutMs,
    onTimeout: () => connection.socket.close(),
  });
}
