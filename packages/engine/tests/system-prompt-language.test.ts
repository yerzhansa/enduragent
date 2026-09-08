import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LanguageResolution, LanguageSource } from "@enduragent/i18n";
import { Memory } from "../../core/src/memory/store.js";
import {
  buildPlanCoachSystemPrompt,
  buildSystemPrompt,
  splitSystemPromptAtBoundary,
} from "../src/agent/system-prompt.js";
import { summarizeDroppedMessages } from "../src/agent/compaction.js";
import { createMemorySnapshot } from "../src/sport/memory-snapshot.js";
import { createFakeLLM } from "./helpers/fake-llm.js";

const protectedContent =
  "The rule covers your prose only. Leave these exactly as they are: tool arguments and every JSON field name and value, metric names and units (FTP, Fitness, Fatigue, Form, Load, Intensity, weighted average power, W/kg, bpm), memory-file section headings and the numerals inside them, compaction summary headings, plan and workout identifiers, activity names copied from the athlete's data, cited titles, and command names such as /review. Do not translate stored athlete text or rewrite historical content. Do not change numeric values, units, dates, or cited evidence because of the language.";
const italian: LanguageResolution = { language: "it", source: "preference", locale: "it-IT" };
const sources: LanguageSource[] = ["message", "surface", "default"];
let dir: string;
let memory: Memory;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reply-language-"));
  memory = new Memory(dir);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const builders = [
  {
    name: "sport coach",
    build: (outputLanguage?: LanguageResolution) =>
      buildSystemPrompt(
        { soul: "# Coach", skills: {}, sessionClusterGapMinutes: 30 },
        memory,
        "UTC",
        "# Degraded data",
        { outputLanguage },
      ),
  },
  {
    name: "plan coach",
    build: (outputLanguage?: LanguageResolution) =>
      buildPlanCoachSystemPrompt(memory, "UTC", "# Degraded data", { outputLanguage }),
  },
];

describe.each(builders)("$name reply language", ({ build }) => {
  it("renders the exact preference rule immediately after time and before degradation", () => {
    const prompt = build(italian);
    const expected = `# Reply language\n\nThe athlete chose Italian (Italiano). Write every athlete-facing sentence in Italian, even when the athlete writes in another language. This rule outranks "Mirror the athlete's register": mirror register, tone, and level of detail within Italian; never mirror the language itself.\n\n${protectedContent}`;
    expect(prompt).toContain(
      `# Current Date & Time\n\nTime zone: UTC\n\n---\n\n${expected}\n\n---\n\n# Degraded data`,
    );
    const blocks = splitSystemPromptAtBoundary(prompt);
    expect(blocks?.prefix).not.toContain("# Reply language");
    expect(blocks?.volatile).toContain(expected);
    expect(blocks?.prefix).toContain(
      "Mirror the athlete's register within the resolved reply language; mirroring never changes that language.",
    );
  });

  it.each(sources)("renders the exact automatic rule for source %s", (source) => {
    expect(build({ ...italian, source })).toContain(
      `# Reply language\n\nNo language is saved. Reply in the language of the athlete's latest message; that is what "Mirror the athlete's register" means for language. When the message carries no language signal (a bare command, numbers only), reply in Italian (Italiano).\n\n${protectedContent}`,
    );
    expect(build({ ...italian, source })).not.toContain("The athlete chose");
  });

  it("changes only volatile bytes when the language changes", () => {
    const first = splitSystemPromptAtBoundary(build(italian));
    const second = splitSystemPromptAtBoundary(
      build({ language: "fr", source: "preference", locale: "fr-FR" }),
    );
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first?.prefix).toBe(second?.prefix);
    expect(first?.volatile).not.toBe(second?.volatile);
    expect(second?.volatile).toContain("French (Français)");
  });

  it("omits the optional block when no resolution is supplied", () => {
    expect(build()).not.toContain("# Reply language");
  });

  it("keeps the reply rule out of compaction calls", async () => {
    build(italian);
    const llm = createFakeLLM(
      [
        "## Athlete Profile\n- None\n## Training Status\n- None\n## Coach Stance\n- None\n## Discussion Context\n- Recovery\n## Pending Questions\n- None",
      ],
      { repeatLast: true },
    );
    await summarizeDroppedMessages({
      dropped: [{ role: "user", content: "Come recupero dopo la corsa?" }],
      llm,
      mustPreserveTokens: ["FTP"],
      memory: createMemorySnapshot(memory),
    });
    expect(llm.capturedOpts.length).toBeGreaterThan(0);
    for (const opts of llm.capturedOpts) {
      expect(opts.system).not.toContain("# Reply language");
      expect(opts.system).not.toContain("The athlete chose");
      expect(opts.system).toContain("MUST PRESERVE");
    }
  });
});
