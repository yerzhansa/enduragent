import { createRequire } from "node:module";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test as base, type ElectronApplication, type Page } from "@playwright/test";
import { desktopFixtureLaunchArgs } from "../../helpers/desktop-fixture-launch-args.js";

const require = createRequire(import.meta.url);
const desktopRoot = resolve(import.meta.dirname, "../../..");
const launchTimeoutMs = 45_000;

interface DesktopPaths {
  readonly athleteHome: string;
  readonly userData: string;
}

interface DesktopApplication {
  readonly application: ElectronApplication;
  readonly page: Page;
  readonly paths: DesktopPaths;
}

interface DesktopFixtures {
  readonly desktop: DesktopApplication;
}

function isolatedEnvironment(paths: DesktopPaths): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete environment.ELECTRON_CLI_ARGS;
  delete environment.ELECTRON_RENDERER_URL;
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.CLICOLOR_FORCE;
  delete environment.FORCE_COLOR;
  delete environment.NO_COLOR;
  delete environment.NODE_OPTIONS;
  return {
    ...environment,
    ENDURAGENT_HOME: paths.athleteHome,
    ENDURAGENT_DEVELOPMENT_USER_DATA: paths.userData,
    ENDURAGENT_ACCEPTANCE_CREDENTIAL_BACKEND: "memory",
    ENDURAGENT_DISPOSABLE_SAFE_STORAGE_CONTEXT: "1",
    ENDURAGENT_ACCEPTANCE_HIDDEN: "0",
    ENDURAGENT_STARTUP_TRACE: "1",
    LANG: "en_US.UTF-8",
    TZ: "UTC",
  };
}

export const test = base.extend<DesktopFixtures>({
  desktop: async ({ playwright }, use, testInfo) => {
    const temporaryRoot = await realpath(process.platform === "darwin" ? "/tmp" : tmpdir());
    const scratch = await mkdtemp(join(temporaryRoot, "enduragent-e2e-"));
    const paths = {
      athleteHome: join(scratch, "athlete-home"),
      userData: join(scratch, "electron-user-data"),
    };
    await Promise.all([
      mkdir(paths.athleteHome, { recursive: true, mode: 0o700 }),
      mkdir(paths.userData, { recursive: true, mode: 0o700 }),
    ]);
    const messages: string[] = [];
    let application: ElectronApplication | undefined;
    let page: Page | undefined;
    try {
      application = await playwright._electron.launch({
        executablePath: require("electron") as string,
        args: [desktopRoot, ...desktopFixtureLaunchArgs(process.platform, process.env.CI)],
        cwd: desktopRoot,
        env: isolatedEnvironment(paths),
        colorScheme: "light",
        locale: "en-US",
        timezoneId: "UTC",
        timeout: launchTimeoutMs,
      });
      application.process().stderr?.on("data", (chunk: Buffer) => {
        messages.push(chunk.toString());
      });
      application.on("console", (message) =>
        messages.push(`main ${message.type()}: ${message.text()}`),
      );
      page = await application.firstWindow({ timeout: launchTimeoutMs });
      page.on("console", (message) =>
        messages.push(`renderer ${message.type()}: ${message.text()}`),
      );
      page.on("pageerror", (error) => messages.push(`renderer error: ${error.message}`));
      await page.setViewportSize({ width: 1180, height: 820 });
      await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
      await page.context().route(/^https?:\/\//, (route) => route.abort("blockedbyclient"));
      await page.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
      await use({ application, page, paths });
    } finally {
      const failed = testInfo.status !== testInfo.expectedStatus;
      if (failed) {
        const diagnostics = `${messages.join("\n")}\n`;
        process.stderr.write(diagnostics);
        await writeFile(testInfo.outputPath("desktop.log"), diagnostics).catch(() => {});
      }
      if (page !== undefined) {
        if (failed) {
          await page
            .screenshot({ path: testInfo.outputPath("desktop.png"), fullPage: true })
            .catch(() => {});
          await page
            .context()
            .tracing.stop({ path: testInfo.outputPath("trace.zip") })
            .catch(() => {});
        } else {
          await page
            .context()
            .tracing.stop()
            .catch(() => {});
        }
      }
      const applicationProcess = application?.process();
      await application?.close().catch(() => {});
      if (applicationProcess !== undefined && applicationProcess.exitCode === null) {
        applicationProcess.kill("SIGKILL");
      }
      await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
});

export { expect };
