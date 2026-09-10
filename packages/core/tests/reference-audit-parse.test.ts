import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeAuditEntry, __resetAuditFailureState } from "../src/reference/audit/writer.js";
import { parseAuditLog } from "../src/reference/audit/parse.js";
import {
  AUDIT_SCHEMA_VERSION,
  type AuditLogEntry,
  type RecommendationMetadata,
} from "../src/reference/validation/recommendation-metadata.js";

const BINARY = "cycling-coach";

const metadata: RecommendationMetadata = {
  citations: [{ field: "current_status.acwr.value", value: 1.12, source: "latest.json" }],
  confidence: "high",
  frameworks: ["polarized"],
  phase_tag: "build",
};

function makeEntry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    schema_version: AUDIT_SCHEMA_VERSION,
    ts: new Date().toISOString(),
    chatId: "12345",
    responseHash: "abcdef0123456789",
    metadata,
    ...overrides,
  };
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "reference-audit-parse-"));
  process.env.CYCLING_COACH_HOME = tempDir;
  __resetAuditFailureState();
});

afterEach(() => {
  delete process.env.CYCLING_COACH_HOME;
  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function dataPath(): string {
  return join(tempDir, "data", ".audit.jsonl");
}

function writeRawLog(contents: string): void {
  mkdirSync(join(tempDir, "data"), { recursive: true });
  writeFileSync(dataPath(), contents, "utf-8");
}

async function collect(): Promise<AuditLogEntry[]> {
  const out: AuditLogEntry[] = [];
  for await (const entry of parseAuditLog(BINARY)) {
    out.push(entry);
  }
  return out;
}

describe("parseAuditLog", () => {
  it("round-trips entries written by writeAuditEntry, in order", async () => {
    const a = makeEntry({ chatId: "a", responseHash: "0000000000000001" });
    const b = makeEntry({ chatId: "b", responseHash: "0000000000000002" });
    const c = makeEntry({ chatId: "c", responseHash: "0000000000000003" });
    await writeAuditEntry(BINARY, a);
    await writeAuditEntry(BINARY, b);
    await writeAuditEntry(BINARY, c);

    const parsed = await collect();
    expect(parsed).toEqual([a, b, c]);
  });

  it("parses a v2 line natively", async () => {
    const v2 = {
      schema_version: "2",
      ts: new Date().toISOString(),
      chatId: "v2-native",
      responseHash: "0000000000000010",
      metadata,
      event_type: "tool_gate_block",
      verdicts: [{ lens: "citation", ok: false, detail: "missing source" }],
      prompt_template_hash: "abc123",
    };
    writeRawLog(JSON.stringify(v2) + "\n");

    const parsed = await collect();
    expect(parsed).toHaveLength(1);
    expect(parsed[0].chatId).toBe("v2-native");
    expect(parsed[0].event_type).toBe("tool_gate_block");
    expect(parsed[0].verdicts).toEqual([{ lens: "citation", ok: false, detail: "missing source" }]);
    expect(parsed[0].prompt_template_hash).toBe("abc123");
  });

  it("maps a v1 line forward to v2 with null verdicts and event_type reply", async () => {
    const v1 = {
      schema_version: "1",
      ts: new Date().toISOString(),
      chatId: "v1-line",
      responseHash: "0000000000000011",
      metadata,
    };
    writeRawLog(JSON.stringify(v1) + "\n");

    const parsed = await collect();
    expect(parsed).toHaveLength(1);
    expect(parsed[0].chatId).toBe("v1-line");
    expect(parsed[0].schema_version).toBe("2");
    expect(parsed[0].event_type).toBe("reply");
    expect(parsed[0].verdicts).toBeNull();
    expect(parsed[0].prompt_template_hash).toBeNull();
  });

  it("still skips a genuinely unknown schema_version with a warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const valid = makeEntry({ chatId: "current" });
    const future = makeEntry({ chatId: "future", schema_version: "3" });
    writeRawLog(JSON.stringify(valid) + "\n" + JSON.stringify(future) + "\n");

    const parsed = await collect();
    expect(parsed).toHaveLength(1);
    expect(parsed[0].chatId).toBe("current");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("schema_version 3");
  });

  it("skips a malformed JSON line with a warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const valid = makeEntry({ chatId: "ok" });
    writeRawLog(JSON.stringify(valid) + "\n" + "{not json\n");

    const parsed = await collect();
    expect(parsed).toHaveLength(1);
    expect(parsed[0].chatId).toBe("ok");
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("returns an empty iterable for an empty file (no warn)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeRawLog("");

    const parsed = await collect();
    expect(parsed).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns an empty iterable for a missing file with NO warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const parsed = await collect();
    expect(parsed).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("skips blank/whitespace lines silently (trailing newline yields no phantom)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await writeAuditEntry(BINARY, makeEntry({ chatId: "one" }));
    await writeAuditEntry(BINARY, makeEntry({ chatId: "two" }));

    const parsed = await collect();
    expect(parsed).toHaveLength(2);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
