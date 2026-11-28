import { describe, expect, it } from "vitest";
import * as ts from "typescript";
import { sameFileChecker } from "./check-code-quality.js";
import { countLooseStateFlags, isCopyComparison } from "./implicit-state.js";

function parse(source: string, file = "apps/desktop/src/sample.ts"): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
}

function flags(source: string, file?: string): number {
  const sourceFile = parse(source, file);
  return countLooseStateFlags(sourceFile, () => sameFileChecker(sourceFile));
}

function copyComparisons(source: string): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (isCopyComparison(node)) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(parse(source));
  return count;
}

describe("loose state flags", () => {
  it("allows a single lifecycle flag", () => {
    expect(
      flags(
        [
          "export function create() {",
          "  let disposed = false;",
          "  return { dispose: () => { disposed = true; }, live: () => !disposed };",
          "}",
        ].join("\n"),
      ),
    ).toBe(0);
  });

  it("ignores flags that never leave their own function", () => {
    expect(
      flags(
        [
          "export function scan(items: readonly number[]) {",
          "  let found = false;",
          "  let negative = false;",
          "  for (const item of items) {",
          "    if (item === 1) found = true;",
          "    if (item < 0) negative = true;",
          "  }",
          "  return found && !negative;",
          "}",
        ].join("\n"),
      ),
    ).toBe(0);
  });

  it("counts every flag when two captured booleans change in callbacks", () => {
    expect(
      flags(
        [
          "export function controller() {",
          "  let busy = false;",
          "  let failed: boolean;",
          "  const run = async () => {",
          "    busy = true;",
          "    try { await work(); } catch { failed = true; } finally { busy = false; }",
          "  };",
          "  return { run, view: () => ({ busy, failed }) };",
          "}",
          "declare function work(): Promise<void>;",
        ].join("\n"),
      ),
    ).toBe(2);
  });

  it("does not count a nested function that shadows the name", () => {
    expect(
      flags(
        [
          "export function controller() {",
          "  let busy = false;",
          "  let failed = false;",
          "  const inner = () => { let busy = true; busy = false; return busy; };",
          "  const fail = () => { failed = true; };",
          "  return { inner, fail, busy };",
          "}",
        ].join("\n"),
      ),
    ).toBe(0);
  });

  it("counts mutable boolean class fields and skips readonly ones", () => {
    expect(
      flags(
        [
          "export class Coordinator {",
          "  private closing = false;",
          "  private started: boolean = false;",
          "  readonly enabled = true;",
          "  close() { this.closing = true; }",
          "  start() { this.started = true; }",
          "}",
        ].join("\n"),
      ),
    ).toBe(2);
    expect(flags("export class One {\n  private closing = false;\n  close() { this.closing = true; }\n}\n")).toBe(0);
  });

  it("counts boolean React state when one component holds two of them", () => {
    const file = "apps/desktop-renderer/src/ui/View.tsx";
    expect(
      flags(
        [
          'import { useState } from "react";',
          "export function View() {",
          "  const [open, setOpen] = useState(false);",
          "  const [editing, setEditing] = useState<boolean>(true);",
          "  return null;",
          "}",
        ].join("\n"),
        file,
      ),
    ).toBe(2);
    expect(
      flags(
        [
          'import { useState } from "react";',
          "export function View() {",
          "  const [open, setOpen] = useState(false);",
          '  const [name, setName] = useState("");',
          "  return null;",
          "}",
        ].join("\n"),
        file,
      ),
    ).toBe(0);
  });
});

describe("loose state flags edge cases", () => {
  it("sees a write after a same-name loop variable in the callback", () => {
    expect(
      flags(
        [
          "export function controller(items: readonly boolean[]) {",
          "  let busy = false;",
          "  let failed = false;",
          "  const run = () => {",
          "    for (const busy of items) void busy;",
          "    busy = true;",
          "    failed = true;",
          "  };",
          "  return { run, view: () => busy || failed };",
          "}",
        ].join("\n"),
      ),
    ).toBe(2);
  });

  it("does not count a destructured parameter that shadows the flag", () => {
    expect(
      flags(
        [
          "export function controller() {",
          "  let busy = false;",
          "  let failed = false;",
          "  const toggle = ({ busy }: { busy: boolean }) => { busy = !busy; return busy; };",
          "  const fail = () => { failed = true; };",
          "  return { toggle, fail, view: () => busy || failed };",
          "}",
        ].join("\n"),
      ),
    ).toBe(0);
  });

  it("treats synchronous array callbacks as part of the same function", () => {
    expect(
      flags(
        [
          "export function signs(values: readonly number[]) {",
          "  let negative = false;",
          "  let positive = false;",
          "  values.forEach((value) => { if (value < 0) negative = true; if (value > 0) positive = true; });",
          "  return { negative, positive };",
          "}",
        ].join("\n"),
      ),
    ).toBe(0);
  });

  it("ignores class fields that are never written and declared fields", () => {
    expect(
      flags(
        [
          "export class Options {",
          "  private verbose = false;",
          "  private dryRun = false;",
          "  declare busy: boolean;",
          "  declare closing: boolean;",
          "  describe() { return this.verbose || this.dryRun; }",
          "  close() { this.busy = true; this.closing = true; }",
          "}",
        ].join("\n"),
      ),
    ).toBe(0);
  });

  it("counts lazily initialized boolean React state", () => {
    expect(
      flags(
        [
          'import { useState } from "react";',
          "export function View() {",
          "  const [open, setOpen] = useState(() => false);",
          "  const [editing, setEditing] = useState(false);",
          "  return null;",
          "}",
        ].join("\n"),
        "apps/desktop-renderer/src/ui/View.tsx",
      ),
    ).toBe(2);
  });
});

describe("copy comparisons", () => {
  it("counts equality and text-match checks against display copy, not copy-to-key maps", () => {
    expect(
      copyComparisons(
        [
          "declare const notice: string;",
          'export const activated = notice === "Plan activated locally.";',
          'export const retryable = notice.endsWith("Retry available.");',
          "export function key(value: string) {",
          "  switch (value) {",
          '    case "Coach is working…":',
          '      return "working";',
          "  }",
          '  return value !== "All saved!" ? "other" : "saved";',
          "}",
        ].join("\n"),
      ),
    ).toBe(3);
  });

  it("ignores codes, identifiers and text without sentence punctuation", () => {
    expect(
      copyComparisons(
        [
          "declare const status: string;",
          'export const a = status === "in-progress";',
          'export const b = status === "Done";',
          'export const c = status === "two words";',
          'export const d = status.startsWith("v1.");',
          'export const e = "Plan activated locally.";',
        ].join("\n"),
      ),
    ).toBe(0);
  });
});
