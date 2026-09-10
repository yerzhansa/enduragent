import { initializeDesktopLanguage } from "../src/main/language.js";
import { describe, expect, it } from "vitest";
import type { DesktopDaemonLifecycleState } from "../src/main/daemon-lifecycle.js";
import {
  lifecycleErrorCopy,
  restartExhaustedCopy,
  startupRefusalCopy,
} from "../src/main/lifecycle-messages.js";

await initializeDesktopLanguage();

describe("desktop lifecycle messages", () => {
  it.each([
    [
      "not-configured",
      "Enduragent isn’t configured",
      "The configuration file is missing. Run Enduragent setup or restore config.yaml, then reopen Enduragent.",
    ],
    [
      "unreadable",
      "Enduragent couldn’t read its configuration",
      "Check that config.yaml is a readable file and its folder is accessible, then reopen Enduragent.",
    ],
    [
      "malformed",
      "Enduragent couldn’t use its configuration",
      "Correct or replace the invalid config.yaml file, then reopen Enduragent.",
    ],
    [
      "contention",
      "Enduragent couldn’t connect to its background service",
      "Another Enduragent process is already running or stuck. Quit that process, then reopen Enduragent. If you can’t find it, log out and back in.",
    ],
    [
      "version-mismatch",
      "Enduragent found a different background service version",
      "A different version of the Enduragent background service is running from the CLI or a previous install. Quit that service, then reopen Enduragent.",
    ],
    [
      "never-published",
      "Enduragent couldn’t start its background service",
      "The background service could not start or its saved connection state could not be read. Quit Enduragent and reopen it. If the problem continues, restart your Mac before trying again.",
    ],
  ] as const)("gives %s a specific recovery path", (classification, title, content) => {
    expect(startupRefusalCopy(classification, "darwin")).toEqual({ title, content });
  });

  it("uses Windows recovery guidance for an unpublished background service", () => {
    expect(startupRefusalCopy("never-published", "win32")).toEqual({
      title: "Enduragent couldn’t start its background service",
      content:
        "The background service could not start or its saved connection state could not be read. Quit Enduragent and reopen it. If the problem continues, restart your PC before trying again.",
    });
  });

  it("keeps internal and sensitive details out of every refusal", () => {
    const copies = [
      "not-configured",
      "unreadable",
      "malformed",
      "contention",
      "version-mismatch",
      "never-published",
      "unavailable",
    ].map((value) => startupRefusalCopy(value as Parameters<typeof startupRefusalCopy>[0]));
    for (const copy of copies) {
      const visible = `${copy.title}\n${copy.content}`;
      expect(visible).not.toMatch(
        /not-configured|unreadable|malformed|contention|version-mismatch|never-published|unavailable/u,
      );
      expect(visible).not.toMatch(/(?:ws|http)s?:\/\//u);
      expect(visible).not.toMatch(/[A-Za-z0-9_-]{43}/u);
      expect(visible).not.toMatch(/exit(?:\s+|-)?code/iu);
      expect(visible).not.toMatch(/\b(?:3|5)\b/u);
    }
  });

  it.each([
    ["not-configured", startupRefusalCopy("not-configured")],
    ["unreadable", startupRefusalCopy("unreadable")],
    ["malformed", startupRefusalCopy("malformed")],
    ["contention", startupRefusalCopy("contention")],
    ["version-mismatch", startupRefusalCopy("version-mismatch")],
    ["never-published", startupRefusalCopy("never-published")],
    ["unavailable", startupRefusalCopy("unavailable")],
    ["termination-failed", startupRefusalCopy("termination-failed")],
    ["restart-exhausted", restartExhaustedCopy],
  ] as const)("presents terminal %s with its matching recovery guidance", (cause, copy) => {
    expect(lifecycleErrorCopy({ status: "terminal", generation: 2, cause })).toEqual(copy);
  });

  it("suppresses lifecycle dialogs while closing or after cancellation", () => {
    const nonTerminal: DesktopDaemonLifecycleState[] = [
      { status: "starting" },
      { status: "ready", generation: 1 },
      { status: "recovering", generation: 1 },
      { status: "closing", generation: 1 },
    ];
    for (const state of nonTerminal) expect(lifecycleErrorCopy(state)).toBeUndefined();
    expect(
      lifecycleErrorCopy({ status: "terminal", generation: 1, cause: "cancelled" }),
    ).toBeUndefined();
  });
});
