import { isStableDesktopVersion } from "./desktop-version.js";
import {
  DESKTOP_USAGE_PING_INTERVAL_MS,
  type DesktopUsagePingStateStore,
} from "./desktop-usage-ping-state.js";

export const DESKTOP_USAGE_PING_ENDPOINT = "https://ping.enduragent.icu/v1/ping" as const;
export const DESKTOP_USAGE_PING_TIMEOUT_MS = 5_000;

export type DesktopUsagePingChannel = "macos" | "windows";

export interface DesktopUsagePingRequest {
  (url: string, init: RequestInit): Promise<unknown>;
}

export interface DesktopUsagePingController {
  start(): Promise<void>;
  close(): void;
}

interface TimerHandle {
  unref(): void;
}

function validChannel(channel: string): channel is DesktopUsagePingChannel {
  return channel === "macos" || channel === "windows";
}

export function desktopUsagePingChannelForPlatform(
  platform: NodeJS.Platform,
): DesktopUsagePingChannel | undefined {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return undefined;
}

export function createDesktopUsagePingController(input: {
  readonly releaseEligible: boolean;
  readonly version: string;
  readonly channel: DesktopUsagePingChannel;
  readonly state: DesktopUsagePingStateStore;
  readonly request: DesktopUsagePingRequest;
  readonly now?: () => number;
  readonly setTimeout?: (callback: () => void, timeout: number) => TimerHandle;
  readonly clearTimeout?: (handle: TimerHandle) => void;
}): DesktopUsagePingController {
  const active =
    input.releaseEligible && isStableDesktopVersion(input.version) && validChannel(input.channel);
  const now = input.now ?? Date.now;
  const scheduleTimeout =
    input.setTimeout ??
    ((callback, timeout) => globalThis.setTimeout(callback, timeout) as TimerHandle);
  const unscheduleTimeout =
    input.clearTimeout ??
    ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>));
  let started = false;
  let closed = false;
  let scheduled: TimerHandle | undefined;
  let requestController: AbortController | undefined;
  let inFlight: Promise<void> | undefined;

  const clearScheduled = (): void => {
    if (scheduled === undefined) return;
    unscheduleTimeout(scheduled);
    scheduled = undefined;
  };

  const schedule = (delay: number): void => {
    if (closed || !active) return;
    clearScheduled();
    const boundedDelay =
      Number.isSafeInteger(delay) && delay > 0 && delay <= DESKTOP_USAGE_PING_INTERVAL_MS
        ? delay
        : DESKTOP_USAGE_PING_INTERVAL_MS;
    const handle = scheduleTimeout(() => {
      if (scheduled === handle) scheduled = undefined;
      void run();
    }, boundedDelay);
    scheduled = handle;
    handle.unref();
  };

  const send = async (instanceId: string): Promise<void> => {
    if (closed) return;
    const controller = new AbortController();
    requestController = controller;
    let deadline: TimerHandle | undefined;
    try {
      deadline = scheduleTimeout(() => controller.abort(), DESKTOP_USAGE_PING_TIMEOUT_MS);
      deadline.unref();
      await input.request(DESKTOP_USAGE_PING_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          product: "enduragent-desktop",
          version: input.version,
          channel: input.channel,
          instance: instanceId,
        }),
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (!(error instanceof Error)) throw error;
    } finally {
      if (deadline !== undefined) unscheduleTimeout(deadline);
      if (requestController === controller) requestController = undefined;
    }
  };

  const perform = async (): Promise<void> => {
    let claim;
    try {
      claim = await input.state.claimAttempt(now());
    } catch {
      claim = { status: "unavailable" } as const;
    }
    if (closed) return;
    if (claim.status === "deferred") {
      schedule(claim.retryAfterMs);
      return;
    }
    if (claim.status === "unavailable") {
      schedule(DESKTOP_USAGE_PING_INTERVAL_MS);
      return;
    }
    await send(claim.instanceId);
    schedule(DESKTOP_USAGE_PING_INTERVAL_MS);
  };

  const run = (): Promise<void> => {
    if (closed || !active) return Promise.resolve();
    if (inFlight !== undefined) return inFlight;
    let operation: Promise<void>;
    operation = perform()
      .catch(() => {
        schedule(DESKTOP_USAGE_PING_INTERVAL_MS);
      })
      .finally(() => {
        if (inFlight === operation) inFlight = undefined;
      });
    inFlight = operation;
    return operation;
  };

  return {
    start() {
      if (started || closed || !active) return Promise.resolve();
      started = true;
      return run();
    },
    close() {
      if (closed) return;
      closed = true;
      clearScheduled();
      requestController?.abort();
    },
  };
}
