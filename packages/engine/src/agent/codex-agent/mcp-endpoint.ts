import { markTurnToolFailure } from "../turn-context.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { asSchema, safeValidateTypes } from "@ai-sdk/provider-utils";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ModelMessage, ToolSet } from "ai";
import { z } from "zod";

import { CODEX_MCP_BEARER_ENV_NAME, CODEX_MCP_SERVER_NAME } from "./config-overrides.js";
import { CODEX_CLIENT_VERSION } from "./session.js";

export const CODEX_MCP_ENDPOINT_HOST = "127.0.0.1";
export const CODEX_MCP_ENDPOINT_PATH = "/mcp";
export const CODEX_MCP_BEARER_BYTES = 32;

const BEARER_SCHEME = "bearer ";

export interface CoachMcpToolResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly isError?: boolean;
}

export interface CoachMcpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType;
  execute(args: Record<string, unknown>): Promise<CoachMcpToolResult>;
}

export interface CoachMcpEndpointOptions {
  readonly tools: ToolSet;
  readonly ctx: unknown;
  readonly abortSignal?: AbortSignal;
  readonly messages?: readonly ModelMessage[];
}

export interface CoachMcpEndpoint {
  readonly url: string;
  readonly bearerToken: string;
  readonly bearerEnvName: string;
  readonly toolNames: readonly string[];
  close(): Promise<void>;
}

function textResult(text: string, isError?: boolean): CoachMcpToolResult {
  return isError === true
    ? { content: [{ type: "text", text }], isError: true }
    : { content: [{ type: "text", text }] };
}

function toolInputSchema(tool: ToolSet[string]): z.ZodType {
  try {
    const jsonSchema = asSchema(tool.inputSchema).jsonSchema;
    const converted = z.fromJSONSchema(jsonSchema as never, { defaultTarget: "draft-7" });
    const shape = (converted as { shape?: Record<string, z.ZodType> }).shape;
    if (shape !== undefined && Object.keys(shape).length > 0) return z.looseObject(shape);
  } catch {
    return z.looseObject({});
  }
  return z.looseObject({});
}

export function buildCoachMcpToolDefinitions(
  options: CoachMcpEndpointOptions,
): CoachMcpToolDefinition[] {
  const messages = [...(options.messages ?? [])];
  let callCounter = 0;
  return Object.entries(options.tools).map(([name, tool]) => ({
    name,
    description: tool.description ?? name,
    inputSchema: toolInputSchema(tool),
    execute: async (args: Record<string, unknown>): Promise<CoachMcpToolResult> => {
      callCounter += 1;
      const toolCallId = `codex-agent-${callCounter}`;
      if (typeof tool.execute !== "function") {
        markTurnToolFailure(options.ctx, name);
        return textResult(`Tool "${name}" is not executable`, true);
      }
      const validation = await safeValidateTypes({
        value: args,
        schema: asSchema(tool.inputSchema),
      });
      if (!validation.success) {
        markTurnToolFailure(options.ctx, name);
        return textResult(
          `Invalid arguments for tool "${name}": ${validation.error.message}`,
          true,
        );
      }
      try {
        const result = await tool.execute(validation.value, {
          toolCallId,
          messages,
          abortSignal: options.abortSignal,
          experimental_context: options.ctx,
        });
        return textResult(typeof result === "string" ? result : JSON.stringify(result));
      } catch (err) {
        markTurnToolFailure(options.ctx, name);
        return textResult(err instanceof Error ? err.message : String(err), true);
      }
    },
  }));
}

function buildMcpServer(definitions: readonly CoachMcpToolDefinition[]): McpServer {
  const server = new McpServer({
    name: CODEX_MCP_SERVER_NAME,
    version: CODEX_CLIENT_VERSION,
  });
  for (const definition of definitions) {
    server.registerTool(
      definition.name,
      { description: definition.description, inputSchema: definition.inputSchema },
      async (args: unknown) => definition.execute((args ?? {}) as Record<string, unknown>) as never,
    );
  }
  return server;
}

function requestPath(target: string | undefined): string {
  try {
    return new URL(target ?? "/", `http://${CODEX_MCP_ENDPOINT_HOST}`).pathname;
  } catch {
    return "";
  }
}

function respondJson(res: ServerResponse, status: number, body: unknown, headers = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function listen(server: Server): Promise<AddressInfo> {
  return new Promise<AddressInfo>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("The coach MCP endpoint did not bind a TCP port."));
        return;
      }
      resolve(address);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, CODEX_MCP_ENDPOINT_HOST);
  });
}

interface OpenExchange {
  readonly server: McpServer;
  readonly transport: StreamableHTTPServerTransport;
}

export async function startCoachMcpEndpoint(
  options: CoachMcpEndpointOptions,
): Promise<CoachMcpEndpoint> {
  const definitions = buildCoachMcpToolDefinitions(options);
  const bearerToken = randomBytes(CODEX_MCP_BEARER_BYTES).toString("base64url");
  const expectedBearer = Buffer.from(bearerToken, "utf8");
  const open = new Set<OpenExchange>();
  let closed = false;

  const authorized = (header: string | string[] | undefined): boolean => {
    if (typeof header !== "string") return false;
    if (header.length <= BEARER_SCHEME.length) return false;
    if (header.slice(0, BEARER_SCHEME.length).toLowerCase() !== BEARER_SCHEME) return false;
    const presented = Buffer.from(header.slice(BEARER_SCHEME.length), "utf8");
    if (presented.length !== expectedBearer.length) return false;
    return timingSafeEqual(presented, expectedBearer);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!authorized(req.headers.authorization)) {
      respondJson(res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
      return;
    }
    if (closed) {
      respondJson(res, 503, { error: "endpoint closed" });
      return;
    }
    if (requestPath(req.url) !== CODEX_MCP_ENDPOINT_PATH) {
      respondJson(res, 404, { error: "not found" });
      return;
    }
    const server = buildMcpServer(definitions);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const exchange: OpenExchange = { server, transport };
    open.add(exchange);
    res.on("close", () => {
      open.delete(exchange);
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  };

  const httpServer = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (res.headersSent) {
        res.end();
        return;
      }
      respondJson(res, 500, { error: "internal error" });
    });
  });

  const address = await listen(httpServer);

  return {
    url: `http://${CODEX_MCP_ENDPOINT_HOST}:${address.port}${CODEX_MCP_ENDPOINT_PATH}`,
    bearerToken,
    bearerEnvName: CODEX_MCP_BEARER_ENV_NAME,
    toolNames: definitions.map((definition) => definition.name),
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      for (const exchange of open) {
        open.delete(exchange);
        await exchange.transport.close();
        await exchange.server.close();
      }
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    },
  };
}
