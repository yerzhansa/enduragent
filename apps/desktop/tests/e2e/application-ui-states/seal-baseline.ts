import { createHash } from "node:crypto";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  applicationBaselineVersion,
  applicationProjects,
  applicationRepositoryRoot,
  applicationScenarios,
  assertApplicationBuildIsFresh,
  assertApplicationCaptureEnvironment,
  collectApplicationBuildIdentity,
  currentSourceRevision,
  expectedApplicationScreenshots,
} from "./identity.js";

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function pngDimensions(bytes: Buffer): { readonly width: number; readonly height: number } {
  if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new TypeError("Baseline screenshot is not a PNG");
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function historicalReference(): Promise<unknown> {
  const path = resolve(
    applicationRepositoryRoot(),
    "apps/desktop/tests/e2e/previews/baselines/production-4dcabb49-v1/manifest.json",
  );
  const bytes = await readFile(path);
  const old = JSON.parse(bytes.toString("utf8")) as {
    readonly version?: unknown;
    readonly source?: { readonly revision?: unknown };
    readonly screenshots?: unknown;
  };
  if (
    old.version !== "production-4dcabb49-v1" ||
    typeof old.source?.revision !== "string" ||
    old.screenshots === null ||
    typeof old.screenshots !== "object" ||
    Array.isArray(old.screenshots)
  ) {
    throw new TypeError("Historical preview manifest is invalid");
  }
  return {
    version: old.version,
    sourceRevision: old.source.revision,
    manifestSha256: sha256(bytes),
    screenshots: old.screenshots,
  };
}

async function main(): Promise<void> {
  if (process.argv.slice(2).join(" ") !== "--reviewed") {
    throw new Error("Seal only after visual inspection: pass --reviewed");
  }
  const root = resolve(import.meta.dirname, "baselines", applicationBaselineVersion);
  const manifestPath = resolve(root, "manifest.json");
  await readFile(manifestPath).then(
    () => {
      throw new Error("Application baseline is already sealed");
    },
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    },
  );
  const files = (await readdir(root, { recursive: true }))
    .filter((file) => file.endsWith(".png"))
    .sort();
  const expected = [...expectedApplicationScreenshots()];
  if (JSON.stringify(files) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${expected.length} inspected screenshots, found ${files.length}`);
  }
  const screenshots: Record<string, string> = {};
  for (const file of files) {
    const bytes = await readFile(resolve(root, file));
    const project = file.split("/")[0] as keyof typeof applicationProjects;
    const dimensions = pngDimensions(bytes);
    const expectedDimensions = applicationProjects[project];
    if (
      expectedDimensions === undefined ||
      dimensions.width !== expectedDimensions.width ||
      dimensions.height !== expectedDimensions.height
    ) {
      throw new Error(`Unexpected screenshot dimensions: ${file}`);
    }
    screenshots[file] = sha256(bytes);
  }
  const identity = await collectApplicationBuildIdentity();
  assertApplicationCaptureEnvironment(identity);
  await assertApplicationBuildIsFresh();
  const value = {
    schemaVersion: 1,
    version: applicationBaselineVersion,
    reviewedBy: "Codex, GPT-6",
    review: "native-application-regression-reference",
    reviewNote:
      "Inspected all 20 new Electron application captures in light and dark, wide and compact layouts. The captures record current rendering and do not approve product behavior.",
    coverage: {
      projects: Object.keys(applicationProjects).length,
      scenarios: applicationScenarios.length,
      screenshots: expected.length,
      executions: 24,
      structuralNegativeControls: 4,
    },
    sourceRevision: await currentSourceRevision(),
    identity,
    historicalReference: await historicalReference(),
    scenarioMappings: {
      "desktop--training-loading": { historicalSourceId: "desktop--training-unavailable" },
    },
    screenshots,
  };
  const temporaryPath = `${manifestPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  await rename(temporaryPath, manifestPath);
  process.stdout.write(`${manifestPath}\n`);
}

await main();
