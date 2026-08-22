import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { METRIC_REGISTRY } from "@enduragent/kernel/reference/registry";
import { FixtureSchema } from "@enduragent/kernel/reference/schemas";
import * as statistics from "@enduragent/kernel/reference/metrics";
import { deviationMap } from "./self-test-deviations.js";
import {
  buildKeychainBinding,
  copyKeychainBindingToAsarStaging,
} from "./build-keychain-binding.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../../..");
const desktopRoot = resolve(scriptDirectory, "..");
const fixtureRoot = join(repositoryRoot, "packages/core/tests/fixtures");
const outputRoot = join(desktopRoot, "dist");
const asarOutput = join(outputRoot, "self-test-asar");
const runnerOutput = join(outputRoot, "self-test-runner");
const extraOutput = join(outputRoot, "extra-resources");
const temporaryRoot = join(outputRoot, `.self-test-build-${process.pid}`);

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function collectStreams(
  value: unknown,
  path: string,
  streams: Array<{ readonly path: string; readonly values: number[] }>,
): void {
  if (streams.length >= 32) return;
  if (Array.isArray(value)) {
    if (
      path.length > 0 &&
      value.length >= 8 &&
      value.every((item) => typeof item === "number" && Number.isFinite(item))
    ) {
      streams.push({ path, values: value });
      return;
    }
    for (let index = 0; index < value.length; index += 1) {
      collectStreams(value[index], path.length === 0 ? `${index}` : `${path}.${index}`, streams);
      if (streams.length >= 32) return;
    }
    return;
  }
  if (!exactObject(value)) return;
  for (const key of Object.keys(value).sort()) {
    collectStreams(value[key], path.length === 0 ? key : `${path}.${key}`, streams);
    if (streams.length >= 32) return;
  }
}

async function runStage(): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [join(scriptDirectory, "stage-extra-resources.mjs")], {
      cwd: desktopRoot,
      stdio: "inherit",
    });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error("resource staging failed"));
    });
  });
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) throw new Error("arguments are not supported");
  const manifestPath = join(fixtureRoot, "snapshots/manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  if (
    !exactObject(manifest) ||
    !Array.isArray(manifest.fixtures) ||
    manifest.fixtures.length === 0
  ) {
    throw new Error("invalid fixture manifest");
  }
  const fixtures = [...manifest.fixtures];
  if (
    fixtures.some((slug) => typeof slug !== "string" || slug.length === 0) ||
    new Set(fixtures).size !== fixtures.length
  ) {
    throw new Error("invalid fixture manifest");
  }
  fixtures.sort((left, right) => (left as string).localeCompare(right as string));
  const metrics = Object.keys(METRIC_REGISTRY).sort();
  if (metrics.length === 0) throw new Error("empty metric registry");
  const operationNames = ["mean", "pythonSum", "sampleStdev"] as const;
  const statisticsSource = await readFile(
    join(repositoryRoot, "packages/kernel/src/reference/metrics/statistics.ts"),
    "utf8",
  );
  const exportedOperations = [
    ...statisticsSource.matchAll(/export function (\w+)\(values: number\[\]\): number/gu),
  ]
    .map((match) => match[1]!)
    .sort();
  if (
    operationNames.length < 2 ||
    JSON.stringify([...operationNames].sort()) !== JSON.stringify(exportedOperations) ||
    operationNames.some((name) => typeof statistics[name] !== "function")
  ) {
    throw new Error("invalid statistics operations");
  }
  const deviations = deviationMap(
    await readFile(join(repositoryRoot, "tools/intentional-deviations.yaml"), "utf8"),
  );
  const generatedFixtures: Array<{
    readonly slug: string;
    readonly frozenNow: string;
    readonly payloadSha256: string;
    readonly payload: unknown;
  }> = [];
  const parityCases: Array<{
    readonly caseId: string;
    readonly fixture: string;
    readonly metric: string;
    readonly expectedSha256: string;
    readonly expected: unknown;
    readonly ignoredActualPaths: readonly string[];
  }> = [];
  const differentialCases: Array<{
    readonly caseId: string;
    readonly fixture: string;
    readonly streamPath: string;
    readonly op: string;
    readonly length: number;
    readonly streamSha256: string;
  }> = [];
  for (const slugValue of fixtures) {
    const slug = slugValue as string;
    const fixturePath = join(fixtureRoot, "golden", `${slug}.json`);
    const fixtureBytes = await readFile(fixturePath);
    const payload = FixtureSchema.parse(JSON.parse(fixtureBytes.toString("utf8")));
    const frozenValues = new Set<string>();
    for (const metric of metrics) {
      const snapshot = JSON.parse(
        await readFile(join(fixtureRoot, "snapshots", slug, `${metric}.json`), "utf8"),
      ) as unknown;
      if (
        !exactObject(snapshot) ||
        snapshot.metric !== metric ||
        snapshot.athlete !== slug ||
        typeof snapshot.frozen_now !== "string" ||
        snapshot.frozen_now.length === 0 ||
        !Object.prototype.hasOwnProperty.call(snapshot, "value")
      ) {
        throw new Error("invalid snapshot");
      }
      frozenValues.add(snapshot.frozen_now);
      const expected = snapshot.value;
      parityCases.push({
        caseId: `${slug}:${metric}`,
        fixture: slug,
        metric,
        expectedSha256: hash(JSON.stringify(expected)),
        expected,
        ignoredActualPaths: deviations.get(metric) ?? [],
      });
    }
    if (frozenValues.size !== 1) throw new Error("inconsistent snapshot time");
    const frozenNow = [...frozenValues][0]!;
    generatedFixtures.push({
      slug,
      frozenNow,
      payloadSha256: hash(JSON.stringify(payload)),
      payload,
    });
    const streams: Array<{ readonly path: string; readonly values: number[] }> = [];
    collectStreams(payload, "", streams);
    streams.sort((left, right) => left.path.localeCompare(right.path));
    for (const stream of streams.slice(0, 32)) {
      for (const op of operationNames) {
        const caseId = `${slug}:${stream.path}:${op}`;
        if (caseId.length > 256) throw new Error("differential case id too long");
        differentialCases.push({
          caseId,
          fixture: slug,
          streamPath: stream.path,
          op,
          length: stream.values.length,
          streamSha256: hash(JSON.stringify(stream.values)),
        });
      }
    }
  }
  parityCases.sort((left, right) => left.caseId.localeCompare(right.caseId));
  differentialCases.sort((left, right) => left.caseId.localeCompare(right.caseId));
  if (
    parityCases.length !== metrics.length * fixtures.length ||
    differentialCases.length === 0 ||
    new Set(parityCases.map((item) => item.caseId)).size !== parityCases.length ||
    new Set(differentialCases.map((item) => item.caseId)).size !== differentialCases.length
  ) {
    throw new Error("incomplete self-test matrix");
  }
  const matrix = {
    schemaVersion: 1,
    hashAlgorithm: "sha256",
    fixtures: generatedFixtures,
    parityCases,
    differentialCases,
  };
  const matrixBytes = `${JSON.stringify(matrix)}\n`;
  const temporaryAsar = join(temporaryRoot, "self-test-asar");
  const temporaryRunner = join(temporaryRoot, "self-test-runner");
  await rm(temporaryRoot, { recursive: true, force: true });
  await mkdir(join(temporaryAsar, "resources/self-test"), { recursive: true });
  await mkdir(temporaryRunner, { recursive: true });
  const injectedBindings = join(temporaryRoot, "self-test-kernel-bindings.ts");
  await writeFile(
    injectedBindings,
    [
      'export { METRIC_REGISTRY } from "@enduragent/kernel/reference/registry";',
      'export { FixtureSchema } from "@enduragent/kernel/reference/schemas";',
      'export { mean, pythonSum, sampleStdev } from "@enduragent/kernel/reference/metrics";',
      "",
    ].join("\n"),
  );
  await writeFile(join(temporaryAsar, "resources/self-test/matrix.json"), matrixBytes);
  await writeFile(
    join(temporaryAsar, "resources/self-test/matrix.sha256"),
    `${hash(matrixBytes)}  matrix.json\n`,
  );
  await build({
    entryPoints: [join(desktopRoot, "src/self-test/runner.ts")],
    outfile: join(temporaryRunner, "self-test-runner.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    minify: false,
    sourcemap: false,
    inject: [injectedBindings],
  });
  await Promise.all([
    rm(asarOutput, { recursive: true, force: true }),
    rm(runnerOutput, { recursive: true, force: true }),
    rm(extraOutput, { recursive: true, force: true }),
  ]);
  await Promise.all([rename(temporaryAsar, asarOutput), rename(temporaryRunner, runnerOutput)]);
  try {
    await buildKeychainBinding(desktopRoot);
    await copyKeychainBindingToAsarStaging(desktopRoot, asarOutput);
    await runStage();
  } catch (error) {
    await Promise.all([
      rm(asarOutput, { recursive: true, force: true }),
      rm(runnerOutput, { recursive: true, force: true }),
      rm(extraOutput, { recursive: true, force: true }),
    ]);
    throw error;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await main();
