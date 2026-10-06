import { mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WindowsPrivatePathPolicyError } from "@enduragent/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  durableAtomicReplace,
  durablyReplaceReversible,
} from "../src/main/durable-atomic-replace.js";

const roots: string[] = [];
const durabilityPlatforms = [
  { name: "POSIX", platform: "darwin" },
  { name: "Windows", platform: "win32" },
] as const;

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "enduragent-durable-replace-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable atomic replace", () => {
  it("enforces the requested mode before syncing and publishing the candidate", async () => {
    const root = await temporaryRoot();
    const target = join(root, "setting.json");

    const result = await durableAtomicReplace({
      root,
      fileName: "setting.json",
      contents: "candidate",
      mode: 0o600,
      createId: () => "restrictive-creation-mode",
      openFile: ((path, flags) => open(path, flags, 0o000)) as typeof open,
    });

    expect(result).toEqual({ state: "durably-committed" });
    if (process.platform === "win32") {
      await expect(readFile(target, "utf8")).resolves.toBe("candidate");
    } else {
      expect((await stat(target)).mode & 0o777).toBe(0o600);
    }
  });

  it.each(durabilityPlatforms)(
    "reports the $name pre-commit outcome when temporary creation fails",
    async ({ platform }) => {
      const root = await temporaryRoot();
      const target = join(root, "setting.json");
      await writeFile(target, "old", { mode: 0o600 });
      const removeFile = vi.fn(async () => undefined);

      const replacement = durableAtomicReplace({
        root,
        fileName: "setting.json",
        contents: "candidate",
        mode: 0o600,
        platform,
        createId: () => "create-failure",
        openFile: vi.fn(async () => {
          throw new TypeError("synthetic temporary create failure");
        }) as never,
        removeFile: removeFile as never,
      });

      if (platform === "win32") {
        await expect(replacement).rejects.toMatchObject({
          message: "Windows private path policy failed",
          stage: "content-write",
        });
      } else {
        await expect(replacement).resolves.toEqual({ state: "not-committed" });
      }
      await expect(readFile(target, "utf8")).resolves.toBe("old");
      expect(removeFile).toHaveBeenCalledWith(join(root, ".setting.json.create-failure.tmp"), {
        force: true,
      });
    },
  );

  it.each(durabilityPlatforms)(
    "reports the $name pre-commit outcome when writing the temporary file fails",
    async ({ platform }) => {
      const root = await temporaryRoot();
      const target = join(root, "setting.json");
      await writeFile(target, "old", { mode: 0o600 });
      const close = vi.fn(async () => undefined);
      const sync = vi.fn(async () => undefined);

      const replacement = durableAtomicReplace({
        root,
        fileName: "setting.json",
        contents: "candidate",
        mode: 0o600,
        platform,
        createId: () => "write-failure",
        openFile: (async (path, flags, mode) => {
          const handle = await open(path, flags, mode);
          return new Proxy(handle, {
            get(target, property) {
              if (property === "sync") return sync;
              if (property === "writeFile") {
                return async () => {
                  throw new TypeError("synthetic temporary write failure");
                };
              }
              if (property === "close") {
                return async () => {
                  await close();
                  await handle.close();
                };
              }
              const value = Reflect.get(target, property);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        }) as typeof open,
      });

      if (platform === "win32") {
        await expect(replacement).rejects.toMatchObject({
          message: "Windows private path policy failed",
          stage: "content-write",
        });
      } else {
        await expect(replacement).resolves.toEqual({ state: "not-committed" });
        expect(sync).not.toHaveBeenCalled();
      }
      await expect(readFile(target, "utf8")).resolves.toBe("old");
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it.each(durabilityPlatforms)(
    "reports the $name pre-commit outcome when syncing the temporary file fails",
    async ({ platform }) => {
      const root = await temporaryRoot();
      const target = join(root, "setting.json");
      await writeFile(target, "old", { mode: 0o600 });
      const close = vi.fn(async () => undefined);
      const sync = vi.fn(async () => {
        throw new TypeError("synthetic temporary file sync failure");
      });

      const replacement = durableAtomicReplace({
        root,
        fileName: "setting.json",
        contents: "candidate",
        mode: 0o600,
        platform,
        createId: () => "file-sync-failure",
        openFile: (async (path, flags, mode) => {
          const handle = await open(path, flags, mode);
          return new Proxy(handle, {
            get(target, property) {
              if (property === "sync") return sync;
              if (property === "close") {
                return async () => {
                  await close();
                  await handle.close();
                };
              }
              const value = Reflect.get(target, property);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        }) as typeof open,
      });

      if (platform === "win32") {
        await expect(replacement).rejects.toMatchObject({
          message: "Windows private path policy failed",
          stage: "file-flush",
        });
      } else {
        await expect(replacement).resolves.toEqual({ state: "not-committed" });
      }
      await expect(readFile(target, "utf8")).resolves.toBe("old");
      expect(sync).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it.each(durabilityPlatforms)(
    "keeps the $name pre-rename outcome from masking an unexpected temporary cleanup failure",
    async ({ platform }) => {
      const root = await temporaryRoot();
      const target = join(root, "setting.json");
      const temporary = join(root, ".setting.json.cleanup-failure.tmp");
      await writeFile(target, "old", { mode: 0o600 });
      const removeFile = vi.fn(async () => {
        throw new TypeError("synthetic temporary cleanup failure");
      });

      const replacement = durableAtomicReplace({
        root,
        fileName: "setting.json",
        contents: "candidate",
        mode: 0o600,
        platform,
        createId: () => "cleanup-failure",
        renameFile: async () => {
          throw new TypeError("synthetic rename failure");
        },
        removeFile: removeFile as never,
      });

      await expect(replacement).rejects.toMatchObject({
        message: "synthetic temporary cleanup failure",
      });
      await expect(readFile(target, "utf8")).resolves.toBe("old");
      await expect(readFile(temporary, "utf8")).resolves.toBe("candidate");
      expect(removeFile).toHaveBeenCalledWith(temporary, { force: true });
    },
  );

  it.each(durabilityPlatforms)(
    "reports the $name outcome when rename published the candidate but directory sync failed",
    async ({ platform }) => {
      const root = await temporaryRoot();
      const target = join(root, "setting.json");
      await writeFile(target, "old", { mode: 0o600 });

      const result = await durableAtomicReplace({
        root,
        fileName: "setting.json",
        contents: Buffer.from("candidate"),
        mode: 0o600,
        platform,
        createId: () => "uncertain",
        syncDirectory: async () => {
          throw new TypeError("synthetic directory sync failure");
        },
      });

      expect(result).toEqual({
        state: platform === "win32" ? "durably-committed" : "commit-uncertain",
      });
      await expect(readFile(target, "utf8")).resolves.toBe("candidate");
      const directory = await open(root, "r");
      await directory.close();
    },
  );

  it.each(durabilityPlatforms)(
    "distinguishes the $name pre-rename outcome from a durable replacement",
    async ({ platform }) => {
      const root = await temporaryRoot();
      const target = join(root, "setting.json");
      await writeFile(target, "old", { mode: 0o600 });
      const refused = durableAtomicReplace({
        root,
        fileName: "setting.json",
        contents: "candidate",
        mode: 0o600,
        platform,
        createId: () => "refused",
        renameFile: async () => {
          throw new TypeError("synthetic rename failure");
        },
        syncDirectory: async () => undefined,
      });
      if (platform === "win32") {
        await expect(refused).rejects.toMatchObject({
          message: "Windows private path policy failed",
          stage: "rename",
        });
      } else {
        await expect(refused).resolves.toEqual({ state: "not-committed" });
      }
      await expect(readFile(target, "utf8")).resolves.toBe("old");

      const committed = await durableAtomicReplace({
        root,
        fileName: "setting.json",
        contents: "candidate",
        mode: 0o600,
        platform,
        createId: () => "committed",
        syncDirectory: async () => undefined,
      });
      expect(committed).toEqual({ state: "durably-committed" });
      await expect(readFile(target, "utf8")).resolves.toBe("candidate");
    },
  );

  it.each(durabilityPlatforms)(
    "surfaces an unexpected $name directory-close failure after a durable rename",
    async ({ platform }) => {
      const root = await temporaryRoot();
      const close = vi.fn(async () => {
        throw new TypeError("synthetic close failure");
      });
      const result = durableAtomicReplace({
        root,
        fileName: "setting.json",
        contents: "candidate",
        mode: 0o600,
        platform,
        createId: () => "close-failure",
        openDirectory: vi.fn(async () => ({ sync: async () => {}, close })) as never,
      });

      if (platform === "win32") {
        await expect(result).resolves.toEqual({ state: "durably-committed" });
        expect(close).not.toHaveBeenCalled();
      } else {
        await expect(result).resolves.toEqual({ state: "commit-uncertain" });
        expect(close).toHaveBeenCalledOnce();
      }
    },
  );

  it.each(durabilityPlatforms)(
    "resolves the $name uncertain replacement against the prior bytes",
    async ({ platform }) => {
      const root = await temporaryRoot();
      const target = join(root, "setting.json");
      const prior = Buffer.from("old");
      const candidate = Buffer.from("candidate");
      await writeFile(target, prior, { mode: 0o600 });
      let syncCount = 0;

      const result = await durablyReplaceReversible({
        root,
        fileName: "setting.json",
        contents: candidate,
        previousContents: prior,
        mode: 0o600,
        platform,
        createId: () => `attempt-${syncCount}`,
        renameFile: rename,
        syncDirectory: async () => {
          syncCount += 1;
          if (syncCount === 1) throw new TypeError("synthetic first directory sync failure");
        },
      });

      expect(result).toEqual({ state: platform === "win32" ? "applied" : "refused" });
      await expect(readFile(target, "utf8")).resolves.toBe(
        platform === "win32" ? "candidate" : "old",
      );
    },
  );

  it.each(durabilityPlatforms)(
    "returns the $name result without requesting a second id after the candidate became visible",
    async ({ platform }) => {
      const root = await temporaryRoot();
      const target = join(root, "setting.json");
      await writeFile(target, "old", { mode: 0o600 });
      let idCalls = 0;

      const result = await durablyReplaceReversible({
        root,
        fileName: "setting.json",
        contents: "candidate",
        previousContents: Buffer.from("old"),
        mode: 0o600,
        platform,
        createId: () => {
          idCalls += 1;
          if (idCalls === 1) return "initial";
          throw new TypeError("synthetic compensation id failure");
        },
        syncDirectory: async () => {
          throw new TypeError("synthetic directory sync failure");
        },
      });

      expect(result).toEqual({ state: platform === "win32" ? "applied" : "uncertain" });
      if (platform === "win32") {
        await expect(readFile(target, "utf8")).resolves.toBe("candidate");
      } else {
        expect(["old", "candidate"]).toContain(await readFile(target, "utf8"));
      }
      expect(idCalls).toBe(1);
    },
  );

  it.each(durabilityPlatforms)(
    "reuses one $name operation id while first-write convergence cleans its tombstone",
    async ({ platform }) => {
      const root = await temporaryRoot();
      const target = join(root, "setting.json");
      let syncCount = 0;
      let idCount = 0;

      const result = await durablyReplaceReversible({
        root,
        fileName: "setting.json",
        contents: "candidate",
        previousContents: undefined,
        mode: 0o600,
        platform,
        createId: () => `operation-${++idCount}`,
        syncDirectory: async () => {
          syncCount += 1;
          if (syncCount <= 2) throw new TypeError("synthetic directory sync failure");
        },
      });

      expect(result).toEqual({ state: platform === "win32" ? "applied" : "refused" });
      if (platform === "win32") {
        await expect(readFile(target, "utf8")).resolves.toBe("candidate");
      } else {
        await expect(readFile(target, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect((await readdir(root)).filter((entry) => entry.endsWith(".deleted"))).toEqual([]);
      expect(idCount).toBe(1);
    },
  );

  it("uses the Windows durability taxonomy without chmod or directory sync", async () => {
    const root = await temporaryRoot();
    const synchronizeDirectory = vi.fn(async () => {
      throw new TypeError("Windows directory sync must stay unavailable");
    });
    const chmod = vi.fn(async () => {
      throw new TypeError("Windows must not apply a POSIX mode");
    });

    const result = await durableAtomicReplace({
      root,
      fileName: "setting.json",
      contents: "candidate",
      mode: 0o600,
      platform: "win32",
      createId: () => "windows-write",
      openFile: (async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        return new Proxy(handle, {
          get(target, property) {
            if (property === "chmod") return chmod;
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      }) as typeof open,
      syncDirectory: synchronizeDirectory,
    });

    expect(result).toEqual({ state: "durably-committed" });
    await expect(readFile(join(root, "setting.json"), "utf8")).resolves.toBe("candidate");
    expect(chmod).not.toHaveBeenCalled();
    expect(synchronizeDirectory).not.toHaveBeenCalled();
  });

  it("surfaces a path-free Windows sharing failure at the rename stage", async () => {
    const root = await temporaryRoot();
    const failure = Object.assign(new Error(`${root} synthetic-secret`), { code: "EBUSY" });
    let observed: unknown;

    try {
      await durableAtomicReplace({
        root,
        fileName: "setting.json",
        contents: "candidate",
        mode: 0o600,
        platform: "win32",
        createId: () => "windows-sharing",
        renameFile: async () => {
          throw failure;
        },
      });
    } catch (error) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(WindowsPrivatePathPolicyError);
    expect(observed).toMatchObject({
      message: "Windows private path policy failed",
      stage: "rename",
      category: "sharing-violation",
    });
    expect(JSON.stringify(observed)).not.toContain(root);
    expect(JSON.stringify(observed)).not.toContain("synthetic-secret");
  });
});
