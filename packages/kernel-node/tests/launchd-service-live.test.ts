import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AthleteHome } from "@enduragent/kernel-node/home";

import { createLaunchdServiceIdentity, installLaunchdService } from "../src/service/index.js";

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runLaunchctl(args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    execFile(
      "/bin/launchctl",
      [...args],
      {
        shell: false,
        encoding: "utf8",
        timeout: 5_000,
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          HOME: homedir(),
        },
      },
      (error, stdoutValue, stderrValue) => {
        const stdout = typeof stdoutValue === "string" ? stdoutValue : "";
        const stderr = typeof stderrValue === "string" ? stderrValue : "";
        resolveResult({
          exitCode: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
          stdout,
          stderr,
        });
      },
    );
  });
}

async function waitForStarts(path: string): Promise<number[]> {
  const deadline = Date.now() + 50_000;
  while (Date.now() < deadline) {
    let bytes = "";
    try {
      bytes = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const starts = bytes
      .trim()
      .split("\n")
      .filter((value) => value.length > 0)
      .map(Number);
    if (starts.length >= 4) return starts;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error("launchd cadence probe timed out");
}

const liveDescribe =
  process.env.RUN_ENDURAGENT_LAUNCHD_STANDARD_LOCATION === "1" ? describe : describe.skip;

liveDescribe("launchd standard-location probe", () => {
  it("accepts the owner-only plist and retains fixed crash-loop throttling", async () => {
    expect(process.platform).toBe("darwin");
    const temporaryDirectory = await realpath(tmpdir());
    const root = await mkdtemp(join(temporaryDirectory, "launchd-live-probe-"));
    const label = `ai.enduragent.coach.probe.${process.pid}.${Date.now()}`;
    const home: AthleteHome = {
      root: join(root, "athlete"),
      storeDir: join(root, "athlete", "store"),
      archiveDir: join(root, "athlete", "archive"),
      configDir: join(root, "athlete", "config"),
    };
    const executablePath = join(root, "synthetic-enduragent");
    const startsPath = join(root, "starts");
    await mkdir(home.configDir, { recursive: true, mode: 0o700 });
    await writeFile(executablePath, `#!/bin/sh\n/bin/date +%s >> '${startsPath}'\nexit 1\n`, {
      mode: 0o700,
    });
    const identity = createLaunchdServiceIdentity({
      home,
      executablePath,
      label,
    });
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("launchd requires a user id");
    const target = `gui/${uid}/${label}`;
    let paths: Awaited<ReturnType<typeof installLaunchdService>>["paths"] | undefined;

    try {
      const installed = await installLaunchdService(identity, {
        platform: "darwin",
        uid,
        userHome: homedir(),
        runLaunchctl: async (args) =>
          args[0] === "print"
            ? {
                outcome: "exited",
                exitCode: 0,
                stdout: "state = exited\n",
                stderr: "",
              }
            : {
                outcome: "exited",
                exitCode: 0,
                stdout: "",
                stderr: "",
              },
      });
      paths = installed.paths;
      await runLaunchctl(["bootout", target]);
      await runLaunchctl(["enable", target]);
      let bootstrap = await runLaunchctl(["bootstrap", `gui/${uid}`, paths.plistPath]);
      if (bootstrap.exitCode === 0) {
        process.stdout.write("PLIST_0600_ACCEPTED_REQUIRES_DECISION_AMENDMENT\n");
      } else {
        const output = `${bootstrap.stdout}\n${bootstrap.stderr}`;
        if (/EIO/i.test(output)) {
          process.stdout.write("ENVIRONMENT_BLOCKED launchd-standard-location EIO\n");
          return;
        }
        process.stdout.write("PLIST_0600_REJECTED\n");
        await chmod(paths.plistPath, 0o644);
        bootstrap = await runLaunchctl(["bootstrap", `gui/${uid}`, paths.plistPath]);
        expect(bootstrap.exitCode).toBe(0);
      }

      const starts = await waitForStarts(startsPath);
      const intervals = starts.slice(1, 4).map((value, index) => {
        const previous = starts[index];
        if (previous === undefined) throw new Error("missing launchd start");
        return (value - previous) * 1_000;
      });
      for (const interval of intervals) {
        expect(interval).toBeGreaterThanOrEqual(8_000);
        expect(interval).toBeLessThanOrEqual(16_000);
      }
      expect(Math.max(...intervals) - Math.min(...intervals)).toBeLessThanOrEqual(4_000);
    } finally {
      await runLaunchctl(["bootout", target]);
      if (paths !== undefined) {
        for (const path of [paths.plistPath, paths.envPath, paths.wrapperPath, paths.handoffPath]) {
          await rm(path, { force: true });
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 70_000);
});
