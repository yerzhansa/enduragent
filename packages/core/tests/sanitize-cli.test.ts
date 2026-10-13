import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TP_DENYLIST_FIELDS } from "../src/reference/trademark-policy.js";
import { main } from "../../../tools/sanitize-fixture.js";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function makeTmpDirs(): { inputDir: string; outputDir: string } {
  const inputDir = mkdtempSync(join(tmpdir(), "sanitize-cli-in-"));
  const outputDir = mkdtempSync(join(tmpdir(), "sanitize-cli-out-"));
  dirs.push(inputDir, outputDir);
  return { inputDir, outputDir };
}

describe("sanitize-fixture CLI — main()", () => {
  it("reads input JSON, sanitizes, writes the output to outputRoot, returns exit code 0", async () => {
    const { inputDir, outputDir } = makeTmpDirs();
    const inputPath = join(inputDir, "raw.json");
    writeFileSync(
      inputPath,
      JSON.stringify({
        activities: [{ id: 1, type: "Ride", name: "morning ride", kj: 1180 }],
      }),
    );

    const exit = await main([inputPath, "tracer-output", "--force"], { outputRoot: outputDir });

    expect(exit).toBe(0);
    const written = JSON.parse(readFileSync(join(outputDir, "tracer-output.json"), "utf-8"));
    expect(written).toEqual({
      activities: [{ id: 12345, type: "Ride", name: "sanitized", kj: 1180 }],
    });
  });

  it("prints a summary listing dropped + transformed keys", async () => {
    const { inputDir, outputDir } = makeTmpDirs();
    const inputPath = join(inputDir, "raw.json");
    writeFileSync(
      inputPath,
      JSON.stringify({
        athlete_id: "operator-uuid",
        activities: [
          { id: 2, type: "Ride", start_latlng: [37, -122], description: "morning" },
          { id: 3, type: "Run", end_latlng: [38, -123], notes: "x" },
        ],
        wellness: [{ id: "2026-05-11", ctl: 52, atl: 39 }],
      }),
    );
    const lines: string[] = [];

    const exit = await main([inputPath, "summary-output", "--force"], {
      outputRoot: outputDir,
      out: (m) => lines.push(m),
    });

    expect(exit).toBe(0);
    const joined = lines.join("\n");
    expect(joined).toMatch(/Wrote sanitized fixture: .+summary-output\.json/);
    expect(joined).toMatch(/Dropped \d+ key occurrence/);
    expect(joined).toMatch(/athlete_id/);
    expect(joined).toMatch(/start_latlng/);
    expect(joined).toMatch(/end_latlng/);
    expect(joined).toMatch(/Transformed:.*id \(×3\)/);
  });

  it("rejects unknown flags with non-zero exit and a stderr message listing known flags", async () => {
    const { inputDir, outputDir } = makeTmpDirs();
    const inputPath = join(inputDir, "raw.json");
    writeFileSync(inputPath, JSON.stringify({ activities: [] }));
    const errs: string[] = [];

    const exit = await main([inputPath, "typo-output", "--force-overrride"], {
      outputRoot: outputDir,
      err: (m) => errs.push(m),
    });

    expect(exit).not.toBe(0);
    const errMsg = errs.join("\n");
    expect(errMsg).toMatch(/unknown flag.*--force-overrride/);
    expect(errMsg).toMatch(/known flags:.*--force/);
  });

  it("refuses to overwrite an existing fixture without --force; output is byte-identical", async () => {
    const { inputDir, outputDir } = makeTmpDirs();
    const inputPath = join(inputDir, "raw.json");
    writeFileSync(inputPath, JSON.stringify({ activities: [{ id: 1, type: "Ride" }] }));

    await main([inputPath, "guarded-output", "--force"], { outputRoot: outputDir });
    const outputPath = join(outputDir, "guarded-output.json");
    const firstBytes = readFileSync(outputPath);
    const firstMtimeNs = statSync(outputPath, { bigint: true }).mtimeNs;

    writeFileSync(inputPath, JSON.stringify({ activities: [{ id: 2, type: "Run" }] }));
    const errs: string[] = [];
    const exit = await main([inputPath, "guarded-output"], {
      outputRoot: outputDir,
      err: (m) => errs.push(m),
    });

    expect(exit).not.toBe(0);
    expect(errs.join("\n")).toMatch(/refusing to overwrite .+--force/);
    expect(readFileSync(outputPath).equals(firstBytes)).toBe(true);
    expect(statSync(outputPath, { bigint: true }).mtimeNs).toBe(firstMtimeNs);
  });

  it("with --force, overwrites the existing fixture", async () => {
    const { inputDir, outputDir } = makeTmpDirs();
    const inputPath = join(inputDir, "raw.json");
    writeFileSync(inputPath, JSON.stringify({ activities: [{ id: 1, type: "Ride" }] }));

    await main([inputPath, "force-output", "--force"], { outputRoot: outputDir });
    const outputPath = join(outputDir, "force-output.json");
    const firstContent = readFileSync(outputPath, "utf-8");

    writeFileSync(
      inputPath,
      JSON.stringify({
        activities: [{ id: 2, type: "Run" }],
        wellness: [{ id: "2026-05-11", weight: 73.4 }],
      }),
    );
    const exit = await main([inputPath, "force-output", "--force"], { outputRoot: outputDir });

    expect(exit).toBe(0);
    const secondContent = readFileSync(outputPath, "utf-8");
    expect(secondContent).not.toBe(firstContent);
    expect(JSON.parse(secondContent)).toEqual({
      activities: [{ id: 12345, type: "Run" }],
      wellness: [
        {
          id: "1998-05-11",
          weight: 73.4,
          restingHR: null,
          hrv: null,
          sleepSecs: null,
          sleepQuality: null,
          subjectiveFatigue: null,
        },
      ],
    });
  });

  it("renames TP wellness fields to plain-English in the CLI output", async () => {
    const { inputDir, outputDir } = makeTmpDirs();
    const inputPath = join(inputDir, "raw.json");
    writeFileSync(
      inputPath,
      JSON.stringify({
        wellness: [
          {
            id: "2026-05-11",
            ctl: 50,
            atl: 38,
            ctlLoad: 12,
            atlLoad: 18,
            rampRate: 4.5,
            weight: 73.4,
          },
        ],
      }),
    );

    const exit = await main([inputPath, "rename-wellness", "--force"], {
      outputRoot: outputDir,
    });

    expect(exit).toBe(0);
    const written = JSON.parse(readFileSync(join(outputDir, "rename-wellness.json"), "utf-8"));
    expect(written.wellness[0].fitness).toBe(50);
    expect(written.wellness[0].fatigue).toBe(38);
    expect(written.wellness[0].fitnessContribution).toBe(12);
    expect(written.wellness[0].fatigueContribution).toBe(18);
    expect(written.wellness[0].weeklyFitnessChange).toBe(4.5);
    expect(written.wellness[0]).not.toHaveProperty("ctl");
    expect(written.wellness[0]).not.toHaveProperty("atl");
    expect(written.wellness[0]).not.toHaveProperty("ctlLoad");
    expect(written.wellness[0]).not.toHaveProperty("atlLoad");
    expect(written.wellness[0]).not.toHaveProperty("rampRate");
    expect(written.wellness[0].weight).toBe(73.4);
    expect(written.wellness[0].id).toBe("1998-05-11");
  });

  it("renames TP activity fields to fitnessAtEnd/fatigueAtEnd", async () => {
    const { inputDir, outputDir } = makeTmpDirs();
    const inputPath = join(inputDir, "raw.json");
    writeFileSync(
      inputPath,
      JSON.stringify({
        activities: [
          {
            id: "i12345",
            type: "Ride",
            icu_ctl: 50.5,
            icu_atl: 38.2,
            start_date_local: "2026-05-11T08:00:00",
          },
        ],
      }),
    );

    const exit = await main([inputPath, "rename-activity", "--force"], {
      outputRoot: outputDir,
    });

    expect(exit).toBe(0);
    const written = JSON.parse(readFileSync(join(outputDir, "rename-activity.json"), "utf-8"));
    expect(written.activities[0].fitnessAtEnd).toBe(50.5);
    expect(written.activities[0].fatigueAtEnd).toBe(38.2);
    expect(written.activities[0]).not.toHaveProperty("icu_ctl");
    expect(written.activities[0]).not.toHaveProperty("icu_atl");
    expect(written.activities[0].start_date_local).toBe("1998-05-11T08:00:00");
    expect(written.activities[0].id).toBe(12345);
  });

  it("CLI output never contains a TP-named key on any wellness or activity row", async () => {
    const { inputDir, outputDir } = makeTmpDirs();
    const inputPath = join(inputDir, "raw.json");
    writeFileSync(
      inputPath,
      JSON.stringify({
        activities: [
          { id: "i1", type: "Ride", icu_ctl: 50, icu_atl: 38, start_date_local: "2026-05-11" },
          { id: "i2", type: "Ride", icu_ctl: 51, start_date_local: "2026-05-10" },
        ],
        wellness: [
          {
            id: "2026-05-11",
            ctl: 50,
            atl: 38,
            ctlLoad: 12,
            atlLoad: 18,
            rampRate: 4.5,
          },
          { id: "2026-05-12", ctl: 51, atl: 39 },
        ],
      }),
    );

    const exit = await main([inputPath, "no-tp-keys", "--force"], {
      outputRoot: outputDir,
    });

    expect(exit).toBe(0);
    const written = JSON.parse(readFileSync(join(outputDir, "no-tp-keys.json"), "utf-8"));
    for (const row of written.activities) {
      for (const banned of TP_DENYLIST_FIELDS) {
        expect(row).not.toHaveProperty(banned);
      }
    }
    for (const row of written.wellness) {
      for (const banned of TP_DENYLIST_FIELDS) {
        expect(row).not.toHaveProperty(banned);
      }
    }
  });

  it("CLI fails with an index-form path when a nested TP key survives the activity rename", async () => {
    const { inputDir, outputDir } = makeTmpDirs();
    const inputPath = join(inputDir, "raw.json");
    writeFileSync(
      inputPath,
      JSON.stringify({
        activities: [
          { id: "i9876543", type: "Ride", start_date_local: "1998-05-11T08:00:00", weeklyAggregates: { ctl: 50 } },
        ],
      }),
    );
    const errs: string[] = [];

    const exit = await main([inputPath, "nested-tp-activity", "--force"], {
      outputRoot: outputDir,
      err: (m) => errs.push(m),
    });

    expect(exit).toBe(3);
    const errMsg = errs.join("\n");
    expect(errMsg).toMatch(/activities\[0\]\.weeklyAggregates\.ctl/);
    expect(errMsg).not.toMatch(/i\d+/);
    expect(existsSync(join(outputDir, "nested-tp-activity.json"))).toBe(false);
  });

  it("CLI lets an activity rename collision propagate and writes nothing", async () => {
    const { inputDir, outputDir } = makeTmpDirs();
    const inputPath = join(inputDir, "raw.json");
    writeFileSync(
      inputPath,
      JSON.stringify({
        activities: [{ id: 1, type: "Ride", start_date_local: "1998-05-11T08:00:00", icu_ctl: 50, fitnessAtEnd: 51 }],
      }),
    );
    const errs: string[] = [];

    await expect(
      main([inputPath, "activity-collision", "--force"], { outputRoot: outputDir, err: (m) => errs.push(m) }),
    ).rejects.toThrow(/collision/);
    expect(errs).toEqual([]);
    expect(existsSync(join(outputDir, "activity-collision.json"))).toBe(false);
  });

  it("CLI warns once per field when an activity load value is not a number", async () => {
    const { inputDir, outputDir } = makeTmpDirs();
    const inputPath = join(inputDir, "raw.json");
    writeFileSync(
      inputPath,
      JSON.stringify({
        activities: [
          { id: 1, type: "Ride", start_date_local: "1998-05-11T08:00:00", icu_ctl: "marker-4471", icu_atl: 38 },
          { id: 2, type: "Ride", start_date_local: "1998-05-12T08:00:00", icu_ctl: "marker-4472" },
        ],
      }),
    );
    const errs: string[] = [];

    const exit = await main([inputPath, "stringy-activity", "--force"], {
      outputRoot: outputDir,
      err: (m) => errs.push(m),
    });

    expect(exit).toBe(0);
    expect(errs).toEqual(["⚠ Skipped non-number TP values during rename: icu_ctl (×2 in activities)"]);
    const written = JSON.parse(readFileSync(join(outputDir, "stringy-activity.json"), "utf-8"));
    expect(written.activities[0]).not.toHaveProperty("fitnessAtEnd");
    expect(written.activities[0].fatigueAtEnd).toBe(38);
  });

  it("CLI fails with the day's index when a nested TP key survives in a wellness day", async () => {
    const { inputDir, outputDir } = makeTmpDirs();
    const inputPath = join(inputDir, "raw.json");
    writeFileSync(
      inputPath,
      JSON.stringify({
        activities: [{ id: "i9876543", type: "Ride", start_date_local: "2026-05-11T08:00:00" }],
        wellness: [{ id: "2026-05-11", weeklyAggregates: { ctl: 50 } }],
      }),
    );
    const errs: string[] = [];

    const exit = await main([inputPath, "nested-tp", "--force"], {
      outputRoot: outputDir,
      err: (m) => errs.push(m),
    });

    expect(exit).not.toBe(0);
    const errMsg = errs.join("\n");
    expect(errMsg).toBe("wellness[0]: row rejected: decode of ctl");
    expect(errMsg).not.toMatch(/i\d+/);
  });

  it("CLI fails and writes nothing when a wellness load average is not a number", async () => {
    const { inputDir, outputDir } = makeTmpDirs();
    const inputPath = join(inputDir, "raw.json");
    writeFileSync(
      inputPath,
      JSON.stringify({
        wellness: [
          { id: "1998-05-11", ctl: 31.2, atl: 38 },
          { id: "1998-05-10", ctl: "marker-4471" },
        ],
      }),
    );
    const errs: string[] = [];

    const exit = await main([inputPath, "stringy-ctl", "--force"], {
      outputRoot: outputDir,
      err: (m) => errs.push(m),
    });

    expect(exit).toBe(3);
    expect(errs.join("\n")).toBe("wellness[1]: row rejected: decode of fitness");
    expect(existsSync(join(outputDir, "stringy-ctl.json"))).toBe(false);
  });

  it("CLI keeps a logged fatigue score apart from the load average it renames", async () => {
    const { inputDir, outputDir } = makeTmpDirs();
    const inputPath = join(inputDir, "raw.json");
    writeFileSync(inputPath, JSON.stringify({ wellness: [{ id: "1998-05-11", ctl: 31.2, atl: 27.787529, fatigue: 3 }] }));

    const exit = await main([inputPath, "two-fatigues", "--force"], { outputRoot: outputDir, err: () => undefined });

    expect(exit).toBe(0);
    const written = JSON.parse(readFileSync(join(outputDir, "two-fatigues.json"), "utf-8"));
    expect(written.wellness[0]).toMatchObject({ fitness: 31.2, fatigue: 27.787529, subjectiveFatigue: 3 });
  });
});
