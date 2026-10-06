import type { App, CrashReporter } from "electron";
import { createSafeLog } from "./safe-log.js";

export const DESKTOP_CRASH_TELEMETRY_FIELD_LIMIT = 120;

export type DesktopCrashReporterPort = Pick<CrashReporter, "start">;
export type DesktopCrashTelemetryAppPort = Pick<App, "on">;

export type DesktopCrashReporterOutcome = "started" | "unavailable";

export interface DesktopRenderProcessGoneFields {
  readonly url: string;
  readonly title: string;
  readonly reason: string;
  readonly exitCode: number;
}

export interface DesktopChildProcessGoneFields {
  readonly type: string;
  readonly reason: string;
  readonly exitCode: number;
  readonly name?: string;
}

function telemetryField(value: string | undefined): string {
  const collapsed = (value ?? "").replaceAll(/[\s\p{C}]+/gu, "_");
  if (collapsed.length === 0) return "unknown";
  if (collapsed.length <= DESKTOP_CRASH_TELEMETRY_FIELD_LIMIT) return collapsed;
  return `${collapsed.slice(0, DESKTOP_CRASH_TELEMETRY_FIELD_LIMIT)}...`;
}

function telemetryLocation(value: string | undefined): string {
  return telemetryField((value ?? "").split(/[?#]/u)[0]);
}

function telemetryExitCode(value: number | undefined): string {
  return Number.isInteger(value) ? String(value) : "unknown";
}

export function describeRenderProcessGone(fields: DesktopRenderProcessGoneFields): string {
  return [
    "desktop-renderer-process-gone",
    `reason=${telemetryField(fields.reason)}`,
    `exitCode=${telemetryExitCode(fields.exitCode)}`,
    `url=${telemetryLocation(fields.url)}`,
    `title=${telemetryField(fields.title)}`,
  ].join(" ");
}

export function describeChildProcessGone(fields: DesktopChildProcessGoneFields): string {
  return [
    "desktop-child-process-gone",
    `type=${telemetryField(fields.type)}`,
    `reason=${telemetryField(fields.reason)}`,
    `exitCode=${telemetryExitCode(fields.exitCode)}`,
    `name=${telemetryField(fields.name)}`,
  ].join(" ");
}

export function startDesktopCrashReporter(input: {
  readonly crashReporter: DesktopCrashReporterPort;
  readonly log?: (message: string) => void;
}): DesktopCrashReporterOutcome {
  const log = createSafeLog(input.log);
  try {
    input.crashReporter.start({ uploadToServer: false });
    return "started";
  } catch {
    log("desktop-crash-reporter-unavailable");
    return "unavailable";
  }
}

export function installDesktopCrashTelemetry(input: {
  readonly app: DesktopCrashTelemetryAppPort;
  readonly log?: (message: string) => void;
}): void {
  const log = createSafeLog(input.log);
  input.app.on("render-process-gone", (_event, webContents, details) => {
    let url = "";
    let title = "";
    try {
      url = webContents.getURL();
      title = webContents.getTitle();
    } catch {}
    log(
      describeRenderProcessGone({
        url,
        title,
        reason: details.reason,
        exitCode: details.exitCode,
      }),
    );
  });
  input.app.on("child-process-gone", (_event, details) => {
    log(
      describeChildProcessGone({
        type: details.type,
        reason: details.reason,
        exitCode: details.exitCode,
        name: details.name,
      }),
    );
  });
}
