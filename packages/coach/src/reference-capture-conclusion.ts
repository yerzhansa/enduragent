import { canonicalJson } from "@enduragent/kernel/archive";

export const HEX_40 = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;

export type ReferenceCaptureEnvironmentCode =
  | "ARGUMENTS"
  | "INPUT_PATH"
  | "INPUT_PERMISSIONS"
  | "INPUT_SCHEMA"
  | "MANIFEST_SCHEMA"
  | "ARCHIVE_MEMBER"
  | "CAPTURE_INCOMPLETE"
  | "SCRATCH_CREATE"
  | "INGEST_FAILED"
  | "PROJECTION_FAILED"
  | "CLEANUP_FAILED"
  | "CONCLUSION_PATH"
  | "CONCLUSION_WRITE"
  | "INTERNAL";

export interface ReferenceCaptureConclusionV1 {
  readonly schema_version: 1;
  readonly gate: "reference-capture-once";
  readonly head_sha: string;
  readonly capture_manifest_sha256: string | null;
  readonly capture_id_sha256: string | null;
  readonly verdict: "PASS" | "MISMATCH" | "ENVIRONMENT";
  readonly fixture_bytes_equal: boolean | null;
  readonly metric_maps_complete: boolean | null;
  readonly metric_bytes_equal: boolean | null;
  readonly registry_key_count: number | null;
  readonly metric_exception_count: number;
  readonly fixture_mismatch_count: number;
  readonly metric_mismatch_count: number;
  readonly direct_metric_exception_keys: readonly string[];
  readonly projected_metric_exception_keys: readonly string[];
  readonly fixture_mismatch_families: readonly string[];
  readonly metric_mismatch_keys: readonly string[];
  readonly direct_family_counts: Readonly<Record<string, number>>;
  readonly projected_family_counts: Readonly<Record<string, number>>;
  readonly environment_code: ReferenceCaptureEnvironmentCode | null;
}

const CONCLUSION_KEYS = [
  "schema_version",
  "gate",
  "head_sha",
  "capture_manifest_sha256",
  "capture_id_sha256",
  "verdict",
  "fixture_bytes_equal",
  "metric_maps_complete",
  "metric_bytes_equal",
  "registry_key_count",
  "metric_exception_count",
  "fixture_mismatch_count",
  "metric_mismatch_count",
  "direct_metric_exception_keys",
  "projected_metric_exception_keys",
  "fixture_mismatch_families",
  "metric_mismatch_keys",
  "direct_family_counts",
  "projected_family_counts",
  "environment_code",
] as const;

const ENVIRONMENT_CODES: readonly ReferenceCaptureEnvironmentCode[] = [
  "ARGUMENTS",
  "INPUT_PATH",
  "INPUT_PERMISSIONS",
  "INPUT_SCHEMA",
  "MANIFEST_SCHEMA",
  "ARCHIVE_MEMBER",
  "CAPTURE_INCOMPLETE",
  "SCRATCH_CREATE",
  "INGEST_FAILED",
  "PROJECTION_FAILED",
  "CLEANUP_FAILED",
  "CONCLUSION_PATH",
  "CONCLUSION_WRITE",
  "INTERNAL",
];

export function binaryCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function binarySortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(binaryCompare);
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function exactKeys<Key extends string>(
  value: object,
  keys: readonly Key[],
): value is Readonly<Record<Key, unknown>> {
  return (
    canonicalJson(Object.keys(value).sort(binaryCompare)) ===
    canonicalJson([...keys].sort(binaryCompare))
  );
}

function validSortedUnique(values: unknown): values is readonly string[] {
  return (
    Array.isArray(values) &&
    values.every((value) => typeof value === "string") &&
    canonicalJson(values) === canonicalJson(binarySortedUnique(values))
  );
}

function validCountMap(value: unknown): value is Readonly<Record<string, number>> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every(safeInteger)
  );
}

function nullableHash(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && HEX_64.test(value));
}

function nullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === "boolean";
}

function isConclusionRecord(value: unknown): value is ReferenceCaptureConclusionV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (!exactKeys(value, CONCLUSION_KEYS)) return false;
  return (
    value.schema_version === 1 &&
    value.gate === "reference-capture-once" &&
    typeof value.head_sha === "string" &&
    HEX_40.test(value.head_sha) &&
    nullableHash(value.capture_manifest_sha256) &&
    nullableHash(value.capture_id_sha256) &&
    (value.verdict === "PASS" || value.verdict === "MISMATCH" || value.verdict === "ENVIRONMENT") &&
    nullableBoolean(value.fixture_bytes_equal) &&
    nullableBoolean(value.metric_maps_complete) &&
    nullableBoolean(value.metric_bytes_equal) &&
    (value.registry_key_count === null || safeInteger(value.registry_key_count)) &&
    safeInteger(value.metric_exception_count) &&
    safeInteger(value.fixture_mismatch_count) &&
    safeInteger(value.metric_mismatch_count) &&
    validSortedUnique(value.direct_metric_exception_keys) &&
    validSortedUnique(value.projected_metric_exception_keys) &&
    validSortedUnique(value.fixture_mismatch_families) &&
    validSortedUnique(value.metric_mismatch_keys) &&
    validCountMap(value.direct_family_counts) &&
    validCountMap(value.projected_family_counts) &&
    (value.environment_code === null ||
      ENVIRONMENT_CODES.some((code) => code === value.environment_code))
  );
}

export function validateReferenceCaptureConclusion(value: unknown): ReferenceCaptureConclusionV1 {
  if (!isConclusionRecord(value)) throw new TypeError("invalid conclusion");
  if (
    value.metric_exception_count !==
      value.direct_metric_exception_keys.length + value.projected_metric_exception_keys.length ||
    value.fixture_mismatch_count !== value.fixture_mismatch_families.length ||
    value.metric_mismatch_count !== value.metric_mismatch_keys.length
  ) {
    throw new TypeError("invalid conclusion counts");
  }
  const noDiagnostics =
    value.metric_exception_count === 0 &&
    value.fixture_mismatch_count === 0 &&
    value.metric_mismatch_count === 0;
  const noFamilyCounts =
    Object.keys(value.direct_family_counts).length === 0 &&
    Object.keys(value.projected_family_counts).length === 0;
  if (value.verdict === "PASS") {
    if (
      value.environment_code !== null ||
      value.fixture_bytes_equal !== true ||
      value.metric_maps_complete !== true ||
      value.metric_bytes_equal !== true ||
      value.registry_key_count === null ||
      !noDiagnostics
    ) {
      throw new TypeError("invalid PASS conclusion");
    }
  } else if (value.verdict === "MISMATCH") {
    if (
      value.environment_code !== null ||
      value.fixture_bytes_equal === null ||
      value.metric_maps_complete === null ||
      value.metric_bytes_equal === null ||
      value.registry_key_count === null ||
      (value.fixture_bytes_equal &&
        value.metric_maps_complete &&
        value.metric_bytes_equal &&
        value.metric_exception_count === 0 &&
        value.fixture_mismatch_count === 0 &&
        value.metric_mismatch_count === 0)
    ) {
      throw new TypeError("invalid MISMATCH conclusion");
    }
  } else if (
    value.environment_code === null ||
    value.fixture_bytes_equal !== null ||
    value.metric_maps_complete !== null ||
    value.metric_bytes_equal !== null ||
    value.registry_key_count !== null ||
    !noDiagnostics ||
    !noFamilyCounts
  ) {
    throw new TypeError("invalid ENVIRONMENT conclusion");
  }
  return Object.freeze(value);
}
