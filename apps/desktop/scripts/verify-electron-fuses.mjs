import { lstat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FuseState,
  FuseV1Options,
  FuseVersion,
  getCurrentFuseWire,
} from "@electron/fuses";

export const REQUIRED_ELECTRON_FUSES = Object.freeze({
  [FuseV1Options.RunAsNode]: FuseState.DISABLE,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: FuseState.DISABLE,
  [FuseV1Options.EnableNodeCliInspectArguments]: FuseState.DISABLE,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: FuseState.ENABLE,
  [FuseV1Options.OnlyLoadAppFromAsar]: FuseState.ENABLE,
});

export async function verifyElectronFuses(executable, overrides = {}) {
  if (typeof executable !== "string" || !isAbsolute(executable)) {
    throw new Error("Electron executable path must be absolute");
  }
  const entry = await (overrides.lstat ?? lstat)(executable);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error("Electron executable is not a regular file");
  }
  const wire = await (overrides.getCurrentFuseWire ?? getCurrentFuseWire)(executable);
  if (wire.version !== FuseVersion.V1) throw new Error("Electron fuse version is invalid");
  for (const [option, expected] of Object.entries(REQUIRED_ELECTRON_FUSES)) {
    if (wire[Number(option)] !== expected) throw new Error("Electron fuse state is invalid");
  }
  return Object.freeze({ executable, version: wire.version });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [executable] = process.argv.slice(2);
    await verifyElectronFuses(executable);
    process.stdout.write("Electron fuses verified\n");
  } catch {
    process.stderr.write("Electron fuse verification failed\n");
    process.exitCode = 1;
  }
}
