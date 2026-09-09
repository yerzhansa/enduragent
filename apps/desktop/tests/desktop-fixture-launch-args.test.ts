import { describe, expect, it } from "vitest";
import { desktopFixtureLaunchArgs } from "./helpers/desktop-fixture-launch-args.js";

describe("Desktop fixture launch arguments", () => {
  it.each(["true", "1", "false"])("uses sandbox-free basic storage on Linux with CI=%s", (ci) => {
    expect(desktopFixtureLaunchArgs("linux", ci)).toEqual([
      "--no-sandbox",
      "--password-store=basic",
    ]);
  });

  it.each([undefined, ""])("preserves the sandbox on Linux with CI=%s", (ci) => {
    expect(desktopFixtureLaunchArgs("linux", ci)).toEqual([]);
  });

  it.each(["darwin", "win32"] satisfies NodeJS.Platform[])(
    "preserves arguments on %s with and without CI",
    (platform) => {
      expect(desktopFixtureLaunchArgs(platform, "true")).toEqual([]);
      expect(desktopFixtureLaunchArgs(platform, undefined)).toEqual([]);
    },
  );
});
