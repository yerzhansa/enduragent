import { randomBytes as nodeRandomBytes } from "node:crypto";
import { dirname } from "node:path";
import { chmod, mkdir, open, readFile, readdir, rename, stat, unlink, rm } from "node:fs/promises";
import type { FileSystemPort } from "@enduragent/kernel/ports";
import { ensureWindowsPrivateDirectory } from "../home/windows-home-policy.js";
import { createFitDecoder } from "../ingest/fit-decoder.js";
import { parseXmlBytes } from "../ingest/xml-file.js";

export function nodeFileSystem(): FileSystemPort {
  return {
    async readFile(path) {
      return new Uint8Array(await readFile(path));
    },
    async readTextFile(path) {
      return readFile(path, "utf8");
    },
    async writeFile(path, data, options) {
      const temporary = `${path}.tmp.${nodeRandomBytes(4).toString("hex")}`;
      let handle: Awaited<ReturnType<typeof open>> | null = null;
      try {
        await mkdir(dirname(path), { recursive: true });
        handle = await open(temporary, "w", options?.mode ?? 0o600);
        await handle.writeFile(typeof data === "string" ? data : Buffer.from(data));
        await handle.sync();
        await handle.close();
        handle = null;
        await rename(temporary, path);
      } catch (error) {
        if (handle !== null) {
          try {
            await handle.close();
          } catch (closeError) {
            if (!(typeof closeError === "object" && closeError !== null && "code" in closeError && (String(closeError.code) === "EBADF" || String(closeError.code) === "ERR_DIR_CLOSED"))) throw closeError;
          }
        }
        await rm(temporary, { force: true });
        throw error;
      }
    },
    async rename(from, to) {
      await rename(from, to);
    },
    async mkdir(path, options) {
      await mkdir(path, { recursive: options?.recursive ?? false });
    },
    async list(path) {
      return (await readdir(path, { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        kind: entry.isFile()
          ? ("file" as const)
          : entry.isDirectory()
            ? ("directory" as const)
            : ("other" as const),
      }));
    },
    async stat(path) {
      try {
        const value = await stat(path);
        return {
          kind: value.isFile() ? "file" : value.isDirectory() ? "directory" : "other",
          size: value.size,
          mtimeMs: value.mtimeMs,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
  };
}

export async function ensurePrivateDirectory(
  path: string,
  options: { readonly platform?: NodeJS.Platform } = {},
): Promise<void> {
  if ((options.platform ?? process.platform) === "win32") {
    await ensureWindowsPrivateDirectory(path);
    return;
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

export async function removeFileIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

export function createNodeFileStructuralValidator(): (input: {
  readonly bytes: Uint8Array;
  readonly ext: "fit" | "tcx" | "gpx";
}) => Promise<void> {
  return async (input) => {
    try {
      if (
        input === null ||
        typeof input !== "object" ||
        !(input.bytes instanceof Uint8Array) ||
        (input.ext !== "fit" && input.ext !== "tcx" && input.ext !== "gpx")
      ) {
        throw new TypeError("file failed structural validation");
      }
      if (input.ext === "fit") {
        await createFitDecoder().decode(input.bytes);
      } else if (parseXmlBytes(input.bytes, input.ext).quarantine !== null) {
        throw new TypeError("file failed structural validation");
      }
    } catch {
      throw new TypeError("file failed structural validation");
    }
  };
}
