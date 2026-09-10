// Different from `safeReadJson` (production graceful-null path): a missing
// or invalid fixture is a test bug, not a runtime condition. Throw loudly
// with the fixture path AND the Zod issue tree so the failure points at
// the bug.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ZodTypeAny, type z } from "zod";

import { FixtureSchema, type FixtureShape } from "../../src/reference/schemas/inputs.js";

/** Re-export the canonical fixture schema for in-package test callers.
 *  Single source of truth for the envelope shape lives in
 *  `reference/schemas/inputs.ts` (ADR-0017); both this helper and the
 *  parity gate at `tools/check-metric-parity.ts` consume it from there. */
export const GoldenFixtureSchema = FixtureSchema;
export type GoldenFixture = FixtureShape;

const DEFAULT_FIXTURES_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

export interface LoadFixtureOptions {
  /** Override the fixture-root directory. Tests use tmpdir to stay
   *  self-contained; production callers omit it. */
  rootDir?: string;
}

export function loadFixture<S extends ZodTypeAny>(
  name: string,
  schema: S,
  opts?: LoadFixtureOptions,
): z.infer<S> {
  const root = opts?.rootDir ?? DEFAULT_FIXTURES_ROOT;
  const path = resolve(root, `${name}.json`);
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw);
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`loadFixture: ${path} failed schema parse:\n${result.error.message}`);
  }
  return result.data;
}
