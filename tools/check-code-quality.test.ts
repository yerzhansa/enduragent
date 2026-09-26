import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareCounts,
  countOxlintDiagnostics,
  formatDrift,
  isTestPath,
  main,
  measure,
  parseBaseline,
  scanSource,
  serializeBaseline,
  updateBaseline,
} from "./check-code-quality.js";

const REPO_OXLINTRC = fileURLToPath(new URL("../.oxlintrc.json", import.meta.url));
const BASELINE = "tools/code-quality-baseline.json";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "code-quality-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tempDir, { recursive: true, force: true });
});

function write(relativePath: string, contents: string): void {
  const path = join(tempDir, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

function initRepository(files: Readonly<Record<string, string>>): void {
  expect(spawnSync("git", ["init", "-q"], { cwd: tempDir }).status).toBe(0);
  copyFileSync(REPO_OXLINTRC, join(tempDir, ".oxlintrc.json"));
  write("tools/tool.ts", "export const tool = 1;\n");
  write("apps/desktop/src/app.ts", "export const app = 1;\n");
  for (const [path, contents] of Object.entries(files)) write(path, contents);
}

function readBaseline(): string {
  return readFileSync(join(tempDir, BASELINE), "utf8");
}

function runMain(argv: readonly string[]): { code: number; errors: string[] } {
  const errors: string[] = [];
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation((line: unknown) => {
    errors.push(String(line));
  });
  const code = main(argv);
  vi.restoreAllMocks();
  return { code, errors };
}

describe("scanSource comments", () => {
  it("counts line, block, doc, trailing, JSX, and end-of-file comments", () => {
    const source = [
      "// leading line",
      "/* block */",
      "/** doc */",
      "export function View() {",
      "  const count = 1; // trailing",
      "  return (",
      "    <div>",
      "      {/* jsx */}",
      '      <span /* attribute */ id="x">{count}</span>',
      "    </div>",
      "  );",
      "}",
      "// end of file",
    ].join("\n");
    expect(scanSource("packages/a/src/view.tsx", source).comment).toEqual({
      "packages/a/src/view.tsx": 7,
    });
  });

  it("ignores comment markers inside strings, templates, regexes, JSX text, and the hashbang", () => {
    const source = [
      "#!/usr/bin/env node",
      'export const url = "https://example.test/*x*/";',
      "export const template = `// not ${url} /* a */ comment`;",
      "export const pattern = /\\/\\/ not a comment/u;",
      "export const divided = 4 / 2 / 1;",
      "export function View() {",
      "  return <p>// not a comment /* either */ {url}// still text</p>;",
      "}",
    ].join("\n");
    expect(scanSource("packages/a/src/view.tsx", source).comment).toBeUndefined();
  });

  it("exempts build directives everywhere and suppression directives only in tests", () => {
    const source = [
      '/// <reference types="vite/client" />',
      "export const frozen = /* #__PURE__ */ Object.freeze({});",
      "export const sealed = /*@__PURE__*/ Object.seal({});",
      "export const load = (url: string) => import(/* @vite-ignore */ url);",
      "// @ts-expect-error the module has no types",
      'import missing from "missing";',
      "// eslint-disable-next-line no-console",
      "console.log(missing);",
      "/* oxlint-disable no-debugger */",
    ].join("\n");
    expect(scanSource("packages/a/tests/view.test.ts", source).comment).toBeUndefined();
    expect(scanSource("packages/a/src/view.ts", source).comment).toEqual({
      "packages/a/src/view.ts": 3,
    });
    expect(scanSource("packages/a/src/view.ts", source)["lint-suppression"]).toEqual({
      "packages/a/src/view.ts": 2,
    });
    expect(scanSource("packages/a/tests/view.test.ts", source)["lint-suppression"]).toBeUndefined();
  });
});

describe("scanSource code patterns", () => {
  it("counts rejection handlers that discard the error outside tests", () => {
    const source = [
      "declare const job: Promise<void>;",
      "declare function fallback(): void;",
      "job.catch(() => {});",
      "job.catch(() => undefined);",
      "job.catch(() => null);",
      "job.catch(() => void 0);",
      "job.catch((() => (undefined)));",
      "job.catch(function () {});",
      "job.catch((error: unknown) => { console.error(error); });",
      "job.catch(() => fallback());",
      "job.then(() => {});",
    ].join("\n");
    expect(scanSource("packages/a/src/job.ts", source)["swallowed-rejection"]).toEqual({
      "packages/a/src/job.ts": 6,
    });
    expect(scanSource("packages/a/src/job.test.ts", source)["swallowed-rejection"]).toBeUndefined();
  });

  it("counts assertions through unknown outside tests", () => {
    const source = [
      "declare const value: string;",
      "export const a = value as unknown as number;",
      "export const b = (value as unknown) as number;",
      "export const c = value as unknown;",
      "export const d = value as string;",
      "export const e = value as never as number;",
    ].join("\n");
    expect(scanSource("packages/a/src/cast.ts", source)["double-assertion"]).toEqual({
      "packages/a/src/cast.ts": 2,
    });
    expect(scanSource("packages/a/e2e/cast.ts", source)["double-assertion"]).toBeUndefined();
  });

  it("records the line count of non-test files over 800 lines", () => {
    const lines = (count: number): string => "export {};\n".repeat(count);
    expect(scanSource("packages/a/src/big.ts", lines(801))["file-length"]).toEqual({
      "packages/a/src/big.ts": 801,
    });
    expect(scanSource("packages/a/src/edge.ts", lines(800))["file-length"]).toBeUndefined();
    expect(scanSource("packages/a/tests/big.test.ts", lines(900))["file-length"]).toBeUndefined();
  });

  it.each([
    ["packages/core/tests/helper.ts", true],
    ["apps/desktop/src/updater.test.ts", true],
    ["apps/desktop-renderer/src/view.spec.tsx", true],
    ["apps/desktop/e2e/flow.ts", true],
    ["tools/fixtures/builder.ts", true],
    ["packages/x/test/helper.ts", true],
    ["packages/core/src/testing.ts", false],
    ["packages/core/src/latest.ts", false],
    ["packages/core/src/contest/entry.ts", false],
  ])("classifies %s as test=%s", (path, expected) => {
    expect(isTestPath(path)).toBe(expected);
  });
});

describe("countOxlintDiagnostics", () => {
  it("maps oxlint codes to ratchet ids within each rule's scope and ignores other codes", () => {
    expect(
      countOxlintDiagnostics([
        { code: "eslint(no-empty)", filename: "packages/a/src/a.ts" },
        { code: "eslint(no-empty)", filename: "packages/a/src/a.ts" },
        { code: "typescript(no-non-null-assertion)", filename: "packages/a/tests/a.test.ts" },
        { code: "eslint(no-restricted-globals)", filename: "apps/desktop-renderer/src/ui/a.tsx" },
        { code: "eslint(no-restricted-properties)", filename: "apps/desktop-renderer/src/ui/a.tsx" },
        { code: "eslint(no-restricted-globals)", filename: "apps/desktop-renderer/src/stores/a.ts" },
        { code: "unicorn(no-useless-spread)", filename: "packages/a/src/a.ts" },
      ]),
    ).toEqual({
      "no-empty": { "packages/a/src/a.ts": 2 },
      "ui-restricted-api": { "apps/desktop-renderer/src/ui/a.tsx": 2 },
    });
  });
});

describe("baseline comparison", () => {
  it("reports a grown count and a newly violating file as increases", () => {
    expect(
      compareCounts({ comment: { "a.ts": 2 } }, { comment: { "a.ts": 3, "b.ts": 1 } }),
    ).toEqual([
      { rule: "comment", file: "a.ts", baseline: 2, current: 3 },
      { rule: "comment", file: "b.ts", baseline: 0, current: 1 },
    ]);
  });

  it("reports a lower count as a drift that asks for --update", () => {
    const drifts = compareCounts({ "no-empty": { "a.ts": 2 } }, { "no-empty": { "a.ts": 1 } });
    expect(drifts).toEqual([{ rule: "no-empty", file: "a.ts", baseline: 2, current: 1 }]);
    expect(drifts.map(formatDrift)).toEqual([
      "  a.ts  no-empty  2 -> 1  run `pnpm check:code-quality --update` to lock in the lower count",
    ]);
  });

  it("names the file, rule, counts, and guidance for an increase", () => {
    expect(
      formatDrift({ rule: "swallowed-rejection", file: "a.ts", baseline: 0, current: 1 }),
    ).toBe(
      "  a.ts  swallowed-rejection  0 -> 1  handle the error, return a typed failure, or let it propagate",
    );
  });

  it("refuses to update when any count would increase", () => {
    expect(
      updateBaseline({ comment: { "a.ts": 1, "b.ts": 5 } }, { comment: { "a.ts": 2, "b.ts": 1 } }),
    ).toEqual({
      kind: "refused",
      increases: [{ rule: "comment", file: "a.ts", baseline: 1, current: 2 }],
    });
  });

  it("updates to the current counts, dropping files and rules that no longer violate", () => {
    expect(
      updateBaseline(
        {
          comment: { "a.ts": 3, "gone.ts": 2 },
          "file-length": { "big.ts": 900 },
          "no-empty": { "fixed.ts": 1 },
        },
        { comment: { "a.ts": 2 }, "file-length": { "big.ts": 850 } },
      ),
    ).toEqual({
      kind: "updated",
      baseline: { comment: { "a.ts": 2 }, "file-length": { "big.ts": 850 } },
    });
  });

  it("serializes with sorted keys and rejects unknown rule ids", () => {
    const serialized = serializeBaseline({
      "no-empty": { "b.ts": 1, "c.ts": 3, "a.ts": 2 },
      comment: { "c.ts": 4 },
    });
    expect(serialized).toBe(
      '{\n  "comment": {\n    "c.ts": 4\n  },\n  "no-empty": {\n    "a.ts": 2,\n    "b.ts": 1,\n    "c.ts": 3\n  }\n}\n',
    );
    expect(parseBaseline(serialized)).toEqual({
      comment: { "c.ts": 4 },
      "no-empty": { "a.ts": 2, "b.ts": 1, "c.ts": 3 },
    });
    expect(() => parseBaseline('{"made-up-rule": {"a.ts": 1}}')).toThrow();
  });
});

describe("measure and main on a fixture repository", () => {
  it("maps oxlint warnings from the repository config to ratchet ids", () => {
    const violations = [
      "// TODO finish",
      "// @ts-ignore",
      "export const loose: any = 1;",
      "export function noop() {}",
      "try { noop(); } catch {}",
      'export const first = new Map<string, number>().get("k")!;',
    ].join("\n");
    initRepository({
      "packages/a/src/core.ts": violations,
      "packages/a/tests/core.test.ts": violations,
      "apps/desktop-renderer/src/ui/View.tsx": [
        "export function View() {",
        '  fetch("/x");',
        "  setTimeout(() => 1, 5);",
        "  window.setInterval(() => 1, 5);",
        "  void window.enduragentAuth;",
        "  void globalThis.fetch;",
        "  return null;",
        "}",
      ].join("\n"),
      "apps/desktop-renderer/src/stores/poll.ts": 'setTimeout(() => 1, 5);\nfetch("/x");\n',
    });

    const core = "packages/a/src/core.ts";
    const coreTest = "packages/a/tests/core.test.ts";
    expect(measure(tempDir).counts).toEqual({
      comment: { [core]: 2, [coreTest]: 2 },
      "no-empty": { [core]: 1, [coreTest]: 1 },
      "no-empty-function": { [core]: 1 },
      "no-warning-comments": { [core]: 1, [coreTest]: 1 },
      "typescript/ban-ts-comment": { [core]: 1, [coreTest]: 1 },
      "typescript/no-explicit-any": { [core]: 1, [coreTest]: 1 },
      "typescript/no-non-null-assertion": { [core]: 1 },
      "ui-restricted-api": { "apps/desktop-renderer/src/ui/View.tsx": 5 },
    });
  });

  it("fails without a baseline, creates one with --update, then passes", () => {
    initRepository({ "packages/a/src/core.ts": "// one\nexport const a = 1;\n" });
    expect(runMain([tempDir]).code).toBe(1);
    expect(runMain([tempDir, "--update"]).code).toBe(0);
    expect(JSON.parse(readBaseline())).toEqual({ comment: { "packages/a/src/core.ts": 1 } });
    expect(runMain([tempDir])).toEqual({ code: 0, errors: [] });
  });

  it("fails on a grown count and on a new file, naming the rule and guidance", () => {
    initRepository({ "packages/a/src/core.ts": "// one\nexport const a = 1;\n" });
    expect(runMain([tempDir, "--update"]).code).toBe(0);

    write(
      "packages/a/src/core.ts",
      "// one\n// two\nexport const a = 1;\nPromise.resolve().catch(() => {});\n",
    );
    write("packages/a/src/added.ts", "// added\nexport const b = 2;\n");
    const { code, errors } = runMain([tempDir]);
    expect(code).toBe(1);
    expect(errors).toContain(
      "  packages/a/src/added.ts  comment  0 -> 1  move the rationale to the PR description or an ADR, and make the code say it through names and structure",
    );
    expect(errors).toContain(
      "  packages/a/src/core.ts  comment  1 -> 2  move the rationale to the PR description or an ADR, and make the code say it through names and structure",
    );
    expect(errors).toContain(
      "  packages/a/src/core.ts  swallowed-rejection  0 -> 1  handle the error, return a typed failure, or let it propagate",
    );
  });

  it("fails on a lower count until --update shrinks the baseline, dropping fixed and deleted files", () => {
    initRepository({
      "packages/a/src/kept.ts": "// one\n// two\nexport const a = 1;\n",
      "packages/a/src/fixed.ts": "// one\nexport const b = 1;\n",
      "packages/a/src/deleted.ts": "// one\nexport const c = 1;\n",
    });
    expect(runMain([tempDir, "--update"]).code).toBe(0);

    write("packages/a/src/kept.ts", "// one\nexport const a = 1;\n");
    write("packages/a/src/fixed.ts", "export const b = 1;\n");
    rmSync(join(tempDir, "packages/a/src/deleted.ts"));
    const { code, errors } = runMain([tempDir]);
    expect(code).toBe(1);
    expect(errors).toContain(
      "  packages/a/src/kept.ts  comment  2 -> 1  run `pnpm check:code-quality --update` to lock in the lower count",
    );

    expect(runMain([tempDir, "--update"]).code).toBe(0);
    expect(JSON.parse(readBaseline())).toEqual({ comment: { "packages/a/src/kept.ts": 1 } });
    expect(runMain([tempDir]).code).toBe(0);
  });

  it("refuses --update when a count grew and leaves the baseline untouched", () => {
    initRepository({ "packages/a/src/core.ts": "// one\nexport const a = 1;\n" });
    expect(runMain([tempDir, "--update"]).code).toBe(0);
    const before = readBaseline();

    write("packages/a/src/core.ts", "export const a = 1 as unknown as string;\n");
    const { code, errors } = runMain([tempDir, "--update"]);
    expect(code).toBe(1);
    expect(errors).toContain(
      "  packages/a/src/core.ts  double-assertion  0 -> 1  fix the type or the code instead of suppressing the checker",
    );
    expect(readBaseline()).toBe(before);
  });
});
