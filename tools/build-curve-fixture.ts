import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertNoTpKeysRemain,
  decodeWellnessRow,
  renameTpFieldsOnActivity,
  type RenameSummary,
} from "../packages/core/src/reference/sync/rename-tp-fields.js";
import { sanitizeFixture } from "./sanitize-fixture-transform.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = resolve(REPO_ROOT, "packages/core/tests/fixtures/golden/curve-equipped.json");
const DEFAULT_FROZEN_NOW = "1998-06-04T12:00:00";

const CYCLING_TYPES = new Set(["Ride", "VirtualRide"]);
const SYNTHETIC_ID_BASE = 90101;

const POWER_DELTA_ANCHORS = [5, 60, 300, 1200, 3600];
const HR_DELTA_ANCHORS = [60, 300, 1200, 3600];
const SUSTAINABILITY_ANCHORS = [300, 600, 1200, 1800, 3600, 5400, 7200];

const ATHLETE_FTP = 200;
const ATHLETE_INDOOR_FTP = 195;
const ATHLETE_LTHR = 168;
const ATHLETE_VO2MAX = 58;

interface Args {
  rawBundle: string;
  rawCurves: string;
  frozenNow: string;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    rawBundle: "",
    rawCurves: "",
    frozenNow: DEFAULT_FROZEN_NOW,
    out: DEFAULT_OUT,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) {
        throw new Error(`flag ${arg} requires a value`);
      }
      i++;
      return v;
    };
    switch (arg) {
      case "--raw-bundle":
        out.rawBundle = next();
        break;
      case "--raw-curves":
        out.rawCurves = next();
        break;
      case "--frozen-now":
        out.frozenNow = next();
        break;
      case "--out":
        out.out = resolve(next());
        break;
      default:
        throw new Error(`unknown flag: ${arg}`);
    }
  }
  if (!out.rawBundle || !out.rawCurves) {
    throw new Error("--raw-bundle and --raw-curves are required");
  }
  return out;
}

function ymdMinus(frozenNow: string, days: number): string {
  const base = new Date(`${frozenNow.slice(0, 10)}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() - days);
  return base.toISOString().slice(0, 10);
}

interface CurveWindows {
  win1: string;
  win2: string;
  sus: string;
}

function curveWindows(frozenNow: string): CurveWindows {
  const today = frozenNow.slice(0, 10);
  return {
    win1: `r.${ymdMinus(frozenNow, 27)}.${today}`,
    win2: `r.${ymdMinus(frozenNow, 55)}.${ymdMinus(frozenNow, 28)}`,
    sus: `r.${ymdMinus(frozenNow, 41)}.${today}`,
  };
}

type RawCurve = {
  id: string;
  secs: number[];
  watts?: (number | null)[];
  values?: (number | null)[];
};

function rawCurveList(envelope: unknown): RawCurve[] {
  const list = (envelope as { list?: unknown })?.list;
  return Array.isArray(list) ? (list as RawCurve[]) : [];
}

function trimCurve(
  curve: RawCurve,
  anchors: number[],
  valueKey: "watts" | "values",
): { id: string; secs: number[] } & Record<string, (number | null)[]> {
  const secs: number[] = [];
  const vals: (number | null)[] = [];
  const source = curve[valueKey] ?? [];
  for (const dur of anchors) {
    const idx = curve.secs.indexOf(dur);
    if (idx < 0) continue;
    secs.push(dur);
    vals.push(source[idx] ?? null);
  }
  return { id: curve.id, secs, [valueKey]: vals } as {
    id: string;
    secs: number[];
  } & Record<string, (number | null)[]>;
}

function findCurve(list: RawCurve[], id: string): RawCurve {
  const found = list.find((c) => c.id === id);
  if (!found) {
    throw new Error(`raw curves missing required window id: ${id}`);
  }
  return found;
}

interface RawBundle {
  activities: Record<string, unknown>[];
  wellness: Record<string, unknown>[];
  ftp_history: unknown[];
}

function main(argv: string[]): void {
  const args = parseArgs(argv);
  const bundle = JSON.parse(readFileSync(args.rawBundle, "utf8")) as RawBundle;
  const rawCurves = JSON.parse(readFileSync(args.rawCurves, "utf8")) as Record<string, unknown>;
  const w = curveWindows(args.frozenNow);

  const actSummary: RenameSummary = { skippedNonNumeric: {} };
  const renamed = {
    activities: bundle.activities.map((row) => renameTpFieldsOnActivity(row, actSummary)),
    wellness: bundle.wellness.map((row) => decodeWellnessRow(row)),
    ftp_history: bundle.ftp_history,
  };
  assertNoTpKeysRemain(renamed);
  const sanitized = sanitizeFixture(renamed) as {
    activities: Record<string, unknown>[];
    wellness: Record<string, unknown>[];
    ftp_history: unknown[];
  };

  const activities = [...sanitized.activities].sort((a, b) =>
    String(a.start_date_local).localeCompare(String(b.start_date_local)),
  );
  activities.forEach((act, i) => {
    act.id = SYNTHETIC_ID_BASE + i;
  });

  const wellness = [...sanitized.wellness].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const latest = wellness[wellness.length - 1];
  latest.sportInfo = [{ type: "Ride", eftp: ATHLETE_FTP, wPrime: 13882, pMax: 727 }];
  latest.vo2max = ATHLETE_VO2MAX;

  const powerDelta = rawCurveList(rawCurves.power_delta);
  const hrDelta = rawCurveList(rawCurves.hr_delta);
  const power_curves = {
    list: [
      trimCurve(findCurve(powerDelta, w.win1), POWER_DELTA_ANCHORS, "watts"),
      trimCurve(findCurve(powerDelta, w.win2), POWER_DELTA_ANCHORS, "watts"),
    ],
  };
  const hr_curves = {
    list: [
      trimCurve(findCurve(hrDelta, w.win1), HR_DELTA_ANCHORS, "values"),
      trimCurve(findCurve(hrDelta, w.win2), HR_DELTA_ANCHORS, "values"),
    ],
  };

  const susPowerRide = findCurve(rawCurveList(rawCurves.sus_power_Ride), w.sus);
  const susPowerVR = findCurve(rawCurveList(rawCurves.sus_power_VirtualRide), w.sus);
  const susHrRide = findCurve(rawCurveList(rawCurves.sus_hr_Ride), w.sus);
  const susHrVR = findCurve(rawCurveList(rawCurves.sus_hr_VirtualRide), w.sus);
  const sustainability_curves = {
    cycling: {
      power: {
        Ride: {
          list: [trimCurve(susPowerRide, SUSTAINABILITY_ANCHORS, "watts")],
        },
        VirtualRide: {
          list: [trimCurve(susPowerVR, SUSTAINABILITY_ANCHORS, "watts")],
        },
      },
      hr: {
        Ride: {
          list: [trimCurve(susHrRide, SUSTAINABILITY_ANCHORS, "values")],
        },
        VirtualRide: {
          list: [trimCurve(susHrVR, SUSTAINABILITY_ANCHORS, "values")],
        },
      },
    },
  };

  const athlete = {
    sportSettings: [
      {
        types: ["Ride", "VirtualRide"],
        ftp: ATHLETE_FTP,
        indoor_ftp: ATHLETE_INDOOR_FTP,
        lthr: ATHLETE_LTHR,
      },
    ],
  };

  const fixture = {
    activities,
    wellness,
    ftp_history: sanitized.ftp_history,
    power_curves,
    hr_curves,
    sustainability_curves,
    athlete,
  };

  assertNonVacuous(fixture, w, args.frozenNow);

  const json = `${JSON.stringify(fixture, null, 2)}\n`;
  writeFileSync(args.out, json);
  const hash = createHash("sha256").update(json).digest("hex");
  writeFileSync(`${args.out}.sha256`, `${hash}  ${basename(args.out)}\n`);
  console.error(`Wrote ${args.out} (${json.length} bytes), checksum ${args.out}.sha256`);
}

interface BuiltFixture {
  activities: Record<string, unknown>[];
  wellness: Record<string, unknown>[];
  power_curves: { list: { id: string; secs: number[] }[] };
  hr_curves: { list: { id: string; secs: number[] }[] };
  sustainability_curves: Record<
    string,
    {
      power: Record<string, { list: { id: string; secs: number[] }[] }>;
      hr: Record<string, { list: { id: string; secs: number[] }[] }>;
    }
  >;
  athlete: { sportSettings: { ftp?: number; lthr?: number }[] };
}

function assertNonVacuous(fixture: BuiltFixture, w: CurveWindows, frozenNow: string): void {
  const fail: (msg: string) => never = (msg) => {
    throw new Error(`[build-curve-fixture] non-vacuity guard failed: ${msg}`);
  };

  const ids = (list: { id: string }[]): Set<string> => new Set(list.map((c) => c.id));
  const pIds = ids(fixture.power_curves.list);
  if (!pIds.has(w.win1) || !pIds.has(w.win2)) {
    fail(`power_curves missing a delta window id (${w.win1} / ${w.win2})`);
  }
  const hIds = ids(fixture.hr_curves.list);
  if (!hIds.has(w.win1) || !hIds.has(w.win2)) {
    fail(`hr_curves missing a delta window id (${w.win1} / ${w.win2})`);
  }
  for (const c of fixture.power_curves.list) {
    for (const a of [5, 60, 1200, 3600]) {
      if (!c.secs.includes(a)) fail(`power_curves ${c.id} missing anchor ${a}s`);
    }
  }
  for (const c of fixture.hr_curves.list) {
    for (const a of [60, 300, 1200, 3600]) {
      if (!c.secs.includes(a)) fail(`hr_curves ${c.id} missing anchor ${a}s`);
    }
  }
  const cyc = fixture.sustainability_curves.cycling;
  if (!cyc) fail("sustainability_curves missing cycling family");
  const susRide = cyc.power.Ride?.list ?? [];
  const susCurve = susRide.find((c) => c.id === w.sus);
  if (!susCurve) fail(`sustainability cycling power missing window id ${w.sus}`);
  if (susCurve.secs.length < 2) {
    fail(`sustainability cycling power has < 2 anchors (${susCurve.secs.length})`);
  }

  const latest = fixture.wellness[fixture.wellness.length - 1];
  const si = (latest.sportInfo as { type?: string }[] | undefined) ?? [];
  const ride = si.find((s) => s.type === "Ride") as
    | { eftp?: number; wPrime?: number; pMax?: number }
    | undefined;
  if (!ride || ride.eftp == null || ride.wPrime == null || ride.pMax == null) {
    fail("latest wellness Ride sportInfo missing eftp/wPrime/pMax");
  }

  const cycling = fixture.athlete.sportSettings.find((s) => s.ftp != null && s.lthr != null);
  if (!cycling) fail("athlete.sportSettings missing cycling ftp + lthr");

  const oldest28 = ymdMinus(frozenNow, 27);
  const today = frozenNow.slice(0, 10);
  const cyclingActs = fixture.activities.filter((a) => {
    const d = String(a.start_date_local).slice(0, 10);
    return CYCLING_TYPES.has(String(a.type)) && d >= oldest28 && d <= today;
  });
  if (cyclingActs.length < 5) {
    fail(`< 5 cycling activities in the 28d window (${cyclingActs.length})`);
  }
}

const isCli =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;

if (isCli) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

export { curveWindows, ymdMinus };
