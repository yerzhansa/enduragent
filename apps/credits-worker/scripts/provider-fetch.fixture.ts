import { DeviceCheckClient } from "../src/apple.js";
import { DomainError, asUsdMillis } from "../src/domain.js";
import type { DeviceCheckToken } from "../src/domain.js";
import type { Env } from "../src/env.js";
import { OpenRouterManagementClient } from "../src/openrouter.js";

const token = "c3ludGhldGlj" as DeviceCheckToken;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/devicecheck") {
        const bits = await new DeviceCheckClient(env).query(token);
        return Response.json(bits);
      }
      if (pathname === "/openrouter") {
        await new OpenRouterManagementClient(env.OPENROUTER_MANAGEMENT_KEY, {
          guardrailMode: "off",
          guardrailId: undefined,
          keyCountCeiling: undefined,
        }).create({
          name: "synthetic",
          limitUsdMillis: asUsdMillis(2_000),
          guardrailMode: "off",
          guardrailId: undefined,
        });
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    } catch (error) {
      if (error instanceof DomainError) {
        return Response.json({ error: error.code }, { status: 503 });
      }
      throw error;
    }
  },
};
