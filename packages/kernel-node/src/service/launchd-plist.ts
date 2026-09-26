import { execFile as nodeExecFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat as nodeLstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import type { AthleteHome } from "../home/index.js";

export const LAUNCHD_THROTTLE_INTERVAL_SECONDS = 10 as const;
export const LAUNCHD_PLIST_MODE = 0o600 as const;
export const LAUNCHD_STATE_DIR_MODE = 0o700 as const;
export const LAUNCHD_ENV_MODE = 0o600 as const;
export const LAUNCHD_WRAPPER_MODE = 0o700 as const;

const LAUNCHCTL_PATH = "/bin/launchctl";
const LAUNCHCTL_TIMEOUT_MS = 5_000;
const STATUS_UNAVAILABLE_DETAIL = "launchd status unavailable";
const COMMAND_FAILED_MESSAGE = "launchd service command failed";
const SERVICE_LABEL_PATTERN = /^[A-Za-z0-9._-]+$/;
const HANDOFF_CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const LAUNCHD_WRAPPER_BYTES = `#!/bin/sh
set -eu
env_file="$1"
shift
. "$env_file"
handoff_file="\${env_file%.env}.handoff"
if [ -e "$handoff_file" ] || [ -L "$handoff_file" ]; then
  if [ -L "$handoff_file" ] || [ ! -f "$handoff_file" ]; then
    /bin/rm -f "$handoff_file"
    exit 1
  fi
  handoff_mode="$(/usr/bin/stat -f '%Lp' "$handoff_file")" || {
    /bin/rm -f "$handoff_file"
    exit 1
  }
  if [ "$handoff_mode" != "600" ]; then
    /bin/rm -f "$handoff_file"
    exit 1
  fi
  exec 9< "$handoff_file"
  IFS= read -r ENDURAGENT_HANDOFF_CAPABILITY <&9 || {
    exec 9<&-
    /bin/rm -f "$handoff_file"
    exit 1
  }
  if IFS= read -r handoff_extra <&9; then
    exec 9<&-
    /bin/rm -f "$handoff_file"
    exit 1
  fi
  exec 9<&-
  /bin/rm -f "$handoff_file"
  if [ "\${#ENDURAGENT_HANDOFF_CAPABILITY}" -ne 43 ]; then
    exit 1
  fi
  case "$ENDURAGENT_HANDOFF_CAPABILITY" in
    *[!A-Za-z0-9_-]*) exit 1 ;;
  esac
  export ENDURAGENT_HANDOFF_CAPABILITY
fi
exec "$@"
`;

export interface LaunchdServiceIdentity {
  readonly label: string;
  readonly executablePath: string;
  readonly home: AthleteHome;
}

export interface LaunchdServicePaths {
  readonly launchAgentsDir: string;
  readonly plistPath: string;
  readonly stateDir: string;
  readonly envPath: string;
  readonly wrapperPath: string;
  readonly handoffPath: string;
}

export type LaunchdServiceStatus =
  | {
      readonly kind: "absent";
      readonly registered: false;
      readonly installed: false;
      readonly loaded: false;
      readonly running: false;
      readonly label: string;
      readonly pid: null;
      readonly lastExitStatus: null;
      readonly paths: LaunchdServicePaths;
    }
  | {
      readonly kind: "registered";
      readonly registered: true;
      readonly installed: boolean;
      readonly loaded: boolean;
      readonly running: boolean;
      readonly label: string;
      readonly pid: number | null;
      readonly lastExitStatus: number | null;
      readonly paths: LaunchdServicePaths;
    }
  | {
      readonly kind: "unknown";
      readonly registered: null;
      readonly installed: boolean | null;
      readonly loaded: null;
      readonly running: null;
      readonly label: string;
      readonly pid: null;
      readonly lastExitStatus: null;
      readonly paths: LaunchdServicePaths;
      readonly detail: string;
    };

export type LaunchdCommandResult =
  | {
      readonly outcome: "exited";
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  | {
      readonly outcome: "timed-out" | "signaled" | "spawn-failed";
      readonly exitCode: null;
      readonly stdout: string;
      readonly stderr: string;
    };

export interface LaunchdDesignatedSuccessorInput {
  readonly targetProtocolVersion: number;
  readonly handoffCapability: string;
}

export interface LaunchdServiceDependencies {
  readonly platform?: NodeJS.Platform;
  readonly uid?: number;
  readonly userHome?: string;
  readonly runLaunchctl?: (args: readonly string[]) => Promise<LaunchdCommandResult>;
  readonly execFile?: typeof import("node:child_process").execFile;
  readonly lstat?: typeof import("node:fs/promises").lstat;
}

export class UnsupportedLaunchdPlatformError extends Error {
  constructor() {
    super("launchd service management is unavailable");
    this.name = "UnsupportedLaunchdPlatformError";
  }
}

export class LaunchdServiceNotInstalledError extends Error {
  constructor() {
    super("launchd service is not installed");
    this.name = "LaunchdServiceNotInstalledError";
  }
}

export class LaunchdServiceCommandError extends Error {
  constructor() {
    super(COMMAND_FAILED_MESSAGE);
    this.name = "LaunchdServiceCommandError";
  }
}

interface LaunchdRuntime {
  readonly uid: number;
  readonly userHome: string;
  readonly runLaunchctl: (args: readonly string[]) => Promise<LaunchdCommandResult>;
  readonly lstat: typeof nodeLstat;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function validateIdentity(identity: LaunchdServiceIdentity): void {
  if (
    !isAbsolute(identity.home.root) ||
    !isAbsolute(identity.home.configDir) ||
    !isAbsolute(identity.executablePath)
  ) {
    throw new TypeError("launchd service paths must be absolute");
  }
  if (!SERVICE_LABEL_PATTERN.test(identity.label)) {
    throw new TypeError("launchd service label is invalid");
  }
}

function createDefaultLaunchctlRunner(
  userHome: string,
  execFile: typeof nodeExecFile,
): (args: readonly string[]) => Promise<LaunchdCommandResult> {
  return async (args) =>
    await new Promise((resolveResult) => {
      execFile(
        LAUNCHCTL_PATH,
        [...args],
        {
          shell: false,
          encoding: "utf8",
          timeout: LAUNCHCTL_TIMEOUT_MS,
          env: {
            PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
            HOME: userHome,
          },
        },
        (error, stdoutValue, stderrValue) => {
          const stdout = typeof stdoutValue === "string" ? stdoutValue : "";
          const stderr = typeof stderrValue === "string" ? stderrValue : "";
          if (error === null) {
            resolveResult({ outcome: "exited", exitCode: 0, stdout, stderr });
            return;
          }
          if (error.killed === true) {
            resolveResult({
              outcome: "timed-out",
              exitCode: null,
              stdout,
              stderr,
            });
            return;
          }
          if (typeof error.code === "number") {
            resolveResult({
              outcome: "exited",
              exitCode: error.code,
              stdout,
              stderr,
            });
            return;
          }
          if (error.signal !== null && error.signal !== undefined) {
            resolveResult({
              outcome: "signaled",
              exitCode: null,
              stdout,
              stderr,
            });
            return;
          }
          resolveResult({
            outcome: "spawn-failed",
            exitCode: null,
            stdout,
            stderr,
          });
        },
      );
    });
}

function resolveRuntime(dependencies: LaunchdServiceDependencies = {}): LaunchdRuntime {
  if ((dependencies.platform ?? process.platform) !== "darwin") {
    throw new UnsupportedLaunchdPlatformError();
  }
  const uid = dependencies.uid ?? process.getuid?.();
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) {
    throw new UnsupportedLaunchdPlatformError();
  }
  const userHome = dependencies.userHome ?? homedir();
  if (!isAbsolute(userHome)) {
    throw new TypeError("launchd user home must be absolute");
  }
  return {
    uid,
    userHome,
    runLaunchctl:
      dependencies.runLaunchctl ??
      createDefaultLaunchctlRunner(userHome, dependencies.execFile ?? nodeExecFile),
    lstat: dependencies.lstat ?? nodeLstat,
  };
}

function pathsFor(identity: LaunchdServiceIdentity, userHome: string): LaunchdServicePaths {
  const launchAgentsDir = join(userHome, "Library", "LaunchAgents");
  const stateDir = join(identity.home.configDir, "service");
  return Object.freeze({
    launchAgentsDir,
    plistPath: join(launchAgentsDir, `${identity.label}.plist`),
    stateDir,
    envPath: join(stateDir, `${identity.label}.env`),
    wrapperPath: join(stateDir, `${identity.label}-env-wrapper.sh`),
    handoffPath: join(stateDir, `${identity.label}.handoff`),
  });
}

function domain(runtime: LaunchdRuntime): string {
  return `gui/${runtime.uid}`;
}

function serviceTarget(identity: LaunchdServiceIdentity, runtime: LaunchdRuntime): string {
  return `${domain(runtime)}/${identity.label}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function buildEnvironmentBytes(identity: LaunchdServiceIdentity): string {
  return `export ENDURAGENT_HOME=${shellQuote(identity.home.root)}\nexport ENDURAGENT_DAEMON_OWNER='service-managed'\n`;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function isNotFound(result: LaunchdCommandResult): boolean {
  if (result.outcome !== "exited" || result.exitCode === 0) return false;
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    output.includes("could not find service") ||
    output.includes("service not found") ||
    output.includes("no such process")
  );
}

async function runCommand(
  runtime: LaunchdRuntime,
  args: readonly string[],
  allowNotFound = false,
): Promise<void> {
  let result: LaunchdCommandResult;
  try {
    result = await runtime.runLaunchctl(args);
  } catch {
    throw new LaunchdServiceCommandError();
  }
  if (result.outcome === "exited" && result.exitCode === 0) return;
  if (allowNotFound && isNotFound(result)) return;
  throw new LaunchdServiceCommandError();
}

function unknownStatus(
  identity: LaunchdServiceIdentity,
  paths: LaunchdServicePaths,
  installed: boolean | null,
): Extract<LaunchdServiceStatus, { kind: "unknown" }> {
  return {
    kind: "unknown",
    registered: null,
    installed,
    loaded: null,
    running: null,
    label: identity.label,
    pid: null,
    lastExitStatus: null,
    paths,
    detail: STATUS_UNAVAILABLE_DETAIL,
  };
}

function parsePositiveInteger(output: string, expression: RegExp): number | null {
  const value = expression.exec(output)?.[1];
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseInteger(output: string, expression: RegExp): number | null {
  const value = expression.exec(output)?.[1];
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function statusWithRuntime(
  identity: LaunchdServiceIdentity,
  paths: LaunchdServicePaths,
  runtime: LaunchdRuntime,
): Promise<LaunchdServiceStatus> {
  let installed: boolean;
  try {
    const stat = await runtime.lstat(paths.plistPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return unknownStatus(identity, paths, null);
    }
    installed = true;
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      return unknownStatus(identity, paths, null);
    }
    installed = false;
  }

  let result: LaunchdCommandResult;
  try {
    result = await runtime.runLaunchctl(["print", serviceTarget(identity, runtime)]);
  } catch {
    return unknownStatus(identity, paths, installed);
  }

  if (result.outcome === "exited" && result.exitCode === 0) {
    const pid = parsePositiveInteger(result.stdout, /^\s*pid\s*=\s*(\d+)\s*$/im);
    const lastExitStatus = parseInteger(result.stdout, /^\s*last exit status\s*=\s*(-?\d+)\s*$/im);
    return {
      kind: "registered",
      registered: true,
      installed,
      loaded: true,
      running: /^\s*state\s*=\s*running\s*$/im.test(result.stdout) || pid !== null,
      label: identity.label,
      pid,
      lastExitStatus,
      paths,
    };
  }

  if (isNotFound(result)) {
    if (!installed) {
      return {
        kind: "absent",
        registered: false,
        installed: false,
        loaded: false,
        running: false,
        label: identity.label,
        pid: null,
        lastExitStatus: null,
        paths,
      };
    }
    return {
      kind: "registered",
      registered: true,
      installed: true,
      loaded: false,
      running: false,
      label: identity.label,
      pid: null,
      lastExitStatus: null,
      paths,
    };
  }

  return unknownStatus(identity, paths, installed);
}

async function atomicPublish(targetPath: string, bytes: string, mode: number): Promise<void> {
  for (;;) {
    const candidate = join(
      dirname(targetPath),
      `.${basename(targetPath)}.${randomBytes(12).toString("hex")}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(
        candidate,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        mode,
      );
    } catch (error) {
      if (isErrno(error, "EEXIST")) continue;
      throw error;
    }

    let openHandle: typeof handle | null = handle;
    try {
      await handle.writeFile(bytes, "utf8");
      await handle.sync();
      await handle.close();
      openHandle = null;
      await chmod(candidate, mode);
      await rename(candidate, targetPath);
      return;
    } catch (error) {
      if (openHandle !== null) {
        try {
          await openHandle.close();
        } catch (closeError) {
          if (!(typeof closeError === "object" && closeError !== null && "code" in closeError && (String(closeError.code) === "EBADF" || String(closeError.code) === "ERR_DIR_CLOSED"))) throw closeError;
        }
      }
      try {
        await unlink(candidate);
      } catch (cleanupError) {
        if (!isErrno(cleanupError, "ENOENT")) throw error;
      }
      throw error;
    }
  }
}

async function removeOwnedFile(path: string): Promise<void> {
  let stat: Awaited<ReturnType<typeof nodeLstat>>;
  try {
    stat = await nodeLstat(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new LaunchdServiceCommandError();
  }
  try {
    await unlink(path);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
}

async function removeHandoff(paths: LaunchdServicePaths): Promise<void> {
  try {
    await removeOwnedFile(paths.handoffPath);
  } catch (error) {
    if (error instanceof LaunchdServiceCommandError) throw error;
    throw new LaunchdServiceCommandError();
  }
}

function validateSuccessorInput(input: LaunchdDesignatedSuccessorInput): void {
  if (
    !Number.isSafeInteger(input.targetProtocolVersion) ||
    input.targetProtocolVersion < 0 ||
    !HANDOFF_CAPABILITY_PATTERN.test(input.handoffCapability)
  ) {
    throw new TypeError("launchd designated successor input is invalid");
  }
}

async function publishHandoff(
  paths: LaunchdServicePaths,
  input: LaunchdDesignatedSuccessorInput,
): Promise<void> {
  try {
    await atomicPublish(paths.handoffPath, `${input.handoffCapability}\n`, LAUNCHD_ENV_MODE);
  } catch {
    throw new LaunchdServiceCommandError();
  }
}

async function cleanFailedHandoff(paths: LaunchdServicePaths): Promise<void> {
  await removeOwnedFile(paths.handoffPath);
}

function requireRegistered(
  status: LaunchdServiceStatus,
): Extract<LaunchdServiceStatus, { kind: "registered" }> {
  if (status.kind === "absent") {
    throw new LaunchdServiceNotInstalledError();
  }
  if (status.kind === "unknown") {
    throw new LaunchdServiceCommandError();
  }
  return status;
}

export function deriveLaunchdServiceLabel(athleteHomeRoot: string): string {
  const normalizedRoot = resolve(athleteHomeRoot);
  const suffix = createHash("sha256").update(normalizedRoot, "utf8").digest("hex").slice(0, 16);
  return `ai.enduragent.coach.${suffix}`;
}

export function canonicalizeAthleteHome(home: AthleteHome): AthleteHome {
  const root = resolve(home.root);
  const storeDir = resolve(home.storeDir);
  const archiveDir = resolve(home.archiveDir);
  const configDir = resolve(home.configDir);
  if (
    storeDir !== join(root, "store") ||
    archiveDir !== join(root, "archive") ||
    configDir !== join(root, "config")
  ) {
    throw new TypeError("athlete home paths are inconsistent");
  }
  return Object.freeze({ root, storeDir, archiveDir, configDir });
}

export function createLaunchdServiceIdentity(input: {
  readonly home: AthleteHome;
  readonly executablePath: string;
  readonly label?: string;
}): LaunchdServiceIdentity {
  if (
    !isAbsolute(input.home.root) ||
    !isAbsolute(input.home.configDir) ||
    !isAbsolute(input.executablePath)
  ) {
    throw new TypeError("launchd service paths must be absolute");
  }
  const label = input.label ?? deriveLaunchdServiceLabel(input.home.root);
  const identity = {
    label,
    executablePath: resolve(input.executablePath),
    home: input.home,
  };
  validateIdentity(identity);
  return Object.freeze(identity);
}

export function resolveLaunchdServicePaths(
  identity: LaunchdServiceIdentity,
  dependencies: LaunchdServiceDependencies = {},
): LaunchdServicePaths {
  validateIdentity(identity);
  const runtime = resolveRuntime(dependencies);
  return pathsFor(identity, runtime.userHome);
}

export function buildLaunchdServicePlist(
  identity: LaunchdServiceIdentity,
  paths: LaunchdServicePaths,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xmlEscape(identity.label)}</string>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/sh</string>
      <string>${xmlEscape(paths.wrapperPath)}</string>
      <string>${xmlEscape(paths.envPath)}</string>
      <string>${xmlEscape(identity.executablePath)}</string>
      <string>serve</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>${LAUNCHD_THROTTLE_INTERVAL_SECONDS}</integer>
  </dict>
</plist>
`;
}

export async function readLaunchdServiceStatus(
  identity: LaunchdServiceIdentity,
  dependencies: LaunchdServiceDependencies = {},
): Promise<LaunchdServiceStatus> {
  validateIdentity(identity);
  const runtime = resolveRuntime(dependencies);
  const paths = pathsFor(identity, runtime.userHome);
  return await statusWithRuntime(identity, paths, runtime);
}

export async function installLaunchdService(
  identity: LaunchdServiceIdentity,
  dependencies: LaunchdServiceDependencies = {},
): Promise<Extract<LaunchdServiceStatus, { kind: "registered" }>> {
  validateIdentity(identity);
  const runtime = resolveRuntime(dependencies);
  const paths = pathsFor(identity, runtime.userHome);
  try {
    await mkdir(paths.launchAgentsDir, { recursive: true, mode: 0o755 });
    await mkdir(paths.stateDir, {
      recursive: true,
      mode: LAUNCHD_STATE_DIR_MODE,
    });
    const stateStat = await nodeLstat(paths.stateDir);
    if (!stateStat.isDirectory() || stateStat.isSymbolicLink()) {
      throw new LaunchdServiceCommandError();
    }
    await chmod(paths.stateDir, LAUNCHD_STATE_DIR_MODE);
    await atomicPublish(paths.envPath, buildEnvironmentBytes(identity), LAUNCHD_ENV_MODE);
    await atomicPublish(paths.wrapperPath, LAUNCHD_WRAPPER_BYTES, LAUNCHD_WRAPPER_MODE);
    await atomicPublish(
      paths.plistPath,
      buildLaunchdServicePlist(identity, paths),
      LAUNCHD_PLIST_MODE,
    );
  } catch (error) {
    if (error instanceof LaunchdServiceCommandError) throw error;
    throw new LaunchdServiceCommandError();
  }

  await runCommand(runtime, ["bootout", serviceTarget(identity, runtime)], true);
  await runCommand(runtime, ["enable", serviceTarget(identity, runtime)]);
  await runCommand(runtime, ["bootstrap", domain(runtime), paths.plistPath]);
  const status = await statusWithRuntime(identity, paths, runtime);
  if (status.kind !== "registered" || !status.loaded) {
    throw new LaunchdServiceCommandError();
  }
  return status;
}

export async function uninstallLaunchdService(
  identity: LaunchdServiceIdentity,
  dependencies: LaunchdServiceDependencies = {},
): Promise<Extract<LaunchdServiceStatus, { kind: "absent" }>> {
  validateIdentity(identity);
  const runtime = resolveRuntime(dependencies);
  const paths = pathsFor(identity, runtime.userHome);
  await runCommand(runtime, ["bootout", serviceTarget(identity, runtime)], true);
  try {
    for (const path of [paths.plistPath, paths.envPath, paths.wrapperPath, paths.handoffPath]) {
      await removeOwnedFile(path);
    }
  } catch (error) {
    if (error instanceof LaunchdServiceCommandError) throw error;
    throw new LaunchdServiceCommandError();
  }
  const status = await statusWithRuntime(identity, paths, runtime);
  if (status.kind !== "absent") throw new LaunchdServiceCommandError();
  return status;
}

export async function restartLaunchdService(
  identity: LaunchdServiceIdentity,
  dependencies: LaunchdServiceDependencies = {},
): Promise<Extract<LaunchdServiceStatus, { kind: "registered" }>> {
  validateIdentity(identity);
  const runtime = resolveRuntime(dependencies);
  const paths = pathsFor(identity, runtime.userHome);
  await removeHandoff(paths);
  const initial = requireRegistered(await statusWithRuntime(identity, paths, runtime));
  if (initial.loaded) {
    await runCommand(runtime, ["kickstart", "-k", serviceTarget(identity, runtime)]);
  } else {
    await runCommand(runtime, ["enable", serviceTarget(identity, runtime)]);
    await runCommand(runtime, ["bootstrap", domain(runtime), paths.plistPath]);
  }
  const status = await statusWithRuntime(identity, paths, runtime);
  if (status.kind !== "registered") throw new LaunchdServiceCommandError();
  return status;
}

export async function resumeLaunchdService(
  identity: LaunchdServiceIdentity,
  dependencies: LaunchdServiceDependencies = {},
): Promise<"resumed" | "not-installed"> {
  validateIdentity(identity);
  const runtime = resolveRuntime(dependencies);
  const paths = pathsFor(identity, runtime.userHome);
  await removeHandoff(paths);
  const status = await statusWithRuntime(identity, paths, runtime);
  if (status.kind === "absent") return "not-installed";
  if (status.kind === "unknown") throw new LaunchdServiceCommandError();
  if (!status.loaded) {
    await runCommand(runtime, ["enable", serviceTarget(identity, runtime)]);
    await runCommand(runtime, ["bootstrap", domain(runtime), paths.plistPath]);
  } else if (!status.running) {
    await runCommand(runtime, ["kickstart", serviceTarget(identity, runtime)]);
  }
  return "resumed";
}

export async function restartLaunchdServiceForUpgrade(
  identity: LaunchdServiceIdentity,
  input: LaunchdDesignatedSuccessorInput,
  dependencies: LaunchdServiceDependencies = {},
): Promise<Extract<LaunchdServiceStatus, { kind: "registered" }>> {
  validateIdentity(identity);
  validateSuccessorInput(input);
  const runtime = resolveRuntime(dependencies);
  const paths = pathsFor(identity, runtime.userHome);
  const initial = requireRegistered(await statusWithRuntime(identity, paths, runtime));
  if (!initial.loaded) {
    await runCommand(runtime, ["enable", serviceTarget(identity, runtime)]);
  }
  await publishHandoff(paths, input);
  try {
    if (initial.loaded) {
      await runCommand(runtime, ["kickstart", "-k", serviceTarget(identity, runtime)]);
    } else {
      await runCommand(runtime, ["bootstrap", domain(runtime), paths.plistPath]);
    }
  } catch (error) {
    await cleanFailedHandoff(paths);
    throw error;
  }
  const status = await statusWithRuntime(identity, paths, runtime);
  if (status.kind !== "registered") throw new LaunchdServiceCommandError();
  return status;
}

export async function resumeLaunchdServiceAfterEphemeral(
  identity: LaunchdServiceIdentity,
  input: LaunchdDesignatedSuccessorInput,
  dependencies: LaunchdServiceDependencies = {},
): Promise<"resumed"> {
  validateIdentity(identity);
  validateSuccessorInput(input);
  const runtime = resolveRuntime(dependencies);
  const paths = pathsFor(identity, runtime.userHome);
  const status = requireRegistered(await statusWithRuntime(identity, paths, runtime));
  if (status.running) throw new LaunchdServiceCommandError();
  if (!status.loaded) {
    await runCommand(runtime, ["enable", serviceTarget(identity, runtime)]);
  }
  await publishHandoff(paths, input);
  try {
    if (status.loaded) {
      await runCommand(runtime, ["kickstart", serviceTarget(identity, runtime)]);
    } else {
      await runCommand(runtime, ["bootstrap", domain(runtime), paths.plistPath]);
    }
  } catch (error) {
    await cleanFailedHandoff(paths);
    throw error;
  }
  return "resumed";
}
