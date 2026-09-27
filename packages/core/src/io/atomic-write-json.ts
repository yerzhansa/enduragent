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

/**
 * Atomically write a JSON-serialized value to `path` via write-to-temp +
 * fsync + rename. A process kill between open and rename leaves the prior
 * file intact — `safeReadJson` returns either the old or the new content,
 * never a truncated splice. Reference always writes through this helper;
 * never `writeFileSync(path, JSON.stringify(...))` directly.
 *
 * On failure, the temp sibling is best-effort unlinked and the error is
 * rethrown. The on-disk target at `path` is untouched on every failure path
 * because rename is the last step.
 */
export async function atomicWriteJson(
  path: string,
  value: unknown,
  opts?: { signal?: AbortSignal; platform?: NodeJS.Platform },
): Promise<void> {
  // Serialize FIRST so circular-reference / BigInt failures don't leave a
  // half-baked temp file on disk.
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
    // Check the abort signal at the LAST instant before commit. A sync cycle
    // whose outer timeout fired has already force-released the mutex to its
    // successor; renaming this dead cycle's payload in now would replace the
    // live file mid-successor-cycle. So if aborted, drop the temp sibling and
    // return cleanly — the skip is a successful no-op, not an error. Checking
    // earlier would race the abort against the in-flight writeFile/sync.
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
