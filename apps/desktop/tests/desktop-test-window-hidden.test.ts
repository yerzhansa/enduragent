import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const testsRoot = import.meta.dirname;
const launcherDirectories = ["e2e", "helpers"];
const operatorWatchedLaunchers = new Set([
  "helpers/plan-inspection-live.ts",
  "helpers/plan-qa-live.ts",
]);
const visibleWindowRequest =
  /ENDURAGENT_ACCEPTANCE_HIDDEN["']?\s*[:=]\s*["']0["']|\bhidden:\s*false\b/;

async function typeScriptSources(directory: string): Promise<string[]> {
  const entries = await readdir(join(testsRoot, directory), {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => relative(testsRoot, join(entry.parentPath, entry.name)).replaceAll("\\", "/"));
}

describe("desktop test window", () => {
  it("is never requested visible by an end-to-end test or launch helper", async () => {
    const sources = (await Promise.all(launcherDirectories.map(typeScriptSources))).flat();
    const visible: string[] = [];
    for (const source of sources) {
      if (operatorWatchedLaunchers.has(source)) continue;
      if (visibleWindowRequest.test(await readFile(join(testsRoot, source), "utf8"))) {
        visible.push(source);
      }
    }

    expect(sources).not.toEqual([]);
    expect(visible).toEqual([]);
  });
});
