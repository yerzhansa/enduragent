import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Memory } from "@enduragent/core";
import {
  createMemorySnapshot,
  getEffectiveSections,
  type CoreDeps,
  type MemorySnapshot,
  type PreserveTokens,
} from "@enduragent/engine/sport";
import { boundToolResultProvenance, unwrapBoundToolResult } from "@enduragent/engine";
import { cyclingSport } from "@enduragent/sport-cycling";
import { runMemoryFlush } from "../../engine/src/agent/memory-flush.js";
import { OneFtpMemory, oneFtpCyclingSport } from "../src/one-ftp-coach.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function memoryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "one-ftp-memory-"));
  roots.push(root);
  return root;
}

function memorySaveLines(soul: string): string[] {
  return soul.split("\n").filter((line) => line.includes("memory_write"));
}

function tokens(sport: typeof cyclingSport, memory: MemorySnapshot): readonly string[] {
  const preserved: PreserveTokens =
    typeof sport.mustPreserveTokens === "function"
      ? sport.mustPreserveTokens(memory)
      : sport.mustPreserveTokens;
  return "tokens" in preserved ? preserved.tokens : preserved;
}

function memoryWriteDescription(sport: typeof cyclingSport, memory: Memory): string {
  const deps = { memory, tz: "UTC" } as unknown as CoreDeps;
  const write = sport.tools(deps).find((tool) => tool.name === "memory_write");
  if (write === undefined) throw new TypeError("memory_write is missing");
  return write.description;
}

const PROFILE = [
  "- FTP 282W (intervals.icu, 1998-07-13)",
  "- Max HR 188 bpm, FTP 282W at 3.9 W/kg (athlete, 1998-06-08)",
  "- Threshold 4×8 at FTP: 282 W (coach, 1998-06-01)",
  "- eFTP reads near 291W (intervals.icu, 1998-08-19)",
  "- FTPs from ramp tests run high (coach, 1998-05-01)",
  "- Prefers sweet spot at 88-94% of FTP (athlete, 1998-05-01)",
].join("\n");

function desktopTool(
  deps: Partial<CoreDeps>,
  name: string,
): (input: unknown, options: unknown) => Promise<unknown> {
  const found = oneFtpCyclingSport.tools(deps as CoreDeps).find((tool) => tool.name === name);
  const execute = (
    found?.tool as { execute?: (input: unknown, options: unknown) => Promise<unknown> }
  )?.execute;
  if (execute === undefined) throw new TypeError(`${name} is missing`);
  return execute;
}

function factsOf(text: string, section: string): string {
  const block = text.split(`## ${section}\n`)[1]?.split("\n## ")[0] ?? "";
  return block
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .join("\n");
}

async function flushPrompt(
  sections: ReturnType<typeof getEffectiveSections>,
  memory?: Memory,
  rewrite?: (prompt: string) => string,
): Promise<string> {
  const target = memory ?? new Memory(await memoryRoot());
  let prompt = "";
  await runMemoryFlush({
    llm: {
      async generate(options: {
        messages: { content: unknown }[];
        tools: Record<string, { execute: (input: unknown) => Promise<unknown> }>;
      }) {
        prompt = String(options.messages.at(-1)?.content ?? "");
        if (rewrite !== undefined) {
          await options.tools.memory_write?.execute({
            section: "cycling-profile",
            content: rewrite(prompt),
          });
        }
        return {
          text: "",
          toolCalls: [],
          toolResults: [],
          steps: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          finishReason: "stop",
          response: { messages: [] },
        };
      },
    } as never,
    messages: [{ role: "user", content: "I ride mornings" }],
    memory: target,
    memorySections: sections,
    tz: "UTC",
  });
  return prompt;
}

describe("the desktop coach's one-FTP rules", () => {
  it("tells the desktop coach the FTP lives in intervals.icu and never to save one to memory", () => {
    const rules = oneFtpCyclingSport.skills["one-ftp"];
    expect(rules).toContain("they set it there, and the app reads it at the next sync");
    expect(rules).toContain("point them to FTP history on Activity review");
    expect(rules).toContain("Never save an FTP to memory, and never offer a Plan change for FTP.");
    expect(memorySaveLines(oneFtpCyclingSport.soul)).toEqual([
      expect.stringContaining("personal details (weight, schedule, goals"),
    ]);
    expect(memorySaveLines(oneFtpCyclingSport.soul).join("\n")).not.toContain("FTP");
  });

  it("gives the desktop coach memory sections and a memory_write tool that never ask for an FTP", async () => {
    expect(getEffectiveSections(oneFtpCyclingSport).map((section) => section.name)).toEqual(
      getEffectiveSections(cyclingSport).map((section) => section.name),
    );
    for (const section of oneFtpCyclingSport.memorySections) {
      expect(`${section.description} ${section.hint ?? ""}`).not.toMatch(/FTP/);
    }
    const memory = new Memory(await memoryRoot());
    const description = memoryWriteDescription(oneFtpCyclingSport, memory);
    expect(description).toContain("cycling-profile (max/resting HR, W/kg, experience level)");
    expect(description).toContain("cycling-history (cycling injuries, ride recovery patterns)");
  });

  it("builds the desktop memory flush prompt without asking for an FTP or using one as the example", async () => {
    const prompt = await flushPrompt(getEffectiveSections(oneFtpCyclingSport));
    expect(prompt).toContain(
      '- "cycling-profile": Max HR, resting HR, W/kg ratio, experience level.',
    );
    expect(prompt).not.toMatch(/"cycling-(profile|history)": [^\n]*FTP/);
    expect(prompt).not.toContain("FTP 252W");
    expect(prompt).toContain(
      `- "person": Name, weight (kg), age, available training days per week. The athlete's FTP lives in intervals.icu; never save it.`,
    );
    expect(prompt).toContain('Example: "- Max HR 188 bpm (athlete, 2026-06-08)".');
  });

  it("shows the coach each stored FTP as see intervals.icu, keeping the rest of every line", async () => {
    const memory = new OneFtpMemory(await memoryRoot());
    memory.writeSection("cycling-profile", PROFILE, "chat-tool");
    memory.writeSection("person", "- Weight 71 kg; FTP 300W (athlete, 1998-08-01)", "chat-tool");
    memory.writeSection("goals", "- Reach 300W FTP by June (athlete, 1998-08-19)", "chat-tool");
    memory.appendDailyNote("Athlete says FTP is 305W today");
    const context = memory.getContext();
    expect(context).toContain("- FTP (see intervals.icu) (intervals.icu, 1998-07-13)");
    expect(context).toContain(
      "- Max HR 188 bpm, FTP (see intervals.icu) at 3.9 W/kg (athlete, 1998-06-08)",
    );
    expect(context).toContain("- Threshold 4×8 at FTP (see intervals.icu) (coach, 1998-06-01)");
    expect(context).toContain("- eFTP reads near 291W (intervals.icu, 1998-08-19)");
    expect(context).toContain("- FTPs from ramp tests run high (coach, 1998-05-01)");
    expect(context).toContain("- Prefers sweet spot at 88-94% of FTP (athlete, 1998-05-01)");
    expect(context).toContain("- Weight 71 kg; FTP (see intervals.icu) (athlete, 1998-08-01)");
    expect(context).toContain("Athlete says FTP (see intervals.icu) today");
    expect(context).toContain("- Reach 300W FTP by June (athlete, 1998-08-19)");
    expect(context).not.toMatch(/FTP:? (?:is |of )?\d|\d+ ?W FTP\b(?! by)/u);
  });

  it("never deletes or rewrites a stored FTP: a flush and memory_write keep every fact", async () => {
    const root = await memoryRoot();
    const memory = new OneFtpMemory(root);
    memory.writeSection("cycling-profile", PROFILE, "chat-tool");
    const shown = await flushPrompt(getEffectiveSections(oneFtpCyclingSport), memory, (prompt) =>
      factsOf(prompt, "cycling-profile"),
    );
    expect(factsOf(shown, "cycling-profile")).toBe(PROFILE);
    expect(memory.readSection("cycling-profile")).toContain(PROFILE);
    const seen = factsOf(memory.getContext(), "cycling-profile");
    await desktopTool({ memory, tz: "UTC" }, "memory_write")(
      {
        type: "memory",
        section: "cycling-profile",
        content: `${seen}\n- Rides mornings (athlete, 1998-08-20)`,
      },
      {},
    );
    expect(memory.readSection("cycling-profile")).toContain(
      `${PROFILE}\n- Rides mornings (athlete, 1998-08-20)`,
    );
  });

  it("keeps the provenance of the whole stored memory, within the same size limit", async () => {
    const root = await memoryRoot();
    const desktop = new OneFtpMemory(root);
    desktop.writeSection("cycling-profile", PROFILE, "chat-tool");
    const shared = new Memory(root);
    const options = { maxChars: 120 };
    expect(desktop.getContextWithProvenance(options)).toEqual(
      shared.getContextWithProvenance(options),
    );
  });

  it("redacts an FTP in what memory_query shows, but not a goal's target", async () => {
    const memory = new OneFtpMemory(await memoryRoot());
    memory.writeSection("cycling-profile", "- FTP 282W (intervals.icu, 1998-07-13)", "chat-tool");
    memory.writeSection("cycling-profile", "- FTP 290W (athlete, 1998-08-01)", "chat-tool");
    memory.writeSection("goals", "- Reach 300W FTP by June (athlete, 1998-08-19)", "chat-tool");
    memory.appendDailyNote("Athlete says FTP is 305W today");
    const today = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    for (const bindMemoryToolProvenance of [false, true]) {
      const answer = await desktopTool(
        { memory, tz: "UTC", bindMemoryToolProvenance },
        "memory_query",
      )({ from, to: today, query: "FTP" }, {});
      const result = String(unwrapBoundToolResult(answer));
      expect(result).toContain("FTP (see intervals.icu)");
      expect(result).toContain("Reach 300W FTP by June");
      expect(result).not.toMatch(/FTP (?:is )?(?:282|290|305)W/u);
      expect(boundToolResultProvenance(answer) !== undefined).toBe(bindMemoryToolProvenance);
    }
  });

  it("keeps compaction from preserving a stored FTP token", async () => {
    const root = await memoryRoot();
    const desktop = new OneFtpMemory(root);
    desktop.writeSection("cycling-profile", PROFILE, "chat-tool");
    expect(tokens(oneFtpCyclingSport, createMemorySnapshot(desktop))).not.toContain("FTP 282W");
    expect(tokens(cyclingSport, createMemorySnapshot(new Memory(root)))).toContain("FTP 282W");
  });

  it("leaves the shared cycling coach, and so the npm bot, unchanged", async () => {
    expect(memorySaveLines(cyclingSport.soul)).toEqual([
      expect.stringContaining("personal details (FTP, weight, schedule, goals"),
    ]);
    expect(cyclingSport.skills).not.toHaveProperty("one-ftp");
    expect(oneFtpCyclingSport.skills).toMatchObject(cyclingSport.skills);
    const shared = getEffectiveSections(cyclingSport);
    expect(shared.find((section) => section.name === "cycling-profile")?.description).toMatch(
      /^FTP \(watts\)/,
    );
    expect(memoryWriteDescription(cyclingSport, new Memory(await memoryRoot()))).toContain(
      "cycling-profile (FTP,",
    );
    expect(await flushPrompt(shared)).toContain('Example: "- FTP 252W (athlete, 2026-06-08)".');
  });
});
