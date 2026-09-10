import { describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "../src/agent/chat-store.js";
import { makeSummaryMessage } from "@enduragent/engine";
import { createMemoryQueryTool, createMemoryTools } from "../src/sport.js";
import { boundToolResultProvenance, unwrapBoundToolResult } from "@enduragent/engine";
import { Memory } from "../src/memory/store.js";
import {
  MAX_PROVENANCE_METADATA_BYTES,
  ProvenanceMetadata,
} from "../src/memory/provenance-metadata.js";
import { contentDigest, getMessageProvenance, setMessageProvenance } from "../src/provenance.js";
import { WindowsPrivatePathPolicyError } from "../src/io/windows-private-path-policy.js";

const GARMIN = { garmin: true, nonGarmin: false, unknown: false };
const UNKNOWN = { garmin: false, nonGarmin: false, unknown: true };

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function memoryQueryResult(
  memory: Memory,
  input: { from: string; to: string; query?: string },
): Promise<string> {
  return (await createMemoryQueryTool(memory).execute!(input, {} as never)) as string;
}

describe("chat history provenance metadata", () => {
  it("round-trips assistant and summary metadata through overwrite", () => {
    const dir = tempDir("cc-chat-provenance-");
    try {
      const store = new ChatStore(dir);
      store.appendMessage("chat", "assistant", "Garmin answer.", {
        templateHash: "template",
        assembledHash: "assembled",
        provider: "test",
        model: "test",
        lineageVersion: "1",
        provenance: GARMIN,
      });
      const loaded = store.load("chat").messages;
      expect(getMessageProvenance(loaded[0])).toEqual(GARMIN);

      const summary = makeSummaryMessage("summary", GARMIN);
      store.overwriteHistory("chat", [summary, ...loaded]);
      const rewritten = store.load("chat").messages;
      expect(getMessageProvenance(rewritten[0])).toEqual(GARMIN);
      expect(getMessageProvenance(rewritten[1])).toEqual(GARMIN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    [GARMIN, UNKNOWN],
    [UNKNOWN, GARMIN],
  ])("preserves the retained duplicate message provenance", (first, retained) => {
    const dir = tempDir("cc-chat-duplicate-provenance-");
    try {
      const store = new ChatStore(dir);
      const lineage = {
        templateHash: "template",
        assembledHash: "assembled",
        provider: "test",
        model: "test",
        lineageVersion: "1",
      };
      store.appendMessage("chat", "assistant", "Same answer.", {
        ...lineage,
        provenance: first,
      });
      store.appendMessage("chat", "assistant", "Same answer.", {
        ...lineage,
        provenance: retained,
      });
      const messages = store.load("chat").messages;

      store.overwriteHistory("chat", [messages[1]]);

      expect(getMessageProvenance(store.load("chat").messages[0])).toEqual(retained);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats legacy records, user messages, and missing metadata as unknown", () => {
    const dir = tempDir("cc-chat-legacy-");
    try {
      const sessions = join(dir, "sessions");
      mkdirSync(sessions, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(sessions, "legacy.jsonl"),
        [
          JSON.stringify({
            role: "user",
            content: "Garmin claim",
            ts: "1998-05-09T00:00:00Z",
            provenance: GARMIN,
          }),
          JSON.stringify({
            role: "assistant",
            content: "Legacy answer",
            ts: "1998-05-09T00:00:01Z",
          }),
        ].join("\n") + "\n",
      );
      const messages = new ChatStore(dir).load("legacy").messages;
      expect(messages.map(getMessageProvenance)).toEqual([UNKNOWN, UNKNOWN]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a valid message with malformed optional provenance as unknown", () => {
    const dir = tempDir("cc-chat-malformed-provenance-");
    try {
      const sessions = join(dir, "sessions");
      mkdirSync(sessions, { recursive: true, mode: 0o700 });
      const line = JSON.stringify({
        role: "assistant",
        content: "Still usable",
        ts: "1998-05-09T00:00:01Z",
        provenance: { garmin: true },
      });
      writeFileSync(join(sessions, "chat.jsonl"), line + "\n");

      const store = new ChatStore(dir);
      const messages = store.load("chat").messages;

      expect(messages).toEqual([{ role: "assistant", content: "Still usable" }]);
      expect(getMessageProvenance(messages[0])).toEqual(UNKNOWN);
      expect(readFileSync(join(sessions, "chat.jsonl"), "utf8")).toBe(line + "\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not infer provenance by scanning summary text", () => {
    const message = setMessageProvenance(
      makeSummaryMessage("GARMIN_CONNECT and the exact footer are only text", UNKNOWN),
      UNKNOWN,
    );
    expect(getMessageProvenance(message)).toEqual(UNKNOWN);
  });
});

describe("memory, daily-note, plan, and ledger digest binding", () => {
  it("keeps an earlier section's provenance after appending another section", () => {
    const dir = tempDir("cc-memory-append-provenance-");
    try {
      const memory = new Memory(dir, "UTC");
      memory.writeSection("garmin", "Garmin fact", "chat-tool", GARMIN);
      memory.writeSection("polar", "Polar fact", "chat-tool", {
        garmin: false,
        nonGarmin: true,
        unknown: false,
      });

      expect(memory.getContextWithProvenance().provenance).toEqual({
        garmin: true,
        nonGarmin: true,
        unknown: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails malformed sidecar entries closed without losing valid siblings", () => {
    const dir = tempDir("cc-memory-malformed-metadata-");
    try {
      const memoryDir = join(dir, "memory");
      mkdirSync(memoryDir, { recursive: true });
      writeFileSync(
        join(memoryDir, ".source-provenance.jsonl"),
        [
          JSON.stringify({ version: 1, op: "put", key: "nullish", digest: null }),
          JSON.stringify({ version: 1, op: "put", key: "numeric", digest: 42 }),
          JSON.stringify({ version: 1, op: "put", key: "missing_digest", provenance: GARMIN }),
          JSON.stringify({
            version: 1,
            op: "put",
            key: "valid",
            digest: contentDigest("valid content"),
            provenance: GARMIN,
          }),
        ].join("\n") + "\n",
      );
      const metadata = new ProvenanceMetadata(memoryDir);

      for (const key of ["nullish", "numeric", "missing_digest"]) {
        expect(metadata.read(key, "anything")).toEqual(UNKNOWN);
        expect(metadata.matches(key, "anything")).toBe(false);
      }
      expect(metadata.read("valid", "valid content")).toEqual(GARMIN);
      expect(metadata.matches("valid", "valid content")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends provenance updates without rewriting prior journal bytes", () => {
    const dir = tempDir("cc-memory-provenance-journal-");
    try {
      const memoryDir = join(dir, "memory");
      mkdirSync(memoryDir, { recursive: true });
      const metadata = new ProvenanceMetadata(memoryDir);
      const path = join(memoryDir, ".source-provenance.jsonl");

      metadata.write("first", "one", GARMIN);
      const firstWrite = readFileSync(path, "utf8");
      metadata.write("second", "two", UNKNOWN);
      const secondWrite = readFileSync(path, "utf8");

      expect(secondWrite.startsWith(firstWrite)).toBe(true);
      expect(secondWrite.length).toBeGreaterThan(firstWrite.length);
      expect(metadata.read("first", "one")).toEqual(GARMIN);
      expect(metadata.read("second", "two")).toEqual(UNKNOWN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists provenance on win32 without attempting directory sync", () => {
    const dir = tempDir("cc-memory-provenance-win32-");
    try {
      const memoryDir = join(dir, "memory");
      mkdirSync(memoryDir, { recursive: true });
      let directorySyncs = 0;
      const metadata = new ProvenanceMetadata(memoryDir, {
        platform: "win32",
        syncDirectory: () => {
          directorySyncs += 1;
          throw new Error("directory sync is unavailable");
        },
      });

      metadata.write("first", "one", GARMIN);

      expect(directorySyncs).toBe(0);
      expect(metadata.read("first", "one")).toEqual(GARMIN);
      expect(readFileSync(join(memoryDir, ".source-provenance.jsonl"), "utf8")).toContain(
        '"key":"first"',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("threads injected win32 semantics through Memory writes", () => {
    const dir = tempDir("cc-memory-win32-");
    try {
      const memory = new Memory(dir, "UTC", { platform: "win32" });

      memory.writeSection("profile", "Private note", "chat-tool", GARMIN);

      expect(memory.provenanceForSection("profile")).toEqual(GARMIN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects corrupt win32 provenance with path-free stage diagnostics", () => {
    const dir = tempDir("cc-memory-provenance-corrupt-win32-");
    try {
      const memoryDir = join(dir, "memory");
      mkdirSync(memoryDir, { recursive: true });
      writeFileSync(join(memoryDir, ".source-provenance.jsonl"), "{invalid\n");
      const metadata = new ProvenanceMetadata(memoryDir, { platform: "win32" });
      const failure = (() => {
        try {
          metadata.read("first", "one");
        } catch (error) {
          return error;
        }
        return undefined;
      })();

      expect(failure).toBeInstanceOf(WindowsPrivatePathPolicyError);
      expect(failure).toMatchObject({ stage: "read-check", category: "corruption" });
      expect((failure as Error).message).not.toContain(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts structurally bound win32 provenance without POSIX mode checks", () => {
    const dir = tempDir("cc-memory-provenance-mode-win32-");
    try {
      const memoryDir = join(dir, "memory");
      mkdirSync(memoryDir, { recursive: true });
      const path = join(memoryDir, ".source-provenance.jsonl");
      const metadata = new ProvenanceMetadata(memoryDir, { platform: "win32" });
      metadata.write("first", "one", GARMIN);
      chmodSync(memoryDir, 0o755);
      chmodSync(path, 0o644);

      expect(new ProvenanceMetadata(memoryDir, { platform: "win32" }).read("first", "one")).toEqual(
        GARMIN,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects oversized win32 provenance before reading it", () => {
    const dir = tempDir("cc-memory-provenance-oversized-win32-");
    try {
      const memoryDir = join(dir, "memory");
      mkdirSync(memoryDir, { recursive: true });
      const path = join(memoryDir, ".source-provenance.jsonl");
      writeFileSync(path, "");
      truncateSync(path, MAX_PROVENANCE_METADATA_BYTES + 1);
      const metadata = new ProvenanceMetadata(memoryDir, { platform: "win32" });

      expect(() => metadata.read("first", "one")).toThrow(
        expect.objectContaining({ stage: "read-check", category: "corruption" }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not swallow win32 provenance file flush failures", () => {
    const dir = tempDir("cc-memory-provenance-flush-win32-");
    try {
      const memoryDir = join(dir, "memory");
      mkdirSync(memoryDir, { recursive: true });
      const metadata = new ProvenanceMetadata(memoryDir, {
        platform: "win32",
        syncFile: () => {
          throw Object.assign(new Error(`locked ${dir}`), { code: "EBUSY" });
        },
      });
      const failure = (() => {
        try {
          metadata.write("first", "one", GARMIN);
        } catch (error) {
          return error;
        }
        return undefined;
      })();

      expect(failure).toBeInstanceOf(WindowsPrivatePathPolicyError);
      expect(failure).toMatchObject({ stage: "file-flush", category: "sharing-violation" });
      expect((failure as Error).message).not.toContain(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("isolates new records from a truncated journal tail", () => {
    const dir = tempDir("cc-memory-truncated-provenance-");
    try {
      const memoryDir = join(dir, "memory");
      mkdirSync(memoryDir, { recursive: true });
      const path = join(memoryDir, ".source-provenance.jsonl");
      writeFileSync(path, '{"version":1,"op":"put","key":"truncated"');
      const metadata = new ProvenanceMetadata(memoryDir);

      expect(metadata.read("truncated", "anything")).toEqual(UNKNOWN);
      metadata.write("valid", "Garmin content", GARMIN);

      expect(readFileSync(path, "utf8")).toContain(
        `\n${JSON.stringify({
          version: 1,
          op: "put",
          key: "valid",
          digest: contentDigest("Garmin content"),
          provenance: GARMIN,
        })}\n`,
      );
      expect(new ProvenanceMetadata(memoryDir).read("valid", "Garmin content")).toEqual(GARMIN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("binds memory and plan provenance before a later write can replace the data", async () => {
    const dir = tempDir("cc-memory-bound-read-provenance-");
    try {
      const memory = new Memory(dir, "UTC");
      memory.writeSection("person", "Garmin profile", "chat-tool", GARMIN);
      memory.savePlan({ name: "Garmin plan" }, "chat-tool", GARMIN);
      const tools = createMemoryTools(
        memory,
        [{ name: "person", description: "Athlete profile", inject: false }],
        { bindProvenance: true },
      );

      const memoryRead = tools.memory_read.execute!({}, {} as never);
      const planRead = tools.plan_load.execute!({}, {} as never);
      memory.writeSection("person", "Replacement profile", "chat-tool", UNKNOWN);
      memory.savePlan({ name: "Replacement plan" }, "chat-tool", UNKNOWN);

      const [memoryResult, planResult] = await Promise.all([memoryRead, planRead]);
      expect(String(unwrapBoundToolResult(memoryResult))).toContain("Garmin profile");
      expect(unwrapBoundToolResult(planResult)).toEqual({ name: "Garmin plan" });
      expect(boundToolResultProvenance(memoryResult)).toEqual(GARMIN);
      expect(boundToolResultProvenance(planResult)).toEqual(GARMIN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not mistake a stored truncation marker for an actual query cutoff", async () => {
    const dir = tempDir("cc-memory-literal-truncation-marker-");
    try {
      const memory = new Memory(dir, "UTC");
      memory.appendDailyNote(
        "[truncated — narrow the date range or add a query term]",
        "1998-05-09",
        UNKNOWN,
      );
      memory.appendDailyNote("Garmin fact after the literal marker", "1998-05-09", GARMIN);
      const query = createMemoryQueryTool(memory, true);

      const result = await query.execute!({ from: "1998-05-09", to: "1998-05-09" }, {} as never);

      expect(String(unwrapBoundToolResult(result))).toContain("Garmin fact after");
      expect(boundToolResultProvenance(result)?.garmin).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns written provenance and degrades manual section edits to unknown", () => {
    const dir = tempDir("cc-memory-provenance-");
    try {
      const memory = new Memory(dir, "UTC");
      memory.runWithWriteProvenance(GARMIN, () =>
        memory.writeSection("person", "FTP 250 W", "chat-tool"),
      );
      expect(memory.getContextWithProvenance().provenance.garmin).toBe(true);

      const path = join(dir, "memory", "MEMORY.md");
      writeFileSync(path, readFileSync(path, "utf8").replace("250", "251"));
      expect(memory.getContextWithProvenance().provenance).toEqual(UNKNOWN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not label a stamp-only memory section as Garmin-derived", () => {
    const dir = tempDir("cc-memory-empty-provenance-");
    try {
      const memory = new Memory(dir, "UTC");
      memory.runWithWriteProvenance(GARMIN, () => memory.writeSection("person", "", "chat-tool"));

      expect(memory.readSection("person")).toMatch(/^_updated: /);
      expect(memory.provenanceForSection("person")).toEqual({
        garmin: false,
        nonGarmin: false,
        unknown: false,
      });
      expect(memory.getContextWithProvenance().provenance.garmin).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("moves and unions section provenance through chained renames", () => {
    const dir = tempDir("cc-memory-rename-provenance-");
    try {
      const memory = new Memory(dir, "UTC");
      memory.writeSection("legacy-profile", "Garmin fact", "chat-tool", GARMIN);
      memory.writeSection("profile", "Polar fact", "chat-tool", {
        garmin: false,
        nonGarmin: true,
        unknown: false,
      });

      expect(
        memory.renameSections([
          ["legacy-profile", "profile"],
          ["profile", "athlete-profile"],
        ]),
      ).toEqual(["merged", "renamed"]);
      expect(memory.getContextWithProvenance().provenance).toEqual({
        garmin: true,
        nonGarmin: true,
        unknown: false,
      });

      const metadata = readFileSync(join(dir, "memory", ".source-provenance.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { op: string; key: string });
      const activeKeys = new Set<string>();
      for (const record of metadata) {
        if (record.op === "delete") activeKeys.delete(record.key);
        else activeKeys.add(record.key);
      }
      expect(activeKeys.has("memory:legacy-profile")).toBe(false);
      expect(activeKeys.has("memory:profile")).toBe(false);
      expect(activeKeys.has("memory:athlete-profile")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not count a metadata-bearing section hidden by the context cap", () => {
    const dir = tempDir("cc-memory-context-cap-");
    try {
      const memory = new Memory(dir, "UTC");
      memory.writeSection("person", "x".repeat(200), "chat-tool", UNKNOWN);
      memory.writeSection("training", "Garmin-derived fact", "chat-tool", GARMIN);

      expect(memory.getContextWithProvenance({ maxChars: 80 }).provenance).toEqual(UNKNOWN);
      expect(memory.getContextWithProvenance({ maxChars: 1_000 }).provenance).toEqual({
        garmin: true,
        nonGarmin: false,
        unknown: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not count a Garmin daily-note line hidden by the context cap", () => {
    const dir = tempDir("cc-memory-daily-context-cap-");
    try {
      const memory = new Memory(dir, "UTC");
      memory.appendDailyNote("x".repeat(200), undefined, UNKNOWN);
      memory.appendDailyNote("Garmin note beyond the cap", undefined, GARMIN);

      expect(memory.getContextWithProvenance({ maxChars: 80 }).provenance).toEqual(UNKNOWN);
      expect(memory.getContextWithProvenance({ maxChars: 1_000 }).provenance).toEqual({
        garmin: true,
        nonGarmin: false,
        unknown: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("unions new provenance when an exact daily note is deduplicated", async () => {
    const dir = tempDir("cc-memory-daily-dedup-provenance-");
    try {
      const memory = new Memory(dir, "UTC");
      memory.appendDailyNote("Recovered well", "1998-05-09", UNKNOWN);
      memory.appendDailyNote("Recovered well", "1998-05-09", GARMIN);
      const input = { from: "1998-05-09", to: "1998-05-09" };
      const result = await memoryQueryResult(memory, input);

      expect(readFileSync(join(dir, "memory", "1998-05-09.md"), "utf8")).toBe("Recovered well");
      expect(memory.provenanceForToolRead("memory_query", input, result)).toEqual({
        garmin: true,
        nonGarmin: false,
        unknown: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not commit primary artifacts when provenance metadata cannot be written", () => {
    const scenarios = [
      {
        name: "section",
        path: (dir: string) => join(dir, "memory", "MEMORY.md"),
        write: (memory: Memory) => memory.writeSection("person", "FTP 250 W", "chat-tool", GARMIN),
      },
      {
        name: "daily note",
        path: (dir: string) => join(dir, "memory", "1998-05-09.md"),
        write: (memory: Memory) => memory.appendDailyNote("Recovered well", "1998-05-09", GARMIN),
      },
      {
        name: "ledger event",
        path: (dir: string) => join(dir, "memory", "events.jsonl"),
        write: (memory: Memory) =>
          memory.appendEvent(
            { date: "1998-05-09", kind: "decision", text: "Ride easy", source: "flush" },
            GARMIN,
          ),
      },
      {
        name: "plan",
        path: (dir: string) => join(dir, "plans", "current-plan.json"),
        write: (memory: Memory) => memory.savePlan({ name: "Base" }, "chat-tool", GARMIN),
      },
    ];

    for (const scenario of scenarios) {
      const dir = tempDir(`cc-memory-sidecar-failure-${scenario.name.replace(" ", "-")}-`);
      try {
        const memory = new Memory(dir, "UTC");
        mkdirSync(join(dir, "memory", ".source-provenance.jsonl"));

        expect(() => scenario.write(memory)).toThrow();
        expect(existsSync(scenario.path(dir))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("keeps ledger dates and athlete text out of provenance keys", () => {
    const dir = tempDir("cc-memory-ledger-private-metadata-");
    try {
      const memory = new Memory(dir, "UTC");
      memory.appendEvent(
        { date: "1998-05-09", kind: "illness", text: "Private symptom", source: "flush" },
        GARMIN,
      );

      const sidecar = readFileSync(join(dir, "memory", ".source-provenance.jsonl"), "utf8");
      expect(sidecar).not.toContain("1998-05-09");
      expect(sidecar).not.toContain("Private symptom");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["single", "batch"])(
    "leaves memory unchanged when a %s rename cannot persist provenance",
    (kind) => {
      const dir = tempDir(`cc-memory-rename-sidecar-failure-${kind}-`);
      try {
        const memory = new Memory(dir, "UTC");
        const path = join(dir, "memory", "MEMORY.md");
        const original = "## legacy-profile\nOriginal body\n";
        writeFileSync(path, original);
        mkdirSync(join(dir, "memory", ".source-provenance.jsonl"));

        expect(() =>
          kind === "single"
            ? memory.renameSection("legacy-profile", "profile")
            : memory.renameSections([["legacy-profile", "profile"]]),
        ).toThrow();
        expect(readFileSync(path, "utf8")).toBe(original);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("degrades daily-note, plan, and ledger mismatches independently", async () => {
    const dir = tempDir("cc-memory-artifacts-");
    try {
      const memory = new Memory(dir, "UTC");
      memory.appendDailyNote("Recovered well", "1998-05-09", GARMIN);
      memory.savePlan({ name: "Base" }, "chat-tool", GARMIN);
      memory.appendEvent(
        { date: "1998-05-09", kind: "decision", text: "Ride easy", source: "flush" },
        GARMIN,
      );
      const sidecar = readFileSync(join(dir, "memory", ".source-provenance.jsonl"), "utf8");
      expect(sidecar).not.toContain("Ride easy");
      const rideEasyInput = {
        from: "1998-05-09",
        to: "1998-05-09",
        query: "Ride easy",
      };
      expect(
        memory.provenanceForToolRead(
          "memory_query",
          rideEasyInput,
          await memoryQueryResult(memory, rideEasyInput),
        ).garmin,
      ).toBe(true);
      expect(memory.provenanceForToolRead("plan_load", {}).garmin).toBe(true);

      writeFileSync(join(dir, "memory", "1998-05-09.md"), "Manually changed");
      writeFileSync(join(dir, "plans", "current-plan.json"), JSON.stringify({ name: "Manual" }));
      const ledgerPath = join(dir, "memory", "events.jsonl");
      writeFileSync(ledgerPath, readFileSync(ledgerPath, "utf8").replace("Ride easy", "Ride hard"));

      const allInput = { from: "1998-05-09", to: "1998-05-09" };
      expect(
        memory.provenanceForToolRead(
          "memory_query",
          allInput,
          await memoryQueryResult(memory, allInput),
        ),
      ).toEqual(UNKNOWN);
      expect(memory.provenanceForToolRead("plan_load", {})).toEqual(UNKNOWN);
      const rideHardInput = {
        from: "1998-05-09",
        to: "1998-05-09",
        query: "Ride hard",
      };
      expect(
        memory.provenanceForToolRead(
          "memory_query",
          rideHardInput,
          await memoryQueryResult(memory, rideHardInput),
        ),
      ).toEqual(UNKNOWN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("unions only daily-note lines returned by a filtered query", async () => {
    const dir = tempDir("cc-memory-daily-filter-");
    try {
      const memory = new Memory(dir, "UTC");
      memory.appendDailyNote("Garmin recovery note", "1998-05-09", GARMIN);
      memory.appendDailyNote("Polar recovery note", "1998-05-09", {
        garmin: false,
        nonGarmin: true,
        unknown: false,
      });

      const polarInput = {
        from: "1998-05-09",
        to: "1998-05-09",
        query: "Polar",
      };
      expect(
        memory.provenanceForToolRead(
          "memory_query",
          polarInput,
          await memoryQueryResult(memory, polarInput),
        ),
      ).toEqual({ garmin: false, nonGarmin: true, unknown: false });
      const allInput = { from: "1998-05-09", to: "1998-05-09" };
      expect(
        memory.provenanceForToolRead(
          "memory_query",
          allInput,
          await memoryQueryResult(memory, allInput),
        ),
      ).toEqual({ garmin: true, nonGarmin: true, unknown: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not count a Garmin note hidden by memory-query truncation", async () => {
    const dir = tempDir("cc-memory-query-cap-");
    try {
      const memory = new Memory(dir, "UTC");
      memory.appendDailyNote("x".repeat(21_000), "1998-05-09", UNKNOWN);
      memory.appendDailyNote("Garmin note beyond the cap", "1998-05-10", GARMIN);
      const input = { from: "1998-05-09", to: "1998-05-10" };
      const result = await memoryQueryResult(memory, input);

      expect(result).toContain("[truncated");
      expect(
        memory.provenanceForToolRead("memory_query", input, result, { truncated: true }),
      ).toEqual(UNKNOWN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses raw offsets when sanitizable text precedes a truncated Garmin note", async () => {
    const dir = tempDir("cc-memory-query-raw-cutoff-");
    try {
      const memory = new Memory(dir, "UTC");
      memory.appendDailyNote("x".repeat(19_900) + "\u0000".repeat(2_000), "1998-05-09", UNKNOWN);
      memory.appendDailyNote("Garmin note beyond the raw cap", "1998-05-10", GARMIN);
      const query = createMemoryQueryTool(memory, true);

      const result = await query.execute!({ from: "1998-05-09", to: "1998-05-10" }, {} as never);

      expect(String(unwrapBoundToolResult(result))).not.toContain("Garmin note beyond the raw cap");
      expect(boundToolResultProvenance(result)).toEqual(UNKNOWN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
