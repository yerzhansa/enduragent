import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "../src/agent/chat-store.js";

let dataDir: string;
let sessionsDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cc-corrupt-store-"));
  sessionsDir = join(dataDir, "sessions");
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const VALID_A = JSON.stringify({
  role: "user",
  content: "we agreed: hold volume",
  ts: "2020-01-01T10:00:00.000Z",
});
const VALID_B = JSON.stringify({
  role: "assistant",
  content: "yes - recheck Friday",
  ts: "2020-01-01T10:00:05.000Z",
});
const TORN = '{"role":"user","content":"torn mid-wri';

function seedRaw(chatId: string, content: string): void {
  writeFileSync(join(sessionsDir, `${chatId}.jsonl`), content, "utf-8");
}
function sidecars(chatId: string): string[] {
  return readdirSync(sessionsDir)
    .filter((f) => f.startsWith(`${chatId}.jsonl.corrupt.`))
    .sort();
}

describe("ChatStore.load corrupt-line tolerance", () => {
  it("torn trailing line: survivors load, sidecar holds the torn bytes, file heals", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new ChatStore(dataDir);
    seedRaw("123", `${VALID_A}\n${VALID_B}\n${TORN}`);

    const { messages, lastMessageTime } = store.load("123");

    expect(messages).toEqual([
      { role: "user", content: "we agreed: hold volume" },
      { role: "assistant", content: "yes - recheck Friday" },
    ]);
    expect(lastMessageTime).toBe("2020-01-01T10:00:05.000Z");

    const side = sidecars("123");
    expect(side).toHaveLength(1);
    expect(readFileSync(join(sessionsDir, side[0]), "utf-8")).toBe(TORN + "\n");

    expect(readFileSync(join(sessionsDir, "123.jsonl"), "utf-8")).toBe(`${VALID_A}\n${VALID_B}\n`);

    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("corrupt session line"))).toBe(
      true,
    );
  });

  it("corrupt middle line: order preserved", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new ChatStore(dataDir);
    seedRaw("123", `${VALID_A}\nnot json at all\n${VALID_B}\n`);

    const { messages, lastMessageTime } = store.load("123");

    expect(messages).toEqual([
      { role: "user", content: "we agreed: hold volume" },
      { role: "assistant", content: "yes - recheck Friday" },
    ]);
    expect(lastMessageTime).toBe("2020-01-01T10:00:05.000Z");

    const side = sidecars("123");
    expect(side).toHaveLength(1);
    expect(readFileSync(join(sessionsDir, side[0]), "utf-8")).toBe("not json at all\n");
  });

  it("shape-invalid JSON is quarantined too", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new ChatStore(dataDir);
    const invalidRole = '{"role":"tool","content":"x","ts":"2020-01-01T10:00:01.000Z"}';
    const numericContent = '{"role":"user","content":42,"ts":"2020-01-01T10:00:02.000Z"}';
    const noTs = '{"role":"user","content":"no ts"}';
    const arr = "[1,2]";
    const bareStr = '"just a string"';
    seedRaw("123", `${VALID_A}\n${invalidRole}\n${numericContent}\n${noTs}\n${arr}\n${bareStr}`);

    const { messages } = store.load("123");

    expect(messages).toEqual([{ role: "user", content: "we agreed: hold volume" }]);

    const side = sidecars("123");
    expect(side).toHaveLength(1);
    const sideContent = readFileSync(join(sessionsDir, side[0]), "utf-8");
    expect(sideContent).toContain(invalidRole);
    expect(sideContent).toContain(numericContent);
    expect(sideContent).toContain(noTs);
    expect(sideContent).toContain(arr);
    expect(sideContent).toContain(bareStr);
    expect(sideContent).not.toContain(VALID_A);
  });

  it("all lines corrupt: empty result, session file removed, nothing lost", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new ChatStore(dataDir);
    seedRaw("123", `${TORN}\ngarbage\n`);

    const result = store.load("123");

    expect(result).toEqual({ messages: [], lastMessageTime: null });
    expect(store.hasSession("123")).toBe(false);

    const side = sidecars("123");
    expect(side).toHaveLength(1);
    const sideContent = readFileSync(join(sessionsDir, side[0]), "utf-8");
    expect(sideContent).toContain(TORN);
    expect(sideContent).toContain("garbage");
  });

  it("clean file: untouched, no sidecar", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new ChatStore(dataDir);
    seedRaw("123", `${VALID_A}\n${VALID_B}\n`);
    const before = readFileSync(join(sessionsDir, "123.jsonl"), "utf-8");

    const { messages } = store.load("123");

    expect(messages).toEqual([
      { role: "user", content: "we agreed: hold volume" },
      { role: "assistant", content: "yes - recheck Friday" },
    ]);
    expect(readFileSync(join(sessionsDir, "123.jsonl"), "utf-8")).toBe(before);
    expect(sidecars("123")).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("healing is byte-verbatim — unknown fields survive", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new ChatStore(dataDir);
    const withExtra = JSON.stringify({
      role: "user",
      content: "hi",
      ts: "2020-01-01T10:00:00.000Z",
      extra: 1,
    });
    seedRaw("123", `${withExtra}\n${TORN}`);

    store.load("123");

    expect(readFileSync(join(sessionsDir, "123.jsonl"), "utf-8")).toBe(withExtra + "\n");
  });

  it("blank interior lines are dropped silently, not quarantined", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new ChatStore(dataDir);
    seedRaw("123", `${VALID_A}\n\n   \n${VALID_B}\n`);

    const { messages } = store.load("123");

    expect(messages).toEqual([
      { role: "user", content: "we agreed: hold volume" },
      { role: "assistant", content: "yes - recheck Friday" },
    ]);
    expect(sidecars("123")).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("modes: sidecar and healed file are 0o600", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new ChatStore(dataDir);
    seedRaw("123", `${VALID_A}\n${VALID_B}\n${TORN}`);

    store.load("123");

    const p = join(sessionsDir, sidecars("123")[0]);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(statSync(join(sessionsDir, "123.jsonl")).mode & 0o777).toBe(0o600);
  });

  it("idempotent: a second load after healing creates no second sidecar", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new ChatStore(dataDir);
    seedRaw("123", `${VALID_A}\n${VALID_B}\n${TORN}`);

    store.load("123");
    const afterFirst = readFileSync(join(sessionsDir, "123.jsonl"), "utf-8");
    store.load("123");
    const afterSecond = readFileSync(join(sessionsDir, "123.jsonl"), "utf-8");

    expect(sidecars("123")).toHaveLength(1);
    expect(afterSecond).toBe(afterFirst);
  });

  it("quarantine failure is best-effort: load still returns the parseable messages", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new ChatStore(dataDir);
    seedRaw("123", `${VALID_A}\n${VALID_B}\n${TORN}`);
    mkdirSync(join(sessionsDir, "123.jsonl.tmp"));

    const { messages, lastMessageTime } = store.load("123");

    expect(messages).toEqual([
      { role: "user", content: "we agreed: hold volume" },
      { role: "assistant", content: "yes - recheck Friday" },
    ]);
    expect(lastMessageTime).toBe("2020-01-01T10:00:05.000Z");
    expect(readFileSync(join(sessionsDir, "123.jsonl"), "utf-8")).toBe(
      `${VALID_A}\n${VALID_B}\n${TORN}`,
    );
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("Failed to quarantine"))).toBe(
      true,
    );
  });
});
