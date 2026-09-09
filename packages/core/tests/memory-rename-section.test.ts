import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Memory } from "../src/memory/store.js";

describe("Memory — data directory permissions", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "cc-memory-perms-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("creates memory/ and plans/ with owner-only 0o700", () => {
    new Memory(dataDir);

    expect(statSync(join(dataDir, "memory")).mode & 0o777).toBe(0o700);
    expect(statSync(join(dataDir, "plans")).mode & 0o777).toBe(0o700);
  });

  it("writes MEMORY.md with owner-only 0o600", () => {
    const memory = new Memory(dataDir);
    memory.writeSection("health", "Resting HR 44, HRV 92ms");

    expect(statSync(join(dataDir, "memory", "MEMORY.md")).mode & 0o777).toBe(0o600);
  });
});

describe("Memory.renameSection", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "cc-rename-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns "noop" and creates no file when MEMORY.md is absent', () => {
    const memory = new Memory(dataDir);
    expect(memory.renameSection("profile", "cycling-profile")).toBe("noop");
    expect(existsSync(join(dataDir, "memory", "MEMORY.md"))).toBe(false);
  });

  it('returns "noop" and leaves file unchanged when section is absent', () => {
    const memory = new Memory(dataDir);
    const path = join(dataDir, "memory", "MEMORY.md");
    const original = "## schedule\nMon, Wed, Fri\n## goals\nSub-3:30 century\n";
    writeFileSync(path, original, "utf-8");

    expect(memory.renameSection("profile", "cycling-profile")).toBe("noop");
    expect(readFileSync(path, "utf-8")).toBe(original);
  });

  it("renames a section in the middle of the file, preserving header order and neighbors", () => {
    const memory = new Memory(dataDir);
    const path = join(dataDir, "memory", "MEMORY.md");
    writeFileSync(
      path,
      "## schedule\nMon, Wed, Fri\n## profile\nFTP 247W, 72kg\n## goals\nSub-3:30 century\n",
      "utf-8",
    );

    expect(memory.renameSection("profile", "cycling-profile")).toBe("renamed");
    expect(readFileSync(path, "utf-8")).toBe(
      "## schedule\nMon, Wed, Fri\n## cycling-profile\nFTP 247W, 72kg\n## goals\nSub-3:30 century\n",
    );
  });

  it("renames the last section, matching writeSection trailing-newline style", () => {
    const memory = new Memory(dataDir);
    const path = join(dataDir, "memory", "MEMORY.md");
    // writeSection writes "## section\ncontent\n" — trailing \n on each block.
    // After rename, the same shape should hold for the (now last) renamed section.
    memory.writeSection("schedule", "Mon, Wed, Fri");
    memory.writeSection("health", "Knee twinge resolved");
    const beforeRename = readFileSync(path, "utf-8");
    expect(beforeRename).toMatch(/## health\n_updated: \d{4}-\d{2}-\d{2}\nKnee twinge resolved\n$/);

    expect(memory.renameSection("health", "cycling-history")).toBe("renamed");
    const after = readFileSync(path, "utf-8");
    expect(after).toMatch(
      /## cycling-history\n_updated: \d{4}-\d{2}-\d{2}\nKnee twinge resolved\n$/,
    );
    // schedule (the prior section) should be untouched
    expect(after).toMatch(/## schedule\n_updated: \d{4}-\d{2}-\d{2}\nMon, Wed, Fri\n/);
  });

  it("merges bodies under `to` when both sections exist; `from` block removed", () => {
    const memory = new Memory(dataDir);
    const path = join(dataDir, "memory", "MEMORY.md");
    writeFileSync(
      path,
      "## cycling-history\nKnee twinge resolved\n## schedule\nMon, Wed, Fri\n## health\nHypertension; lisinopril 10mg\n",
      "utf-8",
    );

    expect(memory.renameSection("health", "cycling-history")).toBe("merged");
    const after = readFileSync(path, "utf-8");
    // health block must be gone
    expect(after.includes("## health")).toBe(false);
    // cycling-history must contain both bodies, separated by one blank line
    expect(after).toBe(
      "## cycling-history\nKnee twinge resolved\n\nHypertension; lisinopril 10mg\n## schedule\nMon, Wed, Fri\n",
    );
  });

  it('is idempotent: A→B then A→B yields "renamed" then "noop", file stable after second call', () => {
    const memory = new Memory(dataDir);
    const path = join(dataDir, "memory", "MEMORY.md");
    writeFileSync(path, "## profile\nFTP 247W, 72kg\n## schedule\nMon, Wed, Fri\n", "utf-8");

    expect(memory.renameSection("profile", "cycling-profile")).toBe("renamed");
    const afterFirst = readFileSync(path, "utf-8");
    expect(memory.renameSection("profile", "cycling-profile")).toBe("noop");
    const afterSecond = readFileSync(path, "utf-8");
    expect(afterSecond).toBe(afterFirst);
  });

  it("renames a section with empty body correctly", () => {
    const memory = new Memory(dataDir);
    const path = join(dataDir, "memory", "MEMORY.md");
    // Empty body: header line, then immediately the next section's header.
    writeFileSync(path, "## profile\n## schedule\nMon, Wed, Fri\n", "utf-8");

    expect(memory.renameSection("profile", "cycling-profile")).toBe("renamed");
    expect(readFileSync(path, "utf-8")).toBe("## cycling-profile\n## schedule\nMon, Wed, Fri\n");
  });

  it("renames a CRLF-encoded MEMORY.md (Windows-authored or pasted from Word)", () => {
    const memory = new Memory(dataDir);
    const path = join(dataDir, "memory", "MEMORY.md");
    // Real-world failure mode: file written with CRLF line endings. Without
    // normalization the marker check fails (sees `## profile\r\n` which does
    // not startsWith `## profile\n`) and the rename silently no-ops.
    writeFileSync(
      path,
      "## profile\r\nFTP 247W, 72kg\r\n## schedule\r\nMon, Wed, Fri\r\n",
      "utf-8",
    );

    expect(memory.renameSection("profile", "cycling-profile")).toBe("renamed");
    // Output is LF-normalized (Node writeFileSync emits LF).
    expect(readFileSync(path, "utf-8")).toBe(
      "## cycling-profile\nFTP 247W, 72kg\n## schedule\nMon, Wed, Fri\n",
    );
  });
});
