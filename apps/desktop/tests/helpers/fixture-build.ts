import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const desktopRoot = resolve(import.meta.dirname, "../..");
let application: Promise<string> | undefined;

export function buildFixtureApplication(): Promise<string> {
  application ??= (async () => {
    const directory = resolve(desktopRoot, "dist");
    await mkdir(directory, { recursive: true });
    const root = await mkdtemp(resolve(directory, "integration-fixture-"));
    await new Promise<void>((resolveBuild, reject) => {
      const child = spawn(
        process.execPath,
        [
          resolve(desktopRoot, "node_modules/electron-vite/bin/electron-vite.js"),
          "build",
          "--config",
          "electron.fixture.vite.config.ts",
        ],
        {
          cwd: desktopRoot,
          env: { ...process.env, ENDURAGENT_FIXTURE_BUILD_ROOT: root },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        output += String(chunk);
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) resolveBuild();
        else reject(new Error(`desktop fixture build failed: ${output}`));
      });
    });
    await writeFile(
      resolve(root, "package.json"),
      JSON.stringify({
        name: "enduragent-desktop-integration-fixture",
        version: "0.0.1",
        type: "module",
        main: "out/main/index.js",
      }),
    );
    return root;
  })();
  return application;
}
