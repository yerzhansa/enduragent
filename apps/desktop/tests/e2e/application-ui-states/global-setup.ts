import type { FullConfig } from "@playwright/test";
import { createHash } from "node:crypto";
import { deepStrictEqual } from "node:assert";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  applicationBaselineVersion,
  assertApplicationBuildIsFresh,
  assertApplicationCaptureEnvironment,
  collectApplicationBuildIdentity,
  expectedApplicationScreenshots,
  type ApplicationBuildIdentity,
  type SourceRevisionIdentity,
} from "./identity.js";

interface BaselineManifest {
  readonly version: string;
  readonly sourceRevision: SourceRevisionIdentity;
  readonly identity: ApplicationBuildIdentity;
  readonly screenshots: Readonly<Record<string, string>>;
}

function manifest(value: unknown): BaselineManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Application baseline manifest must be an object");
  }
  const candidate = value as Partial<BaselineManifest>;
  if (candidate.version !== applicationBaselineVersion) {
    throw new Error("Application baseline version mismatch");
  }
  if (
    candidate.identity === undefined ||
    candidate.screenshots === undefined ||
    candidate.sourceRevision === undefined ||
    !/^[a-f0-9]{40}$/u.test(candidate.sourceRevision.commit) ||
    typeof candidate.sourceRevision.dirty !== "boolean"
  ) {
    throw new TypeError("Application baseline manifest is incomplete");
  }
  return candidate as BaselineManifest;
}

export default async function setup(config: FullConfig): Promise<void> {
  const root = resolve(import.meta.dirname, "baselines", applicationBaselineVersion);
  const manifestPath = resolve(root, "manifest.json");
  const manifestBytes = await readFile(manifestPath).catch(
    (error: NodeJS.ErrnoException): Buffer | null => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  const updating = config.updateSnapshots === "all" || config.updateSnapshots === "changed";
  const current = await collectApplicationBuildIdentity();
  assertApplicationCaptureEnvironment(current);
  await assertApplicationBuildIsFresh();
  if (updating) {
    if (manifestBytes !== null) {
      throw new Error("The reviewed application baseline is frozen; choose a new version");
    }
    return;
  }
  if (manifestBytes === null) {
    throw new Error("Application baseline is unsealed; capture, inspect, and seal it first");
  }
  const sealed = manifest(JSON.parse(manifestBytes.toString("utf8")));
  assertApplicationCaptureEnvironment(sealed.identity);
  deepStrictEqual(current.electron, sealed.identity.electron, "Electron capture runtime changed");
  const files = (await readdir(root, { recursive: true }))
    .filter((file) => file.endsWith(".png"))
    .sort();
  const expected = [...expectedApplicationScreenshots()];
  deepStrictEqual(files, expected, "Application baseline screenshot inventory changed");
  deepStrictEqual(
    Object.keys(sealed.screenshots).sort(),
    expected,
    "Application baseline manifest screenshot inventory changed",
  );
  for (const file of files) {
    const digest = createHash("sha256")
      .update(await readFile(resolve(root, file)))
      .digest("hex");
    if (sealed.screenshots[file] !== digest) {
      throw new Error(`Reviewed application screenshot changed: ${file}`);
    }
  }
}
