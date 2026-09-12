import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const desktopRoot = resolve(import.meta.dirname, "..");

function updaterLoaderBody(source: string): string {
  const prefix = "    loadUpdater: async () => {";
  const suffix = "\n    },\n    requestQuit:";
  const start = source.indexOf(prefix);
  const end = source.indexOf(suffix, start + prefix.length);
  if (start < 0 || end < 0) throw new Error("desktop updater loader was not found");
  return source.slice(start + prefix.length, end);
}

describe("desktop updater import boundary", () => {
  it("loads the real CommonJS updater through the production native ESM loader", async () => {
    const source = await readFile(resolve(desktopRoot, "src/main/index.ts"), "utf8");
    const harness = [
      'import { createRequire } from "node:module";',
      "const require = createRequire(import.meta.url);",
      'const electronPath = require.resolve("electron");',
      "require(electronPath);",
      "const nativeUpdater = { on() { return nativeUpdater; } };",
      "require.cache[electronPath].exports = {",
      "  app: {",
      '    getVersion: () => "0.5.0",',
      '    getName: () => "Enduragent",',
      "    isPackaged: false,",
      "    getAppPath: () => process.cwd(),",
      "    getPath: () => process.cwd(),",
      "    quit() {},",
      "    relaunch() {},",
      "    once() {},",
      "  },",
      "  autoUpdater: nativeUpdater,",
      "  net: {},",
      "  session: {},",
      "};",
      `const loadUpdater = async () => {${updaterLoaderBody(source)}\n};`,
      "const updater = await loadUpdater();",
      "process.stdout.write(typeof updater?.checkForUpdates);",
    ].join("\n");

    const result = await execFileAsync(
      process.execPath,
      ["--input-type=module", "--eval", harness],
      { cwd: desktopRoot },
    );

    expect(result.stdout).toBe("function");
  });
});
