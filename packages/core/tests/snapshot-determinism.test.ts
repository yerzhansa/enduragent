import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runHarnessAsync, section11Available } from "./helpers/snapshot-harness";

/**
 * Two consecutive harness runs into separate tempdirs must produce
 * byte-identical output trees. Runs are dispatched in parallel via
 * `Promise.all` because pyodide boot dominates wall-clock; the
 * byte-identity invariant means the runs are order-independent by
 * construction.
 *
 * When this fails, see `tools/snapshot-section-11.README.md` §
 * "Determinism" for the audited non-determinism sources and the
 * rule for extending the list.
 */

function listFilesRecursive(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(root, rel))) {
      const next = rel ? `${rel}/${entry}` : entry;
      if (statSync(join(root, next)).isDirectory()) walk(next);
      else out.push(next);
    }
  };
  walk("");
  out.sort();
  return out;
}

describe("section-11 snapshot harness determinism", () => {
  it.runIf(section11Available())(
    "two consecutive runs produce byte-identical output trees",
    async () => {
      const dir1 = mkdtempSync(join(tmpdir(), "snapshot-section-11-run-1-"));
      const dir2 = mkdtempSync(join(tmpdir(), "snapshot-section-11-run-2-"));

      await Promise.all([runHarnessAsync({ outDir: dir1 }), runHarnessAsync({ outDir: dir2 })]);

      const files1 = listFilesRecursive(dir1);
      const files2 = listFilesRecursive(dir2);
      expect(files2).toEqual(files1);

      for (const rel of files1) {
        const a = readFileSync(join(dir1, rel));
        const b = readFileSync(join(dir2, rel));
        expect(
          a.equals(b),
          `byte-mismatch in ${rel} — see tools/snapshot-section-11.README.md § Determinism`,
        ).toBe(true);
      }
    },
    180_000,
  );
});
