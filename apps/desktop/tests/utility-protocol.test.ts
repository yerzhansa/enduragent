import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPreferredSystemLanguages: () => ["en-US"] },
  utilityProcess: { fork: vi.fn() },
}));
import {
  isUtilityShutdownFrame,
  isUtilityStartFrame,
  isUtilityTerminalAckFrame,
  isUtilityTerminalFrame,
  createUtilityEnvironment,
} from "../src/main/supervisor.js";
import { createUtilityTerminalFrame } from "../src/utility/protocol.js";

describe("desktop utility protocol", () => {
  it("accepts preferred system languages in start frames", () => {
    expect(
      isUtilityStartFrame({
        type: "start",
        homeRoot: "/synthetic/athlete",
        appVersion: "2026.8.0",
        preferredLanguages: ["en-US"],
      }),
    ).toBe(true);
  });

  it("accepts only strict start and shutdown control frames", () => {
    expect(
      isUtilityStartFrame({
        type: "start",
        homeRoot: "/synthetic/athlete",
        appVersion: "2026.8.0",
      }),
    ).toBe(true);
    expect(
      isUtilityStartFrame({
        type: "start",
        homeRoot: "/synthetic/athlete",
        appVersion: "2026.8.0-beta.1",
        handoffCapability: "a".repeat(43),
      }),
    ).toBe(true);
    for (const frame of [
      { type: "start", homeRoot: "/synthetic/athlete" },
      { type: "start", homeRoot: "relative", appVersion: "2026.8.0" },
      { type: "start", homeRoot: "/synthetic/athlete", appVersion: "latest" },
      {
        type: "start",
        homeRoot: "/synthetic/athlete",
        appVersion: "2026.8.0",
        extra: true,
      },
      {
        type: "start",
        homeRoot: "/synthetic/athlete",
        appVersion: "2026.8.0",
        handoffCapability: "short",
      },
      { type: "unknown" },
    ])
      expect(isUtilityStartFrame(frame)).toBe(false);
    expect(isUtilityShutdownFrame({ type: "shutdown" })).toBe(true);
    expect(isUtilityShutdownFrame({ type: "shutdown", extra: true })).toBe(false);
  });

  it("accepts only strict terminal and acknowledgement frames", () => {
    expect(isUtilityTerminalFrame({ type: "terminal", exitCode: 0 })).toBe(true);
    for (const readinessFailure of ["not-configured", "unreadable", "malformed"]) {
      expect(isUtilityTerminalFrame({ type: "terminal", exitCode: 1, readinessFailure })).toBe(
        true,
      );
    }
    expect(isUtilityTerminalFrame({ type: "terminal", exitCode: -1 })).toBe(false);
    expect(isUtilityTerminalFrame({ type: "terminal", exitCode: 0, extra: true })).toBe(false);
    expect(
      isUtilityTerminalFrame({
        type: "terminal",
        exitCode: 1,
        readinessFailure: "invalid-profile",
      }),
    ).toBe(false);
    expect(
      isUtilityTerminalFrame({
        type: "terminal",
        exitCode: 1,
        readinessFailure: "malformed",
        message: "synthetic-private-detail",
      }),
    ).toBe(false);
    expect(isUtilityTerminalAckFrame({ type: "terminal-ack" })).toBe(true);
    expect(isUtilityTerminalAckFrame({ type: "terminal-ack", extra: true })).toBe(false);
  });

  it.each([
    [{ exitCode: 0 as const }, { type: "terminal", exitCode: 0 }],
    [
      { exitCode: 4 as const, readinessFailure: "not-configured" as const },
      { type: "terminal", exitCode: 4, readinessFailure: "not-configured" },
    ],
    [
      { exitCode: 1 as const, readinessFailure: "unreadable" as const },
      { type: "terminal", exitCode: 1, readinessFailure: "unreadable" },
    ],
    [
      { exitCode: 1 as const, readinessFailure: "malformed" as const },
      { type: "terminal", exitCode: 1, readinessFailure: "malformed" },
    ],
  ])("constructs the exact utility terminal frame for %j", (result, expected) => {
    const frame = createUtilityTerminalFrame(result);
    expect(frame).toEqual(expected);
    expect(Object.keys(frame).sort()).toEqual(Object.keys(expected).sort());
    expect(isUtilityTerminalFrame(frame)).toBe(true);
  });

  it("removes daemon ownership material from the utility environment", () => {
    expect(
      createUtilityEnvironment({
        PATH: "/synthetic/bin",
        ENDURAGENT_HOME: "/synthetic/athlete",
        ENDURAGENT_DAEMON_OWNER: "app-supervised",
        ENDURAGENT_HANDOFF_CAPABILITY: "a".repeat(43),
        ENDURAGENT_STARTER_CONTEXT_FD: "9",
      }),
    ).toEqual({ PATH: "/synthetic/bin" });
  });
});
