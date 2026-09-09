import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  writeAuditEntry,
  computeResponseHash,
  __resetAuditFailureState,
} from "../src/reference/audit/writer.js";
import {
  AUDIT_SCHEMA_VERSION,
  AuditLogEntrySchema,
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
  tempDir = mkdtempSync(join(tmpdir(), "reference-audit-"));
  process.env.CYCLING_COACH_HOME = tempDir;
  __resetAuditFailureState();
});

afterEach(() => {
  delete process.env.CYCLING_COACH_HOME;
  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function auditPath(): string {
  return join(tempDir, "data", ".audit.jsonl");
}

function readLines(): string[] {
  return readFileSync(auditPath(), "utf-8")
    .split("\n")
    .filter((l) => l !== "");
}

describe("writeAuditEntry — append semantics", () => {
  it("appends exactly one valid JSONL line per call", async () => {
    await writeAuditEntry(BINARY, makeEntry());

    const lines = readLines();
    expect(lines).toHaveLength(1);
    const parsed = AuditLogEntrySchema.parse(JSON.parse(lines[0]));
    expect(parsed.chatId).toBe("12345");
  });

  it("creates the parent data directory if missing on first write", async () => {
    expect(existsSync(join(tempDir, "data"))).toBe(false);

    await writeAuditEntry(BINARY, makeEntry());

    expect(existsSync(join(tempDir, "data"))).toBe(true);
  });

  it("creates the audit file with owner-only 0o600 permissions", async () => {
    await writeAuditEntry(BINARY, makeEntry());

    expect(statSync(auditPath()).mode & 0o777).toBe(0o600);
  });

  it("writes compact lines with no embedded newline — N calls yield N lines", async () => {
    await writeAuditEntry(BINARY, makeEntry({ chatId: "a" }));
    await writeAuditEntry(BINARY, makeEntry({ chatId: "b" }));
    await writeAuditEntry(BINARY, makeEntry({ chatId: "c" }));

    expect(readLines()).toHaveLength(3);
  });

  it("does not interleave concurrent appends — 20 lines all parse cleanly", async () => {
    const writes = Array.from({ length: 20 }, (_, i) =>
      writeAuditEntry(
        BINARY,
        makeEntry({
          chatId: `chat-${i}`,
          responseHash: String(i).padStart(16, "0"),
        }),
      ),
    );
    await Promise.all(writes);

    const lines = readLines();
    expect(lines).toHaveLength(20);
    const hashes = new Set<string>();
    for (const line of lines) {
      const parsed = AuditLogEntrySchema.parse(JSON.parse(line));
      hashes.add(parsed.responseHash);
    }
    expect(hashes.size).toBe(20);
  });
});

describe("writeAuditEntry — best-effort failure handling", () => {
  // Force a real filesystem failure by planting a regular file where the
  // writer expects the `data` directory; `mkdir(..., {recursive:true})` then
  // throws EEXIST on every call — no ESM module spying needed.
  function plantFileAtDataDir(): void {
    writeFileSync(join(tempDir, "data"), "not a directory", "utf-8");
  }

  it("logs a warn but does NOT throw on a write failure", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    plantFileAtDataDir();

    await expect(writeAuditEntry(BINARY, makeEntry())).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(tempDir);
    expect(JSON.stringify(warnSpy.mock.calls)).toContain("EEXIST");
  });

  it("fires console.error EXACTLY ONCE after 10 cumulative failures", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    plantFileAtDataDir();

    for (let i = 0; i < 10; i++) {
      await writeAuditEntry(BINARY, makeEntry());
    }

    expect(warnSpy).toHaveBeenCalledTimes(10);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "Reference: audit log writer has failed 10 times this session — disk full or permission issue likely. Audit trail is being lost.",
    );

    // An 11th failure must NOT re-fire the escalation.
    await writeAuditEntry(BINARY, makeEntry());
    expect(warnSpy).toHaveBeenCalledTimes(11);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

describe("computeResponseHash", () => {
  it("is deterministic, 16 chars, and sensitive to the response text", () => {
    const h1 = computeResponseHash("Ride easy today.", metadata);
    const h2 = computeResponseHash("Ride easy today.", metadata);
    const h3 = computeResponseHash("Go hard today.", metadata);

    expect(h1).toBe(h2);
    expect(h1).toHaveLength(16);
    expect(h1).not.toBe(h3);
  });
});
