import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { referenceDataDir } from "../src/reference/paths.js";

let tempHome: string;
let origHome: string | undefined;
let origCyclingHome: string | undefined;
let origRunningHome: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "ref-paths-"));
  origHome = process.env.HOME;
  origCyclingHome = process.env.CYCLING_COACH_HOME;
  origRunningHome = process.env.RUNNING_COACH_HOME;
  process.env.HOME = tempHome;
  delete process.env.CYCLING_COACH_HOME;
  delete process.env.RUNNING_COACH_HOME;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origCyclingHome === undefined) delete process.env.CYCLING_COACH_HOME;
  else process.env.CYCLING_COACH_HOME = origCyclingHome;
  if (origRunningHome === undefined) delete process.env.RUNNING_COACH_HOME;
  else process.env.RUNNING_COACH_HOME = origRunningHome;
  rmSync(tempHome, { recursive: true, force: true });
});

describe("referenceDataDir — composes via getCoachHome", () => {
  it("returns <legacy>/data when ~/.cycling-coach/ exists for the cycling-coach binary", () => {
    mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });
    expect(referenceDataDir("cycling-coach")).toBe(join(tempHome, ".cycling-coach", "data"));
  });

  it("returns <fresh-install>/data for cycling-coach when legacy is absent", () => {
    expect(referenceDataDir("cycling-coach")).toBe(
      join(tempHome, ".enduragent", "cycling", "data"),
    );
  });

  it("returns <fresh-install>/data for non-cycling-coach binaries", () => {
    expect(referenceDataDir("running-coach")).toBe(
      join(tempHome, ".enduragent", "running", "data"),
    );
    expect(referenceDataDir("duathlon-coach")).toBe(
      join(tempHome, ".enduragent", "duathlon", "data"),
    );
  });

  it("respects an env-var override", () => {
    process.env.CYCLING_COACH_HOME = "/srv/coach";
    expect(referenceDataDir("cycling-coach")).toBe(join("/srv/coach", "data"));
  });
});
