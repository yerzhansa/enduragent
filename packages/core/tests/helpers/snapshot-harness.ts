import { exec, execSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "../../../..");
export const SECTION_11_REPO = process.env.SECTION_11_REPO ?? resolve(REPO_ROOT, "../section-11");

const execAsync = promisify(exec);

export function section11Available(): boolean {
  try {
    statSync(join(SECTION_11_REPO, "examples/sync.py"));
    return true;
  } catch {
    return false;
  }
}

export interface HarnessRunOptions {
  outDir: string;
  fixturePath?: string;
}

export interface HarnessRunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function harnessEnv(opts: HarnessRunOptions): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SNAPSHOT_OUT_DIR: opts.outDir,
    SECTION_11_REPO,
    ...(opts.fixturePath ? { SNAPSHOT_FIXTURE_PATH: opts.fixturePath } : {}),
  };
}

export function runHarness(opts: HarnessRunOptions): void {
  execSync("pnpm snapshot:section-11", {
    cwd: REPO_ROOT,
    env: harnessEnv(opts),
    stdio: "pipe",
  });
}

export function tryRunHarness(opts: HarnessRunOptions): HarnessRunResult {
  try {
    const stdout = execSync("pnpm snapshot:section-11", {
      cwd: REPO_ROOT,
      env: harnessEnv(opts),
      stdio: "pipe",
      encoding: "utf8",
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: e.status ?? -1,
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? ""),
    };
  }
}

export async function runHarnessAsync(opts: HarnessRunOptions): Promise<void> {
  await execAsync("pnpm snapshot:section-11", {
    cwd: REPO_ROOT,
    env: harnessEnv(opts),
  });
}
