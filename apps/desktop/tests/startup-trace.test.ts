import { afterEach, describe, expect, it, vi } from "vitest";
import { traceDesktopStartupStage } from "../src/main/startup-trace.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("desktop startup trace", () => {
  it.each([
    [undefined, undefined, false],
    ["0", "0", false],
    ["true", "true", false],
    ["1", undefined, true],
    ["0", "1", true],
    ["1", "1", true],
  ])("gates stderr for hidden=%s and trace=%s", (hidden, trace, enabled) => {
    vi.stubEnv("ENDURAGENT_ACCEPTANCE_HIDDEN", hidden);
    vi.stubEnv("ENDURAGENT_STARTUP_TRACE", trace);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    traceDesktopStartupStage("app-ready");
    traceDesktopStartupStage("resolve-daemon");

    expect(stderr.mock.calls).toEqual(
      enabled
        ? [["desktop-startup-stage app-ready\n"], ["desktop-startup-stage resolve-daemon\n"]]
        : [],
    );
  });
});
