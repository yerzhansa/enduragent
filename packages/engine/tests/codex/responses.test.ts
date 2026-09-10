import { describe, it, expect, afterEach, vi } from "vitest";
import { codexResponses } from "../../src/agent/codex/responses.js";
import { normalizeError } from "../../src/agent/codex-bridge.js";
import { classifyFailure, isRateLimitError, isServerError, isNetworkError } from "../../../core/src/agent/token-utils.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function makeJwt(accountId = "acct_test"): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  ).toString("base64url");
  return `${header}.${payload}.sig`;
}

const TOKEN = makeJwt();

function sseStream(events: unknown[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
  return new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(body));
      c.close();
    },
  });
}

function okResp(events: unknown[]): Response {
  return new Response(sseStream(events), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const TEXT_EVENTS = [
  { type: "response.created", response: { id: "resp_1" } },
  { type: "response.output_item.added", item: { type: "message" } },
  { type: "response.content_part.added", part: { type: "output_text" } },
  { type: "response.output_text.delta", delta: "Hello" },
  { type: "response.output_text.delta", delta: " world" },
  { type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "Hello world" }] } },
  {
    type: "response.completed",
    response: {
      id: "resp_1",
      status: "completed",
      usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15, input_tokens_details: { cached_tokens: 2 } },
    },
  },
];

function baseParams(overrides: Record<string, unknown> = {}) {
  return {
    modelId: "gpt-5.4",
    system: "you are a coach",
    messages: [{ role: "user" as const, content: "hi" }],
    accessToken: TOKEN,
    ...overrides,
  };
}

describe("codexResponses request building", () => {
  it("builds the Responses request body and SSE headers", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResp(TEXT_EVENTS));

    await codexResponses(baseParams({ sessionId: "sess-1" }));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(init.method).toBe("POST");

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("gpt-5.4");
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.instructions).toBe("you are a coach");
    expect(body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
    ]);
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect(body.tool_choice).toBe("auto");
    expect(body.parallel_tool_calls).toBe(true);
    expect(body.prompt_cache_key).toBe("sess-1");
    expect(body.reasoning).toBeUndefined();
    expect(body.text).toEqual({ verbosity: "medium" });
    // Always emit a tools array ([] when the coach passes none) — pre-vendoring parity.
    expect(body.tools).toEqual([]);

    const headers = init.headers as Headers;
    expect(headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
    expect(headers.get("chatgpt-account-id")).toBe("acct_test");
    expect(headers.get("originator")).toBe("codex");
    expect(headers.get("User-Agent")).toContain("cycling-coach");
    expect(headers.get("OpenAI-Beta")).toBe("responses=experimental");
    expect(headers.get("accept")).toBe("text/event-stream");
    expect(headers.get("session_id")).toBe("sess-1");
  });
});

describe("codexResponses SSE accumulation", () => {
  it("accumulates text deltas, usage, and stop reason", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(okResp(TEXT_EVENTS));

    const result = await codexResponses(baseParams());

    expect(result.text).toBe("Hello world");
    expect(result.toolCalls).toEqual([]);
    expect(result.stopReason).toBe("stop");
    // OpenAI includes cached tokens in input_tokens; the accumulator subtracts them.
    expect(result.usage).toEqual({
      input: 10,
      output: 3,
      cacheRead: 2,
      cacheWrite: 0,
      totalTokens: 15,
    });
    expect(result.responseId).toBe("resp_1");
  });

  it("forwards each output_text delta in order and never re-emits the assembled text", async () => {
    const events = [
      { type: "response.created", response: { id: "resp_stream" } },
      { type: "response.output_item.added", item: { type: "reasoning" } },
      { type: "response.output_item.done", item: { type: "reasoning" } },
      { type: "response.output_item.added", item: { type: "message" } },
      { type: "response.content_part.added", part: { type: "output_text" } },
      { type: "response.output_text.delta", delta: "Ride" },
      { type: "response.output_text.delta", delta: " easy" },
      { type: "response.output_text.delta", delta: "" },
      { type: "response.output_text.delta", delta: " today." },
      { type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "Ride easy today." }] } },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 } } },
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(okResp(events));
    const deltas: string[] = [];

    const result = await codexResponses(baseParams({ onTextDelta: (delta: string) => deltas.push(delta) }));

    expect(deltas).toEqual(["Ride", " easy", " today."]);
    expect(deltas.join("")).toBe(result.text);
  });

  it("emits the server-authoritative remainder once when deltas were dropped", async () => {
    const events = [
      { type: "response.created", response: { id: "resp_recover" } },
      { type: "response.output_item.added", item: { type: "message" } },
      { type: "response.output_text.delta", delta: "dropped" },
      { type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "recovered text" }] } },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } } },
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(okResp(events));
    const deltas: string[] = [];

    const result = await codexResponses(baseParams({ onTextDelta: (delta: string) => deltas.push(delta) }));

    expect(deltas).toEqual(["recovered text"]);
    expect(result.text).toBe("recovered text");
  });

  it("recovers final text from output_item.done when content_part.added is missing", async () => {
    // No response.content_part.added, so the per-delta guard never opens and the
    // deltas are dropped — the completed item's content must still be recovered.
    const events = [
      { type: "response.created", response: { id: "resp_3" } },
      { type: "response.output_item.added", item: { type: "message" } },
      { type: "response.output_text.delta", delta: "dropped" },
      { type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "recovered text" }] } },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } } },
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(okResp(events));

    const result = await codexResponses(baseParams());

    expect(result.text).toBe("recovered text");
  });

  it("concatenates the text of multiple message items in one response", async () => {
    // Two message items in a single response: each item's text must survive —
    // the authoritative reconciliation on output_item.done must not clobber the
    // text already committed by an earlier item.
    const events = [
      { type: "response.created", response: { id: "resp_multi" } },
      { type: "response.output_item.added", item: { type: "message" } },
      { type: "response.content_part.added", part: { type: "output_text" } },
      { type: "response.output_text.delta", delta: "first" },
      { type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "first" }] } },
      { type: "response.output_item.added", item: { type: "message" } },
      { type: "response.content_part.added", part: { type: "output_text" } },
      { type: "response.output_text.delta", delta: "second" },
      { type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "second" }] } },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } } },
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(okResp(events));

    const result = await codexResponses(baseParams());

    expect(result.text).toBe("firstsecond");
  });

  it("accumulates a function call and reports stopReason toolUse", async () => {
    const events = [
      { type: "response.created", response: { id: "resp_2" } },
      { type: "response.output_item.added", item: { type: "function_call", call_id: "call_1", id: "fc_1", name: "log_ride", arguments: "" } },
      { type: "response.function_call_arguments.delta", delta: '{"minutes":' },
      { type: "response.function_call_arguments.delta", delta: "60}" },
      { type: "response.function_call_arguments.done", arguments: '{"minutes":60}' },
      { type: "response.output_item.done", item: { type: "function_call", call_id: "call_1", id: "fc_1", name: "log_ride", arguments: '{"minutes":60}' } },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } },
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(okResp(events));

    const result = await codexResponses(baseParams());

    expect(result.stopReason).toBe("toolUse");
    expect(result.toolCalls).toEqual([
      { id: "call_1|fc_1", name: "log_ride", arguments: { minutes: 60 } },
    ]);
  });
});

describe("codexResponses error surface (single attempt, no retry loop)", () => {
  it("throws an auth-classified httpStatus carrier on a 401 and fetches once", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "invalid_token", message: "expired" } }), {
        status: 401,
      }),
    );

    const err = (await codexResponses(baseParams()).catch((e) => e)) as Error & {
      httpStatus?: number;
    };

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(err.httpStatus).toBe(401);
    expect(classifyFailure(normalizeError(err, classifyFailure))).toBe("auth");
  });

  it("throws an httpStatus-carrying RateLimit error on a 429 and fetches once", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "slow down" } }), {
        status: 429,
        headers: { "retry-after": "7" },
      }),
    );

    const err = (await codexResponses(baseParams()).catch((e) => e)) as Error & {
      httpStatus?: number;
      retryAfterMs?: number;
    };

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(err.httpStatus).toBe(429);
    expect(err.retryAfterMs).toBe(7000);
    expect(err.message).toContain("usage limit");
    expect(isRateLimitError(normalizeError(err, classifyFailure))).toBe(true);
  });

  it("throws an httpStatus-carrying ServerError on a 5xx and fetches once", async () => {
    for (const status of [500, 502, 503, 504]) {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("upstream boom", { status }),
      );
      const err = (await codexResponses(baseParams()).catch((e) => e)) as Error & {
        httpStatus?: number;
      };
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(err.httpStatus).toBe(status);
      const normalized = normalizeError(err, classifyFailure);
      expect(isServerError(normalized)).toBe(true);
      expect(isRateLimitError(normalized)).toBe(false);
      vi.restoreAllMocks();
    }
  });

  it("parses retry-after-ms and bare retry-after; absent → undefined", async () => {
    const grab = async (headers: Record<string, string>): Promise<number | undefined> => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("boom", { status: 503, headers }));
      const err = (await codexResponses(baseParams()).catch((e) => e)) as { retryAfterMs?: number };
      vi.restoreAllMocks();
      return err.retryAfterMs;
    };
    expect(await grab({ "retry-after": "7" })).toBe(7000);
    expect(await grab({ "retry-after-ms": "1500" })).toBe(1500);
    expect(await grab({})).toBeUndefined();
  });

  it("propagates a raw network throw with its errno cause, fetching once", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    });

    const err = (await codexResponses(baseParams()).catch((e) => e)) as Error & { cause?: { code?: string } };

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(err.message).toContain("fetch failed");
    expect(err.cause?.code).toBe("ECONNREFUSED");
    expect(isNetworkError(normalizeError(err, classifyFailure))).toBe(true);
  });

  it("preserves a non-timeout abort reason when the signal is already aborted, without fetching", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const controller = new AbortController();
    controller.abort(new Error("operator cancelled"));

    const err = (await codexResponses(baseParams({ signal: controller.signal })).catch((e) => e)) as Error;

    expect(err.message).toBe("operator cancelled");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws 'Request was aborted' for a timeout abort reason, without fetching", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const controller = new AbortController();
    const reason = new Error("deadline exceeded");
    reason.name = "TimeoutError";
    controller.abort(reason);

    const err = (await codexResponses(baseParams({ signal: controller.signal })).catch((e) => e)) as Error;

    expect(err.message).toBe("Request was aborted");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("maps a timeout abort during stream reading to 'Request was aborted'", async () => {
    const controller = new AbortController();
    const reason = new Error("deadline exceeded");
    reason.name = "TimeoutError";
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "response.created" })}\n\n`));
        controller.abort(reason);
        const abortErr = new Error("stream aborted");
        abortErr.name = "AbortError";
        c.error(abortErr);
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );

    const err = (await codexResponses(baseParams({ signal: controller.signal })).catch((e) => e)) as Error;

    expect(err.message).toBe("Request was aborted");
  });

  it("throws the codex error message on a stream error event", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      okResp([{ type: "error", code: "server_error", message: "stream blew up" }]),
    );
    const err = (await codexResponses(baseParams()).catch((e) => e)) as Error;
    expect(err.message).toContain("stream blew up");
  });

  it("returns a fully-accumulated result even if the signal aborts right after accumulation resolves", async () => {
    const controller = new AbortController();
    // The stream completes cleanly, then the signal flips to aborted as the
    // boundary check would run — the already-paid-for result must still return.
    // The abort must fire while the stream is being READ (not at construction:
    // ReadableStream.start runs eagerly, which would abort before codexResponses
    // is even called and trip the entry guard). pull() runs lazily per read, so
    // the first pull delivers the body and the second aborts after it.
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (pulls === 0) {
          const enc = new TextEncoder();
          const body =
            TEXT_EVENTS.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
          c.enqueue(enc.encode(body));
          pulls++;
        } else {
          controller.abort(new Error("aborted after accumulate"));
          c.close();
        }
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );

    const result = await codexResponses(baseParams({ signal: controller.signal }));

    expect(result.text).toBe("Hello world");
    expect(result.stopReason).toBe("stop");
  });

  it("falls back to 'Request was aborted' when the abort reason serializes to undefined", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const controller = new AbortController();
    controller.abort(() => {});

    const err = (await codexResponses(baseParams({ signal: controller.signal })).catch(
      (e) => e,
    )) as Error;

    expect(err.message).toBe("Request was aborted");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("serializes a non-string, non-Error abort reason without producing '[object Object]'", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const controller = new AbortController();
    controller.abort({ code: "cancel" });

    const err = (await codexResponses(baseParams({ signal: controller.signal })).catch(
      (e) => e,
    )) as Error;

    expect(err.message).toContain("cancel");
    expect(err.message).not.toContain("[object Object]");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
