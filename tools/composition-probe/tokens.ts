import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { TOKEN_COUNT_MODEL } from "./constants.js";
import { buildMockPrompt } from "./assemble.js";
import { toAnthropicToolsJson } from "./tools.js";

export interface TokensJson {
  method: string;
  model: string;
  stablePrefixTokens: number;
  wholePromptTokens: number;
  measuredAtGitSha: string;
}

const COUNT_TOKENS_URL = "https://api.anthropic.com/v1/messages/count_tokens";

export class CountTokensHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`count_tokens returned ${status}`);
    this.name = "CountTokensHttpError";
  }
}

async function countTokens(systemText: string, includeTools: boolean, apiKey: string): Promise<number> {
  const body = {
    model: TOKEN_COUNT_MODEL,
    system: [{ type: "text", text: systemText }],
    tools: includeTools ? toAnthropicToolsJson() : undefined,
    messages: [{ role: "user", content: "hi" }],
  };
  const res = await fetch(COUNT_TOKENS_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new CountTokensHttpError(res.status, text);
  }
  const json = (await res.json()) as { input_tokens: number };
  return json.input_tokens;
}

function gitSha(): string {
  return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
}

export async function runTokensPhase(dir: string, apiKey: string): Promise<number> {
  let stablePrefixTokens: number;
  let wholePromptTokens: number;
  try {
    const { block1, fullSystem } = buildMockPrompt();
    stablePrefixTokens = await countTokens(block1, true, apiKey);
    wholePromptTokens = await countTokens(fullSystem, true, apiKey);
  } catch (err) {
    if (err instanceof CountTokensHttpError) {
      console.error(`tokens: count_tokens returned a non-2xx response (HTTP ${err.status}) — this is a STOP condition; not falling back to estimation. Response body:`);
      console.error(err.body);
      return 2;
    }
    throw err;
  }
  const out: TokensJson = {
    method: "anthropic count_tokens",
    model: TOKEN_COUNT_MODEL,
    stablePrefixTokens,
    wholePromptTokens,
    measuredAtGitSha: gitSha(),
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tokens.json"), JSON.stringify(out, null, 2) + "\n", "utf-8");
  return 0;
}
