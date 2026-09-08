import type { SourceProvenance } from "../provenance.js";

const BOUND_PROVENANCE = Symbol.for("enduragent.bound-tool-result.provenance");
const BOUND_VALUE = Symbol.for("enduragent.bound-tool-result.value");

interface BoundToolResult {
  readonly [BOUND_PROVENANCE]: SourceProvenance;
  readonly [BOUND_VALUE]: unknown;
}

export function bindToolResult(value: unknown, provenance: SourceProvenance): BoundToolResult {
  return {
    [BOUND_PROVENANCE]: provenance,
    [BOUND_VALUE]: value,
  };
}

export function boundToolResultProvenance(value: unknown): SourceProvenance | undefined {
  if (value === null || typeof value !== "object") return undefined;
  return (value as Partial<BoundToolResult>)[BOUND_PROVENANCE];
}

export function unwrapBoundToolResult(value: unknown): unknown {
  if (value === null || typeof value !== "object" || !(BOUND_VALUE in value)) return value;
  return (value as BoundToolResult)[BOUND_VALUE];
}

export function carryBoundToolResultProvenance<T extends object>(source: unknown, target: T): T {
  const provenance = boundToolResultProvenance(source);
  if (provenance !== undefined) {
    Object.defineProperty(target, BOUND_PROVENANCE, {
      value: provenance,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return target;
}
