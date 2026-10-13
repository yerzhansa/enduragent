import {
  createReferenceCapturePlan,
  validateReferenceCaptureManifest,
} from "@enduragent/kernel/reference/capture";
import type { CaptureReport, LaneReport, RowDrop } from "@enduragent/sync-intervals-icu";
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReferenceCaptureRunError, ReplacedCaptureNotReplayableError, runReferenceCapture } from "../src/capture.js";
import { REPLACED_CAPTURE_REFUSAL, runCaptureReferenceCommand } from "../src/capture-command.js";
import { CoachStoreWriterError } from "../src/runtime.js";

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

const CLEAN: LaneReport = { fetched: 1, landed: 1, drops: [], unfetched: [] };
const CLEAN_REPORT: CaptureReport = { settings: CLEAN, activities: CLEAN, wellness: CLEAN, streams: CLEAN };

function rejectedDay(payloadIndex: number): RowDrop {
  return { lane: "wellness", payloadIndex, externalId: `1998-07-1${payloadIndex}`, localDate: `1998-07-1${payloadIndex}`,
    phase: "landing", reason: "landing", field: "restingHR", errorName: null };
}

async function recorded(report: CaptureReport) {
  const output: string[] = [],
    errors: string[] = [];
  const code = await runCaptureReferenceCommand(["--reviewed-on", "1998-07-18", "--reason", "initial"], ENV, {
    runCapture: async () => ({ manifest: manifest(), report }),
    uuid: () => UUID,
    wallClock: () => new Date("1998-07-18T12:00:00Z"),
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
  });
  return { code, output, errors };
}

describe("capture-reference command", () => {
  it("prints only counts and the evidence hash on success", async () => {
    const output: string[] = [],
      errors: string[] = [],
      runCapture = vi.fn(async () => ({ manifest: manifest(), report: CLEAN_REPORT }));
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

  it("returns 3 and names the lane when a lane kept none of the rows it fetched", async () => {
    const failedDownload: RowDrop = { lane: "streams", payloadIndex: null, externalId: "streams:42", localDate: null,
      phase: "fetch", reason: "fetch", field: "http_404", errorName: null };

    const { code, output, errors } = await recorded({
      ...CLEAN_REPORT,
      wellness: { fetched: 3, landed: 0, drops: [rejectedDay(5), rejectedDay(6), rejectedDay(7)], unfetched: [] },
      streams: { fetched: 0, landed: 0, drops: [], unfetched: [failedDownload] },
    });

    expect(code).toBe(3);
    expect(output.slice(1)).toEqual([
      'REFERENCE_CAPTURE lane=wellness fetched=3 landed=0 dropped=3 withheld=0 unfetched=0 first_drop="wellness[5] landing: landing of restingHR"',
      'REFERENCE_CAPTURE lane=streams fetched=0 landed=0 dropped=0 withheld=0 unfetched=1 first_unfetched="streams fetch: fetch of http_404"',
    ]);
    expect(errors).toEqual(["REFERENCE_CAPTURE degraded lost=wellness"]);
    expect(output.join("\n")).not.toContain("1998");
    expect(output.join("\n")).not.toContain("streams:42");
  });

  it("returns 0 and still prints the lane when a lane kept some of its rows", async () => {
    const { code, output, errors } = await recorded({
      ...CLEAN_REPORT,
      wellness: { fetched: 85, landed: 84, drops: [rejectedDay(3)], unfetched: [] },
    });

    expect(code).toBe(0);
    expect(output.slice(1)).toEqual([
      'REFERENCE_CAPTURE lane=wellness fetched=85 landed=84 dropped=1 withheld=0 unfetched=0 first_drop="wellness[3] landing: landing of restingHR"',
    ]);
    expect(errors).toEqual([]);
  });

  it("shows the row that lost the lane, not the rows the provider withheld before it", async () => {
    const withheld = (payloadIndex: number): RowDrop => ({ lane: "activities", payloadIndex, externalId: null, localDate: null,
      phase: "decode", reason: "source-restricted", field: null, errorName: null });
    const broken: RowDrop = { lane: "activities", payloadIndex: 2, externalId: null, localDate: null,
      phase: "decode", reason: "unclassified", field: null, errorName: "TypeError" };

    const lost = await recorded({ ...CLEAN_REPORT,
      activities: { fetched: 3, landed: 0, drops: [withheld(0), withheld(1), broken], unfetched: [] } });
    const onlyWithheld = await recorded({ ...CLEAN_REPORT,
      activities: { fetched: 2, landed: 0, drops: [withheld(0), withheld(1)], unfetched: [] } });

    expect(lost.code).toBe(3);
    expect(lost.output.slice(1)).toEqual([
      'REFERENCE_CAPTURE lane=activities fetched=3 landed=0 dropped=1 withheld=2 unfetched=0 first_drop="activities[2] decode: unclassified (TypeError)"',
    ]);
    expect(onlyWithheld.code).toBe(0);
    expect(onlyWithheld.output.slice(1)).toEqual([
      "REFERENCE_CAPTURE lane=activities fetched=2 landed=0 dropped=0 withheld=2 unfetched=0",
    ]);
  });

  it("explains a refused replacement without the capture id or the cause", async () => {
    const errors: string[] = [];
    const runCapture = async (): Promise<never> => {
      throw new ReferenceCaptureRunError("capture",
        { cause: new ReplacedCaptureNotReplayableError(UUID, { cause: new Error("secret detail") }) });
    };

    const code = await runCaptureReferenceCommand(
      ["--reviewed-on", "1998-07-18", "--reason", "provider-refresh", "--replaces", UUID],
      ENV,
      { runCapture, stderr: (line) => errors.push(line) },
    );

    expect(code).toBe(1);
    expect(errors).toEqual(["REFERENCE_CAPTURE failed category=capture", REPLACED_CAPTURE_REFUSAL]);
    expect(errors.join("\n")).not.toContain("secret");
    expect(errors.join("\n")).not.toContain(UUID);
  });

  it("refuses a replacement through the real capture run, before any request, and says why", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "capture-command-"));
    const requests: string[] = [],
      errors: string[] = [],
      output: string[] = [];
    try {
      const code = await runCaptureReferenceCommand(
        ["--reviewed-on", "1998-07-18", "--reason", "provider-refresh", "--replaces", UUID],
        { ...ENV, ENDURAGENT_HOME: root },
        {
          runCapture: (options, dependencies) => runReferenceCapture({
            ...options,
            baseFetch: async (input) => {
              requests.push(String(input));
              throw new Error("no request is expected");
            },
          }, dependencies),
          wallClock: () => new Date("1998-07-18T12:00:00Z"),
          stdout: (line) => output.push(line),
          stderr: (line) => errors.push(line),
        },
      );

      expect(code).toBe(1);
      expect(errors).toEqual(["REFERENCE_CAPTURE failed category=capture", REPLACED_CAPTURE_REFUSAL]);
      expect(output).toEqual([]);
      expect(requests).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads the failure category through the store writer's wrapper", async () => {
    const errors: string[] = [];
    const runCapture = async (): Promise<never> => {
      throw new CoachStoreWriterError("writer-failed", "invoke operation",
        { cause: new ReferenceCaptureRunError("persistence", { cause: new Error("secret detail") }) });
    };

    const code = await runCaptureReferenceCommand(
      ["--reviewed-on", "1998-07-18", "--reason", "initial"], ENV, { runCapture, stderr: (line) => errors.push(line) });

    expect(code).toBe(1);
    expect(errors).toEqual(["REFERENCE_CAPTURE failed category=persistence"]);
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
