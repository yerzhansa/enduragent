import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { ArchiveManager } from "@enduragent/kernel/archive";
import type { HttpPort, HttpResponse } from "@enduragent/kernel/ports";
import { createIntervalsIcuSource, extractBulkFitZip, IncompleteBulkFitBatchError,
  MAX_FIT_BYTES, MAX_UNCOMPRESSED_BATCH_BYTES, MAX_ZIP_BYTES } from "../src/index.js";

const json = (value: unknown): HttpResponse => ({ status: 200, headers: { "content-type": "application/json" },
  body: new TextEncoder().encode(JSON.stringify(value)) });
const activities = (ids: readonly string[]) => ids.map((id, index) => ({ id, start_date: `1998-01-${String(index + 1).padStart(2, "0")}T07:00:00Z`,
  start_date_local: `1998-01-${String(index + 1).padStart(2, "0")}T08:00:00`, type: "Ride", moving_time: 90, elapsed_time: 100 }));
const fitBytes = (index: number) => new Uint8Array([14, index, 42]);
const zipFor = (ids: readonly string[]) => zipSync(Object.fromEntries(ids.map((id, index) => [`${id}_synthetic.fit`, fitBytes(index)])));

function rewriteZipFilename(bytes: Uint8Array, from: string, to: string): Uint8Array {
  const before = new TextEncoder().encode(from), after = new TextEncoder().encode(to);
  if (before.byteLength !== after.byteLength) throw new TypeError("replacement filenames must have equal lengths");
  const output = bytes.slice();
  let replacements = 0;
  for (let offset = 0; offset <= output.byteLength - before.byteLength; offset += 1) {
    if (before.every((value, index) => output[offset + index] === value)) {
      output.set(after, offset);
      replacements += 1;
      offset += before.byteLength - 1;
    }
  }
  if (replacements !== 2) throw new TypeError("ZIP filename records were not found");
  return output;
}

function rewriteZipUncompressedSizes(bytes: Uint8Array, sizes: readonly number[]): Uint8Array {
  const output = bytes.slice(), view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  let local = 0, central = 0;
  for (let offset = 0; offset <= output.byteLength - 4;) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x04034b50) {
      view.setUint32(offset + 22, sizes[local++]!, true);
      const compressedSize = view.getUint32(offset + 18, true);
      offset += 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true) + compressedSize;
    } else if (signature === 0x02014b50) {
      view.setUint32(offset + 24, sizes[central++]!, true);
      offset += 46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true)
        + view.getUint16(offset + 32, true);
    } else {
      offset += 1;
    }
  }
  if (local !== sizes.length || central !== sizes.length) throw new TypeError("ZIP entry records were not found");
  return output;
}

function archive(writes: string[] = []): ArchiveManager {
  return {
    async writeSnapshot(value, when) { const address = createHash("sha256").update(JSON.stringify(value)).digest("hex");
      return { address, relPath: `${when.epochSeconds}/${address}.json.gz`, deduped: false }; },
    async writeArtifact(bytes, ext, when) { writes.push(ext); const address = createHash("sha256").update(bytes).digest("hex");
      return { address, relPath: `${when.epochSeconds}/${address}.${ext}`, deduped: false }; },
    async has() { return true; }, async readArtifact() { throw new Error("unused"); }, async readSnapshot() { throw new Error("unused"); },
    async quarantine() { throw new Error("unused"); },
  };
}

function source(http: HttpPort, rawArchive = archive()) {
  return createIntervalsIcuSource({ athleteId: "synthetic-athlete", historyOldestDate: "1998-01-01",
    historyNewestDate: "1998-12-31", minRequestIntervalMs: 250, httpFactory: () => http, archive: rawArchive,
    wallClock: { now: () => Date.UTC(1998, 0, 1) }, sleep: async () => {}, acl: {
      activity: (row) => row, streams: (value) => value as Record<string, unknown>, assertClean() {},
    } });
}

async function collect(value: ReturnType<typeof source>): Promise<unknown[]> {
  const result: unknown[] = [];
  for await (const artifact of value.pull({ source: "intervals-icu", lane: "bulk-fit", value: null }, {
    signal: new AbortController().signal, clock: { monotonicNow: () => 0 }, deadlineMonotonicMs: 1_000_000,
    perRequestTimeoutMs: 30_000, maxRequests: 20, maxArtifacts: 20 })) result.push(artifact);
  return result;
}

describe("bulk FIT ZIP attribution", () => {
  it.each([1, 3, 8])("batch %i preserves stable container and entry bytes", (count) => {
    const ids = Array.from({ length: count }, (_, index) => `a${index}`), bytes = zipFor(ids);
    expect(zipFor(ids)).toEqual(bytes);
    const entries = extractBulkFitZip(bytes, ids);
    expect(entries.map((entry) => entry.activityId)).toEqual(ids);
    expect(entries.map((entry) => entry.bytes)).toEqual(ids.map((_, index) => fitBytes(index)));
  });

  it("sends repeated sorted ids and yields attributed entry bytes", async () => {
    const ids = ["b", "a", "c"], requests: { method: string; url: string; body: unknown; headers: unknown }[] = [];
    const http: HttpPort = { fetch: async (request) => {
      requests.push({ method: request.method, url: request.url, body: request.body, headers: request.headers });
      return request.url.includes("/activities?") ? json(activities(ids))
        : { status: 200, headers: { "content-type": "application/zip; charset=binary" }, body: zipFor([...ids].sort()) };
    } };
    const result = await collect(source(http));
    const bulk = requests.find((request) => request.method === "POST")!;
    const url = new URL(bulk.url);
    expect(url.searchParams.get("power")).toBe("true"); expect(url.searchParams.get("hr")).toBe("true");
    expect(url.searchParams.getAll("ids")).toEqual(["a", "b", "c"]);
    expect(bulk.body).toBeUndefined(); expect(bulk.headers).toBeUndefined();
    expect(result.filter((entry) => (entry as { kind: string }).kind === "raw-file")).toHaveLength(3);
  });

  it("fallback byte-identical response is archived and yielded without a container", async () => {
    const exact = fitBytes(7);
    const http: HttpPort = { fetch: async (request) => request.url.includes("/activities?") ? json(activities(["fallback-a"]))
      : request.method === "POST" ? { status: 404, headers: {}, body: new Uint8Array() }
        : { status: 200, headers: { "content-type": "application/octet-stream" }, body: exact } };
    const result = await collect(source(http));
    const artifact = result.find((entry) => (entry as { kind: string }).kind === "raw-file") as {
      file: { bytes: Uint8Array }; container: unknown; externalId: string;
    };
    expect(artifact.externalId).toBe("fallback-a"); expect(artifact.file.bytes).toEqual(exact); expect(artifact.container).toBeNull();
  });

  it("silent omission set-diffs before any raw-file or checkpoint yield", async () => {
    const writes: string[] = [], ids = ["a", "b"], yielded: unknown[] = [];
    const http: HttpPort = { fetch: async (request) => request.url.includes("/activities?") ? json(activities(ids))
      : { status: 200, headers: { "content-type": "application/zip" }, body: zipFor(["a"]) } };
    const iterator = source(http, archive(writes)).pull({ source: "intervals-icu", lane: "bulk-fit", value: null }, {
      signal: new AbortController().signal, clock: { monotonicNow: () => 0 }, deadlineMonotonicMs: 1_000_000,
      perRequestTimeoutMs: 30_000, maxRequests: 20, maxArtifacts: 20 });
    let caught: unknown;
    try { for await (const value of iterator) yielded.push(value); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(IncompleteBulkFitBatchError);
    expect(caught).toMatchObject({ requested: ["a", "b"], returned: ["a"], missing: ["b"], unexpected: [] });
    expect(yielded).toEqual([]); expect(writes).toEqual(["zip"]);
  });

  it("unexpected entry reports exact sorted sets", () => {
    expect(() => extractBulkFitZip(zipFor(["a", "x"]), ["a", "b"]))
      .toThrow(expect.objectContaining({ requested: ["a", "b"], returned: ["a", "x"], missing: ["b"], unexpected: ["x"] }));
  });

  it("rejects empty and oversized compressed bodies before extraction", () => {
    expect(() => extractBulkFitZip(new Uint8Array(), ["a"])).toThrow("size");
    const oversized = new Uint8Array(MAX_ZIP_BYTES + 1);
    oversized.set(zipFor(["a"]));
    expect(() => extractBulkFitZip(oversized, ["a"])).toThrow("size");
  });

  it.each([
    ["directory entry", "folder/"],
    ["nested path", "nested/a_one.fit"],
    ["backslash path", "nested\\a_one.fit"],
  ])("rejects a %s", (_label, filename) => {
    expect(() => extractBulkFitZip(zipSync({ [filename]: fitBytes(1) }), ["a"])).toThrow("path");
  });

  it("rejects duplicate filenames and duplicate activity prefixes", () => {
    const duplicateFilename = rewriteZipFilename(zipSync({ "a_one.fit": fitBytes(1), "b_two.fit": fitBytes(2) }),
      "b_two.fit", "a_one.fit");
    expect(() => extractBulkFitZip(duplicateFilename, ["a", "b"])).toThrow("filename is duplicated");
    expect(() => extractBulkFitZip(zipSync({ "a_one.fit": fitBytes(1), "a_two.fit": fitBytes(2) }), ["a"])).toThrow("prefix");
  });

  it("rejects more than eight file entries", () => {
    const nine = Array.from({ length: 9 }, (_, index) => `a${index}`);
    expect(() => extractBulkFitZip(zipFor(nine), nine.slice(0, 8))).toThrow("too many entries");
  });

  it("rejects empty and oversized entries", () => {
    expect(() => extractBulkFitZip(zipSync({ "a_empty.fit": new Uint8Array() }), ["a"])).toThrow("entry is empty");
    const oversized = rewriteZipUncompressedSizes(zipFor(["a"]), [MAX_FIT_BYTES + 1]);
    expect(() => extractBulkFitZip(oversized, ["a"])).toThrow("entry is too large");
  });

  it("rejects declared expanded totals over the batch limit", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const entrySize = Math.floor(MAX_UNCOMPRESSED_BATCH_BYTES / 4);
    expect(entrySize).toBeLessThanOrEqual(MAX_FIT_BYTES);
    const expandedOverflow = rewriteZipUncompressedSizes(zipFor(ids), ids.map(() => entrySize));
    expect(() => extractBulkFitZip(expandedOverflow, ids)).toThrow("batch is too large");
  });
});
