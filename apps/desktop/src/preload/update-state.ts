import { exactKeys, record } from "./shape.js";

const STABLE_VERSION_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

export interface PreloadUpdateDownloadProgress {
  readonly percent: number;
  readonly transferredBytes: number;
  readonly totalBytes: number;
  readonly bytesPerSecond: number;
}

export type PreloadUpdateState =
  | { readonly status: "disabled" | "idle" | "checking" | "current" }
  | {
      readonly status: "downloading";
      readonly version: string;
      readonly progress?: PreloadUpdateDownloadProgress;
    }
  | { readonly status: "preparing" | "downloaded" | "installing"; readonly version: string }
  | { readonly status: "restart-required"; readonly stage: "check" | "download" }
  | { readonly status: "failed"; readonly stage: "check" | "download" };

function isStableVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 64 &&
    value.trim() === value &&
    STABLE_VERSION_RE.test(value)
  );
}

function parseUpdateDownloadProgress(value: unknown): PreloadUpdateDownloadProgress {
  if (
    !record(value) ||
    !exactKeys(value, ["percent", "transferredBytes", "totalBytes", "bytesPerSecond"]) ||
    !Number.isSafeInteger(value.percent) ||
    !Number.isSafeInteger(value.transferredBytes) ||
    !Number.isSafeInteger(value.totalBytes) ||
    !Number.isSafeInteger(value.bytesPerSecond)
  ) {
    throw new TypeError();
  }
  const percent = value.percent as number;
  const transferredBytes = value.transferredBytes as number;
  const totalBytes = value.totalBytes as number;
  const bytesPerSecond = value.bytesPerSecond as number;
  if (
    percent < 0 ||
    percent > 100 ||
    totalBytes < 1 ||
    transferredBytes < 0 ||
    transferredBytes > totalBytes ||
    bytesPerSecond < 0
  ) {
    throw new TypeError();
  }
  return { percent, transferredBytes, totalBytes, bytesPerSecond };
}

export function parseUpdateState(value: unknown): PreloadUpdateState {
  if (!record(value) || typeof value.status !== "string") throw new TypeError();
  if (["disabled", "idle", "checking", "current"].includes(value.status)) {
    if (!exactKeys(value, ["status"])) throw new TypeError();
    return { status: value.status as "disabled" | "idle" | "checking" | "current" };
  }
  if (value.status === "downloading") {
    const hasProgress = Object.hasOwn(value, "progress");
    if (
      !exactKeys(value, hasProgress ? ["status", "version", "progress"] : ["status", "version"]) ||
      !isStableVersion(value.version)
    ) {
      throw new TypeError();
    }
    return hasProgress
      ? {
          status: "downloading",
          version: value.version,
          progress: parseUpdateDownloadProgress(value.progress),
        }
      : {
          status: "downloading",
          version: value.version,
        };
  }
  if (["preparing", "downloaded", "installing"].includes(value.status)) {
    if (!exactKeys(value, ["status", "version"]) || !isStableVersion(value.version)) {
      throw new TypeError();
    }
    return {
      status: value.status as "preparing" | "downloaded" | "installing",
      version: value.version,
    };
  }
  if (
    (value.status !== "failed" && value.status !== "restart-required") ||
    !exactKeys(value, ["status", "stage"]) ||
    (value.stage !== "check" && value.stage !== "download")
  ) {
    throw new TypeError();
  }
  return { status: value.status, stage: value.stage };
}
