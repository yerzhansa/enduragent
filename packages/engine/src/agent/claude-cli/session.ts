import { spawn as nodeSpawn } from "node:child_process";
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { win32 } from "node:path";

import {
  query as sdkQuery,
  type Options,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  type SpawnOptions as SdkSpawnOptions,
  type SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";

import { buildChildEnv, readEnvironmentValue, type ClaudeCliRuntime } from "./env.js";
import {
  ClaudeCliWindowsMcpConfigError,
  ClaudeWorkingAreaError,
  normalizeClaudeCliError,
  unsafeWindowsCommandShimError,
  unsupportedWindowsExecutableError,
  windowsMcpConfigError,
} from "./errors.js";

export type ClaudeCliPrompt = string | AsyncIterable<SDKUserMessage>;

export type SanitizedQueryOptions = Options & {
  env: NonNullable<Options["env"]>;
  pathToClaudeCodeExecutable: string;
  model: string;
};

const WINDOWS_COMMAND_UNSAFE_CHARACTER_PATTERN = /["&|<>^%!()]/u;
const WINDOWS_MCP_CONFIG_FLAG = "--mcp-config";
const WINDOWS_MCP_CONFIG_ROOT = ".enduragent";
const WINDOWS_MCP_CONFIG_PREFIX = "claude-cli-mcp-";
const WINDOWS_MCP_CONFIG_FILE = "mcp.json";
const WINDOWS_MCP_CONFIG_PREFLIGHT = JSON.stringify({
  mcpServers: {
    "enduragent-readiness": { type: "stdio", command: "node" },
  },
});

interface WindowsPrivatePathIdentity {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}

interface WindowsPrivateDirectoryBinding {
  readonly path: string;
  readonly parentPath: string;
  readonly identity: WindowsPrivatePathIdentity;
  readonly parentIdentity: WindowsPrivatePathIdentity;
}

export interface WindowsMcpConfigFileSystem {
  readonly closeSync: typeof closeSync;
  readonly fstatSync: typeof fstatSync;
  readonly fsyncSync: typeof fsyncSync;
  readonly lstatSync: typeof lstatSync;
  readonly mkdirSync: typeof mkdirSync;
  readonly mkdtempSync: typeof mkdtempSync;
  readonly openSync: typeof openSync;
  readonly realpathSync: typeof realpathSync;
  readonly rmdirSync: typeof rmdirSync;
  readonly unlinkSync: typeof unlinkSync;
  readonly writeSync: typeof writeSync;
}

export type WindowsMcpConfigFileSystemDeps = Partial<WindowsMcpConfigFileSystem>;

const nodeWindowsMcpConfigFileSystem: WindowsMcpConfigFileSystem = {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeSync,
};

function windowsMcpConfigFileSystem(
  deps: WindowsMcpConfigFileSystemDeps = {},
): WindowsMcpConfigFileSystem {
  return { ...nodeWindowsMcpConfigFileSystem, ...deps };
}

function safeWindowsCommandText(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false;
  }
  return !WINDOWS_COMMAND_UNSAFE_CHARACTER_PATTERN.test(value);
}

function privatePathIdentity(metadata: Stats): WindowsPrivatePathIdentity {
  return { dev: metadata.dev, ino: metadata.ino };
}

function samePrivatePathIdentity(
  left: WindowsPrivatePathIdentity,
  right: WindowsPrivatePathIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertPrivateDirectoryMetadata(metadata: Stats): void {
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("private directory");
}

function assertPrivateFileMetadata(metadata: Stats): void {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error("private file");
  }
}

function observePrivateDirectory(
  parentPath: string,
  path: string,
  fileSystem: WindowsMcpConfigFileSystem,
): WindowsPrivateDirectoryBinding {
  const parentBefore = fileSystem.lstatSync(parentPath);
  const parentPhysicalPath = fileSystem.realpathSync(parentPath);
  const parentPhysical = fileSystem.lstatSync(parentPhysicalPath);
  const parentAfter = fileSystem.lstatSync(parentPath);
  const before = fileSystem.lstatSync(path);
  const physicalPath = fileSystem.realpathSync(path);
  const physical = fileSystem.lstatSync(physicalPath);
  const after = fileSystem.lstatSync(path);
  const physicalParent = fileSystem.lstatSync(win32.dirname(physicalPath));
  for (const metadata of [
    parentBefore,
    parentPhysical,
    parentAfter,
    before,
    physical,
    after,
    physicalParent,
  ]) {
    assertPrivateDirectoryMetadata(metadata);
  }
  const parentIdentity = privatePathIdentity(parentBefore);
  const identity = privatePathIdentity(before);
  if (
    !samePrivatePathIdentity(parentIdentity, privatePathIdentity(parentPhysical)) ||
    !samePrivatePathIdentity(parentIdentity, privatePathIdentity(parentAfter)) ||
    !samePrivatePathIdentity(identity, privatePathIdentity(physical)) ||
    !samePrivatePathIdentity(identity, privatePathIdentity(after)) ||
    !samePrivatePathIdentity(parentIdentity, privatePathIdentity(physicalParent))
  ) {
    throw new Error("private directory binding");
  }
  return { path, parentPath, identity, parentIdentity };
}

function assertPrivateDirectoryStable(
  binding: WindowsPrivateDirectoryBinding,
  fileSystem: WindowsMcpConfigFileSystem,
): void {
  const observed = observePrivateDirectory(binding.parentPath, binding.path, fileSystem);
  if (
    !samePrivatePathIdentity(binding.identity, observed.identity) ||
    !samePrivatePathIdentity(binding.parentIdentity, observed.parentIdentity)
  ) {
    throw new Error("private directory stability");
  }
}

function assertPrivateFileBinding(
  directory: WindowsPrivateDirectoryBinding,
  path: string,
  expectedIdentity: WindowsPrivatePathIdentity,
  fileSystem: WindowsMcpConfigFileSystem,
): void {
  assertPrivateDirectoryStable(directory, fileSystem);
  const before = fileSystem.lstatSync(path);
  const physicalPath = fileSystem.realpathSync(path);
  const physical = fileSystem.lstatSync(physicalPath);
  const after = fileSystem.lstatSync(path);
  const physicalParent = fileSystem.lstatSync(win32.dirname(physicalPath));
  for (const metadata of [before, physical, after]) assertPrivateFileMetadata(metadata);
  assertPrivateDirectoryMetadata(physicalParent);
  if (
    !samePrivatePathIdentity(expectedIdentity, privatePathIdentity(before)) ||
    !samePrivatePathIdentity(expectedIdentity, privatePathIdentity(physical)) ||
    !samePrivatePathIdentity(expectedIdentity, privatePathIdentity(after)) ||
    !samePrivatePathIdentity(directory.identity, privatePathIdentity(physicalParent))
  ) {
    throw new Error("private file binding");
  }
  assertPrivateDirectoryStable(directory, fileSystem);
}

function missingPath(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function cleanupWindowsMcpConfigFile(
  directory: WindowsPrivateDirectoryBinding,
  filePath: string | undefined,
  fileIdentity: WindowsPrivatePathIdentity | undefined,
  fileSystem: WindowsMcpConfigFileSystem,
): void {
  try {
    assertPrivateDirectoryStable(directory, fileSystem);
    if (filePath !== undefined) {
      let exists = true;
      try {
        fileSystem.lstatSync(filePath);
      } catch (error) {
        if (!missingPath(error)) throw error;
        exists = false;
      }
      if (exists) {
        try {
          if (fileIdentity === undefined) throw new Error("private file identity");
          assertPrivateFileBinding(directory, filePath, fileIdentity, fileSystem);
          fileSystem.unlinkSync(filePath);
        } catch (error) {
          if (!missingPath(error)) throw error;
        }
      }
    }
    assertPrivateDirectoryStable(directory, fileSystem);
    fileSystem.rmdirSync(directory.path);
  } catch {
    throw windowsMcpConfigError("cleanup");
  }
}

function attachCleanupFailure(
  primary: unknown,
  cleanupFailure: ClaudeCliWindowsMcpConfigError,
): unknown {
  if ((typeof primary === "object" && primary !== null) || typeof primary === "function") {
    try {
      Object.defineProperty(primary, "cleanupFailure", {
        configurable: true,
        value: cleanupFailure,
      });
      return primary;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
  }
  return cleanupFailure;
}

export interface WindowsMcpConfigFile {
  readonly commandPath: string;
  cleanup(): void;
}

export interface CreateWindowsMcpConfigFileInput {
  readonly contents: string;
  readonly env: NodeJS.ProcessEnv;
  readonly fileSystem?: WindowsMcpConfigFileSystemDeps;
}

export function createWindowsMcpConfigFile(
  input: CreateWindowsMcpConfigFileInput,
): WindowsMcpConfigFile {
  const fileSystem = windowsMcpConfigFileSystem(input.fileSystem);
  let stage: "private-path" | "content-write" = "private-path";
  let directory: WindowsPrivateDirectoryBinding | undefined;
  let filePath: string | undefined;
  let fileIdentity: WindowsPrivatePathIdentity | undefined;
  let descriptor: number | undefined;
  let contents: Buffer | undefined;
  try {
    const configuredProfile = readEnvironmentValue(input.env, "USERPROFILE", "win32");
    if (configuredProfile === undefined || configuredProfile === "") throw new Error("profile");
    const profile = win32.resolve(configuredProfile);
    const profileParent = win32.dirname(profile);
    if (
      profileParent === profile ||
      !win32.isAbsolute(profile) ||
      !safeWindowsCommandText(profile)
    ) {
      throw new Error("profile path");
    }
    observePrivateDirectory(profileParent, profile, fileSystem);
    const root = win32.join(profile, WINDOWS_MCP_CONFIG_ROOT);
    fileSystem.mkdirSync(root, { recursive: true, mode: 0o700 });
    const rootBinding = observePrivateDirectory(profile, root, fileSystem);
    const temporary = fileSystem.mkdtempSync(win32.join(root, WINDOWS_MCP_CONFIG_PREFIX));
    directory = observePrivateDirectory(rootBinding.path, temporary, fileSystem);
    filePath = win32.join(temporary, WINDOWS_MCP_CONFIG_FILE);
    const commandPath = filePath.replaceAll("\\", "/");
    if (!safeWindowsCommandText(commandPath)) throw new Error("command path");
    stage = "content-write";
    descriptor = fileSystem.openSync(
      filePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    const opened = fileSystem.fstatSync(descriptor);
    assertPrivateFileMetadata(opened);
    fileIdentity = privatePathIdentity(opened);
    assertPrivateFileBinding(directory, filePath, fileIdentity, fileSystem);
    contents = Buffer.from(input.contents, "utf8");
    let offset = 0;
    while (offset < contents.length) {
      const written = fileSystem.writeSync(
        descriptor,
        contents,
        offset,
        contents.length - offset,
        null,
      );
      if (written <= 0) throw new Error("content write");
      offset += written;
    }
    fileSystem.fsyncSync(descriptor);
    const written = fileSystem.fstatSync(descriptor);
    assertPrivateFileMetadata(written);
    if (!samePrivatePathIdentity(fileIdentity, privatePathIdentity(written))) {
      throw new Error("file identity");
    }
    assertPrivateFileBinding(directory, filePath, fileIdentity, fileSystem);
    fileSystem.closeSync(descriptor);
    descriptor = undefined;
    assertPrivateFileBinding(directory, filePath, fileIdentity, fileSystem);
    return {
      commandPath,
      cleanup: () => cleanupWindowsMcpConfigFile(directory!, filePath, fileIdentity, fileSystem),
    };
  } catch {
    let cleanupFailure: ClaudeCliWindowsMcpConfigError | undefined;
    if (descriptor !== undefined) {
      try {
        fileSystem.closeSync(descriptor);
      } catch {
        cleanupFailure = windowsMcpConfigError("cleanup");
      }
    }
    if (directory !== undefined) {
      try {
        cleanupWindowsMcpConfigFile(directory, filePath, fileIdentity, fileSystem);
      } catch (error) {
        cleanupFailure =
          error instanceof ClaudeCliWindowsMcpConfigError
            ? error
            : windowsMcpConfigError("cleanup");
      }
    }
    throw windowsMcpConfigError(stage, cleanupFailure);
  } finally {
    contents?.fill(0);
  }
}

interface PreparedWindowsCommandArguments {
  readonly args: readonly string[];
  readonly cleanup?: () => void;
}

function serializedMcpConfig(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const servers = (parsed as Record<string, unknown>).mcpServers;
    return (
      typeof servers === "object" &&
      servers !== null &&
      !Array.isArray(servers) &&
      Object.keys(servers).length > 0
    );
  } catch {
    return false;
  }
}

function prepareWindowsCommandArguments(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  fileSystem?: WindowsMcpConfigFileSystemDeps,
): PreparedWindowsCommandArguments {
  let inlineIndex = -1;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === WINDOWS_MCP_CONFIG_FLAG) {
      const value = args[index + 1];
      if (value === undefined || inlineIndex !== -1) throw unsafeWindowsCommandShimError();
      if (safeWindowsCommandText(value)) {
        index += 1;
        continue;
      }
      if (!serializedMcpConfig(value)) throw unsafeWindowsCommandShimError();
      inlineIndex = index + 1;
      index += 1;
      continue;
    }
    if (!safeWindowsCommandText(argument)) {
      throw unsafeWindowsCommandShimError();
    }
  }
  if (inlineIndex === -1) return { args: [...args] };
  const file = createWindowsMcpConfigFile({
    contents: args[inlineIndex]!,
    env,
    ...(fileSystem === undefined ? {} : { fileSystem }),
  });
  const transformed = [...args];
  transformed[inlineIndex] = file.commandPath;
  return { args: transformed, cleanup: file.cleanup };
}

export interface PreflightWindowsMcpConfigTransformInput {
  readonly binaryPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly fileSystem?: WindowsMcpConfigFileSystemDeps;
}

export function preflightWindowsMcpConfigTransform(
  input: PreflightWindowsMcpConfigTransformInput,
): void {
  const platform = input.platform ?? process.platform;
  if (platform !== "win32" || win32.extname(input.binaryPath).toLowerCase() !== ".cmd") return;
  buildClaudeCliSpawnInvocation({
    binaryPath: input.binaryPath,
    args: [],
    env: input.env,
    platform,
  });
  const prepared = prepareWindowsCommandArguments(
    [WINDOWS_MCP_CONFIG_FLAG, WINDOWS_MCP_CONFIG_PREFLIGHT],
    input.env,
    input.fileSystem,
  );
  try {
    buildClaudeCliSpawnInvocation({
      binaryPath: input.binaryPath,
      args: prepared.args,
      env: input.env,
      platform,
    });
  } catch (error) {
    try {
      prepared.cleanup?.();
    } catch (cleanupError) {
      throw attachCleanupFailure(
        error,
        cleanupError instanceof ClaudeCliWindowsMcpConfigError
          ? cleanupError
          : windowsMcpConfigError("cleanup"),
      );
    }
    throw error;
  }
  prepared.cleanup?.();
}

export interface ClaudeCliSpawnInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly shell: false;
  readonly windowsHide: true;
  readonly windowsVerbatimArguments?: true;
}

export interface BuildClaudeCliSpawnInvocationInput {
  readonly binaryPath: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

function directInvocation(binaryPath: string, args: readonly string[]): ClaudeCliSpawnInvocation {
  return {
    command: binaryPath,
    args: [...args],
    shell: false,
    windowsHide: true,
  };
}

function windowsCommandProcessor(env: NodeJS.ProcessEnv): string {
  const systemRoot = readEnvironmentValue(env, "SYSTEMROOT", "win32") ?? "C:\\Windows";
  if (!win32.isAbsolute(systemRoot) || !safeWindowsCommandText(systemRoot)) {
    throw unsafeWindowsCommandShimError();
  }
  return win32.join(systemRoot, "System32", "cmd.exe");
}

function quoteWindowsCommandArgument(argument: string): string {
  const trailingBackslashes = /\\+$/.exec(argument)?.[0] ?? "";
  return `"${argument}${trailingBackslashes}"`;
}

export function buildClaudeCliSpawnInvocation(
  input: BuildClaudeCliSpawnInvocationInput,
): ClaudeCliSpawnInvocation {
  const platform = input.platform ?? process.platform;
  if (platform !== "win32") return directInvocation(input.binaryPath, input.args);

  const extension = win32.extname(input.binaryPath).toLowerCase();
  if (extension === ".exe") return directInvocation(input.binaryPath, input.args);
  if (extension !== ".cmd") throw unsupportedWindowsExecutableError();
  if (
    !win32.isAbsolute(input.binaryPath) ||
    !safeWindowsCommandText(input.binaryPath) ||
    input.args.some((argument) => !safeWindowsCommandText(argument))
  ) {
    throw unsafeWindowsCommandShimError();
  }

  const commandLine = [
    `"${input.binaryPath}"`,
    ...input.args.map(quoteWindowsCommandArgument),
  ].join(" ");

  return {
    command: windowsCommandProcessor(input.env),
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    shell: false,
    windowsHide: true,
    windowsVerbatimArguments: true,
  };
}

export interface SpawnClaudeCliProcessDeps {
  readonly platform?: NodeJS.Platform;
  readonly spawn?: typeof nodeSpawn;
  readonly windowsMcpConfigFileSystem?: WindowsMcpConfigFileSystemDeps;
  readonly onWindowsMcpConfigCleanup?: (cleanup: () => void) => void;
  readonly onWindowsMcpConfigCleanupFailure?: (error: ClaudeCliWindowsMcpConfigError) => void;
  readonly stderr?: (data: string) => void;
}

export function spawnClaudeCliProcess(
  options: SdkSpawnOptions,
  deps: SpawnClaudeCliProcessDeps = {},
): SpawnedProcess {
  if (options.cwd === undefined || options.cwd === "") {
    throw new ClaudeWorkingAreaError("spawn-check", "unavailable");
  }
  const platform = deps.platform ?? process.platform;
  let prepared: PreparedWindowsCommandArguments = { args: options.args };
  if (platform === "win32" && win32.extname(options.command).toLowerCase() === ".cmd") {
    buildClaudeCliSpawnInvocation({
      binaryPath: options.command,
      args: [],
      env: options.env,
      platform,
    });
    prepared = prepareWindowsCommandArguments(
      options.args,
      options.env,
      deps.windowsMcpConfigFileSystem,
    );
  }

  let invocation: ClaudeCliSpawnInvocation;
  try {
    invocation = buildClaudeCliSpawnInvocation({
      binaryPath: options.command,
      args: prepared.args,
      env: options.env,
      platform,
    });
  } catch (error) {
    try {
      prepared.cleanup?.();
    } catch (cleanupError) {
      throw attachCleanupFailure(
        error,
        cleanupError instanceof ClaudeCliWindowsMcpConfigError
          ? cleanupError
          : windowsMcpConfigError("cleanup"),
      );
    }
    throw error;
  }

  let child: SpawnedProcess;
  try {
    const launched = (deps.spawn ?? nodeSpawn)(invocation.command, [...invocation.args], {
      cwd: options.cwd,
      env: options.env,
      shell: invocation.shell,
      windowsHide: invocation.windowsHide,
      ...(invocation.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {}),
      signal: options.signal,
      stdio: ["pipe", "pipe", "pipe"],
    });
    launched.stderr?.on("data", (chunk: Buffer) => deps.stderr?.(chunk.toString("utf8")));
    if (deps.stderr === undefined) launched.stderr?.resume();
    child = launched as unknown as SpawnedProcess;
  } catch (error) {
    try {
      prepared.cleanup?.();
    } catch (cleanupError) {
      throw attachCleanupFailure(
        error,
        cleanupError instanceof ClaudeCliWindowsMcpConfigError
          ? cleanupError
          : windowsMcpConfigError("cleanup"),
      );
    }
    throw error;
  }

  if (prepared.cleanup !== undefined) {
    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      try {
        prepared.cleanup?.();
        cleaned = true;
      } catch (error) {
        deps.onWindowsMcpConfigCleanupFailure?.(
          error instanceof ClaudeCliWindowsMcpConfigError
            ? error
            : windowsMcpConfigError("cleanup"),
        );
      }
    };
    deps.onWindowsMcpConfigCleanup?.(cleanup);
    child.once("error", cleanup);
    child.once("exit", cleanup);
  }
  return child;
}

interface WindowsMcpConfigQueryState {
  cleanup?: () => void;
  cleanupFailure: ClaudeCliWindowsMcpConfigError | null;
}

const windowsMcpConfigQueryStates = new WeakMap<
  SanitizedQueryOptions,
  WindowsMcpConfigQueryState
>();

export interface BuildQueryOptionsInput {
  runtime: ClaudeCliRuntime;
  baseEnv: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  model: string;
  systemPrompt?: string;
  mcpServers?: Options["mcpServers"];
  tools?: string[];
  allowedTools?: string[];
  canUseTool?: Options["canUseTool"];
  maxTurns?: number;
  resume?: string;
  sessionId?: string;
  cwd: string;
  assertWorkingArea: () => void;
  persistSession?: boolean;
  includePartialMessages?: boolean;
  abortController?: AbortController;
  stderr?: (data: string) => void;
  windowsMcpConfigFileSystem?: WindowsMcpConfigFileSystemDeps;
}

export function buildQueryOptions(input: BuildQueryOptionsInput): SanitizedQueryOptions {
  const platform = input.platform ?? process.platform;
  const binaryPath = input.runtime.binaryPath;
  if (binaryPath === undefined || binaryPath === "") {
    throw new Error("Claude CLI query options require an explicit resolved binary path.");
  }
  if (input.model === undefined || input.model === "") {
    throw new Error("Claude CLI query options require an explicit model.");
  }
  if (input.cwd === "") {
    throw new ClaudeWorkingAreaError("spawn-check", "unavailable");
  }
  if (input.resume !== undefined && input.sessionId !== undefined) {
    throw new Error("Claude CLI query options accept either resume or sessionId, not both.");
  }

  const env = {
    ...buildChildEnv(input.baseEnv, input.runtime, {
      platform,
      ...(input.home === undefined ? {} : { home: input.home }),
    }),
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  };

  buildClaudeCliSpawnInvocation({
    binaryPath,
    args: [],
    env,
    platform,
  });

  const options: SanitizedQueryOptions = {
    pathToClaudeCodeExecutable: binaryPath,
    model: input.model,
    env,
    strictMcpConfig: true,
    settingSources: [],
    mcpServers: input.mcpServers ?? {},
  };

  const windowsCommandShim =
    platform === "win32" && win32.extname(binaryPath).toLowerCase() === ".cmd";
  if (windowsCommandShim) {
    const state: WindowsMcpConfigQueryState = { cleanupFailure: null };
    windowsMcpConfigQueryStates.set(options, state);
  }
  options.spawnClaudeCodeProcess = (spawnOptions) => {
    if (spawnOptions.cwd !== input.cwd) {
      throw new ClaudeWorkingAreaError("spawn-check", "identity-changed");
    }
    input.assertWorkingArea();
    const state = windowsMcpConfigQueryStates.get(options);
    return spawnClaudeCliProcess(spawnOptions, {
      platform,
      stderr: input.stderr,
      ...(input.windowsMcpConfigFileSystem === undefined
        ? {}
        : { windowsMcpConfigFileSystem: input.windowsMcpConfigFileSystem }),
      ...(state === undefined
        ? {}
        : {
            onWindowsMcpConfigCleanup: (cleanup: () => void) => {
              state.cleanup = cleanup;
            },
            onWindowsMcpConfigCleanupFailure: (error: ClaudeCliWindowsMcpConfigError) => {
              state.cleanupFailure ??= error;
            },
          }),
    });
  };

  if (input.systemPrompt !== undefined) options.systemPrompt = input.systemPrompt;
  if (input.tools !== undefined) options.tools = input.tools;
  if (input.allowedTools !== undefined) options.allowedTools = input.allowedTools;
  if (input.canUseTool !== undefined) options.canUseTool = input.canUseTool;
  if (input.maxTurns !== undefined) options.maxTurns = input.maxTurns;
  if (input.resume !== undefined) options.resume = input.resume;
  if (input.sessionId !== undefined) options.sessionId = input.sessionId;
  options.cwd = input.cwd;
  if (input.persistSession !== undefined) options.persistSession = input.persistSession;
  if (input.includePartialMessages !== undefined) {
    options.includePartialMessages = input.includePartialMessages;
  }
  if (input.abortController !== undefined) options.abortController = input.abortController;
  if (input.stderr !== undefined) options.stderr = input.stderr;

  return options;
}

export interface ClaudeCliGeneration {
  frames(): AsyncIterable<SDKMessage>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  lastResult(): SDKResultMessage | null;
  iterationError(): unknown;
  cleanupError(): ClaudeCliWindowsMcpConfigError | null;
}

export interface StartGenerationDeps {
  query?: typeof sdkQuery;
}

export interface StartGenerationSpec {
  prompt: ClaudeCliPrompt;
  options: SanitizedQueryOptions;
}

export function startGeneration(
  spec: StartGenerationSpec,
  deps: StartGenerationDeps = {},
): ClaudeCliGeneration {
  const run = deps.query ?? sdkQuery;
  const active: Query = run({ prompt: spec.prompt, options: spec.options });
  const windowsMcpConfigState = windowsMcpConfigQueryStates.get(spec.options);

  let started = false;
  let closed = false;
  let result: SDKResultMessage | null = null;
  let caught: unknown = null;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      await active.return(undefined);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    } finally {
      windowsMcpConfigState?.cleanup?.();
    }
  };
  const frames = async function* (): AsyncGenerator<SDKMessage, void> {
    if (started) {
      throw new Error("Claude CLI generation frames() may only be consumed once.");
    }
    started = true;
    let cleanupOnlyFailure: ClaudeCliWindowsMcpConfigError | null = null;
    try {
      for await (const message of active) {
        if (message.type === "result") result = message;
        yield message;
      }
    } catch (err) {
      caught = err;
      if (result === null) {
        throw normalizeClaudeCliError(err);
      }
    } finally {
      await close();
      if (
        result === null &&
        caught === null &&
        windowsMcpConfigState?.cleanupFailure !== null &&
        windowsMcpConfigState?.cleanupFailure !== undefined
      ) {
        caught = windowsMcpConfigState.cleanupFailure;
        cleanupOnlyFailure = windowsMcpConfigState.cleanupFailure;
      }
    }
    if (cleanupOnlyFailure !== null) throw cleanupOnlyFailure;
  };
  return {
    frames,
    interrupt: async (): Promise<void> => {
      if (closed) return;
      await active.interrupt();
    },
    close,
    lastResult: () => result,
    iterationError: () => caught,
    cleanupError: () => windowsMcpConfigState?.cleanupFailure ?? null,
  };
}
