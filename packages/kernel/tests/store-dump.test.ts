import { describe, expect, it } from "vitest";
import { canonicalizeTable, DERIVED_TABLES, DUMP_TABLES } from "../src/store/dump.js";
import type { Row } from "../src/store/ports.js";

describe("INV-2 canonical dump (armed with real ingest at W2)", () => {
  const rowA: Row = {
    id: "a1",
    sport: "cycling",
    anchor_type: "ftp",
    value: 250.5,
    unit: "W",
    valid_from: 1000,
    source: "manual",
    confidence: "manual",
    note: null,
    provenance: "manual",
    device_id: null,
    hlc_physical_ms: null,
    hlc_counter: null,
  };
  const rowB: Row = {
    id: "a2",
    sport: "cycling",
    anchor_type: "ftp",
    value: 260,
    unit: "W",
    valid_from: 2000,
    source: "manual",
    confidence: "manual",
    note: null,
    provenance: "manual",
    device_id: null,
    hlc_physical_ms: null,
    hlc_counter: null,
  };

  it("emits a table header and one line per row, stable across calls", () => {
    const out = canonicalizeTable("anchor_history", [rowA, rowB]);
    expect(out.startsWith("# anchor_history")).toBe(true);
    expect(out.split("\n")).toHaveLength(3);
    expect(canonicalizeTable("anchor_history", [rowA, rowB])).toBe(out);
  });

  it("normalizes column key order inside a row", () => {
    const scrambled: Row = {
      value: 250.5,
      id: "a1",
      sport: "cycling",
      anchor_type: "ftp",
      unit: "W",
      valid_from: 1000,
      source: "manual",
      confidence: "manual",
      note: null,
      provenance: "manual",
      device_id: null,
      hlc_physical_ms: null,
      hlc_counter: null,
    };
    expect(canonicalizeTable("anchor_history", [scrambled])).toBe(
      canonicalizeTable("anchor_history", [rowA]),
    );
  });

  it("renders a BLOB column via the ['b', ...] tag", () => {
    const row: Row = { data: new Uint8Array([1, 2, 3]) };
    const out = canonicalizeTable("raw_file", [row]);
    expect(out).toContain(`"data":["b","010203"]`);
  });

  it("includes every incremental cache while excluding checkpoint operations", () => {
    const dumped = DUMP_TABLES.map(({ table }) => table);
    expect(dumped).toEqual(
      expect.arrayContaining([
        "activity_analysis_projection",
        "analytics_curve_current",
        "analytics_curve_evidence",
        "analytics_curve_generation",
        "analytics_curve_generation_promotion",
        "ingest_candidate_index",
        "ingest_cluster_state",
        "ingest_dedup_pair_state",
        "ingest_dedup_session_state",
        "ingest_incremental_state",
      ]),
    );
    expect(dumped).not.toContain("source_watermark");
    expect(dumped).not.toContain("sync_operation");
    expect(dumped).not.toContain("analytics_curve_refresh_failure");
    expect(DERIVED_TABLES).toEqual(
      expect.arrayContaining([
        "ingest_candidate_index",
        "ingest_cluster_state",
        "ingest_dedup_pair_state",
        "ingest_dedup_session_state",
      ]),
    );
    expect(DERIVED_TABLES).not.toContain("ingest_incremental_state");
    expect(DERIVED_TABLES).not.toContain("activity_analysis_projection");
  });

  it("includes planning domain tables in dependency-safe order", () => {
    const dumped = DUMP_TABLES.map(({ table }) => table);
    const planning = [
      "plan",
      "planning_authority",
      "planning_plan",
      "plan_revision",
      "plan_creation",
      "plan_creation_answer",
      "plan_creation_draft_revision",
      "athlete_preference",
      "training_restriction",
      "plan_change",
      "planning_command",
    ];
    expect(dumped.filter((table) => planning.includes(table))).toEqual(planning);
  });
});
