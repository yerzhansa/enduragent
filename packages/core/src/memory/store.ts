import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { z } from "zod";
import type { MemoryStore, MemoryWriteSource } from "../memory.js";
import { eachDateKeyInRange, todayInTZ } from "@enduragent/engine/sport";
import { sanitizeUntrustedText } from "../agent/prompt-fence.js";
import { atomicWriteFileSync } from "../io/atomic-write-file-sync.js";
import { safeReadJson } from "../io/safe-read-json.js";
import { appendJournalEntry, JOURNAL_FILENAME } from "./journal.js";
import { COMPACTION_SUMMARY_END_MARKER, COMPACTION_SUMMARY_MARKER } from "./compaction-note.js";
import {
  appendLedgerEvent,
  ledgerEventSchema,
  LEDGER_FILENAME,
  type LedgerEventInput,
} from "./event-ledger.js";
import { ProvenanceMetadata } from "./provenance-metadata.js";
import {
  EMPTY_PROVENANCE,
  UNKNOWN_PROVENANCE,
  contentDigest,
  unionProvenance,
  type SourceProvenance,
} from "../provenance.js";

// ============================================================================
// MEMORY SYSTEM
// ============================================================================

const SECTION_SPLIT = /(?=^## )/m;
const markerOf = (section: string) => `## ${section}`;
const bodyOf = (block: string) => block.slice(block.indexOf("\n") + 1);
const canonicalSectionBody = (block: string) => bodyOf(block).trimEnd();

function injectableDailyLines(daily: string): Array<{ line: string; index: number }> {
  let inSummary = false;
  return daily.split("\n").flatMap((line, index) => {
    const trimmed = line.trimEnd();
    if (trimmed === COMPACTION_SUMMARY_MARKER) {
      inSummary = true;
      return [];
    }
    if (trimmed === COMPACTION_SUMMARY_END_MARKER) {
      inSummary = false;
      return [];
    }
    if (inSummary && /^#{1,3} /.test(line)) inSummary = false;
    return inSummary ? [] : [{ line, index }];
  });
}

function sectionBodies(parts: readonly string[]): Map<string, string> {
  const sections = new Map<string, string>();
  for (const block of parts) {
    if (!block.startsWith("## ")) continue;
    const nl = block.indexOf("\n");
    const name = block.slice(3, nl === -1 ? undefined : nl);
    if (!sections.has(name)) sections.set(name, canonicalSectionBody(block));
  }
  return sections;
}

// Drop the sections named in `excludeSections` (spec'd sections whose
// `inject === false`, e.g. `notes`) from the rendered memory. Orphans — section
// headers no spec declares — are never in the exclude set, so they inject
// (conservative: no silent visibility loss). Non-header preamble is preserved.
function dropExcludedSections(memory: string, excludeSections: readonly string[]): string {
  const excludeSet = new Set(excludeSections);
  return memory
    .split(SECTION_SPLIT)
    .filter((block) => {
      if (!block.startsWith("## ")) return true;
      const nl = block.indexOf("\n");
      const name = block.slice(3, nl === -1 ? undefined : nl);
      return !excludeSet.has(name);
    })
    .join("");
}

const UPDATED_STAMP_PREFIX = "_updated: ";

export const SECTION_SOFT_WARN_CHARS = 4000;

// PlanFileSchema is the tolerant read-side loadPlan schema. The write side uses
// PlanSaveInputSchema in agent/tools.ts (typed headline keys plus passthrough), so
// anything saved still loads while malformed headline fields are rejected at the
// tool boundary. Per-field guards in getContext handle hand-edited mistypes.
export const PlanFileSchema = z.record(z.string(), z.unknown());

// Embedded H2 lines would match SECTION_SPLIT and fragment the file into
// phantom sections; demote them one level so section CONTENT can no longer
// create section boundaries. (Section NAMES are a separate surface: markerOf
// interpolates the name unsanitized, but both tool paths constrain it via
// z.enum — out of scope here, which covers content-borne fragmentation only.)
function demoteEmbeddedH2(content: string): string {
  return content.replace(/^## /gm, "### ");
}

/**
 * Stamp a section body's first line with its write date. Idempotent: an
 * existing leading stamp (e.g. echoed back by the LLM from memory_read)
 * is replaced, never stacked — a body carries at most one leading stamp.
 */
function stampUpdated(content: string, date: string): string {
  let body = content;
  if (body.startsWith(UPDATED_STAMP_PREFIX)) {
    const nl = body.indexOf("\n");
    body = nl === -1 ? "" : body.slice(nl + 1);
  }
  return body === "" ? `${UPDATED_STAMP_PREFIX}${date}` : `${UPDATED_STAMP_PREFIX}${date}\n${body}`;
}

function hasLogicalSectionContent(stamped: string): boolean {
  const nl = stamped.indexOf("\n");
  return nl !== -1 && stamped.slice(nl + 1).trim() !== "";
}

type RenameOutcome = "renamed" | "noop" | "merged";

export interface MemoryOptions {
  readonly platform?: NodeJS.Platform;
  readonly persistPlan?: (plan: unknown) => Promise<void>;
  readonly planWriteGate?: () => Promise<string | null>;
  readonly planReadGate?: () => Promise<string | null>;
}

/**
 * Apply a single section rename to `parts` IN PLACE. Shared between
 * `renameSection` (one rename + write) and `renameSections` (chain of
 * renames + single write); the in-place contract lets `renameSections`
 * chain without copying the array between iterations.
 */
function applyRename(parts: string[], from: string, to: string): RenameOutcome {
  const fromMarker = markerOf(from);
  const toMarker = markerOf(to);
  const fromIdx = parts.findIndex((p) => p.startsWith(fromMarker + "\n"));
  if (fromIdx < 0) return "noop";

  const toIdx = parts.findIndex((p) => p.startsWith(toMarker + "\n"));

  if (toIdx >= 0) {
    parts[toIdx] = `${toMarker}\n${bodyOf(parts[toIdx])}\n${bodyOf(parts[fromIdx])}`;
    parts.splice(fromIdx, 1);
    return "merged";
  }

  parts[fromIdx] = `${toMarker}\n${bodyOf(parts[fromIdx])}`;
  return "renamed";
}

export class Memory implements MemoryStore {
  private memoryDir: string;
  private plansDir: string;
  private tz: string;
  private provenance: ProvenanceMetadata;
  private readonly platform: NodeJS.Platform;
  private readonly persistPlan: ((plan: unknown) => Promise<void>) | undefined;
  private readonly planWriteGate: (() => Promise<string | null>) | undefined;
  readonly refreshPlanReadGate?: () => Promise<string | null>;
  private planReadMessage: string | null = null;
  private readonly writeProvenance = new AsyncLocalStorage<SourceProvenance>();

  constructor(dataDir: string, tz: string = "UTC", options: MemoryOptions = {}) {
    this.memoryDir = join(dataDir, "memory");
    this.plansDir = join(dataDir, "plans");
    this.tz = tz;
    this.platform = options.platform ?? process.platform;
    this.persistPlan = options.persistPlan;
    this.planWriteGate = options.planWriteGate;
    const planReadGate = options.planReadGate;
    if (planReadGate) {
      this.refreshPlanReadGate = async () => {
        const message = await planReadGate();
        this.planReadMessage ??= message;
        return this.planReadMessage;
      };
    }
    mkdirSync(this.memoryDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.plansDir, { recursive: true, mode: 0o700 });
    this.provenance = new ProvenanceMetadata(this.memoryDir, { platform: this.platform });
  }

  runWithWriteProvenance<T>(provenance: SourceProvenance, fn: () => T): T {
    return this.writeProvenance.run(provenance, fn);
  }

  private resolvedWriteProvenance(provenance?: SourceProvenance): SourceProvenance {
    return provenance ?? this.writeProvenance.getStore() ?? UNKNOWN_PROVENANCE;
  }

  private applySectionRenames(
    parts: string[],
    renames: ReadonlyArray<readonly [string, string]>,
  ): {
    outcomes: RenameOutcome[];
    metadataEntries: Array<{
      key: string;
      content: string;
      provenance: SourceProvenance;
    }>;
    metadataDeletes: string[];
  } {
    const initialBodies = sectionBodies(parts);
    const provenanceBySection = new Map<string, SourceProvenance>();
    for (const [name, body] of initialBodies) {
      provenanceBySection.set(name, this.provenance.read(`memory:${name}`, body));
    }

    const outcomes: RenameOutcome[] = [];
    const changedSections = new Set<string>();
    for (const [from, to] of renames) {
      const fromProvenance = provenanceBySection.get(from) ?? UNKNOWN_PROVENANCE;
      const toProvenance = provenanceBySection.get(to);
      const outcome = applyRename(parts, from, to);
      outcomes.push(outcome);
      if (outcome === "noop") continue;

      changedSections.add(from);
      changedSections.add(to);
      provenanceBySection.delete(from);
      provenanceBySection.set(
        to,
        outcome === "merged"
          ? unionProvenance(toProvenance ?? UNKNOWN_PROVENANCE, fromProvenance)
          : fromProvenance,
      );
    }

    const finalBodies = sectionBodies(parts);
    const metadataEntries = [...changedSections]
      .filter((name) => finalBodies.has(name))
      .map((name) => ({
        key: `memory:${name}`,
        content: finalBodies.get(name)!,
        provenance: provenanceBySection.get(name) ?? UNKNOWN_PROVENANCE,
      }));
    return {
      outcomes,
      metadataEntries,
      metadataDeletes: [...changedSections].map((name) => `memory:${name}`),
    };
  }

  // ── Long-term memory ──────────────────────────────────────────────────

  readMemory(): string {
    const path = join(this.memoryDir, "MEMORY.md");
    if (!existsSync(path)) return "";
    // Normalize CRLF → LF so section parsing works for files authored on
    // Windows or pasted from sources like Word/Notion. The marker check
    // `parts[idx].startsWith(marker + "\n")` would otherwise miss CRLF
    // headers and silently no-op every rename / read.
    return readFileSync(path, "utf-8").replace(/\r\n/g, "\n");
  }

  writeSection(
    section: string,
    content: string,
    source: MemoryWriteSource = "unattributed",
    provenance?: SourceProvenance,
  ): void {
    const path = join(this.memoryDir, "MEMORY.md");
    const existing = this.readMemory();
    const marker = markerOf(section);
    const stamped = stampUpdated(demoteEmbeddedH2(content), todayInTZ(this.tz));
    const newBlock = `${marker}\n${stamped}\n`;

    if (stamped.length > SECTION_SOFT_WARN_CHARS) {
      console.warn(
        `memory: section "${section}" is ${stamped.length} chars (soft cap ${SECTION_SOFT_WARN_CHARS}) — consider splitting or pruning`,
      );
    }

    this.provenance.write(
      `memory:${section}`,
      stamped.trimEnd(),
      hasLogicalSectionContent(stamped)
        ? this.resolvedWriteProvenance(provenance)
        : EMPTY_PROVENANCE,
    );

    appendJournalEntry(this.memoryDir, {
      ts: new Date().toISOString(),
      op: "write-section",
      section,
      oldBody: this.readSection(section),
      newBody: stamped,
      source,
    });

    if (!existing) {
      atomicWriteFileSync(path, newBlock, { platform: this.platform });
      return;
    }

    const parts = existing.split(SECTION_SPLIT);
    const idx = parts.findIndex((p) => p.startsWith(marker + "\n"));

    if (idx >= 0) {
      parts[idx] = newBlock;
      atomicWriteFileSync(path, parts.join(""), { platform: this.platform });
    } else {
      // Append at end (preserves legacy content not covered by any known section)
      atomicWriteFileSync(path, existing.trimEnd() + "\n\n" + newBlock, {
        platform: this.platform,
      });
    }
  }

  readSection(section: string): string | null {
    const content = this.readMemory();
    if (!content) return null;
    const marker = markerOf(section);
    const parts = content.split(SECTION_SPLIT);
    const block = parts.find((p) => p.startsWith(marker + "\n"));
    if (!block) return null;
    const body = bodyOf(block);
    return body.endsWith("\n") ? body.slice(0, -1) : body;
  }

  provenanceForSection(
    section: string,
    content = this.readSection(section) ?? "",
  ): SourceProvenance {
    if (content === "") return EMPTY_PROVENANCE;
    return this.provenance.read(`memory:${section}`, content.trimEnd());
  }

  renameSection(
    from: string,
    to: string,
    source: MemoryWriteSource = "unattributed",
  ): RenameOutcome {
    const path = join(this.memoryDir, "MEMORY.md");
    const content = this.readMemory();
    if (!content) return "noop";

    const parts = content.split(SECTION_SPLIT);
    const { outcomes, metadataEntries, metadataDeletes } = this.applySectionRenames(parts, [
      [from, to],
    ]);
    const outcome = outcomes[0];
    if (outcome === "noop") return outcome;

    const updated = parts.join("");
    this.provenance.replaceMany(metadataEntries, metadataDeletes);
    appendJournalEntry(this.memoryDir, {
      ts: new Date().toISOString(),
      op: "rename-sections",
      section: null,
      oldBody: content,
      newBody: updated,
      source,
    });
    atomicWriteFileSync(path, updated, { platform: this.platform });
    return outcome;
  }

  /**
   * Apply multiple section renames as a single read + single atomic write.
   * Used by the cycling-coach legacy migration so a partial migration cannot
   * be observed by Reference initialization. Returns the per-rename outcomes
   * in the same order as `renames`.
   */
  renameSections(
    renames: ReadonlyArray<readonly [string, string]>,
    source: MemoryWriteSource = "unattributed",
  ): RenameOutcome[] {
    const path = join(this.memoryDir, "MEMORY.md");
    const content = this.readMemory();
    if (!content) return renames.map(() => "noop" as const);

    const parts = content.split(SECTION_SPLIT);
    const { outcomes, metadataEntries, metadataDeletes } = this.applySectionRenames(parts, renames);
    const mutated = outcomes.some((outcome) => outcome !== "noop");

    if (mutated) {
      const updated = parts.join("");
      this.provenance.replaceMany(metadataEntries, metadataDeletes);
      appendJournalEntry(this.memoryDir, {
        ts: new Date().toISOString(),
        op: "rename-sections",
        section: null,
        oldBody: content,
        newBody: updated,
        source,
      });
      atomicWriteFileSync(path, updated, { platform: this.platform });
    }
    return outcomes;
  }

  // ── Daily notes ────────────────────────────────────────────────────────

  readDailyNotes(date?: string): string {
    const d = date ?? todayInTZ(this.tz);
    const path = join(this.memoryDir, `${d}.md`);
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf-8");
  }

  appendDailyNote(note: string, date?: string, provenance?: SourceProvenance): void {
    const d = date ?? todayInTZ(this.tz);
    const path = join(this.memoryDir, `${d}.md`);
    const existing = this.readDailyNotes(d);
    if (existing && `\n${existing}\n`.includes(`\n${note}\n`)) {
      const writtenProvenance = this.resolvedWriteProvenance(provenance);
      const existingLines = existing.split("\n");
      const noteLines = note.split("\n");
      const matchingLineIndexes = new Set<number>();
      for (let start = 0; start + noteLines.length <= existingLines.length; start++) {
        if (noteLines.every((line, offset) => existingLines[start + offset] === line)) {
          for (let offset = 0; offset < noteLines.length; offset++) {
            matchingLineIndexes.add(start + offset);
          }
        }
      }
      this.provenance.writeMany([
        {
          key: `daily:${d}`,
          content: existing,
          provenance: unionProvenance(
            this.provenance.read(`daily:${d}`, existing),
            writtenProvenance,
          ),
        },
        ...[...matchingLineIndexes].map((index) => ({
          key: `daily-line:${d}:${index}`,
          content: existingLines[index],
          provenance: unionProvenance(
            this.provenance.read(`daily-line:${d}:${index}`, existingLines[index]),
            writtenProvenance,
          ),
        })),
      ]);
      console.warn(
        JSON.stringify({ event: "daily_note_duplicate_skipped", date: d, noteChars: note.length }),
      );
      return;
    }
    const updated = existing ? `${existing}\n${note}` : note;
    const writtenProvenance = this.resolvedWriteProvenance(provenance);
    const prior = existing ? this.provenance.read(`daily:${d}`, existing) : EMPTY_PROVENANCE;
    const metadataWrites: Array<{
      key: string;
      content: string;
      provenance: SourceProvenance;
    }> = [
      {
        key: `daily:${d}`,
        content: updated,
        provenance: unionProvenance(prior, writtenProvenance),
      },
    ];
    const firstNewLine = existing ? existing.split("\n").length : 0;
    for (const [offset, line] of note.split("\n").entries()) {
      metadataWrites.push({
        key: `daily-line:${d}:${firstNewLine + offset}`,
        content: line,
        provenance: writtenProvenance,
      });
    }
    this.provenance.writeMany(metadataWrites);
    atomicWriteFileSync(path, updated, { platform: this.platform });
  }

  readDailyNotesInRange(from: string, to: string): Array<{ date: string; text: string }> {
    const out: Array<{ date: string; text: string }> = [];
    for (const date of eachDateKeyInRange(from, to)) {
      const text = this.readDailyNotes(date);
      if (text) out.push({ date, text });
    }
    return out;
  }

  readEventsRaw(): string {
    const path = join(this.memoryDir, LEDGER_FILENAME);
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf-8");
  }

  readJournalRaw(): string {
    const path = join(this.memoryDir, JOURNAL_FILENAME);
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf-8");
  }

  appendEvent(event: LedgerEventInput, provenance?: SourceProvenance): boolean {
    ledgerEventSchema.omit({ ts: true }).parse(event);
    const digest = (entry: LedgerEventInput) =>
      contentDigest(
        JSON.stringify([
          entry.date,
          entry.kind,
          entry.text.trim().replace(/\s+/g, " ").toLowerCase(),
        ]),
      );
    const eventDigest = digest(event);
    for (const line of this.readEventsRaw().split("\n")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const existing = ledgerEventSchema.safeParse(parsed);
      if (existing.success && digest(existing.data) === eventDigest) return false;
    }
    appendLedgerEvent(this.memoryDir, event, (line) => {
      this.provenance.write(
        `ledger:${contentDigest(line)}`,
        line,
        this.resolvedWriteProvenance(provenance),
      );
    });
    return true;
  }

  // ── Plans ──────────────────────────────────────────────────────────────

  savePlan(
    plan: unknown,
    source: MemoryWriteSource = "unattributed",
    provenance?: SourceProvenance,
  ): void | Promise<void> {
    const write = () => {
      const path = join(this.plansDir, "current-plan.json");
      const newBody = JSON.stringify(plan, null, 2);
      this.provenance.write("plan", newBody, this.resolvedWriteProvenance(provenance));
      appendJournalEntry(this.memoryDir, {
        ts: new Date().toISOString(),
        op: "save-plan",
        section: null,
        oldBody: existsSync(path) ? readFileSync(path, "utf-8") : null,
        newBody,
        source,
      });
      atomicWriteFileSync(path, newBody, { platform: this.platform });
      return this.persistPlan?.(plan);
    };
    if (!this.planWriteGate) return write();
    return this.planWriteGate().then((message) => {
      if (message !== null) throw new Error(message);
      return write();
    });
  }

  loadPlan(): unknown | null {
    if (this.planReadMessage !== null) return null;
    return safeReadJson<Record<string, unknown>>(
      join(this.plansDir, "current-plan.json"),
      PlanFileSchema,
    );
  }

  // ── Full context for system prompt ─────────────────────────────────────

  reload(): void {
    // No-op — Memory reads from disk on every access.
    // Explicit sync point for post-compaction and future caching.
  }

  getContext(opts?: { excludeSections?: readonly string[] }): string {
    const parts: string[] = [];

    const memory = this.readMemory();
    if (memory) {
      const injectable = opts?.excludeSections?.length
        ? dropExcludedSections(memory, opts.excludeSections)
        : memory;
      if (injectable) parts.push("## Athlete Memory\n" + injectable);
    }

    const daily = injectableDailyLines(this.readDailyNotes())
      .map(({ line }) => line)
      .join("\n");
    if (daily.trim()) {
      parts.push("## Today's Notes\n" + daily);
    }

    const plan = this.loadPlan();
    if (plan !== null && typeof plan === "object") {
      const p = plan as Record<string, unknown>;
      const lines: string[] = [];
      if (typeof p.name === "string") lines.push(`- Name: ${p.name}`);
      if (typeof p.primaryGoal === "string") lines.push(`- Goal: ${p.primaryGoal}`);
      if (typeof p.totalWeeks === "number" && Number.isFinite(p.totalWeeks)) {
        lines.push(`- Duration: ${p.totalWeeks} weeks`);
      }
      if (typeof p.status === "string") lines.push(`- Status: ${p.status}`);
      if (lines.length > 0) parts.push("## Current Plan\n" + lines.join("\n"));
    }

    return parts.join("\n\n");
  }

  getContextWithProvenance(opts?: { excludeSections?: readonly string[]; maxChars?: number }): {
    text: string;
    provenance: SourceProvenance;
  } {
    const text = this.getContext(opts);
    if (!text) return { text, provenance: EMPTY_PROVENANCE };
    let provenance = EMPTY_PROVENANCE;
    const isVisibleAt = (rawIndex: number): boolean =>
      rawIndex >= 0 &&
      (opts?.maxChars === undefined ||
        sanitizeUntrustedText(text.slice(0, rawIndex)).length < opts.maxChars);
    const excluded = new Set(opts?.excludeSections ?? []);
    const memory = this.readMemory();
    if (memory) {
      for (const block of memory.split(SECTION_SPLIT)) {
        if (!block.startsWith("## ")) {
          if (block.trim() !== "" && isVisibleAt(text.indexOf(block))) {
            provenance = unionProvenance(provenance, UNKNOWN_PROVENANCE);
          }
          continue;
        }
        const nl = block.indexOf("\n");
        const section = block.slice(3, nl === -1 ? undefined : nl);
        if (excluded.has(section)) continue;
        const canonicalBody = canonicalSectionBody(block);
        const blockIndex = text.indexOf(block);
        const bodyIndex = blockIndex < 0 ? -1 : blockIndex + block.indexOf("\n") + 1;
        if (isVisibleAt(bodyIndex)) {
          provenance = unionProvenance(
            provenance,
            this.provenance.read(`memory:${section}`, canonicalBody),
          );
        }
      }
    }
    const daily = this.readDailyNotes();
    if (daily) {
      const dailyLines = injectableDailyLines(daily);
      const injectable = dailyLines.map(({ line }) => line).join("\n");
      const marker = `## Today's Notes\n`;
      const dailyIndex = injectable.trim() ? text.indexOf(marker + injectable) : -1;
      const dailyBodyIndex = dailyIndex < 0 ? -1 : dailyIndex + marker.length;
      if (isVisibleAt(dailyBodyIndex)) {
        const date = todayInTZ(this.tz);
        if (!this.provenance.matches(`daily:${date}`, daily)) {
          provenance = unionProvenance(provenance, UNKNOWN_PROVENANCE);
        } else {
          let rawOffset = 0;
          for (const { index, line } of dailyLines) {
            if (!isVisibleAt(dailyBodyIndex + rawOffset)) break;
            if (line.length > 0) {
              provenance = unionProvenance(
                provenance,
                this.provenance.read(`daily-line:${date}:${index}`, line),
              );
            }
            rawOffset += line.length + 1;
          }
        }
      }
    }
    const planPath = join(this.plansDir, "current-plan.json");
    const plan = this.loadPlan();
    if (plan !== null && typeof plan === "object" && existsSync(planPath)) {
      const p = plan as Record<string, unknown>;
      const visible =
        typeof p.name === "string" ||
        typeof p.primaryGoal === "string" ||
        (typeof p.totalWeeks === "number" && Number.isFinite(p.totalWeeks)) ||
        typeof p.status === "string";
      if (visible) {
        const marker = "## Current Plan\n";
        const planIndex = text.indexOf(marker);
        if (isVisibleAt(planIndex < 0 ? -1 : planIndex + marker.length)) {
          provenance = unionProvenance(
            provenance,
            this.provenance.read("plan", readFileSync(planPath, "utf8")),
          );
        }
      }
    }
    return { text, provenance };
  }

  provenanceForToolRead(
    name: string,
    input: unknown,
    visibleResult?: unknown,
    opts?: { truncated?: boolean },
  ): SourceProvenance {
    if (name === "memory_read") return this.getContextWithProvenance().provenance;
    if (name === "plan_load") {
      if (this.planReadMessage !== null) return EMPTY_PROVENANCE;
      const path = join(this.plansDir, "current-plan.json");
      return existsSync(path)
        ? this.provenance.read("plan", readFileSync(path, "utf8"))
        : EMPTY_PROVENANCE;
    }
    if (name !== "memory_query" || input === null || typeof input !== "object") {
      return EMPTY_PROVENANCE;
    }
    const record = input as { from?: unknown; to?: unknown; query?: unknown };
    if (typeof record.from !== "string" || typeof record.to !== "string") {
      return EMPTY_PROVENANCE;
    }
    if (typeof visibleResult !== "string" || visibleResult.startsWith("Error:")) {
      return EMPTY_PROVENANCE;
    }
    const queryText = typeof record.query === "string" ? record.query : undefined;
    const query = queryText?.toLowerCase();
    const truncationMarker = "\n[truncated — narrow the date range or add a query term]";
    const truncated = opts?.truncated === true && visibleResult.endsWith(truncationMarker);
    const visibleDataChars = truncated
      ? visibleResult.length - truncationMarker.length
      : visibleResult.length;
    const byDate = new Map<string, Array<{ text: string; provenance: SourceProvenance }>>();
    for (const { date, text } of this.readDailyNotesInRange(record.from, record.to)) {
      const fileMatches = this.provenance.matches(`daily:${date}`, text);
      for (const [index, line] of text.split("\n").entries()) {
        if (query !== undefined && !line.toLowerCase().includes(query)) continue;
        const bucket = byDate.get(date) ?? [];
        bucket.push({
          text: line,
          provenance: fileMatches
            ? this.provenance.read(`daily-line:${date}:${index}`, line)
            : UNKNOWN_PROVENANCE,
        });
        byDate.set(date, bucket);
      }
    }
    for (const line of this.readEventsRaw().split("\n")) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as { date?: unknown };
        if (
          typeof parsed.date === "string" &&
          parsed.date >= record.from &&
          parsed.date <= record.to &&
          (query === undefined || line.toLowerCase().includes(query))
        ) {
          const bucket = byDate.get(parsed.date) ?? [];
          bucket.push({
            text: `event: ${line}`,
            provenance: this.provenance.read(`ledger:${contentDigest(line)}`, line),
          });
          byDate.set(parsed.date, bucket);
        }
      } catch {
        continue;
      }
    }

    const header =
      `Memory query ${record.from}..${record.to}` + (queryText ? ` matching "${queryText}"` : "");
    let rendered = header;
    let all = EMPTY_PROVENANCE;
    for (const date of [...byDate.keys()].sort().reverse()) {
      rendered += `\n\n## ${date}\n`;
      const items = byDate.get(date)!;
      for (const [index, item] of items.entries()) {
        if (index > 0) rendered += "\n";
        const visibleStart = rendered.length;
        rendered += item.text;
        if (visibleStart < visibleDataChars) {
          all = unionProvenance(all, item.provenance);
        }
      }
    }
    return all;
  }
}
