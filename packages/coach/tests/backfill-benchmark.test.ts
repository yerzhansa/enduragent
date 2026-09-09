import { describe, expect, it } from "vitest";
import {
  compareBackfillBenchmarks,
  validateBackfillBenchmarkRecord,
} from "../src/backfill-benchmark.js";
import { runBackfillCommand } from "../src/backfill-command.js";

function record(overrides: Record<string, unknown> = {}) {
  const base = {
    schema_version: 1,
    record_id: "synthetic-baseline",
    created_at: "2020-01-01T00:00:00.000Z",
    role: "baseline",
    workload: {
      identity: "history",
      fixture_id: "synthetic-v1",
      synthetic: true,
      row_count: 10,
      activity_count: 10,
      payload_bytes_total: 1000,
      batch_size: 400,
    },
    environment: {
      host_kind: "node-cli",
      runtime: "node",
      runtime_version: "v24.11.1",
      driver: "node:sqlite",
      os: "darwin",
      os_version: "test",
      arch: "arm64",
      hardware: { model: "test-model", cpu: "test-cpu", cores: 8, memory_bytes: 1000 },
      power_state: "unknown",
    },
    sqlite_settings: {
      journal_mode: "wal",
      synchronous: "2",
      wal_autocheckpoint: 1000,
      cache_state: "cold",
    },
    timings: {
      clock_source: "monotonic",
      elapsed_ms: 12,
      provider_wait_ms: 2,
      local_compute_ms: 10,
      phases: [
        { name: "archive-decode", ms: 4, count: 1 },
        { name: "topology", ms: 2, count: 1 },
        { name: "sqlite", ms: 4, count: 1 },
      ],
      unattributed_ms: 0,
    },
    memory: { peak_rss_bytes: 1024, source: "node-resource-usage-maxrss" },
    outcome: { status: "completed", rows_committed_final: 10, duplicate_rows_final: 0 },
    diagnostics: {
      retry_after_observations: {
        absent: 0,
        delta_seconds: 0,
        http_date: 0,
        malformed: 0,
        natural_429_count: 0,
      },
    },
  };
  return { ...base, ...overrides };
}

describe("backfill benchmark record", () => {
  it.each([
    ["--batch-size", "0"],
    ["--request-interval-ms", "249"],
    ["--per-request-timeout-ms", "999"],
    ["--backfill-page-deadline-ms", "59999"],
  ])("rejects an out-of-range %s before synthetic execution", async (flag, value) => {
    await expect(
      runBackfillCommand(["--synthetic", "--benchmark-record", "ignored.json", flag, value]),
    ).rejects.toThrow("invalid");
  });

  it("validates schema and requires numeric wal_autocheckpoint", () => {
    expect(validateBackfillBenchmarkRecord(record()).schema_version).toBe(1);
    const invalid = record();
    delete (invalid.sqlite_settings as Record<string, unknown>).wal_autocheckpoint;
    expect(() => validateBackfillBenchmarkRecord(invalid)).toThrow();
  });

  const credentialShapedSentinel = String.fromCharCode(
    97,
    112,
    105,
    95,
    107,
    101,
    121,
    61,
    115,
    101,
    99,
    114,
    101,
    116,
    45,
    118,
    97,
    108,
    117,
    101,
  );
  it.each([
    "/private/history",
    "C:\\private\\history",
    "a".repeat(64),
    credentialShapedSentinel,
    "athlete-id-42",
    "i12345678",
    "I123456789",
    "2010-01-01",
  ])("rejects privacy-sensitive string %s", (value) => {
    expect(() => validateBackfillBenchmarkRecord(record({ notes: value }))).toThrow("privacy");
  });

  it("keeps the top-level duplicate field authoritative", () => {
    expect(() =>
      validateBackfillBenchmarkRecord(
        record({
          outcome: { status: "completed", rows_committed_final: 10, duplicate_rows_final: 1 },
        }),
      ),
    ).toThrow();
    expect(() =>
      validateBackfillBenchmarkRecord(
        record({
          diagnostics: {
            duplicate_rows_final: 0,
            retry_after_observations: {
              absent: 0,
              delta_seconds: 0,
              http_date: 0,
              malformed: 0,
              natural_429_count: 0,
            },
          },
        }),
      ),
    ).not.toThrow();
  });

  it("validates aggregate diagnostic counters", () => {
    expect(() =>
      validateBackfillBenchmarkRecord(
        record({
          diagnostics: {
            transactions: "one",
            retry_after_observations: {
              absent: 0,
              delta_seconds: 0,
              http_date: 0,
              malformed: 0,
              natural_429_count: 0,
            },
          },
        }),
      ),
    ).toThrow();
  });

  it("enforces comparability including numeric WAL equality", () => {
    expect(compareBackfillBenchmarks(record(), record()).comparable).toBe(true);
    const candidate = record({
      sqlite_settings: {
        journal_mode: "wal",
        synchronous: "2",
        wal_autocheckpoint: 999,
        cache_state: "cold",
      },
    });
    expect(compareBackfillBenchmarks(record(), candidate)).toMatchObject({
      comparable: false,
      driverInvestigation: false,
    });
  });

  it("fires the driver trigger only when both ratios are strictly above two", () => {
    const exact = record({
      timings: {
        clock_source: "monotonic",
        elapsed_ms: 22,
        provider_wait_ms: 2,
        local_compute_ms: 20,
        phases: [
          { name: "archive-decode", ms: 8 },
          { name: "topology", ms: 4 },
          { name: "sqlite", ms: 8 },
        ],
        unattributed_ms: 0,
      },
    });
    expect(compareBackfillBenchmarks(record(), exact).driverInvestigation).toBe(false);
    const over = record({
      timings: {
        clock_source: "monotonic",
        elapsed_ms: 24,
        provider_wait_ms: 2,
        local_compute_ms: 22,
        phases: [
          { name: "archive-decode", ms: 8 },
          { name: "topology", ms: 5 },
          { name: "sqlite", ms: 9 },
        ],
        unattributed_ms: 0,
      },
    });
    expect(compareBackfillBenchmarks(record(), over).driverInvestigation).toBe(true);
  });

  it("validates timing equations, phases, and RSS source", () => {
    expect(() =>
      validateBackfillBenchmarkRecord(
        record({
          timings: {
            clock_source: "monotonic",
            elapsed_ms: 12,
            provider_wait_ms: 2,
            local_compute_ms: 9,
            phases: [
              { name: "archive-decode", ms: 4 },
              { name: "sqlite", ms: 4 },
            ],
            unattributed_ms: 1,
          },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      validateBackfillBenchmarkRecord(
        record({ memory: { peak_rss_bytes: 1, source: "/usr/bin/time" } }),
      ),
    ).toThrow();
  });

  it("validates killed and resume records without requiring completed phases", () => {
    const killed = record({
      timings: {
        clock_source: "supervisor-external",
        elapsed_ms: 1,
        provider_wait_ms: 0,
        local_compute_ms: 0,
        unattributed_ms: 1,
      },
      memory: { peak_rss_bytes: 1, source: "macos-time-maxrss" },
      outcome: {
        status: "killed",
        rows_committed_final: 4,
        duplicate_rows_final: 0,
        kill: { signal: "SIGKILL", kill_point_rows_committed: 4, kill_point_batch: 1 },
        resume: {
          resumed_from_record_id: "synthetic-prior",
          resumed_from_rows_committed: 4,
          rows_attempted: 6,
          duplicate_rows_attempted: 0,
        },
      },
    });
    expect(validateBackfillBenchmarkRecord(killed).outcome.status).toBe("killed");
  });
});
