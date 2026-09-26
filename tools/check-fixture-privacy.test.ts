// fixture-privacy-lint:skip-file — every identifier, date, and byte below is
// fabricated test input created only in an OS temporary directory.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DOMImplementation, DOMParser } from "@xmldom/xmldom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SCAN_PATHS,
  findBinaryFixtureHits,
  findDateHits,
  findIdHits,
  findStagedBundleHits,
  fixturePrivacyDiagnosticForTest,
  guardXmlDocument,
  main,
  validateXmlFixtureBytes,
  type PrivacyHit,
} from "./check-fixture-privacy.js";
import {
  FIT_DATE_TIME_FLOOR_ISO,
  FIT_DATE_TIME_FLOOR_RAW,
  LOCAL_ENCODER_PACKAGE,
  LOCAL_ENCODER_VERSION,
  SYNTHETIC_FILE_ID_SERIAL_MAX,
  SYNTHETIC_FILE_ID_SERIAL_MIN,
  SYNTHETIC_GEO_ALGORITHM,
  SYNTHETIC_GEO_BOX,
  SYNTHETIC_GEO_CENTER,
  SYNTHETIC_GEO_EARTH_RADIUS_M,
  SYNTHETIC_GEO_LAPS,
  SYNTHETIC_GEO_MAX_CUMULATIVE_DIVERGENCE_RATIO,
  SYNTHETIC_GEO_QUANTIZATION,
} from "./synthetic-fixture-policy.js";

const POLICY_PATH = fileURLToPath(new URL("./synthetic-fixture-policy.ts", import.meta.url));
const INGEST = "packages/kernel-node/tests/fixtures/ingest";
const MANIFEST = `${INGEST}/manifest.json`;
const TCX_NS = "http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2";
const GPX_10_NS = "http://www.topografix.com/GPX/1/0";
const GPX_11_NS = "http://www.topografix.com/GPX/1/1";
const FIT_QA = [
  "triathlon-multisport",
  "duathlon-run-bike-run",
  "brick-cycling",
  "brick-running",
  "multisport-missing-generic-transition",
  "pool-swim-drill-lengths",
  "pool-size-correction",
  "dual-developer-index",
] as const;

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "fixture-privacy-lint-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tempDir, { recursive: true, force: true });
});

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function policyHash(): string {
  return sha256(readFileSync(POLICY_PATH));
}

function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeAt(root: string, rel: string, contents: string | Uint8Array): string {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

function write(rel: string, contents: string | Uint8Array): string {
  return writeAt(tempDir, rel, contents);
}

function writeEmptyManifest(root = tempDir): void {
  writeAt(
    root,
    MANIFEST,
    canonical({
      schema_version: 1,
      hash_algorithm: "sha256",
      policy_sha256: policyHash(),
      files: [],
    }),
  );
}

function sidecar(bytes: Uint8Array, path: string): string {
  return `${sha256(bytes)}  ${path.split("/").at(-1)}\n`;
}

function validTcx(): string {
  return `<?xml version="1.0" encoding="UTF-8"?><TrainingCenterDatabase xmlns="${TCX_NS}"><Activities><Activity><Lap StartTime="${FIT_DATE_TIME_FLOOR_ISO}"><Track><Trackpoint><Time>${FIT_DATE_TIME_FLOOR_ISO}</Time><Position><LatitudeDegrees>${SYNTHETIC_GEO_CENTER.lat}</LatitudeDegrees><LongitudeDegrees>${SYNTHETIC_GEO_CENTER.lon}</LongitudeDegrees></Position></Trackpoint></Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
}

function validGpx(namespace = GPX_11_NS, version = "1.1"): string {
  return `<gpx xmlns="${namespace}" version="${version}"><trk><trkseg><trkpt lat="${SYNTHETIC_GEO_CENTER.lat}" lon="${SYNTHETIC_GEO_CENTER.lon}"><time>${FIT_DATE_TIME_FLOOR_ISO}</time></trkpt></trkseg></trk><rte><rtept lat="${SYNTHETIC_GEO_CENTER.lat}" lon="${SYNTHETIC_GEO_CENTER.lon}"/></rte><wpt lat="${SYNTHETIC_GEO_CENTER.lat}" lon="${SYNTHETIC_GEO_CENTER.lon}"/></gpx>`;
}

interface Entry {
  path: string;
  sha256: string;
  bytes: number;
  kind: "fit" | "tcx" | "gpx";
  serial: number | null;
  qa_cell: string;
}

function committedEntries(root: string, writeFiles = true): Entry[] {
  const entries: Entry[] = [];
  for (let i = 0; i < FIT_QA.length; i++) {
    const path = `${INGEST}/${FIT_QA[i]}.fit`;
    const bytes = Buffer.from(`FABRICATED-NON-REAL-FIT-${i}`);
    entries.push({
      path,
      sha256: sha256(bytes),
      bytes: bytes.length,
      kind: "fit",
      serial: SYNTHETIC_FILE_ID_SERIAL_MIN + i,
      qa_cell: FIT_QA[i],
    });
    if (writeFiles) {
      writeAt(root, path, bytes);
      writeAt(root, `${path}.sha256`, sidecar(bytes, path));
    }
  }
  for (const [kind, qa, xml] of [
    ["tcx", "fallback-cycling-tcx", validTcx()],
    ["gpx", "fallback-cycling-gpx", validGpx()],
  ] as const) {
    const path = `${INGEST}/${qa}.${kind}`;
    const bytes = Buffer.from(xml);
    entries.push({
      path,
      sha256: sha256(bytes),
      bytes: bytes.length,
      kind,
      serial: null,
      qa_cell: qa,
    });
    if (writeFiles) {
      writeAt(root, path, bytes);
      writeAt(root, `${path}.sha256`, sidecar(bytes, path));
    }
  }
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function writeCommittedManifest(root: string, entries: Entry[]): void {
  writeAt(
    root,
    MANIFEST,
    canonical({
      schema_version: 1,
      hash_algorithm: "sha256",
      policy_sha256: policyHash(),
      files: entries,
    }),
  );
}

function committedInventory(entries: Entry[]): { fixtures: string[]; sidecars: string[] } {
  return {
    fixtures: entries.map((entry) => entry.path),
    sidecars: entries.map((entry) => `${entry.path}.sha256`),
  };
}

function expectOnlyCode(hits: readonly PrivacyHit[], code: string): void {
  expect(hits.length).toBeGreaterThan(0);
  expect(new Set(hits.map((hit) => hit.code))).toEqual(new Set([code]));
}

describe("Rule A — real intervals.icu id shape", () => {
  it.each(["", "```json", "~~~text"])("flags Markdown identifiers with fence %j", (fence) => {
    const id = `i${"9".repeat(8)}`;
    const opening = fence ? `${fence}\n` : "";
    const closing = fence ? `\n${fence.slice(0, 3)}` : "";
    const file = write("sample.md", `${opening}athlete ${id}${closing}\n`);
    expect(findIdHits([file])).toEqual([
      expect.objectContaining({ file, line: fence ? 2 : 1, column: 9, rule: "intervals-id" }),
    ]);
  });

  it("preserves Markdown placeholder and explicit file exemptions", () => {
    const placeholder = `i${"1234"}${"5678"}`;
    const forbidden = `i${"9".repeat(9)}`;
    expect(findIdHits([write("placeholder.md", `\`\`\`\n${placeholder}\n\`\`\`\n`)])).toEqual([]);
    expect(
      findIdHits([
        write("skip.md", `<!-- fixture-privacy-lint:skip-file -->\n\`\`\`\n${forbidden}\n\`\`\``),
      ]),
    ).toEqual([]);
  });

  it("flags an i+9-digit id inside a JSON string", () => {
    const file = write("fixture.json", `{ "id": "i123456789", "type": "Ride" }\n`);
    const hits = findIdHits([file]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ rule: "intervals-id", code: "source.intervals_id", path: "$" });
  });

  it("flags an i+8-digit id inside a TS string literal", () => {
    const file = write("sample.ts", `export const id = "i14662260";\n`);
    expect(findIdHits([file])[0]).toMatchObject({
      rule: "intervals-id",
      code: "source.intervals_id",
    });
  });

  it("flags an i+8-9-digit id inside a TS comment", () => {
    const file = write("comment.ts", `// real id looks like i987654321\nconst x = 1;\n`);
    expect(findIdHits([file])).toHaveLength(1);
  });

  it("passes short synthetic placeholders below the shape", () => {
    expect(findIdHits([write("ok.json", `{ "a": "i1", "b": "i9876543" }\n`)])).toHaveLength(0);
  });

  it("passes documented synthetic placeholders", () => {
    expect(findIdHits([write("ok.json", `{ "a": "i12345678", "b": "i12345679" }\n`)])).toHaveLength(
      0,
    );
  });

  it("respects the skip-file marker for Rule A", () => {
    expect(
      findIdHits([write("skip.ts", `// fixture-privacy-lint:skip-file\nconst id="i123456789";`)]),
    ).toHaveLength(0);
  });
});

describe("Rule B — current-era dates", () => {
  it("flags current-era values and keys", () => {
    const value = write(
      "realistic-athlete.json",
      `{ "d": "2026-05-09", "streams": { "2026-05-10": 1 } }\n`,
    );
    expect(findDateHits([value])).toHaveLength(2);
  });

  it("passes shifted values and synthetic allowlists", () => {
    expect(findDateHits([write("realistic-athlete.json", `{ "d": "1998-05-09" }\n`)])).toHaveLength(
      0,
    );
    expect(findDateHits([write("dfa-equipped.json", `{ "d": "2026-05-09" }\n`)])).toHaveLength(0);
  });

  it("respects the skip-file marker for Rule B", () => {
    expect(
      findDateHits([
        write(
          "realistic-athlete.json",
          `{ "note":"fixture-privacy-lint:skip-file", "d":"2026-05-09" }`,
        ),
      ]),
    ).toHaveLength(0);
  });

  it("flags a current-era date used as an object key", () => {
    const file = write("curve-equipped.json", `{ "streams": { "2026-05-09": 1 } }\n`);
    expect(findDateHits([file])[0].detail).toContain("<key:2026-05-09>");
  });

  it("passes a shifted date", () => {
    expect(findDateHits([write("realistic-athlete.json", `{ "d": "1997-05-09" }\n`)])).toEqual([]);
  });

  it("exempts a fully synthetic golden fixture by basename", () => {
    expect(findDateHits([write("dfa-equipped.json", `{ "d": "2026-05-28" }\n`)])).toEqual([]);
  });
});

describe("binary manifest", () => {
  it("[binary-unmanifested] makes main reject fabricated temporary FIT bytes", () => {
    writeEmptyManifest();
    const path = `${INGEST}/unmanifested.fit`;
    write(path, Buffer.from("FABRICATED-NON-REAL-FIT"));
    const original = process.cwd();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      process.chdir(tempDir);
      expect(main([])).toBe(1);
    } finally {
      process.chdir(original);
    }
    expect(error.mock.calls.flat().join(" ")).toContain("binary.unmanifested");
    expect(error.mock.calls[1]?.[0]).toBe(
      `  ${path}  [binary.unmanifested] $ Activity fixture is not present in the committed manifest.`,
    );
  });

  it.each(["UPPER.FIT", "mixed.TcX", "other.GpX"])("[binary-extension-case] routes %s", (name) => {
    writeEmptyManifest();
    const path = `${INGEST}/${name}`;
    write(path, Buffer.from("FABRICATED-NON-REAL"));
    expectOnlyCode(findBinaryFixtureHits([path], [], { rootDir: tempDir }), "binary.unmanifested");
  });

  it("[binary-skip-no-bypass] ignores the legacy skip marker for binary bytes", () => {
    writeEmptyManifest();
    const path = `${INGEST}/skip.fit`;
    write(path, Buffer.from("fixture-privacy-lint:skip-file"));
    expectOnlyCode(findBinaryFixtureHits([path], [], { rootDir: tempDir }), "binary.unmanifested");
  });

  it("[manifest-empty] accepts the policy-bound empty manifest", () => {
    writeEmptyManifest();
    expect(findBinaryFixtureHits([], [], { rootDir: tempDir })).toEqual([]);
  });

  it("[manifested-fit] accepts a complete fabricated manifested set", () => {
    const entries = committedEntries(tempDir);
    writeCommittedManifest(tempDir, entries);
    const inventory = committedInventory(entries);
    expect(
      findBinaryFixtureHits(inventory.fixtures, inventory.sidecars, { rootDir: tempDir }),
    ).toEqual([]);
  });

  it.each([
    ["bytes", "binary.byte_count"],
    ["sha256", "binary.hash"],
    ["missing-sidecar", "binary.sidecar_missing"],
    ["format-sidecar", "binary.sidecar_format"],
    ["mismatch-sidecar", "binary.sidecar_mismatch"],
    ["orphan-sidecar", "binary.sidecar_orphan"],
    ["case-sidecar", "binary.sidecar_orphan"],
  ] as const)("[integrity-failures] rejects %s", (mutation, code) => {
    const entries = committedEntries(tempDir);
    const first = entries.find((entry) => entry.kind === "fit")!;
    const inventory = committedInventory(entries);
    if (mutation === "bytes") first.bytes++;
    if (mutation === "sha256") first.sha256 = "0".repeat(64);
    if (mutation === "missing-sidecar")
      inventory.sidecars = inventory.sidecars.filter((path) => path !== `${first.path}.sha256`);
    if (mutation === "format-sidecar")
      write(`${first.path}.sha256`, `${first.sha256} ${first.path.split("/").at(-1)}`);
    if (mutation === "mismatch-sidecar")
      write(`${first.path}.sha256`, `${"f".repeat(64)}  ${first.path.split("/").at(-1)}\n`);
    if (mutation === "orphan-sidecar") {
      const orphan = `${INGEST}/orphan.gpx.sha256`;
      write(orphan, `${"0".repeat(64)}  orphan.gpx\n`);
      inventory.sidecars.push(orphan);
    }
    if (mutation === "case-sidecar") {
      const exact = `${first.path}.sha256`;
      const mixed = `${first.path}.SHA256`;
      write(mixed, readFileSync(join(tempDir, exact)));
      inventory.sidecars = inventory.sidecars.filter((path) => path !== exact).concat(mixed);
    }
    writeCommittedManifest(tempDir, entries);
    expect(
      findBinaryFixtureHits(inventory.fixtures, inventory.sidecars, { rootDir: tempDir }).map(
        (hit) => hit.code,
      ),
    ).toContain(code);
  });

  it.each([
    ["spacing", (digest: string, name: string) => `${digest} ${name}\n`],
    ["newline", (digest: string, name: string) => `${digest}  ${name}`],
    ["basename", (digest: string) => `${digest}  wrong.fit\n`],
  ])("[integrity-failures] rejects malformed sidecar %s", (_name, contents) => {
    const entries = committedEntries(tempDir);
    const first = entries.find((entry) => entry.kind === "fit")!;
    writeCommittedManifest(tempDir, entries);
    write(`${first.path}.sha256`, contents(first.sha256, first.path.split("/").at(-1)!));
    const inventory = committedInventory(entries);
    const codes = findBinaryFixtureHits(inventory.fixtures, inventory.sidecars, {
      rootDir: tempDir,
    }).map((hit) => hit.code);
    expect(codes).toContain(
      _name === "basename" ? "binary.sidecar_mismatch" : "binary.sidecar_format",
    );
  });

  it.each(["fit", "tcx", "gpx"])(
    "[integrity-failures] rejects orphan .%s sidecars",
    (extension) => {
      const entries = committedEntries(tempDir);
      writeCommittedManifest(tempDir, entries);
      const inventory = committedInventory(entries);
      const orphan = `${INGEST}/orphan.${extension}.sha256`;
      write(orphan, `${"0".repeat(64)}  orphan.${extension}\n`);
      inventory.sidecars.push(orphan);
      expect(
        findBinaryFixtureHits(inventory.fixtures, inventory.sidecars, { rootDir: tempDir }).map(
          (hit) => hit.code,
        ),
      ).toContain("binary.sidecar_orphan");
    },
  );
});

describe("artifact validation", () => {
  it.each([
    [
      "bom",
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("{}\n")]),
      "artifact.noncanonical",
    ],
    ["utf8", Buffer.from([0xff]), "artifact.invalid_utf8"],
    ["json", "{\n", "artifact.invalid_json"],
    ["crlf", "{\r\n}\r\n", "artifact.noncanonical"],
    ["tab", '{\n\t"schema_version": 1\n}\n', "artifact.noncanonical"],
    ["trailing", "{} \n", "artifact.noncanonical"],
    ["missing-lf", "{}", "artifact.noncanonical"],
    ["extra-lf", "{}\n\n", "artifact.noncanonical"],
    ["indent", '{\n    "schema_version": 1\n}\n', "artifact.noncanonical"],
    ["number-spelling", '{"schema_version":1e0}\n', "artifact.noncanonical"],
  ] as const)("[canonical-json] rejects %s", (_name, bytes, code) => {
    write(MANIFEST, bytes);
    expectOnlyCode(
      findBinaryFixtureHits([`${INGEST}/missing.fit`], [], { rootDir: tempDir }),
      code,
    );
  });

  it.each([
    [
      "wrong-order",
      `{"hash_algorithm":"sha256","schema_version":1,"policy_sha256":"${"0".repeat(64)}","files":[]}\n`,
    ],
    [
      "integer-key",
      `{"schema_version":1,"hash_algorithm":"sha256","policy_sha256":"${"0".repeat(64)}","0":true,"files":[]}\n`,
    ],
    ["missing", `{"schema_version":1,"hash_algorithm":"sha256","files":[]}\n`],
    [
      "repeat",
      `{"schema_version":1,"schema_version":1,"hash_algorithm":"sha256","policy_sha256":"${"0".repeat(64)}","files":[]}\n`,
    ],
  ])("[canonical-json] classifies %s as schema before lower defects", (_name, raw) => {
    write(MANIFEST, JSON.stringify(JSON.parse(raw), null, 2) + "\n");
    if (_name === "repeat")
      write(
        MANIFEST,
        `{\n  "schema_version": 1,\n  "schema_version": 1,\n  "hash_algorithm": "sha256",\n  "policy_sha256": "${"0".repeat(64)}",\n  "files": []\n}\n`,
      );
    if (_name === "wrong-order")
      write(
        MANIFEST,
        `{\n  "hash_algorithm": "sha256",\n  "schema_version": 1,\n  "policy_sha256": "${"0".repeat(64)}",\n  "files": []\n}\n`,
      );
    if (_name === "integer-key")
      write(
        MANIFEST,
        `{\n  "schema_version": 1,\n  "hash_algorithm": "sha256",\n  "policy_sha256": "${"0".repeat(64)}",\n  "0": true,\n  "files": []\n}\n`,
      );
    expectOnlyCode(
      findBinaryFixtureHits([`${INGEST}/missing.fit`], [], { rootDir: tempDir }),
      "artifact.schema",
    );
  });

  it.each([
    [
      "unsafe",
      (entries: Entry[]) => {
        entries[0].path = "../unsafe.fit";
      },
      "artifact.unsafe_path",
    ],
    [
      "absolute",
      (entries: Entry[]) => {
        entries[0].path = "/unsafe.fit";
      },
      "artifact.unsafe_path",
    ],
    [
      "backslash",
      (entries: Entry[]) => {
        entries[0].path = "packages\\unsafe.fit";
      },
      "artifact.unsafe_path",
    ],
    [
      "unsorted",
      (entries: Entry[]) => {
        [entries[0], entries[1]] = [entries[1], entries[0]];
      },
      "artifact.unsorted",
    ],
    [
      "duplicate",
      (entries: Entry[]) => {
        entries[1].path = entries[0].path;
      },
      "artifact.duplicate_path",
    ],
    [
      "collision",
      (entries: Entry[]) => {
        entries[1].path = entries[0].path.replace(/[^/]+$/, (name) => name.toUpperCase());
      },
      "artifact.case_collision",
    ],
    [
      "digest",
      (entries: Entry[]) => {
        entries[1].sha256 = entries[0].sha256;
      },
      "artifact.duplicate_digest",
    ],
    [
      "kind",
      (entries: Entry[]) => {
        entries[0].kind = "tcx";
      },
      "artifact.schema",
    ],
    [
      "serial",
      (entries: Entry[]) => {
        entries[0].serial = null;
      },
      "artifact.schema",
    ],
    [
      "bytes",
      (entries: Entry[]) => {
        entries[0].bytes = 0;
      },
      "artifact.schema",
    ],
    [
      "bad-digest",
      (entries: Entry[]) => {
        entries[0].sha256 = "bad";
      },
      "artifact.schema",
    ],
    [
      "qa",
      (entries: Entry[]) => {
        entries[0].qa_cell = "unknown";
      },
      "artifact.schema",
    ],
  ] as const)("[manifest-schema] rejects %s", (_name, mutate, code) => {
    const entries = committedEntries(tempDir, false);
    mutate(entries);
    writeCommittedManifest(tempDir, entries);
    expect(findBinaryFixtureHits([], [], { rootDir: tempDir }).map((hit) => hit.code)).toContain(
      code,
    );
  });
});

describe("XML privacy", () => {
  it("[tcx-valid] accepts TCX v2 paired positions and a zoned shifted time", () => {
    expect(validateXmlFixtureBytes(Buffer.from(validTcx()), "valid.tcx")).toEqual([]);
  });

  it.each([
    [
      "partial",
      validTcx().replace(/<LongitudeDegrees>[\s\S]*?<\/LongitudeDegrees>/, ""),
      "xml.missing_required",
    ],
    [
      "duplicate",
      validTcx().replace(
        "</Position>",
        `<LatitudeDegrees>${SYNTHETIC_GEO_CENTER.lat}</LatitudeDegrees></Position>`,
      ),
      "xml.missing_required",
    ],
    [
      "malformed-number",
      validTcx().replace(`${SYNTHETIC_GEO_CENTER.lat}</LatitudeDegrees>`, "NaN</LatitudeDegrees>"),
      "xml.invalid_number",
    ],
    [
      "nonfinite",
      validTcx().replace(
        `${SYNTHETIC_GEO_CENTER.lat}</LatitudeDegrees>`,
        "1e999</LatitudeDegrees>",
      ),
      "xml.invalid_number",
    ],
    [
      "outside",
      validTcx().replace(
        `${SYNTHETIC_GEO_CENTER.lat}</LatitudeDegrees>`,
        `${SYNTHETIC_GEO_BOX.maxLat + 1}</LatitudeDegrees>`,
      ),
      "xml.invalid_coordinate",
    ],
  ])("[tcx-invalid] rejects %s", (_name, xml, code) => {
    expectOnlyCode(validateXmlFixtureBytes(Buffer.from(xml), "invalid.tcx"), code);
  });

  it.each([
    [GPX_10_NS, "1.0"],
    [GPX_11_NS, "1.1"],
  ])("[gpx-valid] accepts namespace %s version %s", (namespace, version) => {
    expect(validateXmlFixtureBytes(Buffer.from(validGpx(namespace, version)), "valid.gpx")).toEqual(
      [],
    );
  });

  it.each([
    [
      "missing",
      validGpx().replace(` lat="${SYNTHETIC_GEO_CENTER.lat}"`, ""),
      "xml.missing_required",
    ],
    [
      "malformed",
      validGpx().replace(`lat="${SYNTHETIC_GEO_CENTER.lat}"`, 'lat="NaN"'),
      "xml.invalid_number",
    ],
    [
      "outside",
      validGpx().replace(
        `lon="${SYNTHETIC_GEO_CENTER.lon}"`,
        `lon="${SYNTHETIC_GEO_BOX.maxLon + 1}"`,
      ),
      "xml.invalid_coordinate",
    ],
    ["missing-version", validGpx().replace(' version="1.1"', ""), "xml.namespace"],
    [
      "qualified-version",
      validGpx().replace(' version="1.1"', ' version="1.1" xmlns:x="urn:test" x:version="1.1"'),
      "xml.namespace",
    ],
    ["mismatch-10", validGpx(GPX_10_NS, "1.1"), "xml.namespace"],
    ["mismatch-11", validGpx(GPX_11_NS, "1.0"), "xml.namespace"],
  ])("[gpx-invalid] rejects %s", (_name, xml, code) => {
    expectOnlyCode(validateXmlFixtureBytes(Buffer.from(xml), "invalid.gpx"), code);
  });

  it.each([
    [
      "core",
      validGpx().replace(FIT_DATE_TIME_FLOOR_ISO, "2026-01-01T00:00:00Z"),
      "xml.current_era_date",
    ],
    [
      "extension",
      validGpx().replace("</gpx>", "<extension>2026-01-01</extension></gpx>"),
      "xml.current_era_date",
    ],
    ["attribute", validGpx().replace("<gpx ", '<gpx note="2026-01-01" '), "xml.current_era_date"],
    [
      "unzone",
      validGpx().replace(FIT_DATE_TIME_FLOOR_ISO, FIT_DATE_TIME_FLOOR_ISO.replace("Z", "")),
      "xml.invalid_time",
    ],
  ])("[xml-date] rejects %s", (_name, xml, code) => {
    expectOnlyCode(validateXmlFixtureBytes(Buffer.from(xml), "date.gpx"), code);
  });

  it("[xml-date] accepts zoned shifted instants", () => {
    expect(validateXmlFixtureBytes(Buffer.from(validGpx()), "date.gpx")).toEqual([]);
  });

  it.each([
    ["utf8", Buffer.from([0xff]), "xml.invalid_utf8"],
    ["namespace", Buffer.from('<gpx xmlns="urn:wrong" version="1.1"/>'), "xml.namespace"],
    ["doctype", Buffer.from("<!DOCTYPE gpx><gpx/>"), "xml.doctype_forbidden"],
    ["entity", Buffer.from("<!-- <!ENTITY x 'y'> --><gpx/>"), "xml.doctype_forbidden"],
    ["pi", Buffer.from("<gpx/><?later x?>"), "xml.processing_instruction_forbidden"],
    ["parse", Buffer.from("<gpx>"), "xml.parse"],
  ] as const)("[xml-security] rejects %s before unsafe recovery", (_name, bytes, code) => {
    const parser = vi.fn(() => new DOMParser().parseFromString("<gpx/>", "application/xml"));
    const prescan = ["doctype", "entity", "pi", "utf8"].includes(_name);
    const hits = prescan
      ? validateXmlFixtureBytes(bytes, "security.gpx", parser)
      : validateXmlFixtureBytes(bytes, "security.gpx");
    expectOnlyCode(hits, code);
    if (prescan) expect(parser).not.toHaveBeenCalled();
  });

  it.each([
    [10, "xml.doctype_forbidden"],
    [6, "xml.doctype_forbidden"],
    [5, "xml.doctype_forbidden"],
    [7, "xml.processing_instruction_forbidden"],
  ] as const)("[xml-security] direct DOM guard rejects node type %i", (nodeType, code) => {
    if (nodeType === 10) {
      const implementation = new DOMImplementation();
      const document = implementation.createDocument(
        GPX_11_NS,
        "gpx",
        implementation.createDocumentType("gpx", "", ""),
      );
      expectOnlyCode(guardXmlDocument(document, "guard.gpx"), code);
      return;
    }
    if (nodeType === 7) {
      const document = new DOMImplementation().createDocument(GPX_11_NS, "gpx", null);
      document.appendChild(document.createProcessingInstruction("later", "x"));
      expectOnlyCode(guardXmlDocument(document, "guard.gpx"), code);
      return;
    }
    const forbidden = { nodeType, childNodes: { length: 0, item: () => null }, parentNode: null };
    const root = {
      nodeType: 1,
      childNodes: { length: 1, item: () => forbidden },
      parentNode: null,
    };
    forbidden.parentNode = root as never;
    const document = {
      nodeType: 9,
      childNodes: { length: 1, item: () => root },
      documentElement: root,
      parentNode: null,
    };
    root.parentNode = document as never;
    expectOnlyCode(guardXmlDocument(document as never, "guard.gpx"), code);
  });

  it("[precedence] orders same-code XML hits by DOM path", () => {
    const xml = validGpx().replaceAll(
      `lat="${SYNTHETIC_GEO_CENTER.lat}"`,
      `lat="${SYNTHETIC_GEO_BOX.maxLat + 1}"`,
    );
    const hits = validateXmlFixtureBytes(Buffer.from(xml), "ordered.gpx");
    expect(new Set(hits.map((hit) => hit.code))).toEqual(new Set(["xml.invalid_coordinate"]));
    expect(hits.map((hit) => hit.path)).toEqual(hits.map((hit) => hit.path).sort());
  });
});

function evidence(qa: string, byQa: Map<string, { sha256: string }>): unknown {
  switch (qa) {
    case "triathlon-multisport":
      return {
        kind: "triathlon_multisport",
        session_count: 5,
        session_tuples: [
          ["swimming", "open_water"],
          ["transition", "generic"],
          ["cycling", "generic"],
          ["transition", "generic"],
          ["running", "generic"],
        ],
        session_trigger_raw: [2, 2, 2, 2, 0],
        session_trigger_sdk: [
          "autoMultiSport",
          "autoMultiSport",
          "autoMultiSport",
          "autoMultiSport",
          "activityEnd",
        ],
        session_start_raw: [268500000, 268500003, 268500005, 268500009, 268500011],
        session_end_raw: [268500003, 268500005, 268500009, 268500011, 268500014],
        transition_indexes: [1, 3],
        shared_boundary_pairs: [
          [0, 1],
          [1, 2],
          [2, 3],
          [3, 4],
        ],
        markers: [
          {
            event: 38,
            event_type: "marker",
            data: 271,
            timestamp_raw: 268500002,
            role: "before_session_0_closing_lap_and_session",
          },
          {
            event: 38,
            event_type: "marker",
            data: 0,
            timestamp_raw: 268500013,
            role: "before_session_4_closing_lap_session_and_activity",
          },
        ],
        terminal_activity: {
          type: "auto_multi_sport",
          num_sessions: 5,
          event: "activity",
          event_type: "stop",
        },
        assignment_ranges: [
          "[start,end)",
          "[start,end)",
          "[start,end)",
          "[start,end)",
          "[start,end]",
        ],
        per_index_counts: [3, 2, 4, 2, 3],
        record_count: 14,
        unassigned_records: 0,
        ambiguous_records: 0,
        corrected_rerun_verdict: "KEEP",
      };
    case "duathlon-run-bike-run":
      return {
        kind: "duathlon_run_bike_run",
        session_count: 3,
        session_tuples: [
          ["running", "generic"],
          ["cycling", "generic"],
          ["running", "generic"],
        ],
        session_start_raw: [268510000, 268510003, 268510007],
        session_end_raw: [268510003, 268510007, 268510010],
        repeated_running_indexes: [0, 2],
        per_index_counts: [3, 4, 3],
        record_count: 10,
      };
    case "brick-cycling":
      return {
        kind: "brick_member",
        role: "earlier",
        counterpart_path: `${INGEST}/brick-running.fit`,
        counterpart_sha256: byQa.get("brick-running")!.sha256,
        sport: "cycling",
        start_raw: 268520000,
        end_raw: 268522400,
        counterpart_start_raw: 268523300,
        gap_s: 900,
      };
    case "brick-running":
      return {
        kind: "brick_member",
        role: "later",
        counterpart_path: `${INGEST}/brick-cycling.fit`,
        counterpart_sha256: byQa.get("brick-cycling")!.sha256,
        sport: "running",
        start_raw: 268523300,
        end_raw: 268525100,
        counterpart_end_raw: 268522400,
        gap_s: 900,
      };
    case "multisport-missing-generic-transition":
      return {
        kind: "missing_generic_transition",
        session_count: 4,
        session_tuples: [
          ["running", "generic"],
          ["transition", "generic"],
          ["cycling", "generic"],
          ["running", "generic"],
        ],
        session_start_raw: [268530000, 268530003, 268530005, 268530009],
        session_end_raw: [268530003, 268530005, 268530009, 268530012],
        generic_transition_indexes: [1],
        missing_transition_boundaries: [{ from_index: 2, to_index: 3 }],
        non_transition_session_indexes: [0, 2, 3],
      };
    case "pool-swim-drill-lengths":
      return {
        kind: "pool_swim_drill",
        session_count: 1,
        pool_length_m: 25,
        length_count: 4,
        active_length_count: 4,
        drill_length_index: 2,
        drill_raw_swim_stroke: 4,
        drill_length_type: "active",
        source_session_distance_m: 100,
      };
    case "pool-size-correction":
      return {
        kind: "pool_size_correction_ready",
        session_count: 1,
        length_count: 4,
        active_length_count: 4,
        source_session_distance_m: 100,
        original_pool_length_m: 25,
        proposed_correction_m: 50,
        expected_multiplier: 2,
        expected_active_length_distances_m: [50, 50, 50, 50],
        expected_corrected_session_distance_m: 200,
      };
    default:
      return {
        kind: "dual_developer_index",
        developer_data_ids: 2,
        field_descriptions: 28,
        duplicate_names: 14,
        native_message_types: [18, 19, 20],
        identity_slots: 178,
        identity_slots_by_family: { session: 12, lap: 6, record: 160 },
        duplicate_name: "currHemoPerc",
        duplicate_values: [
          { developer_data_index: 0, value: 62.099998474121094 },
          { developer_data_index: 1, value: 65.5999984741211 },
        ],
      };
  }
}

interface StageFixture {
  root: string;
  bundle: string;
  fragment: { schema_version: number; policy_sha256: string; files: Entry[] };
  ready: Record<string, unknown> & {
    files: Record<string, unknown>[];
    operator_attestation: Record<string, unknown>;
  };
}

function buildStage(): StageFixture {
  const root = join(tempDir, "repo");
  const bundle = "stage";
  writeEmptyManifest(root);
  const encoder = join(tempDir, "node_modules", "@garmin", "fitsdk", "package.json");
  writeAt(
    tempDir,
    "node_modules/@garmin/fitsdk/package.json",
    canonical({ name: LOCAL_ENCODER_PACKAGE, version: LOCAL_ENCODER_VERSION }),
  );
  const fragmentFiles = committedEntries(root, false).filter((entry) => entry.kind === "fit");
  const recipe = sha256("FABRICATED-CANONICAL-RECIPE");
  const files = fragmentFiles.map((entry) => {
    const bytes = Buffer.from(`FABRICATED-STAGED-${entry.qa_cell}`);
    entry.sha256 = sha256(bytes);
    entry.bytes = bytes.length;
    writeAt(root, `${bundle}/files/${entry.path}`, bytes);
    writeAt(root, `${bundle}/files/${entry.path}.sha256`, sidecar(bytes, entry.path));
    return { entry, bytes };
  });
  const evidenceByQa = new Map(fragmentFiles.map((entry) => [entry.qa_cell, entry]));
  const readyFiles = files.map(({ entry }) => {
    const qaEvidence = evidence(entry.qa_cell, evidenceByQa);
    const binding = sha256(
      canonical({ fixture_sha256: entry.sha256, qa_cell: entry.qa_cell, evidence: qaEvidence }),
    );
    return {
      path: entry.path,
      sha256: entry.sha256,
      bytes: entry.bytes,
      serial: entry.serial,
      qa_cell: entry.qa_cell,
      source_kind: "synthetic_from_scratch",
      producer_recipe_sha256: recipe,
      evidence: qaEvidence,
      evidence_binding_sha256: binding,
      validation: {
        sdk_decode_errors: 0,
        sdk_redecode_errors: 0,
        two_fresh_encodes_equal: true,
        lossless_scope: true,
        fit_file_parser_records: 1,
        fit_file_parser_sessions: 1,
        geo_box: true,
        geo_max_cumulative_divergence_ratio: 0,
        minimum_raw_date_time: FIT_DATE_TIME_FLOOR_RAW,
        date_floor_and_roundtrip: true,
        field_lifecycle: true,
        exotic_family_parity: true,
        record_assignment_exactly_once: true,
        u10_exactly_once: entry.qa_cell === "triathlon-multisport" ? true : null,
      },
      drops: {
        zero_enumerable_messages: [],
        non_finite_numeric_values: [],
        user_profile_messages: 0,
      },
    };
  });
  const attested = readyFiles.map((entry) => ({
    path: entry.path,
    sha256: entry.sha256,
    source_kind: entry.source_kind,
    producer_recipe_sha256: entry.producer_recipe_sha256,
    evidence_binding_sha256: entry.evidence_binding_sha256,
  }));
  const attestationWithoutHash = {
    attestation_version: 1,
    attestor_role: "capable_operator",
    statement:
      "Every listed FIT fixture was synthesized from scratch without using an athlete recording as input.",
    source_kind: "synthetic_from_scratch",
    producer_recipe_sha256: recipe,
    files: attested,
  };
  const ready = {
    schema_version: 1,
    producer_recipe_version: "w2-fit-producer-v1",
    policy_sha256: policyHash(),
    encoder: {
      package: LOCAL_ENCODER_PACKAGE,
      version: LOCAL_ENCODER_VERSION,
      coordinate: pathToFileURL(encoder).href,
    },
    policy: {
      geo_algorithm: SYNTHETIC_GEO_ALGORITHM,
      earth_radius_m: SYNTHETIC_GEO_EARTH_RADIUS_M,
      center: { lat: SYNTHETIC_GEO_CENTER.lat, lon: SYNTHETIC_GEO_CENTER.lon },
      box: {
        minLat: SYNTHETIC_GEO_BOX.minLat,
        maxLat: SYNTHETIC_GEO_BOX.maxLat,
        minLon: SYNTHETIC_GEO_BOX.minLon,
        maxLon: SYNTHETIC_GEO_BOX.maxLon,
      },
      laps: SYNTHETIC_GEO_LAPS,
      quantization: SYNTHETIC_GEO_QUANTIZATION,
      max_cumulative_divergence_ratio: SYNTHETIC_GEO_MAX_CUMULATIVE_DIVERGENCE_RATIO,
      fit_date_time_floor_raw: FIT_DATE_TIME_FLOOR_RAW,
      fit_date_time_floor_iso: FIT_DATE_TIME_FLOOR_ISO,
      serial_min: SYNTHETIC_FILE_ID_SERIAL_MIN,
      serial_max: SYNTHETIC_FILE_ID_SERIAL_MAX,
    },
    operator_attestation: {
      ...attestationWithoutHash,
      attestation_sha256: sha256(canonical(attestationWithoutHash)),
    },
    files: readyFiles,
  };
  const fragment = { schema_version: 1, policy_sha256: policyHash(), files: fragmentFiles };
  writeAt(root, `${bundle}/manifest-fragment.json`, canonical(fragment));
  writeAt(root, `${bundle}/READY.json`, canonical(ready));
  return { root, bundle, fragment, ready };
}

function rewriteStage(stage: StageFixture): void {
  writeAt(stage.root, `${stage.bundle}/manifest-fragment.json`, canonical(stage.fragment));
  writeAt(stage.root, `${stage.bundle}/READY.json`, canonical(stage.ready));
}

describe("staged contract", () => {
  it("[fragment-schema] accepts the exact fabricated eight-entry fragment", () => {
    const stage = buildStage();
    expect(findStagedBundleHits(stage.bundle, stage.root)).toEqual([]);
  });

  it.each(["count", "xml", "serial", "qa"])("[fragment-schema] rejects %s", (mutation) => {
    const stage = buildStage();
    if (mutation === "count") stage.fragment.files.pop();
    if (mutation === "xml") stage.fragment.files[0].kind = "tcx";
    if (mutation === "serial") stage.fragment.files[1].serial = stage.fragment.files[0].serial;
    if (mutation === "qa") stage.fragment.files[1].qa_cell = stage.fragment.files[0].qa_cell;
    rewriteStage(stage);
    expectOnlyCode(findStagedBundleHits(stage.bundle, stage.root), "artifact.schema");
  });

  it("[ready-schema] rejects key-order and type violations", () => {
    const stage = buildStage();
    stage.ready.schema_version = 2;
    rewriteStage(stage);
    expectOnlyCode(findStagedBundleHits(stage.bundle, stage.root), "artifact.schema");
  });

  it.each([
    ["policy", "artifact.policy_snapshot"],
    ["policy-hash", "artifact.policy_hash"],
    ["encoder", "artifact.encoder_coordinate"],
    ["recipe", "artifact.provenance"],
    ["attestation", "artifact.attestation"],
    ["evidence", "artifact.evidence"],
    ["binding", "artifact.evidence_binding"],
    ["validation", "artifact.validation"],
    ["loss-trim", "artifact.validation"],
  ] as const)("[attestation-evidence] rejects %s", (mutation, code) => {
    const stage = buildStage();
    const first = stage.ready.files[0];
    if (mutation === "policy")
      (stage.ready.policy as Record<string, unknown>).laps = SYNTHETIC_GEO_LAPS + 1;
    if (mutation === "policy-hash") stage.ready.policy_sha256 = "0".repeat(64);
    if (mutation === "encoder")
      (stage.ready.encoder as Record<string, unknown>).coordinate = pathToFileURL(
        join(stage.root, "inside", "node_modules", "@garmin", "fitsdk", "package.json"),
      ).href;
    if (mutation === "recipe") first.producer_recipe_sha256 = "0".repeat(64);
    if (mutation === "attestation")
      (stage.ready.operator_attestation as Record<string, unknown>).attestation_sha256 = "0".repeat(
        64,
      );
    if (mutation === "evidence") (first.evidence as Record<string, unknown>).kind = "wrong";
    if (mutation === "binding") first.evidence_binding_sha256 = "0".repeat(64);
    if (mutation === "validation")
      (first.validation as Record<string, unknown>).sdk_decode_errors = 1;
    if (mutation === "loss-trim")
      (first.drops as Record<string, unknown>).zero_enumerable_messages = [
        { message_type: " record ", count: 1 },
      ];
    rewriteStage(stage);
    expect(findStagedBundleHits(stage.bundle, stage.root).map((hit) => hit.code)).toContain(code);
  });

  it("[attestation-evidence] accepts positive sorted loss tuples", () => {
    const stage = buildStage();
    const first = stage.ready.files[0];
    (first.drops as Record<string, unknown>).zero_enumerable_messages = [
      { message_type: "lap", count: 1 },
      { message_type: "record", count: 2 },
    ];
    (first.drops as Record<string, unknown>).non_finite_numeric_values = [
      { message_type: "lap", field: "a", count: 1 },
      { message_type: "lap", field: "b", count: 2 },
    ];
    rewriteStage(stage);
    expect(findStagedBundleHits(stage.bundle, stage.root)).toEqual([]);
  });

  it.each([
    ["zero-count", [{ message_type: "record", count: 0 }], "artifact.schema"],
    ["empty", [{ message_type: "", count: 1 }], "artifact.schema"],
    [
      "duplicate",
      [
        { message_type: "record", count: 1 },
        { message_type: "record", count: 1 },
      ],
      "artifact.validation",
    ],
    [
      "reversed",
      [
        { message_type: "record", count: 1 },
        { message_type: "lap", count: 1 },
      ],
      "artifact.validation",
    ],
  ] as const)("[attestation-evidence] rejects loss tuple %s", (_name, losses, code) => {
    const stage = buildStage();
    (stage.ready.files[0].drops as Record<string, unknown>).zero_enumerable_messages = losses;
    rewriteStage(stage);
    expect(findStagedBundleHits(stage.bundle, stage.root).map((hit) => hit.code)).toContain(code);
  });

  it("[attestation-evidence] sorts loss tuples by Unicode scalar value", () => {
    const stage = buildStage();
    const losses = [
      { message_type: "\uE000", count: 1 },
      { message_type: "\u{10000}", count: 1 },
    ];
    (stage.ready.files[0].drops as Record<string, unknown>).zero_enumerable_messages = losses;
    rewriteStage(stage);
    expect(findStagedBundleHits(stage.bundle, stage.root)).toEqual([]);
    losses.reverse();
    rewriteStage(stage);
    expect(findStagedBundleHits(stage.bundle, stage.root).map((hit) => hit.code)).toContain(
      "artifact.validation",
    );
  });

  it("[cli-modes] rejects an inexact staged inventory", () => {
    const stage = buildStage();
    writeAt(stage.root, `${stage.bundle}/extra.txt`, "extra");
    expectOnlyCode(findStagedBundleHits(stage.bundle, stage.root), "artifact.inventory");
  });

  it("[destination-conflict] accepts byte-identical idempotent destinations", () => {
    const stage = buildStage();
    for (const entry of stage.fragment.files) {
      writeAt(
        stage.root,
        entry.path,
        readFileSync(join(stage.root, stage.bundle, "files", entry.path)),
      );
      writeAt(
        stage.root,
        `${entry.path}.sha256`,
        readFileSync(join(stage.root, stage.bundle, "files", `${entry.path}.sha256`)),
      );
    }
    const xmlEntries = committedEntries(stage.root, false).filter((entry) => entry.kind !== "fit");
    writeCommittedManifest(
      stage.root,
      [...stage.fragment.files, ...xmlEntries].sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      ),
    );
    expect(findStagedBundleHits(stage.bundle, stage.root)).toEqual([]);
  });

  it("[destination-conflict] reports class 6 before provenance", () => {
    const stage = buildStage();
    const first = stage.ready.files[0];
    writeAt(stage.root, first.path as string, Buffer.from("different"));
    first.producer_recipe_sha256 = "0".repeat(64);
    rewriteStage(stage);
    expectOnlyCode(
      findStagedBundleHits(stage.bundle, stage.root),
      "binary.stage_destination_conflict",
    );
  });

  it("[precedence] reports only the first failure class in complete order", () => {
    const stage = buildStage();
    const first = stage.fragment.files[0];
    first.path = "../unsafe.fit";
    first.sha256 = stage.fragment.files[1].sha256;
    rewriteStage(stage);
    const hits = findStagedBundleHits(stage.bundle, stage.root);
    expect(new Set(hits.map((hit) => hit.code))).toEqual(
      new Set(["artifact.unsafe_path", "artifact.duplicate_digest"]),
    );
    expect(hits).toEqual(
      [...hits].sort(
        (a, b) =>
          a.file.localeCompare(b.file) ||
          a.code.localeCompare(b.code) ||
          a.path.localeCompare(b.path),
      ),
    );
  });
});

describe("CLI and scope", () => {
  it.each([
    ["--unknown"],
    ["--root"],
    ["--root", "relative"],
    ["--root", "/tmp/a", "extra"],
    ["--root", "/tmp/a", "--root", "/tmp/b"],
    ["--staged-bundle"],
    ["--staged-bundle", "/absolute"],
    ["--staged-bundle", "../unsafe"],
    ["--staged-bundle", "stage", "extra"],
    ["--root", "/tmp/a", "--staged-bundle", "stage"],
  ])("[cli-modes] rejects invalid grammar %#", (...argv) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(main(argv)).toBe(2);
  });

  it("[root-shadow] validates a clean and failing outside root", () => {
    const shadow = join(tempDir, "shadow");
    writeEmptyManifest(shadow);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(main(["--root", shadow])).toBe(0);
    writeAt(shadow, `${INGEST}/unmanifested.fit`, Buffer.from("FABRICATED"));
    expect(main(["--root", shadow])).toBe(1);
  });

  it("[legacy-preserved] explicit Rule A paths do not suppress Rule B", () => {
    writeEmptyManifest();
    write("README.md", "clean\n");
    write("packages/core/tests/fixtures/golden/realistic-athlete.json", `{ "d": "2026-01-01" }\n`);
    const original = process.cwd();
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      process.chdir(tempDir);
      expect(main(["README.md"])).toBe(1);
    } finally {
      process.chdir(original);
    }
  });

  it("flags a real-shaped id under every GitHub-visible default surface", () => {
    writeEmptyManifest();
    const paths = [
      ".changeset/sneaky-change.md",
      "README.md",
      "CONTRIBUTING.md",
      "CONTEXT-MAP.md",
      "NOTICE.md",
    ];
    for (const path of paths) write(path, "prose mentioning i123456789\n");
    const original = process.cwd();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      process.chdir(tempDir);
      expect(main([])).toBe(1);
    } finally {
      process.chdir(original);
    }
    const output = error.mock.calls.flat().join(" ");
    for (const path of paths) expect(output).toContain(path);
  });

  it("scans the dot-named changeset directory as a top-level path", () => {
    writeEmptyManifest();
    write(".changeset/leak.md", "id i987654321\n");
    const original = process.cwd();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      process.chdir(tempDir);
      expect(main([])).toBe(1);
    } finally {
      process.chdir(original);
    }
    expect(error.mock.calls.flat().join(" ")).toContain(".changeset/leak.md");
  });

  it("preserves the complete legacy hit shape", () => {
    const idFile = write("a.json", `{ "id": "i123456789" }\n`);
    const dateFile = write("realistic-athlete.json", `{ "d": "2026-01-01" }\n`);
    for (const hit of [...findIdHits([idFile]), ...findDateHits([dateFile])]) {
      expect(hit).toMatchObject({ file: expect.any(String), path: "$", code: expect.any(String) });
      expect(["intervals-id", "current-era-date"]).toContain(hit.rule);
    }
  });

  it("[main-defaults] creates a policy-bound manifest and scans all default paths", () => {
    writeEmptyManifest();
    for (const path of [
      ".changeset/clean.md",
      "README.md",
      "CONTRIBUTING.md",
      "CONTEXT-MAP.md",
      "NOTICE.md",
    ])
      write(path, "clean\n");
    const original = process.cwd();
    vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      process.chdir(tempDir);
      expect(main([])).toBe(0);
    } finally {
      process.chdir(original);
    }
    expect(DEFAULT_SCAN_PATHS).toContain(".changeset");
    expect(DEFAULT_SCAN_PATHS).toContain("apps");
  });

  it("[main-defaults] scans app sources for identifier leaks", () => {
    writeEmptyManifest();
    write("apps/desktop-renderer/src/leak.ts", `export const id = "i987654321";\n`);
    const original = process.cwd();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      process.chdir(tempDir);
      expect(main([])).toBe(1);
    } finally {
      process.chdir(original);
    }
    expect(error.mock.calls.flat().join(" ")).toContain("apps/desktop-renderer/src/leak.ts");
  });

  it("[scope-separation] explicit prose input cannot hide unconditional binary inventory", () => {
    const entries = committedEntries(tempDir);
    writeCommittedManifest(tempDir, entries);
    write("README.md", "clean\n");
    const original = process.cwd();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      process.chdir(tempDir);
      expect(main(["README.md"])).toBe(0);
      rmSync(join(tempDir, entries[0].path));
      expect(main(["README.md"])).toBe(1);
    } finally {
      process.chdir(original);
    }
    expect(error.mock.calls.flat().join(" ")).toContain("binary.manifest_missing_file");
  });

  it.each(["file-outside", "directory-outside", "broken"])(
    "[physical-containment] rejects %s symlinks",
    (kind) => {
      const root = join(tempDir, "repo");
      writeEmptyManifest(root);
      mkdirSync(join(root, "packages"), { recursive: true });
      if (kind === "file-outside") {
        const outside = write("outside.bin", "FABRICATED");
        symlinkSync(outside, join(root, "packages", "linked.fit"));
      } else if (kind === "directory-outside") {
        const outside = join(tempDir, "outside-dir");
        writeAt(outside, "nested.fit", "FABRICATED");
        symlinkSync(outside, join(root, "packages", "linked-dir"));
      } else {
        symlinkSync(join(tempDir, "missing"), join(root, "packages", "broken.fit"));
      }
      const original = process.cwd();
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        process.chdir(root);
        expect(main([])).toBe(1);
      } finally {
        process.chdir(original);
      }
      expect(error.mock.calls.flat().join(" ")).toContain("artifact.unsafe_path");
    },
  );
});

describe("diagnostics", () => {
  const codes = [
    "artifact.missing",
    "artifact.invalid_utf8",
    "artifact.invalid_json",
    "artifact.noncanonical",
    "artifact.schema",
    "artifact.unsafe_path",
    "artifact.unsorted",
    "artifact.duplicate_path",
    "artifact.case_collision",
    "artifact.duplicate_digest",
    "artifact.inventory",
    "binary.unmanifested",
    "binary.manifest_missing_file",
    "artifact.policy_hash",
    "artifact.policy_snapshot",
    "artifact.encoder_coordinate",
    "binary.byte_count",
    "binary.hash",
    "binary.sidecar_missing",
    "binary.sidecar_format",
    "binary.sidecar_mismatch",
    "binary.sidecar_orphan",
    "binary.stage_destination_conflict",
    "artifact.provenance",
    "artifact.attestation",
    "artifact.evidence",
    "artifact.evidence_binding",
    "artifact.validation",
    "xml.invalid_utf8",
    "xml.doctype_forbidden",
    "xml.processing_instruction_forbidden",
    "xml.parse",
    "xml.namespace",
    "xml.missing_required",
    "xml.invalid_number",
    "xml.invalid_time",
    "xml.invalid_coordinate",
    "xml.current_era_date",
  ] as const;

  it.each(codes)("[diagnostic-shape] %s has the complete stable shape", (code) => {
    const hit = fixturePrivacyDiagnosticForTest(code, "fixture", "$.value");
    expect(hit).toEqual({
      file: "fixture",
      line: 0,
      column: 0,
      path: "$.value",
      rule: code.startsWith("xml.") ? "xml-privacy" : "binary-manifest",
      code,
      detail: expect.any(String),
    });
    expect(hit.detail).not.toMatch(/FABRICATED|2685|9040|@garmin/);
  });
});
