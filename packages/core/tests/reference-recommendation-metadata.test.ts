import { describe, it, expect } from "vitest";
import {
  AUDIT_SCHEMA_VERSION,
  CitationSchema,
  RecommendationMetadataSchema,
  AuditLogEntrySchema,
  type RecommendationMetadata,
} from "../src/reference/validation/recommendation-metadata.js";

const validMetadata: RecommendationMetadata = {
  citations: [{ field: "current_status.acwr.value", value: 1.12, source: "latest.json" }],
  confidence: "high",
  frameworks: ["polarized"],
  phase_tag: "build",
};

describe("RecommendationMetadataSchema", () => {
  it("accepts a fully-valid object and round-trips it", () => {
    const parsed = RecommendationMetadataSchema.parse(validMetadata);
    expect(parsed).toEqual(validMetadata);
  });

  it("rejects an empty frameworks array (min(1) violation)", () => {
    expect(() =>
      RecommendationMetadataSchema.parse({ ...validMetadata, frameworks: [] }),
    ).toThrow();
  });

  it("rejects a confidence outside {high,medium,low}", () => {
    expect(() =>
      RecommendationMetadataSchema.parse({
        ...validMetadata,
        confidence: "very-high",
      }),
    ).toThrow();
  });

  it("rejects an unknown top-level field (.strict() boundary)", () => {
    expect(() => RecommendationMetadataSchema.parse({ ...validMetadata, extra: "x" })).toThrow();
  });
});

describe("CitationSchema", () => {
  it("rejects a source other than 'latest.json' (z.literal violation)", () => {
    expect(() =>
      CitationSchema.parse({
        field: "current_status.acwr.value",
        value: 1.12,
        source: "history.json",
      }),
    ).toThrow();
  });

  it("rejects an unknown field (.strict() boundary)", () => {
    expect(() =>
      CitationSchema.parse({
        field: "x",
        value: 1,
        source: "latest.json",
        extra: "nope",
      }),
    ).toThrow();
  });
});

describe("AuditLogEntrySchema", () => {
  it("exposes AUDIT_SCHEMA_VERSION === '2'", () => {
    expect(AUDIT_SCHEMA_VERSION).toBe("2");
  });

  it("accepts a valid entry and round-trips it", () => {
    const entry = {
      schema_version: AUDIT_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      chatId: "12345",
      responseHash: "abcdef0123456789",
      metadata: validMetadata,
    };
    const parsed = AuditLogEntrySchema.parse(entry);
    expect(parsed).toEqual(entry);
  });

  it("accepts the optional validation_warning field and round-trips it", () => {
    const entry = {
      schema_version: AUDIT_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      chatId: "12345",
      responseHash: "abcdef0123456789",
      metadata: validMetadata,
      validation_warning: true,
    };
    const parsed = AuditLogEntrySchema.parse(entry);
    expect(parsed.validation_warning).toBe(true);
  });

  it("accepts the v2 fields and round-trips them", () => {
    const entry = {
      schema_version: AUDIT_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      chatId: "12345",
      responseHash: "abcdef0123456789",
      metadata: validMetadata,
      event_type: "turn_failed" as const,
      verdicts: [{ lens: "citation", ok: true, detail: null }],
      prompt_template_hash: "deadbeefdeadbeef",
    };
    const parsed = AuditLogEntrySchema.parse(entry);
    expect(parsed.event_type).toBe("turn_failed");
    expect(parsed.verdicts).toEqual([{ lens: "citation", ok: true, detail: null }]);
    expect(parsed.prompt_template_hash).toBe("deadbeefdeadbeef");
  });

  it("a minimal (v1-field-set) entry still parses under the v2 schema", () => {
    // The v2 fields being optional is what keeps the v1->v2 map and the existing
    // minimal-entry shape valid.
    const entry = {
      schema_version: AUDIT_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      chatId: "12345",
      responseHash: "abcdef0123456789",
      metadata: validMetadata,
    };
    expect(() => AuditLogEntrySchema.parse(entry)).not.toThrow();
  });

  it("rejects an unknown top-level field (.strict() boundary)", () => {
    expect(() =>
      AuditLogEntrySchema.parse({
        schema_version: AUDIT_SCHEMA_VERSION,
        ts: new Date().toISOString(),
        chatId: "12345",
        responseHash: "abcdef0123456789",
        metadata: validMetadata,
        future_field_typo: "nope",
      }),
    ).toThrow();
  });
});
