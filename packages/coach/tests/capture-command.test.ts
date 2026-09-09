import {
  createReferenceCapturePlan,
  validateReferenceCaptureManifest,
} from "@enduragent/kernel/reference/capture";
import { describe, expect, it, vi } from "vitest";
import { ReferenceCaptureRunError } from "../src/capture.js";
import { runCaptureReferenceCommand } from "../src/capture-command.js";

const UUID = "12345678-1234-4123-8123-123456789abc";
const ENV = {
  REFERENCE_CAPTURE_ENABLE: "1",
  REFERENCE_CAPTURE_API_KEY: "private-key",
  REFERENCE_CAPTURE_ATHLETE_ID: "private-athlete",
  ENDURAGENT_HOME: "private-home",
};

function manifest() {
  const plan = createReferenceCapturePlan({
    now: new Date("1998-07-18T12:00:00.000Z"),
    calendarTimeZone: "UTC",
  });
  const address = "a".repeat(64),
    snapshot = { address, rel_path: `1998/07/${address}.json.gz` };
  return validateReferenceCaptureManifest({
    schema_version: 1,
    capture_id: UUID,
    source: "external-oracle",
    plan,
    operation_ledger: { link_kind: "capture-id", capture_id: UUID },
    endpoints: [
      {
        ordinal: 0,
        lane: "settings",
        endpoint: "athlete-profile",
        request: {
          oldest: null,
          newest: null,
          activity_id: null,
          stream_types: [],
          include_defaults: null,
        },
        snapshot,
      },
      {
        ordinal: 1,
        lane: "activities",
        endpoint: "activities",
        request: {
          oldest: plan.window.oldest,
          newest: plan.window.newest,
          activity_id: null,
          stream_types: [],
          include_defaults: null,
        },
        snapshot,
      },
      {
        ordinal: 2,
        lane: "wellness",
        endpoint: "wellness",
        request: {
          oldest: plan.window.oldest,
          newest: plan.window.newest,
          activity_id: null,
          stream_types: [],
          include_defaults: null,
        },
        snapshot,
      },
    ],
    records: { settings: [], activities: [], wellness: [], streams: [] },
    selected_stream_ids: [],
    captured_stream_ids: [],
    deterministic_order: {
      endpoint_ordinals: [0, 1, 2],
      settings: [],
      activities: [],
      wellness: [],
      streams: [],
    },
  });
}

describe("capture-reference command", () => {
  it("prints only counts and the evidence hash on success", async () => {
    const output: string[] = [],
      errors: string[] = [],
      runCapture = vi.fn(async () => manifest());
    const code = await runCaptureReferenceCommand(
      ["--reviewed-on", "1998-07-18", "--reason", "initial"],
      ENV,
      {
        runCapture,
        uuid: () => UUID,
        wallClock: () => new Date("1998-07-18T12:00:00Z"),
        stdout: (line) => output.push(line),
        stderr: (line) => errors.push(line),
      },
    );
    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(output).toHaveLength(1);
    expect(output[0]).toMatch(
      /^REFERENCE_CAPTURE recorded activities=0 wellness=0 settings=0 streams=0 evidence_sha256=[0-9a-f]{64}$/,
    );
    expect(output[0]).not.toContain(UUID);
    expect(output[0]).not.toContain("1998");
    expect(output[0]).not.toContain("private");
    expect(runCapture).toHaveBeenCalledWith(
      expect.objectContaining({ calendarTimeZone: "UTC" }),
      expect.any(Object),
    );
  });

  it("rejects unknown, duplicate, missing, positional, and inconsistent arguments as environment usage", async () => {
    for (const args of [
      [],
      ["value"],
      ["--unknown", "x"],
      ["--reviewed-on", "1998-07-18", "--reviewed-on", "1998-07-18", "--reason", "initial"],
    ]) {
      const errors: string[] = [];
      expect(
        await runCaptureReferenceCommand(args, ENV, { stderr: (line) => errors.push(line) }),
      ).toBe(2);
      expect(errors).toEqual(["REFERENCE_CAPTURE failed category=environment"]);
    }
    const errors: string[] = [];
    expect(
      await runCaptureReferenceCommand(
        ["--reviewed-on", "1998-07-18", "--reason", "initial"],
        { ...ENV, REFERENCE_CAPTURE_ENABLE: "true" },
        { stderr: (line) => errors.push(line) },
      ),
    ).toBe(2);
  });

  it("uses fixed private failure lines without exception text or stacks", async () => {
    for (const category of ["capture", "persistence", "validation"] as const) {
      const errors: string[] = [];
      const runCapture = async (): Promise<never> => {
        throw new ReferenceCaptureRunError(category, { cause: new Error("secret detail") });
      };
      const code = await runCaptureReferenceCommand(
        ["--reviewed-on", "1998-07-18", "--reason", "initial"],
        ENV,
        { runCapture, stderr: (line) => errors.push(line) },
      );
      expect(code).toBe(1);
      expect(errors).toEqual([`REFERENCE_CAPTURE failed category=${category}`]);
      expect(errors[0]).not.toContain("secret");
    }
  });
});
