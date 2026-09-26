import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertWindowsPrivateDirectoryStable,
  assertWindowsPrivateFileBinding,
  assertWindowsPrivateFileMetadata,
  bindWindowsPrivateDirectory,
  classifyWindowsPrivatePathDurability,
  classifyWindowsPrivatePathFailure,
  sameWindowsPrivatePathIdentity,
  windowsPrivatePathIdentity,
  WindowsPrivatePathPolicyError,
  type WindowsPrivatePathPolicyStage,
} from "@enduragent/core";

export const FIRST_RUN_CONFIG_DIRECTORY_MODE = 0o700;
export const FIRST_RUN_CONFIG_FILE_MODE = 0o600;

export interface FirstRunConfigFileSystem {
  lstat(path: string): Promise<unknown>;
  mkdir(path: string, options: { readonly recursive: true; readonly mode: number }): Promise<void>;
  writeFile(
    path: string,
    contents: string,
    options: { readonly encoding: "utf8"; readonly flag: "wx"; readonly mode: number },
  ): Promise<void>;
  link(temporaryPath: string, targetPath: string): Promise<void>;
  rm(path: string, options: { readonly force: true }): Promise<void>;
}

export interface FirstRunConfigDependencies {
  readonly fileSystem?: FirstRunConfigFileSystem;
  readonly timezone?: () => string | undefined;
  readonly createId?: () => string;
  readonly openFile?: typeof open;
}

export interface SeedFirstRunConfigInput {
  readonly env?: Record<string, string | undefined>;
  readonly dependencies?: FirstRunConfigDependencies;
  readonly platform?: NodeJS.Platform;
}

const nodeFileSystem: FirstRunConfigFileSystem = {
  async lstat(path) {
    await lstat(path);
  },
  async mkdir(path, options) {
    await mkdir(path, options);
  },
  async writeFile(path, contents, options) {
    await writeFile(path, contents, options);
  },
  async link(temporaryPath, targetPath) {
    await link(temporaryPath, targetPath);
  },
  async rm(path, options) {
    await rm(path, options);
  },
};

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function resolveDesktopAthleteHome(
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env.ENDURAGENT_HOME;
  return resolve(
    override !== undefined && override.length > 0
      ? expandHome(override)
      : join(homedir(), ".enduragent"),
  );
}

function defaultTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function yamlPath(path: string): string {
  return /^[/A-Za-z0-9._~@%+=-]+$/.test(path) ? path : JSON.stringify(path);
}

function configContents(homeRoot: string, timezone: string): string {
  return [
    "data_source: store",
    `data_dir: ${yamlPath(homeRoot)}`,
    "llm:",
    "  provider: anthropic",
    "  api_key: ''",
    "intervals:",
    "  api_key: ''",
    "  athlete_id: ''",
    "session:",
    `  timezone: ${timezone}`,
    "",
  ].join("\n");
}

async function exists(fileSystem: FirstRunConfigFileSystem, path: string): Promise<boolean> {
  try {
    await fileSystem.lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertWindowsConfigFile(
  directory: ReturnType<typeof bindWindowsPrivateDirectory>,
  path: string,
  allowedLinks: 1 | 2 = 1,
): Promise<void> {
  const metadata = await lstat(path);
  assertWindowsPrivateFileMetadata(metadata, allowedLinks);
  assertWindowsPrivateFileBinding(
    directory,
    path,
    windowsPrivatePathIdentity(metadata),
    allowedLinks,
  );
}

async function windowsConfigExists(
  homeRoot: string,
  configDirectory: string,
  target: string,
): Promise<boolean> {
  try {
    await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw classifyWindowsPrivatePathFailure("entry-check", error);
  }
  try {
    const directory = bindWindowsPrivateDirectory(homeRoot, configDirectory);
    await assertWindowsConfigFile(directory, target);
    assertWindowsPrivateDirectoryStable(directory);
    return true;
  } catch (error) {
    throw classifyWindowsPrivatePathFailure("entry-check", error);
  }
}

async function seedWindowsFirstRunConfig(input: {
  readonly fileSystem: FirstRunConfigFileSystem;
  readonly openFile: typeof open;
  readonly homeRoot: string;
  readonly configDirectory: string;
  readonly target: string;
  readonly contents: () => string;
  readonly createId: () => string;
}): Promise<"seeded" | "existing"> {
  if (await windowsConfigExists(input.homeRoot, input.configDirectory, input.target)) {
    return "existing";
  }
  try {
    await input.fileSystem.mkdir(input.configDirectory, {
      recursive: true,
      mode: FIRST_RUN_CONFIG_DIRECTORY_MODE,
    });
  } catch (error) {
    throw classifyWindowsPrivatePathFailure("binding-check", error);
  }
  let directory: ReturnType<typeof bindWindowsPrivateDirectory>;
  try {
    directory = bindWindowsPrivateDirectory(input.homeRoot, input.configDirectory);
  } catch (error) {
    throw classifyWindowsPrivatePathFailure("binding-check", error);
  }
  let id: string;
  try {
    id = input.createId();
  } catch (error) {
    throw classifyWindowsPrivatePathFailure("content-write", error);
  }
  if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) {
    throw new WindowsPrivatePathPolicyError("content-write", "corruption");
  }
  const temporary = join(input.configDirectory, `.config.${id}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let identity: ReturnType<typeof windowsPrivatePathIdentity> | undefined;
  let stage: WindowsPrivatePathPolicyStage = "content-write";
  try {
    handle = await input.openFile(temporary, "wx", FIRST_RUN_CONFIG_FILE_MODE);
    const opened = await handle.stat();
    assertWindowsPrivateFileMetadata(opened);
    identity = windowsPrivatePathIdentity(opened);
    assertWindowsPrivateFileBinding(directory, temporary, identity);
    await handle.writeFile(input.contents(), "utf8");
    stage = "file-flush";
    await handle.sync();
    const flushed = await handle.stat();
    assertWindowsPrivateFileMetadata(flushed);
    if (!sameWindowsPrivatePathIdentity(identity, windowsPrivatePathIdentity(flushed))) {
      throw new WindowsPrivatePathPolicyError("binding-check", "corruption");
    }
    assertWindowsPrivateFileBinding(directory, temporary, identity);
    assertWindowsPrivateDirectoryStable(directory);
    await handle.close();
    handle = undefined;
    stage = "rename";
    try {
      await input.fileSystem.link(temporary, input.target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await input.fileSystem.rm(temporary, { force: true });
      await assertWindowsConfigFile(directory, input.target);
      assertWindowsPrivateDirectoryStable(directory);
      return "existing";
    }
    await assertWindowsConfigFile(directory, temporary, 2);
    await assertWindowsConfigFile(directory, input.target, 2);
    await input.fileSystem.rm(temporary, { force: true });
    await assertWindowsConfigFile(directory, input.target);
    assertWindowsPrivateDirectoryStable(directory);
    if (classifyWindowsPrivatePathDurability("directory-sync").kind === "unavailable") {
      return "seeded";
    }
    throw new WindowsPrivatePathPolicyError("rename", "io-failure");
  } catch (error) {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch (closeError) {
        const code = (closeError as NodeJS.ErrnoException).code;
        if (code !== "EBADF") throw closeError;
      }
    }
    await input.fileSystem.rm(temporary, { force: true });
    throw classifyWindowsPrivatePathFailure(stage, error);
  }
}

export async function seedFirstRunConfig(
  input: SeedFirstRunConfigInput = {},
): Promise<"seeded" | "existing"> {
  const fileSystem = input.dependencies?.fileSystem ?? nodeFileSystem;
  const platform = input.platform ?? process.platform;
  const homeRoot = resolveDesktopAthleteHome(input.env);
  const configDirectory = join(homeRoot, "config");
  const target = join(configDirectory, "config.yaml");
  if (platform === "win32") {
    return seedWindowsFirstRunConfig({
      fileSystem,
      openFile: input.dependencies?.openFile ?? open,
      homeRoot,
      configDirectory,
      target,
      contents: () => {
        const resolvedTimezone = (input.dependencies?.timezone ?? defaultTimezone)();
        const timezone =
          resolvedTimezone === undefined || resolvedTimezone.length === 0
            ? "UTC"
            : resolvedTimezone;
        return configContents(homeRoot, timezone);
      },
      createId: input.dependencies?.createId ?? randomUUID,
    });
  }
  if (await exists(fileSystem, target)) return "existing";

  await fileSystem.mkdir(configDirectory, {
    recursive: true,
    mode: FIRST_RUN_CONFIG_DIRECTORY_MODE,
  });
  const temporary = join(
    configDirectory,
    `.config.${(input.dependencies?.createId ?? randomUUID)()}.tmp`,
  );
  const resolvedTimezone = (input.dependencies?.timezone ?? defaultTimezone)();
  const timezone =
    resolvedTimezone === undefined || resolvedTimezone.length === 0 ? "UTC" : resolvedTimezone;
  try {
    await fileSystem.writeFile(temporary, configContents(homeRoot, timezone), {
      encoding: "utf8",
      flag: "wx",
      mode: FIRST_RUN_CONFIG_FILE_MODE,
    });
    try {
      await fileSystem.link(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await fileSystem.rm(temporary, { force: true });
      return "existing";
    }
    await fileSystem.rm(temporary, { force: true });
    return "seeded";
  } catch (error) {
    await fileSystem.rm(temporary, { force: true });
    throw error;
  }
}
