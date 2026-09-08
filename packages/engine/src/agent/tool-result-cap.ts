import type { Tool } from "ai";
import { estimateTokens } from "./token-utils.js";
import { isUntrustedEnvelope } from "./prompt-fence.js";

export const TOOL_RESULT_MAX_TOKENS = 24_000;

type CappedResult = {
  truncated: true;
  notice: string;
  omittedSamples: number;
  estimatedTokens: number;
};

function omittedSampleCount(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  if (result !== null && typeof result === "object") {
    let largest = 0;
    for (const value of Object.values(result as Record<string, unknown>)) {
      if (Array.isArray(value) && value.length > largest) largest = value.length;
    }
    return largest;
  }
  return 0;
}

export function capToolResult(tool: Tool, opts: { maxResultTokens: number }): Tool {
  const inner = tool.execute;
  if (typeof inner !== "function") return tool;
  return {
    ...tool,
    execute: async (input: unknown, options: unknown) => {
      const result = await (inner as (i: unknown, o: unknown) => unknown)(input, options);
      const serialized =
        typeof result === "string" ? result : (JSON.stringify(result) ?? "");
      const estimatedTokens = estimateTokens(serialized);
      if (estimatedTokens <= opts.maxResultTokens) return result;
      // Size is measured on the full (possibly enveloped) result; sample
      // counting wants the payload inside the untrusted-data envelope.
      const omittedSamples = omittedSampleCount(
        isUntrustedEnvelope(result) ? result.data : result,
      );
      const capped: CappedResult = {
        truncated: true,
        notice:
          `Tool result too large (~${estimatedTokens} tokens) and was omitted to protect context. ` +
          "Rerun with narrower arguments (e.g. a smaller date range, fewer stream types, or a shorter activity).",
        omittedSamples,
        estimatedTokens,
      };
      return capped;
    },
  };
}
