import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { tool, type ToolSet } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { CoachAgent } from "../../src/agent/coach-agent.js";
import {
  CODEX_MCP_BEARER_ENV_NAME,
  CODEX_MCP_SERVER_NAME,
} from "../../src/agent/codex-agent/config-overrides.js";
import {
  buildCoachMcpToolDefinitions,
  startCoachMcpEndpoint,
  type CoachMcpEndpoint,
} from "../../src/agent/codex-agent/mcp-endpoint.js";
import { createTurnContext, type TurnContext } from "../../src/agent/turn-context.js";
import type { CoreDeps, MemorySectionSpec, Sport, ToolRegistration } from "../../src/sport.js";
import { baseAgentConfig } from "../helpers/base-agent-config.js";

const TEST_TIMEOUT_MS = 30_000;

const sections: readonly MemorySectionSpec[] = [
  { name: "cycling-profile", description: "FTP, weight, recent form" },
];

interface ToolCallLog {
  reads: string[];
  writes: string[];
  fetches: number;
}

function makeSport(log: ToolCallLog): Sport {
  return {
    id: "cycling",
    soul: "",
    skills: {},
    sessionClusterGapMinutes: 60,
    memorySections: sections,
    mustPreserveTokens: () => ["FTP"],
    intervalsActivityTypes: ["Ride"],
    athleteProfileSchema: z.object({}),
    tools: (_deps: CoreDeps): readonly ToolRegistration[] => {
      const readSchema = z.object({ section: z.string() });
      const writeSchema = z.object({ section: z.string(), content: z.string() });
      const fetchSchema = z.object({ days: z.number() });
      return [
        {
          name: "memory_read",
          description: "Reads a memory section.",
          inputSchema: readSchema,
          tool: tool({
            description: "Reads a memory section.",
            inputSchema: readSchema,
            execute: async ({ section }: { section: string }) => {
              log.reads.push(section);
              return { section, content: `read #${log.reads.length}` };
            },
          }),
        },
        {
          name: "memory_write",
          description: "Saves an athlete memory.",
          inputSchema: writeSchema,
          tool: tool({
            description: "Saves an athlete memory.",
            inputSchema: writeSchema,
            execute: async ({ section }: { section: string }) => {
              log.writes.push(section);
              return { saved: true };
            },
          }),
        },
        {
          name: "intervals_fetch_activities",
          description: "Fetches recent activities.",
          inputSchema: fetchSchema,
          tool: tool({
            description: "Fetches recent activities.",
            inputSchema: fetchSchema,
            execute: async () => {
              log.fetches += 1;
              return [{ id: "a1", source: "GARMIN_CONNECT" }];
            },
          }),
        },
      ];
    },
  };
}

function wrappedTools(dataDir: string, log: ToolCallLog): ToolSet {
  const agent = new CoachAgent(makeSport(log), baseAgentConfig(dataDir));
  return (agent as unknown as { tools: ToolSet }).tools;
}

async function connectClient(endpoint: CoachMcpEndpoint, bearer: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
    requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
  });
  const client = new Client({ name: "codex-agent-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

function resultText(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

describe("codex-agent MCP endpoint", () => {
  let dataDir: string;
  let log: ToolCallLog;
  let ctx: TurnContext;
  let endpoint: CoachMcpEndpoint | undefined;
  let client: Client | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "codex-mcp-"));
    log = { reads: [], writes: [], fetches: 0 };
    ctx = createTurnContext(null, "chat-1");
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
    await endpoint?.close();
    endpoint = undefined;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it(
    "binds an ephemeral loopback port and hands back the bearer binding",
    async () => {
      endpoint = await startCoachMcpEndpoint({ tools: wrappedTools(dataDir, log), ctx });
      const second = await startCoachMcpEndpoint({ tools: wrappedTools(dataDir, log), ctx });
      try {
        const url = new URL(endpoint.url);
        const otherUrl = new URL(second.url);
        expect(url.hostname).toBe("127.0.0.1");
        expect(url.pathname).toBe("/mcp");
        expect(Number(url.port)).toBeGreaterThan(0);
        expect(Number(url.port)).not.toBe(0);
        expect(otherUrl.port).not.toBe(url.port);
        expect(endpoint.bearerEnvName).toBe(CODEX_MCP_BEARER_ENV_NAME);
        expect(endpoint.bearerToken).not.toBe(second.bearerToken);
        expect(endpoint.bearerToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      } finally {
        await second.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "lists exactly the tools of the supplied ToolSet",
    async () => {
      const tools = wrappedTools(dataDir, log);
      endpoint = await startCoachMcpEndpoint({ tools, ctx });
      client = await connectClient(endpoint, endpoint.bearerToken);

      const listed = await client.listTools();
      expect(listed.tools.map((entry) => entry.name).sort()).toEqual(Object.keys(tools).sort());
      expect(endpoint.toolNames.slice().sort()).toEqual(Object.keys(tools).sort());
      const read = listed.tools.find((entry) => entry.name === "memory_read");
      expect(read?.description).toBe("Reads a memory section.");
      expect(Object.keys(read?.inputSchema.properties ?? {})).toContain("section");
      expect(CODEX_MCP_SERVER_NAME).toBe("enduragent");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "threads the live turn context into the wrapped tools",
    async () => {
      endpoint = await startCoachMcpEndpoint({ tools: wrappedTools(dataDir, log), ctx });
      client = await connectClient(endpoint, endpoint.bearerToken);

      const first = await client.callTool({
        name: "memory_read",
        arguments: { section: "cycling-profile" },
      });
      const second = await client.callTool({
        name: "memory_read",
        arguments: { section: "cycling-profile" },
      });
      expect(log.reads).toEqual(["cycling-profile"]);
      expect(resultText(second)).toBe(resultText(first));
      expect(ctx.readToolCache.size).toBe(1);

      expect(ctx.turnWrites.writesCommitted).toBe(0);
      await client.callTool({
        name: "memory_write",
        arguments: { section: "cycling-profile", content: "FTP 250" },
      });
      expect(log.writes).toEqual(["cycling-profile"]);
      expect(ctx.turnWrites.writesCommitted).toBe(1);
      expect(ctx.turnWrites.lastWriteSummary).toBe("saved athlete memory");

      expect(ctx.provenance.value.garmin).toBe(false);
      await client.callTool({ name: "intervals_fetch_activities", arguments: { days: 7 } });
      expect(log.fetches).toBe(1);
      expect(ctx.provenance.value.garmin).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "reports invalid tool arguments without reaching the tool",
    async () => {
      endpoint = await startCoachMcpEndpoint({ tools: wrappedTools(dataDir, log), ctx });
      client = await connectClient(endpoint, endpoint.bearerToken);

      const result = await client.callTool({
        name: "memory_read",
        arguments: { section: 42 },
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("memory_read");
      expect(log.reads).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "validates arguments against the source ToolSet schema before executing",
    async () => {
      const definitions = buildCoachMcpToolDefinitions({
        tools: wrappedTools(dataDir, log),
        ctx,
      });
      const read = definitions.find((definition) => definition.name === "memory_read");
      const invalid = await read?.execute({ section: 42 });
      expect(invalid?.isError).toBe(true);
      expect(invalid?.content[0]?.text).toContain('Invalid arguments for tool "memory_read"');
      expect(log.reads).toEqual([]);

      const valid = await read?.execute({ section: "cycling-profile" });
      expect(valid?.isError).toBeUndefined();
      expect(log.reads).toEqual(["cycling-profile"]);
      expect(ctx.readToolCache.size).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "rejects missing, malformed, and wrong bearers with 401 and runs no tool",
    async () => {
      endpoint = await startCoachMcpEndpoint({ tools: wrappedTools(dataDir, log), ctx });
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "memory_read", arguments: { section: "cycling-profile" } },
      });
      const headerVariants: (Record<string, string> | undefined)[] = [
        undefined,
        { Authorization: "" },
        { Authorization: "Bearer" },
        { Authorization: `Basic ${endpoint.bearerToken}` },
        { Authorization: `Bearer ${endpoint.bearerToken}x` },
        { Authorization: `Bearer ${"a".repeat(endpoint.bearerToken.length)}` },
      ];
      for (const variant of headerVariants) {
        const response = await fetch(endpoint.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...variant,
          },
          body,
        });
        expect(response.status).toBe(401);
        await response.arrayBuffer();
      }
      expect(log.reads).toEqual([]);
      expect(log.writes).toEqual([]);
      expect(log.fetches).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses a correctly-authenticated request once the endpoint is closed",
    async () => {
      const live = await startCoachMcpEndpoint({ tools: wrappedTools(dataDir, log), ctx });
      const url = live.url;
      const bearer = live.bearerToken;
      await live.close();
      await live.close();

      await expect(
        fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            Authorization: `Bearer ${bearer}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "memory_write", arguments: { section: "s", content: "c" } },
          }),
        }),
      ).rejects.toThrow();
      expect(log.reads).toEqual([]);
      expect(log.writes).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});
