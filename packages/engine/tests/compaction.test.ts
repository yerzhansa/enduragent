import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import type { MemorySnapshot } from "@enduragent/engine/sport";
import {
  auditSummaryQuality,
  buildCompactionSystemPrompt,
  COMPACTION_PROMPT_MIN_CHARS,
  resolveMustPreserveTokens,
  summarizeDroppedMessages,
  summarizeInStages,
} from "../src/agent/compaction.js";
import { makeSummaryMessage, SUMMARY_PREFIX } from "../src/agent/history-limit.js";
import { createFakeLLM } from "./helpers/fake-llm.js";
import { getMessageProvenance, setMessageProvenance } from "../src/provenance.js";

const GARMIN = { garmin: true, nonGarmin: false, unknown: false };
const UNKNOWN = { garmin: false, nonGarmin: false, unknown: true };

// ─── Test helpers ─────────────────────────────────────────────────────

const REPRESENTATIVE_CONVERSATION: ModelMessage[] = [
  { role: "user", content: "My FTP is 247W and I weigh 72kg." },
  { role: "assistant", content: "Got it. Logging FTP=247W, weight=72kg." },
  { role: "user", content: "I train Monday, Wednesday, and Friday." },
  { role: "assistant", content: "Schedule noted: Mon/Wed/Fri." },
  { role: "user", content: "Goal: lift FTP to 280W by August for the Gran Fondo." },
  { role: "assistant", content: "Target: FTP 280W by 2026-08, race type gran_fondo." },
  { role: "user", content: "Bike is Trek Madone, power meter is Quarq DZero." },
  { role: "assistant", content: "Equipment logged." },
  { role: "user", content: "I had a knee issue last winter; it flares with high volume." },
  { role: "assistant", content: "Health note: prior knee issue, watch high-volume blocks." },
];

const VALID_FIVE_SECTION_SUMMARY = [
  "## Athlete Profile",
  "- FTP 247W, 72kg, training Mon/Wed/Fri",
  "## Training Status",
  "- Build phase, target FTP 280W",
  "## Coach Stance",
  "- Hold volume this week (prior knee issue); athlete has not pushed back",
  "## Discussion Context",
  "- Goal-setting and equipment review",
  "## Pending Questions",
  "- None outstanding",
].join("\n");

import { CYCLING_VOCABULARY } from "@enduragent/sport-cycling";

const EMPTY_SNAPSHOT: MemorySnapshot = {
  read: () => null,
  has: () => false,
  listSections: () => [],
    provenanceOf: () => ({ garmin: false, nonGarmin: false, unknown: true }),
};

const REQUIRED_HEADINGS = [
  "## Athlete Profile",
  "## Training Status",
  "## Coach Stance",
  "## Discussion Context",
  "## Pending Questions",
];

// ─── Compaction smoke test ────────────────────────────────────────────
//
// Compaction calls carry a cacheable system + one user message: the
// static instruction block (MUST-PRESERVE + sport tokens + section guide)
// rides `opts.system`, and the per-chunk transcript rides the user message.

describe("compaction (sport-parameterized)", () => {
  it("every summarization call carries the 120s deadline for the provider to enforce", async () => {
    const spy = createFakeLLM([VALID_FIVE_SECTION_SUMMARY], { repeatLast: true });

    await summarizeDroppedMessages({
      dropped: REPRESENTATIVE_CONVERSATION,
      llm: spy,
      mustPreserveTokens: CYCLING_VOCABULARY,
      memory: EMPTY_SNAPSHOT,
    });

    expect(spy.capturedOpts.length).toBeGreaterThan(0);
    for (const opts of spy.capturedOpts) expect(opts.deadlineMs).toBe(120_000);
  });

  it("summarizeDroppedMessages carries MUST-PRESERVE + sport tokens in system and transcript data in the user message", async () => {
    const spy = createFakeLLM([VALID_FIVE_SECTION_SUMMARY], { repeatLast: true });

    await summarizeDroppedMessages({
      dropped: REPRESENTATIVE_CONVERSATION,
      llm: spy,
      mustPreserveTokens: CYCLING_VOCABULARY,
      memory: EMPTY_SNAPSHOT,
    });

    expect(spy.capturedOpts.length).toBeGreaterThan(0);
    const system = spy.capturedOpts[0].system ?? "";
    const userContent = String(spy.capturedMessages[0][0].content);

    // Hard contract: every compaction system carries the MUST-PRESERVE
    // instruction.
    expect(system).toContain("MUST PRESERVE");

    // Sport-vocabulary tokens flow through.
    expect(system).toContain("FTP");
    expect(system).toContain("W/kg");
    expect(system).toContain("Coggan");

    // Transcript data is included verbatim in the user message.
    expect(userContent).toContain("247W");
    expect(userContent).toContain("72kg");

    expect(system).toContain("## Coach Stance");
    expect(system).toContain("stance per axis");
    expect(system).toContain("currently disputing");
    expect(system).toContain("illness or symptoms");
    expect(system).toContain("agreed but not yet executed");
  });

  it("summarizeDroppedMessages with function-form tokens calls the function with the snapshot", async () => {
    const spy = createFakeLLM([VALID_FIVE_SECTION_SUMMARY], { repeatLast: true });
    const calls: MemorySnapshot[] = [];

    await summarizeDroppedMessages({
      dropped: REPRESENTATIVE_CONVERSATION,
      llm: spy,
      mustPreserveTokens: (snap) => {
        calls.push(snap);
        return ["FTP 247W", "DYNAMIC_TOKEN"];
      },
      memory: EMPTY_SNAPSHOT,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(EMPTY_SNAPSHOT);
    expect(spy.capturedOpts[0].system).toContain("FTP 247W");
    expect(spy.capturedOpts[0].system).toContain("DYNAMIC_TOKEN");
  });

  it("summarizeInStages system also carries the MUST-PRESERVE instruction and tokens", async () => {
    const spy = createFakeLLM([VALID_FIVE_SECTION_SUMMARY], { repeatLast: true });

    await summarizeInStages({
      messages: REPRESENTATIVE_CONVERSATION,
      llm: spy,
      mustPreserveTokens: CYCLING_VOCABULARY,
      memory: EMPTY_SNAPSHOT,
      recentToKeep: 2,
    });

    expect(spy.capturedOpts.length).toBeGreaterThan(0);
    const system = spy.capturedOpts[0].system ?? "";
    expect(system).toContain("MUST PRESERVE");
    expect(system).toContain("FTP");

    expect(system).toContain("## Coach Stance");
    expect(system).toContain("stance per axis");
    expect(system).toContain("currently disputing");
    expect(system).toContain("illness or symptoms");
    expect(system).toContain("agreed but not yet executed");
  });

  it("auditSummaryQuality accepts a summary with all five required sections", () => {
    const audit = auditSummaryQuality(VALID_FIVE_SECTION_SUMMARY);
    expect(audit.ok).toBe(true);
    expect(audit.missing).toEqual([]);
  });

  it("auditSummaryQuality flags a summary missing required sections", () => {
    const partial = "## Athlete Profile\n- FTP 247W\n## Discussion Context\n- foo";
    const audit = auditSummaryQuality(partial);
    expect(audit.ok).toBe(false);
    expect(audit.missing).toContain("## Training Status");
    expect(audit.missing).toContain("## Coach Stance");
    expect(audit.missing).toContain("## Pending Questions");
  });

  it("auditSummaryQuality flags a summary missing only ## Coach Stance", () => {
    const fourSection = [
      "## Athlete Profile",
      "- FTP 247W",
      "## Training Status",
      "- Build phase",
      "## Discussion Context",
      "- Goal review",
      "## Pending Questions",
      "- None",
    ].join("\n");
    const audit = auditSummaryQuality(fourSection);
    expect(audit.ok).toBe(false);
    expect(audit.missing).toEqual(["## Coach Stance"]);
  });
});

// ─── Cacheable system+messages call shape ─────────────────────────────

describe("compaction call shape", () => {
  it("every compaction call carries the pinned system, one user message, no prompt, and the compact caller", async () => {
    const spy = createFakeLLM([VALID_FIVE_SECTION_SUMMARY], { repeatLast: true });
    const expectedSystem = buildCompactionSystemPrompt(
      resolveMustPreserveTokens(CYCLING_VOCABULARY, EMPTY_SNAPSHOT),
    );

    await summarizeInStages({
      messages: REPRESENTATIVE_CONVERSATION,
      llm: spy,
      mustPreserveTokens: CYCLING_VOCABULARY,
      memory: EMPTY_SNAPSHOT,
      recentToKeep: 2,
      caller: "compact",
    });

    expect(spy.capturedOpts.length).toBeGreaterThan(0);
    for (const opts of spy.capturedOpts) {
      expect(opts.prompt).toBeUndefined();
      expect(opts.system).toBe(expectedSystem);
      expect(opts.messages).toHaveLength(1);
      expect(opts.messages?.[0].role).toBe("user");
      expect(opts.caller).toBe("compact");
    }
  });

  it("a pass that trips the finalize retry uses one byte-identical system across every call", async () => {
    const spy = createFakeLLM(["just some unstructured text", VALID_FIVE_SECTION_SUMMARY]);

    await summarizeInStages({
      messages: REPRESENTATIVE_CONVERSATION,
      llm: spy,
      mustPreserveTokens: CYCLING_VOCABULARY,
      memory: EMPTY_SNAPSHOT,
      recentToKeep: 2,
    });

    expect(spy.capturedOpts.length).toBeGreaterThanOrEqual(2);
    const systems = spy.capturedOpts.map((o) => o.system);
    expect(new Set(systems).size).toBe(1);
  });

  it("prompt floor: the pinned system clears the cache minimum and carries every heading", () => {
    const system = buildCompactionSystemPrompt(["FTP"]);
    expect(system.length).toBeGreaterThanOrEqual(COMPACTION_PROMPT_MIN_CHARS);
    for (const heading of REQUIRED_HEADINGS) {
      expect(system).toContain(heading);
    }
  });

  it("the stages user message is laid out with the summarize instruction, carried summary, then transcript", async () => {
    const spy = createFakeLLM([VALID_FIVE_SECTION_SUMMARY]);
    const carried = "## Athlete Profile\n- FTP 247W baseline established";

    await summarizeInStages({
      messages: REPRESENTATIVE_CONVERSATION,
      llm: spy,
      mustPreserveTokens: CYCLING_VOCABULARY,
      memory: EMPTY_SNAPSHOT,
      recentToKeep: 2,
      previousSummary: carried,
    });

    const userContent = String(spy.capturedMessages[0][0].content);
    expect(userContent.startsWith("Summarize the conversation below")).toBe(true);
    expect(userContent.indexOf("Existing summary of earlier context:")).toBeLessThan(
      userContent.indexOf("Messages to summarize:"),
    );
  });

  it("the dropped user message opens with the incorporate instruction", async () => {
    const spy = createFakeLLM([VALID_FIVE_SECTION_SUMMARY]);

    await summarizeDroppedMessages({
      dropped: REPRESENTATIVE_CONVERSATION,
      llm: spy,
      mustPreserveTokens: CYCLING_VOCABULARY,
      memory: EMPTY_SNAPSHOT,
    });

    const userContent = String(spy.capturedMessages[0][0].content);
    expect(userContent.startsWith("Incorporate the older conversation messages below")).toBe(true);
  });
});

describe("summarizeDroppedMessages failure containment", () => {
  it("throws when every chunk fails", async () => {
    const llm = createFakeLLM([{ error: new Error("boom") }], { repeatLast: true });

    await expect(
      summarizeDroppedMessages({
        dropped: REPRESENTATIVE_CONVERSATION,
        llm,
        mustPreserveTokens: [],
        memory: EMPTY_SNAPSHOT,
      }),
    ).rejects.toThrow("Dropped message summarization failed before any chunk was summarized");
  });

  it("requeues the failed chunk and all newer messages in order", async () => {
    const firstMessage: ModelMessage = { role: "user", content: "CHUNK-A " + "a".repeat(20_000) };
    const secondMessage: ModelMessage = { role: "user", content: "CHUNK-B " + "b".repeat(20_000) };
    const llm = createFakeLLM([VALID_FIVE_SECTION_SUMMARY, { error: new Error("boom") }]);

    const result = await summarizeDroppedMessages({
      dropped: [firstMessage, secondMessage, ...REPRESENTATIVE_CONVERSATION],
      llm,
      mustPreserveTokens: [],
      memory: EMPTY_SNAPSHOT,
      contextWindowTokens: 30_000,
    });

    expect(result.unsummarized).toEqual([secondMessage, ...REPRESENTATIVE_CONVERSATION]);
    expect(result.summary).toContain("## Coach Stance");
  });

  it("excludes a failed chunk from the durable summary provenance", async () => {
    const failedGarmin = setMessageProvenance(
      { role: "user", content: "CHUNK-A " + "a".repeat(20_000) },
      GARMIN,
    );
    const summarizedUnknown = setMessageProvenance(
      { role: "user", content: "CHUNK-B " + "b".repeat(20_000) },
      UNKNOWN,
    );
    const llm = createFakeLLM([VALID_FIVE_SECTION_SUMMARY, { error: new Error("boom") }]);

    const result = await summarizeDroppedMessages({
      dropped: [summarizedUnknown, failedGarmin],
      llm,
      mustPreserveTokens: [],
      memory: EMPTY_SNAPSHOT,
      contextWindowTokens: 30_000,
    });

    expect(result.unsummarized).toEqual([failedGarmin]);
    expect(result.provenance).toEqual(UNKNOWN);
  });

  it("returns an empty requeue on success", async () => {
    const llm = createFakeLLM([VALID_FIVE_SECTION_SUMMARY]);

    const result = await summarizeDroppedMessages({
      dropped: REPRESENTATIVE_CONVERSATION,
      llm,
      mustPreserveTokens: [],
      memory: EMPTY_SNAPSHOT,
    });

    expect(result.unsummarized).toEqual([]);
    expect(result.summary).toContain("## Coach Stance");
  });

  it("short-circuits empty dropped without an LLM call", async () => {
    const llm = createFakeLLM([VALID_FIVE_SECTION_SUMMARY]);

    const result = await summarizeDroppedMessages({
      dropped: [],
      llm,
      mustPreserveTokens: [],
      memory: EMPTY_SNAPSHOT,
      previousSummary: "prior",
    });

    expect(result).toEqual({ summary: "prior", unsummarized: [] });
    expect(llm.capturedOpts).toHaveLength(0);
  });
});

describe("staged summary provenance", () => {
  it("carries memory-derived token provenance through dropped-message compaction", async () => {
    const llm = createFakeLLM([VALID_FIVE_SECTION_SUMMARY]);

    const result = await summarizeDroppedMessages({
      dropped: REPRESENTATIVE_CONVERSATION,
      llm,
      mustPreserveTokens: () => ({ tokens: ["FTP 247W"], provenance: GARMIN }),
      memory: EMPTY_SNAPSHOT,
    });

    expect(result.provenance?.garmin).toBe(true);
  });

  it("carries memory-derived token provenance through staged compaction", async () => {
    const llm = createFakeLLM([VALID_FIVE_SECTION_SUMMARY]);

    const result = await summarizeInStages({
      messages: REPRESENTATIVE_CONVERSATION,
      llm,
      mustPreserveTokens: () => ({ tokens: ["FTP 247W"], provenance: GARMIN }),
      memory: EMPTY_SNAPSHOT,
      recentToKeep: 0,
    });

    expect(result.summaryProvenance?.garmin).toBe(true);
    expect(getMessageProvenance(result.messages[0]).garmin).toBe(true);
  });

  it("excludes a failed chunk from the summary message provenance", async () => {
    const failedGarmin = setMessageProvenance(
      { role: "user", content: "CHUNK-A " + "a".repeat(20_000) },
      GARMIN,
    );
    const summarizedUnknown = setMessageProvenance(
      { role: "user", content: "CHUNK-B " + "b".repeat(20_000) },
      UNKNOWN,
    );
    const llm = createFakeLLM([VALID_FIVE_SECTION_SUMMARY, { error: new Error("boom") }]);

    const result = await summarizeInStages({
      messages: [summarizedUnknown, failedGarmin],
      llm,
      mustPreserveTokens: [],
      memory: EMPTY_SNAPSHOT,
      recentToKeep: 0,
      contextWindowTokens: 30_000,
    });

    expect(result.summaryProvenance).toEqual(UNKNOWN);
    expect(getMessageProvenance(result.messages[0])).toEqual(UNKNOWN);
  });
});

describe("staged summarization failure containment", () => {
  const goal: ModelMessage = {
    role: "user",
    content: "Goal: finish the mountain ride. " + "a".repeat(20_000),
  };
  const correction: ModelMessage = {
    role: "user",
    content: "Correction: no Tuesday training. " + "b".repeat(20_000),
  };
  const recent: ModelMessage[] = [
    { role: "assistant", content: "What changed this week?" },
    { role: "user", content: "Keep Friday easy." },
  ];

  it.each([false, true])(
    "retains every message after total failure (prior summary: %s)",
    async (withSummary) => {
      const messages = [
        ...(withSummary ? [makeSummaryMessage("FTP 247W; protect the knee", UNKNOWN)] : []),
        goal,
        correction,
        ...recent,
      ];
      const llm = createFakeLLM([{ error: new Error("summary unavailable") }], {
        repeatLast: true,
      });
      const result = await summarizeInStages({
        messages,
        llm,
        mustPreserveTokens: [],
        memory: EMPTY_SNAPSHOT,
        recentToKeep: 2,
        contextWindowTokens: 30_000,
      });

      expect(result.messages).toEqual(messages);
      expect(llm.capturedMessages).toHaveLength(1);
      expect(result.summary).toBeUndefined();
    },
  );

  it("retains failed corrections alongside the successful summary and recent messages", async () => {
    const summary = VALID_FIVE_SECTION_SUMMARY + "\nGoal: finish the mountain ride.";
    const newerCorrection: ModelMessage = {
      role: "user",
      content: "Update: Tuesday training is possible again. " + "c".repeat(20_000),
    };
    const llm = createFakeLLM([summary, { error: new Error("summary unavailable") }]);
    const result = await summarizeInStages({
      messages: [
        makeSummaryMessage("FTP 247W; protect the knee", UNKNOWN),
        goal,
        correction,
        newerCorrection,
        ...recent,
      ],
      llm,
      mustPreserveTokens: [],
      memory: EMPTY_SNAPSHOT,
      recentToKeep: 2,
      contextWindowTokens: 30_000,
    });

    expect(result.messages).toEqual([
      makeSummaryMessage(summary, UNKNOWN),
      correction,
      newerCorrection,
      ...recent,
    ]);
    expect(llm.capturedMessages).toHaveLength(2);
    expect(String(llm.capturedMessages[0][0].content)).toContain("FTP 247W; protect the knee");
  });
});

describe("shared audit post-step (cap-before-audit)", () => {
  const PREVIOUS_SUMMARY = "## Athlete Profile\n- FTP 247W baseline established";

  it("staged summarization retries a sectionless summary and returns the restructured one", async () => {
    const spy = createFakeLLM(["just some unstructured text", VALID_FIVE_SECTION_SUMMARY]);

    const result = await summarizeInStages({
      messages: REPRESENTATIVE_CONVERSATION,
      llm: spy,
      mustPreserveTokens: CYCLING_VOCABULARY,
      memory: EMPTY_SNAPSHOT,
      recentToKeep: 2,
    });

    expect(spy.capturedOpts).toHaveLength(2);
    expect(String(spy.capturedMessages[1][0].content)).toContain(
      "Restructure the following summary",
    );
    for (const opts of spy.capturedOpts) {
      expect(opts.maxOutputTokens).toBe(1000);
    }
    expect(result.messages[0].content).toContain("## Coach Stance");
    expect(result.messages[0].content).toContain("## Pending Questions");
    expect(result.messages).toHaveLength(3);
    expect(result.summary).toContain("## Coach Stance");
  });

  it("staged summarization that stays sectionless degrades to the capped text instead of throwing", async () => {
    const spy = createFakeLLM(["no sections here", "still no sections"]);

    const result = await summarizeInStages({
      messages: REPRESENTATIVE_CONVERSATION,
      llm: spy,
      mustPreserveTokens: CYCLING_VOCABULARY,
      memory: EMPTY_SNAPSHOT,
      recentToKeep: 2,
    });

    expect(spy.capturedOpts).toHaveLength(2);
    expect(result.messages[0].content).toContain("still no sections");
    expect(result.messages).toHaveLength(3);
    expect(result.summary).toContain("still no sections");
  });

  it("audits the capped text, not the pre-cap text: tail-amputated sections trigger the retry", async () => {
    const tailBeyondCap =
      "## Athlete Profile\n- FTP 247W\n" +
      "x".repeat(4100) +
      "\n## Training Status\n## Coach Stance\n## Discussion Context\n## Pending Questions";
    const spy = createFakeLLM([tailBeyondCap, VALID_FIVE_SECTION_SUMMARY]);

    const { summary, unsummarized } = await summarizeDroppedMessages({
      dropped: REPRESENTATIVE_CONVERSATION,
      llm: spy,
      mustPreserveTokens: CYCLING_VOCABULARY,
      memory: EMPTY_SNAPSHOT,
    });

    expect(spy.capturedOpts).toHaveLength(2);
    expect(summary).toBe(VALID_FIVE_SECTION_SUMMARY);
    expect(unsummarized).toEqual([]);
  });

  it("every summarization call carries the 1000-token generation bound", async () => {
    const spy = createFakeLLM(["sectionless", "still sectionless"]);

    await summarizeDroppedMessages({
      dropped: REPRESENTATIVE_CONVERSATION,
      llm: spy,
      mustPreserveTokens: CYCLING_VOCABULARY,
      memory: EMPTY_SNAPSHOT,
    });

    expect(spy.capturedOpts.length).toBeGreaterThanOrEqual(2);
    for (const opts of spy.capturedOpts) {
      expect(opts.maxOutputTokens).toBe(1000);
    }
  });

  it("a leading summary message reaches summarizeInStages as previousSummary, not as a transcript line", async () => {
    const spy = createFakeLLM([VALID_FIVE_SECTION_SUMMARY]);

    await summarizeInStages({
      messages: [makeSummaryMessage(PREVIOUS_SUMMARY), ...REPRESENTATIVE_CONVERSATION],
      llm: spy,
      mustPreserveTokens: CYCLING_VOCABULARY,
      memory: EMPTY_SNAPSHOT,
      recentToKeep: 2,
    });

    const userContent = String(spy.capturedMessages[0][0].content);
    expect(userContent).toContain("Existing summary of earlier context:");
    expect(userContent).toContain("FTP 247W baseline established");
    expect(userContent).not.toContain(`system: ${SUMMARY_PREFIX}`);
  });

  it("both update flows carry the PRESERVE-prior-summary rule in the system", async () => {
    const spy = createFakeLLM([VALID_FIVE_SECTION_SUMMARY, VALID_FIVE_SECTION_SUMMARY]);

    await summarizeDroppedMessages({
      dropped: REPRESENTATIVE_CONVERSATION,
      llm: spy,
      mustPreserveTokens: CYCLING_VOCABULARY,
      memory: EMPTY_SNAPSHOT,
      previousSummary: PREVIOUS_SUMMARY,
    });
    await summarizeInStages({
      messages: REPRESENTATIVE_CONVERSATION,
      llm: spy,
      mustPreserveTokens: CYCLING_VOCABULARY,
      memory: EMPTY_SNAPSHOT,
      recentToKeep: 2,
    });

    expect(spy.capturedOpts[0].system).toContain("PRESERVE every fact in it");
    expect(spy.capturedOpts[1].system).toContain("PRESERVE every fact in it");
  });
});
