import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ChatStore } from "../src/agent/chat-store.js";
import { PROMPT_LINEAGE_SCHEMA_VERSION } from "../../engine/src/agent/prompt-lineage.js";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dataDir: string;
let sessionsDir: string;
let store: ChatStore;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cc-lineage-"));
  sessionsDir = join(dataDir, "sessions");
  store = new ChatStore(dataDir);
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function readLines(chatId: string): Record<string, unknown>[] {
  return readFileSync(join(sessionsDir, `${chatId}.jsonl`), "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("ChatStore lineage", () => {
  it("writes the four lineage fields on an assistant line", () => {
    store.appendMessage("c1", "assistant", "reply", {
      templateHash: "0123456789abcdef",
      assembledHash: "fedcba9876543210",
      provider: "anthropic",
      model: "claude-x",
      lineageVersion: PROMPT_LINEAGE_SCHEMA_VERSION,
    });
    const [line] = readLines("c1");
    expect(line.role).toBe("assistant");
    expect(line.content).toBe("reply");
    expect(line.templateHash).toBe("0123456789abcdef");
    expect(line.assembledHash).toBe("fedcba9876543210");
    expect(line.provider).toBe("anthropic");
    expect(line.model).toBe("claude-x");
    expect(line.lineageVersion).toBe(PROMPT_LINEAGE_SCHEMA_VERSION);
    expect(typeof line.ts).toBe("string");
  });

  it("stamps the version on the assistant line of a turn, not the user line", () => {
    store.appendTurn("c1", "how am I doing?", "great", {
      templateHash: "0123456789abcdef",
      assembledHash: "fedcba9876543210",
      provider: "anthropic",
      model: "claude-x",
      lineageVersion: PROMPT_LINEAGE_SCHEMA_VERSION,
    });
    const [userLine, assistantLine] = readLines("c1");
    expect(userLine.role).toBe("user");
    expect("lineageVersion" in userLine).toBe(false);
    expect(assistantLine.role).toBe("assistant");
    expect(assistantLine.lineageVersion).toBe(PROMPT_LINEAGE_SCHEMA_VERSION);
  });

  it("writes no lineage on a user line", () => {
    store.appendMessage("c1", "user", "hi");
    const [line] = readLines("c1");
    expect(line.role).toBe("user");
    expect(line.content).toBe("hi");
    expect(typeof line.ts).toBe("string");
    expect("templateHash" in line).toBe(false);
    expect("provider" in line).toBe(false);
    expect("lineageVersion" in line).toBe(false);
  });

  it("round-trips a session containing a lineage-bearing assistant line", () => {
    store.appendMessage("c1", "user", "hi");
    store.appendMessage("c1", "assistant", "reply", {
      templateHash: "0123456789abcdef",
      assembledHash: "fedcba9876543210",
      provider: "anthropic",
      model: "claude-x",
      lineageVersion: PROMPT_LINEAGE_SCHEMA_VERSION,
    });
    const { messages } = store.load("c1");
    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({ role: "assistant", content: "reply" });
  });

  it("accepts an old session written without lineage fields", () => {
    writeFileSync(
      join(sessionsDir, "legacy.jsonl"),
      JSON.stringify({ role: "assistant", content: "old reply", ts: "2026-06-14T00:00:00.000Z" }) +
        "\n",
      { encoding: "utf-8", mode: 0o600 },
    );
    const { messages } = store.load("legacy");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ role: "assistant", content: "old reply" });
  });

  it("loads a pre-contract line with lineage fields but no version stamp", () => {
    writeFileSync(
      join(sessionsDir, "precontract.jsonl"),
      JSON.stringify({
        role: "assistant",
        content: "pre-contract reply",
        ts: "2026-06-14T00:00:00.000Z",
        templateHash: "0123456789abcdef",
        assembledHash: "fedcba9876543210",
        provider: "anthropic",
        model: "claude-x",
      }) + "\n",
      { encoding: "utf-8", mode: 0o600 },
    );
    const { messages } = store.load("precontract");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ role: "assistant", content: "pre-contract reply" });
  });

  it("quarantines a line whose lineageVersion is not a string", () => {
    writeFileSync(
      join(sessionsDir, "badversion.jsonl"),
      JSON.stringify({
        role: "assistant",
        content: "reply",
        ts: "2026-06-14T00:00:00.000Z",
        lineageVersion: 5,
      }) + "\n",
      { encoding: "utf-8", mode: 0o600 },
    );
    const { messages } = store.load("badversion");
    expect(messages).toHaveLength(0);
  });
});
