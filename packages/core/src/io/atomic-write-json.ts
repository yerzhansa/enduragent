import { open, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import {
  classifyWindowsPrivatePathFailure,
  type WindowsPrivatePathPolicyStage,
} from "./windows-private-path-policy.js";

const commitQueues = new Map<string, Promise<void>>();

export async function enqueueCommit<T>(path: string, task: () => Promise<T>): Promise<T> {
  const prev = commitQueues.get(path) ?? Promise.resolve();
  const run = prev.then(task);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  commitQueues.set(path, settled);
  void settled.then(() => {
    if (commitQueues.get(path) === settled) commitQueues.delete(path);
  });
  return run;
}

export async function atomicWriteJson(
  path: string,
  value: unknown,
  opts?: { signal?: AbortSignal; platform?: NodeJS.Platform },
): Promise<void> {
  const body = JSON.stringify(value, null, 2) + "\n";

  const suffix = randomBytes(4).toString("hex");
  const tempPath = `${path}.tmp.${suffix}`;

  let fh: Awaited<ReturnType<typeof open>> | null = null;
  let stage: WindowsPrivatePathPolicyStage = "content-write";
  try {
    fh = await open(tempPath, "w", 0o600);
    await fh.writeFile(body, "utf-8");
    stage = "file-flush";
    await fh.sync();
    await fh.close();
    fh = null;
    stage = "rename";
    const committed = await enqueueCommit(path, async () => {
      if (opts?.signal?.aborted === true) return false;
      await rename(tempPath, path);
      return true;
    });
    if (!committed) {
      await rm(tempPath, { force: true });
      return;
    }
  } catch (err) {
    if (fh !== null) {
      try {
        await fh.close();
      } catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error && (String(error.code) === "EBADF" || String(error.code) === "ERR_DIR_CLOSED"))) throw error;
      }
    }
    await rm(tempPath, { force: true });
    throw (opts?.platform ?? process.platform) === "win32"
      ? classifyWindowsPrivatePathFailure(stage, err)
      : err;
  }
}
