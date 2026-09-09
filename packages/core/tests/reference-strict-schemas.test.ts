import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";
import { z } from "zod";

import { cacheSchemas as cacheBarrel } from "@enduragent/kernel/reference/schemas";
import * as metricsBarrel from "../src/reference/metrics/index.js";

/**
 * Walks every export of the Reference cache + metrics barrels and asserts
 * each Zod object schema declares `.strict()`. This catches the most common
 * Reference regression — adding a new cache or metric shape without
 * `.strict()`, which makes intervals.icu API drift land silently in our
 * cache or metric authors silently widen the metric contract.
 *
 * The input-schema barrel (inputs.ts) is excluded by design: input schemas
 * use `z.looseObject()` to project the upstream API; their drift-gate is
 * the trademark denylist test (reference-input-schemas-no-tp.test.ts), not
 * the strict gate.
 *
 * Asserted via behavior, not Zod internals: for each ZodObject we extract,
 * we feed it an input shaped `{ __forbidden_extra__: <value> }` and verify
 * Zod rejects it with an `unrecognized_keys` error. A non-strict (default
 * "strip") object would silently drop the extra field and produce a different
 * (or no) error.
 *
 * Test stays valid across Zod versions because it tests behavior, not the
 * schema's `.def` shape.
 */

function isZodObject(value: unknown): value is z.ZodObject<z.ZodRawShape> {
  return value instanceof z.ZodObject;
}

function declaresStrict(schema: z.ZodObject<z.ZodRawShape>): {
  strict: boolean;
  reason?: string;
} {
  const probe = schema.safeParse({ __reference_strict_canary__: "x" });
  if (probe.success) {
    return {
      strict: false,
      reason: "schema accepted an unknown key (`__reference_strict_canary__`)",
    };
  }
  const flagsExtraKey = probe.error.issues.some((i) => i.code === "unrecognized_keys");
  return flagsExtraKey
    ? { strict: true }
    : {
        strict: false,
        reason:
          "schema rejected the canary input but NOT via `unrecognized_keys` — " +
          "indicates a non-strict object that happened to reject due to other " +
          "constraints. Add `.strict()` to enforce the drift gate.",
      };
}

describe("Reference Zod schemas — every object schema declares .strict()", () => {
  const allBarrels = [
    ["cache", cacheBarrel],
    ["metrics", metricsBarrel],
  ] as const;

  const exportedSchemas: Array<readonly [string, z.ZodObject<z.ZodRawShape>]> = [];
  for (const [barrelName, barrel] of allBarrels) {
    for (const [exportName, value] of Object.entries(barrel)) {
      if (isZodObject(value)) {
        exportedSchemas.push([`${barrelName}/${exportName}`, value]);
      }
    }
  }

  it("at least one Zod object schema across cache + metrics barrels", () => {
    // If this fails, the cache barrel emptied or metric schemas are not
    // surfaced through metrics/index.ts (re-export discipline broke).
    expect(exportedSchemas.length).toBeGreaterThan(0);
  });

  it.each(exportedSchemas)("%s declares .strict()", (name, schema) => {
    const result = declaresStrict(schema);
    expect(
      result.strict,
      `Schema ${name} is not strict: ${result.reason ?? "unknown reason"}`,
    ).toBe(true);
  });
});

/**
 * Re-export-discipline gate for metrics/. The barrel walker above only
 * fires on schemas that *did* reach `metrics/index.ts`. A metric author
 * who declares `LoadManagementSchema` in `metrics/load-management.ts` but
 * forgets the re-export silently bypasses the strict-gate. This test
 * scans every `metrics/*.ts` sibling, extracts top-level
 * `export const *Schema = ...` declarations, and asserts each one appears
 * in the imported barrel. Contract documented in `metrics/README.md`
 * (Rule 1).
 *
 * Scope: top-level `export const FooSchema` only. Multi-line declarations,
 * re-exports through `export {}` aliases, and conditionally-exported
 * schemas are out of scope — adding any of those should be paired with a
 * tightening of the regex.
 */

const METRICS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "kernel",
  "src",
  "reference",
  "metrics",
);
const SCHEMA_DECL_RE = /^export\s+const\s+([A-Z][A-Za-z0-9_]*Schema)\b/gm;

function declaredMetricSchemas(): Array<readonly [string, string]> {
  const found: Array<readonly [string, string]> = [];
  for (const entry of readdirSync(METRICS_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name === "index.ts") continue;
    if (entry.name.endsWith(".test.ts")) continue;
    const source = readFileSync(resolve(METRICS_DIR, entry.name), "utf-8");
    for (const match of source.matchAll(SCHEMA_DECL_RE)) {
      found.push([entry.name, match[1]]);
    }
  }
  return found;
}

describe("metrics/ re-export discipline (metrics/README.md Rule 1)", () => {
  const declared = declaredMetricSchemas();
  const barrelExports = new Set(Object.keys(metricsBarrel));

  if (declared.length === 0) {
    it.skip("no metric schemas declared yet — gate becomes active when the first one lands", () => {});
    return;
  }

  it.each(declared)("%s declares export const %s — barrel re-exports it", (file, name) => {
    expect(
      barrelExports.has(name),
      `${file} declares \`export const ${name}\` but it is missing from metrics/index.ts. ` +
        `Add the re-export in the same PR per metrics/README.md Rule 1, or the schema bypasses ` +
        `the strict-gate above.`,
    ).toBe(true);
  });
});
