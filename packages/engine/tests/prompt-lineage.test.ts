import { describe, it, expect } from "vitest";
import {
  computeAssembledHash,
  computePromptLineage,
  promptLineageSchemaVersion,
  PROMPT_LINEAGE_NATIVE_MEDIA_SCHEMA_VERSION,
  PROMPT_LINEAGE_SCHEMA_VERSION,
  sha256_16,
} from "../src/agent/prompt-lineage.js";
import type { PromptLineageInput } from "../src/agent/prompt-lineage.js";
import { staticRuleBlocks } from "../src/agent/system-prompt.js";
import type { ModelMessage } from "ai";

const baseMessages: ModelMessage[] = [
  { role: "user", content: "hi" },
  { role: "assistant", content: "hello" },
];

const base: PromptLineageInput = {
  soul: "# Coach\n\nYou are a coach.",
  skills: { example: "# Example\n\nSome content." },
  ruleBlocks: ["RULE A", "RULE B"],
  toolSchemas: { memory_query: { kind: "object" }, plan_save: { kind: "object" } },
  model: "claude-x",
  systemPrompt: "# Coach\n\n---\n\nRULE A\n\n---\n\nRULE B",
  messages: baseMessages,
};

describe("computePromptLineage", () => {
  it("pins lineage for the ungated (immediate-execute) host rule-block set", () => {
    const lineage = computePromptLineage({ ...base, ruleBlocks: staticRuleBlocks() });
    expect(lineage.templateHash).toBe("37266c7365ff94d1");
  });

  it("pins a distinct lineage for the confirmation-gated host rule-block set", () => {
    const gated = computePromptLineage({
      ...base,
      ruleBlocks: staticRuleBlocks(30, { confirmationGate: true }),
    });
    expect(gated.templateHash).toBe("0f0beefd13810f99");
    expect(gated.templateHash).not.toBe(
      computePromptLineage({ ...base, ruleBlocks: staticRuleBlocks() }).templateHash,
    );
  });

  it("is deterministic and produces sha256-16 hashes", () => {
    const a = computePromptLineage(base);
    const b = computePromptLineage(base);
    expect(a).toEqual(b);
    expect(a.templateHash).toMatch(/^[0-9a-f]{16}$/);
    expect(a.assembledHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("holds the template hash stable across volatile-only changes", () => {
    const a = computePromptLineage(base);
    const b = computePromptLineage({
      ...base,
      systemPrompt: base.systemPrompt + "\n\n---\n\n# Athlete Context\n\nFTP 250",
      messages: [...baseMessages, { role: "user", content: "what now?" }],
    });
    expect(b.templateHash).toBe(a.templateHash);
    expect(b.assembledHash).not.toBe(a.assembledHash);
  });

  it("changes the template hash when the model id changes", () => {
    const a = computePromptLineage(base);
    const b = computePromptLineage({ ...base, model: "claude-y" });
    expect(b.templateHash).not.toBe(a.templateHash);
  });

  it("changes the template hash when a rule block is dropped (Layer-3 flag-off case)", () => {
    const a = computePromptLineage(base);
    const b = computePromptLineage({ ...base, ruleBlocks: ["RULE A"] });
    expect(b.templateHash).not.toBe(a.templateHash);
  });

  it("serializes tool schemas order-stably", () => {
    const a = computePromptLineage(base);
    const b = computePromptLineage({
      ...base,
      toolSchemas: { plan_save: { kind: "object" }, memory_query: { kind: "object" } },
    });
    expect(b.templateHash).toBe(a.templateHash);
  });

  it("hashes native media by digest without serializing its bytes into lineage", () => {
    const messages = (image: Uint8Array): ModelMessage[] => [
      {
        role: "user",
        content: [
          { type: "text", text: "review this" },
          { type: "image", image, mediaType: "image/png" },
        ],
      },
    ];
    const first = computePromptLineage({ ...base, messages: messages(new Uint8Array([1, 2, 3])) });
    const same = computePromptLineage({ ...base, messages: messages(Buffer.from([1, 2, 3])) });
    const changed = computePromptLineage({
      ...base,
      messages: messages(new Uint8Array([1, 2, 4])),
    });
    expect(PROMPT_LINEAGE_SCHEMA_VERSION).toBe("2");
    expect(PROMPT_LINEAGE_NATIVE_MEDIA_SCHEMA_VERSION).toBe("3");
    expect(promptLineageSchemaVersion(baseMessages)).toBe("2");
    expect(promptLineageSchemaVersion(messages(new Uint8Array([1])))).toBe("3");
    expect(same.assembledHash).toBe(first.assembledHash);
    expect(changed.assembledHash).not.toBe(first.assembledHash);
  });

  it("preserves the v2 assembled-hash recipe for binary-free prompts", () => {
    expect(computeAssembledHash(base.systemPrompt, baseMessages)).toBe(
      sha256_16(JSON.stringify({ system: base.systemPrompt, messages: baseMessages })),
    );
  });
});
