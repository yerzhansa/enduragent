import { describe, it, expect, vi } from "vitest";
import { markdownToTelegramHtml, chunkHtml, sendLongMessage } from "../src/channels/telegram.js";

describe("markdownToTelegramHtml", () => {
  it("passes plain markdown through with existing transforms", () => {
    const out = markdownToTelegramHtml("# Hello\n\nSome **bold** and *italic*.\n- one\n- two");
    expect(out).toContain("<b>Hello</b>");
    expect(out).toContain("<b>bold</b>");
    expect(out).toContain("<i>italic</i>");
    expect(out).toContain("• one");
  });

  it("renders a basic markdown table as a padded <pre> block", () => {
    const md = `| Phase | Duration |\n|-------|----------|\n| Warmup | 10min |\n| Main | 30min |`;
    const out = markdownToTelegramHtml(md);
    expect(out.startsWith("<pre>")).toBe(true);
    expect(out.endsWith("</pre>")).toBe(true);
    // Header padded to widest cell ("Warmup" = 6); columns separated by two spaces.
    expect(out).toContain("Phase   Duration");
    expect(out).toContain("Warmup  10min");
    expect(out).toContain("Main    30min");
  });

  it("escapes HTML special chars inside table cells", () => {
    const md = `| Day | Plan |\n|-----|------|\n| Mon | <easy> & rest |`;
    const out = markdownToTelegramHtml(md);
    expect(out).toContain("&lt;easy&gt;");
    expect(out).toContain("&amp;");
    expect(out).not.toContain("<easy>");
  });

  it("renders multiple tables as separate <pre> blocks", () => {
    const md = `| A | B |\n|---|---|\n| 1 | 2 |\n\n| C | D |\n|---|---|\n| 3 | 4 |`;
    const out = markdownToTelegramHtml(md);
    const matches = out.match(/<pre>[\s\S]*?<\/pre>/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it("leaves a malformed table (no separator) as plain pipes", () => {
    const md = `| not | a | table |\n| really | not | one |`;
    const out = markdownToTelegramHtml(md);
    expect(out).not.toContain("<pre>");
    expect(out).toContain("|");
  });

  it("does not let italic regex match the placeholder content", () => {
    const md = `| _hidden_ | x |\n|----------|---|\n| a | b |`;
    const out = markdownToTelegramHtml(md);
    expect(out).toContain("<pre>");
    // The leading underscore in "_hidden_" stays literal inside the <pre>;
    // it should NOT have been turned into <i>hidden</i> by the italic pass.
    expect(out).not.toContain("<i>hidden</i>");
  });

  it("renders a header-only table (no body rows) without crashing", () => {
    const md = `| Col1 | Col2 |\n|------|------|`;
    const out = markdownToTelegramHtml(md);
    expect(out).toContain("<pre>");
    expect(out).toContain("Col1");
    expect(out).toContain("Col2");
  });

  it("renders a table at the very start of a message cleanly", () => {
    const md = `| A | B |\n|---|---|\n| 1 | 2 |\n\nFollow-up text.`;
    const out = markdownToTelegramHtml(md);
    expect(out.startsWith("<pre>")).toBe(true);
    expect(out).toContain("Follow-up text.");
  });

  it("renders a table at the very end of a message cleanly", () => {
    const md = `Intro text.\n\n| A | B |\n|---|---|\n| 1 | 2 |`;
    const out = markdownToTelegramHtml(md);
    expect(out).toContain("Intro text.");
    expect(out.trimEnd().endsWith("</pre>")).toBe(true);
  });

  it("coexists with markdown code blocks (both become separate <pre> blocks)", () => {
    const md = "```\nsome code\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |";
    const out = markdownToTelegramHtml(md);
    const preBlocks = out.match(/<pre>[\s\S]*?<\/pre>/g) ?? [];
    expect(preBlocks.length).toBe(2);
    expect(out).toContain("some code");
    expect(out).toContain("1");
  });

  it("escapes a literal <pre> tag pair in the source text", () => {
    const out = markdownToTelegramHtml("a literal <pre>block</pre> here");
    expect(out).toContain("&lt;pre&gt;");
    expect(out).toContain("&lt;/pre&gt;");
    expect(out).not.toContain("<pre>");
  });

  it("escapes a literal closing </b> tag in the source text", () => {
    const out = markdownToTelegramHtml("danger </b> here");
    expect(out).toContain("&lt;/b&gt;");
    expect(out).not.toContain("</b>");
  });

  it("escapes an unbalanced literal <pre> so the output stays well-formed", () => {
    const out = markdownToTelegramHtml("start <pre> and never closed");
    expect(out).toContain("&lt;pre&gt;");
    expect(out).not.toContain("<pre>");
  });

  it("escapes bare '>' and '<' characters", () => {
    const out = markdownToTelegramHtml("threshold > 0.75 and < 1.0");
    expect(out).toContain("threshold &gt; 0.75 and &lt; 1.0");
  });

  it("escapes HTML inside a fenced code block while the fence still becomes <pre>", () => {
    const out = markdownToTelegramHtml("```\n<b>not bold</b> & co\n```");
    expect(out).toContain("<pre>");
    expect(out).toContain("&lt;b&gt;not bold&lt;/b&gt; &amp; co");
  });

  it("converter markup still produces real tags after source escaping", () => {
    const out = markdownToTelegramHtml("**bold** and <b>literal</b>");
    expect(out).toContain("<b>bold</b>");
    expect(out).toContain("&lt;b&gt;literal&lt;/b&gt;");
  });

  it("escapes pre-encoded entities so they render literally", () => {
    const out = markdownToTelegramHtml("a &amp; b");
    expect(out).toContain("a &amp;amp; b");
  });

  it("preserves fenced content byte-for-byte (modulo escaping) with no transform injection", () => {
    const out = markdownToTelegramHtml("```\n- 4x8min @ 105%\n# main set\ndo 3 * 8\n```");
    const pre = out.match(/<pre>([\s\S]*?)<\/pre>/);
    expect(pre).not.toBeNull();
    const body = pre![1];
    expect(body).toContain("- 4x8min @ 105%");
    expect(body).toContain("# main set");
    expect(body).toContain("do 3 * 8");
    expect(out).not.toContain("•");
    expect(out).not.toContain("<b>main set</b>");
    expect(out).not.toContain("<i>");
  });

  it("does not italicize spaced asterisks in interval math", () => {
    const out = markdownToTelegramHtml("do 3 * 8 reps then 2 * 20min");
    expect(out).toContain("3 * 8");
    expect(out).toContain("2 * 20min");
    expect(out).not.toContain("<i>");
  });

  it("still italicizes genuine emphasis with no internal spaces", () => {
    const out = markdownToTelegramHtml("this is *important*");
    expect(out).toContain("<i>important</i>");
  });

  it("renders an https link as an escaped <a href>", () => {
    const out = markdownToTelegramHtml("see [the plan](https://example.com)");
    expect(out).toContain('<a href="https://example.com">the plan</a>');
  });

  it("renders an http link as an escaped <a href>", () => {
    const out = markdownToTelegramHtml("[x](http://a.b)");
    expect(out).toContain('<a href="http://a.b">x</a>');
  });

  it("leaves a non-http(s) link as literal text", () => {
    const out = markdownToTelegramHtml("[x](javascript:alert(1))");
    expect(out).not.toContain("<a");
    expect(out).toContain("[x](javascript:alert(1))");
  });

  it("attribute-escapes a quote in the link href", () => {
    const out = markdownToTelegramHtml('[x](https://a.b/?q="hi")');
    const href = out.match(/href="([^"]*)"/);
    expect(href).not.toBeNull();
    expect(out).toContain("&quot;");
  });

  it("does not double-escape an ampersand in a multi-param link href", () => {
    const out = markdownToTelegramHtml("[plan](https://example.com/?a=1&b=2)");
    expect(out).toContain('href="https://example.com/?a=1&amp;b=2"');
    expect(out).not.toContain("&amp;amp;");
  });

  it("keeps a balanced closing paren inside the link URL", () => {
    const out = markdownToTelegramHtml("see [Foo](https://en.wikipedia.org/wiki/Foo_(bar))");
    expect(out).toContain('<a href="https://en.wikipedia.org/wiki/Foo_(bar)">Foo</a>');
    expect(out).not.toContain(">)"); // no stray dangling paren after the link
  });
});

describe("sendLongMessage", () => {
  function makeCtx(
    replyImpl: (text: string, options?: Record<string, unknown>) => Promise<unknown>,
  ) {
    return { reply: vi.fn(replyImpl) };
  }

  it("falls back to human-readable source text when Telegram rejects the HTML parse", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = makeCtx(async (_text, options) => {
      if (options?.parse_mode === "HTML") {
        throw new Error(
          "Call to 'sendMessage' failed! (400: Bad Request: can't parse entities: Unsupported start tag)",
        );
      }
      return undefined;
    });
    await expect(
      sendLongMessage(ctx, "**Week 1** a & b [link](https://x.y)"),
    ).resolves.toBeUndefined();
    expect(ctx.reply).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = ctx.reply.mock.calls;
    expect(firstCall[1]).toEqual({ parse_mode: "HTML" });
    expect(secondCall[1]).toBeUndefined();
    const fallback = String(secondCall[0]);
    expect(fallback).not.toContain("<b>");
    expect(fallback).not.toContain("<i>");
    expect(fallback).not.toContain("<pre>");
    expect(fallback).not.toContain("<a");
    expect(fallback).not.toContain("&amp;amp;");
    expect(fallback).toContain("Week 1");
    expect(fallback).toContain("a & b");
    errSpy.mockRestore();
  });

  it("rethrows non-parse errors without a plain-text retry", async () => {
    const ctx = makeCtx(async () => {
      throw new Error(
        "Call to 'sendMessage' failed! (403: Forbidden: bot was blocked by the user)",
      );
    });
    await expect(sendLongMessage(ctx, "hi")).rejects.toThrow("blocked");
    expect(ctx.reply).toHaveBeenCalledTimes(1);
  });

  it("delivers attacker-shaped literal tags without throwing", async () => {
    const ctx = makeCtx(async () => undefined);
    await expect(
      sendLongMessage(ctx, "echoed <pre> from intervals.icu notes </b>"),
    ).resolves.toBeUndefined();
    const sent = String(ctx.reply.mock.calls[0][0]);
    expect(sent).toContain("&lt;pre&gt;");
    expect(sent).toContain("&lt;/b&gt;");
  });

  it("sends nothing for empty text", async () => {
    const ctx = makeCtx(async () => undefined);
    await sendLongMessage(ctx, "");
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("sends nothing for whitespace-only text", async () => {
    const ctx = makeCtx(async () => undefined);
    await sendLongMessage(ctx, "   \n  ");
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("still sends real text", async () => {
    const ctx = makeCtx(async () => undefined);
    await sendLongMessage(ctx, "real reply");
    expect(ctx.reply).toHaveBeenCalledTimes(1);
  });
});

describe("chunkHtml", () => {
  const MAX = 4096;

  it("returns a single chunk when the message fits", () => {
    expect(chunkHtml("short message")).toEqual(["short message"]);
  });

  it("splits on line boundaries when there is no <pre> block", () => {
    const line = "x".repeat(2000);
    const html = `${line}\n${line}\n${line}`;
    const chunks = chunkHtml(html);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MAX);
  });

  it("keeps a multi-line <pre> block whole when the surrounding text pushes total over the limit", () => {
    const para = "x".repeat(2500);
    const pre = "<pre>row1\nrow2\nrow3\nrow4</pre>";
    const html = `${para}\n\n${para}\n\n${pre}`;
    expect(html.length).toBeGreaterThan(MAX);
    const chunks = chunkHtml(html);
    expect(chunks.length).toBeGreaterThan(1);
    // Whichever chunk contains <pre> must also contain </pre> on the same chunk.
    const preChunk = chunks.find((c) => c.includes("<pre>"));
    expect(preChunk).toBeDefined();
    expect(preChunk).toContain("</pre>");
    expect(preChunk).toContain("row4");
  });

  it("splits a <pre> block whose own size exceeds the limit into multiple wrapped <pre> chunks", () => {
    const row = "row content padding ".repeat(20); // ~400 chars
    const rows = Array.from({ length: 30 }, (_, i) => `${i}: ${row}`).join("\n");
    const pre = `<pre>${rows}</pre>`;
    expect(pre.length).toBeGreaterThan(MAX);
    const chunks = chunkHtml(pre);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(MAX);
      // Every chunk that contains <pre> content must have a matching close, and vice versa.
      const opens = (c.match(/<pre>/g) ?? []).length;
      const closes = (c.match(/<\/pre>/g) ?? []).length;
      expect(opens).toBe(closes);
    }
  });

  it("hard-splits a single non-<pre> line longer than the limit", () => {
    const line = "y".repeat(MAX + 500);
    const chunks = chunkHtml(line);
    expect(chunks.length).toBe(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MAX);
    expect(chunks.join("")).toBe(line);
  });

  it("invariant: every chunk has matching <pre>/</pre> tag counts", () => {
    const filler = "lorem ipsum dolor sit amet ".repeat(200); // ~5400 chars
    const pre = `<pre>${"x".repeat(50)}\n${"y".repeat(50)}\n${"z".repeat(50)}</pre>`;
    const html = `${filler}\n${pre}\n${filler}`;
    const chunks = chunkHtml(html);
    for (const c of chunks) {
      const opens = (c.match(/<pre>/g) ?? []).length;
      const closes = (c.match(/<\/pre>/g) ?? []).length;
      expect(opens).toBe(closes);
      expect(c.length).toBeLessThanOrEqual(MAX);
    }
  });

  it("hard-splits without cutting a tag, entity, or surrogate pair", () => {
    const unit = "<b>x</b> &amp; ";
    const line = unit.repeat(Math.ceil((MAX + 1000) / unit.length));
    const chunks = chunkHtml(line);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(MAX);
      expect(c.match(/<[^>]*$/)).toBeNull(); // no chunk ends mid-tag
      expect(c.match(/&[^;]*$/)).toBeNull(); // no chunk ends mid-entity
      const last = c.charCodeAt(c.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false); // no lone high surrogate
      const first = c.charCodeAt(0);
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false); // no lone low surrogate
    }
    expect(chunks.join("")).toBe(line);
  });

  it("keeps inline tags balanced when hard-splitting a long formatted line", () => {
    const unit = "<b>workout</b> ";
    const line = unit.repeat(Math.ceil((MAX + 1000) / unit.length));
    const chunks = chunkHtml(line);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(MAX);
      expect((c.match(/<b>/g) ?? []).length).toBe((c.match(/<\/b>/g) ?? []).length);
      expect(c.match(/<[^>]*$/)).toBeNull(); // no chunk ends mid-tag
    }
  });

  it("preserves consecutive multi-line <pre> blocks across chunking", () => {
    const pre1 = "<pre>a\nb\nc</pre>";
    const pre2 = "<pre>d\ne\nf</pre>";
    // Two paragraphs of filler force chunking; both <pre> blocks must end up intact.
    const filler = "x".repeat(2500);
    const html = `${pre1}\n\n${filler}\n\n${pre2}\n\n${filler}`;
    expect(html.length).toBeGreaterThan(MAX);
    const chunks = chunkHtml(html);
    expect(chunks.join("\n")).toContain(pre1);
    expect(chunks.join("\n")).toContain(pre2);
    for (const c of chunks) {
      expect((c.match(/<pre>/g) ?? []).length).toBe((c.match(/<\/pre>/g) ?? []).length);
    }
  });
});
