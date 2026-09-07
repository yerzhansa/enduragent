import { describe, expect, it } from "vitest";
import { arch, platform, release } from "node:os";
import {
  applicationBaselineForEnvironment,
  assertApplicationBaselineEnvironment,
  currentApplicationEnvironment,
} from "./e2e/application-ui-states/baseline-environment.js";

const environment = { platform: "darwin", architecture: "arm64", darwinRelease: "25.2.0" };

describe("application baseline environment", () => {
  it("reads the real host identity", () => {
    expect(currentApplicationEnvironment()).toEqual({
      platform: platform(),
      architecture: arch(),
      darwinRelease: release(),
    });
  });

  it.each(["25.2.0", "25.2.1", "25.2.99"])(
    "preserves the original corpus on %s",
    (darwinRelease) => {
      expect(applicationBaselineForEnvironment({ ...environment, darwinRelease })).toBe(
        "application-ui-extraction-v1",
      );
    },
  );

  it.each(["25.5.0", "25.5.1", "25.5.99"])(
    "selects the other CI corpus on %s",
    (darwinRelease) => {
      expect(applicationBaselineForEnvironment({ ...environment, darwinRelease })).toBe(
        "application-ui-extraction-darwin-25-5-v1",
      );
    },
  );

  it.each(["25.6.0", "25.6.1", "25.6.99"])(
    "selects the separate CI corpus on %s",
    (darwinRelease) => {
      expect(applicationBaselineForEnvironment({ ...environment, darwinRelease })).toBe(
        "application-ui-extraction-darwin-25-6-v1",
      );
    },
  );

  it.each([
    "24.2.0",
    "25.0.0",
    "25.1.0",
    "25.3.0",
    "25.4.0",
    "25.7.0",
    "26.2.0",
    "25",
    "25.2",
    "25.2.0-extra",
    "025.2.0",
    "25.02.0",
    "",
  ])(
    "rejects unsupported or malformed releases instead of matching only the major: %s",
    (darwinRelease) => {
      expect(() => applicationBaselineForEnvironment({ ...environment, darwinRelease })).toThrow(
        /Run on Darwin 25\.2, 25\.5, or 25\.6 arm64, or capture, inspect, and seal/,
      );
    },
  );

  it.each([
    { platform: "linux", architecture: "arm64" },
    { platform: "win32", architecture: "arm64" },
    { platform: "darwin", architecture: "x64" },
  ])("rejects unsupported platform and architecture: %j", (host) => {
    expect(() => applicationBaselineForEnvironment({ ...environment, ...host })).toThrow(
      "No reviewed application baseline",
    );
  });
});

describe("sealed baseline environment identity", () => {
  it.each([
    ["25.2.0", "application-ui-extraction-darwin-25-6-v1"],
    ["25.6.0", "application-ui-extraction-v1"],
    ["25.5.0", "application-ui-extraction-darwin-25-6-v1"],
    ["25.6.0", "application-ui-extraction-darwin-25-5-v1"],
  ])(
    "rejects an identity from %s in the other supported corpus",
    (darwinRelease, baselineVersion) => {
      expect(() =>
        assertApplicationBaselineEnvironment({ ...environment, darwinRelease }, baselineVersion),
      ).toThrow("Capture environment does not match");
    },
  );

  it.each([
    ["25.2.0", "application-ui-extraction-v1"],
    ["25.6.0", "application-ui-extraction-darwin-25-6-v1"],
    ["25.5.0", "application-ui-extraction-darwin-25-5-v1"],
  ])("accepts matching identity %s", (darwinRelease, baselineVersion) => {
    expect(() =>
      assertApplicationBaselineEnvironment({ ...environment, darwinRelease }, baselineVersion),
    ).not.toThrow();
  });
});
